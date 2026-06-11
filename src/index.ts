import { mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SKVersion } from '@signalk/server-api';
import type { Analyzer, TriggerCtx } from './analyzers/Analyzer.js';
import { ANALYZER_IDS, type AnalyzerId } from './analyzers/ids.js';
import { ANALYZER_FACTORIES } from './analyzers/registry.js';
import { getOpenApi, type PluginRuntime, type RouterLike, registerApiRoutes } from './core/api.js';
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
import { HOUR_MS } from './core/format.js';
import { Logger, stringify } from './core/logger.js';
import { OpenRouterClient } from './core/openrouter.js';
import { enginePaths, pluginPutPath } from './core/paths.js';
import { ReportPublisher } from './core/publisher.js';
import { QuestDBClient } from './core/questdb.js';
import { TriggerRouter } from './core/triggerRouter.js';
import { manualPutCtx } from './core/triggers.js';
import { buildSchema, buildUiSchema } from './schema.js';
import { ALERTS_SUPPORTED_EVENTS, mergeWithDefaults, type PluginOptions } from './types.js';

const PLUGIN_ID = 'signalk-openrouter-companion';
const PLUGIN_NAME = 'OpenRouter Companion';

const BUFFER_MAX_AGE_MS = 26 * HOUR_MS;
const BUFFER_MAX_ENTRIES_PER_PATH = 50_000;
const ENGINE_SOURCE_WINDOW_MS = 1000;
const BATTERY_SOURCE_WINDOW_MS = 5000;
const MONITOR_TICK_MS = 5000;
const WATCHDOG_TICK_MS = 5000;
const WATCHDOG_SEC = 30;
const RESCAN_INTERVAL_MS = 60_000;
// How far a delta's timestamp may lead wall-clock before it gets clamped.
// Sensors with a mis-set RTC commonly drift hours; anything past this is
// treated as a clock fault rather than a legitimate sample, so it cannot
// shift the rolling-buffer eviction cutoff or the engine watchdog math.
const CLOCK_SKEW_GRACE_MS = 60 * 60 * 1000;
// On restart, a persisted engine session whose last delta is older than this
// is discarded rather than resumed (the engine stopped during the downtime).
const ENGINE_STATE_MAX_RESUME_SEC = 3600;
// How often the in-progress engine session is persisted to disk so a restart
// mid-session can resume it.
const DETECTOR_SAVE_INTERVAL_MS = 60_000;

interface ServerApiLike {
  streambundle: {
    getSelfBus(path: string): { onValue(cb: (v: unknown) => void): () => void };
    getAvailablePaths(): string[];
  };
  // Third arg matches the real SK ServerAPI signature so a v2-shaped delta
  // can be routed correctly; the publisher passes SKVersion.v1 explicitly.
  handleMessage(pluginId: string, delta: unknown, skVersion?: SKVersion): void;
  registerPutHandler(context: string, path: string, handler: unknown, source?: string): void;
  setPluginStatus(msg: string): void;
  setPluginError(msg: string): void;
  debug(...args: unknown[]): void;
  error(msg: string): void;
  getDataDirPath(): string;
  getSelfPath(path: string): unknown;
  selfContext?: string;
  // securityStrategy is provided by SK but not in the typed ServerAPI surface
  // (the typed surface is the long-term-public subset; security middleware
  // wiring is server-internal). Optional so test harnesses without auth can
  // still satisfy the interface; runtime checks at the call site.
  securityStrategy?: {
    addAdminMiddleware(path: string): void;
    addAdminWriteMiddleware(path: string): void;
    addWriteMiddleware(path: string): void;
  };
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
  getOpenApi: () => object;
  // Prefixed underscore: not part of the SK Plugin contract. Tests and
  // in-process consumers can await the deferred router init that completes
  // after start() returns synchronously.
  _whenReady: () => Promise<void>;
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
  // Module-scoped handle to the live router. The PUT handlers capture this
  // via the getRouter callback; stop() nulls it so a PUT after stop() cannot
  // reach a router from a dead start() and charge the budget.
  let activeRouter: TriggerRouter | null = null;
  // Resolved when a start()'s deferred init settles. Replaced on every
  // start() so a restart hands out a fresh promise; each start() owns its own
  // resolver (a module-scoped resolver would let a stale start() resolve a
  // newer start()'s promise).
  let readyPromise: Promise<void> = new Promise<void>(() => {});

  // Release every resource start() registered: abort the lifecycle, stop the
  // scheduler, drain stream subscriptions, clear intervals, drop the runtime.
  // Shared by stop() and start()'s own catch, since SK does not call stop()
  // for a start() that threw partway through wiring.
  const releaseResources = (): void => {
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
    activeRouter = null;
  };

  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description:
      'OpenRouter-powered analyzers for Signal K: engine maintenance, battery health, threshold alerts, battery aging, engine drift, sensor liveness, and weather outlook.',
    enabledByDefault: false,
    schema: () => buildSchema(),
    uiSchema: () => buildUiSchema(),

    start: (rawSettings, _restart) => {
      // Per-start resolver: the deferred init resolves THIS start()'s
      // readyPromise, even after a later start() has replaced it.
      let signalReady: () => void = () => {};
      try {
        app.setPluginStatus('Starting...');
        readyPromise = new Promise<void>((resolve) => {
          signalReady = resolve;
        });
        const cfg = mergeWithDefaults(rawSettings);
        if (!cfg.openrouter.apiKey) {
          app.setPluginStatus('No OpenRouter API key configured. Set one in plugin settings.');
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
        const detectorStatePath = join(dataDir, 'engine-detector.json');

        const buffer = new RollingBuffer({
          maxAgeMs: BUFFER_MAX_AGE_MS,
          maxEntriesPerPath: BUFFER_MAX_ENTRIES_PER_PATH,
        });
        const detector = new EngineDetector(
          {
            stopRpmHz: cfg.analyzers.maintenance.engineStopRpmHzThreshold,
            stopSettleSec: cfg.analyzers.maintenance.engineStopSettleSeconds,
            startRpmHz: cfg.analyzers.maintenance.engineStartRpmHzThreshold,
            startSettleSec: cfg.analyzers.maintenance.engineStartSettleSeconds,
            watchdogSec: WATCHDOG_SEC,
            silenceStopSec: cfg.analyzers.maintenance.engineSilenceStopSeconds,
            sourceWindowMs: ENGINE_SOURCE_WINDOW_MS,
          },
          logger,
        );
        // Resume an engine session that was in progress when the plugin last
        // stopped, so a restart mid-trip neither splits nor loses the session.
        try {
          const parsed: unknown = JSON.parse(readFileSync(detectorStatePath, 'utf-8'));
          if (Array.isArray(parsed)) {
            detector.restore(parsed, Date.now(), ENGINE_STATE_MAX_RESUME_SEC * 1000);
          }
        } catch {
          // No persisted state, or unreadable: start with a clean detector.
        }
        // Persist only when the snapshot actually changed: the engine is off
        // most of the time, so an unconditional periodic write would rewrite
        // the same empty state to the SD card every interval.
        let lastDetectorState = '';
        const saveDetectorState = (): void => {
          const serialized = JSON.stringify(detector.snapshot());
          if (serialized === lastDetectorState) return;
          lastDetectorState = serialized;
          void writeFile(detectorStatePath, serialized).catch((err) => {
            logger.debug(`engine-detector state save failed: ${stringify(err)}`);
          });
        };
        const monitor = new BatteryMonitor(
          {
            lowSocPercent: cfg.analyzers.alerts.lowSocPercent,
            socExitHysteresis: cfg.analyzers.alerts.socExitHysteresis,
            cellImbalanceV: cfg.analyzers.alerts.cellImbalanceV,
            imbalanceSettleSec: cfg.analyzers.alerts.imbalanceSettleSec,
            sourceWindowMs: BATTERY_SOURCE_WINDOW_MS,
          },
          logger,
        );
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
          ? questdbCandidate
              .probe(lifecycle.signal)
              .then((ok) => {
                if (!ok)
                  logger.debug('QuestDB unreachable; trend analyzers will skip until it recovers');
                return ok ? questdbCandidate : null;
              })
              .catch(() => {
                logger.debug('QuestDB unreachable; trend analyzers will skip until it recovers');
                return null;
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
          log: (m) => logger.error(m),
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
              signal: lifecycle.signal,
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
              signal: lifecycle.signal,
              startedAt: Date.now(),
            };
            activeRouter = router;
            // Register one Cron job per unique (pattern, timezone) pair, each
            // carrying the analyzers that share it. Several analyzers can share
            // a schedule (health and liveness both default to '0 8 * * *'), so
            // a job per analyzer would double-spend the budget. The job fires
            // its members by id via runById, not router.dispatch: dispatch
            // matches cron by pattern alone, so two analyzers on the same
            // pattern but different timezones would each run on both jobs.
            // Naming the members keeps every job bound to exactly its pair.
            const cronJobs = new Map<
              string,
              { pattern: string; timezone: string; analyzerIds: AnalyzerId[] }
            >();
            for (const a of analyzers) {
              const timezone = cfg.analyzers[a.id].triggers.cron.timezone;
              for (const t of a.triggers) {
                if (t.kind !== 'cron') continue;
                // Join pattern + timezone with a NUL: cron patterns contain spaces and
                // IANA timezone names do not, so the pair cannot collide into one key.
                const key = `${t.pattern}\u0000${timezone}`;
                const existing = cronJobs.get(key);
                if (existing) existing.analyzerIds.push(a.id);
                else cronJobs.set(key, { pattern: t.pattern, timezone, analyzerIds: [a.id] });
              }
            }
            for (const { pattern, timezone, analyzerIds } of cronJobs.values()) {
              try {
                sched.register(
                  pattern,
                  () => {
                    if (!router) return;
                    const ctx: TriggerCtx = { kind: 'cron', firedAt: new Date() };
                    for (const id of analyzerIds) void router.runById(id, ctx);
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

        // The detector emits engine-start, engine-stop, and possible-stop.
        // engine-start and engine-stop persist detector state so a restart
        // mid-session can resume it. engine-stop additionally drives the
        // maintenance analyzer, which narrates the completed session.
        unsubs.push(detector.on('engine-start', () => saveDetectorState()));
        unsubs.push(
          detector.on('engine-stop', (e: EngineEvent) => {
            saveDetectorState();
            // router is wired by the deferred init (probe + budget). An event
            // in that brief startup window is dropped: an engine stop right at
            // plugin start is unlikely and the next session is still captured.
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
        // Watched paths already subscribed: lets the rescan pick up a path
        // that appeared after start() without ever re-subscribing one.
        const watchedPaths = new Set<string>();
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
            // Date.parse returns NaN for a malformed timestamp; a NaN ts would
            // silently break buffer eviction and detector session arithmetic.
            // A future-stamped delta (mis-set sensor RTC, backlog replay) would
            // evict the entire RollingBuffer in one record() and freeze the
            // engine watchdog forever (silentFor goes negative, never trips
            // silenceStopMs). A far-past delta (epoch 0 from a sensor with no
            // RTC, or Unix seconds parsed as ms-since-1970) is just as
            // dangerous on the other side: silentFor becomes years, and the
            // next tick ends a phantom multi-decade session. Tolerate small
            // clock skew either way; beyond the grace, fall back to wall-clock.
            const wall = Date.now();
            const parsed = d.timestamp ? Date.parse(d.timestamp) : Number.NaN;
            const ts =
              Number.isFinite(parsed) &&
              parsed <= wall + CLOCK_SKEW_GRACE_MS &&
              parsed >= wall - CLOCK_SKEW_GRACE_MS
                ? parsed
                : wall;
            sink(d.value, ts, d.$source ?? 'unknown');
          });
          if (typeof unsub === 'function') unsubs.push(unsub);
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
          watchedPaths.add(path);
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

        // Some analyzers need fixed Signal K paths buffered that are not
        // discovered from the live tree (forecast's weather leaves). Subscribe
        // the union the enabled analyzers declare via Analyzer.watchedPaths, so
        // the lifecycle never special-cases one analyzer by id. These are
        // subscribed unconditionally (not filtered by getAvailablePaths) so a
        // producer that starts after this plugin is still captured;
        // collectContext degrades gracefully on paths that never produce data.
        const declaredPaths = new Set(watched);
        for (const a of analyzers) {
          if (!a.watchedPaths) continue;
          for (const path of a.watchedPaths) {
            if (declaredPaths.has(path) || engineRpmPaths.has(path)) continue;
            declaredPaths.add(path);
            subscribe(path, (value, ts, src) => {
              if (typeof value === 'number') buffer.record(path, value, ts, src);
            });
          }
        }

        for (const id of ANALYZER_IDS) {
          registerAnalyzerPut(app, id, cfg.analyzers[id], () => activeRouter, PLUGIN_ID);
        }

        intervalHandles.push(
          setInterval(() => detector.tickWatchdog(Date.now()), WATCHDOG_TICK_MS),
        );
        // Persist the in-progress engine session periodically so the
        // restart-resume window stays current between engine-start and the
        // next event (see saveDetectorState and detector.restore above).
        intervalHandles.push(setInterval(saveDetectorState, DETECTOR_SAVE_INTERVAL_MS));
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
            for (const id of discoverBankIds(fresh)) {
              if (bankIds.has(id)) continue;
              bankIds.add(id);
              changed = true;
            }
            // Subscribe any watched path that appeared since the last scan: a
            // battery bank, alternator, charger, or fuel tank that came online
            // after start().
            const freshWatched = discoverWatchedPaths(
              fresh,
              cfg.analyzers.maintenance.extraWatchedPaths,
            );
            for (const path of freshWatched) {
              if (engineRpmPaths.has(path) || watchedPaths.has(path)) continue;
              subscribeWatchedPath(path);
              changed = true;
            }
            if (changed) {
              app.setPluginStatus(runningStatus(analyzers.length));
            }
            // QuestDB recovery: it is probed once at start(), so a QuestDB that
            // is down then (or starts after this plugin) would otherwise leave
            // the trend analyzers disabled for the whole plugin lifetime. When
            // it is enabled but not currently live, re-probe and wire it in.
            if (questdbCandidate && router && runtime && !runtime.questdbLive) {
              const live = runtime;
              const routerForRecovery = router;
              void questdbCandidate
                .probe(lifecycle.signal)
                .then((ok) => {
                  if (ok) {
                    routerForRecovery.setQuestdb(questdbCandidate);
                    live.questdbLive = questdbCandidate;
                    logger.debug('QuestDB recovered; trend analyzers re-enabled');
                  }
                })
                .catch(() => {});
            }
          }, RESCAN_INTERVAL_MS),
        );

        if (analyzers.length === 0) {
          app.setPluginStatus('No analyzers enabled. Enable at least one in plugin settings.');
        } else if (engineIds.size === 0 && bankIds.size === 0) {
          app.setPluginStatus('Running: no engine or battery data yet, re-scanning every 60s');
        } else {
          app.setPluginStatus(runningStatus(analyzers.length));
        }
      } catch (err) {
        // start() threw partway through wiring subscriptions and intervals.
        // Release whatever was registered before the throw so it does not leak
        // until the next enable/disable cycle.
        releaseResources();
        app.setPluginError(stringify(err));
        signalReady();
      }
    },

    stop: async () => {
      // The SK server sets the plugin status after stop() resolves, so an
      // explicit 'Stopped' here would only be overwritten.
      releaseResources();
    },

    registerWithRouter: (router: RouterLike) => {
      // Gate every route under the plugin's API prefix to admin users.
      // Three of the seven routes spend OpenRouter budget, fire LLM calls,
      // or probe arbitrary URLs from the SK host; the others leak operator
      // configuration and report history. addAdminMiddleware is the
      // narrowest gate that closes the unauthenticated path; on a server
      // with security disabled (dummysecurity) it is still attached and
      // a no-op so dev setups are unaffected.
      const prefix = `/plugins/${PLUGIN_ID}/api`;
      if (app.securityStrategy?.addAdminMiddleware) {
        app.securityStrategy.addAdminMiddleware(prefix);
      } else {
        // Fail loud: the headline security fix advertises that all routes
        // are gated. If securityStrategy is missing the gate is silently
        // skipped, leaving paid-LLM and SSRF endpoints exposed; the only
        // way an operator learns is by checking the admin status banner.
        app.setPluginError(
          'securityStrategy not available; REST routes are unauthenticated. Upgrade signalk-server or report this deployment shape.',
        );
        logger.error(
          'app.securityStrategy missing in registerWithRouter; admin middleware NOT applied',
        );
      }
      registerApiRoutes(router, () => runtime);
    },

    getOpenApi,

    // _whenReady is not part of the SK Plugin interface. The underscore
    // signals "not in the public contract"; tests (and any in-process
    // consumer that wants to coordinate with the plugin lifecycle) can
    // await the deferred router init that happens after start() returns
    // synchronously. The SK server itself never calls it.
    _whenReady: () => readyPromise,
  };
}

function runningStatus(analyzerCount: number): string {
  const label = analyzerCount === 1 ? 'analyzer' : 'analyzers';
  return `Running with ${analyzerCount} ${label} enabled`;
}

interface AnalyzerSectionLike {
  enabled: boolean;
  triggers: { put: { enabled: boolean } };
}

function registerAnalyzerPut(
  app: ServerApiLike,
  analyzerId: AnalyzerId,
  section: AnalyzerSectionLike,
  getRouter: () => TriggerRouter | null,
  pluginId: string,
): void {
  if (!section.enabled) return;
  if (!section.triggers.put.enabled) return;
  const path = pluginPutPath(analyzerId);
  app.registerPutHandler(
    'vessels.self',
    path,
    (
      _context: string,
      _path: string,
      value: unknown,
      cb: (r: { state: string; statusCode?: number; message?: string }) => void,
    ): { state: string; statusCode?: number; message?: string } => {
      const router = getRouter();
      // Router not yet built (a PUT landing during the deferred init window):
      // resolve synchronously with a terminal result. Returning PENDING here
      // and then calling cb would have the SK contract surface a 503 carrying
      // a PENDING state and a result href that never completes.
      if (!router) {
        return { state: 'COMPLETED', statusCode: 503, message: 'plugin not fully started' };
      }
      // Guard the async ack against double-fire: the SK PENDING/COMPLETED
      // contract expects exactly one cb per request.
      let acked = false;
      const ack = (r: { state: string; statusCode?: number; message?: string }): void => {
        if (acked) return;
        acked = true;
        cb(r);
      };
      void (async () => {
        try {
          await router.dispatch('put', manualPutCtx(value), { putPath: path });
          ack({ state: 'COMPLETED', statusCode: 200 });
        } catch (err) {
          ack({ state: 'FAILED', statusCode: 500, message: stringify(err) });
        }
      })();
      return { state: 'PENDING' };
    },
    pluginId,
  );
}
