import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TriggerCtx } from '../src/analyzers/Analyzer.js';
import { AlertAnalyzer } from '../src/analyzers/alerts.js';
import type { RollingBuffer } from '../src/core/buffer.js';
import { Logger } from '../src/core/logger.js';
import { ReportPublisher } from '../src/core/publisher.js';
import {
  cleanupTmpDir,
  firstNotificationValue,
  type MockApp,
  makeAnalyzerDeps,
  makeBuffer,
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
    const buf = makeBuffer();
    const publisher = new ReportPublisher({
      app,
      pluginId: 'orcb',
      logPath: join(dir, 'reports.jsonl'),
    });
    const ctx: TriggerCtx = { kind: 'cron', firedAt: new Date() };
    expect(await a.collectContext(ctx, makeDeps(app, buf, publisher))).toBeNull();
  });

  it('collectContext builds context for low-soc-enter', async () => {
    const a = new AlertAnalyzer(makeCfg());
    const buf = makeBuffer();
    const publisher = new ReportPublisher({
      app,
      pluginId: 'orcb',
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
    const buf = makeBuffer();
    const publisher = new ReportPublisher({
      app,
      pluginId: 'orcb',
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
    const v = firstNotificationValue(app.published[0]?.delta);
    expect(v.path).toBe('notifications.electrical.batteries.house.lowSoc');
    expect(v.state).toBe('alert');
    // alert state -> method includes 'sound' so `signalk-nmea2000-emitter-cannon` emits Active PGN 126983.
    expect(v.method).toEqual(['visual', 'sound']);
    // Stable, nonzero 16-bit alertId derived from the path.
    expect(typeof v.alertId).toBe('number');
    const line = (await readFile(join(dir, 'reports.jsonl'), 'utf-8')).trim();
    expect(JSON.parse(line).analyzer).toBe('alerts');
  });

  it('publishOutput truncates long alert messages to fit PGN 126985 alertTextDescription', async () => {
    const a = new AlertAnalyzer(makeCfg());
    const buf = makeBuffer();
    const publisher = new ReportPublisher({
      app,
      pluginId: 'orcb',
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
    const sent = firstNotificationValue(app.published[0]?.delta).message;
    // Cap is 64 chars; the previous 200 assertion was a no-op (the wire spec
    // ceiling, not the plugin's truncation budget).
    expect(sent.length).toBeLessThanOrEqual(64);
    expect(sent.endsWith('…')).toBe(true);
    expect(sent.startsWith('House bank SoC dropped to 25%.')).toBe(true);
  });

  it('publishOutput leaves short messages unchanged', async () => {
    const a = new AlertAnalyzer(makeCfg());
    const buf = makeBuffer();
    const publisher = new ReportPublisher({
      app,
      pluginId: 'orcb',
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
    expect(firstNotificationValue(app.published[0]?.delta).message).toBe(short);
  });

  it('publishOutput sends a normal-state notification on exit events', async () => {
    const a = new AlertAnalyzer(makeCfg());
    const buf = makeBuffer();
    const publisher = new ReportPublisher({
      app,
      pluginId: 'orcb',
      logPath: join(dir, 'reports.jsonl'),
    });
    const ctx: TriggerCtx = {
      kind: 'battery-event',
      firedAt: new Date(),
      bankId: 'house',
      batteryEvent: { subkind: 'low-soc-exit', soc: 0.4 },
    };
    await a.publishOutput?.('SoC recovered to 40%.', ctx, makeDeps(app, buf, publisher));
    const v = firstNotificationValue(app.published[0]?.delta);
    // Exit re-uses the same canonical per-bank path as enter, with state=normal.
    expect(v.path).toBe('notifications.electrical.batteries.house.lowSoc');
    expect(v.state).toBe('normal');
    // Exit is visual-only so `signalk-nmea2000-emitter-cannon` clears the cached PGN without re-pinging audible.
    expect(v.method).toEqual(['visual']);
  });

  it('collectContext and buildPrompt surface the cell-imbalance line for imbalance events', async () => {
    const a = new AlertAnalyzer(makeCfg());
    const buf = makeBuffer();
    const publisher = new ReportPublisher({
      app,
      pluginId: 'orcb',
      logPath: join(dir, 'reports.jsonl'),
    });
    app.setSelfPath('electrical.batteries', {
      starter: { voltage: { value: 12.8 }, capacity: { stateOfCharge: { value: 0.9 } } },
    });
    const ctx: TriggerCtx = {
      kind: 'battery-event',
      firedAt: new Date(),
      bankId: 'starter',
      batteryEvent: { subkind: 'cell-imbalance-enter', imbalanceV: 0.12 },
    };
    const input = await a.collectContext(ctx, makeDeps(app, buf, publisher));
    if (input == null) throw new Error('expected a cell-imbalance input');
    expect(input.subkind).toBe('cell-imbalance-enter');
    expect(input.eventData.imbalanceV).toBe(0.12);
    const prompt = a.buildPrompt(input);
    // fmtUnit renders to 3 decimals: 0.12 becomes 0.120 V.
    expect(prompt.user).toContain('Triggering cell imbalance: 0.120 V');
    expect(prompt.user).toContain('Bank: starter');
    // The SoC line is omitted when the event carries no soc.
    expect(prompt.user).not.toContain('Triggering SoC:');
  });

  it('publishOutput sends an alert-state notification on the cellImbalance path for enter events', async () => {
    const a = new AlertAnalyzer(makeCfg());
    const buf = makeBuffer();
    const publisher = new ReportPublisher({
      app,
      pluginId: 'orcb',
      logPath: join(dir, 'reports.jsonl'),
    });
    const ctx: TriggerCtx = {
      kind: 'battery-event',
      firedAt: new Date(),
      bankId: 'starter',
      batteryEvent: { subkind: 'cell-imbalance-enter', imbalanceV: 0.12 },
    };
    await a.publishOutput?.('Starter cell imbalance 0.12 V.', ctx, makeDeps(app, buf, publisher));
    expect(app.published).toHaveLength(1);
    const v = firstNotificationValue(app.published[0]?.delta);
    // Cell-imbalance events route to their own per-bank canonical path, distinct
    // from the lowSoc path, so each gets its own PGN 126983 cache slot.
    expect(v.path).toBe('notifications.electrical.batteries.starter.cellImbalance');
    expect(v.state).toBe('alert');
    expect(v.method).toEqual(['visual', 'sound']);
    expect(typeof v.alertId).toBe('number');
  });

  it('publishOutput sends a normal-state cell-imbalance notification on exit events', async () => {
    const a = new AlertAnalyzer(makeCfg());
    const buf = makeBuffer();
    const publisher = new ReportPublisher({
      app,
      pluginId: 'orcb',
      logPath: join(dir, 'reports.jsonl'),
    });
    const ctx: TriggerCtx = {
      kind: 'battery-event',
      firedAt: new Date(),
      bankId: 'starter',
      batteryEvent: { subkind: 'cell-imbalance-exit', imbalanceV: 0.01 },
    };
    await a.publishOutput?.('Starter cells balanced.', ctx, makeDeps(app, buf, publisher));
    const v = firstNotificationValue(app.published[0]?.delta);
    // Exit re-uses the same cellImbalance path as enter, with state=normal.
    expect(v.path).toBe('notifications.electrical.batteries.starter.cellImbalance');
    expect(v.state).toBe('normal');
    expect(v.method).toEqual(['visual']);
  });

  it('publishOutput discards the result and logs when subkind or bankId is missing', async () => {
    const a = new AlertAnalyzer(makeCfg());
    const buf = makeBuffer();
    const publisher = new ReportPublisher({
      app,
      pluginId: 'orcb',
      logPath: join(dir, 'reports.jsonl'),
    });
    const errorSpy = vi.fn();
    const deps = {
      ...makeDeps(app, buf, publisher),
      logger: new Logger({ debug: vi.fn(), error: errorSpy }),
    };
    // A battery-event ctx with no batteryEvent leaves subkind undefined, so the
    // guard at alerts.publishOutput fires: the LLM text is discarded after the
    // budget was already spent, which is why it is logged rather than silent.
    const ctx: TriggerCtx = {
      kind: 'battery-event',
      firedAt: new Date(),
      bankId: 'starter',
    };
    await a.publishOutput?.('text that should be discarded', ctx, deps);
    expect(app.published).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('missing subkind or bankId'));
  });
});
