import type { TriggerKind } from '../core/triggerContext.js';

// Maps the trigger kind a report row carries (TriggerCtx.kind, written by
// core/publisher.ts) to interface copy, so the reports drawer reads as a list
// of runs rather than a log file. Kept in a plain module (no JSX) so it is
// unit-testable on its own, alongside fireOutcome.ts. Keyed on TriggerKind, so
// a seventh trigger is a compile error here rather than a raw wire string in
// the reports drawer.
const REPORT_TRIGGER_TEXT: Record<TriggerKind, string> = {
  cron: 'Scheduled',
  put: 'Manual run',
  'engine-start': 'Engine start',
  'engine-stop': 'Engine stop',
  'possible-stop': 'Possible engine stop',
  'battery-event': 'Battery event',
};

// A kind this panel build does not know about renders as the server sent it,
// which stays legible and never blanks the line.
export function reportTriggerLabel(trigger: string): string {
  return Object.hasOwn(REPORT_TRIGGER_TEXT, trigger)
    ? REPORT_TRIGGER_TEXT[trigger as TriggerKind]
    : trigger;
}
