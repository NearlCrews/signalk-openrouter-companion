# Changelog

All notable changes will be documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.1] - 2026-05-12

This release aligns the plugin's notification output with the NMEA 2000
alert PGN family (126983 / 126985) as bridged by
[`signalk-nmea2000-emitter-cannon`](https://github.com/NearlCrews/signalk-nmea2000-emitter-cannon).
The changes were derived from a signalk-plugin-expert audit of
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
- Third simplify pass over the entire codebase:
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

## [0.1.0] - 2026-05-10

### Added
- Initial release.
- Plugin core: rolling buffer, engine-session detector, trigger router, OpenRouter HTTP client, optional QuestDB enrichment, default publisher (SK notification + JSONL log), per-day budget cap.
- Maintenance analyzer: engine-stop trigger and PUT-on-demand trigger, plain-English session reports with engine alarm snapshot and battery state.
