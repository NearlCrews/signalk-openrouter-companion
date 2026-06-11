import { describe, expect, it } from 'vitest';
import {
  asTreeMap,
  isBankNode,
  readBankSnapshot,
  readNumberAt,
  readValueAt,
} from '../src/core/skNode.js';

const node = {
  voltage: { value: 12.6 },
  capacity: { stateOfCharge: { value: 0.85 } },
  name: { value: 'house' },
  broken: { value: Number.NaN },
  noValue: { meta: {} },
};

describe('readValueAt', () => {
  it('reads a leaf .value by dotted subpath', () => {
    expect(readValueAt(node, 'voltage')).toBe(12.6);
    expect(readValueAt(node, 'capacity.stateOfCharge')).toBe(0.85);
    expect(readValueAt(node, 'name')).toBe('house');
  });

  it('returns undefined for a missing path, a node with no value leaf, or a non-object root', () => {
    expect(readValueAt(node, 'missing')).toBeUndefined();
    expect(readValueAt(node, 'noValue')).toBeUndefined();
    expect(readValueAt(undefined, 'voltage')).toBeUndefined();
  });
});

describe('readNumberAt', () => {
  it('returns the value only when it is a finite number', () => {
    expect(readNumberAt(node, 'voltage')).toBe(12.6);
    expect(readNumberAt(node, 'name')).toBeNull();
    expect(readNumberAt(node, 'broken')).toBeNull();
    expect(readNumberAt(node, 'missing')).toBeNull();
  });
});

describe('asTreeMap', () => {
  it('passes an object through and rejects non-objects', () => {
    const obj = { a: 1 };
    expect(asTreeMap(obj)).toBe(obj);
    expect(asTreeMap(null)).toBeNull();
    expect(asTreeMap('x')).toBeNull();
    expect(asTreeMap(undefined)).toBeNull();
  });
});

describe('readBankSnapshot', () => {
  it('pulls the canonical numeric fields, leaving absent ones null', () => {
    const bank = {
      voltage: { value: 12.6 },
      current: { value: -4.2 },
      capacity: { stateOfCharge: { value: 0.8 }, nominal: { value: 3_600_000 } },
      cycles: { value: 12 },
      // temperature absent
    };
    expect(readBankSnapshot(bank)).toEqual({
      voltage: 12.6,
      current: -4.2,
      stateOfCharge: 0.8,
      nominalCapacityJ: 3_600_000,
      cycles: 12,
      temperatureK: null,
    });
  });
});

describe('isBankNode', () => {
  it('accepts a node carrying at least one bank field', () => {
    expect(isBankNode({ voltage: { value: 12 } })).toBe(true);
    expect(isBankNode({ capacity: {} })).toBe(true);
  });

  it('rejects a leaf with a value, a metadata-only blob, or a non-object', () => {
    expect(isBankNode({ value: 12 })).toBe(false);
    expect(isBankNode({ meta: {}, $source: 'x' })).toBe(false);
    expect(isBankNode(null)).toBe(false);
    expect(isBankNode('x')).toBe(false);
  });
});
