import type { BatteryEventKind } from './analyzers/Analyzer.js';
import { CRON_PRESETS } from './cronPresets.js';
import { SEVERITY_FLOOR_PRESETS } from './severityFloors.js';
import {
  ALERTS_SUPPORTED_EVENTS,
  type AnalyzerTriggerCfg,
  DEFAULT_OPTIONS,
  MAINTENANCE_SUPPORTED_EVENTS,
  type MaintenanceEventKind,
  NO_EVENTS,
} from './types.js';

/**
 * Human-readable labels for each event subkind exposed in the admin UI.
 * Kept here (rather than alongside the event constants in types.ts) because
 * these strings are UI copy specific to the rjsf `enumNames` directive.
 *
 * Typing the record by the union of event kinds means adding a new subkind
 * without a title is a build error rather than a silent fall-through.
 */
const EVENT_TITLES: Record<MaintenanceEventKind | BatteryEventKind, string> = {
  'engine-stop': 'Engine session ended',
  'low-soc-enter': 'Low SoC: bank entered low state',
  'low-soc-exit': 'Low SoC: bank recovered',
  'cell-imbalance-enter': 'Cell imbalance detected',
  'cell-imbalance-exit': 'Cell imbalance cleared',
};

function eventTitlesFor(events: ReadonlyArray<string>): string[] {
  return events.map((e) => EVENT_TITLES[e as MaintenanceEventKind | BatteryEventKind] ?? e);
}

/**
 * Cron presets exposed in the admin form. The list itself lives in
 * `src/cronPresets.ts` as the single source of truth shared with the custom
 * config panel; here it is split into the parallel `values` and `titles`
 * arrays the schema needs so it renders a clean `enum + enumNames` dropdown
 * in the SK admin UI (rjsf 5 + raw `@rjsf/core`).
 *
 * Why not `anyOf` with a freeform fallback?
 *
 * rjsf treats `anyOf`/`oneOf` as a select-dropdown only when EVERY branch is
 * a "constant" (single-value `const` or `enum`). A freeform branch
 * (`{ type: 'string' }` with no `const`) breaks that condition, so rjsf falls
 * back to rendering both the underlying StringField (a visible text input
 * showing the value) AND the AnyOfField selector. The result on screen is a
 * doubled control: literal preset title text shown as the input value with a
 * separate dropdown below. Switching to `enum` produces a single, clean
 * select. Users who need a custom 5-field cron pattern can set it directly
 * in the plugin's saved JSON config (`~/.signalk/plugin-config-data/<id>.json`).
 */
const CRON_PRESET_VALUES = CRON_PRESETS.map((p) => p.value);
const CRON_PRESET_TITLES = CRON_PRESETS.map((p) => p.label);

const CRON_HELP =
  'Pick a preset. Custom 5-field cron patterns can be set by editing the ' +
  "plugin's JSON config file directly.";

export function cronPatternSchema(defaultPattern: string): Record<string, unknown> {
  // If the saved default is not a preset (e.g. a custom pattern persisted in
  // the JSON config, or a future analyzer shipping a non-preset default),
  // include it in the enum so rjsf keeps the dropdown selection consistent
  // rather than blanking it.
  const presets = [...CRON_PRESET_VALUES] as string[];
  const titles = [...CRON_PRESET_TITLES] as string[];
  if (defaultPattern && !presets.includes(defaultPattern)) {
    presets.push(defaultPattern);
    titles.push(`Custom: ${defaultPattern}`);
  }
  return {
    type: 'string',
    title: 'Schedule',
    default: defaultPattern || presets[0],
    enum: presets,
    enumNames: titles,
  };
}

/**
 * The two repeating shapes inside `PluginSchema` that tests and helpers walk
 * most often. They are exported as light type aliases (not a full discriminated
 * union) so tests can drop the bulk of their `as { ... }` casts.
 *
 * `EnabledGatedNode` is the standard rjsf "checkbox reveals more fields" gate:
 * `enabled` lives at the top level and the conditional fields live inside the
 * `enabled === true` branch of `dependencies.enabled.oneOf`.
 */
export interface EnabledGatedNode {
  type: 'object';
  title?: string;
  description?: string;
  properties: {
    enabled: { type: 'boolean'; title?: string; default?: boolean; description?: string };
  };
  dependencies: {
    enabled: {
      oneOf: [
        { properties: { enabled: { const: false } } },
        { properties: Record<string, unknown> & { enabled: { const: true } } },
      ];
    };
  };
}

/**
 * The `triggers` block that every analyzer's enabled-true branch hangs off.
 * `cron` is an `EnabledGatedNode` (the enabled-true branch reveals the cron
 * pattern dropdown). `put` is a plain object with only `enabled` (the PUT
 * path is a fixed convention exposed via the field description). `events`
 * is a plain string array whose enum varies per analyzer; it is omitted
 * entirely for analyzers with no supported events.
 */
export interface TriggerSchemaNode {
  type: 'object';
  title: string;
  description: string;
  properties: {
    cron: EnabledGatedNode;
    put: {
      type: 'object';
      title: string;
      properties: {
        enabled: { type: 'boolean'; title: string; default: boolean; description: string };
      };
    };
    events?: {
      type: 'array';
      title?: string;
      description?: string;
      items: unknown;
      default?: unknown[];
      uniqueItems?: boolean;
    };
  };
}

/**
 * Wraps the `{ dependencies: { enabled: { oneOf: [...false, ...true] } } }`
 * shape used at every place where toggling `enabled` reveals/hides extra
 * fields. The caller still owns the outer `type: 'object'`, `title`,
 * `description`, and the `properties.enabled` boolean (which vary per site).
 */
function enabledGate(opts: {
  whenEnabled: Record<string, unknown>;
}): Pick<EnabledGatedNode, 'dependencies'> {
  return {
    dependencies: {
      enabled: {
        oneOf: [
          { properties: { enabled: { const: false } } },
          {
            properties: { enabled: { const: true }, ...opts.whenEnabled } as Record<
              string,
              unknown
            > & { enabled: { const: true } },
          },
        ],
      },
    },
  };
}

function triggerSchema(opts: {
  defaults: AnalyzerTriggerCfg;
  supportedEvents: ReadonlyArray<string>;
}): TriggerSchemaNode {
  const { defaults, supportedEvents } = opts;
  const properties: TriggerSchemaNode['properties'] = {
    cron: {
      type: 'object',
      title: 'Schedule',
      properties: {
        enabled: {
          type: 'boolean',
          title: 'Run on a schedule',
          default: defaults.cron.enabled,
        },
      },
      ...enabledGate({
        whenEnabled: {
          pattern: cronPatternSchema(defaults.cron.pattern),
        },
      }),
    },
    put: {
      type: 'object',
      title: 'On-demand trigger',
      properties: {
        enabled: {
          type: 'boolean',
          title: 'Allow on-demand trigger via Signal K PUT',
          default: defaults.put.enabled,
          // PUT path is a fixed convention `plugins.openrouter-companion.<id>.run`
          // (derived from the analyzer id at registration time, not configurable).
          description: 'PUT to plugins.openrouter-companion.<analyzer-id>.run to fire on demand.',
        },
      },
    },
  };
  // Only include the events field when there are events to choose from.
  // Omitting it entirely is cleaner than rendering a disabled empty array
  // since `ui:widget: 'hidden'` does not fully hide a field in the SK admin
  // UI (the custom FieldTemplate ignores rjsf's `hidden` prop, so the label
  // and wrapper still render).
  if (supportedEvents.length > 0) {
    properties.events = {
      type: 'array',
      title: 'Event subscriptions',
      description:
        'Pick which vessel events should invoke this analyzer. Leaving all unchecked disables the event trigger; the analyzer still runs on its schedule and on a PUT if those are enabled.',
      uniqueItems: true,
      items: { type: 'string' as const, enum: supportedEvents as string[] },
      default: defaults.events,
    };
  }

  return {
    type: 'object',
    title: 'When to run',
    description:
      'Every analyzer supports cron, PUT, and an event subscription. Defaults vary per analyzer; an event-only analyzer ships with cron disabled.',
    properties,
  };
}

/**
 * The per-analyzer schema node: the outer `type: 'object'`, title and
 * description, the top-level `enabled` boolean, and the enabled-true gate.
 * Only the titles, the `enabled` default, and the gated `whenEnabled` fields
 * vary per analyzer, so every analyzer block goes through here rather than
 * repeating the skeleton seven times.
 */
function analyzerSchemaNode(opts: {
  title: string;
  description: string;
  enabledTitle: string;
  enabledDefault: boolean;
  whenEnabled: Record<string, unknown>;
}): EnabledGatedNode {
  return {
    type: 'object',
    title: opts.title,
    description: opts.description,
    properties: {
      enabled: { type: 'boolean', title: opts.enabledTitle, default: opts.enabledDefault },
    },
    ...enabledGate({ whenEnabled: opts.whenEnabled }),
  };
}

// PluginSchema and PluginUiSchema are file-private return-type aliases for
// the two builders; downstream consumers (SK admin, tests) treat them as
// opaque JSON shapes and do not import the type names.
type PluginSchema = {
  type: 'object';
  description: string;
  properties: Record<string, Record<string, unknown>>;
};

type PluginUiSchema = Record<string, unknown>;

// The SK admin UI wrapper sets the outer title to a single space and ignores
// the outer `required` array, so the top-level `title` on this schema is
// always dropped. The inner `description` IS rendered as the form preamble
// and is the place to put user-facing copy; the inner `openrouter.required`
// remains the load-bearing required declaration.
function buildSchemaInner(): PluginSchema {
  return {
    type: 'object',
    description:
      'OpenRouter-powered analyzers for Signal K: engine maintenance reports, daily battery health summaries, battery threshold alerts, monthly battery aging trends, weekly engine performance drift, sensor-liveness monitoring, and short-term weather outlooks. Each analyzer can be independently enabled and configured below. The only required field is your OpenRouter API key. Disabling any "Enable ..." or "Run on a schedule" toggle clears the gated fields below it, so save first if you want to keep a custom value.',
    properties: {
      openrouter: {
        type: 'object',
        title: 'OpenRouter',
        required: ['apiKey'],
        properties: {
          apiKey: {
            type: 'string',
            title: 'API Key',
            description: 'OpenRouter API key. Required to call the LLM.',
            default: DEFAULT_OPTIONS.openrouter.apiKey,
          },
          model: {
            type: 'string',
            title: 'Model',
            description: 'OpenRouter model slug (e.g. anthropic/claude-haiku-4.5).',
            default: DEFAULT_OPTIONS.openrouter.model,
          },
          maxCallsPerDay: {
            type: 'integer',
            title: 'Max OpenRouter calls per day',
            description: 'Hard cap on OpenRouter calls per UTC day to bound spend.',
            default: DEFAULT_OPTIONS.openrouter.maxCallsPerDay,
            minimum: 0,
          },
        },
      },
      questdb: {
        type: 'object',
        title: 'QuestDB (optional history source)',
        description:
          'If you run signalk-questdb, the plugin pulls 30-day baselines for richer reports.',
        properties: {
          enabled: {
            type: 'boolean',
            title: 'Enable QuestDB enrichment',
            description:
              'When enabled, the plugin probes QuestDB on start and uses it for history lookups. Falls back gracefully if unreachable.',
            default: DEFAULT_OPTIONS.questdb.enabled,
          },
        },
        ...enabledGate({
          whenEnabled: {
            url: {
              type: 'string',
              title: 'QuestDB REST URL',
              description: 'Only used when QuestDB enrichment is enabled.',
              default: DEFAULT_OPTIONS.questdb.url,
            },
          },
        }),
      },
      analyzers: {
        type: 'object',
        title: 'Analyzers',
        properties: {
          maintenance: analyzerSchemaNode({
            title: 'Maintenance Advisor',
            description: 'Generates a plain-English engine session report when the engine stops.',
            enabledTitle: 'Enable engine maintenance reports',
            enabledDefault: DEFAULT_OPTIONS.analyzers.maintenance.enabled,
            whenEnabled: {
              triggers: triggerSchema({
                defaults: DEFAULT_OPTIONS.analyzers.maintenance.triggers,
                supportedEvents: MAINTENANCE_SUPPORTED_EVENTS,
              }),
              engineStopRpmHzThreshold: {
                type: 'number',
                title: 'Engine-off RPM threshold (Hz)',
                description:
                  'RPM frequency below which the engine is considered idle (1.0 Hz = 60 RPM).',
                default: DEFAULT_OPTIONS.analyzers.maintenance.engineStopRpmHzThreshold,
              },
              engineStopSettleSeconds: {
                type: 'integer',
                title: 'Engine-off settle time (seconds)',
                description:
                  'How long RPM must stay below the threshold before the engine is considered stopped. Default 10s.',
                default: DEFAULT_OPTIONS.analyzers.maintenance.engineStopSettleSeconds,
                minimum: 0,
              },
              engineSilenceStopSeconds: {
                type: 'integer',
                title: 'Engine-silent stop time (seconds)',
                description:
                  'How long the RPM feed can go fully silent before the session is treated as ended. A switched-off NMEA 2000 engine stops broadcasting entirely rather than reporting RPM 0. Default 300s.',
                default: DEFAULT_OPTIONS.analyzers.maintenance.engineSilenceStopSeconds,
                minimum: 0,
              },
              engineStartRpmHzThreshold: {
                type: 'number',
                title: 'Engine-on RPM threshold (Hz)',
                description:
                  'RPM frequency above which the engine is considered running (1.0 Hz = 60 RPM).',
                default: DEFAULT_OPTIONS.analyzers.maintenance.engineStartRpmHzThreshold,
              },
              engineStartSettleSeconds: {
                type: 'integer',
                title: 'Engine-on settle time (seconds)',
                description:
                  'How long RPM must stay above the threshold before the engine is considered running.',
                default: DEFAULT_OPTIONS.analyzers.maintenance.engineStartSettleSeconds,
                minimum: 0,
              },
              minSessionSeconds: {
                type: 'integer',
                title: 'Minimum session length (seconds)',
                description: 'Engine sessions shorter than this are ignored (no report generated).',
                default: DEFAULT_OPTIONS.analyzers.maintenance.minSessionSeconds,
                minimum: 0,
              },
              extraWatchedPaths: {
                type: 'array',
                title: 'Extra Signal K paths to include',
                description:
                  'Additional Signal K paths to sample during each engine session and include in the report.',
                items: { type: 'string' },
                default: DEFAULT_OPTIONS.analyzers.maintenance.extraWatchedPaths,
              },
            },
          }),
          health: analyzerSchemaNode({
            title: 'Daily Battery Health Summary',
            description: "Daily summary of every battery bank's health.",
            enabledTitle: 'Enable daily battery health summaries',
            enabledDefault: DEFAULT_OPTIONS.analyzers.health.enabled,
            whenEnabled: {
              triggers: triggerSchema({
                defaults: DEFAULT_OPTIONS.analyzers.health.triggers,
                supportedEvents: NO_EVENTS,
              }),
            },
          }),
          aging: analyzerSchemaNode({
            title: 'Battery Aging Tracker',
            description:
              'Monthly capacity-loss trend per battery bank, ranked by degradation rate.',
            enabledTitle: 'Enable battery aging tracker',
            enabledDefault: DEFAULT_OPTIONS.analyzers.aging.enabled,
            whenEnabled: {
              triggers: triggerSchema({
                defaults: DEFAULT_OPTIONS.analyzers.aging.triggers,
                supportedEvents: NO_EVENTS,
              }),
              shortWindowDays: {
                type: 'integer',
                title: 'Short window (days)',
                description:
                  'How far back to look for the near-term aging window. Default 30. The shorter window catches recent acceleration in capacity loss.',
                default: DEFAULT_OPTIONS.analyzers.aging.shortWindowDays,
                minimum: 7,
                maximum: 365,
              },
              longWindowDays: {
                type: 'integer',
                title: 'Long window (days)',
                description:
                  'How far back to look for the longer-term aging window. Default 90. The longer window provides a more stable baseline for the projection to 80 percent of nominal capacity.',
                default: DEFAULT_OPTIONS.analyzers.aging.longWindowDays,
                minimum: 7,
                maximum: 1095,
              },
            },
          }),
          drift: analyzerSchemaNode({
            title: 'Engine Performance Drift',
            description:
              'Weekly fuel-economy and per-RPM drift for engines vs a configurable trailing baseline.',
            enabledTitle: 'Enable engine performance drift analysis',
            enabledDefault: DEFAULT_OPTIONS.analyzers.drift.enabled,
            whenEnabled: {
              triggers: triggerSchema({
                defaults: DEFAULT_OPTIONS.analyzers.drift.triggers,
                supportedEvents: NO_EVENTS,
              }),
              baselineDays: {
                type: 'integer',
                title: 'Baseline window (days)',
                description:
                  'How many days of QuestDB history to use as the baseline for the past-week vs baseline comparison. Default 30. The baseline ends where the past week begins (no overlap).',
                default: DEFAULT_OPTIONS.analyzers.drift.baselineDays,
                minimum: 14,
                maximum: 365,
              },
            },
          }),
          alerts: analyzerSchemaNode({
            title: 'Battery Threshold Alerts',
            description:
              'Sends notifications when state-of-charge or cell-balance crosses configured thresholds.',
            enabledTitle: 'Enable battery threshold alerts',
            enabledDefault: DEFAULT_OPTIONS.analyzers.alerts.enabled,
            whenEnabled: {
              triggers: triggerSchema({
                defaults: DEFAULT_OPTIONS.analyzers.alerts.triggers,
                supportedEvents: ALERTS_SUPPORTED_EVENTS,
              }),
              lowSocPercent: {
                type: 'number',
                title: 'Low state-of-charge threshold (%)',
                description: 'Fires a low-SoC alert when any bank drops below this value.',
                default: DEFAULT_OPTIONS.analyzers.alerts.lowSocPercent,
                minimum: 0,
                maximum: 100,
              },
              socExitHysteresis: {
                type: 'number',
                title: 'SoC recovery hysteresis (%)',
                description:
                  'SoC must rise above (threshold + hysteresis) before the alert clears.',
                default: DEFAULT_OPTIONS.analyzers.alerts.socExitHysteresis,
                minimum: 0,
              },
              cellImbalanceV: {
                type: 'number',
                title: 'Cell imbalance threshold (V)',
                description:
                  'Voltage difference between highest and lowest cell that triggers an alert.',
                default: DEFAULT_OPTIONS.analyzers.alerts.cellImbalanceV,
                minimum: 0,
              },
              imbalanceSettleSec: {
                type: 'integer',
                title: 'Cell imbalance settle time (seconds)',
                description:
                  'Cell imbalance must persist for this many seconds before an alert fires.',
                default: DEFAULT_OPTIONS.analyzers.alerts.imbalanceSettleSec,
                minimum: 0,
              },
            },
          }),
          liveness: analyzerSchemaNode({
            title: 'Sensor Liveness Monitor',
            description:
              'Reports watched Signal K paths that have gone stale or are served by multiple sources.',
            enabledTitle: 'Enable sensor liveness monitoring',
            enabledDefault: DEFAULT_OPTIONS.analyzers.liveness.enabled,
            whenEnabled: {
              triggers: triggerSchema({
                defaults: DEFAULT_OPTIONS.analyzers.liveness.triggers,
                supportedEvents: NO_EVENTS,
              }),
              stalenessThresholdSec: {
                type: 'integer',
                title: 'Staleness threshold (seconds)',
                description:
                  'A watched path with no sample newer than this is reported as stale. Default 300.',
                default: DEFAULT_OPTIONS.analyzers.liveness.stalenessThresholdSec,
                minimum: 30,
              },
            },
          }),
          forecast: analyzerSchemaNode({
            title: 'Weather Outlook Advisor',
            description:
              'Reads how environmental conditions are changing and publishes a short-term weather outlook as a Signal K notification.',
            enabledTitle: 'Enable weather outlook advisor',
            enabledDefault: DEFAULT_OPTIONS.analyzers.forecast.enabled,
            whenEnabled: {
              triggers: triggerSchema({
                defaults: DEFAULT_OPTIONS.analyzers.forecast.triggers,
                supportedEvents: NO_EVENTS,
              }),
              severityFloor: {
                type: 'string',
                title: 'Alarm severity floor',
                description:
                  'How bad the predicted weather must be before the outlook raises an alarm. Below the floor the outlook still publishes at a normal state, so it is always readable in the Data Browser.',
                enum: SEVERITY_FLOOR_PRESETS.map((p) => p.value),
                enumNames: SEVERITY_FLOOR_PRESETS.map((p) => p.label),
                default: DEFAULT_OPTIONS.analyzers.forecast.severityFloor,
              },
            },
          }),
        },
      },
    },
  };
}

function triggerUiSchema(opts: {
  supportedEvents: ReadonlyArray<string>;
}): Record<string, unknown> {
  const { supportedEvents } = opts;
  const ui: Record<string, unknown> = {
    'ui:order': ['cron', 'put', 'events'],
    cron: {
      'ui:order': ['enabled', 'pattern'],
      pattern: {
        'ui:help': CRON_HELP,
      },
    },
    put: {
      'ui:order': ['enabled'],
    },
  };
  if (supportedEvents.length > 0) {
    ui.events = {
      'ui:widget': 'checkboxes',
      'ui:options': { inline: false },
      'ui:enumNames': eventTitlesFor(supportedEvents),
    };
  }
  return ui;
}

function buildUiSchemaInner(): PluginUiSchema {
  return {
    openrouter: {
      'ui:order': ['apiKey', 'model', 'maxCallsPerDay'],
      apiKey: {
        'ui:widget': 'password',
        'ui:autocomplete': 'off',
      },
      model: {
        'ui:placeholder': 'anthropic/claude-haiku-4.5',
      },
    },
    questdb: {
      'ui:order': ['enabled', 'url'],
    },
    analyzers: {
      maintenance: {
        'ui:order': [
          'enabled',
          'triggers',
          'engineStopRpmHzThreshold',
          'engineStopSettleSeconds',
          'engineSilenceStopSeconds',
          'engineStartRpmHzThreshold',
          'engineStartSettleSeconds',
          'minSessionSeconds',
          'extraWatchedPaths',
        ],
        triggers: triggerUiSchema({ supportedEvents: MAINTENANCE_SUPPORTED_EVENTS }),
        extraWatchedPaths: {
          'ui:options': { orderable: false },
        },
      },
      health: {
        'ui:order': ['enabled', 'triggers'],
        triggers: triggerUiSchema({ supportedEvents: NO_EVENTS }),
      },
      aging: {
        'ui:order': ['enabled', 'triggers', 'shortWindowDays', 'longWindowDays'],
        triggers: triggerUiSchema({ supportedEvents: NO_EVENTS }),
      },
      drift: {
        'ui:order': ['enabled', 'triggers', 'baselineDays'],
        triggers: triggerUiSchema({ supportedEvents: NO_EVENTS }),
      },
      alerts: {
        'ui:order': [
          'enabled',
          'triggers',
          'lowSocPercent',
          'socExitHysteresis',
          'cellImbalanceV',
          'imbalanceSettleSec',
        ],
        triggers: triggerUiSchema({ supportedEvents: ALERTS_SUPPORTED_EVENTS }),
      },
      liveness: {
        'ui:order': ['enabled', 'triggers', 'stalenessThresholdSec'],
        triggers: triggerUiSchema({ supportedEvents: NO_EVENTS }),
      },
      forecast: {
        'ui:order': ['enabled', 'triggers', 'severityFloor'],
        triggers: triggerUiSchema({ supportedEvents: NO_EVENTS }),
      },
    },
  };
}

// Both schemas are pure functions of compile-time constants. Build once at
// module load and return the same reference on every call.
const SCHEMA: PluginSchema = buildSchemaInner();
const UI_SCHEMA: PluginUiSchema = buildUiSchemaInner();

export function buildSchema(): PluginSchema {
  return SCHEMA;
}

export function buildUiSchema(): PluginUiSchema {
  return UI_SCHEMA;
}
