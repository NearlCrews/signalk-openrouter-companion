import { type AnalyzerTriggerCfg, DEFAULT_OPTIONS, MAINTENANCE_SUPPORTED_EVENTS } from './types.js';

function triggerSchema(
  defaults: AnalyzerTriggerCfg,
  supportedEvents: ReadonlyArray<string>,
): Record<string, unknown> {
  return {
    type: 'object',
    title: 'Triggers',
    description:
      'How this analyzer is invoked. Cron and PUT triggers are universal across all plugins; event triggers depend on the analyzer.',
    properties: {
      cron: {
        type: 'object',
        title: 'Cron schedule',
        properties: {
          enabled: { type: 'boolean', title: 'Enabled', default: defaults.cron.enabled },
          pattern: {
            type: 'string',
            title: 'Cron pattern (5-field)',
            default: defaults.cron.pattern,
          },
          timezone: {
            type: 'string',
            title: 'Timezone (IANA, empty = system)',
            default: defaults.cron.timezone,
          },
        },
      },
      put: {
        type: 'object',
        title: 'On-demand PUT',
        properties: {
          enabled: { type: 'boolean', title: 'Enabled', default: defaults.put.enabled },
          path: {
            type: 'string',
            title: 'Signal K PUT path under vessels.self',
            default: defaults.put.path,
          },
        },
      },
      events: {
        type: 'array',
        title: 'Event subscriptions',
        description:
          supportedEvents.length === 0
            ? 'This analyzer does not subscribe to event triggers.'
            : 'Select which event subkinds invoke this analyzer.',
        items:
          supportedEvents.length === 0
            ? { type: 'string' }
            : { type: 'string', enum: supportedEvents as string[] },
        default: defaults.events,
      },
    },
  };
}

export function buildSchema(): {
  type: 'object';
  required: string[];
  properties: Record<string, Record<string, unknown>>;
} {
  return {
    type: 'object',
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
            description: 'OpenRouter model slug.',
            default: DEFAULT_OPTIONS.openrouter.model,
          },
          baseUrl: {
            type: 'string',
            title: 'Base URL',
            default: DEFAULT_OPTIONS.openrouter.baseUrl,
          },
          maxCallsPerDay: {
            type: 'integer',
            title: 'Max calls per day',
            description: 'Hard cap on OpenRouter calls per UTC day.',
            default: DEFAULT_OPTIONS.openrouter.maxCallsPerDay,
            minimum: 0,
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
        properties: {
          enabled: {
            type: 'boolean',
            title: 'Enable QuestDB enrichment',
            default: DEFAULT_OPTIONS.questdb.enabled,
          },
          url: { type: 'string', title: 'QuestDB REST URL', default: DEFAULT_OPTIONS.questdb.url },
        },
      },
      analyzers: {
        type: 'object',
        title: 'Analyzers',
        properties: {
          maintenance: {
            type: 'object',
            title: 'Maintenance Advisor',
            properties: {
              enabled: { type: 'boolean', default: DEFAULT_OPTIONS.analyzers.maintenance.enabled },
              triggers: triggerSchema(
                DEFAULT_OPTIONS.analyzers.maintenance.triggers,
                MAINTENANCE_SUPPORTED_EVENTS,
              ),
              engineStopRpmHzThreshold: {
                type: 'number',
                title: 'Engine-off RPM threshold (Hz, 1.0 = 60 RPM)',
                default: DEFAULT_OPTIONS.analyzers.maintenance.engineStopRpmHzThreshold,
              },
              engineStopSettleSeconds: {
                type: 'integer',
                default: DEFAULT_OPTIONS.analyzers.maintenance.engineStopSettleSeconds,
              },
              engineStartRpmHzThreshold: {
                type: 'number',
                title: 'Engine-on RPM threshold (Hz)',
                default: DEFAULT_OPTIONS.analyzers.maintenance.engineStartRpmHzThreshold,
              },
              engineStartSettleSeconds: {
                type: 'integer',
                default: DEFAULT_OPTIONS.analyzers.maintenance.engineStartSettleSeconds,
              },
              minSessionSeconds: {
                type: 'integer',
                title: 'Minimum session length (s)',
                default: DEFAULT_OPTIONS.analyzers.maintenance.minSessionSeconds,
              },
              extraWatchedPaths: {
                type: 'array',
                title: 'Extra paths to include in analysis',
                items: { type: 'string' },
                default: DEFAULT_OPTIONS.analyzers.maintenance.extraWatchedPaths,
              },
            },
          },
        },
      },
      output: {
        type: 'object',
        title: 'Report output',
        properties: {
          notificationPath: { type: 'string', default: DEFAULT_OPTIONS.output.notificationPath },
          notificationState: {
            type: 'string',
            enum: ['normal', 'nominal'],
            default: DEFAULT_OPTIONS.output.notificationState,
          },
          logFilename: { type: 'string', default: DEFAULT_OPTIONS.output.logFilename },
        },
      },
    },
  };
}

export function buildUiSchema(): { openrouter: { apiKey: { 'ui:widget': 'password' } } } {
  return { openrouter: { apiKey: { 'ui:widget': 'password' } } };
}
