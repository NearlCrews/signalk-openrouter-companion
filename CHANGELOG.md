# Changelog

All notable changes will be documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Battery health monitoring: `HealthAnalyzer` produces a daily summary covering every discovered battery bank (SoC, voltage, current, cycles, cell balance, 30-day baselines if QuestDB is co-installed). Triggers: cron (default `0 8 * * *`) plus on-demand PUT to `plugins.openrouter-companion.health.run`. Publishes on `notifications.openrouter-companion.health.report`.
- Battery alerts: `AlertAnalyzer` emits short notifications when a bank crosses configurable thresholds (low SoC, cell imbalance). Triggers on `battery-event` subkinds from the new `BatteryMonitor` state machine. Publishes per subkind on `notifications.openrouter-companion.alert.<subkind>`.
- `BatteryMonitor`: per-bank state machine watching SoC and per-cell voltage; emits enter/exit events with configurable thresholds and hysteresis.
- New trigger kind: `battery-event` with subkinds `low-soc-enter`, `low-soc-exit`, `cell-imbalance-enter`, `cell-imbalance-exit`.
- New notification state: `'alert'` (joins existing `nominal | normal | warn`).
- `ReportPublisher.publishOnPath`: lets analyzers publish to a per-event path with override state (used by `AlertAnalyzer` and `HealthAnalyzer`).
- `discoverBankIds`, `discoverBatteryWatchedPaths`, `SOC_PATH_RE`, `CELL_VOLT_PATH_RE` exports from `src/core/discovery.ts`.
- `HEALTH_SUPPORTED_EVENTS`, `ALERTS_SUPPORTED_EVENTS` exports from `src/types.ts`.

### Changed
- Admin form ergonomics: per-section titles + descriptions, checkbox UI for event subscriptions, cron pattern dropdown with named presets + "Other" custom option, advanced fields (base URL, request timeout, notification path, log filename, per-analyzer PUT path and cron timezone) hidden by default.
- Analyzer and QuestDB detail fields collapse from the admin form when their `enabled` checkbox is unchecked. Note: rjsf clears dependent field values when toggling enabled off; re-enabling restores defaults, not your previously-entered values. Save before toggling if you have non-default tunables.
- Default `analyzers.alerts.triggers.put.path` is now `plugins.openrouter-companion.alerts.run` (was empty). The PUT toggle itself is still off by default.
- **Breaking**: each analyzer's config now uses a standardized `triggers` block with `cron` (pattern + timezone), `put` (path), and `events` (subkind list) sub-objects. `mergeWithDefaults` preserves backward compatibility for pre-v0.3 configs.
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

### Removed
- The sibling `signalk-openrouter-batteries-companion` repo is archived. Its analyzers (`health`, `alerts`) and supporting infra (`BatteryMonitor`, bank discovery) now live in this plugin.

### Internal
- Post-consolidation cleanup pass: prompt overhauls (SI-units contract, "cause not determinable" hint, unit-suffixed numeric lines, JSON-dump rewritten as labeled lines for alerts), tighter type narrowing across analyzers (generic `Analyzer<I>`, discriminated `BatteryEvent` union, type-guard for `BatteryEventKind`), shared `readNumberAt` helper extracted to `src/core/skNode.ts`, magic numbers hoisted to module-level named constants in `src/index.ts`, widened notification-state enum to the full Signal K `ALARM_STATE`, new tests (start/stop cycle, PUT-handler invocation, 500/502 retries, stall+restart debounce, source eviction, cron timezone, QuestDB validation), README rewritten to cover all three analyzers.

## [0.1.0] - 2026-05-10

### Added
- Initial release.
- Plugin core: rolling buffer, engine-session detector, trigger router, OpenRouter HTTP client, optional QuestDB enrichment, default publisher (SK notification + JSONL log), per-day budget cap.
- Maintenance analyzer: engine-stop trigger and PUT-on-demand trigger, plain-English session reports with engine alarm snapshot and battery state.
