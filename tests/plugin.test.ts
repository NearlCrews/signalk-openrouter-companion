import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    const beforeListeners = app.buses.get('propulsion.port.revolutions')!.listenerCount();
    expect(beforeListeners).toBeGreaterThan(0);
    await plugin.stop();
    expect(app.buses.get('propulsion.port.revolutions')!.listenerCount()).toBe(0);
    expect(app.statusMessages.at(-1)).toBe('Stopped');
  });

  it('supports a start/stop/start cycle', async () => {
    app.availablePaths = ['propulsion.port.revolutions'];
    const plugin = createPlugin(app as never);
    plugin.start({ openrouter: { apiKey: 'sk-x' } } as never, () => {});
    const firstPutCount = app.registeredPuts.length;
    expect(firstPutCount).toBeGreaterThan(0);
    await plugin.stop();
    expect(app.buses.get('propulsion.port.revolutions')!.listenerCount()).toBe(0);

    plugin.start({ openrouter: { apiKey: 'sk-x' } } as never, () => {});
    expect(app.buses.get('propulsion.port.revolutions')!.listenerCount()).toBeGreaterThan(0);
    expect(app.registeredPuts.length).toBe(firstPutCount * 2);
    await plugin.stop();
    expect(app.statusMessages.at(-1)).toBe('Stopped');
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
    const put = app.registeredPuts.find(
      (r) => r.path === 'plugins.openrouter-companion.maintenance.run',
    );
    expect(put).toBeDefined();

    const cb = vi.fn();
    const sync = (put!.handler as (...args: unknown[]) => unknown)(
      'vessels.self',
      'plugins.openrouter-companion.maintenance.run',
      { reason: 'manual' },
      cb,
    );
    expect(sync).toEqual({ state: 'PENDING' });

    await vi.waitFor(() => expect(cb).toHaveBeenCalled(), { timeout: 2000 });
    const arg = cb.mock.calls[0]![0] as { state: string };
    expect(arg.state).toBe('COMPLETED');

    vi.unstubAllGlobals();
    await plugin.stop();
  });
});
