import { formatRelativeAge } from 'signalk-nearlcrews-ui';
import { describe, expect, it } from 'vitest';
import { fireOutcomeText, isFireSuccess } from '../src/configpanel/fireOutcome.js';
import { RELATIVE_AGE_FORMAT } from '../src/configpanel/relativeAge.js';
import { buildScheduleOptions } from '../src/configpanel/scheduleOptions.js';
import { historyValidity, isHttpUrl, jsonEqual } from '../src/configpanel/utils.js';
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

describe('historyValidity', () => {
  it('defaults an unset source to QuestDB and reports the missing URL', () => {
    expect(historyValidity(undefined)).toEqual({
      source: 'questdb',
      noUrl: true,
      invalidUrl: false,
      missingDatabase: false,
    });
  });

  it('reports nothing wrong while history is disabled', () => {
    expect(historyValidity({ source: 'none' })).toEqual({
      source: 'none',
      noUrl: false,
      invalidUrl: false,
      missingDatabase: false,
    });
  });

  it('separates an empty URL from an unusable one', () => {
    expect(historyValidity({ source: 'questdb', questdb: { url: '   ' } })).toMatchObject({
      noUrl: true,
      invalidUrl: false,
    });
    expect(
      historyValidity({ source: 'questdb', questdb: { url: 'ftp://questdb.local' } }),
    ).toMatchObject({ noUrl: false, invalidUrl: true });
  });

  it('reads the URL of the selected provider and requires an InfluxDB database', () => {
    expect(
      historyValidity({
        source: 'influxdb',
        questdb: { url: 'http://localhost:9000' },
        influxdb: { url: 'http://influx.local:8086' },
      }),
    ).toEqual({
      source: 'influxdb',
      noUrl: false,
      invalidUrl: false,
      missingDatabase: true,
    });
    expect(
      historyValidity({
        source: 'influxdb',
        influxdb: { url: 'http://influx.local:8086', database: 'signalk' },
      }),
    ).toMatchObject({ missingDatabase: false });
  });
});

describe('isHttpUrl', () => {
  it.each(['http://localhost:9000', 'https://questdb.example.test/exec'])('accepts %s', (value) => {
    expect(isHttpUrl(value)).toBe(true);
  });

  it.each([
    undefined,
    '',
    'questdb.local:9000',
    'ftp://questdb.local',
    'not a url',
    'http://operator:secret@questdb.local:9000',
    'http://questdb.local:9000?token=secret',
    'http://questdb.local:9000#fragment',
  ])('rejects %s', (value) => {
    expect(isHttpUrl(value)).toBe(false);
  });
});

describe('shared status age formatting', () => {
  it('uses the shared UI relative-age contract', () => {
    expect(formatRelativeAge(0, { locale: 'en' })).toBe('0s ago');
    expect(formatRelativeAge(59_500, { locale: 'en' })).toBe('1m ago');
    expect(formatRelativeAge(undefined, { fallback: 'unknown' })).toBe('unknown');
  });

  it('renders the family format as words rather than a zero-second stamp', () => {
    // The library default is numeric-always and narrow. RELATIVE_AGE_FORMAT is
    // what the panel actually passes, so pin what an operator reads.
    expect(formatRelativeAge(0, { ...RELATIVE_AGE_FORMAT, locale: 'en' })).toBe('now');
    expect(formatRelativeAge(59_500, { ...RELATIVE_AGE_FORMAT, locale: 'en' })).toBe(
      '1 minute ago',
    );
    expect(formatRelativeAge(7_200_000, { ...RELATIVE_AGE_FORMAT, locale: 'en' })).toBe(
      '2 hours ago',
    );
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
