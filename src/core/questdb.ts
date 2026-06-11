import { fetchWithTimeout } from './http.js';

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

// Pre-escaped form for embedding directly in a SQL `context = '...'` clause.
// Escaped once here so the trend analyzers single-source it instead of each
// calling escapeSqlLiteral(QUESTDB_SELF_CONTEXT) per query.
export const QUESTDB_SELF_CONTEXT_SQL = escapeSqlLiteral(QUESTDB_SELF_CONTEXT);

// Collapse a multi-line template-literal SQL string to a single space-separated
// line before sending it over the /exec query string. The trend analyzers all
// author SQL as indented template literals for readability; this is the shared
// flatten so the regex cannot drift between them.
export function flattenSql(sql: string): string {
  return sql.trim().replace(/\s+/g, ' ');
}

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

// Decode a path-keyed GROUP BY result into a Map keyed by the `path` column.
// Shared by the trend analyzers, which all run `... GROUP BY path` and then
// fold each row into a per-path summary. Two-stage: `build` receives the
// column index map once and returns the per-row decoder, so callers resolve
// their aggregate-column indexes once per result instead of once per row.
// The decoder returning null drops that row from the Map. A result missing
// the `path` column yields an empty Map rather than throwing, matching the
// per-analyzer bail that returned the empty accumulator when the path index
// was negative.
export function decodePathKeyed<T>(
  res: QueryResult,
  build: (cols: ReadonlyMap<string, number>) => (row: readonly unknown[]) => T | null,
): Map<string, T> {
  const out = new Map<string, T>();
  const cols = indexColumns(res);
  const pIdx = cols.get('path') ?? -1;
  if (pIdx < 0) return out;
  const decodeRow = build(cols);
  for (const row of res.dataset) {
    const path = row[pIdx];
    if (typeof path !== 'string') continue;
    const built = decodeRow(row);
    if (built == null) continue;
    out.set(path, built);
  }
  return out;
}

// The two ISO bounds every windowed query builder needs from a millisecond
// range. Returns [fromIso, toIso] so the SQL `ts > fromIso AND ts <= toIso`
// clauses read straight from a destructure.
export function isoRange(fromMs: number, toMs: number): [fromIso: string, toIso: string] {
  return [new Date(fromMs).toISOString(), new Date(toMs).toISOString()];
}

export class QuestDBClient {
  constructor(private cfg: QuestDBCfg) {}

  // Resolves false for a reachable server that answers wrongly (non-2xx, or a
  // payload without a dataset). Throws for a transport failure (refused
  // connection, DNS, timeout) so callers that want the reason, such as the
  // QuestDB test endpoint, can report it instead of a bare "unreachable".
  async probe(abortSignal?: AbortSignal): Promise<boolean> {
    const r = await fetchWithTimeout(
      `${this.cfg.url}/exec?query=SELECT%201`,
      {},
      QUESTDB_DEFAULT_TIMEOUT_MS,
      abortSignal,
    );
    if (!r.ok) return false;
    const j = (await r.json()) as Partial<QueryResult>;
    return Array.isArray(j.dataset);
  }

  async query(sql: string, abortSignal?: AbortSignal): Promise<QueryResult> {
    const r = await fetchWithTimeout(
      `${this.cfg.url}/exec?query=${encodeURIComponent(sql)}`,
      {},
      QUESTDB_DEFAULT_TIMEOUT_MS,
      abortSignal,
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = (await r.json()) as QueryResult;
    return { columns: body.columns ?? [], dataset: body.dataset ?? [] };
  }
}
