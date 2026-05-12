// Bare-string analyzer ids and their human-readable titles, kept here
// (not in registry-with-prompts) to avoid a circular import between
// registry and analyzer modules. The default-system-prompt registry lives
// in core/api.ts where it's adjacent to the route handler that needs it.
export const ANALYZER_IDS = ['maintenance', 'health', 'aging', 'drift', 'alerts'] as const;
export type AnalyzerId = (typeof ANALYZER_IDS)[number];

const ANALYZER_ID_SET: ReadonlySet<string> = new Set(ANALYZER_IDS);

export const ANALYZER_TITLES: Record<AnalyzerId, string> = {
  maintenance: 'Maintenance Advisor',
  health: 'Battery Health Advisor',
  aging: 'Battery Aging Tracker',
  drift: 'Engine Performance Drift',
  alerts: 'Battery Alerts',
};

export function isAnalyzerId(s: unknown): s is AnalyzerId {
  return typeof s === 'string' && ANALYZER_ID_SET.has(s);
}
