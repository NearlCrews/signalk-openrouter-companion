import { describe, expect, it, vi } from 'vitest';
import type { Analyzer, AnalyzerDeps, TriggerCtx } from '../src/analyzers/Analyzer.js';
import { TriggerRouter } from '../src/core/triggerRouter.js';

function makeAnalyzer(overrides: Partial<Analyzer> & Pick<Analyzer, 'id' | 'triggers'>): Analyzer {
  return {
    title: overrides.id,
    collectContext: vi.fn(async () => ({ ok: true })),
    buildPrompt: vi.fn(() => ({ system: 's', user: 'u' })),
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
  const publisher = { publish: vi.fn(async () => {}), publishFailure: vi.fn(async () => {}) };
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
    expect(deps.publisher.publish).not.toHaveBeenCalled();
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
});
