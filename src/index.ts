import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionHandler, ActionResult } from '@signalk/server-api';
import type { Analyzer, TriggerCtx } from './analyzers/Analyzer.js';
import { ANALYZER_IDS, type AnalyzerId } from './analyzers/ids.js';
import { ANALYZER_FACTORIES } from './analyzers/registry.js';
import { getOpenApi, type PluginRuntime, type RouterLike, registerApiRoutes } from './core/api.js';
import type { PluginApp } from './core/app.js';
import { AtomicFileWriter } from './core/atomicFile.js';
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
import { compositeKey, HOUR_MS, MINUTE_MS, SECOND_MS } from './core/format.js';
import type { HistoryProvider } from './core/history.js';
import { InfluxDBClient } from './core/influxdb.js';
import { Logger, stringify } from './core/logger.js';
import { OpenRouterClient } from './core/openrouter.js';
import { enginePaths, PLUGIN_ID, pluginPutPath } from './core/paths.js';
import { ReportPublisher } from './core/publisher.js';
import { QuestDBClient } from './core/questdb.js';
import { deltaTimestampMs } from './core/skNode.js';
import { BATTERY_EVENT_KINDS } from './core/triggerContext.js';
import { REPLAYABLE_TRIGGER_KINDS, type RunOutcome, TriggerRouter } from './core/triggerRouter.js';
import { manualPutCtx } from './core/triggers.js';
import { buildSchema, buildUiSchema } from './schema.js';
import { mergeWithDefaults, type PluginOptions } from './types.js';

const PLUGIN_NAME = 'OpenRouter Companion';

const BUFFER_MAX_AGE_MS = 26 * HOUR_MS;
// Raw samples per path. Older samples still read through their minute
// buckets, so this bounds memory, not the window a report covers.
const BUFFER_MAX_ENTRIES_PER_PATH = 50_000;
// Ceiling across every buffered path together, raw samples and minute buckets
// alike, so a vessel with many busy electrical and propulsion paths cannot
// multiply the per-path cap into hundreds of megabytes on a Raspberry Pi.
// Roughly 40 MB. One source's full window is about 1,600 minute buckets, so
// the cap takes raw samples, which fall back to buckets, long before it has
// to shorten any window.
const BUFFER_MAX_TOTAL_ENTRIES = 400_000;
const ENGINE_SOURCE_WINDOW_MS = SECOND_MS;
const BATTERY_SOURCE_WINDOW_MS = 5000;
const MONITOR_TICK_MS = 5000;
const WATCHDOG_TICK_MS = 5000;
const WATCHDOG_SEC = 30;
const RESCAN_INTERVAL_MS = MINUTE_MS;
// On restart, a persisted engine session whose last delta is older than this
// is discarded rather than resumed (the engine stopped during the downtime).
const ENGINE_STATE_MAX_RESUME_MS = HOUR_MS;
// How often the in-progress engine session is persisted to disk so a restart
// mid-session can resume it.
const DETECTOR_SAVE_INTERVAL_MS = MINUTE_MS;
const HISTORY_UNREACHABLE_MESSAGE =
  'History source unreachable; trend analyzers will skip until it recovers';
// Used when the configured report-log filename is not a plain filename.
const DEFAULT_LOG_FILENAME = 'reports.jsonl';
// What a report-log filename may be: letters, digits, dot, dash, and
// underscore. See safeLogFilename.
const PLAIN_FILENAME = /^[A-Za-z0-9._-]+$/;
const ONLY_DOTS = /^\.+$/;
// Ceiling on events held for the router during the deferred init (see
// withRouter in start). The window is a local budget-file read, so one or two
// is the realistic worst case; the bound only stops a pathologically stalled
// init from growing the list without end.
const MAX_PENDING_STARTUP_EVENTS = 32;

export default function createPlugin(app: PluginApp): {
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

  // Set by start() so stop() can write the in-progress engine session out once
  // more before the periodic saver goes away. Null while the plugin is stopped.
  let flushDetectorState: (() => Promise<void>) | null = null;

  // Release every resource start() registered: abort the lifecycle, stop the
  // scheduler, drain stream subscriptions, clear intervals, drop the runtime.
  // Shared by stop() and start()'s own catch, since SK does not call stop()
  // for a start() that threw partway through wiring.
  const releaseResources = (): void => {
    flushDetectorState = null;
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
        // logFilename is not exposed in the schema, so a value with a path
        // separator or a parent segment can only come from a hand-edited
        // config. Keep it a plain filename so the report log cannot be
        // written outside the plugin's own data directory.
        const logPath = join(dataDir, safeLogFilename(cfg.output.logFilename));
        const budgetPath = join(dataDir, 'budget.json');
        const detectorStatePath = join(dataDir, 'engine-detector.json');

        const buffer = new RollingBuffer({
          maxAgeMs: BUFFER_MAX_AGE_MS,
          maxEntriesPerPath: BUFFER_MAX_ENTRIES_PER_PATH,
          maxTotalEntries: BUFFER_MAX_TOTAL_ENTRIES,
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
        const saveDetectorState = persistDetector(detector, detectorStatePath, logger);
        flushDetectorState = saveDetectorState;
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
          fallbackModels: cfg.openrouter.fallbackModels,
          provider: cfg.openrouter.provider,
        });
        const historyCandidate: HistoryProvider | null =
          cfg.history.source === 'questdb'
            ? new QuestDBClient({ url: cfg.history.questdb.url })
            : cfg.history.source === 'influxdb'
              ? new InfluxDBClient({
                  ...cfg.history.influxdb,
                  selfContext: app.selfContext,
                })
              : null;
        // True while any probe of the history source is outstanding, the
        // initial one included, so the periodic recovery probe never runs a
        // second one alongside it.
        let historyProbeInFlight = false;
        // Probe the history source once. A probe that answers wrongly and one
        // that throws both read as unreachable.
        const probeHistory = (candidate: HistoryProvider): Promise<boolean> => {
          historyProbeInFlight = true;
          return candidate
            .probe(lifecycle.signal)
            .catch(() => false)
            .finally(() => {
              historyProbeInFlight = false;
            });
        };
        const probePromise: Promise<HistoryProvider | null> = historyCandidate
          ? probeHistory(historyCandidate).then((ok) => {
              if (!ok) logger.debug(HISTORY_UNREACHABLE_MESSAGE);
              return ok ? historyCandidate : null;
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
        // Events raised before the deferred init wires the router. Their
        // producers clear the state as they emit (the detector ends the
        // session, the monitor flips the per-bank flag), so one dropped here
        // never comes back: a resumed engine session whose stop lands in this
        // window would lose that trip's report for good, and that resume path
        // is exactly when a stop is likely. Hold them and dispatch once the
        // router exists.
        const pendingStartupEvents: Array<(r: TriggerRouter) => void> = [];
        const withRouter = (dispatch: (r: TriggerRouter) => void): void => {
          if (router) {
            dispatch(router);
            return;
          }
          if (pendingStartupEvents.length >= MAX_PENDING_STARTUP_EVENTS) {
            logger.debug('startup event queue full; dropping an event raised before router init');
            return;
          }
          pendingStartupEvents.push(dispatch);
        };
        // The router is built as soon as the budget state (a local file read)
        // resolves, and the history provider is attached separately when the
        // probe settles. Waiting for both would leave the router null for the
        // provider's full 30-second timeout on a configured-but-unreachable
        // history host, and every engine and battery event raised in that
        // window would be dropped. Trend analyzers simply skip until the
        // provider arrives, which is the same degraded mode a history source
        // that is down at start already produces.
        void budgetPromise
          .then(async (budget) => {
            // stop() may have run while the budget load was still in flight (a
            // disable, or a restart). The abort signal is the lifecycle
            // marker: if it fired, this start() is dead. Bail before writing
            // runtime/router or registering crons, otherwise a late resolve
            // resurrects a stopped plugin's runtime (routes would serve stale
            // data) or clobbers a fresh restart's runtime.
            if (lifecycle.signal.aborted) return;
            router = new TriggerRouter(analyzers, {
              buffer,
              history: null,
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
                history: cfg.history,
                analyzers: cfg.analyzers,
              },
              llm,
              budget,
              historyLive: null,
              historyProbed: false,
              analyzers,
              router,
              logPath,
              signal: lifecycle.signal,
              startedAt: Date.now(),
            };
            activeRouter = router;
            const cronRouter = router;
            registerCronJobs(analyzers, cfg, sched, logger, (ids, ctx) => {
              for (const id of ids) void cronRouter.runById(id, ctx);
            });
            logger.debug('router ready');
            // Anything the engine detector or the battery monitor raised while
            // the router was still being built goes out now, in arrival order.
            const built = router;
            for (const dispatch of pendingStartupEvents.splice(0)) dispatch(built);
            // Attach the history provider once its probe settles. The router is
            // already live and serving events by this point; the trend
            // analyzers were the only thing waiting on it.
            const historyLive = await probePromise;
            if (lifecycle.signal.aborted || activeRouter !== built || runtime === null) return;
            built.setHistory(historyLive);
            runtime.historyLive = historyLive;
            runtime.historyProbed = true;
          })
          .catch((err) => {
            // AbortError is the normal stop() path; anything else is a real
            // startup failure that should surface to the admin UI status banner
            // and the SK server log, not get swallowed at debug level.
            const isAbort =
              err instanceof Error &&
              (err.name === 'AbortError' || err.message.includes('aborted'));
            if (isAbort) {
              logger.debug(`startup aborted: ${stringify(err)}`);
              return;
            }
            logger.error(err);
            app.setPluginError(`Startup failed: ${stringify(err)}`);
          })
          // _whenReady resolves once the deferred init has settled either way,
          // router built and history attached, or bailed on a stop.
          .finally(() => signalReady());

        // The detector emits engine-start, engine-stop, and possible-stop.
        // engine-start and engine-stop persist detector state so a restart
        // mid-session can resume it. engine-stop additionally drives the
        // maintenance analyzer, which narrates the completed session.
        unsubs.push(
          detector.on('engine-start', () => {
            void saveDetectorState();
          }),
        );
        unsubs.push(
          detector.on('engine-stop', (e: EngineEvent) => {
            void saveDetectorState();
            const sess = e.session;
            if (!sess) return;
            // The ctx is stamped now, from the session's own timestamps, so a
            // stop held for the router still narrates the trip that ended, not
            // the moment the router came up.
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
            withRouter((r) => {
              void r.dispatch(ctx);
            });
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
          withRouter((r) => {
            void r.dispatch(ctx);
          });
        };
        for (const k of BATTERY_EVENT_KINDS) unsubs.push(monitor.on(k, dispatchBatteryEvent));

        for (const id of ANALYZER_IDS) {
          registerAnalyzerPut(app, id, cfg.analyzers[id], () => activeRouter);
        }

        // Nothing below has a reader without an enabled analyzer: the
        // subscriptions feed the buffer and the detectors, the timers raise
        // events, and the rescan finds new paths and recovers history.
        if (analyzers.length === 0) {
          app.setPluginStatus('No analyzers enabled. Enable at least one in plugin settings.');
          return;
        }

        // Every path subscribed so far, whatever its sink: lets each scan pick
        // up a path that appeared after start() without ever buffering one
        // twice.
        const subscribed = new Set<string>();
        const engineIds = new Set<string>();
        const bankIds = new Set<string>();

        // Subscribe to one self-path. The sink receives the unpacked
        // (value, ts, source) for each delta; non-numeric callers can
        // short-circuit inside the sink.
        const subscribe = (
          path: string,
          sink: (value: unknown, ts: number, source: string) => void,
        ): void => {
          subscribed.add(path);
          const bus = app.streambundle.getSelfBus(path);
          const unsub = bus.onValue((delta) => {
            const d = delta as { value?: unknown; timestamp?: string; $source?: string };
            sink(d.value, deltaTimestampMs(d.timestamp, Date.now()), d.$source ?? 'unknown');
          });
          if (typeof unsub === 'function') unsubs.push(unsub);
        };

        const subscribeEnginePath = (engineId: string, path: string): void => {
          // An operator extra can buffer the RPM path before its engine is
          // discovered. The detector then gets a listener of its own, and the
          // samples are not recorded a second time.
          const buffered = subscribed.has(path);
          subscribe(path, (value, ts, src) => {
            if (typeof value !== 'number') return;
            detector.observe(engineId, src, value, ts);
            if (!buffered) buffer.record(path, value, ts, src);
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

        // Subscribe everything new in one listing of the live tree: each
        // engine's RPM path, which feeds the detector, then every watched path
        // under the WATCH_PREFIXES plus the operator's extras (a battery bank,
        // alternator, charger, or fuel tank that came online after start()).
        // Engines go first, so an RPM path is never subscribed as a plain
        // watched path. Returns whether anything new turned up.
        const scan = (available: readonly string[]): boolean => {
          let changed = false;
          for (const id of discoverEngineIds(available)) {
            if (engineIds.has(id)) continue;
            engineIds.add(id);
            subscribeEnginePath(id, enginePaths(id).rpm);
            changed = true;
          }
          for (const id of discoverBankIds(available)) {
            if (bankIds.has(id)) continue;
            bankIds.add(id);
            changed = true;
          }
          for (const path of discoverWatchedPaths(
            available,
            cfg.analyzers.maintenance.extraWatchedPaths,
          )) {
            if (subscribed.has(path)) continue;
            subscribeWatchedPath(path);
            changed = true;
          }
          return changed;
        };
        scan(app.streambundle.getAvailablePaths());

        // Some analyzers need fixed Signal K paths buffered that are not
        // discovered from the live tree (forecast's weather leaves). Subscribe
        // the union the enabled analyzers declare via Analyzer.watchedPaths, so
        // the lifecycle never special-cases one analyzer by id. These are
        // subscribed unconditionally (not filtered by getAvailablePaths) so a
        // producer that starts after this plugin is still captured;
        // collectContext degrades gracefully on paths that never produce data.
        for (const a of analyzers) {
          for (const path of a.watchedPaths ?? []) {
            if (subscribed.has(path)) continue;
            subscribe(path, (value, ts, src) => {
              if (typeof value === 'number') buffer.record(path, value, ts, src);
            });
          }
        }

        // The engine and battery timers exist to raise events. With no enabled
        // analyzer listening for either kind, they would tick for nobody, so
        // they are registered only when something consumes them.
        const wantsEngineEvents = analyzers.some((a) =>
          a.triggers.some(
            (t) =>
              t.kind === 'engine-start' || t.kind === 'engine-stop' || t.kind === 'possible-stop',
          ),
        );
        const wantsBatteryEvents = analyzers.some((a) =>
          a.triggers.some((t) => t.kind === 'battery-event'),
        );
        if (wantsEngineEvents) {
          intervalHandles.push(
            setInterval(() => detector.tickWatchdog(Date.now()), WATCHDOG_TICK_MS),
          );
          // Persist the in-progress engine session periodically so the
          // restart-resume window stays current between engine-start and the
          // next event (see saveDetectorState and detector.restore above).
          intervalHandles.push(
            setInterval(() => {
              void saveDetectorState();
            }, DETECTOR_SAVE_INTERVAL_MS),
          );
        }
        if (wantsBatteryEvents) {
          intervalHandles.push(setInterval(() => monitor.tick(Date.now()), MONITOR_TICK_MS));
        }
        intervalHandles.push(
          setInterval(() => {
            if (scan(app.streambundle.getAvailablePaths())) {
              app.setPluginStatus(runningStatus(analyzers.length));
            }
            // History recovery: a source that is down at start (or starts after
            // this plugin) must not leave trend analyzers disabled forever.
            if (
              historyCandidate &&
              router &&
              runtime &&
              !runtime.historyLive &&
              !historyProbeInFlight
            ) {
              const live = runtime;
              const routerForRecovery = router;
              void probeHistory(historyCandidate).then((ok) => {
                if (
                  ok &&
                  !lifecycle.signal.aborted &&
                  runtime === live &&
                  activeRouter === routerForRecovery
                ) {
                  routerForRecovery.setHistory(historyCandidate);
                  live.historyLive = historyCandidate;
                  logger.debug('History source recovered; trend analyzers re-enabled');
                }
              });
            }
          }, RESCAN_INTERVAL_MS),
        );

        if (engineIds.size === 0 && bankIds.size === 0) {
          app.setPluginStatus(
            `Running: no engine or battery data yet, re-scanning every ${RESCAN_INTERVAL_MS / SECOND_MS}s`,
          );
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
      // Write the in-progress engine session out one last time: the periodic
      // saver runs every 60 seconds, so a stop mid-session would otherwise
      // leave the resume window that stale.
      await flushDetectorState?.();
      // The SK server sets the plugin status after stop() resolves, so an
      // explicit 'Stopped' here would only be overwritten.
      releaseResources();
    },

    // Every route here spends OpenRouter budget, fires an LLM call, probes a
    // URL from the Signal K host, or reads operator configuration and report
    // history, so all of them must be admin-only. The server already enforces
    // that: it mounts admin authentication over /plugins (since 2.24, and
    // through its plugin route permissions since 2.33, where a route nobody
    // declared readonly or readwrite stays admin-only), and this plugin
    // declares no such permission. Reaching for app.securityStrategy here
    // would add nothing and is a server internal plugin CI flags.
    registerWithRouter: (router: RouterLike) => {
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

// Accept a configured log filename only when it is a plain filename in the
// plugin's data directory, falling back to the shipped default otherwise. An
// allowlist rather than a list of known-bad values: a separator, a traversal,
// and anything else nobody thought of is rejected by default, and a name made
// only of dots is rejected on top because '.' and '..' name a directory, so
// every append would fail with EISDIR.
function safeLogFilename(configured: string): string {
  return PLAIN_FILENAME.test(configured) && !ONLY_DOTS.test(configured)
    ? configured
    : DEFAULT_LOG_FILENAME;
}

function runningStatus(analyzerCount: number): string {
  const label = analyzerCount === 1 ? 'analyzer' : 'analyzers';
  return `Running with ${analyzerCount} ${label} enabled`;
}

// Resume an engine session that was in progress when the plugin last stopped,
// so a restart mid-trip neither splits nor loses the session, and return the
// saver that keeps that file current.
//
// The saver writes only when the snapshot actually changed: the engine is off
// most of the time, so an unconditional periodic write would rewrite the same
// empty state to the SD card every interval. Its writes are serialized and
// atomic, because the periodic saver, the engine-start listener, and the
// engine-stop listener can all fire close together.
function persistDetector(
  detector: EngineDetector,
  statePath: string,
  logger: Logger,
): () => Promise<void> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath, 'utf-8'));
    if (Array.isArray(parsed)) detector.restore(parsed, Date.now(), ENGINE_STATE_MAX_RESUME_MS);
  } catch {
    // No persisted state, or unreadable: start with a clean detector.
  }
  let lastWritten = '';
  const writer = new AtomicFileWriter(statePath, (err) => {
    // Clear the memo so the next save retries rather than treating this
    // snapshot as already on disk.
    lastWritten = '';
    logger.debug(`engine-detector state save failed: ${stringify(err)}`);
  });
  return () => {
    const serialized = JSON.stringify(detector.snapshot());
    if (serialized === lastWritten) return writer.settled();
    lastWritten = serialized;
    return writer.write(serialized);
  };
}

// Register one Cron job per unique (pattern, timezone) pair, each carrying the
// analyzers that share it. Several analyzers can share a schedule (health and
// liveness both default to '0 8 * * *'), so a job per analyzer would
// double-spend the budget. The job fires its members by id, not through
// router.dispatch: dispatch matches cron by pattern alone, so two analyzers on
// the same pattern but different timezones would each run on both jobs. Naming
// the members keeps every job bound to exactly its pair.
function registerCronJobs(
  analyzers: readonly Analyzer[],
  cfg: PluginOptions,
  scheduler: CronScheduler,
  logger: Logger,
  fire: (ids: readonly AnalyzerId[], ctx: TriggerCtx) => void,
): void {
  const jobs = new Map<string, { pattern: string; timezone: string; ids: AnalyzerId[] }>();
  for (const a of analyzers) {
    const timezone = cfg.analyzers[a.id].triggers.cron.timezone;
    for (const t of a.triggers) {
      if (t.kind !== 'cron') continue;
      const key = compositeKey(t.pattern, timezone);
      const existing = jobs.get(key);
      if (existing) existing.ids.push(a.id);
      else jobs.set(key, { pattern: t.pattern, timezone, ids: [a.id] });
    }
  }
  for (const { pattern, timezone, ids } of jobs.values()) {
    try {
      scheduler.register(
        pattern,
        () => fire(ids, { kind: 'cron', firedAt: new Date() }),
        timezone || undefined,
      );
    } catch (err) {
      logger.error(`failed to register cron '${pattern}': ${stringify(err)}`);
    }
  }
}

// Map the outcomes of a PUT-triggered run onto the Signal K PUT contract. A
// PUT that produced no report must not answer 200 COMPLETED as if it had: the
// router resolves rather than rejects, so the outcomes are the only signal.
function putAckFor(outcomes: readonly RunOutcome[]): ActionResult {
  if (outcomes.includes('failed')) {
    return { state: 'FAILED', statusCode: 500, message: 'analyzer run failed' };
  }
  if (outcomes.includes('reported')) return { state: 'COMPLETED', statusCode: 200 };
  if (outcomes.includes('budget-exhausted')) {
    return { state: 'COMPLETED', statusCode: 429, message: 'daily call budget exhausted' };
  }
  if (outcomes.includes('already-running')) {
    return { state: 'COMPLETED', statusCode: 409, message: 'a run is already in flight' };
  }
  if (outcomes.includes('aborted')) {
    return { state: 'COMPLETED', statusCode: 503, message: 'the plugin stopped mid-run' };
  }
  // A PUT is a replayable trigger, so the router skips rather than defers it
  // and no run started here comes back queued today. The claim is checked
  // rather than narrated: the day 'put' leaves that set, a deferred run gets
  // its own answer instead of being reported as "nothing to report".
  if (!REPLAYABLE_TRIGGER_KINDS.has('put') && outcomes.includes('queued')) {
    return {
      state: 'COMPLETED',
      statusCode: 202,
      message: 'queued behind a run already in flight',
    };
  }
  if (outcomes.length === 0) {
    return { state: 'COMPLETED', statusCode: 200, message: 'no analyzer listens on this path' };
  }
  return { state: 'COMPLETED', statusCode: 200, message: 'nothing to report' };
}

function registerAnalyzerPut(
  app: Pick<PluginApp, 'registerPutHandler'>,
  analyzerId: AnalyzerId,
  section: { enabled: boolean; triggers: { put: { enabled: boolean } } },
  getRouter: () => TriggerRouter | null,
): void {
  if (!section.enabled) return;
  if (!section.triggers.put.enabled) return;
  const path = pluginPutPath(analyzerId);
  // The PUT value is not read: a PUT to this path means "run once", whatever
  // it carries.
  const handler: ActionHandler = (_context, _path, _value, cb) => {
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
    const ack = (r: ActionResult): void => {
      if (acked) return;
      acked = true;
      cb(r);
    };
    void (async () => {
      try {
        ack(putAckFor(await router.dispatch(manualPutCtx(path))));
      } catch (err) {
        ack({ state: 'FAILED', statusCode: 500, message: stringify(err) });
      }
    })();
    return { state: 'PENDING' };
  };
  app.registerPutHandler('vessels.self', path, handler, PLUGIN_ID);
}
