# OpenRouter Companion

[![npm version](https://img.shields.io/npm/v/signalk-openrouter-companion.svg)](https://www.npmjs.com/package/signalk-openrouter-companion)
[![npm downloads](https://img.shields.io/npm/dm/signalk-openrouter-companion.svg)](https://www.npmjs.com/package/signalk-openrouter-companion)
[![CI](https://github.com/NearlCrews/signalk-openrouter-companion/actions/workflows/ci.yml/badge.svg)](https://github.com/NearlCrews/signalk-openrouter-companion/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/NearlCrews/signalk-openrouter-companion/blob/main/LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen.svg)](https://nodejs.org)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/nearlcrews)

A [Signal K](https://signalk.org) plugin that runs LLM analyzers over your
vessel's propulsion, electrical, and weather telemetry and writes the
results back as plain-prose Signal K notifications. Requires an
[OpenRouter](https://openrouter.ai) API key.

> The battery threshold alerts are written by a cloud LLM call bounded by a
> shared daily budget, so a crossing can go unreported when the budget is
> spent or OpenRouter is unreachable. Do not rely on this plugin as your
> sole battery safety alarm: pair it with a hardware or BMS alarm.

## What's new in 0.7.4

0.7.4 adds selectable history providers, strengthens configuration safety, and
refreshes the shared panel and release checks.

- **QuestDB or InfluxDB history** lets aging, drift, and forecast analyzers use
  QuestDB, InfluxDB 1.x, or InfluxDB 2.x through its InfluxQL API.
- **Credential-safe connection tests** reject embedded credentials and
  redirects, keep authentication in headers, and return sanitized errors.
- **Compatible configuration migration** moves legacy QuestDB settings into
  the history block while preserving fields introduced by newer versions.
- **Shared UI 0.7.1** supplies the secret input, viewport-aware action bar,
  theme behavior, and strict host React and React DOM singleton contract.
- **Stronger release validation** checks documentation, package provenance
  metadata, App Store inputs, dependency boundaries, and current toolchains.

See the [v0.7.4 changelog entry](https://github.com/NearlCrews/signalk-openrouter-companion/blob/main/CHANGELOG.md#v074) and the
[full release history](https://github.com/NearlCrews/signalk-openrouter-companion/releases).

## What it does

Signal K is an open marine data standard that streams a boat's navigation,
environment, and electrical data over a single API. OpenRouter Companion
watches that data and, on a schedule, a Signal K PUT, or a vessel event
(an engine stop, a battery threshold crossing), sends the relevant
telemetry to an OpenRouter-hosted model and publishes the model's
plain-prose report as a Signal K notification: how the last engine session
went, how the battery banks are doing, whether capacity is fading over the
season, and where the local weather is heading.

Spend is bounded by a per-day call cap, every run is appended to a JSONL
log on the server, and the whole plugin is configured from a custom panel
in the Signal K admin UI.

## Features

- **Seven independent analyzers**: engine-session maintenance, battery
  health, battery threshold alerts, capacity aging, engine performance
  drift, sensor liveness, and a short-term weather outlook.
- **Plain-prose reports** published as Signal K notifications, readable in
  the Data Browser, each led by a headline short enough for a chartplotter
  alert.
- **Three trigger kinds per analyzer**: a cron schedule, a Signal K PUT,
  or a vessel event.
- **A per-day OpenRouter call cap** (default 20 calls per UTC day) to
  bound spend.
- **A JSONL report log**: every run is appended to `reports.jsonl` in the
  plugin's data directory, with the full report text.
- **A custom React configuration panel** in the admin UI, built from the
  accessible, theme-aware
  [`signalk-nearlcrews-ui`](https://github.com/NearlCrews/signalk-nearlcrews-ui)
  primitives. Signal K Admin reports the panel as unavailable if its remote
  cannot load; it does not fall back to the JSON Schema form.
- **Selectable history source** for the trend analyzers: QuestDB, InfluxDB
  1.x, or InfluxDB 2.x through its InfluxQL compatibility API.
- **NMEA 2000 bridging**: battery alerts carry stable alert ids that a
  co-installed
  [`signalk-nmea2000-emitter-cannon`](https://github.com/NearlCrews/signalk-nmea2000-emitter-cannon)
  can forward to a chartplotter.

## Screenshots

| View | Preview |
| --- | --- |
| Light theme | [![The configuration panel's live status grid and OpenRouter settings in the Light theme](assets/screenshots/panel-overview.png)](assets/screenshots/panel-overview.png) |
| Dark theme | [![The configuration panel's live status grid and OpenRouter settings in the Dark theme](assets/screenshots/panel-overview-dark.png)](assets/screenshots/panel-overview-dark.png) |
| Night theme | [![The configuration panel's live status grid and OpenRouter settings in the Night theme](assets/screenshots/panel-overview-night.png)](assets/screenshots/panel-overview-night.png) |
| Analyzer cards | [![The Analyzers section of the configuration panel, with one collapsible card per analyzer and Fire now, View reports, and Edit prompt controls](assets/screenshots/panel-analyzers.png)](assets/screenshots/panel-analyzers.png) |

## Architecture

OpenRouter Companion is one plugin built from focused modules:

- **One npm package.** Each monitoring domain is an `Analyzer` module
  under `src/analyzers/`, wired through a shared registry; the trigger
  router, rolling buffer, budget tracker, OpenRouter client, and history
  providers live in `src/core/`.
- **TypeScript 6, ESM.** esbuild bundles the backend to `dist/index.js`;
  webpack with esbuild-loader bundles the React panel to
  `public/remoteEntry.js` as a Module Federation remote the Signal K
  admin UI loads.
- **Shared panel foundations.** `signalk-nearlcrews-ui` supplies the layout,
  fields, status components, action bar, and light, dark, and night themes.
  React and React DOM are supplied by the Signal K admin host. Version 0.7.1
  starts fresh profiles in Auto, follows an explicit host theme, and otherwise
  stays Light. System follows the operating-system preference, and all explicit
  choices persist under the shared key.
- **Binnacle-aligned verification.** TypeScript, Biome, ESLint, dependency
  boundaries, dead-code checks, Vitest, Playwright, package validation, size
  budgets, workflow security, and dependency audits share the same gate
  structure. Signal K
  integration checks cover both the declared 2.25 floor and the latest server.

See the [development guide](https://github.com/NearlCrews/signalk-openrouter-companion/blob/main/docs/DEVELOPMENT.md) for the full module map
and the analyzer extension point.

## Requirements

- [Signal K server](https://github.com/SignalK/signalk-server) 2.25.0 or newer,
  before 3.0.0. Version 2.25 added the ESM configurator-container loading this
  panel requires.
- Node.js 22.18 or newer.
- A browser with native CSS `@scope`: Chromium or Edge 120+, Firefox 146+, or
  Safari 17.4+.
- An [OpenRouter](https://openrouter.ai) API key, set in the plugin's
  admin panel. Calls are billed per token.
- Optional: one supported history writer and database:
  [`signalk-questdb`](https://www.npmjs.com/package/signalk-questdb),
  [`signalk-to-influxdb`](https://www.npmjs.com/package/signalk-to-influxdb)
  for InfluxDB 1.x, or
  [`signalk-to-influxdb2`](https://www.npmjs.com/package/signalk-to-influxdb2)
  for InfluxDB 2.x. The `aging` and `drift` analyzers require history, the
  `forecast` analyzer uses it as an optional baseline, and the other four work
  without it.

## Installation

Install from the Signal K admin UI under **Apps and Plugins, then Store**, or
from npm:

```bash
cd ~/.signalk
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

Then enable it under **Apps and Plugins, then Plugin Configuration** and set your
OpenRouter API key in the panel that opens.

## Configuration

The plugin ships a custom admin panel that replaces the default Signal K
plugin form. The main settings:

| Setting | Description | Default |
| --------- | ------------- | --------- |
| OpenRouter API key | Required. Key from openrouter.ai. | n/a |
| Model | OpenRouter model slug. | anthropic/claude-haiku-4.5 |
| Max calls per day | Hard cap on OpenRouter calls per UTC day, to bound spend. | 20 |
| History source | Disabled, QuestDB, or InfluxDB for the trend analyzers. | QuestDB; `http://localhost:9000` |
| Analyzers | Each of the seven can be enabled or disabled independently. | six on by default; the weather outlook is opt-in |

For InfluxDB 1.x, select InfluxDB and enter the server URL, database, and any
username and password used by `signalk-to-influxdb`. The provider reads the
writer's measurement-per-Signal-K-path layout, numeric `value` field, and
`context` tag for this vessel.

For InfluxDB 2.x, configure `signalk-to-influxdb2` first so its DBRP mapping is
available, then select version 2 in this panel. Enter the DBRP database name,
and enter an InfluxDB API token in the password field. Leave the username blank
to use token authentication, or enter a v1-compatible username to use Basic
authentication with the token as its password. This provider reads the
writer's numeric `value` field and `self=true` tag. It does not require Flux
access or a second time-series database.

Advanced settings (engine RPM thresholds, cell-imbalance settle times,
trend window lengths, custom cron patterns) are not in the panel; they
live in the saved JSON config at
`~/.signalk/plugin-config-data/signalk-openrouter-companion.json`.

Advanced OpenRouter settings, edited in the saved JSON config under
`openrouter`:

| Key | Meaning | Default |
| ----- | --------- | --------- |
| `fallbackModels` | Ordered list of model slugs to try if the primary is unavailable. | none |
| `provider.sort` | Routing preference: `price`, `throughput`, or `latency`. | unset |
| `provider.maxPrice` | Per-call price ceiling. `prompt` and `completion` are USD per million tokens; `request` is a flat USD per request. | unset |
| `provider.allowFallbacks` | When `false`, a run fails rather than substituting another provider. | unset; OpenRouter default: `true` |
| `provider.dataCollection` | Set to `deny` to route only to providers that do not retain request data. Also available as a panel toggle. | unset; OpenRouter default: `allow` |
| `provider.zdr` | Require zero-data-retention providers. | unset; OpenRouter default: `false` |

Token use and estimated cost per day are shown in the panel status block, and
per-report model and cost are recorded in `reports.jsonl`. The cost figure is
OpenRouter's reported `usage.cost`. If you use a Bring-Your-Own-Key provider,
that figure reflects only OpenRouter's fee, not the upstream provider charge,
so it understates true spend.

A tight provider configuration (a low `maxPrice`, `dataCollection: deny`,
`zdr: true`, or `allowFallbacks: false`) can leave no eligible provider; the
run then fails fast with OpenRouter's routing message rather than retrying.

## Analyzers

Seven analyzers ship; six are enabled by default. The weather outlook is
opt-in because it benefits from a barometer or anemometer on the vessel
and is more chatty than the per-event analyzers. The two history-backed
trend analyzers need a few weeks of history before their reports are
meaningful.

- **maintenance**: a short narrative of each completed engine session.
  Fires when the engine stops.
- **health**: a daily snapshot of every battery bank.
- **alerts**: real-time battery threshold crossings (low state of charge,
  cell imbalance), as alarm-grade notifications.
- **aging**: a monthly look at battery capacity loss per bank over two
  configurable windows (default 30 and 90 days). Reads the selected history
  source.
- **drift**: a weekly look at engine fuel economy and per-RPM drift
  against a configurable trailing baseline (default 30 days). Reads
  the selected history source.
- **liveness**: a daily check that the data the other analyzers depend on
  is still flowing, flagging stale and multi-source paths.
- **forecast**: a short-term weather outlook. Reads how barometric
  pressure, wind, temperature, and (when available) cloud, visibility,
  and precipitation are trending, then predicts how conditions develop
  over the next few hours. Works with a real onboard barometer and
  anemometer, or with
  [`signalk-virtual-weather-sensors`](https://www.npmjs.com/package/signalk-virtual-weather-sensors).
  A severity-floor dropdown sets when the outlook raises an alarm. Runs
  every 3 hours by default.

Reports publish as informational notifications (`state: nominal`). The
`alerts` analyzer publishes true alerts with a stable alert id, which a
co-installed
[`signalk-nmea2000-emitter-cannon`](https://github.com/NearlCrews/signalk-nmea2000-emitter-cannon)
can forward to a NMEA 2000 chartplotter. The `forecast` analyzer publishes
its outlook at `state: nominal` and escalates to an alert state when the
predicted severity meets the configured floor.

> [!IMPORTANT]
> The `alerts` analyzer writes its alert text with an OpenRouter call, so
> a battery crossing is reported only when that call succeeds and the
> shared daily budget (Max calls per day) is not yet exhausted. If the
> budget is spent, or OpenRouter is unreachable, a crossing may not raise
> a notification at the helm. The underlying detection still runs, but the
> operator-facing alarm depends on a cloud call. Do not rely on this as
> your sole battery safety alarm: pair it with a hardware or BMS alarm,
> and set the daily budget high enough to cover your expected crossings.

## Documentation

- [Development guide](https://github.com/NearlCrews/signalk-openrouter-companion/blob/main/docs/DEVELOPMENT.md): architecture, the analyzer
  extension point, the REST API, build, and tests
- [Changelog](https://github.com/NearlCrews/signalk-openrouter-companion/blob/main/CHANGELOG.md)
- [Contributing](https://github.com/NearlCrews/signalk-openrouter-companion/blob/main/.github/CONTRIBUTING.md)
- [Security policy](https://github.com/NearlCrews/signalk-openrouter-companion/blob/main/.github/SECURITY.md)

## Development

The published plugin runs on Node 22.18 or newer. Building from source requires
Node 22.22.2+, Node 24.15+, or Node 26, with TypeScript 6 for development. The
checked-in `.node-version` selects Node 22.22.2. The primary CI gate runs on
Node 26 with npm 11.18.0, and Signal K plugin CI checks Node 22, 24, and 26
across its desktop platforms.

```bash
git clone https://github.com/NearlCrews/signalk-openrouter-companion.git
cd signalk-openrouter-companion
npm install          # install dependencies
npx playwright install --with-deps chromium firefox webkit # one-time browser setup
npm run build        # bundle the backend and the panel
npm test             # Vitest suite
npm run type-check   # type-check without emitting
npm run lint         # code, documentation, and spelling checks
npm run lint:fix     # lint and auto-fix
npm run verify       # static checks, coverage, build, and size budgets
npm run test:browser # current production panel build in Chromium
npm run test:browser:with-build # build, then run the Chromium panel test
npm run verify:release # cross-browser, package, and dependency audit gate
npm run hooks        # enable the repository's commit and push hooks
npm run clean        # remove dist/ and public/
```

Run `npm run verify:browser` before pushing and `npm run verify:release` before
release approval. See the [development guide](https://github.com/NearlCrews/signalk-openrouter-companion/blob/main/docs/DEVELOPMENT.md) for the full
workflow.

## License

Apache-2.0: see the [license](https://github.com/NearlCrews/signalk-openrouter-companion/blob/main/LICENSE) for the full text. The software is
provided "AS IS", without warranty of any kind. Treat the generated
reports and alerts as advisory, and keep independent engine and battery
monitoring in place. Bundled dependency attributions are in
[third-party notices](https://github.com/NearlCrews/signalk-openrouter-companion/blob/main/THIRD_PARTY_NOTICES.md).

## Acknowledgments

Written and maintained by [Nearl Crews](https://github.com/NearlCrews).

- [Signal K Project](https://signalk.org/) for the open marine data
  standard
- [OpenRouter](https://openrouter.ai) for the unified LLM API
- [QuestDB](https://questdb.io) for the time-series database the trend
  analyzers read
- [InfluxData](https://www.influxdata.com) for the InfluxDB history source

OpenRouter Companion pairs well with sibling plugins such as
[`signalk-virtual-weather-sensors`](https://www.npmjs.com/package/signalk-virtual-weather-sensors)
and [`signalk-nmea2000-emitter-cannon`](https://github.com/NearlCrews/signalk-nmea2000-emitter-cannon).

## Support

Find this plugin useful? You can support its continued development by
[buying me a coffee](https://www.buymeacoffee.com/nearlcrews).

- [Report a bug](https://github.com/NearlCrews/signalk-openrouter-companion/issues/new?template=bug_report.yml)
- [Request a feature](https://github.com/NearlCrews/signalk-openrouter-companion/issues/new?template=feature_request.yml)
- [Security issues](https://github.com/NearlCrews/signalk-openrouter-companion/blob/main/.github/SECURITY.md)
