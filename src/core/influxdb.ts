import { asFiniteNumber } from './format.js';
import type {
  EngineBinHistory,
  EngineWindowRequest,
  HistoryProvider,
  PathWindowSummary,
} from './history.js';
import { fetchWithTimeout } from './http.js';
import { stripTrailingSlashes } from './questdb.js';

export type InfluxDBVersion = '1' | '2';

export interface InfluxDBCfg {
  url: string;
  database: string;
  username: string;
  password: string;
  version: InfluxDBVersion;
  selfContext?: string;
}

interface InfluxSeries {
  columns?: unknown;
  values?: unknown;
}

interface InfluxResult {
  error?: unknown;
  series?: unknown;
}

interface InfluxResponse {
  error?: unknown;
  results?: unknown;
}

interface TimedValue {
  timestamp: number;
  value: number;
}

interface InfluxDBQueryLimits {
  engineMaxBytes: number;
  engineMaxSamples: number;
  engineTimeoutMs: number;
}

const INFLUXDB_DEFAULT_TIMEOUT_MS = 30_000;
const INFLUXDB_CHUNK_SIZE = 10_000;
const INFLUXDB_ENGINE_MAX_BYTES = 64 * 1024 * 1024;
const INFLUXDB_ENGINE_MAX_SAMPLES = 2_000_000;
const INFLUXDB_ENGINE_TIMEOUT_MS = 60_000;
const INFLUXDB_ENGINE_BUDGET_ERROR = 'InfluxDB engine history exceeded its bounded query budget';

function normalizeBaseUrl(value: string): string {
  const rawUrl = value.trim();
  try {
    const parsed = new URL(rawUrl);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = stripTrailingSlashes(parsed.pathname);
    return stripTrailingSlashes(parsed.href);
  } catch {
    return stripTrailingSlashes(rawUrl);
  }
}

export function escapeInfluxIdentifier(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function escapeInfluxString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function identifier(value: string): string {
  return `"${escapeInfluxIdentifier(value)}"`;
}

function stringLiteral(value: string): string {
  return `'${escapeInfluxString(value)}'`;
}

function columnIndex(series: InfluxSeries, name: string): number {
  if (!Array.isArray(series.columns)) return -1;
  return series.columns.indexOf(name);
}

function rows(series: InfluxSeries): unknown[][] {
  return Array.isArray(series.values) ? series.values.filter(Array.isArray) : [];
}

function firstSeries(result: InfluxResult): InfluxSeries | null {
  if (!Array.isArray(result.series)) return null;
  const value = result.series.find((candidate): candidate is InfluxSeries => {
    return candidate !== null && typeof candidate === 'object';
  });
  return value ?? null;
}

function decodeResult(body: unknown): InfluxResult {
  if (body === null || typeof body !== 'object') {
    throw new Error('InfluxDB returned an invalid query response');
  }
  const response = body as InfluxResponse;
  if (typeof response.error === 'string') throw new Error('InfluxDB query failed');
  if (!Array.isArray(response.results) || response.results.length === 0) {
    throw new Error('InfluxDB returned an invalid query response');
  }
  const result = response.results[0];
  if (result === null || typeof result !== 'object') {
    throw new Error('InfluxDB returned an invalid query response');
  }
  const typed = result as InfluxResult;
  if (typeof typed.error === 'string') throw new Error('InfluxDB query failed');
  return typed;
}

class EngineQueryBudget {
  private bytes = 0;
  private samples = 0;

  constructor(private readonly limits: InfluxDBQueryLimits) {}

  addBytes(count: number): void {
    this.bytes += count;
    if (this.bytes > this.limits.engineMaxBytes) throw new Error(INFLUXDB_ENGINE_BUDGET_ERROR);
  }

  addSamples(count: number): void {
    this.samples += count;
    if (this.samples > this.limits.engineMaxSamples) {
      throw new Error(INFLUXDB_ENGINE_BUDGET_ERROR);
    }
  }
}

function emptyEngineBins(request: EngineWindowRequest): Map<string, EngineBinHistory> {
  return new Map(
    request.bins.map(({ key }) => [
      key,
      { fuelCount: 0, sogCount: 0, meanFuelRate: null, meanSog: null },
    ]),
  );
}

function binKey(request: EngineWindowRequest, rpmHz: number): string | null {
  if (rpmHz < request.runningThresholdHz) return null;
  for (const bin of request.bins) {
    if (rpmHz < bin.maxHz) return bin.key;
  }
  return request.bins.at(-1)?.key ?? null;
}

function timestampMs(value: unknown): number | null {
  const numeric = asFiniteNumber(value);
  if (numeric != null) return numeric;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class InfluxDBClient implements HistoryProvider {
  readonly kind = 'influxdb' as const;
  private readonly baseUrl: string;
  private readonly database: string;
  private readonly username: string;
  private readonly password: string;
  private readonly version: InfluxDBVersion;
  private readonly selfContext?: string;
  private readonly queryLimits: InfluxDBQueryLimits;

  constructor(cfg: InfluxDBCfg, queryLimits: Partial<InfluxDBQueryLimits> = {}) {
    this.baseUrl = normalizeBaseUrl(cfg.url);
    this.database = cfg.database.trim();
    this.username = cfg.username;
    this.password = cfg.password;
    this.version = cfg.version;
    this.selfContext = cfg.selfContext?.trim() || undefined;
    this.queryLimits = {
      engineMaxBytes: queryLimits.engineMaxBytes ?? INFLUXDB_ENGINE_MAX_BYTES,
      engineMaxSamples: queryLimits.engineMaxSamples ?? INFLUXDB_ENGINE_MAX_SAMPLES,
      engineTimeoutMs: queryLimits.engineTimeoutMs ?? INFLUXDB_ENGINE_TIMEOUT_MS,
    };
  }

  async probe(abortSignal?: AbortSignal): Promise<boolean> {
    await this.query('SHOW MEASUREMENTS LIMIT 1', abortSignal);
    return true;
  }

  async summarizePaths(
    paths: readonly string[],
    fromMs: number,
    toMs: number,
    abortSignal?: AbortSignal,
  ): Promise<Map<string, PathWindowSummary>> {
    const entries = await Promise.all(
      paths.map(async (path): Promise<[string, PathWindowSummary] | null> => {
        const result = await this.query(
          `SELECT FIRST("value") AS "first_value", LAST("value") AS "last_value", COUNT("value") AS "sample_count" FROM ${identifier(path)} WHERE ${this.whereClause(fromMs, toMs)}`,
          abortSignal,
        );
        const series = firstSeries(result);
        const row = series ? rows(series)[0] : undefined;
        if (!series || !row) return null;
        const firstIdx = columnIndex(series, 'first_value');
        const lastIdx = columnIndex(series, 'last_value');
        const countIdx = columnIndex(series, 'sample_count');
        return [
          path,
          {
            first: asFiniteNumber(firstIdx >= 0 ? row[firstIdx] : null),
            last: asFiniteNumber(lastIdx >= 0 ? row[lastIdx] : null),
            count: asFiniteNumber(countIdx >= 0 ? row[countIdx] : null) ?? 0,
          },
        ];
      }),
    );
    return new Map(entries.filter((entry): entry is [string, PathWindowSummary] => entry !== null));
  }

  async meanPaths(
    paths: readonly string[],
    fromMs: number,
    toMs: number,
    abortSignal?: AbortSignal,
  ): Promise<Map<string, number>> {
    const entries = await Promise.all(
      paths.map(async (path): Promise<[string, number] | null> => {
        const result = await this.query(
          `SELECT MEAN("value") AS "mean_value" FROM ${identifier(path)} WHERE ${this.whereClause(fromMs, toMs)}`,
          abortSignal,
        );
        const series = firstSeries(result);
        const row = series ? rows(series)[0] : undefined;
        if (!series || !row) return null;
        const meanIdx = columnIndex(series, 'mean_value');
        const mean = asFiniteNumber(meanIdx >= 0 ? row[meanIdx] : null);
        return mean == null ? null : [path, mean];
      }),
    );
    return new Map(entries.filter((entry): entry is [string, number] => entry !== null));
  }

  async binEngineWindow(
    request: EngineWindowRequest,
    fromMs: number,
    toMs: number,
    abortSignal?: AbortSignal,
  ): Promise<Map<string, EngineBinHistory> | null> {
    // InfluxQL has no ASOF JOIN. Stream ordered server chunks and merge them
    // here so every RPM sample uses only the latest preceding metric inside
    // the configured freshness window. One shared budget bounds all three
    // streams by decoded bytes, samples, and elapsed time.
    const deadline = new AbortController();
    const deadlineHandle = setTimeout(() => deadline.abort(), this.queryLimits.engineTimeoutMs);
    const querySignal = abortSignal
      ? AbortSignal.any([abortSignal, deadline.signal])
      : deadline.signal;
    const budget = new EngineQueryBudget(this.queryLimits);
    const rpmIterator = this.rawSeries(request.rpmPath, fromMs, toMs, budget, querySignal)[
      Symbol.asyncIterator
    ]();
    let fuelIterator: AsyncGenerator<TimedValue> | null = null;
    let sogIterator: AsyncGenerator<TimedValue> | null = null;

    try {
      let rpm = await rpmIterator.next();
      if (rpm.done) return null;

      fuelIterator = this.rawSeries(request.fuelRatePath, fromMs, toMs, budget, querySignal);
      sogIterator = this.rawSeries(request.sogPath, fromMs, toMs, budget, querySignal);
      let nextFuel = await fuelIterator.next();
      let nextSog = await sogIterator.next();
      let latestFuel: TimedValue | null = null;
      let latestSog: TimedValue | null = null;

      const out = emptyEngineBins(request);
      const fuelTotals = new Map<string, number>();
      const sogTotals = new Map<string, number>();
      while (!rpm.done) {
        const rpmSample = rpm.value;
        while (!nextFuel.done && nextFuel.value.timestamp <= rpmSample.timestamp) {
          latestFuel = nextFuel.value;
          nextFuel = await fuelIterator.next();
        }
        while (!nextSog.done && nextSog.value.timestamp <= rpmSample.timestamp) {
          latestSog = nextSog.value;
          nextSog = await sogIterator.next();
        }

        const key = binKey(request, rpmSample.value);
        rpm = await rpmIterator.next();
        if (!key) continue;
        const stats = out.get(key);
        if (!stats) continue;

        if (latestFuel && rpmSample.timestamp - latestFuel.timestamp <= request.joinWindowMs) {
          stats.fuelCount += 1;
          fuelTotals.set(key, (fuelTotals.get(key) ?? 0) + latestFuel.value);
        }
        if (latestSog && rpmSample.timestamp - latestSog.timestamp <= request.joinWindowMs) {
          stats.sogCount += 1;
          sogTotals.set(key, (sogTotals.get(key) ?? 0) + latestSog.value);
        }
      }
      for (const [key, stats] of out) {
        stats.meanFuelRate =
          stats.fuelCount > 0 ? (fuelTotals.get(key) ?? 0) / stats.fuelCount : null;
        stats.meanSog = stats.sogCount > 0 ? (sogTotals.get(key) ?? 0) / stats.sogCount : null;
      }
      return out;
    } catch (err) {
      if (deadline.signal.aborted && !abortSignal?.aborted) {
        throw new Error(INFLUXDB_ENGINE_BUDGET_ERROR);
      }
      throw err;
    } finally {
      clearTimeout(deadlineHandle);
      await Promise.allSettled([
        rpmIterator.return(undefined),
        fuelIterator?.return(undefined),
        sogIterator?.return(undefined),
      ]);
    }
  }

  private whereClause(fromMs: number, toMs: number): string {
    const fromIso = new Date(fromMs).toISOString();
    const toIso = new Date(toMs).toISOString();
    return `${this.selfClause()} AND time >= ${stringLiteral(fromIso)} AND time < ${stringLiteral(toIso)}`;
  }

  private selfClause(): string {
    if (this.version === '2') return `"self" = 'true'`;
    if (!this.selfContext) {
      throw new Error('Signal K self context is unavailable for the InfluxDB v1 history source');
    }
    return `"context" = ${stringLiteral(this.selfContext)}`;
  }

  private async *rawSeries(
    path: string,
    fromMs: number,
    toMs: number,
    budget: EngineQueryBudget,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<TimedValue> {
    for await (const result of this.streamQuery(
      `SELECT "value" FROM ${identifier(path)} WHERE ${this.whereClause(fromMs, toMs)} ORDER BY time ASC`,
      budget,
      abortSignal,
    )) {
      const series = firstSeries(result);
      if (!series) continue;
      const timeIdx = columnIndex(series, 'time');
      const valueIdx = columnIndex(series, 'value');
      if (timeIdx < 0 || valueIdx < 0) {
        throw new Error('InfluxDB returned an invalid query response');
      }
      const chunkRows = rows(series);
      budget.addSamples(chunkRows.length);
      const chunk: TimedValue[] = [];
      for (const row of chunkRows) {
        const timestamp = timestampMs(row[timeIdx]);
        const value = asFiniteNumber(row[valueIdx]);
        if (timestamp == null || value == null) continue;
        chunk.push({ timestamp, value });
      }
      chunk.sort((a, b) => a.timestamp - b.timestamp);
      yield* chunk;
    }
  }

  private async *streamQuery(
    influxql: string,
    budget: EngineQueryBudget,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<InfluxResult> {
    const url = this.queryUrl(influxql, 'ms');
    url.searchParams.set('chunked', 'true');
    url.searchParams.set('chunk_size', String(INFLUXDB_CHUNK_SIZE));
    const response = await fetch(url.toString(), {
      headers: this.authHeaders(),
      redirect: 'error',
      signal: abortSignal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.body) throw new Error('InfluxDB returned an invalid query response');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let complete = false;
    try {
      while (true) {
        abortSignal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) {
          complete = true;
          pending += decoder.decode();
          break;
        }
        budget.addBytes(value.byteLength);
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          yield decodeResult(JSON.parse(line));
        }
      }
      if (pending.trim()) yield decodeResult(JSON.parse(pending));
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error('InfluxDB returned an invalid query response');
      }
      throw err;
    } finally {
      if (!complete) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  private queryUrl(influxql: string, epoch?: 'ms'): URL {
    const url = new URL(`${this.baseUrl}/query`);
    url.searchParams.set('db', this.database);
    url.searchParams.set('q', influxql);
    if (epoch) url.searchParams.set('epoch', epoch);
    return url;
  }

  private authHeaders(): Headers {
    const headers = new Headers();
    if (this.version === '2' && this.password && !this.username) {
      headers.set('authorization', `Token ${this.password}`);
    } else if (this.username || this.password) {
      headers.set(
        'authorization',
        `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`,
      );
    }
    return headers;
  }

  private async query(
    influxql: string,
    abortSignal?: AbortSignal,
    epoch?: 'ms',
  ): Promise<InfluxResult> {
    const url = this.queryUrl(influxql, epoch);
    const response = await fetchWithTimeout(
      url.toString(),
      { headers: this.authHeaders(), redirect: 'error' },
      INFLUXDB_DEFAULT_TIMEOUT_MS,
      abortSignal,
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return decodeResult(await response.json());
  }
}
