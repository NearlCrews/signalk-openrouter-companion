import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReportPublisher } from '../src/core/publisher.js';
import { cleanupTmpDir, type MockApp, makeMockApp, makeTmpDir } from './_mocks.js';

describe('ReportPublisher', () => {
  let dir: string;
  let app: MockApp;
  beforeEach(async () => {
    dir = await makeTmpDir();
    app = makeMockApp(dir);
  });
  afterEach(async () => {
    await cleanupTmpDir(dir);
  });

  it('publishes a notification delta and writes a JSONL log line', async () => {
    const logPath = join(dir, 'reports.jsonl');
    const p = new ReportPublisher({
      app,
      pluginId: 'orc',
      notificationPath: 'notifications.x.report',
      notificationState: 'normal',
      logPath,
    });
    await p.publish('the report text', {
      analyzerId: 'maintenance',
      ctx: {
        kind: 'engine-stop',
        firedAt: new Date('2026-05-10T10:00:00Z'),
        engineSession: {
          engineId: 'port',
          start: new Date('2026-05-10T09:00:00Z'),
          end: new Date('2026-05-10T10:00:00Z'),
          durationSec: 3600,
        },
      },
    });
    expect(app.published).toHaveLength(1);
    const { pluginId, delta } = app.published[0]!;
    expect(pluginId).toBe('orc');
    const d = delta as {
      updates: {
        values: { path: string; value: { state: string; method: string[]; message: string } }[];
      }[];
    };
    expect(d.updates[0]!.values[0]!.path).toBe('notifications.x.report');
    expect(d.updates[0]!.values[0]!.value.state).toBe('normal');
    expect(d.updates[0]!.values[0]!.value.method).toEqual(['visual']);
    expect(d.updates[0]!.values[0]!.value.message).toBe('the report text');

    const line = (await readFile(logPath, 'utf-8')).trim();
    const entry = JSON.parse(line);
    expect(entry.analyzer).toBe('maintenance');
    expect(entry.trigger).toBe('engine-stop');
    expect(entry.engineId).toBe('port');
    expect(entry.durationSec).toBe(3600);
    expect(entry.report).toBe('the report text');
  });

  it('publishOnPath emits on the override path with the override state', async () => {
    const logPath = join(dir, 'reports.jsonl');
    const p = new ReportPublisher({
      app,
      pluginId: 'orc',
      notificationPath: 'notifications.default.report',
      notificationState: 'normal',
      logPath,
    });
    await p.publishOnPath(
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
      { path: 'notifications.openrouter-companion.alert.low-soc-enter', state: 'alert' },
    );
    expect(app.published).toHaveLength(1);
    const d = app.published[0]!.delta as {
      updates: { values: { path: string; value: { state: string; message: string } }[] }[];
    };
    expect(d.updates[0]!.values[0]!.path).toBe(
      'notifications.openrouter-companion.alert.low-soc-enter',
    );
    expect(d.updates[0]!.values[0]!.value.state).toBe('alert');
    expect(d.updates[0]!.values[0]!.value.message).toBe('soc dropped');
  });

  it('publishFailure emits a warn-state notification', async () => {
    const logPath = join(dir, 'reports.jsonl');
    const p = new ReportPublisher({
      app,
      pluginId: 'orc',
      notificationPath: 'notifications.x.report',
      notificationState: 'normal',
      logPath,
    });
    await p.publishFailure(
      'maintenance',
      {
        kind: 'engine-stop',
        firedAt: new Date(),
      },
      new Error('upstream 503'),
    );
    expect(app.published).toHaveLength(1);
    const d = app.published[0]!.delta as {
      updates: { values: { value: { state: string; message: string } }[] }[];
    };
    expect(d.updates[0]!.values[0]!.value.state).toBe('warn');
    expect(d.updates[0]!.values[0]!.value.message).toContain('upstream 503');
  });
});
