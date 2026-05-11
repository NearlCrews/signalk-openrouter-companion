export interface QuestDBCfg {
  url: string;
}

export interface QueryResult {
  columns: { name: string; type: string }[];
  dataset: unknown[][];
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

  async baselineFor(
    path: string,
    context: string,
    days: number,
    abortSignal?: AbortSignal,
  ): Promise<{
    min: number;
    max: number;
    mean: number;
    p10: number;
    p50: number;
    p90: number;
  } | null> {
    if (!Number.isFinite(days)) {
      throw new Error(`baselineFor: days must be a finite number (got ${String(days)})`);
    }
    const d = Math.max(1, Math.trunc(days));
    const escapedPath = path.replace(/'/g, "''");
    const escapedCtx = context.replace(/'/g, "''");
    const sql = `
      SELECT min(value) AS min, max(value) AS max, avg(value) AS mean,
             approx_percentile(value, 0.10) AS p10,
             approx_percentile(value, 0.50) AS p50,
             approx_percentile(value, 0.90) AS p90
      FROM signalk
      WHERE path = '${escapedPath}'
        AND context = '${escapedCtx}'
        AND ts > dateadd('d', -${d}, now())
    `
      .trim()
      .replace(/\s+/g, ' ');
    const r = await this.query(sql, abortSignal);
    const row = r.dataset[0];
    if (!row || row.every((v) => v == null)) return null;
    const get = (name: string): number => {
      const idx = r.columns.findIndex((c) => c.name === name);
      const v = idx >= 0 ? row[idx] : null;
      return typeof v === 'number' ? v : Number.NaN;
    };
    const result = {
      min: get('min'),
      max: get('max'),
      mean: get('mean'),
      p10: get('p10'),
      p50: get('p50'),
      p90: get('p90'),
    };
    if (Object.values(result).some((n) => !Number.isFinite(n))) return null;
    return result;
  }
}
