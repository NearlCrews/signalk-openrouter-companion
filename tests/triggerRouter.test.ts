import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Analyzer, TriggerCtx } from '../src/analyzers/Analyzer.js';
import type { AnalyzerId } from '../src/analyzers/ids.js';
import { BudgetTracker } from '../src/core/budget.js';
import { TriggerRouter } from '../src/core/triggerRouter.js';
import { cleanupTmpDir, makeRouter, makeRouterDeps, makeTmpDir } from './_mocks.js';

// The router routes by trigger shape, not by analyzer identity, so these tests
// use throwaway ids ('a', 'b', ...). makeAnalyzer accepts a plain string id and
// casts to AnalyzerId, while the deps/router come from the shared _mocks
// helpers so the spy surface matches the rest of the suite.
type AnalyzerOverrides = Partial<Omit<Analyzer, 'id' | 'triggers'>> & {
  id: string;
  triggers: Analyzer['triggers'];
};

function makeAnalyzer(overrides: AnalyzerOverrides): Analyzer {
  const base = {
    title: overrides.id,
    collectContext: vi.fn(async () => ({ ok: true })),
    buildPrompt: vi.fn(() => ({ system: 's', user: 'u' })),
    publishOutput: vi.fn(async () => {}),
  };
  return { ...base, ...overrides, id: overrides.id as AnalyzerId } as Analyzer;
}

describe('TriggerRouter', () => {
  it('dispatches engine-stop to analyzers subscribed to it', async () => {
    const a = makeAnalyzer({ id: 'a', triggers: [{ kind: 'engine-stop' }] });
    const b = makeAnalyzer({ id: 'b', triggers: [{ kind: 'engine-start' }] });
    const { router } = makeRouter([a, b]);
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
    const { router, mocks } = makeRouter([a]);
    await router.dispatch('engine-stop', { kind: 'engine-stop', firedAt: new Date() });
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.publishReport).not.toHaveBeenCalled();
  });

  it('skips LLM call when budget is exhausted', async () => {
    const a = makeAnalyzer({ id: 'a', triggers: [{ kind: 'engine-stop' }] });
    const { router, mocks } = makeRouter([a]);
    mocks.canSpend.mockReturnValue(false);
    await router.dispatch('engine-stop', { kind: 'engine-stop', firedAt: new Date() });
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  // Pins the DOCUMENTED P2-6 behavior: when the shared daily budget is
  // exhausted, runOne returns before any publish, so a battery-event run
  // (the alerts safety analyzer) publishes NOTHING, not even a failure
  // notification. The crossing is still detected upstream by batteryMonitor;
  // only the helm notification is gated. This is called out in the schema
  // description and README as "not your sole battery safety alarm". A future
  // change must not silently alter this, hence the lock.
  it('publishes nothing on a budget-exhausted run (documented safety-alert gating)', async () => {
    const alerts = makeAnalyzer({
      id: 'alerts',
      triggers: [{ kind: 'battery-event', subkind: 'low-soc-enter' }],
      failureAudible: true,
    });
    const { router, mocks } = makeRouter([alerts]);
    mocks.canSpend.mockReturnValue(false);
    await router.dispatch(
      'battery-event',
      { kind: 'battery-event', firedAt: new Date(), bankId: 'house' },
      { batterySubkind: 'low-soc-enter' },
    );
    expect(mocks.recordCall).not.toHaveBeenCalled();
    expect(alerts.publishOutput).not.toHaveBeenCalled();
    expect(mocks.publishFailure).not.toHaveBeenCalled();
    expect(mocks.publishReport).not.toHaveBeenCalled();
  });

  it('returns the "budget-exhausted" outcome for a battery-event run past the daily cap', async () => {
    // Complements the no-publish lock above by pinning the RunOutcome value
    // itself, the signal the REST fire endpoint and in-process callers read to
    // tell a real report from a silent skip. runById surfaces the outcome
    // directly, where dispatch returns void.
    const alerts = makeAnalyzer({
      id: 'alerts',
      triggers: [{ kind: 'battery-event', subkind: 'low-soc-enter' }],
    });
    const { router, mocks } = makeRouter([alerts]);
    mocks.canSpend.mockReturnValue(false);
    const outcome = await router.runById('alerts', {
      kind: 'battery-event',
      firedAt: new Date(),
      bankId: 'house',
      batteryEvent: { subkind: 'low-soc-enter', soc: 0.25 },
    });
    expect(outcome).toBe('budget-exhausted');
    expect(mocks.complete).not.toHaveBeenCalled();
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
    const { router, mocks } = makeRouter([bad, good]);
    await router.dispatch('engine-stop', { kind: 'engine-stop', firedAt: new Date() });
    expect(good.collectContext).toHaveBeenCalled();
    expect(mocks.publishFailure).toHaveBeenCalled();
  });

  it('does not publish a failure when aborted mid-LLM-call (shutdown path)', async () => {
    // A stop() landing while a completion is in flight aborts the lifecycle
    // signal and rejects the LLM call. The router must swallow that abort, not
    // publish a failure report, which for an audible analyzer would raise a
    // spurious N2K alarm on the way down. See triggerRouter.ts runOne's catch.
    const a = makeAnalyzer({
      id: 'alerts',
      triggers: [{ kind: 'engine-stop' }],
      failureAudible: true,
    });
    const { deps, mocks } = makeRouterDeps();
    const controller = new AbortController();
    deps.signal = controller.signal;
    mocks.complete.mockImplementation(async () => {
      controller.abort();
      throw new Error('request aborted');
    });
    const router = new TriggerRouter([a], deps);
    const outcome = await router.runById('alerts', { kind: 'engine-stop', firedAt: new Date() });
    expect(mocks.complete).toHaveBeenCalled();
    expect(mocks.publishFailure).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(outcome).toBe('no-input');
  });

  it('matches put triggers by path', async () => {
    const a = makeAnalyzer({
      id: 'a',
      triggers: [{ kind: 'put', path: 'plugins.x.run' }],
    });
    const { router } = makeRouter([a]);
    await router.dispatch(
      'put',
      { kind: 'put', firedAt: new Date(), put: { value: 1 } },
      { putPath: 'plugins.x.run' },
    );
    expect(a.collectContext).toHaveBeenCalled();
  });

  it('sets status when budget exhausts and resets after a successful call', async () => {
    const a = makeAnalyzer({ id: 'a', triggers: [{ kind: 'engine-stop' }] });
    const { deps, mocks } = makeRouterDeps();
    // First call: budget exhausted
    mocks.canSpend.mockReturnValueOnce(false);
    let router = new TriggerRouter([a], deps);
    await router.dispatch('engine-stop', { kind: 'engine-stop', firedAt: new Date() });
    expect(mocks.setStatus).toHaveBeenCalledWith('Running: budget exhausted for today');
    // Second call: budget available
    mocks.setStatus.mockClear();
    mocks.canSpend.mockReturnValue(true);
    router = new TriggerRouter([a], deps);
    await router.dispatch('engine-stop', { kind: 'engine-stop', firedAt: new Date() });
    expect(mocks.setStatus).toHaveBeenCalledWith('Running');
  });

  it('does not exceed the daily cap when cron analyzers fire concurrently', async () => {
    const dir = await makeTmpDir();
    try {
      const budget = await BudgetTracker.load({
        maxPerDay: 1,
        statePath: join(dir, 'budget.json'),
      });
      const { deps, mocks } = makeRouterDeps();
      deps.budget = budget;
      const a = makeAnalyzer({ id: 'a', triggers: [{ kind: 'cron', pattern: 'p' }] });
      const b = makeAnalyzer({ id: 'b', triggers: [{ kind: 'cron', pattern: 'p' }] });
      const router = new TriggerRouter([a, b], deps);
      // Cron is dispatched via runById in production (index.ts registers one
      // cron job per (pattern, timezone) pair and runs each member by id); the
      // budget-cap guarantee must hold for two analyzers fired in parallel.
      const ctx: TriggerCtx = { kind: 'cron', firedAt: new Date() };
      await Promise.all([
        router.runById('a' as AnalyzerId, ctx),
        router.runById('b' as AnalyzerId, ctx),
      ]);
      // maxPerDay is 1 and both analyzers run: exactly one LLM call may fire.
      expect(mocks.complete).toHaveBeenCalledTimes(1);
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
    const { router } = makeRouter([a]);
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
    const { router, mocks } = makeRouter([a, b]);
    await router.runById('health', { kind: 'put', firedAt: new Date(), put: { value: 'manual' } });
    expect(a.collectContext).toHaveBeenCalledOnce();
    expect(mocks.recordCall).toHaveBeenCalledOnce();
    expect(a.publishOutput).toHaveBeenCalledOnce();
    expect(b.collectContext).not.toHaveBeenCalled();
  });

  it('runById returns "unknown" for an analyzer id that is not registered', async () => {
    const a = makeAnalyzer({ id: 'health', triggers: [] });
    const { router } = makeRouter([a]);
    const outcome = await router.runById('nope' as AnalyzerId, {
      kind: 'put',
      firedAt: new Date(),
      put: { value: 'manual' },
    });
    expect(outcome).toBe('unknown');
    expect(a.collectContext).not.toHaveBeenCalled();
  });

  it('runById fires the named cron analyzer (production cron path)', async () => {
    const a = makeAnalyzer({
      id: 'a',
      triggers: [{ kind: 'cron', pattern: '0 8 * * *' }],
    });
    const { router } = makeRouter([a]);
    // Production registers one cron job per (pattern, timezone) and fires
    // its members by id; runById is the only cron entry point.
    await router.runById('a' as AnalyzerId, { kind: 'cron', firedAt: new Date() });
    expect(a.collectContext).toHaveBeenCalled();
  });

  it('dispatch does not route cron (cron is runById-only in production)', async () => {
    const a = makeAnalyzer({
      id: 'a',
      triggers: [{ kind: 'cron', pattern: '0 8 * * *' }],
    });
    const { router } = makeRouter([a]);
    // dispatch is for path-based (put) and event-based (battery-event)
    // routing; cron has no path to match on.
    await router.dispatch('cron', { kind: 'cron', firedAt: new Date() });
    expect(a.collectContext).not.toHaveBeenCalled();
  });

  it('matches battery-event triggers by subkind', async () => {
    const a = makeAnalyzer({
      id: 'a',
      triggers: [{ kind: 'battery-event', subkind: 'low-soc-enter' }],
    });
    const { router } = makeRouter([a]);
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
    const { router } = makeRouter([a]);
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
    } as Analyzer;
    const { router, mocks } = makeRouter([a]);
    await router.dispatch('engine-stop', { kind: 'engine-stop', firedAt: new Date() });
    expect(mocks.publishReport).toHaveBeenCalledTimes(1);
    expect(mocks.publishReport.mock.calls[0]?.[0]).toBe('maintenance');
  });

  it('records token/cost usage on a successful run', async () => {
    const { deps, mocks } = makeRouterDeps({
      completeResult: {
        text: 'Headline\nbody',
        model: 'anthropic/claude-haiku-4.5',
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          cachedTokens: 4,
          cost: 0.001,
        },
      },
    });
    const a = makeAnalyzer({ id: 'health', triggers: [] });
    const router = new TriggerRouter([a], deps);
    await router.runById('health', { kind: 'cron', firedAt: new Date() });
    expect(mocks.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ totalTokens: 15, cost: 0.001 }),
    );
  });

  it('passes run-meta to publishReport on the default path', async () => {
    const publishReport = vi.fn().mockResolvedValue(undefined);
    const { deps } = makeRouterDeps({
      completeResult: {
        text: 'Headline\nbody',
        model: 'anthropic/claude-haiku-4.5',
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          cachedTokens: 4,
          cost: 0.001,
        },
      },
    });
    deps.publisher.publishReport = publishReport;
    // Use an analyzer without publishOutput so the default publishReport path is taken.
    const a: Analyzer = {
      id: 'health',
      title: 'Health',
      triggers: [],
      collectContext: vi.fn(async () => ({ ok: true })),
      buildPrompt: vi.fn(() => ({ system: 's', user: 'u' })),
    } as Analyzer;
    const ctx: TriggerCtx = { kind: 'cron', firedAt: new Date() };
    const router = new TriggerRouter([a], deps);
    await router.runById('health', ctx);
    expect(publishReport).toHaveBeenCalledWith('health', ctx, 'Headline\nbody', undefined, {
      model: 'anthropic/claude-haiku-4.5',
      usage: { totalTokens: 15, cachedTokens: 4, cost: 0.001 },
    });
  });
});
