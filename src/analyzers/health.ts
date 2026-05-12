import { fmtNumber } from '../core/format.js';
import { BATTERIES_PARENT_PATH, bankPaths } from '../core/paths.js';
import { readNumberAt } from '../core/skNode.js';
import { buildTriggers } from '../core/triggers.js';
import type { AnalyzerTriggerCfg } from '../types.js';
import type { Analyzer, AnalyzerDeps, TriggerCtx, TriggerSpec } from './Analyzer.js';

export interface HealthCfg {
  triggers: AnalyzerTriggerCfg;
  customSystemPrompt?: string;
}

export const HEALTH_DEFAULT_SYSTEM_PROMPT = [
  'You are an experienced marine electrical specialist reading raw battery telemetry from a Signal K server.',
  'All numeric values are in Signal K SI base units: voltage in V, current in A, temperature in K, capacity in J, SoC as a 0-1 ratio.',
  'Produce a concise plain-English daily report covering every battery bank.',
  'For each bank: state of charge, voltage and current trends, cycle count, and cell balance (if cell data is present).',
  'Stick to facts present in the data. Do not speculate beyond what the numbers show.',
  'If you cannot identify a cause from the data, say so rather than guess.',
  'Surface anything that looks unusual: voltage outside an obvious range for the bank, cell imbalance over the configured threshold, SoC drifting low.',
  'Output is rendered in the Signal K data browser as a single string. Produce one short paragraph of plain prose (80-150 words). Do not use markdown: no headers, no bullets, no horizontal rules, no section dividers. Use semicolons and commas to separate points within the paragraph. Lead with the headline (overall state across all banks), then mention each bank by name in one tight clause covering SoC, voltage, balance, and anything notable.',
].join(' ');

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
}

export class HealthAnalyzer implements Analyzer<HealthInput> {
  readonly id = 'health';
  readonly title = 'Battery Health Advisor';
  readonly triggers: ReadonlyArray<TriggerSpec>;
  private readonly systemPrompt: string;

  constructor(cfg: HealthCfg) {
    this.triggers = buildTriggers(cfg.triggers);
    this.systemPrompt = cfg.customSystemPrompt?.trim() || HEALTH_DEFAULT_SYSTEM_PROMPT;
  }

  async collectContext(ctx: TriggerCtx, deps: AnalyzerDeps): Promise<HealthInput | null> {
    const tree = deps.app.getSelfPath(BATTERIES_PARENT_PATH);
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
        voltage24h: deps.buffer.summarize(bankPaths(id).voltage, startMs, endMs),
        cells: cells.length > 0 ? cells : null,
      };
    });

    return {
      generatedAt: new Date(endMs).toISOString(),
      banks,
    };
  }

  buildPrompt(input: HealthInput): { system: string; user: string } {
    const banks = input.banks;

    const lines: string[] = [];
    lines.push(`## Generated ${input.generatedAt}`);
    lines.push('');
    for (const b of banks) {
      lines.push(`### Bank: ${b.id}`);
      lines.push(`- voltage now: ${fmtNumber(b.voltage)}`);
      lines.push(`- current now: ${fmtNumber(b.current)}`);
      lines.push(`- state of charge: ${fmtNumber(b.stateOfCharge)}`);
      if (b.nominalCapacityJ != null)
        lines.push(`- nominal capacity (J): ${fmtNumber(b.nominalCapacityJ)}`);
      if (b.cycles != null) lines.push(`- cycles: ${fmtNumber(b.cycles)}`);
      if (b.temperatureK != null) lines.push(`- temperature (K): ${fmtNumber(b.temperatureK)}`);
      if (b.voltage24h) {
        lines.push(
          `- voltage 24h: min=${fmtNumber(b.voltage24h.min)} max=${fmtNumber(b.voltage24h.max)} mean=${fmtNumber(b.voltage24h.mean)} count=${fmtNumber(b.voltage24h.count)}`,
        );
      }
      if (b.cells && b.cells.length > 0) {
        const cellLine = b.cells.map((c) => `${c.index}=${fmtNumber(c.voltage)}`).join(' ');
        lines.push(`- cells: ${cellLine}`);
      }
      lines.push('');
    }
    return { system: this.systemPrompt, user: lines.join('\n') };
  }
}

const CELL_KEY_RE = /^cell(\d+)$/;

function collectCells(node: unknown): CellSnapshot[] {
  if (!node || typeof node !== 'object') return [];
  const out: CellSnapshot[] = [];
  // Flat form: electrical.batteries.<bank>.cell<N>.voltage
  for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
    const cm = key.match(CELL_KEY_RE);
    const indexStr = cm?.[1];
    if (!indexStr) continue;
    const v = readNumberAt(val, 'voltage');
    if (v == null) continue;
    out.push({ index: Number.parseInt(indexStr, 10), voltage: v });
  }
  // Nested form: electrical.batteries.<bank>.cells.<N>.voltage
  const cellsContainer = (node as Record<string, unknown>).cells;
  if (cellsContainer && typeof cellsContainer === 'object') {
    for (const [key, val] of Object.entries(cellsContainer as Record<string, unknown>)) {
      const idx = Number.parseInt(key, 10);
      if (!Number.isFinite(idx)) continue;
      const v = readNumberAt(val, 'voltage');
      if (v == null) continue;
      out.push({ index: idx, voltage: v });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}
