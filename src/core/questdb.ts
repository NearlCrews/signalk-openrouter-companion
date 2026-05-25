interface QuestDBCfg {
  url: string;
}

// Default request timeout for QuestDB probes and queries. QuestDB's HTTP
// /exec endpoint usually answers in tens of ms; 30s is a generous ceiling
// that still bounds the hang on a contended host or a stuck connection.
const QUESTDB_DEFAULT_TIMEOUT_MS = 30_000;

export interface QueryResult {
  columns: { name: string; type: string }[];
  dataset: unknown[][];
}

export function escapeSqlLiteral(s: string): string {
  return s.replace(/'/g, "''");
}

// Quote and escape a set of SignalK paths into a comma-separated list for a
// SQL `path IN (...)` clause.
export function quotedPathList(paths: readonly string[]): string {
  return paths.map((p) => `'${escapeSqlLiteral(p)}'`).join(', ');
}

// signalk-questdb writes the self vessel's rows with the literal context
// 'self', not the full `vessels.urn:mrn:...` value that app.selfContext
// returns. Analyzer queries must filter on this or they match no rows.
export const QUESTDB_SELF_CONTEXT = 'self';

// Build a name-to-index lookup for a QueryResult's columns. Cheaper and less
// repetitive than calling r.columns.findIndex per field at the call site.
export function indexColumns(r: QueryResult): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < r.columns.length; i += 1) {
    const c = r.columns[i];
    if (c) out.set(c.name, i);
  }
  return out;
}

export class QuestDBClient {
  constructor(private cfg: QuestDBCfg) {}

  // Resolves false for a reachable server that answers wrongly (non-2xx, or a
  // payload without a dataset). Throws for a transport failure (refused
  // connection, DNS, timeout) so callers that want the reason, such as the
  // QuestDB test endpoint, can report it instead of a bare "unreachable".
  async probe(abortSignal?: AbortSignal): Promise<boolean> {
    return withTimeout(abortSignal, async (signal) => {
      const r = await fetch(`${this.cfg.url}/exec?query=SELECT%201`, { signal });
      if (!r.ok) return false;
      const j = (await r.json()) as Partial<QueryResult>;
      return Array.isArray(j.dataset);
    });
  }

  async query(sql: string, abortSignal?: AbortSignal): Promise<QueryResult> {
    return withTimeout(abortSignal, async (signal) => {
      const r = await fetch(`${this.cfg.url}/exec?query=${encodeURIComponent(sql)}`, {
        signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as QueryResult;
      return { columns: body.columns ?? [], dataset: body.dataset ?? [] };
    });
  }
}

// Wrap a fetch in a per-request timeout that also honors the caller's
// lifecycle signal. Aborts on whichever fires first; the trend analyzers
// pass their lifecycle signal, the REST test endpoint passes the runtime's.
async function withTimeout<T>(
  caller: AbortSignal | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController();
  // Guard every abort path against double-call. AbortController.abort is
  // idempotent today, but the second call shadows nothing (reason wins on
  // first-call); a future runtime that throws on second abort would crash.
  const safeAbort = (reason: unknown): void => {
    if (!ctrl.signal.aborted) ctrl.abort(reason);
  };
  const onCaller = (): void => safeAbort(caller?.reason);
  if (caller?.aborted) {
    // Already aborted at call time: prefer the explicit sync abort over a
    // listener that will never fire (the event has already happened).
    safeAbort(caller.reason);
  } else {
    caller?.addEventListener('abort', onCaller, { once: true });
  }
  const timer = setTimeout(
    () => safeAbort(new Error('QuestDB request timed out')),
    QUESTDB_DEFAULT_TIMEOUT_MS,
  );
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener('abort', onCaller);
  }
}
