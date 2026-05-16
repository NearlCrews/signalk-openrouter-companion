# Sensor-liveness analyzer design

Date: 2026-05-15
Status: approved, ready for implementation plan

## Problem

The plugin ships five analyzers covering batteries and the engine. None of
them report on the health of the data pipeline itself: a SignalK sensor or
NMEA2000 source can go silent and every downstream analyzer then reasons over
stale or missing data without anyone noticing.

A sixth analyzer, `liveness`, monitors the freshness of the data the other
analyzers consume. It is a state analyzer: it describes "now" (which watched
paths are currently reporting), reads no long-term history, and raises no
alert PGN.

## Scope decisions (from brainstorming)

- **Monitored set:** the watched paths only, i.e. every path the
  `RollingBuffer` has received a sample for. No whole-tree walk, no
  user-configured expected-path list. Consequence: the analyzer cannot flag a
  sensor that never appeared at all, only one that appeared and went silent.
- **Staleness threshold:** a single global `stalenessThresholdSec`, default
  300 (5 minutes), configurable via the rjsf schema / saved JSON config (the
  same route as `aging.shortWindowDays`, `drift.baselineDays`, etc.). The
  custom React panel does not render numeric per-analyzer knobs, so this is
  not a new panel widget.
- **Source flapping:** v1 detects it. A path served by 2+ distinct `$source`
  labels within the retained buffer window is flagged as flapping. This
  addresses a documented real issue on the vessel (device
  `c064960014706367` publishes under both `nmea2000_feed.*` and
  `notificationApi.*`).
- **Intermittently-powered gear:** engine paths (`propulsion.*`) legitimately
  go silent when the engine is off. This is handled in the prompt, not in
  analyzer code: the system prompt tells the LLM that such silence is
  expected and not a fault. No equipment knowledge is hard-coded.

## Approach

Approach A, buffer-only. The `LivenessAnalyzer` reads `deps.buffer`
exclusively: `pathKeys()` to enumerate watched paths, `slice(path, 0,
firedAt)` per path for the newest timestamp (freshness) and the distinct
source set (flapping). No `RollingBuffer` changes, no new subscriptions, no
QuestDB.

A SignalK-tree walk was rejected (latest-value only, cannot see a vanished
path, covers more than the chosen watched set). A dedicated
`buffer.liveness()` accessor was rejected as over-engineering for a single
consumer when `pathKeys()` + `slice()` suffice.

## Design

### New module: `src/analyzers/liveness.ts`

`id = 'liveness'`, `title = ANALYZER_TITLES.liveness`
("Sensor Liveness Monitor").

Config:

```ts
interface LivenessCfg {
  triggers: AnalyzerTriggerCfg;
  stalenessThresholdSec: number;
  customSystemPrompt?: string;
}
```

The constructor runs `buildTriggers(cfg.triggers)`, clamps the threshold via
`clampPositiveInt(cfg.stalenessThresholdSec, 300)`, and resolves the system
prompt via `resolveSystemPrompt(cfg.customSystemPrompt,
LIVENESS_DEFAULT_SYSTEM_PROMPT)`. `LIVENESS_DEFAULT_SYSTEM_PROMPT` is exported
for `core/api.ts::DEFAULT_SYSTEM_PROMPTS`.

Input shape:

```ts
interface PathLiveness {
  path: string;
  lastSeenAgeSec: number | null;  // null when no retained samples
  stale: boolean;                 // lastSeenAgeSec == null || > threshold
  sampleCount: number;            // retained entries in [0, firedAt]
  sources: string[];              // distinct, sorted
  flapping: boolean;              // sources.length > 1
}

interface LivenessInput extends AnalysisInput {
  generatedAt: string;
  stalenessThresholdSec: number;
  paths: PathLiveness[];          // sorted by path name
}
```

`collectContext(ctx, deps)`:

- For each `path` in `deps.buffer.pathKeys()`, call
  `deps.buffer.slice(path, 0, ctx.firedAt.getTime())`.
- `lastSeenAgeSec` is derived from the newest entry's `ts`
  (`(firedAt - maxTs) / 1000`), or `null` when the slice is empty.
- `sampleCount` is the slice length; `sources` is the sorted distinct set of
  entry `source` values.
- `stale = lastSeenAgeSec == null || lastSeenAgeSec > stalenessThresholdSec`;
  `flapping = sources.length > 1`.
- Return `null` when no paths are buffered yet; otherwise return
  `LivenessInput` with `paths` sorted by name.

`buildPrompt(input)`: render the path table as plain text (path, age,
sample count, sources, stale/flapping flags), prefixed with the generation
timestamp and the active threshold. Returns `{ system: this.systemPrompt,
user }`.

`LIVENESS_DEFAULT_SYSTEM_PROMPT`: instruct the LLM to produce one short
plain-prose paragraph (80-150 words, no markdown, matching the `health`
analyzer's output convention); lead with overall pipeline state; name
genuinely stale paths and flapping sources; and explicitly treat
intermittently-powered gear (engine / `propulsion.*` paths silent when the
engine is off) as expected rather than a fault.

Publishing: no `publishOutput` override. `TriggerRouter` publishes via
`deps.publisher.publishReport('liveness', ctx, text)` on the canonical report
path with `state: nominal`.

Triggers: standard contract. Default config has cron enabled (daily), put
enabled (on-demand fire), and an empty events array.

### Framework wiring

- `src/analyzers/ids.ts`: add `'liveness'` to `ANALYZER_IDS`; add
  `ANALYZER_TITLES.liveness = 'Sensor Liveness Monitor'`.
- `src/analyzers/registry.ts`: add `ANALYZER_FACTORIES.liveness` passing
  `triggers`, `stalenessThresholdSec`, `customSystemPrompt`.
- `src/types.ts`: add the `liveness` key to `PluginOptions['analyzers']`
  with its cfg shape, and a `DEFAULT_OPTIONS.analyzers.liveness` entry
  (cron daily, put enabled, events empty, `stalenessThresholdSec: 300`).
- `src/schema.ts`: rjsf sub-schema for `liveness`: the standard triggers
  block, `stalenessThresholdSec` integer, and `customSystemPrompt`,
  mirroring the `aging` / `drift` numeric-knob declarations.
- `src/core/api.ts`: add the liveness default prompt to
  `DEFAULT_SYSTEM_PROMPTS`.
- `src/index.ts`: no change expected. Instantiation is the
  `ANALYZER_IDS` + `ANALYZER_FACTORIES` loop; trigger registration is the
  config-driven lifecycle.

## Testing

New `tests/liveness.test.ts`, using the shared `_mocks.ts` harness and
`makePluginRuntime`:

- All paths fresh: no path flagged stale.
- A path whose newest sample is older than the threshold: flagged stale.
- A path key present with no retained entries: stale, `lastSeenAgeSec` null.
- A path with 2+ sources in the window: flagged flapping.
- Empty buffer: `collectContext` returns `null`.
- `buildPrompt` output shape: includes path names, ages, and the threshold.
- Threshold boundary: a path exactly at the threshold is not stale; just
  over is stale.

`tests/schema.test.ts`: assert the `liveness` sub-schema is present.

Verification: `npm run prepublishOnly` (type-check + lint + test + build)
must be clean.

## Out of scope

- No custom React panel changes.
- No CHANGELOG entry or version bump in this design; decide at
  implementation time.
- No expected-path list (a sensor that never appeared cannot be flagged).
