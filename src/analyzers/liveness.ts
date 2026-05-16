import { clampPositiveInt, resolveSystemPrompt } from '../core/cfg.js';
import { buildTriggers } from '../core/triggers.js';
import { type AnalyzerTriggerCfg, LIVENESS_DEFAULT_STALENESS_SEC } from '../types.js';
import type { AnalysisInput, Analyzer, AnalyzerDeps, TriggerCtx, TriggerSpec } from './Analyzer.js';
import { ANALYZER_TITLES } from './ids.js';

export interface LivenessCfg {
  triggers: AnalyzerTriggerCfg;
  stalenessThresholdSec: number;
  customSystemPrompt?: string;
}

export const LIVENESS_DEFAULT_SYSTEM_PROMPT = [
  'You are a marine systems engineer reviewing the health of a Signal K data pipeline.',
  'You are given a list of Signal K paths, each with the age of its most recent sample, a sample count, and the data sources serving it.',
  'A path marked STALE has produced no sample within the configured staleness window; a path marked FLAPPING is served by more than one source.',
  'Treat intermittently-powered equipment as expected: engine and propulsion paths (propulsion.*) go silent whenever the engine is off, so their staleness is normal and not a fault unless other data shows the engine running.',
  'Lead with the headline (overall pipeline state). Then name any genuinely stale path and any flapping path, and briefly say why it matters.',
  'If everything is reporting normally, say so plainly.',
  'Stick to the facts in the data; do not speculate about causes you cannot see.',
  'Output is rendered in the Signal K data browser as a single string. Produce one short paragraph of plain prose (80-150 words). Do not use markdown: no headers, no bullets, no horizontal rules. Use semicolons and commas to separate points.',
].join(' ');

interface PathLiveness {
  path: string;
  lastSeenAgeSec: number | null;
  stale: boolean;
  sampleCount: number;
  sources: string[];
  flapping: boolean;
}

export interface LivenessInput extends AnalysisInput {
  generatedAt: string;
  stalenessThresholdSec: number;
  paths: PathLiveness[];
}

export class LivenessAnalyzer implements Analyzer<LivenessInput> {
  readonly id = 'liveness';
  readonly title = ANALYZER_TITLES.liveness;
  readonly triggers: ReadonlyArray<TriggerSpec>;
  private readonly systemPrompt: string;
  private readonly stalenessThresholdSec: number;

  constructor(cfg: LivenessCfg) {
    this.triggers = buildTriggers(cfg.triggers);
    this.stalenessThresholdSec = clampPositiveInt(
      cfg.stalenessThresholdSec,
      LIVENESS_DEFAULT_STALENESS_SEC,
    );
    this.systemPrompt = resolveSystemPrompt(cfg.customSystemPrompt, LIVENESS_DEFAULT_SYSTEM_PROMPT);
  }

  async collectContext(ctx: TriggerCtx, deps: AnalyzerDeps): Promise<LivenessInput | null> {
    const firedMs = ctx.firedAt.getTime();
    const paths: PathLiveness[] = [];
    for (const path of deps.buffer.pathKeys()) {
      const entries = deps.buffer.slice(path, 0, firedMs);
      let newestTs: number | null = null;
      const sources = new Set<string>();
      for (const e of entries) {
        if (newestTs == null || e.ts > newestTs) newestTs = e.ts;
        sources.add(e.source);
      }
      const lastSeenAgeSec = newestTs == null ? null : (firedMs - newestTs) / 1000;
      const sortedSources = Array.from(sources).sort();
      paths.push({
        path,
        lastSeenAgeSec,
        stale: lastSeenAgeSec == null || lastSeenAgeSec > this.stalenessThresholdSec,
        sampleCount: entries.length,
        sources: sortedSources,
        flapping: sortedSources.length > 1,
      });
    }
    if (paths.length === 0) return null;
    paths.sort((a, b) => a.path.localeCompare(b.path));
    return {
      generatedAt: new Date(firedMs).toISOString(),
      stalenessThresholdSec: this.stalenessThresholdSec,
      paths,
    };
  }

  buildPrompt(input: LivenessInput): { system: string; user: string } {
    const lines: string[] = [];
    lines.push(`## Generated ${input.generatedAt}`);
    lines.push(`## Staleness threshold: ${input.stalenessThresholdSec}s`);
    lines.push('');
    for (const p of input.paths) {
      const age =
        p.lastSeenAgeSec == null ? 'no samples retained' : `${p.lastSeenAgeSec.toFixed(0)}s ago`;
      const flags = [p.stale ? 'STALE' : null, p.flapping ? 'FLAPPING' : null]
        .filter((f) => f != null)
        .join(' ');
      lines.push(
        `- ${p.path}: last sample ${age}; ${p.sampleCount} samples; sources=[${p.sources.join(', ')}]${
          flags ? ` ${flags}` : ''
        }`,
      );
    }
    return { system: this.systemPrompt, user: lines.join('\n') };
  }
}
