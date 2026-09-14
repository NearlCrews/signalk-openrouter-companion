import { appendFile, rename, stat } from 'node:fs/promises';
import { SKVersion } from '@signalk/server-api';
import { type NotificationState, severityRank } from '../types.js';
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
// `audible` is the caller's choice for a state that would otherwise sound the
// helm alarm: a failure notice and an outlook the vessel's own telemetry does
// not corroborate both stay readable without beeping. It is the only thing a
// caller may say about the method, so the state-to-method mapping stays here,
// and each entry point states its own default rather than inheriting one.
function methodFor(state: NotificationState, audible: boolean): string[] {
  if (state === 'nominal') return [];
  if (audible && AUDIBLE_STATES.has(state)) return ['visual', 'sound'];
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

  // Bytes in the current log generation, or null until the first append of this
  // process stats the file. See rotateIfOversized.
  private logBytes: number | null = null;

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
        // A failure notice is silent unless the analyzer asked otherwise: a
        // failed monthly summary must not sound the helm alarm.
        this.makeDelta(headlineOf(message), FAILURE_STATE, now, path, {
          audible: opts.audible === true,
        }),
        SKVersion.v1,
      );
      // What stands on the path now is this failure, not the report it
      // replaced. `warn` does not outrank itself, so a second failure
      // republishes rather than being held, and the next successful report
      // publishes the `normal` that clears this notice.
      this.lastReportState.set(path, FAILURE_STATE);
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
  // `audible` is the same choice `publishFailure` takes: false keeps a state
  // that would otherwise sound the helm alarm visual-only. The forecast
  // analyzer publishes an outlook its own telemetry does not corroborate that
  // way, so a graded severity the sensors do not support stays readable
  // without beeping.
  async publishOnPath(
    displayText: string,
    meta: PublishMeta,
    override: {
      path: string;
      state: NotificationState;
      alertId?: number;
      logText?: string;
      audible?: boolean;
    },
  ): Promise<void> {
    const now = new Date();
    const state = this.resolveRecovery(override.path, override.state);
    this.cfg.app.handleMessage(
      this.cfg.pluginId,
      this.makeDelta(headlineOf(displayText), state, now, override.path, {
        alertId: override.alertId,
        // A report publishes at its state's own method unless the caller says
        // otherwise: the alerts analyzer's per-bank alarm is meant to be heard.
        audible: override.audible ?? true,
      }),
      SKVersion.v1,
    );
    this.lastReportState.set(override.path, state);
    await this.appendLog(this.buildEntry(override.logText ?? displayText, meta, now));
  }

  // Signal K separates `nominal` ("no action needed", and never alarmed) from
  // `normal` ("recovered after an alarm"), and
  // `signalk-nmea2000-emitter-cannon` has no alertTypes entry for `nominal`, so
  // it suppresses the PGN: a recovery published as `nominal` emits nothing on
  // the bus and never clears the chartplotter's alert. This class already knows
  // what stands on each path, so the first `nominal` after anything that raised
  // becomes that recovery and every analyzer gets the behavior without keeping
  // a flag of its own. `normal` is itself the recovery, so the one after it is
  // a plain `nominal` again.
  private resolveRecovery(path: string, state: NotificationState): NotificationState {
    if (state !== 'nominal') return state;
    const standing = this.lastReportState.get(path);
    return standing === undefined || standing === 'nominal' || standing === 'normal'
      ? state
      : 'normal';
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
    opts: { alertId?: number; audible: boolean },
  ): SignalKNotificationDelta {
    const value: SignalKNotificationValue = {
      state,
      method: methodFor(state, opts.audible),
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
    const line = `${JSON.stringify(entry)}\n`;
    try {
      await this.rotateIfOversized();
      await appendFile(this.cfg.logPath, line);
      this.logBytes = (this.logBytes ?? 0) + Buffer.byteLength(line);
    } catch (err) {
      // A failed append leaves the running total where it was, which is what
      // the file still holds.
      this.cfg.app.error(`report log append failed: ${stringify(err)}`);
    }
  }

  // Keep the report log bounded. Nothing else trims it, so an unbounded log
  // would eventually cost both disk and a growing admin request. One generation
  // is kept as `<log>.1`; the panel reads only the current file, so history
  // immediately after a rotation is short rather than lost.
  //
  // The size is stat'd once per plugin start and then tracked by what this
  // publisher writes, because the rotation fires about once a year at a few
  // hundred rows a day and a stat before every append is a filesystem round
  // trip that learns nothing. The plugin is the sole writer of this file.
  private async rotateIfOversized(): Promise<void> {
    if (this.logBytes === null) {
      try {
        this.logBytes = (await stat(this.cfg.logPath)).size;
      } catch {
        // No log yet (the first append creates it), or it is unreadable; either
        // way there is nothing to rotate and the append reports any real fault.
        this.logBytes = 0;
        return;
      }
    }
    if (this.logBytes < (this.cfg.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES)) return;
    await rename(this.cfg.logPath, `${this.cfg.logPath}.1`);
    this.logBytes = 0;
  }
}
