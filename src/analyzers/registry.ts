import type { PluginOptions } from '../types.js';
import type { Analyzer } from './Analyzer.js';
import { AgingAnalyzer } from './aging.js';
import { AlertAnalyzer } from './alerts.js';
import { DriftAnalyzer } from './drift.js';
import { ForecastAnalyzer } from './forecast.js';
import { HealthAnalyzer } from './health.js';
import type { AnalyzerId } from './ids.js';
import { LivenessAnalyzer } from './liveness.js';
import { MaintenanceAnalyzer } from './maintenance.js';

// Per-id factory map. Each factory receives the analyzer's cfg sub-object
// (DEFAULT_OPTIONS.analyzers[id] in types.ts) and returns the live Analyzer
// instance. Keeping these here (rather than in ids.ts, which must stay free
// of analyzer-class imports to break the circular dep) lets index.ts loop
// `ANALYZER_IDS` once instead of repeating five hand-rolled if-blocks.
type AnalyzerFactories = {
  [K in AnalyzerId]: (cfg: PluginOptions['analyzers'][K]) => Analyzer;
};

export const ANALYZER_FACTORIES: AnalyzerFactories = {
  maintenance: (c) =>
    new MaintenanceAnalyzer({
      triggers: c.triggers,
      minSessionSeconds: c.minSessionSeconds,
      extraWatchedPaths: c.extraWatchedPaths,
      customSystemPrompt: c.customSystemPrompt,
    }),
  health: (c) =>
    new HealthAnalyzer({
      triggers: c.triggers,
      customSystemPrompt: c.customSystemPrompt,
    }),
  aging: (c) =>
    new AgingAnalyzer({
      triggers: c.triggers,
      shortWindowDays: c.shortWindowDays,
      longWindowDays: c.longWindowDays,
      customSystemPrompt: c.customSystemPrompt,
    }),
  drift: (c) =>
    new DriftAnalyzer({
      triggers: c.triggers,
      baselineDays: c.baselineDays,
      customSystemPrompt: c.customSystemPrompt,
    }),
  alerts: (c) =>
    new AlertAnalyzer({
      triggers: c.triggers,
      customSystemPrompt: c.customSystemPrompt,
    }),
  liveness: (c) =>
    new LivenessAnalyzer({
      triggers: c.triggers,
      stalenessThresholdSec: c.stalenessThresholdSec,
      customSystemPrompt: c.customSystemPrompt,
    }),
  forecast: (c) =>
    new ForecastAnalyzer({
      triggers: c.triggers,
      severityFloor: c.severityFloor,
      customSystemPrompt: c.customSystemPrompt,
    }),
};
