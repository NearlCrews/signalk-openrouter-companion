import { discoverBankIds } from '../core/discovery.js';
import type { AnalyzerTriggerCfg } from '../types.js';
import type { AnalysisInput, Analyzer, AnalyzerDeps, TriggerCtx, TriggerSpec } from './Analyzer.js';

export interface AgingCfg {
  triggers: AnalyzerTriggerCfg;
}

const WINDOW_DAYS = [30, 90] as const;
type WindowDays = (typeof WINDOW_DAYS)[number];
type WindowKey = `${WindowDays}d`;

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

interface BankAging {
  id: string;
  windows: Record<WindowKey, WindowStats>;
}

export interface AgingInput extends AnalysisInput {
  generatedAt: string;
  selfContext: string;
  banks: BankAging[];
}

export class AgingAnalyzer implements Analyzer<AgingInput> {
  readonly id = 'aging';
  readonly title = 'Battery Aging Tracker';
  readonly triggers: ReadonlyArray<TriggerSpec>;

  constructor(private cfg: AgingCfg) {
    const triggers: TriggerSpec[] = [];
    if (cfg.triggers.cron.enabled && cfg.triggers.cron.pattern) {
      triggers.push({ kind: 'cron', pattern: cfg.triggers.cron.pattern });
    }
    if (cfg.triggers.put.enabled && cfg.triggers.put.path) {
      triggers.push({ kind: 'put', path: cfg.triggers.put.path });
    }
    this.triggers = triggers;
  }

  async collectContext(ctx: TriggerCtx, deps: AnalyzerDeps): Promise<AgingInput | null> {
    if (!deps.questdb) return null;
    const bankIds = discoverBankIds(Array.from(deps.buffer.pathKeys()));
    if (bankIds.length === 0) return null;

    const selfContext = deps.app.selfContext ?? '';
    const banks: BankAging[] = [];

    for (const id of bankIds) {
      const capPath = `electrical.batteries.${id}.capacity.actual`;
      const cycPath = `electrical.batteries.${id}.cycles`;
      const windows = {} as Record<WindowKey, WindowStats>;
      let anyData = false;
      for (const days of WINDOW_DAYS) {
        const key = `${days}d` as WindowKey;
        const summaries = await queryWindow(deps.questdb, selfContext, [capPath, cycPath], days);
        const stats = computeWindowStats(summaries.get(capPath), summaries.get(cycPath));
        windows[key] = stats;
        if (stats.capacitySamples >= 2 || stats.cyclesSamples >= 2) anyData = true;
      }
      if (anyData) banks.push({ id, windows });
    }

    if (banks.length === 0) return null;
    return {
      generatedAt: ctx.firedAt.toISOString(),
      selfContext,
      banks,
    };
  }

  async publishOutput(text: string, ctx: TriggerCtx, deps: AnalyzerDeps): Promise<void> {
    await deps.publisher.publishOnPath(
      text,
      { analyzerId: this.id, ctx },
      { path: 'notifications.openrouter-companion.aging.report', state: 'normal' },
    );
  }

  buildPrompt(input: AgingInput): { system: string; user: string } {
    const system = [
      'You are a marine LiFePO4 battery specialist reviewing capacity degradation trends from a Signal K vessel.',
      'All numeric values are in Signal K SI base units: capacity in J, cycles unitless. Deltas are expressed as percentages and as percent capacity loss per 100 cycles.',
      'Focus only on the aging trend. Do not restate the snapshot for today; the daily health analyzer covers that.',
      'For each bank, comment on the 30-day and 90-day capacity trajectory and the loss per 100 cycles when cycles increased over the window.',
      'Rank banks by capacity loss per 100 cycles, worst first. Flag any bank degrading 3 to 4 times the median rate as an outlier worth investigating.',
      'When the 90-day window has at least two samples on both capacity and cycles and a positive cycles delta, project months to replacement assuming linear degradation reaches 80 percent of original nominal capacity at end of life. Skip the projection where data is insufficient.',
      'Stay with the numbers in the data. If a bank is degrading within normal LiFePO4 expectations, say so plainly.',
      'Stay under 350 words. Format as markdown with a 1-line summary followed by a section per bank.',
    ].join(' ');

    const lines: string[] = [];
    lines.push(`## Generated ${input.generatedAt}`);
    lines.push('');
    for (const b of input.banks) {
      lines.push(`### Bank: ${b.id}`);
      for (const days of WINDOW_DAYS) {
        const key = `${days}d` as WindowKey;
        const w = b.windows[key];
        lines.push(`- ${key} window:`);
        lines.push(`  - capacity samples: ${w.capacitySamples}`);
        lines.push(`  - capacity start (J): ${fmt(w.capacityStart)}`);
        lines.push(`  - capacity end (J): ${fmt(w.capacityEnd)}`);
        lines.push(`  - capacity delta (%): ${fmt(w.capacityDeltaPct)}`);
        lines.push(`  - cycles samples: ${w.cyclesSamples}`);
        lines.push(`  - cycles start: ${fmt(w.cyclesStart)}`);
        lines.push(`  - cycles end: ${fmt(w.cyclesEnd)}`);
        lines.push(`  - cycles delta: ${fmt(w.cyclesDelta)}`);
        lines.push(`  - capacity loss per 100 cycles (%): ${fmt(w.lossPer100Cycles)}`);
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
  const capStart = isFiniteNumber(cap?.first) ? (cap as PathSummary).first : null;
  const capEnd = isFiniteNumber(cap?.last) ? (cap as PathSummary).last : null;
  const capN = cap?.n ?? 0;
  const cycStart = isFiniteNumber(cyc?.first) ? (cyc as PathSummary).first : null;
  const cycEnd = isFiniteNumber(cyc?.last) ? (cyc as PathSummary).last : null;
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
  const escapedCtx = context.replace(/'/g, "''");
  const escapedPaths = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(', ');
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
    const pIdx = r.columns.findIndex((c) => c.name === 'path');
    const fIdx = r.columns.findIndex((c) => c.name === 'first_val');
    const lIdx = r.columns.findIndex((c) => c.name === 'last_val');
    const nIdx = r.columns.findIndex((c) => c.name === 'n');
    if (pIdx < 0) return out;
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

function isFiniteNumber(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

function fmt(v: unknown): string {
  if (v == null) return 'n/a';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'n/a';
    return Number.isInteger(v) ? String(v) : v.toFixed(3);
  }
  return String(v);
}
