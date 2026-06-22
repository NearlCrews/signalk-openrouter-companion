import { describe, expect, it } from 'vitest';
import { evictStale, evictStaleSpan, fuseMax, fuseMin } from '../src/core/readings.js';

interface Reading {
  ts: number;
  value: number;
}

function makeMap(entries: Array<[string, Reading]>): Map<string, Reading> {
  return new Map(entries);
}

const readingValue = (r: Reading): number => r.value;

describe('evictStale', () => {
  it('drops entries older than the cutoff and keeps the rest', () => {
    const map = makeMap([
      ['old', { ts: 10, value: 1 }],
      ['live', { ts: 100, value: 2 }],
    ]);
    evictStale(map, 50);
    expect([...map.keys()]).toEqual(['live']);
  });
});

describe('fuseMin', () => {
  it('returns the minimum over live readings and evicts stale ones', () => {
    const map = makeMap([
      ['a', { ts: 100, value: 5 }],
      ['b', { ts: 100, value: 3 }],
      ['stale', { ts: 1, value: 0 }],
    ]);
    expect(fuseMin(map, 50, readingValue)).toBe(3);
    expect(map.has('stale')).toBe(false);
  });

  it('returns +Infinity when no live reading remains', () => {
    const map = makeMap([['stale', { ts: 1, value: 7 }]]);
    expect(fuseMin(map, 50, readingValue)).toBe(Number.POSITIVE_INFINITY);
    expect(map.size).toBe(0);
  });
});

describe('fuseMax', () => {
  it('returns the maximum over live readings and evicts stale ones', () => {
    const map = makeMap([
      ['a', { ts: 100, value: 5 }],
      ['b', { ts: 100, value: 9 }],
      ['stale', { ts: 1, value: 99 }],
    ]);
    expect(fuseMax(map, 50, readingValue)).toBe(9);
    expect(map.has('stale')).toBe(false);
  });

  it('returns -Infinity when no live reading remains', () => {
    const map = makeMap([['stale', { ts: 1, value: 7 }]]);
    expect(fuseMax(map, 50, readingValue)).toBe(Number.NEGATIVE_INFINITY);
    expect(map.size).toBe(0);
  });
});

describe('evictStaleSpan', () => {
  it('returns max minus min over the survivors in one pass', () => {
    const map = makeMap([
      ['a', { ts: 100, value: 3.3 }],
      ['b', { ts: 100, value: 3.5 }],
      ['stale', { ts: 1, value: 9 }],
    ]);
    expect(evictStaleSpan(map, 50, readingValue)).toBeCloseTo(0.2, 10);
    expect(map.has('stale')).toBe(false);
  });

  it('returns 0 when every reading is stale', () => {
    const map = makeMap([['stale', { ts: 1, value: 9 }]]);
    expect(evictStaleSpan(map, 50, readingValue)).toBe(0);
    expect(map.size).toBe(0);
  });
});
