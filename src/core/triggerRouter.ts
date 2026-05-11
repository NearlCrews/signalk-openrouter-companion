import type {
  Analyzer,
  AnalyzerDeps,
  TriggerCtx,
  TriggerKind,
  TriggerSpec,
} from '../analyzers/Analyzer.js';
import { stringify } from './logger.js';

export interface DispatchExtras {
  putPath?: string;
  cronPattern?: string;
}

export class TriggerRouter {
  constructor(
    private analyzers: Analyzer[],
    private deps: AnalyzerDeps,
  ) {}

  async dispatch(kind: TriggerKind, ctx: TriggerCtx, extras: DispatchExtras = {}): Promise<void> {
    const matches = this.analyzers.filter((a) =>
      a.triggers.some((t) => triggerMatches(t, kind, extras)),
    );
    await Promise.allSettled(matches.map((a) => this.runOne(a, ctx)));
  }

  private async runOne(a: Analyzer, ctx: TriggerCtx): Promise<void> {
    try {
      const input = await a.collectContext(ctx, this.deps);
      if (input == null) return;
      if (!this.deps.budget.canSpend()) {
        this.deps.logger.debug(`${a.id}: budget exhausted, skipping`);
        this.deps.setStatus?.('Running, budget exhausted for today');
        return;
      }
      const { system, user } = a.buildPrompt(input);
      const { text } = await this.deps.llm.complete({ system, user });
      await this.deps.budget.recordCall();
      this.deps.setStatus?.('Running');
      const publish = a.publishOutput
        ? a.publishOutput.bind(a)
        : async (t: string, c: TriggerCtx, d: AnalyzerDeps) =>
            d.publisher.publish(t, { analyzerId: a.id, ctx: c });
      await publish(text, ctx, this.deps);
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
  return true;
}
