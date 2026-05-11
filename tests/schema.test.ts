import { describe, expect, it } from 'vitest';
import { buildSchema, buildUiSchema } from '../src/schema.js';
import { mergeWithDefaults } from '../src/types.js';

describe('schema', () => {
  it('declares apiKey as required string and other defaults', () => {
    const s = buildSchema();
    expect(s.type).toBe('object');
    expect(s.properties.openrouter.required).toContain('apiKey');
    expect(s.properties.openrouter.properties.model.default).toBe('anthropic/claude-haiku-4.5');
    expect(s.properties.openrouter.properties.maxCallsPerDay.default).toBe(20);
    expect(s.properties.questdb.properties.enabled.default).toBe(true);
    expect(
      s.properties.analyzers.properties.maintenance.properties.engineStopRpmHzThreshold.default,
    ).toBe(1.0);
    expect(s.properties.output.properties.notificationState.enum).toEqual(['normal', 'nominal']);
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
  });

  it('overrides only provided values', () => {
    const r = mergeWithDefaults({ openrouter: { apiKey: 'sk-x' } as never });
    expect(r.openrouter.apiKey).toBe('sk-x');
    expect(r.openrouter.model).toBe('anthropic/claude-haiku-4.5');
  });
});
