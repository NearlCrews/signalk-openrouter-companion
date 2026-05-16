# Signal K OpenRouter Companion

[![npm](https://img.shields.io/npm/v/signalk-openrouter-companion)](https://www.npmjs.com/package/signalk-openrouter-companion)
[![License](https://img.shields.io/github/license/NearlCrews/signalk-openrouter-companion.svg)](LICENSE)

> **Beta, and requires a paid [OpenRouter](https://openrouter.ai) API key.** LLM calls are billed per token. The plugin enforces a per-day call cap (default 20) that you can raise or lower in the admin panel. Trend analyzers also need a few weeks of history before their reports are useful.

A Signal K plugin that runs LLM analyzers over your vessel's propulsion and electrical telemetry and writes the results back as plain-prose Signal K notifications. Instead of another gauge, you get a short readable summary: how the last engine session went, how your battery banks are doing today, whether capacity is fading over the season.

Each analyzer runs on a schedule, on a Signal K PUT, or on a vessel event. Every run is also appended to a JSONL log on the server for later review.

## Requirements

- A Signal K server with the App Store (any recent Signal K Node server).
- A paid OpenRouter API key. You set this in the plugin's admin panel.
- Optional: a co-installed [`signalk-questdb`](https://www.npmjs.com/package/signalk-questdb). The two trend analyzers (`aging`, `drift`) read time-series history from it. The other four analyzers work without it.

## Install

In the Signal K admin UI: **App Store** then **Available**, search for **OpenRouter Companion**, and install. Then enable it under **Server**, **Plugin Config**, and set your OpenRouter API key in the panel that opens.

## What it does

Six analyzers ship, all enabled by default. Disable any you do not want in the admin panel.

- **maintenance**: writes a short narrative of each completed engine session. Fires when the engine stops.
- **health**: a daily snapshot of every battery bank. Fires on a schedule.
- **alerts**: real-time battery threshold crossings (low state of charge, cell imbalance). Fires on the event, with an alarm-grade Signal K notification.
- **aging**: a monthly look at battery capacity loss per bank over a trailing window. Fires on a schedule. Reads QuestDB history.
- **drift**: a weekly look at engine fuel economy and per-RPM drift against a trailing baseline. Fires on a schedule. Reads QuestDB history.
- **liveness**: a daily check that the data the other analyzers depend on is still flowing. Fires on a schedule.

Analyzer reports are published as informational Signal K notifications (`state: nominal`). The `alerts` analyzer is the exception: it publishes a true alert with a stable alert id, which a co-installed [`signalk-nmea2000-emitter-cannon`](https://github.com/NearlCrews/signalk-nmea2000-emitter-cannon) can forward to a NMEA 2000 chartplotter.

## Configuration

The plugin ships a custom admin panel that replaces the default Signal K plugin form. Use it to set your OpenRouter API key and model, set the per-day call cap, enable or disable analyzers, trigger a run manually, and read recent reports. Advanced settings (engine RPM thresholds, cell-imbalance settle times, trend window lengths, custom cron patterns) are not in the panel; they live in the saved JSON config at `~/.signalk/plugin-config-data/signalk-openrouter-companion.json` and can be edited there directly.

## Documentation

- [DEVELOPMENT.md](DEVELOPMENT.md): architecture, the analyzer extension point, the REST API, build, and tests.
- [CONTRIBUTING.md](CONTRIBUTING.md): contribution flow and coding standards.

## License

Apache-2.0: see [LICENSE](LICENSE).

## Support

- [Report a bug](https://github.com/NearlCrews/signalk-openrouter-companion/issues/new)
- [Request a feature](https://github.com/NearlCrews/signalk-openrouter-companion/issues/new)
