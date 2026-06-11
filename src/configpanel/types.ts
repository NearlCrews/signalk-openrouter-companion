// Panel-facing types. These describe only the slices of the plugin config and
// the REST payloads the panel actually reads, kept local so the panel bundle
// stays decoupled from the backend's full runtime types. The rjsf schema in
// src/schema.ts remains the authoritative storage shape.

// The analyzer's standardized trigger block, as the panel edits it.
export interface AnalyzerTriggerConfig {
  cron?: { pattern?: string; enabled?: boolean; timezone?: string };
}

// One analyzer's slice of the saved config (the panel only writes these keys).
export interface AnalyzerConfig {
  enabled?: boolean;
  customSystemPrompt?: string;
  severityFloor?: string;
  triggers?: AnalyzerTriggerConfig;
}

// The edit buffer the panel maintains and saves. Every key is optional: a
// fresh install pushes an empty object and the server fills defaults.
export interface PanelConfig {
  openrouter?: { apiKey?: string; model?: string; maxCallsPerDay?: number };
  questdb?: { enabled?: boolean; url?: string };
  analyzers?: Record<string, AnalyzerConfig>;
}

// The /status payload (mirror of StatusResponse in src/core/api.ts).
export interface AnalyzerStatus {
  id: string;
  title: string;
  enabled: boolean;
  cron: { enabled: boolean; pattern: string };
  // Whether this analyzer exposes a severity-floor setting. Optional so an
  // older server payload without the field reads as "no floor".
  hasSeverityFloor?: boolean;
}

export interface PanelStatus {
  startedAt: number;
  openrouter: {
    apiKeySet: boolean;
    model: string;
    callsToday: number;
    maxCallsPerDay: number;
  };
  questdb: { enabled: boolean; reachable: boolean | null };
  analyzers: AnalyzerStatus[];
}

// One OpenRouter model in the autocomplete datalist.
export interface ModelOption {
  id: string;
  name?: string;
}

// A single rendered report row (a slice of the on-disk JsonlEntry).
export interface ReportEntry {
  ts: string;
  trigger: string;
  engineId?: string;
  durationSec?: number;
  report?: string;
  failure?: string;
}

export type ModelsState = 'idle' | 'loading' | 'ready' | 'error';

// Per-analyzer UI state, stored on the consolidated analyzerUi map and patched
// via patchUi. One entry per analyzer id.
export interface AnalyzerUiState {
  expanded?: boolean;
  fire?: { pending?: boolean; ok?: boolean; text?: string };
  reportsOpen?: boolean;
  reports?: ReportEntry[];
  reportsLoading?: boolean;
  reportsError?: string | null;
  promptOpen?: boolean;
  promptLoaded?: boolean;
  promptError?: string | null;
  promptDefault?: string;
  promptCurrent?: string | null;
}

// The two-phase post-save notice shown beside the Save button.
export interface SavedNotice {
  at: string;
  phase: 'restarting' | 'done';
  error?: string;
}

export interface TestResult {
  ok: boolean;
  text: string;
}

// The QuestDB probe result: a reachable URL or a failure message.
export type QdbTestResult = { ok: true; url: string } | { ok: false; text: string };

// The standard envelope every panel REST call resolves to.
export interface FetchResult<T = unknown> {
  ok: boolean;
  status: number;
  body: T | null;
  error: string | null;
}
