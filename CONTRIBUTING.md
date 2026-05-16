# Contributing to Signal K OpenRouter Companion

Thanks for your interest. This is a beta project; PRs and issues are welcome.

## Getting started

1. Fork the repository on GitHub.
2. Clone your fork:

   ```bash
   git clone https://github.com/YOUR-USERNAME/signalk-openrouter-companion.git
   cd signalk-openrouter-companion
   ```

3. Add the upstream remote:

   ```bash
   git remote add upstream https://github.com/NearlCrews/signalk-openrouter-companion.git
   ```

4. Install dependencies:

   ```bash
   npm install
   ```

5. Build and verify:

   ```bash
   npm run build
   npm run test
   ```

## Architecture

This repo is **ONE npm package**. New monitoring domains go in as `Analyzer` modules under `src/analyzers/`, not as sibling packages. See [DEVELOPMENT.md](DEVELOPMENT.md) for the full architectural rules and the standardized triggers contract.

Six analyzers ship today: `maintenance`, `health`, `alerts`, `aging`, `drift`, `liveness`. Split by purpose:

- **State** analyzers describe "now" (`maintenance`, `health`, `liveness`).
- **Transition** analyzers describe a threshold crossing (`alerts`).
- **Trend** analyzers describe gradual change over a configurable window from QuestDB history (`aging`, `drift`).

## Development workflow

1. Create a feature branch from `main`:

   ```bash
   git checkout -b feat/your-feature
   ```

2. Make your changes. Add or update tests under `tests/`.

3. Run the pre-publish gate locally before pushing:

   ```bash
   npm run prepublishOnly
   ```

   This runs type-check + Biome lint + Vitest + esbuild build. It must be clean.

4. Commit with a [Conventional Commits](https://www.conventionalcommits.org/) prefix:

   - `feat`: new feature
   - `fix`: bug fix
   - `refactor`: internal cleanup with no behavior change
   - `perf`: measurable per-request, per-delta, or per-render win
   - `docs`, `test`, `chore`, `ci`: docs, tests, maintenance, CI

5. Push and open a PR against `main`. Fill in the PR template.

## Coding standards

- TypeScript 6, strict mode, ESM. Node 20.18+ (CI runs on Node 20 and 22).
- Biome handles lint and format: `npm run lint` / `npm run lint:fix`. The Biome config in `biome.json` is the source of truth.
- **No em dashes** anywhere: in code, commits, PR descriptions, or docs. Use a colon, a comma, or split into two sentences.
- Default to no comments. Add a comment only when it explains a non-obvious WHY (a hidden constraint, a subtle invariant, a workaround). Skip WHAT-comments and change-narrative comments; the code says what, the PR description says why.
- Trust internal callers. Only validate at system boundaries (user input, external APIs). Skip defensive runtime checks for scenarios that can't happen.
- Prefer the shared helpers in `src/core/`: `buildTriggers` and `manualPutCtx`, `bankPaths`/`enginePaths`/`notificationReportPath`, `escapeSqlLiteral` + `indexColumns`, `publishReport`, `clampPositiveInt`, `fmtNumber`/`fmtPct`/`fmtUnit`/`fmtRatio`, `asTreeMap` + `readBankSnapshot` for SK battery trees. Adding a new analyzer should mostly be wiring these together.

## Adding a new analyzer

See [DEVELOPMENT.md](DEVELOPMENT.md) for the full walkthrough. Short version:

1. Implement the `Analyzer` interface in `src/analyzers/Analyzer.ts`: `id` (typed as `AnalyzerId`), `title`, `triggers`, `collectContext`, `buildPrompt`, optional `publishOutput`.
2. Use `buildTriggers(cfg.triggers, eventMapper?)` so the cron + PUT + events block stays uniform.
3. Use `publisher.publishReport(this.id, ctx, text)` for the canonical `notifications.openrouter-companion.<id>.report` shape.
4. Append the id to `src/analyzers/ids.ts::ANALYZER_IDS`, the factory closure to `src/analyzers/registry.ts::ANALYZER_FACTORIES`, and the config section to `src/schema.ts` plus `src/types.ts`. `index.ts` instantiates from the registry automatically.
5. Add tests under `tests/` using `makeAnalyzerDeps` (and `makeQuestDBStub` for trend analyzers) from `tests/_mocks.ts`.

## Reporting bugs

Open a [bug report](https://github.com/NearlCrews/signalk-openrouter-companion/issues/new?template=bug_report.yml). Include the plugin version, Signal K server version, Node version, the relevant analyzer, and any log output (with API keys redacted).

## Requesting features

Open a [feature request](https://github.com/NearlCrews/signalk-openrouter-companion/issues/new?template=feature_request.yml). New monitoring domains are usually a fit for the `Analyzer` extension point; check whether your idea is one of those before proposing a structural change.

## License

By contributing you agree your contributions are licensed under the Apache-2.0 License. See [LICENSE](LICENSE).
