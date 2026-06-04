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

  it('probe rejects on a transport failure so the caller can report the reason', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const q = new QuestDBClient({ url: 'http://localhost:9000' });
    await expect(q.probe()).rejects.toThrow('fetch failed');
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

  it('withTimeout propagates an already-aborted caller signal to the request', async () => {
    // Real fetch rejects synchronously when handed an already-aborted signal;
    // the stub mirrors that so probe surfaces the abort. The branch under test
    // is withTimeout's caller?.aborted fast path, which aborts the internal
    // controller before the listener would ever fire.
    fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) => {
      if (init.signal.aborted) return Promise.reject(new Error('aborted before fetch'));
      return Promise.resolve(ok({ dataset: [[1]] }));
    });
    const controller = new AbortController();
    controller.abort(new Error('caller already done'));
    const q = new QuestDBClient({ url: 'http://localhost:9000' });
    await expect(q.probe(controller.signal)).rejects.toThrow();
    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) throw new Error('expected fetch to be called');
    const init = firstCall[1] as { signal?: AbortSignal };
    expect(init.signal?.aborted).toBe(true);
  });

  it('withTimeout aborts the in-flight request when the timeout fires', async () => {
    vi.useFakeTimers();
    try {
      // The request never resolves on its own; it settles only when its signal
      // aborts. That forces the win to come from withTimeout's setTimeout path.
      fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('request aborted')), {
            once: true,
          });
        });
      });
      const q = new QuestDBClient({ url: 'http://localhost:9000' });
      const p = q.probe();
      // Attach the rejection handler before advancing timers so the rejection
      // is never unhandled. The default QuestDB timeout is 30s; advance past it.
      const expectation = expect(p).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(31_000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
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
