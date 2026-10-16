import { baseUrlProblem, type HistorySource } from '../historyConfig.js';
import type { PanelConfig } from './types.js';

// Structural equality used to detect a dirty edit buffer and to skip
// redundant status-state updates. Order-insensitive on object keys: the panel
// edit buffer and the saved JSON can be structurally equal but key-ordered
// differently, which a naive JSON.stringify compare would flag as dirty.
export function jsonEqual(a: unknown, b: unknown): boolean {
  return deepEqual(a ?? null, b ?? null);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  // Ignore explicit-undefined values to match JSON.stringify semantics:
  // onPromptReset writes { customSystemPrompt: undefined } into cfg, which
  // would otherwise show as a key that pristine (deserialized JSON, which
  // drops undefined) does not have. This runs on every keystroke (dirty memo)
  // and every status poll, so iterate the keys directly instead of building
  // filtered key arrays; matching defined-key counts plus a per-key match
  // proves the defined-key sets are equal.
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  let aDefined = 0;
  for (const k in ao) {
    if (!Object.hasOwn(ao, k) || ao[k] === undefined) continue;
    aDefined += 1;
    if (bo[k] === undefined) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  let bDefined = 0;
  for (const k in bo) {
    if (Object.hasOwn(bo, k) && bo[k] !== undefined) bDefined += 1;
  }
  return aDefined === bDefined;
}

// Whether the prompt text differs from the analyzer's built-in default. A
// missing default (the prompt fetch failed) counts as an override so the edit
// buffer is not silently discarded. Single-sources the "is this a custom
// override" rule shared by the prompt drawer's label and the panel's
// typed-back-to-default detection.
export function isPromptOverride(value: string, promptDefault: string | undefined): boolean {
  return value !== promptDefault;
}

// What the operator is told when the model catalog cannot be loaded. Written
// once because the banner shows it and the announcer speaks it, and the two
// must not drift.
export const MODELS_ERROR = 'Could not load the model list. Type a model slug manually, or retry.';

// What the panel calls each history provider: the provider dropdown and the
// status tile both name them, so the two cannot spell a provider differently.
export const HISTORY_SOURCE_LABELS: Record<HistorySource, string> = {
  none: 'Disabled',
  questdb: 'QuestDB',
  influxdb: 'InfluxDB',
};

// A US dollar amount the way the panel shows OpenRouter spend: four decimals,
// because a single call usually costs a fraction of a cent.
export function formatUsd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

// The base-URL rule, written once. Both the history field error and the
// save-blocked notice quote it, so a wording change cannot leave the two
// describing different rules.
export const HISTORY_URL_RULE =
  'HTTP or HTTPS base URL without credentials, a query, or a fragment';

export interface HistoryValidity {
  source: HistorySource;
  noUrl: boolean;
  invalidUrl: boolean;
  missingDatabase: boolean;
}

// Single derivation of the history-provider validation state. The panel gates
// Save on it and HistorySection marks the offending field from it, so the two
// can never disagree about which value is wrong or which message to show.
export function historyValidity(history: PanelConfig['history']): HistoryValidity {
  const source = history?.source ?? 'questdb';
  const url = source === 'influxdb' ? history?.influxdb?.url : history?.questdb?.url;
  const noUrl = source !== 'none' && !url?.trim();
  return {
    source,
    noUrl,
    invalidUrl: source !== 'none' && !noUrl && !isHttpUrl(url),
    missingDatabase: source === 'influxdb' && !history?.influxdb?.database?.trim(),
  };
}

// The error a history provider's URL field shows, or undefined when it has
// none. Both providers' fields ask the same two questions in the same order, so
// they ask them through one function: `missing` is the only thing that differs,
// and the invalid case quotes the shared rule. Nothing is an error until a save
// was actually blocked here, so a pristine panel accuses the operator of
// nothing.
export function urlError(
  submitted: boolean,
  validity: HistoryValidity,
  missing: string,
): string | undefined {
  if (!submitted) return undefined;
  if (validity.noUrl) return missing;
  return validity.invalidUrl ? `Enter an ${HISTORY_URL_RULE}.` : undefined;
}

// Whether a value is a usable history-provider base URL, by the rule the
// plugin's probe routes apply (see historyConfig.ts).
export function isHttpUrl(value: string | undefined): boolean {
  const trimmed = value?.trim();
  return Boolean(trimmed) && baseUrlProblem(trimmed ?? '') === null;
}
