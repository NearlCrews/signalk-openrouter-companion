export interface PluginOptions {
  openrouter: {
    apiKey: string;
    model: string;
    baseUrl: string;
    maxCallsPerDay: number;
    requestTimeoutMs: number;
  };
  questdb: {
    enabled: boolean;
    url: string;
  };
  analyzers: {
    maintenance: {
      enabled: boolean;
      engineStopRpmHzThreshold: number;
      engineStopSettleSeconds: number;
      engineStartRpmHzThreshold: number;
      engineStartSettleSeconds: number;
      minSessionSeconds: number;
      extraWatchedPaths: string[];
    };
  };
  output: {
    notificationPath: string;
    notificationState: 'normal' | 'nominal';
    logFilename: string;
  };
}

export const DEFAULT_OPTIONS: PluginOptions = {
  openrouter: {
    apiKey: '',
    model: 'anthropic/claude-haiku-4.5',
    baseUrl: 'https://openrouter.ai/api/v1',
    maxCallsPerDay: 20,
    requestTimeoutMs: 60_000,
  },
  questdb: { enabled: true, url: 'http://localhost:9000' },
  analyzers: {
    maintenance: {
      enabled: true,
      engineStopRpmHzThreshold: 1.0,
      engineStopSettleSeconds: 10,
      engineStartRpmHzThreshold: 5.0,
      engineStartSettleSeconds: 5,
      minSessionSeconds: 60,
      extraWatchedPaths: [],
    },
  },
  output: {
    notificationPath: 'notifications.openrouter-companion.maintenance.report',
    notificationState: 'normal',
    logFilename: 'reports.jsonl',
  },
};

export function mergeWithDefaults(input: Partial<PluginOptions> | undefined): PluginOptions {
  if (!input) return clone(DEFAULT_OPTIONS);
  return {
    openrouter: { ...DEFAULT_OPTIONS.openrouter, ...(input.openrouter ?? {}) },
    questdb: { ...DEFAULT_OPTIONS.questdb, ...(input.questdb ?? {}) },
    analyzers: {
      maintenance: {
        ...DEFAULT_OPTIONS.analyzers.maintenance,
        ...(input.analyzers?.maintenance ?? {}),
      },
    },
    output: { ...DEFAULT_OPTIONS.output, ...(input.output ?? {}) },
  };
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
