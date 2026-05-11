import { describe, expect, it } from 'vitest';
import { buildSchema, buildUiSchema } from '../src/schema.js';
import { mergeWithDefaults } from '../src/types.js';

/**
 * Walks into the enabled-true branch of a `dependencies.enabled.oneOf` block.
 * Branches are ordered [enabled=false, enabled=true]; index 1 is the populated branch.
 */
function enabledTrueBranch(node: Record<string, unknown>): {
  properties: Record<string, Record<string, unknown>>;
} {
  const deps = node.dependencies as {
    enabled: { oneOf: Array<{ properties: Record<string, Record<string, unknown>> }> };
  };
  return deps.enabled.oneOf[1] as { properties: Record<string, Record<string, unknown>> };
}

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

  it('hides analyzer detail fields behind a dependencies.enabled gate', () => {
    const s = buildSchema();
    const analyzers = s.properties.analyzers as {
      properties: { maintenance: Record<string, unknown> };
    };
    const maintenance = analyzers.properties.maintenance;
    // The dependencies block exists with the oneOf-on-enabled shape.
    expect(maintenance.dependencies).toBeDefined();
    const deps = maintenance.dependencies as { enabled: { oneOf: unknown[] } };
    expect(Array.isArray(deps.enabled.oneOf)).toBe(true);
    expect(deps.enabled.oneOf).toHaveLength(2);

    // The enabled-true branch reveals triggers + threshold fields.
    const onBranch = enabledTrueBranch(maintenance);
    expect(onBranch.properties.triggers).toBeDefined();
    expect(onBranch.properties.engineStopRpmHzThreshold).toBeDefined();
    expect(onBranch.properties.extraWatchedPaths).toBeDefined();
  });

  it('hides health + alerts detail fields behind a dependencies.enabled gate', () => {
    const s = buildSchema();
    const analyzers = s.properties.analyzers as {
      properties: { health: Record<string, unknown>; alerts: Record<string, unknown> };
    };

    const healthOn = enabledTrueBranch(analyzers.properties.health);
    expect(healthOn.properties.triggers).toBeDefined();

    const alertsOn = enabledTrueBranch(analyzers.properties.alerts);
    expect(alertsOn.properties.triggers).toBeDefined();
    expect(alertsOn.properties.lowSocPercent).toBeDefined();
    expect(alertsOn.properties.cellImbalanceV).toBeDefined();
  });

  it('hides questdb.url behind a dependencies.enabled gate', () => {
    const s = buildSchema();
    const questdb = s.properties.questdb;
    const onBranch = enabledTrueBranch(questdb);
    expect(onBranch.properties.url).toBeDefined();
  });

  it('exposes a triggers block on the maintenance analyzer (enabled-true branch)', () => {
    const s = buildSchema();
    const analyzers = s.properties.analyzers as {
      properties: { maintenance: Record<string, unknown> };
    };
    const onBranch = enabledTrueBranch(analyzers.properties.maintenance);
    const triggers = onBranch.properties.triggers as {
      type: string;
      title: string;
      properties: {
        cron: Record<string, unknown>;
        put: Record<string, unknown>;
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

    // cron.enabled is at the top level; pattern + timezone only appear when enabled=true.
    const cronProps = (triggers.properties.cron as { properties: Record<string, unknown> })
      .properties;
    expect((cronProps.enabled as { default: unknown }).default).toBe(false);
    const cronOn = enabledTrueBranch(triggers.properties.cron);
    expect((cronOn.properties.pattern as { default: unknown }).default).toBe('');
    expect((cronOn.properties.timezone as { default: unknown }).default).toBe('');

    // put.enabled is at top level; path only appears when enabled=true.
    const putProps = (triggers.properties.put as { properties: Record<string, unknown> })
      .properties;
    expect((putProps.enabled as { default: unknown }).default).toBe(true);
    const putOn = enabledTrueBranch(triggers.properties.put);
    expect((putOn.properties.path as { default: unknown }).default).toBe(
      'plugins.openrouter-companion.maintenance.run',
    );

    expect(triggers.properties.events.type).toBe('array');
    expect(triggers.properties.events.uniqueItems).toBe(true);
    expect(triggers.properties.events.items.enum).toEqual(['engine-stop']);
    expect(triggers.properties.events.default).toEqual(['engine-stop']);
  });

  it('renders cron.pattern as a oneOf preset dropdown with a freeform fallback', () => {
    const s = buildSchema();
    const analyzers = s.properties.analyzers as {
      properties: Record<string, Record<string, unknown>>;
    };
    for (const name of ['maintenance', 'health', 'alerts']) {
      const onBranch = enabledTrueBranch(analyzers.properties[name]);
      const triggers = onBranch.properties.triggers as {
        properties: { cron: Record<string, unknown> };
      };
      const cronOn = enabledTrueBranch(triggers.properties.cron);
      const pattern = cronOn.properties.pattern as {
        oneOf: Array<{ type: string; title: string; const?: string }>;
      };
      expect(Array.isArray(pattern.oneOf)).toBe(true);
      expect(pattern.oneOf).toHaveLength(8);
      // First entry is the 8:00 AM preset.
      expect(pattern.oneOf[0].const).toBe('0 8 * * *');
      expect(pattern.oneOf[0].title).toBe('8:00 AM daily');
      // Last entry is the freeform fallback: no const so any string passes.
      const freeform = pattern.oneOf[pattern.oneOf.length - 1];
      expect(freeform.const).toBeUndefined();
      expect(freeform.title).toMatch(/Other/);
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
