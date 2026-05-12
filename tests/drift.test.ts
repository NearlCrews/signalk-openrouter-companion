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

function makeCfg() {
  return {
    triggers: {
      cron: { enabled: true, pattern: '0 8 * * 0', timezone: '' },
      put: { enabled: true, path: 'plugins.openrouter-companion.drift.run' },
      events: [] as string[],
    },
  };
}

function makeDeps(app: MockApp, buffer: RollingBuffer, questdb: MockQuestDB | null = null) {
  return makeAnalyzerDeps(app, buffer, { questdb });
}

// drift.ts pushes per-bin aggregation into QuestDB and reads back rows of
// {bin, n, mean_fuel, mean_sog}. Test stubs return pre-binned rows in that
// exact shape rather than raw timeseries.
interface BinRow {
  bin: 'idle' | 'lowCruise' | 'highCruise' | 'topEnd';
  n: number;
  mean_fuel: number | null;
  mean_sog: number | null;
}

function binResult(rows: BinRow[]) {
  return {
    columns: [
      { name: 'bin', type: 'STRING' },
      { name: 'n', type: 'LONG' },
      { name: 'mean_fuel', type: 'DOUBLE' },
      { name: 'mean_sog', type: 'DOUBLE' },
    ],
    dataset: rows.map((r) => [r.bin, r.n, r.mean_fuel, r.mean_sog]),
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
        { bin: 'idle', n: 50, mean_fuel: 0.000055, mean_sog: 0 },
        { bin: 'lowCruise', n: 50, mean_fuel: 0.000132, mean_sog: 2.5 },
        { bin: 'highCruise', n: 50, mean_fuel: 0.000308, mean_sog: 4.6 },
        { bin: 'topEnd', n: 50, mean_fuel: 0.000484, mean_sog: 5.5 },
      ];
      const baseRows: BinRow[] = [
        { bin: 'idle', n: 200, mean_fuel: 0.00005, mean_sog: 0 },
        { bin: 'lowCruise', n: 200, mean_fuel: 0.00012, mean_sog: 2.5 },
        { bin: 'highCruise', n: 200, mean_fuel: 0.00028, mean_sog: 4.6 },
        { bin: 'topEnd', n: 200, mean_fuel: 0.00044, mean_sog: 5.5 },
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
      const eng = input.engines[0]!;
      expect(eng.engineId).toBe('port');
      for (const bin of ['idle', 'lowCruise', 'highCruise', 'topEnd'] as const) {
        expect(eng.thisWeek[bin].count).toBe(50);
        expect(eng.baseline[bin].count).toBe(200);
        expect(eng.deltas[bin].fuelRateDeltaPct).not.toBeNull();
        expect(eng.deltas[bin].fuelRateDeltaPct!).toBeCloseTo(10, 0);
        expect(eng.deltas[bin].sogDeltaPct!).toBeCloseTo(0, 1);
      }

      // One query per (engine, window): two queries total for one engine.
      expect(stub.calls).toHaveLength(2);
      // Both queries must reference the engine-specific paths and the SOG path.
      for (const sql of stub.calls) {
        expect(sql).toContain('propulsion.port.revolutions');
        expect(sql).toContain('propulsion.port.fuel.rate');
        expect(sql).toContain('navigation.speedOverGround');
      }
    });

    it('skips bins that fall below MIN_BIN_SAMPLES (null delta)', async () => {
      const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
      buf.record('propulsion.port.revolutions', 2, Date.now() - 1000, 'n2k');

      const firedAt = new Date('2026-05-10T08:00:00Z');
      const firedMs = firedAt.getTime();
      const thisWeekFromIso = new Date(firedMs - 7 * 86_400_000).toISOString();

      // Only 5 samples in low cruise: below MIN_BIN_SAMPLES (30).
      const week: BinRow[] = [{ bin: 'lowCruise', n: 5, mean_fuel: 0.0001, mean_sog: 2.5 }];
      const base: BinRow[] = [{ bin: 'lowCruise', n: 5, mean_fuel: 0.0001, mean_sog: 2.5 }];

      const stub = makeQuestDBStub((sql) =>
        sql.includes(`ts >= '${thisWeekFromIso}'`) ? binResult(week) : binResult(base),
      );

      const a = new DriftAnalyzer(makeCfg());
      const ctx: TriggerCtx = { kind: 'cron', firedAt };
      const r = await a.collectContext(ctx, makeDeps(app, buf, stub));
      expect(r).not.toBeNull();
      const input = r as DriftInput;
      const eng = input.engines[0]!;
      expect(eng.thisWeek.lowCruise.count).toBe(5);
      expect(eng.deltas.lowCruise.fuelRateDeltaPct).toBeNull();
      expect(eng.deltas.lowCruise.sogDeltaPct).toBeNull();
    });
  });

  describe('buildPrompt', () => {
    it('produces deterministic system + user content from a representative input', () => {
      const a = new DriftAnalyzer(makeCfg());
      const out = a.buildPrompt({
        generatedAt: '2026-05-10T08:00:00.000Z',
        windowDays: { thisWeek: 7, baseline: 30 },
        engines: [
          {
            engineId: 'port',
            thisWeek: {
              idle: { count: 60, meanFuelRate: 0.00005, meanSog: 0.0 },
              lowCruise: { count: 80, meanFuelRate: 0.00012, meanSog: 2.5 },
              highCruise: { count: 120, meanFuelRate: 0.00031, meanSog: 4.6 },
              topEnd: { count: 5, meanFuelRate: 0.00044, meanSog: 5.4 },
            },
            baseline: {
              idle: { count: 200, meanFuelRate: 0.00005, meanSog: 0.0 },
              lowCruise: { count: 300, meanFuelRate: 0.00012, meanSog: 2.5 },
              highCruise: { count: 400, meanFuelRate: 0.00028, meanSog: 4.6 },
              topEnd: { count: 20, meanFuelRate: 0.00043, meanSog: 5.5 },
            },
            deltas: {
              idle: { fuelRateDeltaPct: 0, sogDeltaPct: 0 },
              lowCruise: { fuelRateDeltaPct: 0, sogDeltaPct: 0 },
              highCruise: { fuelRateDeltaPct: 10.7, sogDeltaPct: 0 },
              topEnd: { fuelRateDeltaPct: null, sogDeltaPct: null },
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
