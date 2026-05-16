# Weather Outlook Analyzer: design

Date: 2026-05-16
Status: approved design, ready for implementation planning
Repo: signalk-openrouter-companion

## Summary

Add a 7th analyzer, `forecast` ("Weather Outlook Advisor"), to the OpenRouter
Companion. It reads how environmental conditions are *changing* over the last
several hours, feeds that trend to an LLM, and publishes a plain-prose
short-term weather outlook as a Signal K notification. A user-set severity
floor controls how bad the predicted weather must be before the notification
raises an alarm rather than just sitting at `state: normal`.

The goal is prediction *beyond* the current-condition alerts AccuWeather and
the `signalk-virtual-weather-sensors` plugin already emit: catch a falling
glass, a veering wind, or a collapsing cloud ceiling before a storm is
formally flagged.

## Motivation

The Companion is an LLM-analyzer framework. Its six existing analyzers cover
engine and battery telemetry. Weather is the same shape of problem: noisy
time-series telemetry that a domain-expert LLM can summarize and reason over.
AccuWeather (as integrated by `signalk-virtual-weather-sensors`) reports
current conditions only, with no multi-hour forecast endpoint. So the
"prediction" here is the LLM extrapolating an outlook from observed trends,
with the latest AccuWeather reading as the authoritative current anchor (a
wider-area observation than any single onboard sensor).

This broadens the Companion from engine/battery telemetry to general vessel
telemetry. The README and `docs/DEVELOPMENT.md` are updated to say so.

## Design decisions (settled during brainstorming)

1. **Host:** new analyzer inside `signalk-openrouter-companion`, reusing its
   OpenRouter client, per-day spend cap, QuestDB integration, cron scheduling,
   and React config panel. Not a feature in the weather plugin, not a split
   across both repos.
2. **Prediction basis:** observed trends (rolling buffer + optional QuestDB)
   cross-checked against the current AccuWeather-anchored snapshot.
3. **Severity model:** the LLM grades each prediction; a 3-level dropdown sets
   the floor for raising an alarm.
4. **Cadence:** cron-driven, user-editable per the framework's standard
   `triggers.cron` config, shipped default every 3 hours.
5. **Call strategy:** the LLM runs every cron tick (approach A). No code-side
   pre-filter. The daily spend cap already bounds cost; this matches every
   other analyzer.

## Architecture

A new `ForecastAnalyzer` class implementing the existing `Analyzer` interface
(`collectContext` -> `buildPrompt` -> `publishOutput`). It is wired in exactly
the way the six current analyzers are:

- `src/analyzers/forecast.ts` (new): the analyzer class and its default
  system prompt.
- `src/analyzers/ids.ts`: add `'forecast'` to `ANALYZER_IDS` and a title to
  `ANALYZER_TITLES` (`'Weather Outlook Advisor'`).
- `src/analyzers/registry.ts`: add a `forecast` factory to
  `ANALYZER_FACTORIES`.
- `src/types.ts`: add the `analyzers.forecast` config block to
  `PluginOptions`, its `DEFAULT_OPTIONS` entry, the `mergeAnalyzerCfg` wiring,
  and a `FORECAST_DEFAULT_*` constant for any clamped numeric option.
- `src/schema.ts`: add the `forecast` section, including the `severityFloor`
  enum dropdown.
- `src/configpanel/PluginConfigurationPanel.jsx`: add the `forecast` analyzer
  card with a `<select>` for the severity floor.
- `src/index.ts`: subscribe the weather paths into the rolling buffer when the
  `forecast` analyzer is enabled.

The analyzer is **source-agnostic**: it consumes canonical `environment.*`
Signal K paths, so it works with a real onboard barometer/anemometer just as
well as with `signalk-virtual-weather-sensors`. The weather plugin is the
expected feed but is not a hard dependency.

## Data collection (`collectContext`)

### Two path families

The analyzer is explicitly aware of two distinct families of input paths, and
this distinction is documented (see Documentation below):

**Canonical paths** (Signal K 1.8.2 standard leaves, provider-agnostic: a real
sensor or the weather plugin can feed them):

- `environment.outside.pressure`
- `environment.outside.temperature`
- `environment.outside.dewPointTemperature`
- `environment.outside.relativeHumidity`
- `environment.wind.speedOverGround`
- `environment.wind.directionTrue`

**Virtual Weather Sensor extension paths** (producer-namespaced
`environment.weather.*`, emitted by `signalk-virtual-weather-sensors`; present
only when that plugin, or another producer, feeds them):

- `environment.weather.speedGust`
- `environment.weather.cloudCover`
- `environment.weather.cloudCeiling`
- `environment.weather.visibility`
- `environment.weather.precipitationLastHour`
- `environment.weather.temperatureDeparture24h`

The analyzer subscribes whatever subset of these `app.streambundle`
`getAvailablePaths()` reports as present. It **degrades gracefully**:

- Canonical-only feed: still produces a forecast. Pressure tendency, wind
  shift, and temperature/dewpoint convergence carry the prediction.
- Extension paths also present: the outlook is enriched. A lowering cloud
  ceiling, collapsing visibility, precipitation onset, and the 24h temperature
  departure are strong leading indicators the LLM is told to weigh.

Each value is tagged with its `$source` so the LLM (and the trend table)
knows what is AccuWeather-sourced versus a real onboard sensor.

### Buffer subscription

When `forecast` is enabled, `index.ts` subscribes the available weather paths
into the existing `RollingBuffer` (which already retains ~24h, as the `health`
analyzer's 24h voltage windows rely on). The weather paths are fixed canonical
strings, so no per-instance discovery is needed (unlike engines and battery
banks). A static `WEATHER_CANONICAL_PATHS` / `WEATHER_EXTENSION_PATHS` list
lives in `src/core/paths.ts`.

### Trend table

`collectContext` slices each subscribed path from the buffer into hourly-mean
buckets over the last ~12h, producing a compact tendency table for the prompt.
Barometric tendency (hPa change per 3h) is the headline metric and is
pre-computed so the LLM does not have to derive it.

### QuestDB baseline (optional)

If a QuestDB client is configured and reachable, one query extends the window
to a 24-72h baseline so the LLM can distinguish a passing squall from a
settling pattern. If QuestDB is absent, the analyzer runs buffer-only on the
~24h the buffer holds. QuestDB is a strict enhancement, never required.

### Cold-start guard

If less than ~1h of history is in the buffer and no QuestDB baseline is
available, `collectContext` returns `null`. The tick is skipped and no
OpenRouter call is spent, rather than asking the LLM to guess from a near-empty
table. This mirrors how `drift` returns `null` when it has no data.

## The LLM call (`buildPrompt`)

The default system prompt frames an experienced marine weather forecaster and
names the leading indicators to weigh: barometric tendency (rate and sign of
pressure change), wind veering versus backing, temperature/dewpoint
convergence, and (when present) a lowering cloud ceiling, collapsing
visibility, and precipitation onset. It carries the house output style already
used by the other analyzers: one plain-prose paragraph, ~80-150 words, no
markdown.

The user content is the trend table plus the current AccuWeather-anchored
snapshot.

The model is instructed to output **two parts**:

1. A machine-readable first line: `SEVERITY: severe|moderate|minor|none`.
2. The plain-prose outlook paragraph.

`customSystemPrompt` remains supported, like every other analyzer, via
`resolveSystemPrompt`.

## Severity grading and the dropdown

`collectContext`/`publishOutput` parses the `SEVERITY:` line, validates it
against the four allowed grades, and strips it from the published text. A
missing or malformed line falls back to grade `none` (the safe default: write
the outlook, raise no alarm).

The config dropdown `severityFloor` has three options:

| Dropdown label      | Config value | Raises an alarm when LLM grade is |
|---------------------|--------------|-----------------------------------|
| Severe only         | `severe`     | `severe`                          |
| Moderate and up     | `moderate`   | `severe`, `moderate`              |
| Any deterioration   | `minor`      | `severe`, `moderate`, `minor`     |

Default: `moderate` ("Moderate and up").

When the grade meets or exceeds the floor, the notification publishes with a
mapped Signal K notification state:

- `severe`   -> `alarm`
- `moderate` -> `warn`
- `minor`    -> `alert`

When the grade is below the floor, or is `none`, the outlook is **still
published**, with `state: normal`, so it is always readable in the Signal K
Data Browser. It simply does not raise an alarm.

## Output

Published via `publishOnPath` (the pattern the `alerts` analyzer already uses)
to a single stable path:

```
notifications.openrouter-companion.forecast.report
```

The state on that path varies per the severity mapping above. The notification
deliberately stays in the Companion namespace and does **not** use
`notifications.environment.weather.*`: that branch belongs to
`signalk-virtual-weather-sensors` for its current-condition alerts, and the
Companion must not squat it. Keeping the prediction under the Companion's own
namespace also keeps provenance unambiguous for consumers.

## Config block

Added to `PluginOptions.analyzers` and `DEFAULT_OPTIONS`:

```ts
forecast: {
  enabled: false,                        // opt-in, like every analyzer
  triggers: {
    cron: { enabled: true, pattern: '0 */3 * * *', timezone: '' },
    put: { enabled: true, path: pluginPutPath('forecast') },
    events: [],
  },
  severityFloor: 'moderate',             // the dropdown
  customSystemPrompt?: string,
}
```

`severityFloor` is a string enum (`'severe' | 'moderate' | 'minor'`). The cron
pattern is user-editable in the admin panel like every other analyzer; the
shipped default is every 3 hours, which aligns with the classic 3-hour
barometric-tendency interval.

## Schema and config panel

- `src/schema.ts`: the `forecast` section mirrors the other analyzers' schema
  (enabled, triggers, customSystemPrompt) plus a `severityFloor` enum with
  `enum: ['severe','moderate','minor']` and `enumNames`/titles
  `['Severe only','Moderate and up','Any deterioration']`.
- `src/configpanel/PluginConfigurationPanel.jsx`: a `forecast` analyzer card
  matching the existing cards, with the severity floor rendered as a simple
  `<select>` dropdown.

## Documentation

The dual path-family awareness and the new analyzer are documented:

- **`README.md`**: add `forecast` to the analyzer list; note it reads weather
  telemetry and works with a real barometer or with
  `signalk-virtual-weather-sensors`. Bump the analyzer count wherever it
  appears.
- **`docs/DEVELOPMENT.md`**: a dedicated subsection for the Weather Outlook
  Advisor explaining the two input path families (canonical
  `environment.outside.*` / `environment.wind.*` versus the producer-namespaced
  `environment.weather.*` extension paths from `signalk-virtual-weather-sensors`),
  the graceful degradation behavior, the severity grading and floor, and the
  output path.
- **`CHANGELOG.md`**: a new entry for the release that ships the analyzer.

## Testing

A new `tests/forecast.test.ts`, mirroring the existing per-analyzer test
files, covering:

- Hourly-bucket trend math and the pre-computed 3h pressure tendency.
- `SEVERITY:` line parsing: each valid grade, plus a malformed/missing line
  falling back to `none`.
- The `severityFloor` -> alarm decision and the grade -> Signal K state
  mapping for all three floor settings.
- Cold-start: `collectContext` returns `null` with insufficient history and
  no QuestDB.
- Buffer-only path versus QuestDB-baseline path.
- Graceful degradation: canonical-only input still produces a prompt; the
  extension paths, when present, appear in the trend table.

The project's `npm run validate` (type-check, lint, full test run) must pass.

## Out of scope

- Calling an AccuWeather (or any) multi-day forecast API. The prediction is
  trend extrapolation only.
- Bridging the forecast notification to NMEA 2000. Consumers can bridge it via
  `signalk-to-nmea2000` if they choose; this analyzer emits Signal K only.
- Any change to `signalk-virtual-weather-sensors`. That plugin is consumed
  as-is through its published Signal K paths.
