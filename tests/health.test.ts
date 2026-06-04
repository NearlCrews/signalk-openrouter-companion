import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TriggerCtx } from '../src/analyzers/Analyzer.js';
import { HealthAnalyzer } from '../src/analyzers/health.js';
import {
  cleanupTmpDir,
  type MockApp,
  makeBuffer,
  makeAnalyzerDeps as makeDeps,
  makeMockApp,
  makeTmpDir,
} from './_mocks.js';

function makeCfg() {
  return {
    triggers: {
      cron: { enabled: true, pattern: '0 8 * * *', timezone: '' },
      put: { enabled: true, path: 'plugins.openrouter-companion.health.run' },
      events: [],
    },
  };
}

describe('HealthAnalyzer', () => {
  let dir: string;
  let app: MockApp;
  beforeEach(async () => {
    dir = await makeTmpDir();
    app = makeMockApp(dir);
  });
  afterEach(async () => {
    await cleanupTmpDir(dir);
  });

  it('declares triggers built from the triggers config', () => {
    const a = new HealthAnalyzer(makeCfg());
    const kinds = a.triggers.map((t) => t.kind).sort();
    expect(kinds).toEqual(['cron', 'put']);
    const cron = a.triggers.find((t) => t.kind === 'cron') as { kind: 'cron'; pattern: string };
    expect(cron.pattern).toBe('0 8 * * *');
    const put = a.triggers.find((t) => t.kind === 'put') as { kind: 'put'; path: string };
    expect(put.path).toBe('plugins.openrouter-companion.health.run');
  });

  it('omits cron trigger when cron disabled', () => {
    const cfg = makeCfg();
    cfg.triggers.cron.enabled = false;
    const a = new HealthAnalyzer(cfg);
    expect(a.triggers.map((t) => t.kind)).toEqual(['put']);
  });

  it('omits put trigger when put disabled', () => {
    const cfg = makeCfg();
    cfg.triggers.put.enabled = false;
    const a = new HealthAnalyzer(cfg);
    expect(a.triggers.map((t) => t.kind)).toEqual(['cron']);
  });

  it('collectContext returns null when no battery banks are present', async () => {
    const buf = makeBuffer();
    const a = new HealthAnalyzer(makeCfg());
    const ctx: TriggerCtx = { kind: 'cron', firedAt: new Date('2026-05-10T08:00:00Z') };
    const r = await a.collectContext(ctx, makeDeps(app, buf));
    expect(r).toBeNull();
  });

  it('collectContext builds per-bank summary from buffer + getSelfPath', async () => {
    const buf = makeBuffer();
    const now = new Date('2026-05-10T08:00:00Z').getTime();
    buf.record('electrical.batteries.house.voltage', 12.6, now - 3600_000, 'bms');
    buf.record('electrical.batteries.house.voltage', 12.4, now - 1000, 'bms');
    buf.record('electrical.batteries.house.current', 0.5, now - 1000, 'bms');

    app.availablePaths = [
      'electrical.batteries.house.voltage',
      'electrical.batteries.house.current',
      'electrical.batteries.house.capacity.stateOfCharge',
    ];
    app.setSelfPath('electrical.batteries', {
      house: {
        voltage: { value: 12.4, meta: { units: 'V' } },
        current: { value: 0.5, meta: { units: 'A' } },
        capacity: {
          stateOfCharge: { value: 0.85, meta: { units: 'ratio' } },
          nominal: { value: 5_400_000, meta: { units: 'J' } },
        },
        cycles: { value: 12 },
      },
    });

    const a = new HealthAnalyzer(makeCfg());
    const ctx: TriggerCtx = { kind: 'cron', firedAt: new Date(now) };
    const r = await a.collectContext(ctx, makeDeps(app, buf));
    expect(r).not.toBeNull();
    const banks = r?.banks as Array<Record<string, unknown>>;
    expect(banks).toHaveLength(1);
    expect(banks[0]?.id).toBe('house');
    expect(banks[0]?.stateOfCharge).toBe(0.85);
    expect(banks[0]?.cycles).toBe(12);
    expect(banks[0]?.voltage24h).toMatchObject({ min: 12.4, max: 12.6, count: 2 });
  });

  it('buildPrompt produces stable system + user content', () => {
    const a = new HealthAnalyzer(makeCfg());
    const out = a.buildPrompt({
      generatedAt: '2026-05-10T08:00:00.000Z',
      banks: [
        {
          id: 'house',
          voltage: 12.4,
          current: 0.5,
          stateOfCharge: 0.85,
          nominalCapacityJ: 5_400_000,
          cycles: 12,
          voltage24h: { min: 12.3, max: 12.7, mean: 12.5, count: 60, sources: ['bms'] },
          cells: null,
        },
      ],
    });
    expect(out.system).toContain('marine');
    expect(out.system).toContain('battery');
    expect(out.user).toContain('house');
    expect(out.user).toContain('0.85');
  });

  it('collectContext collects cells from the flat cell<N>.voltage form, sorted by index', async () => {
    const buf = makeBuffer();
    const now = new Date('2026-05-10T08:00:00Z').getTime();
    app.setSelfPath('electrical.batteries', {
      house: {
        voltage: { value: 13.2 },
        current: { value: 1.0 },
        capacity: { stateOfCharge: { value: 0.9 } },
        // Inserted out of index order to prove the output is sorted by index.
        cell2: { voltage: { value: 3.32 } },
        cell1: { voltage: { value: 3.31 } },
        cell3: { voltage: { value: 3.33 } },
      },
    });

    const a = new HealthAnalyzer(makeCfg());
    const ctx: TriggerCtx = { kind: 'cron', firedAt: new Date(now) };
    const r = await a.collectContext(ctx, makeDeps(app, buf));
    if (!r) throw new Error('expected collectContext result');
    expect(r.banks[0]?.cells).toEqual([
      { index: 1, voltage: 3.31 },
      { index: 2, voltage: 3.32 },
      { index: 3, voltage: 3.33 },
    ]);
    // The sorted per-cell voltages reach buildPrompt's cells line.
    const out = a.buildPrompt(r);
    expect(out.user).toContain('cells: 1=3.310 2=3.320 3=3.330');
  });

  it('collectContext collects cells from the nested cells.<n>.voltage form, sorted by index', async () => {
    const buf = makeBuffer();
    const now = new Date('2026-05-10T08:00:00Z').getTime();
    app.setSelfPath('electrical.batteries', {
      starter: {
        voltage: { value: 12.8 },
        cells: {
          '1': { voltage: { value: 3.4 } },
          '0': { voltage: { value: 3.39 } },
        },
      },
    });

    const a = new HealthAnalyzer(makeCfg());
    const ctx: TriggerCtx = { kind: 'cron', firedAt: new Date(now) };
    const r = await a.collectContext(ctx, makeDeps(app, buf));
    if (!r) throw new Error('expected collectContext result');
    expect(r.banks[0]?.cells).toEqual([
      { index: 0, voltage: 3.39 },
      { index: 1, voltage: 3.4 },
    ]);
    const out = a.buildPrompt(r);
    expect(out.user).toContain('cells: 0=3.390 1=3.400');
  });
});
