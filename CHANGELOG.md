# Changelog

All notable changes will be documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed
- Plugin lifecycle now creates an `AbortController` per `start()` cycle and aborts on `stop()`. The QuestDB probe at startup honors this signal so a slow probe doesn't outlive the plugin.
- `TriggerRouter` now updates plugin status to `"Running, budget exhausted for today"` when the per-day cap is hit, and resets to `"Running"` on the next successful call. Previously this only logged at debug.
- The 5s engine watchdog emits a debug log on `possible-stop` events (was previously silent).
- `start(settings, restart)` now captures the `restart` callback and exposes it via `AnalyzerDeps.requestRestart` for future analyzers.

### Roadmap
- Battery and other electrical analytics will live in a separate Signal K plugin. This plugin remains engine-focused (battery state-of-charge is still snapshotted at engine session end as contextual data in maintenance reports).

## [0.1.0] - 2026-05-10

### Added
- Initial release.
- Plugin core: rolling buffer, engine-session detector, trigger router, OpenRouter HTTP client, optional QuestDB enrichment, default publisher (SK notification + JSONL log), per-day budget cap.
- Maintenance analyzer: engine-stop trigger and PUT-on-demand trigger, plain-English session reports with engine alarm snapshot and battery state.
