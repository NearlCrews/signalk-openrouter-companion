// Rolling per-source reading maps shared by BatteryMonitor and EngineDetector.
// Both keep a Map of source -> { ts, ...reading } and, on each sample, age out
// entries past a cutoff before reading a fused value back. These helpers
// single-source that scan so the two monitors cannot drift apart. Call sites
// pass module-level extractor constants so the per-delta scans allocate no
// closures.

// Drop every entry whose ts predates cutoff. Used where the eviction is all the
// caller needs.
export function evictStale<K>(map: Map<K, { ts: number }>, cutoff: number): void {
  for (const [k, r] of map) {
    if (r.ts < cutoff) map.delete(k);
  }
}

// Evict stale entries and, in the same pass, fold the live readings into the
// minimum of `value`: SoC fuses with the minimum because a single pessimistic
// sensor must still alarm. Returns +Infinity when no live reading remains,
// which callers test for finiteness.
export function fuseMin<K, V extends { ts: number }>(
  map: Map<K, V>,
  cutoff: number,
  value: (r: V) => number,
): number {
  let acc = Number.POSITIVE_INFINITY;
  for (const [k, r] of map) {
    if (r.ts < cutoff) {
      map.delete(k);
      continue;
    }
    const x = value(r);
    if (x < acc) acc = x;
  }
  return acc;
}

// Evict stale entries and fold the live readings into the maximum of `value`:
// engine RPM fuses with the maximum because one slow or stale source must not
// cut a session short. Returns -Infinity when no live reading remains, which
// callers test for finiteness.
export function fuseMax<K, V extends { ts: number }>(
  map: Map<K, V>,
  cutoff: number,
  value: (r: V) => number,
): number {
  let acc = Number.NEGATIVE_INFINITY;
  for (const [k, r] of map) {
    if (r.ts < cutoff) {
      map.delete(k);
      continue;
    }
    const x = value(r);
    if (x > acc) acc = x;
  }
  return acc;
}

// Evict stale entries and return the span (max - min) of `value` over the
// survivors in a single pass; 0 when no live reading remains. Lets the cell-
// imbalance scan fold into the same loop that ages out silent cells.
export function evictStaleSpan<K, V extends { ts: number }>(
  map: Map<K, V>,
  cutoff: number,
  value: (r: V) => number,
): number {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const [k, r] of map) {
    if (r.ts < cutoff) {
      map.delete(k);
      continue;
    }
    const x = value(r);
    if (x < min) min = x;
    if (x > max) max = x;
  }
  return Number.isFinite(min) && Number.isFinite(max) ? max - min : 0;
}
