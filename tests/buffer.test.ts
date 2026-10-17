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
    // Once the front ages out, the compaction also drops the stranded ts 100.
    buf.record('x', 4, 2000, 'a');
    expect(buf.slice('x', 0, 10_000).map((e) => e.ts)).toEqual([1500, 2000]);
  });

  it('folds the oldest samples into their bucket when a path exceeds maxEntriesPerPath', () => {
    const buf = new RollingBuffer({ maxAgeMs: 60_000, maxEntriesPerPath: 3 });
    for (let i = 1; i <= 4; i += 1) buf.record('a.b', i, 900 + i * 100, 's1');
    // The cap moves the two first-arrived samples into their minute bucket,
    // which reads as its newest sample, and keeps the newest two raw.
    expect(buf.slice('a.b', 0, 10_000).map((e) => e.value)).toEqual([2, 3, 4]);
    expect(buf.summarize('a.b', 0, 10_000)).toEqual({
      min: 1,
      max: 4,
      mean: 2.5,
      count: 4,
      sources: ['s1'],
    });
  });

  it('keeps the just-recorded sample raw when the cap trims inside one minute', () => {
    const buf = new RollingBuffer({ maxAgeMs: 60_000, maxEntriesPerPath: 3 });
    for (let i = 1; i <= 4; i += 1) buf.record('a', i, 900 + i * 100, 's1');
    // The bucket starts before the window and is skipped; the raw samples
    // inside it still answer.
    expect(buf.summarize('a', 1050, 1250)).toEqual({
      min: 3,
      max: 3,
      mean: 3,
      count: 1,
      sources: ['s1'],
    });
  });

  it('keeps record() amortized over many over-cap inserts', () => {
    const buf = new RollingBuffer({ maxAgeMs: 60_000, maxEntriesPerPath: 100 });
    for (let i = 0; i < 1_000; i += 1) buf.record('a.b', i, 1000 + i, 's1');
    expect(buf.slice('a.b', 1000, 1_000_000).length).toBeLessThanOrEqual(101);
    expect(buf.slice('a.b', 1990, 1_000_000).map((e) => e.value)).toEqual([
      990, 991, 992, 993, 994, 995, 996, 997, 998, 999,
    ]);
    expect(buf.scan('a.b', 0, 1_000_000).count).toBe(1000);
  });

  it('keeps the newest entry raw when maxEntriesPerPath is 1', () => {
    const buf = new RollingBuffer({ maxAgeMs: 60_000, maxEntriesPerPath: 1 });
    buf.record('a.b', 1, 1000, 's1');
    buf.record('a.b', 2, 1100, 's1');
    buf.record('a.b', 3, 1200, 's1');
    expect(buf.slice('a.b', 1150, 10_000)).toEqual([{ value: 3, ts: 1200, source: 's1' }]);
    expect(buf.summarize('a.b', 0, 10_000)?.count).toBe(3);
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

  it('holds the whole buffer under the total cap by folding the longest raw tier first', () => {
    const buf = new RollingBuffer({
      maxAgeMs: 60_000,
      maxEntriesPerPath: 1000,
      maxTotalEntries: 20,
    });
    for (let i = 0; i < 30; i += 1) buf.record('chatty', i, 1000 + i, 's1');
    for (let i = 0; i < 5; i += 1) buf.record('quiet', i, 1000 + i, 's1');
    // The quiet path keeps every sample raw. The chatty one folded most of
    // its minute into a bucket, so it still counts all 30 but no longer
    // reads them one by one.
    expect(buf.slice('quiet', 0, 10_000).map((e) => e.value)).toEqual([0, 1, 2, 3, 4]);
    expect(buf.scan('chatty', 0, 10_000)).toEqual({ newestTs: 1029, count: 30, sources: ['s1'] });
    expect(buf.slice('chatty', 0, 10_000).length).toBeLessThan(30);
  });

  it('drops the oldest buckets once folding saves no more room', () => {
    // Thirty minutes at 1 Hz against a total of 30: one source map and about
    // a dozen minute buckets fit beside the newest raw samples.
    const buf = new RollingBuffer({
      maxAgeMs: 26 * HOUR_MS,
      maxEntriesPerPath: 20,
      maxTotalEntries: 30,
    });
    const end = 30 * 60;
    for (let s = 0; s < end; s += 1) buf.record('v', s, s * 1000, 'bmv');
    expect(buf.scan('v', 0, HOUR_MS).newestTs).toBe((end - 1) * 1000);
    expect(buf.summarize('v', 25 * MINUTE_MS, HOUR_MS)?.count).toBe(5 * 60);
    expect(buf.summarize('v', 0, 15 * MINUTE_MS - 1)).toBeNull();
  });

  it('keeps the newest sample of every path readable under total cap pressure', () => {
    const buf = new RollingBuffer({
      maxAgeMs: 26 * HOUR_MS,
      maxEntriesPerPath: 1000,
      maxTotalEntries: 50,
    });
    for (let s = 0; s < 600; s += 1) {
      for (const path of ['p0', 'p1', 'p2']) buf.record(path, s, s * 1000, 'src');
    }
    // A fire half a second before the newest sample still sees one a
    // second old.
    const fired = 599_000 - 500;
    expect(buf.scan('p0', 0, fired).newestTs).toBe(598_000);
  });

  it('ages out the buckets of a source that stopped sending', () => {
    const buf = new RollingBuffer({ maxAgeMs: HOUR_MS, maxEntriesPerPath: 100 });
    for (let s = 0; s < 600; s += 1) {
      buf.record('p', 1, s * 1000, 'a');
      buf.record('p', 2, s * 1000, 'b');
    }
    for (let s = 600; s < 2 * 3600; s += 1) buf.record('p', 1, s * 1000, 'a');
    const live = buf.scan('p', 0, 2 * HOUR_MS);
    expect(live.sources).toEqual(['a']);
    expect(live.count).toBeLessThanOrEqual(3600 + 60);
  });

  // Capacity at a smaller scale: one-second buckets, ten samples a bucket, a
  // one-minute window, and a raw cap whose tiers alone overflow the total.
  describe('capacity under the total cap', () => {
    const capacityBuffer = (): RollingBuffer =>
      new RollingBuffer({
        maxAgeMs: 60_000,
        maxEntriesPerPath: 150,
        maxTotalEntries: 14_000,
        bucketMs: 1000,
      });

    it('folds raw samples to keep every path whole when raw tiers alone fill the cap', () => {
      const buf = capacityBuffer();
      for (let k = 0; k < 1200; k += 1) {
        for (let p = 0; p < 100; p += 1) buf.record(`p${p}`, k, k * 100, 'src');
      }
      for (let p = 0; p < 100; p += 1) {
        expect(buf.summarize(`p${p}`, 64_000, 119_900)?.count).toBe(560);
        expect(buf.scan(`p${p}`, 0, 119_900).newestTs).toBe(119_900);
      }
    });

    it('ages a silent path down to its newest sample while live paths keep their window', () => {
      const buf = capacityBuffer();
      for (let k = 0; k < 1800; k += 1) {
        if (k < 300) for (let p = 0; p < 20; p += 1) buf.record(`engine${p}`, k, k * 100, 'n2k');
        for (let p = 0; p < 80; p += 1) buf.record(`live${p}`, k, k * 100, 'src');
      }
      expect(buf.scan('engine0', 0, 179_900)).toEqual({
        newestTs: 29_900,
        count: 1,
        sources: ['n2k'],
      });
      for (let p = 0; p < 80; p += 1) {
        expect(buf.summarize(`live${p}`, 124_000, 179_900)?.count).toBe(560);
      }
    });
  });

  it('charges each new source label against the total cap', () => {
    const buf = new RollingBuffer({
      maxAgeMs: 26 * HOUR_MS,
      maxEntriesPerPath: 100,
      maxTotalEntries: 1000,
    });
    for (let i = 0; i < 50_000; i += 1) buf.record('p', i, i, `label-${i}`);
    // Raw samples cost one each, and a demoted one opens a bucket and a source
    // map of its own, which cost five.
    expect(buf.scan('p', 0, 100_000).sources.length).toBeLessThanOrEqual(100 + 900 / 5);
  });

  it('bounds the sources it holds when every sample carries a new label', () => {
    const buf = new RollingBuffer({
      maxAgeMs: 26 * HOUR_MS,
      maxEntriesPerPath: 100,
      maxTotalEntries: 1000,
    });
    for (let i = 0; i < 50_000; i += 1) buf.record('p', i, i, `label-${i}`);
    const live = buf.scan('p', 0, 100_000);
    expect(live.newestTs).toBe(49_999);
    expect(live.sources.length).toBeLessThanOrEqual(1000);
  });

  it('keeps other sources raw when one source stamps ahead of the rest', () => {
    const buf = new RollingBuffer({ maxAgeMs: 26 * HOUR_MS, maxEntriesPerPath: 100 });
    const t0 = 10 * HOUR_MS;
    buf.record('p', 9, t0 + 50 * MINUTE_MS, 'fast-clock');
    for (let s = 0; s <= 100; s += 1) buf.record('p', s, t0 + s * 1000, 'a');
    const end = t0 + 100_000;
    expect(buf.summarize('p', end - 29_500, end)?.count).toBe(30);
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

  it('folds one label carrying two clocks into one bucket per minute', () => {
    // Two producers five minutes apart share the fallback label, so the
    // demoted samples flip between two minutes. A bucket per sample would
    // blow the total cap and shorten the window.
    const buf = new RollingBuffer({
      maxAgeMs: 26 * HOUR_MS,
      maxEntriesPerPath: 10,
      maxTotalEntries: 300,
    });
    for (let s = 0; s < 3600; s += 1) {
      buf.record('soc', 0.5, 10 * MINUTE_MS + s * 1000, 'unknown');
      buf.record('soc', 0.6, 5 * MINUTE_MS + s * 1000, 'unknown');
    }
    expect(buf.summarize('soc', 0, 2 * HOUR_MS)?.count).toBe(7200);
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
