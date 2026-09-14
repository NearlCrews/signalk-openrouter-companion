import type { Analyzer, AnalyzerDeps } from '../analyzers/Analyzer.js';
import type { AnalyzerId } from '../analyzers/ids.js';
import type { HistoryProvider } from './history.js';
import { stringify } from './logger.js';
import type { BatteryEventKind, TriggerCtx, TriggerKind, TriggerSpec } from './triggerContext.js';

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
// `aborted` is a run the plugin shutdown interrupted, kept distinct from
// `no-input` because it may already have spent a budget call.
// `queued` is an event trigger deferred behind a run of the same subject; it
// runs when that one settles, so it is neither a report nor a drop.
export type RunOutcome =
  | 'reported'
  | 'no-input'
  | 'budget-exhausted'
  | 'failed'
  | 'unknown'
  | 'already-running'
  | 'aborted'
  | 'queued';

// Trigger kinds whose producer fires again on its own: cron comes round on the
// next tick and a PUT is the operator pressing the button, so one that lands
// on an in-flight run of the same subject can be skipped outright. Every other
// kind carries a state transition its producer clears as it emits (the battery
// monitor flips the per-bank flag, the engine detector ends the session), so a
// skipped one never comes back; those are deferred instead. Listing the
// replayable kinds rather than the droppable ones keeps a future event kind on
// the safe side of the guard by default.
const REPLAYABLE_TRIGGER_KINDS: ReadonlySet<TriggerKind> = new Set(['cron', 'put']);

// One deferred trigger, held until the run it landed on settles.
interface DeferredRun {
  analyzer: Analyzer;
  ctx: TriggerCtx;
}

export class TriggerRouter {
  private lastStatus: string | null = null;
  // Run keys with a run in flight (see runKeyFor). A cron fire that overlaps a
  // manual PUT or REST fire, or a retry ladder that outlives the cron
  // interval, would otherwise spend two budget calls and publish two reports
  // for what the operator sees as one event.
  private readonly inFlight = new Set<string>();
  // At most one deferred trigger per in-flight run key, newest wins. A single
  // slot is what keeps the guard's spend bound intact: draining adds at most
  // one call per run it followed, and that call still passes canSpend().
  private readonly pending = new Map<string, DeferredRun>();

  constructor(
    private analyzers: Analyzer[],
    private deps: AnalyzerDeps,
  ) {}

  // Swap in a history provider discovered after construction. The plugin
  // probes once at start and periodically re-probes an unavailable source.
  setHistory(history: HistoryProvider | null): void {
    this.deps.history = history;
  }

  // Skip SK admin-UI churn when the status string hasn't changed.
  private setStatus(msg: string): void {
    if (msg === this.lastStatus) return;
    this.lastStatus = msg;
    this.deps.setStatus?.(msg);
  }

  // Returns one outcome per matched analyzer, in match order, so a caller that
  // has to answer for the run (the PUT handler) can report what actually
  // happened instead of blanket success. runOne resolves rather than rejects,
  // so a rejected settlement here would be a bug in runOne itself.
  async dispatch(
    kind: TriggerKind,
    ctx: TriggerCtx,
    extras: DispatchExtras = {},
  ): Promise<RunOutcome[]> {
    const matches = this.analyzers.filter((a) =>
      a.triggers.some((t) => triggerMatches(t, kind, extras)),
    );
    const settled = await Promise.allSettled(matches.map((a) => this.runOne(a, ctx)));
    return settled.map((result) => (result.status === 'fulfilled' ? result.value : 'failed'));
  }

  // Run a single analyzer by id, bypassing trigger matching. The REST fire
  // endpoint names the analyzer directly, so it must run regardless of which
  // triggers the analyzer has enabled.
  async runById(id: AnalyzerId, ctx: TriggerCtx): Promise<RunOutcome> {
    const a = this.analyzers.find((x) => x.id === id);
    if (!a) return 'unknown';
    return this.runOne(a, ctx);
  }

  // The identity one run serializes on: the analyzer id, plus the subject the
  // analyzer names for this trigger. Most analyzers name none, so their key is
  // the bare id and the guard behaves exactly as it always has. `alerts` names
  // the (bank, alert kind) pair, which is the Signal K path the alert publishes
  // on, so two banks never contend while an alert and its recovery still share
  // one key and cannot publish out of order.
  private runKeyFor(a: Analyzer, ctx: TriggerCtx): string {
    const subject = a.runKey?.(ctx);
    // The pair is joined with a NUL, the same convention index.ts uses for
    // its (pattern, timezone) cron keys: no analyzer id or Signal K path
    // segment can contain one, so the pair cannot collide into one key.
    return subject ? `${a.id}\u0000${subject}` : a.id;
  }

  // A trigger that landed on an in-flight run of the same subject. A cron fire
  // or a PUT is skipped, which is the guard's documented purpose: the schedule
  // comes round again and the operator can press again, so a second budget call
  // and a second report for one event buy nothing. An event trigger is deferred
  // instead, because its producer has already cleared the state that raised it:
  // a dropped `low-soc-exit` never comes back, and the audible alert it would
  // have cleared stays Active until the bank happens to re-enter and re-exit
  // the band. One slot per key, newest wins, so a burst of events for one
  // subject collapses to the latest state rather than queueing behind it.
  private deferOrSkip(a: Analyzer, ctx: TriggerCtx, key: string): RunOutcome {
    if (REPLAYABLE_TRIGGER_KINDS.has(ctx.kind)) {
      this.deps.logger.debug(`${a.id}: a run is already in flight, skipping this trigger`);
      return 'already-running';
    }
    const verb = this.pending.has(key) ? 'replacing the deferred' : 'deferring this';
    this.pending.set(key, { analyzer: a, ctx });
    this.deps.logger.debug(`${a.id}: a run is already in flight, ${verb} ${ctx.kind} trigger`);
    return 'queued';
  }

  // Start the trigger that was deferred while `key` was in flight. The deferred
  // run goes through the same canSpend() gate as any other and the slot holds
  // exactly one entry, so a drain can add at most one call per run it follows
  // and cannot burst past the daily cap. A shutdown drops the slot rather than
  // spending budget on the way down.
  private drainPending(key: string): void {
    const next = this.pending.get(key);
    if (!next) return;
    this.pending.delete(key);
    if (this.deps.signal?.aborted) return;
    void this.runOne(next.analyzer, next.ctx)
      .then((outcome) =>
        this.deps.logger.debug(
          `${next.analyzer.id}: deferred ${next.ctx.kind} run finished: ${outcome}`,
        ),
      )
      .catch((err) =>
        this.deps.logger.error(`${next.analyzer.id}: deferred run threw: ${stringify(err)}`),
      );
  }

  private async runOne(a: Analyzer, ctx: TriggerCtx): Promise<RunOutcome> {
    const key = this.runKeyFor(a, ctx);
    if (this.inFlight.has(key)) return this.deferOrSkip(a, ctx, key);
    this.inFlight.add(key);
    try {
      const input = await a.collectContext(ctx, this.deps);
      if (input == null) return 'no-input';
      // stop() aborts the lifecycle signal; bail before spending budget or
      // calling the LLM if a shutdown landed while collectContext was running.
      if (this.deps.signal?.aborted) return 'aborted';
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
      const result = await this.deps.llm.complete({
        system,
        user,
        abortSignal: this.deps.signal,
        beforeRetry: (previous) => this.approveRetry(previous),
      });
      await this.deps.budget.recordUsage(result.usage);
      this.setStatus(this.deps.okStatus ?? 'Running');
      const run = {
        model: result.model,
        usage: {
          totalTokens: result.usage.totalTokens,
          cachedTokens: result.usage.cachedTokens,
          cost: result.usage.cost,
        },
      };
      if (a.publishOutput) {
        await a.publishOutput(result.text, ctx, this.deps, run, input);
      } else {
        await this.deps.publisher.publishReport(a.id, ctx, result.text, undefined, run);
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
        return 'aborted';
      }
      this.deps.logger.error(`${a.id}: ${stringify(err)}`);
      await this.deps.publisher
        .publishFailure(a.id, ctx, err, { audible: a.failureAudible })
        .catch((e) =>
          this.deps.logger.debug(`${a.id}: failed to publish failure: ${stringify(e)}`),
        );
      return 'failed';
    } finally {
      this.inFlight.delete(key);
      this.drainPending(key);
    }
  }

  // Whether the LLM client may make one more attempt. A retry after a 429 or a
  // gateway fault is free: OpenRouter does not bill an attempt that produced no
  // generation, so it neither counts against the cap nor needs to re-check it.
  // A client-side timeout is different: it abandons a request the provider may
  // already be generating and billing for, so the retry that follows counts as
  // a call of its own and stops when the cap is spent. Without this one run
  // could bill four generations against one recorded call. canSpend() and the
  // in-memory increment inside recordCall() stay adjacent with no await between
  // them, for the same reason the pre-call check in runOne needs it.
  private async approveRetry(previous: { timedOut: boolean }): Promise<boolean> {
    if (!previous.timedOut) return true;
    if (!this.deps.budget.canSpend()) return false;
    await this.deps.budget.recordCall();
    return true;
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
