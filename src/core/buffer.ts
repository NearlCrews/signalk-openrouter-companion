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

  paths(): IterableIterator<[string, BufferEntry[]]> {
    return this.store.entries();
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
    while (arr.length > 0) {
      const first = arr[0];
      if (!first || first.ts >= cutoff) break;
      arr.shift();
    }
    while (arr.length > this.opts.maxEntriesPerPath) {
      arr.shift();
    }
  }
}
