// Maps the /fire endpoint's run outcome to the message shown beside the Fire
// button, so a no-op fire reads as "Nothing to report" rather than a misleading
// success. `unknown` covers the runById path where the analyzer id is not
// registered; the REST /fire endpoint pre-guards with 409, but the panel covers
// it too so any future code path that bypasses the pre-guard reads correctly.
// Kept in a plain module (no JSX) so it is unit-testable on its own. The map is
// module-private; callers go through fireOutcomeText so the fallback is never
// bypassed. It carries one entry per member of RunOutcome in
// core/triggerRouter.ts, and a case in tests/configpanel.test.ts reads that
// union out of the source and fails when one has no entry here: an unmapped
// outcome reaches the operator as the neutral "Dispatched" fallback, which
// reads as a run that went out fine.
const FIRE_OUTCOME_TEXT: Record<string, string> = {
  reported: 'Report generated',
  'no-input': 'Nothing to report',
  'budget-exhausted': 'Daily call budget exhausted',
  failed: 'Analysis failed (check notifications)',
  unknown: 'Analyzer not registered',
  'already-running': 'Already running',
  aborted: 'Interrupted by shutdown',
  queued: 'Queued behind the current run',
};

// Outcomes that read as a failure (danger color); everything else is a normal
// success or a benign no-op.
//
// `aborted` is a failure rather than a no-op. It covers two shutdown paths, one
// before the LLM call that spends nothing and one after it that has already
// recorded a call, so a press may or may not have cost money; neither publishes
// a report, which is what settles the tone. Green beside "Interrupted by
// shutdown" would contradict its own text. `queued` stays a success because the
// run is deferred, not dropped: the router starts it as soon as the in-flight
// run of the same subject settles.
const FIRE_FAILURE_OUTCOMES: ReadonlySet<string> = new Set(['failed', 'unknown', 'aborted']);

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
