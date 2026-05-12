import { clampPositiveInt } from '../core/cfg.js';
import { discoverBankIds } from '../core/discovery.js';
import { fmtNumber } from '../core/format.js';
import { bankPaths } from '../core/paths.js';
import { escapeSqlLiteral, indexColumns } from '../core/questdb.js';
import { buildTriggers } from '../core/triggers.js';
import type { AnalyzerTriggerCfg } from '../types.js';
import type { AnalysisInput, Analyzer, AnalyzerDeps, TriggerCtx, TriggerSpec } from './Analyzer.js';

export interface AgingCfg {
  triggers: AnalyzerTriggerCfg;
  shortWindowDays: number;
  longWindowDays: number;
}

interface PathSummary {
  first: number;
  last: number;
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
  selfContext: string;
  banks: BankAging[];
}

function resolveWindowDays(cfg: AgingCfg): readonly number[] {
  const short = clampPositiveInt(cfg.shortWindowDays, 30);
  const long = clampPositiveInt(cfg.longWindowDays, 90);
  const [a, b] = short <= long ? [short, long] : [long, short];
  return a === b ? [a] : [a, b];
}

export class AgingAnalyzer implements Analyzer<AgingInput> {
  readonly id = 'aging';
  readonly title = 'Battery Aging Tracker';
  readonly triggers: ReadonlyArray<TriggerSpec>;
  private readonly windowDays: readonly number[];

  constructor(cfg: AgingCfg) {
    this.triggers = buildTriggers(cfg.triggers);
    this.windowDays = resolveWindowDays(cfg);
  }

  async collectContext(ctx: TriggerCtx, deps: AnalyzerDeps): Promise<AgingInput | null> {
    if (!deps.questdb) return null;
    const bankIds = discoverBankIds(Array.from(deps.buffer.pathKeys()));
    if (bankIds.length === 0) return null;

    const selfContext = deps.app.selfContext ?? '';
    const questdb = deps.questdb;

    const allPaths: string[] = [];
    const pathsByBank = new Map<string, { cap: string; cyc: string }>();
    for (const id of bankIds) {
      const { capacityActual: cap, cycles: cyc } = bankPaths(id);
      pathsByBank.set(id, { cap, cyc });
      allPaths.push(cap, cyc);
    }

    const summariesByWindow = await Promise.all(
      this.windowDays.map(async (days) => ({
        days,
        summaries: await queryWindow(questdb, selfContext, allPaths, days),
      })),
    );

    const banks: BankAging[] = [];
    for (const id of bankIds) {
      const paths = pathsByBank.get(id);
      if (!paths) continue;
      const { cap, cyc } = paths;
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
      selfContext,
      banks,
    };
  }

  async publishOutput(text: string, ctx: TriggerCtx, deps: AnalyzerDeps): Promise<void> {
    await deps.publisher.publishReport(this.id, ctx, text);
  }

  buildPrompt(input: AgingInput): { system: string; user: string } {
    const days = input.banks[0]?.windows.map((w) => w.days) ?? Array.from(this.windowDays);
    const windowDesc = days.map((d) => `${d}-day`).join(' and ');
    const longestWindow = days.at(-1) ?? 90;
    const system = [
      'You are a marine LiFePO4 battery specialist reviewing capacity degradation trends from a Signal K vessel.',
      'All numeric values are in Signal K SI base units: capacity in J, cycles unitless. Deltas are expressed as percentages and as percent capacity loss per 100 cycles.',
      'Focus only on the aging trend. Do not restate the snapshot for today; the daily health analyzer covers that.',
      `For each bank, comment on the ${windowDesc} capacity trajectory and the loss per 100 cycles when cycles increased over the window.`,
      'Rank banks by capacity loss per 100 cycles, worst first. Flag any bank degrading 3 to 4 times the median rate as an outlier worth investigating.',
      `When the longest window (${longestWindow} days) has at least two samples on both capacity and cycles and a positive cycles delta, project months to replacement assuming linear degradation reaches 80 percent of original nominal capacity at end of life. Skip the projection where data is insufficient.`,
      'Stay with the numbers in the data. If a bank is degrading within normal LiFePO4 expectations, say so plainly.',
      'Output is rendered in the Signal K data browser as a single string. Produce one short paragraph of plain prose (80-150 words). Do not use markdown: no headers, no bullets, no horizontal rules, no section dividers. Use semicolons and commas to separate points. Lead with the headline (which bank is aging fastest, or "all banks within normal range"), then mention each bank by name in one tight clause covering its loss-per-100-cycles and any projected months-to-replace.',
    ].join(' ');

    const lines: string[] = [];
    lines.push(`## Generated ${input.generatedAt}`);
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
    return { system, user: lines.join('\n') };
  }
}

function computeWindowStats(
  cap: PathSummary | undefined,
  cyc: PathSummary | undefined,
): WindowStats {
  const capStart = numOrNull(cap?.first);
  const capEnd = numOrNull(cap?.last);
  const capN = cap?.n ?? 0;
  const cycStart = numOrNull(cyc?.first);
  const cycEnd = numOrNull(cyc?.last);
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
  context: string,
  paths: string[],
  days: number,
): Promise<Map<string, PathSummary>> {
  const escapedCtx = escapeSqlLiteral(context);
  const escapedPaths = paths.map((p) => `'${escapeSqlLiteral(p)}'`).join(', ');
  const sql = `
    SELECT path, first(value) AS first_val, last(value) AS last_val, count() AS n
    FROM signalk
    WHERE context = '${escapedCtx}'
      AND path IN (${escapedPaths})
      AND ts > dateadd('d', -${days}, now())
    GROUP BY path
  `
    .trim()
    .replace(/\s+/g, ' ');

  const out = new Map<string, PathSummary>();
  try {
    const r = await client.query(sql);
    const cols = indexColumns(r);
    const pIdx = cols.get('path') ?? -1;
    if (pIdx < 0) return out;
    const fIdx = cols.get('first_val') ?? -1;
    const lIdx = cols.get('last_val') ?? -1;
    const nIdx = cols.get('n') ?? -1;
    for (const row of r.dataset) {
      const path = row[pIdx];
      if (typeof path !== 'string') continue;
      const firstV = fIdx >= 0 ? row[fIdx] : null;
      const lastV = lIdx >= 0 ? row[lIdx] : null;
      const nV = nIdx >= 0 ? row[nIdx] : 0;
      out.set(path, {
        first: typeof firstV === 'number' ? firstV : Number.NaN,
        last: typeof lastV === 'number' ? lastV : Number.NaN,
        n: typeof nV === 'number' ? nV : 0,
      });
    }
  } catch {
    // best-effort: caller treats missing path as insufficient data
  }
  return out;
}

function numOrNull(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
