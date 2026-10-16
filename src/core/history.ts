import type { HistorySource } from '../historyConfig.js';

type HistoryProviderKind = Exclude<HistorySource, 'none'>;

export interface PathWindowSummary {
  first: number | null;
  last: number | null;
  count: number;
}

interface EngineBinDefinition {
  key: string;
  maxHz: number;
}

export interface EngineWindowRequest {
  rpmPath: string;
  fuelRatePath: string;
  sogPath: string;
  runningThresholdHz: number;
  joinWindowMs: number;
  bins: readonly EngineBinDefinition[];
}

export interface EngineBinHistory {
  // RPM samples in this bin that had a fresh fuel.rate or SOG sample within
  // the request's join window. Counted per metric: the two join independently,
  // so one can be well covered while the other is sparse.
  fuelCount: number;
  sogCount: number;
  meanFuelRate: number | null;
  meanSog: number | null;
}

// A bin no sample landed in. Written once so both providers and the drift
// analyzer agree on what an empty bin is.
export function emptyEngineBin(): EngineBinHistory {
  return { fuelCount: 0, sogCount: 0, meanFuelRate: null, meanSog: null };
}

// Every requested bin, empty, keyed by bin key in request order.
export function emptyEngineBins(request: EngineWindowRequest): Map<string, EngineBinHistory> {
  return new Map(request.bins.map(({ key }) => [key, emptyEngineBin()]));
}

/**
 * Read-only history surface consumed by the trend analyzers. Provider-specific
 * query languages stay behind this boundary so analyzers operate on Signal K
 * paths, time windows, and numeric summaries only.
 */
export interface HistoryProvider {
  readonly kind: HistoryProviderKind;
  probe(abortSignal?: AbortSignal): Promise<boolean>;
  summarizePaths(
    paths: readonly string[],
    fromMs: number,
    toMs: number,
    abortSignal?: AbortSignal,
  ): Promise<Map<string, PathWindowSummary>>;
  meanPaths(
    paths: readonly string[],
    fromMs: number,
    toMs: number,
    abortSignal?: AbortSignal,
  ): Promise<Map<string, number>>;
  binEngineWindow(
    request: EngineWindowRequest,
    fromMs: number,
    toMs: number,
    abortSignal?: AbortSignal,
  ): Promise<Map<string, EngineBinHistory> | null>;
}
