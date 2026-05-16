import { pluginPutPath } from './core/paths.js';

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

export const LIVENESS_SUPPORTED_EVENTS = [] as const;

export const ALERTS_SUPPORTED_EVENTS = [
  'low-soc-enter',
  'low-soc-exit',
  'cell-imbalance-enter',
  'cell-imbalance-exit',
] as const;

// Trend-analyzer history-window defaults. Source-of-truth for the schema's
// admin-UI defaults AND the analyzer constructors' clamp fallbacks; keeping
// them in one place guarantees the two layers can't drift.
export const AGING_DEFAULT_SHORT_DAYS = 30;
export const AGING_DEFAULT_LONG_DAYS = 90;
export const DRIFT_DEFAULT_BASELINE_DAYS = 30;

// Liveness-analyzer default: a watched path with no sample newer than this
// many seconds is reported stale. Source-of-truth for the schema default and
// the analyzer constructor's clamp fallback.
export const LIVENESS_DEFAULT_STALENESS_SEC = 300;

// Signal K notification states (the full ALARM_STATE enum). The publisher's
// typed `state` argument and per-analyzer publish overrides both resolve to
// one of these strings.
const ALARM_STATES = ['nominal', 'normal', 'alert', 'warn', 'alarm', 'emergency'] as const;
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
      customSystemPrompt?: string;
    };
    health: {
      enabled: boolean;
      triggers: AnalyzerTriggerCfg;
      customSystemPrompt?: string;
    };
    aging: {
      enabled: boolean;
      triggers: AnalyzerTriggerCfg;
      shortWindowDays: number;
      longWindowDays: number;
      customSystemPrompt?: string;
    };
    drift: {
      enabled: boolean;
      triggers: AnalyzerTriggerCfg;
      baselineDays: number;
      customSystemPrompt?: string;
    };
    alerts: {
      enabled: boolean;
      triggers: AnalyzerTriggerCfg;
      lowSocPercent: number;
      socExitHysteresis: number;
      cellImbalanceV: number;
      imbalanceSettleSec: number;
      customSystemPrompt?: string;
    };
    liveness: {
      enabled: boolean;
      triggers: AnalyzerTriggerCfg;
      stalenessThresholdSec: number;
      customSystemPrompt?: string;
    };
  };
  output: {
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
        put: { enabled: true, path: pluginPutPath('maintenance') },
        events: ['engine-stop'],
      },
      engineStopRpmHzThreshold: 1.0,
      engineStopSettleSeconds: 10,
      // 8 Hz (~480 RPM) sits comfortably above cold-cranking RPM (3-7 Hz on
      // a diesel) and well below any marine idle (10+ Hz). A lower threshold
      // can falsely fire engine-start during a long crank.
      engineStartRpmHzThreshold: 8.0,
      engineStartSettleSeconds: 5,
      minSessionSeconds: 60,
      extraWatchedPaths: [],
    },
    health: {
      enabled: true,
      triggers: {
        cron: { enabled: true, pattern: '0 8 * * *', timezone: '' },
        put: { enabled: true, path: pluginPutPath('health') },
        events: [],
      },
    },
    aging: {
      enabled: true,
      triggers: {
        cron: { enabled: true, pattern: '0 8 1 * *', timezone: '' },
        put: { enabled: true, path: pluginPutPath('aging') },
        events: [],
      },
      shortWindowDays: AGING_DEFAULT_SHORT_DAYS,
      longWindowDays: AGING_DEFAULT_LONG_DAYS,
    },
    drift: {
      enabled: true,
      triggers: {
        cron: { enabled: true, pattern: '0 8 * * 0', timezone: '' },
        put: { enabled: true, path: pluginPutPath('drift') },
        events: [],
      },
      baselineDays: DRIFT_DEFAULT_BASELINE_DAYS,
    },
    alerts: {
      enabled: true,
      triggers: {
        cron: { enabled: false, pattern: '', timezone: '' },
        put: { enabled: false, path: pluginPutPath('alerts') },
        events: ['low-soc-enter', 'low-soc-exit', 'cell-imbalance-enter', 'cell-imbalance-exit'],
      },
      lowSocPercent: 30,
      socExitHysteresis: 5,
      // 0.05 V matches LiFePO4 healthy-pack drift under load. 0.1 V was too
      // high: by the time a real LFP imbalance hits 100 mV the BMS is
      // already alarming. Lead-acid users on shore-charged systems may want
      // to raise this (0.15-0.2 V); LFP is the assumed default.
      cellImbalanceV: 0.05,
      imbalanceSettleSec: 60,
    },
    liveness: {
      enabled: true,
      triggers: {
        cron: { enabled: true, pattern: '0 8 * * *', timezone: '' },
        put: { enabled: true, path: pluginPutPath('liveness') },
        events: [],
      },
      stalenessThresholdSec: LIVENESS_DEFAULT_STALENESS_SEC,
    },
  },
  output: {
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
        liveness?: WithPartialTriggers<PluginOptions['analyzers']['liveness']>;
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
      liveness: mergeAnalyzerCfg(DEFAULT_OPTIONS.analyzers.liveness, inputAnalyzers?.liveness),
    },
    output: { ...DEFAULT_OPTIONS.output, ...(input.output ?? {}) },
  };
}

function clone<T>(v: T): T {
  return structuredClone(v);
}
