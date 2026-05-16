# LLM-path resilience design

Date: 2026-05-15
Status: approved, ready for implementation plan

## Problem

The `OpenRouterClient` already handles a request timeout (`AbortController`),
caller-abort propagation, HTTP-status retry classification (429/500/502/503
transient; 400/401/402/403/408/413/422 terminal), a 3-attempt backoff ladder,
and the `Retry-After` header. `TriggerRouter` wraps every analyzer run in
try/catch and calls `publishFailure` on error.

Four gaps remain, all relevant to a vessel with intermittent connectivity:

1. **Network/transport errors are never retried.** If `fetch()` itself rejects
   (connection reset/refused, DNS failure) or the internal timeout fires, the
   rejection propagates straight out of `doCall` with zero retries. Only HTTP
   status codes are retried. A dropped connection is the most common real-world
   failure on a boat and currently gets no retry.
2. **`504` Gateway Timeout** is not in `TRANSIENT_STATUSES`, so it is treated as
   permanently fatal.
3. **No jitter** on backoff: multiple analyzers retrying on the same cron tick
   back off in lockstep.
4. **Empty completion** (HTTP 200 with `content: ''`) is returned as success, so
   an empty model response publishes an empty report.

## Approach

Extend the existing recursive `doCall` in place. The recursion already threads
`attempt` correctly and the file is small (146 lines); the four gaps are local
additions. A classify-then-retry rewrite or a generic `withRetry` helper were
rejected as a rewrite of working code and premature generalization (one call
site, OpenRouter-specific classification).

## Design

All changes in `src/core/openrouter.ts` unless noted.

### 1. Network/timeout retry

Wrap the `fetch(...)` call in try/catch inside `doCall`. On rejection:

- If `args.abortSignal?.aborted` is true, the caller asked to stop: rethrow the
  error as-is, no retry.
- Otherwise it is a transport failure (connection reset/refused, DNS, or the
  internal timeout `AbortController` firing). Treat it exactly like a transient
  HTTP error: if `attempt >= 3`, throw
  `new OpenRouterError(0, message, undefined, true)`; otherwise
  `await delay(backoffMs(attempt, null))` and recurse with `attempt + 1`.
- Status `0` on `OpenRouterError` means "no HTTP response / transport error".
- Network errors share the same `attempt` counter and `>= 3` cap as HTTP
  transient errors, so a mixed run of timeouts and 503s still caps at 4 total
  calls.

The internal timeout abort is correctly classified as retryable: when the
timeout fires, `args.abortSignal` is undefined (or not aborted), so the
caller-abort branch is not taken.

### 2. `504` transient

Add `504` to `TRANSIENT_STATUSES`.

### 3. Jitter

`backoffMs` applies equal jitter to the ladder base:
`jitteredBase = base * (0.5 + random() * 0.5)`. `Retry-After` is a server
instruction, so jitter applies only to the ladder component; the final delay is
`Math.max(jitteredBase, retryAfterMs ?? 0)`.

To keep jitter tests deterministic, add an optional `random?: () => number` to
`OpenRouterCfg`, defaulting to `Math.random`. This mirrors the existing
`now?: () => Date` pattern in `BudgetTracker`.

### 4. Empty completion

After extracting `text` from a 200 response, if `text.trim() === ''` throw
`new OpenRouterError(200, 'empty completion', body, false)` (non-retryable).
`TriggerRouter` already catches it and calls `publishFailure`; no change there.

### Supporting change: `api.ts` guard

`/api/openrouter/test` does `res.status(err.status)`. A transport error now
carries `status: 0`, which is invalid for `res.status()`. Change the status
resolution to:
`const status = err instanceof OpenRouterError && err.status >= 400 ? err.status : 500;`
so transport errors surface as a clean HTTP 500.

## Testing

Additions to `tests/openrouter.test.ts` (existing 7 tests must still pass):

- Network error rejected once, then a 200: retried, succeeds.
- Network error on every attempt: throws `OpenRouterError` with
  `retryable: true`, `status: 0`, fetch called 4 times.
- Internal timeout abort fires: retried, not treated as a caller abort.
- Caller `abortSignal` aborted: rethrown, fetch called once, no retry.
- `504`: retried like `503`.
- Empty-content 200: throws `OpenRouterError`, fetch called once (no retry).
- Jitter: inject `random: () => 0` and `random: () => 1`, assert the two
  backoff bounds.

`npm run prepublishOnly` (type-check + lint + test + build) must be clean.

## Scope

- Files touched: `src/core/openrouter.ts`, `src/core/api.ts`.
- ~7 new tests in `tests/openrouter.test.ts`.
- No schema, React panel, or `TriggerRouter` changes.
- Retry tuning stays as hardcoded constants; no new config-panel knobs.
- CHANGELOG entry and version bump are out of scope for this design (decide at
  implementation time).
