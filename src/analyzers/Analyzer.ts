export type TriggerSpec =
  | { kind: 'engine-start' }
  | { kind: 'engine-stop' }
  | { kind: 'possible-stop' }
  | { kind: 'put'; path: string }
  | { kind: 'cron'; pattern: string }
  | { kind: 'battery-event'; subkind: BatteryEventKind };

export type BatteryEventKind =
  | 'low-soc-enter'
  | 'low-soc-exit'
  | 'cell-imbalance-enter'
  | 'cell-imbalance-exit';

export type TriggerKind = TriggerSpec['kind'];

export interface EngineSessionCtx {
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

export type AnalysisInput = Record<string, unknown>;

export interface AppForAnalyzer {
  getSelfPath(path: string): unknown;
  selfContext?: string;
}

export interface AnalyzerDeps {
  buffer: import('../core/buffer.js').RollingBuffer;
  questdb: import('../core/questdb.js').QuestDBClient | null;
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
  collectContext(ctx: TriggerCtx, deps: AnalyzerDeps): Promise<I | null>;
  buildPrompt(input: I): { system: string; user: string };
  // Optional. When omitted, the TriggerRouter publishes via
  // `deps.publisher.publishReport(this.id, ctx, text)` on the canonical
  // `notifications.openrouter-companion.<id>.report` path with
  // `state: 'nominal'`. Override only when an analyzer needs a different
  // path or state, e.g. `alerts` uses `deps.publisher.publishOnPath` with
  // a per-event canonical path and explicit alert state.
  publishOutput?(
    text: string,
    ctx: TriggerCtx,
    deps: AnalyzerDeps,
    run?: PublishRunMeta,
  ): Promise<void>;
}
