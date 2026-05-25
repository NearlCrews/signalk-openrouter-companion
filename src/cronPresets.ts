// Single source of truth for the scheduled-analyzer "frequency" dropdown.
//
// Both UIs consume this list:
//  - the rjsf fallback schema (src/schema.ts) renders it as enum + enumNames,
//  - the custom React config panel (src/configpanel) renders it as the
//    schedule <select> in AnalyzerRow.jsx.
//
// Every analyzer's default cron pattern MUST appear here. A default that is
// not a preset renders as a non-selectable "Custom" entry instead of a clean
// choice. The four cron-driven analyzer defaults today are the daily-8AM,
// monthly-1st, weekly-Sunday, and every-3-hours entries below (health and
// liveness, aging, drift, and forecast respectively).
interface CronPreset {
  /** A 5-field cron pattern. */
  value: string;
  /** Human-readable label shown in the dropdown. */
  label: string;
}

export const CRON_PRESETS: readonly CronPreset[] = [
  { value: '0 * * * *', label: 'Hourly' },
  { value: '0 */3 * * *', label: 'Every 3 hours' },
  { value: '0 */6 * * *', label: 'Every 6 hours' },
  { value: '0 */12 * * *', label: 'Every 12 hours' },
  { value: '0 8 * * *', label: 'Daily (8 AM)' },
  { value: '0 8 * * 0', label: 'Weekly (Sun 8 AM)' },
  { value: '0 8 1 * *', label: 'Monthly (1st, 8 AM)' },
];
