import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TriggerCtx } from '../src/analyzers/Analyzer.js';
import { LivenessAnalyzer } from '../src/analyzers/liveness.js';
import {
  cleanupTmpDir,
  type MockApp,
  makeBuffer,
  makeAnalyzerDeps as makeDeps,
  makeMockApp,
  makeTmpDir,
} from './_mocks.js';

function makeCfg(overrides: Record<string, unknown> = {}) {
  return {
    triggers: {
      cron: { enabled: true, pattern: '0 8 * * *', timezone: '' },
      put: { enabled: true, path: 'plugins.openrouter-companion.liveness.run' },
      events: [],
    },
    stalenessThresholdSec: 300,
    ...overrides,
  };
}

const FIRED = new Date('2026-05-15T08:00:00Z');
const FIRED_MS = FIRED.getTime();

describe('LivenessAnalyzer', () => {
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
    const a = new LivenessAnalyzer(makeCfg());
    const kinds = a.triggers.map((t) => t.kind).sort();
    expect(kinds).toEqual(['cron', 'put']);
  });

  it('collectContext returns null when the buffer is empty', async () => {
    const a = new LivenessAnalyzer(makeCfg());
    const ctx: TriggerCtx = { kind: 'cron', firedAt: FIRED };
    const r = await a.collectContext(ctx, makeDeps(app, makeBuffer()));
    expect(r).toBeNull();
  });

  it('marks a recently-updated path as not stale', async () => {
    const buf = makeBuffer();
    buf.record('electrical.batteries.house.voltage', 12.6, FIRED_MS - 1000, 'bms');
    const a = new LivenessAnalyzer(makeCfg());
    const r = await a.collectContext({ kind: 'cron', firedAt: FIRED }, makeDeps(app, buf));
    expect(r?.paths).toHaveLength(1);
    expect(r?.paths[0]?.stale).toBe(false);
    expect(r?.paths[0]?.lastSeenAgeSec).toBe(1);
  });

  it('marks a path with an old newest sample as stale', async () => {
    const buf = makeBuffer();
    buf.record('propulsion.port.revolutions', 25, FIRED_MS - 600_000, 'n2k');
    const a = new LivenessAnalyzer(makeCfg());
    const r = await a.collectContext({ kind: 'cron', firedAt: FIRED }, makeDeps(app, buf));
    expect(r?.paths[0]?.stale).toBe(true);
    expect(r?.paths[0]?.lastSeenAgeSec).toBe(600);
  });

  it('treats a path with no sample in [0, firedAt] as stale with null age', async () => {
    const buf = makeBuffer();
    // Only sample is timestamped after firedAt, so the [0, firedMs] slice is empty.
    buf.record('environment.depth.belowTransducer', 3.1, FIRED_MS + 5000, 'sounder');
    const a = new LivenessAnalyzer(makeCfg());
    const r = await a.collectContext({ kind: 'cron', firedAt: FIRED }, makeDeps(app, buf));
    expect(r?.paths[0]?.lastSeenAgeSec).toBeNull();
    expect(r?.paths[0]?.stale).toBe(true);
  });

  it('flags a path served by two sources as multi-source', async () => {
    const buf = makeBuffer();
    buf.record('propulsion.port.temperature', 350, FIRED_MS - 2000, 'nmea2000_feed');
    buf.record('propulsion.port.temperature', 351, FIRED_MS - 1000, 'notificationApi');
    const a = new LivenessAnalyzer(makeCfg());
    const r = await a.collectContext({ kind: 'cron', firedAt: FIRED }, makeDeps(app, buf));
    expect(r?.paths[0]?.multiSource).toBe(true);
    expect(r?.paths[0]?.sources).toEqual(['nmea2000_feed', 'notificationApi']);
  });

  it('treats a sample exactly at the threshold as not stale, just over as stale', async () => {
    const buf = makeBuffer();
    buf.record('at.threshold', 1, FIRED_MS - 300_000, 's'); // age 300s == threshold
    buf.record('over.threshold', 1, FIRED_MS - 301_000, 's'); // age 301s > threshold
    const a = new LivenessAnalyzer(makeCfg());
    const r = await a.collectContext({ kind: 'cron', firedAt: FIRED }, makeDeps(app, buf));
    const byPath = Object.fromEntries((r?.paths ?? []).map((p) => [p.path, p.stale]));
    expect(byPath['at.threshold']).toBe(false);
    expect(byPath['over.threshold']).toBe(true);
  });

  it('buildPrompt includes path names, the threshold, and stale/multi-source flags', () => {
    const a = new LivenessAnalyzer(makeCfg());
    const out = a.buildPrompt({
      generatedAt: '2026-05-15T08:00:00.000Z',
      stalenessThresholdSec: 300,
      paths: [
        {
          path: 'propulsion.port.revolutions',
          lastSeenAgeSec: 600,
          stale: true,
          sampleCount: 3,
          sources: ['n2k', 'gps'],
          multiSource: true,
        },
      ],
    });
    expect(out.system).toContain('Signal K');
    expect(out.user).toContain('propulsion.port.revolutions');
    expect(out.user).toContain('300');
    expect(out.user).toContain('STALE');
    expect(out.user).toContain('MULTI-SOURCE');
  });
});
