import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TriggerCtx } from '../src/analyzers/Analyzer.js';
import { AgingAnalyzer } from '../src/analyzers/aging.js';
import { RollingBuffer } from '../src/core/buffer.js';
import { ReportPublisher } from '../src/core/publisher.js';
import {
  cleanupTmpDir,
  firstNotificationValue,
  type MockApp,
  type MockQuestDB,
  makeAnalyzerDeps,
  makeMockApp,
  makeQuestDBStub,
  makeTmpDir,
} from './_mocks.js';

interface QuerySpec {
  path: string;
  first: number;
  last: number;
  n: number;
}

function makeCfg(overrides: Partial<{ shortWindowDays: number; longWindowDays: number }> = {}) {
  return {
    triggers: {
      cron: { enabled: true, pattern: '0 8 1 * *', timezone: '' },
      put: { enabled: true, path: 'plugins.openrouter-companion.aging.run' },
      events: [] as string[],
    },
    shortWindowDays: overrides.shortWindowDays ?? 30,
    longWindowDays: overrides.longWindowDays ?? 90,
  };
}

// Aging issues one batched query per window with a `dateadd('d', -<days>, ...)`
// boundary. Dispatch by parsing the days back out of the SQL.
function windowStats<B extends { windows: { days: number; stats: S }[] }, S>(
  bank: B,
  days: number,
): S {
  const w = bank.windows.find((x) => x.days === days);
  if (!w) throw new Error(`no ${days}d window`);
  return w.stats;
}

function stubQuestDB(perWindow: Partial<Record<number, QuerySpec[]>>): MockQuestDB {
  return makeQuestDBStub((sql) => {
    const m = sql.match(/dateadd\('d', -(\d+),/);
    const days = m?.[1] ? Number.parseInt(m[1], 10) : 0;
    const rows = perWindow[days] ?? [];
    return {
      columns: [
        { name: 'path', type: 'STRING' },
        { name: 'first_val', type: 'DOUBLE' },
        { name: 'last_val', type: 'DOUBLE' },
        { name: 'n', type: 'LONG' },
      ],
      dataset: rows.map((r) => [r.path, r.first, r.last, r.n]),
    };
  });
}

function makeDeps(
  app: MockApp,
  buffer: RollingBuffer,
  questdb: MockQuestDB | null,
  publisher?: ReportPublisher,
) {
  return makeAnalyzerDeps(app, buffer, { questdb, publisher });
}

describe('AgingAnalyzer', () => {
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
    const a = new AgingAnalyzer(makeCfg());
    const kinds = a.triggers.map((t) => t.kind).sort();
    expect(kinds).toEqual(['cron', 'put']);
    const cron = a.triggers.find((t) => t.kind === 'cron') as { kind: 'cron'; pattern: string };
    expect(cron.pattern).toBe('0 8 1 * *');
    const put = a.triggers.find((t) => t.kind === 'put') as { kind: 'put'; path: string };
    expect(put.path).toBe('plugins.openrouter-companion.aging.run');
  });

  it('omits cron trigger when cron disabled', () => {
    const cfg = makeCfg();
    cfg.triggers.cron.enabled = false;
    const a = new AgingAnalyzer(cfg);
    expect(a.triggers.map((t) => t.kind)).toEqual(['put']);
  });

  it('omits put trigger when put disabled', () => {
    const cfg = makeCfg();
    cfg.triggers.put.enabled = false;
    const a = new AgingAnalyzer(cfg);
    expect(a.triggers.map((t) => t.kind)).toEqual(['cron']);
  });

  it('collectContext returns null when QuestDB is unavailable', async () => {
    const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
    buf.record('electrical.batteries.house.capacity.actual', 5_400_000, Date.now(), 'bms');
    const a = new AgingAnalyzer(makeCfg());
    const ctx: TriggerCtx = { kind: 'cron', firedAt: new Date('2026-05-11T08:00:00Z') };
    expect(await a.collectContext(ctx, makeDeps(app, buf, null))).toBeNull();
  });

  it('collectContext returns null when no battery banks have been observed', async () => {
    const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
    const a = new AgingAnalyzer(makeCfg());
    const stub = stubQuestDB({});
    const ctx: TriggerCtx = { kind: 'cron', firedAt: new Date('2026-05-11T08:00:00Z') };
    expect(await a.collectContext(ctx, makeDeps(app, buf, stub))).toBeNull();
    expect(stub.calls).toHaveLength(0);
  });

  it('collectContext returns null when no bank has at least two samples in any window', async () => {
    const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
    buf.record('electrical.batteries.house.capacity.actual', 5_400_000, Date.now(), 'bms');
    const a = new AgingAnalyzer(makeCfg());
    // Stub returns one sample for capacity, none for cycles, so insufficient data.
    const stub = stubQuestDB({
      30: [
        {
          path: 'electrical.batteries.house.capacity.actual',
          first: 5_400_000,
          last: 5_400_000,
          n: 1,
        },
      ],
      90: [
        {
          path: 'electrical.batteries.house.capacity.actual',
          first: 5_400_000,
          last: 5_400_000,
          n: 1,
        },
      ],
    });
    const ctx: TriggerCtx = { kind: 'cron', firedAt: new Date('2026-05-11T08:00:00Z') };
    expect(await a.collectContext(ctx, makeDeps(app, buf, stub))).toBeNull();
  });

  it('collectContext issues one query per window for all banks and computes deltas', async () => {
    const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
    const now = Date.now();
    buf.record('electrical.batteries.house.capacity.actual', 5_400_000, now, 'bms');
    buf.record('electrical.batteries.house.cycles', 100, now, 'bms');
    buf.record('electrical.batteries.starter.voltage', 12.6, now, 'bms');

    const stub = stubQuestDB({
      30: [
        {
          path: 'electrical.batteries.house.capacity.actual',
          first: 5_500_000,
          last: 5_400_000,
          n: 60,
        },
        { path: 'electrical.batteries.house.cycles', first: 95, last: 100, n: 60 },
      ],
      90: [
        {
          path: 'electrical.batteries.house.capacity.actual',
          first: 5_700_000,
          last: 5_400_000,
          n: 180,
        },
        { path: 'electrical.batteries.house.cycles', first: 80, last: 100, n: 180 },
      ],
    });

    const a = new AgingAnalyzer(makeCfg());
    const ctx: TriggerCtx = { kind: 'cron', firedAt: new Date('2026-05-11T08:00:00Z') };
    const r = await a.collectContext(ctx, makeDeps(app, buf, stub));
    expect(r).not.toBeNull();
    // starter has no capacity.actual/cycles data so it should be skipped.
    expect(r?.banks).toHaveLength(1);
    if (!r) throw new Error('expected aging input');
    const bank = r.banks[0];
    if (!bank) throw new Error('expected at least one bank');
    expect(bank.id).toBe('house');
    expect(r?.generatedAt).toBe('2026-05-11T08:00:00.000Z');
    expect(r?.selfContext).toBe(app.selfContext);

    expect(bank.windows.map((w) => w.days)).toEqual([30, 90]);
    const w30 = windowStats(bank, 30);
    expect(w30.capacityStart).toBe(5_500_000);
    expect(w30.capacityEnd).toBe(5_400_000);
    expect(w30.capacitySamples).toBe(60);
    expect(w30.cyclesDelta).toBe(5);
    expect(w30.capacityDeltaPct).toBeCloseTo(-1.8182, 3);
    expect(w30.lossPer100Cycles).toBeCloseTo(36.3636, 3);

    const w90 = windowStats(bank, 90);
    expect(w90.capacityStart).toBe(5_700_000);
    expect(w90.cyclesDelta).toBe(20);
    expect(w90.capacityDeltaPct).toBeCloseTo(-5.2632, 3);
    expect(w90.lossPer100Cycles).toBeCloseTo(26.3158, 3);

    // One batched query per window, regardless of how many banks were discovered.
    expect(stub.calls.length).toBe(2);
    expect(stub.calls.some((q) => q.includes('-30,'))).toBe(true);
    expect(stub.calls.some((q) => q.includes('-90,'))).toBe(true);
    // Each window query must include all discovered banks' paths.
    for (const sql of stub.calls) {
      expect(sql).toContain("'electrical.batteries.house.capacity.actual'");
      expect(sql).toContain("'electrical.batteries.house.cycles'");
      expect(sql).toContain("'electrical.batteries.starter.capacity.actual'");
      expect(sql).toContain("'electrical.batteries.starter.cycles'");
    }
  });

  it('collectContext still issues exactly 2 queries when many banks are present', async () => {
    const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
    const now = Date.now();
    const bankIds = ['house', 'starter', 'console', 'trolling'];
    for (const id of bankIds) {
      buf.record(`electrical.batteries.${id}.capacity.actual`, 5_400_000, now, 'bms');
      buf.record(`electrical.batteries.${id}.cycles`, 100, now, 'bms');
    }

    const rowsFor = (firstCap: number): QuerySpec[] =>
      bankIds.flatMap((id) => [
        {
          path: `electrical.batteries.${id}.capacity.actual`,
          first: firstCap,
          last: 5_400_000,
          n: 60,
        },
        { path: `electrical.batteries.${id}.cycles`, first: 95, last: 100, n: 60 },
      ]);

    const stub = stubQuestDB({
      30: rowsFor(5_500_000),
      90: rowsFor(5_700_000),
    });

    const a = new AgingAnalyzer(makeCfg());
    const ctx: TriggerCtx = { kind: 'cron', firedAt: new Date('2026-05-11T08:00:00Z') };
    const r = await a.collectContext(ctx, makeDeps(app, buf, stub));
    expect(r).not.toBeNull();
    expect(r?.banks.map((b) => b.id).sort()).toEqual([...bankIds].sort());
    // Total query count is exactly 2 (one per window), independent of bank count.
    expect(stub.calls.length).toBe(2);
  });

  it('uses configured shortWindowDays and longWindowDays when set', async () => {
    const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
    buf.record('electrical.batteries.house.capacity.actual', 5_400_000, Date.now(), 'bms');
    const stub = stubQuestDB({
      14: [
        {
          path: 'electrical.batteries.house.capacity.actual',
          first: 5_460_000,
          last: 5_400_000,
          n: 30,
        },
        { path: 'electrical.batteries.house.cycles', first: 98, last: 100, n: 30 },
      ],
      60: [
        {
          path: 'electrical.batteries.house.capacity.actual',
          first: 5_600_000,
          last: 5_400_000,
          n: 120,
        },
        { path: 'electrical.batteries.house.cycles', first: 90, last: 100, n: 120 },
      ],
    });
    const a = new AgingAnalyzer(makeCfg({ shortWindowDays: 14, longWindowDays: 60 }));
    const ctx: TriggerCtx = { kind: 'cron', firedAt: new Date('2026-05-11T08:00:00Z') };
    const r = await a.collectContext(ctx, makeDeps(app, buf, stub));
    expect(r).not.toBeNull();
    expect(r?.banks[0]?.windows.map((w) => w.days)).toEqual([14, 60]);
    expect(stub.calls.some((q) => q.includes('-14,'))).toBe(true);
    expect(stub.calls.some((q) => q.includes('-60,'))).toBe(true);
  });

  it('sorts windows ascending when user inverts short/long days', async () => {
    const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
    buf.record('electrical.batteries.house.capacity.actual', 5_400_000, Date.now(), 'bms');
    const stub = stubQuestDB({
      30: [
        {
          path: 'electrical.batteries.house.capacity.actual',
          first: 5_450_000,
          last: 5_400_000,
          n: 30,
        },
        { path: 'electrical.batteries.house.cycles', first: 99, last: 100, n: 30 },
      ],
      90: [
        {
          path: 'electrical.batteries.house.capacity.actual',
          first: 5_500_000,
          last: 5_400_000,
          n: 90,
        },
        { path: 'electrical.batteries.house.cycles', first: 95, last: 100, n: 90 },
      ],
    });
    const a = new AgingAnalyzer(makeCfg({ shortWindowDays: 90, longWindowDays: 30 }));
    const ctx: TriggerCtx = { kind: 'cron', firedAt: new Date('2026-05-11T08:00:00Z') };
    const r = await a.collectContext(ctx, makeDeps(app, buf, stub));
    expect(r).not.toBeNull();
    expect(r?.banks[0]?.windows.map((w) => w.days)).toEqual([30, 90]);
    expect(stub.calls).toHaveLength(2);
  });

  it('collapses to a single window when shortWindowDays == longWindowDays', async () => {
    const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
    buf.record('electrical.batteries.house.capacity.actual', 5_400_000, Date.now(), 'bms');
    const stub = stubQuestDB({
      45: [
        {
          path: 'electrical.batteries.house.capacity.actual',
          first: 5_500_000,
          last: 5_400_000,
          n: 30,
        },
        { path: 'electrical.batteries.house.cycles', first: 95, last: 100, n: 30 },
      ],
    });
    const a = new AgingAnalyzer(makeCfg({ shortWindowDays: 45, longWindowDays: 45 }));
    const ctx: TriggerCtx = { kind: 'cron', firedAt: new Date('2026-05-11T08:00:00Z') };
    const r = await a.collectContext(ctx, makeDeps(app, buf, stub));
    expect(r).not.toBeNull();
    expect(r?.banks[0]?.windows.map((w) => w.days)).toEqual([45]);
    expect(stub.calls).toHaveLength(1);
  });

  it('buildPrompt produces deterministic system + user content', () => {
    const a = new AgingAnalyzer(makeCfg());
    const out = a.buildPrompt({
      generatedAt: '2026-05-11T08:00:00.000Z',
      selfContext: 'vessels.urn:mrn:signalk:uuid:test',
      banks: [
        {
          id: 'house',
          windows: [
            {
              days: 30,
              stats: {
                capacitySamples: 60,
                capacityStart: 5_500_000,
                capacityEnd: 5_400_000,
                capacityDeltaPct: -1.818,
                cyclesSamples: 60,
                cyclesStart: 95,
                cyclesEnd: 100,
                cyclesDelta: 5,
                lossPer100Cycles: 36.364,
              },
            },
            {
              days: 90,
              stats: {
                capacitySamples: 180,
                capacityStart: 5_700_000,
                capacityEnd: 5_400_000,
                capacityDeltaPct: -5.263,
                cyclesSamples: 180,
                cyclesStart: 80,
                cyclesEnd: 100,
                cyclesDelta: 20,
                lossPer100Cycles: 26.316,
              },
            },
          ],
        },
      ],
    });
    expect(out.system).toContain('LiFePO4');
    expect(out.system).toContain('loss per 100 cycles');
    expect(out.system).toContain('outlier');
    expect(out.user).toContain('### Bank: house');
    expect(out.user).toContain('30d window');
    expect(out.user).toContain('90d window');
    expect(out.user).toContain('5400000');
    expect(out.user).toContain('-1.818');
  });

  it('omits publishOutput so the router uses the publishReport default on the canonical aging path', async () => {
    const a = new AgingAnalyzer(makeCfg());
    // Aging delegates publish-side responsibility to the router default
    // (publisher.publishReport(this.id, ctx, text) on
    // notifications.openrouter-companion.<id>.report with state: nominal).
    expect(a.publishOutput).toBeUndefined();

    // Sanity check that the publisher's publishReport actually emits on the
    // expected canonical path with the expected state, so the router default
    // really does land at notifications.openrouter-companion.aging.report.
    const publisher = new ReportPublisher({
      app,
      pluginId: 'orc',
      logPath: join(dir, 'reports.jsonl'),
    });
    const ctx: TriggerCtx = { kind: 'cron', firedAt: new Date('2026-05-11T08:00:00Z') };
    await publisher.publishReport(a.id, ctx, 'House bank lost 1.8% capacity in 30 days.');
    expect(app.published).toHaveLength(1);
    const v = firstNotificationValue(app.published[0]?.delta);
    expect(v.path).toBe('notifications.openrouter-companion.aging.report');
    expect(v.state).toBe('nominal');
  });
});
