import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TriggerCtx } from '../src/analyzers/Analyzer.js';
import { DriftAnalyzer, type DriftInput } from '../src/analyzers/drift.js';
import { RollingBuffer } from '../src/core/buffer.js';
import {
  cleanupTmpDir,
  type MockApp,
  type MockQuestDB,
  makeAnalyzerDeps,
  makeMockApp,
  makeQuestDBStub,
  makeTmpDir,
} from './_mocks.js';

function makeCfg(overrides: Partial<{ baselineDays: number }> = {}) {
  return {
    triggers: {
      cron: { enabled: true, pattern: '0 8 * * 0', timezone: '' },
      put: { enabled: true },
      events: [] as string[],
    },
    baselineDays: overrides.baselineDays ?? 30,
  };
}

function makeDeps(app: MockApp, buffer: RollingBuffer, questdb: MockQuestDB | null = null) {
  return makeAnalyzerDeps(app, buffer, { questdb });
}

// drift.ts pushes per-bin aggregation into QuestDB and reads back rows of
// {bin, n_fuel, n_sog, mean_fuel, mean_sog}. Test stubs return pre-binned rows
// in that exact shape rather than raw timeseries. n_fuel and n_sog are the
// per-metric fresh-pair counts (RPM samples with a fuel.rate / SOG join inside
// the tolerance window).
interface BinRow {
  bin: 'idle' | 'lowCruise' | 'highCruise' | 'topEnd' | 'wot';
  n_fuel: number;
  n_sog: number;
  mean_fuel: number | null;
  mean_sog: number | null;
}

function binResult(rows: BinRow[]) {
  return {
    columns: [
      { name: 'bin', type: 'STRING' },
      { name: 'n_fuel', type: 'LONG' },
      { name: 'n_sog', type: 'LONG' },
      { name: 'mean_fuel', type: 'DOUBLE' },
      { name: 'mean_sog', type: 'DOUBLE' },
    ],
    dataset: rows.map((r) => [r.bin, r.n_fuel, r.n_sog, r.mean_fuel, r.mean_sog]),
  };
}

describe('DriftAnalyzer', () => {
  let dir: string;
  let app: MockApp;
  beforeEach(async () => {
    dir = await makeTmpDir();
    app = makeMockApp(dir);
  });
  afterEach(async () => {
    await cleanupTmpDir(dir);
  });

  describe('triggers', () => {
    it('declares cron and put when both enabled', () => {
      const a = new DriftAnalyzer(makeCfg());
      const kinds = a.triggers.map((t) => t.kind).sort();
      expect(kinds).toEqual(['cron', 'put']);
      const cron = a.triggers.find((t) => t.kind === 'cron') as { kind: 'cron'; pattern: string };
      expect(cron.pattern).toBe('0 8 * * 0');
      const put = a.triggers.find((t) => t.kind === 'put') as { kind: 'put'; path: string };
      expect(put.path).toBe('plugins.openrouter-companion.drift.run');
    });

    it('omits cron when cron disabled', () => {
      const cfg = makeCfg();
      cfg.triggers.cron.enabled = false;
      const a = new DriftAnalyzer(cfg);
      expect(a.triggers.map((t) => t.kind)).toEqual(['put']);
    });

    it('omits put when put disabled', () => {
      const cfg = makeCfg();
      cfg.triggers.put.enabled = false;
      const a = new DriftAnalyzer(cfg);
      expect(a.triggers.map((t) => t.kind)).toEqual(['cron']);
    });

    it('does not subscribe to any battery or engine events', () => {
      const a = new DriftAnalyzer(makeCfg());
      const eventKinds = a.triggers.map((t) => t.kind).filter((k) => k !== 'cron' && k !== 'put');
      expect(eventKinds).toEqual([]);
    });
  });

  describe('collectContext null paths', () => {
    it('returns null when questdb is not configured', async () => {
      const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
      const a = new DriftAnalyzer(makeCfg());
      const ctx: TriggerCtx = { kind: 'cron', firedAt: new Date('2026-05-10T08:00:00Z') };
      const r = await a.collectContext(ctx, makeDeps(app, buf, null));
      expect(r).toBeNull();
    });

    it('returns null when QuestDB returns no bin rows in the past week', async () => {
      const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
      const stub = makeQuestDBStub(() => binResult([]));
      const a = new DriftAnalyzer(makeCfg());
      const ctx: TriggerCtx = { kind: 'cron', firedAt: new Date('2026-05-10T08:00:00Z') };
      const r = await a.collectContext(ctx, makeDeps(app, buf, stub));
      expect(r).toBeNull();
    });
  });

  describe('collectContext happy path', () => {
    it('returns per-bin stats and computes deltas vs baseline', async () => {
      const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
      buf.record('propulsion.port.revolutions', 4, Date.now() - 1000, 'n2k');

      const firedAt = new Date('2026-05-10T08:00:00Z');
      const firedMs = firedAt.getTime();
      const thisWeekFromIso = new Date(firedMs - 7 * 86_400_000).toISOString();

      // Week burns 10% more fuel per bin than baseline; SOG identical.
      const weekRows: BinRow[] = [
        { bin: 'idle', n_fuel: 50, n_sog: 50, mean_fuel: 0.000055, mean_sog: 0 },
        { bin: 'lowCruise', n_fuel: 50, n_sog: 50, mean_fuel: 0.000132, mean_sog: 2.5 },
        { bin: 'highCruise', n_fuel: 50, n_sog: 50, mean_fuel: 0.000308, mean_sog: 4.6 },
        { bin: 'topEnd', n_fuel: 50, n_sog: 50, mean_fuel: 0.000484, mean_sog: 5.5 },
      ];
      const baseRows: BinRow[] = [
        { bin: 'idle', n_fuel: 200, n_sog: 200, mean_fuel: 0.00005, mean_sog: 0 },
        { bin: 'lowCruise', n_fuel: 200, n_sog: 200, mean_fuel: 0.00012, mean_sog: 2.5 },
        { bin: 'highCruise', n_fuel: 200, n_sog: 200, mean_fuel: 0.00028, mean_sog: 4.6 },
        { bin: 'topEnd', n_fuel: 200, n_sog: 200, mean_fuel: 0.00044, mean_sog: 5.5 },
      ];

      const stub = makeQuestDBStub((sql) =>
        sql.includes(`ts >= '${thisWeekFromIso}'`) ? binResult(weekRows) : binResult(baseRows),
      );

      const a = new DriftAnalyzer(makeCfg());
      const ctx: TriggerCtx = { kind: 'cron', firedAt };
      const r = await a.collectContext(ctx, makeDeps(app, buf, stub));
      expect(r).not.toBeNull();
      const input = r as DriftInput;
      expect(input.windowDays).toEqual({ thisWeek: 7, baseline: 30 });
      expect(input.engines).toHaveLength(1);
      const eng = input.engines[0];
      if (!eng) throw new Error('expected one engine');
      expect(eng.engineId).toBe('port');
      for (const bin of ['idle', 'lowCruise', 'highCruise', 'topEnd'] as const) {
        expect(eng.thisWeek[bin].fuelCount).toBe(50);
        expect(eng.thisWeek[bin].sogCount).toBe(50);
        expect(eng.baseline[bin].fuelCount).toBe(200);
        expect(eng.baseline[bin].sogCount).toBe(200);
        const fuel = eng.deltas[bin].fuelRateDeltaPct;
        if (fuel == null) throw new Error(`null fuel delta in bin ${bin}`);
        expect(fuel).toBeCloseTo(10, 0);
        // pctDelta(0, 0) returns null for the idle bin (vessel stationary in
        // both windows); skip the SOG assertion there.
        const sog = eng.deltas[bin].sogDeltaPct;
        if (sog != null) expect(sog).toBeCloseTo(0, 1);
      }

      // One query per (engine, window): two queries total for one engine.
      expect(stub.calls).toHaveLength(2);
      // Both queries must reference the engine-specific paths and the SOG path.
      for (const sql of stub.calls) {
        expect(sql).toContain('propulsion.port.revolutions');
        expect(sql).toContain('propulsion.port.fuel.rate');
        expect(sql).toContain('navigation.speedOverGround');
        // The bin CASE is derived from BIN_DEFS: the finite edges and the wot
        // fallthrough must appear so server-side binning matches the bin defs.
        expect(sql).toContain("WHEN r.value < 15 THEN 'idle'");
        expect(sql).toContain("WHEN r.value < 75 THEN 'topEnd'");
        expect(sql).toContain("ELSE 'wot'");
        // The ASOF freshness guard is BETWEEN 0 AND the window, so inverted
        // pairs from N2K clock skew (negative delta) are rejected.
        expect(sql).toContain('r.ts - f.ts BETWEEN 0 AND 5000000');
        expect(sql).toContain('r.ts - s.ts BETWEEN 0 AND 5000000');
      }
    });

    it('skips bins that fall below MIN_BIN_SAMPLES (null delta)', async () => {
      const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
      buf.record('propulsion.port.revolutions', 2, Date.now() - 1000, 'n2k');

      const firedAt = new Date('2026-05-10T08:00:00Z');
      const firedMs = firedAt.getTime();
      const thisWeekFromIso = new Date(firedMs - 7 * 86_400_000).toISOString();

      // Only 5 samples in low cruise: below MIN_BIN_SAMPLES (30).
      const week: BinRow[] = [
        { bin: 'lowCruise', n_fuel: 5, n_sog: 5, mean_fuel: 0.0001, mean_sog: 2.5 },
      ];
      const base: BinRow[] = [
        { bin: 'lowCruise', n_fuel: 5, n_sog: 5, mean_fuel: 0.0001, mean_sog: 2.5 },
      ];

      const stub = makeQuestDBStub((sql) =>
        sql.includes(`ts >= '${thisWeekFromIso}'`) ? binResult(week) : binResult(base),
      );

      const a = new DriftAnalyzer(makeCfg());
      const ctx: TriggerCtx = { kind: 'cron', firedAt };
      const r = await a.collectContext(ctx, makeDeps(app, buf, stub));
      expect(r).not.toBeNull();
      const input = r as DriftInput;
      const eng = input.engines[0];
      if (!eng) throw new Error('expected one engine');
      expect(eng.thisWeek.lowCruise.fuelCount).toBe(5);
      expect(eng.thisWeek.lowCruise.sogCount).toBe(5);
      expect(eng.deltas.lowCruise.fuelRateDeltaPct).toBeNull();
      expect(eng.deltas.lowCruise.sogDeltaPct).toBeNull();
    });

    it('uses configured baselineDays to size the baseline window', async () => {
      const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
      buf.record('propulsion.port.revolutions', 4, Date.now() - 1000, 'n2k');

      const firedAt = new Date('2026-05-10T08:00:00Z');
      const firedMs = firedAt.getTime();
      const thisWeekFromIso = new Date(firedMs - 7 * 86_400_000).toISOString();
      // baselineDays=14 means the baseline runs from -21d to -7d.
      const baselineFromIso = new Date(firedMs - (7 + 14) * 86_400_000).toISOString();

      const rows: BinRow[] = [
        { bin: 'idle', n_fuel: 50, n_sog: 50, mean_fuel: 0.00005, mean_sog: 0 },
      ];
      const stub = makeQuestDBStub(() => binResult(rows));

      const a = new DriftAnalyzer(makeCfg({ baselineDays: 14 }));
      const ctx: TriggerCtx = { kind: 'cron', firedAt };
      const r = await a.collectContext(ctx, makeDeps(app, buf, stub));
      expect(r).not.toBeNull();
      expect((r as DriftInput).windowDays).toEqual({ thisWeek: 7, baseline: 14 });
      // One query references each window's lower bound exactly.
      expect(stub.calls.some((sql) => sql.includes(`ts >= '${thisWeekFromIso}'`))).toBe(true);
      expect(stub.calls.some((sql) => sql.includes(`ts >= '${baselineFromIso}'`))).toBe(true);
    });
  });

  describe('buildPrompt', () => {
    it('surfaces the configured baseline length in the user prompt', () => {
      const a = new DriftAnalyzer(makeCfg({ baselineDays: 14 }));
      const out = a.buildPrompt({
        generatedAt: '2026-05-10T08:00:00.000Z',
        windowDays: { thisWeek: 7, baseline: 14 },
        engines: [],
      });
      expect(out.user).toContain('past 7d vs trailing 14d baseline');
    });

    it('produces deterministic system + user content from a representative input', () => {
      const a = new DriftAnalyzer(makeCfg());
      const out = a.buildPrompt({
        generatedAt: '2026-05-10T08:00:00.000Z',
        windowDays: { thisWeek: 7, baseline: 30 },
        engines: [
          {
            engineId: 'port',
            thisWeek: {
              idle: { fuelCount: 60, sogCount: 60, meanFuelRate: 0.00005, meanSog: 0.0 },
              lowCruise: { fuelCount: 80, sogCount: 80, meanFuelRate: 0.00012, meanSog: 2.5 },
              highCruise: { fuelCount: 120, sogCount: 120, meanFuelRate: 0.00031, meanSog: 4.6 },
              topEnd: { fuelCount: 5, sogCount: 5, meanFuelRate: 0.00044, meanSog: 5.4 },
              wot: { fuelCount: 0, sogCount: 0, meanFuelRate: null, meanSog: null },
            },
            baseline: {
              idle: { fuelCount: 200, sogCount: 200, meanFuelRate: 0.00005, meanSog: 0.0 },
              lowCruise: { fuelCount: 300, sogCount: 300, meanFuelRate: 0.00012, meanSog: 2.5 },
              highCruise: { fuelCount: 400, sogCount: 400, meanFuelRate: 0.00028, meanSog: 4.6 },
              topEnd: { fuelCount: 20, sogCount: 20, meanFuelRate: 0.00043, meanSog: 5.5 },
              wot: { fuelCount: 0, sogCount: 0, meanFuelRate: null, meanSog: null },
            },
            deltas: {
              idle: { fuelRateDeltaPct: 0, sogDeltaPct: 0 },
              lowCruise: { fuelRateDeltaPct: 0, sogDeltaPct: 0 },
              highCruise: { fuelRateDeltaPct: 10.7, sogDeltaPct: 0 },
              topEnd: { fuelRateDeltaPct: null, sogDeltaPct: null },
              wot: { fuelRateDeltaPct: null, sogDeltaPct: null },
            },
          },
        ],
      });
      expect(out.system).toContain('marine');
      expect(out.system).toContain('drift');
      expect(out.system).toContain('Hz');
      // The prompt must explicitly tell the LLM not to "fix" Hz back to rad/s.
      expect(out.system).toContain('do not convert to rad/s');
      expect(out.user).toContain('Engine port');
      expect(out.user).toContain('idle');
      expect(out.user).toContain('low cruise');
      expect(out.user).toContain('high cruise');
      expect(out.user).toContain('top end');
      expect(out.user).toContain('+10.7%');
      expect(out.user).toContain('n/a');
      // The summary header should mention both window lengths so the LLM has
      // the comparison context inline.
      expect(out.user).toContain('past 7d');
      expect(out.user).toContain('30d baseline');
    });
  });
});
