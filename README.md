# signalk-openrouter-companion

OpenRouter-powered analyzers for Signal K. Ships five analyzers, split by purpose:

- **Maintenance Advisor** (`maintenance`, state): plain-English report after every engine session.
- **Battery Health Advisor** (`health`, state): daily snapshot covering every discovered battery bank.
- **Battery Threshold Alerts** (`alerts`, transition): short notifications when a bank crosses configurable thresholds (low SoC, cell imbalance).
- **Battery Aging Tracker** (`aging`, trend): monthly capacity-loss trend per bank, sourced from QuestDB history.
- **Engine Performance Drift** (`drift`, trend): weekly per-RPM-band fuel-economy drift vs the trailing 30-day baseline, sourced from QuestDB history.

Each analyzer is independently enabled/disabled in the admin UI and shares the standardized triggers config (cron, PUT, events). Designed to be extended with more analyzers (voyage logger, alarm translator, anomaly watcher) without touching the core.

## What it does

- Watches your propulsion and electrical telemetry on `vessels.self`.
- Runs analyzers when their triggers fire (engine-stop, low-SoC threshold crossing, cron, PUT).
- Calls OpenRouter to generate a short report or notification using the session data, current snapshot, active engine alarms, and battery state.
- Publishes each report as a Signal K notification on a per-analyzer path.
- Appends every report to a JSONL log under the plugin's data directory.
- Trend analyzers (`aging`, `drift`) read history from a co-installed `signalk-questdb`. State analyzers describe "now" without QuestDB.
- Honors a per-day call cap so a misconfigured loop can't burn through credit.

## Install

Via the Signal K app store: search for "OpenRouter Companion" and install.

Or manually:

```bash
cd ~/.signalk
npm install signalk-openrouter-companion
```

Restart the Signal K server, then open the admin UI then Plugin Config then OpenRouter Companion.

## Configure

Required:

- **OpenRouter API key**: get one at <https://openrouter.ai>.

Optional:

- **Model**: defaults to `anthropic/claude-haiku-4.5`. Any OpenRouter-supported chat model works.
- **Max OpenRouter calls per day**: hard cap, default 20.
- **QuestDB URL**: required for the trend analyzers (`aging`, `drift`). State analyzers (`maintenance`, `health`, `alerts`) ignore it. Default `http://localhost:9000`. The plugin probes QuestDB on start; if it's unreachable, trend analyzers go silent for the run while state analyzers continue. Disable in the admin UI if you want to skip the probe entirely.
- **Schedule (cron) for any analyzer**: pick one of the seven presets (8:00 AM daily, 7:00 AM daily, Noon daily, 5:30 PM daily, 6:00 PM daily, Midnight Sunday, Midnight on the 1st), or choose "Other" to enter a custom 5-field cron pattern.
- **Engine-off and Engine-on RPM thresholds (in Hz: 1.0 Hz = 60 RPM)**: leave at defaults unless your engine idles unusually low or high.
- **Low state-of-charge threshold (alerts)**: default 30%. SoC must rise above `threshold + hysteresis` (default +5%) to clear.
- **Cell imbalance threshold (alerts)**: default 0.1 V. Must persist past the settle window (default 60 s) before an event fires.
- **Aging windows (short/long)**: how far back to look for the two aging trend windows. Defaults 30 and 90 days. Useful to extend on a slowly-cycling lithium pack, or shorten if your QuestDB retention is tight.
- **Drift baseline window**: how many days of history the drift analyzer uses as the trailing baseline. Default 30. The "past week" recent window is fixed at 7 days; the baseline ends where the recent window begins (no overlap).

Disabling an analyzer or QuestDB collapses its options away in the admin form. Heads up: rjsf treats a re-enable as a fresh form, so toggling back on restores the schema defaults rather than whatever values you had entered. Save before toggling if you want to keep a tweaked configuration.

A few advanced fields are hidden from the admin form for simplicity (OpenRouter base URL, request timeout, notification path, log filename, per-analyzer PUT path, per-analyzer cron timezone). They still exist in the schema and can be overridden by editing `~/.signalk/plugin-config-data/signalk-openrouter-companion.json` directly.

### Triggers

Each analyzer has a standardized `triggers` block in plugin config:

- **cron**: 5-field cron pattern plus IANA timezone.
- **put**: a Signal K PUT path under `vessels.self`.
- **events**: list of analyzer-specific event subkinds.

A run fires when any of these triggers matches.

### Defaults per analyzer

| Analyzer    | cron          | put                                                          | events                                                                         |
| ----------- | ------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| maintenance | off           | `plugins.openrouter-companion.maintenance.run`               | `engine-stop`                                                                  |
| health      | `0 8 * * *`   | `plugins.openrouter-companion.health.run`                    | (none)                                                                         |
| aging       | `0 8 1 * *`   | `plugins.openrouter-companion.aging.run`                     | (none)                                                                         |
| drift       | `0 8 * * 0`   | `plugins.openrouter-companion.drift.run`                     | (none)                                                                         |
| alerts      | off           | off (default path `plugins.openrouter-companion.alerts.run`) | `low-soc-enter`, `low-soc-exit`, `cell-imbalance-enter`, `cell-imbalance-exit` |

## Where reports appear

- **Signal K notifications**:
  - maintenance: `notifications.openrouter-companion.maintenance.report` (state: `normal`)
  - health: `notifications.openrouter-companion.health.report` (state: `normal`)
  - aging: `notifications.openrouter-companion.aging.report` (state: `normal`)
  - drift: `notifications.openrouter-companion.drift.report` (state: `normal`)
  - alerts: `notifications.openrouter-companion.alert.<subkind>` per event; state is `alert` on enter, `normal` on exit
- **Log file**: every report appends to `<SIGNALK_NODE_CONFIG_DIR>/plugin-config-data/signalk-openrouter-companion/reports.jsonl` (one JSON object per line).

## Trigger a report on demand

PUT to the analyzer's PUT path on `vessels.self`.

Maintenance:

```bash
curl -X PUT \
  -H "Authorization: Bearer $SK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value": {"reason": "manual"}}' \
  http://localhost:3000/signalk/v1/api/vessels/self/plugins/openrouter-companion/maintenance/run
```

Health:

```bash
curl -X PUT \
  -H "Authorization: Bearer $SK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value": {"reason": "manual"}}' \
  http://localhost:3000/signalk/v1/api/vessels/self/plugins/openrouter-companion/health/run
```

Alerts (PUT is disabled by default; enable it in the admin UI first):

```bash
curl -X PUT \
  -H "Authorization: Bearer $SK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value": {"reason": "manual"}}' \
  http://localhost:3000/signalk/v1/api/vessels/self/plugins/openrouter-companion/alerts/run
```

The examples use `Authorization: Bearer $SK_TOKEN`, which requires JWT setup in the Signal K server. Cookie auth works too; see the Signal K auth docs for token setup.

## Troubleshooting

- **"Awaiting API key configuration"**: fill in the OpenRouter API key in the admin UI and save.
- **"Running, no engine or battery data detected"**: the plugin couldn't find any `propulsion.<id>.revolutions` or `electrical.batteries.<id>.*` paths. Check that your NMEA2000 gateway or BMS is actually publishing.
- **"Running, budget exhausted for today"**: you hit the per-day cap. Raise it or wait until UTC midnight.
- **Reports not appearing**: check Server Log with `DEBUG=signalk-openrouter-companion`.

## Adding a custom analyzer

Implement the `Analyzer` interface (`src/analyzers/Analyzer.ts`), drop the new file under `src/analyzers/`, register it in `src/index.ts` alongside the existing analyzers. See the existing five (`maintenance`, `health`, `alerts`, `aging`, `drift`) for worked examples.

## License

Apache-2.0.
