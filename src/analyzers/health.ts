import type { BufferSummary } from '../core/buffer.js';
import {
  REPORT_BODY_INSTRUCTION,
  REPORT_HEADLINE_INSTRUCTION,
  resolveSystemPrompt,
} from '../core/cfg.js';
import { DAY_MS, fmtNumber } from '../core/format.js';
import { BATTERIES_PARENT_PATH, bankPaths } from '../core/paths.js';
import {
  asTreeMap,
  readBankSnapshot,
  readNumberAt,
  type BankSnapshot as SkBankSnapshot,
} from '../core/skNode.js';
import { buildTriggers } from '../core/triggers.js';
import type { AnalyzerTriggerCfg } from '../types.js';
import type { AnalysisInput, Analyzer, AnalyzerDeps, TriggerCtx, TriggerSpec } from './Analyzer.js';
import { ANALYZER_TITLES } from './ids.js';

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
  REPORT_HEADLINE_INSTRUCTION,
  REPORT_BODY_INSTRUCTION,
  'Mention each bank by name in one tight clause covering SoC, voltage, balance, and anything notable.',
].join(' ');

interface CellSnapshot {
  index: number;
  voltage: number;
}

interface HealthBankSnapshot extends SkBankSnapshot {
  id: string;
  voltage24h: BufferSummary | null;
  cells: CellSnapshot[] | null;
}

export interface HealthInput extends AnalysisInput {
  generatedAt: string;
  banks: HealthBankSnapshot[];
}

export class HealthAnalyzer implements Analyzer<HealthInput> {
  readonly id = 'health';
  readonly title = ANALYZER_TITLES.health;
  readonly triggers: ReadonlyArray<TriggerSpec>;
  private readonly systemPrompt: string;

  constructor(cfg: HealthCfg) {
    this.triggers = buildTriggers(this.id, cfg.triggers);
    this.systemPrompt = resolveSystemPrompt(cfg.customSystemPrompt, HEALTH_DEFAULT_SYSTEM_PROMPT);
  }

  async collectContext(ctx: TriggerCtx, deps: AnalyzerDeps): Promise<HealthInput | null> {
    const tree = asTreeMap(deps.app.getSelfPath(BATTERIES_PARENT_PATH));
    if (!tree) return null;
    // Skip any non-bank child of `electrical.batteries`: a future SK release
    // could attach container-level metadata leaves (`meta`, `$source`,
    // `value`, `timestamp`, ...). A real bank carries at least one of the
    // canonical fields below; anything else is rejected so phantom bank ids
    // never reach the prompt.
    const banksRaw = Object.entries(tree).filter(([_, node]) => isBankNode(node));
    if (banksRaw.length === 0) return null;

    const endMs = ctx.firedAt.getTime();
    const startMs = endMs - DAY_MS;

    const banks: HealthBankSnapshot[] = banksRaw.map(([id, node]) => {
      const cells = collectCells(node);
      return {
        id,
        ...readBankSnapshot(node),
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

// Canonical fields any real battery bank subtree exposes. Mirrors the gate
// in src/analyzers/maintenance.ts so both analyzers reject metadata leaves
// the same way.
const BANK_FIELD_KEYS: ReadonlyArray<string> = ['voltage', 'current', 'capacity', 'temperature'];

function isBankNode(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return false;
  if ('value' in (node as object)) return false;
  return BANK_FIELD_KEYS.some((k) => k in (node as object));
}
