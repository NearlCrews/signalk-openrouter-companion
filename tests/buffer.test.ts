import { describe, expect, it } from 'vitest';
import { RollingBuffer } from '../src/core/buffer.js';
import { HOUR_MS, MINUTE_MS } from '../src/core/format.js';

describe('RollingBuffer', () => {
  it('records and slices entries by time range', () => {
    const buf = new RollingBuffer({ maxAgeMs: 60_000, maxEntriesPerPath: 100 });
    buf.record('a.b', 1, 1000, 's1');
    buf.record('a.b', 2, 2000, 's1');
    buf.record('a.b', 3, 3000, 's2');
    expect(buf.slice('a.b', 1500, 2500)).toEqual([{ value: 2, ts: 2000, source: 's1' }]);
    expect(buf.slice('a.b', 0, 10_000)).toHaveLength(3);
    expect(buf.slice('a.b', 0, 1000)).toHaveLength(1);
    expect(buf.slice('missing', 0, 10_000)).toEqual([]);
  });

  it('evicts entries older than maxAgeMs', () => {
    const buf = new RollingBuffer({ maxAgeMs: 1000, maxEntriesPerPath: 100 });
    buf.record('a.b', 1, 0, 's1');
    buf.record('a.b', 2, 500, 's1');
    buf.record('a.b', 3, 2000, 's1');
    expect(buf.slice('a.b', 0, 10_000)).toEqual([{ value: 3, ts: 2000, source: 's1' }]);
  });

  it('reads stay window-correct when a stale entry lingers behind a fresh front (evict fast path)', () => {
    const buf = new RollingBuffer({ maxAgeMs: 1000, maxEntriesPerPath: 100 });
    // A fresh delta (ts 5000) arrives first and becomes arr[0]; a stale delta
    // (ts 1000, a timestamp inversion across sources) arrives after. evict's
    // fast path sees a fresh front under the cap and skips compaction, so the
    // stale entry lingers in the array. slice() and summarize() must still
    // exclude it by window, which is what keeps the lingering entry harmless.
    buf.record('x', 10, 5000, 'a');
    buf.record('x', 99, 1000, 'b');
    const sliced = buf.slice('x', 4000, 5000);
    expect(sliced).toHaveLength(1);
    expect(sliced[0]?.value).toBe(10);
    const summary = buf.summarize('x', 4000, 5000);
    expect(summary?.count).toBe(1);
    expect(summary?.mean).toBe(10);
  });

  it('evicts the stale prefix of a path whose samples arrive in time order', () => {
    const buf = new RollingBuffer({ maxAgeMs: 1000, maxEntriesPerPath: 100 });
    for (let ts = 0; ts <= 3000; ts += 250) buf.record('a.b', ts, ts, 's1');
    const kept = buf.slice('a.b', 0, 10_000).map((e) => e.ts);
    expect(kept[0]).toBe(2000);
    expect(kept.at(-1)).toBe(3000);
    expect(buf.scan('a.b', 0, 10_000).count).toBe(kept.length);
  });

  it('still drops every stale entry of a path that has seen a timestamp inversion', () => {
    const buf = new RollingBuffer({ maxAgeMs: 1000, maxEntriesPerPath: 100 });
    buf.record('x', 1, 900, 'a');
    // An inversion: a second source stamps an older sample after a newer one.
    buf.record('x', 2, 100, 'b');
    buf.record('x', 3, 1500, 'a');
    // The front (ts 900) is still fresh, so nothing is evicted yet.
    expect(buf.scan('x', 0, 10_000).count).toBe(3);
    // Once the front ages out, the compaction also drops the stranded ts 100.
    buf.record('x', 4, 2000, 'a');
    expect(buf.slice('x', 0, 10_000).map((e) => e.ts)).toEqual([1500, 2000]);
  });

  it('evicts oldest entries when path exceeds maxEntriesPerPath', () => {
    const buf = new RollingBuffer({ maxAgeMs: 60_000, maxEntriesPerPath: 3 });
    buf.record('a.b', 1, 1000, 's1');
    buf.record('a.b', 2, 1100, 's1');
    buf.record('a.b', 3, 1200, 's1');
    buf.record('a.b', 4, 1300, 's1');
    // Count eviction is amortized: trim when over cap, leaving at most cap
    // entries and dropping the oldest first. The newest record always
    // survives; older entries beyond the per-trim chunk are dropped.
    const values = buf.slice('a.b', 0, 10_000).map((e) => e.value);
    expect(values.length).toBeLessThanOrEqual(3);
    expect(values.at(-1)).toBe(4);
    expect(values).not.toContain(1);
  });

  it('keeps record() amortized over many over-cap inserts', () => {
    const buf = new RollingBuffer({ maxAgeMs: 60_000, maxEntriesPerPath: 100 });
    for (let i = 0; i < 1_000; i += 1) buf.record('a.b', i, 1000 + i, 's1');
    const values = buf.slice('a.b', 0, 1_000_000).map((e) => e.value as number);
    expect(values.length).toBeLessThanOrEqual(100);
    expect(values.at(-1)).toBe(999);
  });

  it('keeps the newest entry when maxEntriesPerPath is 1', () => {
    const buf = new RollingBuffer({ maxAgeMs: 60_000, maxEntriesPerPath: 1 });
    buf.record('a.b', 1, 1000, 's1');
    buf.record('a.b', 2, 1100, 's1');
    buf.record('a.b', 3, 1200, 's1');
    expect(buf.slice('a.b', 0, 10_000)).toEqual([{ value: 3, ts: 1200, source: 's1' }]);
  });

  it('summarizes numeric values in a time range', () => {
    const buf = new RollingBuffer({ maxAgeMs: 60_000, maxEntriesPerPath: 100 });
    buf.record('rpm', 100, 1000, 's1');
    buf.record('rpm', 200, 1500, 's1');
    buf.record('rpm', 300, 2000, 's2');
    const s = buf.summarize('rpm', 0, 10_000);
    expect(s).toEqual({
      min: 100,
      max: 300,
      mean: 200,
      count: 3,
      sources: ['s1', 's2'],
    });
  });

  it('returns null from summarize when no numeric data in range', () => {
    const buf = new RollingBuffer({ maxAgeMs: 60_000, maxEntriesPerPath: 100 });
    buf.record('s', 'on', 1000, 's1');
    expect(buf.summarize('s', 0, 10_000)).toBeNull();
    expect(buf.summarize('missing', 0, 10_000)).toBeNull();
  });

  it('folds a window into newest timestamp, count, and sources', () => {
    const buf = new RollingBuffer({ maxAgeMs: 60_000, maxEntriesPerPath: 100 });
    buf.record('rpm', 100, 1000, 's2');
    buf.record('rpm', 'not a number', 1500, 's1');
    buf.record('rpm', 300, 2000, 's1');
    // Non-numeric samples still count as liveness: the path is producing.
    expect(buf.scan('rpm', 0, 10_000)).toEqual({
      newestTs: 2000,
      count: 3,
      sources: ['s1', 's2'],
    });
    expect(buf.scan('rpm', 0, 1200)).toEqual({ newestTs: 1000, count: 1, sources: ['s2'] });
    expect(buf.scan('missing', 0, 10_000)).toEqual({ newestTs: null, count: 0, sources: [] });
  });

  it('holds the whole buffer under the total cap by trimming the biggest path', () => {
    const buf = new RollingBuffer({
      maxAgeMs: 60_000,
      maxEntriesPerPath: 1000,
      maxTotalEntries: 20,
    });
    for (let i = 0; i < 30; i += 1) buf.record('chatty', i, 1000 + i, 's1');
    for (let i = 0; i < 5; i += 1) buf.record('quiet', i, 1000 + i, 's1');
    // The quiet path keeps its raw samples: a window inside its minute is exact.
    expect(buf.slice('quiet', 1001, 1003).map((e) => e.value)).toEqual([1, 2, 3]);
    // The chatty path lost its raw samples and keeps its minute bucket: a
    // window that cuts through the minute reads nothing rather than samples
    // from outside it, and one that holds the minute still counts all 30.
    expect(buf.slice('chatty', 1001, 1003)).toEqual([]);
    expect(buf.scan('chatty', 0, 10_000)).toEqual({ newestTs: 1029, count: 30, sources: ['s1'] });
  });

  it('drops the oldest buckets once the total cap has no raw samples left to take', () => {
    const buf = new RollingBuffer({
      maxAgeMs: 26 * HOUR_MS,
      maxEntriesPerPath: 100,
      maxTotalEntries: 10,
    });
    for (let m = 0; m < 30; m += 1) buf.record('slow', m, m * MINUTE_MS, 's1');
    const live = buf.scan('slow', 0, HOUR_MS);
    expect(live.count).toBeLessThanOrEqual(10);
    expect(live.newestTs).toBe(29 * MINUTE_MS);
    expect(buf.slice('slow', 0, HOUR_MS).map((e) => e.value)).not.toContain(0);
  });

  describe('a path past its raw cap', () => {
    // Two hours of a 1 Hz feed against a 100-sample raw cap.
    const twoHours = (): RollingBuffer => {
      const buf = new RollingBuffer({ maxAgeMs: 26 * HOUR_MS, maxEntriesPerPath: 100 });
      for (let s = 0; s < 7200; s += 1) buf.record('v', s, s * 1000, 'bmv');
      return buf;
    };

    it('still reads its whole window, every sample once', () => {
      const buf = twoHours();
      expect(buf.summarize('v', 0, 2 * HOUR_MS)).toEqual({
        min: 0,
        max: 7199,
        mean: 3599.5,
        count: 7200,
        sources: ['bmv'],
      });
      expect(buf.scan('v', 0, 2 * HOUR_MS)).toEqual({
        newestTs: 7_199_000,
        count: 7200,
        sources: ['bmv'],
      });
    });

    it('skips a bucket a window edge cuts through instead of reading outside the window', () => {
      const buf = twoHours();
      expect(buf.summarize('v', 30_500, 2 * HOUR_MS)?.min).toBe(60);
      const head = buf.summarize('v', 0, 90_500);
      expect(head?.max).toBe(59);
      expect(head?.count).toBe(60);
    });

    it('reads each bucket as its newest sample', () => {
      expect(twoHours().slice('v', 0, 2 * MINUTE_MS - 1)).toEqual([
        { value: 59, ts: 59_000, source: 'bmv' },
        { value: 119, ts: 119_000, source: 'bmv' },
      ]);
    });
  });

  it('folds interleaved sources into buckets of their own, even with skewed clocks', () => {
    // Source b stamps five minutes behind source a, so one shared bucket
    // series would flip between two minutes and open a bucket per sample.
    const buf = new RollingBuffer({
      maxAgeMs: 26 * HOUR_MS,
      maxEntriesPerPath: 10,
      maxTotalEntries: 1000,
    });
    for (let s = 0; s < 3600; s += 1) {
      buf.record('soc', 0.5, 10 * MINUTE_MS + s * 1000, 'a');
      buf.record('soc', 0.6, 5 * MINUTE_MS + s * 1000, 'b');
    }
    expect(buf.scan('soc', 0, 2 * HOUR_MS)).toEqual({
      newestTs: 10 * MINUTE_MS + 3_599_000,
      count: 7200,
      sources: ['a', 'b'],
    });
    expect(buf.summarize('soc', 0, 2 * HOUR_MS)?.mean).toBeCloseTo(0.55, 9);
  });
});
