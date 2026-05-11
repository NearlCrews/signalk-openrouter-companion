export type TriggerSpec =
  | { kind: 'engine-start' }
  | { kind: 'engine-stop' }
  | { kind: 'possible-stop' }
  | { kind: 'put'; path: string }
  | { kind: 'cron'; pattern: string }
  | { kind: 'sk-notification'; pathPattern: string };

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
  requestRestart?: () => void;
}

export interface Analyzer {
  readonly id: string;
  readonly title: string;
  readonly triggers: ReadonlyArray<TriggerSpec>;
  collectContext(ctx: TriggerCtx, deps: AnalyzerDeps): Promise<AnalysisInput | null>;
  buildPrompt(input: AnalysisInput): { system: string; user: string };
  publishOutput?(text: string, ctx: TriggerCtx, deps: AnalyzerDeps): Promise<void>;
}
