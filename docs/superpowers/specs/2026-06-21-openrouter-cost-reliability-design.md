# OpenRouter Cost & Reliability Layer

Design spec. Status: approved for planning. Date: 2026-06-21.

## Problem

Every analyzer run spends real money on an OpenRouter LLM call, but the plugin
has no visibility into token use or cost, and no reliability features on the
request envelope:

- The per-day cap counts **calls**, not tokens or dollars. A single call can
  cost an order of magnitude more than another (for example `liveness` on a
  vessel exposing hundreds of paths) and consume exactly one of the 20 daily
  slots. The cap cannot see it.
- `OpenRouterClient.complete()` already returns `{ text, model, usage }`, but
  `triggerRouter.ts` destructures only `{ text }` and discards model and usage.
- `reports.jsonl` rows record no model, tokens, or cost. The status panel shows
  only `callsToday / maxCallsPerDay`.
- The request body sends no prompt-cache breakpoints, no model fallback, no
  provider routing, and no privacy controls. A single provider 502 exhausts the
  retry ladder and fails the report (and for `alerts`, sounds the alarm).

This was the convergent finding of a four-agent code review: three of the four
agents independently flagged the missing cost/token observability.

## Goals

1. Make per-run and per-day token use and cost **visible** in `reports.jsonl`
   and the status panel.
2. Cut input-token cost where free to do so, via prompt caching on the stable
   system prompt for Anthropic-family models.
3. Improve reliability with an optional model-fallback chain and provider
   routing, including a `max_price` per-request backstop.
4. Add an outbound-privacy control (`data_collection: "deny"`).

## Non-goals

- **No soft daily cost ceiling.** Cost is observe-only; the existing per-call
  per-day cap remains the only hard spend bound. The chosen safeguard is the
  `provider.max_price` per-request backstop, nothing more. (`BudgetTracker`
  gains cost *accounting* but not cost *enforcement*.)
- **No backend pricing math.** Cost comes from OpenRouter's authoritative
  `usage.cost`. We do not multiply token counts by cached model pricing on the
  server.
- **No change to the call-cap race semantics.** `recordCall()` stays before the
  LLM await exactly as today. Agent 2's separate "budget records before the
  call, transient failures burn the cap" observation is explicitly out of scope.
- **No new analyzers.** This spec is the OpenRouter client/accounting/surface
  layer only. New analyzers (anchor-watch, digest, tanks, etc.) stay on the
  backlog.
- **Panel input knobs stay JSON-only**, except the one privacy toggle. Surfacing
  the full advanced-settings set in the panel is a separate backlog item.

## Design decisions (locked with the user)

| Decision | Choice |
| --- | --- |
| Scope | All four pieces: cost/token accounting + UI, prompt caching, model fallback / provider routing, privacy controls. |
| Cost control | Observe-only plus a `provider.max_price` per-request backstop. No daily cost ceiling. |
| Config surface | New input knobs JSON-only, **except** the `data_collection` privacy toggle, which is surfaced in the panel's OpenRouter section. |
| Cost source of truth | OpenRouter `usage.cost` only. A call that returns no cost contributes 0 to the daily total (labeled "est." in the UI). |

## Architecture

The change is a vertical slice through the existing request-to-status path. No
new modules; every touched file already exists.

```
openrouter.ts (request body + result parsing)
      |
      v
triggerRouter.ts (capture full result, record usage after success)
      |          \
      v           v
budget.ts     publisher.ts (JsonlEntry enrichment)
(daily totals)      |
      |             v
      v        reports.jsonl
api.ts buildStatus (tokensToday, costToday)
      |
      v
configpanel StatusBlock (display) + OpenRouterSection (privacy toggle)
```

### A. OpenRouter client (`src/core/openrouter.ts`)

`OpenRouterCfg` gains optional fields, all config-driven and absent-safe:

```ts
interface OpenRouterCfg {
  // ...existing: apiKey, baseUrl, model, requestTimeoutMs, referer, title, random
  fallbackModels?: string[];
  provider?: {
    sort?: 'price' | 'throughput' | 'latency';
    maxPrice?: { prompt?: number; completion?: number; request?: number };
    allowFallbacks?: boolean;
    dataCollection?: 'allow' | 'deny';
    zdr?: boolean;  // require zero-data-retention providers
  };
}
```

> Correction (as shipped): the `provider` object also carries an optional
> `zdr` boolean (require zero-data-retention providers), omitted from the
> original interface above.

In `attempt()`, the request body changes:

1. **Usage accounting.** Read `usage.cost` and
   `usage.prompt_tokens_details.cached_tokens` from the response.

   > Correction (as shipped): no `usage` flag is sent on the request body.
   > OpenRouter now returns `usage.cost` by default, and the `usage: { include:
   > true }` opt-in is deprecated, so the shipped code deliberately omits it and
   > simply parses the usage block from every response.
2. **Prompt caching.** When the active model slug starts with `anthropic/`, send
   the system message in content-array form with a cache breakpoint:
   ```ts
   { role: 'system', content: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] }
   ```
   For non-Anthropic models the system message stays the plain-string form
   (their caching is automatic). Below Anthropic's minimum-token threshold the
   breakpoint is a silent no-op, not a regression.

   > Correction (as shipped): the threshold is model-tier specific. The
   > 1,024-token floor applies to Sonnet and Opus; the shipped default model
   > (`anthropic/claude-haiku-4.5`) has a 4,096-token cache floor. So with the
   > default Haiku model the system prompt must exceed 4,096 tokens for caching
   > to engage at all; below that the breakpoint contributes nothing.
3. **Model fallback.** When `fallbackModels` is non-empty, send
   `models: [model, ...fallbackModels]` (the ordered routing list). When empty,
   the body keeps the single `model` field as today.
4. **Provider object.** When `provider` config is present, attach a `provider`
   object carrying `sort`, `max_price`, `allow_fallbacks`, and
   `data_collection`. Absent config sends no `provider` key.

`CompleteResult.usage` extends to carry the new fields, parsed with the existing
`?? 0` style:

```ts
export interface CompleteResult {
  text: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;  // body.usage.prompt_tokens_details?.cached_tokens ?? 0
    cost: number;          // body.usage.cost ?? 0  (USD credits)
  };
}
```

The `ApiResponse.usage` interface widens to include `cost` and
`prompt_tokens_details`. A response that omits any field yields 0, so an older
or non-conforming provider degrades cleanly rather than throwing.

### B. Trigger router (`src/core/triggerRouter.ts`)

`runOne` captures the full result instead of just text:

```ts
const result = await this.deps.llm.complete({ system, user, abortSignal: this.deps.signal });
```

After the call succeeds (the existing success path, after `setStatus`):

- **Accounting:** `await this.deps.budget.recordUsage(result.usage)`.
- **Enrichment:** pass `{ model: result.model, usage: result.usage }` into the
  publish path so it lands on the JSONL row (see D).

`recordCall()` is unchanged and stays before the LLM await. `recordUsage()` runs
only on success, so a failed or aborted call records no tokens/cost (matching the
"after success" rule and avoiding double counting).

### C. Daily accounting (`src/core/budget.ts`)

`BudgetTracker` keeps the call-cap gate and gains daily token/cost totals.

```ts
interface PersistedState {
  day: string;
  callsToday: number;
  tokensToday?: number;  // optional: back-compat with existing on-disk state
  costToday?: number;    // optional: back-compat with existing on-disk state
}
```

- `load()` defaults the two new fields to 0 when an existing state file lacks
  them (a pre-upgrade `{ day, callsToday }` file loads cleanly). The shape
  validation widens to tolerate the optional fields while still rejecting a
  malformed `callsToday`.
- `recordUsage(usage: { totalTokens: number; cost: number }): Promise<void>`
  runs `rolloverIfNeeded()`, increments `tokensToday` and `costToday`, and
  persists with the same best-effort try/catch as `recordCall()` (a write
  failure logs and does not reject).
- `tokensToday()` and `costToday()` getters call `rolloverIfNeeded()` first, like
  `callsToday()`.
- `rolloverIfNeeded()` resets all three counters together at the UTC day change.

Note: a successful call writes the state file twice (once in `recordCall` before
the await, once in `recordUsage` after). Both are best-effort and idempotent on
the in-memory state; the extra write is acceptable.

### D. Report log + publisher (`src/core/publisher.ts`)

`JsonlEntry` gains optional usage fields:

```ts
export interface JsonlEntry {
  // ...existing: ts, analyzer, trigger, engineId, sessionStart, sessionEnd, durationSec, report, failure
  model?: string;
  totalTokens?: number;
  cachedTokens?: number;
  costUsd?: number;
}
```

`buildEntry` accepts an optional run-meta argument `{ model, usage }` and folds
the fields onto the entry when present. Failure rows (`publishFailure`) carry no
usage, since no successful call occurred.

**The `publishOutput` wrinkle.** The default report path
(`publisher.publishReport`) is called by the router, which can pass the run meta
directly. But the `alerts` analyzer overrides `publishOutput`, building its own
`publishOnPath` call. To get usage onto the alerts log row:

- The `Analyzer.publishOutput` signature gains an optional fourth parameter:
  `publishOutput?(text, ctx, deps, runMeta?)` where
  `runMeta = { model: string; usage: CompleteResult['usage'] }`.
- The router passes `runMeta` when calling `a.publishOutput(text, ctx, deps, runMeta)`.
- `alerts.publishOutput` forwards it into the `PublishMeta` it hands to
  `publishOnPath`.
- `PublishMeta` (the `{ analyzerId, ctx }` object) gains optional `model` and
  `usage`, and `publishOnPath` / `publishReport` thread them into `buildEntry`.

This is a small, bounded interface extension. The parameter is optional, so any
analyzer that does not need it is unaffected.

### E. Status (`src/core/api.ts`)

`StatusResponse.openrouter` gains two fields:

```ts
openrouter: {
  apiKeySet: boolean;
  model: string;
  callsToday: number;
  maxCallsPerDay: number;
  tokensToday: number;   // rt.budget.tokensToday()
  costToday: number;     // rt.budget.costToday()
};
```

`buildStatus` reads them from the budget. No new route is added; the existing
`/api/status` poll carries the fields.

### F. Panel (`src/configpanel/`)

- **`components/StatusBlock.tsx`**: add a "Tokens today" figure and an
  "Est. cost today" figure (formatted as USD) alongside the existing
  `callsToday / maxCallsPerDay` line. The "est." label reflects that a call
  returning no `usage.cost` contributes 0.
- **`components/OpenRouterSection.tsx`**: add the `data_collection` privacy
  control (a toggle or segmented Allow/Deny). It writes
  `cfg.openrouter.provider.dataCollection` through the existing `save(fullCfg)`
  contract. No other new panel inputs.
- **`hooks/useStatus.ts`** and the panel status type widen to carry
  `tokensToday` / `costToday`. No new fetch; the fields ride the existing poll.
- Reports drawer (`AnalyzerRow.tsx`): when a report row carries `model` /
  `totalTokens` / `costUsd`, show them in the entry's metadata line. Optional
  within this spec but cheap once the fields exist.

### G. Config + schema + types (`src/types.ts`, `src/schema.ts`)

- `PluginOptions.openrouter` and `DEFAULT_OPTIONS.openrouter` gain
  `fallbackModels` (default `[]` or omitted) and `provider` (default omitted;
  `provider.dataCollection`, `provider.sort`, `provider.maxPrice`, and
  `provider.allowFallbacks` all live under it). Defaults preserve today's
  behavior exactly: no fallback, no provider object, `data_collection` unset
  (OpenRouter default).
- `schema.ts` rjsf fallback gains the same fields so the JSON-schema form can
  edit them when the custom panel is unavailable. The privacy field also appears
  in the custom panel (E); the rest are JSON-only.

### H. Docs

- README advanced-settings section documents the new JSON-only knobs
  (`fallbackModels`, `provider.sort`, `provider.maxPrice`, `allowFallbacks`)
  with units and defaults. The privacy toggle is documented as a panel control.
- CHANGELOG entry on release (separate from this spec).

## OpenRouter API verification gate (must run first)

All three review agents flagged that the exact OpenRouter field names and
semantics need confirmation against current docs before coding. The
implementation plan opens with an `openrouter-marine-expert` verification pass
that confirms, against live OpenRouter documentation:

1. The usage-accounting opt-in flag (expected `usage: { include: true }`) and
   the response field for cost (`usage.cost`) and cached input tokens
   (`usage.prompt_tokens_details.cached_tokens`).
2. The `cache_control` breakpoint shape, the Anthropic minimum-token threshold,
   and the cache-read price multiplier (agents saw inconsistent published
   numbers; confirm before quoting any saving).
3. The `provider` object field names: `data_collection`, `max_price` (and its
   sub-fields), `sort`, `allow_fallbacks`.
4. The `models[]` fallback array semantics (whether it replaces `model` or rides
   alongside it, and ordering).

Every parse keeps a graceful `?? 0` / optional-field fallback so a wrong
assumption degrades rather than breaks. If a field name differs from the
expectation above, the plan adjusts the single constant/key, not the structure.

## Testing

| Area | Tests |
| --- | --- |
| `openrouter.ts` request body | `usage: { include: true }` always present; `cache_control` present for an `anthropic/` model and absent for a non-Anthropic model; `provider` object built only when config present, with the right keys; `models` array present only when `fallbackModels` non-empty, ordered primary-first. |
| `openrouter.ts` result parsing | `CompleteResult.usage` parses `cost` and `cachedTokens`; a response omitting them yields 0; existing token fields unchanged. |
| `budget.ts` | `recordUsage` accumulates tokens and cost; `tokensToday`/`costToday` reflect it; UTC rollover resets all three; loading a pre-upgrade `{ day, callsToday }` state file defaults the new fields to 0; a write failure does not reject. |
| `publisher.ts` | `JsonlEntry` carries `model`/`totalTokens`/`cachedTokens`/`costUsd` when run-meta is provided and omits them otherwise; failure rows carry none. |
| `triggerRouter.ts` | `recordUsage` is called on success and not on failure/abort; run-meta threads to `publishReport` and to an overriding `publishOutput`. |
| `api.ts` | `buildStatus` includes `tokensToday`/`costToday` from the budget. |
| panel | (if React test harness adopted) `StatusBlock` renders the new figures; otherwise covered by the status-type widening and a manual check. |

All work must pass the existing pre-push gate (`npm run prepublishOnly`:
type-check + lint + test + build) and `npm run type-check`'s three passes
(`src/`, `tests/`, panel).

## Risks and mitigations

- **Wrong OpenRouter field name.** Mitigated by the up-front verification gate
  and graceful `?? 0` parsing. Blast radius is one key, not the structure.
- **Caching saves nothing for daily/weekly cron analyzers** (5-minute TTL rarely
  spans scheduled runs). Accepted: caching's value concentrates on `alerts`
  bursts and operator "Fire now" clusters; the durable wins here are visibility
  (cost/token surfacing) and reliability (fallback). Not a regression anywhere.
- **`max_price` or `sort: "price"` can move routing off the cached endpoint**,
  reducing cache hits. Documented tradeoff; both are opt-in and off by default.
- **Double state-file write per successful call** (recordCall + recordUsage).
  Accepted; both best-effort, neither rejects.
- **`usage.cost` absent from a provider's response.** That call contributes 0 to
  the daily cost; the UI labels the figure "est." to set expectations.

## Out of scope (backlog, from the same review)

- New analyzers: anchor-watch (drag detection), daily digest, tanks, bilge,
  charging-efficiency, AIS traffic.
- Off-vessel delivery (webhook / Pushover / ntfy / email).
- Structured outputs (`response_format`) to replace `forecast`'s `SEVERITY:`
  string parsing.
- Surfacing the full advanced-settings set in the panel.
- Code-quality hardening: discriminated `TriggerCtx` union, QuestDB
  null-guard/try-catch in `aging`/`drift`, compile-enforced registry/ids,
  buffer eviction fast-path, `liveness` prompt cap.
