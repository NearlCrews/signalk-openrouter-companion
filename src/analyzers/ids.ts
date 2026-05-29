// Bare-string analyzer ids and their human-readable titles, kept here (free of
// analyzer-class imports) to avoid a circular import between registry and
// analyzer modules. The factory map and the default-system-prompt registry
// both live in registry.ts, which already imports every analyzer module.
export const ANALYZER_IDS = [
  'maintenance',
  'health',
  'aging',
  'drift',
  'alerts',
  'liveness',
  'forecast',
] as const;
export type AnalyzerId = (typeof ANALYZER_IDS)[number];

const ANALYZER_ID_SET: ReadonlySet<string> = new Set(ANALYZER_IDS);

export const ANALYZER_TITLES: Record<AnalyzerId, string> = {
  maintenance: 'Maintenance Advisor',
  health: 'Battery Health Advisor',
  aging: 'Battery Aging Tracker',
  drift: 'Engine Performance Drift',
  alerts: 'Battery Alerts',
  liveness: 'Sensor Liveness Monitor',
  forecast: 'Weather Outlook Advisor',
};

export function isAnalyzerId(s: unknown): s is AnalyzerId {
  return typeof s === 'string' && ANALYZER_ID_SET.has(s);
}
