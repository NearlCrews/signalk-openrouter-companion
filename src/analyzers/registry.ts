import type { PluginOptions } from '../types.js';
import type { Analyzer } from './Analyzer.js';
import { AGING_DEFAULT_SYSTEM_PROMPT, AgingAnalyzer } from './aging.js';
import { ALERTS_DEFAULT_SYSTEM_PROMPT, AlertAnalyzer } from './alerts.js';
import { DRIFT_DEFAULT_SYSTEM_PROMPT, DriftAnalyzer } from './drift.js';
import { FORECAST_DEFAULT_SYSTEM_PROMPT, ForecastAnalyzer } from './forecast.js';
import { HEALTH_DEFAULT_SYSTEM_PROMPT, HealthAnalyzer } from './health.js';
import type { AnalyzerId } from './ids.js';
import { LIVENESS_DEFAULT_SYSTEM_PROMPT, LivenessAnalyzer } from './liveness.js';
import { MAINTENANCE_DEFAULT_SYSTEM_PROMPT, MaintenanceAnalyzer } from './maintenance.js';

// Per-id factory map. Each factory receives the analyzer's cfg sub-object
// (DEFAULT_OPTIONS.analyzers[id] in types.ts, already normalized by
// mergeWithDefaults) and returns the live Analyzer instance. Each section
// satisfies its analyzer's config type as is, so a new setting reaches the
// analyzer without an edit here. Keeping these here (rather than in ids.ts,
// which must stay free of analyzer-class imports to break the circular dep)
// lets index.ts loop `ANALYZER_IDS` once instead of a hand-rolled if-block per
// analyzer.
type AnalyzerFactories = {
  [K in AnalyzerId]: (cfg: PluginOptions['analyzers'][K]) => Analyzer;
};

export const ANALYZER_FACTORIES: AnalyzerFactories = {
  maintenance: (c) => new MaintenanceAnalyzer(c),
  health: (c) => new HealthAnalyzer(c),
  aging: (c) => new AgingAnalyzer(c),
  drift: (c) => new DriftAnalyzer(c),
  alerts: (c) => new AlertAnalyzer(c),
  liveness: (c) => new LivenessAnalyzer(c),
  forecast: (c) => new ForecastAnalyzer(c),
};

// Per-id default system prompt. Co-located with the factory map so adding an
// analyzer touches one file here (plus its id in ids.ts), not also core/api.ts.
// The `/api/analyzers/:id/prompt` route serves these before the runtime exists
// and for disabled analyzers, so they stay compile-time constants rather than
// being read off a live instance.
export const ANALYZER_DEFAULT_SYSTEM_PROMPTS: Record<AnalyzerId, string> = {
  maintenance: MAINTENANCE_DEFAULT_SYSTEM_PROMPT,
  health: HEALTH_DEFAULT_SYSTEM_PROMPT,
  aging: AGING_DEFAULT_SYSTEM_PROMPT,
  drift: DRIFT_DEFAULT_SYSTEM_PROMPT,
  alerts: ALERTS_DEFAULT_SYSTEM_PROMPT,
  liveness: LIVENESS_DEFAULT_SYSTEM_PROMPT,
  forecast: FORECAST_DEFAULT_SYSTEM_PROMPT,
};
