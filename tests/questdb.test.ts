import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuestDBClient } from '../src/core/questdb.js';

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
    const [url] = fetchMock.mock.calls[0]!;
    expect(typeof url).toBe('string');
    expect(decodeURIComponent((url as string).split('query=')[1]!)).toContain(
      "SELECT ts, value FROM signalk WHERE path = 'x'",
    );
  });

  it('query throws on non-200', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const q = new QuestDBClient({ url: 'http://localhost:9000' });
    await expect(q.query('SELECT 1')).rejects.toThrow(/HTTP 500/);
  });

  it('baselineFor returns null for empty dataset', async () => {
    fetchMock.mockResolvedValueOnce(ok({ columns: [], dataset: [] }));
    const q = new QuestDBClient({ url: 'http://localhost:9000' });
    const r = await q.baselineFor('propulsion.port.revolutions', 'vessels.self', 30);
    expect(r).toBeNull();
  });

  it('baselineFor returns aggregate stats from a single row', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        columns: [
          { name: 'min', type: 'DOUBLE' },
          { name: 'max', type: 'DOUBLE' },
          { name: 'mean', type: 'DOUBLE' },
          { name: 'p10', type: 'DOUBLE' },
          { name: 'p50', type: 'DOUBLE' },
          { name: 'p90', type: 'DOUBLE' },
        ],
        dataset: [[1, 100, 50, 5, 50, 95]],
      }),
    );
    const q = new QuestDBClient({ url: 'http://localhost:9000' });
    const r = await q.baselineFor('propulsion.port.revolutions', 'vessels.self', 30);
    expect(r).toEqual({ min: 1, max: 100, mean: 50, p10: 5, p50: 50, p90: 95 });
  });

  it('baselineFor propagates errors from query()', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const q = new QuestDBClient({ url: 'http://localhost:9000' });
    await expect(q.baselineFor('propulsion.port.revolutions', 'vessels.self', 30)).rejects.toThrow(
      /HTTP 500/,
    );
  });
});
