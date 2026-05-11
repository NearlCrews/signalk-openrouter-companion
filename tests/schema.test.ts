import { describe, expect, it } from 'vitest';
import { buildSchema, buildUiSchema } from '../src/schema.js';
import { mergeWithDefaults } from '../src/types.js';

describe('schema', () => {
  it('declares apiKey as required and notificationState as full ALARM_STATE enum', () => {
    const s = buildSchema();
    expect(s.type).toBe('object');
    expect(s.title).toBe('OpenRouter Companion');
    expect(typeof s.description).toBe('string');
    const openrouter = s.properties.openrouter as {
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    expect(openrouter.required).toContain('apiKey');
    const output = s.properties.output as { properties: Record<string, Record<string, unknown>> };
    expect(output.properties.notificationState.enum).toEqual([
      'nominal',
      'normal',
      'alert',
      'warn',
      'alarm',
      'emergency',
    ]);
  });

  it('exposes a triggers block on the maintenance analyzer', () => {
    const s = buildSchema();
    const analyzers = s.properties.analyzers as {
      properties: { maintenance: { properties: Record<string, Record<string, unknown>> } };
    };
    const triggers = analyzers.properties.maintenance.properties.triggers as {
      type: string;
      title: string;
      properties: {
        cron: { properties: Record<string, Record<string, unknown>> };
        put: { properties: Record<string, Record<string, unknown>> };
        events: {
          type: string;
          uniqueItems?: boolean;
          items: { enum?: string[] };
          default: string[];
        };
      };
    };
    expect(triggers.type).toBe('object');
    expect(triggers.title).toBe('When to run');
    expect(triggers.properties.cron.properties.enabled.default).toBe(false);
    expect(triggers.properties.cron.properties.pattern.default).toBe('');
    expect(triggers.properties.put.properties.enabled.default).toBe(true);
    expect(triggers.properties.put.properties.path.default).toBe(
      'plugins.openrouter-companion.maintenance.run',
    );
    expect(triggers.properties.events.type).toBe('array');
    expect(triggers.properties.events.uniqueItems).toBe(true);
    expect(triggers.properties.events.items.enum).toEqual(['engine-stop']);
    expect(triggers.properties.events.default).toEqual(['engine-stop']);
  });

  it('attaches cron pattern examples to every analyzer', () => {
    const s = buildSchema();
    const analyzers = s.properties.analyzers as {
      properties: Record<string, { properties: Record<string, Record<string, unknown>> }>;
    };
    for (const name of ['maintenance', 'health', 'alerts']) {
      const triggers = analyzers.properties[name].properties.triggers as {
        properties: { cron: { properties: { pattern: { examples?: string[] } } } };
      };
      const examples = triggers.properties.cron.properties.pattern.examples;
      expect(Array.isArray(examples)).toBe(true);
      expect(examples).toContain('0 8 * * *');
    }
  });

  it('uiSchema marks apiKey as password widget and hides advanced fields', () => {
    const u = buildUiSchema() as Record<string, Record<string, unknown>>;
    const openrouter = u.openrouter as Record<string, Record<string, unknown>>;
    expect(openrouter.apiKey['ui:widget']).toBe('password');
    expect(openrouter.baseUrl['ui:widget']).toBe('hidden');
    expect(openrouter.requestTimeoutMs['ui:widget']).toBe('hidden');
    const output = u.output as Record<string, Record<string, unknown>>;
    expect(output.notificationPath['ui:widget']).toBe('hidden');
    expect(output.logFilename['ui:widget']).toBe('hidden');
  });

  it('uiSchema renders events as checkboxes with humanized labels (or hides them)', () => {
    const u = buildUiSchema() as Record<string, unknown>;
    const analyzers = u.analyzers as Record<string, Record<string, Record<string, unknown>>>;

    const maintEvents = analyzers.maintenance.triggers.events as Record<string, unknown>;
    expect(maintEvents['ui:widget']).toBe('checkboxes');
    expect(maintEvents['ui:enumNames']).toEqual(['Engine session ended']);

    const alertsEvents = analyzers.alerts.triggers.events as Record<string, unknown>;
    expect(alertsEvents['ui:widget']).toBe('checkboxes');
    expect(alertsEvents['ui:enumNames']).toEqual([
      'Low SoC: bank entered low state',
      'Low SoC: bank recovered',
      'Cell imbalance detected',
      'Cell imbalance cleared',
    ]);

    // health has no supported events, so the events field is hidden entirely
    const healthEvents = analyzers.health.triggers.events as Record<string, unknown>;
    expect(healthEvents['ui:widget']).toBe('hidden');
  });

  it('uiSchema sets ui:order on every analyzer with enabled first', () => {
    const u = buildUiSchema() as Record<string, unknown>;
    const analyzers = u.analyzers as Record<string, Record<string, unknown>>;
    for (const name of ['maintenance', 'health', 'alerts']) {
      const order = analyzers[name]['ui:order'] as string[];
      expect(Array.isArray(order)).toBe(true);
      expect(order[0]).toBe('enabled');
      expect(order[1]).toBe('triggers');
    }
  });

  it('uiSchema hides put.path and cron.timezone on every analyzer', () => {
    const u = buildUiSchema() as Record<string, unknown>;
    const analyzers = u.analyzers as Record<string, Record<string, Record<string, unknown>>>;
    for (const name of ['maintenance', 'health', 'alerts']) {
      const triggers = analyzers[name].triggers as Record<string, Record<string, unknown>>;
      const cron = triggers.cron as Record<string, Record<string, unknown>>;
      const put = triggers.put as Record<string, Record<string, unknown>>;
      expect(cron.timezone['ui:widget']).toBe('hidden');
      expect(put.path['ui:widget']).toBe('hidden');
    }
  });
});

describe('mergeWithDefaults', () => {
  it('returns full defaults when input is undefined', () => {
    const r = mergeWithDefaults(undefined);
    expect(r.openrouter.apiKey).toBe('');
    expect(r.analyzers.maintenance.minSessionSeconds).toBe(60);
    expect(r.analyzers.maintenance.triggers.cron.enabled).toBe(false);
    expect(r.analyzers.maintenance.triggers.put.enabled).toBe(true);
    expect(r.analyzers.maintenance.triggers.events).toEqual(['engine-stop']);
  });

  it('overrides only provided values', () => {
    const r = mergeWithDefaults({ openrouter: { apiKey: 'sk-x' } as never });
    expect(r.openrouter.apiKey).toBe('sk-x');
    expect(r.openrouter.model).toBe('anthropic/claude-haiku-4.5');
  });

  it('deep-merges the triggers block', () => {
    const r = mergeWithDefaults({
      analyzers: {
        maintenance: {
          triggers: {
            cron: { enabled: true, pattern: '0 8 * * *' },
          },
        },
      },
    } as never);
    expect(r.analyzers.maintenance.triggers.cron.enabled).toBe(true);
    expect(r.analyzers.maintenance.triggers.cron.pattern).toBe('0 8 * * *');
    expect(r.analyzers.maintenance.triggers.cron.timezone).toBe('');
    expect(r.analyzers.maintenance.triggers.put.enabled).toBe(true);
    expect(r.analyzers.maintenance.triggers.put.path).toBe(
      'plugins.openrouter-companion.maintenance.run',
    );
    expect(r.analyzers.maintenance.triggers.events).toEqual(['engine-stop']);
  });

  it('preserves user-provided events and other fields', () => {
    const r = mergeWithDefaults({
      analyzers: {
        maintenance: {
          minSessionSeconds: 120,
          triggers: { events: [] },
        },
      },
    } as never);
    expect(r.analyzers.maintenance.minSessionSeconds).toBe(120);
    expect(r.analyzers.maintenance.triggers.events).toEqual([]);
  });
});
