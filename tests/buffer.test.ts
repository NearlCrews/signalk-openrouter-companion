import { describe, expect, it } from 'vitest';
import { RollingBuffer } from '../src/core/buffer.js';

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
});
