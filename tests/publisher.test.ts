import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { batteryAlertPath } from '../src/core/paths.js';
import { ReportPublisher } from '../src/core/publisher.js';
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
    // Reports are informational ('nominal') so `signalk-nmea2000-emitter-cannon`
    // does not emit a PGN 126983 alert; method is visual-only since nominal isn't audible.
    expect(v.state).toBe('nominal');
    expect(v.method).toEqual(['visual']);
    expect(v.message).toBe('the report text');

    const line = (await readFile(logPath, 'utf-8')).trim();
    const entry = JSON.parse(line);
    expect(entry.analyzer).toBe('maintenance');
    expect(entry.trigger).toBe('engine-stop');
    expect(entry.engineId).toBe('port');
    expect(entry.durationSec).toBe(3600);
    expect(entry.report).toBe('the report text');
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
    expect(v.alertId).toBe(0xabcd);
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
