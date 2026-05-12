import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TriggerCtx } from '../src/analyzers/Analyzer.js';
import { MaintenanceAnalyzer } from '../src/analyzers/maintenance.js';
import { RollingBuffer } from '../src/core/buffer.js';
import {
  cleanupTmpDir,
  type MockApp,
  makeAnalyzerDeps as makeDeps,
  makeMockApp,
  makeTmpDir,
} from './_mocks.js';

function engineStopCtx(durationSec: number, engineId = 'port'): TriggerCtx {
  const end = new Date('2026-05-10T10:00:00Z');
  const start = new Date(end.getTime() - durationSec * 1000);
  return {
    kind: 'engine-stop',
    firedAt: end,
    engineSession: { engineId, start, end, durationSec },
  };
}

describe('MaintenanceAnalyzer.collectContext', () => {
  let dir: string;
  let app: MockApp;
  beforeEach(async () => {
    dir = await makeTmpDir();
    app = makeMockApp(dir);
  });
  afterEach(async () => {
    await cleanupTmpDir(dir);
  });

  it('returns null when session is shorter than minSessionSeconds', async () => {
    const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
    const a = new MaintenanceAnalyzer({
      triggers: {
        cron: { enabled: false, pattern: '', timezone: '' },
        put: { enabled: true, path: 'plugins.openrouter-companion.maintenance.run' },
        events: ['engine-stop'],
      },
      minSessionSeconds: 60,
    });
    const r = await a.collectContext(engineStopCtx(30), makeDeps(app, buf));
    expect(r).toBeNull();
  });

  it('builds session telemetry summaries from the buffer', async () => {
    const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
    const startMs = new Date('2026-05-10T09:00:00Z').getTime();
    const endMs = new Date('2026-05-10T10:00:00Z').getTime();
    buf.record('propulsion.port.revolutions', 12, startMs + 1000, 'n2k');
    buf.record('propulsion.port.revolutions', 18, startMs + 30_000, 'n2k');
    buf.record('propulsion.port.revolutions', 22, startMs + 60_000, 'n2k');
    buf.record('electrical.batteries.house.voltage', 13.6, endMs - 500, 'bms');

    app.setSelfPath('notifications.propulsion.port', {
      lowOilPressure: { value: { state: 'normal', message: 'OK' } },
      maintenanceNeeded: { value: { state: 'alert', message: 'Service due' } },
    });
    app.setSelfPath('electrical.batteries', {
      house: {
        voltage: { value: 13.6, meta: { units: 'V' } },
        current: { value: 0.5, meta: { units: 'A' } },
        capacity: {
          stateOfCharge: { value: 0.92, meta: { units: 'ratio' } },
          nominal: { value: 5_400_000, meta: { units: 'J' } },
        },
      },
    });

    const a = new MaintenanceAnalyzer({
      triggers: {
        cron: { enabled: false, pattern: '', timezone: '' },
        put: { enabled: true, path: 'plugins.openrouter-companion.maintenance.run' },
        events: ['engine-stop'],
      },
      minSessionSeconds: 60,
    });
    const r = await a.collectContext(engineStopCtx(3600), makeDeps(app, buf));
    expect(r).not.toBeNull();
    expect(r!.session).toEqual({
      engineId: 'port',
      start: '2026-05-10T09:00:00.000Z',
      end: '2026-05-10T10:00:00.000Z',
      durationSec: 3600,
    });
    const telemetry = r!.telemetry as Record<string, { min: number; max: number; count: number }>;
    expect(telemetry['propulsion.port.revolutions']).toMatchObject({ min: 12, max: 22, count: 3 });
    expect(r!.engineNotifications).toEqual({
      lowOilPressure: { state: 'normal', message: 'OK' },
      maintenanceNeeded: { state: 'alert', message: 'Service due' },
    });
    expect(r!.batteries).toEqual([
      {
        id: 'house',
        voltage: 13.6,
        current: 0.5,
        stateOfCharge: 0.92,
        nominalCapacityJ: 5_400_000,
      },
    ]);
  });
});

describe('MaintenanceAnalyzer.buildPrompt', () => {
  it('produces a stable system + user prompt from a representative input', () => {
    const a = new MaintenanceAnalyzer({
      triggers: {
        cron: { enabled: false, pattern: '', timezone: '' },
        put: { enabled: true, path: 'plugins.openrouter-companion.maintenance.run' },
        events: ['engine-stop'],
      },
      minSessionSeconds: 60,
    });
    const out = a.buildPrompt({
      session: {
        engineId: 'port',
        start: '2026-05-10T09:00:00.000Z',
        end: '2026-05-10T10:00:00.000Z',
        durationSec: 3600,
      },
      telemetry: {
        'propulsion.port.revolutions': { min: 12, max: 22, mean: 17.3, count: 3, sources: ['n2k'] },
      },
      engineNotifications: {
        lowOilPressure: { state: 'normal', message: 'OK' },
        maintenanceNeeded: { state: 'alert', message: 'Service due' },
      },
      batteries: [
        {
          id: 'house',
          voltage: 13.6,
          current: 0.5,
          stateOfCharge: 0.92,
          nominalCapacityJ: 5_400_000,
        },
      ],
    });
    expect(out.system).toContain('marine');
    expect(out.system).toContain('engine');
    expect(out.user).toContain('port');
    expect(out.user).toContain('propulsion.port.revolutions');
    expect(out.user).toContain('maintenanceNeeded');
    expect(out.user).toContain('Service due');
    expect(out.user).toContain('house');
  });
});
