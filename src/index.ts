import { join } from 'node:path';
import type { Analyzer, TriggerCtx } from './analyzers/Analyzer.js';
import { MaintenanceAnalyzer } from './analyzers/maintenance.js';
import { BudgetTracker } from './core/budget.js';
import { RollingBuffer } from './core/buffer.js';
import { CronScheduler } from './core/cronScheduler.js';
import { discoverEngineIds, discoverWatchedPaths } from './core/discovery.js';
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
  let intervalHandles: NodeJS.Timeout[] = [];
  let lifecycleController: AbortController | null = null;
  let restartFn: (() => void) | null = null;
  let scheduler: CronScheduler | null = null;

  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description: 'OpenRouter-powered analyzers for Signal K: maintenance reports and more.',
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

        const buffer = new RollingBuffer({ maxAgeMs: 6 * 3600 * 1000, maxEntriesPerPath: 10_000 });
        const detector = new EngineDetector({
          stopRpmHz: cfg.analyzers.maintenance.engineStopRpmHzThreshold,
          stopSettleSec: cfg.analyzers.maintenance.engineStopSettleSeconds,
          startRpmHz: cfg.analyzers.maintenance.engineStartRpmHzThreshold,
          startSettleSec: cfg.analyzers.maintenance.engineStartSettleSeconds,
          watchdogSec: 30,
          sourceWindowMs: 1000,
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

        const maintenance = cfg.analyzers.maintenance.enabled
          ? new MaintenanceAnalyzer({
              triggers: cfg.analyzers.maintenance.triggers,
              minSessionSeconds: cfg.analyzers.maintenance.minSessionSeconds,
            })
          : null;
        const analyzers: Analyzer[] = maintenance ? [maintenance] : [];

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
          logger.debug(`possible-stop: engine ${e.engineId} silent for >${30}s while running`);
        });

        const available = app.streambundle.getAvailablePaths();
        const engineIds = discoverEngineIds(available);
        if (engineIds.length === 0) {
          app.setPluginStatus('Running, no engine data detected');
          return;
        }
        const watched = discoverWatchedPaths(
          available,
          cfg.analyzers.maintenance.extraWatchedPaths,
        );

        for (const engineId of engineIds) {
          const rpmPath = `propulsion.${engineId}.revolutions`;
          const bus = app.streambundle.getSelfBus(rpmPath);
          const unsub = bus.onValue((delta) => {
            const d = delta as { value?: unknown; timestamp?: string; $source?: string };
            const ts = d.timestamp ? Date.parse(d.timestamp) : Date.now();
            const src = d.$source ?? 'unknown';
            const v = typeof d.value === 'number' ? d.value : null;
            if (v != null) {
              detector.observe(engineId, src, v, ts);
              buffer.record(rpmPath, v, ts, src);
            }
          });
          if (unsub) unsubs.push(unsub);
        }

        for (const path of watched) {
          if (path.endsWith('.revolutions') && discoverEngineIds([path]).length > 0) continue;
          const bus = app.streambundle.getSelfBus(path);
          const unsub = bus.onValue((delta) => {
            const d = delta as { value?: unknown; timestamp?: string; $source?: string };
            const ts = d.timestamp ? Date.parse(d.timestamp) : Date.now();
            const src = d.$source ?? 'unknown';
            buffer.record(path, d.value, ts, src);
          });
          if (unsub) unsubs.push(unsub);
        }

        app.subscriptionmanager.subscribe(
          {
            context: 'vessels.self',
            subscribe: [{ path: 'notifications.propulsion.*', policy: 'instant' }],
          },
          unsubs,
          (err) => logger.error(stringify(err)),
          () => {
            /* captured by analyzers via getSelfPath snapshot */
          },
        );

        if (
          maintenance &&
          cfg.analyzers.maintenance.triggers.put.enabled &&
          cfg.analyzers.maintenance.triggers.put.path
        ) {
          const putPath = cfg.analyzers.maintenance.triggers.put.path;
          app.registerPutHandler(
            'vessels.self',
            putPath,
            (
              _context: string,
              _path: string,
              value: unknown,
              cb: (r: { state: string; statusCode?: number; message?: string }) => void,
            ): { state: string } => {
              void (async () => {
                try {
                  if (!router) {
                    cb({
                      state: 'COMPLETED',
                      statusCode: 503,
                      message: 'plugin not fully started',
                    });
                    return;
                  }
                  const ctx: TriggerCtx = { kind: 'put', firedAt: new Date(), put: { value } };
                  await router.dispatch('put', ctx, { putPath });
                  cb({ state: 'COMPLETED', statusCode: 200 });
                } catch (err) {
                  cb({ state: 'COMPLETED', statusCode: 500, message: stringify(err) });
                }
              })();
              return { state: 'PENDING' };
            },
            PLUGIN_ID,
          );
        }

        intervalHandles.push(setInterval(() => detector.tickWatchdog(Date.now()), 5000));
        intervalHandles.push(
          setInterval(() => {
            const fresh = app.streambundle.getAvailablePaths();
            const newEngines = discoverEngineIds(fresh).filter((id) => !engineIds.includes(id));
            for (const id of newEngines) {
              engineIds.push(id);
              const path = `propulsion.${id}.revolutions`;
              const bus = app.streambundle.getSelfBus(path);
              const u = bus.onValue((delta) => {
                const d = delta as { value?: unknown; timestamp?: string; $source?: string };
                const ts = d.timestamp ? Date.parse(d.timestamp) : Date.now();
                const src = d.$source ?? 'unknown';
                const v = typeof d.value === 'number' ? d.value : null;
                if (v != null) {
                  detector.observe(id, src, v, ts);
                  buffer.record(path, v, ts, src);
                }
              });
              if (u) unsubs.push(u);
            }
          }, 60_000),
        );

        app.setPluginStatus('Running');
      } catch (err) {
        app.setPluginError(stringify(err));
      }
    },

    stop: async () => {
      if (lifecycleController) {
        lifecycleController.abort();
        lifecycleController = null;
      }
      restartFn = null;
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
      intervalHandles = [];
      app.setPluginStatus('Stopped');
    },
  };
}
