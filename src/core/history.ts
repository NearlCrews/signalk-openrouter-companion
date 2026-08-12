type HistoryProviderKind = 'questdb' | 'influxdb';

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
  fuelCount: number;
  sogCount: number;
  meanFuelRate: number | null;
  meanSog: number | null;
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
