# Signal K OpenRouter Companion

[![License](https://img.shields.io/github/license/NearlCrews/signalk-openrouter-companion.svg)](LICENSE)

> **Beta.** The plugin hasn't been around long enough to test a full 30 or 90 days of live data, so the trend analyzers (`aging`, `drift`) are unverified against real long-window history. Per-trigger smoke tests pass; whether the prose the LLM produces makes sense over a full quarter of telemetry is still an open question.

A Signal K plugin that runs LLM analyzers over your vessel's propulsion and electrical telemetry via the OpenRouter API. Ships five analyzers split by purpose: state (now), transition (threshold crossings), and trend (over time). Each emits a short, plain-prose report or alert as a Signal K notification under `notifications.openrouter-companion.*` and appends every run to a JSONL log.

## Analyzers

| Analyzer      | Kind       | Fires on                                       | Reads     | Notification path                                          |
| ------------- | ---------- | ---------------------------------------------- | --------- | ---------------------------------------------------------- |
| `maintenance` | state      | engine-stop (or cron/PUT)                      | buffer    | `notifications.openrouter-companion.maintenance.report`    |
| `health`      | state      | cron (default 8am daily) or PUT                | buffer    | `notifications.openrouter-companion.health.report`         |
| `alerts`      | transition | battery-event subkinds (low SoC, imbalance)    | snapshot  | `notifications.openrouter-companion.alert.<subkind>`       |
| `aging`       | trend      | cron (default 8am on the 1st) or PUT           | QuestDB   | `notifications.openrouter-companion.aging.report`          |
| `drift`       | trend      | cron (default 8am Sunday) or PUT               | QuestDB   | `notifications.openrouter-companion.drift.report`          |

- **State** analyzers describe "now": one engine session, or today's battery snapshot.
- **Transition** analyzers describe a threshold crossing: SoC dropped below 30%.
- **Trend** analyzers describe gradual change over a configurable window from QuestDB history: monthly capacity loss per bank, weekly per-RPM-band fuel-economy drift.

Each analyzer is independently enabled in the admin UI and shares the standardized `triggers` config (cron + PUT + events).

## Features

- **Five analyzer modules** sharing one extension point (`src/analyzers/Analyzer.ts`). Adding a sixth (voyage logger, alarm translator, anomaly watcher) is a single file under `src/analyzers/`.
- **Standardized triggers contract** per analyzer: `{ cron, put, events }`. Same shape across all five; the events enum is per-analyzer.
- **Plain-prose output**, no markdown. Designed for the Signal K data browser's single-string notification renderer.
- **Per-day OpenRouter call cap** so a misconfigured cron loop can't burn through credit.
- **JSONL log** of every run at `<plugin-config-data>/signalk-openrouter-companion/reports.jsonl`.
- **NMEA 2000 Alert Text compatibility**: alert messages truncate to 200 chars (word-boundary cut) for chartplotters that read PGN 126985 via `signalk-nmea2000-emitter-cannon`.
- **QuestDB-backed trend analyzers** with configurable history windows. State analyzers stay independent of QuestDB.
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
| **Cell imbalance threshold (alerts)** | Volts | 0.1 V | sane V values |
| **Cell imbalance settle (alerts)** | How long imbalance must persist before firing | 60 s | 0 to 3600 |
| **Aging short window (days)** | Near-term aging trend window | 30 | 7 to 365 |
| **Aging long window (days)** | Longer-term aging trend window, used for the projection-to-replace estimate | 90 | 7 to 1095 |
| **Drift baseline window (days)** | Trailing baseline length for drift; the past-7-day recent window is fixed | 30 | 14 to 365 |

Disabling an analyzer or QuestDB collapses its options away in the admin form. Heads-up: rjsf clears dependent field values when toggling enabled off, then restores schema defaults on re-enable. Save before toggling if you have non-default tunables.

A few advanced fields are hidden from the admin form (OpenRouter base URL, request timeout, notification path, log filename, per-analyzer PUT path, per-analyzer cron timezone). They still exist in the schema and can be overridden by editing `~/.signalk/plugin-config-data/signalk-openrouter-companion.json` directly.

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

## Where reports appear

- **Signal K notifications** at the paths in the analyzer table above. State and trend reports use state `normal`; alerts use `alert` on enter events and `normal` on exit.
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

### Alert message truncated with `…` suffix
This is by design: alerts cap at 200 ASCII chars (word-boundary cut) so chartplotters reading NMEA 2000 PGN 126985 (Alert Text) via `signalk-nmea2000-emitter-cannon` get clean, in-budget text. The full message is still in `reports.jsonl`.

### Reports not appearing at all
Run the Signal K server with `DEBUG=signalk-openrouter-companion` and tail the server log. Common causes: API key not set, QuestDB not reachable (trend analyzers only), no telemetry on the watched paths.

## Adding a custom analyzer

1. Implement the `Analyzer` interface in `src/analyzers/Analyzer.ts`: `id`, `title`, `triggers`, `collectContext`, `buildPrompt`, optional `publishOutput`.
2. Use the shared helpers in `src/core/`: `buildTriggers(cfg)` for the standardized cron/PUT/events block, `bankPaths(id)`/`enginePaths(id)`/`notificationReportPath(id)` for path strings, `escapeSqlLiteral` + `indexColumns` for QuestDB queries.
3. Register the analyzer in `src/index.ts` alongside the existing five and add a section to `src/schema.ts`.
4. Add a test under `tests/`, reusing `makeAnalyzerDeps` and (for trend analyzers) `makeQuestDBStub` from `tests/_mocks.ts`.

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
- `croner` 10 for cron scheduling
- esbuild for bundling, Biome for lint and format, Vitest for tests (131 tests across 18 files)

### Local Signal K server

The plugin is designed to be symlinked into `~/.signalk/node_modules/signalk-openrouter-companion` and run against a local Signal K server at port 3000. After a `npm run build`, `sudo systemctl restart signalk.service` picks up the new bundle.

## License

Apache-2.0: see [LICENSE](LICENSE).

## Contributing

Issues and pull requests welcome. Before pushing, run `npm run prepublishOnly` and confirm it is clean.

## Support

- [Report a bug](https://github.com/NearlCrews/signalk-openrouter-companion/issues/new)
- [Request a feature](https://github.com/NearlCrews/signalk-openrouter-companion/issues/new)
