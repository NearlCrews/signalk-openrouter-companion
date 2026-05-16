# Signal K OpenRouter Companion

[![npm version](https://img.shields.io/npm/v/signalk-openrouter-companion.svg)](https://www.npmjs.com/package/signalk-openrouter-companion)
[![npm downloads](https://img.shields.io/npm/dm/signalk-openrouter-companion.svg)](https://www.npmjs.com/package/signalk-openrouter-companion)
[![License](https://img.shields.io/github/license/NearlCrews/signalk-openrouter-companion.svg)](LICENSE)
[![CI](https://github.com/NearlCrews/signalk-openrouter-companion/actions/workflows/ci.yml/badge.svg)](https://github.com/NearlCrews/signalk-openrouter-companion/actions/workflows/ci.yml)

Runs LLM analyzers over your vessel's propulsion and electrical telemetry and
writes the results back as plain-prose Signal K notifications: how the last
engine session went, how the battery banks are doing, whether capacity is
fading over the season. A paid [OpenRouter](https://openrouter.ai) API key is
required; calls are billed per token and capped per day.

_Beta: the `aging` and `drift` trend analyzers need a few weeks of QuestDB
history before their reports are meaningful._

## What's new in 0.4.2

- **Budget cap race fixed.** Analyzers dispatched concurrently on a shared
  schedule could overshoot the per-day OpenRouter call cap; a call is now
  counted before the request, not after.
- **Config panel checkbox fixed.** On a fresh install the analyzer enable
  checkboxes showed as disabled while the analyzers were actually running;
  they now reflect the live server state.

See the [changelog](CHANGELOG.md) for earlier releases.

## Features

- Six independent analyzers: engine-session maintenance, battery health,
  threshold alerts, capacity aging, performance drift, and sensor liveness
- Plain-prose reports written back as Signal K notifications, readable in the
  Data Browser
- Each analyzer runs on a schedule, on a Signal K PUT, or on a vessel event
- Every run appended to a JSONL log on the server
- A per-day OpenRouter call cap to bound spend
- A custom React config panel in the Admin UI, with a JSON-schema form fallback
- Optional QuestDB history for the trend analyzers

## Requirements

- A Signal K server with the App Store (any recent Signal K Node server)
- A paid OpenRouter API key, set in the plugin's admin panel. Calls are billed
  per token.
- Optional: a co-installed
  [`signalk-questdb`](https://www.npmjs.com/package/signalk-questdb). The
  `aging` and `drift` analyzers read history from it; the other four work
  without it.

## Installation

Install from the Signal K Admin UI under **App Store -> Available**, or from
npm:

```bash
npm install signalk-openrouter-companion
```

From source:

```bash
git clone https://github.com/NearlCrews/signalk-openrouter-companion.git
cd signalk-openrouter-companion
npm install
npm run build
ln -s "$(pwd)" ~/.signalk/node_modules/signalk-openrouter-companion
```

Then enable it under **Server -> Plugin Config** and set your OpenRouter API
key in the panel that opens.

## Configuration

The plugin ships a custom admin panel that replaces the default Signal K plugin
form. The main settings:

| Setting | Description | Default |
|---------|-------------|---------|
| OpenRouter API Key | Required. Paid key from openrouter.ai. | n/a |
| Model | OpenRouter model slug. | anthropic/claude-haiku-4.5 |
| Max calls per day | Hard cap on OpenRouter calls per UTC day, to bound spend. | 20 |
| QuestDB | Optional history source for the trend analyzers. | enabled, localhost:9000 |
| Analyzers | Each of the six can be enabled or disabled independently. | all enabled |

Advanced settings (engine RPM thresholds, cell-imbalance settle times, trend
window lengths, custom cron patterns) are not in the panel; they live in the
saved JSON config at
`~/.signalk/plugin-config-data/signalk-openrouter-companion.json`.

## Analyzers

Six analyzers ship, all enabled by default.

- **maintenance**: a short narrative of each completed engine session. Fires
  when the engine stops.
- **health**: a daily snapshot of every battery bank.
- **alerts**: real-time battery threshold crossings (low state of charge, cell
  imbalance), as alarm-grade notifications.
- **aging**: a monthly look at battery capacity loss per bank. Reads QuestDB
  history.
- **drift**: a weekly look at engine fuel economy and per-RPM drift. Reads
  QuestDB history.
- **liveness**: a daily check that the data the other analyzers depend on is
  still flowing.

Reports publish as informational notifications (`state: nominal`). The
`alerts` analyzer publishes true alerts with a stable alert id, which a
co-installed
[`signalk-nmea2000-emitter-cannon`](https://github.com/NearlCrews/signalk-nmea2000-emitter-cannon)
can forward to a NMEA 2000 chartplotter.

## Documentation

- [Development guide](DEVELOPMENT.md): architecture, the analyzer extension
  point, the REST API, build, and tests
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## License

Apache-2.0: see [LICENSE](LICENSE).

## Support

- [Report a bug](https://github.com/NearlCrews/signalk-openrouter-companion/issues/new?template=bug_report.yml)
- [Request a feature](https://github.com/NearlCrews/signalk-openrouter-companion/issues/new?template=feature_request.yml)
- [Security issues](SECURITY.md)
