import { describe, expect, it } from 'vitest';
import {
  clampMin,
  clampPositiveInt,
  clampRange,
  finiteOr,
  resolveSystemPrompt,
} from '../src/core/cfg.js';

describe('clampPositiveInt', () => {
  it('truncates a finite value to an integer', () => {
    expect(clampPositiveInt(5.9, 1)).toBe(5);
  });

  it('falls back for non-finite or sub-1 input', () => {
    expect(clampPositiveInt(Number.NaN, 7)).toBe(7);
    expect(clampPositiveInt(0, 7)).toBe(7);
    expect(clampPositiveInt(-3, 7)).toBe(7);
    expect(clampPositiveInt(Number.POSITIVE_INFINITY, 7)).toBe(7);
  });

  it('clamps into the supplied min/max range', () => {
    expect(clampPositiveInt(2, 10, { min: 7, max: 365 })).toBe(7);
    expect(clampPositiveInt(9999, 10, { min: 7, max: 365 })).toBe(365);
    expect(clampPositiveInt(30, 10, { min: 7, max: 365 })).toBe(30);
  });
});

describe('resolveSystemPrompt', () => {
  it('uses a non-empty custom prompt, trimmed', () => {
    expect(resolveSystemPrompt('  custom  ', 'default')).toBe('custom');
  });

  it('falls back to the default for undefined or whitespace-only custom', () => {
    expect(resolveSystemPrompt(undefined, 'default')).toBe('default');
    expect(resolveSystemPrompt('', 'default')).toBe('default');
    expect(resolveSystemPrompt('   ', 'default')).toBe('default');
  });
});

describe('clampMin', () => {
  it('keeps a finite value at or above min, else falls back', () => {
    expect(clampMin(5, 1, 99)).toBe(5);
    expect(clampMin(1, 1, 99)).toBe(1);
    expect(clampMin(0.5, 1, 99)).toBe(99);
    expect(clampMin('x', 1, 99)).toBe(99);
    expect(clampMin(Number.NaN, 1, 99)).toBe(99);
  });

  it('keeps a fractional value (unlike clampPositiveInt)', () => {
    expect(clampMin(2.5, 1, 99)).toBe(2.5);
  });
});

describe('clampRange', () => {
  it('keeps a finite value within [min, max], else falls back', () => {
    expect(clampRange(50, 0, 100, 30)).toBe(50);
    expect(clampRange(-1, 0, 100, 30)).toBe(30);
    expect(clampRange(101, 0, 100, 30)).toBe(30);
    expect(clampRange('x', 0, 100, 30)).toBe(30);
  });
});

describe('finiteOr', () => {
  it('keeps any finite number, including zero and negatives', () => {
    expect(finiteOr(-7.5, 0)).toBe(-7.5);
    expect(finiteOr(0, 5)).toBe(0);
  });

  it('falls back for non-finite or non-number input', () => {
    expect(finiteOr(Number.POSITIVE_INFINITY, 5)).toBe(5);
    expect(finiteOr(Number.NaN, 5)).toBe(5);
    expect(finiteOr(null, 5)).toBe(5);
    expect(finiteOr('x', 5)).toBe(5);
  });
});
