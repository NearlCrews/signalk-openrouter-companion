// Forecast severity-floor preset list: single source of truth shared with
// the rjsf schema (enum + enumNames) and the React panel (dropdown options),
// mirroring the cron-preset pattern in `src/cronPresets.ts`. Keeping value
// and label together prevents the schema's enumNames from drifting out of
// sync with the panel's labels (an instance of the anti-pattern CLAUDE.md
// calls out for cron presets).
export const SEVERITY_FLOOR_PRESETS = [
  { value: 'severe', label: 'Severe only' },
  { value: 'moderate', label: 'Moderate and up' },
  { value: 'minor', label: 'Any deterioration' },
] as const;

export type SeverityFloorPresetValue = (typeof SEVERITY_FLOOR_PRESETS)[number]['value'];

// 'moderate' raises an alarm on a moderate or severe outlook; below the
// floor the outlook still publishes at `nominal` state so it stays readable.
export const DEFAULT_SEVERITY_FLOOR_VALUE: SeverityFloorPresetValue = 'moderate';
