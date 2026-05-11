import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyzerDeps, TriggerCtx } from '../src/analyzers/Analyzer.js';
import { DriftAnalyzer, type DriftInput } from '../src/analyzers/drift.js';
import { RollingBuffer } from '../src/core/buffer.js';
import { Logger } from '../src/core/logger.js';
import type { QueryResult } from '../src/core/questdb.js';
import { cleanupTmpDir, type MockApp, makeMockApp, makeTmpDir } from './_mocks.js';

function makeCfg() {
  return {
    triggers: {
      cron: { enabled: true, pattern: '0 8 * * 0', timezone: '' },
      put: { enabled: true, path: 'plugins.openrouter-companion.drift.run' },
      events: [] as string[],
    },
  };
}

function makeDeps(
  app: MockApp,
  buffer: RollingBuffer,
  questdb: AnalyzerDeps['questdb'] = null,
): AnalyzerDeps {
  return {
    app: { getSelfPath: (p) => app.getSelfPath(p), selfContext: app.selfContext },
    buffer,
    questdb,
    publisher: {} as never,
    budget: {} as never,
    llm: {} as never,
    logger: new Logger({ debug: vi.fn(), error: vi.fn() }),
  };
}

interface StubQuestDB {
  query: (sql: string) => Promise<QueryResult>;
  calls: string[];
}

// Inject a typed stub matching the QuestDBClient surface drift.ts touches.
// Avoids vi.stubGlobal('fetch'), which is process-global and clashes with
// other test files running in parallel workers.
function stubQuestDB(
  dispatch: (sql: string) => ReadonlyArray<{ ts: number; value: number }>,
): StubQuestDB {
  const stub: StubQuestDB = {
    calls: [],
    query: async (sql: string) => {
      stub.calls.push(sql);
      const series = dispatch(sql);
      return {
        columns: [
          { name: 'ts', type: 'TIMESTAMP' },
          { name: 'value', type: 'DOUBLE' },
        ],
        dataset: series.map((s) => [new Date(s.ts).toISOString(), s.value]),
      };
    },
  };
  return stub;
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

    it('returns null when QuestDB has no RPM samples in the past week', async () => {
      const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
      const stub = stubQuestDB(() => []);
      const a = new DriftAnalyzer(makeCfg());
      const ctx: TriggerCtx = { kind: 'cron', firedAt: new Date('2026-05-10T08:00:00Z') };
      const r = await a.collectContext(
        ctx,
        makeDeps(app, buf, stub as unknown as AnalyzerDeps['questdb']),
      );
      expect(r).toBeNull();
    });
  });

  describe('collectContext happy path', () => {
    it('bins fuel.rate and SOG per RPM band and computes deltas vs baseline', async () => {
      // Discover engineId 'port' from buffer (avoids relying on the fallback).
      const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
      buf.record('propulsion.port.revolutions', 4, Date.now() - 1000, 'n2k');

      const firedAt = new Date('2026-05-10T08:00:00Z');
      const firedMs = firedAt.getTime();
      const inWeek = firedMs - 2 * 86_400_000; // 2 days ago
      const inBaseline = firedMs - 20 * 86_400_000; // 20 days ago

      // For each path the analyzer asks for, build a deterministic series.
      // Use 50 RPM samples per band so they comfortably clear MIN_BIN_SAMPLES.
      type Series = Array<{ ts: number; value: number }>;
      const buildSeries = (
        anchor: number,
        rpmValue: number,
        count: number,
        spacingMs: number,
      ): Series => {
        const out: Series = [];
        for (let i = 0; i < count; i += 1)
          out.push({ ts: anchor + i * spacingMs, value: rpmValue });
        return out;
      };

      // Values are in Hz (the SK unit for propulsion.*.revolutions).
      const weekRpm: Series = [
        ...buildSeries(inWeek, 10, 50, 1000), // idle (~600 RPM)
        ...buildSeries(inWeek + 100_000, 20, 50, 1000), // low cruise (~1200 RPM)
        ...buildSeries(inWeek + 200_000, 40, 50, 1000), // high cruise (~2400 RPM)
        ...buildSeries(inWeek + 300_000, 60, 50, 1000), // top end (~3600 RPM)
      ];
      // Fuel: same ts as RPM, value rises with RPM band; week burns 10% more
      // in the high-cruise band than baseline.
      const weekFuel: Series = weekRpm.map((r) => ({
        ts: r.ts,
        value: fuelForRpm(r.value, 1.1 /* high-cruise inflated */),
      }));
      const weekSog: Series = weekRpm.map((r) => ({ ts: r.ts, value: sogForRpm(r.value, 1.0) }));

      const baseRpm: Series = [
        ...buildSeries(inBaseline, 10, 50, 1000),
        ...buildSeries(inBaseline + 100_000, 20, 50, 1000),
        ...buildSeries(inBaseline + 200_000, 40, 50, 1000),
        ...buildSeries(inBaseline + 300_000, 60, 50, 1000),
      ];
      const baseFuel: Series = baseRpm.map((r) => ({
        ts: r.ts,
        value: fuelForRpm(r.value, 1.0),
      }));
      const baseSog: Series = baseRpm.map((r) => ({ ts: r.ts, value: sogForRpm(r.value, 1.0) }));

      const thisWeekFromIso = new Date(firedMs - 7 * 86_400_000).toISOString();
      const baselineFromIso = new Date(firedMs - 37 * 86_400_000).toISOString();
      // `ts >= '<from>'` uniquely identifies the window since the two share
      // their boundary timestamp.
      const stub = stubQuestDB((sql) => {
        const inThisWeek = sql.includes(`ts >= '${thisWeekFromIso}'`);
        const inBaselineWindow = sql.includes(`ts >= '${baselineFromIso}'`);
        if (sql.includes('propulsion.port.revolutions')) {
          if (inThisWeek) return weekRpm;
          if (inBaselineWindow) return baseRpm;
        }
        if (sql.includes('propulsion.port.fuel.rate')) {
          if (inThisWeek) return weekFuel;
          if (inBaselineWindow) return baseFuel;
        }
        if (sql.includes('navigation.speedOverGround')) {
          if (inThisWeek) return weekSog;
          if (inBaselineWindow) return baseSog;
        }
        return [];
      });

      const a = new DriftAnalyzer(makeCfg());
      const ctx: TriggerCtx = { kind: 'cron', firedAt };
      const r = await a.collectContext(
        ctx,
        makeDeps(app, buf, stub as unknown as AnalyzerDeps['questdb']),
      );
      expect(r).not.toBeNull();
      const input = r as DriftInput;
      expect(input.windowDays).toEqual({ thisWeek: 7, baseline: 30 });
      expect(input.engines).toHaveLength(1);
      const eng = input.engines[0]!;
      expect(eng.engineId).toBe('port');
      // All four bands populated, all >= MIN_BIN_SAMPLES.
      expect(eng.thisWeek.idle.count).toBe(50);
      expect(eng.thisWeek.lowCruise.count).toBe(50);
      expect(eng.thisWeek.highCruise.count).toBe(50);
      expect(eng.thisWeek.topEnd.count).toBe(50);
      // Week fuel uses a flat 1.1x multiplier vs baseline across all bands,
      // so every band's fuel-rate delta should land near +10%.
      for (const bin of ['idle', 'lowCruise', 'highCruise', 'topEnd'] as const) {
        expect(eng.deltas[bin].fuelRateDeltaPct).not.toBeNull();
        expect(eng.deltas[bin].fuelRateDeltaPct!).toBeCloseTo(10, 0);
      }
      // SOG unchanged across the board (same multiplier).
      for (const bin of ['idle', 'lowCruise', 'highCruise', 'topEnd'] as const) {
        expect(eng.deltas[bin].sogDeltaPct!).toBeCloseTo(0, 1);
      }

      // 3 paths x 2 windows means at least 6 SQL queries.
      expect(stub.calls.some((s) => s.includes('propulsion.port.revolutions'))).toBe(true);
      expect(stub.calls.some((s) => s.includes('propulsion.port.fuel.rate'))).toBe(true);
      expect(stub.calls.some((s) => s.includes('navigation.speedOverGround'))).toBe(true);
    });

    it('skips bins that fall below MIN_BIN_SAMPLES (null delta)', async () => {
      const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
      buf.record('propulsion.port.revolutions', 2, Date.now() - 1000, 'n2k');

      const firedAt = new Date('2026-05-10T08:00:00Z');
      const firedMs = firedAt.getTime();
      const inWeek = firedMs - 1 * 86_400_000;
      const inBaseline = firedMs - 15 * 86_400_000;

      // Only 5 samples in low cruise: below MIN_BIN_SAMPLES (30).
      const buildAt = (anchor: number, value: number, count: number) => {
        const out: Array<{ ts: number; value: number }> = [];
        for (let i = 0; i < count; i += 1) out.push({ ts: anchor + i * 1000, value });
        return out;
      };
      // 20 Hz lands in low cruise.
      const weekRpm = buildAt(inWeek, 20, 5);
      const weekFuel = weekRpm.map((r) => ({ ts: r.ts, value: 0.0001 }));
      const weekSog = weekRpm.map((r) => ({ ts: r.ts, value: 2.5 }));
      const baseRpm = buildAt(inBaseline, 20, 5);
      const baseFuel = baseRpm.map((r) => ({ ts: r.ts, value: 0.0001 }));
      const baseSog = baseRpm.map((r) => ({ ts: r.ts, value: 2.5 }));

      const thisWeekFromIso = new Date(firedMs - 7 * 86_400_000).toISOString();
      // `ts >= '<from>'` uniquely identifies the week query; the baseline
      // query has the same boundary timestamp on its `ts < ...` clause.
      const stub = stubQuestDB((sql) => {
        const inThisWeek = sql.includes(`ts >= '${thisWeekFromIso}'`);
        if (sql.includes('propulsion.port.revolutions')) {
          return inThisWeek ? weekRpm : baseRpm;
        }
        if (sql.includes('propulsion.port.fuel.rate')) {
          return inThisWeek ? weekFuel : baseFuel;
        }
        if (sql.includes('navigation.speedOverGround')) {
          return inThisWeek ? weekSog : baseSog;
        }
        return [];
      });

      const a = new DriftAnalyzer(makeCfg());
      const ctx: TriggerCtx = { kind: 'cron', firedAt };
      const r = await a.collectContext(
        ctx,
        makeDeps(app, buf, stub as unknown as AnalyzerDeps['questdb']),
      );
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

// Helpers to synthesize plausible fuel/SOG values per RPM band (rpm in Hz).
// Multipliers let tests skew one band relative to baseline.
function fuelForRpm(rpmHz: number, mul: number): number {
  let base: number;
  if (rpmHz < 15) base = 0.00005;
  else if (rpmHz < 30) base = 0.00012;
  else if (rpmHz < 50) base = 0.00028;
  else base = 0.00044;
  return base * mul;
}

function sogForRpm(rpmHz: number, mul: number): number {
  let base: number;
  if (rpmHz < 15) base = 0.0;
  else if (rpmHz < 30) base = 2.5;
  else if (rpmHz < 50) base = 4.6;
  else base = 5.5;
  return base * mul;
}
