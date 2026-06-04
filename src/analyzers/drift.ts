import {
  clampPositiveInt,
  REPORT_BODY_INSTRUCTION,
  REPORT_HEADLINE_INSTRUCTION,
  resolveSystemPrompt,
} from '../core/cfg.js';
import { discoverEngineIds } from '../core/discovery.js';
import { asFiniteNumber, DAY_MS, fmtNumber, fmtPct } from '../core/format.js';
import { enginePaths, SOG_PATH } from '../core/paths.js';
import {
  escapeSqlLiteral,
  flattenSql,
  indexColumns,
  QUESTDB_SELF_CONTEXT,
} from '../core/questdb.js';
import { buildTriggers } from '../core/triggers.js';
import { type AnalyzerTriggerCfg, DRIFT_DEFAULT_BASELINE_DAYS } from '../types.js';
import type { AnalysisInput, Analyzer, AnalyzerDeps, TriggerCtx, TriggerSpec } from './Analyzer.js';
import { ANALYZER_TITLES } from './ids.js';

const PAST_WEEK_DAYS = 7;
// A bin must have at least this many RPM samples in both windows before its
// delta is meaningful. Reported as null otherwise.
const MIN_BIN_SAMPLES = 30;
// Below this (in Hz, i.e. rev/s) we treat the engine as off or still cranking
// and exclude the sample from any bin. An independent floor between the
// detector's default stop (1.0 Hz) and start (8.0 Hz) thresholds, roughly
// 300 RPM.
const RPM_RUNNING_THRESHOLD_HZ = 5.0;
// Maximum lag (in microseconds) between an RPM sample and the ASOF-joined
// fuel.rate or SOG sample for that joined value to count toward the per-bin
// mean. QuestDB stores TIMESTAMP as microseconds since epoch and arithmetic
// on two TIMESTAMP columns returns microseconds. 5 seconds = 5_000_000 us.
const RPM_JOIN_WINDOW_US = 5_000_000;

export interface DriftCfg {
  triggers: AnalyzerTriggerCfg;
  baselineDays: number;
  customSystemPrompt?: string;
}

// Static: window lengths come through the user prompt's data block, not the
// system prompt, so customSystemPrompt overrides do not lose any numbers.
export const DRIFT_DEFAULT_SYSTEM_PROMPT = [
  'You are an experienced marine engine specialist comparing recent engine performance to its longer-term baseline.',
  'Units: propulsion.*.revolutions is in Hz (rev/s, the documented Signal K unit for this path: do not convert to rad/s). fuel.rate is in m^3/s. navigation.speedOverGround is in m/s.',
  'The user content gives mean fuel rate and mean speed-over-ground per RPM band for the past week vs the trailing baseline, with percent delta per metric. Band edges are in Hz; 1 Hz = 60 RPM. The exact window lengths in days appear in the data section.',
  'A positive fuel-rate delta means burning more fuel per second in that band than baseline. A negative SOG delta means going slower in that band than baseline.',
  "Do not restate per-session details. That is the maintenance analyzer's job. Focus only on this-week vs baseline drift.",
  'Identify (1) which band moved most, (2) what the drift suggests: fouled prop, dirty hull, fuel quality, alternator load creep, fuel filter clogging, air filter or intercooler fouling, engine trim, weight changes from fuel/water/gear stowage, or sustained sea state and current effects, or a transducer or sensor issue, (3) whether the magnitude warrants action this season or just monitoring.',
  'If a bin has too few samples, say so rather than guess. If the cause is not determinable from the fields shown, say "cause not determinable from telemetry".',
  REPORT_HEADLINE_INSTRUCTION,
  REPORT_BODY_INSTRUCTION,
  'Name the engine, the RPM band that drifted most, the magnitude of the change, and a short interpretation of the likely cause.',
].join(' ');

type BinKey = 'idle' | 'lowCruise' | 'highCruise' | 'topEnd' | 'wot';

interface BinDef {
  label: string;
  min: number;
  max: number;
}

const BIN_ORDER: ReadonlyArray<BinKey> = ['idle', 'lowCruise', 'highCruise', 'topEnd', 'wot'];

// Hz bin edges. propulsion.*.revolutions is documented in SK v1.8.2 as Hz
// (rev/s), and the N2K bridge passes the wire value through unchanged.
// Approximate RPM ranges per bin (1 Hz = 60 RPM):
//   idle:        ~300-900 RPM   (diesel idle, outboard troll)
//   low cruise:  ~900-1800 RPM  (diesel cruise low)
//   high cruise: ~1800-3000 RPM (diesel cruise high)
//   top end:     ~3000-4500 RPM (diesel WOT, outboard cruise)
//   wot:         ~4500+ RPM     (outboard WOT; always empty for diesels)
const BIN_DEFS: Record<BinKey, BinDef> = {
  idle: { label: 'idle', min: RPM_RUNNING_THRESHOLD_HZ, max: 15.0 },
  lowCruise: { label: 'low cruise', min: 15.0, max: 30.0 },
  highCruise: { label: 'high cruise', min: 30.0, max: 50.0 },
  topEnd: { label: 'top end', min: 50.0, max: 75.0 },
  wot: { label: 'wot', min: 75.0, max: Number.POSITIVE_INFINITY },
};

// QuestDB CASE expression mapping an RPM (Hz) value to its bin key, derived
// from BIN_DEFS so the server-side binning cannot drift from the bin edges.
const BIN_CASE_SQL = ((): string => {
  const whens: string[] = [];
  let elseBin: BinKey = 'wot';
  for (const k of BIN_ORDER) {
    const { max } = BIN_DEFS[k];
    if (Number.isFinite(max)) whens.push(`WHEN r.value < ${max} THEN '${k}'`);
    else elseBin = k;
  }
  return `CASE ${whens.join(' ')} ELSE '${elseBin}' END`;
})();

export interface BinStats {
  // Count of RPM samples in this bin that had a fresh fuel.rate / SOG pair
  // within RPM_JOIN_WINDOW_US. Tracked per metric: fuel.rate and SOG join
  // independently, so one can be well-covered while the other is sparse.
  fuelCount: number;
  sogCount: number;
  meanFuelRate: number | null;
  meanSog: number | null;
}

export interface BinDelta {
  fuelRateDeltaPct: number | null;
  sogDeltaPct: number | null;
}

export interface EngineDrift {
  engineId: string;
  thisWeek: Record<BinKey, BinStats>;
  baseline: Record<BinKey, BinStats>;
  deltas: Record<BinKey, BinDelta>;
}

export interface DriftInput extends AnalysisInput {
  generatedAt: string;
  windowDays: { thisWeek: number; baseline: number };
  engines: EngineDrift[];
}

export class DriftAnalyzer implements Analyzer<DriftInput> {
  readonly id = 'drift';
  readonly title = ANALYZER_TITLES.drift;
  readonly triggers: ReadonlyArray<TriggerSpec>;
  private readonly baselineDays: number;
  private readonly systemPrompt: string;

  constructor(cfg: DriftCfg) {
    this.triggers = buildTriggers(this.id, cfg.triggers);
    // Bounds mirror the schema (baselineDays minimum 14, maximum 365) so a
    // value from a hand-edited JSON config is clamped at runtime too.
    this.baselineDays = clampPositiveInt(cfg.baselineDays, DRIFT_DEFAULT_BASELINE_DAYS, {
      min: 14,
      max: 365,
    });
    this.systemPrompt = resolveSystemPrompt(cfg.customSystemPrompt, DRIFT_DEFAULT_SYSTEM_PROMPT);
  }

  async collectContext(ctx: TriggerCtx, deps: AnalyzerDeps): Promise<DriftInput | null> {
    const { questdb } = deps;
    if (!questdb) return null;
    const engineIds = discoverEngineIds(Array.from(deps.buffer.pathKeys()));
    if (engineIds.length === 0) return null;

    const context = QUESTDB_SELF_CONTEXT;
    const firedMs = ctx.firedAt.getTime();
    const weekStart = firedMs - PAST_WEEK_DAYS * DAY_MS;
    const weekEnd = firedMs;
    const baselineEnd = weekStart;
    const baselineStart = baselineEnd - this.baselineDays * DAY_MS;

    const engines = (
      await Promise.all(
        engineIds.map(async (engineId): Promise<EngineDrift | null> => {
          const [thisWeek, baseline] = await Promise.all([
            binEngineWindow(questdb, context, engineId, weekStart, weekEnd),
            binEngineWindow(questdb, context, engineId, baselineStart, baselineEnd),
          ]);
          if (!thisWeek || totalBinCount(thisWeek) === 0) return null;
          if (!baseline || totalBinCount(baseline) === 0) return null;
          return {
            engineId,
            thisWeek,
            baseline,
            deltas: computeDeltas(thisWeek, baseline),
          };
        }),
      )
    ).filter((e): e is EngineDrift => e !== null);
    if (engines.length === 0) return null;

    return {
      generatedAt: new Date(firedMs).toISOString(),
      windowDays: { thisWeek: PAST_WEEK_DAYS, baseline: this.baselineDays },
      engines,
    };
  }

  buildPrompt(input: DriftInput): { system: string; user: string } {
    const lines: string[] = [];
    lines.push(`## Generated ${input.generatedAt}`);
    lines.push(
      `Windows: past ${input.windowDays.thisWeek}d vs trailing ${input.windowDays.baseline}d baseline (baseline ends where the week begins, no overlap)`,
    );
    lines.push('');
    for (const eng of input.engines) {
      lines.push(`### Engine ${eng.engineId}`);
      lines.push(
        '| Band | Wk n (fuel/sog) | Base n (fuel/sog) | Fuel.rate wk (m^3/s) | Fuel.rate base | Δ% | SOG wk (m/s) | SOG base | Δ% |',
      );
      lines.push('|---|---|---|---|---|---|---|---|---|');
      for (const bin of BIN_ORDER) {
        const def = BIN_DEFS[bin];
        const w = eng.thisWeek[bin];
        const b = eng.baseline[bin];
        const d = eng.deltas[bin];
        const range = `${def.label} [${def.min}, ${def.max === Number.POSITIVE_INFINITY ? '∞' : def.max}) Hz`;
        lines.push(
          `| ${range} | ${w.fuelCount}/${w.sogCount} | ${b.fuelCount}/${b.sogCount} | ${fmtFuelRate(w.meanFuelRate)} | ${fmtFuelRate(b.meanFuelRate)} | ${fmtPct(d.fuelRateDeltaPct)} | ${fmtNumber(w.meanSog, { digits: 5 })} | ${fmtNumber(b.meanSog, { digits: 5 })} | ${fmtPct(d.sogDeltaPct)} |`,
        );
      }
      lines.push('');
    }
    return { system: this.systemPrompt, user: lines.join('\n') };
  }
}

// Issues one QuestDB query per (engine, window) that does the per-RPM-band
// aggregation server-side. ASOF JOIN pairs each RPM sample with the most
// recent preceding fuel.rate and SOG sample. ASOF JOIN has no time bound, so
// it will pair an RPM sample with a fuel/SOG reading from hours earlier across
// an engine-off gap. The BETWEEN 0 AND RPM_JOIN_WINDOW_US guard in the CASE
// expressions drops those stale pairs from both the mean AND the sample count,
// so n_fuel / n_sog reflect only RPM samples that had a fresh pair, not every
// RPM row. The lower bound of 0 also rejects inverted pairs from N2K clock
// skew, where the joined sample carries a timestamp after the RPM sample.
// fuel.rate and SOG are joined independently, so each carries its own count:
// a bin with dense fuel coverage but sparse SOG must not pass the SOG gate on
// fuel-sample density.
async function binEngineWindow(
  questdb: NonNullable<AnalyzerDeps['questdb']>,
  context: string,
  engineId: string,
  fromMs: number,
  toMs: number,
): Promise<Record<BinKey, BinStats> | null> {
  const escapedCtx = escapeSqlLiteral(context);
  const { rpm, fuelRate } = enginePaths(engineId);
  const rpmPath = escapeSqlLiteral(rpm);
  const fuelPath = escapeSqlLiteral(fuelRate);
  // Escaped to match the sibling rpm and fuel paths; a no-op on this constant.
  const sogPath = escapeSqlLiteral(SOG_PATH);
  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(toMs).toISOString();
  const sql = flattenSql(`
    WITH r AS (
      SELECT ts, value FROM signalk
      WHERE path = '${rpmPath}'
        AND context = '${escapedCtx}'
        AND ts >= '${fromIso}'
        AND ts < '${toIso}'
        AND value >= ${RPM_RUNNING_THRESHOLD_HZ}
    ),
    f AS (
      SELECT ts, value FROM signalk
      WHERE path = '${fuelPath}'
        AND context = '${escapedCtx}'
        AND ts >= '${fromIso}'
        AND ts < '${toIso}'
    ),
    s AS (
      SELECT ts, value FROM signalk
      WHERE path = '${sogPath}'
        AND context = '${escapedCtx}'
        AND ts >= '${fromIso}'
        AND ts < '${toIso}'
    )
    SELECT
      ${BIN_CASE_SQL} AS bin,
      count(CASE WHEN r.ts - f.ts BETWEEN 0 AND ${RPM_JOIN_WINDOW_US} THEN 1 END) AS n_fuel,
      count(CASE WHEN r.ts - s.ts BETWEEN 0 AND ${RPM_JOIN_WINDOW_US} THEN 1 END) AS n_sog,
      avg(CASE WHEN r.ts - f.ts BETWEEN 0 AND ${RPM_JOIN_WINDOW_US} THEN f.value END) AS mean_fuel,
      avg(CASE WHEN r.ts - s.ts BETWEEN 0 AND ${RPM_JOIN_WINDOW_US} THEN s.value END) AS mean_sog
    FROM r ASOF JOIN f ASOF JOIN s
    GROUP BY bin
  `);

  // A query fault propagates: drift requires QuestDB, so a fault is a real
  // analyzer failure and must surface as a failure report, not a silent skip.
  const res = await questdb.query(sql);
  const cols = indexColumns(res);
  const binIdx = cols.get('bin') ?? -1;
  const nFuelIdx = cols.get('n_fuel') ?? -1;
  const nSogIdx = cols.get('n_sog') ?? -1;
  const fuelIdx = cols.get('mean_fuel') ?? -1;
  const sogIdx = cols.get('mean_sog') ?? -1;
  if (binIdx < 0 || nFuelIdx < 0 || nSogIdx < 0 || fuelIdx < 0 || sogIdx < 0) return null;
  if (res.dataset.length === 0) return null;
  const out = emptyBins();
  for (const row of res.dataset) {
    const binRaw = row[binIdx];
    if (typeof binRaw !== 'string' || !isBinKey(binRaw)) continue;
    out[binRaw] = {
      fuelCount: asFiniteNumber(row[nFuelIdx]) ?? 0,
      sogCount: asFiniteNumber(row[nSogIdx]) ?? 0,
      meanFuelRate: asFiniteNumber(row[fuelIdx]),
      meanSog: asFiniteNumber(row[sogIdx]),
    };
  }
  return out;
}

// fuel.rate in m^3/s is order 1e-6 for a marine diesel, which a fixed-decimal
// format collapses to "0.00000". Exponential keeps the absolute value legible.
function fmtFuelRate(v: number | null): string {
  return v == null || !Number.isFinite(v) ? 'n/a' : v.toExponential(3);
}

function isBinKey(k: string): k is BinKey {
  return k in BIN_DEFS;
}

function emptyBins(): Record<BinKey, BinStats> {
  return Object.fromEntries(
    BIN_ORDER.map((k) => [k, { fuelCount: 0, sogCount: 0, meanFuelRate: null, meanSog: null }]),
  ) as Record<BinKey, BinStats>;
}

function computeDeltas(
  week: Record<BinKey, BinStats>,
  base: Record<BinKey, BinStats>,
): Record<BinKey, BinDelta> {
  return Object.fromEntries(BIN_ORDER.map((k) => [k, deltaForBin(week[k], base[k])])) as Record<
    BinKey,
    BinDelta
  >;
}

function deltaForBin(w: BinStats, b: BinStats): BinDelta {
  // Gate each metric on its own fresh-pair count: a SOG delta must not pass
  // on fuel-sample density and vice versa.
  const fuelOk = w.fuelCount >= MIN_BIN_SAMPLES && b.fuelCount >= MIN_BIN_SAMPLES;
  const sogOk = w.sogCount >= MIN_BIN_SAMPLES && b.sogCount >= MIN_BIN_SAMPLES;
  return {
    fuelRateDeltaPct: fuelOk ? pctDelta(w.meanFuelRate, b.meanFuelRate) : null,
    sogDeltaPct: sogOk ? pctDelta(w.meanSog, b.meanSog) : null,
  };
}

function pctDelta(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  if (b === 0) return null;
  return ((a - b) / b) * 100;
}

function totalBinCount(bins: Record<BinKey, BinStats>): number {
  let n = 0;
  for (const k of BIN_ORDER) n += bins[k].fuelCount + bins[k].sogCount;
  return n;
}
