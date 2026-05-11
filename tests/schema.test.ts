import { describe, expect, it } from 'vitest';
import { buildSchema, buildUiSchema } from '../src/schema.js';
import { mergeWithDefaults } from '../src/types.js';

describe('schema', () => {
  it('declares apiKey as required string and other defaults', () => {
    const s = buildSchema();
    expect(s.type).toBe('object');
    const openrouter = s.properties.openrouter as {
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    expect(openrouter.required).toContain('apiKey');
    expect(openrouter.properties.model.default).toBe('anthropic/claude-haiku-4.5');
    expect(openrouter.properties.maxCallsPerDay.default).toBe(20);
    const questdb = s.properties.questdb as { properties: Record<string, Record<string, unknown>> };
    expect(questdb.properties.enabled.default).toBe(true);
    const analyzers = s.properties.analyzers as {
      properties: { maintenance: { properties: Record<string, Record<string, unknown>> } };
    };
    expect(analyzers.properties.maintenance.properties.engineStopRpmHzThreshold.default).toBe(1.0);
    const output = s.properties.output as { properties: Record<string, Record<string, unknown>> };
    expect(output.properties.notificationState.enum).toEqual(['normal', 'nominal']);
  });

  it('exposes a triggers block on the maintenance analyzer', () => {
    const s = buildSchema();
    const analyzers = s.properties.analyzers as {
      properties: { maintenance: { properties: Record<string, Record<string, unknown>> } };
    };
    const triggers = analyzers.properties.maintenance.properties.triggers as {
      type: string;
      properties: {
        cron: { properties: Record<string, Record<string, unknown>> };
        put: { properties: Record<string, Record<string, unknown>> };
        events: { type: string; items: { enum?: string[] }; default: string[] };
      };
    };
    expect(triggers.type).toBe('object');
    expect(triggers.properties.cron.properties.enabled.default).toBe(false);
    expect(triggers.properties.cron.properties.pattern.default).toBe('');
    expect(triggers.properties.put.properties.enabled.default).toBe(true);
    expect(triggers.properties.put.properties.path.default).toBe(
      'plugins.openrouter-companion.maintenance.run',
    );
    expect(triggers.properties.events.type).toBe('array');
    expect(triggers.properties.events.items.enum).toEqual(['engine-stop']);
    expect(triggers.properties.events.default).toEqual(['engine-stop']);
  });

  it('uiSchema marks apiKey as password widget', () => {
    const u = buildUiSchema();
    expect(u.openrouter.apiKey['ui:widget']).toBe('password');
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
