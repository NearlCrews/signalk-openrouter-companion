import { readFile, rename, writeFile } from 'node:fs/promises';

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

// Coerce a malformed numeric (NaN, Infinity, negative, or a value that slipped
// past JSON.parse) to 0. The token/cost totals are display-only and come
// straight off persisted state or the API body, so they must never go negative
// or non-finite.
function nonNegFinite(n: number): number {
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

type ResolvedBudgetOptions = BudgetOptions & { now: () => Date };

export class BudgetTracker {
  // Serializes the state writes. One cron job fans out to several analyzers, so
  // one run's recordUsage can overlap another's recordCall. Two independent
  // truncating writes to the same path can leave the longer payload's tail
  // behind the shorter one, and the unparseable file that results silently
  // resets the daily spend cap on the next load.
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(
    private opts: ResolvedBudgetOptions,
    private state: PersistedState,
  ) {}

  static async load(opts: BudgetOptions): Promise<BudgetTracker> {
    const now = opts.now ?? (() => new Date());
    let state: PersistedState;
    try {
      const raw = await readFile(opts.statePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PersistedState> & {
        day?: string;
        callsToday?: number;
      };
      // callsToday gates the spend cap, so reject a NaN, fractional, or
      // negative count rather than letting it through to the comparison. The
      // tokensToday/costToday totals are display-only, so they take the gentler
      // route below: coerce a malformed value to 0 instead of rejecting the
      // whole file.
      if (
        typeof parsed.day !== 'string' ||
        typeof parsed.callsToday !== 'number' ||
        !Number.isInteger(parsed.callsToday) ||
        parsed.callsToday < 0
      ) {
        throw new Error('invalid state shape');
      }
      const tokensToday = nonNegFinite(parsed.tokensToday ?? 0);
      const costToday = nonNegFinite(parsed.costToday ?? 0);
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
    await this.persist();
  }

  // Write the current state through the serializing chain, and write it
  // atomically: a temporary file plus a rename, so a concurrent reader or a
  // power loss mid-write can only ever see a complete file.
  //
  // Best-effort by contract. The in-memory counters are already updated, so a
  // failed write only loses them across a server restart. It must not reject:
  // recordCall runs inside the analyzer's try block, and a rejection there
  // would surface as a spurious analyzer-failure report before the LLM call
  // has even been attempted. A persistently failing write quietly weakens the
  // cap, so log it.
  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state);
    const tempPath = `${this.opts.statePath}.tmp`;
    this.writeChain = this.writeChain.then(async () => {
      try {
        await writeFile(tempPath, snapshot);
        await rename(tempPath, this.opts.statePath);
      } catch (err) {
        this.opts.log?.(`budget state write failed: ${String(err)}`);
      }
    });
    return this.writeChain;
  }

  // Daily token/cost accounting. Unlike recordCall (which runs before the LLM
  // await to bound the call cap under concurrency), recordUsage runs only after
  // a successful call, so it reflects real spend. It does not gate anything; the
  // call cap remains the sole hard spend bound. Best-effort persist, like
  // recordCall: a failed write only loses the running total across a restart.
  async recordUsage(usage: { totalTokens: number; cost: number }): Promise<void> {
    this.rolloverIfNeeded();
    // nonNegFinite defends the daily counter: OpenRouter should never send a
    // negative cost, but the figure comes straight off the API body.
    this.state = {
      ...this.state,
      tokensToday: this.state.tokensToday + nonNegFinite(usage.totalTokens),
      costToday: this.state.costToday + nonNegFinite(usage.cost),
    };
    await this.persist();
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
