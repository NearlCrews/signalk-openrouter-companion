import { Cron } from 'croner';
import { ANALYZER_IDS, type AnalyzerId } from './analyzers/ids.js';
import { DEFAULT_MAX_CALLS_PER_DAY, MAX_CALLS_PER_DAY_CEILING } from './callBudget.js';
import {
  clampMin,
  clampPositiveInt,
  clampRange,
  finiteOr,
  normalizeOpenRouterBaseUrl,
  stringOr,
} from './core/cfg.js';
import { BATTERY_EVENT_KINDS } from './core/triggerContext.js';
import {
  type HistorySource,
  isHistorySource,
  type LegacyQuestDbCfg,
  legacyHistorySource,
} from './historyConfig.js';
import {
  DEFAULT_SEVERITY_FLOOR_VALUE,
  isSeverityFloor,
  type SeverityFloor,
} from './severityFloors.js';

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
const NO_EVENTS = [] as const;

// The alerts analyzer answers every crossing the battery monitor raises.
export const ALERTS_SUPPORTED_EVENTS = BATTERY_EVENT_KINDS;

// The event subkinds each analyzer can subscribe to: the schema's checkbox
// list and its labels both read this, so a new analyzer states them once.
export const ANALYZER_SUPPORTED_EVENTS: Record<AnalyzerId, ReadonlyArray<string>> = {
  maintenance: MAINTENANCE_SUPPORTED_EVENTS,
  health: NO_EVENTS,
  aging: NO_EVENTS,
  drift: NO_EVENTS,
  alerts: ALERTS_SUPPORTED_EVENTS,
  liveness: NO_EVENTS,
  forecast: NO_EVENTS,
};

// The bounds on every bounded analyzer setting, stated once. The schema
// advertises them as each field's minimum and maximum, and validateOptions
// holds a saved value inside them, so the form and the runtime cannot disagree
// about what a setting may be. A whole-number window or threshold
// (clampPositiveInt) snaps to the nearest bound; a fractional threshold or a
// settle time (clampMin, clampRange) falls back to its default. Analyzers then
// trust the normalized config.
export const ANALYZER_BOUNDS = {
  maintenance: {
    engineStopSettleSeconds: { min: 1 },
    engineSilenceStopSeconds: { min: 1 },
    engineStartSettleSeconds: { min: 1 },
    minSessionSeconds: { min: 0 },
  },
  aging: {
    shortWindowDays: { min: 7, max: 365 },
    longWindowDays: { min: 7, max: 1095 },
  },
  drift: {
    baselineDays: { min: 14, max: 365 },
  },
  alerts: {
    lowSocPercent: { min: 0, max: 100 },
    // Strict-positive minimums on the hysteresis and threshold fields: a 0
    // value collapses enter and exit into the same boundary, so any sensor
    // noise spams enter/exit pairs (each pair spends an LLM call).
    socExitHysteresis: { min: 1 },
    cellImbalanceV: { min: 0.001 },
    imbalanceSettleSec: { min: 1 },
  },
  liveness: {
    stalenessThresholdSec: { min: 30 },
  },
} as const;

// Number of whitespace-separated fields in a standard cron pattern. Croner also
// accepts a 6-field form with a leading seconds column, so an unvalidated
// '* * * * * *' from a hand-edited config would fire every second and empty the
// daily call cap in under a minute.
const CRON_FIELD_COUNT = 5;

// Signal K notification states (the full ALARM_STATE enum). The publisher's
// typed `state` argument and per-analyzer publish overrides both resolve to
// one of these strings. Declared in the spec's severity order, least to most.
// The array itself stays module-private: `severityRank` below is the only way
// to read that order, so nothing can compare two states by a rule of its own.
const ALARM_STATES = ['nominal', 'normal', 'alert', 'warn', 'alarm', 'emergency'] as const;
export type NotificationState = (typeof ALARM_STATES)[number];

// Where a state sits on that ladder, as a number two states on one path can be
// compared by. Declared beside the array it reads, so a reordered or extended
// ALARM_STATES has one ranking rule to keep honest rather than an indexOf
// spelled out wherever two states meet.
export function severityRank(state: NotificationState): number {
  return ALARM_STATES.indexOf(state);
}

// OpenRouter provider-routing controls, mirrored 1:1 onto the request body's
// `provider` object (see core/openrouter.ts::buildProvider). Shared by the
// plugin config, the OpenRouter client, and (as a type-only import) the panel,
// so none of them can drift; src/schema.ts is the JSON storage shape.
export interface ProviderRoutingCfg {
  sort?: 'price' | 'throughput' | 'latency';
  maxPrice?: { prompt?: number; completion?: number; request?: number };
  allowFallbacks?: boolean;
  dataCollection?: 'allow' | 'deny';
  zdr?: boolean;
}

interface HistoryCfg {
  source: HistorySource;
  questdb: {
    url: string;
  };
  influxdb: {
    version: '1' | '2';
    url: string;
    database: string;
    username: string;
    password: string;
  };
}

export interface PluginOptions {
  openrouter: {
    apiKey: string;
    model: string;
    baseUrl: string;
    maxCallsPerDay: number;
    requestTimeoutMs: number;
    fallbackModels?: string[];
    provider?: ProviderRoutingCfg;
  };
  history: HistoryCfg;
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
    maxCallsPerDay: DEFAULT_MAX_CALLS_PER_DAY,
    requestTimeoutMs: 60_000,
  },
  history: {
    source: 'questdb',
    questdb: { url: 'http://localhost:9000' },
    influxdb: {
      version: '1',
      url: 'http://localhost:8086',
      database: 'signalk',
      username: '',
      password: '',
    },
  },
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
      shortWindowDays: 30,
      longWindowDays: 90,
    },
    drift: {
      enabled: true,
      triggers: {
        cron: { enabled: true, pattern: '0 8 * * 0', timezone: '' },
        put: { enabled: true },
        events: [...NO_EVENTS],
      },
      baselineDays: 30,
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
      stalenessThresholdSec: 300,
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
      severityFloor: DEFAULT_SEVERITY_FLOOR_VALUE,
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

// The saved-config overlay: each analyzer section is optional and may carry
// partial triggers. Keyed off ANALYZER_IDS so it cannot drift from the section
// list the merge loop walks.
type AnalyzerInputOverlay = {
  [K in AnalyzerId]?: WithPartialTriggers<PluginOptions['analyzers'][K]>;
};

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
  if (!input) return structuredClone(defaults);
  // Clone the defaults base so the merged result never aliases a
  // DEFAULT_OPTIONS array (events, extraWatchedPaths). A shared reference
  // would let one analyzer's config mutate the shipped defaults.
  const base = structuredClone(defaults);
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

type PluginOptionsInput = Omit<Partial<PluginOptions>, 'history'> & {
  history?: Partial<HistoryCfg> & {
    questdb?: Partial<HistoryCfg['questdb']>;
    influxdb?: Partial<HistoryCfg['influxdb']>;
  };
  // Pre-history-provider releases stored this top-level block. Keep reading it
  // so existing installations migrate without re-entering their QuestDB URL.
  questdb?: LegacyQuestDbCfg;
};

export function mergeWithDefaults(input: PluginOptionsInput | undefined): PluginOptions {
  // Run validateOptions on every return path, including the no-input
  // bootstrap. DEFAULT_OPTIONS values are valid today, so this is a no-op
  // now; the uniform contract ('all returned cfgs are validated') protects
  // a future maintainer who changes a default into a sentinel that would
  // otherwise bypass the clamp.
  if (!input) return validateOptions(structuredClone(DEFAULT_OPTIONS));
  const inputAnalyzers = input.analyzers as AnalyzerInputOverlay | undefined;
  const legacyQuestDB = input.questdb;
  const historyInput = input.history;
  const historySource =
    historyInput?.source ??
    (legacyQuestDB ? legacyHistorySource(legacyQuestDB) : DEFAULT_OPTIONS.history.source);
  // Merge every analyzer section by iterating ANALYZER_IDS, the single source
  // of truth. A new analyzer added to ids.ts and registry.ts is then merged
  // from saved config automatically, rather than being silently dropped by a
  // hand-listed object that forgot its key. The builder is keyed `unknown`
  // because writing through a union-typed index would otherwise demand the
  // intersection of every section shape; the loop fills all ids, so the single
  // cast to the concrete map at the end is sound. mergeAnalyzerCfg is generic
  // over one section shape, so its inputs are cast to the generic's base
  // constraint here; structuredClone and the spreads preserve every real field
  // at runtime, and only compile-time precision is bridged by the casts.
  const analyzers = {} as Record<AnalyzerId, unknown>;
  for (const id of ANALYZER_IDS) {
    analyzers[id] = mergeAnalyzerCfg(
      DEFAULT_OPTIONS.analyzers[id] as { triggers: AnalyzerTriggerCfg },
      inputAnalyzers?.[id] as WithPartialTriggers<{ triggers: AnalyzerTriggerCfg }> | undefined,
    );
  }
  const merged: PluginOptions = {
    openrouter: { ...DEFAULT_OPTIONS.openrouter, ...(input.openrouter ?? {}) },
    history: {
      source: historySource,
      questdb: {
        ...DEFAULT_OPTIONS.history.questdb,
        ...(legacyQuestDB?.url ? { url: legacyQuestDB.url } : {}),
        ...(historyInput?.questdb ?? {}),
      },
      influxdb: {
        ...DEFAULT_OPTIONS.history.influxdb,
        ...(historyInput?.influxdb ?? {}),
      },
    },
    analyzers: analyzers as PluginOptions['analyzers'],
    output: { ...DEFAULT_OPTIONS.output, ...(input.output ?? {}) },
  };
  return validateOptions(merged);
}

// Clamp obviously-broken values back to defaults so a hand-edited JSON cfg (or
// a UI field cleared to '') cannot silently disable analyzers. The most
// consequential lockout: maxCallsPerDay = 0 leaves canSpend() returning false
// forever and pegs the status banner at "budget exhausted". Every bounded
// setting is normalized here, once, so the analyzers and the lifecycle read a
// config they can trust rather than each re-clamping their own slice.
function validateOptions(cfg: PluginOptions): PluginOptions {
  const d = DEFAULT_OPTIONS;
  const da = d.analyzers;
  const b = ANALYZER_BOUNDS;
  const or = cfg.openrouter;
  const { maintenance: m, aging, drift, alerts: a, liveness, forecast } = cfg.analyzers;
  const history = cfg.history;
  const influxdb = history.influxdb;
  cfg.openrouter = {
    ...or,
    // A blank model reaches OpenRouter as a 400 on every run: each one records
    // a budget call, publishes a failure notification, and leaves the status
    // banner reading "Running". Fall back to the shipped slug so a cleared
    // field costs nothing instead of a day's cap.
    model: typeof or.model === 'string' && or.model.trim() ? or.model.trim() : d.openrouter.model,
    baseUrl: normalizeOpenRouterBaseUrl(or.baseUrl, d.openrouter.baseUrl),
    // clampPositiveInt, not clampMin: the cap is a count, so it truncates the
    // fraction, and it takes the ceiling that keeps this a real spend bound.
    maxCallsPerDay: clampPositiveInt(or.maxCallsPerDay, d.openrouter.maxCallsPerDay, {
      min: 1,
      max: MAX_CALLS_PER_DAY_CEILING,
    }),
    requestTimeoutMs: clampMin(or.requestTimeoutMs, 1000, d.openrouter.requestTimeoutMs),
  };
  for (const id of ANALYZER_IDS) {
    const cron = cfg.analyzers[id].triggers.cron;
    if (cron.pattern && !isRunnableCron(cron.pattern)) {
      cron.pattern = da[id].triggers.cron.pattern;
    }
  }
  cfg.history = {
    source: isHistorySource(history.source) ? history.source : d.history.source,
    questdb: {
      url: stringOr(history.questdb.url, d.history.questdb.url),
    },
    influxdb: {
      version: influxdb.version === '1' || influxdb.version === '2' ? influxdb.version : '1',
      url: stringOr(influxdb.url, d.history.influxdb.url),
      database: stringOr(influxdb.database, d.history.influxdb.database),
      username: stringOr(influxdb.username, d.history.influxdb.username),
      password: stringOr(influxdb.password, d.history.influxdb.password),
    },
  };
  cfg.analyzers.maintenance = {
    ...m,
    engineStopRpmHzThreshold: finiteOr(
      m.engineStopRpmHzThreshold,
      da.maintenance.engineStopRpmHzThreshold,
    ),
    engineStartRpmHzThreshold: finiteOr(
      m.engineStartRpmHzThreshold,
      da.maintenance.engineStartRpmHzThreshold,
    ),
    engineStopSettleSeconds: clampMin(
      m.engineStopSettleSeconds,
      b.maintenance.engineStopSettleSeconds.min,
      da.maintenance.engineStopSettleSeconds,
    ),
    engineStartSettleSeconds: clampMin(
      m.engineStartSettleSeconds,
      b.maintenance.engineStartSettleSeconds.min,
      da.maintenance.engineStartSettleSeconds,
    ),
    engineSilenceStopSeconds: clampMin(
      m.engineSilenceStopSeconds,
      b.maintenance.engineSilenceStopSeconds.min,
      da.maintenance.engineSilenceStopSeconds,
    ),
    minSessionSeconds: clampMin(
      m.minSessionSeconds,
      b.maintenance.minSessionSeconds.min,
      da.maintenance.minSessionSeconds,
    ),
  };
  cfg.analyzers.aging = {
    ...aging,
    shortWindowDays: clampPositiveInt(
      aging.shortWindowDays,
      da.aging.shortWindowDays,
      b.aging.shortWindowDays,
    ),
    longWindowDays: clampPositiveInt(
      aging.longWindowDays,
      da.aging.longWindowDays,
      b.aging.longWindowDays,
    ),
  };
  cfg.analyzers.drift = {
    ...drift,
    baselineDays: clampPositiveInt(drift.baselineDays, da.drift.baselineDays, b.drift.baselineDays),
  };
  cfg.analyzers.alerts = {
    ...a,
    lowSocPercent: clampRange(
      a.lowSocPercent,
      b.alerts.lowSocPercent.min,
      b.alerts.lowSocPercent.max,
      da.alerts.lowSocPercent,
    ),
    socExitHysteresis: clampMin(
      a.socExitHysteresis,
      b.alerts.socExitHysteresis.min,
      da.alerts.socExitHysteresis,
    ),
    cellImbalanceV: clampMin(
      a.cellImbalanceV,
      b.alerts.cellImbalanceV.min,
      da.alerts.cellImbalanceV,
    ),
    imbalanceSettleSec: clampMin(
      a.imbalanceSettleSec,
      b.alerts.imbalanceSettleSec.min,
      da.alerts.imbalanceSettleSec,
    ),
  };
  cfg.analyzers.liveness = {
    ...liveness,
    stalenessThresholdSec: clampPositiveInt(
      liveness.stalenessThresholdSec,
      da.liveness.stalenessThresholdSec,
      b.liveness.stalenessThresholdSec,
    ),
  };
  // A floor off the preset scale falls back to the default, so the analyzer
  // never ranks against a value the scale does not hold.
  cfg.analyzers.forecast = {
    ...forecast,
    severityFloor: isSeverityFloor(forecast.severityFloor)
      ? forecast.severityFloor
      : da.forecast.severityFloor,
  };
  return cfg;
}

// Whether a cron pattern is one this plugin will actually run on the schedule
// it advertises. Anything else falls back to the analyzer's shipped pattern.
//
// The field count is a rule of its own because croner accepts a 6-field form
// with a leading seconds column, which would fire every second and empty the
// daily call cap in under a minute while the status banner still read
// "Running". The parse covers what counting fields cannot: an out-of-range
// value ('99 * * * *'), an illegal character ('a b c d e'), and a pattern with
// no next occurrence at all ('0 0 30 2 *'), each of which would otherwise reach
// the scheduler and leave that analyzer silently never running. Validating with
// the parser that will run the pattern is what keeps the two in step.
function isRunnableCron(pattern: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed.split(/\s+/).length !== CRON_FIELD_COUNT) return false;
  try {
    // No callback, so nothing is scheduled: this only parses and asks when the
    // pattern would next fire.
    return new Cron(trimmed).nextRun() !== null;
  } catch {
    return false;
  }
}
