import { describe, expect, it } from 'vitest';
import { EngineDetector, type EngineEvent } from '../src/core/engineDetector.js';

function makeDetector() {
  const events: EngineEvent[] = [];
  const det = new EngineDetector({
    stopRpmHz: 1.0,
    stopSettleSec: 10,
    startRpmHz: 5.0,
    startSettleSec: 5,
    watchdogSec: 30,
    sourceWindowMs: 1000,
  });
  det.on('engine-start', (e) => events.push(e));
  det.on('engine-stop', (e) => events.push(e));
  det.on('possible-stop', (e) => events.push(e));
  return { det, events };
}

describe('EngineDetector', () => {
  it('emits engine-start when RPM sustains above threshold', () => {
    const { det, events } = makeDetector();
    det.observe('port', 's1', 10, 1_000_000);
    det.observe('port', 's1', 10, 1_002_000);
    det.observe('port', 's1', 10, 1_004_000);
    expect(events).toEqual([]);
    det.observe('port', 's1', 10, 1_006_000);
    expect(events).toEqual([{ kind: 'engine-start', engineId: 'port', ts: 1_000_000 }]);
  });

  it('emits engine-stop after sustained low RPM, with session metadata', () => {
    const { det, events } = makeDetector();
    det.observe('port', 's1', 10, 1_000_000);
    det.observe('port', 's1', 10, 1_006_000);
    expect(events).toHaveLength(1);
    det.observe('port', 's1', 10, 1_010_000);
    det.observe('port', 's1', 0, 2_000_000);
    det.observe('port', 's1', 0, 2_011_000);
    expect(events).toHaveLength(2);
    const stop = events[1];
    if (!stop) throw new Error('expected stop event');
    expect(stop.kind).toBe('engine-stop');
    expect(stop.engineId).toBe('port');
    expect(stop.session?.sessionStart).toBe(1_000_000);
    expect(stop.session?.sessionEnd).toBe(2_000_000);
    expect(stop.session?.durationSec).toBe(1000);
  });

  it('aggregates RPM across multiple sources (max within window)', () => {
    const { det, events } = makeDetector();
    det.observe('port', 's1', 12, 1_000_000);
    det.observe('port', 's2', 11, 1_000_500);
    det.observe('port', 's1', 12, 1_001_000);
    det.observe('port', 's2', 0, 1_006_000);
    det.observe('port', 's1', 12, 1_006_500);
    expect(events).toEqual([{ kind: 'engine-start', engineId: 'port', ts: 1_000_000 }]);
  });

  it('does not stop on a momentary RPM dip below threshold', () => {
    const { det, events } = makeDetector();
    det.observe('port', 's1', 10, 1_000_000);
    det.observe('port', 's1', 10, 1_006_000);
    expect(events).toHaveLength(1);
    det.observe('port', 's1', 0, 1_010_000);
    det.observe('port', 's1', 10, 1_011_000);
    expect(events).toHaveLength(1);
  });

  it('emits possible-stop on gateway dropout while running', () => {
    const { det, events } = makeDetector();
    det.observe('port', 's1', 10, 1_000_000);
    det.observe('port', 's1', 10, 1_006_000);
    events.length = 0;
    det.tickWatchdog(1_007_000);
    expect(events).toHaveLength(0);
    det.tickWatchdog(1_037_000);
    expect(events).toEqual([{ kind: 'possible-stop', engineId: 'port', ts: 1_037_000 }]);
  });

  it('tracks engines independently', () => {
    const { det, events } = makeDetector();
    det.observe('port', 's1', 10, 1_000_000);
    det.observe('starboard', 's1', 0, 1_000_000);
    det.observe('port', 's1', 10, 1_006_000);
    expect(events.filter((e) => e.engineId === 'port')).toHaveLength(1);
    expect(events.filter((e) => e.engineId === 'starboard')).toHaveLength(0);
  });

  it('emits a fresh engine-start after a stall and immediate restart', () => {
    const { det, events } = makeDetector();
    // Initial start-stop cycle.
    det.observe('port', 's1', 10, 1_000_000);
    det.observe('port', 's1', 10, 1_006_000);
    det.observe('port', 's1', 10, 1_010_000);
    det.observe('port', 's1', 0, 2_000_000);
    det.observe('port', 's1', 0, 2_011_000);
    expect(events.map((e) => e.kind)).toEqual(['engine-start', 'engine-stop']);
    // Immediately rises again above start threshold and sustains.
    det.observe('port', 's1', 10, 2_012_000);
    det.observe('port', 's1', 10, 2_018_000);
    expect(events.map((e) => e.kind)).toEqual(['engine-start', 'engine-stop', 'engine-start']);
    // The two engine-start events bracket distinct sessions.
    const starts = events.filter((e) => e.kind === 'engine-start');
    expect(starts[0]?.ts).toBe(1_000_000);
    expect(starts[1]?.ts).toBe(2_012_000);
  });
});
