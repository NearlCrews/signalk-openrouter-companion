import { describe, expect, it } from 'vitest';
import {
  buildSchema,
  buildUiSchema,
  type EnabledGatedNode,
  type TriggerSchemaNode,
} from '../src/schema.js';
import { mergeWithDefaults } from '../src/types.js';

/**
 * Walks into the enabled-true branch of a `dependencies.enabled.oneOf` block.
 * Locates the branch by predicate rather than by index so the test still
 * targets the right branch if the order of the two oneOf entries ever flips.
 */
function enabledTrueBranch(node: EnabledGatedNode | Record<string, unknown>): {
  properties: Record<string, Record<string, unknown>>;
} {
  const deps = (node as EnabledGatedNode).dependencies;
  const branch = deps.enabled.oneOf.find(
    (b) => (b.properties.enabled as { const: boolean }).const === true,
  );
  if (!branch) throw new Error('enabled-true branch not found');
  return branch as { properties: Record<string, Record<string, unknown>> };
}

describe('schema', () => {
  it('declares apiKey as required and exposes no output config (the dead notificationPath/State knobs were removed in the notification-PGN-alignment pass)', () => {
    const s = buildSchema();
    expect(s.type).toBe('object');
    expect(s.title).toBe('OpenRouter Companion');
    expect(typeof s.description).toBe('string');
    const openrouter = s.properties.openrouter as {
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    expect(openrouter.required).toEqual(['apiKey']);
    // output/* schema is gone now: every analyzer owns its own publish path
    // and state via publishOutput.
    expect(s.properties.output).toBeUndefined();
  });

  it('hides analyzer detail fields behind a dependencies.enabled gate', () => {
    const s = buildSchema();
    const analyzers = s.properties.analyzers as {
      properties: { maintenance: EnabledGatedNode };
    };
    const maintenance = analyzers.properties.maintenance;
    expect(maintenance.dependencies).toBeDefined();
    expect(Array.isArray(maintenance.dependencies.enabled.oneOf)).toBe(true);
    expect(maintenance.dependencies.enabled.oneOf).toHaveLength(2);

    const onBranch = enabledTrueBranch(maintenance);
    expect(onBranch.properties.triggers).toBeDefined();
    expect(onBranch.properties.engineStopRpmHzThreshold).toBeDefined();
    expect(onBranch.properties.extraWatchedPaths).toBeDefined();
  });

  it('hides health + alerts detail fields behind a dependencies.enabled gate', () => {
    const s = buildSchema();
    const analyzers = s.properties.analyzers as {
      properties: { health: EnabledGatedNode; alerts: EnabledGatedNode };
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
    const questdb = s.properties.questdb as unknown as EnabledGatedNode;
    const onBranch = enabledTrueBranch(questdb);
    expect(onBranch.properties.url).toBeDefined();
  });

  it('exposes a triggers block on the maintenance analyzer (enabled-true branch)', () => {
    const s = buildSchema();
    const analyzers = s.properties.analyzers as {
      properties: { maintenance: EnabledGatedNode };
    };
    const onBranch = enabledTrueBranch(analyzers.properties.maintenance);
    const triggers = onBranch.properties.triggers as unknown as TriggerSchemaNode;
    expect(triggers.type).toBe('object');
    expect(triggers.title).toBe('When to run');

    const cronProps = triggers.properties.cron.properties;
    expect(cronProps.enabled.default).toBe(false);
    const cronOn = enabledTrueBranch(triggers.properties.cron);
    // pattern is now a plain enum-string schema; not gated by an `enabled`
    // sub-branch and not surfaced as a timezone field.
    expect((cronOn.properties.pattern as { type: unknown }).type).toBe('string');
    expect(cronOn.properties.timezone).toBeUndefined();

    const putProps = triggers.properties.put.properties;
    expect(putProps.enabled.default).toBe(true);
    // PUT path is no longer a separate input; it surfaces in the enabled
    // checkbox's description as a fixed-by-convention value.
    expect(putProps.enabled.description).toBe(
      'PUT path: plugins.openrouter-companion.maintenance.run',
    );

    const events = triggers.properties.events as NonNullable<
      TriggerSchemaNode['properties']['events']
    > & {
      items: { enum?: string[] };
      default: string[];
    };
    expect(events.type).toBe('array');
    expect(events.uniqueItems).toBe(true);
    expect(events.items.enum).toEqual(['engine-stop']);
    expect(events.default).toEqual(['engine-stop']);
  });

  it('exposes the liveness analyzer with a staleness threshold field', () => {
    const s = buildSchema();
    const analyzers = s.properties.analyzers as {
      properties: Record<string, EnabledGatedNode>;
    };
    expect(analyzers.properties.liveness).toBeDefined();
    const onBranch = enabledTrueBranch(analyzers.properties.liveness);
    expect(onBranch.properties.triggers).toBeDefined();
    expect(onBranch.properties.stalenessThresholdSec).toBeDefined();
  });

  it('renders cron.pattern as a clean enum + enumNames dropdown', () => {
    const s = buildSchema();
    const analyzers = s.properties.analyzers as {
      properties: Record<string, EnabledGatedNode>;
    };
    for (const name of ['maintenance', 'health', 'alerts']) {
      const onBranch = enabledTrueBranch(analyzers.properties[name]);
      const triggers = onBranch.properties.triggers as unknown as TriggerSchemaNode;
      const cronOn = enabledTrueBranch(triggers.properties.cron);
      const pattern = cronOn.properties.pattern as {
        type: string;
        enum: string[];
        enumNames: string[];
        default: string;
      };
      // anyOf was producing a doubled control in the SK admin UI because the
      // freeform branch (`{ type: 'string' }` with no `const`) caused rjsf to
      // fall back to rendering BOTH the underlying StringField input AND the
      // AnyOfField selector. enum + enumNames produces a single clean select.
      expect(pattern.type).toBe('string');
      expect(Array.isArray(pattern.enum)).toBe(true);
      expect(pattern.enum.length).toBeGreaterThanOrEqual(7);
      expect(pattern.enum).toEqual(expect.arrayContaining(['0 8 * * *', '0 12 * * *']));
      expect(pattern.enumNames.length).toBe(pattern.enum.length);
      expect(pattern.enumNames[0]).toBe('8:00 AM daily');
      // No `anyOf`: that's the whole point of this refactor.
      expect((cronOn.properties.pattern as { anyOf?: unknown }).anyOf).toBeUndefined();
    }
  });

  it('keeps a preset cron default in the enum without widening', () => {
    // Health analyzer ships with '0 8 * * *' which IS a preset, so the enum
    // is the unmodified preset list and no 'Custom:' entry is added.
    const s = buildSchema();
    const health = s.properties.analyzers as { properties: { health: EnabledGatedNode } };
    const healthOn = enabledTrueBranch(health.properties.health);
    const healthTriggers = healthOn.properties.triggers as unknown as TriggerSchemaNode;
    const healthCronOn = enabledTrueBranch(healthTriggers.properties.cron);
    const healthPattern = healthCronOn.properties.pattern as {
      enum: string[];
      enumNames: string[];
      default: string;
    };
    expect(healthPattern.default).toBe('0 8 * * *');
    expect(healthPattern.enum).toContain('0 8 * * *');
    expect(healthPattern.enumNames.length).toBe(healthPattern.enum.length);
    expect(healthPattern.enumNames.some((n) => n.startsWith('Custom:'))).toBe(false);
  });

  it('widens the cron enum to include a non-preset analyzer default pattern', () => {
    // Forecast analyzer ships with '0 */3 * * *' which is NOT a preset, so
    // cronPatternSchema appends it with a 'Custom:' label.
    const s = buildSchema();
    const analyzers = s.properties.analyzers as {
      properties: Record<string, EnabledGatedNode>;
    };
    const onBranch = enabledTrueBranch(analyzers.properties.forecast);
    const triggers = onBranch.properties.triggers as unknown as TriggerSchemaNode;
    const cronOn = enabledTrueBranch(triggers.properties.cron);
    const pattern = cronOn.properties.pattern as {
      enum: string[];
      enumNames: string[];
      default: string;
    };
    expect(pattern.default).toBe('0 */3 * * *');
    expect(pattern.enum).toContain('0 */3 * * *');
    expect(pattern.enumNames[pattern.enum.indexOf('0 */3 * * *')]).toBe('Custom: 0 */3 * * *');
    expect(pattern.enumNames.length).toBe(pattern.enum.length);
  });

  it('exposes the forecast analyzer with a severity-floor enum dropdown', () => {
    const s = buildSchema();
    const analyzers = s.properties.analyzers as {
      properties: Record<string, EnabledGatedNode>;
    };
    expect(analyzers.properties.forecast).toBeDefined();
    const onBranch = enabledTrueBranch(analyzers.properties.forecast);
    expect(onBranch.properties.triggers).toBeDefined();
    const severityFloor = onBranch.properties.severityFloor as {
      type: string;
      enum: string[];
      enumNames: string[];
      default: string;
    };
    expect(severityFloor.type).toBe('string');
    expect(severityFloor.enum).toEqual(['severe', 'moderate', 'minor']);
    expect(severityFloor.enumNames).toEqual([
      'Severe only',
      'Moderate and up',
      'Any deterioration',
    ]);
    expect(severityFloor.default).toBe('moderate');
  });

  it('uiSchema marks apiKey as password and drops the advanced-fields list entirely', () => {
    const u = buildUiSchema() as Record<string, Record<string, unknown>>;
    const openrouter = u.openrouter as Record<string, Record<string, unknown>>;
    expect(openrouter.apiKey['ui:widget']).toBe('password');
    // Advanced openrouter fields (baseUrl, requestTimeoutMs) are now dropped
    // from the schema entirely rather than hidden via ui:widget, because
    // 'hidden' does not fully hide a field in the SK admin UI (the custom
    // FieldTemplate ignores rjsf's `hidden` prop and still renders the label
    // and wrapper). mergeWithDefaults fills in the runtime values.
    expect(openrouter.baseUrl).toBeUndefined();
    expect(openrouter.requestTimeoutMs).toBeUndefined();
    // The output/* uiSchema block is gone alongside its schema counterpart.
    expect(u.output).toBeUndefined();
  });

  it('uiSchema renders events as checkboxes with humanized labels, omitting events for analyzers without any', () => {
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

    // health has no supported events: the events field is omitted from the
    // schema entirely so there is no uiSchema entry for it either.
    expect(analyzers.health.triggers.events).toBeUndefined();
  });

  it('schema omits the events field for analyzers with no supported events', () => {
    const s = buildSchema();
    const analyzers = s.properties.analyzers as {
      properties: { health: EnabledGatedNode };
    };
    const healthOn = enabledTrueBranch(analyzers.properties.health);
    const healthTriggers = healthOn.properties.triggers as unknown as TriggerSchemaNode;
    expect(healthTriggers.properties.events).toBeUndefined();
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

  it('merges the forecast analyzer including its severityFloor', () => {
    const r = mergeWithDefaults(undefined);
    expect(r.analyzers.forecast.enabled).toBe(false);
    expect(r.analyzers.forecast.severityFloor).toBe('moderate');
    expect(r.analyzers.forecast.triggers.cron.pattern).toBe('0 */3 * * *');

    const overridden = mergeWithDefaults({
      analyzers: { forecast: { severityFloor: 'severe' } },
    } as never);
    expect(overridden.analyzers.forecast.severityFloor).toBe('severe');
    // Untouched trigger fields fall back to defaults.
    expect(overridden.analyzers.forecast.triggers.cron.enabled).toBe(true);
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
