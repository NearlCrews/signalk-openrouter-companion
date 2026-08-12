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

interface BucketValue {
  value: number;
  count: number;
}

const INFLUXDB_DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ENGINE_BUCKETS = 50_000;

function normalizeBaseUrl(value: string): string {
  const rawUrl = value.trim();
  try {
    const parsed = new URL(rawUrl);
    parsed.search = '';
    parsed.hash = '';
    parsed.username = '';
    parsed.password = '';
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

function engineBucketSeconds(fromMs: number, toMs: number, joinWindowMs: number): number {
  const durationSeconds = Math.max(1, Math.ceil((toMs - fromMs) / 1000));
  return Math.max(
    1,
    Math.ceil(joinWindowMs / 1000),
    Math.ceil(durationSeconds / MAX_ENGINE_BUCKETS),
  );
}

export class InfluxDBClient implements HistoryProvider {
  readonly kind = 'influxdb' as const;
  private readonly baseUrl: string;
  private readonly database: string;
  private readonly username: string;
  private readonly password: string;
  private readonly version: InfluxDBVersion;
  private readonly selfContext?: string;

  constructor(cfg: InfluxDBCfg) {
    this.baseUrl = normalizeBaseUrl(cfg.url);
    this.database = cfg.database.trim();
    this.username = cfg.username;
    this.password = cfg.password;
    this.version = cfg.version;
    this.selfContext = cfg.selfContext?.trim() || undefined;
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
    // InfluxQL has no QuestDB-style bounded ASOF JOIN. Align the three
    // measurements into common time buckets instead, using the analyzer's
    // freshness window as the minimum width and widening long ranges enough
    // to keep every aggregate response at or below MAX_ENGINE_BUCKETS rows.
    const bucketSeconds = engineBucketSeconds(fromMs, toMs, request.joinWindowMs);
    const [rpm, fuel, sog] = await Promise.all([
      this.bucketedSeries(request.rpmPath, fromMs, toMs, bucketSeconds, abortSignal),
      this.bucketedSeries(request.fuelRatePath, fromMs, toMs, bucketSeconds, abortSignal),
      this.bucketedSeries(request.sogPath, fromMs, toMs, bucketSeconds, abortSignal),
    ]);
    if (rpm.size === 0) return null;

    const out = emptyEngineBins(request);
    const fuelTotals = new Map<string, number>();
    const sogTotals = new Map<string, number>();
    for (const [timestamp, rpmBucket] of rpm) {
      const key = binKey(request, rpmBucket.value);
      if (!key) continue;
      const stats = out.get(key);
      if (!stats) continue;

      const fuelBucket = fuel.get(timestamp);
      if (fuelBucket) {
        const paired = Math.min(rpmBucket.count, fuelBucket.count);
        stats.fuelCount += paired;
        fuelTotals.set(key, (fuelTotals.get(key) ?? 0) + fuelBucket.value * paired);
      }
      const sogBucket = sog.get(timestamp);
      if (sogBucket) {
        const paired = Math.min(rpmBucket.count, sogBucket.count);
        stats.sogCount += paired;
        sogTotals.set(key, (sogTotals.get(key) ?? 0) + sogBucket.value * paired);
      }
    }
    for (const [key, stats] of out) {
      stats.meanFuelRate =
        stats.fuelCount > 0 ? (fuelTotals.get(key) ?? 0) / stats.fuelCount : null;
      stats.meanSog = stats.sogCount > 0 ? (sogTotals.get(key) ?? 0) / stats.sogCount : null;
    }
    return out;
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

  private async bucketedSeries(
    path: string,
    fromMs: number,
    toMs: number,
    bucketSeconds: number,
    abortSignal?: AbortSignal,
  ): Promise<Map<number, BucketValue>> {
    const result = await this.query(
      `SELECT MEAN("value") AS "mean_value", COUNT("value") AS "sample_count" FROM ${identifier(path)} WHERE ${this.whereClause(fromMs, toMs)} GROUP BY time(${bucketSeconds}s) fill(none)`,
      abortSignal,
      'ms',
    );
    const series = firstSeries(result);
    if (!series) return new Map();
    const timeIdx = columnIndex(series, 'time');
    const valueIdx = columnIndex(series, 'mean_value');
    const countIdx = columnIndex(series, 'sample_count');
    if (timeIdx < 0 || valueIdx < 0 || countIdx < 0) return new Map();
    const out = new Map<number, BucketValue>();
    for (const row of rows(series)) {
      const timestamp = asFiniteNumber(row[timeIdx]);
      const value = asFiniteNumber(row[valueIdx]);
      const count = asFiniteNumber(row[countIdx]);
      if (timestamp == null || value == null || count == null || count <= 0) continue;
      out.set(timestamp, { value, count });
    }
    return out;
  }

  private async query(
    influxql: string,
    abortSignal?: AbortSignal,
    epoch?: 'ms',
  ): Promise<InfluxResult> {
    const url = new URL(`${this.baseUrl}/query`);
    url.searchParams.set('db', this.database);
    url.searchParams.set('q', influxql);
    if (epoch) url.searchParams.set('epoch', epoch);
    const headers = new Headers();
    if (this.version === '2' && this.password && !this.username) {
      headers.set('authorization', `Token ${this.password}`);
    } else if (this.username || this.password) {
      headers.set(
        'authorization',
        `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`,
      );
    }
    const response = await fetchWithTimeout(
      url.toString(),
      { headers, redirect: 'error' },
      INFLUXDB_DEFAULT_TIMEOUT_MS,
      abortSignal,
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as InfluxResponse;
    if (typeof body.error === 'string') throw new Error('InfluxDB query failed');
    if (!Array.isArray(body.results) || body.results.length === 0) {
      throw new Error('InfluxDB returned an invalid query response');
    }
    const result = body.results[0];
    if (result === null || typeof result !== 'object') {
      throw new Error('InfluxDB returned an invalid query response');
    }
    const typed = result as InfluxResult;
    if (typeof typed.error === 'string') throw new Error('InfluxDB query failed');
    return typed;
  }
}
