// The trigger vocabulary: what can fire an analyzer run, what one occurrence of
// that looks like, and what the LLM call behind it cost.
//
// These types live in `core` rather than in `analyzers/Analyzer.ts` because
// both layers need them and only one direction is sound. `ReportPublisher` is a
// core service that stamps a notification and a log row from the run's context;
// it must not import the analyzer layer to do that. Defining the vocabulary
// here leaves `analyzers -> core` as the only edge between the two, and
// `Analyzer.ts` re-exports these names so an analyzer still imports its whole
// vocabulary from one place.
//
// Types only: this module imports nothing, so it cannot grow an edge back into
// either layer.

export type BatteryEventKind =
  | 'low-soc-enter'
  | 'low-soc-exit'
  | 'cell-imbalance-enter'
  | 'cell-imbalance-exit';

export type TriggerSpec =
  | { kind: 'engine-start' }
  | { kind: 'engine-stop' }
  | { kind: 'possible-stop' }
  | { kind: 'put'; path: string }
  | { kind: 'cron'; pattern: string }
  | { kind: 'battery-event'; subkind: BatteryEventKind };

export type TriggerKind = TriggerSpec['kind'];

// Outcome of one analyzer run, decided by the TriggerRouter (which re-exports
// this name) and read as far away as the configuration panel, which turns each
// one into the words shown beside the Fire button. It lives here with the rest
// of the run vocabulary so the panel can have the compiler check that every
// outcome has words, without importing the router.
//
// `unknown` distinguishes "no analyzer with that id" from `no-input`
// ("collectContext returned nothing"); the REST endpoint pre-guards unknown ids
// with a 409, but in-process callers may not. `aborted` is a run the plugin
// shutdown interrupted, kept distinct from `no-input` because it may already
// have spent a budget call. `queued` is an event trigger deferred behind a run
// of the same subject; it runs when that one settles, so it is neither a report
// nor a drop.
export type RunOutcome =
  | 'reported'
  | 'no-input'
  | 'budget-exhausted'
  | 'failed'
  | 'unknown'
  | 'already-running'
  | 'aborted'
  | 'queued';

// Only reached through TriggerCtx.engineSession, so it stays module-private the
// way it was when it lived in the analyzer layer.
interface EngineSessionCtx {
  engineId: string;
  start: Date;
  end: Date;
  durationSec: number;
}

export interface TriggerCtx {
  kind: TriggerKind;
  firedAt: Date;
  engineSession?: EngineSessionCtx;
  put?: { value: unknown };
  notification?: { path: string; value: unknown };
  bankId?: string;
  batteryEvent?: { subkind: BatteryEventKind; soc?: number; imbalanceV?: number };
}

export interface PublishRunMeta {
  model: string;
  usage: { totalTokens: number; cachedTokens: number; cost: number };
}
