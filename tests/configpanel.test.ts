import { describe, expect, it } from 'vitest';
import { fireOutcomeText, isFireSuccess } from '../src/configpanel/fireOutcome.js';
import { humanizeAgo } from '../src/configpanel/recency.js';
import { buildScheduleOptions } from '../src/configpanel/scheduleOptions.js';
import { clamp, jsonEqual } from '../src/configpanel/utils.js';
import { CRON_PRESETS } from '../src/cronPresets.js';

describe('jsonEqual', () => {
  it('treats key order as insignificant', () => {
    expect(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('ignores explicit-undefined keys to match JSON.stringify semantics', () => {
    // onPromptReset writes { customSystemPrompt: undefined } into the edit
    // buffer; the deserialized pristine config simply lacks the key. The dirty
    // check must treat the two as equal so a reset-to-default does not read as
    // a pending edit.
    expect(jsonEqual({ a: 1, customSystemPrompt: undefined }, { a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 1, customSystemPrompt: undefined })).toBe(true);
  });

  it('compares nested objects and arrays structurally', () => {
    expect(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(jsonEqual({ a: [1, 2] }, { a: [1, 3] })).toBe(false);
    expect(jsonEqual({ a: [1, 2] }, { a: [1, 2, 3] })).toBe(false);
  });

  it('distinguishes an array from an object', () => {
    expect(jsonEqual([], {})).toBe(false);
  });

  it('treats null and undefined and missing as equal at the top level', () => {
    expect(jsonEqual(null, undefined)).toBe(true);
    expect(jsonEqual(undefined, {})).toBe(false);
  });

  it('flags a changed scalar', () => {
    expect(jsonEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonEqual('x', 'y')).toBe(false);
  });

  it('flags an extra defined key on either side', () => {
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  it('treats differently named explicit-undefined keys as equal', () => {
    // Both sides have exactly one defined key (a), so the undefined-valued
    // keys must not count toward the defined-key totals on either side.
    expect(jsonEqual({ a: 1, b: undefined }, { a: 1, c: undefined })).toBe(true);
    expect(jsonEqual({ a: 1, b: undefined }, { a: 1, b: 2 })).toBe(false);
  });

  it('ignores explicit-undefined keys in nested objects too', () => {
    expect(jsonEqual({ x: { a: 1, b: undefined } }, { x: { a: 1 } })).toBe(true);
    expect(jsonEqual({ x: { a: 1 } }, { x: { a: 1, b: undefined } })).toBe(true);
  });
});

describe('clamp', () => {
  it('bounds below the minimum', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });
  it('bounds above the maximum', () => {
    expect(clamp(42, 0, 10)).toBe(10);
  });
  it('passes a value already in range', () => {
    expect(clamp(7, 0, 10)).toBe(7);
  });
  it('returns the shared bound when min equals max', () => {
    expect(clamp(7, 3, 3)).toBe(3);
  });
});

describe('fire outcome mapping', () => {
  it('falls back to "Dispatched" for an unmapped or missing outcome', () => {
    expect(fireOutcomeText(undefined)).toBe('Dispatched');
    expect(fireOutcomeText('brand-new-outcome')).toBe('Dispatched');
    expect(fireOutcomeText('reported')).toBe('Report generated');
  });

  it('reads only failed and unknown as a failure', () => {
    expect(isFireSuccess('reported')).toBe(true);
    expect(isFireSuccess('no-input')).toBe(true);
    expect(isFireSuccess('budget-exhausted')).toBe(true);
    expect(isFireSuccess(undefined)).toBe(true);
    expect(isFireSuccess('failed')).toBe(false);
    expect(isFireSuccess('unknown')).toBe(false);
  });
});

describe('humanizeAgo', () => {
  it('returns "unknown" for a missing, non-finite, or negative age', () => {
    expect(humanizeAgo(undefined)).toBe('unknown');
    expect(humanizeAgo(Number.NaN)).toBe('unknown');
    expect(humanizeAgo(Number.POSITIVE_INFINITY)).toBe('unknown');
    expect(humanizeAgo(-1)).toBe('unknown');
  });

  it('formats seconds, minutes, hours, and days', () => {
    expect(humanizeAgo(0)).toBe('0s ago');
    expect(humanizeAgo(8_000)).toBe('8s ago');
    expect(humanizeAgo(59_000)).toBe('59s ago');
    expect(humanizeAgo(60_000)).toBe('1m ago');
    expect(humanizeAgo(59 * 60_000)).toBe('59m ago');
    expect(humanizeAgo(60 * 60_000)).toBe('1h ago');
    expect(humanizeAgo(23 * 60 * 60_000)).toBe('23h ago');
    expect(humanizeAgo(24 * 60 * 60_000)).toBe('1d ago');
  });
});

describe('buildScheduleOptions', () => {
  it('prepends a "Not set" entry when no pattern is selected', () => {
    const opts = buildScheduleOptions('');
    expect(opts[0]).toEqual({ value: '', label: 'Not set' });
    expect(opts.slice(1)).toEqual([...CRON_PRESETS]);
  });

  it('returns the shared preset list for a preset pattern', () => {
    const preset = CRON_PRESETS[0];
    if (!preset) throw new Error('CRON_PRESETS is empty');
    const opts = buildScheduleOptions(preset.value);
    // Identity, not just equality: the preset case must not copy the shared
    // list on every render.
    expect(opts).toBe(CRON_PRESETS);
    expect(opts.some((o) => o.label.startsWith('Custom:'))).toBe(false);
  });

  it('appends a "Custom" entry for a saved non-preset pattern so the value stays in range', () => {
    const custom = '15 3 */2 * *';
    expect(CRON_PRESETS.some((o) => o.value === custom)).toBe(false);
    const opts = buildScheduleOptions(custom);
    expect(opts[opts.length - 1]).toEqual({ value: custom, label: `Custom: ${custom}` });
    expect(opts.some((o) => o.value === custom)).toBe(true);
  });
});
