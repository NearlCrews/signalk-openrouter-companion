import type { TriggerSpec } from '../analyzers/Analyzer.js';
import type { AnalyzerTriggerCfg } from '../types.js';

// Every analyzer wires the same cron + put parsing from its triggers cfg, then
// optionally maps each event subkind string to an analyzer-specific TriggerSpec.
// Centralized here so adding an analyzer can't drift from the canonical shape.
export function buildTriggers(
  cfg: AnalyzerTriggerCfg,
  eventMapper?: (sub: string) => TriggerSpec | null,
): TriggerSpec[] {
  const out: TriggerSpec[] = [];
  if (cfg.cron.enabled && cfg.cron.pattern) {
    out.push({ kind: 'cron', pattern: cfg.cron.pattern });
  }
  if (cfg.put.enabled && cfg.put.path) {
    out.push({ kind: 'put', path: cfg.put.path });
  }
  if (eventMapper) {
    for (const sub of cfg.events) {
      const spec = eventMapper(sub);
      if (spec) out.push(spec);
    }
  }
  return out;
}
