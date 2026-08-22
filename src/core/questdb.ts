import { asFiniteNumber } from './format.js';
import type {
  EngineBinHistory,
  EngineWindowRequest,
  HistoryProvider,
  PathWindowSummary,
} from './history.js';
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

export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

// Quote and escape a set of SignalK paths into a comma-separated list for a
// SQL `path IN (...)` clause.
function quotedPathList(paths: readonly string[]): string {
  return paths.map((p) => `'${escapeSqlLiteral(p)}'`).join(', ');
}

// signalk-questdb writes the self vessel's rows with the literal context
// 'self', not the full `vessels.urn:mrn:...` value that app.selfContext
// returns. Analyzer queries must filter on this or they match no rows.
const QUESTDB_SELF_CONTEXT = 'self';

// Pre-escaped form for embedding directly in a SQL `context = '...'` clause.
// Escaped once here so the trend analyzers single-source it instead of each
// calling escapeSqlLiteral(QUESTDB_SELF_CONTEXT) per query.
const QUESTDB_SELF_CONTEXT_SQL = escapeSqlLiteral(QUESTDB_SELF_CONTEXT);

// Collapse a multi-line template-literal SQL string to a single space-separated
// line before sending it over the /exec query string. The trend analyzers all
// author SQL as indented template literals for readability; this is the shared
// flatten so the regex cannot drift between them.
function flattenSql(sql: string): string {
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
function decodePathKeyed<T>(
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
function isoRange(fromMs: number, toMs: number): [fromIso: string, toIso: string] {
  return [new Date(fromMs).toISOString(), new Date(toMs).toISOString()];
}

export class QuestDBClient implements HistoryProvider {
  readonly kind = 'questdb' as const;
  private readonly baseUrl: string;

  constructor(cfg: QuestDBCfg) {
    const rawUrl = cfg.url.trim();
    try {
      const parsed = new URL(rawUrl);
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      parsed.pathname = stripTrailingSlashes(parsed.pathname);
      this.baseUrl = stripTrailingSlashes(parsed.href);
    } catch {
      // Preserve the old fail-soft behavior for a hand-edited invalid config:
      // fetch rejects during probe, and the optional provider degrades cleanly.
      this.baseUrl = stripTrailingSlashes(rawUrl);
    }
  }

  // Resolves false for a reachable server that answers wrongly (non-2xx, or a
  // payload without a dataset). Throws for a transport failure (refused
  // connection, DNS, timeout) so callers that want the reason, such as the
  // QuestDB test endpoint, can report it instead of a bare "unreachable".
  async probe(abortSignal?: AbortSignal): Promise<boolean> {
    const r = await fetchWithTimeout(
      `${this.baseUrl}/exec?query=SELECT%201`,
      { redirect: 'error' },
      QUESTDB_DEFAULT_TIMEOUT_MS,
      abortSignal,
    );
    if (!r.ok) return false;
    const j = (await r.json()) as Partial<QueryResult>;
    return Array.isArray(j.dataset);
  }

  async query(sql: string, abortSignal?: AbortSignal): Promise<QueryResult> {
    const r = await fetchWithTimeout(
      `${this.baseUrl}/exec?query=${encodeURIComponent(sql)}`,
      // Same redirect rule as probe() and both InfluxDB request paths: a 3xx
      // from the configured host must not forward this query somewhere else.
      { redirect: 'error' },
      QUESTDB_DEFAULT_TIMEOUT_MS,
      abortSignal,
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = (await r.json()) as QueryResult;
    return { columns: body.columns ?? [], dataset: body.dataset ?? [] };
  }

  async summarizePaths(
    paths: readonly string[],
    fromMs: number,
    toMs: number,
    abortSignal?: AbortSignal,
  ): Promise<Map<string, PathWindowSummary>> {
    const [fromIso, toIso] = isoRange(fromMs, toMs);
    const sql = flattenSql(`
      SELECT path, first(value) AS first_val, last(value) AS last_val, count() AS n
      FROM signalk
      WHERE context = '${QUESTDB_SELF_CONTEXT_SQL}'
        AND path IN (${quotedPathList(paths)})
        AND ts > '${fromIso}'
        AND ts <= '${toIso}'
      GROUP BY path
    `);
    const result = await this.query(sql, abortSignal);
    return decodePathKeyed(result, (columns) => {
      const firstIdx = columns.get('first_val') ?? -1;
      const lastIdx = columns.get('last_val') ?? -1;
      const countIdx = columns.get('n') ?? -1;
      return (row) => ({
        first: asFiniteNumber(firstIdx >= 0 ? row[firstIdx] : null),
        last: asFiniteNumber(lastIdx >= 0 ? row[lastIdx] : null),
        count: asFiniteNumber(countIdx >= 0 ? row[countIdx] : null) ?? 0,
      });
    });
  }

  async meanPaths(
    paths: readonly string[],
    fromMs: number,
    toMs: number,
    abortSignal?: AbortSignal,
  ): Promise<Map<string, number>> {
    const [fromIso, toIso] = isoRange(fromMs, toMs);
    const sql = flattenSql(`
      SELECT path, avg(value) AS mean_value FROM signalk
      WHERE path IN (${quotedPathList(paths)})
        AND context = '${QUESTDB_SELF_CONTEXT_SQL}'
        AND ts >= '${fromIso}'
        AND ts < '${toIso}'
      GROUP BY path
    `);
    const result = await this.query(sql, abortSignal);
    return decodePathKeyed(result, (columns) => {
      const meanIdx = columns.get('mean_value') ?? -1;
      return (row) => (meanIdx >= 0 ? asFiniteNumber(row[meanIdx]) : null);
    });
  }

  async binEngineWindow(
    request: EngineWindowRequest,
    fromMs: number,
    toMs: number,
    abortSignal?: AbortSignal,
  ): Promise<Map<string, EngineBinHistory> | null> {
    const [fromIso, toIso] = isoRange(fromMs, toMs);
    const rpmPath = escapeSqlLiteral(request.rpmPath);
    const fuelPath = escapeSqlLiteral(request.fuelRatePath);
    const sogPath = escapeSqlLiteral(request.sogPath);
    const joinWindowUs = request.joinWindowMs * 1000;
    const finiteBins = request.bins.filter((bin) => Number.isFinite(bin.maxHz));
    const elseBin = request.bins.at(-1)?.key;
    if (!elseBin) return null;
    const binCase = `CASE ${finiteBins
      .map((bin) => `WHEN r.value < ${bin.maxHz} THEN '${escapeSqlLiteral(bin.key)}'`)
      .join(' ')} ELSE '${escapeSqlLiteral(elseBin)}' END`;
    const sql = flattenSql(`
      WITH r AS (
        SELECT ts, value FROM signalk
        WHERE path = '${rpmPath}'
          AND context = '${QUESTDB_SELF_CONTEXT_SQL}'
          AND ts >= '${fromIso}'
          AND ts < '${toIso}'
          AND value >= ${request.runningThresholdHz}
      ),
      f AS (
        SELECT ts, value FROM signalk
        WHERE path = '${fuelPath}'
          AND context = '${QUESTDB_SELF_CONTEXT_SQL}'
          AND ts >= '${fromIso}'
          AND ts < '${toIso}'
      ),
      s AS (
        SELECT ts, value FROM signalk
        WHERE path = '${sogPath}'
          AND context = '${QUESTDB_SELF_CONTEXT_SQL}'
          AND ts >= '${fromIso}'
          AND ts < '${toIso}'
      )
      SELECT
        ${binCase} AS bin,
        count(CASE WHEN r.ts - f.ts BETWEEN 0 AND ${joinWindowUs} THEN 1 END) AS n_fuel,
        count(CASE WHEN r.ts - s.ts BETWEEN 0 AND ${joinWindowUs} THEN 1 END) AS n_sog,
        avg(CASE WHEN r.ts - f.ts BETWEEN 0 AND ${joinWindowUs} THEN f.value END) AS mean_fuel,
        avg(CASE WHEN r.ts - s.ts BETWEEN 0 AND ${joinWindowUs} THEN s.value END) AS mean_sog
      FROM r ASOF JOIN f ASOF JOIN s
      GROUP BY bin
    `);
    const result = await this.query(sql, abortSignal);
    if (result.dataset.length === 0) return null;
    const columns = indexColumns(result);
    const binIdx = columns.get('bin') ?? -1;
    const fuelCountIdx = columns.get('n_fuel') ?? -1;
    const sogCountIdx = columns.get('n_sog') ?? -1;
    const fuelIdx = columns.get('mean_fuel') ?? -1;
    const sogIdx = columns.get('mean_sog') ?? -1;
    if (binIdx < 0 || fuelCountIdx < 0 || sogCountIdx < 0 || fuelIdx < 0 || sogIdx < 0) {
      return null;
    }
    const out = new Map<string, EngineBinHistory>(
      request.bins.map(({ key }) => [
        key,
        { fuelCount: 0, sogCount: 0, meanFuelRate: null, meanSog: null },
      ]),
    );
    for (const row of result.dataset) {
      const key = row[binIdx];
      if (typeof key !== 'string' || !out.has(key)) continue;
      out.set(key, {
        fuelCount: asFiniteNumber(row[fuelCountIdx]) ?? 0,
        sogCount: asFiniteNumber(row[sogCountIdx]) ?? 0,
        meanFuelRate: asFiniteNumber(row[fuelIdx]),
        meanSog: asFiniteNumber(row[sogIdx]),
      });
    }
    return out;
  }
}
