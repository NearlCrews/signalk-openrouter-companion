import type { BatteryEventKind } from '../analyzers/Analyzer.js';

export type { BatteryEventKind } from '../analyzers/Analyzer.js';

export type BatteryEvent =
  | { kind: 'low-soc-enter'; bankId: string; ts: number; soc: number }
  | { kind: 'low-soc-exit'; bankId: string; ts: number; soc: number }
  | { kind: 'cell-imbalance-enter'; bankId: string; ts: number; imbalanceV: number }
  | { kind: 'cell-imbalance-exit'; bankId: string; ts: number; imbalanceV: number };

export interface BatteryMonitorOptions {
  lowSocPercent: number;
  socExitHysteresis: number;
  cellImbalanceV: number;
  imbalanceSettleSec: number;
  sourceWindowMs: number;
}

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

type Listener = (e: BatteryEvent) => void;

export class BatteryMonitor {
  private banks = new Map<string, BankState>();
  private listeners = new Map<BatteryEventKind, Set<Listener>>();

  constructor(private opts: BatteryMonitorOptions) {}

  on(kind: BatteryEventKind, cb: Listener): () => void {
    let set = this.listeners.get(kind);
    if (!set) {
      set = new Set();
      this.listeners.set(kind, set);
    }
    const target = set;
    target.add(cb);
    return () => {
      target.delete(cb);
    };
  }

  private emit(e: BatteryEvent): void {
    const set = this.listeners.get(e.kind);
    if (!set) return;
    for (const cb of set) cb(e);
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

    const cutoff = ts - this.opts.sourceWindowMs;
    let effective = Number.NEGATIVE_INFINITY;
    for (const [src, r] of b.recentSoc) {
      if (r.ts < cutoff) {
        b.recentSoc.delete(src);
        continue;
      }
      if (r.soc > effective) effective = r.soc;
    }
    if (!Number.isFinite(effective)) return;

    const lowThreshold = this.opts.lowSocPercent / 100;
    const exitThreshold = (this.opts.lowSocPercent + this.opts.socExitHysteresis) / 100;

    if (!b.socLow && effective < lowThreshold) {
      b.socLow = true;
      this.emit({ kind: 'low-soc-enter', bankId, ts, soc: effective });
    } else if (b.socLow && effective >= exitThreshold) {
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
    const overThreshold = imbalance > this.opts.cellImbalanceV;
    if (overThreshold) {
      if (b.imbalanceSince === null) b.imbalanceSince = ts;
    } else {
      b.imbalanceSince = null;
      if (b.imbalanceHigh) {
        b.imbalanceHigh = false;
        this.emit({ kind: 'cell-imbalance-exit', bankId, ts, imbalanceV: imbalance });
      }
    }
  }

  tick(now: number): void {
    for (const b of this.banks.values()) {
      if (!b.imbalanceHigh && b.imbalanceSince !== null) {
        const elapsed = now - b.imbalanceSince;
        if (elapsed >= this.opts.imbalanceSettleSec * 1000) {
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
