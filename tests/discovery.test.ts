import { describe, expect, it } from 'vitest';
import {
  CELL_VOLT_PATH_RE,
  discoverBankIds,
  discoverEngineIds,
  discoverWatchedPaths,
  SOC_PATH_RE,
} from '../src/core/discovery.js';

describe('discoverEngineIds', () => {
  it('discovers an engine from its revolutions path', () => {
    expect(discoverEngineIds(['propulsion.port.revolutions'])).toEqual(['port']);
  });

  it('discovers an engine from aux fields when revolutions is absent', () => {
    // An older N2K engine emits only coolantTemperature / oilPressure / fuel
    // fragments, no revolutions; it must still be discovered.
    expect(
      discoverEngineIds([
        'propulsion.starboard.coolantTemperature',
        'propulsion.starboard.oilPressure',
        'propulsion.starboard.fuel.rate',
      ]),
    ).toEqual(['starboard']);
  });

  it('de-duplicates, sorts, and ignores non-engine paths', () => {
    expect(
      discoverEngineIds([
        'propulsion.port.revolutions',
        'propulsion.port.coolantTemperature',
        'propulsion.aux.runTime',
        'electrical.batteries.house.voltage',
      ]),
    ).toEqual(['aux', 'port']);
  });

  it('accepts any iterable, not just an array', () => {
    expect(discoverEngineIds(new Set(['propulsion.port.revolutions']))).toEqual(['port']);
  });
});

describe('discoverBankIds', () => {
  it('discovers banks under electrical.batteries, sorted and unique', () => {
    expect(
      discoverBankIds([
        'electrical.batteries.house.voltage',
        'electrical.batteries.house.current',
        'electrical.batteries.starter.capacity.stateOfCharge',
        'propulsion.port.revolutions',
      ]),
    ).toEqual(['house', 'starter']);
  });
});

describe('discoverWatchedPaths', () => {
  it('keeps watch-prefix paths plus the supplied extras, sorted and unique', () => {
    const out = discoverWatchedPaths(
      ['propulsion.port.revolutions', 'electrical.batteries.house.voltage', 'navigation.position'],
      ['environment.outside.temperature'],
    );
    expect(out).toEqual([
      'electrical.batteries.house.voltage',
      'environment.outside.temperature',
      'propulsion.port.revolutions',
    ]);
    expect(out).not.toContain('navigation.position');
  });
});

describe('CELL_VOLT_PATH_RE', () => {
  it('matches both the flat cellN and nested cells.N voltage forms', () => {
    const flat = 'electrical.batteries.house.cell3.voltage'.match(CELL_VOLT_PATH_RE);
    expect(flat?.[1]).toBe('house');
    expect(flat?.[2]).toBe('3');
    const nested = 'electrical.batteries.house.cells.12.voltage'.match(CELL_VOLT_PATH_RE);
    expect(nested?.[1]).toBe('house');
    expect(nested?.[2]).toBe('12');
  });

  it('does not match a non-cell battery path', () => {
    expect('electrical.batteries.house.voltage'.match(CELL_VOLT_PATH_RE)).toBeNull();
  });
});

describe('SOC_PATH_RE', () => {
  it('captures the bank id from a stateOfCharge path', () => {
    const m = 'electrical.batteries.starter.capacity.stateOfCharge'.match(SOC_PATH_RE);
    expect(m?.[1]).toBe('starter');
  });
});
