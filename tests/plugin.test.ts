import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteRequest, RouteResponse, RouterLike } from '../src/core/api.js';
import { CronScheduler } from '../src/core/cronScheduler.js';
import { TriggerRouter } from '../src/core/triggerRouter.js';
import createPlugin from '../src/index.js';
import { cleanupTmpDir, type MockApp, makeMockApp, makeTmpDir } from './_mocks.js';

describe('plugin lifecycle', () => {
  let dir: string;
  let app: MockApp;
  beforeEach(async () => {
    dir = await makeTmpDir();
    app = makeMockApp(dir);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await cleanupTmpDir(dir);
  });

  it('loads but stays inert when apiKey is missing', () => {
    const plugin = createPlugin(app as never);
    plugin.start({}, () => {});
    expect(app.statusMessages.at(-1)).toMatch(/Awaiting API key/);
    expect(app.registeredPuts).toHaveLength(0);
  });

  it('reports "no engine or battery data yet" when neither domain has data, and still sets up rescan', async () => {
    app.availablePaths = ['environment.water.temperature'];
    const plugin = createPlugin(app as never);
    plugin.start({ openrouter: { apiKey: 'sk-x' } } as never, () => {});
    expect(app.statusMessages.some((m) => m.includes('no engine or battery data yet'))).toBe(true);
    expect(app.registeredPuts.length).toBeGreaterThan(0);
  });

  it('subscribes to discovered engine RPM paths and registers PUT handler', () => {
    app.availablePaths = ['propulsion.port.revolutions', 'propulsion.starboard.revolutions'];
    const plugin = createPlugin(app as never);
    plugin.start({ openrouter: { apiKey: 'sk-x' } } as never, () => {});
    expect(app.buses.has('propulsion.port.revolutions')).toBe(true);
    expect(app.buses.has('propulsion.starboard.revolutions')).toBe(true);
    expect(
      app.registeredPuts.some(
        (r) =>
          r.path === 'plugins.openrouter-companion.maintenance.run' && r.context === 'vessels.self',
      ),
    ).toBe(true);
  });

  it('subscribes to discovered bank paths and registers health PUT handler', () => {
    app.availablePaths = [
      'electrical.batteries.house.voltage',
      'electrical.batteries.house.current',
      'electrical.batteries.house.capacity.stateOfCharge',
      'electrical.batteries.starter.voltage',
    ];
    const plugin = createPlugin(app as never);
    plugin.start({ openrouter: { apiKey: 'sk-x' } } as never, () => {});
    expect(app.buses.has('electrical.batteries.house.voltage')).toBe(true);
    expect(app.buses.has('electrical.batteries.house.capacity.stateOfCharge')).toBe(true);
    expect(app.buses.has('electrical.batteries.starter.voltage')).toBe(true);
    expect(
      app.registeredPuts.some(
        (r) => r.path === 'plugins.openrouter-companion.health.run' && r.context === 'vessels.self',
      ),
    ).toBe(true);
  });

  it('subscribes to both engine and battery paths when both domains are present', () => {
    app.availablePaths = ['propulsion.port.revolutions', 'electrical.batteries.house.voltage'];
    const plugin = createPlugin(app as never);
    plugin.start({ openrouter: { apiKey: 'sk-x' } } as never, () => {});
    expect(app.buses.has('propulsion.port.revolutions')).toBe(true);
    expect(app.buses.has('electrical.batteries.house.voltage')).toBe(true);
  });

  it('drains subscriptions on stop()', async () => {
    app.availablePaths = ['propulsion.port.revolutions'];
    const plugin = createPlugin(app as never);
    plugin.start({ openrouter: { apiKey: 'sk-x' } } as never, () => {});
    const beforeListeners = app.buses.get('propulsion.port.revolutions')?.listenerCount();
    expect(beforeListeners).toBeGreaterThan(0);
    await plugin.stop();
    expect(app.buses.get('propulsion.port.revolutions')?.listenerCount()).toBe(0);
    expect(app.statusMessages.at(-1)).toBe('Stopped');
  });

  it('supports a start/stop/start cycle', async () => {
    app.availablePaths = ['propulsion.port.revolutions'];
    const plugin = createPlugin(app as never);
    plugin.start({ openrouter: { apiKey: 'sk-x' } } as never, () => {});
    const firstPutCount = app.registeredPuts.length;
    expect(firstPutCount).toBeGreaterThan(0);
    await plugin.stop();
    expect(app.buses.get('propulsion.port.revolutions')?.listenerCount()).toBe(0);

    plugin.start({ openrouter: { apiKey: 'sk-x' } } as never, () => {});
    expect(app.buses.get('propulsion.port.revolutions')?.listenerCount()).toBeGreaterThan(0);
    expect(app.registeredPuts.length).toBe(firstPutCount * 2);
    await plugin.stop();
    expect(app.statusMessages.at(-1)).toBe('Stopped');
  });

  it('does not resurrect the runtime when stop() races the deferred router init', async () => {
    app.availablePaths = ['propulsion.port.revolutions'];
    const plugin = createPlugin(app as never);

    // Capture the REST route handlers so the runtime can be probed via the
    // /api/status route, which is the only externally visible surface of the
    // module-private `runtime` snapshot.
    const routes = new Map<string, (req: RouteRequest, res: RouteResponse) => unknown>();
    const mockRouter: RouterLike = {
      get: (path, handler) => routes.set(path, handler),
      post: (path, handler) => routes.set(path, handler),
    };
    plugin.registerWithRouter(mockRouter);

    // QuestDB disabled so the probe resolves immediately; the budget load is
    // the in-flight async work the deferred init awaits. start() returns
    // synchronously, then stop() runs before that init resolves.
    plugin.start(
      { openrouter: { apiKey: 'sk-x' }, questdb: { enabled: false } } as never,
      () => {},
    );
    await plugin.stop();
    // whenReady resolves once the deferred init has run (it calls signalReady
    // on both the abort-skip path and the normal path).
    await plugin.whenReady();

    const statusHandler = routes.get('/api/status');
    expect(statusHandler).toBeDefined();
    let statusCode = 0;
    const res: RouteResponse = {
      status(code) {
        statusCode = code;
        return res;
      },
      json() {
        return res;
      },
      send() {
        return res;
      },
    };
    statusHandler?.({}, res);
    // A plugin stopped mid-startup must report 503, not serve a runtime that a
    // late deferred-init resolve resurrected.
    expect(statusCode).toBe(503);
  });

  it('registers one cron job per unique (pattern, timezone) pair, not per analyzer', async () => {
    // Defaults: health + liveness both cron '0 8 * * *', aging '0 8 1 * *',
    // drift '0 8 * * 0'. Four cron-enabled analyzers but only three unique
    // patterns; the router dispatches cron by pattern and fans out to every
    // matching analyzer, so a job per analyzer would double-run the shared
    // schedule.
    const registerSpy = vi.spyOn(CronScheduler.prototype, 'register');
    const plugin = createPlugin(app as never);
    plugin.start(
      { openrouter: { apiKey: 'sk-x' }, questdb: { enabled: false } } as never,
      () => {},
    );
    await plugin.whenReady();

    const patterns = registerSpy.mock.calls.map((c) => c[0]);
    expect(patterns).toHaveLength(3);
    expect(new Set(patterns)).toEqual(new Set(['0 8 * * *', '0 8 1 * *', '0 8 * * 0']));

    registerSpy.mockRestore();
    await plugin.stop();
  });

  it('passes each analyzer cron timezone through to the scheduler', async () => {
    const registerSpy = vi.spyOn(CronScheduler.prototype, 'register');
    const plugin = createPlugin(app as never);
    plugin.start(
      {
        openrouter: { apiKey: 'sk-x' },
        questdb: { enabled: false },
        analyzers: { drift: { triggers: { cron: { timezone: 'America/New_York' } } } },
      } as never,
      () => {},
    );
    await plugin.whenReady();

    const driftCall = registerSpy.mock.calls.find((c) => c[0] === '0 8 * * 0');
    expect(driftCall?.[2]).toBe('America/New_York');
    // Analyzers without a configured timezone register with no override.
    const healthCall = registerSpy.mock.calls.find((c) => c[0] === '0 8 * * *');
    expect(healthCall?.[2]).toBeUndefined();

    registerSpy.mockRestore();
    await plugin.stop();
  });

  it('subscribes to a watched path that appears after start, via the rescan', async () => {
    vi.useFakeTimers();
    // Noon: no default cron ('0 8 * * *' etc.) fires within the advance below.
    vi.setSystemTime(new Date('2026-05-10T12:00:00Z'));
    app.availablePaths = ['propulsion.port.revolutions'];
    const plugin = createPlugin(app as never);
    plugin.start(
      { openrouter: { apiKey: 'sk-x' }, questdb: { enabled: false } } as never,
      () => {},
    );
    await plugin.whenReady();
    expect(app.buses.has('electrical.alternators.1.voltage')).toBe(false);

    // An alternator comes online after start(); the 60s rescan must pick it
    // up. Before the fix only new battery banks were re-subscribed.
    app.availablePaths = ['propulsion.port.revolutions', 'electrical.alternators.1.voltage'];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(app.buses.has('electrical.alternators.1.voltage')).toBe(true);

    await plugin.stop();
  });

  it('binds each cron job to only its own (pattern, timezone) analyzers', async () => {
    // health and liveness both default to cron '0 8 * * *'. Give them
    // distinct timezones so the (pattern, timezone) dedup yields two jobs on
    // the same pattern. Each job must fire only its own analyzer; a job that
    // dispatched by pattern would fan out to both and double-spend the budget.
    const registerSpy = vi.spyOn(CronScheduler.prototype, 'register');
    const runByIdSpy = vi.spyOn(TriggerRouter.prototype, 'runById').mockResolvedValue(undefined);
    const plugin = createPlugin(app as never);
    plugin.start(
      {
        openrouter: { apiKey: 'sk-x' },
        questdb: { enabled: false },
        analyzers: {
          health: { triggers: { cron: { timezone: 'UTC' } } },
          liveness: { triggers: { cron: { timezone: 'America/New_York' } } },
        },
      } as never,
      () => {},
    );
    await plugin.whenReady();

    const dailyJobs = registerSpy.mock.calls.filter((c) => c[0] === '0 8 * * *');
    expect(dailyJobs).toHaveLength(2);
    const utcJob = dailyJobs.find((c) => c[2] === 'UTC');
    const nyJob = dailyJobs.find((c) => c[2] === 'America/New_York');
    expect(utcJob).toBeDefined();
    expect(nyJob).toBeDefined();

    (utcJob?.[1] as () => void)();
    expect(runByIdSpy.mock.calls.map((c) => c[0])).toEqual(['health']);

    runByIdSpy.mockClear();
    (nyJob?.[1] as () => void)();
    expect(runByIdSpy.mock.calls.map((c) => c[0])).toEqual(['liveness']);

    registerSpy.mockRestore();
    runByIdSpy.mockRestore();
    await plugin.stop();
  });

  it('resolves whenReady and reports an error when start() throws synchronously', async () => {
    app.streambundle.getAvailablePaths = () => {
      throw new Error('discovery boom');
    };
    const plugin = createPlugin(app as never);
    plugin.start({ openrouter: { apiKey: 'sk-x' } } as never, () => {});
    // The synchronous failure must still resolve readyPromise; otherwise
    // whenReady() hangs forever.
    await plugin.whenReady();
    expect(app.errorMessages.some((m) => m.includes('discovery boom'))).toBe(true);
  });

  it('invokes the PUT handler callback with state COMPLETED', async () => {
    app.availablePaths = ['propulsion.port.revolutions'];
    // Stub global fetch so the OpenRouter call inside the dispatch doesn't hit the network.
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok' } }],
            model: 'm',
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const plugin = createPlugin(app as never);
    plugin.start({ openrouter: { apiKey: 'sk-x' } } as never, () => {});
    // Wait for the router to be wired before invoking the PUT handler;
    // otherwise getRouter() returns null and the callback fires FAILED.
    await plugin.whenReady();
    const put = app.registeredPuts.find(
      (r) => r.path === 'plugins.openrouter-companion.maintenance.run',
    );
    expect(put).toBeDefined();

    const cb = vi.fn();
    const sync = (put?.handler as (...args: unknown[]) => unknown)(
      'vessels.self',
      'plugins.openrouter-companion.maintenance.run',
      { reason: 'manual' },
      cb,
    );
    expect(sync).toEqual({ state: 'PENDING' });

    await vi.waitFor(() => expect(cb).toHaveBeenCalled(), { timeout: 2000 });
    const arg = cb.mock.calls[0]?.[0] as { state: string };
    expect(arg.state).toBe('COMPLETED');

    vi.unstubAllGlobals();
    await plugin.stop();
  });
});
