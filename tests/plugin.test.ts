import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('reports "no engine data detected" when no propulsion paths exist', async () => {
    app.availablePaths = ['environment.water.temperature'];
    const plugin = createPlugin(app as never);
    plugin.start({ openrouter: { apiKey: 'sk-x' } } as never, () => {});
    expect(app.statusMessages.some((m) => m.includes('no engine data detected'))).toBe(true);
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
});
