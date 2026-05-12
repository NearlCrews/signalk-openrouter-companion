import type {
  Analyzer,
  AnalyzerDeps,
  BatteryEventKind,
  TriggerCtx,
  TriggerKind,
  TriggerSpec,
} from '../analyzers/Analyzer.js';
import { stringify } from './logger.js';

export interface DispatchExtras {
  putPath?: string;
  cronPattern?: string;
  batterySubkind?: BatteryEventKind;
}

type PublishFn = (text: string, ctx: TriggerCtx, deps: AnalyzerDeps) => Promise<void>;

interface AnalyzerEntry {
  analyzer: Analyzer;
  publish: PublishFn;
}

export class TriggerRouter {
  private entries: AnalyzerEntry[];
  private lastStatus: string | null = null;

  constructor(
    analyzers: Analyzer[],
    private deps: AnalyzerDeps,
  ) {
    this.entries = analyzers.map((a) => ({ analyzer: a, publish: a.publishOutput.bind(a) }));
  }

  // Skip SK admin-UI churn when the status string hasn't changed.
  private setStatus(msg: string): void {
    if (msg === this.lastStatus) return;
    this.lastStatus = msg;
    this.deps.setStatus?.(msg);
  }

  async dispatch(kind: TriggerKind, ctx: TriggerCtx, extras: DispatchExtras = {}): Promise<void> {
    const matches = this.entries.filter((e) =>
      e.analyzer.triggers.some((t) => triggerMatches(t, kind, extras)),
    );
    await Promise.allSettled(matches.map((e) => this.runOne(e, ctx)));
  }

  private async runOne(entry: AnalyzerEntry, ctx: TriggerCtx): Promise<void> {
    const a = entry.analyzer;
    try {
      const input = await a.collectContext(ctx, this.deps);
      if (input == null) return;
      if (!this.deps.budget.canSpend()) {
        this.deps.logger.debug(`${a.id}: budget exhausted, skipping`);
        this.setStatus('Running, budget exhausted for today');
        return;
      }
      const { system, user } = a.buildPrompt(input);
      const { text } = await this.deps.llm.complete({ system, user });
      await this.deps.budget.recordCall();
      this.setStatus(this.deps.okStatus ?? 'Running');
      await entry.publish(text, ctx, this.deps);
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
