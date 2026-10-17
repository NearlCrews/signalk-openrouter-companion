import { asFiniteNumber, compositeKey, MINUTE_MS } from './format.js';

export interface BufferEntry {
  value: unknown;
  ts: number;
  source: string;
}

interface BufferOptions {
  maxAgeMs: number;
  // Raw samples kept per path. Past it the oldest fold into their buckets, so
  // this bounds a path's raw samples, not its buckets.
  maxEntriesPerPath: number;
  // Ceiling across every path together, counted in raw samples, with a bucket
  // and a source's bucket map each costing what their heap does. The per-path
  // cap alone bounds neither total memory nor a path's buckets: a vessel with
  // a hundred busy electrical and propulsion paths multiplies it by a hundred,
  // and every new source label opens buckets of its own. Omit to leave the
  // total unbounded.
  maxTotalEntries?: number;
  // Width of the buckets a demoted sample folds into. Defaults to a minute.
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

// One source's demoted samples within one bucket-width slot: the count, the
// finite-number count, min, max, and sum, the oldest timestamp, and the
// newest sample.
interface Bucket {
  firstTs: number;
  ts: number;
  value: unknown;
  count: number;
  numeric: number;
  min: number;
  max: number;
  sum: number;
}

// Heap per item, measured on Node 24: a raw sample holds about 92 bytes, a
// bucket about 220, and a source's own bucket map with its label about 250
// more. The total cap counts in raw samples, so a bucket costs two and a
// source map three.
const BUCKET_COST = 2;
const SERIES_COST = 3;

interface PathStore {
  // The newest samples, in arrival order.
  raw: BufferEntry[];
  // Set once a sample arrives older than the one before it. Until then the
  // raw samples are in timestamp order, so the stale ones are exactly a prefix.
  unordered: boolean;
  // The samples demotion folded, keyed by source and then by slot, so
  // interleaved sources each fill their own buckets and a source label shared
  // by two clocks still folds into one bucket per slot.
  buckets: Map<string, Map<number, Bucket>>;
  bucketCount: number;
  // The newest sample the path has recorded, kept once everything else ages
  // out so a path that fell silent still reads how long it has been quiet.
  newest: BufferEntry;
}

// A rolling per-path window over the last `maxAgeMs`. The newest samples of
// each path stay raw and answer reads exactly. A fast path outgrows any raw
// cap long before the window ends (a 10 Hz RPM feed fills an hour of 1 Hz
// samples in six minutes), so the caps demote the oldest raw samples into
// per-source buckets instead of dropping them. Every sample lives in exactly
// one of the two, so a read counts it once: min, max, mean, and count stay
// exact across the window, and a window edge that falls inside a bucket skips
// that bucket, so the window loses at most one bucket width at each end and
// never reads a sample from outside it.
export class RollingBuffer {
  private store = new Map<string, PathStore>();
  private readonly trimTo: number;
  private readonly bucketMs: number;
  // Running cost of every raw sample, bucket, and source map across every
  // path, so the global cap costs no map walk on the record path.
  private total = 0;
  // The slot of the age horizon at the last sweep, so every path ages once
  // per bucket width, whether or not it is still recording.
  private sweptSlot = Number.NEGATIVE_INFINITY;

  constructor(private opts: BufferOptions) {
    // Keep at least 1: a maxEntriesPerPath of 1 would otherwise yield trimTo 0,
    // and the over-cap demotion would take the sample that was just recorded.
    this.trimTo = Math.max(1, opts.maxEntriesPerPath - Math.ceil(opts.maxEntriesPerPath / 10));
    this.bucketMs = opts.bucketMs ?? MINUTE_MS;
  }

  record(path: string, value: unknown, ts: number, source: string): void {
    const entry: BufferEntry = { value, ts, source };
    let store = this.store.get(path);
    if (!store) {
      store = { raw: [], unordered: false, buckets: new Map(), bucketCount: 0, newest: entry };
      this.store.set(path, store);
    }
    const last = store.raw[store.raw.length - 1];
    if (last && ts < last.ts) store.unordered = true;
    if (ts >= store.newest.ts) store.newest = entry;
    store.raw.push(entry);
    this.total += 1;
    const cutoff = ts - this.opts.maxAgeMs;
    this.evict(store, cutoff);
    this.sweep(cutoff);
    this.enforceTotalCap(cutoff);
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
    for (const e of store.raw) {
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
    for (const e of store.raw) {
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
    for (const e of store.raw) {
      if (e.ts < fromTs || e.ts > toTs) continue;
      sources.add(e.source);
      const value = asFiniteNumber(e.value);
      if (value === null) continue;
      if (value < min) min = value;
      if (value > max) max = value;
      sum += value;
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

  // The buckets a window reads: only those wholly inside it.
  private forEachBucket(
    store: PathStore,
    fromTs: number,
    toTs: number,
    visit: (bucket: Bucket, source: string) => void,
  ): void {
    for (const [source, series] of store.buckets) {
      for (const b of series.values()) {
        if (b.firstTs >= fromTs && b.ts <= toTs) visit(b, source);
      }
    }
  }

  private evict(store: PathStore, cutoff: number): void {
    // Steady-state fast path: the first-arrived sample is still inside the
    // window, so there is nothing to drop and record() stays O(1). A stale
    // sample stranded behind a timestamp inversion lingers harmlessly here:
    // every read re-filters by window, and the sweep and the over-cap
    // demotion below still bound memory.
    const oldest = store.raw[0];
    if (oldest && oldest.ts < cutoff) this.dropStaleRaw(store, cutoff);
    if (store.raw.length > this.opts.maxEntriesPerPath) {
      this.demote(store, store.raw.length - this.trimTo, cutoff);
    }
  }

  // Age every path once per bucket width. A path ages here even after it
  // stops recording, so its expired samples cannot outlive the live window of
  // a path that is still sending. A silent path keeps only its newest sample.
  private sweep(cutoff: number): void {
    const slot = Math.floor(cutoff / this.bucketMs);
    if (slot <= this.sweptSlot) return;
    this.sweptSlot = slot;
    for (const store of this.store.values()) {
      if (store.newest.ts < cutoff) {
        if (store.bucketCount === 0 && store.raw.length === 1 && store.raw[0] === store.newest)
          continue;
        this.dropBuckets(store, () => true);
        this.total += 1 - store.raw.length;
        store.raw = [store.newest];
        store.unordered = false;
        continue;
      }
      const oldest = store.raw[0];
      if (store.unordered || (oldest && oldest.ts < cutoff)) this.dropStaleRaw(store, cutoff);
      if (store.bucketCount > 0) this.dropBuckets(store, (b) => b.ts < cutoff);
    }
  }

  // An ordered tier drops its stale prefix in one splice; an unordered one is
  // compacted in place, since a stale sample can sit behind a fresh one.
  private dropStaleRaw(store: PathStore, cutoff: number): void {
    const { raw } = store;
    const before = raw.length;
    if (store.unordered) {
      let write = 0;
      for (const e of raw) {
        if (e.ts >= cutoff) {
          raw[write] = e;
          write += 1;
        }
      }
      raw.length = write;
    } else {
      let stale = 0;
      while (stale < raw.length && (raw[stale]?.ts ?? cutoff) < cutoff) stale += 1;
      if (stale > 0) raw.splice(0, stale);
    }
    this.total -= before - raw.length;
  }

  // Fold the `n` first-arrived raw samples into their buckets. One already
  // outside the window has nothing left to answer, so it goes outright.
  private demote(store: PathStore, n: number, cutoff: number): void {
    const moved = store.raw.splice(0, n);
    this.total -= moved.length;
    for (const e of moved) {
      if (e.ts >= cutoff) this.fold(store, e);
    }
  }

  // What folding the `n` first-arrived raw samples would save against the
  // total cap: each sample's cost, less every bucket and source map the fold
  // would open. Negative when the samples are sparser than one per bucket
  // width and source, where keeping them raw is cheaper.
  private foldSaving(store: PathStore, n: number, cutoff: number): number {
    const opened = new Set<string>();
    const openedSources = new Set<string>();
    let saving = 0;
    for (let i = 0; i < n; i += 1) {
      const e = store.raw[i];
      if (!e) break;
      saving += 1;
      if (e.ts < cutoff) continue;
      const slot = Math.floor(e.ts / this.bucketMs);
      const series = store.buckets.get(e.source);
      if (series?.has(slot)) continue;
      const key = compositeKey(e.source, String(slot));
      if (opened.has(key)) continue;
      opened.add(key);
      saving -= BUCKET_COST;
      if (!series && !openedSources.has(e.source)) {
        openedSources.add(e.source);
        saving -= SERIES_COST;
      }
    }
    return saving;
  }

  private fold(store: PathStore, e: BufferEntry): void {
    const slot = Math.floor(e.ts / this.bucketMs);
    const numeric = asFiniteNumber(e.value);
    let series = store.buckets.get(e.source);
    if (!series) {
      series = new Map();
      store.buckets.set(e.source, series);
      this.total += SERIES_COST;
    }
    const b = series.get(slot);
    if (!b) {
      series.set(slot, {
        firstTs: e.ts,
        ts: e.ts,
        value: e.value,
        count: 1,
        numeric: numeric === null ? 0 : 1,
        min: numeric ?? Number.POSITIVE_INFINITY,
        max: numeric ?? Number.NEGATIVE_INFINITY,
        sum: numeric ?? 0,
      });
      store.bucketCount += 1;
      this.total += BUCKET_COST;
      return;
    }
    b.count += 1;
    if (e.ts < b.firstTs) b.firstTs = e.ts;
    if (e.ts >= b.ts) {
      b.ts = e.ts;
      b.value = e.value;
    }
    if (numeric !== null) {
      b.numeric += 1;
      if (numeric < b.min) b.min = numeric;
      if (numeric > b.max) b.max = numeric;
      b.sum += numeric;
    }
  }

  // Delete every bucket `stale` matches, and every source left with none.
  // Deleting from a Map while iterating it is safe: the walk skips what it
  // removed and visits the rest.
  private dropBuckets(store: PathStore, stale: (bucket: Bucket) => boolean): void {
    let dropped = 0;
    let sources = 0;
    for (const [source, series] of store.buckets) {
      for (const [slot, b] of series) {
        if (!stale(b)) continue;
        series.delete(slot);
        dropped += 1;
      }
      if (series.size === 0) {
        store.buckets.delete(source);
        sources += 1;
      }
    }
    store.bucketCount -= dropped;
    this.total -= dropped * BUCKET_COST + sources * SERIES_COST;
  }

  // Hold the whole buffer under its total budget. Folding comes first: the
  // longest raw tier gives its oldest tenth to its buckets wherever that
  // saves room, which costs resolution but no window, and the newest samples
  // of every path stay raw. Only when no tier folds at a saving does the
  // costliest path lose its oldest data, buckets before raw samples, since
  // demotion only ever moves the oldest samples into buckets. Each pass
  // reclaims a hundredth of the cap below it, so a buffer that sits at its
  // cap walks its paths once per hundredth of the cap rather than every few
  // samples.
  private enforceTotalCap(cutoff: number): void {
    const cap = this.opts.maxTotalEntries;
    if (cap === undefined || this.total <= cap) return;
    const target = cap - Math.ceil(cap / 100);
    const unfoldable = new Set<PathStore>();
    while (this.total > target) {
      let longest: PathStore | null = null;
      for (const store of this.store.values()) {
        if (store.raw.length < 2 || unfoldable.has(store)) continue;
        if (!longest || store.raw.length > longest.raw.length) longest = store;
      }
      if (longest) {
        // A tenth that only starts a new bucket saves nothing, so a tier
        // whose tenth does not pay is tried once more with all but its
        // newest sample before it counts as unfoldable.
        let n = Math.ceil(longest.raw.length / 10);
        let saving = this.foldSaving(longest, n, cutoff);
        if (saving <= 0 && n < longest.raw.length - 1) {
          n = longest.raw.length - 1;
          saving = this.foldSaving(longest, n, cutoff);
        }
        if (saving > 0) this.demote(longest, n, cutoff);
        else unfoldable.add(longest);
        continue;
      }
      let costliest: PathStore | null = null;
      let highest = 0;
      for (const store of this.store.values()) {
        const cost =
          store.raw.length + store.bucketCount * BUCKET_COST + store.buckets.size * SERIES_COST;
        if (cost > highest) {
          costliest = store;
          highest = cost;
        }
      }
      // Nothing left to reclaim. The running total matches the stores, so
      // this only guards the loop against spinning on a drift.
      if (!costliest) return;
      if (costliest.bucketCount > 0) {
        this.dropOldestBuckets(costliest);
      } else {
        const drop = Math.max(1, Math.ceil(costliest.raw.length / 10));
        costliest.raw.splice(0, drop);
        this.total -= drop;
      }
    }
  }

  // Drop the oldest tenth of a path's buckets across its sources, by newest
  // sample, and at least one.
  private dropOldestBuckets(store: PathStore): void {
    const stamps: number[] = [];
    for (const series of store.buckets.values()) {
      for (const b of series.values()) stamps.push(b.ts);
    }
    stamps.sort((a, b) => a - b);
    const through =
      stamps[Math.max(1, Math.ceil(stamps.length / 10)) - 1] ?? Number.POSITIVE_INFINITY;
    this.dropBuckets(store, (b) => b.ts <= through);
  }
}
