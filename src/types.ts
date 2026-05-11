export interface AnalyzerTriggerCfg {
  cron: { enabled: boolean; pattern: string; timezone: string };
  put: { enabled: boolean; path: string };
  events: string[];
}

export const MAINTENANCE_SUPPORTED_EVENTS = ['engine-stop'] as const;
export type MaintenanceEventKind = (typeof MAINTENANCE_SUPPORTED_EVENTS)[number];

export const HEALTH_SUPPORTED_EVENTS = [] as const;

export const AGING_SUPPORTED_EVENTS = [] as const;

export const DRIFT_SUPPORTED_EVENTS = [] as const;

export const ALERTS_SUPPORTED_EVENTS = [
  'low-soc-enter',
  'low-soc-exit',
  'cell-imbalance-enter',
  'cell-imbalance-exit',
] as const;

/**
 * Signal K notification states (the full ALARM_STATE enum). The plugin's
 * `output.notificationState` config and the publisher's typed argument both
 * resolve to one of these strings.
 */
export const ALARM_STATES = ['nominal', 'normal', 'alert', 'warn', 'alarm', 'emergency'] as const;
export type NotificationState = (typeof ALARM_STATES)[number];

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
      triggers: AnalyzerTriggerCfg;
      engineStopRpmHzThreshold: number;
      engineStopSettleSeconds: number;
      engineStartRpmHzThreshold: number;
      engineStartSettleSeconds: number;
      minSessionSeconds: number;
      extraWatchedPaths: string[];
    };
    health: {
      enabled: boolean;
      triggers: AnalyzerTriggerCfg;
    };
    aging: {
      enabled: boolean;
      triggers: AnalyzerTriggerCfg;
    };
    drift: {
      enabled: boolean;
      triggers: AnalyzerTriggerCfg;
    };
    alerts: {
      enabled: boolean;
      triggers: AnalyzerTriggerCfg;
      lowSocPercent: number;
      socExitHysteresis: number;
      cellImbalanceV: number;
      imbalanceSettleSec: number;
    };
  };
  output: {
    notificationPath: string;
    notificationState: NotificationState;
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
      triggers: {
        cron: { enabled: false, pattern: '', timezone: '' },
        put: { enabled: true, path: 'plugins.openrouter-companion.maintenance.run' },
        events: ['engine-stop'],
      },
      engineStopRpmHzThreshold: 1.0,
      engineStopSettleSeconds: 10,
      engineStartRpmHzThreshold: 5.0,
      engineStartSettleSeconds: 5,
      minSessionSeconds: 60,
      extraWatchedPaths: [],
    },
    health: {
      enabled: true,
      triggers: {
        cron: { enabled: true, pattern: '0 8 * * *', timezone: '' },
        put: { enabled: true, path: 'plugins.openrouter-companion.health.run' },
        events: [],
      },
    },
    aging: {
      enabled: true,
      triggers: {
        cron: { enabled: true, pattern: '0 8 1 * *', timezone: '' },
        put: { enabled: true, path: 'plugins.openrouter-companion.aging.run' },
        events: [],
      },
    },
    drift: {
      enabled: true,
      triggers: {
        cron: { enabled: true, pattern: '0 8 * * 0', timezone: '' },
        put: { enabled: true, path: 'plugins.openrouter-companion.drift.run' },
        events: [],
      },
    },
    alerts: {
      enabled: true,
      triggers: {
        cron: { enabled: false, pattern: '', timezone: '' },
        put: { enabled: false, path: 'plugins.openrouter-companion.alerts.run' },
        events: ['low-soc-enter', 'low-soc-exit', 'cell-imbalance-enter', 'cell-imbalance-exit'],
      },
      lowSocPercent: 30,
      socExitHysteresis: 5,
      cellImbalanceV: 0.1,
      imbalanceSettleSec: 60,
    },
  },
  output: {
    notificationPath: 'notifications.openrouter-companion.maintenance.report',
    notificationState: 'normal',
    logFilename: 'reports.jsonl',
  },
};

type PartialTriggerCfg = {
  cron?: Partial<AnalyzerTriggerCfg['cron']>;
  put?: Partial<AnalyzerTriggerCfg['put']>;
  events?: string[];
};

type WithPartialTriggers<T extends { triggers: AnalyzerTriggerCfg }> = Partial<
  Omit<T, 'triggers'>
> & { triggers?: PartialTriggerCfg };

function mergeAnalyzerCfg<T extends { triggers: AnalyzerTriggerCfg }>(
  defaults: T,
  input: WithPartialTriggers<T> | undefined,
): T {
  if (!input) return clone(defaults);
  const inputTriggers = input.triggers ?? {};
  return {
    ...defaults,
    ...input,
    triggers: {
      cron: { ...defaults.triggers.cron, ...(inputTriggers.cron ?? {}) },
      put: { ...defaults.triggers.put, ...(inputTriggers.put ?? {}) },
      events: inputTriggers.events ?? defaults.triggers.events,
    },
  };
}

export function mergeWithDefaults(input: Partial<PluginOptions> | undefined): PluginOptions {
  if (!input) return clone(DEFAULT_OPTIONS);
  const inputAnalyzers = input.analyzers as
    | {
        maintenance?: WithPartialTriggers<PluginOptions['analyzers']['maintenance']>;
        health?: WithPartialTriggers<PluginOptions['analyzers']['health']>;
        aging?: WithPartialTriggers<PluginOptions['analyzers']['aging']>;
        drift?: WithPartialTriggers<PluginOptions['analyzers']['drift']>;
        alerts?: WithPartialTriggers<PluginOptions['analyzers']['alerts']>;
      }
    | undefined;
  return {
    openrouter: { ...DEFAULT_OPTIONS.openrouter, ...(input.openrouter ?? {}) },
    questdb: { ...DEFAULT_OPTIONS.questdb, ...(input.questdb ?? {}) },
    analyzers: {
      maintenance: mergeAnalyzerCfg(
        DEFAULT_OPTIONS.analyzers.maintenance,
        inputAnalyzers?.maintenance,
      ),
      health: mergeAnalyzerCfg(DEFAULT_OPTIONS.analyzers.health, inputAnalyzers?.health),
      aging: mergeAnalyzerCfg(DEFAULT_OPTIONS.analyzers.aging, inputAnalyzers?.aging),
      drift: mergeAnalyzerCfg(DEFAULT_OPTIONS.analyzers.drift, inputAnalyzers?.drift),
      alerts: mergeAnalyzerCfg(DEFAULT_OPTIONS.analyzers.alerts, inputAnalyzers?.alerts),
    },
    output: { ...DEFAULT_OPTIONS.output, ...(input.output ?? {}) },
  };
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
