export interface BufferEntry {
  value: unknown;
  ts: number;
  source: string;
}

export interface BufferOptions {
  maxAgeMs: number;
  maxEntriesPerPath: number;
}

export class RollingBuffer {
  private store = new Map<string, BufferEntry[]>();

  constructor(private opts: BufferOptions) {}

  record(path: string, value: unknown, ts: number, source: string): void {
    let arr = this.store.get(path);
    if (!arr) {
      arr = [];
      this.store.set(path, arr);
    }
    arr.push({ value, ts, source });
    this.evict(arr, ts);
  }

  slice(path: string, fromTs: number, toTs: number): BufferEntry[] {
    const arr = this.store.get(path);
    if (!arr) return [];
    return arr.filter((e) => e.ts >= fromTs && e.ts <= toTs);
  }

  pathKeys(): IterableIterator<string> {
    return this.store.keys();
  }

  summarize(
    path: string,
    fromTs: number,
    toTs: number,
  ): { min: number; max: number; mean: number; count: number; sources: string[] } | null {
    const arr = this.slice(path, fromTs, toTs);
    const sources = new Set<string>();
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    let count = 0;
    for (const e of arr) {
      sources.add(e.source);
      if (typeof e.value !== 'number' || !Number.isFinite(e.value)) continue;
      if (e.value < min) min = e.value;
      if (e.value > max) max = e.value;
      sum += e.value;
      count += 1;
    }
    if (count === 0) return null;
    return {
      min,
      max,
      mean: sum / count,
      count,
      sources: Array.from(sources).sort(),
    };
  }

  private evict(arr: BufferEntry[], now: number): void {
    const cutoff = now - this.opts.maxAgeMs;
    let firstFresh = 0;
    while (firstFresh < arr.length) {
      const e = arr[firstFresh];
      if (!e || e.ts >= cutoff) break;
      firstFresh += 1;
    }
    if (firstFresh > 0) arr.splice(0, firstFresh);
    // Amortize the O(n) splice cost at saturation: when over cap, trim down by
    // 10% of cap so the next ~10% of records skip count eviction entirely.
    const cap = this.opts.maxEntriesPerPath;
    if (arr.length > cap) {
      arr.splice(0, arr.length - cap + Math.ceil(cap / 10));
    }
  }
}
