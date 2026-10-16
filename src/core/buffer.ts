import { MINUTE_MS } from './format.js';

export interface BufferEntry {
  value: unknown;
  ts: number;
  source: string;
}

interface BufferOptions {
  maxAgeMs: number;
  // Raw samples kept per path. Older samples live on only in their buckets.
  maxEntriesPerPath: number;
  // Ceiling across every path together, raw samples and buckets alike. The
  // per-path cap alone does not bound total memory: a vessel with a hundred
  // busy electrical and propulsion paths multiplies it by a hundred, which is
  // hundreds of megabytes on a Raspberry Pi. Omit to leave the total
  // unbounded.
  maxTotalEntries?: number;
  // Width of the summary buckets every sample also folds into. Defaults to a
  // minute.
  bucketMs?: number;
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

// One source's samples within one bucket-width slot: the count, the
// finite-number min, max, and sum, and the newest sample.
interface Bucket {
  slot: number;
  firstTs: number;
  ts: number;
  value: unknown;
  count: number;
  numeric: number;
  min: number;
  max: number;
  sum: number;
}

interface Series<T> {
  items: T[];
  // Set once an item arrives older than the one before it. Until then the
  // items are in timestamp order, so the stale ones are exactly a prefix.
  unordered: boolean;
}

interface PathStore {
  // Every sample from `floor` on, in arrival order.
  raw: Series<BufferEntry>;
  // Every sample, folded into buckets, one series per source so interleaved
  // sources each fill their own bucket rather than splitting each other's.
  buckets: Map<string, Series<Bucket>>;
  // The first slot the raw samples still cover in full. A read takes raw
  // samples from here on and buckets before it, so each sample counts once.
  // It starts at negative infinity and only a trim moves it: a path that never
  // outgrew its raw cap reads exactly as its raw samples.
  floor: number;
}

// Drop every item whose newest timestamp is before `cutoff` and return how
// many went. An ordered series drops its stale prefix in one splice; an
// unordered one is compacted in place, since a stale item can sit behind a
// fresh one.
function dropBefore<T extends { ts: number }>(series: Series<T>, cutoff: number): number {
  const { items } = series;
  const before = items.length;
  if (series.unordered) {
    let write = 0;
    for (const item of items) {
      if (item.ts >= cutoff) {
        items[write] = item;
        write += 1;
      }
    }
    items.length = write;
  } else {
    let stale = 0;
    while (stale < items.length && (items[stale]?.ts ?? cutoff) < cutoff) stale += 1;
    if (stale > 0) items.splice(0, stale);
  }
  return before - items.length;
}

// A rolling per-path window over the last `maxAgeMs`. Raw samples answer
// reads exactly, but a fast path outgrows any raw cap long before the window
// ends (a 10 Hz RPM feed fills 50,000 samples in under an hour and a half),
// so every sample also folds into per-source buckets. When the caps trim raw
// samples, reads fall back to the buckets for the trimmed span: min, max,
// mean, and count stay exact there, and a window edge that falls inside a
// bucket drops that bucket, so the window loses at most one bucket width at
// each end and never reads a sample from outside it.
export class RollingBuffer {
  private store = new Map<string, PathStore>();
  private readonly trimTo: number;
  private readonly bucketMs: number;
  // An ordered bucket series holds at most one bucket per slot in the window.
  // An unordered one can open a bucket per sample, so it gets twice that.
  private readonly maxBucketsPerSeries: number;
  // Running total of raw samples and buckets across every path, so the global
  // cap costs no map walk on the record path.
  private total = 0;

  constructor(private opts: BufferOptions) {
    // Keep at least 1: a maxEntriesPerPath of 1 would otherwise yield trimTo 0,
    // and the over-cap splice would drop the entry that was just recorded.
    this.trimTo = Math.max(1, opts.maxEntriesPerPath - Math.ceil(opts.maxEntriesPerPath / 10));
    this.bucketMs = opts.bucketMs ?? MINUTE_MS;
    this.maxBucketsPerSeries = 2 * (Math.ceil(opts.maxAgeMs / this.bucketMs) + 1);
  }

  record(path: string, value: unknown, ts: number, source: string): void {
    let store = this.store.get(path);
    if (!store) {
      store = {
        raw: { items: [], unordered: false },
        buckets: new Map(),
        floor: Number.NEGATIVE_INFINITY,
      };
      this.store.set(path, store);
    }
    this.fold(store, value, ts, source);
    // A sample in a slot the raw samples no longer cover lives in its bucket
    // only, the same as the rest of that slot.
    if (Math.floor(ts / this.bucketMs) >= store.floor) {
      const raw = store.raw;
      const last = raw.items[raw.items.length - 1];
      if (last && ts < last.ts) raw.unordered = true;
      raw.items.push({ value, ts, source });
      this.total += 1;
      this.evictRaw(store, ts);
    }
    this.enforceTotalCap();
  }

  // Fold one path's window in place. `liveness` needs only the newest
  // timestamp, the sample count, and the distinct sources, and it runs over
  // every buffered path on every fire, so materializing a filtered copy per
  // path is pure garbage.
  scan(path: string, fromTs: number, toTs: number): BufferLiveness {
    const store = this.store.get(path);
    if (!store) return { newestTs: null, count: 0, sources: [] };
    const sources = new Set<string>();
    let newestTs: number | null = null;
    let count = 0;
    for (const e of store.raw.items) {
      if (e.ts < fromTs || e.ts > toTs) continue;
      count += 1;
      sources.add(e.source);
      if (newestTs == null || e.ts > newestTs) newestTs = e.ts;
    }
    this.forEachBucket(store, fromTs, toTs, (b, source) => {
      count += b.count;
      sources.add(source);
      if (newestTs == null || b.ts > newestTs) newestTs = b.ts;
    });
    return { newestTs, count, sources: Array.from(sources).sort() };
  }

  // A path's entries are appended in arrival order with each delta's own
  // timestamp, and one path interleaves multiple sources, so the result is
  // not strictly ts-sorted. A bucket reads as its newest sample, a point
  // sample rather than a mean, so an angle such as a wind direction stays
  // meaningful.
  slice(path: string, fromTs: number, toTs: number): BufferEntry[] {
    const store = this.store.get(path);
    if (!store) return [];
    const entries: BufferEntry[] = [];
    this.forEachBucket(store, fromTs, toTs, (b, source) => {
      entries.push({ value: b.value, ts: b.ts, source });
    });
    for (const e of store.raw.items) {
      if (e.ts >= fromTs && e.ts <= toTs) entries.push(e);
    }
    return entries;
  }

  pathKeys(): IterableIterator<string> {
    return this.store.keys();
  }

  summarize(path: string, fromTs: number, toTs: number): BufferSummary | null {
    const store = this.store.get(path);
    if (!store) return null;
    const sources = new Set<string>();
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    let count = 0;
    for (const e of store.raw.items) {
      if (e.ts < fromTs || e.ts > toTs) continue;
      sources.add(e.source);
      if (typeof e.value !== 'number' || !Number.isFinite(e.value)) continue;
      if (e.value < min) min = e.value;
      if (e.value > max) max = e.value;
      sum += e.value;
      count += 1;
    }
    this.forEachBucket(store, fromTs, toTs, (b, source) => {
      sources.add(source);
      if (b.numeric === 0) return;
      if (b.min < min) min = b.min;
      if (b.max > max) max = b.max;
      sum += b.sum;
      count += b.numeric;
    });
    if (count === 0) return null;
    return {
      min,
      max,
      mean: sum / count,
      count,
      sources: Array.from(sources).sort(),
    };
  }

  // The buckets a window reads: only slots before the floor, since the raw
  // samples hold everything after it, and only buckets wholly inside the
  // window.
  private forEachBucket(
    store: PathStore,
    fromTs: number,
    toTs: number,
    visit: (bucket: Bucket, source: string) => void,
  ): void {
    if (store.floor === Number.NEGATIVE_INFINITY) return;
    for (const [source, series] of store.buckets) {
      for (const b of series.items) {
        if (b.slot < store.floor && b.firstTs >= fromTs && b.ts <= toTs) visit(b, source);
      }
    }
  }

  private fold(store: PathStore, value: unknown, ts: number, source: string): void {
    const slot = Math.floor(ts / this.bucketMs);
    const numeric = typeof value === 'number' && Number.isFinite(value) ? value : null;
    let series = store.buckets.get(source);
    if (!series) {
      series = { items: [], unordered: false };
      store.buckets.set(source, series);
    }
    const last = series.items[series.items.length - 1];
    if (last?.slot === slot) {
      last.count += 1;
      if (ts < last.firstTs) last.firstTs = ts;
      if (ts >= last.ts) {
        last.ts = ts;
        last.value = value;
      }
      if (numeric !== null) {
        last.numeric += 1;
        if (numeric < last.min) last.min = numeric;
        if (numeric > last.max) last.max = numeric;
        last.sum += numeric;
      }
      return;
    }
    if (last && slot < last.slot) series.unordered = true;
    series.items.push({
      slot,
      firstTs: ts,
      ts,
      value,
      count: 1,
      numeric: numeric === null ? 0 : 1,
      min: numeric ?? Number.POSITIVE_INFINITY,
      max: numeric ?? Number.NEGATIVE_INFINITY,
      sum: numeric ?? 0,
    });
    this.total += 1;
    // A new bucket opens at most once per bucket width per source, so aging
    // the series here costs nothing per sample.
    this.total -= dropBefore(series, ts - this.opts.maxAgeMs);
    const over = series.items.length - this.maxBucketsPerSeries;
    if (over > 0) {
      series.items.splice(0, over);
      this.total -= over;
    }
  }

  private evictRaw(store: PathStore, now: number): void {
    const { raw } = store;
    // Steady-state fast path: the first-arrived sample is still inside the
    // window and the path is under its cap, so there is nothing to drop and
    // record() stays O(1). A stale sample stranded behind a timestamp
    // inversion lingers harmlessly here: every read re-filters by window, and
    // the over-cap trim below still bounds memory.
    const oldest = raw.items[0];
    if (oldest && oldest.ts >= now - this.opts.maxAgeMs) {
      if (raw.items.length <= this.opts.maxEntriesPerPath) return;
    } else {
      // Aged-out samples leave the floor alone: their buckets age out at the
      // same horizon, so no window can reach them either way.
      this.total -= dropBefore(raw, now - this.opts.maxAgeMs);
    }
    if (raw.items.length > this.opts.maxEntriesPerPath) {
      this.trimRaw(store, raw.items.length - this.trimTo);
    }
  }

  // Drop at least `drop` raw samples, oldest first. They live on in their
  // buckets, so the floor moves past the slot of the newest one dropped, and
  // the rest of that slot goes too: raw samples then cover every slot from the
  // floor on in full, and buckets every slot before it.
  private trimRaw(store: PathStore, drop: number): void {
    const { items } = store.raw;
    let newest = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < drop && i < items.length; i += 1) {
      const ts = items[i]?.ts ?? newest;
      if (ts > newest) newest = ts;
    }
    if (newest === Number.NEGATIVE_INFINITY) return;
    store.floor = Math.max(store.floor, Math.floor(newest / this.bucketMs) + 1);
    this.total -= dropBefore(store.raw, store.floor * this.bucketMs);
  }

  // Hold the whole buffer under its total budget. Raw samples go first, from
  // the path holding the most: one chatty path is what pushes the total over,
  // and its trimmed span still reads from buckets. Only once no raw samples
  // are left do the oldest buckets of the longest series go.
  private enforceTotalCap(): void {
    const cap = this.opts.maxTotalEntries;
    if (cap === undefined || this.total <= cap) return;
    while (this.total > cap) {
      let biggest: PathStore | null = null;
      for (const store of this.store.values()) {
        if (!biggest || store.raw.items.length > biggest.raw.items.length) biggest = store;
      }
      const rawLength = biggest?.raw.items.length ?? 0;
      if (biggest && rawLength > 0) {
        this.trimRaw(biggest, Math.max(1, Math.ceil(rawLength / 10)));
        continue;
      }
      let longest: Series<Bucket> | null = null;
      for (const store of this.store.values()) {
        for (const series of store.buckets.values()) {
          if (!longest || series.items.length > longest.items.length) longest = series;
        }
      }
      // Nothing left to reclaim: a cap below the number of live series would
      // otherwise spin here.
      if (!longest || longest.items.length === 0) return;
      const drop = Math.max(1, Math.ceil(longest.items.length / 10));
      longest.items.splice(0, drop);
      this.total -= drop;
    }
  }
}
