import { appendFile, rename, stat } from 'node:fs/promises';
import { SKVersion } from '@signalk/server-api';
import { ALARM_STATES, type NotificationState } from '../types.js';
import { clampAtWord } from './format.js';
import { stringify } from './logger.js';
import { notificationReportPath } from './paths.js';
import type { PublishRunMeta, TriggerCtx } from './triggerContext.js';

export interface SignalKNotificationValue {
  state: NotificationState;
  method: string[];
  message: string;
  // Stable 16-bit PGN 126983 Alert Identifier; see `alertIdFor` in paths.ts.
  // The field lives both at top level (kept for one release for the existing
  // `signalk-nmea2000-emitter-cannon` consumer that reads `value.alertId`)
  // and under `value.data.alertId`, the SK master extension slot for
  // notification custom data. The top-level form will be removed once the
  // emitter sibling reads from `data`.
  alertId?: number;
  data?: { alertId?: number };
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

// `nominal` is the informational/no-action state in SK 1.8.2; an empty
// method array tells downstream consumers "no user-facing notification".
// The daily/weekly narrative reports (health/aging/drift/liveness/forecast)
// land at `nominal`, so a strict SK client should not pop a visual for them.
function methodFor(state: NotificationState): string[] {
  if (AUDIBLE_STATES.has(state)) return ['visual', 'sound'];
  if (state === 'nominal') return [];
  return ['visual'];
}

// Defensive ceiling for the notification message. Analyzer prompts ask for an
// <=80-char headline; this is well clear of that yet under the ~200-char point
// where `signalk-nmea2000-emitter-cannon` hard-truncates the alert-text PGN.
const HEADLINE_MAX_CHARS = 140;

// The state a failure notice publishes. A run that could not produce a report
// is worth seeing, but it is never itself a hazard, so it must not outrank the
// report it replaces.
const FAILURE_STATE: NotificationState = 'warn';

// Where a state sits on the Signal K severity ladder, from the spec-ordered
// list in types.ts. Used only to compare two states on one path.
function severityRank(state: NotificationState): number {
  return ALARM_STATES.indexOf(state);
}

const FAILURE_STATE_RANK = severityRank(FAILURE_STATE);

// Size at which the JSONL report log rotates. One generation is kept, so the
// log costs at most twice this on disk, and `tailReports` still reads a bounded
// file. Sized so a plugin running at the daily call ceiling holds weeks of
// history before the first rotation.
const DEFAULT_MAX_LOG_BYTES = 8 * 1024 * 1024;

// The chartplotter alert text. Analyzer reports lead with a short headline
// line followed by the full narrative; this returns just that first line
// (clamped at a word boundary), leaving the full text for the JSONL log.
// Exported for tests; the runtime is the only other caller and uses it
// through makeDelta below.
export function headlineOf(text: string): string {
  const trimmed = text.trimStart();
  const nl = trimmed.indexOf('\n');
  const firstLine = (nl < 0 ? trimmed : trimmed.slice(0, nl)).trim();
  return clampAtWord(firstLine, HEADLINE_MAX_CHARS);
}

interface SignalKNotificationDelta {
  context: string;
  updates: Array<{
    $source: string;
    timestamp: string;
    values: Array<{ path: string; value: SignalKNotificationValue }>;
  }>;
}

// app.error is part of the real SK ServerAPI surface and is always present;
// it is not optional here. A test harness that wants to stub it just provides
// a no-op function rather than relying on the publisher to defend missing
// methods.
interface PublisherCfg {
  app: {
    handleMessage(pluginId: string, delta: unknown, skVersion?: SKVersion): void;
    selfContext?: string;
    error(msg: string): void;
  };
  pluginId: string;
  logPath: string;
  // Rotation threshold for the report log, in bytes. Defaults to
  // DEFAULT_MAX_LOG_BYTES; the plugin never sets it and tests use it to reach
  // the rotation path without writing megabytes.
  maxLogBytes?: number;
}

interface PublishMeta {
  analyzerId: string;
  ctx: TriggerCtx;
  run?: PublishRunMeta;
}

// JsonlEntry is the on-disk log row shape; api.ts also reads it to render
// per-analyzer report history, hence the export.
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
  model?: string;
  totalTokens?: number;
  cachedTokens?: number;
  costUsd?: number;
}

// All notification paths this plugin emits are SK v1 (`notifications.*`).
// A future v2-shaped path must pass `SKVersion.v2` to keep it out of the v1
// full data model.
export class ReportPublisher {
  // The state each notification path last carried from a successful report.
  // A failure notice must not lower a standing non-nominal state on the same
  // path: `forecast` publishes its outlook and its failures both on
  // `notifications.openrouter-companion.forecast.report`, so a rate-limited
  // call three hours after a gale alarm would otherwise replace that alarm
  // with a `warn` and drop the `sound` method, clearing a live hazard because
  // a request failed. Held in memory only, which is enough: the plugin is the
  // sole writer of these paths, and a restart republishes before anything can
  // fail against a state this map has forgotten.
  private readonly lastReportState = new Map<string, NotificationState>();

  constructor(private cfg: PublisherCfg) {}

  // Failure notifications always publish on the canonical report path
  // (notifications.openrouter-companion.<id>.report). For a default analyzer
  // that is also where its successful report lands; an analyzer that overrides
  // publishOutput with its own path (alerts publishes per bank) still has its
  // failures collected here on the one canonical channel.
  // `audible` is the failing analyzer's `failureAudible` flag (see
  // Analyzer.failureAudible for the rationale). audible=false emits method
  // ['visual'] (PGN 126983 Silenced); audible=true keeps 'sound' (Active). The
  // 'warn' state keeps the failure visible either way.
  async publishFailure(
    analyzerId: string,
    ctx: TriggerCtx,
    err: unknown,
    opts: { audible?: boolean } = {},
  ): Promise<void> {
    const now = new Date();
    const reason = stringify(err);
    const message = `${analyzerId} report unavailable: ${reason}`;
    const path = notificationReportPath(analyzerId);
    const standing = this.lastReportState.get(path);
    if (standing !== undefined && severityRank(standing) > FAILURE_STATE_RANK) {
      // A report on this path is standing at alarm or emergency. Leave it
      // alone: the weather has not changed because a call failed. The failure
      // is still recorded in the JSONL log the panel reads, and on the server
      // log, so the run is not silently forgotten.
      this.cfg.app.error(`${analyzerId}: ${reason} (holding the standing ${standing})`);
    } else {
      this.cfg.app.handleMessage(
        this.cfg.pluginId,
        this.makeDelta(headlineOf(message), FAILURE_STATE, now, path, {
          method: opts.audible ? ['visual', 'sound'] : ['visual'],
        }),
        SKVersion.v1,
      );
      // What stands on the path now is this failure, not the report it
      // replaced, so a second failure republishes rather than being held.
      this.lastReportState.delete(path);
    }
    await this.appendLog({
      ...this.buildEntry(message, { analyzerId, ctx }, now),
      failure: reason,
    });
  }

  // `displayText` is what goes on the notification value (headline-clamped for
  // the chartplotter). `logText` is what lands in the JSONL log; defaults to
  // displayText for callers that did not narrate separately. The alerts
  // analyzer truncates the message to fit PGN 126985 but the full LLM report
  // belongs in the log so an operator reviewing history sees the reasoning,
  // not just the headline.
  // `method` overrides the state's default audible/visual mapping. The forecast
  // analyzer uses it to publish an outlook the vessel's own telemetry does not
  // corroborate as visual-only, so a graded severity the sensors do not support
  // stays readable without sounding the helm alarm.
  async publishOnPath(
    displayText: string,
    meta: PublishMeta,
    override: {
      path: string;
      state: NotificationState;
      alertId?: number;
      logText?: string;
      method?: string[];
    },
  ): Promise<void> {
    const now = new Date();
    this.cfg.app.handleMessage(
      this.cfg.pluginId,
      this.makeDelta(headlineOf(displayText), override.state, now, override.path, {
        alertId: override.alertId,
        method: override.method,
      }),
      SKVersion.v1,
    );
    this.lastReportState.set(override.path, override.state);
    await this.appendLog(this.buildEntry(override.logText ?? displayText, meta, now));
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
    run?: PublishRunMeta,
  ): Promise<void> {
    await this.publishOnPath(
      text,
      { analyzerId, ctx, run },
      { path: notificationReportPath(analyzerId), state },
    );
  }

  private makeDelta(
    text: string,
    state: NotificationState,
    now: Date,
    path: string,
    opts: { alertId?: number; method?: string[] } = {},
  ): SignalKNotificationDelta {
    const value: SignalKNotificationValue = {
      state,
      // `method` defaults to the state's audible/visual mapping; callers that
      // need a state's normal mapping overridden (failures stay visual-only)
      // pass an explicit method.
      method: opts.method ?? methodFor(state),
      message: text,
    };
    if (opts.alertId !== undefined) {
      // Dual-emit: top-level for the existing emitter-cannon sibling, plus
      // the spec-clean `data` slot. Drop the top-level form once the sibling
      // is updated to read from `value.data.alertId`.
      value.alertId = opts.alertId;
      value.data = { alertId: opts.alertId };
    }
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
    if (meta.run) {
      base.model = meta.run.model;
      base.totalTokens = meta.run.usage.totalTokens;
      base.cachedTokens = meta.run.usage.cachedTokens;
      base.costUsd = meta.run.usage.cost;
    }
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
      await this.rotateIfOversized();
      await appendFile(this.cfg.logPath, `${JSON.stringify(entry)}\n`);
    } catch (err) {
      this.cfg.app.error(`report log append failed: ${stringify(err)}`);
    }
  }

  // Keep the report log bounded. Nothing else trims it, and `tailReports` reads
  // the whole file per request, so an unbounded log would eventually cost both
  // disk and an admin request proportional to the plugin's whole history. One
  // generation is kept as `<log>.1`; the panel reads only the current file, so
  // history immediately after a rotation is short rather than lost. Cheap at
  // this rate: at most a few hundred appends a day.
  private async rotateIfOversized(): Promise<void> {
    const max = this.cfg.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
    let size: number;
    try {
      size = (await stat(this.cfg.logPath)).size;
    } catch {
      // No log yet (the first append creates it), or it is unreadable; either
      // way there is nothing to rotate and the append below reports any real
      // fault.
      return;
    }
    if (size < max) return;
    await rename(this.cfg.logPath, `${this.cfg.logPath}.1`);
  }
}
