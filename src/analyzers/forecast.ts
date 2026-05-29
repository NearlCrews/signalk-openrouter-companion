import type { BufferEntry } from '../core/buffer.js';
import { resolveSystemPrompt } from '../core/cfg.js';
import { asFiniteNumber, fmtNumber, fmtSigned, HOUR_MS } from '../core/format.js';
import {
  notificationReportPath,
  WEATHER_CANONICAL_PATHS,
  WEATHER_EXTENSION_PATHS,
  WEATHER_PRESSURE_PATH,
} from '../core/paths.js';
import {
  escapeSqlLiteral,
  flattenSql,
  indexColumns,
  QUESTDB_SELF_CONTEXT,
  type QuestDBClient,
  quotedPathList,
} from '../core/questdb.js';
import { buildTriggers } from '../core/triggers.js';
import {
  type AnalyzerTriggerCfg,
  FORECAST_DEFAULT_SEVERITY_FLOOR,
  type NotificationState,
  type SeverityFloor,
} from '../types.js';
import type { AnalysisInput, Analyzer, AnalyzerDeps, TriggerCtx, TriggerSpec } from './Analyzer.js';
import { ANALYZER_TITLES } from './ids.js';

// Hourly-mean trend buckets span the last 12h of the rolling buffer.
const TREND_WINDOW_HOURS = 12;
// Cold-start floor: with less buffered history than this and no QuestDB
// baseline, collectContext returns null rather than asking the LLM to guess
// from a near-empty table. Mirrors how the drift analyzer returns null with
// no data.
const COLD_START_MIN_HISTORY_MS = HOUR_MS;
// QuestDB baseline window: 24h to 72h before the trigger, so the LLM can tell
// a passing squall from a settling multi-day pattern. A strict enhancement,
// never required.
const BASELINE_FROM_HOURS = 72;
const BASELINE_TO_HOURS = 24;
// Barometric tendency is reported over the classic 3-hour interval.
const TENDENCY_HOURS = 3;
const PA_PER_HPA = 100;

// Wind direction is a circular quantity (radians true): its hourly buckets
// need a circular mean, not an arithmetic one that breaks across the 0/2pi wrap.
const WIND_DIRECTION_PATH = 'environment.wind.directionTrue';

// Four-level severity scale, ordered weakest to strongest so the array index
// doubles as the rank used for the severity-floor comparison.
const SEVERITY_GRADES = ['none', 'minor', 'moderate', 'severe'] as const;
type SeverityGrade = (typeof SEVERITY_GRADES)[number];

// Maps an LLM grade to the Signal K notification state used when the grade
// meets or exceeds the configured floor. Below the floor the state is forced
// to 'nominal' (see resolveForecastState).
const GRADE_STATE: Record<SeverityGrade, NotificationState> = {
  none: 'nominal',
  minor: 'alert',
  moderate: 'warn',
  severe: 'alarm',
};

type PathFamily = 'canonical' | 'extension';

interface WeatherPathMeta {
  family: PathFamily;
  label: string;
  unit: string;
}

// Per-path family/label/unit metadata. Units are Signal K SI base units, named
// in the prompt so the LLM does not misread Pa as hPa or radians as degrees.
const WEATHER_PATH_META: Record<string, WeatherPathMeta> = {
  'environment.outside.pressure': { family: 'canonical', label: 'barometric pressure', unit: 'Pa' },
  'environment.outside.temperature': {
    family: 'canonical',
    label: 'air temperature',
    unit: 'K',
  },
  'environment.outside.dewPointTemperature': {
    family: 'canonical',
    label: 'dew point',
    unit: 'K',
  },
  'environment.outside.relativeHumidity': {
    family: 'canonical',
    label: 'relative humidity',
    unit: 'ratio 0-1',
  },
  'environment.wind.speedOverGround': {
    family: 'canonical',
    label: 'wind speed',
    unit: 'm/s',
  },
  'environment.wind.directionTrue': {
    family: 'canonical',
    label: 'wind direction (true)',
    unit: 'rad',
  },
  'environment.weather.speedGust': { family: 'extension', label: 'wind gust', unit: 'm/s' },
  'environment.weather.cloudCover': {
    family: 'extension',
    label: 'cloud cover',
    unit: 'ratio 0-1',
  },
  'environment.weather.cloudCeiling': {
    family: 'extension',
    label: 'cloud ceiling',
    unit: 'm',
  },
  'environment.weather.visibility': { family: 'extension', label: 'visibility', unit: 'm' },
  'environment.weather.precipitationLastHour': {
    family: 'extension',
    label: 'precipitation (last hour)',
    unit: 'm',
  },
  'environment.weather.temperatureDeparture24h': {
    family: 'extension',
    label: '24h temperature departure',
    unit: 'K',
  },
};

const ALL_WEATHER_PATHS: ReadonlyArray<string> = [
  ...WEATHER_CANONICAL_PATHS,
  ...WEATHER_EXTENSION_PATHS,
];

export interface ForecastCfg {
  triggers: AnalyzerTriggerCfg;
  severityFloor: SeverityFloor;
  customSystemPrompt?: string;
}

// Static: window lengths and the severity scale are described here so a
// customSystemPrompt override never loses the SEVERITY-line contract that
// publishOutput depends on (a missing line just falls back to grade 'none').
export const FORECAST_DEFAULT_SYSTEM_PROMPT = [
  'You are an experienced marine weather forecaster producing a short-term outlook for a vessel from observed environmental trends.',
  'You have no forecast feed: extrapolate the outlook from how conditions are changing, anchored by the latest observed snapshot, which is a wider-area reading than any single onboard sensor.',
  'Units are Signal K SI base units: pressure in Pa (divide by 100 for hPa), temperature and dew point in K, wind speed in m/s, wind direction in radians true, humidity and cloud cover as 0-1 ratios, visibility and cloud ceiling in m.',
  'Weigh the classic leading indicators: barometric tendency (the rate and sign of the pressure change; a fall of 3 hPa or more in 3 hours signals a deepening system), wind veering (a clockwise shift) versus backing (a counter-clockwise shift), and air temperature converging on the dew point (fog or precipitation risk).',
  'When the extension paths are present, also weigh a lowering cloud ceiling, collapsing visibility, a widening gust spread, and precipitation onset: these are strong short-term indicators.',
  'If only the canonical paths are present, still produce an outlook from pressure tendency, wind shift, and temperature/dew point convergence.',
  'Grade the outlook on a four-level severity scale: severe (dangerous weather developing, act now), moderate (a notable deterioration is likely), minor (a slight deterioration is possible), none (settled or improving).',
  'Output exactly three parts. The first line must be exactly "SEVERITY: severe", "SEVERITY: moderate", "SEVERITY: minor", or "SEVERITY: none", with nothing else on that line.',
  'The second line is a headline of at most 80 characters: plain, conversational language a person reads at a glance like a phone notification, stating only the single most important takeaway about the outlook, with no statistics and no jargon.',
  'After the headline, leave an empty line, then write the outlook as one plain-prose paragraph of 80 to 150 words. Do not use markdown: no headers, no bullets, no horizontal rules. Use commas and semicolons to separate points. Lead with the expected change (or "conditions settled"), then the supporting trend, then the practical implication for the vessel.',
].join(' ');

interface PathTrend {
  path: string;
  family: PathFamily;
  label: string;
  unit: string;
  source: string | null;
  current: number | null;
  // Hourly means over the trend window, oldest bucket first. null where a
  // bucket holds no numeric sample.
  buckets: Array<number | null>;
  // 24-72h QuestDB mean, or null when QuestDB is absent or has no rows.
  baselineMean: number | null;
}

export interface ForecastInput extends AnalysisInput {
  generatedAt: string;
  trendWindowHours: number;
  tendencyHours: number;
  // Pre-computed 3h pressure change in hPa, so the LLM does not derive it.
  pressureTendencyHpa: number | null;
  hasQuestdbBaseline: boolean;
  trends: PathTrend[];
}

export class ForecastAnalyzer implements Analyzer<ForecastInput> {
  readonly id = 'forecast';
  readonly title = ANALYZER_TITLES.forecast;
  readonly triggers: ReadonlyArray<TriggerSpec>;
  // Weather leaves are fixed canonical strings (no per-instance discovery), so
  // the lifecycle subscribes them directly from this declaration. They feed the
  // rolling buffer unconditionally so a weather producer that starts after the
  // plugin is still captured; collectContext degrades gracefully on paths that
  // never produce data.
  readonly watchedPaths: ReadonlyArray<string> = ALL_WEATHER_PATHS;
  private readonly systemPrompt: string;
  private readonly severityFloor: SeverityFloor;

  constructor(cfg: ForecastCfg) {
    this.triggers = buildTriggers(this.id, cfg.triggers);
    this.severityFloor = normalizeFloor(cfg.severityFloor);
    this.systemPrompt = resolveSystemPrompt(cfg.customSystemPrompt, FORECAST_DEFAULT_SYSTEM_PROMPT);
  }

  async collectContext(ctx: TriggerCtx, deps: AnalyzerDeps): Promise<ForecastInput | null> {
    const { buffer, questdb } = deps;
    const firedMs = ctx.firedAt.getTime();
    const windowStart = firedMs - TREND_WINDOW_HOURS * HOUR_MS;

    const bufferPaths = new Set(buffer.pathKeys());

    // QuestDB baseline is a strict enhancement: query it first so the cold-
    // start guard can let a thin buffer through when a baseline is available.
    // A query fault must not fail the analyzer (it runs buffer-only without
    // QuestDB), but it is logged so a broken baseline is not invisible.
    let baseline = new Map<string, number>();
    if (questdb) {
      try {
        baseline = await queryBaseline(questdb, QUESTDB_SELF_CONTEXT, firedMs);
      } catch (err) {
        deps.logger.debug(`forecast: QuestDB baseline query failed: ${String(err)}`);
      }
    }
    const hasQuestdbBaseline = baseline.size > 0;

    const pathsToReport = ALL_WEATHER_PATHS.filter((p) => bufferPaths.has(p) || baseline.has(p));
    if (pathsToReport.length === 0) return null;

    // Slice each reported path's trend window once, reused for the cold-start
    // gate and the trend rows. Buffer entries are in arrival order, not
    // timestamp order (one path interleaves multiple sources), so scan every
    // entry for the oldest ts. Reading oldestTs from the window (not full
    // history) is sound only because COLD_START_MIN_HISTORY_MS is shorter than
    // the trend window: a sample old enough to pass the gate is always inside.
    const windowEntries = new Map<string, BufferEntry[]>();
    let oldestTs: number | null = null;
    for (const path of pathsToReport) {
      if (!bufferPaths.has(path)) continue;
      const entries = buffer.slice(path, windowStart, firedMs);
      windowEntries.set(path, entries);
      for (const e of entries) {
        if (oldestTs == null || e.ts < oldestTs) oldestTs = e.ts;
      }
    }
    const historyMs = oldestTs == null ? 0 : firedMs - oldestTs;
    if (historyMs < COLD_START_MIN_HISTORY_MS && !hasQuestdbBaseline) return null;

    const trends: PathTrend[] = pathsToReport.map((path) => {
      const meta = WEATHER_PATH_META[path];
      const entries = windowEntries.get(path) ?? [];
      const latest = latestEntry(entries);
      return {
        path,
        family: meta?.family ?? 'canonical',
        label: meta?.label ?? path,
        unit: meta?.unit ?? '',
        source: latest?.source ?? null,
        current: latest ? asFiniteNumber(latest.value) : null,
        buckets: bucketMeans(entries, windowStart, path === WIND_DIRECTION_PATH),
        baselineMean: baseline.get(path) ?? null,
      };
    });

    return {
      generatedAt: new Date(firedMs).toISOString(),
      trendWindowHours: TREND_WINDOW_HOURS,
      tendencyHours: TENDENCY_HOURS,
      pressureTendencyHpa: pressureTendency(trends),
      hasQuestdbBaseline,
      trends,
    };
  }

  buildPrompt(input: ForecastInput): { system: string; user: string } {
    const lines: string[] = [];
    lines.push(`## Generated ${input.generatedAt}`);
    lines.push(
      `Trend window: last ${input.trendWindowHours}h of observations, shown as hourly means oldest to newest.`,
    );
    lines.push(
      input.pressureTendencyHpa == null
        ? 'Barometric tendency: not determinable from the retained history.'
        : `Barometric tendency: ${fmtSigned(input.pressureTendencyHpa)} hPa over the last ${input.tendencyHours}h.`,
    );
    lines.push(
      input.hasQuestdbBaseline
        ? 'A 24-72h QuestDB baseline mean is shown per path for context.'
        : 'No QuestDB baseline available; this outlook is based on the rolling buffer only.',
    );
    lines.push('');

    const canonical = input.trends.filter((t) => t.family === 'canonical');
    const extension = input.trends.filter((t) => t.family === 'extension');
    lines.push('### Canonical paths (standard sensors or weather plugin)');
    appendTrendLines(lines, canonical);
    lines.push('');
    lines.push('### Extension paths (signalk-virtual-weather-sensors)');
    if (extension.length === 0) {
      lines.push('None present; the outlook runs on canonical data only.');
    } else {
      appendTrendLines(lines, extension);
    }

    return { system: this.systemPrompt, user: lines.join('\n') };
  }

  async publishOutput(text: string, ctx: TriggerCtx, deps: AnalyzerDeps): Promise<void> {
    const { grade, body, severityLineParsed } = parseForecast(text);
    if (!severityLineParsed) {
      deps.logger.debug(
        'forecast: LLM reply had no valid SEVERITY line; outlook graded none (no alarm)',
      );
    }
    const state = resolveForecastState(grade, this.severityFloor);
    await deps.publisher.publishOnPath(
      body.length > 0 ? body : text.trim(),
      { analyzerId: this.id, ctx },
      { path: notificationReportPath(this.id), state },
    );
  }
}

function normalizeFloor(v: unknown): SeverityFloor {
  return v === 'severe' || v === 'moderate' || v === 'minor' ? v : FORECAST_DEFAULT_SEVERITY_FLOOR;
}

// Slice the buffer entries into TREND_WINDOW_HOURS hourly-mean buckets, oldest
// bucket first. Out-of-range timestamps are clamped to the edge buckets. When
// `circular` is set the values are angles in radians (wind direction): the
// bucket mean is then the circular mean (atan2 of summed sin/cos) so a trend
// across the 0/2pi wrap is not averaged into a meaningless mid-value.
function bucketMeans(
  entries: ReadonlyArray<{ value: unknown; ts: number }>,
  windowStart: number,
  circular = false,
): Array<number | null> {
  const sumX = new Array<number>(TREND_WINDOW_HOURS).fill(0);
  // sumY is only used by the circular path (wind direction); allocate it
  // lazily so a non-circular trend (the other 10 weather paths) skips the
  // 12-slot allocation per call.
  const sumY = circular ? new Array<number>(TREND_WINDOW_HOURS).fill(0) : null;
  const counts = new Array<number>(TREND_WINDOW_HOURS).fill(0);
  for (const e of entries) {
    const value = asFiniteNumber(e.value);
    if (value == null) continue;
    let idx = Math.floor((e.ts - windowStart) / HOUR_MS);
    if (idx < 0) idx = 0;
    if (idx >= TREND_WINDOW_HOURS) idx = TREND_WINDOW_HOURS - 1;
    sumX[idx] = (sumX[idx] ?? 0) + (circular ? Math.cos(value) : value);
    if (sumY) sumY[idx] = (sumY[idx] ?? 0) + Math.sin(value);
    counts[idx] = (counts[idx] ?? 0) + 1;
  }
  return sumX.map((x, i) => {
    const n = counts[i] ?? 0;
    if (n === 0) return null;
    if (!circular || !sumY) return x / n;
    const mx = x / n;
    const my = (sumY[i] ?? 0) / n;
    // Drop the bucket if the resultant magnitude is near zero: samples that
    // cancel around the unit circle have no coherent direction, and atan2
    // would return 0 (north) which the prompt would read as a real heading.
    if (Math.hypot(mx, my) < 0.1) return null;
    const angle = Math.atan2(my, mx);
    return angle < 0 ? angle + 2 * Math.PI : angle;
  });
}

// The newest entry by timestamp whose value is a finite number. Buffer entries
// are in arrival order, not timestamp order, so this scans every entry rather
// than trusting array position.
function latestEntry(entries: ReadonlyArray<BufferEntry>): BufferEntry | null {
  let best: BufferEntry | null = null;
  for (const e of entries) {
    if (asFiniteNumber(e.value) == null) continue;
    if (best == null || e.ts > best.ts) best = e;
  }
  return best;
}

// Pre-compute the 3-hour barometric tendency in hPa from the pressure path's
// hourly buckets: the most recent bucket minus the bucket TENDENCY_HOURS
// earlier. null when either bucket is empty.
function pressureTendency(trends: ReadonlyArray<PathTrend>): number | null {
  const pressure = trends.find((t) => t.path === WEATHER_PRESSURE_PATH);
  if (!pressure) return null;
  const { buckets } = pressure;
  let latestIdx = -1;
  for (let i = buckets.length - 1; i >= 0; i -= 1) {
    if (buckets[i] != null) {
      latestIdx = i;
      break;
    }
  }
  if (latestIdx < 0) return null;
  // The prompt labels the tendency as "the last 3h". If the most recent
  // populated bucket is not the current bucket, the pressure data is stale and
  // an old tendency would be presented as current. Report null instead.
  if (latestIdx !== TREND_WINDOW_HOURS - 1) return null;
  const priorIdx = latestIdx - TENDENCY_HOURS;
  if (priorIdx < 0) return null;
  const latest = buckets[latestIdx];
  const prior = buckets[priorIdx];
  if (latest == null || prior == null) return null;
  return (latest - prior) / PA_PER_HPA;
}

function appendTrendLines(lines: string[], trends: ReadonlyArray<PathTrend>): void {
  if (trends.length === 0) {
    lines.push('None present.');
    return;
  }
  for (const t of trends) {
    const hourly = t.buckets.map((b) => (b == null ? '-' : fmtNumber(b))).join(', ');
    const parts = [
      `now=${fmtNumber(t.current)}`,
      `source=${t.source ?? 'n/a'}`,
      `hourly=[${hourly}]`,
    ];
    if (t.baselineMean != null) parts.push(`baseline=${fmtNumber(t.baselineMean)}`);
    lines.push(`- ${t.label} (${t.path}) [${t.unit}]: ${parts.join('; ')}`);
  }
}

// One QuestDB query that returns the per-path mean over the 24-72h baseline
// window. Throws on a query fault; the caller logs it and runs buffer-only,
// since the baseline is a strict enhancement.
async function queryBaseline(
  questdb: QuestDBClient,
  context: string,
  firedMs: number,
): Promise<Map<string, number>> {
  const escapedCtx = escapeSqlLiteral(context);
  const fromIso = new Date(firedMs - BASELINE_FROM_HOURS * HOUR_MS).toISOString();
  const toIso = new Date(firedMs - BASELINE_TO_HOURS * HOUR_MS).toISOString();
  const pathList = quotedPathList(ALL_WEATHER_PATHS);
  const sql = flattenSql(`
    SELECT path, avg(value) AS mean_value FROM signalk
    WHERE path IN (${pathList})
      AND context = '${escapedCtx}'
      AND ts >= '${fromIso}'
      AND ts < '${toIso}'
    GROUP BY path
  `);

  const out = new Map<string, number>();
  const res = await questdb.query(sql);
  const cols = indexColumns(res);
  const pathIdx = cols.get('path') ?? -1;
  const meanIdx = cols.get('mean_value') ?? -1;
  if (pathIdx < 0 || meanIdx < 0) return out;
  for (const row of res.dataset) {
    const path = row[pathIdx];
    const mean = asFiniteNumber(row[meanIdx]);
    if (typeof path === 'string' && mean != null) {
      out.set(path, mean);
    }
  }
  return out;
}

interface ParsedForecast {
  grade: SeverityGrade;
  body: string;
  // False when the reply had no valid SEVERITY line and grade fell back to
  // 'none'. A custom prompt that drops the SEVERITY contract would otherwise
  // silently downgrade every outlook to nominal.
  severityLineParsed: boolean;
}

const SEVERITY_LINE_RE = /^\s*SEVERITY:\s*(severe|moderate|minor|none)\s*$/i;
const SEVERITY_PREFIX_RE = /^\s*SEVERITY:/i;

// Parse the LLM output: line 1 is the SEVERITY control line (consumed), the
// rest is the report (a headline line followed by the outlook). A malformed
// or missing SEVERITY line grades 'none' (the safe default: publish the
// outlook, raise no alarm) and the whole reply is kept as the body. The
// publisher's headlineOf then takes the report's first line for the alert.
export function parseForecast(text: string): ParsedForecast {
  const nl = text.indexOf('\n');
  const firstLine = (nl < 0 ? text : text.slice(0, nl)).trim();
  const rest = nl < 0 ? '' : text.slice(nl + 1).trim();
  const severityMatch = firstLine.match(SEVERITY_LINE_RE);
  if (severityMatch?.[1]) {
    return {
      grade: severityMatch[1].toLowerCase() as SeverityGrade,
      body: rest,
      severityLineParsed: true,
    };
  }
  if (SEVERITY_PREFIX_RE.test(firstLine)) {
    return { grade: 'none', body: rest, severityLineParsed: false };
  }
  return { grade: 'none', body: text.trim(), severityLineParsed: false };
}

// Map an LLM grade plus the configured floor to a Signal K notification state.
// The outlook always publishes; below the floor (or grade 'none') the state is
// 'nominal' (informational, no action) so it stays readable in the data
// browser without raising an alarm.
export function resolveForecastState(
  grade: SeverityGrade,
  floor: SeverityFloor,
): NotificationState {
  const gradeRank = SEVERITY_GRADES.indexOf(grade);
  const floorRank = SEVERITY_GRADES.indexOf(floor);
  const raised = gradeRank > 0 && gradeRank >= floorRank;
  return raised ? GRADE_STATE[grade] : 'nominal';
}
