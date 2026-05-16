import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Analyzer, AnalyzerDeps, TriggerCtx } from '../src/analyzers/Analyzer.js';
import { BudgetTracker } from '../src/core/budget.js';
import { TriggerRouter } from '../src/core/triggerRouter.js';
import { cleanupTmpDir, makeTmpDir } from './_mocks.js';

function makeAnalyzer(overrides: Partial<Analyzer> & Pick<Analyzer, 'id' | 'triggers'>): Analyzer {
  return {
    title: overrides.id,
    collectContext: vi.fn(async () => ({ ok: true })),
    buildPrompt: vi.fn(() => ({ system: 's', user: 'u' })),
    publishOutput: vi.fn(async () => {}),
    ...overrides,
  } as Analyzer;
}

function makeDeps(): AnalyzerDeps {
  const budget = { canSpend: vi.fn(() => true), recordCall: vi.fn(async () => {}) };
  const llm = {
    complete: vi.fn(async () => ({
      text: 'report',
      model: 'm',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      raw: {},
    })),
  };
  // Mirror the real ReportPublisher surface the router actually touches:
  // publishReport for analyzers without publishOutput, publishFailure for
  // collectContext / LLM exceptions. publishOnPath is unused here.
  const publisher = {
    publishReport: vi.fn(async () => {}),
    publishFailure: vi.fn(async () => {}),
  };
  const logger = { debug: vi.fn(), error: vi.fn() };
  return {
    buffer: {} as never,
    questdb: null,
    publisher: publisher as never,
    budget: budget as never,
    llm: llm as never,
    logger: logger as never,
    app: { getSelfPath: () => undefined },
  };
}

describe('TriggerRouter', () => {
  it('dispatches engine-stop to analyzers subscribed to it', async () => {
    const a = makeAnalyzer({ id: 'a', triggers: [{ kind: 'engine-stop' }] });
    const b = makeAnalyzer({ id: 'b', triggers: [{ kind: 'engine-start' }] });
    const deps = makeDeps();
    const router = new TriggerRouter([a, b], deps);
    const ctx: TriggerCtx = { kind: 'engine-stop', firedAt: new Date() };
    await router.dispatch('engine-stop', ctx);
    expect(a.collectContext).toHaveBeenCalled();
    expect(b.collectContext).not.toHaveBeenCalled();
  });

  it('skips LLM call when collectContext returns null', async () => {
    const a = makeAnalyzer({
      id: 'a',
      triggers: [{ kind: 'engine-stop' }],
      collectContext: vi.fn(async () => null),
    });
    const deps = makeDeps();
    const router = new TriggerRouter([a], deps);
    await router.dispatch('engine-stop', { kind: 'engine-stop', firedAt: new Date() });
    expect(deps.llm.complete).not.toHaveBeenCalled();
    expect(deps.publisher.publishReport).not.toHaveBeenCalled();
  });

  it('skips LLM call when budget is exhausted', async () => {
    const a = makeAnalyzer({ id: 'a', triggers: [{ kind: 'engine-stop' }] });
    const deps = makeDeps();
    (deps.budget.canSpend as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const router = new TriggerRouter([a], deps);
    await router.dispatch('engine-stop', { kind: 'engine-stop', firedAt: new Date() });
    expect(deps.llm.complete).not.toHaveBeenCalled();
  });

  it('isolates per-analyzer failures via Promise.allSettled', async () => {
    const bad = makeAnalyzer({
      id: 'bad',
      triggers: [{ kind: 'engine-stop' }],
      collectContext: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const good = makeAnalyzer({ id: 'good', triggers: [{ kind: 'engine-stop' }] });
    const deps = makeDeps();
    const router = new TriggerRouter([bad, good], deps);
    await router.dispatch('engine-stop', { kind: 'engine-stop', firedAt: new Date() });
    expect(good.collectContext).toHaveBeenCalled();
    expect(deps.publisher.publishFailure).toHaveBeenCalled();
  });

  it('matches put triggers by path', async () => {
    const a = makeAnalyzer({
      id: 'a',
      triggers: [{ kind: 'put', path: 'plugins.x.run' }],
    });
    const deps = makeDeps();
    const router = new TriggerRouter([a], deps);
    await router.dispatch(
      'put',
      { kind: 'put', firedAt: new Date(), put: { value: 1 } },
      { putPath: 'plugins.x.run' },
    );
    expect(a.collectContext).toHaveBeenCalled();
  });

  it('sets status when budget exhausts and resets after a successful call', async () => {
    const a = makeAnalyzer({ id: 'a', triggers: [{ kind: 'engine-stop' }] });
    const setStatus = vi.fn();
    const deps = { ...makeDeps(), setStatus };
    // First call: budget exhausted
    (deps.budget.canSpend as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    let router = new TriggerRouter([a], deps);
    await router.dispatch('engine-stop', { kind: 'engine-stop', firedAt: new Date() });
    expect(setStatus).toHaveBeenCalledWith('Running, budget exhausted for today');
    // Second call: budget available
    setStatus.mockClear();
    (deps.budget.canSpend as ReturnType<typeof vi.fn>).mockReturnValue(true);
    router = new TriggerRouter([a], deps);
    await router.dispatch('engine-stop', { kind: 'engine-stop', firedAt: new Date() });
    expect(setStatus).toHaveBeenCalledWith('Running');
  });

  it('does not exceed the daily cap when analyzers dispatch concurrently', async () => {
    const dir = await makeTmpDir();
    try {
      const budget = await BudgetTracker.load({
        maxPerDay: 1,
        statePath: join(dir, 'budget.json'),
      });
      const deps = { ...makeDeps(), budget };
      const a = makeAnalyzer({ id: 'a', triggers: [{ kind: 'cron', pattern: 'p' }] });
      const b = makeAnalyzer({ id: 'b', triggers: [{ kind: 'cron', pattern: 'p' }] });
      const router = new TriggerRouter([a, b], deps);
      await router.dispatch('cron', { kind: 'cron', firedAt: new Date() }, { cronPattern: 'p' });
      // maxPerDay is 1 and both analyzers match: exactly one LLM call may run.
      expect(deps.llm.complete).toHaveBeenCalledTimes(1);
      expect(budget.callsToday()).toBe(1);
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it('does not match put triggers when path differs', async () => {
    const a = makeAnalyzer({
      id: 'a',
      triggers: [{ kind: 'put', path: 'plugins.x.run' }],
    });
    const deps = makeDeps();
    const router = new TriggerRouter([a], deps);
    await router.dispatch(
      'put',
      { kind: 'put', firedAt: new Date(), put: { value: 1 } },
      { putPath: 'other.path' },
    );
    expect(a.collectContext).not.toHaveBeenCalled();
  });

  it('runById runs the named analyzer through the full path', async () => {
    const a = makeAnalyzer({ id: 'health', triggers: [] });
    const b = makeAnalyzer({ id: 'drift', triggers: [] });
    const deps = makeDeps();
    const router = new TriggerRouter([a, b], deps);
    await router.runById('health', { kind: 'put', firedAt: new Date(), put: { value: 'manual' } });
    expect(a.collectContext).toHaveBeenCalledOnce();
    expect(deps.budget.recordCall).toHaveBeenCalledOnce();
    expect(a.publishOutput).toHaveBeenCalledOnce();
    expect(b.collectContext).not.toHaveBeenCalled();
  });

  it('runById is a no-op for an unknown analyzer id', async () => {
    const a = makeAnalyzer({ id: 'health', triggers: [] });
    const deps = makeDeps();
    const router = new TriggerRouter([a], deps);
    await router.runById('nope', { kind: 'put', firedAt: new Date(), put: { value: 'manual' } });
    expect(a.collectContext).not.toHaveBeenCalled();
  });

  it('matches cron triggers by pattern', async () => {
    const a = makeAnalyzer({
      id: 'a',
      triggers: [{ kind: 'cron', pattern: '0 8 * * *' }],
    });
    const deps = makeDeps();
    const router = new TriggerRouter([a], deps);
    await router.dispatch(
      'cron',
      { kind: 'cron', firedAt: new Date() },
      { cronPattern: '0 8 * * *' },
    );
    expect(a.collectContext).toHaveBeenCalled();
  });

  it('does not match cron triggers with a different pattern', async () => {
    const a = makeAnalyzer({
      id: 'a',
      triggers: [{ kind: 'cron', pattern: '0 8 * * *' }],
    });
    const deps = makeDeps();
    const router = new TriggerRouter([a], deps);
    await router.dispatch(
      'cron',
      { kind: 'cron', firedAt: new Date() },
      { cronPattern: '0 9 * * *' },
    );
    expect(a.collectContext).not.toHaveBeenCalled();
  });

  it('matches battery-event triggers by subkind', async () => {
    const a = makeAnalyzer({
      id: 'a',
      triggers: [{ kind: 'battery-event', subkind: 'low-soc-enter' }],
    });
    const deps = makeDeps();
    const router = new TriggerRouter([a], deps);
    await router.dispatch(
      'battery-event',
      {
        kind: 'battery-event',
        firedAt: new Date(),
        bankId: 'house',
        batteryEvent: { subkind: 'low-soc-enter', soc: 0.25 },
      },
      { batterySubkind: 'low-soc-enter' },
    );
    expect(a.collectContext).toHaveBeenCalled();
  });

  it('does not match battery-event triggers with a different subkind', async () => {
    const a = makeAnalyzer({
      id: 'a',
      triggers: [{ kind: 'battery-event', subkind: 'low-soc-enter' }],
    });
    const deps = makeDeps();
    const router = new TriggerRouter([a], deps);
    await router.dispatch(
      'battery-event',
      {
        kind: 'battery-event',
        firedAt: new Date(),
        bankId: 'house',
        batteryEvent: { subkind: 'cell-imbalance-enter' },
      },
      { batterySubkind: 'cell-imbalance-enter' },
    );
    expect(a.collectContext).not.toHaveBeenCalled();
  });

  it('falls back to publisher.publishReport when analyzer omits publishOutput', async () => {
    const a: Analyzer = {
      id: 'maintenance',
      title: 'Maintenance',
      triggers: [{ kind: 'engine-stop' }],
      collectContext: vi.fn(async () => ({ ok: true })),
      buildPrompt: vi.fn(() => ({ system: 's', user: 'u' })),
    };
    const deps = makeDeps();
    const router = new TriggerRouter([a], deps);
    await router.dispatch('engine-stop', { kind: 'engine-stop', firedAt: new Date() });
    expect(deps.publisher.publishReport).toHaveBeenCalledTimes(1);
    expect((deps.publisher.publishReport as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      'maintenance',
    );
  });
});
