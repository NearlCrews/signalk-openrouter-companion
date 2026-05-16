# Development

Technical documentation for working on `signalk-openrouter-companion`. For user-facing install and configuration, see [README.md](README.md). For contribution flow, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Architecture

This repo is **one npm package**. New monitoring domains land as `Analyzer` modules under `src/analyzers/`, not as sibling repos or sub-packages. A previous session mistakenly created a sibling repo and had to consolidate; that mistake is documented in [CLAUDE.md](CLAUDE.md) and [CHANGELOG.md](CHANGELOG.md) under 0.2.0.

### Layered structure

```
src/
├── index.ts                  Plugin entry: lifecycle, subscriptions, PUT + REST registration
├── schema.ts                 rjsf JSON Schema (storage shape; fallback admin UI)
├── types.ts                  Plugin options + DEFAULT_OPTIONS + mergeWithDefaults
├── analyzers/
│   ├── Analyzer.ts           Shared interface, TriggerSpec union, AnalyzerDeps
│   ├── ids.ts                ANALYZER_IDS, AnalyzerId, ANALYZER_TITLES, isAnalyzerId
│   ├── registry.ts           ANALYZER_FACTORIES: per-id constructor map driven by ANALYZER_IDS
│   ├── maintenance.ts        State: engine-session narrative
│   ├── health.ts             State: daily battery snapshot
│   ├── alerts.ts             Transition: threshold crossings
│   ├── aging.ts              Trend: capacity loss per bank from QuestDB
│   └── drift.ts              Trend: fuel-economy drift per RPM bin from QuestDB
├── configpanel/
│   ├── index.js              Module Federation entry stub (Webpack emits remoteEntry around this)
│   └── PluginConfigurationPanel.jsx  React 19 panel exposed as `./PluginConfigurationPanel`
└── core/
    ├── api.ts                REST routes registered via registerWithRouter; PluginRuntime; DEFAULT_SYSTEM_PROMPTS
    ├── buffer.ts             Rolling buffer for raw delta history (in-memory)
    ├── batteryMonitor.ts     Per-bank SoC + cell-imbalance state machine
    ├── engineDetector.ts     Per-engine RPM state machine for session detection
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

Full rules for adding a new analyzer live in [CLAUDE.md](CLAUDE.md) and the project's memory at `~/.claude/projects/-home-dietpi-src-signalk-openrouter-companion/memory/triggers_contract.md`.

### State vs transition vs trend

The six analyzers are split by purpose so they don't duplicate findings:

- **State** (`maintenance`, `health`, `liveness`): describe "now". Read from the in-memory `RollingBuffer` (`maintenance` and `health` also read the live SK tree via `app.getSelfPath(...)`; `liveness` reads the buffer only). No QuestDB.
- **Transition** (`alerts`): describe a threshold crossing. Triggered by `battery-event` subkinds from `BatteryMonitor`. Reads a one-shot snapshot.
- **Trend** (`aging`, `drift`): describe gradual change over a configurable window. Read history from QuestDB; the buffer is only used to discover which banks and engines exist.

Trend analyzers own QuestDB queries; state analyzers don't, so a daily health report stays independent of long-term history and won't duplicate the trend analyzers' findings.

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

- `dist/index.js` (single ESM backend bundle, ~131 KB)
- `dist/*.d.ts` (TypeScript declarations)
- `public/remoteEntry.js` + lazy chunks (Webpack Module Federation panel, ~18 KB total)

esbuild externalizes `@signalk/server-api` and `croner`; everything else in the backend is bundled. The panel bundle shares `react` / `react-dom` 19 as Module Federation `singleton: true` so it reuses the SK admin UI's React runtime. The panel is built with `experiments.outputModule: true` and `library: { type: 'module' }` because this package's `"type": "module"` makes SK admin inject `<script type="module">`; legacy `library: 'var'` doesn't work under that loader.

## Tests

```bash
npm run test           # vitest run, one-shot
npm run test:watch     # vitest, watch mode
npm run test:coverage  # vitest run --coverage
```

156 tests across 19 files cover:

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

9. Document the analyzer in `README.md` (the Analyzers table) and `CHANGELOG.md`.

## CI

GitHub Actions workflows under `.github/workflows/`:

- `plugin-ci.yml`: reuses the upstream SK plugin CI workflow (type-check + lint + build).
- `ci.yml`: runs the vitest suite on Node 20.x and 22.x.
- `codeql.yml`: CodeQL static analysis.
- `publish.yml`: npm publish on a tag.

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

Apache-2.0. Copyright 2026 Nearl Crews. See [LICENSE](LICENSE).
