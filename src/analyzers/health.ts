import type { BufferSummary } from '../core/buffer.js';
import {
  BATTERY_SI_UNITS_INSTRUCTION,
  generatedLine,
  REPORT_BODY_INSTRUCTION,
  REPORT_HEADLINE_INSTRUCTION,
  resolveSystemPrompt,
  sanitizeProducerString,
} from '../core/cfg.js';
import { DAY_MS, fmtNumber } from '../core/format.js';
import { bankPaths } from '../core/paths.js';
import {
  pushBankLines,
  readBankNodes,
  readBankSnapshot,
  readNumberAt,
  type BankSnapshot as SkBankSnapshot,
} from '../core/skNode.js';
import { buildTriggers } from '../core/triggers.js';
import type {
  AnalysisInput,
  Analyzer,
  AnalyzerBaseCfg,
  AnalyzerDeps,
  PromptPair,
  TriggerCtx,
  TriggerSpec,
} from './Analyzer.js';
import { ANALYZER_TITLES } from './ids.js';

export type HealthCfg = AnalyzerBaseCfg;

export const HEALTH_DEFAULT_SYSTEM_PROMPT = [
  'You are an experienced marine electrical specialist reading raw battery telemetry from a Signal K server.',
  BATTERY_SI_UNITS_INSTRUCTION,
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
    const banksRaw = readBankNodes(deps.app);
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

  buildPrompt(input: HealthInput): PromptPair {
    const banks = input.banks;

    const lines: string[] = [];
    lines.push(generatedLine(input.generatedAt));
    lines.push('');
    for (const b of banks) {
      pushBankLines(lines, sanitizeProducerString(b.id), b, [
        { label: 'voltage 24h', summary: b.voltage24h },
      ]);
      if (b.cells) {
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
