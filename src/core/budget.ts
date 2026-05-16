import { readFile, writeFile } from 'node:fs/promises';

export interface BudgetOptions {
  maxPerDay: number;
  statePath: string;
  now?: () => Date;
}

interface PersistedState {
  day: string;
  callsToday: number;
  lastCallTs: string | null;
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

type ResolvedBudgetOptions = BudgetOptions & { now: () => Date };

export class BudgetTracker {
  private constructor(
    private opts: ResolvedBudgetOptions,
    private state: PersistedState,
  ) {}

  static async load(opts: BudgetOptions): Promise<BudgetTracker> {
    const now = opts.now ?? (() => new Date());
    let state: PersistedState;
    try {
      const raw = await readFile(opts.statePath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedState;
      if (typeof parsed.day !== 'string' || typeof parsed.callsToday !== 'number') {
        throw new Error('invalid state shape');
      }
      state = parsed;
    } catch {
      state = { day: utcDay(now()), callsToday: 0, lastCallTs: null };
    }
    return new BudgetTracker({ ...opts, now }, state);
  }

  private rolloverIfNeeded(): void {
    const today = utcDay(this.opts.now());
    if (this.state.day !== today) {
      this.state = { day: today, callsToday: 0, lastCallTs: null };
    }
  }

  canSpend(): boolean {
    this.rolloverIfNeeded();
    return this.state.callsToday < this.opts.maxPerDay;
  }

  callsToday(): number {
    this.rolloverIfNeeded();
    return this.state.callsToday;
  }

  // The `callsToday` increment must stay synchronous and run before the
  // first await. `TriggerRouter.runOne` calls `canSpend()` then `recordCall()`
  // with no await between them; that gap being await-free is what stops
  // concurrently dispatched analyzers from overshooting the daily cap. A
  // read-modify-write of the state file before the increment would reopen
  // that race.
  async recordCall(): Promise<void> {
    this.rolloverIfNeeded();
    this.state = {
      day: this.state.day,
      callsToday: this.state.callsToday + 1,
      lastCallTs: this.opts.now().toISOString(),
    };
    await writeFile(this.opts.statePath, JSON.stringify(this.state));
  }
}
