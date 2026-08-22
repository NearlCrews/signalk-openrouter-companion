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

// The base-URL rule, written once. Both the history field error and the
// save-blocked notice quote it, so a wording change cannot leave the two
// describing different rules.
export const HISTORY_URL_RULE =
  'HTTP or HTTPS base URL without credentials, a query, or a fragment';

export interface HistoryValidity {
  source: NonNullable<PanelConfig['history']>['source'];
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

// History providers only support HTTP and HTTPS base URLs. Credentials, query
// strings, and fragments cannot be part of the base because each client owns
// authentication and its API query.
export function isHttpUrl(value: string | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}
