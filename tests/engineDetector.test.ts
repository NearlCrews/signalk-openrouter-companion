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
    silenceStopSec: 300,
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

  it('emits possible-stop once per silent stretch and re-arms after a fresh delta', () => {
    const { det, events } = makeDetector();
    det.observe('port', 's1', 10, 1_000_000);
    det.observe('port', 's1', 10, 1_006_000);
    events.length = 0;
    // Three consecutive watchdog ticks while silent emit a single event.
    det.tickWatchdog(1_037_000);
    det.tickWatchdog(1_042_000);
    det.tickWatchdog(1_047_000);
    expect(events).toEqual([{ kind: 'possible-stop', engineId: 'port', ts: 1_037_000 }]);
    // A fresh delta re-arms the watchdog: a later dropout emits again.
    det.observe('port', 's1', 10, 1_050_000);
    det.tickWatchdog(1_090_000);
    expect(events).toEqual([
      { kind: 'possible-stop', engineId: 'port', ts: 1_037_000 },
      { kind: 'possible-stop', engineId: 'port', ts: 1_090_000 },
    ]);
  });

  it('ends the session via the watchdog when a running engine goes silent', () => {
    const { det, events } = makeDetector();
    det.observe('port', 's1', 10, 1_000_000);
    det.observe('port', 's1', 10, 1_006_000);
    expect(events.map((e) => e.kind)).toEqual(['engine-start']);
    events.length = 0;
    // No further deltas: a switched-off N2K engine stops broadcasting. At
    // 200s silent only possible-stop fires; the session is still open.
    det.tickWatchdog(1_206_000);
    expect(events.map((e) => e.kind)).toEqual(['possible-stop']);
    // Past silenceStopSec (300s) the watchdog ends the session. The session
    // end is the last delta actually seen, not the watchdog tick time.
    det.tickWatchdog(1_307_000);
    const stop = events.find((e) => e.kind === 'engine-stop');
    if (!stop) throw new Error('expected engine-stop from the watchdog');
    expect(stop.session?.sessionStart).toBe(1_000_000);
    expect(stop.session?.sessionEnd).toBe(1_006_000);
  });

  it('snapshot and restore preserve a running session across a restart', () => {
    const first = makeDetector();
    first.det.observe('port', 's1', 10, 1_000_000);
    first.det.observe('port', 's1', 10, 1_006_000);
    const snap = first.det.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]?.sessionStartTs).toBe(1_000_000);

    // A fresh detector (a restarted plugin) restores the open session, then
    // sees the engine shut down. The stop must report the original start.
    const restarted = makeDetector();
    restarted.det.restore(snap, 1_010_000, 3_600_000);
    restarted.det.observe('port', 's1', 0, 1_020_000);
    restarted.det.observe('port', 's1', 0, 1_031_000);
    const stop = restarted.events.find((e) => e.kind === 'engine-stop');
    if (!stop) throw new Error('expected engine-stop after restore');
    expect(stop.session?.sessionStart).toBe(1_000_000);
  });

  it('restore discards a session older than the max resume age', () => {
    const first = makeDetector();
    first.det.observe('port', 's1', 10, 1_000_000);
    first.det.observe('port', 's1', 10, 1_006_000);
    const snap = first.det.snapshot();

    // Signal K was down for two hours: the last delta is well past the
    // one-hour resume guard, so the stale session must not be resurrected.
    const restarted = makeDetector();
    restarted.det.restore(snap, 1_006_000 + 7_200_000, 3_600_000);
    restarted.det.tickWatchdog(1_006_000 + 7_200_000 + 400_000);
    expect(restarted.events).toEqual([]);
    expect(restarted.det.snapshot()).toEqual([]);
  });

  it('restore coerces a non-numeric sessionStartTs to null rather than trusting it', () => {
    const { det, events } = makeDetector();
    // A hand-corrupted engine-detector.json: sessionStartTs is a string.
    // restore must not store it, or it would later feed NaN into the
    // durationSec arithmetic.
    det.restore(
      [{ engineId: 'port', lastDeltaTs: 1_000_000, sessionStartTs: 'garbage' }],
      1_010_000,
      3_600_000,
    );
    det.observe('port', 's1', 0, 1_020_000);
    det.observe('port', 's1', 0, 1_031_000);
    const stop = events.find((e) => e.kind === 'engine-stop');
    if (!stop) throw new Error('expected engine-stop');
    expect(Number.isFinite(stop.session?.durationSec)).toBe(true);
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
