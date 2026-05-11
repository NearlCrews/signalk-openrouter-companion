import type { AnalyzerTriggerCfg } from '../types.js';
import type { Analyzer, AnalyzerDeps, TriggerCtx, TriggerSpec } from './Analyzer.js';

export interface HealthCfg {
  triggers: AnalyzerTriggerCfg;
}

interface CellSnapshot {
  index: number;
  voltage: number;
}

interface BankSnapshot {
  id: string;
  voltage: number | null;
  current: number | null;
  stateOfCharge: number | null;
  nominalCapacityJ: number | null;
  cycles: number | null;
  temperatureK: number | null;
  voltage24h: { min: number; max: number; mean: number; count: number; sources: string[] } | null;
  cells: CellSnapshot[] | null;
}

export interface HealthInput {
  generatedAt: string;
  banks: BankSnapshot[];
  baselines: Record<string, unknown> | null;
  [key: string]: unknown;
}

export class HealthAnalyzer implements Analyzer<HealthInput> {
  readonly id = 'health';
  readonly title = 'Battery Health Advisor';
  readonly triggers: ReadonlyArray<TriggerSpec>;

  constructor(private cfg: HealthCfg) {
    const triggers: TriggerSpec[] = [];
    if (cfg.triggers.cron.enabled && cfg.triggers.cron.pattern) {
      triggers.push({ kind: 'cron', pattern: cfg.triggers.cron.pattern });
    }
    if (cfg.triggers.put.enabled && cfg.triggers.put.path) {
      triggers.push({ kind: 'put', path: cfg.triggers.put.path });
    }
    this.triggers = triggers;
  }

  async collectContext(ctx: TriggerCtx, deps: AnalyzerDeps): Promise<HealthInput | null> {
    const tree = deps.app.getSelfPath('electrical.batteries');
    if (!tree || typeof tree !== 'object') return null;
    const banksRaw = Object.entries(tree as Record<string, unknown>);
    if (banksRaw.length === 0) return null;

    const endMs = ctx.firedAt.getTime();
    const startMs = endMs - 24 * 3600_000;

    const banks: BankSnapshot[] = banksRaw.map(([id, node]) => {
      const get = (subpath: string): number | null => readNumberAt(node, subpath);
      const cells = collectCells(node);
      return {
        id,
        voltage: get('voltage'),
        current: get('current'),
        stateOfCharge: get('capacity.stateOfCharge'),
        nominalCapacityJ: get('capacity.nominal'),
        cycles: get('cycles'),
        temperatureK: get('temperature'),
        voltage24h: deps.buffer.summarize(`electrical.batteries.${id}.voltage`, startMs, endMs),
        cells: cells.length > 0 ? cells : null,
      };
    });

    const questdb = deps.questdb;
    let baselines: Record<string, unknown> | null = null;
    if (questdb) {
      const collected: Record<string, unknown> = {};
      await Promise.all(
        banks.map(async (b) => {
          try {
            const sb = await questdb.baselineFor(
              `electrical.batteries.${b.id}.capacity.stateOfCharge`,
              deps.app.selfContext ?? 'vessels.self',
              30,
            );
            if (sb) collected[b.id] = sb;
          } catch {
            // best-effort: questdb gaps must not derail the report
          }
        }),
      );
      baselines = collected;
    }

    return {
      generatedAt: new Date(endMs).toISOString(),
      banks,
      baselines,
    };
  }

  async publishOutput(text: string, ctx: TriggerCtx, deps: AnalyzerDeps): Promise<void> {
    await deps.publisher.publishOnPath(
      text,
      { analyzerId: this.id, ctx },
      { path: 'notifications.openrouter-companion.health.report', state: 'normal' },
    );
  }

  buildPrompt(input: HealthInput): { system: string; user: string } {
    const system = [
      'You are an experienced marine electrical specialist reading raw battery telemetry from a Signal K server.',
      'All numeric values are in Signal K SI base units: voltage in V, current in A, temperature in K, capacity in J, SoC as a 0-1 ratio.',
      'Produce a concise plain-English daily report covering every battery bank.',
      'For each bank: state of charge, voltage and current trends, cycle count, cell balance (if cell data is present), and any drift vs the 30-day baseline if baselines are present.',
      'Stick to facts present in the data. Do not speculate beyond what the numbers show.',
      'Surface anything that looks unusual: voltage outside an obvious range for the bank, cell imbalance over the configured threshold, SoC drifting low.',
      'Format the response as markdown with a 1-line summary, then a section per bank.',
      'Stay under 400 words.',
    ].join(' ');

    const banks = input.banks;
    const baselines = input.baselines;

    const lines: string[] = [];
    lines.push(`## Generated ${input.generatedAt}`);
    lines.push('');
    for (const b of banks) {
      lines.push(`### Bank: ${b.id}`);
      lines.push(`- voltage now: ${fmt(b.voltage)}`);
      lines.push(`- current now: ${fmt(b.current)}`);
      lines.push(`- state of charge: ${fmt(b.stateOfCharge)}`);
      if (b.nominalCapacityJ != null)
        lines.push(`- nominal capacity (J): ${fmt(b.nominalCapacityJ)}`);
      if (b.cycles != null) lines.push(`- cycles: ${fmt(b.cycles)}`);
      if (b.temperatureK != null) lines.push(`- temperature (K): ${fmt(b.temperatureK)}`);
      if (b.voltage24h) {
        lines.push(
          `- voltage 24h: min=${fmt(b.voltage24h.min)} max=${fmt(b.voltage24h.max)} mean=${fmt(b.voltage24h.mean)} count=${fmt(b.voltage24h.count)}`,
        );
      }
      if (b.cells && b.cells.length > 0) {
        const cellLine = b.cells.map((c) => `${c.index}=${fmt(c.voltage)}`).join(' ');
        lines.push(`- cells: ${cellLine}`);
      }
      if (baselines && baselines[b.id]) {
        lines.push(`- 30-day SoC baseline: ${JSON.stringify(baselines[b.id])}`);
      }
      lines.push('');
    }
    return { system, user: lines.join('\n') };
  }
}

function collectCells(node: unknown): CellSnapshot[] {
  if (!node || typeof node !== 'object') return [];
  const out: CellSnapshot[] = [];
  for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
    const cm = key.match(/^cell(\d+)$/);
    if (!cm) continue;
    if (val && typeof val === 'object') {
      const vNode = (val as Record<string, unknown>).voltage;
      if (vNode && typeof vNode === 'object' && 'value' in (vNode as Record<string, unknown>)) {
        const v = (vNode as { value: unknown }).value;
        if (typeof v === 'number') {
          out.push({ index: Number.parseInt(cm[1]!, 10), voltage: v });
        }
      }
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

function fmt(v: unknown): string {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
  if (v == null) return 'n/a';
  return String(v);
}

export function readNumberAt(node: unknown, subpath: string): number | null {
  const segs = subpath.split('.');
  let cur: unknown = node;
  for (const seg of segs) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (cur && typeof cur === 'object' && 'value' in (cur as Record<string, unknown>)) {
    const v = (cur as { value: unknown }).value;
    return typeof v === 'number' ? v : null;
  }
  return null;
}
