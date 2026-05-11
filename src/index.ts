import { join } from 'node:path';
import type { Analyzer, BatteryEventKind, TriggerCtx } from './analyzers/Analyzer.js';
import { AlertAnalyzer } from './analyzers/alerts.js';
import { HealthAnalyzer } from './analyzers/health.js';
import { MaintenanceAnalyzer } from './analyzers/maintenance.js';
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
import { ReportPublisher } from './core/publisher.js';
import { QuestDBClient } from './core/questdb.js';
import { TriggerRouter } from './core/triggerRouter.js';
import { buildSchema, buildUiSchema } from './schema.js';
import { mergeWithDefaults, type PluginOptions } from './types.js';

const PLUGIN_ID = 'signalk-openrouter-companion';
const PLUGIN_NAME = 'OpenRouter Companion';

const BUFFER_MAX_AGE_MS = 26 * 3600 * 1000;
const BUFFER_MAX_ENTRIES_PER_PATH = 50_000;
const SOURCE_WINDOW_MS = 1000;
const MONITOR_SOURCE_WINDOW_MS = 5000;
const MONITOR_TICK_MS = 5000;
const WATCHDOG_TICK_MS = 5000;
const WATCHDOG_SEC = 30;
const RESCAN_INTERVAL_MS = 60_000;

const BATTERY_SUBKINDS: ReadonlyArray<BatteryEventKind> = [
  'low-soc-enter',
  'low-soc-exit',
  'cell-imbalance-enter',
  'cell-imbalance-exit',
];

interface ServerApiLike {
  streambundle: {
    getSelfBus(path: string): { onValue(cb: (v: unknown) => void): () => void };
    getAvailablePaths(): string[];
  };
  subscriptionmanager: {
    subscribe(
      msg: unknown,
      unsubs: Array<() => void>,
      errCb: (err: unknown) => void,
      deltaCb: (delta: unknown) => void,
    ): void;
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
} {
  const logger = new Logger(app);
  const unsubs: Array<() => void> = [];
  const intervalHandles: NodeJS.Timeout[] = [];
  let lifecycleController: AbortController | null = null;
  let restartFn: (() => void) | null = null;
  let scheduler: CronScheduler | null = null;

  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description:
      'OpenRouter-powered analyzers for Signal K: engine maintenance, battery health, and threshold alerts.',
    enabledByDefault: false,
    schema: () => buildSchema(),
    uiSchema: () => buildUiSchema(),

    start: (rawSettings, restart) => {
      try {
        app.setPluginStatus('Starting');
        const cfg = mergeWithDefaults(rawSettings);
        if (!cfg.openrouter.apiKey) {
          app.setPluginStatus('Awaiting API key configuration');
          return;
        }
        lifecycleController = new AbortController();
        restartFn = restart;
        scheduler = new CronScheduler({
          tz: cfg.analyzers.maintenance.triggers.cron.timezone || undefined,
        });

        const dataDir = app.getDataDirPath();
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
          sourceWindowMs: SOURCE_WINDOW_MS,
        });
        const monitor = new BatteryMonitor({
          lowSocPercent: cfg.analyzers.alerts.lowSocPercent,
          socExitHysteresis: cfg.analyzers.alerts.socExitHysteresis,
          cellImbalanceV: cfg.analyzers.alerts.cellImbalanceV,
          imbalanceSettleSec: cfg.analyzers.alerts.imbalanceSettleSec,
          sourceWindowMs: MONITOR_SOURCE_WINDOW_MS,
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
              if (!ok) logger.debug('QuestDB unreachable; baselines disabled for this run');
              return ok ? questdbCandidate : null;
            })
          : Promise.resolve(null);
        const publisher = new ReportPublisher({
          app,
          pluginId: PLUGIN_ID,
          notificationPath: cfg.output.notificationPath,
          notificationState: cfg.output.notificationState,
          logPath,
        });

        const analyzers: Analyzer[] = [];
        if (cfg.analyzers.maintenance.enabled) {
          analyzers.push(
            new MaintenanceAnalyzer({
              triggers: cfg.analyzers.maintenance.triggers,
              minSessionSeconds: cfg.analyzers.maintenance.minSessionSeconds,
            }),
          );
        }
        if (cfg.analyzers.health.enabled) {
          analyzers.push(new HealthAnalyzer({ triggers: cfg.analyzers.health.triggers }));
        }
        if (cfg.analyzers.alerts.enabled) {
          analyzers.push(new AlertAnalyzer({ triggers: cfg.analyzers.alerts.triggers }));
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
              app: { getSelfPath: (p) => app.getSelfPath(p), selfContext: app.selfContext },
              setStatus: (m) => app.setPluginStatus(m),
              requestRestart: () => restartFn?.(),
            });
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
          })
          .catch((err) => logger.debug(`startup aborted: ${stringify(err)}`));

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
        });

        detector.on('possible-stop', (e) => {
          logger.debug(
            `possible-stop: engine ${e.engineId} silent for >${WATCHDOG_SEC}s while running`,
          );
        });

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
        for (const k of BATTERY_SUBKINDS) monitor.on(k, dispatchBatteryEvent);

        const available = app.streambundle.getAvailablePaths();
        const engineIds = discoverEngineIds(available);
        const bankIds = discoverBankIds(available);
        if (engineIds.length === 0 && bankIds.length === 0) {
          app.setPluginStatus('Running, no engine or battery data detected');
          return;
        }
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
          const bus = app.streambundle.getSelfBus(path);
          const unsub = bus.onValue((delta) => {
            const d = delta as { value?: unknown; timestamp?: string; $source?: string };
            const ts = d.timestamp ? Date.parse(d.timestamp) : Date.now();
            const src = d.$source ?? 'unknown';
            buffer.record(path, d.value, ts, src);
            if (typeof d.value !== 'number') return;
            const socMatch = path.match(SOC_PATH_RE);
            if (socMatch) {
              monitor.observeSoc(socMatch[1]!, src, d.value, ts);
              return;
            }
            const cellMatch = path.match(CELL_VOLT_PATH_RE);
            if (cellMatch) {
              monitor.observeCellV(cellMatch[1]!, Number.parseInt(cellMatch[2]!, 10), d.value, ts);
            }
          });
          if (unsub) unsubs.push(unsub);
        };

        for (const engineId of engineIds) {
          subscribeEnginePath(engineId, `propulsion.${engineId}.revolutions`);
        }

        const engineRpmPaths = new Set(engineIds.map((id) => `propulsion.${id}.revolutions`));
        for (const path of watched) {
          if (engineRpmPaths.has(path)) continue;
          subscribeWatchedPath(path);
        }

        registerAnalyzerPut(app, cfg.analyzers.maintenance, () => router, PLUGIN_ID);
        registerAnalyzerPut(app, cfg.analyzers.health, () => router, PLUGIN_ID);
        registerAnalyzerPut(app, cfg.analyzers.alerts, () => router, PLUGIN_ID);

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
              subscribeEnginePath(id, `propulsion.${id}.revolutions`);
            }
            const newBanks = discoverBankIds(fresh).filter((id) => !bankIds.includes(id));
            if (newBanks.length > 0) {
              const freshWatched = discoverWatchedPaths(
                fresh,
                cfg.analyzers.maintenance.extraWatchedPaths,
              );
              for (const id of newBanks) {
                bankIds.push(id);
                const prefix = `electrical.batteries.${id}.`;
                for (const path of freshWatched) {
                  if (engineRpmPaths.has(path)) continue;
                  if (path.startsWith(prefix)) subscribeWatchedPath(path);
                }
              }
            }
          }, RESCAN_INTERVAL_MS),
        );

        app.setPluginStatus('Running');
      } catch (err) {
        app.setPluginError(stringify(err));
      }
    },

    stop: async () => {
      restartFn = null;
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
      app.setPluginStatus('Stopped');
    },
  };
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
              state: 'COMPLETED',
              statusCode: 503,
              message: 'plugin not fully started',
            });
            return;
          }
          const ctx: TriggerCtx = { kind: 'put', firedAt: new Date(), put: { value } };
          await router.dispatch('put', ctx, { putPath: path });
          cb({ state: 'COMPLETED', statusCode: 200 });
        } catch (err) {
          cb({ state: 'COMPLETED', statusCode: 500, message: stringify(err) });
        }
      })();
      return { state: 'PENDING' };
    },
    pluginId,
  );
}
