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
