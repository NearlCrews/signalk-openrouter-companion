export interface QuestDBCfg {
  url: string;
}

export interface QueryResult {
  columns: { name: string; type: string }[];
  dataset: unknown[][];
}

export function escapeSqlLiteral(s: string): string {
  return s.replace(/'/g, "''");
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

  async probe(abortSignal?: AbortSignal): Promise<boolean> {
    try {
      const r = await fetch(`${this.cfg.url}/exec?query=SELECT%201`, { signal: abortSignal });
      if (!r.ok) return false;
      const j = (await r.json()) as Partial<QueryResult>;
      return Array.isArray(j.dataset);
    } catch {
      return false;
    }
  }

  async query(sql: string, abortSignal?: AbortSignal): Promise<QueryResult> {
    const r = await fetch(`${this.cfg.url}/exec?query=${encodeURIComponent(sql)}`, {
      signal: abortSignal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = (await r.json()) as QueryResult;
    return { columns: body.columns ?? [], dataset: body.dataset ?? [] };
  }
}
