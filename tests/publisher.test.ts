import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { batteryAlertPath } from '../src/core/paths.js';
import { headlineOf, ReportPublisher } from '../src/core/publisher.js';
import {
  cleanupTmpDir,
  firstNotificationValue,
  type MockApp,
  makeMockApp,
  makeTmpDir,
} from './_mocks.js';

describe('ReportPublisher', () => {
  let dir: string;
  let app: MockApp;
  let logPath: string;
  let publisher: ReportPublisher;
  beforeEach(async () => {
    dir = await makeTmpDir();
    app = makeMockApp(dir);
    logPath = join(dir, 'reports.jsonl');
    publisher = new ReportPublisher({ app, pluginId: 'orc', logPath });
  });
  afterEach(async () => {
    await cleanupTmpDir(dir);
  });

  it('publishReport emits a nominal-state notification on the canonical report path', async () => {
    await publisher.publishReport(
      'maintenance',
      {
        kind: 'engine-stop',
        firedAt: new Date('2026-05-10T10:00:00Z'),
        engineSession: {
          engineId: 'port',
          start: new Date('2026-05-10T09:00:00Z'),
          end: new Date('2026-05-10T10:00:00Z'),
          durationSec: 3600,
        },
      },
      'the report text',
    );
    expect(app.published).toHaveLength(1);
    const first = app.published[0];
    if (!first) throw new Error('expected one published delta');
    expect(first.pluginId).toBe('orc');
    const v = firstNotificationValue(first.delta);
    expect(v.path).toBe('notifications.openrouter-companion.maintenance.report');
    // Reports are informational ('nominal'), which per SK 1.8.2 is the
    // no-action state: method is empty so strict consumers do not pop a
    // visual notification for a routine cron-fired report.
    expect(v.state).toBe('nominal');
    expect(v.method).toEqual([]);
    expect(v.message).toBe('the report text');

    const line = (await readFile(logPath, 'utf-8')).trim();
    const entry = JSON.parse(line);
    expect(entry.analyzer).toBe('maintenance');
    expect(entry.trigger).toBe('engine-stop');
    expect(entry.engineId).toBe('port');
    expect(entry.durationSec).toBe(3600);
    expect(entry.report).toBe('the report text');
  });

  it('sends only the headline to the notification but logs the full report', async () => {
    const full =
      'Starter and console banks show no charging.\n\nThis session recorded steady voltages across all banks; the starter bank held 13.24 V at 70 percent state of charge with a modest discharge.';
    await publisher.publishReport(
      'health',
      { kind: 'cron', firedAt: new Date('2026-05-10T08:00:00Z') },
      full,
    );
    const v = firstNotificationValue(app.published[0]?.delta);
    // The chartplotter notification carries only the short headline line.
    expect(v.message).toBe('Starter and console banks show no charging.');
    // The JSONL log keeps the full multi-paragraph report.
    const entry = JSON.parse((await readFile(logPath, 'utf-8')).trim());
    expect(entry.report).toBe(full);
  });

  it('publishOnPath emits on the override path with the override state and audible method for alerts', async () => {
    const path = batteryAlertPath('house', 'lowSoc');
    await publisher.publishOnPath(
      'soc dropped',
      {
        analyzerId: 'alerts',
        ctx: {
          kind: 'battery-event',
          firedAt: new Date('2026-05-10T10:00:00Z'),
          bankId: 'house',
          batteryEvent: { subkind: 'low-soc-enter', soc: 0.25 },
        },
      },
      { path, state: 'alert', alertId: 0xabcd },
    );
    expect(app.published).toHaveLength(1);
    const v = firstNotificationValue(app.published[0]?.delta);
    expect(v.path).toBe(path);
    expect(v.state).toBe('alert');
    // alert state -> audible so `signalk-nmea2000-emitter-cannon` emits PGN 126983 with Active alertState.
    expect(v.method).toEqual(['visual', 'sound']);
    expect(v.message).toBe('soc dropped');
    // Dual-emit: the spec-clean `data.alertId` AND the legacy top-level
    // `alertId` both carry the id during the one-release transition. The
    // sibling emitter-cannon will migrate to `data.alertId`; locking both
    // here prevents a refactor from silently dropping the data slot before
    // the sibling has migrated.
    expect(v.alertId).toBe(0xabcd);
    expect((v as { data?: { alertId?: number } }).data?.alertId).toBe(0xabcd);
  });

  it('publishOnPath writes the full text to the JSONL log when logText is supplied', async () => {
    const path = batteryAlertPath('house', 'lowSoc');
    const truncated = 'House SoC 25%';
    const full =
      'House bank dropped to 25% state of charge. The discharge curve over the last 90 minutes is steeper than typical, suggesting either a sudden load step or a faulty cell beginning to lose capacity.';
    await publisher.publishOnPath(
      truncated,
      {
        analyzerId: 'alerts',
        ctx: {
          kind: 'battery-event',
          firedAt: new Date('2026-05-10T10:00:00Z'),
          bankId: 'house',
          batteryEvent: { subkind: 'low-soc-enter', soc: 0.25 },
        },
      },
      { path, state: 'alert', logText: full },
    );
    // The notification value carries the chartplotter-safe truncated headline.
    const v = firstNotificationValue(app.published[0]?.delta);
    expect(v.message).toBe(truncated);
    // The JSONL log carries the full LLM reasoning, not the truncated headline.
    const entry = JSON.parse((await readFile(logPath, 'utf-8')).trim());
    expect(entry.report).toBe(full);
  });

  it('still publishes and stays resolved when the JSONL log append fails', async () => {
    // logPath points into a directory that does not exist: appendFile rejects.
    const badPublisher = new ReportPublisher({
      app,
      pluginId: 'orc',
      logPath: join(dir, 'no-such-subdir', 'reports.jsonl'),
    });
    await expect(
      badPublisher.publishReport('health', { kind: 'cron', firedAt: new Date() }, 'body'),
    ).resolves.toBeUndefined();
    // The notification delta still went out, and the log failure surfaced on
    // the server log rather than rejecting the publish.
    expect(app.published).toHaveLength(1);
    expect(app.appErrorMessages.some((m) => m.includes('log append failed'))).toBe(true);
  });

  it('publishFailure emits a warn-state notification on the analyzer report path', async () => {
    await publisher.publishFailure(
      'maintenance',
      {
        kind: 'engine-stop',
        firedAt: new Date(),
      },
      new Error('upstream 503'),
    );
    expect(app.published).toHaveLength(1);
    const v = firstNotificationValue(app.published[0]?.delta);
    expect(v.path).toBe('notifications.openrouter-companion.maintenance.report');
    expect(v.state).toBe('warn');
    // warn state is audible so the chartplotter user actually notices the LLM failed.
    expect(v.method).toEqual(['visual', 'sound']);
    expect(v.message).toContain('upstream 503');
  });
});

describe('headlineOf', () => {
  it('returns the first line of a multi-line report', () => {
    expect(headlineOf('A short headline.\n\nThe long body paragraph.')).toBe('A short headline.');
  });

  it('returns a single-line report unchanged', () => {
    expect(headlineOf('Just one line.')).toBe('Just one line.');
  });

  it('clamps an over-long headline at a word boundary', () => {
    const out = headlineOf(`${'word '.repeat(60)}end`);
    expect(out.length).toBeLessThanOrEqual(140);
    expect(out.endsWith(' ')).toBe(false);
  });
});
