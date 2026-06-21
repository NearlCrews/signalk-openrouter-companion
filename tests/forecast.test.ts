import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TriggerCtx } from '../src/analyzers/Analyzer.js';
import {
  FORECAST_DEFAULT_SYSTEM_PROMPT,
  ForecastAnalyzer,
  type ForecastInput,
  parseForecast,
  resolveForecastState,
} from '../src/analyzers/forecast.js';
import { RollingBuffer } from '../src/core/buffer.js';
import { ReportPublisher } from '../src/core/publisher.js';
import type { SeverityFloor } from '../src/types.js';
import {
  cleanupTmpDir,
  firstNotificationValue,
  type MockApp,
  makeAnalyzerDeps,
  makeMockApp,
  makeQuestDBStub,
  makeRouterDeps,
  makeTmpDir,
} from './_mocks.js';

const HOUR = 3_600_000;
// Fixed trigger time so the 12 hourly buckets land on predictable indices.
const FIRED_AT = new Date('2026-05-10T12:00:00.000Z');
const FIRED_MS = FIRED_AT.getTime();
const PRESSURE_PATH = 'environment.outside.pressure';
const TEMPERATURE_PATH = 'environment.outside.temperature';
const GUST_PATH = 'environment.weather.speedGust';
const REPORT_PATH = 'notifications.openrouter-companion.forecast.report';

function makeCfg(
  overrides: Partial<{ severityFloor: SeverityFloor; cron: boolean; put: boolean }> = {},
) {
  return {
    triggers: {
      cron: { enabled: overrides.cron ?? true, pattern: '0 */3 * * *', timezone: '' },
      put: { enabled: overrides.put ?? true },
      events: [] as string[],
    },
    severityFloor: overrides.severityFloor ?? ('moderate' as SeverityFloor),
  };
}

// QuestDB baseline result shape consumed by queryBaseline: columns `path` and
// `mean_value`, one row per weather path with a 24-72h mean.
function baselineResult(rows: Array<{ path: string; mean: number }>) {
  return {
    columns: [
      { name: 'path', type: 'STRING' },
      { name: 'mean_value', type: 'DOUBLE' },
    ],
    dataset: rows.map((r) => [r.path, r.mean]),
  };
}

const cronCtx: TriggerCtx = { kind: 'cron', firedAt: FIRED_AT };

describe('ForecastAnalyzer', () => {
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
      const a = new ForecastAnalyzer(makeCfg());
      const kinds = a.triggers.map((t) => t.kind).sort();
      expect(kinds).toEqual(['cron', 'put']);
      const cron = a.triggers.find((t) => t.kind === 'cron') as { kind: 'cron'; pattern: string };
      expect(cron.pattern).toBe('0 */3 * * *');
      const put = a.triggers.find((t) => t.kind === 'put') as { kind: 'put'; path: string };
      expect(put.path).toBe('plugins.openrouter-companion.forecast.run');
    });

    it('omits cron when cron disabled', () => {
      const a = new ForecastAnalyzer(makeCfg({ cron: false }));
      expect(a.triggers.map((t) => t.kind)).toEqual(['put']);
    });

    it('omits put when put disabled', () => {
      const a = new ForecastAnalyzer(makeCfg({ put: false }));
      expect(a.triggers.map((t) => t.kind)).toEqual(['cron']);
    });

    it('subscribes to no engine or battery events', () => {
      const a = new ForecastAnalyzer(makeCfg());
      const eventKinds = a.triggers.map((t) => t.kind).filter((k) => k !== 'cron' && k !== 'put');
      expect(eventKinds).toEqual([]);
    });
  });

  describe('parseForecast', () => {
    it('parses each valid SEVERITY grade and keeps the rest as the body', () => {
      for (const grade of ['severe', 'moderate', 'minor', 'none'] as const) {
        const r = parseForecast(`SEVERITY: ${grade}\nShort headline.\n\nThe outlook paragraph.`);
        expect(r.grade).toBe(grade);
        expect(r.body).toBe('Short headline.\n\nThe outlook paragraph.');
      }
    });

    it('is case-insensitive on the SEVERITY line', () => {
      const r = parseForecast('severity: Severe\nDeepening low approaching.');
      expect(r.grade).toBe('severe');
      expect(r.body).toBe('Deepening low approaching.');
    });

    it('drops a malformed SEVERITY-prefixed line and falls back to none', () => {
      const r = parseForecast('SEVERITY: catastrophic\nShort headline.\n\nThe outlook paragraph.');
      expect(r.grade).toBe('none');
      // The unparseable SEVERITY line is dropped, the rest kept as the body.
      expect(r.body).toBe('Short headline.\n\nThe outlook paragraph.');
    });

    it('keeps the whole text and grades none when no SEVERITY line is present', () => {
      const text = 'Conditions settled.\n\nNo significant change expected overnight.';
      const r = parseForecast(text);
      expect(r.grade).toBe('none');
      expect(r.body).toBe(text);
    });
  });

  describe('resolveForecastState', () => {
    it('floor "severe" raises an alarm only on a severe grade', () => {
      expect(resolveForecastState('severe', 'severe')).toBe('alarm');
      expect(resolveForecastState('moderate', 'severe')).toBe('nominal');
      expect(resolveForecastState('minor', 'severe')).toBe('nominal');
      expect(resolveForecastState('none', 'severe')).toBe('nominal');
    });

    it('floor "moderate" raises on moderate and severe', () => {
      expect(resolveForecastState('severe', 'moderate')).toBe('alarm');
      expect(resolveForecastState('moderate', 'moderate')).toBe('warn');
      expect(resolveForecastState('minor', 'moderate')).toBe('nominal');
      expect(resolveForecastState('none', 'moderate')).toBe('nominal');
    });

    it('floor "minor" raises on every deterioration grade', () => {
      expect(resolveForecastState('severe', 'minor')).toBe('alarm');
      expect(resolveForecastState('moderate', 'minor')).toBe('warn');
      expect(resolveForecastState('minor', 'minor')).toBe('alert');
      // 'none' never raises, whatever the floor.
      expect(resolveForecastState('none', 'minor')).toBe('nominal');
    });
  });

  describe('collectContext cold start', () => {
    it('returns null with under an hour of history and no QuestDB', async () => {
      const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
      buf.record(PRESSURE_PATH, 101_300, FIRED_MS - 30 * 60_000, 'accuweather');
      const a = new ForecastAnalyzer(makeCfg());
      const r = await a.collectContext(cronCtx, makeAnalyzerDeps(app, buf));
      expect(r).toBeNull();
    });

    it('proceeds despite a thin buffer when a QuestDB baseline is available', async () => {
      const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
      buf.record(PRESSURE_PATH, 101_300, FIRED_MS - 30 * 60_000, 'accuweather');
      const stub = makeQuestDBStub(() => baselineResult([{ path: PRESSURE_PATH, mean: 101_500 }]));
      const a = new ForecastAnalyzer(makeCfg());
      const r = await a.collectContext(cronCtx, makeAnalyzerDeps(app, buf, { questdb: stub }));
      expect(r).not.toBeNull();
      expect((r as ForecastInput).hasQuestdbBaseline).toBe(true);
    });
  });

  describe('collectContext trend buckets', () => {
    it('averages samples that fall in the same hourly bucket', async () => {
      const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
      // Samples are recorded oldest-first, as live deltas arrive. One older
      // sample (bucket 8) clears the 1h cold-start floor; two recent samples
      // 0.5h before the trigger both land in bucket 11 and average to 292.
      buf.record(TEMPERATURE_PATH, 288, FIRED_MS - 3.5 * HOUR, 'accuweather');
      buf.record(TEMPERATURE_PATH, 290, FIRED_MS - 30 * 60_000, 'accuweather');
      buf.record(TEMPERATURE_PATH, 294, FIRED_MS - 29 * 60_000, 'accuweather');
      const a = new ForecastAnalyzer(makeCfg());
      const r = await a.collectContext(cronCtx, makeAnalyzerDeps(app, buf));
      expect(r).not.toBeNull();
      const temp = (r as ForecastInput).trends.find((t) => t.path === TEMPERATURE_PATH);
      if (!temp) throw new Error('expected a temperature trend');
      expect(temp.buckets).toHaveLength(12);
      expect(temp.buckets[11]).toBe(292);
      expect(temp.buckets[8]).toBe(288);
      expect(temp.current).toBe(294);
    });

    it('pre-computes the 3h barometric tendency in hPa', async () => {
      const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
      // Bucket 8 (3.5h ago) and bucket 11 (0.5h ago) are exactly 3 buckets apart.
      buf.record(PRESSURE_PATH, 101_300, FIRED_MS - 3.5 * HOUR, 'accuweather');
      buf.record(PRESSURE_PATH, 100_700, FIRED_MS - 30 * 60_000, 'accuweather');
      const a = new ForecastAnalyzer(makeCfg());
      const r = await a.collectContext(cronCtx, makeAnalyzerDeps(app, buf));
      expect(r).not.toBeNull();
      // (100700 - 101300) Pa / 100 = -6 hPa: a falling glass.
      expect((r as ForecastInput).pressureTendencyHpa).toBeCloseTo(-6, 5);
      expect((r as ForecastInput).tendencyHours).toBe(3);
      expect((r as ForecastInput).trendWindowHours).toBe(12);
    });

    it('reports a null tendency when the prior 3h bucket is empty', async () => {
      const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
      // Pressure only recently; an older temperature sample clears cold start.
      buf.record(TEMPERATURE_PATH, 288, FIRED_MS - 3.5 * HOUR, 'accuweather');
      buf.record(PRESSURE_PATH, 100_700, FIRED_MS - 30 * 60_000, 'accuweather');
      const a = new ForecastAnalyzer(makeCfg());
      const r = await a.collectContext(cronCtx, makeAnalyzerDeps(app, buf));
      expect(r).not.toBeNull();
      expect((r as ForecastInput).pressureTendencyHpa).toBeNull();
    });

    it('reports a null tendency when the latest pressure bucket is stale', async () => {
      const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
      // Pressure stopped 4.5h ago: buckets 4 and 7 populated, current bucket
      // 11 empty. The prompt labels the tendency "last 3h", so an old delta
      // must not be surfaced as current.
      buf.record(PRESSURE_PATH, 101_300, FIRED_MS - 7.5 * HOUR, 'accuweather');
      buf.record(PRESSURE_PATH, 100_700, FIRED_MS - 4.5 * HOUR, 'accuweather');
      const a = new ForecastAnalyzer(makeCfg());
      const r = await a.collectContext(cronCtx, makeAnalyzerDeps(app, buf));
      expect(r).not.toBeNull();
      expect((r as ForecastInput).pressureTendencyHpa).toBeNull();
    });
  });

  describe('collectContext buffer-only vs QuestDB baseline', () => {
    it('runs buffer-only with no QuestDB: baseline flag false, baselineMean null', async () => {
      const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
      buf.record(PRESSURE_PATH, 101_300, FIRED_MS - 3.5 * HOUR, 'accuweather');
      buf.record(PRESSURE_PATH, 100_700, FIRED_MS - 30 * 60_000, 'accuweather');
      const a = new ForecastAnalyzer(makeCfg());
      const r = await a.collectContext(cronCtx, makeAnalyzerDeps(app, buf));
      expect(r).not.toBeNull();
      const input = r as ForecastInput;
      expect(input.hasQuestdbBaseline).toBe(false);
      for (const t of input.trends) expect(t.baselineMean).toBeNull();
    });

    it('falls back to a buffer-only forecast when the QuestDB query throws', async () => {
      const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
      buf.record(PRESSURE_PATH, 101_300, FIRED_MS - 3.5 * HOUR, 'accuweather');
      buf.record(PRESSURE_PATH, 100_700, FIRED_MS - 30 * 60_000, 'accuweather');
      const stub = makeQuestDBStub(() => {
        throw new Error('questdb unreachable');
      });
      const a = new ForecastAnalyzer(makeCfg());
      const r = await a.collectContext(cronCtx, makeAnalyzerDeps(app, buf, { questdb: stub }));
      expect(r).not.toBeNull();
      const input = r as ForecastInput;
      // queryBaseline swallows the failure: the analyzer still runs on the buffer.
      expect(input.hasQuestdbBaseline).toBe(false);
      for (const t of input.trends) expect(t.baselineMean).toBeNull();
      expect(stub.calls).toHaveLength(1);
    });

    it('attaches the QuestDB 24-72h baseline mean per path when QuestDB is reachable', async () => {
      const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
      buf.record(PRESSURE_PATH, 101_300, FIRED_MS - 3.5 * HOUR, 'accuweather');
      buf.record(PRESSURE_PATH, 100_700, FIRED_MS - 30 * 60_000, 'accuweather');
      const stub = makeQuestDBStub(() => baselineResult([{ path: PRESSURE_PATH, mean: 101_900 }]));
      const a = new ForecastAnalyzer(makeCfg());
      const r = await a.collectContext(cronCtx, makeAnalyzerDeps(app, buf, { questdb: stub }));
      expect(r).not.toBeNull();
      const input = r as ForecastInput;
      expect(input.hasQuestdbBaseline).toBe(true);
      const pressure = input.trends.find((t) => t.path === PRESSURE_PATH);
      expect(pressure?.baselineMean).toBe(101_900);
      // One baseline query, scoped to the weather paths.
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0]).toContain(PRESSURE_PATH);
    });
  });

  describe('collectContext graceful degradation', () => {
    it('produces a forecast from a canonical-only feed', async () => {
      const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
      buf.record(PRESSURE_PATH, 101_300, FIRED_MS - 3.5 * HOUR, 'accuweather');
      buf.record(PRESSURE_PATH, 100_700, FIRED_MS - 30 * 60_000, 'accuweather');
      const a = new ForecastAnalyzer(makeCfg());
      const r = await a.collectContext(cronCtx, makeAnalyzerDeps(app, buf));
      expect(r).not.toBeNull();
      const input = r as ForecastInput;
      // Every trend is from the canonical family; no extension paths present.
      expect(input.trends.every((t) => t.family === 'canonical')).toBe(true);
      const prompt = a.buildPrompt(input);
      expect(prompt.user).toContain('### Canonical paths');
      expect(prompt.user).toContain('None present; the outlook runs on canonical data only.');
    });

    it('includes extension paths in the trend table when they are present', async () => {
      const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
      buf.record(PRESSURE_PATH, 100_700, FIRED_MS - 3.5 * HOUR, 'accuweather');
      buf.record(GUST_PATH, 14.2, FIRED_MS - 30 * 60_000, 'accuweather');
      const a = new ForecastAnalyzer(makeCfg());
      const r = await a.collectContext(cronCtx, makeAnalyzerDeps(app, buf));
      expect(r).not.toBeNull();
      const gust = (r as ForecastInput).trends.find((t) => t.path === GUST_PATH);
      expect(gust?.family).toBe('extension');
      const prompt = a.buildPrompt(r as ForecastInput);
      expect(prompt.user).toContain(GUST_PATH);
    });
  });

  describe('buildPrompt', () => {
    it('produces deterministic system + user content from a representative input', () => {
      const a = new ForecastAnalyzer(makeCfg());
      const out = a.buildPrompt({
        generatedAt: '2026-05-10T12:00:00.000Z',
        trendWindowHours: 12,
        tendencyHours: 3,
        pressureTendencyHpa: -6,
        hasQuestdbBaseline: false,
        trends: [
          {
            path: PRESSURE_PATH,
            family: 'canonical',
            label: 'barometric pressure',
            unit: 'Pa',
            source: 'accuweather',
            current: 100_700,
            buckets: [null, null, null, null, null, null, null, null, 101_300, null, null, 100_700],
            baselineMean: null,
          },
        ],
      });
      // The system prompt must keep the SEVERITY-line contract publishOutput needs.
      expect(out.system).toContain('SEVERITY');
      expect(out.system).toContain('marine weather forecaster');
      expect(out.user).toContain('## Generated 2026-05-10T12:00:00.000Z');
      expect(out.user).toContain('Barometric tendency: -6.0 hPa over the last 3h.');
      expect(out.user).toContain('### Canonical paths');
      expect(out.user).toContain('### Extension paths');
      expect(out.user).toContain('No QuestDB baseline available');
    });

    it('honors a customSystemPrompt override', () => {
      const cfg = { ...makeCfg(), customSystemPrompt: 'Custom forecaster prompt.' };
      const a = new ForecastAnalyzer(cfg);
      expect(
        a.buildPrompt({
          generatedAt: '2026-05-10T12:00:00.000Z',
          trendWindowHours: 12,
          tendencyHours: 3,
          pressureTendencyHpa: null,
          hasQuestdbBaseline: false,
          trends: [],
        }).system,
      ).toBe('Custom forecaster prompt.');
    });

    it('exposes a non-empty default system prompt', () => {
      expect(FORECAST_DEFAULT_SYSTEM_PROMPT.length).toBeGreaterThan(0);
      expect(FORECAST_DEFAULT_SYSTEM_PROMPT).toContain('SEVERITY');
    });
  });

  describe('publishOutput', () => {
    function makePublisher() {
      return new ReportPublisher({ app, pluginId: 'orcb', logPath: join(dir, 'reports.jsonl') });
    }

    it('publishes an alarm-state notification when the grade meets the floor', async () => {
      const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
      const publisher = makePublisher();
      const a = new ForecastAnalyzer(makeCfg({ severityFloor: 'moderate' }));
      await a.publishOutput?.(
        'SEVERITY: severe\nDeepening low approaching; expect gale-force wind within hours.',
        cronCtx,
        makeAnalyzerDeps(app, buf, { publisher }),
      );
      expect(app.published).toHaveLength(1);
      const v = firstNotificationValue(app.published[0]?.delta);
      expect(v.path).toBe(REPORT_PATH);
      expect(v.state).toBe('alarm');
      // The SEVERITY line is stripped; only the prose body reaches the consumer.
      expect(v.message).toBe('Deepening low approaching; expect gale-force wind within hours.');
      const line = (await readFile(join(dir, 'reports.jsonl'), 'utf-8')).trim();
      expect(JSON.parse(line).analyzer).toBe('forecast');
    });

    it('publishes at state nominal when the grade is below the floor', async () => {
      const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
      const publisher = makePublisher();
      const a = new ForecastAnalyzer(makeCfg({ severityFloor: 'moderate' }));
      await a.publishOutput?.(
        'SEVERITY: minor\nA slight deterioration is possible later.',
        cronCtx,
        makeAnalyzerDeps(app, buf, { publisher }),
      );
      const v = firstNotificationValue(app.published[0]?.delta);
      expect(v.path).toBe(REPORT_PATH);
      expect(v.state).toBe('nominal');
      expect(v.message).toBe('A slight deterioration is possible later.');
    });

    it('publishes the whole text at state nominal when no SEVERITY line is present', async () => {
      const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
      const publisher = makePublisher();
      const a = new ForecastAnalyzer(makeCfg({ severityFloor: 'minor' }));
      const text = 'Conditions settled; no significant change expected overnight.';
      await a.publishOutput?.(text, cronCtx, makeAnalyzerDeps(app, buf, { publisher }));
      const v = firstNotificationValue(app.published[0]?.delta);
      expect(v.state).toBe('nominal');
      expect(v.message).toBe(text);
    });

    it('forwards run-meta to publishOnPath', async () => {
      const a = new ForecastAnalyzer(makeCfg({ severityFloor: 'moderate' }));
      const { deps, mocks } = makeRouterDeps();
      const run = {
        model: 'anthropic/claude-haiku-4.5',
        usage: { totalTokens: 50, cachedTokens: 0, cost: 0.0005 },
      };
      await a.publishOutput?.('SEVERITY: severe\nDeepening low approaching.', cronCtx, deps, run);
      expect(mocks.publishOnPath).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ run }),
        expect.any(Object),
      );
    });
  });
});
