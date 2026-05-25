import type { TriggerCtx, TriggerSpec } from '../analyzers/Analyzer.js';
import type { AnalyzerId } from '../analyzers/ids.js';
import type { AnalyzerTriggerCfg } from '../types.js';
import { pluginPutPath } from './paths.js';

// Every analyzer wires the same cron + put parsing from its triggers cfg, then
// optionally maps each event subkind string to an analyzer-specific TriggerSpec.
// Centralized here so adding an analyzer can't drift from the canonical shape.
// The PUT path is derived from the analyzer id (the convention is fixed at
// `plugins.openrouter-companion.<id>.run`), so the analyzer's TriggerSpec[]
// and the PUT handler registered in index.ts share one definition of the path.
export function buildTriggers(
  analyzerId: AnalyzerId,
  cfg: AnalyzerTriggerCfg,
  eventMapper?: (sub: string) => TriggerSpec | null,
): TriggerSpec[] {
  const out: TriggerSpec[] = [];
  if (cfg.cron.enabled && cfg.cron.pattern) {
    out.push({ kind: 'cron', pattern: cfg.cron.pattern });
  }
  if (cfg.put.enabled) {
    out.push({ kind: 'put', path: pluginPutPath(analyzerId) });
  }
  if (eventMapper) {
    for (const sub of cfg.events) {
      const spec = eventMapper(sub);
      if (spec) out.push(spec);
    }
  }
  return out;
}

// Synthesize the TriggerCtx for a manual fire (REST /api/analyzers/:id/fire
// or PUT). Shared so the two call sites can't drift on shape.
export function manualPutCtx(value: unknown = 'manual'): TriggerCtx {
  return { kind: 'put', firedAt: new Date(), put: { value } };
}
