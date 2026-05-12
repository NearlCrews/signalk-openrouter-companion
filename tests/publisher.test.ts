import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { batteryAlertPath } from '../src/core/paths.js';
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

  it('publishReport emits a nominal-state notification on the canonical report path', async () => {
    const logPath = join(dir, 'reports.jsonl');
    const p = new ReportPublisher({ app, pluginId: 'orc', logPath });
    await p.publishReport(
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
    const { pluginId, delta } = first;
    expect(pluginId).toBe('orc');
    const d = delta as {
      updates: {
        values: { path: string; value: { state: string; method: string[]; message: string } }[];
      }[];
    };
    expect(d.updates[0]?.values[0]?.path).toBe(
      'notifications.openrouter-companion.maintenance.report',
    );
    // Reports are informational ('nominal') so cannon does not emit a PGN
    // 126983 alert; method is visual-only since nominal isn't audible.
    expect(d.updates[0]?.values[0]?.value.state).toBe('nominal');
    expect(d.updates[0]?.values[0]?.value.method).toEqual(['visual']);
    expect(d.updates[0]?.values[0]?.value.message).toBe('the report text');

    const line = (await readFile(logPath, 'utf-8')).trim();
    const entry = JSON.parse(line);
    expect(entry.analyzer).toBe('maintenance');
    expect(entry.trigger).toBe('engine-stop');
    expect(entry.engineId).toBe('port');
    expect(entry.durationSec).toBe(3600);
    expect(entry.report).toBe('the report text');
  });

  it('publishOnPath emits on the override path with the override state and audible method for alerts', async () => {
    const logPath = join(dir, 'reports.jsonl');
    const p = new ReportPublisher({ app, pluginId: 'orc', logPath });
    const path = batteryAlertPath('house', 'lowSoc');
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
      { path, state: 'alert', alertId: 0xabcd },
    );
    expect(app.published).toHaveLength(1);
    const d = app.published[0]?.delta as {
      updates: {
        values: {
          path: string;
          value: { state: string; method: string[]; message: string; alertId?: number };
        }[];
      }[];
    };
    expect(d.updates[0]?.values[0]?.path).toBe(path);
    expect(d.updates[0]?.values[0]?.value.state).toBe('alert');
    // alert state -> audible so cannon emits PGN 126983 with Active alertState.
    expect(d.updates[0]?.values[0]?.value.method).toEqual(['visual', 'sound']);
    expect(d.updates[0]?.values[0]?.value.message).toBe('soc dropped');
    expect(d.updates[0]?.values[0]?.value.alertId).toBe(0xabcd);
  });

  it('publishFailure emits a warn-state notification on the analyzer report path', async () => {
    const logPath = join(dir, 'reports.jsonl');
    const p = new ReportPublisher({ app, pluginId: 'orc', logPath });
    await p.publishFailure(
      'maintenance',
      {
        kind: 'engine-stop',
        firedAt: new Date(),
      },
      new Error('upstream 503'),
    );
    expect(app.published).toHaveLength(1);
    const d = app.published[0]?.delta as {
      updates: {
        values: { path: string; value: { state: string; message: string; method: string[] } }[];
      }[];
    };
    expect(d.updates[0]?.values[0]?.path).toBe(
      'notifications.openrouter-companion.maintenance.report',
    );
    expect(d.updates[0]?.values[0]?.value.state).toBe('warn');
    // warn state is audible so the chartplotter user actually notices the LLM failed.
    expect(d.updates[0]?.values[0]?.value.method).toEqual(['visual', 'sound']);
    expect(d.updates[0]?.values[0]?.value.message).toContain('upstream 503');
  });
});
