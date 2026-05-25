import { readFile, writeFile } from 'node:fs/promises';

interface BudgetOptions {
  maxPerDay: number;
  statePath: string;
  now?: () => Date;
  // Optional sink for persistence faults. A failed load silently resets the
  // daily spend cap and a failed write silently weakens it, so both are worth
  // surfacing even though neither should reject.
  log?: (msg: string) => void;
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
    } catch (err) {
      // ENOENT is the expected first-run case. Anything else means an existing
      // budget file failed to load, which silently resets the daily spend cap.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        opts.log?.(`budget state unreadable, resetting daily counter: ${String(err)}`);
      }
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
    try {
      await writeFile(this.opts.statePath, JSON.stringify(this.state));
    } catch (err) {
      // Best-effort persist. The in-memory counter is already incremented, so
      // a failed write only loses the count across a server restart. It must
      // not reject: recordCall runs inside the analyzer's try block, and a
      // rejection here would surface as a spurious analyzer-failure report
      // even though the LLM call has not been attempted yet. A persistently
      // failing write quietly weakens the cap, so log it.
      this.opts.log?.(`budget state write failed: ${String(err)}`);
    }
  }
}
