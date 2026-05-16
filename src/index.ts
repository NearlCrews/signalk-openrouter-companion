import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Analyzer, TriggerCtx } from './analyzers/Analyzer.js';
import { ANALYZER_IDS } from './analyzers/ids.js';
import { ANALYZER_FACTORIES } from './analyzers/registry.js';
import { type PluginRuntime, type RouterLike, registerApiRoutes } from './core/api.js';
import { type BatteryEvent, BatteryMonitor } from './core/batteryMonitor.js';
import { BudgetTracker } from './core/budget.js';
import { RollingBuffer } from './core/buffer.js';
import { CronScheduler } from './core/cronScheduler.js';
import {
  CELL_VOLT_PATH_RE,
  discoverBankIds,
  discoverEngineIds,
  discoverWatchedPaths,
  SOC_PATH_RE,
} from './core/discovery.js';
import { EngineDetector, type EngineEvent } from './core/engineDetector.js';
import { Logger, stringify } from './core/logger.js';
import { OpenRouterClient } from './core/openrouter.js';
import {
  bankPathPrefix,
  enginePaths,
  WEATHER_CANONICAL_PATHS,
  WEATHER_EXTENSION_PATHS,
} from './core/paths.js';
import { ReportPublisher } from './core/publisher.js';
import { QuestDBClient } from './core/questdb.js';
import { TriggerRouter } from './core/triggerRouter.js';
import { manualPutCtx } from './core/triggers.js';
import { buildSchema, buildUiSchema } from './schema.js';
import { ALERTS_SUPPORTED_EVENTS, mergeWithDefaults, type PluginOptions } from './types.js';

const PLUGIN_ID = 'signalk-openrouter-companion';
const PLUGIN_NAME = 'OpenRouter Companion';

const BUFFER_MAX_AGE_MS = 26 * 3600 * 1000;
const BUFFER_MAX_ENTRIES_PER_PATH = 50_000;
const ENGINE_SOURCE_WINDOW_MS = 1000;
const BATTERY_SOURCE_WINDOW_MS = 5000;
const MONITOR_TICK_MS = 5000;
const WATCHDOG_TICK_MS = 5000;
const WATCHDOG_SEC = 30;
const RESCAN_INTERVAL_MS = 60_000;

interface ServerApiLike {
  streambundle: {
    getSelfBus(path: string): { onValue(cb: (v: unknown) => void): () => void };
    getAvailablePaths(): string[];
  };
  handleMessage(pluginId: string, delta: unknown): void;
  registerPutHandler(context: string, path: string, handler: unknown, source?: string): void;
  setPluginStatus(msg: string): void;
  setPluginError(msg: string): void;
  debug(...args: unknown[]): void;
  error(msg: string): void;
  getDataDirPath(): string;
  getSelfPath(path: string): unknown;
  selfContext?: string;
}

export default function createPlugin(app: ServerApiLike): {
  id: string;
  name: string;
  description: string;
  enabledByDefault: boolean;
  schema: () => ReturnType<typeof buildSchema>;
  uiSchema: () => ReturnType<typeof buildUiSchema>;
  start: (settings: Partial<PluginOptions>, restart: () => void) => void;
  stop: () => Promise<void>;
  registerWithRouter: (router: RouterLike) => void;
  whenReady: () => Promise<void>;
} {
  const logger = new Logger(app);
  const unsubs: Array<() => void> = [];
  const intervalHandles: NodeJS.Timeout[] = [];
  let lifecycleController: AbortController | null = null;
  let scheduler: CronScheduler | null = null;
  // Snapshot of live runtime objects exposed via registerWithRouter routes.
  // Populated in the start() then-handler once async init resolves; cleared
  // in stop(). Routes return 503 while null.
  let runtime: PluginRuntime | null = null;
  // Reset on every start() so a restart hands out a fresh promise.
  let signalReady: () => void = () => {};
  let readyPromise: Promise<void> = new Promise<void>((resolve) => {
    signalReady = resolve;
  });

  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description:
      'OpenRouter-powered analyzers for Signal K: engine maintenance, battery health, threshold alerts, battery aging, engine drift, and sensor liveness.',
    enabledByDefault: false,
    schema: () => buildSchema(),
    uiSchema: () => buildUiSchema(),

    start: (rawSettings, _restart) => {
      try {
        app.setPluginStatus('Starting');
        readyPromise = new Promise<void>((resolve) => {
          signalReady = resolve;
        });
        const cfg = mergeWithDefaults(rawSettings);
        if (!cfg.openrouter.apiKey) {
          app.setPluginStatus('Awaiting API key configuration');
          signalReady();
          return;
        }
        lifecycleController = new AbortController();
        // Capture into a const: stop() nulls the module-scoped
        // lifecycleController, but the deferred init below still needs a
        // stable handle to this start()'s abort signal.
        const lifecycle = lifecycleController;
        // No scheduler-wide timezone: each analyzer carries its own
        // triggers.cron.timezone, passed per job at register() time below.
        scheduler = new CronScheduler();
        const sched = scheduler;

        const dataDir = app.getDataDirPath();
        // SK server is responsible for the dir, but on first plugin install
        // it may not exist yet; mkdir defensively so publisher.appendLog and
        // BudgetTracker.load don't trip on ENOENT.
        mkdirSync(dataDir, { recursive: true });
        const logPath = join(dataDir, cfg.output.logFilename);
        const budgetPath = join(dataDir, 'budget.json');

        const buffer = new RollingBuffer({
          maxAgeMs: BUFFER_MAX_AGE_MS,
          maxEntriesPerPath: BUFFER_MAX_ENTRIES_PER_PATH,
        });
        const detector = new EngineDetector({
          stopRpmHz: cfg.analyzers.maintenance.engineStopRpmHzThreshold,
          stopSettleSec: cfg.analyzers.maintenance.engineStopSettleSeconds,
          startRpmHz: cfg.analyzers.maintenance.engineStartRpmHzThreshold,
          startSettleSec: cfg.analyzers.maintenance.engineStartSettleSeconds,
          watchdogSec: WATCHDOG_SEC,
          sourceWindowMs: ENGINE_SOURCE_WINDOW_MS,
        });
        const monitor = new BatteryMonitor({
          lowSocPercent: cfg.analyzers.alerts.lowSocPercent,
          socExitHysteresis: cfg.analyzers.alerts.socExitHysteresis,
          cellImbalanceV: cfg.analyzers.alerts.cellImbalanceV,
          imbalanceSettleSec: cfg.analyzers.alerts.imbalanceSettleSec,
          sourceWindowMs: BATTERY_SOURCE_WINDOW_MS,
        });
        const llm = new OpenRouterClient({
          apiKey: cfg.openrouter.apiKey,
          baseUrl: cfg.openrouter.baseUrl,
          model: cfg.openrouter.model,
          requestTimeoutMs: cfg.openrouter.requestTimeoutMs,
          referer: 'https://github.com/NearlCrews/signalk-openrouter-companion',
          title: PLUGIN_ID,
        });
        const questdbCandidate = cfg.questdb.enabled
          ? new QuestDBClient({ url: cfg.questdb.url })
          : null;
        const probePromise: Promise<QuestDBClient | null> = questdbCandidate
          ? questdbCandidate.probe(lifecycle.signal).then((ok) => {
              if (!ok) logger.debug('QuestDB unreachable; trend analyzers will skip this run');
              return ok ? questdbCandidate : null;
            })
          : Promise.resolve(null);
        const publisher = new ReportPublisher({
          app,
          pluginId: PLUGIN_ID,
          logPath,
        });

        const analyzers: Analyzer[] = [];
        for (const id of ANALYZER_IDS) {
          const section = cfg.analyzers[id];
          if (!section.enabled) continue;
          const factory = ANALYZER_FACTORIES[id] as (c: typeof section) => Analyzer;
          analyzers.push(factory(section));
        }

        const budgetPromise = BudgetTracker.load({
          maxPerDay: cfg.openrouter.maxCallsPerDay,
          statePath: budgetPath,
        });

        let router: TriggerRouter | null = null;
        void Promise.all([probePromise, budgetPromise])
          .then(([questdbLive, budget]) => {
            // stop() may have run while probe/budget were still in flight (a
            // disable, or a restart). The abort signal is the lifecycle
            // marker: if it fired, this start() is dead. Bail before writing
            // runtime/router or registering crons, otherwise a late resolve
            // resurrects a stopped plugin's runtime (routes would serve stale
            // data) or clobbers a fresh restart's runtime.
            if (lifecycle.signal.aborted) {
              signalReady();
              return;
            }
            router = new TriggerRouter(analyzers, {
              buffer,
              questdb: questdbLive,
              publisher,
              budget,
              llm,
              logger,
              app,
              setStatus: (m) => app.setPluginStatus(m),
              okStatus: runningStatus(analyzers.length),
            });
            runtime = {
              cfg: {
                openrouter: cfg.openrouter,
                questdb: cfg.questdb,
                analyzers: cfg.analyzers,
              },
              llm,
              budget,
              questdbLive,
              questdbProbed: true,
              analyzers,
              apiKeySet: true,
              router,
              logPath,
            };
            // Register one Cron job per unique (pattern, timezone) pair.
            // Several analyzers can share a schedule (health and liveness both
            // default to '0 8 * * *'). The router dispatches cron by pattern
            // and already fans out to every analyzer whose cron trigger
            // matches, so a job per analyzer would run each shared-schedule
            // analyzer once per duplicate job and double-spend the budget.
            const cronJobs = new Map<string, { pattern: string; timezone: string }>();
            for (const a of analyzers) {
              const timezone = cfg.analyzers[a.id].triggers.cron.timezone;
              for (const t of a.triggers) {
                if (t.kind !== 'cron') continue;
                // Join pattern + timezone with a NUL: cron patterns contain spaces and
                // IANA timezone names do not, so the pair cannot collide into one key.
                cronJobs.set(`${t.pattern}\u0000${timezone}`, { pattern: t.pattern, timezone });
              }
            }
            for (const { pattern, timezone } of cronJobs.values()) {
              try {
                sched.register(
                  pattern,
                  () => {
                    if (!router) return;
                    const ctx: TriggerCtx = { kind: 'cron', firedAt: new Date() };
                    void router.dispatch('cron', ctx, { cronPattern: pattern });
                  },
                  timezone || undefined,
                );
              } catch (err) {
                logger.error(`failed to register cron '${pattern}': ${stringify(err)}`);
              }
            }
            logger.debug('router ready');
            signalReady();
          })
          .catch((err) => {
            // AbortError is the normal stop() path; anything else is a real
            // startup failure that should surface to the admin UI status banner
            // and the SK server log, not get swallowed at debug level.
            signalReady();
            const isAbort =
              err instanceof Error &&
              (err.name === 'AbortError' || err.message.includes('aborted'));
            if (isAbort) {
              logger.debug(`startup aborted: ${stringify(err)}`);
              return;
            }
            logger.error(err);
            app.setPluginError(`Startup failed: ${stringify(err)}`);
          });

        unsubs.push(
          detector.on('engine-stop', (e: EngineEvent) => {
            if (!router) return;
            const sess = e.session;
            if (!sess) return;
            const ctx: TriggerCtx = {
              kind: 'engine-stop',
              firedAt: new Date(sess.sessionEnd),
              engineSession: {
                engineId: e.engineId,
                start: new Date(sess.sessionStart),
                end: new Date(sess.sessionEnd),
                durationSec: sess.durationSec,
              },
            };
            void router.dispatch('engine-stop', ctx);
          }),
        );

        unsubs.push(
          detector.on('possible-stop', (e) => {
            logger.debug(
              `possible-stop: engine ${e.engineId} silent for >${WATCHDOG_SEC}s while running`,
            );
          }),
        );

        const dispatchBatteryEvent = (e: BatteryEvent): void => {
          if (!router) return;
          const batteryEvent =
            e.kind === 'low-soc-enter' || e.kind === 'low-soc-exit'
              ? { subkind: e.kind, soc: e.soc }
              : { subkind: e.kind, imbalanceV: e.imbalanceV };
          const ctx: TriggerCtx = {
            kind: 'battery-event',
            firedAt: new Date(e.ts),
            bankId: e.bankId,
            batteryEvent,
          };
          void router.dispatch('battery-event', ctx, { batterySubkind: e.kind });
        };
        for (const k of ALERTS_SUPPORTED_EVENTS) unsubs.push(monitor.on(k, dispatchBatteryEvent));

        const available = app.streambundle.getAvailablePaths();
        const engineIds = new Set(discoverEngineIds(available));
        const bankIds = new Set(discoverBankIds(available));
        const engineRpmPaths = new Set<string>();
        const watched = discoverWatchedPaths(
          available,
          cfg.analyzers.maintenance.extraWatchedPaths,
        );

        // Subscribe to one self-path. The sink receives the unpacked
        // (value, ts, source) for each delta; non-numeric callers can
        // short-circuit inside the sink.
        const subscribe = (
          path: string,
          sink: (value: unknown, ts: number, source: string) => void,
        ): void => {
          const bus = app.streambundle.getSelfBus(path);
          const unsub = bus.onValue((delta) => {
            const d = delta as { value?: unknown; timestamp?: string; $source?: string };
            const ts = d.timestamp ? Date.parse(d.timestamp) : Date.now();
            sink(d.value, ts, d.$source ?? 'unknown');
          });
          if (unsub) unsubs.push(unsub);
        };

        const subscribeEnginePath = (engineId: string, path: string): void => {
          engineRpmPaths.add(path);
          subscribe(path, (value, ts, src) => {
            if (typeof value !== 'number') return;
            detector.observe(engineId, src, value, ts);
            buffer.record(path, value, ts, src);
          });
        };

        const subscribeWatchedPath = (path: string): void => {
          // Match the path once at subscribe time so the per-delta callback
          // skips two regex executions per delta on a path that fires often.
          const socMatch = path.match(SOC_PATH_RE);
          const cellMatch = socMatch ? null : path.match(CELL_VOLT_PATH_RE);
          const socBank = socMatch?.[1] ?? null;
          const cellBank = cellMatch?.[1] ?? null;
          const cellIdx = cellMatch?.[2] ? Number.parseInt(cellMatch[2], 10) : null;
          subscribe(path, (value, ts, src) => {
            if (typeof value !== 'number') return;
            buffer.record(path, value, ts, src);
            if (socBank) monitor.observeSoc(socBank, src, value, ts);
            else if (cellBank && cellIdx != null)
              monitor.observeCellV(cellBank, cellIdx, value, ts);
          });
        };

        for (const engineId of engineIds) {
          subscribeEnginePath(engineId, enginePaths(engineId).rpm);
        }
        for (const path of watched) {
          if (engineRpmPaths.has(path)) continue;
          subscribeWatchedPath(path);
        }

        // The forecast analyzer reads weather telemetry from the rolling
        // buffer. The weather paths are fixed canonical strings, so no
        // per-instance discovery is needed: subscribe the list directly. They
        // are subscribed unconditionally (not filtered by getAvailablePaths)
        // so a weather producer that starts after this plugin is still
        // captured; collectContext degrades gracefully on paths that never
        // produce data.
        if (cfg.analyzers.forecast.enabled) {
          const watchedSet = new Set(watched);
          for (const path of [...WEATHER_CANONICAL_PATHS, ...WEATHER_EXTENSION_PATHS]) {
            if (watchedSet.has(path) || engineRpmPaths.has(path)) continue;
            subscribe(path, (value, ts, src) => {
              if (typeof value === 'number') buffer.record(path, value, ts, src);
            });
          }
        }

        for (const section of Object.values(cfg.analyzers)) {
          registerAnalyzerPut(app, section, () => router, PLUGIN_ID);
        }

        intervalHandles.push(
          setInterval(() => detector.tickWatchdog(Date.now()), WATCHDOG_TICK_MS),
        );
        intervalHandles.push(setInterval(() => monitor.tick(Date.now()), MONITOR_TICK_MS));
        intervalHandles.push(
          setInterval(() => {
            const fresh = app.streambundle.getAvailablePaths();
            let changed = false;
            for (const id of discoverEngineIds(fresh)) {
              if (engineIds.has(id)) continue;
              engineIds.add(id);
              subscribeEnginePath(id, enginePaths(id).rpm);
              changed = true;
            }
            const newBanks: string[] = [];
            for (const id of discoverBankIds(fresh)) {
              if (bankIds.has(id)) continue;
              bankIds.add(id);
              newBanks.push(id);
              changed = true;
            }
            if (newBanks.length > 0) {
              const freshWatched = discoverWatchedPaths(
                fresh,
                cfg.analyzers.maintenance.extraWatchedPaths,
              );
              for (const id of newBanks) {
                const prefix = bankPathPrefix(id);
                for (const path of freshWatched) {
                  if (engineRpmPaths.has(path)) continue;
                  if (path.startsWith(prefix)) subscribeWatchedPath(path);
                }
              }
            }
            if (changed) {
              app.setPluginStatus(runningStatus(analyzers.length));
            }
          }, RESCAN_INTERVAL_MS),
        );

        if (analyzers.length === 0) {
          app.setPluginStatus('No analyzers enabled. Enable at least one in plugin settings.');
        } else if (engineIds.size === 0 && bankIds.size === 0) {
          app.setPluginStatus('Running, no engine or battery data yet (re-scanning every 60s)');
        } else {
          app.setPluginStatus(runningStatus(analyzers.length));
        }
      } catch (err) {
        app.setPluginError(stringify(err));
      }
    },

    stop: async () => {
      if (lifecycleController) {
        lifecycleController.abort();
        lifecycleController = null;
      }
      if (scheduler) {
        scheduler.stopAll();
        scheduler = null;
      }
      while (unsubs.length > 0) {
        try {
          unsubs.pop()?.();
        } catch (err) {
          logger.error(err);
        }
      }
      for (const h of intervalHandles) clearInterval(h);
      intervalHandles.length = 0;
      runtime = null;
      app.setPluginStatus('Stopped');
    },

    registerWithRouter: (router: RouterLike) => {
      registerApiRoutes(router, () => runtime);
    },

    // whenReady is not part of the SK Plugin interface. It exists so tests
    // (and any in-process consumer that wants to coordinate with the plugin
    // lifecycle) can await the deferred router init that happens after start()
    // returns synchronously. The SK server itself never calls it.
    whenReady: () => readyPromise,
  };
}

function runningStatus(analyzerCount: number): string {
  const label = analyzerCount === 1 ? 'analyzer' : 'analyzers';
  return `Running with ${analyzerCount} ${label} enabled`;
}

interface AnalyzerSectionLike {
  enabled: boolean;
  triggers: { put: { enabled: boolean; path: string } };
}

function registerAnalyzerPut(
  app: ServerApiLike,
  section: AnalyzerSectionLike,
  getRouter: () => TriggerRouter | null,
  pluginId: string,
): void {
  if (!section.enabled) return;
  const { enabled, path } = section.triggers.put;
  if (!enabled || !path) return;
  app.registerPutHandler(
    'vessels.self',
    path,
    (
      _context: string,
      _path: string,
      value: unknown,
      cb: (r: { state: string; statusCode?: number; message?: string }) => void,
    ): { state: string } => {
      void (async () => {
        try {
          const router = getRouter();
          if (!router) {
            cb({
              state: 'FAILED',
              statusCode: 503,
              message: 'plugin not fully started',
            });
            return;
          }
          await router.dispatch('put', manualPutCtx(value), { putPath: path });
          cb({ state: 'COMPLETED', statusCode: 200 });
        } catch (err) {
          cb({ state: 'FAILED', statusCode: 500, message: stringify(err) });
        }
      })();
      return { state: 'PENDING' };
    },
    pluginId,
  );
}
