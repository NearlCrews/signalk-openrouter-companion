# Changelog

All notable changes will be documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

<a id="v060"></a>

## [0.6.0] - 2026-06-21

A cost and reliability release for the OpenRouter request layer. No new
analyzers and no config migration: existing config loads unchanged, and every
new setting is opt-in and absent-safe. The per-day call cap is still the only
hard spend bound; the new cost figures are observe-only.

### Added

- **Daily token and estimated-cost tracking.** The budget tracker now
  accumulates total tokens and OpenRouter's reported `usage.cost` per UTC day
  alongside the call count, surfaced through `/api/status` and shown in the
  config panel status block. A pre-upgrade budget file loads cleanly with the
  new totals defaulting to 0.
- **Prompt caching for Anthropic-family models.** The stable system prompt is
  sent with a cache breakpoint when the active model slug starts with
  `anthropic/`, so repeat runs in a burst can reuse cached input tokens.
  Non-Anthropic models keep automatic caching.
- **Ordered model fallback.** A new `openrouter.fallbackModels` list sends an
  ordered routing list (primary first) so a single provider fault can fall
  through to the next model instead of failing the run.
- **Provider routing controls.** New `openrouter.provider` config exposes
  `sort` (price, throughput, or latency), `maxPrice` (a per-request price
  ceiling), `allowFallbacks`, and `zdr` (require zero-data-retention
  providers). Absent config sends no provider object, preserving today's
  behavior.
- **A provider data-collection privacy control** in the panel's OpenRouter
  section, writing `provider.dataCollection` (allow or deny) so a run can route
  only to providers that do not retain request data.
- **Per-report model, token, and cost metadata.** Each successful run records
  its model, total and cached tokens, and cost on its `reports.jsonl` row, and
  the panel's reports drawer shows the model and cost per report.

### Changed

- **The trigger router now captures the full OpenRouter result** (model and
  usage), not just the report text, and records token and cost usage after a
  successful call. Failed or aborted runs record no usage.
- **An explicit `zdr: false`** is sent when zero-data-retention is not
  required, rather than relying on an implicit default.

<a id="v057"></a>

## [0.5.7] - 2026-06-11

### Fixed

- **Shutdown during an in-flight analyzer run is now silent.** When the plugin
  stops mid-run, the aborted analyzer no longer publishes a failure report, and
  the `alerts` analyzer no longer raises its audible alarm for the interrupted
  run.
- **A PUT fired before the plugin has finished starting returns a clean 503.**
  The early request used to get a 503 carrying a pending body and a dead href;
  it now returns a plain, well-formed 503.
- **Malformed `Retry-After` headers no longer misparse.** A value such as
  `12abc` is rejected rather than read as 12 seconds, so a bad upstream header
  cannot shorten the backoff.
- **The budget file rejects a corrupted negative call count** instead of
  trusting it, so a truncated or hand-edited counter cannot hand out extra
  calls.
- **The Max calls per day field can be cleared while editing** and no longer
  changes value when the scroll wheel passes over it.

### Added

- **Config panel theme support**: light, dark, and a red-preserving night mode,
  with a persisted theme toggle.
- **A Discard button and an unsaved-changes warning**, so in-progress edits are
  not lost by accident.
- **An "updated Xs ago" staleness cue** on the live status block, so a stalled
  poll is obvious at a glance.
- **A Retry button** for when the OpenRouter model list fails to load.
- **A first-run callout** prompting for an API key when none is configured.
- **An OpenAPI document** for the plugin's REST routes, served at the plugin's
  `openapi.json` and rendered in the Signal K admin API browser.

### Changed

- New plugin icon badge: the routing-graph glyph is replaced with a chat
  bubble carrying a white four-point sparkle on the violet badge,
  reflecting the plugin's role of narrating vessel data into Signal K
  notifications. The family base (deep-ocean gradient and three wave
  lines) is unchanged, and all PNG sizes are regenerated from the new SVG.
- **The config panel is now TypeScript** with larger marine-friendly touch
  targets (22px checkboxes, 36px buttons) and screen-reader fixes: alert roles
  on status, real headings, disclosure wiring, and focus management for the
  prompt drawer.
- **Status polling pauses in hidden browser tabs** and resumes on return, and a
  keystroke now re-renders only the field it edits instead of the whole panel.
- **Duplicated helpers are consolidated**: one finite-number coercion, shared
  clamp helpers, shared QuestDB row decode and time-range builders, shared
  monitor eviction, and one fetch-timeout helper.
- **Type checking now covers `tests/` and the config panel**, and the esbuild
  bundle target is aligned to the Node 20.18 engines floor.

<a id="v056"></a>

## [0.5.6] - 2026-06-04

A hardening release. No new analyzers and
no config migration. Analyzer-run failure notifications now differentiate by
analyzer class so a transient OpenRouter or QuestDB fault on a best-effort report
no longer sounds the helm alarm, while the safety alerts analyzer keeps its
failures audible. A latent forecast wind-direction bug is fixed, several
duplicated helpers are consolidated, the battery-alert dependency on the LLM call
and the shared daily budget is now documented, and 23 tests close coverage holes.

### Added

- **`Analyzer.failureAudible`**, an optional flag (default silent) that opts an
  analyzer into audible failure notifications. The `alerts` analyzer sets it so a
  sustained battery-alert failure still beeps; the six narrative analyzers leave
  it unset and fail silently.
- **`isSeverityFloor` type guard** in `src/severityFloors.ts`, derived from
  `SEVERITY_FLOOR_PRESETS` so the accepted-value set cannot drift from the
  presets, mirroring `isAnalyzerId`.
- **`signalk.recommends`** ("Works well with") listing the author's companion
  plugins that pair by real data flow: `signalk-virtual-weather-sensors` (feeds
  the forecast analyzer's weather paths) and `signalk-nmea2000-emitter-cannon`
  (forwards the alert notifications to NMEA 2000 PGN 126983).
- **23 tests** closing coverage holes: emitter listener isolation and error
  reporting, battery-monitor silence-clears-imbalance and settle-reset, health
  `collectCells` for both BMS cell shapes, alerts cell-imbalance prompt and
  discard guard, OpenRouter Retry-After HTTP-date and abort-at-delay, QuestDB
  `withTimeout`, the budget write-failure log, the PUT-handler 503 and 500 paths,
  and a lock on the documented budget-exhausted no-publish behavior.

### Changed

- **Analyzer-run failures now differentiate audibility by analyzer.** The six
  narrative analyzers publish failures visual-only (`method: ['visual']`, silent)
  so a transient fault does not sound the helm alarm louder than a success report
  (which is silent at `nominal`); the safety `alerts` analyzer keeps its failures
  audible (`method: ['visual','sound']`).
- **The `TypedEmitter` base routes a throwing listener through the injected
  plugin logger** (`app.error`) instead of `console.error`, so the only
  `console.*` in non-panel `src` is gone and listener errors land on the Signal K
  server log surface.
- **Shared-helper reuse:** the engine detector drops its local `numOrNull` for
  the identical shared `asFiniteNumber`, the forecast analyzer's `normalizeFloor`
  uses the new `isSeverityFloor` guard, and the wind-direction path is
  single-sourced as `WIND_DIRECTION_PATH` in `src/core/paths.ts`.
- **The `clean` build script is now cross-platform** (Node `fs.rmSync`) instead
  of unix-only `rm -rf`, so the SignalK plugin-ci Windows matrix runs cleanly.
- **Dependencies refreshed** to current within range, and the
  `@signalk/server-api` build pin moved to 2.25.0 (the peer range already allowed
  it). `npm audit` of runtime dependencies is clean.

### Fixed

- **Forecast wind-direction path was duplicated in three places.** The
  circular-mean heading calculation gates on that exact string, so editing the
  canonical path without the other copies would have silently fallen back to an
  arithmetic mean across the 0/2pi wrap, producing a wrong heading with no error.
  The path is now single-sourced.

### Documentation

- **Documented that battery threshold alerts are LLM-and-budget contingent.** The
  per-bank alert is written by an OpenRouter call gated by the shared daily
  budget, so a spent budget or an outage can drop a crossing at the helm. The
  schema description, the README, and `CLAUDE.md` now state this and advise
  pairing with a hardware or BMS alarm. The deliberate low-SoC latch-on-silence
  asymmetry with cell-imbalance is also documented in `src/core/batteryMonitor.ts`.

<a id="v055"></a>

## [0.5.5] - 2026-05-28

A maintainability and registry-compliance release with no behavior change for
existing installs. A cleanup of the whole codebase consolidated
duplicated logic into shared helpers and pushed several analyzer-specific
special-cases down into the shared extension point: the lifecycle no longer
hardcodes the forecast analyzer's weather paths, config merging is driven by the
single `ANALYZER_IDS` source of truth, and the per-analyzer default-prompt map
moved next to the factory map. The plugin now also ships admin-panel screenshots
so it scores full marks on the community SignalK plugin registry.

### Added

- **`signalk.screenshots` in `package.json`**, shipping two admin-panel
  screenshots under `assets/screenshots/` in the published tarball. This
  satisfies the SignalK plugin registry's screenshots check, the last item
  between the plugin and a 100/100 compatibility score, and supplies the App
  Store hero image.
- **`Analyzer.watchedPaths`**, an optional declaration of fixed Signal K paths
  an analyzer needs buffered that are not discovered from the live tree. The
  lifecycle subscribes the union across enabled analyzers, so the forecast
  analyzer's weather leaves are no longer a hardcoded branch in `index.ts`.

### Changed

- **`mergeWithDefaults` now iterates `ANALYZER_IDS`** instead of merging seven
  hand-listed sections, so a new analyzer's saved config can no longer be
  silently dropped by an overlooked key.
- **The default-system-prompt map moved from `core/api.ts` to
  `analyzers/registry.ts`** (as `ANALYZER_DEFAULT_SYSTEM_PROMPTS`), next to the
  factory map, removing the import edge from the core HTTP layer to every
  analyzer module. Adding an analyzer now touches `ids.ts` and `registry.ts`
  only.
- **Shared helpers replace duplicated logic:** the battery-bank node guard
  (`isBankNode`) is now one function in `core/skNode.ts`, the QuestDB
  whitespace-flatten is `flattenSql` in `core/questdb.ts`, the panel's REST
  error-string fallback is `errText` in `configpanel/api.js`, and `core/api.ts`
  reuses `stringify` for error coercion.
- **Minor panel and code cleanups:** the config panel's dirty-flag is memoized,
  the severity-floor control renders on prop presence rather than a hardcoded
  analyzer id, and dead code (an unused export, two unused `bankPaths` fields,
  an unreachable error block) was removed.

<a id="v054"></a>

## [0.5.4] - 2026-05-25

A 15-finding follow-up to 0.5.3, fixing regressions and weak spots in that
release's diff. The biggest is symmetric clock-skew clamping on inbound deltas (0.5.3
only clamped future-stamped deltas, so a 1970 timestamp still produced a phantom
multi-decade engine session). The Save button's new stuck-on-error edge, the
config panel's React 19 state-updater purity violations, the dirty-flag
regression on the prompt reset, and the cell-imbalance hysteresis's weakened
settle guarantee are also fixed.

### Fixed

- **A far-past delta timestamp is now clamped, symmetric to the future-stamp
  clamp 0.5.3 introduced.** A sensor with no RTC reporting `1970-01-01` (or
  one sending Unix seconds parsed as ms-since-1970) used to pass through and
  feed the engine detector with a decades-old `lastDeltaTs`; the next watchdog
  tick would then end a phantom multi-decade session. The clamp now rejects
  deltas more than one hour off wall-clock in either direction.
- **The Save button cannot get pinned at "Saving..." on a silent failure.**
  `onSave` now wraps `save(cfg)` in a try/catch and falls back on a 30-second
  timeout if the host never pushes a fresh configuration back; a synchronous
  reject surfaces the error in the post-save notice slot.
- **The panel's dirty-flag no longer falsely flags a Reset Prompt as a real
  edit.** The new key-stable `deepEqual` treated an explicit-undefined key
  as distinct from a missing one; `onPromptReset` writes
  `customSystemPrompt: undefined`, so a no-op reset used to enable Save.
- **The config panel's drawer-toggle and fire handlers no longer fire side
  effects from inside `setState` updaters.** React 19 (and any concurrent
  rendering) may call updaters more than once, which would double-fire
  `loadReports`, `loadPrompt`, and the `fireAnalyzer` follow-up `setTimeout`.
  The handlers now read live state through a ref and the load helpers
  carry an in-flight dedup guard.
- **The cell-imbalance settle guarantee is restored.** The 0.5.3 hysteresis
  preserved `imbalanceSince` across an in-band dip (between the 80% exit floor
  and the alert threshold); a sample dipping mid-window then bouncing back
  could fire `cell-imbalance-enter` despite imbalance NOT being continuously
  above the alert threshold for the full settle window. The clock now resets
  on any sample below the alert threshold; exit hysteresis is preserved.
- **`validateOptions` rejects pathological zeros on the alert thresholds.**
  `cellImbalanceV=0` (any sensor jitter fires an alert) and
  `socExitHysteresis=0` (low-SoC enter/exit pairs spam at the boundary) are
  now clamped to safe minimums. The `imbalanceSettleSec` minimum is also
  raised from 0 to 1 to keep the settle gate meaningful.
- **`mergeWithDefaults(undefined)` now also runs `validateOptions`.** The
  no-input bootstrap used to short-circuit straight to a `clone(DEFAULT_OPTIONS)`
  return, bypassing the new clamping. Harmless today (defaults are valid), but
  a future default that needed clamping would silently bypass it.
- **`isBankNode` rejects metadata-only children of `electrical.batteries`.**
  The 0.5.3 predicate only rejected children with a top-level `value` leaf;
  a future SK release attaching a `meta` container (no `value`) would have
  been treated as a phantom bank id `meta`. The predicate now requires at
  least one canonical bank field (`voltage`, `current`, `capacity`, or
  `temperature`).
- **The `/api/questdb/test` endpoint normalizes the URL** so a trailing slash
  (common copy-paste from a browser address bar) does not produce a double
  slash in the probe path.
- **The `withTimeout` helper guards every abort against double-call.** The
  prior pattern called `ctrl.abort` from both the listener and an explicit
  `if (caller?.aborted)` check; the new helper short-circuits on the
  already-aborted controller, future-proofing against a runtime that throws
  on second abort.

### Changed

- **REST 404/500/502 envelopes now match the 503 envelope.** `requireAnalyzerId`
  and the `/openrouter/models` and `/analyzers/:id/reports` error handlers
  return `{ ok: false, error }` so a single panel branch handles every
  failure path uniformly. The 0.5.3 promise of a consistent envelope is now
  actually consistent.
- **`registerWithRouter` fails loud when `securityStrategy` is missing.**
  The 0.5.3 optional-chain silently skipped the admin gate if SK had not
  attached `securityStrategy` at registration time; the gate now sets a plugin
  error and logs so the operator learns from the admin status banner.
- **The `/fire` panel handler maps the new `unknown` outcome to "Analyzer
  not registered"** with a danger-color badge, instead of falling through
  to "Dispatched" which read as success.
- **The `/api/analyzers/:id/prompt` response includes `runtimeReady`** so a
  future panel can distinguish "no override set" from "plugin not yet
  started". Backward-compatible: the existing `current: null` semantics are
  unchanged.
- **The stale comment in `src/analyzers/alerts.ts` that claimed the full LLM
  text reached the SK notification is corrected** to match the actual
  behavior (truncated headline to the notification; full text to the JSONL
  log via `logText`).
- New regression tests lock in the dual-emit `value.data.alertId` and the
  separate-log-vs-display behavior so a future refactor cannot silently
  drop either.

<a id="v053"></a>

## [0.5.3] - 2026-05-25

A Signal K conformance release. The headlines: the plugin's seven REST
routes were unauthenticated and could be hit by any caller on the SK admin
network (one route spends OpenRouter budget, one probed arbitrary URLs from the
boat, several leak operational data and report history); a single delta carrying
a future timestamp could evict the entire rolling buffer and freeze the engine
watchdog forever. Both classes are now closed at the trust and input edges, and
a long list of smaller spec, correctness, and cleanup findings landed in the
same release.

### Security

- **All plugin REST routes are now gated by `addAdminMiddleware`.** On a SK
  server with security enabled, the seven `/plugins/signalk-openrouter-companion/api/*`
  routes now require an authenticated admin caller. On a server with security
  disabled the gate is a no-op so dev setups are unaffected.
- **`/api/questdb/test` validates its URL before fetching.** The body's `url`
  is parsed, restricted to `http:`/`https:`, and only then handed to the
  QuestDB client; an authenticated admin can no longer probe arbitrary schemes
  from the SK host.

### Fixed

- **A future-timestamped delta no longer evicts the rolling buffer or freezes
  the engine watchdog.** The subscribe wrapper clamps incoming timestamps to
  wall-clock; the engine detector's restore path rejects snapshots stamped in
  the future. Either case was previously a one-delta bomb on the forecast and
  liveness trend windows and on engine stop detection.
- **The full LLM text for each battery alert now lands in the JSONL report
  log.** Previously the log only saw the 64-char chartplotter headline; the
  inline comment claiming "anything longer survives in the log" was
  contradicted by the code. The notification still carries the truncated
  headline for PGN 126985.
- **Cell-imbalance alerts no longer spam on a bank oscillating around the
  threshold.** An exit re-arms only once the imbalance drops below 80% of the
  alert threshold, matching the same hysteresis pattern as the low-SoC alert.
- **`/api/openrouter/test` aborts on plugin stop instead of hanging for up to
  60s** and no longer counts against the daily call budget (the carve-out is
  documented in the panel hint).
- **Notifications with `state: nominal` are emitted with `method: []`** instead
  of `['visual']`, matching the SK 1.8.2 convention that nominal is the
  informational/no-action state. The daily/weekly narrative reports
  (health/aging/drift/liveness/forecast) no longer advertise themselves as
  visual notifications.
- **Numeric config values are clamped at load time.** A saved `maxCallsPerDay`
  of 0 (a UI input cleared to empty) no longer pegs the status banner at
  "budget exhausted" forever; a non-finite engine RPM threshold falls back to
  the default. The panel's max-calls input refuses to write values below 1.
- **Engine detector restore rejects non-finite numbers** (`NaN`, `Infinity`)
  that would silently freeze the detector.
- **PUT handler ack is idempotent**, defensive against a future maintainer
  accidentally calling the callback twice.
- **The config panel's drawer toggles use functional state setters**, so a
  rapid double-click cannot read stale state and load the wrong drawer.
- **The Save button latches until the host pushes a fresh configuration**, so
  a double-click cannot fire two saves before the restart completes.
- **The dirty-check is now key-order-insensitive**, so a structurally equal
  but differently-ordered configuration object does not falsely flag the
  panel as having unsaved edits.
- **QuestDB requests carry a 30s default timeout**, so a slow or stuck
  QuestDB cannot hang an analyzer indefinitely.
- **`bucketMeans` skips wind-direction buckets with no coherent direction**
  (samples that cancel around the unit circle) rather than reporting them as
  due north.
- **`snapshotBatteries` and the health analyzer filter** Signal K metadata
  leaves at the `electrical.batteries` container level so a future SK release
  cannot inject them as phantom bank ids.
- **`TypedEmitter` isolates listener throws** so a faulty engine-stop
  listener does not skip the state-persist listener for the same event.

### Changed

- **`whenReady` renamed to `_whenReady`** to signal that it is not part of the
  Signal K `Plugin` interface (a test-and-coordination seam, not contract).
- **Plugin status strings align with the family convention.** `Starting`
  becomes `Starting...`, `Awaiting API key configuration` becomes
  `No OpenRouter API key configured. Set one in plugin settings.`, and the
  comma-separated `Running, X` messages become `Running: X`.
- **Battery-alert notifications now carry `alertId` both at the value top
  level and under `value.data.alertId`.** The `data` slot is the SK master
  extension form; the top-level form is kept for one release for the existing
  `signalk-nmea2000-emitter-cannon` consumer and will be removed once the
  sibling reads from `data`.
- **The cron-dispatch arm in `TriggerRouter.dispatch` is dropped.** In
  production, cron jobs already fire by id via `runById` (per the 0.4.1 fix);
  the dispatch-by-pattern path existed only to keep three tests passing.
- **The five empty `*_SUPPORTED_EVENTS` constants** for analyzers without
  event subscriptions collapse into one shared `NO_EVENTS` sentinel.
- **Forecast severity-floor presets live in `src/severityFloors.ts`** as the
  single source of truth shared by the rjsf schema, the React panel, and
  `DEFAULT_OPTIONS`, mirroring the existing cron-preset pattern.
- **`triggers.put.path` is no longer stored in the config.** The PUT path is
  derived at registration time from the analyzer id (the convention is
  fixed at `plugins.openrouter-companion.<id>.run`); the schema no longer
  advertises an editable field that the runtime ignored.
- **Internal-only type exports** dropped across `src/core/` and `src/schema.ts`
  for symbols that were only ever referenced inside their declaring file.

<a id="v052"></a>

## [0.5.2] - 2026-05-21

A full-codebase hardening release with no feature changes. The headline fix
is in the engine detector: a start or stop settle anchor left stale across a
long gap in the RPM feed could satisfy its settle check on the first delta
after the gap and backdate a session by the whole gap, reporting a multi-hour
trip that never happened. The release also stops trend-analyzer QuestDB query
faults from being swallowed, where the scheduled report would silently never
appear, re-probes QuestDB so a database that starts after the plugin is picked
up without a restart, and clears a batch of analyzer, config-panel, and
dead-code findings.

### Fixed

- **Engine sessions are no longer backdated across an RPM dropout.** A stale
  start/stop settle anchor carried across a delta gap longer than the watchdog
  window is now discarded, so the first delta after a long silence cannot
  instantly satisfy a settle check and report a phantom multi-hour session.
- **A disconnected BMS no longer leaves a cell-imbalance alarm stuck on.** When
  every cell reading ages out, the monitor now clears an active imbalance and
  emits `cell-imbalance-exit` instead of waiting for a reconnect that may never
  come.
- **Trend-analyzer QuestDB faults surface instead of vanishing.** `aging` and
  `drift` now report a failure when a QuestDB query errors rather than silently
  producing nothing; `forecast` logs the fault and continues buffer-only.
  QuestDB is re-probed periodically, so a database that was unreachable at
  plugin start is picked up without a restart.
- **The Weather Outlook Advisor reads its trends correctly.** It no longer
  assumes the rolling buffer is timestamp-ordered (multi-source paths
  interleave), and wind-direction hourly means use a circular mean so a trend
  across the 0/2pi wrap is not averaged into a meaningless mid-value. A missing
  `SEVERITY:` line in the model reply is now logged.
- **Engine drift fuel figures are legible.** Mean fuel rate (m^3/s, order
  1e-6) was formatted to `0.00000`; it now uses exponential notation.
- **A malformed delta timestamp** is replaced with the current time instead of
  `NaN`, which had silently broken buffer eviction and detector arithmetic.
- **The config panel** shows an error instead of an editable empty box when a
  prompt fails to load (which had let an edit overwrite the saved prompt), no
  longer discards unsaved edits when the host re-renders with an equal config,
  and survives a malformed status payload.
- A plugin that throws partway through `start()` now releases its
  subscriptions and timers; corrupt or unwritable budget state, a failed
  failure-notification publish, and the `Retry-After` HTTP-date form are all
  handled rather than silently swallowed.

### Changed

- The `/fire` endpoint and config panel report the run outcome (report
  generated, nothing to report, budget exhausted, or failed) instead of a
  blanket "Dispatched".
- The plugin shutdown signal is threaded into the LLM call, so a stop cancels
  an in-flight request.
- Internal cleanup: a shared `BufferSummary` type and the core
  `BankSnapshot` replace re-declared shapes, the seven repeated analyzer schema
  skeletons collapse into one helper, schema config bounds are enforced at
  runtime, and several unused exports, fields, and styles were removed. No
  behavior change.

<a id="v051"></a>

## [0.5.1] - 2026-05-19

Makes the maintenance analyzer fire reliably and resolves a large batch of
latent defects. A switched-off NMEA 2000 engine stops broadcasting
RPM entirely rather than reporting zero, so the detector's stop path never ran
for a real shutdown and the per-trip maintenance report never fired; the
detector now ends a session on sustained silence and survives a Signal K
restart mid-trip. Fifteen further bugs were fixed across the plugin
lifecycle, core infra, the analyzers, and the config panel.

### Added

- **Engine sessions survive N2K shutoffs and Signal K restarts.** The engine
  detector's watchdog ends a running session when `propulsion.*.revolutions`
  has been silent past `engineSilenceStopSeconds` (default 300s), using the
  last delta seen as the session end. The in-progress session is persisted to
  `engine-detector.json` and restored on restart, so a restart mid-trip
  resumes the session instead of splitting or losing it; a session whose last
  delta predates a one-hour resume guard is discarded. `engineSilenceStopSeconds`
  is a configurable maintenance setting alongside the existing start/stop
  tuning knobs.

### Fixed

- **A stopped-plugin PUT no longer charges budget.** A PUT arriving after
  `stop()` could reach a router from a dead `start()`, run the LLM, and spend
  budget. PUT handlers now resolve the live router and no-op when the plugin
  is stopped.
- **No false cell-imbalance alarm from a disconnected BMS.** A disconnected
  BMS keeps its last cell reading forever; the monitor now evicts cell
  readings older than the source window before measuring imbalance, so a
  stale reading cannot raise a false alarm.
- **The low-SoC alarm fuses multi-source SoC with the minimum**, not the
  maximum, so one optimistic sensor can no longer suppress or prematurely
  clear a safety alarm.
- **Aging window bounds.** Each QuestDB window query is bounded by explicit
  ISO timestamps anchored to the trigger time instead of an unbounded
  server-side `now()`, so samples arriving mid-query cannot leak into the
  capacity reading.
- **Drift ASOF-join freshness.** The join freshness guard rejects inverted
  (negative-delta) pairs from N2K clock skew and counts only fresh fuel/SOG
  pairs per metric, so the sample-count gate no longer passes on phantom
  density.
- **Forecast pressure tendency** reports null when the latest pressure bucket
  is stale rather than presenting an old 3h tendency as current.
- **Config panel report drawer.** It surfaces a fetch error instead of a
  false "No reports yet", keeps previously loaded reports on a failed
  refresh, and reads live drawer state through a functional updater so a
  multi-second "Fire now" no longer refreshes against a stale closure.
  `severityFloor` is derived per analyzer.
- **Buffer eviction** compacts over every entry instead of stopping at the
  first fresh one, so stale entries stranded behind a multi-source timestamp
  inversion are evicted.
- **OpenRouter completions are capped** with `max_tokens`, and the models
  cache rejects a malformed payload instead of poisoning the 1-hour cache.
- **Cron preset list consolidated.** The rjsf schema and the React panel had
  diverged into two preset lists; both now consume `src/cronPresets.ts`, and
  every analyzer's default schedule appears in the dropdown instead of
  rendering as a non-selectable "Custom" entry.
- **Budget persistence is best-effort**: a state-file write failure no longer
  rejects inside the analyzer and surfaces as a spurious analyzer-failure
  report.
- Engine-detector state leaks and watchdog double-emission, and a dropped
  maintenance battery temperature field.

### Changed

- Internal cleanup: shared `HOUR_MS` / `DAY_MS` time
  constants and a `quotedPathList` SQL helper replace per-file duplicates, and
  the engine detector's two session-end blocks are unified into one
  `endSession` helper. No behavior change.

<a id="v050"></a>

## [0.5.0] - 2026-05-16

Adds the Weather Outlook Advisor, a seventh analyzer, broadening the Companion
from engine and battery telemetry to vessel weather telemetry. It also hardens
the OpenRouter request path against transient failures, fixes a QuestDB
context mismatch that had left the three history-backed analyzers silent,
shortens every notification so it fits a chartplotter alert, and reworks the
config panel into collapsible sections with a per-analyzer schedule control.

### Added

- **Weather Outlook Advisor (`forecast` analyzer).** Reads how environmental
  conditions are changing over the last several hours and publishes a
  plain-prose short-term weather outlook as a Signal K notification on
  `notifications.openrouter-companion.forecast.report`. Barometric tendency
  (hPa per 3h, pre-computed for the model), wind veer or back, and
  temperature/dewpoint convergence carry the prediction; a lowering cloud
  ceiling, collapsing visibility, and precipitation onset enrich it when those
  paths are present. Runs on a cron schedule, every 3 hours by default.
  Opt-in, disabled by default like every analyzer.
- **Two input path families.** The analyzer consumes both the canonical
  Signal K leaves (`environment.outside.*`, `environment.wind.*`) and the
  producer-namespaced `environment.weather.*` extension paths emitted by
  `signalk-virtual-weather-sensors`. It is source-agnostic: a real onboard
  barometer and anemometer feed it just as well as the weather plugin. It
  degrades gracefully: a canonical-only feed still produces a forecast, and
  the extension paths enrich the outlook when available.
- **Severity grading with a 3-level floor.** The model grades each outlook
  `severe`, `moderate`, `minor`, or `none`. A `severityFloor` config dropdown
  (Severe only, Moderate and up, Any deterioration; default Moderate and up)
  sets how bad the prediction must be before the notification raises an
  alarm. Grades map to Signal K notification states: `severe` to `alarm`,
  `moderate` to `warn`, `minor` to `alert`. Below the floor the outlook still
  publishes at `state: nominal`, so it is always readable in the Data Browser.
- **Per-analyzer schedule control.** Each analyzer in the config panel now has
  a Frequency dropdown (Hourly, Every 3/6/12 hours, Daily, Weekly, Monthly).
  Event-driven analyzers (`maintenance`, `alerts`) show their trigger as
  read-only text since they have no schedule.

### Changed

- **Notifications are now short enough for a chartplotter alert.** Every
  analyzer report leads with a one-line headline. The Signal K notification,
  which `signalk-nmea2000-emitter-cannon` bridges onto the NMEA 2000 bus as a
  chartplotter alert, now carries only that headline. The full multi-paragraph
  report is kept in the JSONL log and shown in the config panel's report
  drawer.
- **Hardened OpenRouter request handling.** The client retries transient
  failures (HTTP 429, 500, 502, 503, 504, transport errors, and truncated or
  malformed response bodies) up to three times with exponential backoff and
  jitter, honoring `Retry-After` and aborting the backoff immediately on
  shutdown. An empty completion is treated as a failure rather than published
  as a blank report.
- **Config panel reorganized.** The OpenRouter, QuestDB, and Analyzers
  sections are collapsible and collapsed by default, so the panel opens
  compact. Each analyzer is its own collapsible card: the enable checkbox and
  status pill stay visible, the controls expand on demand. Panel styles were
  tokenized into a shared design-token module, and an accessibility pass fixed
  focus order, contrast, and labelling across the panel.
- The Companion now ships seven analyzers. The README and the development
  guide describe it as covering general vessel telemetry, not engine and
  battery telemetry only.

### Fixed

- **QuestDB context mismatch silenced the trend analyzers.** The `aging`,
  `drift`, and `forecast` analyzers queried QuestDB filtering `context` on the
  vessel's full `vessels.urn:mrn:...` identifier, but `signalk-questdb` stores
  every row with `context` set to `self`. The filter matched no rows, so all
  three analyzers silently produced no report. They now query the correct
  context.
- **"Plugin restarting" notice never cleared.** After a save, the config panel
  showed "Plugin restarting..." regardless of the actual restart. It now
  detects when the plugin has come back up, via a new `startedAt` field on
  `/api/status`, and updates the notice to "restarted".

### Test count

183 -> 228 tests across 21 test files.

<a id="v042"></a>

## [0.4.2] - 2026-05-16

Bug-fix release: two low-severity items carried over from 0.4.1.

### Fixed

- **Budget cap race.** `TriggerRouter.runOne` recorded the OpenRouter call
  only after awaiting the LLM, so analyzers dispatched concurrently on a
  shared trigger could all pass the per-day cap check before any of them
  incremented the counter, overshooting the cap. The call is now recorded
  immediately after the check, with no `await` between them. A call that
  fails afterward still counts, the intended conservative behavior for a
  spend cap.
- **Config panel enabled-state.** Each analyzer's enabled checkbox keyed off
  the local edit buffer only. On a fresh install the saved configuration has
  no analyzers key while the server defaults every analyzer enabled, so all
  checkboxes showed as disabled. The checkbox now falls back to the live
  `/api/status` value when the edit buffer has no explicit setting.

### Test count

182 -> 183 tests across 20 test files.

<a id="v041"></a>

## [0.4.1] - 2026-05-16

Bug-fix release. A user-reported "Fire now" failure led to a full-codebase
sweep that surfaced several latent defects, all fixed here.
173 -> 182 tests across 20 test files.

### Fixed

- **"Fire now" ran no analyzer.** `POST /api/analyzers/:id/fire` dispatched
  through `TriggerRouter.dispatch('put', ..., { putPath: "manual:<id>" })`,
  but no analyzer's PUT trigger path equals `manual:<id>` (they are
  `plugins.openrouter-companion.<id>.run`). Trigger matching is exact-string,
  so zero analyzers ran: no LLM call, no report, no budget increment, yet the
  endpoint returned `{ok:true}`. New `TriggerRouter.runById(id, ctx)` runs the
  named analyzer directly, bypassing trigger matching, so the fire endpoint
  (and only it) targets one analyzer regardless of its trigger config. Broken
  since the Fire feature shipped in 0.3.0.
- **Cron jobs double-fired when analyzers shared a schedule.** `index.ts`
  registered one cron job per cron trigger. With `health` and `liveness` both
  defaulting to `0 8 * * *`, two jobs fired and each dispatched by pattern to
  both analyzers, so each ran twice every morning (doubled LLM spend and
  duplicate reports). Cron registration now dedupes to one job per unique
  `(pattern, timezone)` pair.
- **Per-analyzer cron `timezone` was ignored.** The single `CronScheduler`
  was built with only `maintenance`'s timezone. `CronScheduler.register` now
  takes an optional per-job timezone and `index.ts` passes each analyzer's
  own value.
- **A stopped plugin's runtime could be resurrected.** If `stop()` ran while
  the deferred router init (QuestDB probe + budget load) was still in flight,
  the late `.then` rebuilt `runtime`, so REST routes served live data for a
  stopped plugin and a restart could be clobbered. The deferred init now
  bails when the lifecycle `AbortController` has fired.
- **Maintenance analyzer dropped data on a cron/PUT fire.** Operator-set
  `extraWatchedPaths` were buffered but never reached the report, and a
  cron/PUT fire set `engineId='unknown'`, which made the path filter discard
  every `propulsion.*` path, so the fallback summary contained no engine
  telemetry. The analyzer now receives `extraWatchedPaths` and recovers the
  engine id from the buffer when the vessel has exactly one.
- Panel: a cleanly-unreachable QuestDB now shows "Unreachable" instead of the
  misleading "HTTP 200" (the `/questdb/test` endpoint returns 200 with
  `{ok:false}` for that case).

### Changed

- Removed the dead `sk-notification` `TriggerSpec` variant: nothing dispatched
  it, and `triggerMatches` had no case for it, so its `pathPattern` was
  silently ignored.
- `mergeWithDefaults` no longer lets a merged analyzer config alias a
  `DEFAULT_OPTIONS` array; the defaults base is cloned first.
- `enginePathPrefix` reuses the `PROPULSION_PREFIX` constant.

### Docs

- Trimmed `README.md` to a concise npm and GitHub landing page; the REST
  API reference moved to `DEVELOPMENT.md`. Removed the internal
  `docs/superpowers/` design specs and plans.

<a id="v040"></a>

## [0.4.0] - 2026-05-16

Adds a sixth analyzer, `liveness`, and hardens the OpenRouter client
against transport-level failures. 173 tests pass across 20 test files.

### Added (sensor-liveness analyzer)

- `LivenessAnalyzer` (`src/analyzers/liveness.ts`): a state analyzer that
  reports which watched Signal K paths have gone stale or are served by
  more than one source. It reads the `RollingBuffer` only (`pathKeys()`
  plus `slice()`): no new subscriptions, no QuestDB. A path is stale when
  its newest buffered sample is older than `stalenessThresholdSec`
  (default 300); a path is multi-source when two or more `$source` labels
  served it within the retained window. The system prompt tells the LLM
  that intermittently-powered gear going silent (engine `propulsion.*`
  paths) and intentional sensor redundancy (multi-source) are normal, so
  only genuine faults get flagged. Default trigger: cron `0 8 * * *` plus
  on-demand PUT to `plugins.openrouter-companion.liveness.run`. Publishes
  on `notifications.openrouter-companion.liveness.report` with
  `state: nominal`.
- The `liveness` id, title, factory, config shape, default options, rjsf
  schema block, and default system prompt are wired through `ids.ts`,
  `registry.ts`, `types.ts`, `schema.ts`, and `core/api.ts`.
  `LIVENESS_DEFAULT_STALENESS_SEC` and `LIVENESS_SUPPORTED_EVENTS` join
  the per-analyzer constants block in `types.ts`.
- `tests/_mocks.ts::makeBuffer()`: shared `RollingBuffer` factory for
  analyzer tests.

### Added (LLM-path resilience)

- `OpenRouterClient` now retries transport-level failures (connection
  reset, DNS failure, the internal request-timeout abort), not just HTTP
  status codes. A caller-supplied `AbortSignal` abort still propagates
  immediately without a retry.
- `504 Gateway Timeout` joins the transient-status set.
- Backoff applies equal jitter to the ladder base
  (`base * (0.5 + random * 0.5)`); `OpenRouterCfg.random` is an
  injectable source so tests stay deterministic. A larger `Retry-After`
  header still wins.
- An HTTP 200 carrying empty completion text now throws an
  `OpenRouterError`, so the `TriggerRouter` publishes a failure rather
  than an empty report.
- `OpenRouterClient.retryOrThrow` centralizes the back-off-and-recurse
  tail shared by the transient-HTTP and transport-failure paths.

### Changed

- `/api/openrouter/test` maps an `OpenRouterError` whose status is below
  400 (transport status 0, empty-completion status 200) to HTTP 500,
  since neither is a valid HTTP error status to echo to the client.

### Test count

156 -> 173 tests across 20 test files. dist 130.9 kB -> 136.5 kB.

<a id="v032"></a>

## [0.3.2] - 2026-05-13

Codebase-wide simplification across reuse,
quality, efficiency, SignalK semantics, and type design. No behavior
change; 156 tests pass (one new test for the registry's fallback
publish path).

### Added

- `src/analyzers/registry.ts::ANALYZER_FACTORIES`: per-id constructor
  map keyed by `AnalyzerId`. `src/index.ts` now iterates
  `ANALYZER_IDS` and instantiates enabled analyzers through this map
  instead of five hand-rolled `if (cfg.analyzers.<id>.enabled)`
  blocks. Adding a sixth analyzer is now one entry in `ids.ts` plus
  one entry in `registry.ts`.
- `src/core/emitter.ts::TypedEmitter<K, E>`: shared listener
  bookkeeping (on / emit) used by `BatteryMonitor` and
  `EngineDetector`. The two classes had identical 10-line copies.
- `src/core/skNode.ts::asTreeMap(tree)` + `readBankSnapshot(node)`:
  helpers that absorb the `typeof tree === 'object' ? ...` guard
  plus the six `readNumberAt(node, 'voltage' | 'current' | ...)`
  calls that `health`, `alerts`, and `maintenance` repeated.
- `src/core/triggers.ts::manualPutCtx(value?)`: factory for the
  manually-synthesized `TriggerCtx`. Used by `api.ts` (fire
  endpoint) and `index.ts` (PUT handler) so the shape can't drift.
- Panel: `fetchJson(path, opts)` envelope (`{ ok, status, body,
  error }`) replaces the five try/await/parse/catch blocks across
  fire, reports, prompt, openrouter test, and questdb test.
- Panel: `btn(...overrides)` helper replaces the inline
  `{ ...S.btn, ...variant }` spreads.
- `tests/triggerRouter.test.ts`: new case asserts that an analyzer
  without `publishOutput` is published via
  `deps.publisher.publishReport(a.id, ctx, text)`.

### Changed (type system)

- `Analyzer.id` narrowed from `string` to `AnalyzerId`. A typo in a
  class's `readonly id = '...'` no longer compiles.
- `AnalysisInput` aliased to `Record<string, unknown>` (was `object`).
  `HealthInput` and `AlertInput` now extend it explicitly.
- `isAnalyzerId(s)` checks `ANALYZER_IDS` via a Set and accepts
  `unknown` (was the title record + `string`).
- `JsonlEntry` is the single shape; `core/api.ts` consumes it
  instead of the locally-duplicated `ReportEntry`.
- `OpenRouterModelsResponse.data[].pricing` narrowed from `unknown`
  to `{ prompt?: string; completion?: string }`.
- `StatusResponse.analyzers[].id: AnalyzerId` (was `string`).
- Removed unused exports: `NOTIFICATION_PATH_PREFIX`,
  `PUT_PATH_PREFIX`, `ALARM_STATES`, the `NotificationState`
  re-export from publisher.

### Changed (hot path)

- `src/index.ts` extracts one `subscribe(path, sink)` helper inside
  `start()`. The per-delta closure no longer rebuilds the
  `SOC_PATH_RE`/`CELL_VOLT_PATH_RE` matches; both are computed at
  subscribe time and the bank/cell ids are captured.
- `subscribeWatchedPath` skips `buffer.record` for non-numeric
  values (they were getting accumulated and prematurely evicting
  the numeric entries the analyzers actually consume).
- `RollingBuffer.summarize` folds the time-window filter into the
  single accumulation pass; the intermediate filtered array is
  gone.
- `engineIds` / `bankIds` are now `Set<string>` in the discovery
  rescan loop. The 60s tick only calls `setPluginStatus(...)` when
  something actually changed (was unconditional on every tick).

### Changed (API hardening)

- `requireRuntime` and `requireAnalyzerId` guards dedupe the
  503 / 404 envelopes at the top of every route handler in
  `core/api.ts`.
- `getOpenRouterModels()` coalesces concurrent fetches via an
  in-flight promise. Two open admin tabs no longer trigger two
  upstream calls after the 1-hour cache expires.

### Changed (panel)

- `shallowJsonEqual` renamed to `jsonEqual` (it's deep via
  `JSON.stringify`, not shallow). The misleading O(1) dirty check
  (`cfg !== pristine && ...`) is dropped in favor of just
  `!jsonEqual(cfg, pristine)`.
- The `analyzerUi[id] ?? EMPTY_UI` falls back to `?? {}` inline;
  the `EMPTY_UI` constant was a micro-optimization that didn't
  actually save renders.

### Changed (internal)

- `TriggerRouter` no longer carries a per-analyzer `publish`
  closure. `runOne` picks `publishOutput` vs `publishReport`
  directly at dispatch time.
- `BudgetTracker.load` resolves `now` with a local default; the
  `as Required<BudgetOptions>` cast is gone.
- `publisher.ts::buildEntry` uses a spread instead of conditional
  mutation when the engine-session fields are present.
- `drift.isBinKey` uses `k in BIN_DEFS` (faster, clearer than the
  `BIN_ORDER.includes` cast).
- `src/index.ts` drops the `void restart;` placeholder and the
  three-line narration comment; the parameter is now `_restart`.

### Test count

155 -> 156 tests across 19 test files. dist 130.9 kB (unchanged).

### Docs

- `CLAUDE.md`, `DEVELOPMENT.md`, and `CONTRIBUTING.md` updated to
  reflect the registry flow, the new shared helpers, and the actual
  Node 20.18+ engines floor.
- `.gitignore` explicitly lists `.remember/` (an inner
  `.remember/.gitignore` already covers contents; the top-level
  entry makes the rule grep-discoverable).

<a id="v031"></a>

## [0.3.1] - 2026-05-12

### Fixed

- **Panel "React is not defined" on first install.** The panel mounted
  in the SK admin UI failed with a React error boundary stating
  "React is not defined" because esbuild-loader's `loader: 'jsx'`
  defaults to the legacy classic JSX runtime, which compiles JSX to
  `React.createElement(...)` and depends on a bare `React` identifier
  in scope. Module Federation's singleton-shared `react` module is
  fetched lazily, so the identifier was undefined when the JSX-compiled
  code ran. Switching `webpack.config.cjs` esbuild-loader options to
  `jsx: 'automatic'` (the React 19 default) emits `_jsx(...)` from
  `react/jsx-runtime` as a normal module import that webpack handles
  correctly through the federation share scope.

### Changed

- Trimmed Module Federation `shared` map to just `react` as
  `singleton: true`, matching the minimal config used by
  `signalk-virtual-weather-sensors`. The panel never imports
  `react-dom` directly (host owns the root render) and
  `react/jsx-runtime` is small and stateless, so a bundled copy
  is fine. Drops one devDependency (`react-dom`).

<a id="v030"></a>

## [0.3.0] - 2026-05-12

Adds a custom React configuration panel that the Signal K admin UI loads
in place of the rjsf-rendered schema, plus a REST control plane the
panel uses for live status, manual triggering, last-report viewing, and
per-analyzer system-prompt overrides. The rjsf schema stays in place as
the storage shape and as a fallback if the panel ever fails to load.

### Added (custom config panel)

- New `signalk-plugin-configurator` keyword in `package.json` triggers
  the SK admin to discover and dynamically import a React component
  exposed via Webpack Module Federation. The plugin ships
  `public/remoteEntry.js` (built from `src/configpanel/`); SK serves it
  at `/<package>/remoteEntry.js` and renders the exposed
  `./PluginConfigurationPanel` with `{ configuration, save }` props.
- Live status grid: API key configured + model, calls today / cap,
  QuestDB reachable, analyzer enabled count. Polled every 5 s with a
  deep-equality guard that skips re-renders when nothing changed.
- Per-analyzer rows (one per id from `src/analyzers/ids.ts`):
  - Enable toggle (writes through to `cfg.analyzers.<id>.enabled`).
  - Fire now button (POST to `/api/analyzers/:id/fire`).
  - View reports drawer (GET `/api/analyzers/:id/reports?limit=10`,
    newest first, full report text inline).
  - Edit prompt drawer with a textarea preloaded from
    GET `/api/analyzers/:id/prompt`. Reset to default clears the
    override.
- OpenRouter section: API key (password input), model field with
  native `<datalist>` autocomplete populated from
  GET `/api/openrouter/models` (lazy-loaded, 1-hour in-process cache),
  max calls per day.
- QuestDB section: enabled toggle, URL field when enabled, "Test
  connection" button (POST `/api/questdb/test`) that probes the URL
  in the edit buffer BEFORE saving.
- Sticky save bar at the bottom; disabled when nothing changed
  (O(1) `dirty` flag, not a per-keystroke `JSON.stringify`).
- All panel fetches send `credentials: 'same-origin'` to match the SK
  admin's own convention; works regardless of reverse-proxy setup.

### Added (REST API under `/plugins/signalk-openrouter-companion/api`)

The plugin now exposes a small read+action HTTP surface via the SK
`registerWithRouter` lifecycle hook:

| Verb | Path | Purpose |
| ---- | ---- | ------- |
| GET  | `/api/status` | Live snapshot for the panel polling loop |
| POST | `/api/openrouter/test` | One-token round-trip ping using saved API key |
| GET  | `/api/openrouter/models` | Proxy to OpenRouter `/api/v1/models` (1 h cache) |
| POST | `/api/questdb/test` | Probe an arbitrary or saved QuestDB URL |
| POST | `/api/analyzers/:id/fire` | Synthesize a put-kind ctx and dispatch via `TriggerRouter` |
| GET  | `/api/analyzers/:id/reports?limit=N` | Tail JSONL log filtered by analyzer (default 10, max 100) |
| GET  | `/api/analyzers/:id/prompt` | Returns `{ default, current }` for the panel's prompt editor |

All routes are mounted by SK under the standard plugin REST prefix and
inherit SK admin authentication; no separate auth wiring is needed.

### Added (per-analyzer prompt overrides)

- `customSystemPrompt?: string` added to every `*Cfg` and the
  `PluginOptions.analyzers.<id>` shape. When set (non-whitespace),
  it replaces the analyzer's built-in default system prompt
  verbatim.
- Each analyzer exports a `<NAME>_DEFAULT_SYSTEM_PROMPT` constant. The
  drift and aging defaults are now generic about window length: the
  configured window-day numbers travel through the user prompt's
  data block instead, so a custom override doesn't lose meaning.
- New `core/cfg.ts::resolveSystemPrompt(custom, fallback)` helper
  centralises the trim/fallback dance. Each analyzer constructor
  shrinks from a three-line `if (custom?.trim()) ... else ...`
  pattern to one call.
- The default ALERTS prompt now interpolates `MAX_ALERT_MESSAGE_CHARS`
  at module load instead of hardcoding `64`, so bumping the constant
  updates the prompt automatically.

### Added (analyzer registry)

- New `src/analyzers/ids.ts` is the single source of truth for analyzer
  ids and their human-readable titles. Exports `ANALYZER_IDS` (const
  tuple), `AnalyzerId` (string-literal union), `ANALYZER_TITLES`
  (record), and `isAnalyzerId(s)` (type guard).
- Each analyzer reads `readonly title = ANALYZER_TITLES.<id>` instead
  of repeating a hardcoded string. Fixes a real bug where
  `api.ts::ANALYZER_META` titles had drifted from the analyzer
  classes' own `.title` strings, causing the `/api/status` response
  to disagree with what each analyzer self-identified as.

### Changed

- `PluginRuntime.cfg` (the snapshot the REST routes read) now uses
  `Pick<PluginOptions, 'openrouter' | 'questdb' | 'analyzers'>`
  instead of a hand-written stripped duplicate. Adding a new
  analyzer config field no longer requires edits in three places.
- Build output now includes `public/` (Webpack Module Federation
  bundle, ~18 kB total) alongside `dist/` (esbuild backend bundle,
  131 kB). Both are produced by `npm run build`; `npm run build:panel`
  runs only the Webpack step.
- `npm run clean` now also removes `public/`.

### Internal

- Webpack 5 + esbuild-loader added as devDependencies (panel-only
  toolchain; backend still bundles with esbuild). React 19 declared
  as `singleton: true` Module Federation shared dep so the panel
  reuses the SK admin's React runtime.
- `experiments.outputModule: true` in `webpack.config.cjs`: the panel
  emits an ESM-format federation container with `export { ... as get,
  ... as init }`. Required because this package's
  `"type": "module"` makes SK admin inject `<script type="module">`,
  under which the legacy `library: 'var'` form leaves the container
  variable in module scope (never on `window`) and breaks the loader.
- Six near-identical `PluginRuntime` literals in `tests/api.test.ts`
  collapse into a single `makePluginRuntime(opts)` helper exported
  from `tests/_mocks.ts`.
- Six parallel per-id state maps in the panel (fireState,
  reportsByAnalyzer, reportsLoading, reportsOpen, promptOpen,
  promptState) consolidate into one `analyzerUi` map.

### Test count

127 -> 155 tests across 19 test files. dist 122.6 kB -> 130.9 kB.

<a id="v021"></a>

## [0.2.1] - 2026-05-12

This release aligns the plugin's notification output with the NMEA 2000
alert PGN family (126983 / 126985) as bridged by
[`signalk-nmea2000-emitter-cannon`](https://github.com/NearlCrews/signalk-nmea2000-emitter-cannon).
The changes were derived from a study of
`signalk-nmea2000-emitter-cannon`'s actual mapping conventions.

### Breaking changes
- **Alert notification paths moved**. Battery alerts now publish on
  canonical per-bank Signal K paths (`notifications.electrical.batteries.<bankId>.lowSoc`
  and `.cellImbalance`) instead of the producer-namespaced shared paths
  (`notifications.openrouter-companion.alert.low-soc-enter`, etc). One path
  per (bank, kind), with `state: alert` on enter and `state: normal` on exit
  (no more `-enter`/`-exit` subkind paths). This avoids
  `signalk-nmea2000-emitter-cannon`'s one-cache-slot-per-path collision when
  multiple banks alert simultaneously, and lets any third-party bridge
  already watching
  `notifications.electrical.batteries.*` consume the alerts.
- **`output.notificationPath` and `output.notificationState` config fields
  removed**. They were dead knobs: every analyzer overrides per-publish via
  `publishOutput`, so the cfg defaults never reached the wire. The
  corresponding admin-UI dropdown is gone too. Existing
  `signalk-openrouter-companion.json` config files that set these fields
  will silently ignore them at load (mergeWithDefaults ignores unknown
  keys).
- **`ReportPublisher.publish()` removed**. It depended on the now-removed
  `cfg.notificationPath` / `cfg.notificationState` defaults. The
  `TriggerRouter` no longer falls back to it: when an analyzer omits
  `publishOutput`, the router calls
  `deps.publisher.publishReport(analyzer.id, ctx, text)` instead, which
  publishes on the canonical `notifications.openrouter-companion.<id>.report`
  path with `state: 'nominal'`. `publishOutput` itself stays optional;
  override it only when the analyzer needs a different path or state
  (transition analyzers like `alerts` do; the four narrative analyzers
  inherit the default).

### Changed (notification PGN alignment)
- Reports now use `state: 'nominal'` (was `'normal'`). Per Signal K 1.8.2,
  `nominal` is the informational/no-action state; `normal` means
  "recovered after an alarm". `signalk-nmea2000-emitter-cannon`'s
  `alertTypes` table has no entry for `nominal`, so the chartplotter does
  NOT get a spurious PGN 126983 alert for narrative reports
  (maintenance / health / aging / drift).
- Notification `method` is now state-driven.
  `signalk-nmea2000-emitter-cannon` maps the SK `method` array to PGN
  126983 `alertState`: includes `'sound'` -> Active; nonempty without
  `'sound'` -> Silenced; empty -> Acknowledged. This plugin now emits
  `['visual', 'sound']` for `alert`/`alarm`/`emergency`/`warn` states
  (audible) and `['visual']` for `nominal`/`normal` (silent), yielding
  the correct chartplotter UX.
- Notification value carries an optional `alertId` (16-bit). Battery
  alerts now set it to a stable FNV-1a hash of the SK path so the
  chartplotter sees the same alert reappear across
  `signalk-nmea2000-emitter-cannon` restarts. Without this,
  `signalk-nmea2000-emitter-cannon`'s auto-counter resets on config
  reload and the chartplotter treats post-restart alerts as new.
- `MAX_ALERT_MESSAGE_CHARS` tightened from 80 to 64. The wire field
  (PGN 126985 alertTextDescription) holds ~200 chars but real-world MFD
  display caps are tighter (Raymarine Axiom ~60, B&G Zeus ~70, Furuno
  TZTouch ~80, Garmin ~72); 64 keeps the headline visible everywhere.
- Failure notifications (`publishFailure`) now publish on the analyzer's
  canonical report path (e.g., `notifications.openrouter-companion.maintenance.report`)
  with `state: 'warn'` and audible method, so a chartplotter user actually
  notices when the LLM call failed.

### Added (notification PGN helpers)
- `core/paths.ts::batteryAlertPath(bankId, kind)`: canonical per-bank
  battery alert path builder. Replaces `alertNotificationPath(subkind)`.
- `core/paths.ts::alertIdFor(path)`: deterministic 16-bit nonzero alert
  identifier derived from the SK path via FNV-1a.
- `core/publisher.ts::SignalKNotificationValue.alertId?: number`: optional
  alert identifier passed through to the SK delta and consumed by
  `signalk-nmea2000-emitter-cannon` for PGN 126983.

### Removed
- `core/paths.ts::alertNotificationPath` and `ALERT_NOTIFICATION_PREFIX`
  (replaced by `batteryAlertPath` + canonical paths).
- `ReportPublisher.publish()` (no consumer left after the router fallback
  was removed; `publishReport` and `publishOnPath` cover all cases).
- `output.notificationPath` and `output.notificationState` from
  `PluginOptions`, `DEFAULT_OPTIONS`, `PublisherCfg`, and the admin schema.
- `alerts.ts::ENTER_SUBKINDS`. State now drives the audible-method picker;
  no per-subkind enter set needed.

### Internal
- `core/publisher.ts::methodFor(state)` and `AUDIBLE_STATES` set picks the
  notification method based on state (one O(1) Set.has).
- `core/publisher.ts::makeDelta` signature simplified: dropped the unused
  `_meta` parameter, made `path` required, added optional `alertId`.

<a id="v020"></a>

## [0.2.0] - 2026-05-12

### Added (trend analyzers and configurable history)
- Battery aging tracker: `AgingAnalyzer` produces a monthly trend report per battery bank, computing capacity-loss-per-100-cycles over two rolling windows (default 30 and 90 days) from QuestDB and ranking banks by degradation rate. Default trigger: cron `0 8 1 * *` (1st of month, 8am) plus on-demand PUT to `plugins.openrouter-companion.aging.run`. Publishes on `notifications.openrouter-companion.aging.report`.
- Engine performance drift: `DriftAnalyzer` produces a weekly trend report comparing the past week's per-RPM-bin fuel rate and SOG against a configurable trailing baseline (default 30 days, from QuestDB), to surface gradual changes (fouled prop, dirty hull, fuel-quality drift, alternator load creep). Default trigger: cron `0 8 * * 0` (Sunday, 8am) plus on-demand PUT to `plugins.openrouter-companion.drift.run`. Publishes on `notifications.openrouter-companion.drift.report`.
- Configurable history lookback for trend analyzers. Aging exposes `shortWindowDays` (default 30) and `longWindowDays` (default 90); drift exposes `baselineDays` (default 30). Adjustable in the admin UI within sensible bounds (aging short: 7-365 days, aging long: 7-1095 days, drift: 14-365 days).
- `plugin.whenReady()`: returns a promise that resolves once the deferred `Promise.all([probe, budget]).then()` block in `start()` has wired the router. Replaces the brittle 'router ready' debug-log polling the integration tests were using; resets on every `start()` so a restart hands out a fresh promise.

### Changed (prompt and query architecture)
- `MaintenanceAnalyzer` no longer fetches 30-day baselines from QuestDB or includes them in its prompt. Per-session reports now describe just that session, with battery aging and engine drift moved to dedicated trend analyzers.
- `HealthAnalyzer` no longer fetches 30-day SoC baselines from QuestDB or includes them in its prompt. Daily reports now describe today's battery snapshot only.
- All analyzer prompts now require plain prose (no markdown headers, bullets, dividers) so the Signal K data browser's single-string notification renderer displays them legibly.
- Drift `binEngineWindow` pushes RPM-binning into QuestDB via an ASOF JOIN'd CTE; previously the plugin fetched raw timeseries and binned in JS. One query per (engine, window) now returns pre-aggregated `bin/n/mean_fuel/mean_sog` rows.
- Aging queries are batched per window across all banks: one SQL per window regardless of how many banks were discovered.

### Internal (shared infrastructure and efficiency)
- Shared infrastructure in `src/core/`:
  - `paths.ts`: notification and PUT path prefixes, `notificationReportPath(id)`, `pluginPutPath(id, verb)`, `bankPathPrefix(id)`, `enginePathPrefix(id)`, `engineNotificationsPath(id)`, `alertNotificationPath(subkind)`, `bankPaths(id)`, `enginePaths(id)`, `SOG_PATH`. `types.ts::DEFAULT_OPTIONS` derives the four PUT paths and the maintenance notification path from these helpers.
  - `triggers.ts::buildTriggers(cfg, eventMapper?)`: collapses the five copies of the cron + put + events block every analyzer was hand-rolling.
  - `format.ts`: adds `fmtUnit` and `fmtRatio` on top of the existing `fmtNumber`/`fmtPct`.
  - `questdb.ts`: adds `escapeSqlLiteral` and `indexColumns(r)` so the column-index lookup is one Map per QueryResult instead of `findIndex` per field. `aging.queryWindow` and `drift.binEngineWindow` both consume them.
  - `publisher.ts`: adds `publishReport(analyzerId, ctx, text)` shorthand. State and trend analyzers consume it.
  - `cfg.ts::clampPositiveInt(v, fallback, opts?)`: absorbs aging's `sanitizeDays` and drift's inline baseline-days clamp.
- Test infrastructure: `tests/_mocks.ts` adds `makeAnalyzerDeps` and `makeQuestDBStub`. All five analyzer tests consume the shared factories instead of redefining their own.
- Drift `collectContext` parallelizes per-engine queries: each engine's thisWeek + baseline pair runs concurrently via `Promise.all`, and the engines themselves run concurrently via another `Promise.all`. Multi-engine vessels no longer pay 2N round-trip latency.
- `RollingBuffer.evict` count-eviction is amortized: when the per-path array exceeds `maxEntriesPerPath`, trim down by 10% of cap so the next ~10% of `record()` calls skip count eviction entirely. `trimTo` is cached in the constructor so the saturated hot path stays free of arithmetic.
- `BatteryMonitor.observeSoc` and `EngineDetector.observe` fold their per-source cutoff sweep and max scan into a single pass over the Map.
- `src/index.ts` `subscribeWatchedPath` hoists the SOC/cell regex match to subscribe-time so the per-delta callback doesn't recompile and re-match regexes.
- `tests/drift.test.ts` injects a typed stub matching the QuestDBClient `query` surface instead of stubbing global `fetch`. The global-fetch approach was process-wide and clashed with parallel test workers, producing intermittent flakes.
- Dropped dead `discoverBatteryWatchedPaths`, `ServerApiLike.subscriptionmanager`, and the test-mock `pushSubscriptionDelta`/`registeredSubscriptions` scaffolding.
- A further simplification pass over the entire codebase:
  - `paths.ts` adds `BATTERIES_PARENT_PATH` and `PROPULSION_PREFIX`. health, alerts, and maintenance read the parent path through the constant; maintenance.snapshotBatteries uses `bankPaths(id).voltage` and `.soc`; listWatchedPaths uses `PROPULSION_PREFIX`.
  - `format.ts::asFiniteNumber(v)` consolidates aging's `numOrNull` and three inline `typeof === number && isFinite ? v : null|0` checks in `drift.binEngineWindow`.
  - `skNode.ts::readValueAt(node, subpath)` for non-numeric leaf reads. `maintenance.snapshotEngineNotifications` consumes it.
  - `types.ts::AGING_DEFAULT_SHORT_DAYS`, `AGING_DEFAULT_LONG_DAYS`, `DRIFT_DEFAULT_BASELINE_DAYS` are the source-of-truth for both `DEFAULT_OPTIONS` and analyzer constructor clamp fallbacks.
  - `AnalyzerDeps.requestRestart` and `QuestDBClient.baselineFor` deleted (both were dead in src; `baselineFor` only existed in tests). The four `baselineFor` test cases removed.
  - `MaintenanceAnalyzer` drops `private cfg`, stores only the `minSessionSeconds` value it actually reads. `MAINT_FALLBACK_WINDOW_MS` named (was bare `30 * 60 * 1000`).
  - `alerts.ts::ENTER_SUBKINDS` now a `ReadonlySet` with `.has()` membership.
  - `drift.ts::emptyBins()` extracts the per-bin defaults Object.fromEntries dance into one place.
  - `types.ts::clone` uses native `structuredClone` (Node 22+).
  - `index.ts` passes `app` directly to `AnalyzerDeps` (was a `{ getSelfPath, selfContext }` re-export literal).
  - `AnalyzerDeps.okStatus`: router uses it to recover from the budget-exhausted state with the same analyzer-count-aware banner that the startup path uses.
  - `BatteryMonitor` and `EngineDetector` hoist `Sec * 1000` conversions and SoC threshold ratios into constructor-time fields; per-delta hot path no longer recomputes them.
  - `TriggerRouter.setStatus` tracks `lastStatus` and skips no-op SK admin-UI calls.
  - `tests/_mocks.ts::MOCK_SELF_CONTEXT` exported as a named constant.
  - `tests/openrouter.test.ts::makeClient(overrides?)` helper compresses ~40 lines of duplicated 7-field cfg literals.
  - All non-null assertions (`!`) in tests replaced with explicit null guards or destructure-with-throw. Lint is at zero warnings.

### Initial 0.2.0 (consolidation + battery analyzers)

### Added
- Battery health monitoring: `HealthAnalyzer` produces a daily summary covering every discovered battery bank (SoC, voltage, current, cycles, cell balance, 30-day baselines if QuestDB is co-installed). Triggers: cron (default `0 8 * * *`) plus on-demand PUT to `plugins.openrouter-companion.health.run`. Publishes on `notifications.openrouter-companion.health.report`.
- Battery alerts: `AlertAnalyzer` emits short notifications when a bank crosses configurable thresholds (low SoC, cell imbalance). Triggers on `battery-event` subkinds from the new `BatteryMonitor` state machine. Publishes per subkind on `notifications.openrouter-companion.alert.<subkind>`.
- `BatteryMonitor`: per-bank state machine watching SoC and per-cell voltage; emits enter/exit events with configurable thresholds and hysteresis.
- New trigger kind: `battery-event` with subkinds `low-soc-enter`, `low-soc-exit`, `cell-imbalance-enter`, `cell-imbalance-exit`.
- New notification state: `'alert'` (joins existing `nominal | normal | warn`).
- `ReportPublisher.publishOnPath`: lets analyzers publish to a per-event path with override state (used by `AlertAnalyzer` and `HealthAnalyzer`).
- `discoverBankIds`, `discoverBatteryWatchedPaths`, `SOC_PATH_RE`, `CELL_VOLT_PATH_RE` exports from `src/core/discovery.ts`.
- `HEALTH_SUPPORTED_EVENTS`, `ALERTS_SUPPORTED_EVENTS` exports from `src/types.ts`.
- Plugin icon: rounded-square deep-ocean gradient with three stacked wave lines and a violet bottom-right routing-node badge (hub plus three model nodes), nodding to OpenRouter's many-models identity. Shipped in four sizes (72, 96, 192, 512) under `assets/icons/` and wired via `package.json` `signalk.appIcon`.
- `AlertAnalyzer` truncates outgoing alert messages to 200 chars (word-boundary cut, ellipsis suffix) so chartplotters that read NMEA 2000 PGN 126985 (Alert Text) via `signalk-nmea2000-emitter-cannon` get clean, in-budget text. Short messages pass through unchanged.

### Changed
- Admin form ergonomics: per-section titles + descriptions, checkbox UI for event subscriptions, cron pattern as a clean `enum + enumNames` preset dropdown. Custom (non-preset) cron patterns can be set by editing the plugin's saved JSON config file directly. Advanced fields (base URL, request timeout, notification path, log filename, per-analyzer PUT path and cron timezone) are no longer surfaced in the admin form: defaults are sensible and `mergeWithDefaults` fills any missing values at runtime. They remain editable in the plugin's saved JSON config file. (Earlier attempts to hide them via `ui:widget: 'hidden'` left empty inputs visible because the SK admin UI's custom `FieldTemplate` ignores rjsf's `hidden` prop and still renders the label and wrapper. The final fix dropped the hidden fields from the schema entirely and switched the cron preset selector from `anyOf` with a freeform branch to `enum + enumNames`, which rjsf 5 renders as a single clean select.)
- Analyzer and QuestDB detail fields collapse from the admin form when their `enabled` checkbox is unchecked. Note: rjsf clears dependent field values when toggling enabled off; re-enabling restores defaults, not your previously-entered values. Save before toggling if you have non-default tunables.
- Default `analyzers.alerts.triggers.put.path` is now `plugins.openrouter-companion.alerts.run` (was empty). The PUT toggle itself is still off by default.
- **Breaking**: each analyzer's config now uses a standardized `triggers` block with `cron` (pattern + timezone), `put` (path), and `events` (subkind list) sub-objects. `mergeWithDefaults` preserves backward compatibility for pre-0.2.0 configs.
- The plugin now subscribes to `electrical.batteries.*` paths in addition to `propulsion.*`. Path discovery handles both domains.
- Status message updated: "Running, no engine or battery data detected" when neither domain has data.
- Rolling buffer enlarged to 26 hours / 50k entries per path to give the daily health analyzer 24h of voltage history.
- Plugin lifecycle now creates an `AbortController` per `start()` cycle and aborts on `stop()`. The QuestDB probe at startup honors this signal so a slow probe doesn't outlive the plugin.
- `TriggerRouter` now updates plugin status to `"Running, budget exhausted for today"` when the per-day cap is hit, and resets to `"Running"` on the next successful call. Previously this only logged at debug.
- The engine watchdog (5s tick, 30s silence threshold) emits a debug log on `possible-stop` events (was previously silent).
- `start(settings, restart)` accepts the SK server's `restart` callback. (Earlier 0.2.0 development exposed it on `AnalyzerDeps.requestRestart`; that field was later removed because no analyzer ever called it.)
- `MaintenanceAnalyzer` constructor now takes `{ triggers: AnalyzerTriggerCfg, minSessionSeconds }` (was `{ minSessionSeconds, putTriggerPath }`).
- `croner: ^10.0.1` runtime dependency.
- `src/core/cronScheduler.ts` wrapping croner for cron-triggered analyzers.
- `MAINTENANCE_SUPPORTED_EVENTS` export from `src/types.ts` (currently `['engine-stop']`).

### Fixed
- Plugin now schedules a one-shot rescan even when the initial startup discovery finds no engine or battery data, so analyzers come up cleanly when the gateway publishes data after the plugin starts.

### Removed
- The sibling `signalk-openrouter-batteries-companion` repo is archived. Its analyzers (`health`, `alerts`) and supporting infra (`BatteryMonitor`, bank discovery) now live in this plugin.

### Internal
- Post-consolidation cleanup pass: prompt overhauls (SI-units contract, "cause not determinable" hint, unit-suffixed numeric lines, JSON-dump rewritten as labeled lines for alerts), tighter type narrowing across analyzers (generic `Analyzer<I>`, discriminated `BatteryEvent` union, type-guard for `BatteryEventKind`), shared `readNumberAt` helper extracted to `src/core/skNode.ts`, magic numbers hoisted to module-level named constants in `src/index.ts`, widened notification-state enum to the full Signal K `ALARM_STATE`, new tests (start/stop cycle, PUT-handler invocation, 500/502 retries, stall+restart debounce, source eviction, cron timezone, QuestDB validation), README rewritten to cover all three analyzers.
- Schema refactor: `triggerSchema` / `triggerUiSchema` take options bags instead of positional args, and two named helper types (`EnabledGatedNode`, `TriggerSchemaNode`) are exported from `PluginSchema` so test inline casts shrink and changes to the public type surface fail at the builder rather than at test time.
- CI: GitHub Actions workflows for `plugin-ci` (type-check + lint + build) and `test`.

<a id="v010"></a>

## [0.1.0] - 2026-05-10

### Added
- Initial release.
- Plugin core: rolling buffer, engine-session detector, trigger router, OpenRouter HTTP client, optional QuestDB enrichment, default publisher (SK notification + JSONL log), per-day budget cap.
- Maintenance analyzer: engine-stop trigger and PUT-on-demand trigger, plain-English session reports with engine alarm snapshot and battery state.
