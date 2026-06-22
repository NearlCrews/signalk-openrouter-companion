# CLAUDE.md: signalk-openrouter-companion

Project memory for Claude Code. Read at the start of every session.

## Architecture (Critical)

- This repo is **ONE npm package**. Each type of monitoring is a separate `Analyzer` module inside `src/analyzers/`. Never create a sibling repo or a separate npm package per domain. (On 2026-05-10 a session mistakenly created `signalk-openrouter-batteries-companion` and had to consolidate. Don't repeat that.)
- The `Analyzer` interface in `src/analyzers/Analyzer.ts` is the extension point. New analyzers implement: `id: AnalyzerId` (must also be added to `src/analyzers/ids.ts`), `title` (read from `ANALYZER_TITLES`), `triggers`, `collectContext`, `buildPrompt`, optional `publishOutput`, and optional `watchedPaths`. When `publishOutput` is omitted the TriggerRouter publishes via `deps.publisher.publishReport(this.id, ctx, text)` on the canonical report path with `state: nominal` (no N2K alert PGN). Transition analyzers (alerts) override with `deps.publisher.publishOnPath` for a per-event path and explicit alert state. `watchedPaths` declares fixed Signal K paths the analyzer needs buffered that are not discovered from the live tree (forecast's weather leaves); the lifecycle subscribes the union across enabled analyzers, so `index.ts` never special-cases one analyzer by id.
- `src/analyzers/ids.ts` is the **single source of truth** for analyzer ids and titles (`ANALYZER_IDS`, `AnalyzerId`, `ANALYZER_TITLES`, `isAnalyzerId`). Kept separate from each analyzer module to avoid the circular import that a registry-with-prompts would create. Don't duplicate this list anywhere; api.ts iterates `ANALYZER_IDS` for the status payload, index.ts iterates `ANALYZER_IDS` plus `ANALYZER_FACTORIES` to instantiate enabled analyzers, the panel reads order from `/api/status`, and analyzer classes set `readonly title = ANALYZER_TITLES.<id>`.
- `src/analyzers/registry.ts` maps each `AnalyzerId` to its constructor closure (`ANALYZER_FACTORIES`) and to its default system prompt (`ANALYZER_DEFAULT_SYSTEM_PROMPTS`). Both live here, the one file that already imports every analyzer module, so adding a new analyzer means one entry in each map (plus the id in `ids.ts`) instead of editing a hand-rolled if-block in `index.ts` or a third parallel map in `core/api.ts`.
- Standardized triggers block per analyzer: `{ cron: { enabled, pattern, timezone }, put: { enabled }, events: string[] }`. Same shape for every analyzer; the events array's enum is per-analyzer. The PUT path is not stored on the cfg; it is derived from the analyzer id (`pluginPutPath(id)`, verb fixed at `run`).
- Per-analyzer system prompts are overridable via `customSystemPrompt?: string` on each `*Cfg`. Constructor calls `resolveSystemPrompt(cfg.customSystemPrompt, <NAME>_DEFAULT_SYSTEM_PROMPT)`. The default is exported from each analyzer file and aggregated in `registry.ts::ANALYZER_DEFAULT_SYSTEM_PROMPTS`, which `core/api.ts` serves via `GET /api/analyzers/:id/prompt` (kept a compile-time constant so the route works before the runtime exists and for disabled analyzers).
- Shared infra in `src/core/`: `logger`, `buffer`, `budget`, `engineDetector`, `batteryMonitor`, `cronScheduler`, `triggerRouter`, `openrouter`, `questdb` (incl. `escapeSqlLiteral`, `decodePathKeyed`, `isoRange`, and `QUESTDB_SELF_CONTEXT_SQL`), `http` (`fetchWithTimeout`), `publisher`, `discovery`, `skNode` (incl. `asTreeMap` + `readBankSnapshot`), `emitter` (TypedEmitter base for batteryMonitor/engineDetector), `readings` (shared rolling per-source map helpers: `evictStale`, `fuseMin`, `fuseMax`, and `evictStaleSpan`), `format`, `paths`, `triggers` (incl. `buildTriggers` and `manualPutCtx`), `cfg` (incl. `clampPositiveInt`, `clampMin`, `clampRange`, `finiteOr`, and `resolveSystemPrompt`), `api` (REST routes + PluginRuntime).
- Seven analyzers ship today, split by purpose. State analyzers describe "now", trend analyzers describe "over time", the alerts analyzer describes "transitions":
  - `maintenance` (state): per-engine-session narrative, fires on engine-stop. No QuestDB.
  - `health` (state): daily snapshot of every battery bank, fires on cron. No QuestDB.
  - `alerts` (transition): real-time threshold crossings (low SoC, cell imbalance), fires on battery events. Known and documented design choice (not a bug): the per-bank alert is published inside `publishOutput`, which the router reaches only after the shared daily budget check and a successful OpenRouter call (`triggerRouter.ts` runOne). So a budget-exhausted or offline run does not raise the per-bank alert; on a sustained LLM failure the operator still gets an audible generic `warn` on the report path (`alerts.failureAudible = true`), and on budget exhaustion only the admin status banner moves. A shutdown that aborts a run mid-flight is the deliberate exception: the abort guard in `triggerRouter.ts` skips the failure publish entirely, so stopping the plugin raises no spurious failure report or `alerts` alarm for the interrupted run. This is documented in the schema description and README as "not your sole battery safety alarm". If you ever want the alarm to be LLM-independent, the fix is to publish a deterministic per-bank alert on the battery event first, then enrich with LLM text; that was deferred by choice, do not treat the coupling as an undiscovered defect.
  - `aging` (trend): monthly capacity-loss trend per bank over two configurable windows (default 30 and 90 days), fires on cron. Reads QuestDB.
  - `drift` (trend): weekly engine fuel-economy and per-RPM drift vs a configurable trailing baseline (default 30 days), fires on cron. Reads QuestDB.
  - `liveness` (state): reports which watched SignalK paths have gone stale or are served by multiple sources, fires on cron. Reads the `RollingBuffer` only (`pathKeys` + `slice`); no QuestDB.
  - `forecast` (trend): short-term weather outlook extrapolated from environmental trends, fires on cron. Reads the `RollingBuffer` for trends and treats QuestDB as an optional baseline, so it still produces an outlook with no QuestDB.
- Trend analyzers own QuestDB queries; state analyzers don't, to keep their reports independent of long-term history and avoid duplicating the trend findings.

## Conventions

- TypeScript 6, ESM, Node 20.18+ (engines floor; CI tests on Node 20 and 22). esbuild bundles backend to `dist/index.js` (target `node20`, matching the engines floor); webpack + esbuild-loader bundles the React panel to `public/remoteEntry.js`. vitest for tests. biome for lint and format. `npm run type-check` runs three chained `tsc --noEmit` passes: `src/` (`tsconfig.json`), `tests/` (`tsconfig.tests.json`), and the config panel (`tsconfig.panel.json`), so dead test fixtures and panel type errors both fail the gate.
- No em dashes anywhere in code, commits, or docs. Use colons, commas, or split sentences.
- Tests live in `tests/`. Share the `_mocks.ts` harness; don't re-mock fundamentals. Use `makePluginRuntime(opts)` for any new test that builds a `PluginRuntime` literal; don't hand-roll the cfg/llm/budget/etc. boilerplate.
- Notification paths: `notifications.openrouter-companion.<analyzer>.<...>`, except `alerts`, which publishes per-bank events to the SK source data path `notifications.electrical.batteries.<bank>.<kind>` (see `src/core/paths.ts::batteryAlertPath`) so third-party bridges already watching that subtree pick them up. Analyzer-run failures always land on the canonical `notifications.openrouter-companion.<analyzer>.report` channel.
- PUT paths: `plugins.openrouter-companion.<analyzer>.<verb>`.
- Plugin REST routes are mounted at the HTTP prefix `/plugins/signalk-openrouter-companion/api/*` via `registerWithRouter`; see `src/core/api.ts`. The shared `requireRuntime` and `requireAnalyzerId` helpers dedupe the 503 / 404 envelopes at the top of each handler.
- Apache-2.0 license. Author is Nearl Crews (`NearlCrews@users.noreply.github.com`).

## Custom config panel (Module Federation)

- The plugin advertises the `signalk-plugin-configurator` keyword in `package.json` so the SK admin loads the React panel at `src/configpanel/PluginConfigurationPanel.tsx` (built to `public/remoteEntry.js`) instead of rendering the rjsf schema. The panel is TypeScript (`.ts`/`.tsx`), type-checked by `tsconfig.panel.json` (`jsx: react-jsx`, DOM libs, `@types/react`).
- `webpack.config.cjs` uses `experiments.outputModule: true` and `library: { type: 'module' }`. This is REQUIRED because our `package.json` has `"type": "module"`, which makes SK admin inject `<script type="module">` for our bundle. The legacy `library: { type: 'var' }` form leaves the federation container's `var ... = ...` in module scope (never on `window`) and breaks the loader. ESM exports `get` and `init` are what the SK admin's dynamic-import path expects.
- Panel state contract from the admin: `{ configuration, save }`. The panel maintains a local `cfg` edit buffer initialized from `configuration` (resync via useEffect), and `save(fullCfg)` persists. No partial PATCH endpoint; the panel always sends the full object.
- All panel `fetch` calls go through `apiFetch(path, opts)` (sets `credentials: 'same-origin'` to match the SK admin convention) and the `fetchJson(path, opts)` envelope on top of it, which returns `{ ok, status, body, error }`. Don't bypass either.
- `setStatus` is guarded by a deep-equality check via `jsonEqual(a, b)`: identical poll responses don't re-render. New per-id state lives on the consolidated `analyzerUi: {[id]: {...}}` map; never add another parallel `{[id]: ...}` map.
- The panel is themed through `--orc-*` CSS variables defined in `src/configpanel/tokens.ts` and consumed in `styles.ts`. `ThemeToggle` pins one of Auto (follow the host admin), Light, Dark, or a red-preserving Night theme by setting `data-orc-theme` on the `.orc-config-panel` root, and persists the choice in `localStorage` under `orc-theme`. Don't hardcode colors in component styles; add a token.
- Panel code is split: data and effects live in `src/configpanel/hooks/` (`useConfig`, `useStatus`, `useOpenRouterModels`, `useSaveLifecycle`), presentational pieces in `src/configpanel/components/` (`AnalyzerRow`, `StatusBlock`, `OpenRouterSection`, `QuestDBSection`, `PromptDrawer`, `NumberInput`, `SegmentedControl`, `ThemeToggle`, `CollapsibleSection`, `SecondaryButton`, `TestButton`, `TestStatus`, `DisclosureCaret`), and shared pure helpers in `utils.ts`, `recency.ts`, `fireOutcome.ts`, and `scheduleOptions.ts`. `PluginConfigurationPanel.tsx` composes them.
- The rjsf schema (`src/schema.ts`) stays as the storage shape and is loaded as a fallback. Don't remove it.

## Standardized triggers contract

- Every analyzer's config has `triggers: AnalyzerTriggerCfg`. The plugin lifecycle in `src/index.ts` registers triggers from the analyzer's `.triggers` array dynamically, driven by config.
- Cron support comes from the `CronScheduler` (croner). PUT support comes from `app.registerPutHandler`. Event support is per-domain.
- Don't hardcode trigger registration logic in `index.ts`; let analyzers declare their triggers and let the lifecycle wire them.
- See `~/.claude/projects/-home-dietpi-src-signalk-openrouter-companion/memory/triggers_contract.md` for the full rules on adding a new analyzer.

## Pre-push gate

- Run `npm run prepublishOnly` (type-check + lint + test + build) before any push or publish. Never push without it being clean.
- Linked into `~/.signalk/node_modules/signalk-openrouter-companion` for live dev against the local Signal K server at port 3000.

## Documentation layout

Docs are organized by audience; keep the repo root clean (it is the first impression on both npm and GitHub).

- **Root**: `README.md`, `CHANGELOG.md`, `LICENSE`, `CLAUDE.md` (Claude Code loads it from root), plus build/config tooling. Nothing else.
- **`.github/`**: `CONTRIBUTING.md` and `SECURITY.md` (GitHub auto-surfaces these from `.github/` exactly as from root), plus issue/PR templates and workflows.
- **`docs/`**: contributor and user reference. `docs/DEVELOPMENT.md` today. If design-decision or release/QA docs appear later, use `docs/decisions/` and `docs/maintainers/`.
- `README.md` is the npm package page (npm renders only `README.md`): a landing page, not a reference manual. Deep reference lives in `docs/` and is linked. It follows the `signalk-virtual-weather-sensors` README as the style model (badges, intro, Features, Requirements, Installation, a Configuration table, content sections, a Documentation links block, License, Support).
- After moving any doc, re-verify every relative markdown link: files in a subdirectory reach the root with `../`. A check that resolves each `](path)` link and fails on a missing target must pass.

## Release process

Every version push updates four things together, then ships:

1. Bump `package.json` version.
2. Add the dated `CHANGELOG.md` entry as `## [X.Y.Z] - YYYY-MM-DD`, preceded by an `<a id="vXYZ"></a>` anchor (every release header carries one so the README can deep-link).
3. Refresh the `README.md` `## What's new in <version>` section (right after the intro blockquote, before What it does). It is **replaced, not appended**: only the most recent release, never an accumulating list. Content is a one-line intro plus 3 to 5 bolded bullets sourced from that release's CHANGELOG entry, ending with links to the CHANGELOG version anchor (`CHANGELOG.md#vXYZ`) and the full release history. No AI-process talk anywhere in it.
4. Run the pre-push gate, push, tag `vX.Y.Z`, and create the GitHub release; the `publish.yml` workflow publishes to npm on the release event.

## Quick-start commands

- Get a local SK login token (admin creds via env; do not echo from user memory):

  ```bash
  curl -s -X POST http://localhost:3000/signalk/v1/auth/login \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$SK_USER\",\"password\":\"$SK_PASS\"}" | jq -r .token
  ```

- Inspect served plugin schema:

  ```bash
  curl -s -H "Authorization: Bearer $TOKEN" \
    http://localhost:3000/skServer/plugins \
    | jq '.[] | select(.id == "signalk-openrouter-companion")'
  ```

- Rebuild dist and restart SK:

  ```bash
  npm run build && sudo systemctl restart signalk.service
  ```

## Useful tools and agents

- The `signalk-plugin-expert` agent (user-global, `~/.claude/agents/`) is the source of truth for Signal K plugin semantics. Use it for any SK API or convention question.
- The `openrouter-marine-expert` agent (user-global, `~/.claude/agents/`) is the expert on the OpenRouter API, marine telemetry analysis, and combining the two. Use it for model, routing, and cost decisions, for prompt design over telemetry, and for judging whether telemetry values are normal or anomalous. It verifies OpenRouter specifics against live docs rather than assuming.
- The `Read` tool gives access to the engine-plugin source under `/home/dietpi/src/signalk-server/` for reference. Don't modify it.
- The user's vessel exposes battery banks (house, starter, console, trolling) and a single engine (`port`). Use these for testing.

## Things to avoid (learned this session)

- Don't propose separate npm packages for new monitoring domains. Add them as Analyzer modules. (See CHANGELOG 0.2.0: the early `signalk-openrouter-batteries-companion` sibling repo was archived and its analyzers consolidated into this plugin.)
- Don't use `anyOf` for the cron-pattern dropdown with a freeform string branch. rjsf 5 only renders `anyOf` / `oneOf` as a single select when every branch is a constant; mixing in a freeform branch produces a doubled control. Use `enum + enumNames`. Custom (non-preset) cron values go in the saved JSON config file.
- Don't fork the cron preset list. `src/cronPresets.ts::CRON_PRESETS` is the single source of truth, consumed by both `schema.ts` (split into `enum + enumNames`) and the React panel's schedule dropdown (`configpanel/components/AnalyzerRow.tsx`). Every analyzer's default cron pattern must appear in it, or the dropdown shows that default as a non-selectable "Custom" entry. The panel imports the `.ts` module via the webpack `extensionAlias` + `.ts` loader rule.
- Don't read user memory for credentials and echo them. They go through env vars only.
- Don't duplicate analyzer titles or ids. `src/analyzers/ids.ts::ANALYZER_TITLES` is the single source. (See CHANGELOG 0.3.0: api.ts had drifted from analyzer class titles, causing `/api/status` to lie about names.)
- Don't switch the panel's Module Federation `library` to `var` "to match other plugins". Three of four configurator plugins on the reference SK install use `var`, but they get away with it because their packages are CommonJS. Ours is `"type": "module"`, so SK injects `<script type="module">` and ESM-format federation is the only option that works.
- Don't bypass `apiFetch` in the panel for new fetches. It's a one-liner that sets `credentials: 'same-origin'`; missing it silently 401s under reverse proxies.
- Don't add a new per-id state map alongside `analyzerUi` in the panel. Add a key to `analyzerUi[id]` and patch via `patchUi(id, partial)`.
- Don't restart SK before the new `dist/index.js` finishes building. SK loads plugin code at startup; if dist is older than the SK process the new REST routes will return 404 until the next restart. (See CHANGELOG 0.3.0 simplify-pass.)
- Don't register one cron job per cron trigger in `index.ts`. Analyzers can share a schedule (`health` and `liveness` both default to `0 8 * * *`), and the router dispatches cron by pattern to every matching analyzer, so a job per trigger double-dispatches and double-spends the budget. Register one job per unique `(pattern, timezone)` pair. (See CHANGELOG 0.4.1.)
- Don't route the REST fire endpoint through `TriggerRouter.dispatch`. `dispatch` matches by trigger path/pattern; the fire endpoint names one analyzer directly, so it uses `TriggerRouter.runById`. (See CHANGELOG 0.4.1: the old `dispatch` path matched no analyzer and "Fire now" silently ran nothing.)
- Don't query QuestDB with `app.selfContext`. `signalk-questdb` writes every row with `context` set to the literal `self`, not the vessel's `vessels.urn:mrn:...` identifier. The trend analyzers use `QUESTDB_SELF_CONTEXT` from `src/core/questdb.ts`. (See CHANGELOG 0.5.0: the mismatch matched no rows and left `aging`, `drift`, and `forecast` silent.)
