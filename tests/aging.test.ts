import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyzerDeps, TriggerCtx } from '../src/analyzers/Analyzer.js';
import { AgingAnalyzer } from '../src/analyzers/aging.js';
import { RollingBuffer } from '../src/core/buffer.js';
import { Logger } from '../src/core/logger.js';
import { ReportPublisher } from '../src/core/publisher.js';
import type { QueryResult } from '../src/core/questdb.js';
import { cleanupTmpDir, type MockApp, makeMockApp, makeTmpDir } from './_mocks.js';

interface QuerySpec {
  path: string;
  first: number;
  last: number;
  n: number;
}

interface StubQuestDB {
  query: (sql: string) => Promise<QueryResult>;
  calls: string[];
}

function makeCfg() {
  return {
    triggers: {
      cron: { enabled: true, pattern: '0 8 1 * *', timezone: '' },
      put: { enabled: true, path: 'plugins.openrouter-companion.aging.run' },
      events: [] as string[],
    },
  };
}

function stubQuestDB(perWindow: Partial<Record<number, QuerySpec[]>>): StubQuestDB {
  const stub: StubQuestDB = {
    calls: [],
    query: async (sql: string) => {
      stub.calls.push(sql);
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
    },
  };
  return stub;
}

function makeDeps(
  app: MockApp,
  buffer: RollingBuffer,
  questdb: StubQuestDB | null,
  publisher?: ReportPublisher,
): AnalyzerDeps {
  return {
    app: { getSelfPath: (p) => app.getSelfPath(p), selfContext: app.selfContext },
    buffer,
    questdb: questdb as unknown as AnalyzerDeps['questdb'],
    publisher: (publisher ?? ({} as never)) as never,
    budget: {} as never,
    llm: {} as never,
    logger: new Logger({ debug: vi.fn(), error: vi.fn() }),
  };
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

  it('collectContext queries 30d and 90d windows per bank and computes deltas', async () => {
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
    expect(r!.banks).toHaveLength(1);
    const bank = r!.banks[0]!;
    expect(bank.id).toBe('house');
    expect(r!.generatedAt).toBe('2026-05-11T08:00:00.000Z');
    expect(r!.selfContext).toBe(app.selfContext);

    const w30 = bank.windows['30d'];
    expect(w30.capacityStart).toBe(5_500_000);
    expect(w30.capacityEnd).toBe(5_400_000);
    expect(w30.capacitySamples).toBe(60);
    expect(w30.cyclesDelta).toBe(5);
    expect(w30.capacityDeltaPct).toBeCloseTo(-1.8182, 3);
    expect(w30.lossPer100Cycles).toBeCloseTo(36.3636, 3);

    const w90 = bank.windows['90d'];
    expect(w90.capacityStart).toBe(5_700_000);
    expect(w90.cyclesDelta).toBe(20);
    expect(w90.capacityDeltaPct).toBeCloseTo(-5.2632, 3);
    expect(w90.lossPer100Cycles).toBeCloseTo(26.3158, 3);

    // 2 queries per discovered bank × 2 windows. starter was discovered but
    // also queried before the analyzer found no usable data.
    expect(stub.calls.length).toBe(4);
    expect(stub.calls.some((q) => q.includes('-30,'))).toBe(true);
    expect(stub.calls.some((q) => q.includes('-90,'))).toBe(true);
  });

  it('buildPrompt produces deterministic system + user content', () => {
    const a = new AgingAnalyzer(makeCfg());
    const out = a.buildPrompt({
      generatedAt: '2026-05-11T08:00:00.000Z',
      selfContext: 'vessels.urn:mrn:signalk:uuid:test',
      banks: [
        {
          id: 'house',
          windows: {
            '30d': {
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
            '90d': {
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

  it('publishOutput publishes on notifications.openrouter-companion.aging.report', async () => {
    const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
    const publisher = new ReportPublisher({
      app,
      pluginId: 'orc',
      notificationPath: 'unused',
      notificationState: 'normal',
      logPath: join(dir, 'reports.jsonl'),
    });
    const a = new AgingAnalyzer(makeCfg());
    const ctx: TriggerCtx = { kind: 'cron', firedAt: new Date('2026-05-11T08:00:00Z') };
    await a.publishOutput(
      'House bank lost 1.8% capacity in 30 days.',
      ctx,
      makeDeps(app, buf, null, publisher),
    );
    expect(app.published).toHaveLength(1);
    const d = app.published[0]!.delta as {
      updates: { values: { path: string; value: { state: string; message: string } }[] }[];
    };
    expect(d.updates[0]!.values[0]!.path).toBe('notifications.openrouter-companion.aging.report');
    expect(d.updates[0]!.values[0]!.value.state).toBe('normal');
    const line = (await readFile(join(dir, 'reports.jsonl'), 'utf-8')).trim();
    expect(JSON.parse(line).analyzer).toBe('aging');
  });
});
