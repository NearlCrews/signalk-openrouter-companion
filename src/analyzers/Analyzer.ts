// The trigger vocabulary is defined in core (see core/triggerContext.ts for
// why) and re-exported here, so an analyzer imports everything it needs from
// one module while `ReportPublisher` takes the same types from their definition
// site rather than importing the analyzer layer. Core modules import from
// core/triggerContext.js directly; the analyzers, the plugin lifecycle, and the
// schema come through here.
export type {
  BatteryEventKind,
  PublishRunMeta,
  TriggerCtx,
  TriggerSpec,
} from '../core/triggerContext.js';

import type { PublishRunMeta, TriggerCtx, TriggerSpec } from '../core/triggerContext.js';

export type AnalysisInput = Record<string, unknown>;

interface AppForAnalyzer {
  getSelfPath(path: string): unknown;
  selfContext?: string;
}

export interface AnalyzerDeps {
  buffer: import('../core/buffer.js').RollingBuffer;
  history: import('../core/history.js').HistoryProvider | null;
  publisher: import('../core/publisher.js').ReportPublisher;
  budget: import('../core/budget.js').BudgetTracker;
  llm: import('../core/openrouter.js').OpenRouterClient;
  logger: import('../core/logger.js').Logger;
  app: AppForAnalyzer;
  setStatus?: (msg: string) => void;
  // The "all healthy" status string the router uses when recovering from a
  // budget-exhausted state. index.ts populates with the analyzer-count aware
  // banner so recovery matches the startup message.
  okStatus?: string;
  // The plugin lifecycle abort signal. The router bails before spending budget
  // if it has fired, and passes it to the LLM call so a shutdown cancels an
  // in-flight request.
  signal?: AbortSignal;
}

export interface Analyzer<I extends AnalysisInput = AnalysisInput> {
  readonly id: import('./ids.js').AnalyzerId;
  readonly title: string;
  readonly triggers: ReadonlyArray<TriggerSpec>;
  // Fixed Signal K self-paths this analyzer needs buffered that are not
  // discovered from the live tree (engines and battery banks are discovered;
  // weather leaves are fixed canonical strings). The lifecycle subscribes the
  // union across enabled analyzers, so an analyzer declares its own data need
  // here instead of index.ts special-casing it by id.
  readonly watchedPaths?: ReadonlyArray<string>;
  // When true, a failed analyzer run publishes an AUDIBLE failure notification
  // (method ['visual','sound']); when false or omitted it publishes visual-only
  // (silent). Default silent: the narrative analyzers are best-effort, so a
  // failed monthly aging summary or weather outlook must not sound the helm
  // alarm. The safety `alerts` analyzer sets this true, so a sustained failure
  // to produce a battery alert still beeps. See publisher.publishFailure.
  readonly failureAudible?: boolean;
  // Optional. The subject one run acts on, when an analyzer's runs are
  // independent per subject rather than per analyzer. The router serializes
  // its in-flight guard on the analyzer id plus this key, so two battery banks
  // crossing the same threshold never contend, while an alert and the recovery
  // that clears it (same bank, same kind, same Signal K path) still run in
  // order. Return null, or omit the method, when every run of the analyzer
  // acts on the same subject and one run at a time is correct.
  runKey?(ctx: TriggerCtx): string | null;
  collectContext(ctx: TriggerCtx, deps: AnalyzerDeps): Promise<I | null>;
  buildPrompt(input: I): { system: string; user: string };
  // Optional. When omitted, the TriggerRouter publishes via
  // `deps.publisher.publishReport(this.id, ctx, text)` on the canonical
  // `notifications.openrouter-companion.<id>.report` path with
  // `state: 'nominal'`. Override only when an analyzer needs a different
  // path or state, e.g. `alerts` uses `deps.publisher.publishOnPath` with
  // a per-event canonical path and explicit alert state.
  // `input` is what `collectContext` returned for this run, so an analyzer
  // that has to check the model's answer against the telemetry behind it
  // (forecast weighs a graded outlook against the observed trend) reads the
  // numbers here rather than stashing them on the instance.
  publishOutput?(
    text: string,
    ctx: TriggerCtx,
    deps: AnalyzerDeps,
    run?: PublishRunMeta,
    input?: I,
  ): Promise<void>;
}
