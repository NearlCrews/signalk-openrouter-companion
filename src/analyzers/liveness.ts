import {
  clampPositiveInt,
  REPORT_BODY_INSTRUCTION,
  REPORT_HEADLINE_INSTRUCTION,
  resolveSystemPrompt,
} from '../core/cfg.js';
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
  'A path marked STALE has produced no sample within the configured staleness window.',
  'A path marked MULTI-SOURCE is served by more than one source. Multiple sources on a path is often intentional sensor redundancy (for example two GPS units or two depth sounders) and is healthy; treat it as a concern only when it looks like one physical device publishing under duplicate source labels.',
  'Treat intermittently-powered equipment as expected: engine and propulsion paths (propulsion.*) go silent whenever the engine is off, so their staleness is normal and not a fault unless other data shows the engine running.',
  'In the report, name any genuinely stale path, and any multi-source path that looks like duplicate labelling rather than real redundancy, and briefly say why it matters.',
  'If everything is reporting normally, say so plainly.',
  'Stick to the facts in the data; do not speculate about causes you cannot see.',
  REPORT_HEADLINE_INSTRUCTION,
  REPORT_BODY_INSTRUCTION,
].join(' ');

export interface PathLiveness {
  path: string;
  lastSeenAgeSec: number | null;
  stale: boolean;
  sampleCount: number;
  sources: string[];
  multiSource: boolean;
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
    // min mirrors the schema (stalenessThresholdSec minimum 30) so a value
    // from a hand-edited JSON config is clamped at runtime too.
    this.stalenessThresholdSec = clampPositiveInt(
      cfg.stalenessThresholdSec,
      LIVENESS_DEFAULT_STALENESS_SEC,
      { min: 30 },
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
        multiSource: sortedSources.length > 1,
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
      const flags: string[] = [];
      if (p.stale) flags.push('STALE');
      if (p.multiSource) flags.push('MULTI-SOURCE');
      lines.push(
        `- ${p.path}: last sample ${age}; ${p.sampleCount} samples; sources=[${p.sources.join(', ')}]${
          flags.length > 0 ? ` ${flags.join(' ')}` : ''
        }`,
      );
    }
    return { system: this.systemPrompt, user: lines.join('\n') };
  }
}
