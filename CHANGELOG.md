# Changelog

All notable changes will be documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Battery aging tracker: `AgingAnalyzer` produces a monthly trend report per battery bank, computing capacity-loss-per-100-cycles over two rolling windows (default 30 and 90 days) from QuestDB and ranking banks by degradation rate. Default trigger: cron `0 8 1 * *` (1st of month, 8am) plus on-demand PUT to `plugins.openrouter-companion.aging.run`. Publishes on `notifications.openrouter-companion.aging.report`.
- Engine performance drift: `DriftAnalyzer` produces a weekly trend report comparing the past week's per-RPM-bin fuel rate and SOG against a configurable trailing baseline (default 30 days, from QuestDB), to surface gradual changes (fouled prop, dirty hull, fuel-quality drift, alternator load creep). Default trigger: cron `0 8 * * 0` (Sunday, 8am) plus on-demand PUT to `plugins.openrouter-companion.drift.run`. Publishes on `notifications.openrouter-companion.drift.report`.
- Configurable history lookback for trend analyzers. Aging exposes `shortWindowDays` (default 30) and `longWindowDays` (default 90); drift exposes `baselineDays` (default 30). Adjustable in the admin UI within sensible bounds (aging short: 7-365 days, aging long: 7-1095 days, drift: 14-365 days).

### Changed
- `MaintenanceAnalyzer` no longer fetches 30-day baselines from QuestDB or includes them in its prompt. Per-session reports now describe just that session, with battery aging and engine drift moved to dedicated trend analyzers.
- `HealthAnalyzer` no longer fetches 30-day SoC baselines from QuestDB or includes them in its prompt. Daily reports now describe today's battery snapshot only.

### Internal
- `tests/drift.test.ts` injects a typed stub matching the QuestDBClient `query` surface instead of stubbing global `fetch`. The global-fetch approach was process-wide and clashed with parallel test workers, producing intermittent flakes.
- Simplify pass over the codebase: shared `core/triggers.ts` (`buildTriggers`), `core/paths.ts` (notification and PUT path helpers), extended `core/format.ts` (`fmtUnit`, `fmtRatio`), `core/questdb.ts` (`escapeSqlLiteral`), and `core/publisher.ts` (`publishReport` shorthand). Tests share `makeAnalyzerDeps` via `_mocks.ts`. `RollingBuffer.evict` count-eviction is now amortized.

## [0.2.0] - 2026-05-11

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
- `start(settings, restart)` now captures the `restart` callback and exposes it via `AnalyzerDeps.requestRestart` for future analyzers.
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
