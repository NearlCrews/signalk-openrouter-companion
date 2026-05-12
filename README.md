# Signal K OpenRouter Companion

[![License](https://img.shields.io/github/license/NearlCrews/signalk-openrouter-companion.svg)](LICENSE)

> **Beta.** The plugin hasn't been around long enough to test a full 30 or 90 days of live data, so the trend analyzers (`aging`, `drift`) are unverified against real long-window history. Per-trigger smoke tests pass; whether the prose the LLM produces makes sense over a full quarter of telemetry is still an open question.

A Signal K plugin that runs LLM analyzers over your vessel's propulsion and electrical telemetry via the OpenRouter API. Ships five analyzers split by purpose: state (now), transition (threshold crossings), and trend (over time). Each emits a short, plain-prose report or alert as a Signal K notification under `notifications.openrouter-companion.*` and appends every run to a JSONL log.

> **Requires a paid OpenRouter API key.** LLM calls are billed per OpenRouter's token pricing. A per-day call cap (default 20) is enforced; raise or lower it in the admin UI. The trend analyzers (`aging`, `drift`) also need a co-installed [`signalk-questdb`](https://www.npmjs.com/package/signalk-questdb) instance for time-series history; state analyzers (`maintenance`, `health`, `alerts`) do not.

## Analyzers

| Analyzer      | Kind       | Fires on                                       | Reads     | Notification path                                          |
| ------------- | ---------- | ---------------------------------------------- | --------- | ---------------------------------------------------------- |
| `maintenance` | state      | engine-stop (or cron/PUT)                      | buffer    | `notifications.openrouter-companion.maintenance.report`    |
| `health`      | state      | cron (default 8am daily) or PUT                | buffer    | `notifications.openrouter-companion.health.report`         |
| `alerts`      | transition | battery-event subkinds (low SoC, imbalance)    | snapshot  | `notifications.electrical.batteries.<bankId>.{lowSoc,cellImbalance}` (canonical, per-bank) |
| `aging`       | trend      | cron (default 8am on the 1st) or PUT           | QuestDB   | `notifications.openrouter-companion.aging.report`          |
| `drift`       | trend      | cron (default 8am Sunday) or PUT               | QuestDB   | `notifications.openrouter-companion.drift.report`          |

- **State** analyzers describe "now": one engine session, or today's battery snapshot.
- **Transition** analyzers describe a threshold crossing: SoC dropped below 30%.
- **Trend** analyzers describe gradual change over a configurable window from QuestDB history: monthly capacity loss per bank, weekly per-RPM-band fuel-economy drift.

Each analyzer is independently enabled in the admin UI and shares the standardized `triggers` config (cron + PUT + events).

## Features

- **Custom React admin panel** (Module Federation, React 19) replaces the rjsf form for this plugin in the Signal K admin UI. Live status grid, per-analyzer Fire-now / View-reports / Edit-prompt buttons, OpenRouter API key + model autocomplete, QuestDB connection test before saving. The rjsf schema stays as the storage shape and is what the panel reads/writes via `save({...config})`. See [Custom config panel](#custom-config-panel) below.
- **Five analyzer modules** sharing one extension point (`src/analyzers/Analyzer.ts`). Adding a sixth (voyage logger, alarm translator, anomaly watcher) is a single file under `src/analyzers/`.
- **Standardized triggers contract** per analyzer: `{ cron, put, events }`. Same shape across all five; the events enum is per-analyzer.
- **Per-analyzer system-prompt overrides**. Each analyzer has a default system prompt and an optional `customSystemPrompt` field; if you have domain knowledge the default doesn't capture (vessel quirks, BMS-specific behavior, fleet-wide reporting style), edit the prompt inline in the panel and save. Reset clears the override.
- **REST control plane** under `/plugins/signalk-openrouter-companion/api/*` (registered via SK's `registerWithRouter`): live status, manual fire, recent reports tail, OpenRouter ping, model list proxy, QuestDB probe. See [REST API](#rest-api) below.
- **Plain-prose output**, no markdown. Designed for the Signal K data browser's single-string notification renderer.
- **Per-day OpenRouter call cap** so a misconfigured cron loop can't burn through credit.
- **JSONL log** of every run at `<plugin-config-data>/signalk-openrouter-companion/reports.jsonl`.
- **NMEA 2000 alert-PGN alignment**. Alert notifications publish on canonical per-bank paths (`notifications.electrical.batteries.<bankId>.lowSoc` and `.cellImbalance`) with `state: alert`/`normal`, `method: ['visual','sound']` on enter and `['visual']` on exit, plus a stable 16-bit `alertId` (FNV-1a hash of the path). When bridged via [`signalk-nmea2000-emitter-cannon`](https://github.com/NearlCrews/signalk-nmea2000-emitter-cannon) this maps cleanly to PGN 126983 (`alertType` from state, `alertState: Active` on enter from method, `alertId` stable across `signalk-nmea2000-emitter-cannon` restarts) and PGN 126985 (`alertTextDescription` capped at 64 chars to survive Garmin/Raymarine/Furuno/B&G display truncation). Reports (maintenance/health/aging/drift) use `state: nominal` so they DO NOT trip the chartplotter alarm.
- **QuestDB-backed trend analyzers** with configurable history windows. State analyzers stay independent of QuestDB.
- **Forgiving path discovery**: engines are discovered off `propulsion.<id>.revolutions`, or off `coolantTemperature`/`runTime`/`oilPressure`/`temperature`/`alternatorVoltage`/`fuel.rate` if no RPM source is publishing. `tanks.fuel.*` is also buffered so the maintenance prompt can cross-check fuel rate against tank-level drift over the session.
- **Restart-safe**: `plugin.whenReady()` returns once the deferred router init has wired analyzers; tests await it instead of polling.

## Installation

### From source (recommended while in beta)

```bash
git clone https://github.com/NearlCrews/signalk-openrouter-companion.git
cd signalk-openrouter-companion
npm install
npm run build
```

Then symlink into your Signal K server's plugin directory:

```bash
ln -s "$(pwd)" ~/.signalk/node_modules/signalk-openrouter-companion
```

Restart the Signal K server, then open the admin UI then Plugin Config then OpenRouter Companion.

### From npm

Not yet published. Build from source above.

## Configuration

| Setting | Description | Default | Range |
|---------|-------------|---------|-------|
| **OpenRouter API key** | Required. Get one at [openrouter.ai](https://openrouter.ai) | n/a | n/a |
| **Model** | Any OpenRouter-supported chat model | `anthropic/claude-haiku-4.5` | any model slug |
| **Max OpenRouter calls per day** | Hard per-day cap to bound spend | 20 | 1 to 1000 |
| **QuestDB URL** | Required for trend analyzers; ignored by state analyzers | `http://localhost:9000` | URL |
| **Cron schedule (per analyzer)** | Pick a preset, or edit the saved JSON for a custom 5-field pattern | per analyzer | preset list |
| **Engine-off / Engine-on RPM thresholds (Hz)** | 1.0 Hz = 60 RPM | 1.0 / 5.0 | sane Hz values |
| **Low SoC threshold (alerts)** | Percent; SoC must rise above `threshold + hysteresis` to clear | 30% | 0 to 100 |
| **Low SoC exit hysteresis (alerts)** | Added to the low threshold to debounce exits | 5% | 0 to 50 |
| **Cell imbalance threshold (alerts)** | Volts (LFP-tuned default) | 0.05 V | sane V values |
| **Cell imbalance settle (alerts)** | How long imbalance must persist before firing | 60 s | 0 to 3600 |
| **Aging short window (days)** | Near-term aging trend window | 30 | 7 to 365 |
| **Aging long window (days)** | Longer-term aging trend window, used for the projection-to-replace estimate | 90 | 7 to 1095 |
| **Drift baseline window (days)** | Trailing baseline length for drift; the past-7-day recent window is fixed | 30 | 14 to 365 |

The custom panel exposes the most-used fields (API key, model, max calls, QuestDB toggle/URL, per-analyzer enable + prompt) and writes the full config back via `save({...config})`. Anything else in the schema (per-analyzer numeric tuning like RPM thresholds, settle times, hysteresis, window days, extra watched paths) lands in the saved JSON config file under `~/.signalk/plugin-config-data/signalk-openrouter-companion.json` and can be edited there directly. The rjsf schema is also kept as a fallback so the legacy admin form renders if the panel ever fails to load.

A few advanced fields are hidden from the admin form by design (OpenRouter base URL, request timeout, log filename, per-analyzer PUT path, per-analyzer cron timezone). They still exist in the schema and can be overridden by editing the JSON config file.

### Cron presets

Seven presets are available in the admin dropdown:

| Preset | Pattern |
|--------|---------|
| 8:00 AM daily | `0 8 * * *` |
| 7:00 AM daily | `0 7 * * *` |
| Noon daily | `0 12 * * *` |
| 5:30 PM daily | `30 17 * * *` |
| 6:00 PM daily | `0 18 * * *` |
| Midnight Sunday | `0 0 * * 0` |
| Midnight on the 1st | `0 0 1 * *` |

For custom patterns, edit `~/.signalk/plugin-config-data/signalk-openrouter-companion.json` directly: the schema accepts any 5-field cron string.

### Defaults per analyzer

| Analyzer    | cron          | put                                                          | events                                                                         |
| ----------- | ------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| maintenance | off           | `plugins.openrouter-companion.maintenance.run`               | `engine-stop`                                                                  |
| health      | `0 8 * * *`   | `plugins.openrouter-companion.health.run`                    | (none)                                                                         |
| aging       | `0 8 1 * *`   | `plugins.openrouter-companion.aging.run`                     | (none)                                                                         |
| drift       | `0 8 * * 0`   | `plugins.openrouter-companion.drift.run`                     | (none)                                                                         |
| alerts      | off           | off (default path `plugins.openrouter-companion.alerts.run`) | `low-soc-enter`, `low-soc-exit`, `cell-imbalance-enter`, `cell-imbalance-exit` |

## Custom config panel

The plugin ships a Webpack Module Federation bundle that the Signal K admin UI auto-loads in place of the rjsf form (the `signalk-plugin-configurator` keyword in `package.json` opts in). The panel is a single React 19 component at `src/configpanel/PluginConfigurationPanel.jsx` built to `public/remoteEntry.js` (~18 kB total). React itself is shared as a singleton with the SK admin runtime, so no second copy is loaded.

What it shows:

- **Live status grid** (top of the page, polled every 5 s):
  - OpenRouter API key configured + current model
  - Calls today / per-day cap
  - QuestDB reachable (or Disabled / Probing)
  - Analyzer enabled count
  - "Test API key" button does a one-token round-trip to OpenRouter using the saved key
- **OpenRouter section**: API key (password input), model field with native `<datalist>` autocomplete populated from `https://openrouter.ai/api/v1/models` (proxied + cached for 1 h), max calls per day.
- **QuestDB section**: enabled toggle, URL field when enabled, "Test connection" button that probes the URL in the edit buffer BEFORE saving.
- **Per-analyzer rows**: enable checkbox, **Fire now** (manual trigger), **View reports** (drawer with the last 10 entries from `reports.jsonl`, full text), **Edit prompt** (drawer with a multi-line textarea preloaded from the analyzer's default prompt; Reset clears any custom override).
- **Sticky save bar** at the bottom; greyed out when nothing has changed.

The panel never bypasses the schema. Every Save call hands the full edited config back to the SK admin which persists it to `~/.signalk/plugin-config-data/signalk-openrouter-companion.json` and restarts the plugin. If the panel ever fails to load (e.g., older SK admin without Module Federation support), the rjsf fallback at the same URL still works.

## REST API

Mounted by the plugin via SK's `registerWithRouter` lifecycle hook under `/plugins/signalk-openrouter-companion/api/*`. All routes inherit SK admin authentication; no separate keys.

| Verb | Path | Returns |
| ---- | ---- | ------- |
| GET  | `/api/status` | `{ openrouter: { apiKeySet, model, callsToday, maxCallsPerDay }, questdb: { enabled, reachable: true \| false \| null }, analyzers: [{ id, title, enabled }] }` |
| POST | `/api/openrouter/test` | One-token ping with saved key. `{ ok, model, totalTokens, text }` on success, `{ ok: false, status, error }` on failure |
| GET  | `/api/openrouter/models` | Proxy to OpenRouter `/api/v1/models`, cached for 1 h in process |
| POST | `/api/questdb/test` | Probes URL from request body, falling back to saved config URL. `{ ok, url }` |
| POST | `/api/analyzers/:id/fire` | Synthesizes a put-kind ctx and dispatches via the live `TriggerRouter`. `{ ok, analyzer }` |
| GET  | `/api/analyzers/:id/reports?limit=N` | Tail JSONL log filtered by analyzer id. Newest first. Default 10, max 100 |
| GET  | `/api/analyzers/:id/prompt` | `{ analyzer, default, current }` for the panel's prompt editor |

Examples:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/signalk/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$SK_USER\",\"password\":\"$SK_PASS\"}" | jq -r .token)

# Live status
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/plugins/signalk-openrouter-companion/api/status | jq .

# Manual fire
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/plugins/signalk-openrouter-companion/api/analyzers/health/fire | jq .

# Last 5 reports
curl -s -H "Authorization: Bearer $TOKEN" \
  'http://localhost:3000/plugins/signalk-openrouter-companion/api/analyzers/maintenance/reports?limit=5' | jq .
```

Manual fire is also available via the standardised SK PUT trigger paths (`plugins.openrouter-companion.<analyzer>.run`); the REST `fire` endpoint is a panel-UX convenience that skips the SK delta machinery.

## Where reports appear

- **Signal K notifications** at the paths in the analyzer table above:
  - Maintenance / health / aging / drift reports use `state: nominal`, `method: ['visual']`. SK 1.8.2 treats `nominal` as informational (no action required), so a co-installed N2K emitter like [`signalk-nmea2000-emitter-cannon`](https://github.com/NearlCrews/signalk-nmea2000-emitter-cannon) does NOT translate these to PGN 126983/126985: they live in the SK data browser and the JSONL log but do not ring a chartplotter alarm.
  - Battery alerts publish on canonical per-bank paths `notifications.electrical.batteries.<bankId>.lowSoc` and `.cellImbalance`. Enter events use `state: alert`, `method: ['visual','sound']` (`signalk-nmea2000-emitter-cannon` emits PGN 126983 with Active alert state and PGN 126985 with the headline). Exit events use `state: normal`, `method: ['visual']` (`signalk-nmea2000-emitter-cannon` clears the cached PGN). Each notification carries a stable 16-bit `alertId` derived from the path so the chartplotter sees the same alert across `signalk-nmea2000-emitter-cannon` restarts.
  - `publishFailure` (LLM call failed) uses `state: warn`, `method: ['visual','sound']` on the analyzer's report path.
- **JSONL log** appended to `<SIGNALK_NODE_CONFIG_DIR>/plugin-config-data/signalk-openrouter-companion/reports.jsonl`, one JSON object per line. Includes the analyzer id, trigger kind, ISO timestamp, report text, and (for engine-stop) the session bounds and duration.

## Trigger a report on demand

PUT to the analyzer's PUT path on `vessels.self`. Cookie auth or Bearer JWT both work.

```bash
# Maintenance
curl -X PUT \
  -H "Authorization: Bearer $SK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value": {"reason": "manual"}}' \
  http://localhost:3000/signalk/v1/api/vessels/self/plugins/openrouter-companion/maintenance/run

# Health
curl -X PUT \
  -H "Authorization: Bearer $SK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value": {"reason": "manual"}}' \
  http://localhost:3000/signalk/v1/api/vessels/self/plugins/openrouter-companion/health/run

# Aging
curl -X PUT \
  -H "Authorization: Bearer $SK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value": {"reason": "manual"}}' \
  http://localhost:3000/signalk/v1/api/vessels/self/plugins/openrouter-companion/aging/run

# Drift
curl -X PUT \
  -H "Authorization: Bearer $SK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value": {"reason": "manual"}}' \
  http://localhost:3000/signalk/v1/api/vessels/self/plugins/openrouter-companion/drift/run

# Alerts (PUT is disabled by default; enable in the admin UI first)
curl -X PUT \
  -H "Authorization: Bearer $SK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value": {"reason": "manual"}}' \
  http://localhost:3000/signalk/v1/api/vessels/self/plugins/openrouter-companion/alerts/run
```

## Data flow

```
SK self-bus deltas (propulsion.*, electrical.batteries.*)
        |
        +--> RollingBuffer (26h / 50k entries per path, age + count eviction)
        |
        +--> EngineDetector (per-RPM-source state machine, engine-stop events)
        |
        +--> BatteryMonitor (per-bank SoC + cell-imbalance state machine, alert events)
                |
                v
        TriggerRouter (cron + PUT + event dispatch)
                |
                v
        Analyzer.collectContext (read SK tree, buffer, and optionally QuestDB)
                |
                v
        OpenRouter chat completion
                |
                v
        ReportPublisher (handleMessage notification + appendFile JSONL)
                |
                v
        Signal K data browser, NMEA 2000 emitter, etc.
```

## Troubleshooting

### `Awaiting API key configuration`
The OpenRouter API key field is empty. Fill it in via the admin UI and save. The status banner clears once the next start cycle runs.

### `Running, no engine or battery data yet (re-scanning every 60s)`
The plugin found no `propulsion.<id>.revolutions` or `electrical.batteries.<id>.*` paths in `streambundle.getAvailablePaths()` at startup. It re-scans every 60 seconds, so analyzers come up cleanly once your gateway or BMS starts publishing.
**What to check**: confirm in the Signal K data browser that `propulsion.*` or `electrical.batteries.*` paths exist on `vessels.self`. If they show up under a different context, the plugin only watches self.

### `Running, budget exhausted for today`
You hit the per-day OpenRouter call cap. The plugin will skip new triggers until UTC midnight. Raise `openrouter.maxCallsPerDay` (paid tier permitting) or wait for the rollover.

### Trend analyzer notification never appears
The `aging` and `drift` analyzers require QuestDB. On start, the plugin probes the configured QuestDB URL. If unreachable, the debug log shows `QuestDB unreachable; trend analyzers will skip this run`. Confirm `signalk-questdb` is installed and reachable at `http://localhost:9000` (or the configured URL).

### Aging or drift returns "no data"
Aging needs at least two samples on `electrical.batteries.<id>.capacity.actual` and `electrical.batteries.<id>.cycles` in the configured window. Drift needs at least 30 samples per RPM bin (in both the past week and the baseline window) to compute a delta. On a vessel newly outfitted with QuestDB, give it the full window before expecting trend output.

### Drift RPM bins
Drift sorts RPM samples into five bins, sized to cover both marine diesel and outboard ranges:

| Bin | Hz | ~RPM |
| --- | --- | --- |
| idle | 5-15 | 300-900 |
| low cruise | 15-30 | 900-1800 |
| high cruise | 30-50 | 1800-3000 |
| top end | 50-75 | 3000-4500 |
| wot | 75+ | 4500+ |

Diesels rarely cross 50 Hz so the top-end bin captures their WOT and the wot bin stays empty. Outboards run their cruise band in top-end and their WOT in the wot bin. Per-engine configurable bin edges are on the roadmap.

### Alert message truncated with `…` suffix
This is by design: alerts cap at 64 ASCII chars (word-boundary cut) so chartplotters reading NMEA 2000 PGN 126985 (Alert Text Description) via [`signalk-nmea2000-emitter-cannon`](https://github.com/NearlCrews/signalk-nmea2000-emitter-cannon) get clean, in-budget text. The wire field holds ~200 chars but real-world MFD display caps are tighter (Raymarine Axiom ~60, B&G Zeus ~70, Furuno TZTouch ~80, Garmin ~72). The full prose is still in the SK notification and `reports.jsonl`.

### Reports not appearing at all
Run the Signal K server with `DEBUG=signalk-openrouter-companion` and tail the server log. Common causes: API key not set, QuestDB not reachable (trend analyzers only), no telemetry on the watched paths.

## Adding a custom analyzer

1. Add the new id and title to `src/analyzers/ids.ts` (`ANALYZER_IDS` tuple and `ANALYZER_TITLES` record). This is the single source of truth for both: api.ts reads it for the status payload, and the analyzer class reads its own title from there.
2. Implement the `Analyzer` interface in `src/analyzers/Analyzer.ts`: `id`, `title` (from `ANALYZER_TITLES`), `triggers`, `collectContext`, `buildPrompt`, optional `publishOutput`. The default (when `publishOutput` is omitted) publishes via `deps.publisher.publishReport(this.id, ctx, text)` on the canonical `notifications.openrouter-companion.<id>.report` path with `state: 'nominal'`. Override only when you need a different path or state, like `alerts` does for per-bank alert paths.
3. Use the shared helpers in `src/core/`: `buildTriggers(cfg)` for the standardized cron/PUT/events block, `bankPaths(id)`/`enginePaths(id)`/`notificationReportPath(id)`/`pluginPutPath(id)` for path strings, `escapeSqlLiteral` + `indexColumns` for QuestDB queries, `asFiniteNumber` / `fmtNumber`/`fmtPct`/`fmtUnit`/`fmtRatio` for value handling, `clampPositiveInt` and `resolveSystemPrompt(cfg.customSystemPrompt, DEFAULT)` for sanitized config, `readNumberAt`/`readValueAt` for SK tree walks, `publisher.publishReport(this.id, ctx, text)` for the canonical report notification.
4. Export a `<NAME>_DEFAULT_SYSTEM_PROMPT` constant from the analyzer module and register it in `src/core/api.ts::DEFAULT_SYSTEM_PROMPTS` so `/api/analyzers/:id/prompt` can serve it.
5. Add the config block to `src/types.ts` (including `customSystemPrompt?: string`), register the analyzer in `src/index.ts` alongside the existing five, and add a section to `src/schema.ts` (drives the rjsf fallback form).
6. Add a test under `tests/`, reusing `makeAnalyzerDeps`, `makeQuestDBStub`, and `makePluginRuntime` from `tests/_mocks.ts`.

See the existing five (`maintenance`, `health`, `alerts`, `aging`, `drift`) for worked examples that cover state, transition, and trend shapes.

## Development

```bash
npm run build          # Clean build (types + bundle)
npm run dev            # Watch mode with tsx
npm run test           # Tests once (vitest run)
npm run test:watch     # Watch mode
npm run test:coverage  # Coverage report
npm run type-check     # tsc --noEmit
npm run lint           # Biome check
npm run lint:fix       # Auto-fix
npm run prepublishOnly # Type-check + lint + test + build (run before any push)
```

### Tech stack

- TypeScript 6 (strict, ESM, ES2022 target)
- Node 22+
- `@signalk/server-api` 2.24+ (`peerDependency`; the SK server provides it at runtime)
- `croner` 10 for cron scheduling (only runtime dep)
- esbuild for the backend bundle (`dist/index.js`)
- Webpack 5 + esbuild-loader + React 19 (singleton-shared with SK admin) for the panel bundle (`public/`, Module Federation)
- Biome for lint and format, Vitest for tests (155 tests across 19 files)

### Local Signal K server

The plugin is designed to be symlinked into `~/.signalk/node_modules/signalk-openrouter-companion` and run against a local Signal K server at port 3000. After a `npm run build`, `sudo systemctl restart signalk.service` picks up the new bundle.

## License

Apache-2.0: see [LICENSE](LICENSE).

## Contributing

Issues and pull requests welcome. Before pushing, run `npm run prepublishOnly` and confirm it is clean.

## Support

- [Report a bug](https://github.com/NearlCrews/signalk-openrouter-companion/issues/new)
- [Request a feature](https://github.com/NearlCrews/signalk-openrouter-companion/issues/new)
