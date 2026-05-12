import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TriggerCtx } from '../src/analyzers/Analyzer.js';
import { AlertAnalyzer } from '../src/analyzers/alerts.js';
import { RollingBuffer } from '../src/core/buffer.js';
import { ReportPublisher } from '../src/core/publisher.js';
import {
  cleanupTmpDir,
  type MockApp,
  makeAnalyzerDeps,
  makeMockApp,
  makeTmpDir,
} from './_mocks.js';

function makeCfg(overrides: Partial<{ events: string[] }> = {}) {
  return {
    triggers: {
      cron: { enabled: false, pattern: '', timezone: '' },
      put: { enabled: false, path: '' },
      events: overrides.events ?? [
        'low-soc-enter',
        'low-soc-exit',
        'cell-imbalance-enter',
        'cell-imbalance-exit',
      ],
    },
  };
}

function makeDeps(app: MockApp, buffer: RollingBuffer, publisher: ReportPublisher) {
  return makeAnalyzerDeps(app, buffer, { publisher });
}

describe('AlertAnalyzer', () => {
  let dir: string;
  let app: MockApp;
  beforeEach(async () => {
    dir = await makeTmpDir();
    app = makeMockApp(dir);
  });
  afterEach(async () => {
    await cleanupTmpDir(dir);
  });

  it('declares battery-event triggers from the events array in config', () => {
    const a = new AlertAnalyzer(makeCfg());
    const subkinds = a.triggers
      .filter((t) => t.kind === 'battery-event')
      .map((t) => (t as { kind: 'battery-event'; subkind: string }).subkind)
      .sort();
    expect(subkinds).toEqual([
      'cell-imbalance-enter',
      'cell-imbalance-exit',
      'low-soc-enter',
      'low-soc-exit',
    ]);
  });

  it('omits event subscriptions not listed in config.triggers.events', () => {
    const a = new AlertAnalyzer(makeCfg({ events: ['low-soc-enter'] }));
    const subkinds = a.triggers
      .filter((t) => t.kind === 'battery-event')
      .map((t) => (t as { kind: 'battery-event'; subkind: string }).subkind);
    expect(subkinds).toEqual(['low-soc-enter']);
  });

  it('collectContext returns null without a battery-event ctx', async () => {
    const a = new AlertAnalyzer(makeCfg());
    const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
    const publisher = new ReportPublisher({
      app,
      pluginId: 'orcb',
      notificationPath: 'unused',
      notificationState: 'normal',
      logPath: join(dir, 'reports.jsonl'),
    });
    const ctx: TriggerCtx = { kind: 'cron', firedAt: new Date() };
    expect(await a.collectContext(ctx, makeDeps(app, buf, publisher))).toBeNull();
  });

  it('collectContext builds context for low-soc-enter', async () => {
    const a = new AlertAnalyzer(makeCfg());
    const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
    const publisher = new ReportPublisher({
      app,
      pluginId: 'orcb',
      notificationPath: 'unused',
      notificationState: 'normal',
      logPath: join(dir, 'reports.jsonl'),
    });
    app.setSelfPath('electrical.batteries', {
      house: { voltage: { value: 12.0 }, capacity: { stateOfCharge: { value: 0.25 } } },
    });
    const ctx: TriggerCtx = {
      kind: 'battery-event',
      firedAt: new Date(),
      bankId: 'house',
      batteryEvent: { subkind: 'low-soc-enter', soc: 0.25 },
    };
    const r = await a.collectContext(ctx, makeDeps(app, buf, publisher));
    expect(r).not.toBeNull();
    expect(r?.subkind).toBe('low-soc-enter');
    expect(r?.bankId).toBe('house');
    expect((r?.snapshot as Record<string, unknown>).stateOfCharge).toBe(0.25);
  });

  it('publishOutput sends an alert-state notification on enter events', async () => {
    const a = new AlertAnalyzer(makeCfg());
    const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
    const publisher = new ReportPublisher({
      app,
      pluginId: 'orcb',
      notificationPath: 'unused',
      notificationState: 'normal',
      logPath: join(dir, 'reports.jsonl'),
    });
    const ctx: TriggerCtx = {
      kind: 'battery-event',
      firedAt: new Date(),
      bankId: 'house',
      batteryEvent: { subkind: 'low-soc-enter', soc: 0.25 },
    };
    await a.publishOutput?.('SoC is at 25%, check house bank.', ctx, makeDeps(app, buf, publisher));
    expect(app.published).toHaveLength(1);
    const d = app.published[0]?.delta as {
      updates: { values: { path: string; value: { state: string } }[] }[];
    };
    expect(d.updates[0]?.values[0]?.path).toBe(
      'notifications.openrouter-companion.alert.low-soc-enter',
    );
    expect(d.updates[0]?.values[0]?.value.state).toBe('alert');
    const line = (await readFile(join(dir, 'reports.jsonl'), 'utf-8')).trim();
    expect(JSON.parse(line).analyzer).toBe('alerts');
  });

  it('publishOutput truncates long alert messages to fit PGN 126985 alertTextDescription', async () => {
    const a = new AlertAnalyzer(makeCfg());
    const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
    const publisher = new ReportPublisher({
      app,
      pluginId: 'orcb',
      notificationPath: 'unused',
      notificationState: 'normal',
      logPath: join(dir, 'reports.jsonl'),
    });
    const ctx: TriggerCtx = {
      kind: 'battery-event',
      firedAt: new Date(),
      bankId: 'house',
      batteryEvent: { subkind: 'low-soc-enter', soc: 0.25 },
    };
    const longText = `House bank SoC dropped to 25%. ${'Voltage trending down across all cells with no detectable charging source connected. '.repeat(10)}`;
    expect(longText.length).toBeGreaterThan(220);
    await a.publishOutput?.(longText, ctx, makeDeps(app, buf, publisher));
    const d = app.published[0]?.delta as {
      updates: { values: { path: string; value: { message: string } }[] }[];
    };
    const sentMessage = d.updates[0]?.values[0]?.value.message;
    expect(sentMessage.length).toBeLessThanOrEqual(200);
    expect(sentMessage.endsWith('…')).toBe(true);
    expect(sentMessage.startsWith('House bank SoC dropped to 25%.')).toBe(true);
  });

  it('publishOutput leaves short messages unchanged', async () => {
    const a = new AlertAnalyzer(makeCfg());
    const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
    const publisher = new ReportPublisher({
      app,
      pluginId: 'orcb',
      notificationPath: 'unused',
      notificationState: 'normal',
      logPath: join(dir, 'reports.jsonl'),
    });
    const ctx: TriggerCtx = {
      kind: 'battery-event',
      firedAt: new Date(),
      bankId: 'house',
      batteryEvent: { subkind: 'low-soc-enter', soc: 0.25 },
    };
    const short = 'House bank SoC dropped to 25%, check charging source.';
    await a.publishOutput?.(short, ctx, makeDeps(app, buf, publisher));
    const d = app.published[0]?.delta as {
      updates: { values: { path: string; value: { message: string } }[] }[];
    };
    expect(d.updates[0]?.values[0]?.value.message).toBe(short);
  });

  it('publishOutput sends a normal-state notification on exit events', async () => {
    const a = new AlertAnalyzer(makeCfg());
    const buf = new RollingBuffer({ maxAgeMs: 86_400_000, maxEntriesPerPath: 10_000 });
    const publisher = new ReportPublisher({
      app,
      pluginId: 'orcb',
      notificationPath: 'unused',
      notificationState: 'normal',
      logPath: join(dir, 'reports.jsonl'),
    });
    const ctx: TriggerCtx = {
      kind: 'battery-event',
      firedAt: new Date(),
      bankId: 'house',
      batteryEvent: { subkind: 'low-soc-exit', soc: 0.4 },
    };
    await a.publishOutput?.('SoC recovered to 40%.', ctx, makeDeps(app, buf, publisher));
    const d = app.published[0]?.delta as {
      updates: { values: { path: string; value: { state: string } }[] }[];
    };
    expect(d.updates[0]?.values[0]?.path).toBe(
      'notifications.openrouter-companion.alert.low-soc-exit',
    );
    expect(d.updates[0]?.values[0]?.value.state).toBe('normal');
  });
});
