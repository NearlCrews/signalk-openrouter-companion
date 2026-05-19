# Development

Technical documentation for working on `signalk-openrouter-companion`. For user-facing install and configuration, see [README.md](../README.md). For contribution flow, see [CONTRIBUTING.md](../.github/CONTRIBUTING.md).

## Architecture

This repo is **one npm package**. New monitoring domains land as `Analyzer` modules under `src/analyzers/`, not as sibling repos or sub-packages. A previous session mistakenly created a sibling repo and had to consolidate; that mistake is documented in [CLAUDE.md](../CLAUDE.md) and [CHANGELOG.md](../CHANGELOG.md) under 0.2.0.

### Layered structure

```
src/
├── index.ts                  Plugin entry: lifecycle, subscriptions, PUT + REST registration
├── schema.ts                 rjsf JSON Schema (storage shape; fallback admin UI)
├── types.ts                  Plugin options + DEFAULT_OPTIONS + mergeWithDefaults
├── cronPresets.ts             CRON_PRESETS: schedule-dropdown presets shared by schema + panel
├── analyzers/
│   ├── Analyzer.ts           Shared interface, TriggerSpec union, AnalyzerDeps
│   ├── ids.ts                ANALYZER_IDS, AnalyzerId, ANALYZER_TITLES, isAnalyzerId
│   ├── registry.ts           ANALYZER_FACTORIES: per-id constructor map driven by ANALYZER_IDS
│   ├── maintenance.ts        State: engine-session narrative
│   ├── health.ts             State: daily battery snapshot
│   ├── alerts.ts             Transition: threshold crossings
│   ├── aging.ts              Trend: capacity loss per bank from QuestDB
│   ├── drift.ts              Trend: fuel-economy drift per RPM bin from QuestDB
│   ├── liveness.ts           State: stale-path and multi-source detection
│   └── forecast.ts           Trend: short-term weather outlook from buffer + optional QuestDB
├── configpanel/
│   ├── index.js              Module Federation entry stub (Webpack emits remoteEntry around this)
│   └── PluginConfigurationPanel.jsx  React 19 panel exposed as `./PluginConfigurationPanel`
└── core/
    ├── api.ts                REST routes registered via registerWithRouter; PluginRuntime; DEFAULT_SYSTEM_PROMPTS
    ├── buffer.ts             Rolling buffer for raw delta history (in-memory)
    ├── batteryMonitor.ts     Per-bank SoC + cell-imbalance state machine
    ├── engineDetector.ts     Per-engine RPM session state machine, persisted across restarts
    ├── emitter.ts            TypedEmitter base used by batteryMonitor and engineDetector
    ├── triggerRouter.ts      Routes cron + put + event triggers to analyzers
    ├── cronScheduler.ts      Wraps croner for cron-driven triggers
    ├── publisher.ts          handleMessage notification + JSONL log writer; exports JsonlEntry
    ├── budget.ts             Per-day OpenRouter call cap
    ├── openrouter.ts         HTTP client with retry and backoff ladder
    ├── questdb.ts            HTTP client + escapeSqlLiteral + indexColumns
    ├── discovery.ts          Engine and bank id discovery from SK paths
    ├── skNode.ts             readNumberAt + readValueAt + asTreeMap + readBankSnapshot
    ├── paths.ts              Notification + PUT + bank/engine path builders, parent-path constants
    ├── triggers.ts           buildTriggers(cfg, eventMapper?) + manualPutCtx(value?)
    ├── format.ts             fmtNumber / fmtPct / fmtUnit / fmtRatio / asFiniteNumber
    ├── cfg.ts                clampPositiveInt + resolveSystemPrompt
    └── logger.ts             Wraps app.debug / app.error / stringify
```

### The Analyzer interface

```typescript
export interface Analyzer<I extends AnalysisInput = AnalysisInput> {
  readonly id: AnalyzerId;
  readonly title: string;
  readonly triggers: ReadonlyArray<TriggerSpec>;
  collectContext(ctx: TriggerCtx, deps: AnalyzerDeps): Promise<I | null>;
  buildPrompt(input: I): { system: string; user: string };
  publishOutput?(text: string, ctx: TriggerCtx, deps: AnalyzerDeps): Promise<void>;
}
```

`AnalyzerId` is the string-literal union derived from `ANALYZER_IDS` in `src/analyzers/ids.ts`; a typo in a class's `readonly id` won't compile. `AnalysisInput = Record<string, unknown>` so analyzer-specific input interfaces should `extends AnalysisInput`.

`collectContext` returns `null` to mean "no report for this trigger" (e.g., engine-stop with too short a session, or a trend window without enough data). `buildPrompt` is pure: given a snapshot, it produces the prompt halves. `publishOutput` is optional: when omitted, the `TriggerRouter` publishes via `deps.publisher.publishReport(this.id, ctx, text)` on the canonical `notifications.openrouter-companion.<id>.report` path with `state: 'nominal'` (informational, no N2K alert PGN). Override only when an analyzer needs a different path or state; transition analyzers like `alerts` use `deps.publisher.publishOnPath` with a canonical per-event path (`notifications.electrical.batteries.<bankId>.<kind>`), explicit alert state, and an `alertId` from `alertIdFor(path)` so [`signalk-nmea2000-emitter-cannon`](https://github.com/NearlCrews/signalk-nmea2000-emitter-cannon) emits a stable PGN 126983 / 126985 pair.

### Standardized triggers contract

Every analyzer's config carries the same `triggers` shape:

```typescript
interface AnalyzerTriggerCfg {
  cron: { enabled: boolean; pattern: string; timezone: string };
  put:  { enabled: boolean; path: string };
  events: string[]; // per-analyzer subkind enum
}
```

Each analyzer constructor calls `buildTriggers(cfg.triggers, eventMapper?)` which returns the `TriggerSpec[]` consumed by the lifecycle in `index.ts`. The lifecycle reads `analyzer.triggers` and wires cron via `CronScheduler`, PUT via `app.registerPutHandler`, and events from `EngineDetector` / `BatteryMonitor`. Adding a new trigger kind means adding a `TriggerSpec` variant in `Analyzer.ts` and a dispatch arm in `TriggerRouter`. The analyzers themselves are decoupled.

Full rules for adding a new analyzer live in [CLAUDE.md](../CLAUDE.md) and the project's memory at `~/.claude/projects/-home-dietpi-src-signalk-openrouter-companion/memory/triggers_contract.md`.

### State vs transition vs trend

The seven analyzers are split by purpose so they don't duplicate findings:

- **State** (`maintenance`, `health`, `liveness`): describe "now". Read from the in-memory `RollingBuffer` (`maintenance` and `health` also read the live SK tree via `app.getSelfPath(...)`; `liveness` reads the buffer only). No QuestDB.
- **Transition** (`alerts`): describe a threshold crossing. Triggered by `battery-event` subkinds from `BatteryMonitor`. Reads a one-shot snapshot.
- **Trend** (`aging`, `drift`, `forecast`): describe gradual change over a window. `aging` and `drift` read history only from QuestDB; the buffer just discovers which banks and engines exist. `forecast` is the exception: it reads weather trends straight from the `RollingBuffer` (which retains ~24h) and treats QuestDB as an optional baseline extension, so it still produces a forecast with no QuestDB configured.

Trend analyzers own QuestDB queries; state analyzers don't, so a daily health report stays independent of long-term history and won't duplicate the trend analyzers' findings.

### Weather Outlook Advisor

The `forecast` analyzer broadens the Companion past engine and battery telemetry: it reads how environmental conditions are changing and publishes a plain-prose short-term weather outlook. AccuWeather, as integrated by `signalk-virtual-weather-sensors`, reports current conditions only, so the prediction here is the LLM extrapolating an outlook from observed trends, anchored on the latest reading.

**Two input path families.** The analyzer is explicitly aware of two distinct families of Signal K input paths, and subscribes whatever subset `app.streambundle.getAvailablePaths()` reports as present:

- **Canonical paths** are the Signal K 1.8.2 standard leaves, provider-agnostic so a real onboard sensor or the weather plugin can feed them: `environment.outside.pressure`, `environment.outside.temperature`, `environment.outside.dewPointTemperature`, `environment.outside.relativeHumidity`, `environment.wind.speedOverGround`, `environment.wind.directionTrue`.
- **Virtual Weather Sensor extension paths** are producer-namespaced under `environment.weather.*`, emitted by `signalk-virtual-weather-sensors` (or another producer) and present only when that plugin feeds them: `environment.weather.speedGust`, `environment.weather.cloudCover`, `environment.weather.cloudCeiling`, `environment.weather.visibility`, `environment.weather.precipitationLastHour`, `environment.weather.temperatureDeparture24h`.

Both lists live as static `WEATHER_CANONICAL_PATHS` / `WEATHER_EXTENSION_PATHS` constants in `src/core/paths.ts`. Each buffered value keeps its `$source` so the prompt distinguishes an AccuWeather-sourced reading from a real onboard sensor.

**Graceful degradation.** The analyzer is source-agnostic and never hard-depends on the weather plugin. On a canonical-only feed it still produces a forecast: pressure tendency, wind veer or back, and temperature/dewpoint convergence carry the prediction. When the extension paths are also present the outlook is enriched, since a lowering cloud ceiling, collapsing visibility, precipitation onset, and the 24h temperature departure are strong leading indicators. If less than ~1h of history is buffered and no QuestDB baseline is reachable, `collectContext` returns `null` and the tick is skipped, spending no OpenRouter call.

**Severity grading and the floor.** The model returns a machine-readable first line, `SEVERITY: severe|moderate|minor|none`, ahead of the prose paragraph. `forecast` parses and strips that line; a missing or malformed line falls back to grade `none`. The `severityFloor` config dropdown has three settings that control when the notification raises an alarm:

| Dropdown label    | Config value | Raises an alarm when the grade is |
| ----------------- | ------------ | --------------------------------- |
| Severe only       | `severe`     | `severe`                          |
| Moderate and up   | `moderate`   | `severe`, `moderate`              |
| Any deterioration | `minor`      | `severe`, `moderate`, `minor`     |

The default is `moderate`. When the grade meets or exceeds the floor the notification publishes with a mapped Signal K state: `severe` to `alarm`, `moderate` to `warn`, `minor` to `alert`. When the grade is below the floor, or is `none`, the outlook is still published with `state: nominal` so it stays readable in the Data Browser; it simply raises no alarm.

**Output path.** The outlook publishes on the single stable path `notifications.openrouter-companion.forecast.report`. It deliberately stays in the Companion namespace and does not use `notifications.environment.weather.*`: that branch belongs to `signalk-virtual-weather-sensors` for its current-condition alerts, and keeping the prediction under the Companion's own namespace keeps provenance unambiguous.

## REST API

Mounted under `/plugins/signalk-openrouter-companion/api/*` via SK's `registerWithRouter`. All routes inherit SK admin authentication.

| Verb | Path | Purpose |
| ---- | ---- | ------- |
| GET  | `/api/status` | Live status snapshot for the panel |
| POST | `/api/openrouter/test` | One-token ping with the saved key |
| GET  | `/api/openrouter/models` | Proxy to the OpenRouter models list, cached 1 h |
| POST | `/api/questdb/test` | Probe a QuestDB URL |
| POST | `/api/analyzers/:id/fire` | Manually trigger an analyzer |
| GET  | `/api/analyzers/:id/reports?limit=N` | Tail the JSONL log filtered by analyzer (default 10, max 100) |
| GET  | `/api/analyzers/:id/prompt` | `{ default, current }` for the prompt editor |

Manual fire is also available via the standardized SK PUT trigger paths (`plugins.openrouter-companion.<analyzer>.run`); the REST `fire` endpoint is a panel convenience.

## Build

```bash
npm run build          # clean + tsc -d + esbuild bundle + webpack panel
npm run build:types    # tsc --emitDeclarationOnly --declaration --outDir dist
npm run build:bundle   # node esbuild.config.mjs (backend ESM bundle)
npm run build:panel    # webpack --config webpack.config.cjs (admin UI panel)
npm run clean          # rm -rf dist public
```

Outputs:

- `dist/index.js` (single ESM backend bundle, ~138 KB)
- `dist/*.d.ts` (TypeScript declarations)
- `public/remoteEntry.js` + lazy chunks (Webpack Module Federation panel, ~18 KB total)

esbuild externalizes `@signalk/server-api` and `croner`; everything else in the backend is bundled. The panel bundle shares `react` 19 as a Module Federation `singleton: true` so it reuses the SK admin UI's React runtime. The panel is built with `experiments.outputModule: true` and `library: { type: 'module' }` because this package's `"type": "module"` makes SK admin inject `<script type="module">`; legacy `library: 'var'` doesn't work under that loader.

## Tests

```bash
npm run test           # vitest run, one-shot
npm run test:watch     # vitest, watch mode
npm run test:coverage  # vitest run --coverage
```

235 tests across 21 files cover:

- Each analyzer's triggers, `collectContext` null paths, happy path, and `buildPrompt` (including `customSystemPrompt` overrides).
- Shared infra: buffer eviction (age + amortized count), battery monitor state machine, engine detector state machine, trigger router dispatch, cron scheduler, publisher (delta shape + JSONL append), QuestDB client (probe + query + error paths).
- `tests/api.test.ts` covers all seven REST endpoints: registration, status payload shape, OpenRouter test (happy/401), fire (404/503/409/500/happy), reports (clamp, filter, missing log), prompt (default/override), models (cache/upstream errors), questdb test (URL override/probe).
- `tests/integration.test.ts` exercises the plugin end-to-end with a mocked SK server and `vi.stubGlobal('fetch')` for OpenRouter.

The shared test mocks live in `tests/_mocks.ts`:

- `makeMockApp(dir)`: builds a `MockApp` implementing the subset of `ServerApiLike` the plugin touches.
- `makeAnalyzerDeps(app, buffer, opts?)`: canonical factory for `AnalyzerDeps`. Pass `{ questdb }` and `{ publisher }` only when the test needs them.
- `makeQuestDBStub(dispatch)`: injects a typed stub matching the `QuestDBClient.query` surface. Trend-analyzer tests use it instead of stubbing global `fetch`, which is process-wide and races with parallel test workers.
- `makePluginRuntime(opts?)`: builds a `PluginRuntime` literal with sane defaults from `DEFAULT_OPTIONS`. Use this for any new test that registers REST routes; never hand-roll the cfg/llm/budget/etc. boilerplate.

## Lint and type-check

```bash
npm run lint           # biome check src/ tests/
npm run lint:fix       # biome check --write src/ tests/
npm run format         # biome format --write src/ tests/
npm run type-check     # tsc --noEmit
```

Biome is the source of truth for style. The repo follows strict mode TypeScript with no implicit `any`, no unchecked indexed access, and `exactOptionalPropertyTypes`.

## Pre-publish gate

```bash
npm run prepublishOnly # type-check + lint + test + build
```

This is the gate before any push or publish. It must be clean. If lint emits warnings (e.g., the few existing non-null assertions in tests), that's fine; only errors fail the gate.

## Local development against a real Signal K server

The plugin is designed to be symlinked into `~/.signalk/node_modules/signalk-openrouter-companion` and run against a local SK server at port 3000:

```bash
ln -s "$(pwd)" ~/.signalk/node_modules/signalk-openrouter-companion
npm run build
sudo systemctl restart signalk.service
```

After each code change, `npm run build && sudo systemctl restart signalk.service` rebuilds and reloads. `tsx watch` (`npm run dev`) works for tighter iteration but doesn't produce the `dist/` bundle the SK server actually loads, so save it for unit-level testing. Note: `dist/index.js` MUST finish writing before SK restarts, otherwise SK loads the old code and any new `registerWithRouter` routes return 404.

For panel-only iteration: `npm run build:panel && sudo systemctl restart signalk.service` (panel changes do not require the backend to rebuild). After the restart, hard-refresh the admin tab so the browser drops the cached `remoteEntry.js`.

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

- **No em dashes** in code, commits, PR descriptions, or docs. Use a colon, a comma, or split sentences. This applies to text written by both humans and AI assistants on the project.
- **Default to no comments.** Add a comment only when it captures non-obvious WHY: a hidden constraint, a subtle invariant, a workaround. Skip WHAT-comments (the code says what) and change-narrative comments (the PR description says why).
- **Trust internal callers.** Only validate at system boundaries (user input, external APIs). Don't add `Number.isFinite` checks against your own helpers; let the type system carry that.
- **Notification paths**: `notifications.openrouter-companion.<analyzer>.<...>`. Use `notificationReportPath(id)` from `core/paths.ts`.
- **PUT paths**: `plugins.openrouter-companion.<analyzer>.<verb>`. Use `pluginPutPath(id, verb)` from `core/paths.ts`.
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
       this.triggers = buildTriggers(cfg.triggers);
       this.systemPrompt = resolveSystemPrompt(cfg.customSystemPrompt, MYNAME_DEFAULT_SYSTEM_PROMPT);
     }
     async collectContext(ctx, deps) { /* ... return MyInput | null */ }
     buildPrompt(input) { return { system: this.systemPrompt, user: ... }; }
   }
   ```

4. Add the analyzer to `src/analyzers/registry.ts::ANALYZER_FACTORIES`. The factory closure forwards the cfg sub-object fields the constructor wants. `index.ts` iterates `ANALYZER_IDS` and instantiates via this map; no extra wiring in `index.ts` is needed unless the analyzer introduces a brand-new event source (like `EngineDetector` or `BatteryMonitor`).

5. Register the default prompt in `src/core/api.ts::DEFAULT_SYSTEM_PROMPTS` so `GET /api/analyzers/:id/prompt` can serve it.

6. Add the config block (including `customSystemPrompt?: string`) to `src/types.ts::PluginOptions['analyzers']` and `DEFAULT_OPTIONS`. Use `pluginPutPath('myname')` for the default PUT path.

7. Add the schema section in `src/schema.ts` (a per-analyzer `type: 'object'` with `enabled` and a nested `triggers` block). The schema is the storage shape and drives the rjsf fallback admin UI.

8. Add tests under `tests/myname.test.ts` using `makeAnalyzerDeps` (and `makeQuestDBStub` for trend analyzers) from `tests/_mocks.ts`. If your test needs a `PluginRuntime` literal, use `makePluginRuntime`.

9. Document the analyzer in `README.md` (the Analyzers section) and `CHANGELOG.md`.

## CI

GitHub Actions workflows under `.github/workflows/`:

- `plugin-ci.yml`: reuses the upstream SK plugin CI workflow (type-check + lint + build).
- `ci.yml`: lint, type-check, vitest with coverage, and build on Node 20.x and 22.x.
- `codeql.yml`: CodeQL static analysis.
- `publish.yml`: npm publish, triggered when a GitHub release is published.

All run on push and pull_request to `main`.

## Tech stack

- TypeScript 6 strict, ESM, ES2022 target
- Node 20.18+ (specified in `package.json#engines`; CI tests on Node 20 and 22)
- `@signalk/server-api` 2.24+ (peer dep)
- `croner` 10 (only runtime dep)
- esbuild 0.28 (backend bundle)
- Webpack 5 + esbuild-loader + React 19 (admin panel bundle, Module Federation)
- Biome 2.4 (lint + format)
- Vitest 4 (tests)

## License

Apache-2.0. Copyright 2026 Nearl Crews. See [LICENSE](../LICENSE).
