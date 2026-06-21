# OpenRouter Cost & Reliability Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenRouter token use and cost visible per-run and per-day, and add prompt caching, model fallback, provider routing, and an outbound-privacy control to the OpenRouter request path.

**Architecture:** A vertical slice through the existing request-to-status path. The client (`src/core/openrouter.ts`) parses cost/cached-token usage that OpenRouter now returns automatically, and gains config-gated request-body features (Anthropic cache breakpoint, `models` fallback array, `provider` object). The trigger router captures the full result and records daily token/cost totals into `BudgetTracker`, which surfaces through `/api/status` to the panel. Per-report model/token/cost lands in `reports.jsonl` and the reports drawer.

**Tech Stack:** TypeScript 6 (ESM, Node 20.18+), Vitest, Biome, esbuild (backend) + webpack/esbuild-loader (React panel). OpenRouter Chat Completions API.

## Global Constraints

- One npm package. No sibling packages. (CLAUDE.md)
- No em dashes anywhere in code, commits, or docs. Use colons, commas, or split sentences.
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- Tests live in `tests/`, share the `_mocks.ts` harness, use `makePluginRuntime(opts)` for any `PluginRuntime` literal. Don't re-mock fundamentals.
- `src/analyzers/ids.ts` stays the single source of truth for analyzer ids/titles. Not touched here.
- The per-call/day cap (`maxCallsPerDay`) stays the only hard spend bound. `recordCall()` stays before the LLM await exactly as today. Cost is observe-only; no daily cost ceiling.
- Cost source of truth is OpenRouter `usage.cost` only. No backend pricing math. A call returning no cost contributes 0.
- All parses keep a graceful `?? 0` / optional-field fallback.
- Pre-push gate before any push: `npm run prepublishOnly` (type-check + lint + test + build). `npm run type-check` runs three passes (`src/`, `tests/`, panel) and all must be clean.
- Apache-2.0. Author Nearl Crews (`NearlCrews@users.noreply.github.com`).

## Verified OpenRouter API facts (confirmed against live docs 2026-06-21)

- **Usage is returned automatically.** `usage: { include: true }` is DEPRECATED and a no-op. Do NOT add it to the request body. Parse the response.
- Response paths: total cost `usage.cost` (credits, 1 = 1 USD); cached input tokens `usage.prompt_tokens_details.cached_tokens`. Both optional; default to 0.
- **Anthropic prompt caching**: content-array system message with `cache_control: { type: 'ephemeral' }`. Cache floor for Haiku 4.5 is **4,096 tokens**; below it the marker is accepted but caching silently does not engage (no error, `cached_tokens: 0`). Kept anyway as cheap future-proofing. Non-Anthropic models cache automatically with no body change, so the marker is sent ONLY for `anthropic/` model slugs.
- **Model fallback**: top-level `models: [primary, ...fallbacks]` array, priority order. Send `models` ALONE (omit `model`) when fallbacks are configured, to avoid a documented 400 when both are present.
- **Provider object**: `provider.sort` ("price"|"throughput"|"latency"), `provider.max_price` ({ prompt?, completion?, request? } in USD per million tokens), `provider.allow_fallbacks` (boolean), `provider.data_collection` ("allow"|"deny"), `provider.zdr` (boolean). Tight routing can yield a 503 "no provider"; that is left to the existing transient-retry path (documented limitation, not handled specially here).

## File map

| File | Change |
| --- | --- |
| `src/core/openrouter.ts` | Parse `cost`/`cachedTokens`; config-gated request body (cache breakpoint, `models`, `provider`); `OpenRouterCfg` gains `fallbackModels?`, `provider?`. |
| `src/core/budget.ts` | `recordUsage`, `tokensToday`, `costToday`; back-compat state load; rollover resets all three. |
| `src/core/triggerRouter.ts` | Capture full result; `recordUsage` on success; thread run-meta to publish. |
| `src/core/publisher.ts` | `JsonlEntry` usage fields; `PublishMeta.run`; `publishReport`/`publishOnPath`/`buildEntry` thread run-meta. |
| `src/analyzers/Analyzer.ts` | `publishOutput` optional 4th param `run?: PublishRunMeta`; export `PublishRunMeta`. |
| `src/analyzers/alerts.ts` | Forward `run` into its `publishOnPath` meta. |
| `src/analyzers/forecast.ts` | Forward `run` into its `publishOnPath` meta. |
| `src/core/api.ts` | `StatusResponse.openrouter` gains `tokensToday`/`costToday`; `buildStatus` reads them. |
| `src/index.ts` | Wire `cfg.openrouter.fallbackModels`/`provider` into `new OpenRouterClient(...)`. |
| `src/types.ts` | `PluginOptions.openrouter` gains `fallbackModels?`/`provider?`; `DEFAULT_OPTIONS`; `validateOptions` passthrough. |
| `src/schema.ts` | JSON-schema fields for the new JSON-only knobs. |
| `src/configpanel/types.ts` | `PanelStatus.openrouter` gains `tokensToday`/`costToday`; `PanelConfig.openrouter.provider`; `ReportEntry` usage fields. |
| `src/configpanel/components/StatusBlock.tsx` | "Tokens today" + "Est. cost today" cards. |
| `src/configpanel/components/OpenRouterSection.tsx` | Data-collection privacy control. |
| `src/configpanel/components/AnalyzerRow.tsx` | Per-report model/tokens/cost metadata line. |
| `README.md` | Advanced-settings reference for the new JSON-only knobs. |
| `CHANGELOG.md` | Entry (at release; see final task). |

Phases are natural review checkpoints: **P1** result parsing, **P2** daily accounting + status (the convergent finding), **P3** per-report enrichment, **P4** request-body reliability/caching/privacy + docs.

---

## Phase 1: Result parsing

### Task 1: Parse cost and cached tokens into `CompleteResult`

**Files:**
- Modify: `src/core/openrouter.ts` (the `CompleteResult` interface ~19-23, `ApiResponse` ~36-40, the 200-branch result build ~129-141)
- Test: `tests/openrouter.test.ts`

**Interfaces:**
- Produces: `CompleteResult.usage` becomes `{ promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens: number; cost: number }`. Later tasks (budget, router, publisher) consume `usage.totalTokens` and `usage.cost`.

- [ ] **Step 1: Write the failing test**

Add to `tests/openrouter.test.ts` inside the `describe('OpenRouterClient', ...)` block:

```ts
it('parses cost and cached tokens from usage', async () => {
  fetchMock.mockResolvedValueOnce(
    jsonResponse(200, {
      choices: [{ message: { content: 'hi' } }],
      model: 'anthropic/claude-haiku-4.5',
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        cost: 0.0042,
        prompt_tokens_details: { cached_tokens: 64 },
      },
    }),
  );
  const c = makeClient();
  const r = await c.complete({ system: 's', user: 'u' });
  expect(r.usage).toEqual({
    promptTokens: 100,
    completionTokens: 20,
    totalTokens: 120,
    cachedTokens: 64,
    cost: 0.0042,
  });
});

it('defaults cost and cached tokens to 0 when usage omits them', async () => {
  fetchMock.mockResolvedValueOnce(
    jsonResponse(200, {
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    }),
  );
  const c = makeClient();
  const r = await c.complete({ system: 's', user: 'u' });
  expect(r.usage.cachedTokens).toBe(0);
  expect(r.usage.cost).toBe(0);
});
```

Also update the existing `'returns text and usage on a 200'` assertion (line 56) to the new shape:

```ts
expect(r.usage).toEqual({
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
  cachedTokens: 0,
  cost: 0,
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/openrouter.test.ts -t "cost and cached"`
Expected: FAIL (`cachedTokens`/`cost` undefined, not 0).

- [ ] **Step 3: Implement**

In `src/core/openrouter.ts`, widen `CompleteResult`:

```ts
export interface CompleteResult {
  text: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
    cost: number;
  };
}
```

Widen `ApiResponse.usage`:

```ts
interface ApiResponse {
  choices: { message: { content?: string } }[];
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}
```

In the 200 branch, extend the usage mapping:

```ts
const u = body.usage ?? {};
return {
  kind: 'result',
  result: {
    text,
    model: body.model ?? this.cfg.model,
    usage: {
      promptTokens: u.prompt_tokens ?? 0,
      completionTokens: u.completion_tokens ?? 0,
      totalTokens: u.total_tokens ?? 0,
      cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
      cost: u.cost ?? 0,
    },
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/openrouter.test.ts`
Expected: PASS (all OpenRouterClient tests, including the updated existing one).

- [ ] **Step 5: Commit**

```bash
git add src/core/openrouter.ts tests/openrouter.test.ts
git commit -m "feat(openrouter): parse cost and cached-token usage from responses"
```

---

## Phase 2: Daily accounting and status surfacing

### Task 2: Daily token/cost totals in `BudgetTracker`

**Files:**
- Modify: `src/core/budget.ts` (`PersistedState` ~13-16, `load` validation ~36-45, add methods)
- Test: `tests/budget.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `recordUsage(usage: { totalTokens: number; cost: number }): Promise<void>`, `tokensToday(): number`, `costToday(): number`. `PersistedState` gains optional `tokensToday?`, `costToday?`.

- [ ] **Step 1: Write the failing test**

Add to `tests/budget.test.ts`:

```ts
it('accumulates tokens and cost via recordUsage', async () => {
  const path = join(dir, 'budget.json');
  const t0 = new Date('2026-05-10T01:00:00Z');
  const b = await BudgetTracker.load({ maxPerDay: 5, statePath: path, now: () => t0 });
  await b.recordUsage({ totalTokens: 120, cost: 0.004 });
  await b.recordUsage({ totalTokens: 80, cost: 0.002 });
  expect(b.tokensToday()).toBe(200);
  expect(b.costToday()).toBeCloseTo(0.006, 6);
});

it('resets tokens and cost on UTC day rollover', async () => {
  const path = join(dir, 'budget.json');
  let now = new Date('2026-05-10T23:30:00Z');
  const b = await BudgetTracker.load({ maxPerDay: 5, statePath: path, now: () => now });
  await b.recordUsage({ totalTokens: 100, cost: 0.01 });
  now = new Date('2026-05-11T00:30:00Z');
  expect(b.tokensToday()).toBe(0);
  expect(b.costToday()).toBe(0);
});

it('loads a pre-upgrade state file without token/cost fields', async () => {
  const path = join(dir, 'budget.json');
  const t0 = new Date('2026-05-10T01:00:00Z');
  await writeFile(path, JSON.stringify({ day: '2026-05-10', callsToday: 2 }));
  const b = await BudgetTracker.load({ maxPerDay: 5, statePath: path, now: () => t0 });
  expect(b.callsToday()).toBe(2);
  expect(b.tokensToday()).toBe(0);
  expect(b.costToday()).toBe(0);
});

it('persists tokens and cost across instances', async () => {
  const path = join(dir, 'budget.json');
  const t0 = new Date('2026-05-10T01:00:00Z');
  const b1 = await BudgetTracker.load({ maxPerDay: 5, statePath: path, now: () => t0 });
  await b1.recordUsage({ totalTokens: 50, cost: 0.005 });
  const b2 = await BudgetTracker.load({ maxPerDay: 5, statePath: path, now: () => t0 });
  expect(b2.tokensToday()).toBe(50);
  expect(b2.costToday()).toBeCloseTo(0.005, 6);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/budget.test.ts -t "recordUsage"`
Expected: FAIL (`recordUsage` is not a function).

- [ ] **Step 3: Implement**

In `src/core/budget.ts`, widen `PersistedState`:

```ts
interface PersistedState {
  day: string;
  callsToday: number;
  tokensToday: number;
  costToday: number;
}
```

In `load`, after the existing `callsToday` validation, default the two new fields (tolerate absence and non-finite):

```ts
const tokensToday =
  Number.isFinite(parsed.tokensToday) && (parsed.tokensToday as number) >= 0
    ? (parsed.tokensToday as number)
    : 0;
const costToday =
  Number.isFinite(parsed.costToday) && (parsed.costToday as number) >= 0
    ? (parsed.costToday as number)
    : 0;
state = { day: parsed.day, callsToday: parsed.callsToday, tokensToday, costToday };
```

(Type the `parsed` read loosely: change `const parsed = JSON.parse(raw) as PersistedState;` to `as Partial<PersistedState> & { day?: string; callsToday?: number }` and keep the existing `day`/`callsToday` guards as-is. In the ENOENT/catch fallback, set `state = { day: utcDay(now()), callsToday: 0, tokensToday: 0, costToday: 0 };`.)

Update `rolloverIfNeeded` to reset all three:

```ts
private rolloverIfNeeded(): void {
  const today = utcDay(this.opts.now());
  if (this.state.day !== today) {
    this.state = { day: today, callsToday: 0, tokensToday: 0, costToday: 0 };
  }
}
```

In `recordCall`, preserve the new fields when incrementing:

```ts
this.state = {
  ...this.state,
  callsToday: this.state.callsToday + 1,
};
```

Add the new methods after `recordCall`:

```ts
// Daily token/cost accounting. Unlike recordCall (which runs before the LLM
// await to bound the call cap under concurrency), recordUsage runs only after
// a successful call, so it reflects real spend. It does not gate anything; the
// call cap remains the sole hard spend bound. Best-effort persist, like
// recordCall: a failed write only loses the running total across a restart.
async recordUsage(usage: { totalTokens: number; cost: number }): Promise<void> {
  this.rolloverIfNeeded();
  this.state = {
    ...this.state,
    tokensToday: this.state.tokensToday + (Number.isFinite(usage.totalTokens) ? usage.totalTokens : 0),
    costToday: this.state.costToday + (Number.isFinite(usage.cost) ? usage.cost : 0),
  };
  try {
    await writeFile(this.opts.statePath, JSON.stringify(this.state));
  } catch (err) {
    this.opts.log?.(`budget state write failed: ${String(err)}`);
  }
}

tokensToday(): number {
  this.rolloverIfNeeded();
  return this.state.tokensToday;
}

costToday(): number {
  this.rolloverIfNeeded();
  return this.state.costToday;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/budget.test.ts`
Expected: PASS (new and existing budget tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/budget.ts tests/budget.test.ts
git commit -m "feat(budget): track daily token and cost totals"
```

---

### Task 3: Router records usage on success

**Files:**
- Modify: `src/core/triggerRouter.ts` (`runOne` ~82-95)
- Test: `tests/triggerRouter.test.ts`

**Interfaces:**
- Consumes: `BudgetTracker.recordUsage` (Task 2); `CompleteResult` (Task 1).
- Produces: the router now captures `result` and calls `recordUsage`. Run-meta plumbing to publish is added in Task 7; this task only records the daily totals.

- [ ] **Step 1: Write the failing test**

Open `tests/triggerRouter.test.ts` and inspect how `deps`/`budget` are built (it uses the `_mocks.ts` harness). Add a test asserting `recordUsage` is called with the LLM result's usage on a successful run. Mirror the existing successful-run test's setup; the key new assertion:

```ts
it('records token/cost usage on a successful run', async () => {
  // Arrange a runtime whose llm.complete resolves with a known usage, using the
  // same _mocks harness the other triggerRouter tests use. Spy on budget.recordUsage.
  const recordUsage = vi.fn().mockResolvedValue(undefined);
  // ... build deps via the harness, then override:
  deps.budget.recordUsage = recordUsage;
  deps.llm.complete = vi.fn().mockResolvedValue({
    text: 'Headline\nbody',
    model: 'anthropic/claude-haiku-4.5',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 0, cost: 0.001 },
  });

  await router.runById('health', ctx);

  expect(recordUsage).toHaveBeenCalledWith(
    expect.objectContaining({ totalTokens: 15, cost: 0.001 }),
  );
});
```

(Match the exact harness/fixture construction already used by the neighboring tests in this file; reuse their `makePluginRuntime`/deps builder rather than hand-rolling.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/triggerRouter.test.ts -t "records token/cost"`
Expected: FAIL (`recordUsage` not called).

- [ ] **Step 3: Implement**

In `src/core/triggerRouter.ts` `runOne`, replace the destructure-and-publish block:

```ts
const { system, user } = a.buildPrompt(input);
const result = await this.deps.llm.complete({
  system,
  user,
  abortSignal: this.deps.signal,
});
await this.deps.budget.recordUsage(result.usage);
this.setStatus(this.deps.okStatus ?? 'Running');
if (a.publishOutput) {
  await a.publishOutput(result.text, ctx, this.deps);
} else {
  await this.deps.publisher.publishReport(a.id, ctx, result.text);
}
return 'reported';
```

(The run-meta argument to `publishOutput`/`publishReport` is added in Task 7.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/triggerRouter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/triggerRouter.ts tests/triggerRouter.test.ts
git commit -m "feat(router): record daily token/cost usage after a successful call"
```

---

### Task 4: Surface `tokensToday`/`costToday` in `/api/status`

**Files:**
- Modify: `src/core/api.ts` (`StatusResponse` ~59-65, `buildStatus` ~86-91)
- Test: `tests/api.test.ts`

**Interfaces:**
- Consumes: `BudgetTracker.tokensToday`/`costToday` (Task 2).
- Produces: `StatusResponse.openrouter` carries `tokensToday: number` and `costToday: number`.

- [ ] **Step 1: Write the failing test**

In `tests/api.test.ts`, find the test that asserts the `/api/status` payload's `openrouter` block (it checks `callsToday`/`maxCallsPerDay`). Add assertions that the response includes `tokensToday` and `costToday` sourced from the budget. If the harness's budget stub lacks the methods, extend the stub (via `makePluginRuntime`) so `budget.tokensToday()` returns e.g. `4096` and `budget.costToday()` returns e.g. `0.12`, then:

```ts
expect(body.openrouter.tokensToday).toBe(4096);
expect(body.openrouter.costToday).toBeCloseTo(0.12, 6);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api.test.ts -t "status"`
Expected: FAIL (`tokensToday` undefined).

- [ ] **Step 3: Implement**

In `src/core/api.ts`, extend `StatusResponse.openrouter`:

```ts
openrouter: {
  apiKeySet: boolean;
  model: string;
  callsToday: number;
  maxCallsPerDay: number;
  tokensToday: number;
  costToday: number;
};
```

In `buildStatus`:

```ts
openrouter: {
  apiKeySet: rt.apiKeySet,
  model: rt.cfg.openrouter.model,
  callsToday: rt.budget.callsToday(),
  maxCallsPerDay: rt.cfg.openrouter.maxCallsPerDay,
  tokensToday: rt.budget.tokensToday(),
  costToday: rt.budget.costToday(),
},
```

If `makePluginRuntime` in `tests/_mocks.ts` builds a budget stub, add `tokensToday: () => 0` and `costToday: () => 0` defaults there so existing tests keep compiling.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/api.ts tests/api.test.ts tests/_mocks.ts
git commit -m "feat(api): surface daily tokens and cost in /api/status"
```

---

### Task 5: Show tokens and cost in the panel status block

**Files:**
- Modify: `src/configpanel/types.ts` (`PanelStatus.openrouter` ~40-45)
- Modify: `src/configpanel/components/StatusBlock.tsx` (stats grid ~73-79)

**Interfaces:**
- Consumes: `PanelStatus.openrouter.tokensToday`/`costToday`.
- Produces: two new stat cards; no new fetch (rides the existing `/api/status` poll).

- [ ] **Step 1: Extend the panel status type**

In `src/configpanel/types.ts`, add the fields (optional so an older server payload degrades):

```ts
openrouter: {
  apiKeySet: boolean;
  model: string;
  callsToday: number;
  maxCallsPerDay: number;
  tokensToday?: number;
  costToday?: number;
};
```

- [ ] **Step 2: Add the stat cards**

In `src/configpanel/components/StatusBlock.tsx`, after the "Calls today" `statCard` (the block ending ~79), add:

```tsx
<div style={S.statCard}>
  <div style={S.statLabel}>Tokens today</div>
  <div style={S.statValue}>{(o.tokensToday ?? 0).toLocaleString()}</div>
  <div style={S.statSub}>prompt + completion</div>
</div>
<div style={S.statCard}>
  <div style={S.statLabel}>Est. cost today</div>
  <div style={S.statValue}>${(o.costToday ?? 0).toFixed(4)}</div>
  <div style={S.statSub}>OpenRouter usage.cost</div>
</div>
```

- [ ] **Step 3: Type-check the panel**

Run: `npx tsc --noEmit -p tsconfig.panel.json`
Expected: no errors.

- [ ] **Step 4: Build the panel bundle**

Run: `npm run build`
Expected: backend and panel bundles build clean.

- [ ] **Step 5: Commit**

```bash
git add src/configpanel/types.ts src/configpanel/components/StatusBlock.tsx
git commit -m "feat(panel): show daily tokens and estimated cost in the status block"
```

---

## Phase 3: Per-report enrichment

### Task 6: Add usage fields to the report log entry

**Files:**
- Modify: `src/core/publisher.ts` (`JsonlEntry` ~92-102, `PublishMeta` ~85-88, `publishOnPath` ~147-166, `publishReport` ~174-185, `buildEntry` ~221-237)
- Modify: `src/analyzers/Analyzer.ts` (export `PublishRunMeta`; `publishOutput` signature ~85)
- Test: `tests/publisher.test.ts`

**Interfaces:**
- Consumes: `CompleteResult['usage']` (Task 1).
- Produces:
  - `export interface PublishRunMeta { model: string; usage: { totalTokens: number; cachedTokens: number; cost: number } }` (in `Analyzer.ts`).
  - `JsonlEntry` gains optional `model?`, `totalTokens?`, `cachedTokens?`, `costUsd?`.
  - `PublishMeta` gains optional `run?: PublishRunMeta`.
  - `publishReport(analyzerId, ctx, text, state?, run?)` and `publishOnPath(displayText, meta, override)` (meta now may carry `run`).

- [ ] **Step 1: Write the failing test**

In `tests/publisher.test.ts`, add a test that a published report's JSONL row carries the usage fields when run-meta is supplied. Find how the existing tests read the appended JSONL (they read `cfg.logPath` and parse the last line). Add:

```ts
it('records model and usage on the JSONL entry when run-meta is supplied', async () => {
  // build publisher via the same helper the other tests use
  await publisher.publishReport('health', ctx, 'Headline\nbody', 'nominal', {
    model: 'anthropic/claude-haiku-4.5',
    usage: { totalTokens: 123, cachedTokens: 64, cost: 0.0021 },
  });
  const lines = (await readFile(logPath, 'utf-8')).trim().split('\n');
  const entry = JSON.parse(lines[lines.length - 1]);
  expect(entry.model).toBe('anthropic/claude-haiku-4.5');
  expect(entry.totalTokens).toBe(123);
  expect(entry.cachedTokens).toBe(64);
  expect(entry.costUsd).toBeCloseTo(0.0021, 6);
});

it('omits usage fields when no run-meta is supplied', async () => {
  await publisher.publishReport('health', ctx, 'Headline\nbody');
  const lines = (await readFile(logPath, 'utf-8')).trim().split('\n');
  const entry = JSON.parse(lines[lines.length - 1]);
  expect(entry.model).toBeUndefined();
  expect(entry.totalTokens).toBeUndefined();
});
```

(Match the exact publisher/log construction the file already uses.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/publisher.test.ts -t "run-meta"`
Expected: FAIL (`publishReport` rejects the 5th arg / fields absent).

- [ ] **Step 3: Implement**

In `src/analyzers/Analyzer.ts`, add the exported type and widen `publishOutput`:

```ts
export interface PublishRunMeta {
  model: string;
  usage: { totalTokens: number; cachedTokens: number; cost: number };
}
```

```ts
publishOutput?(text: string, ctx: TriggerCtx, deps: AnalyzerDeps, run?: PublishRunMeta): Promise<void>;
```

In `src/core/publisher.ts`:

- Import the type: `import type { PublishRunMeta, TriggerCtx } from '../analyzers/Analyzer.js';`
- Widen `JsonlEntry`:

```ts
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
```

- Widen `PublishMeta`:

```ts
interface PublishMeta {
  analyzerId: string;
  ctx: TriggerCtx;
  run?: PublishRunMeta;
}
```

- `publishReport` gains the `run` param and forwards it:

```ts
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
```

- `buildEntry` folds the run fields when present:

```ts
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
```

(`publishOnPath` already passes `meta` to `buildEntry` via `appendLog(this.buildEntry(override.logText ?? displayText, meta, now))`, so no change needed there beyond `meta` now carrying `run`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/publisher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/publisher.ts src/analyzers/Analyzer.ts tests/publisher.test.ts
git commit -m "feat(publisher): record model and token/cost usage on report log entries"
```

---

### Task 7: Thread run-meta from the router through both `publishOutput` overrides

**Files:**
- Modify: `src/core/triggerRouter.ts` (`runOne` publish block from Task 3)
- Modify: `src/analyzers/alerts.ts` (`publishOutput` ~125 and its `publishOnPath` call)
- Modify: `src/analyzers/forecast.ts` (`publishOutput` ~271 and its `publishOnPath` call)
- Test: `tests/triggerRouter.test.ts`, `tests/alerts.test.ts`, `tests/forecast.test.ts`

**Interfaces:**
- Consumes: `PublishRunMeta` (Task 6); `CompleteResult` (Task 1).
- Produces: the router builds `run = { model: result.model, usage: { totalTokens, cachedTokens, cost } }` and passes it to both publish paths. `alerts` and `forecast` forward it into their `publishOnPath` meta.

- [ ] **Step 1: Write the failing test**

In `tests/triggerRouter.test.ts`, extend the success test (or add one) to assert the run-meta reaches publish. For the default path, spy on `deps.publisher.publishReport` and assert the 5th arg:

```ts
it('passes run-meta to publishReport on the default path', async () => {
  const publishReport = vi.fn().mockResolvedValue(undefined);
  deps.publisher.publishReport = publishReport;
  deps.llm.complete = vi.fn().mockResolvedValue({
    text: 'Headline\nbody',
    model: 'anthropic/claude-haiku-4.5',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 4, cost: 0.001 },
  });
  await router.runById('health', ctx);
  expect(publishReport).toHaveBeenCalledWith(
    'health',
    ctx,
    'Headline\nbody',
    undefined,
    { model: 'anthropic/claude-haiku-4.5', usage: { totalTokens: 15, cachedTokens: 4, cost: 0.001 } },
  );
});
```

In `tests/alerts.test.ts` and `tests/forecast.test.ts`, add a test that calling `publishOutput(text, ctx, deps, run)` results in a JSONL entry carrying `model`/`totalTokens`/`costUsd` (read the appended log like the publisher test). Match each file's existing publish/log fixture.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/triggerRouter.test.ts tests/alerts.test.ts tests/forecast.test.ts -t "run-meta"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/core/triggerRouter.ts`, build run-meta and pass it on both branches:

```ts
const result = await this.deps.llm.complete({
  system,
  user,
  abortSignal: this.deps.signal,
});
await this.deps.budget.recordUsage(result.usage);
this.setStatus(this.deps.okStatus ?? 'Running');
const run = {
  model: result.model,
  usage: {
    totalTokens: result.usage.totalTokens,
    cachedTokens: result.usage.cachedTokens,
    cost: result.usage.cost,
  },
};
if (a.publishOutput) {
  await a.publishOutput(result.text, ctx, this.deps, run);
} else {
  await this.deps.publisher.publishReport(a.id, ctx, result.text, undefined, run);
}
return 'reported';
```

(`publishReport`'s 4th param `state` defaults to `'nominal'` when `undefined` is passed, so behavior is unchanged.)

In `src/analyzers/alerts.ts`, widen the signature and forward `run` into the `publishOnPath` meta:

```ts
async publishOutput(
  text: string,
  ctx: TriggerCtx,
  deps: AnalyzerDeps,
  run?: PublishRunMeta,
): Promise<void> {
  // ...existing subkind/bankId guard unchanged...
  await deps.publisher.publishOnPath(
    displayText,
    { analyzerId: this.id, ctx, run },
    { path, state, alertId, logText },
  );
}
```

Import the type in `alerts.ts`: add `PublishRunMeta` to the existing import from `./Analyzer.js`. (Confirm the exact `publishOnPath` argument names already used there and only add `run` to the meta object; leave the override object as-is.)

In `src/analyzers/forecast.ts`, the same: widen `publishOutput(text, ctx, deps, run?)` and add `run` to the `{ analyzerId, ctx }` meta it hands to `publishOnPath`. Import `PublishRunMeta` from `./Analyzer.js`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/triggerRouter.test.ts tests/alerts.test.ts tests/forecast.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/triggerRouter.ts src/analyzers/alerts.ts src/analyzers/forecast.ts tests/triggerRouter.test.ts tests/alerts.test.ts tests/forecast.test.ts
git commit -m "feat(router): thread model/usage run-meta through all publish paths"
```

---

### Task 8: Show model/tokens/cost in the panel reports drawer

**Files:**
- Modify: `src/configpanel/types.ts` (`ReportEntry` ~57-64)
- Modify: `src/configpanel/components/AnalyzerRow.tsx` (report-row render ~243-247)

**Interfaces:**
- Consumes: `ReportEntry.model`/`totalTokens`/`costUsd`.
- Produces: a per-report metadata line showing model and cost when present.

- [ ] **Step 1: Extend `ReportEntry`**

In `src/configpanel/types.ts`:

```ts
export interface ReportEntry {
  ts: string;
  trigger: string;
  engineId?: string;
  durationSec?: number;
  report?: string;
  failure?: string;
  model?: string;
  totalTokens?: number;
  costUsd?: number;
}
```

- [ ] **Step 2: Render the metadata line**

In `src/configpanel/components/AnalyzerRow.tsx`, where a report row renders its `ts`/trigger, add a usage line when fields are present (place beside the existing timestamp line):

```tsx
{r.model && (
  <div style={S.statSub}>
    {r.model}
    {typeof r.totalTokens === 'number' ? ` · ${r.totalTokens.toLocaleString()} tok` : ''}
    {typeof r.costUsd === 'number' ? ` · $${r.costUsd.toFixed(4)}` : ''}
  </div>
)}
```

(Use the existing small/sub text style token in `styles.ts`; if `S.statSub` is not in scope here, use the nearest existing muted-text style the drawer already uses.)

- [ ] **Step 3: Type-check + build the panel**

Run: `npx tsc --noEmit -p tsconfig.panel.json && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/configpanel/types.ts src/configpanel/components/AnalyzerRow.tsx
git commit -m "feat(panel): show model and cost per report in the reports drawer"
```

---

## Phase 4: Request-body reliability, caching, privacy, docs

### Task 9: Config shape for fallback models and provider routing

**Files:**
- Modify: `src/types.ts` (`PluginOptions.openrouter` ~60-66, `DEFAULT_OPTIONS.openrouter` ~135-141, `validateOptions` ~316-323)
- Test: `tests/cfg.test.ts` (or `tests/schema.test.ts` if config defaults are asserted there)

**Interfaces:**
- Produces: `PluginOptions.openrouter` gains
  `fallbackModels?: string[]` and
  `provider?: { sort?: 'price' | 'throughput' | 'latency'; maxPrice?: { prompt?: number; completion?: number; request?: number }; allowFallbacks?: boolean; dataCollection?: 'allow' | 'deny'; zdr?: boolean }`.
  Defaults omit both (today's behavior preserved).

- [ ] **Step 1: Write the failing test**

In `tests/cfg.test.ts`, add a test that `validateOptions` preserves the new fields when present and tolerates their absence. If `tests/cfg.test.ts` does not exercise `validateOptions`, add the assertion to wherever `DEFAULT_OPTIONS`/`validateOptions` is already tested (search the suite for `validateOptions` or `DEFAULT_OPTIONS`). Minimum:

```ts
it('preserves openrouter.fallbackModels and provider through validation', () => {
  const cfg = structuredClone(DEFAULT_OPTIONS);
  cfg.openrouter.fallbackModels = ['openai/gpt-5-mini'];
  cfg.openrouter.provider = { dataCollection: 'deny', sort: 'price' };
  const out = validateOptions(cfg);
  expect(out.openrouter.fallbackModels).toEqual(['openai/gpt-5-mini']);
  expect(out.openrouter.provider).toEqual({ dataCollection: 'deny', sort: 'price' });
});
```

(Import `validateOptions`/`DEFAULT_OPTIONS` as the existing tests do; if `validateOptions` is not exported, assert via the public path that already covers it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cfg.test.ts -t "fallbackModels"`
Expected: FAIL (type error or fields dropped).

- [ ] **Step 3: Implement**

In `src/types.ts`, widen the `openrouter` member of `PluginOptions`:

```ts
openrouter: {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxCallsPerDay: number;
  requestTimeoutMs: number;
  fallbackModels?: string[];
  provider?: {
    sort?: 'price' | 'throughput' | 'latency';
    maxPrice?: { prompt?: number; completion?: number; request?: number };
    allowFallbacks?: boolean;
    dataCollection?: 'allow' | 'deny';
    zdr?: boolean;
  };
};
```

`DEFAULT_OPTIONS.openrouter` stays as-is (no `fallbackModels`/`provider` keys: both default to undefined). In `validateOptions`, the existing spread `cfg.openrouter = { ...or, maxCallsPerDay: ... }` already preserves the new optional fields, so no change is required beyond confirming the spread keeps them. (If `validateOptions` rebuilds the object field-by-field rather than spreading, add `fallbackModels: or.fallbackModels` and `provider: or.provider` to the rebuild.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/cfg.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts tests/cfg.test.ts
git commit -m "feat(config): add openrouter fallbackModels and provider routing options"
```

---

### Task 10: Request-body caching, fallback, and provider object in the client

**Files:**
- Modify: `src/core/openrouter.ts` (`OpenRouterCfg` ~3-11, the request `body` ~100-107, add private builders)
- Test: `tests/openrouter.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `OpenRouterCfg` gains `fallbackModels?: string[]` and `provider?` (same shape as Task 9's `PluginOptions.openrouter.provider`). Request body now conditionally sends `cache_control`, `models`, and `provider`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/openrouter.test.ts`:

```ts
it('sends a cache_control breakpoint for an anthropic model', async () => {
  fetchMock.mockResolvedValueOnce(
    jsonResponse(200, { choices: [{ message: { content: 'x' } }], usage: {} }),
  );
  const c = makeClient({ model: 'anthropic/claude-haiku-4.5' });
  await c.complete({ system: 'SYS', user: 'U' });
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.messages[0]).toEqual({
    role: 'system',
    content: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }],
  });
});

it('sends a plain system string for a non-anthropic model', async () => {
  fetchMock.mockResolvedValueOnce(
    jsonResponse(200, { choices: [{ message: { content: 'x' } }], usage: {} }),
  );
  const c = makeClient({ model: 'openai/gpt-5-mini' });
  await c.complete({ system: 'SYS', user: 'U' });
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.messages[0]).toEqual({ role: 'system', content: 'SYS' });
});

it('sends a models array and omits model when fallbacks are configured', async () => {
  fetchMock.mockResolvedValueOnce(
    jsonResponse(200, { choices: [{ message: { content: 'x' } }], usage: {} }),
  );
  const c = makeClient({ model: 'anthropic/claude-haiku-4.5', fallbackModels: ['openai/gpt-5-mini'] });
  await c.complete({ system: 's', user: 'u' });
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.models).toEqual(['anthropic/claude-haiku-4.5', 'openai/gpt-5-mini']);
  expect(body.model).toBeUndefined();
});

it('sends a provider object built from config', async () => {
  fetchMock.mockResolvedValueOnce(
    jsonResponse(200, { choices: [{ message: { content: 'x' } }], usage: {} }),
  );
  const c = makeClient({
    model: 'openai/gpt-5-mini',
    provider: { sort: 'price', dataCollection: 'deny', allowFallbacks: false, maxPrice: { prompt: 1, completion: 2 }, zdr: true },
  });
  await c.complete({ system: 's', user: 'u' });
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.provider).toEqual({
    sort: 'price',
    data_collection: 'deny',
    allow_fallbacks: false,
    max_price: { prompt: 1, completion: 2 },
    zdr: true,
  });
});

it('omits provider when no provider config is set', async () => {
  fetchMock.mockResolvedValueOnce(
    jsonResponse(200, { choices: [{ message: { content: 'x' } }], usage: {} }),
  );
  const c = makeClient({ model: 'openai/gpt-5-mini' });
  await c.complete({ system: 's', user: 'u' });
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.provider).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/openrouter.test.ts -t "cache_control"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/core/openrouter.ts`, widen `OpenRouterCfg`:

```ts
interface OpenRouterCfg {
  apiKey: string;
  baseUrl: string;
  model: string;
  requestTimeoutMs: number;
  referer: string;
  title: string;
  random?: () => number;
  fallbackModels?: string[];
  provider?: {
    sort?: 'price' | 'throughput' | 'latency';
    maxPrice?: { prompt?: number; completion?: number; request?: number };
    allowFallbacks?: boolean;
    dataCollection?: 'allow' | 'deny';
    zdr?: boolean;
  };
}
```

Add two private builders to the class:

```ts
private buildSystemMessage(system: string): unknown {
  // Anthropic needs an explicit cache breakpoint; OpenAI/Gemini/etc cache
  // automatically and take the plain string. Below the model's cache floor
  // (4,096 tokens on Haiku 4.5) the marker is a silent no-op, not an error.
  if (this.cfg.model.startsWith('anthropic/')) {
    return { role: 'system', content: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] };
  }
  return { role: 'system', content: system };
}

private buildProvider(): Record<string, unknown> | undefined {
  const p = this.cfg.provider;
  if (!p) return undefined;
  const out: Record<string, unknown> = {};
  if (p.sort) out.sort = p.sort;
  if (p.maxPrice) out.max_price = p.maxPrice;
  if (p.allowFallbacks !== undefined) out.allow_fallbacks = p.allowFallbacks;
  if (p.dataCollection) out.data_collection = p.dataCollection;
  if (p.zdr) out.zdr = p.zdr;
  return Object.keys(out).length > 0 ? out : undefined;
}
```

Replace the inline `body: JSON.stringify({...})` with a built payload:

```ts
const payload: Record<string, unknown> = {
  max_tokens: MAX_COMPLETION_TOKENS,
  messages: [this.buildSystemMessage(args.system), { role: 'user', content: args.user }],
};
const fallbacks = this.cfg.fallbackModels;
if (fallbacks && fallbacks.length > 0) {
  payload.models = [this.cfg.model, ...fallbacks];
} else {
  payload.model = this.cfg.model;
}
const provider = this.buildProvider();
if (provider) payload.provider = provider;
```

and use `body: JSON.stringify(payload)` in the `fetchWithTimeout` call.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/openrouter.test.ts`
Expected: PASS (new tests plus the existing `model`/`messages` test, which uses a non-anthropic model `'m'` so still expects the plain string form and a top-level `model`).

- [ ] **Step 5: Commit**

```bash
git add src/core/openrouter.ts tests/openrouter.test.ts
git commit -m "feat(openrouter): prompt caching, model fallback, and provider routing in the request"
```

---

### Task 11: Wire the new config into the client construction

**Files:**
- Modify: `src/index.ts` (`new OpenRouterClient({...})` ~234-241)
- Test: covered by `tests/plugin.test.ts` / `tests/integration.test.ts` if they assert client config; otherwise type-check + build is the gate.

**Interfaces:**
- Consumes: `cfg.openrouter.fallbackModels`/`provider` (Task 9); `OpenRouterCfg` (Task 10).

- [ ] **Step 1: Implement**

In `src/index.ts`, extend the client construction:

```ts
const llm = new OpenRouterClient({
  apiKey: cfg.openrouter.apiKey,
  baseUrl: cfg.openrouter.baseUrl,
  model: cfg.openrouter.model,
  requestTimeoutMs: cfg.openrouter.requestTimeoutMs,
  referer: 'https://github.com/NearlCrews/signalk-openrouter-companion',
  title: PLUGIN_ID,
  fallbackModels: cfg.openrouter.fallbackModels,
  provider: cfg.openrouter.provider,
});
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 3: Run the suite**

Run: `npx vitest run tests/plugin.test.ts tests/integration.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(plugin): pass fallbackModels and provider config to the OpenRouter client"
```

---

### Task 12: JSON-schema fields for the new JSON-only knobs

**Files:**
- Modify: `src/schema.ts` (openrouter `properties` ~290-297; `ui:order` ~580-581)
- Test: `tests/schema.test.ts`

**Interfaces:**
- Produces: rjsf schema exposes `fallbackModels` (array of strings) and a `provider` object (`sort` enum, `maxPrice` object, `allowFallbacks` boolean, `dataCollection` enum, `zdr` boolean) under `openrouter`.

- [ ] **Step 1: Write the failing test**

In `tests/schema.test.ts`, add assertions that the built schema includes the new properties. Match how the file reads the schema (it calls the schema builder and inspects `properties`). Example:

```ts
it('exposes openrouter fallbackModels and provider in the schema', () => {
  const schema = buildSchema(); // use the file's existing accessor
  const or = schema.properties.openrouter.properties;
  expect(or.fallbackModels.type).toBe('array');
  expect(or.provider.type).toBe('object');
  expect(or.provider.properties.dataCollection.enum).toEqual(['allow', 'deny']);
  expect(or.provider.properties.sort.enum).toEqual(['price', 'throughput', 'latency']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/schema.test.ts -t "fallbackModels"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/schema.ts`, after the `maxCallsPerDay` property inside the `openrouter.properties` object, add:

```ts
fallbackModels: {
  type: 'array',
  title: 'Fallback models',
  description:
    'Optional ordered list of model slugs to try if the primary model is unavailable. Leave empty to use only the primary model.',
  items: { type: 'string' },
  default: [],
},
provider: {
  type: 'object',
  title: 'Provider routing (advanced)',
  description:
    'Optional OpenRouter provider controls. Tight routing can leave no eligible provider and fail a run.',
  properties: {
    sort: {
      type: 'string',
      title: 'Routing preference',
      enum: ['price', 'throughput', 'latency'],
    },
    allowFallbacks: {
      type: 'boolean',
      title: 'Allow provider fallbacks',
      description: 'When off, a run fails rather than substituting a different provider.',
    },
    dataCollection: {
      type: 'string',
      title: 'Provider data collection',
      description: 'Set to deny to route only to providers that do not retain or train on request data.',
      enum: ['allow', 'deny'],
    },
    zdr: {
      type: 'boolean',
      title: 'Require zero-data-retention providers',
    },
    maxPrice: {
      type: 'object',
      title: 'Maximum price (USD per million tokens)',
      properties: {
        prompt: { type: 'number', title: 'Max prompt price' },
        completion: { type: 'number', title: 'Max completion price' },
        request: { type: 'number', title: 'Max per-request price' },
      },
    },
  },
},
```

(Match the surrounding object's exact TypeScript shape. If the schema is a typed literal that disallows extra keys, extend the corresponding interface in `schema.ts` to include these properties. Confirm the schema builder's type for the `openrouter.properties` block and add fields to that interface first if needed.)

Add `'fallbackModels'` and `'provider'` to the openrouter `ui:order` array (~581):

```ts
'ui:order': ['apiKey', 'model', 'maxCallsPerDay', 'fallbackModels', 'provider'],
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schema.ts tests/schema.test.ts
git commit -m "feat(schema): expose fallbackModels and provider routing in the config schema"
```

---

### Task 13: Privacy control in the panel OpenRouter section

**Files:**
- Modify: `src/configpanel/types.ts` (`PanelConfig.openrouter` ~22)
- Modify: `src/configpanel/components/OpenRouterSection.tsx` (after the max-calls field ~99)

**Interfaces:**
- Consumes: `PanelConfig.openrouter.provider.dataCollection`.
- Produces: a segmented Allow/Deny (or select) control that writes `cfg.openrouter.provider.dataCollection`.

- [ ] **Step 1: Extend `PanelConfig`**

In `src/configpanel/types.ts`:

```ts
openrouter?: {
  apiKey?: string;
  model?: string;
  maxCallsPerDay?: number;
  provider?: { dataCollection?: 'allow' | 'deny' };
};
```

- [ ] **Step 2: Add the control**

In `src/configpanel/components/OpenRouterSection.tsx`, after the max-calls `fieldRow` (closing ~99), add a privacy row. Reuse the existing `SegmentedControl` primitive (per CLAUDE.md the panel has one in `components/`); if its prop shape differs, fall back to a native `<select>` styled with `S.input`:

```tsx
<div style={S.fieldRow}>
  <label htmlFor="orc-data-collection" style={S.fieldLabel}>
    Provider data
  </label>
  <select
    id="orc-data-collection"
    style={S.inputSmall}
    value={o.provider?.dataCollection ?? 'allow'}
    onChange={(e) =>
      set({
        openrouter: {
          ...o,
          provider: { ...o.provider, dataCollection: e.target.value as 'allow' | 'deny' },
        },
      })
    }
  >
    <option value="allow">Allow (default)</option>
    <option value="deny">Deny (privacy)</option>
  </select>
  <span style={S.hint}>Deny routes only to providers that do not retain request data</span>
</div>
```

(`o` is already `cfg.openrouter ?? {}` in this component. Keep the `set({ openrouter: {...o, ...} })` pattern the other fields use so the full object is saved.)

- [ ] **Step 3: Type-check + build the panel**

Run: `npx tsc --noEmit -p tsconfig.panel.json && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/configpanel/types.ts src/configpanel/components/OpenRouterSection.tsx
git commit -m "feat(panel): add provider data-collection privacy control"
```

---

### Task 14: Document the new JSON-only settings

**Files:**
- Modify: `README.md` (the advanced-settings paragraph ~145-148)

**Interfaces:** none.

- [ ] **Step 1: Add the reference**

In `README.md`, expand the advanced-settings section to enumerate the new OpenRouter knobs. Add after the existing advanced-settings sentence (no em dashes):

```markdown
Advanced OpenRouter settings, edited in the saved JSON config under
`openrouter`:

| Key | Meaning | Default |
|-----|---------|---------|
| `fallbackModels` | Ordered list of model slugs to try if the primary is unavailable. | none |
| `provider.sort` | Routing preference: `price`, `throughput`, or `latency`. | unset |
| `provider.maxPrice` | Per-call price ceiling in USD per million tokens (`prompt`, `completion`, `request`). | unset |
| `provider.allowFallbacks` | When `false`, a run fails rather than substituting another provider. | `true` |
| `provider.dataCollection` | Set to `deny` to route only to providers that do not retain request data. Also available as a panel toggle. | `allow` |
| `provider.zdr` | Require zero-data-retention providers. | `false` |

Token use and estimated cost per day are shown in the panel status block, and
per-report model and cost are recorded in `reports.jsonl`.
```

- [ ] **Step 2: Verify links and dashes**

Run: `grep -n "—" README.md`
Expected: no output (no em dashes).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document OpenRouter fallback, provider routing, and cost visibility"
```

---

## Final verification

- [ ] **Run the full pre-push gate**

Run: `npm run prepublishOnly`
Expected: type-check (all three passes), lint, full Vitest suite, and both builds all clean.

- [ ] **Manual smoke (optional, if a local SK server is linked)**

Rebuild dist, restart SK, open the panel, fire an analyzer, and confirm: status shows non-zero "Tokens today"/"Est. cost today", the reports drawer shows model and cost on the new entry, and the privacy toggle round-trips through save.

## CHANGELOG / release

The CHANGELOG entry, README "What's new", version bump, tag, and GitHub release follow the project's release process (CLAUDE.md "Release process") and are done as a separate release commit, not inside the feature tasks above.

---

## Self-review notes (planner)

- **Spec coverage:** cost/token accounting (Tasks 1-5), prompt caching (Task 10), model fallback + provider routing + max_price (Tasks 9-12), privacy control (Tasks 9, 10, 12, 13), per-report enrichment (Tasks 6-8), docs (Task 14). All four approved pieces plus the spec's per-report enrichment are covered.
- **Correction vs spec:** the spec said only `alerts` overrides `publishOutput`; `forecast` does too. Task 7 handles both. The spec's "add `usage:{include:true}`" was dropped (deprecated no-op per verification); Task 1 parses the auto-returned usage instead.
- **Type consistency:** `PublishRunMeta` (Analyzer.ts) is the single run-meta type, consumed by publisher.ts, triggerRouter.ts, alerts.ts, forecast.ts. `CompleteResult.usage` shape (Task 1) is the source the router narrows from. `provider` config shape is identical in `PluginOptions.openrouter` (Task 9) and `OpenRouterCfg` (Task 10).
- **Known limitation (documented, not handled):** a tight-routing 503 ("no provider meets routing") flows through the existing transient-retry path and then fails the run. Disambiguating it from a genuine gateway 503 is out of scope.
