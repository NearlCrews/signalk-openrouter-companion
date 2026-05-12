# Signal K OpenRouter Companion

[![npm](https://img.shields.io/npm/v/signalk-openrouter-companion)](https://www.npmjs.com/package/signalk-openrouter-companion)
[![License](https://img.shields.io/github/license/NearlCrews/signalk-openrouter-companion.svg)](LICENSE)

> **Beta.** Trend analyzers (`aging`, `drift`) need 30+ days of QuestDB history before their reports are useful; smoke tests pass but the prose hasn't been verified across a full season of telemetry yet.

A Signal K plugin that runs LLM analyzers (via OpenRouter) over your vessel's propulsion and electrical telemetry. Five analyzers ship: state ("now"), transition ("threshold crossed"), and trend ("over time"). Each emits a short plain-prose report or alert as a Signal K notification and appends every run to a JSONL log.

> **Requires a paid OpenRouter API key.** LLM calls are billed per token. A per-day call cap (default 20) is enforced; raise or lower it in the admin panel. Trend analyzers (`aging`, `drift`) also need a co-installed [`signalk-questdb`](https://www.npmjs.com/package/signalk-questdb) for time-series history.

## Install

In the Signal K admin UI: **App Store** → **Available** → search for **OpenRouter Companion** → Install. Then enable it under **Server → Plugin Config** and set your OpenRouter API key in the panel that opens.

## Analyzers

| Analyzer      | Kind       | Fires on                                       | Notification path                                                                          |
| ------------- | ---------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `maintenance` | state      | engine-stop (or cron/PUT)                      | `notifications.openrouter-companion.maintenance.report`                                    |
| `health`      | state      | cron (default 8am daily) or PUT                | `notifications.openrouter-companion.health.report`                                         |
| `alerts`      | transition | battery events (low SoC, cell imbalance)       | `notifications.electrical.batteries.<bankId>.{lowSoc,cellImbalance}` (canonical, per-bank) |
| `aging`       | trend      | cron (default 8am on the 1st) or PUT           | `notifications.openrouter-companion.aging.report`                                          |
| `drift`       | trend      | cron (default 8am Sunday) or PUT               | `notifications.openrouter-companion.drift.report`                                          |

Each analyzer is independently enabled and shares the standardized `triggers` config (cron + PUT + events). Reports use SK 1.8.2 `state: nominal` so they don't trip a chartplotter alarm; alerts use `state: alert` with `method: ['visual','sound']` and a stable 16-bit `alertId`, which a co-installed [`signalk-nmea2000-emitter-cannon`](https://github.com/NearlCrews/signalk-nmea2000-emitter-cannon) maps cleanly to PGN 126983/126985.

Every run also appends to `<plugin-config-data>/signalk-openrouter-companion/reports.jsonl`.

## The config panel

OpenRouter Companion ships a custom React panel (Module Federation, React 19) that the SK admin loads in place of the default rjsf form:

- **Live status grid**: API key configured, calls today / cap, QuestDB reachable, analyzer enabled count.
- **Per-analyzer rows**: enable toggle, **Fire now** (manual trigger), **View reports** (last 10 from the JSONL log inline), **Edit prompt** (textarea preloaded from the analyzer's default; Reset clears any override).
- **OpenRouter section**: API key (password), model field with autocomplete from `/api/v1/models`, max calls per day, "Test API key" button.
- **QuestDB section**: enabled toggle, URL, "Test connection" before saving.

Advanced fields not surfaced in the panel (engine RPM thresholds, cell-imbalance settle times, trend window days, custom 5-field cron patterns) live in the saved JSON config at `~/.signalk/plugin-config-data/signalk-openrouter-companion.json` and can be edited there directly. The rjsf schema is also kept as a fallback so the legacy form renders if the panel ever fails to load.

## REST API

Mounted under `/plugins/signalk-openrouter-companion/api/*` via SK's `registerWithRouter`. All routes inherit SK admin authentication.

| Verb | Path                              | Purpose                                                       |
| ---- | --------------------------------- | ------------------------------------------------------------- |
| GET  | `/api/status`                     | Live status snapshot for the panel                            |
| POST | `/api/openrouter/test`            | One-token ping with saved key                                 |
| GET  | `/api/openrouter/models`          | Proxy to OpenRouter models list, cached 1 h                   |
| POST | `/api/questdb/test`               | Probe a QuestDB URL                                           |
| POST | `/api/analyzers/:id/fire`         | Manually trigger an enabled analyzer                          |
| GET  | `/api/analyzers/:id/reports?limit=N` | Tail JSONL filtered by analyzer (default 10, max 100)      |
| GET  | `/api/analyzers/:id/prompt`       | `{ default, current }` for the prompt editor                  |

Manual fire is also available via the standardised SK PUT trigger paths (`plugins.openrouter-companion.<analyzer>.run`); the REST `fire` endpoint is a panel-UX convenience.

## Development and contributing

See [DEVELOPMENT.md](DEVELOPMENT.md) for architecture, build, tests, and the steps to add a new analyzer. See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution flow. Run `npm run prepublishOnly` before any push.

## License

Apache-2.0: see [LICENSE](LICENSE).

## Support

- [Report a bug](https://github.com/NearlCrews/signalk-openrouter-companion/issues/new)
- [Request a feature](https://github.com/NearlCrews/signalk-openrouter-companion/issues/new)
