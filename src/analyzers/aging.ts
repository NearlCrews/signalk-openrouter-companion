import {
  clampPositiveInt,
  REPORT_BODY_INSTRUCTION,
  REPORT_HEADLINE_INSTRUCTION,
  resolveSystemPrompt,
} from '../core/cfg.js';
import { discoverBankIds } from '../core/discovery.js';
import { asFiniteNumber, DAY_MS, fmtNumber } from '../core/format.js';
import { bankPaths } from '../core/paths.js';
import {
  decodePathKeyed,
  flattenSql,
  isoRange,
  QUESTDB_SELF_CONTEXT_SQL,
  quotedPathList,
} from '../core/questdb.js';
import { buildTriggers } from '../core/triggers.js';
import {
  AGING_DEFAULT_LONG_DAYS,
  AGING_DEFAULT_SHORT_DAYS,
  type AnalyzerTriggerCfg,
} from '../types.js';
import type { AnalysisInput, Analyzer, AnalyzerDeps, TriggerCtx, TriggerSpec } from './Analyzer.js';
import { ANALYZER_TITLES } from './ids.js';

export interface AgingCfg {
  triggers: AnalyzerTriggerCfg;
  shortWindowDays: number;
  longWindowDays: number;
  customSystemPrompt?: string;
}

// Static: window lengths come through the user prompt's data block, not the
// system prompt, so customSystemPrompt overrides do not lose any numbers.
export const AGING_DEFAULT_SYSTEM_PROMPT = [
  'You are a marine LiFePO4 battery specialist reviewing capacity degradation trends from a Signal K vessel.',
  'All numeric values are in Signal K SI base units: capacity in J, cycles unitless. Deltas are expressed as percentages and as percent capacity loss per 100 cycles.',
  'Focus only on the aging trend. Do not restate the snapshot for today; the daily health analyzer covers that.',
  "For each bank, comment on each configured window's capacity trajectory and the loss per 100 cycles when cycles increased over the window.",
  'Each window delta is computed from the first and last sample in that window, not a fitted regression line, so a single BMS capacity recalibration (common after a full charge) can show up as a spurious jump in one window. Weigh a trend that appears in both windows more heavily than one that shows in only one.',
  'Rank banks by capacity loss per 100 cycles, worst first. Flag any bank degrading 3 to 4 times the median rate as an outlier worth investigating.',
  "When the longest window has at least two samples on both capacity and cycles and a positive cycles delta, project months to replacement assuming linear degradation reaches 80 percent of original nominal capacity at end of life. Skip the projection where data is insufficient. Note that this is a linear-fit approximation; LiFePO4 capacity typically holds steady for most of the pack's life and then drops past a knee, so the projection will run optimistic late in life.",
  'Stay with the numbers in the data. If a bank is degrading within normal LiFePO4 expectations, say so plainly.',
  REPORT_HEADLINE_INSTRUCTION,
  REPORT_BODY_INSTRUCTION,
  'Mention each bank by name in one tight clause covering its loss-per-100-cycles and any projected months-to-replace.',
].join(' ');

interface PathSummary {
  first: number | null;
  last: number | null;
  n: number;
}

interface WindowStats {
  capacitySamples: number;
  capacityStart: number | null;
  capacityEnd: number | null;
  capacityDeltaPct: number | null;
  cyclesSamples: number;
  cyclesStart: number | null;
  cyclesEnd: number | null;
  cyclesDelta: number | null;
  lossPer100Cycles: number | null;
}

interface WindowEntry {
  days: number;
  stats: WindowStats;
}

interface BankAging {
  id: string;
  windows: WindowEntry[];
}

export interface AgingInput extends AnalysisInput {
  generatedAt: string;
  banks: BankAging[];
}

function resolveWindowDays(cfg: AgingCfg): readonly number[] {
  // Bounds mirror the schema so a value from a hand-edited JSON config is
  // clamped at runtime too (shortWindowDays 7..365, longWindowDays 7..1095).
  const short = clampPositiveInt(cfg.shortWindowDays, AGING_DEFAULT_SHORT_DAYS, {
    min: 7,
    max: 365,
  });
  const long = clampPositiveInt(cfg.longWindowDays, AGING_DEFAULT_LONG_DAYS, {
    min: 7,
    max: 1095,
  });
  const [a, b] = short <= long ? [short, long] : [long, short];
  return a === b ? [a] : [a, b];
}

export class AgingAnalyzer implements Analyzer<AgingInput> {
  readonly id = 'aging';
  readonly title = ANALYZER_TITLES.aging;
  readonly triggers: ReadonlyArray<TriggerSpec>;
  private readonly windowDays: readonly number[];
  private readonly systemPrompt: string;

  constructor(cfg: AgingCfg) {
    this.triggers = buildTriggers(this.id, cfg.triggers);
    this.windowDays = resolveWindowDays(cfg);
    this.systemPrompt = resolveSystemPrompt(cfg.customSystemPrompt, AGING_DEFAULT_SYSTEM_PROMPT);
  }

  async collectContext(ctx: TriggerCtx, deps: AnalyzerDeps): Promise<AgingInput | null> {
    if (!deps.questdb) return null;
    const bankIds = discoverBankIds(deps.buffer.pathKeys());
    if (bankIds.length === 0) return null;

    const questdb = deps.questdb;

    const allPaths: string[] = [];
    for (const id of bankIds) {
      const { capacityActual: cap, cycles: cyc } = bankPaths(id);
      allPaths.push(cap, cyc);
    }

    const firedMs = ctx.firedAt.getTime();
    const summariesByWindow = await Promise.all(
      this.windowDays.map(async (days) => ({
        days,
        summaries: await queryWindow(questdb, allPaths, days, firedMs),
      })),
    );

    const banks: BankAging[] = [];
    for (const id of bankIds) {
      const { capacityActual: cap, cycles: cyc } = bankPaths(id);
      const windows: WindowEntry[] = [];
      let hasData = false;
      for (const { days, summaries } of summariesByWindow) {
        const stats = computeWindowStats(summaries.get(cap), summaries.get(cyc));
        windows.push({ days, stats });
        if (stats.capacitySamples >= 2 || stats.cyclesSamples >= 2) hasData = true;
      }
      if (hasData) banks.push({ id, windows });
    }

    if (banks.length === 0) return null;
    return {
      generatedAt: ctx.firedAt.toISOString(),
      banks,
    };
  }

  buildPrompt(input: AgingInput): { system: string; user: string } {
    // By the time buildPrompt runs, each bank's windows match this.windowDays
    // one for one (collectContext builds them from the same list).
    const windowDesc = this.windowDays.map((d) => `${d}-day`).join(' and ');
    const lines: string[] = [];
    lines.push(`## Generated ${input.generatedAt}`);
    lines.push(`Configured windows: ${windowDesc} (longest = ${this.windowDays.at(-1)} days)`);
    lines.push('');
    for (const b of input.banks) {
      lines.push(`### Bank: ${b.id}`);
      for (const { days, stats: w } of b.windows) {
        lines.push(`- ${days}d window:`);
        lines.push(`  - capacity samples: ${w.capacitySamples}`);
        lines.push(`  - capacity start (J): ${fmtNumber(w.capacityStart)}`);
        lines.push(`  - capacity end (J): ${fmtNumber(w.capacityEnd)}`);
        lines.push(`  - capacity delta (%): ${fmtNumber(w.capacityDeltaPct)}`);
        lines.push(`  - cycles samples: ${w.cyclesSamples}`);
        lines.push(`  - cycles start: ${fmtNumber(w.cyclesStart)}`);
        lines.push(`  - cycles end: ${fmtNumber(w.cyclesEnd)}`);
        lines.push(`  - cycles delta: ${fmtNumber(w.cyclesDelta)}`);
        lines.push(`  - capacity loss per 100 cycles (%): ${fmtNumber(w.lossPer100Cycles)}`);
      }
      lines.push('');
    }
    return { system: this.systemPrompt, user: lines.join('\n') };
  }
}

function computeWindowStats(
  cap: PathSummary | undefined,
  cyc: PathSummary | undefined,
): WindowStats {
  const capStart = cap?.first ?? null;
  const capEnd = cap?.last ?? null;
  const capN = cap?.n ?? 0;
  const cycStart = cyc?.first ?? null;
  const cycEnd = cyc?.last ?? null;
  const cycN = cyc?.n ?? 0;

  let capacityDeltaPct: number | null = null;
  if (capN >= 2 && capStart != null && capEnd != null && capStart > 0) {
    capacityDeltaPct = ((capEnd - capStart) / capStart) * 100;
  }

  let cyclesDelta: number | null = null;
  if (cycN >= 2 && cycStart != null && cycEnd != null) {
    cyclesDelta = cycEnd - cycStart;
  }

  let lossPer100Cycles: number | null = null;
  if (capacityDeltaPct != null && cyclesDelta != null && cyclesDelta > 0) {
    lossPer100Cycles = (-capacityDeltaPct / cyclesDelta) * 100;
  }

  return {
    capacitySamples: capN,
    capacityStart: capStart,
    capacityEnd: capEnd,
    capacityDeltaPct,
    cyclesSamples: cycN,
    cyclesStart: cycStart,
    cyclesEnd: cycEnd,
    cyclesDelta,
    lossPer100Cycles,
  };
}

async function queryWindow(
  client: NonNullable<AnalyzerDeps['questdb']>,
  paths: string[],
  days: number,
  firedMs: number,
): Promise<Map<string, PathSummary>> {
  const escapedPaths = quotedPathList(paths);
  // Explicit ISO bounds anchored to the trigger time. A server-side now()
  // upper bound would let BMS samples that arrive between the trigger and the
  // query execution leak into last(value); pinning ts <= firedAt prevents it.
  const [fromIso, toIso] = isoRange(firedMs - days * DAY_MS, firedMs);
  const sql = flattenSql(`
    SELECT path, first(value) AS first_val, last(value) AS last_val, count() AS n
    FROM signalk
    WHERE context = '${QUESTDB_SELF_CONTEXT_SQL}'
      AND path IN (${escapedPaths})
      AND ts > '${fromIso}'
      AND ts <= '${toIso}'
    GROUP BY path
  `);

  // A query fault propagates: aging requires QuestDB, so a fault is a real
  // analyzer failure and must surface as a failure report, not a silent skip.
  const r = await client.query(sql);
  return decodePathKeyed(r, (cols) => {
    const fIdx = cols.get('first_val') ?? -1;
    const lIdx = cols.get('last_val') ?? -1;
    const nIdx = cols.get('n') ?? -1;
    return (row) => ({
      first: asFiniteNumber(fIdx >= 0 ? row[fIdx] : null),
      last: asFiniteNumber(lIdx >= 0 ? row[lIdx] : null),
      n: asFiniteNumber(nIdx >= 0 ? row[nIdx] : null) ?? 0,
    });
  });
}
