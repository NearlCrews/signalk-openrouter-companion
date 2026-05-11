import type { TriggerCtx } from '../analyzers/Analyzer.js';

export interface PublishMeta {
  analyzerId: string;
  ctx: TriggerCtx;
}

export class ReportPublisher {
  publish(_text: string, _meta: PublishMeta): Promise<void> {
    throw new Error('not implemented');
  }

  publishFailure(_analyzerId: string, _ctx: TriggerCtx, _err: unknown): Promise<void> {
    throw new Error('not implemented');
  }
}
