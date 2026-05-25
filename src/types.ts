export interface AnalyzerTriggerCfg {
  cron: { enabled: boolean; pattern: string; timezone: string };
  // The PUT path is a fixed convention: `plugins.openrouter-companion.<id>.run`.
  // It is derived from the analyzer id at registration time (see
  // `pluginPutPath` in core/paths.ts) and is not stored on the cfg shape, so
  // a hand-edited path cannot drift from the convention and the schema does
  // not advertise a configurable path the operator cannot actually change.
  put: { enabled: boolean };
  events: string[];
}

export const MAINTENANCE_SUPPORTED_EVENTS = ['engine-stop'] as const;
export type MaintenanceEventKind = (typeof MAINTENANCE_SUPPORTED_EVENTS)[number];

// Shared empty-events sentinel for analyzers that have no event subscriptions.
// One reference is bundled into dist; the prior five named copies all collapsed
// to a single allocation here.
export const NO_EVENTS = [] as const;

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

// Forecast-analyzer severity floor: the lowest LLM-graded outlook severity
// that raises an alarm on the forecast notification. Below the floor the
// outlook still publishes, with state 'nominal', so it stays readable in the
// data browser. The preset list lives in `src/severityFloors.ts` (shared
// with the panel); these aliases are kept for backward-compat with the
// analyzer constructor and the existing config shape.
import {
  DEFAULT_SEVERITY_FLOOR_VALUE,
  SEVERITY_FLOOR_PRESETS,
  type SeverityFloorPresetValue,
} from './severityFloors.js';

export const FORECAST_SEVERITY_FLOORS: ReadonlyArray<SeverityFloorPresetValue> =
  SEVERITY_FLOOR_PRESETS.map((p) => p.value);
export type SeverityFloor = SeverityFloorPresetValue;

export const FORECAST_DEFAULT_SEVERITY_FLOOR: SeverityFloor = DEFAULT_SEVERITY_FLOOR_VALUE;

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
      engineSilenceStopSeconds: number;
      engineStartRpmHzThreshold: number;
      engineStartSettleSeconds: number;
      minSessionSeconds: number;
      // Configured under maintenance for historical reasons, but the effect
      // is plugin-wide: the path list also enriches the RollingBuffer that
      // feeds the forecast and liveness analyzers. Disabling maintenance
      // does NOT stop those paths from being subscribed; they remain in the
      // buffer so the other analyzers see them.
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
    forecast: {
      enabled: boolean;
      triggers: AnalyzerTriggerCfg;
      severityFloor: SeverityFloor;
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
        put: { enabled: true },
        events: [...MAINTENANCE_SUPPORTED_EVENTS],
      },
      engineStopRpmHzThreshold: 1.0,
      engineStopSettleSeconds: 10,
      // A switched-off NMEA 2000 engine stops broadcasting RPM entirely
      // rather than reporting 0, so a real shutdown is detected as silence.
      // 300s is far past any bus dropout, so it never false-fires.
      engineSilenceStopSeconds: 300,
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
        put: { enabled: true },
        events: [...NO_EVENTS],
      },
    },
    aging: {
      enabled: true,
      triggers: {
        cron: { enabled: true, pattern: '0 8 1 * *', timezone: '' },
        put: { enabled: true },
        events: [...NO_EVENTS],
      },
      shortWindowDays: AGING_DEFAULT_SHORT_DAYS,
      longWindowDays: AGING_DEFAULT_LONG_DAYS,
    },
    drift: {
      enabled: true,
      triggers: {
        cron: { enabled: true, pattern: '0 8 * * 0', timezone: '' },
        put: { enabled: true },
        events: [...NO_EVENTS],
      },
      baselineDays: DRIFT_DEFAULT_BASELINE_DAYS,
    },
    alerts: {
      enabled: true,
      triggers: {
        cron: { enabled: false, pattern: '', timezone: '' },
        put: { enabled: false },
        events: [...ALERTS_SUPPORTED_EVENTS],
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
        put: { enabled: true },
        events: [...NO_EVENTS],
      },
      stalenessThresholdSec: LIVENESS_DEFAULT_STALENESS_SEC,
    },
    forecast: {
      enabled: false,
      triggers: {
        // Every 3 hours, aligning with the classic 3-hour barometric-tendency
        // interval. User-editable in the admin panel like every analyzer.
        cron: { enabled: true, pattern: '0 */3 * * *', timezone: '' },
        put: { enabled: true },
        events: [...NO_EVENTS],
      },
      severityFloor: FORECAST_DEFAULT_SEVERITY_FLOOR,
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

// The `enabled` key on each analyzer section defaults to whatever the
// shipped DEFAULT_OPTIONS sets (true for most, false for forecast). The
// panel always writes the full cfg, so the saved JSON carries `enabled`
// explicitly. Any future code path that constructs a partial overlay
// without the `enabled` field will re-enable the analyzer; carry the flag
// explicitly in such call sites.
function mergeAnalyzerCfg<T extends { triggers: AnalyzerTriggerCfg }>(
  defaults: T,
  input: WithPartialTriggers<T> | undefined,
): T {
  if (!input) return clone(defaults);
  // Clone the defaults base so the merged result never aliases a
  // DEFAULT_OPTIONS array (events, extraWatchedPaths). A shared reference
  // would let one analyzer's config mutate the shipped defaults.
  const base = clone(defaults);
  const inputTriggers = input.triggers ?? {};
  return {
    ...base,
    ...input,
    triggers: {
      cron: { ...base.triggers.cron, ...(inputTriggers.cron ?? {}) },
      put: { ...base.triggers.put, ...(inputTriggers.put ?? {}) },
      events: inputTriggers.events ?? base.triggers.events,
    },
  };
}

export function mergeWithDefaults(input: Partial<PluginOptions> | undefined): PluginOptions {
  // Run validateOptions on every return path, including the no-input
  // bootstrap. DEFAULT_OPTIONS values are valid today, so this is a no-op
  // now; the uniform contract ('all returned cfgs are validated') protects
  // a future maintainer who changes a default into a sentinel that would
  // otherwise bypass the clamp.
  if (!input) return validateOptions(clone(DEFAULT_OPTIONS));
  const inputAnalyzers = input.analyzers as
    | {
        maintenance?: WithPartialTriggers<PluginOptions['analyzers']['maintenance']>;
        health?: WithPartialTriggers<PluginOptions['analyzers']['health']>;
        aging?: WithPartialTriggers<PluginOptions['analyzers']['aging']>;
        drift?: WithPartialTriggers<PluginOptions['analyzers']['drift']>;
        alerts?: WithPartialTriggers<PluginOptions['analyzers']['alerts']>;
        liveness?: WithPartialTriggers<PluginOptions['analyzers']['liveness']>;
        forecast?: WithPartialTriggers<PluginOptions['analyzers']['forecast']>;
      }
    | undefined;
  const merged: PluginOptions = {
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
      forecast: mergeAnalyzerCfg(DEFAULT_OPTIONS.analyzers.forecast, inputAnalyzers?.forecast),
    },
    output: { ...DEFAULT_OPTIONS.output, ...(input.output ?? {}) },
  };
  return validateOptions(merged);
}

// Clamp obviously-broken numeric values back to defaults so a hand-edited
// JSON cfg (or a UI field cleared to '') cannot silently disable analyzers.
// The most consequential lockout: maxCallsPerDay = 0 leaves canSpend()
// returning false forever and pegs the status banner at "budget exhausted".
function validateOptions(cfg: PluginOptions): PluginOptions {
  const d = DEFAULT_OPTIONS;
  const or = cfg.openrouter;
  const m = cfg.analyzers.maintenance;
  const a = cfg.analyzers.alerts;
  cfg.openrouter = {
    ...or,
    maxCallsPerDay: clampMin(or.maxCallsPerDay, 1, d.openrouter.maxCallsPerDay),
    requestTimeoutMs: clampMin(or.requestTimeoutMs, 1000, d.openrouter.requestTimeoutMs),
  };
  cfg.analyzers.maintenance = {
    ...m,
    engineStopRpmHzThreshold: finiteOr(
      m.engineStopRpmHzThreshold,
      d.analyzers.maintenance.engineStopRpmHzThreshold,
    ),
    engineStartRpmHzThreshold: finiteOr(
      m.engineStartRpmHzThreshold,
      d.analyzers.maintenance.engineStartRpmHzThreshold,
    ),
    engineStopSettleSeconds: clampMin(
      m.engineStopSettleSeconds,
      1,
      d.analyzers.maintenance.engineStopSettleSeconds,
    ),
    engineStartSettleSeconds: clampMin(
      m.engineStartSettleSeconds,
      1,
      d.analyzers.maintenance.engineStartSettleSeconds,
    ),
    engineSilenceStopSeconds: clampMin(
      m.engineSilenceStopSeconds,
      1,
      d.analyzers.maintenance.engineSilenceStopSeconds,
    ),
    minSessionSeconds: clampMin(m.minSessionSeconds, 0, d.analyzers.maintenance.minSessionSeconds),
  };
  cfg.analyzers.alerts = {
    ...a,
    lowSocPercent: clampRange(a.lowSocPercent, 0, 100, d.analyzers.alerts.lowSocPercent),
    // Strict-positive minimums on the hysteresis and threshold fields: a 0
    // value collapses enter and exit into the same boundary, so any sensor
    // noise spams enter/exit pairs (each pair spends an LLM call). The
    // defaults are the sensible operating point; clamp anything weaker.
    socExitHysteresis: clampMin(a.socExitHysteresis, 1, d.analyzers.alerts.socExitHysteresis),
    cellImbalanceV: clampMin(a.cellImbalanceV, 0.001, d.analyzers.alerts.cellImbalanceV),
    imbalanceSettleSec: clampMin(a.imbalanceSettleSec, 1, d.analyzers.alerts.imbalanceSettleSec),
  };
  return cfg;
}

function clampMin(v: unknown, min: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min ? v : fallback;
}

function clampRange(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}

function finiteOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clone<T>(v: T): T {
  return structuredClone(v);
}
