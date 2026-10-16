import type { BatteryEventKind } from './analyzers/Analyzer.js';
import { ANALYZER_TITLES, type AnalyzerId } from './analyzers/ids.js';
import { MAX_CALLS_PER_DAY_CEILING } from './callBudget.js';
import { CRON_PRESETS } from './cronPresets.js';
import { SEVERITY_FLOOR_PRESETS } from './severityFloors.js';
import {
  ANALYZER_BOUNDS,
  ANALYZER_SUPPORTED_EVENTS,
  type AnalyzerTriggerCfg,
  DEFAULT_OPTIONS,
  type MaintenanceEventKind,
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
  // Build fresh arrays on every call. Returning the shared module arrays makes
  // the same enum/enumNames object appear in every analyzer's cron node, which
  // the SignalK plugin-ci schema check flags as a circular reference (it treats
  // any object seen twice as a cycle), failing the App Store compliance gate.
  const needsCustom = !!defaultPattern && !CRON_PRESET_VALUES.includes(defaultPattern);
  const presets = needsCustom ? [...CRON_PRESET_VALUES, defaultPattern] : [...CRON_PRESET_VALUES];
  const titles = needsCustom
    ? [...CRON_PRESET_TITLES, `Custom: ${defaultPattern}`]
    : [...CRON_PRESET_TITLES];
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
          description:
            'PUT to plugins.openrouter-companion.<analyzer-id>.run to fire on demand. Each trigger consumes the shared OpenRouter budget and is available to clients with Signal K write permission.',
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
 * description, the top-level `enabled` boolean, and the enabled-true gate with
 * the analyzer's trigger block first. The title, the `enabled` default, the
 * trigger defaults, and the supported events all follow from the analyzer id,
 * so only the copy and the analyzer's own `settings` vary per block.
 */
function analyzerSchemaNode(opts: {
  id: AnalyzerId;
  description: string;
  enabledTitle: string;
  settings?: Record<string, unknown>;
}): EnabledGatedNode {
  const defaults = DEFAULT_OPTIONS.analyzers[opts.id];
  return {
    type: 'object',
    title: ANALYZER_TITLES[opts.id],
    description: opts.description,
    properties: {
      enabled: { type: 'boolean', title: opts.enabledTitle, default: defaults.enabled },
    },
    ...enabledGate({
      whenEnabled: {
        triggers: triggerSchema({
          defaults: defaults.triggers,
          supportedEvents: ANALYZER_SUPPORTED_EVENTS[opts.id],
        }),
        ...opts.settings,
      },
    }),
  };
}

// A bounded setting's minimum and maximum, read from ANALYZER_BOUNDS so the
// form advertises exactly the range the option normalizer clamps to.
function boundsOf(bound: { min: number; max?: number }): { minimum: number; maximum?: number } {
  return bound.max === undefined
    ? { minimum: bound.min }
    : { minimum: bound.min, maximum: bound.max };
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
            // "analyzer calls": POST /api/openrouter/test deliberately runs
            // outside this cap so an operator debugging connectivity does not
            // spend the day's analyzer budget. That route carries its own
            // coalescing and cooldown instead; see core/api.ts.
            description: 'Hard cap on analyzer OpenRouter calls per UTC day, to bound spend.',
            default: DEFAULT_OPTIONS.openrouter.maxCallsPerDay,
            // Matches the runtime clamp floor in types.ts::validateOptions. A
            // lower value would be silently rewritten to the default, so a
            // "0 calls" entry would buy the shipped daily cap instead.
            minimum: 1,
            // Matches the runtime ceiling, from the same constant. The cap is
            // the only hard spend bound in the plugin, so it needs a top.
            maximum: MAX_CALLS_PER_DAY_CEILING,
          },
          fallbackModels: {
            type: 'array',
            title: 'Fallback models',
            description:
              'Optional ordered list of model slugs to try if the primary model is unavailable. Leave empty to use only the primary model.',
            items: { type: 'string' },
            default: [],
          },
          provider: {
            type: 'object',
            title: 'Provider routing (advanced)',
            description:
              'Optional OpenRouter provider controls. Left unset, your OpenRouter account settings govern where prompts are routed and how long providers retain them. Tight routing can leave no eligible provider and fail a run.',
            properties: {
              sort: {
                type: 'string',
                title: 'Routing preference',
                description:
                  'How OpenRouter selects among eligible providers: price (lowest cost), throughput (highest tokens/sec), or latency (fastest first token).',
                enum: ['price', 'throughput', 'latency'],
              },
              allowFallbacks: {
                type: 'boolean',
                title: 'Allow provider fallbacks',
                description: 'When off, a run fails rather than substituting a different provider.',
              },
              dataCollection: {
                type: 'string',
                title: 'Provider data collection',
                description:
                  'Set to deny to route only to providers that do not retain or train on request data.',
                enum: ['allow', 'deny'],
              },
              zdr: {
                type: 'boolean',
                title: 'Require zero-data-retention providers',
              },
              maxPrice: {
                type: 'object',
                title: 'Maximum price',
                description:
                  'Skip providers above these prices. prompt/completion are USD per million tokens; request is USD per request.',
                properties: {
                  prompt: {
                    type: 'number',
                    title: 'Max prompt price (USD / 1M tokens)',
                    minimum: 0,
                  },
                  completion: {
                    type: 'number',
                    title: 'Max completion price (USD / 1M tokens)',
                    minimum: 0,
                  },
                  request: { type: 'number', title: 'Max per-request price (USD)', minimum: 0 },
                },
              },
            },
          },
        },
      },
      history: {
        type: 'object',
        title: 'History source',
        description:
          'Choose the read-only time-series source used by aging, drift, and the optional forecast baseline.',
        properties: {
          source: {
            type: 'string',
            title: 'Provider',
            enum: ['none', 'questdb', 'influxdb'],
            enumNames: ['Disabled', 'QuestDB', 'InfluxDB'],
            default: DEFAULT_OPTIONS.history.source,
          },
        },
        dependencies: {
          source: {
            oneOf: [
              { properties: { source: { const: 'none' } } },
              {
                properties: {
                  source: { const: 'questdb' },
                  questdb: {
                    type: 'object',
                    title: 'QuestDB',
                    required: ['url'],
                    properties: {
                      url: {
                        type: 'string',
                        title: 'QuestDB REST URL',
                        default: DEFAULT_OPTIONS.history.questdb.url,
                      },
                    },
                  },
                },
              },
              {
                properties: {
                  source: { const: 'influxdb' },
                  influxdb: {
                    type: 'object',
                    title: 'InfluxDB',
                    required: ['version', 'url', 'database'],
                    properties: {
                      version: {
                        type: 'string',
                        title: 'InfluxDB version',
                        enum: ['1', '2'],
                        enumNames: ['InfluxDB 1.x', 'InfluxDB 2.x compatibility API'],
                        default: DEFAULT_OPTIONS.history.influxdb.version,
                      },
                      url: {
                        type: 'string',
                        title: 'InfluxDB URL',
                        default: DEFAULT_OPTIONS.history.influxdb.url,
                      },
                      database: {
                        type: 'string',
                        title: 'Database or DBRP database',
                        default: DEFAULT_OPTIONS.history.influxdb.database,
                      },
                      username: {
                        type: 'string',
                        title: 'Username',
                        default: DEFAULT_OPTIONS.history.influxdb.username,
                      },
                      password: {
                        type: 'string',
                        title: 'Password or API token',
                        default: DEFAULT_OPTIONS.history.influxdb.password,
                      },
                    },
                  },
                },
              },
            ],
          },
        },
      },
      analyzers: {
        type: 'object',
        title: 'Analyzers',
        properties: {
          maintenance: analyzerSchemaNode({
            id: 'maintenance',
            description: 'Generates a plain-English engine session report when the engine stops.',
            enabledTitle: 'Enable engine maintenance reports',
            settings: {
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
                ...boundsOf(ANALYZER_BOUNDS.maintenance.engineStopSettleSeconds),
              },
              engineSilenceStopSeconds: {
                type: 'integer',
                title: 'Engine-silent stop time (seconds)',
                description:
                  'How long the RPM feed can go fully silent before the session is treated as ended. A switched-off NMEA 2000 engine stops broadcasting entirely rather than reporting RPM 0. Default 300s.',
                default: DEFAULT_OPTIONS.analyzers.maintenance.engineSilenceStopSeconds,
                ...boundsOf(ANALYZER_BOUNDS.maintenance.engineSilenceStopSeconds),
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
                ...boundsOf(ANALYZER_BOUNDS.maintenance.engineStartSettleSeconds),
              },
              minSessionSeconds: {
                type: 'integer',
                title: 'Minimum session length (seconds)',
                description: 'Engine sessions shorter than this are ignored (no report generated).',
                default: DEFAULT_OPTIONS.analyzers.maintenance.minSessionSeconds,
                ...boundsOf(ANALYZER_BOUNDS.maintenance.minSessionSeconds),
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
            id: 'health',
            description: "Daily summary of every battery bank's health.",
            enabledTitle: 'Enable daily battery health summaries',
          }),
          aging: analyzerSchemaNode({
            id: 'aging',
            description:
              'Monthly capacity-loss trend per battery bank, ranked by degradation rate.',
            enabledTitle: 'Enable battery aging tracker',
            settings: {
              shortWindowDays: {
                type: 'integer',
                title: 'Short window (days)',
                description:
                  'How far back to look for the near-term aging window. Default 30. The shorter window catches recent acceleration in capacity loss.',
                default: DEFAULT_OPTIONS.analyzers.aging.shortWindowDays,
                ...boundsOf(ANALYZER_BOUNDS.aging.shortWindowDays),
              },
              longWindowDays: {
                type: 'integer',
                title: 'Long window (days)',
                description:
                  'How far back to look for the longer-term aging window. Default 90. The longer window provides a more stable baseline for the projection to 80 percent of nominal capacity.',
                default: DEFAULT_OPTIONS.analyzers.aging.longWindowDays,
                ...boundsOf(ANALYZER_BOUNDS.aging.longWindowDays),
              },
            },
          }),
          drift: analyzerSchemaNode({
            id: 'drift',
            description:
              'Weekly fuel-economy and per-RPM drift for engines vs a configurable trailing baseline.',
            enabledTitle: 'Enable engine performance drift analysis',
            settings: {
              baselineDays: {
                type: 'integer',
                title: 'Baseline window (days)',
                description:
                  'How many days of history to use as the baseline for the past-week vs baseline comparison. Default 30. The baseline ends where the past week begins (no overlap).',
                default: DEFAULT_OPTIONS.analyzers.drift.baselineDays,
                ...boundsOf(ANALYZER_BOUNDS.drift.baselineDays),
              },
            },
          }),
          alerts: analyzerSchemaNode({
            id: 'alerts',
            description:
              'Sends notifications when state-of-charge or cell-balance crosses configured thresholds. Note: the alert text is written by an OpenRouter call, so a crossing is reported only when the call succeeds and the shared daily budget (Max OpenRouter calls per day) is not yet exhausted. If the budget is spent or OpenRouter is unreachable, a crossing may not raise a notification. Do not rely on this as your sole battery safety alarm; pair it with a hardware or BMS alarm, and set the daily budget high enough to cover your expected crossings.',
            enabledTitle: 'Enable battery threshold alerts',
            settings: {
              lowSocPercent: {
                type: 'number',
                title: 'Low state-of-charge threshold (%)',
                description: 'Fires a low-SoC alert when any bank drops below this value.',
                default: DEFAULT_OPTIONS.analyzers.alerts.lowSocPercent,
                ...boundsOf(ANALYZER_BOUNDS.alerts.lowSocPercent),
              },
              socExitHysteresis: {
                type: 'number',
                title: 'SoC recovery hysteresis (%)',
                description:
                  'SoC must rise above (threshold + hysteresis) before the alert clears.',
                default: DEFAULT_OPTIONS.analyzers.alerts.socExitHysteresis,
                ...boundsOf(ANALYZER_BOUNDS.alerts.socExitHysteresis),
              },
              cellImbalanceV: {
                type: 'number',
                title: 'Cell imbalance threshold (V)',
                description:
                  'Voltage difference between highest and lowest cell that triggers an alert.',
                default: DEFAULT_OPTIONS.analyzers.alerts.cellImbalanceV,
                ...boundsOf(ANALYZER_BOUNDS.alerts.cellImbalanceV),
              },
              imbalanceSettleSec: {
                type: 'integer',
                title: 'Cell imbalance settle time (seconds)',
                description:
                  'Cell imbalance must persist for this many seconds before an alert fires.',
                default: DEFAULT_OPTIONS.analyzers.alerts.imbalanceSettleSec,
                ...boundsOf(ANALYZER_BOUNDS.alerts.imbalanceSettleSec),
              },
            },
          }),
          liveness: analyzerSchemaNode({
            id: 'liveness',
            description:
              'Reports watched Signal K paths that have gone stale or are served by multiple sources.',
            enabledTitle: 'Enable sensor liveness monitoring',
            settings: {
              stalenessThresholdSec: {
                type: 'integer',
                title: 'Staleness threshold (seconds)',
                description:
                  'A watched path with no sample newer than this is reported as stale. Default 300.',
                default: DEFAULT_OPTIONS.analyzers.liveness.stalenessThresholdSec,
                ...boundsOf(ANALYZER_BOUNDS.liveness.stalenessThresholdSec),
              },
            },
          }),
          forecast: analyzerSchemaNode({
            id: 'forecast',
            description:
              'Reads how environmental conditions are changing and publishes a short-term weather outlook as a Signal K notification.',
            enabledTitle: 'Enable weather outlook advisor',
            settings: {
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
      'ui:order': ['apiKey', 'model', 'maxCallsPerDay', 'fallbackModels', 'provider'],
      apiKey: {
        'ui:widget': 'password',
        'ui:autocomplete': 'off',
      },
      model: {
        'ui:placeholder': 'anthropic/claude-haiku-4.5',
      },
      provider: {
        'ui:order': ['sort', 'allowFallbacks', 'dataCollection', 'zdr', 'maxPrice'],
      },
    },
    history: {
      'ui:order': ['source', 'questdb', 'influxdb'],
      influxdb: {
        'ui:order': ['version', 'url', 'database', 'username', 'password'],
        password: {
          'ui:widget': 'password',
          'ui:autocomplete': 'off',
        },
      },
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
        triggers: triggerUiSchema({ supportedEvents: ANALYZER_SUPPORTED_EVENTS.maintenance }),
        extraWatchedPaths: {
          'ui:options': { orderable: false },
        },
      },
      health: {
        'ui:order': ['enabled', 'triggers'],
        triggers: triggerUiSchema({ supportedEvents: ANALYZER_SUPPORTED_EVENTS.health }),
      },
      aging: {
        'ui:order': ['enabled', 'triggers', 'shortWindowDays', 'longWindowDays'],
        triggers: triggerUiSchema({ supportedEvents: ANALYZER_SUPPORTED_EVENTS.aging }),
      },
      drift: {
        'ui:order': ['enabled', 'triggers', 'baselineDays'],
        triggers: triggerUiSchema({ supportedEvents: ANALYZER_SUPPORTED_EVENTS.drift }),
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
        triggers: triggerUiSchema({ supportedEvents: ANALYZER_SUPPORTED_EVENTS.alerts }),
      },
      liveness: {
        'ui:order': ['enabled', 'triggers', 'stalenessThresholdSec'],
        triggers: triggerUiSchema({ supportedEvents: ANALYZER_SUPPORTED_EVENTS.liveness }),
      },
      forecast: {
        'ui:order': ['enabled', 'triggers', 'severityFloor'],
        triggers: triggerUiSchema({ supportedEvents: ANALYZER_SUPPORTED_EVENTS.forecast }),
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
