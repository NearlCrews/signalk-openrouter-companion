import { TypedEmitter } from './emitter.js';
import { asFiniteNumber } from './format.js';
import type { Logger } from './logger.js';

type EngineEventKind = 'engine-start' | 'engine-stop' | 'possible-stop';

export interface EngineSession {
  sessionStart: number;
  sessionEnd: number;
  durationSec: number;
}

export interface EngineEvent {
  kind: EngineEventKind;
  engineId: string;
  ts: number;
  session?: EngineSession;
}

export interface EngineDetectorOptions {
  stopRpmHz: number;
  stopSettleSec: number;
  startRpmHz: number;
  startSettleSec: number;
  watchdogSec: number;
  // Silence beyond this many seconds while running ends the session: see
  // tickWatchdog for why a real N2K shutdown produces silence, not RPM 0.
  silenceStopSec: number;
  sourceWindowMs: number;
}

// Serializable per-engine state for one in-progress session, persisted so a
// plugin restart can resume it. recentBySource is omitted: it is a short
// rolling window that rebuilds from incoming deltas within sourceWindowMs.
export interface EngineStateSnapshot {
  engineId: string;
  belowSince: number | null;
  aboveSince: number | null;
  belowSinceWhileStarting: number | null;
  sessionStartTs: number | null;
  lastDeltaTs: number;
  possibleStopEmitted: boolean;
}

interface PerSourceReading {
  hz: number;
  ts: number;
}

interface EngineState {
  engineId: string;
  running: boolean;
  belowSince: number | null;
  aboveSince: number | null;
  belowSinceWhileStarting: number | null;
  sessionStartTs: number | null;
  lastDeltaTs: number;
  // True once the watchdog has emitted possible-stop for the current silent
  // stretch. Reset by observe() so a later dropout re-emits; without it the
  // watchdog would re-emit every tick for a permanently silent engine.
  possibleStopEmitted: boolean;
  recentBySource: Map<string, PerSourceReading>;
}

export class EngineDetector extends TypedEmitter<EngineEventKind, EngineEvent> {
  private states = new Map<string, EngineState>();
  private readonly stopSettleMs: number;
  private readonly startSettleMs: number;
  private readonly watchdogMs: number;
  private readonly silenceStopMs: number;

  constructor(
    private opts: EngineDetectorOptions,
    logger: Pick<Logger, 'error'>,
  ) {
    super((message) => logger.error(message));
    this.stopSettleMs = opts.stopSettleSec * 1000;
    this.startSettleMs = opts.startSettleSec * 1000;
    this.watchdogMs = opts.watchdogSec * 1000;
    this.silenceStopMs = opts.silenceStopSec * 1000;
  }

  private getState(engineId: string): EngineState {
    let s = this.states.get(engineId);
    if (!s) {
      s = {
        engineId,
        running: false,
        belowSince: null,
        aboveSince: null,
        belowSinceWhileStarting: null,
        sessionStartTs: null,
        lastDeltaTs: 0,
        possibleStopEmitted: false,
        recentBySource: new Map(),
      };
      this.states.set(engineId, s);
    }
    return s;
  }

  // Close the running session: clear all per-session state and emit
  // engine-stop. Shared by the below-threshold path in observe() and the
  // silence path in tickWatchdog().
  private endSession(s: EngineState, sessionStart: number, sessionEnd: number): void {
    s.running = false;
    s.sessionStartTs = null;
    s.aboveSince = null;
    s.belowSince = null;
    s.belowSinceWhileStarting = null;
    s.possibleStopEmitted = false;
    this.emit({
      kind: 'engine-stop',
      engineId: s.engineId,
      ts: sessionEnd,
      session: {
        sessionStart,
        sessionEnd,
        durationSec: Math.round((sessionEnd - sessionStart) / 1000),
      },
    });
  }

  observe(engineId: string, source: string, hz: number, ts: number): void {
    // Defense in depth: the subscribe wrapper clamps ts to wall-clock and
    // drops NaN samples, but a non-finite value here would silently freeze
    // the detector (NaN comparisons return false, so settle anchors are
    // never reset and start/stop never fires).
    if (!Number.isFinite(ts) || !Number.isFinite(hz)) return;
    const s = this.getState(engineId);
    // A delta gap longer than the watchdog window is a real dropout, not the
    // normal sub-second-to-few-second cadence the settle timers tolerate. A
    // stale `aboveSince`/`belowSince` carried across such a gap would satisfy
    // a settle check on the first delta after it and backdate a session start
    // (or end) by the whole gap. Restart the settle anchors from this delta.
    const gap = s.lastDeltaTs > 0 ? ts - s.lastDeltaTs : 0;
    s.lastDeltaTs = ts;
    s.possibleStopEmitted = false;
    if (gap > this.watchdogMs) {
      s.aboveSince = null;
      s.belowSince = null;
      s.belowSinceWhileStarting = null;
    }
    s.recentBySource.set(source, { hz, ts });
    const cutoff = ts - this.opts.sourceWindowMs;
    let effectiveHz = Number.NEGATIVE_INFINITY;
    for (const [src, r] of s.recentBySource) {
      if (r.ts < cutoff) {
        s.recentBySource.delete(src);
        continue;
      }
      if (r.hz > effectiveHz) effectiveHz = r.hz;
    }

    if (!s.running) {
      if (effectiveHz >= this.opts.startRpmHz) {
        s.belowSinceWhileStarting = null;
        if (s.aboveSince === null) s.aboveSince = ts;
        if (ts - s.aboveSince >= this.startSettleMs) {
          s.running = true;
          s.sessionStartTs = s.aboveSince;
          s.belowSince = null;
          this.emit({ kind: 'engine-start', engineId, ts: s.aboveSince });
        }
      } else {
        if (s.belowSinceWhileStarting === null) s.belowSinceWhileStarting = ts;
        if (ts - s.belowSinceWhileStarting >= this.opts.sourceWindowMs) {
          s.aboveSince = null;
        }
      }
    } else {
      if (effectiveHz < this.opts.stopRpmHz) {
        if (s.belowSince === null) s.belowSince = ts;
        if (ts - s.belowSince >= this.stopSettleMs) {
          this.endSession(s, s.sessionStartTs ?? s.belowSince, s.belowSince);
        }
      } else {
        s.belowSince = null;
      }
    }
  }

  tickWatchdog(now: number): void {
    for (const s of this.states.values()) {
      if (!s.running) continue;
      const silentFor = now - s.lastDeltaTs;
      if (silentFor > this.silenceStopMs) {
        // A switched-off N2K engine goes silent rather than reporting RPM 0,
        // so the below-threshold stop path in observe() never fires for a
        // real shutdown. The last delta seen is the end of the session.
        // Skip possible-stop here: when the silence already exceeds
        // silenceStopMs (a SK restart after a long downtime), emitting a
        // possible-stop in the same tick that ends the session would only
        // produce a stale "engine may have stopped" event for a session
        // that is being closed anyway.
        this.endSession(s, s.sessionStartTs ?? s.lastDeltaTs, s.lastDeltaTs);
      } else if (!s.possibleStopEmitted && silentFor > this.watchdogMs) {
        s.possibleStopEmitted = true;
        this.emit({ kind: 'possible-stop', engineId: s.engineId, ts: now });
      }
    }
  }

  // Snapshot of every engine with a session in progress, for persistence so a
  // plugin restart mid-session does not lose the session. Engines that are not
  // running carry no session worth preserving and are omitted.
  snapshot(): EngineStateSnapshot[] {
    const out: EngineStateSnapshot[] = [];
    for (const s of this.states.values()) {
      if (!s.running) continue;
      out.push({
        engineId: s.engineId,
        belowSince: s.belowSince,
        aboveSince: s.aboveSince,
        belowSinceWhileStarting: s.belowSinceWhileStarting,
        sessionStartTs: s.sessionStartTs,
        lastDeltaTs: s.lastDeltaTs,
        possibleStopEmitted: s.possibleStopEmitted,
      });
    }
    return out;
  }

  // Reload sessions persisted by snapshot(). A session whose last delta is
  // older than maxResumeAgeMs is discarded: Signal K was down long enough
  // that the engine certainly stopped during the outage, so resuming it would
  // only produce a spurious multi-hour session on the next watchdog tick.
  // Every field is validated: the file is plugin-written, but a hand-edit
  // must not feed a non-number into the duration arithmetic.
  restore(snapshots: readonly unknown[], now: number, maxResumeAgeMs: number): void {
    for (const snap of snapshots) {
      if (typeof snap !== 'object' || snap === null) continue;
      const s = snap as Record<string, unknown>;
      if (typeof s.engineId !== 'string') continue;
      if (typeof s.lastDeltaTs !== 'number' || !Number.isFinite(s.lastDeltaTs)) continue;
      // Reject snapshots whose lastDeltaTs is in the future (clock skew,
      // hand-edit): a negative now - lastDeltaTs defeats both the maxResumeAge
      // check below and the silentFor comparisons in tickWatchdog.
      if (s.lastDeltaTs > now + 5 * 60_000) continue;
      if (now - s.lastDeltaTs > maxResumeAgeMs) continue;
      this.states.set(s.engineId, {
        engineId: s.engineId,
        running: true,
        belowSince: asFiniteNumber(s.belowSince),
        aboveSince: asFiniteNumber(s.aboveSince),
        belowSinceWhileStarting: asFiniteNumber(s.belowSinceWhileStarting),
        sessionStartTs: asFiniteNumber(s.sessionStartTs),
        lastDeltaTs: s.lastDeltaTs,
        possibleStopEmitted: s.possibleStopEmitted === true,
        recentBySource: new Map(),
      });
    }
  }
}
