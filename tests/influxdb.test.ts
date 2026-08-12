import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  escapeInfluxIdentifier,
  escapeInfluxString,
  InfluxDBClient,
} from '../src/core/influxdb.js';

function okResult(columns: string[] = ['name'], values: unknown[][] = [['measurement']]): Response {
  return new Response(
    JSON.stringify({
      results: [{ series: values.length > 0 ? [{ name: 'series', columns, values }] : [] }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function requestAt(
  mock: ReturnType<typeof vi.fn>,
  index = 0,
): {
  url: URL;
  init: RequestInit;
} {
  const call = mock.mock.calls[index];
  if (!call) throw new Error(`expected fetch call ${index}`);
  return { url: new URL(String(call[0])), init: call[1] as RequestInit };
}

describe('InfluxDBClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('probes the v1-compatible query API with bounded, redirect-safe Basic auth', async () => {
    fetchMock.mockResolvedValueOnce(okResult());
    const client = new InfluxDBClient({
      version: '2',
      url: '  http://influx.local:8086///?discarded=yes#old  ',
      database: 'boat history',
      username: 'operator',
      password: 'token-value',
    });

    await expect(client.probe()).resolves.toBe(true);

    const { url, init } = requestAt(fetchMock);
    expect(url.origin + url.pathname).toBe('http://influx.local:8086/query');
    expect(url.searchParams.get('db')).toBe('boat history');
    expect(url.searchParams.get('q')).toBe('SHOW MEASUREMENTS LIMIT 1');
    expect(url.username).toBe('');
    expect(url.password).toBe('');
    expect(url.href).not.toContain('token-value');
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe(
      `Basic ${Buffer.from('operator:token-value').toString('base64')}`,
    );
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('omits authorization when authentication is disabled', async () => {
    fetchMock.mockResolvedValueOnce(okResult());
    const client = new InfluxDBClient({
      version: '1',
      url: 'http://influx.local:8086',
      database: 'signalk',
      username: '',
      password: '',
      selfContext: 'vessels.self',
    });

    await client.probe();

    expect(new Headers(requestAt(fetchMock).init.headers).has('authorization')).toBe(false);
  });

  it('removes credentials embedded in a hand-edited base URL', async () => {
    fetchMock.mockResolvedValueOnce(okResult());
    const client = new InfluxDBClient({
      version: '1',
      url: 'http://embedded:secret@influx.local:8086',
      database: 'signalk',
      username: '',
      password: '',
      selfContext: 'vessels.self',
    });

    await client.probe();

    const { url, init } = requestAt(fetchMock);
    expect(url.username).toBe('');
    expect(url.password).toBe('');
    expect(url.href).not.toContain('embedded');
    expect(url.href).not.toContain('secret');
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });

  it('uses token authentication for InfluxDB 2 when no username is configured', async () => {
    fetchMock.mockResolvedValueOnce(okResult());
    const client = new InfluxDBClient({
      version: '2',
      url: 'http://influx.local:8086',
      database: 'signalk',
      username: '',
      password: 'api-token',
    });

    await client.probe();

    const { url, init } = requestAt(fetchMock);
    expect(new Headers(init.headers).get('authorization')).toBe('Token api-token');
    expect(url.href).not.toContain('api-token');
  });

  it('summarizes a v1 writer measurement using the full self-context tag', async () => {
    fetchMock.mockResolvedValueOnce(
      okResult(
        ['time', 'first_value', 'last_value', 'sample_count'],
        [['2026-08-01T00:00:00Z', 100, 95, 42]],
      ),
    );
    const client = new InfluxDBClient({
      version: '1',
      url: 'http://influx.local:8086',
      database: 'signalk',
      username: '',
      password: '',
      selfContext: "vessels.o'brien",
    });

    const summary = await client.summarizePaths(
      ['electrical.batteries.bank"one.capacity.actual'],
      Date.parse('2026-08-01T00:00:00Z'),
      Date.parse('2026-08-02T00:00:00Z'),
    );

    expect(summary.get('electrical.batteries.bank"one.capacity.actual')).toEqual({
      first: 100,
      last: 95,
      count: 42,
    });
    const query = requestAt(fetchMock).url.searchParams.get('q') ?? '';
    expect(query).toContain('FROM "electrical.batteries.bank\\"one.capacity.actual"');
    expect(query).toContain("\"context\" = 'vessels.o\\'brien'");
    expect(query).toContain("time >= '2026-08-01T00:00:00.000Z'");
    expect(query).toContain("time < '2026-08-02T00:00:00.000Z'");
  });

  it('uses the v2 writer self tag and decodes per-path means', async () => {
    fetchMock.mockResolvedValueOnce(
      okResult(['time', 'mean_value'], [['2026-08-01T00:00:00Z', 101_325.5]]),
    );
    const client = new InfluxDBClient({
      version: '2',
      url: 'http://influx.local:8086',
      database: 'signalk',
      username: 'signalk',
      password: 'token',
    });

    const means = await client.meanPaths(
      ['environment.outside.pressure'],
      Date.parse('2026-08-01T00:00:00Z'),
      Date.parse('2026-08-02T00:00:00Z'),
    );

    expect(means.get('environment.outside.pressure')).toBe(101_325.5);
    expect(requestAt(fetchMock).url.searchParams.get('q')).toContain('"self" = \'true\'');
  });

  it('aligns bounded time buckets and aggregates engine metrics by RPM band', async () => {
    const t0 = Date.parse('2026-08-01T00:00:00Z');
    const t1 = t0 + 5_000;
    const t2 = t0 + 10_000;
    fetchMock.mockImplementation(async (input: string) => {
      const query = new URL(input).searchParams.get('q') ?? '';
      const columns = ['time', 'mean_value', 'sample_count'];
      if (query.includes('propulsion.port.revolutions')) {
        return okResult(columns, [
          [t0, 10, 2],
          [t1, 20, 1],
          [t2, 3, 4],
        ]);
      }
      if (query.includes('propulsion.port.fuel.rate')) {
        return okResult(columns, [
          [t0, 2, 3],
          [t1, 4, 1],
        ]);
      }
      return okResult(columns, [
        [t0, 5, 2],
        [t1, 6, 2],
      ]);
    });
    const client = new InfluxDBClient({
      version: '2',
      url: 'http://influx.local:8086',
      database: 'signalk',
      username: 'signalk',
      password: 'token',
    });

    const result = await client.binEngineWindow(
      {
        rpmPath: 'propulsion.port.revolutions',
        fuelRatePath: 'propulsion.port.fuel.rate',
        sogPath: 'navigation.speedOverGround',
        runningThresholdHz: 5,
        joinWindowMs: 5_000,
        bins: [
          { key: 'idle', maxHz: 15 },
          { key: 'cruise', maxHz: Number.POSITIVE_INFINITY },
        ],
      },
      t0,
      t0 + 15_000,
    );

    expect(result?.get('idle')).toEqual({
      fuelCount: 2,
      sogCount: 2,
      meanFuelRate: 2,
      meanSog: 5,
    });
    expect(result?.get('cruise')).toEqual({
      fuelCount: 1,
      sogCount: 1,
      meanFuelRate: 4,
      meanSog: 6,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (let index = 0; index < 3; index += 1) {
      const request = requestAt(fetchMock, index);
      expect(request.url.searchParams.get('epoch')).toBe('ms');
      expect(request.url.searchParams.get('q')).toContain('GROUP BY time(5s) fill(none)');
    }
  });

  it('widens long engine windows to keep aggregate result sets bounded', async () => {
    fetchMock.mockImplementation(async () => okResult([], []));
    const client = new InfluxDBClient({
      version: '2',
      url: 'http://influx.local:8086',
      database: 'signalk',
      username: '',
      password: '',
    });
    const fromMs = Date.parse('2025-08-01T00:00:00Z');

    await client.binEngineWindow(
      {
        rpmPath: 'rpm',
        fuelRatePath: 'fuel',
        sogPath: 'sog',
        runningThresholdHz: 5,
        joinWindowMs: 5_000,
        bins: [{ key: 'all', maxHz: Number.POSITIVE_INFINITY }],
      },
      fromMs,
      fromMs + 365 * 24 * 60 * 60 * 1000,
    );

    expect(requestAt(fetchMock).url.searchParams.get('q')).toContain(
      'GROUP BY time(631s) fill(none)',
    );
  });

  it('returns no engine window when the RPM measurement has no rows', async () => {
    fetchMock.mockImplementation(async () => okResult([], []));
    const client = new InfluxDBClient({
      version: '2',
      url: 'http://influx.local:8086',
      database: 'signalk',
      username: '',
      password: '',
    });

    await expect(
      client.binEngineWindow(
        {
          rpmPath: 'rpm',
          fuelRatePath: 'fuel',
          sogPath: 'sog',
          runningThresholdHz: 5,
          joinWindowMs: 5_000,
          bins: [{ key: 'all', maxHz: Number.POSITIVE_INFINITY }],
        },
        0,
        10_000,
      ),
    ).resolves.toBeNull();
  });

  it('rejects missing v1 self context before sending an analyzer query', async () => {
    const client = new InfluxDBClient({
      version: '1',
      url: 'http://influx.local:8086',
      database: 'signalk',
      username: '',
      password: '',
    });

    await expect(client.meanPaths(['path'], 0, 1_000)).rejects.toThrow(
      'Signal K self context is unavailable',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns generic query failures without including response content', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ error: 'private server detail' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new InfluxDBClient({
      version: '1',
      url: 'http://influx.local:8086',
      database: 'signalk',
      username: '',
      password: '',
      selfContext: 'vessels.self',
    });

    const error = await client.probe().then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('InfluxDB query failed');
    expect((error as Error).message).not.toContain('private server detail');
  });
});

describe('InfluxQL escaping', () => {
  it('escapes identifier and string delimiters', () => {
    expect(escapeInfluxIdentifier('a\\b"c')).toBe('a\\\\b\\"c');
    expect(escapeInfluxString("a\\b'c")).toBe("a\\\\b\\'c");
  });
});
