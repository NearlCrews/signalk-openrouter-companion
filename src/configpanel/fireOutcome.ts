// Maps the /fire endpoint's run outcome to the message shown beside the Fire
// button, so a no-op fire reads as "Nothing to report" rather than a misleading
// success. `unknown` covers the runById path where the analyzer id is not
// registered; the REST /fire endpoint pre-guards with 409, but the panel covers
// it too so any future code path that bypasses the pre-guard reads correctly.
// Kept in a plain module (no JSX) so it is unit-testable on its own. The map is
// module-private; callers go through fireOutcomeText so the fallback is never
// bypassed.
const FIRE_OUTCOME_TEXT: Record<string, string> = {
  reported: 'Report generated',
  'no-input': 'Nothing to report',
  'budget-exhausted': 'Daily call budget exhausted',
  failed: 'Analysis failed (check notifications)',
  unknown: 'Analyzer not registered',
};

// Outcomes that read as a failure (danger color); everything else is a normal
// success or a benign no-op.
const FIRE_FAILURE_OUTCOMES: ReadonlySet<string> = new Set(['failed', 'unknown']);

// Text shown beside the Fire button. An unmapped or missing outcome falls back
// to a neutral "Dispatched" so a new server outcome never renders blank.
export function fireOutcomeText(outcome: string | undefined): string {
  return (outcome && FIRE_OUTCOME_TEXT[outcome]) ?? 'Dispatched';
}

// Whether a fire outcome should read as success (vs the danger color). A missing
// or unmapped outcome reads as success so a benign no-op is not styled as a
// failure.
export function isFireSuccess(outcome: string | undefined): boolean {
  return outcome === undefined || !FIRE_FAILURE_OUTCOMES.has(outcome);
}
