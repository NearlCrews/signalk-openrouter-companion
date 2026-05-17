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

export interface DispatchExtras {
  putPath?: string;
  cronPattern?: string;
  batterySubkind?: BatteryEventKind;
}

export class TriggerRouter {
  private lastStatus: string | null = null;

  constructor(
    private analyzers: Analyzer[],
    private deps: AnalyzerDeps,
  ) {}

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
  async runById(id: AnalyzerId, ctx: TriggerCtx): Promise<void> {
    const a = this.analyzers.find((x) => x.id === id);
    if (a) await this.runOne(a, ctx);
  }

  private async runOne(a: Analyzer, ctx: TriggerCtx): Promise<void> {
    try {
      const input = await a.collectContext(ctx, this.deps);
      if (input == null) return;
      if (!this.deps.budget.canSpend()) {
        this.deps.logger.debug(`${a.id}: budget exhausted, skipping`);
        this.setStatus('Running, budget exhausted for today');
        return;
      }
      // Record the call here, not after the LLM await: the canSpend() check
      // above and the in-memory counter increment inside recordCall() run with
      // no await between them, so analyzers dispatched concurrently cannot all
      // pass the check before any of them increments the counter and overshoot
      // the daily cap. A call that fails after this point still counts, the
      // intended conservative behavior for a spend cap.
      await this.deps.budget.recordCall();
      const { system, user } = a.buildPrompt(input);
      const { text } = await this.deps.llm.complete({ system, user });
      this.setStatus(this.deps.okStatus ?? 'Running');
      if (a.publishOutput) {
        await a.publishOutput(text, ctx, this.deps);
      } else {
        await this.deps.publisher.publishReport(a.id, ctx, text);
      }
    } catch (err) {
      this.deps.logger.error(`${a.id}: ${stringify(err)}`);
      await this.deps.publisher.publishFailure(a.id, ctx, err).catch(() => {});
    }
  }
}

function triggerMatches(t: TriggerSpec, kind: TriggerKind, extras: DispatchExtras): boolean {
  if (t.kind !== kind) return false;
  if (t.kind === 'put') return t.path === extras.putPath;
  if (t.kind === 'cron') return t.pattern === extras.cronPattern;
  if (t.kind === 'battery-event') return t.subkind === extras.batterySubkind;
  return true;
}
