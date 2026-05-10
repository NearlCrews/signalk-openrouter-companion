# signalk-openrouter-companion: design

Status: draft 1, 2026-05-10
Owner: NearlCrews (NearlCrews@users.noreply.github.com)

## 1. Summary

A Signal K server plugin that runs LLM-powered analyzers over live vessel telemetry. Ships with one analyzer (engine maintenance reports after each session) and is structured so additional analyzers (voyage logger, alarm translator, anomaly watcher) can be added as one-file modules without touching the core. Calls OpenRouter for inference. Publishes reports as Signal K notifications and appends them to a log file under the plugin's data directory. Optionally enriches analysis with long-horizon history from a co-installed `signalk-questdb` instance, with graceful degradation when QuestDB is absent.

Targeted at the official Signal K app store. No vessel-specific assumptions.

## 2. Goals and non-goals

### Goals

- Zero-touch operation after install: configure once (API key), then it runs.
- Modular analyzers. Adding a new one is a single file plus one registration line.
- Portable across vessels: engine count, engine ids, battery topology, sources all discovered at runtime.
- Graceful empty-state: no engine, no QuestDB, no API key, no internet, no budget left, all handled with informative status, never with crashes or spam.
- Bounded cost: per-day call cap configurable.
- App-store-ready: correct keywords, license, metadata, CI-friendly layout.

### Non-goals (for v0.1)

- Cron-based or scheduled analyses. The `Analyzer` interface declares a `cron` trigger kind for forward compatibility, but no analyzer uses it in v0.1.
- Voice / TTS output. Reports are text only.
- Streaming LLM responses. Synchronous request/response is fine for ≤500 word reports.
- Multi-vessel context. Only `vessels.self`.
- Web UI beyond the SK admin "Plugin Config" pane.
- Cross-language support. Reports are English only.

## 3. Architecture

```
src/
├── plugin.ts                  # SK lifecycle: id, name, schema, start, stop
├── core/
│   ├── buffer.ts              # in-memory rolling buffer (path -> recent deltas)
│   ├── engineDetector.ts      # per-engine state machine: detects start/stop
│   ├── triggerRouter.ts       # maps TriggerSpec -> Analyzer; dispatches events
│   ├── openrouter.ts          # OpenRouter HTTP client (native fetch)
│   ├── questdb.ts             # optional QuestDB REST client (native fetch)
│   ├── publisher.ts           # default output: notification + JSONL log file
│   ├── budget.ts              # per-day call counter, persisted JSON
│   └── logger.ts              # thin wrapper over app.debug/app.error
└── analyzers/
    ├── Analyzer.ts            # interface + shared types
    └── maintenance.ts         # MaintenanceAnalyzer (v0.1's only analyzer)
```

One file per concern. The core has no analyzer-specific code; analyzers have no SK-API or HTTP code.

## 4. Configuration schema

Returned from `Plugin.schema()`. Persisted by the SK server into `$SIGNALK_NODE_CONFIG_DIR/plugin-config-data/signalk-openrouter-companion.json` on save.

```ts
type PluginOptions = {
  openrouter: {
    apiKey: string                                  // required; '' on first run
    model: string                                   // default 'anthropic/claude-haiku-4.5'
    baseUrl: string                                 // default 'https://openrouter.ai/api/v1'
    maxCallsPerDay: number                          // default 20
    requestTimeoutMs: number                        // default 60000
  }
  questdb: {
    enabled: boolean                                // default true (auto-probed on start)
    url: string                                     // default 'http://localhost:9000'
  }
  analyzers: {
    maintenance: {
      enabled: boolean                              // default true
      engineStopRpmHzThreshold: number              // default 1.0 (= 60 RPM)
      engineStopSettleSeconds: number               // default 10
      engineStartRpmHzThreshold: number             // default 5.0 (= 300 RPM)
      engineStartSettleSeconds: number              // default 5
      minSessionSeconds: number                     // default 60 (skip < 1m sessions)
      extraWatchedPaths: string[]                   // default []
    }
  }
  output: {
    notificationPath: string                        // default 'notifications.openrouter-companion.maintenance.report'
    notificationState: 'normal' | 'nominal'         // default 'normal'
    logFilename: string                             // default 'reports.jsonl'
  }
}
```

`uiSchema()` masks the API key:

```ts
{ openrouter: { apiKey: { 'ui:widget': 'password' } } }
```

Every field has a `title` and `description` in the schema for admin-UI readability (not shown above; spelled out in the implementation).

## 5. Plugin lifecycle

### 5.1 `start(options, restartPlugin)`

1. Wrap the entire body in try/catch; on throw, `app.setPluginError(stringify(err))` and return.
2. `app.setPluginStatus('Starting')`.
3. Coerce and lightly validate `options`. Missing `openrouter.apiKey`: set status to `'Awaiting API key'`, register nothing, return early (plugin loaded but inert).
4. Resolve `dataDir = app.getDataDirPath()`. Create `logFilename` if absent (touch). Load `budget.json` if present, else seed.
5. Build singletons: `buffer`, `engineDetector`, `openrouter`, `questdb` (if `questdb.enabled`), `publisher`, `budget`, `logger`.
6. Probe QuestDB once. On success, mark available. On failure, log warning and disable for this run; do not retry on a timer (re-probe on next plugin restart).
7. Discover engine ids: `app.streambundle.getAvailablePaths()` filtered to `propulsion.<id>.revolutions`. Parse `<id>`. The set may be empty (no engine data yet, or sailboat).
8. Subscribe:
   - Each `propulsion.<id>.revolutions` via `app.streambundle.getSelfBus(path)`. Each delta feeds `engineDetector.observe(engineId, sourceRef, hz, ts)` AND `buffer.record(...)`.
   - Each auto-watched maintenance path under `propulsion.*`, `electrical.batteries.*`, `electrical.alternators.*`, `electrical.chargers.*` via the same `getSelfBus`. Records into buffer only.
   - Each `extraWatchedPaths` entry from config. Records into buffer only.
   - All `notifications.propulsion.*` via `app.subscriptionmanager.subscribe({context: 'vessels.self', subscribe: [{path: 'notifications.propulsion.*', policy: 'instant'}]}, unsubs, onErr, onDelta)`. The `instant` policy is required: the default `fixed`/1000ms drops alarm bursts.
9. Register the `EngineDetector` event listeners (`engine-start`, `engine-stop`, `possible-stop`). On each, hand to `triggerRouter`.
10. Build the `triggerRouter` from enabled analyzers' `triggers` arrays.
11. Register PUT handlers for every `{kind: 'put', path}` trigger declared by an analyzer:
    `app.registerPutHandler('vessels.self', path, putHandler, PLUGIN_ID)`.
12. Start a periodic re-scan: every 60s, re-list available paths; if a new engine appears, subscribe and start tracking it. This handles NMEA2000 gateways that come up after the SK server.
13. `app.setPluginStatus('Running')`.

### 5.2 `stop()`

1. Drain all unsubscribes: `while (unsubs.length) try { unsubs.pop()?.() } catch (e) { logger.error(e) }`.
2. Clear the periodic re-scan interval.
3. Abort all in-flight HTTP via the shared `AbortController` set; replace with fresh controllers on next start.
4. Flush any buffered budget writes to disk.
5. `app.setPluginStatus('Stopped')`.

Returns `Promise<void>` so the server awaits cleanup.

### 5.3 Behavior on `restartPlugin`

Not called by the plugin itself. The admin UI restarts the plugin on every "Save" so config changes are picked up via the standard `stop()`/`start()` cycle.

## 6. Engine session detection

### 6.1 State machine (per engine)

Per `engineId`, hold:

```ts
type EngineState = {
  engineId: string
  running: boolean
  belowSince: number | null   // ts of first sustained-below reading (ms epoch)
  aboveSince: number | null   // ts of first sustained-above reading
  sessionStartTs: number | null
  lastDeltaTs: number
  // source aggregation:
  recentBySource: Map<string, { hz: number; ts: number }>  // last reading per $source within 1s window
}
```

### 6.2 Source aggregation

Same physical engine often publishes via multiple `$source` labels (e.g., `nmea2000_feed.X` and `notificationApi.X` on this vessel). For each incoming delta:

1. Update `recentBySource[sourceRef] = { hz, ts }`.
2. Evict entries older than 1000ms.
3. Effective RPM Hz for the engine = `max(recentBySource.values().hz)`.

Take the max (not mean) because any source seeing RPM means the engine is running.

### 6.3 Transitions

- Currently `running == false`: if effective Hz > `startRpmHz` for `>= startSettleSec` (using `aboveSince`), set `running = true`, `sessionStartTs = aboveSince`, emit `engine-start`.
- Currently `running == true`: if effective Hz < `stopRpmHz` for `>= stopSettleSec`, set `running = false`, emit `engine-stop({engineId, sessionStart: sessionStartTs, sessionEnd: belowSince, durationSec})`, clear `sessionStartTs`.

### 6.4 Watchdog (gateway dropout)

A 5-second ticker checks every engine. If `running == true` and `now - lastDeltaTs > 30000`, emit `possible-stop` (different event from `engine-stop`). Analyzers can opt to consume `possible-stop` with reduced confidence in the prompt. Default behavior: ignore.

### 6.5 Edge cases handled

- Cranking: brief dip < threshold during start, then climb. The settle timer absorbs this.
- Stall + restart: stop emitted, then a fresh start emitted. Two sessions. Acceptable; the analyzer can detect "session N+1 started < 60s after session N ended" if it cares.
- Multi-engine: independent state machine per `engineId`. Two engines stopping near-simultaneously emit two `engine-stop` events.
- Session shorter than `minSessionSeconds`: `engine-stop` still emits, but the maintenance analyzer's `collectContext` returns null, which makes the router skip the LLM call. Logged at debug.

## 7. Analyzer interface

```ts
// src/analyzers/Analyzer.ts

export type TriggerSpec =
  | { kind: 'engine-start' }
  | { kind: 'engine-stop' }
  | { kind: 'possible-stop' }
  | { kind: 'put'; path: string }
  | { kind: 'cron'; pattern: string }            // reserved; not wired in v0.1
  | { kind: 'sk-notification'; pathPattern: string } // reserved

export type TriggerCtx = {
  kind: TriggerSpec['kind']
  firedAt: Date
  engineSession?: {
    engineId: string
    start: Date
    end: Date
    durationSec: number
  }
  put?: { value: unknown }
  notification?: { path: string; value: NotificationValue }
}

export type AnalysisInput = {
  // arbitrary structured data the analyzer wants to feed its prompt
  [key: string]: unknown
}

export type AnalyzerDeps = {
  app: ServerAPI
  buffer: RollingBuffer
  questdb: QuestDBClient | null
  publisher: ReportPublisher
  budget: BudgetTracker
  llm: OpenRouterClient
  logger: Logger
}

export interface Analyzer {
  readonly id: string
  readonly title: string
  readonly triggers: ReadonlyArray<TriggerSpec>
  collectContext(ctx: TriggerCtx, deps: AnalyzerDeps): Promise<AnalysisInput | null>
  buildPrompt(input: AnalysisInput): { system: string; user: string }
  publishOutput?(text: string, ctx: TriggerCtx, deps: AnalyzerDeps): Promise<void>
}
```

`collectContext` returns `null` when the analyzer chooses to skip this trigger (too-short session, missing data, etc.). The router treats `null` as a no-op without calling the LLM.

`publishOutput` is optional. Default: `deps.publisher.publish(text, { analyzerId, ctx })`, which does the notification + JSONL log file write.

## 8. Trigger router

```ts
class TriggerRouter {
  constructor(private analyzers: Analyzer[], private deps: AnalyzerDeps) {}

  async dispatch(kind: TriggerSpec['kind'], ctx: TriggerCtx): Promise<void> {
    const matches = this.analyzers.filter(a =>
      a.triggers.some(t => triggerMatches(t, kind, ctx)))
    await Promise.allSettled(matches.map(a => this.runOne(a, ctx)))
  }

  private async runOne(a: Analyzer, ctx: TriggerCtx) {
    try {
      const input = await a.collectContext(ctx, this.deps)
      if (input == null) return
      if (!this.deps.budget.canSpend()) {
        this.deps.logger.debug(`${a.id}: budget exhausted, skipping`)
        return
      }
      const { system, user } = a.buildPrompt(input)
      const { text } = await this.deps.llm.complete({ system, user })
      this.deps.budget.recordCall()
      const publish = a.publishOutput ?? defaultPublish(a, this.deps)
      await publish(text, ctx, this.deps)
    } catch (err) {
      this.deps.logger.error(`${a.id}: ${stringify(err)}`)
      // Best-effort fallback notification so the user knows something failed
      this.deps.publisher.publishFailure(a.id, ctx, err).catch(() => {})
    }
  }
}
```

`Promise.allSettled` so one analyzer's failure can't block siblings.

## 9. MaintenanceAnalyzer (v0.1 concrete analyzer)

### 9.1 Triggers

```ts
[
  { kind: 'engine-stop' },
  { kind: 'put', path: 'plugins.openrouter-companion.maintenance.run' },
]
```

### 9.2 `collectContext(ctx, deps)`

For `engine-stop`:
- Skip if `ctx.engineSession!.durationSec < cfg.minSessionSeconds`. Return null.
- Build session window `[start, end]`.
- From `deps.buffer`, summarize every watched path that has data in the window: `{min, max, mean, count, sources[]}`.
- From `deps.app.getSelfPath('notifications.propulsion.<engineId>')`, snapshot the full sub-tree: current state of every engine alarm slot. Also include any state changes captured by the notifications subscription during the window.
- Snapshot all batteries: for each id in `electrical.batteries.*`, capture `voltage`, `current`, `capacity.stateOfCharge`, `capacity.nominal` (from meta), `temperature` if present.
- If `deps.questdb` is available: per watched path, query 30-day baseline `(min, max, p10, p50, p90, mean)`. One query per path. Concurrency cap 4. Total time cap 5s (`AbortController`); on timeout, drop the baselines and proceed.
- Pull current vessel meta: `vessels.self.name`, `vessels.self.mmsi` if set, `vessels.self.design.*` if set. These go in the prompt as plain facts.
- Pull every relevant path's `meta` (units, displayUnits, capacity.nominal) once and include it in the prompt so the LLM can reason about scale without baked-in vessel knowledge.

For `put`:
- Use "the most recent completed session" if one exists in `engineDetector`'s history (last 5 sessions retained), else "last 30 minutes of buffer with engine-running mask".

### 9.3 `buildPrompt(input)`

System: a tight marine-technician prompt (~150 words) defining role, output format (markdown, ≤ 350 words), and constraints (no speculation beyond data, flag known engine alarm slots if non-normal, summarize charging behavior, note anomalies vs baseline if baselines present).

User: structured. Roughly:

```
## Vessel
<name, mmsi, design, if known>

## Session
Engine: <engineId>
Start: <iso8601>
End:   <iso8601>
Duration: <h m s>

## Telemetry (this session)
<table of path | unit | min | max | mean | count | sources>

## Engine notification slots
<table of slot | state | message>

## Batteries (end-of-session snapshot)
<table of bank | voltage | current | SoC | nominalCapacity | temperature>

## 30-day baselines (where available)
<table of path | unit | p10 | p50 | p90>

## Meta
<units / displayUnits for any non-obvious paths>
```

No mention of model name, no role-play instructions, no "be helpful". Just facts in, report out.

### 9.4 `publishOutput`: default (notification + JSONL log).

## 10. OpenRouterClient

```ts
type OpenRouterCompleteArgs = {
  system: string
  user: string
  abortSignal?: AbortSignal
}
type OpenRouterCompleteResult = {
  text: string
  model: string
  usage: { promptTokens: number; completionTokens: number; totalTokens: number }
  raw: unknown   // for the JSONL log
}

class OpenRouterClient {
  constructor(private cfg: { apiKey, baseUrl, model, requestTimeoutMs })

  async complete(args: OpenRouterCompleteArgs): Promise<OpenRouterCompleteResult>
}
```

### 10.1 Request

`POST {baseUrl}/chat/completions` with:

```jsonc
{
  "model": "<cfg.model>",
  "messages": [
    {"role": "system", "content": args.system},
    {"role": "user",   "content": args.user}
  ]
}
```

Headers: `Authorization: Bearer <apiKey>`, `Content-Type: application/json`, `HTTP-Referer: https://github.com/NearlCrews/signalk-openrouter-companion`, `X-OpenRouter-Title: signalk-openrouter-companion`.

`AbortController` per call, chained to `args.abortSignal` AND to a fresh timeout (`cfg.requestTimeoutMs`).

### 10.2 Retry policy (per OpenRouter's documented error semantics)

- 200: parse `choices[0].message.content` → `text`; `usage.{prompt,completion,total}_tokens` → `usage`.
- 429, 502, 503: transient. Retry with backoff `[500ms, 1500ms, 4500ms]`, capped at 3 retries. Honor `Retry-After` header if present (use whichever is larger between header and computed backoff).
- 500: transient, same retry policy.
- 400, 401, 402, 403, 408, 413, 422: terminal. Throw a typed error (`OpenRouterError` with `code`, `message`, `metadata`).
- Network/abort error: treat as transient unless abort came from caller's `abortSignal`.

### 10.3 Logging

Log a one-line `app.debug` entry per call with `{model, status, latencyMs, promptTokens, completionTokens}`. Never log the API key, the prompt body, or the response content.

## 11. QuestDBClient

```ts
class QuestDBClient {
  constructor(private cfg: { url: string })

  async probe(abortSignal?: AbortSignal): Promise<boolean>
  async query(sql: string, abortSignal?: AbortSignal): Promise<{ columns: {name: string, type: string}[]; dataset: unknown[][] }>
}
```

Probe is `GET {url}/exec?query=SELECT%201&count=true`. Returns true on 200 with parseable JSON.

`query` GETs `{url}/exec?query=<urlencoded>&count=false`. Throws on non-200.

The maintenance analyzer holds a higher-level helper `baselineFor(path, days)` that:

1. Resolves self context once at start (`app.selfContext` from SelfIdentity interface, which is the full `vessels.urn:mrn:signalk:uuid:...` string).
2. Issues `SELECT min(value), max(value), avg(value), approx_percentile(value, 0.10), approx_percentile(value, 0.50), approx_percentile(value, 0.90) FROM signalk WHERE path = '<path>' AND context = '<ctx>' AND ts > dateadd('d', -<days>, now())`.
3. Returns `{min, max, mean, p10, p50, p90}` or null if no rows.

`approx_percentile` is QuestDB-native and fast.

## 12. RollingBuffer

In-memory map `path -> Array<{value, ts, source}>`. Append on every relevant delta. On each append, evict any entries older than `maxAgeMs` (default 6h). Memory cap: per-path entry count cap (default 10,000) with FIFO eviction.

Methods:

```ts
class RollingBuffer {
  record(path: string, value: number | string | object, ts: number, source: string): void
  slice(path: string, fromTs: number, toTs: number): Array<{value, ts, source}>
  summarize(path: string, fromTs: number, toTs: number): {
    min: number, max: number, mean: number, count: number, sources: string[]
  } | null   // null if no numeric data
}
```

String-valued paths (e.g., `propulsion.<id>.state` if present) are stored but skipped by `summarize`.

## 13. ReportPublisher

```ts
class ReportPublisher {
  constructor(private app: ServerAPI, private cfg: {
    notificationPath: string
    notificationState: 'normal' | 'nominal'
    logPath: string
  }) {}

  async publish(text: string, meta: { analyzerId: string; ctx: TriggerCtx }): Promise<void>
  async publishFailure(analyzerId: string, ctx: TriggerCtx, err: unknown): Promise<void>
}
```

### 13.1 Notification

`app.handleMessage(PLUGIN_ID, delta)` where delta is:

```ts
{
  updates: [{
    timestamp: nowIso,
    values: [{
      path: cfg.notificationPath,
      value: {
        state: cfg.notificationState,   // 'normal'
        method: ['visual'],
        message: text,
        id: `${analyzerId}-${nowMs}`
      }
    }]
  }]
}
```

`$source` is NOT set; server attributes the delta to the plugin id automatically.

### 13.2 JSONL log

Append one JSON object per line to `<dataDir>/<logFilename>`:

```json
{
  "ts": "2026-05-10T23:41:47.207Z",
  "analyzer": "maintenance",
  "trigger": "engine-stop",
  "engineId": "port",
  "sessionStart": "...",
  "sessionEnd": "...",
  "durationSec": 1234,
  "model": "anthropic/claude-haiku-4.5",
  "promptTokens": 1234,
  "completionTokens": 567,
  "report": "..."
}
```

JSONL is robust (tail-friendly, parseable line-by-line) and lets downstream tools (rotation, ingestion) work without parsing fragile multi-line formats.

### 13.3 Failure publish

On error in any analyzer, publish a notification with `state: 'warn'`, `method: ['visual']`, `message: "Maintenance report unavailable: <short reason>"`. So the user knows the plugin tried and failed; it doesn't go silently dark.

Failures from "no budget" are NOT published as notifications (would spam). Failures from "no API key" are NOT published (the status banner already says).

## 14. BudgetTracker

Persisted state at `<dataDir>/budget.json`:

```json
{ "day": "2026-05-10", "callsToday": 3, "lastCallTs": "2026-05-10T18:22:11.000Z" }
```

Methods:

```ts
class BudgetTracker {
  constructor(private cfg: { maxPerDay: number; statePath: string }) {}
  canSpend(): boolean   // false if today's count >= max
  recordCall(): void    // increments + flushes
}
```

Day rollover detected by comparing current UTC date to `day`; reset when different. No timer needed.

Flushes synchronously (small file, one writer) on every `recordCall`. On flush failure, log and continue (don't crash the analyzer).

## 15. Logging conventions

`app.debug(...)` for everything verbose. Toggled by `DEBUG=signalk-openrouter-companion` in the SK admin UI's server log filter.

`app.error(stringify(err))` for runtime errors. Always stringify before passing.

`app.setPluginStatus(...)` for state changes the user should see in the admin UI banner:
- `'Starting'`, `'Running'`, `'Stopped'`
- `'Awaiting API key'`
- `'Running, no engine data detected'`
- `'Running, budget exhausted for today'` (set on first attempt after exhaustion; cleared on next day's reset)

`app.setPluginError(...)` only for terminal config issues that block start (e.g., schema validation failure if we ever add strict checks).

Never log the API key, response bodies, or full prompt text. Token counts and latencies only.

## 16. Packaging and distribution

### `package.json` (skeleton in the dependency-analysis section above; final form lives in the repo)

Critical fields:

- `name`: `signalk-openrouter-companion`
- `version`: `0.1.0` initial; SemVer onward.
- `main`: `dist/index.js`
- `type`: `module`
- `keywords`: `['signalk-node-server-plugin', 'signalk-category-utility', 'signalk-category-cloud', 'signalk-category-notifications', ...]`
- `signalk-plugin-enabled-by-default`: `false`
- `signalk`: `{ displayName: 'OpenRouter Companion' }`
- `engines.node`: `'>=22'`
- `license`: `'Apache-2.0'`
- `peerDependencies`: `{ '@signalk/server-api': '>=2.24.0' }`

Plugin object adds `enabledByDefault: false`.

### Build

- `src/` (TS) → `dist/index.js` (single esbuild bundle, ESM, target `node22`).
- Types via `tsc --declaration --emitDeclarationOnly --outDir dist`.
- `@signalk/server-api` marked external in the bundle config; server provides it at runtime.

### Files shipped (`files` field)

`dist/`, `README.md`, `LICENSE`, `CHANGELOG.md`. Not `src/`, tests, or fixtures.

### CI

GitHub Actions calling `SignalK/signalk-server/.github/workflows/plugin-ci.yml@master` for the standard plugin-validation matrix (Node 22 + 24, package.json validation, build).

### README

Sections: what it does, install (via SK app store or `npm install -g`), required configuration (OpenRouter API key), optional QuestDB enrichment, example report, troubleshooting (no API key, no engine data, budget exhausted, QuestDB unreachable, OpenRouter rate-limited), how to add a custom analyzer.

### CHANGELOG.md

Keep-a-Changelog format, starting at 0.1.0.

## 17. Error handling and degraded modes summary

| Condition | Behavior | User signal |
|---|---|---|
| No `apiKey` | Plugin loads, no subscriptions, no PUT handlers | Status: 'Awaiting API key' |
| No engine paths after start + 60s rescans | Maintenance analyzer idle; other analyzers still work | Status: 'Running, no engine data detected' |
| QuestDB disabled or unreachable | Skip baselines; analyzer still runs | One-time `app.debug` warn |
| OpenRouter 429/502/503 | Retry up to 3x with backoff | Transparent on success; failure notification on final fail |
| OpenRouter 400/401/402/403/408/413/422 | Throw immediately | Failure notification with short reason |
| Budget exhausted | Skip call, no LLM hit | Status: 'Running, budget exhausted for today'; no notification spam |
| Plugin error in analyzer | Caught per-analyzer; others continue | Failure notification (one per failure) |
| Engine session < `minSessionSeconds` | `collectContext` returns null | Debug log, no notification |
| Source flapping | `EngineDetector` aggregates max across sources within 1s | No user-visible effect |
| Gateway dropout while running | `possible-stop` emits at 30s of silence | Analyzers may ignore (v0.1) |

## 18. Testing

Unit tests (Vitest):

- `engineDetector.test.ts`: synthetic delta streams. Cases: clean stop, source flapping, cranking dip, stall + restart within debounce, gateway dropout, multi-engine.
- `buffer.test.ts`: record, slice, summarize, eviction at age and count caps.
- `openrouter.test.ts`: mocked fetch. Cases: 200 happy path, 429 + retry with `Retry-After`, 502 + retry, 401 terminal, abort signal propagates.
- `budget.test.ts`: day rollover, persistence round-trip, max-per-day cap.
- `triggerRouter.test.ts`: dispatch fans out, `Promise.allSettled` isolates failures.
- `maintenance.test.ts`: `buildPrompt` snapshot test for stability; `collectContext` with stubbed deps.

Integration test:

- Spin up an in-process minimal `ServerAPI` mock (handful of methods) and an engine-session scenario; end-to-end assert the published notification and JSONL log entry.

Manual smoke on real SK server (the user's Pi, post-install): toggle `enabled` in admin UI, watch logs, fire a PUT.

## 19. Open questions and future work

- **Cron analyzers**: add `croner` when first non-event-driven analyzer appears (e.g., a "daily dock health summary").
- **History API**: `signalk-questdb` exposes a v2 History API via `app.registerHistoryApiProvider()`. Once stable, the QuestDB client could go through that abstraction instead of hitting QuestDB's REST directly, gaining cross-history-backend portability. Defer for v0.2 once the API is verified.
- **Streaming**: if reports grow beyond ~350 words or get used in a live UI, consider streaming and an SK-data-path output. Not for v0.1.
- **Tool calling**: future analyzer might want the LLM to call back into the SK API for clarifying queries. Big complexity jump; defer.
- **Multi-vessel**: not in scope.
- **Cost reporting**: OpenRouter returns generation cost. Could surface running total in the status banner.

## 20. References

- `@signalk/server-api` v2.24.0 (Apache-2.0) types and source: `/home/dietpi/src/signalk-server/packages/server-api/src/`.
- Example plugins consulted: `signalk-virtual-weather-sensors`, `signalk-nmea2000-emitter-cannon`, `signalk-questdb`.
- OpenRouter API: `https://openrouter.ai/api/v1/chat/completions`, error codes per `https://openrouter.ai/docs/api/reference/errors-and-debugging`.
- QuestDB REST: `GET /exec?query=...` on port 9000.
- Signal K spec 1.8.2: paths `propulsion.<id>.revolutions` (Hz), `electrical.batteries.<id>.*`, `notifications.*`.
