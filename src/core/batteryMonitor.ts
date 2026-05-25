import type { BatteryEventKind } from '../analyzers/Analyzer.js';
import { TypedEmitter } from './emitter.js';

export type { BatteryEventKind } from '../analyzers/Analyzer.js';

export type BatteryEvent =
  | { kind: 'low-soc-enter'; bankId: string; ts: number; soc: number }
  | { kind: 'low-soc-exit'; bankId: string; ts: number; soc: number }
  | { kind: 'cell-imbalance-enter'; bankId: string; ts: number; imbalanceV: number }
  | { kind: 'cell-imbalance-exit'; bankId: string; ts: number; imbalanceV: number };

interface BatteryMonitorOptions {
  lowSocPercent: number;
  socExitHysteresis: number;
  cellImbalanceV: number;
  imbalanceSettleSec: number;
  sourceWindowMs: number;
}

// Cell-imbalance exit re-arms only when the imbalance drops below this
// fraction of the alert threshold. Without hysteresis a bank oscillating
// around the threshold (a heavy load step, an LFP pack at the absorption
// knee) fires enter/exit pairs every settle window, each pair burning two
// LLM calls. 0.8 matches the same shape socExitHysteresis uses.
const CELL_IMBALANCE_EXIT_FRACTION = 0.8;

interface SocReading {
  soc: number;
  ts: number;
}
interface CellReading {
  v: number;
  ts: number;
}

interface BankState {
  bankId: string;
  socLow: boolean;
  imbalanceHigh: boolean;
  imbalanceSince: number | null;
  recentSoc: Map<string, SocReading>;
  recentCells: Map<number, CellReading>;
}

export class BatteryMonitor extends TypedEmitter<BatteryEventKind, BatteryEvent> {
  private banks = new Map<string, BankState>();
  private readonly lowThreshold: number;
  private readonly exitThreshold: number;
  private readonly imbalanceSettleMs: number;

  constructor(private opts: BatteryMonitorOptions) {
    super();
    this.lowThreshold = opts.lowSocPercent / 100;
    this.exitThreshold = (opts.lowSocPercent + opts.socExitHysteresis) / 100;
    this.imbalanceSettleMs = opts.imbalanceSettleSec * 1000;
  }

  private getBank(bankId: string): BankState {
    let b = this.banks.get(bankId);
    if (!b) {
      b = {
        bankId,
        socLow: false,
        imbalanceHigh: false,
        imbalanceSince: null,
        recentSoc: new Map(),
        recentCells: new Map(),
      };
      this.banks.set(bankId, b);
    }
    return b;
  }

  observeSoc(bankId: string, source: string, soc: number, ts: number): void {
    const b = this.getBank(bankId);
    b.recentSoc.set(source, { soc, ts });

    // Fuse multiple SoC sources with the MINIMUM, not the maximum. This is a
    // low-battery safety alarm: a single pessimistic sensor should still warn
    // the operator, and a single optimistic sensor must not suppress the
    // alarm or clear it early. (The engine detector fuses RPM with the max,
    // which is the conservative direction there: harder to falsely cut a
    // session short. The conservative direction differs per alarm.)
    const cutoff = ts - this.opts.sourceWindowMs;
    let effective = Number.POSITIVE_INFINITY;
    for (const [src, r] of b.recentSoc) {
      if (r.ts < cutoff) {
        b.recentSoc.delete(src);
        continue;
      }
      if (r.soc < effective) effective = r.soc;
    }
    if (!Number.isFinite(effective)) return;

    if (!b.socLow && effective < this.lowThreshold) {
      b.socLow = true;
      this.emit({ kind: 'low-soc-enter', bankId, ts, soc: effective });
    } else if (b.socLow && effective >= this.exitThreshold) {
      b.socLow = false;
      this.emit({ kind: 'low-soc-exit', bankId, ts, soc: effective });
    }
  }

  observeCellV(bankId: string, cellIndex: number, v: number, ts: number): void {
    const b = this.getBank(bankId);
    b.recentCells.set(cellIndex, { v, ts });
    const cutoff = ts - this.opts.sourceWindowMs;
    for (const [idx, r] of b.recentCells) {
      if (r.ts < cutoff) b.recentCells.delete(idx);
    }
    const imbalance = this.computeImbalance(b);
    const overEnter = imbalance > this.opts.cellImbalanceV;
    const overExit = imbalance > this.opts.cellImbalanceV * CELL_IMBALANCE_EXIT_FRACTION;
    if (overEnter) {
      if (b.imbalanceSince === null) b.imbalanceSince = ts;
    } else {
      // Below the enter threshold: clear the entry settle clock so the next
      // tick does not satisfy `elapsed >= settle` from a stale anchor that
      // covered a dip. Exit only fires once we have also cleared the 80%
      // exit floor (hysteresis); a sample in the in-band [exit, enter] zone
      // holds the alert state but resets the entry timer, so a fresh
      // continuous over-enter stretch is required before the next enter.
      b.imbalanceSince = null;
      if (!overExit && b.imbalanceHigh) {
        b.imbalanceHigh = false;
        this.emit({ kind: 'cell-imbalance-exit', bankId, ts, imbalanceV: imbalance });
      }
    }
  }

  tick(now: number): void {
    for (const b of this.banks.values()) {
      // A disconnected BMS keeps its last cell reading forever; without
      // evicting readings older than the source window, the settle timer
      // would fire a false cell-imbalance-enter on hours-old data.
      const cutoff = now - this.opts.sourceWindowMs;
      for (const [idx, r] of b.recentCells) {
        if (r.ts < cutoff) b.recentCells.delete(idx);
      }
      if (b.recentCells.size === 0) {
        b.imbalanceSince = null;
        // The BMS went silent. observeCellV is the only other exit path and it
        // cannot run without deltas, so clear an active imbalance alert here or
        // it would stay stuck until the BMS reconnects with balanced cells.
        if (b.imbalanceHigh) {
          b.imbalanceHigh = false;
          this.emit({ kind: 'cell-imbalance-exit', bankId: b.bankId, ts: now, imbalanceV: 0 });
        }
        continue;
      }
      if (!b.imbalanceHigh && b.imbalanceSince !== null) {
        const elapsed = now - b.imbalanceSince;
        if (elapsed >= this.imbalanceSettleMs) {
          const imbalance = this.computeImbalance(b);
          if (imbalance > this.opts.cellImbalanceV) {
            b.imbalanceHigh = true;
            this.emit({
              kind: 'cell-imbalance-enter',
              bankId: b.bankId,
              ts: now,
              imbalanceV: imbalance,
            });
          } else {
            b.imbalanceSince = null;
          }
        }
      }
    }
  }

  private computeImbalance(b: BankState): number {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const r of b.recentCells.values()) {
      if (r.v < min) min = r.v;
      if (r.v > max) max = r.v;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
    return max - min;
  }
}
