export interface BufferEntry {
  value: unknown;
  ts: number;
  source: string;
}

interface BufferOptions {
  maxAgeMs: number;
  maxEntriesPerPath: number;
  // Ceiling across every path together. The per-path cap alone does not bound
  // total memory: a vessel with a hundred busy electrical and propulsion paths
  // multiplies it by a hundred, which is hundreds of megabytes on a Raspberry
  // Pi. Omit to leave the total unbounded.
  maxTotalEntries?: number;
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

// Liveness view of one path over a window: how fresh it is, how much arrived,
// and which sources served it. Returned by `scan`.
export interface BufferLiveness {
  newestTs: number | null;
  count: number;
  sources: string[];
}

export class RollingBuffer {
  private store = new Map<string, BufferEntry[]>();
  private readonly trimTo: number;
  // Running total across every path, so the global cap costs no map walk on
  // the record path.
  private total = 0;

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
    this.total += 1;
    const before = arr.length;
    this.evict(arr, ts);
    this.total -= before - arr.length;
    this.enforceTotalCap();
  }

  // Fold one path's window in place. `liveness` needs only the newest
  // timestamp, the sample count, and the distinct sources, and it runs over
  // every buffered path on every fire, so materializing a filtered copy per
  // path (up to maxEntriesPerPath entries) is pure garbage.
  scan(path: string, fromTs: number, toTs: number): BufferLiveness {
    const arr = this.store.get(path);
    if (!arr) return { newestTs: null, count: 0, sources: [] };
    const sources = new Set<string>();
    let newestTs: number | null = null;
    let count = 0;
    for (const e of arr) {
      if (e.ts < fromTs || e.ts > toTs) continue;
      count += 1;
      sources.add(e.source);
      if (newestTs == null || e.ts > newestTs) newestTs = e.ts;
    }
    return { newestTs, count, sources: Array.from(sources).sort() };
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
    // Steady-state fast path: the first-arrived entry is still inside the
    // window and the path is under its cap, so there is nothing to drop. Skip
    // the O(n) compaction; record() then stays O(1) until the front ages out
    // or the cap is reached. A stale entry stranded behind a timestamp
    // inversion lingers harmlessly here: slice() and summarize() re-filter by
    // window on read, and the over-cap splice below still bounds memory.
    const oldest = arr[0];
    if (oldest && oldest.ts >= cutoff && arr.length <= this.opts.maxEntriesPerPath) return;
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

  // Hold the whole buffer under its total budget by trimming the biggest path
  // first: one chatty path is what pushes the total over, and every consumer
  // reads aggregates over a window rather than a fixed sample count.
  private enforceTotalCap(): void {
    const cap = this.opts.maxTotalEntries;
    if (cap === undefined || this.total <= cap) return;
    while (this.total > cap) {
      let biggest: BufferEntry[] | null = null;
      for (const arr of this.store.values()) {
        if (!biggest || arr.length > biggest.length) biggest = arr;
      }
      // Nothing left to reclaim: a cap below the number of live paths would
      // otherwise spin here.
      if (!biggest || biggest.length === 0) return;
      const drop = Math.min(biggest.length, Math.max(1, Math.ceil(biggest.length / 10)));
      biggest.splice(0, drop);
      this.total -= drop;
    }
  }
}
