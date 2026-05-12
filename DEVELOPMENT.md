# Development

Technical documentation for working on `signalk-openrouter-companion`. For user-facing install and configuration, see [README.md](README.md). For contribution flow, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Architecture

This repo is **one npm package**. New monitoring domains land as `Analyzer` modules under `src/analyzers/`, not as sibling repos or sub-packages. A previous session mistakenly created a sibling repo and had to consolidate; that mistake is documented in [CLAUDE.md](CLAUDE.md) and [CHANGELOG.md](CHANGELOG.md) under 0.2.0.

### Layered structure

```
src/
├── index.ts                  Plugin entry: lifecycle, subscriptions, PUT registration
├── schema.ts                 rjsf JSON Schema for the admin UI
├── types.ts                  Plugin options + DEFAULT_OPTIONS + mergeWithDefaults
├── analyzers/
│   ├── Analyzer.ts           Shared interface, TriggerSpec union, AnalyzerDeps
│   ├── maintenance.ts        State: engine-session narrative
│   ├── health.ts             State: daily battery snapshot
│   ├── alerts.ts             Transition: threshold crossings
│   ├── aging.ts              Trend: capacity loss per bank from QuestDB
│   └── drift.ts              Trend: fuel-economy drift per RPM bin from QuestDB
└── core/
    ├── buffer.ts             Rolling buffer for raw delta history (in-memory)
    ├── batteryMonitor.ts     Per-bank SoC + cell-imbalance state machine
    ├── engineDetector.ts     Per-engine RPM state machine for session detection
    ├── triggerRouter.ts      Routes cron + put + event triggers to analyzers
    ├── cronScheduler.ts      Wraps croner for cron-driven triggers
    ├── publisher.ts          handleMessage notification + JSONL log writer
    ├── budget.ts             Per-day OpenRouter call cap
    ├── openrouter.ts         HTTP client with retry and backoff ladder
    ├── questdb.ts            HTTP client + escapeSqlLiteral + indexColumns
    ├── discovery.ts          Engine and bank id discovery from SK paths
    ├── skNode.ts             readNumberAt helper for SK tree traversal
    ├── paths.ts              Centralized path-string helpers
    ├── triggers.ts           buildTriggers(cfg, eventMapper?) shared by all analyzers
    ├── format.ts             fmtNumber / fmtPct / fmtUnit / fmtRatio
    ├── cfg.ts                clampPositiveInt for sanitized day-counts
    └── logger.ts             Wraps app.debug / app.error / stringify
```

### The Analyzer interface

```typescript
export interface Analyzer<I extends AnalysisInput = AnalysisInput> {
  readonly id: string;
  readonly title: string;
  readonly triggers: ReadonlyArray<TriggerSpec>;
  collectContext(ctx: TriggerCtx, deps: AnalyzerDeps): Promise<I | null>;
  buildPrompt(input: I): { system: string; user: string };
  publishOutput?(text: string, ctx: TriggerCtx, deps: AnalyzerDeps): Promise<void>;
}
```

`collectContext` returns `null` to mean "no report for this trigger" (e.g., engine-stop with too short a session, or a trend window without enough data). `buildPrompt` is pure: given a snapshot, it produces the prompt halves. `publishOutput` is optional; the default `TriggerRouter` falls back to `ReportPublisher.publish(text, meta)`. State and trend analyzers override to use `publisher.publishReport(this.id, ctx, text)` which uses the canonical `notifications.openrouter-companion.<id>.report` path.

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

The five analyzers are split by purpose so they don't duplicate findings:

- **State** (`maintenance`, `health`): describe "now". Read from the in-memory `RollingBuffer` and the live SK tree via `app.getSelfPath(...)`. No QuestDB.
- **Transition** (`alerts`): describe a threshold crossing. Triggered by `battery-event` subkinds from `BatteryMonitor`. Reads a one-shot snapshot.
- **Trend** (`aging`, `drift`): describe gradual change over a configurable window. Read history from QuestDB; the buffer is only used to discover which banks and engines exist.

Trend analyzers own QuestDB queries; state analyzers don't, so a daily health report stays independent of long-term history and won't duplicate the trend analyzers' findings.

## Build

```bash
npm run build          # clean + tsc -d + esbuild bundle
npm run build:types    # tsc --emitDeclarationOnly --declaration --outDir dist
npm run build:bundle   # node esbuild.config.mjs
npm run clean          # rm -rf dist
```

Output:

- `dist/index.js` (single ESM bundle, ~120 KB)
- `dist/*.d.ts` (TypeScript declarations)

esbuild externalizes `@signalk/server-api` and `croner`; everything else is bundled. The Signal K server provides `@signalk/server-api` at runtime (`peerDependency`).

## Tests

```bash
npm run test           # vitest run, one-shot
npm run test:watch     # vitest, watch mode
npm run test:coverage  # vitest run --coverage
```

131 tests across 18 files cover:

- Each analyzer's triggers, `collectContext` null paths, happy path, and `buildPrompt`.
- Shared infra: buffer eviction (age + amortized count), battery monitor state machine, engine detector state machine, trigger router dispatch, cron scheduler, publisher (delta shape + JSONL append), QuestDB client (probe + query + error paths).
- `tests/integration.test.ts` exercises the plugin end-to-end with a mocked SK server and `vi.stubGlobal('fetch')` for OpenRouter.

The shared test mocks live in `tests/_mocks.ts`:

- `makeMockApp(dir)`: builds a `MockApp` implementing the subset of `ServerApiLike` the plugin touches.
- `makeAnalyzerDeps(app, buffer, opts?)`: canonical factory for `AnalyzerDeps`. Pass `{ questdb }` and `{ publisher }` only when the test needs them.
- `makeQuestDBStub(dispatch)`: injects a typed stub matching the `QuestDBClient.query` surface. Trend-analyzer tests use it instead of stubbing global `fetch`, which is process-wide and races with parallel test workers.

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

After each code change, `npm run build && sudo systemctl restart signalk.service` rebuilds and reloads. `tsx watch` (`npm run dev`) works for tighter iteration but doesn't produce the `dist/` bundle the SK server actually loads, so save it for unit-level testing.

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

1. Decide whether it is **state**, **transition**, or **trend**. State/trend use the shared `publishReport` shorthand; transition usually wants a custom path like `alerts` uses for `alert.<subkind>`.

2. Create `src/analyzers/<name>.ts` implementing `Analyzer<I>`:

   ```typescript
   export class MyAnalyzer implements Analyzer<MyInput> {
     readonly id = 'myname';
     readonly title = 'My Analyzer';
     readonly triggers: ReadonlyArray<TriggerSpec>;
     constructor(cfg: MyCfg) {
       this.triggers = buildTriggers(cfg.triggers);
     }
     async collectContext(ctx, deps) { /* ... return MyInput | null */ }
     buildPrompt(input) { return { system, user }; }
     async publishOutput(text, ctx, deps) {
       await deps.publisher.publishReport(this.id, ctx, text);
     }
   }
   ```

3. Add the config block to `src/types.ts::PluginOptions['analyzers']` and `DEFAULT_OPTIONS`. Use `pluginPutPath('myname')` for the default PUT path.

4. Add the schema section in `src/schema.ts` (a per-analyzer `type: 'object'` with `enabled` and a nested `triggers` block). The schema also drives the admin UI.

5. Wire the analyzer in `src/index.ts`: instantiate it inside the `cfg.analyzers.myname.enabled` branch and push onto the `analyzers` array.

6. Add tests under `tests/myname.test.ts` using `makeAnalyzerDeps` (and `makeQuestDBStub` for trend analyzers) from `tests/_mocks.ts`.

7. Document the analyzer in `README.md` (the Analyzers table and Defaults table) and `CHANGELOG.md`.

## CI

GitHub Actions workflows under `.github/workflows/`:

- `plugin-ci.yml`: reuses the upstream SK plugin CI workflow (type-check + lint + build).
- `test.yml`: runs the vitest suite on Node 22 and 24.

Both run on push and pull_request to `main`.

## Tech stack

- TypeScript 6 strict, ESM, ES2022 target
- Node 22+ (specified in `package.json#engines`)
- `@signalk/server-api` 2.24+ (peer dep)
- `croner` 10 (only runtime dep)
- esbuild 0.28 (build)
- Biome 2.4 (lint + format)
- Vitest 4.1 (tests)

## License

Apache-2.0. Copyright 2026 Nearl Crews. See [LICENSE](LICENSE).
