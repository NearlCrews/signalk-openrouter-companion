import { describe, expect, it } from 'vitest';
import { type BatteryEvent, BatteryMonitor } from '../src/core/batteryMonitor.js';

function makeMonitor() {
  const events: BatteryEvent[] = [];
  const monitor = new BatteryMonitor(
    {
      lowSocPercent: 30,
      socExitHysteresis: 5,
      cellImbalanceV: 0.1,
      imbalanceSettleSec: 60,
      sourceWindowMs: 5000,
    },
    { error: () => {} },
  );
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

  it('aggregates SoC across sources (min wins: conservative for a safety alarm)', () => {
    const { monitor, events } = makeMonitor();
    monitor.observeSoc('house', 'bms-a', 0.5, 1_000_000);
    monitor.observeSoc('house', 'bms-b', 0.4, 1_000_500);
    // min(0.5, 0.4) = 0.4, still above the 0.3 threshold.
    expect(events).toEqual([]);
    // bms-a drops to 0.2 while the optimistic bms-b still reads 0.4. Min
    // fusion must still fire: an optimistic sensor cannot suppress the alarm.
    monitor.observeSoc('house', 'bms-a', 0.2, 1_001_000);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('low-soc-enter');
    expect(events[0]?.soc).toBe(0.2);
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

// Post both cell readings for `trolling` at a given timestamp. A live BMS
// reports its cells on a steady cadence; the test mirrors that so the
// readings stay fresh within sourceWindowMs across the settle window.
function observePair(monitor: BatteryMonitor, cell0: number, cell1: number, ts: number): void {
  monitor.observeCellV('trolling', 0, cell0, ts);
  monitor.observeCellV('trolling', 1, cell1, ts);
}

describe('BatteryMonitor cell-imbalance', () => {
  it('does not emit imbalance until sustained beyond imbalanceSettleSec', () => {
    const { monitor, events } = makeMonitor();
    // Balanced readings: no imbalance to settle.
    observePair(monitor, 3.5, 3.55, 1_000_000);
    monitor.tick(1_001_000);
    expect(events).toEqual([]);
    // Imbalance appears at t=1_002_000. The BMS keeps reporting both cells
    // every 2s so they stay fresh inside the 5s source window. The settle
    // window is 60s, so a tick a few seconds in must not fire yet.
    observePair(monitor, 3.5, 3.7, 1_002_000);
    monitor.tick(1_003_000);
    expect(events).toEqual([]);
    for (let ts = 1_004_000; ts <= 1_062_000; ts += 2_000) {
      observePair(monitor, 3.5, 3.7, ts);
    }
    monitor.tick(1_063_000);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('cell-imbalance-enter');
    expect(events[0]?.imbalanceV).toBeGreaterThan(0.1);
  });

  it('emits exit when imbalance drops back below threshold', () => {
    const { monitor, events } = makeMonitor();
    for (let ts = 1_000_000; ts <= 1_064_000; ts += 2_000) {
      observePair(monitor, 3.5, 3.7, ts);
    }
    monitor.tick(1_065_000);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('cell-imbalance-enter');
    monitor.observeCellV('trolling', 1, 3.55, 1_066_000);
    monitor.tick(1_070_000);
    expect(events).toHaveLength(2);
    expect(events[1]?.kind).toBe('cell-imbalance-exit');
  });

  it('does not fire a false imbalance-enter on stale cell data', () => {
    const { monitor, events } = makeMonitor();
    // An imbalanced reading arrives once, then the BMS goes silent. The
    // settle timer would elapse, but the cell readings are well past the 5s
    // source window, so the eviction pass clears them and no alarm fires.
    observePair(monitor, 3.5, 3.7, 1_000_000);
    monitor.tick(1_010_000);
    expect(events).toEqual([]);
    monitor.tick(1_070_000);
    expect(events).toEqual([]);
  });

  it('clears an active imbalance alert when the BMS goes silent', () => {
    const { monitor, events } = makeMonitor();
    // Sustain an imbalance long enough to fire cell-imbalance-enter.
    for (let ts = 1_000_000; ts <= 1_064_000; ts += 2_000) {
      observePair(monitor, 3.5, 3.7, ts);
    }
    monitor.tick(1_065_000);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('cell-imbalance-enter');
    // The BMS then goes silent. A tick past the 5s source window evicts every
    // cell reading, so recentCells empties. observeCellV cannot run without
    // deltas, so this is the only exit path left: the active alert is cleared
    // with imbalanceV 0, since a comparative diagnostic has no value once no
    // cells are reporting.
    monitor.tick(1_075_000);
    expect(events).toHaveLength(2);
    expect(events[1]?.kind).toBe('cell-imbalance-exit');
    expect(events[1]?.imbalanceV).toBe(0);
  });

  it('resets the settle timer without emitting when the imbalance resolves before settling', () => {
    const { monitor, events } = makeMonitor();
    // The outlier cell (1) and the anchor cell (0) are imbalanced and fresh, so
    // the entry settle clock starts at 1_000_000. No tick runs during the
    // buildup, so the alert never fires. The outlier stops reporting before the
    // anchor: at the settle-window tick the outlier is outside the 5s window and
    // is evicted, while the anchor survives, so the lone surviving cell has zero
    // spread. The tick finds the settle window elapsed but the imbalance gone,
    // so it clears the timer without emitting an enter.
    for (let ts = 1_000_000; ts <= 1_058_000; ts += 2_000) {
      monitor.observeCellV('trolling', 0, 3.5, ts);
      monitor.observeCellV('trolling', 1, 3.7, ts);
    }
    // The anchor gets one more fresh reading; the outlier does not. The outlier
    // (last seen 1_058_000) is still inside the 5s window here, so this call
    // sees a real imbalance and keeps the settle timer armed.
    monitor.observeCellV('trolling', 0, 3.5, 1_060_000);
    // 63.5s since the timer armed: the settle window has elapsed. The outlier
    // (1_058_000) is now outside the 5s window and is evicted; the anchor
    // (1_060_000) survives, so the live imbalance is 0 and no alert fires.
    monitor.tick(1_063_500);
    expect(events).toEqual([]);
  });
});
