import type {
  Analyzer,
  AnalyzerDeps,
  BatteryEventKind,
  TriggerCtx,
  TriggerKind,
  TriggerSpec,
} from '../analyzers/Analyzer.js';
import type { AnalyzerId } from '../analyzers/ids.js';
import { stringify } from './logger.js';
import type { QuestDBClient } from './questdb.js';

// cron triggers are dispatched directly via runById (a cron job names its
// analyzer ids); only put and battery-event flow through dispatch + match.
interface DispatchExtras {
  putPath?: string;
  batterySubkind?: BatteryEventKind;
}

// Outcome of one analyzer run. `runById` returns it so a caller (the REST fire
// endpoint) can tell a real report apart from a no-op or a failure instead of
// reporting blanket success. `unknown` distinguishes "no analyzer with that
// id" from `no-input` ("collectContext returned nothing"); the REST endpoint
// pre-guards unknown ids with a 409, but in-process callers may not.
export type RunOutcome = 'reported' | 'no-input' | 'budget-exhausted' | 'failed' | 'unknown';

export class TriggerRouter {
  private lastStatus: string | null = null;

  constructor(
    private analyzers: Analyzer[],
    private deps: AnalyzerDeps,
  ) {}

  // Swap in a QuestDB client discovered after construction (the plugin probes
  // QuestDB once at start and re-probes if it was unreachable then).
  setQuestdb(questdb: QuestDBClient | null): void {
    this.deps.questdb = questdb;
  }

  // Skip SK admin-UI churn when the status string hasn't changed.
  private setStatus(msg: string): void {
    if (msg === this.lastStatus) return;
    this.lastStatus = msg;
    this.deps.setStatus?.(msg);
  }

  async dispatch(kind: TriggerKind, ctx: TriggerCtx, extras: DispatchExtras = {}): Promise<void> {
    const matches = this.analyzers.filter((a) =>
      a.triggers.some((t) => triggerMatches(t, kind, extras)),
    );
    await Promise.allSettled(matches.map((a) => this.runOne(a, ctx)));
  }

  // Run a single analyzer by id, bypassing trigger matching. The REST fire
  // endpoint names the analyzer directly, so it must run regardless of which
  // triggers the analyzer has enabled.
  async runById(id: AnalyzerId, ctx: TriggerCtx): Promise<RunOutcome> {
    const a = this.analyzers.find((x) => x.id === id);
    if (!a) return 'unknown';
    return this.runOne(a, ctx);
  }

  private async runOne(a: Analyzer, ctx: TriggerCtx): Promise<RunOutcome> {
    try {
      const input = await a.collectContext(ctx, this.deps);
      if (input == null) return 'no-input';
      // stop() aborts the lifecycle signal; bail before spending budget or
      // calling the LLM if a shutdown landed while collectContext was running.
      if (this.deps.signal?.aborted) return 'no-input';
      if (!this.deps.budget.canSpend()) {
        this.deps.logger.debug(`${a.id}: budget exhausted, skipping`);
        this.setStatus('Running: budget exhausted for today');
        return 'budget-exhausted';
      }
      // Record the call here, not after the LLM await: the canSpend() check
      // above and the in-memory counter increment inside recordCall() run with
      // no await between them, so analyzers dispatched concurrently cannot all
      // pass the check before any of them increments the counter and overshoot
      // the daily cap. A call that fails after this point still counts, the
      // intended conservative behavior for a spend cap.
      await this.deps.budget.recordCall();
      const { system, user } = a.buildPrompt(input);
      const { text } = await this.deps.llm.complete({
        system,
        user,
        abortSignal: this.deps.signal,
      });
      this.setStatus(this.deps.okStatus ?? 'Running');
      if (a.publishOutput) {
        await a.publishOutput(text, ctx, this.deps);
      } else {
        await this.deps.publisher.publishReport(a.id, ctx, text);
      }
      return 'reported';
    } catch (err) {
      // A shutdown that aborts mid-LLM-call or mid-backoff surfaces here as the
      // abort error. Publishing a failure on the way down would raise a
      // spurious report, and for alerts (failureAudible) an audible N2K alarm,
      // for a run that was only interrupted. Treat it as the same silent no-op
      // as the pre-LLM abort check above.
      if (this.deps.signal?.aborted) {
        this.deps.logger.debug(`${a.id}: aborted during run, skipping failure publish`);
        return 'no-input';
      }
      this.deps.logger.error(`${a.id}: ${stringify(err)}`);
      await this.deps.publisher
        .publishFailure(a.id, ctx, err, { audible: a.failureAudible })
        .catch((e) =>
          this.deps.logger.debug(`${a.id}: failed to publish failure: ${stringify(e)}`),
        );
      return 'failed';
    }
  }
}

function triggerMatches(t: TriggerSpec, kind: TriggerKind, extras: DispatchExtras): boolean {
  if (t.kind !== kind) return false;
  // Cron is dispatched via runById (production registers one cron job per
  // (pattern, timezone) and names its members directly); dispatch never
  // routes cron and a call here is a misuse.
  if (t.kind === 'cron') return false;
  if (t.kind === 'put') return t.path === extras.putPath;
  if (t.kind === 'battery-event') return t.subkind === extras.batterySubkind;
  return true;
}
