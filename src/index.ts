import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Analyzer, TriggerCtx } from './analyzers/Analyzer.js';
import { AgingAnalyzer } from './analyzers/aging.js';
import { AlertAnalyzer } from './analyzers/alerts.js';
import { DriftAnalyzer } from './analyzers/drift.js';
import { HealthAnalyzer } from './analyzers/health.js';
import { MaintenanceAnalyzer } from './analyzers/maintenance.js';
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
import { bankPathPrefix, enginePaths } from './core/paths.js';
import { ReportPublisher } from './core/publisher.js';
import { QuestDBClient } from './core/questdb.js';
import { TriggerRouter } from './core/triggerRouter.js';
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
      'OpenRouter-powered analyzers for Signal K: engine maintenance, battery health, threshold alerts, battery aging, and engine drift.',
    enabledByDefault: false,
    schema: () => buildSchema(),
    uiSchema: () => buildUiSchema(),

    start: (rawSettings, restart) => {
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
        // `restart` is provided by the SK server in case a plugin needs to
        // request a self-restart. No analyzer triggers a restart today, so
        // the parameter is intentionally captured but unused.
        void restart;
        scheduler = new CronScheduler({
          tz: cfg.analyzers.maintenance.triggers.cron.timezone || undefined,
        });

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
          ? questdbCandidate.probe(lifecycleController.signal).then((ok) => {
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
        if (cfg.analyzers.maintenance.enabled) {
          analyzers.push(
            new MaintenanceAnalyzer({
              triggers: cfg.analyzers.maintenance.triggers,
              minSessionSeconds: cfg.analyzers.maintenance.minSessionSeconds,
              customSystemPrompt: cfg.analyzers.maintenance.customSystemPrompt,
            }),
          );
        }
        if (cfg.analyzers.health.enabled) {
          analyzers.push(
            new HealthAnalyzer({
              triggers: cfg.analyzers.health.triggers,
              customSystemPrompt: cfg.analyzers.health.customSystemPrompt,
            }),
          );
        }
        if (cfg.analyzers.aging.enabled) {
          analyzers.push(
            new AgingAnalyzer({
              triggers: cfg.analyzers.aging.triggers,
              shortWindowDays: cfg.analyzers.aging.shortWindowDays,
              longWindowDays: cfg.analyzers.aging.longWindowDays,
              customSystemPrompt: cfg.analyzers.aging.customSystemPrompt,
            }),
          );
        }
        if (cfg.analyzers.drift.enabled) {
          analyzers.push(
            new DriftAnalyzer({
              triggers: cfg.analyzers.drift.triggers,
              baselineDays: cfg.analyzers.drift.baselineDays,
              customSystemPrompt: cfg.analyzers.drift.customSystemPrompt,
            }),
          );
        }
        if (cfg.analyzers.alerts.enabled) {
          analyzers.push(
            new AlertAnalyzer({
              triggers: cfg.analyzers.alerts.triggers,
              customSystemPrompt: cfg.analyzers.alerts.customSystemPrompt,
            }),
          );
        }

        const budgetPromise = BudgetTracker.load({
          maxPerDay: cfg.openrouter.maxCallsPerDay,
          statePath: budgetPath,
        });

        let router: TriggerRouter | null = null;
        void Promise.all([probePromise, budgetPromise])
          .then(([questdbLive, budget]) => {
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
                openrouter: {
                  model: cfg.openrouter.model,
                  maxCallsPerDay: cfg.openrouter.maxCallsPerDay,
                },
                questdb: { enabled: cfg.questdb.enabled, url: cfg.questdb.url },
                analyzers: {
                  maintenance: {
                    customSystemPrompt: cfg.analyzers.maintenance.customSystemPrompt,
                  },
                  health: { customSystemPrompt: cfg.analyzers.health.customSystemPrompt },
                  aging: { customSystemPrompt: cfg.analyzers.aging.customSystemPrompt },
                  drift: { customSystemPrompt: cfg.analyzers.drift.customSystemPrompt },
                  alerts: { customSystemPrompt: cfg.analyzers.alerts.customSystemPrompt },
                },
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
            for (const a of analyzers) {
              for (const t of a.triggers) {
                if (t.kind === 'cron' && scheduler) {
                  try {
                    scheduler.register(t.pattern, () => {
                      if (!router) return;
                      const ctx: TriggerCtx = { kind: 'cron', firedAt: new Date() };
                      void router.dispatch('cron', ctx, { cronPattern: t.pattern });
                    });
                  } catch (err) {
                    logger.error(`failed to register cron '${t.pattern}': ${stringify(err)}`);
                  }
                }
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
        const engineIds = discoverEngineIds(available);
        const bankIds = discoverBankIds(available);
        const watched = discoverWatchedPaths(
          available,
          cfg.analyzers.maintenance.extraWatchedPaths,
        );

        const subscribeEnginePath = (engineId: string, path: string): void => {
          const bus = app.streambundle.getSelfBus(path);
          const unsub = bus.onValue((delta) => {
            const d = delta as { value?: unknown; timestamp?: string; $source?: string };
            const ts = d.timestamp ? Date.parse(d.timestamp) : Date.now();
            const src = d.$source ?? 'unknown';
            const v = typeof d.value === 'number' ? d.value : null;
            if (v != null) {
              detector.observe(engineId, src, v, ts);
              buffer.record(path, v, ts, src);
            }
          });
          if (unsub) unsubs.push(unsub);
        };

        const subscribeWatchedPath = (path: string): void => {
          const socMatch = path.match(SOC_PATH_RE);
          const cellMatch = !socMatch ? path.match(CELL_VOLT_PATH_RE) : null;
          const socBank = socMatch?.[1] ?? null;
          const cellBank = cellMatch?.[1] ?? null;
          const cellIdx = cellMatch?.[2] ? Number.parseInt(cellMatch[2], 10) : null;
          const bus = app.streambundle.getSelfBus(path);
          const unsub = bus.onValue((delta) => {
            const d = delta as { value?: unknown; timestamp?: string; $source?: string };
            const ts = d.timestamp ? Date.parse(d.timestamp) : Date.now();
            const src = d.$source ?? 'unknown';
            buffer.record(path, d.value, ts, src);
            if (typeof d.value !== 'number') return;
            if (socBank) {
              monitor.observeSoc(socBank, src, d.value, ts);
            } else if (cellBank && cellIdx != null) {
              monitor.observeCellV(cellBank, cellIdx, d.value, ts);
            }
          });
          if (unsub) unsubs.push(unsub);
        };

        for (const engineId of engineIds) {
          subscribeEnginePath(engineId, enginePaths(engineId).rpm);
        }

        const engineRpmPaths = new Set(engineIds.map((id) => enginePaths(id).rpm));
        for (const path of watched) {
          if (engineRpmPaths.has(path)) continue;
          subscribeWatchedPath(path);
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
            const newEngines = discoverEngineIds(fresh).filter((id) => !engineIds.includes(id));
            for (const id of newEngines) {
              engineIds.push(id);
              subscribeEnginePath(id, enginePaths(id).rpm);
            }
            const newBanks = discoverBankIds(fresh).filter((id) => !bankIds.includes(id));
            if (newBanks.length > 0) {
              const freshWatched = discoverWatchedPaths(
                fresh,
                cfg.analyzers.maintenance.extraWatchedPaths,
              );
              for (const id of newBanks) {
                bankIds.push(id);
                const prefix = bankPathPrefix(id);
                for (const path of freshWatched) {
                  if (engineRpmPaths.has(path)) continue;
                  if (path.startsWith(prefix)) subscribeWatchedPath(path);
                }
              }
            }
            if (engineIds.length > 0 || bankIds.length > 0) {
              app.setPluginStatus(runningStatus(analyzers.length));
            }
          }, RESCAN_INTERVAL_MS),
        );

        if (analyzers.length === 0) {
          app.setPluginStatus('No analyzers enabled. Enable at least one in plugin settings.');
        } else if (engineIds.length === 0 && bankIds.length === 0) {
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
          const ctx: TriggerCtx = { kind: 'put', firedAt: new Date(), put: { value } };
          await router.dispatch('put', ctx, { putPath: path });
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
