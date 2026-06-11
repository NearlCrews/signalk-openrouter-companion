import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEVERITY_FLOOR_VALUE,
  isSeverityFloor,
  SEVERITY_FLOOR_PRESETS,
} from '../src/severityFloors.js';

describe('isSeverityFloor', () => {
  it('accepts every preset value', () => {
    for (const preset of SEVERITY_FLOOR_PRESETS) {
      expect(isSeverityFloor(preset.value)).toBe(true);
    }
  });

  it('accepts the default floor value', () => {
    expect(isSeverityFloor(DEFAULT_SEVERITY_FLOOR_VALUE)).toBe(true);
  });

  it('rejects strings that are not preset values', () => {
    // 'none' is a forecast grade but not a settable floor; 'major' is off the
    // scale entirely. Both must be rejected so a renamed or stray value cannot
    // pass as a floor.
    for (const v of ['none', 'major', 'Severe', '', 'moderate ']) {
      expect(isSeverityFloor(v)).toBe(false);
    }
  });

  it('rejects non-string values', () => {
    for (const v of [undefined, null, 0, 1, true, {}, [], { value: 'severe' }]) {
      expect(isSeverityFloor(v)).toBe(false);
    }
  });
});
