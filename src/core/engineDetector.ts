import { TypedEmitter } from './emitter.js';

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
  sourceWindowMs: number;
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

  constructor(private opts: EngineDetectorOptions) {
    super();
    this.stopSettleMs = opts.stopSettleSec * 1000;
    this.startSettleMs = opts.startSettleSec * 1000;
    this.watchdogMs = opts.watchdogSec * 1000;
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

  observe(engineId: string, source: string, hz: number, ts: number): void {
    const s = this.getState(engineId);
    s.lastDeltaTs = ts;
    s.possibleStopEmitted = false;
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
          const sessionStart = s.sessionStartTs ?? s.belowSince;
          const sessionEnd = s.belowSince;
          s.running = false;
          s.sessionStartTs = null;
          s.aboveSince = null;
          this.emit({
            kind: 'engine-stop',
            engineId,
            ts: sessionEnd,
            session: {
              sessionStart,
              sessionEnd,
              durationSec: Math.round((sessionEnd - sessionStart) / 1000),
            },
          });
        }
      } else {
        s.belowSince = null;
      }
    }
  }

  tickWatchdog(now: number): void {
    for (const s of this.states.values()) {
      if (s.running && !s.possibleStopEmitted && now - s.lastDeltaTs > this.watchdogMs) {
        s.possibleStopEmitted = true;
        this.emit({ kind: 'possible-stop', engineId: s.engineId, ts: now });
      }
    }
  }
}
