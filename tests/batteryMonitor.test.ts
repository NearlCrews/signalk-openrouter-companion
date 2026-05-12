import { describe, expect, it } from 'vitest';
import { type BatteryEvent, BatteryMonitor } from '../src/core/batteryMonitor.js';

function makeMonitor() {
  const events: BatteryEvent[] = [];
  const monitor = new BatteryMonitor({
    lowSocPercent: 30,
    socExitHysteresis: 5,
    cellImbalanceV: 0.1,
    imbalanceSettleSec: 60,
    sourceWindowMs: 5000,
  });
  monitor.on('low-soc-enter', (e) => events.push(e));
  monitor.on('low-soc-exit', (e) => events.push(e));
  monitor.on('cell-imbalance-enter', (e) => events.push(e));
  monitor.on('cell-imbalance-exit', (e) => events.push(e));
  return { monitor, events };
}

describe('BatteryMonitor low-soc', () => {
  it('emits low-soc-enter when SoC drops below threshold', () => {
    const { monitor, events } = makeMonitor();
    monitor.observeSoc('house', 'bms', 0.5, 1_000_000);
    expect(events).toEqual([]);
    monitor.observeSoc('house', 'bms', 0.25, 1_001_000);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('low-soc-enter');
    expect(events[0]?.bankId).toBe('house');
    expect(events[0]?.soc).toBe(0.25);
  });

  it('does not emit again on further drop while already low', () => {
    const { monitor, events } = makeMonitor();
    monitor.observeSoc('house', 'bms', 0.25, 1_000_000);
    monitor.observeSoc('house', 'bms', 0.2, 1_001_000);
    expect(events).toHaveLength(1);
  });

  it('emits low-soc-exit only when SoC rises above threshold + hysteresis', () => {
    const { monitor, events } = makeMonitor();
    monitor.observeSoc('house', 'bms', 0.25, 1_000_000);
    expect(events).toHaveLength(1);
    monitor.observeSoc('house', 'bms', 0.31, 1_001_000);
    expect(events).toHaveLength(1);
    monitor.observeSoc('house', 'bms', 0.36, 1_002_000);
    expect(events).toHaveLength(2);
    expect(events[1]?.kind).toBe('low-soc-exit');
    expect(events[1]?.soc).toBe(0.36);
  });

  it('aggregates SoC across sources (max wins)', () => {
    const { monitor, events } = makeMonitor();
    monitor.observeSoc('house', 'bms-a', 0.5, 1_000_000);
    monitor.observeSoc('house', 'bms-b', 0.4, 1_000_500);
    monitor.observeSoc('house', 'bms-a', 0.2, 1_001_000);
    expect(events).toEqual([]);
  });

  it('tracks banks independently', () => {
    const { monitor, events } = makeMonitor();
    monitor.observeSoc('house', 'bms', 0.2, 1_000_000);
    monitor.observeSoc('starter', 'bms', 0.8, 1_000_000);
    expect(events.filter((e) => e.bankId === 'house')).toHaveLength(1);
    expect(events.filter((e) => e.bankId === 'starter')).toHaveLength(0);
  });

  it('evicts stale per-source readings outside sourceWindowMs', () => {
    const { monitor, events } = makeMonitor();
    // bms-a posts 0.5 at t=0; bms-b posts 0.4 at t=6000 (past 5s window).
    monitor.observeSoc('house', 'bms-a', 0.5, 1_000_000);
    monitor.observeSoc('house', 'bms-b', 0.4, 1_006_000);
    // bms-a's reading should be evicted; effective SoC reflects bms-b (0.4),
    // which is above 0.3 so no low-soc-enter has fired yet.
    expect(events).toEqual([]);
    // Drop bms-b below threshold; only bms-b should be the source after eviction.
    monitor.observeSoc('house', 'bms-b', 0.25, 1_007_000);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('low-soc-enter');
    expect(events[0]?.soc).toBe(0.25);
  });
});

describe('BatteryMonitor cell-imbalance', () => {
  it('does not emit imbalance until sustained beyond imbalanceSettleSec', () => {
    const { monitor, events } = makeMonitor();
    monitor.observeCellV('trolling', 0, 3.5, 1_000_000);
    monitor.observeCellV('trolling', 1, 3.55, 1_000_000);
    monitor.tick(1_001_000);
    expect(events).toEqual([]);
    monitor.observeCellV('trolling', 0, 3.5, 1_002_000);
    monitor.observeCellV('trolling', 1, 3.7, 1_002_000);
    monitor.tick(1_003_000);
    expect(events).toEqual([]);
    monitor.tick(1_063_000);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('cell-imbalance-enter');
    expect(events[0]?.imbalanceV).toBeGreaterThan(0.1);
  });

  it('emits exit when imbalance drops back below threshold', () => {
    const { monitor, events } = makeMonitor();
    monitor.observeCellV('trolling', 0, 3.5, 1_000_000);
    monitor.observeCellV('trolling', 1, 3.7, 1_000_000);
    monitor.tick(1_065_000);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('cell-imbalance-enter');
    monitor.observeCellV('trolling', 1, 3.55, 1_066_000);
    monitor.tick(1_070_000);
    expect(events).toHaveLength(2);
    expect(events[1]?.kind).toBe('cell-imbalance-exit');
  });
});
