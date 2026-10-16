// The history-provider vocabulary the plugin runtime, the admin probe routes,
// and the browser panel all state: which providers exist, and what a provider
// base URL may be. Dependency-free, like callBudget.ts, so the panel imports
// it without pulling Node code into the browser bundle.

export const HISTORY_SOURCES = ['none', 'questdb', 'influxdb'] as const;
export type HistorySource = (typeof HISTORY_SOURCES)[number];

export function isHistorySource(v: unknown): v is HistorySource {
  return (HISTORY_SOURCES as readonly unknown[]).includes(v);
}

// Releases before the history-provider selector stored QuestDB at the top level
// of the saved configuration. Both the plugin and the panel still read it, so
// an existing installation migrates without re-entering its URL.
export interface LegacyQuestDbCfg {
  enabled?: boolean;
  url?: string;
}

// The provider a legacy top-level QuestDB block selected.
export function legacyHistorySource(legacy: LegacyQuestDbCfg): HistorySource {
  return legacy.enabled === false ? 'none' : 'questdb';
}

// Why a history-provider base URL is unusable. Only HTTP and HTTPS are served
// by either provider, and the base carries no credentials, query, or fragment
// because each client owns its authentication and its own API query.
export type BaseUrlProblem = 'invalid' | 'scheme' | 'credentials' | 'query';

// The one statement of that rule: null for a usable base URL, otherwise what
// is wrong with it. The probe routes turn the reason into their error text and
// the panel only needs to know whether there is one.
export function baseUrlProblem(raw: string): BaseUrlProblem | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return 'invalid';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'scheme';
  if (url.username || url.password) return 'credentials';
  if (url.search || url.hash) return 'query';
  return null;
}
