import { CRON_PRESETS } from '../cronPresets.js';

export interface ScheduleOption {
  value: string;
  label: string;
}

// Build the frequency <select> option list so the controlled value is always in
// the option set: an unset pattern gets a leading "Not set" entry, a preset
// pattern uses the shared list as-is, and a saved non-preset (a hand-edited
// cron persisted in the JSON config) is appended as a "Custom" entry so the
// dropdown never blanks. Extracted from AnalyzerRow's three-branch ternary so it
// is readable and unit-testable.
export function buildScheduleOptions(schedule: string): ReadonlyArray<ScheduleOption> {
  if (!schedule) return [{ value: '', label: 'Not set' }, ...CRON_PRESETS];
  // The preset case runs on every analyzer-row render; return the shared list
  // rather than copying it (the readonly return type keeps callers honest).
  if (CRON_PRESETS.some((o) => o.value === schedule)) return CRON_PRESETS;
  return [...CRON_PRESETS, { value: schedule, label: `Custom: ${schedule}` }];
}
