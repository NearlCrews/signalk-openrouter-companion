# signalk-openrouter-companion

OpenRouter-powered analyzers for Signal K. Ships with an engine **maintenance reporter** that generates a plain-English summary after every engine session and publishes it as a Signal K notification. Designed to be extended with more analyzers (voyage logger, alarm translator, anomaly watcher) without touching the core.

## What it does (v0.1)

- Watches your propulsion + electrical telemetry on `vessels.self`.
- Detects when an engine session ends.
- Calls OpenRouter to generate a short report from the session's data plus any active engine alarms and battery state.
- Publishes the report as a Signal K notification (`notifications.openrouter-companion.maintenance.report`).
- Appends each report to a JSONL log under the plugin's data directory.
- Optionally enriches the prompt with 30-day baselines pulled from a co-installed `signalk-questdb` instance.
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
- **Max calls per day**: hard cap, default 20.
- **QuestDB URL**: if you run `signalk-questdb`, the plugin will pull 30-day baselines for richer reports. Default `http://localhost:9000`. Leave QuestDB disabled if you don't have it.
- **Engine-off and Engine-on RPM thresholds**: leave at defaults unless your engine idles unusually low or high.

## Where reports appear

- **Signal K notifications**: every report posts a `state: normal` notification on `notifications.openrouter-companion.maintenance.report`. Any SK-aware app surfaces it.
- **Log file**: every report also appends to `<SIGNALK_NODE_CONFIG_DIR>/plugin-config-data/signalk-openrouter-companion/reports.jsonl` (one JSON object per line).

## Trigger a report on demand

PUT to `plugins.openrouter-companion.maintenance.run` on `vessels.self`. Example:

```bash
curl -X PUT \
  -H "Authorization: Bearer $SK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value": {"reason": "manual"}}' \
  http://localhost:3000/signalk/v1/api/vessels/self/plugins/openrouter-companion/maintenance/run
```

## Troubleshooting

- **"Awaiting API key configuration"**: fill in the OpenRouter API key in the admin UI and save.
- **"Running, no engine data detected"**: the plugin couldn't find any `propulsion.<id>.revolutions` paths. Check that your NMEA2000 gateway or engine source is actually publishing RPM.
- **"Running, budget exhausted for today"**: you hit the per-day cap. Raise it or wait until UTC midnight.
- **Reports not appearing**: check Server Log with `DEBUG=signalk-openrouter-companion`.

## Adding a custom analyzer

Implement the `Analyzer` interface (`src/analyzers/Analyzer.ts`), drop the new file under `src/analyzers/`, register it in `src/index.ts` next to `MaintenanceAnalyzer`. See `src/analyzers/maintenance.ts` for a worked example.

## License

Apache-2.0.
