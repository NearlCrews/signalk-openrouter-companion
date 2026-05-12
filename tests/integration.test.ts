import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import createPlugin from '../src/index.js';
import { cleanupTmpDir, type MockApp, makeMockApp, makeTmpDir } from './_mocks.js';

function lastLine(jsonl: string): string {
  const line = jsonl.trim().split('\n').at(-1);
  if (!line) throw new Error('empty JSONL');
  return line;
}

describe('integration: engine session -> report', () => {
  let dir: string;
  let app: MockApp;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    dir = await makeTmpDir();
    app = makeMockApp(dir);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await cleanupTmpDir(dir);
  });

  it('produces a notification and JSONL entry after a simulated engine stop', async () => {
    app.availablePaths = ['propulsion.port.revolutions'];
    app.setSelfPath('notifications.propulsion.port', {
      lowOilPressure: { value: { state: 'normal', message: 'OK' } },
    });
    app.setSelfPath('electrical.batteries', {
      house: { voltage: { value: 13.6, meta: { units: 'V' } } },
    });
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('localhost:9000')) {
        return new Response(JSON.stringify({ columns: [], dataset: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Engine session completed without anomalies.' } }],
          model: 'anthropic/claude-haiku-4.5',
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const plugin = createPlugin(app as never);
    plugin.start({ openrouter: { apiKey: 'sk-x' } } as never, () => {});

    await plugin.whenReady();

    const bus = app.busFor<{ value: number; timestamp: string; $source: string }>(
      'propulsion.port.revolutions',
    );
    const t0 = Date.now();
    bus.push({ value: 10, timestamp: new Date(t0).toISOString(), $source: 's1' });
    bus.push({ value: 10, timestamp: new Date(t0 + 6000).toISOString(), $source: 's1' });
    bus.push({ value: 10, timestamp: new Date(t0 + 60_000).toISOString(), $source: 's1' });
    bus.push({ value: 0, timestamp: new Date(t0 + 65_000).toISOString(), $source: 's1' });
    bus.push({ value: 0, timestamp: new Date(t0 + 76_000).toISOString(), $source: 's1' });

    await vi.waitFor(() => expect(app.published.length).toBeGreaterThan(0), { timeout: 2000 });

    const lastDelta = app.published.at(-1)?.delta as {
      updates: { values: { path: string; value: { message: string; state: string } }[] }[];
    };
    expect(lastDelta.updates[0]?.values[0]?.path).toBe(
      'notifications.openrouter-companion.maintenance.report',
    );
    expect(lastDelta.updates[0]?.values[0]?.value.state).toBe('normal');
    expect(lastDelta.updates[0]?.values[0]?.value.message).toContain('Engine session');

    const logRaw = await readFile(join(dir, 'reports.jsonl'), 'utf-8');
    const entry = JSON.parse(lastLine(logRaw));
    expect(entry.analyzer).toBe('maintenance');
    expect(entry.engineId).toBe('port');

    await plugin.stop();
  });

  it('publishes a warn notification and logs failure when OpenRouter returns 503', async () => {
    app.availablePaths = ['propulsion.port.revolutions'];
    app.setSelfPath('notifications.propulsion.port', {
      lowOilPressure: { value: { state: 'normal', message: 'OK' } },
    });
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('localhost:9000')) {
        return new Response(JSON.stringify({ columns: [], dataset: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: { code: 503, message: 'unavailable' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    });

    const plugin = createPlugin(app as never);
    plugin.start(
      {
        openrouter: { apiKey: 'sk-x', requestTimeoutMs: 5000 },
      } as never,
      () => {},
    );

    await plugin.whenReady();

    const bus = app.busFor<{ value: number; timestamp: string; $source: string }>(
      'propulsion.port.revolutions',
    );
    const t0 = Date.now();
    bus.push({ value: 10, timestamp: new Date(t0).toISOString(), $source: 's1' });
    bus.push({ value: 10, timestamp: new Date(t0 + 6000).toISOString(), $source: 's1' });
    bus.push({ value: 10, timestamp: new Date(t0 + 60_000).toISOString(), $source: 's1' });
    bus.push({ value: 0, timestamp: new Date(t0 + 65_000).toISOString(), $source: 's1' });
    bus.push({ value: 0, timestamp: new Date(t0 + 76_000).toISOString(), $source: 's1' });

    await vi.waitFor(() => expect(app.published.length).toBeGreaterThan(0), { timeout: 30_000 });

    const lastDelta = app.published.at(-1)?.delta as {
      updates: { values: { path: string; value: { message: string; state: string } }[] }[];
    };
    expect(lastDelta.updates[0]?.values[0]?.value.state).toBe('warn');
    expect(lastDelta.updates[0]?.values[0]?.value.message).toContain('report unavailable');

    const logRaw = await readFile(join(dir, 'reports.jsonl'), 'utf-8');
    const entry = JSON.parse(lastLine(logRaw));
    expect(entry.analyzer).toBe('maintenance');
    expect(typeof entry.failure).toBe('string');

    await plugin.stop();
  }, 35_000);

  it('produces an alert notification when a bank drops below low-SoC threshold', async () => {
    app.availablePaths = [
      'electrical.batteries.house.voltage',
      'electrical.batteries.house.capacity.stateOfCharge',
    ];
    app.setSelfPath('electrical.batteries', {
      house: { voltage: { value: 12.2 }, capacity: { stateOfCharge: { value: 0.25 } } },
    });
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('localhost:9000')) {
        return new Response(JSON.stringify({ columns: [], dataset: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: 'House bank dropped to 25%. Investigate house loads.' } },
          ],
          model: 'anthropic/claude-haiku-4.5',
          usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const plugin = createPlugin(app as never);
    plugin.start({ openrouter: { apiKey: 'sk-x' } } as never, () => {});

    await plugin.whenReady();

    const bus = app.busFor<{ value: number; timestamp: string; $source: string }>(
      'electrical.batteries.house.capacity.stateOfCharge',
    );
    bus.push({ value: 0.5, timestamp: new Date().toISOString(), $source: 'bms' });
    bus.push({ value: 0.25, timestamp: new Date().toISOString(), $source: 'bms' });

    await vi.waitFor(
      () => {
        const alert = app.published.find((p) => {
          const d = p.delta as { updates: { values: { path: string }[] }[] };
          return (
            d.updates[0]?.values[0]?.path ===
            'notifications.openrouter-companion.alert.low-soc-enter'
          );
        });
        expect(alert).toBeDefined();
      },
      { timeout: 2000 },
    );

    const alertDelta = app.published.find((p) => {
      const d = p.delta as { updates: { values: { path: string }[] }[] };
      return (
        d.updates[0]?.values[0]?.path === 'notifications.openrouter-companion.alert.low-soc-enter'
      );
    });
    const value = (
      alertDelta?.delta as {
        updates: { values: { value: { state: string; message: string } }[] }[];
      }
    ).updates[0]?.values[0]?.value;
    expect(value.state).toBe('alert');
    expect(value.message).toContain('25%');

    const logRaw = await readFile(join(dir, 'reports.jsonl'), 'utf-8');
    const entry = JSON.parse(lastLine(logRaw));
    expect(entry.analyzer).toBe('alerts');

    await plugin.stop();
  });
});
