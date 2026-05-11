import {
  ALERTS_SUPPORTED_EVENTS,
  type AnalyzerTriggerCfg,
  DEFAULT_OPTIONS,
  HEALTH_SUPPORTED_EVENTS,
  MAINTENANCE_SUPPORTED_EVENTS,
} from './types.js';

/**
 * Human-readable labels for each event subkind exposed in the admin UI.
 * Kept here (rather than alongside the event constants in types.ts) because
 * these strings are UI copy specific to the rjsf `enumNames` directive.
 */
const EVENT_TITLES: Record<string, string> = {
  'engine-stop': 'Engine session ended',
  'low-soc-enter': 'Low SoC: bank entered low state',
  'low-soc-exit': 'Low SoC: bank recovered',
  'cell-imbalance-enter': 'Cell imbalance detected',
  'cell-imbalance-exit': 'Cell imbalance cleared',
};

function eventTitlesFor(events: ReadonlyArray<string>): string[] {
  return events.map((e) => EVENT_TITLES[e] ?? e);
}

const CRON_PRESETS: ReadonlyArray<{ title: string; const: string }> = [
  { title: '8:00 AM daily', const: '0 8 * * *' },
  { title: '7:00 AM daily', const: '0 7 * * *' },
  { title: 'Noon daily', const: '0 12 * * *' },
  { title: '5:30 PM daily', const: '30 17 * * *' },
  { title: '6:00 PM daily', const: '0 18 * * *' },
  { title: 'Midnight Sunday', const: '0 0 * * 0' },
  { title: 'Midnight on the 1st', const: '0 0 1 * *' },
];

const CRON_HELP =
  "Pick a preset or choose 'Other' to enter your own 5-field cron pattern " +
  '(minute hour day-of-month month day-of-week).';

function cronPatternSchema(defaultPattern: string): Record<string, unknown> {
  return {
    title: 'Schedule',
    default: defaultPattern,
    oneOf: [
      ...CRON_PRESETS.map((p) => ({ type: 'string', title: p.title, const: p.const })),
      { type: 'string', title: 'Other (custom 5-field cron pattern)' },
    ],
  };
}

function triggerSchema(
  defaults: AnalyzerTriggerCfg,
  supportedEvents: ReadonlyArray<string>,
): Record<string, unknown> {
  const eventsItems =
    supportedEvents.length === 0
      ? { type: 'string' as const }
      : { type: 'string' as const, enum: supportedEvents as string[] };

  return {
    type: 'object',
    title: 'When to run',
    description:
      'Cron and on-demand PUT triggers are universal. Event triggers depend on the analyzer.',
    properties: {
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
        dependencies: {
          enabled: {
            oneOf: [
              { properties: { enabled: { const: false } } },
              {
                properties: {
                  enabled: { const: true },
                  pattern: cronPatternSchema(defaults.cron.pattern),
                  timezone: {
                    type: 'string',
                    title: 'Timezone',
                    default: defaults.cron.timezone,
                  },
                },
              },
            ],
          },
        },
      },
      put: {
        type: 'object',
        title: 'On-demand trigger',
        properties: {
          enabled: {
            type: 'boolean',
            title: 'Allow on-demand trigger via Signal K PUT',
            default: defaults.put.enabled,
          },
        },
        dependencies: {
          enabled: {
            oneOf: [
              { properties: { enabled: { const: false } } },
              {
                properties: {
                  enabled: { const: true },
                  path: {
                    type: 'string',
                    title: 'Signal K PUT path',
                    default: defaults.put.path,
                  },
                },
              },
            ],
          },
        },
      },
      events: {
        type: 'array',
        title: 'Event subscriptions',
        description:
          supportedEvents.length === 0
            ? 'This analyzer does not subscribe to event triggers.'
            : 'Select which events should invoke this analyzer.',
        uniqueItems: true,
        items: eventsItems,
        default: defaults.events,
      },
    },
  };
}

export type PluginSchema = {
  type: 'object';
  title: string;
  description: string;
  required: string[];
  properties: Record<string, Record<string, unknown>>;
};

export type PluginUiSchema = Record<string, unknown>;

export function buildSchema(): PluginSchema {
  return {
    type: 'object',
    title: 'OpenRouter Companion',
    description:
      'OpenRouter-powered analyzers for Signal K: engine maintenance reports, daily battery health summaries, and battery threshold alerts. Each analyzer can be independently enabled and configured below. The only required field is your OpenRouter API key.',
    required: ['openrouter'],
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
          baseUrl: {
            type: 'string',
            title: 'OpenRouter base URL',
            default: DEFAULT_OPTIONS.openrouter.baseUrl,
          },
          requestTimeoutMs: {
            type: 'integer',
            title: 'Request timeout (ms)',
            default: DEFAULT_OPTIONS.openrouter.requestTimeoutMs,
            minimum: 1000,
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
        dependencies: {
          enabled: {
            oneOf: [
              { properties: { enabled: { const: false } } },
              {
                properties: {
                  enabled: { const: true },
                  url: {
                    type: 'string',
                    title: 'QuestDB REST URL',
                    description: 'Only used when QuestDB enrichment is enabled.',
                    default: DEFAULT_OPTIONS.questdb.url,
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
          maintenance: {
            type: 'object',
            title: 'Maintenance Advisor',
            description: 'Generates a plain-English engine session report when the engine stops.',
            properties: {
              enabled: {
                type: 'boolean',
                title: 'Enable engine maintenance reports',
                default: DEFAULT_OPTIONS.analyzers.maintenance.enabled,
              },
            },
            dependencies: {
              enabled: {
                oneOf: [
                  { properties: { enabled: { const: false } } },
                  {
                    properties: {
                      enabled: { const: true },
                      triggers: triggerSchema(
                        DEFAULT_OPTIONS.analyzers.maintenance.triggers,
                        MAINTENANCE_SUPPORTED_EVENTS,
                      ),
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
                        description:
                          'Engine sessions shorter than this are ignored (no report generated).',
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
                  },
                ],
              },
            },
          },
          health: {
            type: 'object',
            title: 'Daily Battery Health Summary',
            description: "Daily summary of every battery bank's health.",
            properties: {
              enabled: {
                type: 'boolean',
                title: 'Enable daily battery health summaries',
                default: DEFAULT_OPTIONS.analyzers.health.enabled,
              },
            },
            dependencies: {
              enabled: {
                oneOf: [
                  { properties: { enabled: { const: false } } },
                  {
                    properties: {
                      enabled: { const: true },
                      triggers: triggerSchema(
                        DEFAULT_OPTIONS.analyzers.health.triggers,
                        HEALTH_SUPPORTED_EVENTS,
                      ),
                    },
                  },
                ],
              },
            },
          },
          alerts: {
            type: 'object',
            title: 'Battery Threshold Alerts',
            description:
              'Sends notifications when state-of-charge or cell-balance crosses configured thresholds.',
            properties: {
              enabled: {
                type: 'boolean',
                title: 'Enable battery threshold alerts',
                default: DEFAULT_OPTIONS.analyzers.alerts.enabled,
              },
            },
            dependencies: {
              enabled: {
                oneOf: [
                  { properties: { enabled: { const: false } } },
                  {
                    properties: {
                      enabled: { const: true },
                      triggers: triggerSchema(
                        DEFAULT_OPTIONS.analyzers.alerts.triggers,
                        ALERTS_SUPPORTED_EVENTS,
                      ),
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
                        maximum: 50,
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
                  },
                ],
              },
            },
          },
        },
      },
      output: {
        type: 'object',
        title: 'Report output',
        description:
          'Where reports are published. Defaults are sensible; advanced fields are hidden from the form and editable in the plugin config file.',
        properties: {
          notificationState: {
            type: 'string',
            title: 'Default notification state',
            description:
              'Signal K notification state used when a report is published (alert subkinds override this).',
            enum: ['nominal', 'normal', 'alert', 'warn', 'alarm', 'emergency'],
            default: DEFAULT_OPTIONS.output.notificationState,
          },
          notificationPath: {
            type: 'string',
            title: 'Custom notification path',
            default: DEFAULT_OPTIONS.output.notificationPath,
          },
          logFilename: {
            type: 'string',
            title: 'Log filename',
            default: DEFAULT_OPTIONS.output.logFilename,
          },
        },
      },
    },
  };
}

function triggerUiSchema(supportedEvents: ReadonlyArray<string>): Record<string, unknown> {
  const eventsUi: Record<string, unknown> =
    supportedEvents.length === 0
      ? { 'ui:widget': 'hidden' }
      : {
          'ui:widget': 'checkboxes',
          'ui:options': { inline: false },
          'ui:enumNames': eventTitlesFor(supportedEvents),
        };

  return {
    'ui:order': ['cron', 'put', 'events'],
    cron: {
      'ui:order': ['enabled', 'pattern', 'timezone'],
      pattern: {
        'ui:help': CRON_HELP,
        'ui:autocomplete': 'off',
      },
      timezone: {
        // Hide by default. Empty = system timezone, which is the common case.
        'ui:widget': 'hidden',
      },
    },
    put: {
      'ui:order': ['enabled', 'path'],
      path: {
        // Hide by default. Defaults are sane; users rarely need to override.
        'ui:widget': 'hidden',
      },
    },
    events: eventsUi,
  };
}

export function buildUiSchema(): PluginUiSchema {
  return {
    openrouter: {
      'ui:order': ['apiKey', 'model', 'maxCallsPerDay', 'baseUrl', 'requestTimeoutMs'],
      apiKey: {
        'ui:widget': 'password',
        'ui:autocomplete': 'off',
      },
      model: {
        'ui:placeholder': 'anthropic/claude-haiku-4.5',
      },
      baseUrl: { 'ui:widget': 'hidden' },
      requestTimeoutMs: { 'ui:widget': 'hidden' },
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
          'engineStartRpmHzThreshold',
          'engineStartSettleSeconds',
          'minSessionSeconds',
          'extraWatchedPaths',
        ],
        triggers: triggerUiSchema(MAINTENANCE_SUPPORTED_EVENTS),
        extraWatchedPaths: {
          'ui:options': { orderable: false },
        },
      },
      health: {
        'ui:order': ['enabled', 'triggers'],
        triggers: triggerUiSchema(HEALTH_SUPPORTED_EVENTS),
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
        triggers: triggerUiSchema(ALERTS_SUPPORTED_EVENTS),
      },
    },
    output: {
      'ui:order': ['notificationState', 'notificationPath', 'logFilename'],
      notificationPath: { 'ui:widget': 'hidden' },
      logFilename: { 'ui:widget': 'hidden' },
    },
  };
}
