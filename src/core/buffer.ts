export interface BufferEntry {
  value: unknown;
  ts: number;
  source: string;
}

interface BufferOptions {
  maxAgeMs: number;
  maxEntriesPerPath: number;
}

// Numeric summary of one path over a time window. Returned by `summarize`;
// exported so analyzers reuse it instead of re-declaring the same shape.
export interface BufferSummary {
  min: number;
  max: number;
  mean: number;
  count: number;
  sources: string[];
}

export class RollingBuffer {
  private store = new Map<string, BufferEntry[]>();
  private readonly trimTo: number;

  constructor(private opts: BufferOptions) {
    // Keep at least 1: a maxEntriesPerPath of 1 would otherwise yield trimTo 0,
    // and the over-cap splice would drop the entry that was just recorded.
    this.trimTo = Math.max(1, opts.maxEntriesPerPath - Math.ceil(opts.maxEntriesPerPath / 10));
  }

  record(path: string, value: unknown, ts: number, source: string): void {
    let arr = this.store.get(path);
    if (!arr) {
      arr = [];
      this.store.set(path, arr);
    }
    arr.push({ value, ts, source });
    this.evict(arr, ts);
  }

  // A path's entries are appended in arrival order with each delta's own
  // timestamp, and one path interleaves multiple sources, so the array is
  // not strictly ts-sorted. The window filter must stay order-agnostic: a
  // binary search would silently miss entries past a timestamp inversion.
  slice(path: string, fromTs: number, toTs: number): BufferEntry[] {
    const arr = this.store.get(path);
    if (!arr) return [];
    return arr.filter((e) => e.ts >= fromTs && e.ts <= toTs);
  }

  pathKeys(): IterableIterator<string> {
    return this.store.keys();
  }

  summarize(path: string, fromTs: number, toTs: number): BufferSummary | null {
    const arr = this.store.get(path);
    if (!arr) return null;
    const sources = new Set<string>();
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    let count = 0;
    for (const e of arr) {
      if (e.ts < fromTs || e.ts > toTs) continue;
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

  // A path's entries interleave multiple sources, each carrying its own
  // delta timestamp, so the array is not strictly ts-sorted. A forward scan
  // that stops at the first fresh entry would miss stale entries stranded
  // behind a timestamp inversion. Compact in place over every entry instead.
  private evict(arr: BufferEntry[], now: number): void {
    const cutoff = now - this.opts.maxAgeMs;
    let write = 0;
    for (let read = 0; read < arr.length; read += 1) {
      const e = arr[read];
      if (e && e.ts >= cutoff) {
        arr[write] = e;
        write += 1;
      }
    }
    if (write < arr.length) arr.length = write;
    if (arr.length > this.opts.maxEntriesPerPath) {
      arr.splice(0, arr.length - this.trimTo);
    }
  }
}
