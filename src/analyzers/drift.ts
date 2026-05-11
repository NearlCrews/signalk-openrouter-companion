import type { AnalyzerTriggerCfg } from '../types.js';
import type { AnalysisInput, Analyzer, AnalyzerDeps, TriggerCtx, TriggerSpec } from './Analyzer.js';

const DAY_MS = 86_400_000;
const PAST_WEEK_DAYS = 7;
const BASELINE_DAYS = 30;
// A bin must have at least this many RPM samples in both windows before its
// delta is meaningful. Reported as null otherwise.
const MIN_BIN_SAMPLES = 30;
// Below this (in Hz, i.e. rev/s) we treat the engine as off or still cranking
// and exclude the sample from any bin. Matches the running-detect floor used
// by the engine detector and is roughly 300 RPM.
const RPM_RUNNING_THRESHOLD_HZ = 5.0;
// Window (in ms) used to pair a non-RPM sample to its most recent preceding RPM
// observation. Beyond this gap, the non-RPM sample is dropped from binning.
const RPM_JOIN_WINDOW_MS = 5_000;
// Defensive cap so a chatty source can't blow up memory in collectContext.
const QUERY_ROW_LIMIT = 50_000;

export interface DriftCfg {
  triggers: AnalyzerTriggerCfg;
}

type BinKey = 'idle' | 'lowCruise' | 'highCruise' | 'topEnd';

interface BinDef {
  label: string;
  min: number;
  max: number;
}

const BIN_ORDER: ReadonlyArray<BinKey> = ['idle', 'lowCruise', 'highCruise', 'topEnd'];

// Hz bin edges sized for a typical marine diesel or gas engine. propulsion.*.revolutions
// is documented in SK v1.8.2 as Hz (rev/s), and the N2K bridge passes the wire value
// through unchanged. Approximate RPM ranges per bin:
//   idle:        ~300-900 RPM
//   low cruise:  ~900-1800 RPM
//   high cruise: ~1800-3000 RPM
//   top end:     ~3000+ RPM
const BIN_DEFS: Record<BinKey, BinDef> = {
  idle: { label: 'idle', min: RPM_RUNNING_THRESHOLD_HZ, max: 15.0 },
  lowCruise: { label: 'low cruise', min: 15.0, max: 30.0 },
  highCruise: { label: 'high cruise', min: 30.0, max: 50.0 },
  topEnd: { label: 'top end', min: 50.0, max: Number.POSITIVE_INFINITY },
};

export interface BinStats {
  count: number;
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

interface Sample {
  ts: number;
  value: number;
}

export class DriftAnalyzer implements Analyzer<DriftInput> {
  readonly id = 'drift';
  readonly title = 'Engine Performance Drift';
  readonly triggers: ReadonlyArray<TriggerSpec>;

  constructor(cfg: DriftCfg) {
    const triggers: TriggerSpec[] = [];
    if (cfg.triggers.cron.enabled && cfg.triggers.cron.pattern) {
      triggers.push({ kind: 'cron', pattern: cfg.triggers.cron.pattern });
    }
    if (cfg.triggers.put.enabled && cfg.triggers.put.path) {
      triggers.push({ kind: 'put', path: cfg.triggers.put.path });
    }
    this.triggers = triggers;
  }

  async collectContext(ctx: TriggerCtx, deps: AnalyzerDeps): Promise<DriftInput | null> {
    const { questdb, app } = deps;
    if (!questdb) return null;
    const engineIds = discoverEngineIds(deps);
    if (engineIds.length === 0) return null;

    const context = app.selfContext ?? 'vessels.self';
    const firedMs = ctx.firedAt.getTime();
    const weekStart = firedMs - PAST_WEEK_DAYS * DAY_MS;
    const weekEnd = firedMs;
    const baselineEnd = weekStart;
    const baselineStart = baselineEnd - BASELINE_DAYS * DAY_MS;

    const engines: EngineDrift[] = [];
    for (const engineId of engineIds) {
      const thisWeek = await binEngineWindow(questdb, context, engineId, weekStart, weekEnd);
      if (!thisWeek || totalBinCount(thisWeek) === 0) continue;
      const baseline = await binEngineWindow(
        questdb,
        context,
        engineId,
        baselineStart,
        baselineEnd,
      );
      if (!baseline || totalBinCount(baseline) === 0) continue;
      engines.push({
        engineId,
        thisWeek,
        baseline,
        deltas: computeDeltas(thisWeek, baseline),
      });
    }
    if (engines.length === 0) return null;

    return {
      generatedAt: new Date(firedMs).toISOString(),
      windowDays: { thisWeek: PAST_WEEK_DAYS, baseline: BASELINE_DAYS },
      engines,
    };
  }

  async publishOutput(text: string, _ctx: TriggerCtx, deps: AnalyzerDeps): Promise<void> {
    await deps.publisher.publishOnPath(
      text,
      { analyzerId: this.id, ctx: _ctx },
      { path: 'notifications.openrouter-companion.drift.report', state: 'normal' },
    );
  }

  buildPrompt(input: DriftInput): { system: string; user: string } {
    const system = [
      'You are an experienced marine engine specialist comparing recent engine performance to its longer-term baseline.',
      'Units: propulsion.*.revolutions is in Hz (rev/s, the documented Signal K unit for this path: do not convert to rad/s). fuel.rate is in m^3/s. navigation.speedOverGround is in m/s.',
      'The data shows mean fuel rate and mean speed-over-ground per RPM band for the past week vs the trailing 30-day baseline, with percent delta per metric. Band edges are in Hz; 1 Hz = 60 RPM.',
      'A positive fuel-rate delta means burning more fuel per second in that band than baseline. A negative SOG delta means going slower in that band than baseline.',
      "Do not restate per-session details. That is the maintenance analyzer's job. Focus only on this-week vs baseline drift.",
      'Identify (1) which band moved most, (2) what the drift suggests: fouled prop, dirty hull, fuel quality, alternator load creep, or a transducer or sensor issue, (3) whether the magnitude warrants action this season or just monitoring.',
      'If a bin has too few samples, say so rather than guess. If the cause is not determinable from the fields shown, say "cause not determinable from telemetry".',
      'Stay under 350 words. Format as markdown with a 1-line summary, a per-engine section, and a short interpretation.',
    ].join(' ');

    const lines: string[] = [];
    lines.push(`## Generated ${input.generatedAt}`);
    lines.push(
      `Windows: past ${input.windowDays.thisWeek}d vs trailing ${input.windowDays.baseline}d baseline (baseline ends where the week begins, no overlap)`,
    );
    lines.push('');
    for (const eng of input.engines) {
      lines.push(`### Engine ${eng.engineId}`);
      lines.push(
        '| Band | Week n | Base n | Fuel.rate wk (m^3/s) | Fuel.rate base | Δ% | SOG wk (m/s) | SOG base | Δ% |',
      );
      lines.push('|---|---|---|---|---|---|---|---|---|');
      for (const bin of BIN_ORDER) {
        const def = BIN_DEFS[bin];
        const w = eng.thisWeek[bin];
        const b = eng.baseline[bin];
        const d = eng.deltas[bin];
        const range = `${def.label} [${def.min}, ${def.max === Number.POSITIVE_INFINITY ? '∞' : def.max}) Hz`;
        lines.push(
          `| ${range} | ${w.count} | ${b.count} | ${fmtNum(w.meanFuelRate)} | ${fmtNum(b.meanFuelRate)} | ${fmtPct(d.fuelRateDeltaPct)} | ${fmtNum(w.meanSog)} | ${fmtNum(b.meanSog)} | ${fmtPct(d.sogDeltaPct)} |`,
        );
      }
      lines.push('');
    }
    return { system, user: lines.join('\n') };
  }
}

function discoverEngineIds(deps: AnalyzerDeps): string[] {
  const ids = new Set<string>();
  for (const path of deps.buffer.pathKeys()) {
    const m = path.match(/^propulsion\.([^.]+)\.revolutions$/);
    if (m?.[1]) ids.add(m[1]);
  }
  // Fallback for the common single-engine vessel. The cron may fire after the
  // buffer has aged out (>26h since last engine use), in which case QuestDB
  // still holds the history but the buffer has nothing to discover from.
  if (ids.size === 0) ids.add('port');
  return Array.from(ids).sort();
}

async function binEngineWindow(
  questdb: NonNullable<AnalyzerDeps['questdb']>,
  context: string,
  engineId: string,
  fromMs: number,
  toMs: number,
): Promise<Record<BinKey, BinStats> | null> {
  const rpmPath = `propulsion.${engineId}.revolutions`;
  const fuelPath = `propulsion.${engineId}.fuel.rate`;
  const sogPath = 'navigation.speedOverGround';
  const [rpm, fuel, sog] = await Promise.all([
    fetchSamples(questdb, rpmPath, context, fromMs, toMs),
    fetchSamples(questdb, fuelPath, context, fromMs, toMs),
    fetchSamples(questdb, sogPath, context, fromMs, toMs),
  ]);
  if (rpm.length === 0) return null;
  rpm.sort(byTs);
  fuel.sort(byTs);
  sog.sort(byTs);

  const acc: Record<
    BinKey,
    { count: number; fuelSum: number; fuelN: number; sogSum: number; sogN: number }
  > = {
    idle: { count: 0, fuelSum: 0, fuelN: 0, sogSum: 0, sogN: 0 },
    lowCruise: { count: 0, fuelSum: 0, fuelN: 0, sogSum: 0, sogN: 0 },
    highCruise: { count: 0, fuelSum: 0, fuelN: 0, sogSum: 0, sogN: 0 },
    topEnd: { count: 0, fuelSum: 0, fuelN: 0, sogSum: 0, sogN: 0 },
  };

  for (const r of rpm) {
    const bin = binFor(r.value);
    if (bin) acc[bin].count += 1;
  }
  pairToBins(rpm, fuel, (bin, value) => {
    acc[bin].fuelSum += value;
    acc[bin].fuelN += 1;
  });
  pairToBins(rpm, sog, (bin, value) => {
    acc[bin].sogSum += value;
    acc[bin].sogN += 1;
  });

  return {
    idle: finalizeBin(acc.idle),
    lowCruise: finalizeBin(acc.lowCruise),
    highCruise: finalizeBin(acc.highCruise),
    topEnd: finalizeBin(acc.topEnd),
  };
}

function finalizeBin(a: {
  count: number;
  fuelSum: number;
  fuelN: number;
  sogSum: number;
  sogN: number;
}): BinStats {
  return {
    count: a.count,
    meanFuelRate: a.fuelN > 0 ? a.fuelSum / a.fuelN : null,
    meanSog: a.sogN > 0 ? a.sogSum / a.sogN : null,
  };
}

function pairToBins(
  rpm: Sample[],
  samples: Sample[],
  emit: (bin: BinKey, value: number) => void,
): void {
  if (rpm.length === 0) return;
  let i = 0;
  for (const s of samples) {
    while (i + 1 < rpm.length && rpm[i + 1]!.ts <= s.ts) i += 1;
    const r = rpm[i];
    if (!r || r.ts > s.ts) continue;
    if (s.ts - r.ts > RPM_JOIN_WINDOW_MS) continue;
    const bin = binFor(r.value);
    if (!bin) continue;
    emit(bin, s.value);
  }
}

function binFor(rpmHz: number): BinKey | null {
  if (!Number.isFinite(rpmHz) || rpmHz < RPM_RUNNING_THRESHOLD_HZ) return null;
  for (const k of BIN_ORDER) {
    const def = BIN_DEFS[k];
    if (rpmHz >= def.min && rpmHz < def.max) return k;
  }
  return null;
}

async function fetchSamples(
  questdb: NonNullable<AnalyzerDeps['questdb']>,
  path: string,
  context: string,
  fromMs: number,
  toMs: number,
): Promise<Sample[]> {
  const escapedPath = path.replace(/'/g, "''");
  const escapedCtx = context.replace(/'/g, "''");
  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(toMs).toISOString();
  const sql = `
    SELECT ts, value FROM signalk
    WHERE path = '${escapedPath}'
      AND context = '${escapedCtx}'
      AND ts >= '${fromIso}'
      AND ts < '${toIso}'
    ORDER BY ts
    LIMIT ${QUERY_ROW_LIMIT}
  `
    .trim()
    .replace(/\s+/g, ' ');
  try {
    const r = await questdb.query(sql);
    const tsIdx = r.columns.findIndex((c) => c.name === 'ts');
    const valIdx = r.columns.findIndex((c) => c.name === 'value');
    if (tsIdx < 0 || valIdx < 0) return [];
    const out: Sample[] = [];
    for (const row of r.dataset) {
      const tsRaw = row[tsIdx];
      const valRaw = row[valIdx];
      const tsMs =
        typeof tsRaw === 'number'
          ? tsRaw
          : typeof tsRaw === 'string'
            ? Date.parse(tsRaw)
            : Number.NaN;
      if (!Number.isFinite(tsMs)) continue;
      if (typeof valRaw !== 'number' || !Number.isFinite(valRaw)) continue;
      out.push({ ts: tsMs, value: valRaw });
    }
    return out;
  } catch {
    return [];
  }
}

function computeDeltas(
  week: Record<BinKey, BinStats>,
  base: Record<BinKey, BinStats>,
): Record<BinKey, BinDelta> {
  return {
    idle: deltaForBin(week.idle, base.idle),
    lowCruise: deltaForBin(week.lowCruise, base.lowCruise),
    highCruise: deltaForBin(week.highCruise, base.highCruise),
    topEnd: deltaForBin(week.topEnd, base.topEnd),
  };
}

function deltaForBin(w: BinStats, b: BinStats): BinDelta {
  if (w.count < MIN_BIN_SAMPLES || b.count < MIN_BIN_SAMPLES) {
    return { fuelRateDeltaPct: null, sogDeltaPct: null };
  }
  return {
    fuelRateDeltaPct: pctDelta(w.meanFuelRate, b.meanFuelRate),
    sogDeltaPct: pctDelta(w.meanSog, b.meanSog),
  };
}

function pctDelta(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  if (b === 0) return null;
  return ((a - b) / b) * 100;
}

function totalBinCount(bins: Record<BinKey, BinStats>): number {
  let n = 0;
  for (const k of BIN_ORDER) n += bins[k].count;
  return n;
}

function byTs(a: Sample, b: Sample): number {
  return a.ts - b.ts;
}

function fmtNum(v: number | null): string {
  if (v == null) return 'n/a';
  if (!Number.isFinite(v)) return 'n/a';
  return v.toFixed(5);
}

function fmtPct(v: number | null): string {
  if (v == null) return 'n/a';
  if (!Number.isFinite(v)) return 'n/a';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}
