import { appendFile } from 'node:fs/promises';
import { SKVersion } from '@signalk/server-api';
import type { TriggerCtx } from '../analyzers/Analyzer.js';
import type { NotificationState } from '../types.js';
import { clampAtWord } from './format.js';
import { stringify } from './logger.js';
import { notificationReportPath } from './paths.js';

export interface SignalKNotificationValue {
  state: NotificationState;
  method: string[];
  message: string;
  // Stable 16-bit PGN 126983 Alert Identifier; see `alertIdFor` in paths.ts.
  alertId?: number;
}

// SK states that warrant an audible NMEA 2000 alarm on the chartplotter.
// `signalk-nmea2000-emitter-cannon` maps `value.method` to PGN 126983's
// "Alert State": method includes 'sound' -> Active; method nonempty without
// 'sound' -> Silenced; method empty -> Acknowledged. We want Active for any
// non-informational state.
const AUDIBLE_STATES: ReadonlySet<NotificationState> = new Set([
  'alert',
  'alarm',
  'emergency',
  'warn',
]);

function methodFor(state: NotificationState): string[] {
  return AUDIBLE_STATES.has(state) ? ['visual', 'sound'] : ['visual'];
}

// Defensive ceiling for the notification message. Analyzer prompts ask for an
// <=80-char headline; this is well clear of that yet under the ~200-char point
// where `signalk-nmea2000-emitter-cannon` hard-truncates the alert-text PGN.
const HEADLINE_MAX_CHARS = 140;

// The chartplotter alert text. Analyzer reports lead with a short headline
// line followed by the full narrative; this returns just that first line
// (clamped at a word boundary), leaving the full text for the JSONL log.
export function headlineOf(text: string): string {
  const trimmed = text.trimStart();
  const nl = trimmed.indexOf('\n');
  const firstLine = (nl < 0 ? trimmed : trimmed.slice(0, nl)).trim();
  return clampAtWord(firstLine, HEADLINE_MAX_CHARS);
}

export interface SignalKNotificationDelta {
  context: string;
  updates: Array<{
    $source: string;
    timestamp: string;
    values: Array<{ path: string; value: SignalKNotificationValue }>;
  }>;
}

export interface PublisherCfg {
  app: {
    handleMessage(pluginId: string, delta: unknown, skVersion?: SKVersion): void;
    selfContext?: string;
    error?(msg: string): void;
  };
  pluginId: string;
  logPath: string;
}

export interface PublishMeta {
  analyzerId: string;
  ctx: TriggerCtx;
}

export interface JsonlEntry {
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

  // SKVersion.v1: all notification paths this plugin emits live in v1.
  // Failure notifications always publish on the canonical report path
  // (notifications.openrouter-companion.<id>.report). For a default analyzer
  // that is also where its successful report lands; an analyzer that overrides
  // publishOutput with its own path (alerts publishes per bank) still has its
  // failures collected here on the one canonical channel.
  async publishFailure(analyzerId: string, ctx: TriggerCtx, err: unknown): Promise<void> {
    const now = new Date();
    const reason = stringify(err);
    const message = `${analyzerId} report unavailable: ${reason}`;
    this.cfg.app.handleMessage(
      this.cfg.pluginId,
      this.makeDelta(headlineOf(message), 'warn', now, notificationReportPath(analyzerId)),
      SKVersion.v1,
    );
    await this.appendLog({
      ...this.buildEntry(message, { analyzerId, ctx }, now),
      failure: reason,
    });
  }

  async publishOnPath(
    text: string,
    meta: PublishMeta,
    override: { path: string; state: NotificationState; alertId?: number },
  ): Promise<void> {
    const now = new Date();
    this.cfg.app.handleMessage(
      this.cfg.pluginId,
      this.makeDelta(headlineOf(text), override.state, now, override.path, override.alertId),
      SKVersion.v1,
    );
    await this.appendLog(this.buildEntry(text, meta, now));
  }

  // Default state is 'nominal' (informational): per SK 1.8.2, 'nominal' is the
  // no-action state, while 'normal' means "recovered after an alarm". The
  // narrative-report analyzers (maintenance/health/aging/drift) are pure info
  // dumps so `signalk-nmea2000-emitter-cannon` should NOT emit an N2K alert PGN for them; passing
  // 'nominal' achieves that because `signalk-nmea2000-emitter-cannon`'s alertTypes table has no entry
  // for nominal and the PGN is suppressed.
  async publishReport(
    analyzerId: string,
    ctx: TriggerCtx,
    text: string,
    state: NotificationState = 'nominal',
  ): Promise<void> {
    await this.publishOnPath(
      text,
      { analyzerId, ctx },
      { path: notificationReportPath(analyzerId), state },
    );
  }

  private makeDelta(
    text: string,
    state: NotificationState,
    now: Date,
    path: string,
    alertId?: number,
  ): SignalKNotificationDelta {
    const value: SignalKNotificationValue = {
      state,
      method: methodFor(state),
      message: text,
    };
    if (alertId !== undefined) value.alertId = alertId;
    return {
      context: this.cfg.app.selfContext ?? 'vessels.self',
      updates: [
        {
          $source: this.cfg.pluginId,
          timestamp: now.toISOString(),
          values: [{ path, value }],
        },
      ],
    };
  }

  private buildEntry(text: string, meta: PublishMeta, now: Date): JsonlEntry {
    const base: JsonlEntry = {
      ts: now.toISOString(),
      analyzer: meta.analyzerId,
      trigger: meta.ctx.kind,
      report: text,
    };
    const sess = meta.ctx.engineSession;
    if (!sess) return base;
    return {
      ...base,
      engineId: sess.engineId,
      sessionStart: sess.start.toISOString(),
      sessionEnd: sess.end.toISOString(),
      durationSec: sess.durationSec,
    };
  }

  // The JSONL report log is best-effort bookkeeping. A write failure must not
  // reject the publish: the notification delta has already gone out via
  // handleMessage, and rejecting here would make the router treat a delivered
  // report as an analysis failure and overwrite it with a warn. Surface the
  // failure on the server log instead of swallowing it.
  private async appendLog(entry: JsonlEntry): Promise<void> {
    try {
      await appendFile(this.cfg.logPath, `${JSON.stringify(entry)}\n`);
    } catch (err) {
      this.cfg.app.error?.(`report log append failed: ${stringify(err)}`);
    }
  }
}
