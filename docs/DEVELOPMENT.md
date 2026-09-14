# Development

Technical documentation for working on `signalk-openrouter-companion`. For user-facing install and configuration, see [README.md](../README.md). For contribution flow, see [CONTRIBUTING.md](../.github/CONTRIBUTING.md).

## Architecture

This repo is **one npm package**. New monitoring domains land as `Analyzer`
modules under `src/analyzers/`, not as sibling repos or sub-packages. The
shared registry keeps every analyzer inside the same plugin lifecycle,
configuration, and release unit.

### Layered structure

```text
src/
├── index.ts                  Plugin entry: lifecycle, subscriptions, PUT + REST registration
├── schema.ts                 JSON Schema storage shape and server metadata
├── types.ts                  Plugin options + DEFAULT_OPTIONS + mergeWithDefaults
├── cronPresets.ts             CRON_PRESETS: schedule-dropdown presets shared by schema + panel
├── severityFloors.ts          SEVERITY_FLOOR_PRESETS, SeverityFloor, isSeverityFloor: shared by schema + panel + forecast
├── analyzers/
│   ├── Analyzer.ts           Shared interface and AnalyzerDeps; re-exports the trigger vocabulary
│   ├── ids.ts                ANALYZER_IDS, AnalyzerId, ANALYZER_TITLES, isAnalyzerId
│   ├── registry.ts           ANALYZER_FACTORIES + ANALYZER_DEFAULT_SYSTEM_PROMPTS: per-id maps driven by ANALYZER_IDS
│   ├── maintenance.ts        State: engine-session narrative
│   ├── health.ts             State: daily battery snapshot
│   ├── alerts.ts             Transition: threshold crossings
│   ├── aging.ts              Trend: capacity loss per bank from selected history
│   ├── drift.ts              Trend: fuel-economy drift from selected history
│   ├── liveness.ts           State: stale-path and multi-source detection
│   └── forecast.ts           Trend: weather outlook from buffer + optional history
├── configpanel/
│   ├── PluginConfigurationPanel.tsx  Module Federation panel exposed as `./PluginConfigurationPanel`
│   ├── components/           Shared UI composition plus plugin-specific CSS Modules
│   └── hooks/                Config, save, model-list, and live-status state
└── core/
    ├── api.ts                REST routes registered via registerWithRouter; PluginRuntime
    ├── buffer.ts             Rolling buffer for raw delta history (in-memory)
    ├── batteryMonitor.ts     Per-bank SoC + cell-imbalance state machine
    ├── engineDetector.ts     Per-engine RPM session state machine, persisted across restarts
    ├── emitter.ts            TypedEmitter base used by batteryMonitor and engineDetector
    ├── triggerContext.ts     TriggerSpec, TriggerCtx, BatteryEventKind, PublishRunMeta: the trigger vocabulary
    ├── triggerRouter.ts      Routes cron + put + event triggers to analyzers; one run per subject
    ├── cronScheduler.ts      Wraps croner for cron-driven triggers
    ├── publisher.ts          handleMessage notification + rotating JSONL log writer; exports JsonlEntry
    ├── budget.ts             Per-day OpenRouter call cap
    ├── openrouter.ts         HTTP client with retry and backoff ladder
    ├── history.ts            Read-only history-provider contract
    ├── influxdb.ts           InfluxQL history provider
    ├── questdb.ts            QuestDB history provider and HTTP client
    ├── http.ts               fetchWithTimeout: fetch wrapper with AbortSignal-based timeout
    ├── discovery.ts          Engine and bank id discovery from SK paths
    ├── skNode.ts             readNumberAt + readValueAt + asTreeMap + readBankSnapshot
    ├── paths.ts              Notification + PUT + bank/engine path builders, parent-path constants
    ├── triggers.ts           buildTriggers(analyzerId, cfg, eventMapper?) + manualPutCtx(value?)
    ├── readings.ts           Per-source rolling map helpers: evictStale, fuseMin, fuseMax, evictStaleSpan
    ├── format.ts             fmtNumber / fmtPct / fmtUnit / fmtRatio / asFiniteNumber
    ├── cfg.ts                clamp and default helpers, resolveSystemPrompt, and the prompt sanitizers and row cap
    └── logger.ts             Wraps app.debug / app.error / stringify
```

### The Analyzer interface

```typescript
export interface Analyzer<I extends AnalysisInput = AnalysisInput> {
  readonly id: AnalyzerId;
  readonly title: string;
  readonly triggers: ReadonlyArray<TriggerSpec>;
  readonly watchedPaths?: ReadonlyArray<string>;
  readonly failureAudible?: boolean;
  runKey?(ctx: TriggerCtx): string | null;
  collectContext(ctx: TriggerCtx, deps: AnalyzerDeps): Promise<I | null>;
  buildPrompt(input: I): { system: string; user: string };
  publishOutput?(
    text: string,
    ctx: TriggerCtx,
    deps: AnalyzerDeps,
    run?: PublishRunMeta,
    input?: I,
  ): Promise<void>;
}
```

`AnalyzerId` is the string-literal union derived from `ANALYZER_IDS` in `src/analyzers/ids.ts`; a typo in a class's `readonly id` won't compile. `AnalysisInput = Record<string, unknown>` so analyzer-specific input interfaces should `extends AnalysisInput`.

`collectContext` returns `null` to mean "no report for this trigger" (e.g., engine-stop with too short a session, or a trend window without enough data). `buildPrompt` is pure: given a snapshot, it produces the prompt halves. `publishOutput` is optional: when omitted, the `TriggerRouter` publishes via `deps.publisher.publishReport(this.id, ctx, text)` on the canonical `notifications.openrouter-companion.<id>.report` path with `state: 'nominal'` (informational, no N2K alert PGN). Override only when an analyzer needs a different path or state; transition analyzers like `alerts` use `deps.publisher.publishOnPath` with a canonical per-event path (`notifications.electrical.batteries.<bankId>.<kind>`), explicit alert state, and an `alertId` from `alertIdFor(path)` so [`signalk-nmea2000-emitter-cannon`](https://github.com/NearlCrews/signalk-nmea2000-emitter-cannon) emits a stable PGN 126983 / 126985 pair.

The optional `run` argument is the `PublishRunMeta` of the completed OpenRouter call: the served model slug plus its total tokens, cached tokens, and cost. The `TriggerRouter` passes it to `publishOutput` and to the default `publishReport` path alike, and an override should forward it in the `publishOnPath` metadata so the JSONL log records which model and cost produced the text.

`runKey` is optional and names the subject one run acts on, for an analyzer whose runs are independent per subject rather than per analyzer. The `TriggerRouter` serializes its in-flight guard on the analyzer id plus this key, so `alerts` returns the bank and alert-kind pair and two banks crossing one threshold never contend, while an alert and the recovery that clears it still run in order. Return `null`, or omit the method, when one run at a time is correct for the whole analyzer.

The optional `input` argument of `publishOutput` is what `collectContext` returned for this run, so an analyzer that has to check the model's answer against the telemetry behind it reads the numbers there rather than stashing them on the instance. `forecast` uses it to weigh a graded outlook against the observed trend.

`failureAudible` is optional and defaults to silent. When true, a failed run publishes its `warn` failure notification with method `visual` and `sound`; otherwise the failure is visual only. The narrative analyzers leave it unset so a failed monthly aging summary or weather outlook never sounds the helm alarm, and `alerts` sets it true so a sustained failure to produce a battery alert still beeps.

`watchedPaths` is optional: an analyzer sets it to a fixed list of Signal K paths it needs buffered that are not discovered from the live tree (engines and battery banks are discovered; `forecast`'s weather leaves are fixed strings). The lifecycle in `index.ts` subscribes the union of `watchedPaths` across enabled analyzers, so no analyzer's data need is hardcoded by id in the lifecycle.

### One run per subject

`TriggerRouter` holds an in-flight guard so one event does not spend two budget calls and publish two reports. The key is the analyzer id plus whatever `runKey` returns for the trigger, so most analyzers serialize per analyzer and `alerts` serializes per bank and alert kind. A trigger that lands on a run already holding its key is skipped when its producer will fire again on its own, which is cron and PUT, and deferred otherwise: an event producer clears the state that raised it as it emits, so a skipped `low-soc-exit` would never come back. One deferred trigger is held per key, newest wins, and it goes through the same daily cap check as any other run, so a drain adds at most one call per run it follows. A shutdown drops the slot rather than spending on the way down.

### Standardized triggers contract

Every analyzer's config carries the same `triggers` shape:

```typescript
interface AnalyzerTriggerCfg {
  cron: { enabled: boolean; pattern: string; timezone: string };
  put:  { enabled: boolean };
  events: string[]; // per-analyzer subkind enum
}
```

Each analyzer constructor calls `buildTriggers(this.id, cfg.triggers, eventMapper?)` which returns the `TriggerSpec[]` consumed by the lifecycle in `index.ts`. The PUT path is derived from the analyzer id inside `buildTriggers`, not stored on the cfg, so it cannot drift from the convention. The lifecycle reads `analyzer.triggers` and wires cron via `CronScheduler`, PUT via `app.registerPutHandler`, and events from `EngineDetector` / `BatteryMonitor`. Adding a new trigger kind means adding a `TriggerSpec` variant in `core/triggerContext.ts`, which `Analyzer.ts` re-exports, and a dispatch arm in `TriggerRouter`. The analyzers themselves are decoupled.

The complete analyzer workflow is in [Adding a new analyzer](#adding-a-new-analyzer)
below and in [CONTRIBUTING.md](../.github/CONTRIBUTING.md).

### State vs transition vs trend

The seven analyzers are split by purpose so they don't duplicate findings:

- **State** (`maintenance`, `health`, `liveness`): describe "now". Read from the in-memory `RollingBuffer` (`maintenance` and `health` also read the live SK tree via `app.getSelfPath(...)`; `liveness` reads the buffer only). No long-term history provider.
- **Transition** (`alerts`): describe a threshold crossing. Triggered by `battery-event` subkinds from `BatteryMonitor`. Reads a one-shot snapshot.
- **Trend** (`aging`, `drift`, `forecast`): describe gradual change over a window. `aging` and `drift` read the selected QuestDB or InfluxDB provider through the shared `HistoryProvider` contract; the buffer just discovers which banks and engines exist. `forecast` is the exception: it reads weather trends straight from the `RollingBuffer` (which retains 26 hours) and treats the selected provider as an optional baseline extension, so it still produces a forecast with history disabled.

Trend analyzers request provider-neutral summaries; the QuestDB and InfluxDB implementations own their query details. State analyzers do not use long-term history, so a daily health report stays independent of the selected provider and does not duplicate the trend analyzers' findings.

### Weather Outlook Advisor

The `forecast` analyzer broadens the Companion past engine and battery telemetry: it reads how environmental conditions are changing and publishes a plain-prose short-term weather outlook. AccuWeather, as integrated by `signalk-virtual-weather-sensors`, reports current conditions only, so the prediction here is the LLM extrapolating an outlook from observed trends, anchored on the latest reading.

**Two input path families.** The analyzer is explicitly aware of two distinct families of Signal K input paths. It declares the full list via `Analyzer.watchedPaths`, and the lifecycle subscribes them unconditionally (not filtered by `app.streambundle.getAvailablePaths()`) so a producer that starts after the plugin is still captured; `collectContext` then reports whichever subset actually produced data:

- **Canonical paths** are the Signal K 1.8.2 standard leaves, provider-agnostic so a real onboard sensor or the weather plugin can feed them: `environment.outside.pressure`, `environment.outside.temperature`, `environment.outside.dewPointTemperature`, `environment.outside.relativeHumidity`, `environment.wind.speedOverGround`, `environment.wind.directionTrue`.
- **Virtual Weather Sensor extension paths** are producer-namespaced under `environment.weather.*`, emitted by `signalk-virtual-weather-sensors` (or another producer) and present only when that plugin feeds them: `environment.weather.speedGust`, `environment.weather.cloudCover`, `environment.weather.cloudCeiling`, `environment.weather.visibility`, `environment.weather.precipitationLastHour`, `environment.weather.temperatureDeparture24h`.

Both lists live as static `WEATHER_CANONICAL_PATHS` / `WEATHER_EXTENSION_PATHS` constants in `src/core/paths.ts`, and the analyzer exposes their union as its `watchedPaths` so the lifecycle subscribes them generically. Each buffered value keeps its `$source` so the prompt distinguishes an AccuWeather-sourced reading from a real onboard sensor.

**Graceful degradation.** The analyzer is source-agnostic and never hard-depends on the weather plugin. On a canonical-only feed it still produces a forecast: pressure tendency, wind veer or back, and temperature/dewpoint convergence carry the prediction. When the extension paths are also present the outlook is enriched, since a lowering cloud ceiling, collapsing visibility, precipitation onset, and the 24h temperature departure are strong leading indicators. If less than about one hour of history is buffered and no selected history-provider baseline is reachable, `collectContext` returns `null` and the tick is skipped, spending no OpenRouter call.

**Severity grading and the floor.** The model returns a machine-readable first line, `SEVERITY: severe|moderate|minor|none`, ahead of the prose paragraph. `forecast` parses and strips that line; a missing or malformed line falls back to grade `none`. The `severityFloor` config dropdown has three settings that control when the notification raises an alarm:

| Dropdown label    | Config value | Raises an alarm when the grade is |
| ----------------- | ------------ | --------------------------------- |
| Severe only       | `severe`     | `severe`                          |
| Moderate and up   | `moderate`   | `severe`, `moderate`              |
| Any deterioration | `minor`      | `severe`, `moderate`, `minor`     |

The default is `moderate`. When the grade meets or exceeds the floor the notification publishes with a mapped Signal K state: `severe` to `alarm`, `moderate` to `warn`, `minor` to `alert`. When the grade is below the floor, or is `none`, the outlook is still published with `state: nominal` so it stays readable in the Data Browser; it simply raises no alarm.

**Output path.** The outlook publishes on the single stable path `notifications.openrouter-companion.forecast.report`. It deliberately stays in the Companion namespace and does not use `notifications.environment.weather.*`: that branch belongs to `signalk-virtual-weather-sensors` for its current-condition alerts, and keeping the prediction under the Companion's own namespace keeps provenance unambiguous.

## REST API

Mounted under `/plugins/signalk-openrouter-companion/api/*` via SK's
`registerWithRouter`. All routes inherit Signal K admin authentication. If the
server cannot install the admin middleware, the plugin registers no REST routes.
History-provider tests support the local and LAN hosts commonly used onboard,
but reject redirects and never return upstream response text or credentials to
the client.

| Verb | Path | Purpose |
| ---- | ---- | ------- |
| GET | `/api/status` | Live status snapshot for the panel |
| POST | `/api/openrouter/test` | Minimal completion request to verify the saved key. The prompt asks for one word, but the request carries the same 2000-token completion bound as every other call, and a small per-call cap is not the fix: it returns an empty completion with `finish_reason` `length` on a reasoning model. It does not consume the daily budget, and is bounded instead by coalescing overlapping presses onto one upstream call and refusing a new one for five seconds after the last finishes |
| GET | `/api/openrouter/models` | Proxy to the OpenRouter models list, cached 1 h |
| POST | `/api/questdb/test` | Probe a QuestDB URL |
| POST | `/api/influxdb/test` | Probe an InfluxDB 1.x or 2.x InfluxQL endpoint |
| POST | `/api/analyzers/:id/fire` | Manually trigger an analyzer |
| GET | `/api/analyzers/:id/reports?limit=N` | Tail the JSONL log filtered by analyzer (default 10, max 100). The route reads the whole current file, which `ReportPublisher` keeps bounded by rotating `reports.jsonl` to `reports.jsonl.1` past 8 MB and keeping one generation; the archive is deliberately not read here |
| GET | `/api/analyzers/:id/prompt` | `{ default, current }` for the prompt editor |

Manual fire is also available via the standardized Signal K PUT trigger paths
(`plugins.openrouter-companion.<analyzer>.run`); the REST `fire` endpoint is a
panel convenience. PUT triggers are available to clients with Signal K write
permission and consume the shared OpenRouter budget.

Producer-controlled path identifiers, source labels, and notification text are
untrusted prompt input. Keep them bounded and on one line with
`sanitizeProducerString` before interpolating them into an analyzer prompt.

## Build

```bash
npm run build          # clean + declarations + esbuild bundle + webpack panel + panel check
npm run build:types    # scripts/tsc7.mjs --emitDeclarationOnly --declaration --outDir dist
npm run build:bundle   # node esbuild.config.mjs (backend ESM bundle)
npm run build:panel    # node scripts/build-panel.mjs (admin UI panel + build stats)
npm run check:panel    # shared consumer check (pin, version stamp, share map, size baseline) plus the ESM container and React module graph checks
npm run clean          # delete dist/ and public/ via Node fs.rmSync (cross-platform)
```

Outputs:

- `dist/index.js` (single ESM backend bundle)
- `dist/*.d.ts` (TypeScript declarations)
- `public/remoteEntry.js` plus lazy Module Federation chunks

esbuild externalizes only `@signalk/server-api`; everything else in the
backend, including `croner`, is bundled. The panel bundles the exact-pinned
`signalk-nearlcrews-ui` 0.11.1 component library and shares React 19 and React
DOM as Module Federation singletons supplied by the Signal K admin host. The
share map is read from `signalk-nearlcrews-ui/federation`, so it cannot drift
from the release the panel bundles. The shares carry no strict version check:
the Admin registers them with a version that understates the React it actually
ships, so a strict check would reject compatible hosts, and with `import: false`
the panel would never mount there. A mismatched registration warns and
continues; `hostNotes` on the same entry records the reasoning.
`PanelRoot` owns the theme tokens. A profile without a valid shared preference
starts in Auto, follows an explicit host theme, otherwise stays Light, and does
not persist an implicit choice. System follows the operating-system preference.
The retired `orc-theme` preference is intentionally ignored. The panel checks
native CSS scope support before mounting, and its responsive rules follow the
panel container rather than the browser viewport. Chromium and Edge 120 are the minimum
Chromium-family versions because the shared UI mirrors direction-sensitive
controls with `:dir()`. Plugin-specific drawer and report styles stay in CSS
Modules, which webpack's native CSS support emits as one stylesheet asset the
remote links at runtime.

The panel is built with `experiments.outputModule: true` and
`library: { type: 'module' }` because this package's `"type": "module"` makes
Signal K admin load the container as an ES module, and with
`optimization.splitChunks: false` so the panel and the bundled shared UI form
one chunk beside `remoteEntry.js`. `npm run check:panel` runs the library's
`snui-check-consumer`, which asserts the exact pin against the installed
version, the bundled version stamp, the absence of a React runtime, the
published share map in both the remote and the webpack configuration, and the
gzip size against `scripts/panel-size-baseline.json`; the local
`check-panel-bundle.mjs` then asserts the container is a real ES module and
that the only React module in the graph is the JSX runtime.

## Tests

```bash
npm run test           # vitest run, one-shot
npm run test:watch     # vitest, watch mode
npm run test:coverage  # vitest run --coverage
npm run test:browser   # current production remote build in Chromium
npm run test:browser:cross # desktop and mobile Chromium, Firefox, and WebKit
npm run test:browser:with-build # build, then run Chromium
npm run test:browser:cross:with-build # build, then run every browser project
npm run test:host-asset # running Signal K Admin requests the installed remote
npm run test:integration # unsecured CI server loads the plugin and configurator remote
```

The browser fixture uses port 4174 by default. Set `ORC_BROWSER_PORT` to an
unused local port when another development server is already using it.
`npm run screenshots` captures the declared App Store screenshots at 1280 by
800 pixels, and `npm run package:check` rejects stale dimensions.

The tarball ships one icon, `assets/icons/icon-192.png`, because
`signalk.appIcon` is the only icon reference any consumer reads: the App Store
has no size ladder to pick from and this package ships no web manifest. The
`files` entry names that one path rather than the whole directory, so the rest
of `assets/icons/` (the 72, 96, and 512 pixel renders and `icon.svg`, the
vector master they come from) stays in the repository for regenerating the
192 pixel PNG without adding 36 kB to every install.

`test:integration` targets the unsecured temporary server used by plugin-ci. On
a secured, installed server, use `test:host-asset` to verify the public Admin UI
and configurator asset without requesting authenticated plugin metadata.

The unit and integration suite covers:

- Each analyzer's triggers, `collectContext` null paths, happy path, and `buildPrompt` (including `customSystemPrompt` overrides).
- Shared infra: buffer eviction (age + amortized count), battery monitor state machine, engine detector state machine, trigger router dispatch, cron scheduler, publisher (delta shape + JSONL append), and both history providers (probe, query, decode, and error paths).
- `tests/api.test.ts` covers all eight REST route families: registration, status payload shape, OpenRouter test (happy/401), fire (404/503/409/500/happy), reports (clamp, filter, missing log), prompt (default/override), models (cache/upstream errors), QuestDB test, and InfluxDB test.
- `tests/integration.test.ts` exercises the plugin end-to-end with a mocked SK server and `vi.stubGlobal('fetch')` for OpenRouter.
- `tests/panelStyles.test.ts` walks the panel sources for CSS Modules classes that land on a shared UI component and requires each one to repeat its own name. The library ships its rules inside a native CSS scope, so at equal specificity the scoped rule wins whatever the stylesheet order and a single-class override would be dropped without a warning.

The shared test mocks live in `tests/_mocks.ts`:

- `makeMockApp(dir)`: builds a `MockApp` implementing the subset of `ServerApiLike` the plugin touches.
- `makeAnalyzerDeps(app, buffer, opts?)`: canonical factory for `AnalyzerDeps`. Pass `{ questdb }` and `{ publisher }` only when the test needs them.
- `makeQuestDBStub(dispatch)`: injects a typed stub matching the `QuestDBClient.query` surface. Trend-analyzer tests use it instead of stubbing global `fetch`, which is process-wide and races with parallel test workers.
- `makePluginRuntime(opts?)`: builds a `PluginRuntime` literal with sane defaults from `DEFAULT_OPTIONS`. Use this for any new test that registers REST routes; never hand-roll the cfg/llm/budget/etc. boilerplate.

## Lint and type-check

```bash
npm run lint           # code, documentation, and spelling checks
npm run lint:fix       # safe Biome and ESLint code fixes
npm run format         # format supported repository files with Biome
npm run format:check   # verify formatting without writes
npm run cruise         # dependency boundaries and circular imports, type edges included
npm run deadcode       # unused files, exports, and dependencies
npm run type-check     # backend, tests, panel, and tooling configs
```

`cruise` runs with `tsPreCompilationDeps: true`, so `import type` and inline
`import('...')` type references count as edges. dependency-cruiser drops them by
default because they erase at compile time, which here hid roughly 30 percent of
the graph: the two boundary rules would have passed a type-only import from the
panel into `src/core/`, and a type-only cycle between the analyzer contract and
the publisher went unreported. A type-only cycle is harmless at runtime but it
still signals a layering problem, so `no-circular` stays at `severity: 'error'`
for every edge rather than exempting type ones.

Biome owns formatting and its recommended lint rules. ESLint adds typed promise
checks and React Hooks rules. The documentation gate uses exact-pinned
markdownlint-cli2 0.23.2, cspell 10.3.0, and Linkinator 8.1.0. Local files and
fragments block the commit gate. External links run in a scheduled workflow
with bounded concurrency, retries, and rate-limit warnings because remote rate
limits and bot protection make them unsuitable for the merge gate. The repo
follows strict-mode TypeScript with no implicit `any` and no unchecked indexed
access. The `type-check` script covers `src/`, tests, the config panel,
Playwright, Vite, and browser fixtures through four TypeScript configurations,
and `type-check:ts6` repeats them under the TypeScript 6 compiler API.

### TypeScript toolchain

Two TypeScript compilers are installed on purpose, through npm aliases in
`devDependencies`:

- `@typescript/native` is the real `typescript` package at 7.x. `npm run
  build:types` and `npm run type-check` run its compiler by path through
  `scripts/tsc7.mjs`. Both aliases declare a `tsc` binary and npm links
  `node_modules/.bin/tsc` to whichever it installed last, so a bare `tsc` call
  could silently compile with TypeScript 6 after a fresh install; never call
  bare `tsc` from a script.
- `typescript` is aliased to `@typescript/typescript6`, which provides the
  TypeScript 6 JavaScript compiler API plus a `tsc6` binary.

The alias exists because tools that import the compiler API, most importantly
typescript-eslint, do not yet run under TypeScript 7. Resolving the bare
`typescript` specifier to the TypeScript 6 API keeps type-aware linting, Knip,
and dependency-cruiser working while builds use the native compiler. Because
lint rules evaluate under TypeScript 6 while the build evaluates under
TypeScript 7, `npm run check` runs both `type-check` and `type-check:ts6`.
Dependabot does not bump npm-alias ranges, so the two entries need a manual
check with `npm outdated`. Collapse back to a single `typescript` dependency
once typescript-eslint supports TypeScript 7, and confirm the emitted
declarations in `dist/` are unchanged across that collapse.

### Dependency pins that need a manual step

- `@types/react` and `@types/react-dom` are pinned exactly, the way `react` and
  `react-dom` are. With carets they resolve ahead of the runtime on the next
  install, and typing the panel against a React minor it does not bundle is the
  kind of skew that type-checks locally and misbehaves in the admin host. Bump
  all four together.
- `allowScripts` in `package.json` records the one dependency with an install
  script, `esbuild`, pinned to the exact version reviewed. npm treats the field
  as advisory today and will block unreviewed install scripts in a future
  release, so **every esbuild bump needs `npm run approve-scripts` in the same
  commit**; `npm run approve-scripts:check` reports nothing outstanding when the
  entry is current. Dependabot bumps `devDependencies` and
  never touches `allowScripts`, so a bump PR that skips this step installs with
  an unreviewed-install-script warning.
- The `overrides` block carries `smol-toml` alone, and it is load-bearing:
  `markdownlint-cli2` pins `smol-toml` to exactly 1.7.0 while `knip` and
  `cspell-config-lib` take `^1.8.0`, so without it npm nests a second,
  vulnerable copy. Do not add an override for a version a dependency already
  declares: it is a no-op that silently holds the next upgrade back.

## Verification gates

```bash
npm run verify:commit  # formatting, lint, boundaries, and dead code
npm run check:links:local # deterministic local files and Markdown fragments
npm run check:links:external # networked external-link maintenance check
npm run ci:workflows   # action pins and release-workflow invariants
npm run verify:fast    # commit gate plus all type checks
npm run verify         # fast gate, coverage, production build, and size budgets
npm run verify:browser # full local gate plus Chromium
npm run verify:release # cross-browser, package, and dependency audit checks
```

Run `npm run hooks` once to activate the Binnacle-style repository hooks. The
commit hook runs `verify:commit`, and the push hook runs `verify:browser`.
`prepublishOnly` and the release workflow both run `verify:release` before npm
can publish an artifact.

The panel's size gate lives in `scripts/panel-size-baseline.json`, read by
`snui-check-consumer` during `npm run check:panel`: the baseline records the
panel's JavaScript and CSS assets in gzip bytes at level 9, the way the check
measures them, and the check allows 5 percent growth over it. Re-record the
baseline when a library upgrade legitimately grows the panel, as the move to
shared UI 0.11.1 did, so the gate keeps catching unexpected growth instead of
sitting near its ceiling. Raise `gzipBytes` to the new measurement, or add
`approvedCeilingGzipBytes` with the reason, rather than loosening the
percentage. `npm run size` keeps the
separate 60 kB budget on the backend bundle. Per-release byte attribution
belongs in the changelog rather than here.

## Local development against a real Signal K server

The plugin is designed to be symlinked into `~/.signalk/node_modules/signalk-openrouter-companion` and run against a local SK server at port 3000:

```bash
ln -s "$(pwd)" ~/.signalk/node_modules/signalk-openrouter-companion
npm run build
sudo systemctl restart signalk.service
```

After each code change, `npm run build && sudo systemctl restart signalk.service` rebuilds and reloads. `tsx watch` (`npm run dev`) works for tighter iteration but doesn't produce the `dist/` bundle the SK server actually loads, so save it for unit-level testing. Note: `dist/index.js` MUST finish writing before SK restarts, otherwise SK loads the old code and any new `registerWithRouter` routes return 404.

For panel-only iteration: `npm run build:panel && sudo systemctl restart signalk.service` (panel changes do not require the backend to rebuild). After the restart, hard-refresh the admin tab so the browser drops the cached `remoteEntry.js`.

Run `npm run test:host-asset` after the restart to verify that Signal K Admin
discovers and requests this plugin's production Module Federation asset. This
is an asset-registration smoke test, not an authenticated configuration-page
test. The production browser fixture separately initializes and mounts the
container. Set `SIGNALK_URL` when the test server is not on
`http://127.0.0.1:3000`.

To inspect the served plugin schema:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/signalk/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$SK_USER\",\"password\":\"$SK_PASS\"}" | jq -r .token)
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/skServer/plugins \
  | jq '.[] | select(.id == "signalk-openrouter-companion")'
```

Credentials must come from environment variables; do not hardcode.

## Conventions

- **No em dashes** in code, commits, PR descriptions, or docs. Use a colon, a comma, or split sentences. This applies to all committed project text.
- **Default to no comments.** Add a comment only when it captures non-obvious WHY: a hidden constraint, a subtle invariant, a workaround. Skip WHAT-comments (the code says what) and change-narrative comments (the PR description says why).
- **Trust internal callers.** Only validate at system boundaries (user input, external APIs). Don't add `Number.isFinite` checks against your own helpers; let the type system carry that.
- **Notification paths**: `notifications.openrouter-companion.<analyzer>.<...>`. Use `notificationReportPath(id)` from `core/paths.ts`.
- **PUT paths**: `plugins.openrouter-companion.<analyzer>.run` (the verb is fixed at `run`). Use `pluginPutPath(id)` from `core/paths.ts`.
- **All numbers in SI base units** unless the SK spec dictates otherwise: voltage in V, current in A, temperature in K, capacity in J, SoC as a 0-1 ratio, RPM as Hz (1 Hz = 60 RPM, per SK v1.8.2 vocabulary for `propulsion.*.revolutions`). Do NOT convert RPM to rad/s; the SK spec uses Hz for this path.

## Adding a new analyzer

Step by step:

1. Decide whether it is **state**, **transition**, or **trend**. State/trend use the shared `publishReport` shorthand (defaults to `state: nominal`, `method: ['visual']`, no N2K alert PGN). Transition wants a custom path like `alerts` uses for `notifications.electrical.batteries.<bankId>.<kind>` with `state: alert`/`normal` and an `alertId` from `alertIdFor(path)`.

2. Add the new id and title to `src/analyzers/ids.ts`. Append to `ANALYZER_IDS` (which auto-extends the `AnalyzerId` union) and add the title to `ANALYZER_TITLES`. This is the single source of truth; api.ts, the registry, and the panel all read it.

3. Create `src/analyzers/<name>.ts` implementing `Analyzer<I>`:

   ```typescript
   import { resolveSystemPrompt } from '../core/cfg.js';
   import { ANALYZER_TITLES } from './ids.js';

   export const MYNAME_DEFAULT_SYSTEM_PROMPT = '...';

   export class MyAnalyzer implements Analyzer<MyInput> {
     readonly id = 'myname';
     readonly title = ANALYZER_TITLES.myname;
     readonly triggers: ReadonlyArray<TriggerSpec>;
     private readonly systemPrompt: string;
     constructor(cfg: MyCfg) {
       this.triggers = buildTriggers(this.id, cfg.triggers);
       this.systemPrompt = resolveSystemPrompt(cfg.customSystemPrompt, MYNAME_DEFAULT_SYSTEM_PROMPT);
     }
     async collectContext(ctx, deps) { /* ... return MyInput | null */ }
     buildPrompt(input) { return { system: this.systemPrompt, user: ... }; }
   }
   ```

4. Add the analyzer to `src/analyzers/registry.ts::ANALYZER_FACTORIES`. The factory closure forwards the cfg sub-object fields the constructor wants. `index.ts` iterates `ANALYZER_IDS` and instantiates via this map; no extra wiring in `index.ts` is needed unless the analyzer introduces a brand-new event source (like `EngineDetector` or `BatteryMonitor`).

5. Register the default prompt in `src/analyzers/registry.ts::ANALYZER_DEFAULT_SYSTEM_PROMPTS` (next to the factory map) so `GET /api/analyzers/:id/prompt` can serve it.

6. Add the config block (including `customSystemPrompt?: string`) to `src/types.ts::PluginOptions['analyzers']` and `DEFAULT_OPTIONS`. Use `pluginPutPath('myname')` for the default PUT path.

7. Add the schema section in `src/schema.ts` (a per-analyzer `type: 'object'` with `enabled` and a nested `triggers` block). The schema remains the storage shape and server-facing configuration metadata. Signal K Admin uses the custom configurator exclusively when the plugin declares one.

8. Add tests under `tests/myname.test.ts` using `makeAnalyzerDeps` (and `makeQuestDBStub` for trend analyzers) from `tests/_mocks.ts`. If your test needs a `PluginRuntime` literal, use `makePluginRuntime`.

9. Document the analyzer in `README.md` (the Analyzers section) and `CHANGELOG.md`.

## CI

GitHub Actions workflows under `.github/workflows/`:

- `plugin-ci.yml`: reuses the upstream Signal K plugin workflow on Node 22, 24,
  and 26 across Linux x64, Linux arm64, macOS, and Windows. The Node 20 armv7
  lane is disabled because the package now requires Node 22.18 or newer. Its
  real Signal K server integration lane installs and starts the packed plugin
  on both Signal K 2.25.0 and the latest server release.
- `ci.yml`: runs the full release gate on Node 26 with npm 11.18.0, including
  Chromium, Firefox, WebKit, package validation, and full and runtime audits.
- `codeql.yml`: CodeQL static analysis.
- `workflow-security.yml`: pinned actionlint and zizmor checks.
- `publish.yml`: writes the release commit to the package's `gitHead`, verifies
  that exact manifest and code, packs it once, checks the tarball commit
  metadata, and publishes the verified artifact when a non-prerelease GitHub
  release is published.

The validation workflows run on pushes and pull requests to `main`, and CodeQL
also runs weekly. Publishing runs only for a published, non-prerelease GitHub
release.

## Tech stack

- TypeScript 7 strict (the native compiler, for builds and type checks) with
  the TypeScript 6 compiler API alongside for lint tooling, ESM, ES2022 target
- Node 22.22.2+, Node 24.15+, or Node 26 with npm 11.18.0 for development.
  The published plugin remains compatible with Node 22.18 or newer. The
  manifest accepts npm 10.9.3 only so the upstream Node 22 plugin workflow can
  bootstrap the project.
- `@signalk/server-api` 2.32 types with a `>=2.24.0 <3` runtime peer range. The
  separate Signal K server floor is 2.25.0 because that release added the ESM
  configurator loader while still shipping server API 2.24.
- `croner` 10 (only runtime dep)
- esbuild 0.28 (backend bundle)
- Webpack 5 with native CSS Modules, esbuild-loader 4, React 19, React DOM
  19, and `signalk-nearlcrews-ui` 0.11.1
- Biome 2.5, ESLint 10, dependency-cruiser 18, and Knip 6
- Vitest 5 with v8 coverage and Playwright cross-browser checks

## Third-party notices

The configuration panel is a Module Federation remote, so its dependency tree
is bundled into `public/*.mjs`, and esbuild inlines every runtime dependency
into `dist/index.js`. The published package therefore redistributes both trees:
MIT requires the copyright and permission notice to travel with a copy, and
Apache-2.0 section 4(a) requires giving recipients the license. Terser's
sidecar extracts only comments marked `@license` or `@preserve`, which here
covers the React JSX runtime alone, so it discharges neither obligation.

`THIRD_PARTY_NOTICES.md` is therefore GENERATED, not hand-maintained. Run
`npm run licenses` after any change to either bundle's dependency tree, and
`npm run package:check` re-verifies the committed copy with `--check`: it
fails when the file is missing, was generated for a different shared UI
version, names a package that is no longer installed, no longer matches a
package's declared license, or omits a runtime dependency that reaches
`dist/index.js`.

The panel package list comes from the webpack statistics the panel build
already writes to `.tmp/panel-stats.json`, walked recursively. The recursion is
load-bearing: module concatenation nests the interesting records under a parent
module and reports an empty chunk list for them, so a shallow read, or a read
that filters on chunk membership, reports neither `react-aria` nor anything
else reached through the shared UI. `react-aria` is bundled by every panel that
renders `PanelRoot`, because `PanelRoot` installs React Aria's portal provider,
whether or not the panel imports a focused entry point.

## License

Apache-2.0. Copyright 2026 Nearl Crews. See [LICENSE](../LICENSE) and
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
