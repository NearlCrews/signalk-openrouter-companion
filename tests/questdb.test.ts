import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { escapeSqlLiteral, indexColumns, QuestDBClient } from '../src/core/questdb.js';

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('QuestDBClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('probe returns true on 200 with parseable JSON', async () => {
    fetchMock.mockResolvedValueOnce(ok({ dataset: [[1]], columns: [{ name: 'x', type: 'INT' }] }));
    const q = new QuestDBClient({ url: 'http://localhost:9000' });
    expect(await q.probe()).toBe(true);
  });

  it('probe returns false on network failure', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const q = new QuestDBClient({ url: 'http://localhost:9000' });
    expect(await q.probe()).toBe(false);
  });

  it('query passes through SQL urlencoded and parses response', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        columns: [
          { name: 'ts', type: 'TIMESTAMP' },
          { name: 'value', type: 'DOUBLE' },
        ],
        dataset: [['2026-05-10T00:00:00Z', 12.5]],
      }),
    );
    const q = new QuestDBClient({ url: 'http://localhost:9000' });
    const r = await q.query("SELECT ts, value FROM signalk WHERE path = 'x'");
    expect(r.columns).toEqual([
      { name: 'ts', type: 'TIMESTAMP' },
      { name: 'value', type: 'DOUBLE' },
    ]);
    expect(r.dataset).toEqual([['2026-05-10T00:00:00Z', 12.5]]);
    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) throw new Error('expected fetch call');
    const [url] = firstCall;
    expect(typeof url).toBe('string');
    const queryPart = (url as string).split('query=')[1];
    if (!queryPart) throw new Error('expected query= in URL');
    expect(decodeURIComponent(queryPart)).toContain(
      "SELECT ts, value FROM signalk WHERE path = 'x'",
    );
  });

  it('query throws on non-200', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const q = new QuestDBClient({ url: 'http://localhost:9000' });
    await expect(q.query('SELECT 1')).rejects.toThrow(/HTTP 500/);
  });
});

describe('escapeSqlLiteral', () => {
  it('doubles single quotes and leaves other text untouched', () => {
    expect(escapeSqlLiteral("O'Brien")).toBe("O''Brien");
    expect(escapeSqlLiteral("a'b'c")).toBe("a''b''c");
    expect(escapeSqlLiteral('environment.outside.pressure')).toBe('environment.outside.pressure');
    expect(escapeSqlLiteral('')).toBe('');
  });
});

describe('indexColumns', () => {
  it('maps column names to their dataset index', () => {
    const idx = indexColumns({
      columns: [
        { name: 'path', type: 'STRING' },
        { name: 'mean_value', type: 'DOUBLE' },
      ],
      dataset: [],
    });
    expect(idx.get('path')).toBe(0);
    expect(idx.get('mean_value')).toBe(1);
    expect(idx.get('missing')).toBeUndefined();
  });

  it('returns an empty map for a result with no columns', () => {
    expect(indexColumns({ columns: [], dataset: [] }).size).toBe(0);
  });
});
