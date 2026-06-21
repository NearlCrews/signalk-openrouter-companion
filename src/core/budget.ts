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
  tokensToday: number;
  costToday: number;
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
      const parsed = JSON.parse(raw) as Partial<PersistedState> & { day?: string; callsToday?: number };
      // callsToday gates the spend cap, so reject a NaN, fractional, or
      // negative count rather than letting it through to the comparison.
      if (
        typeof parsed.day !== 'string' ||
        !Number.isInteger(parsed.callsToday) ||
        parsed.callsToday < 0
      ) {
        throw new Error('invalid state shape');
      }
      const tokensToday =
        Number.isFinite(parsed.tokensToday) && (parsed.tokensToday as number) >= 0
          ? (parsed.tokensToday as number)
          : 0;
      const costToday =
        Number.isFinite(parsed.costToday) && (parsed.costToday as number) >= 0
          ? (parsed.costToday as number)
          : 0;
      state = { day: parsed.day, callsToday: parsed.callsToday, tokensToday, costToday };
    } catch (err) {
      // ENOENT is the expected first-run case. Anything else means an existing
      // budget file failed to load, which silently resets the daily spend cap.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        opts.log?.(`budget state unreadable, resetting daily counter: ${String(err)}`);
      }
      state = { day: utcDay(now()), callsToday: 0, tokensToday: 0, costToday: 0 };
    }
    return new BudgetTracker({ ...opts, now }, state);
  }

  private rolloverIfNeeded(): void {
    const today = utcDay(this.opts.now());
    if (this.state.day !== today) {
      this.state = { day: today, callsToday: 0, tokensToday: 0, costToday: 0 };
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
      ...this.state,
      callsToday: this.state.callsToday + 1,
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

  // Daily token/cost accounting. Unlike recordCall (which runs before the LLM
  // await to bound the call cap under concurrency), recordUsage runs only after
  // a successful call, so it reflects real spend. It does not gate anything; the
  // call cap remains the sole hard spend bound. Best-effort persist, like
  // recordCall: a failed write only loses the running total across a restart.
  async recordUsage(usage: { totalTokens: number; cost: number }): Promise<void> {
    this.rolloverIfNeeded();
    this.state = {
      ...this.state,
      tokensToday: this.state.tokensToday + (Number.isFinite(usage.totalTokens) ? usage.totalTokens : 0),
      costToday: this.state.costToday + (Number.isFinite(usage.cost) ? usage.cost : 0),
    };
    try {
      await writeFile(this.opts.statePath, JSON.stringify(this.state));
    } catch (err) {
      this.opts.log?.(`budget state write failed: ${String(err)}`);
    }
  }

  tokensToday(): number {
    this.rolloverIfNeeded();
    return this.state.tokensToday;
  }

  costToday(): number {
    this.rolloverIfNeeded();
    return this.state.costToday;
  }
}
