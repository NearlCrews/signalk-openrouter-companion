import { appendFile } from 'node:fs/promises';
import type { TriggerCtx } from '../analyzers/Analyzer.js';
import { stringify } from './logger.js';

export type NotificationState = 'normal' | 'nominal' | 'warn';

export interface PublisherCfg {
  app: { handleMessage(pluginId: string, delta: unknown): void };
  pluginId: string;
  notificationPath: string;
  notificationState: NotificationState;
  logPath: string;
}

export interface PublishMeta {
  analyzerId: string;
  ctx: TriggerCtx;
}

interface JsonlEntry {
  ts: string;
  analyzer: string;
  trigger: string;
  engineId?: string;
  sessionStart?: string;
  sessionEnd?: string;
  durationSec?: number;
  report: string;
  failure?: string;
}

export class ReportPublisher {
  constructor(private cfg: PublisherCfg) {}

  async publish(text: string, meta: PublishMeta): Promise<void> {
    const now = new Date();
    this.cfg.app.handleMessage(
      this.cfg.pluginId,
      this.makeDelta(text, this.cfg.notificationState, now, meta),
    );
    await this.appendLog(this.buildEntry(text, meta, now));
  }

  async publishFailure(analyzerId: string, ctx: TriggerCtx, err: unknown): Promise<void> {
    const now = new Date();
    const reason = stringify(err);
    const message = `${analyzerId} report unavailable: ${reason}`;
    this.cfg.app.handleMessage(
      this.cfg.pluginId,
      this.makeDelta(message, 'warn', now, { analyzerId, ctx }),
    );
    await this.appendLog({
      ...this.buildEntry(message, { analyzerId, ctx }, now),
      failure: reason,
    });
  }

  private makeDelta(text: string, state: NotificationState, now: Date, meta: PublishMeta): unknown {
    return {
      updates: [
        {
          timestamp: now.toISOString(),
          values: [
            {
              path: this.cfg.notificationPath,
              value: {
                state,
                method: ['visual'],
                message: text,
                id: `${meta.analyzerId}-${now.getTime()}`,
              },
            },
          ],
        },
      ],
    };
  }

  private buildEntry(text: string, meta: PublishMeta, now: Date): JsonlEntry {
    const entry: JsonlEntry = {
      ts: now.toISOString(),
      analyzer: meta.analyzerId,
      trigger: meta.ctx.kind,
      report: text,
    };
    if (meta.ctx.engineSession) {
      entry.engineId = meta.ctx.engineSession.engineId;
      entry.sessionStart = meta.ctx.engineSession.start.toISOString();
      entry.sessionEnd = meta.ctx.engineSession.end.toISOString();
      entry.durationSec = meta.ctx.engineSession.durationSec;
    }
    return entry;
  }

  private async appendLog(entry: JsonlEntry): Promise<void> {
    await appendFile(this.cfg.logPath, `${JSON.stringify(entry)}\n`);
  }
}
