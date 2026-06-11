# Contributing

Thanks for your interest in contributing to OpenRouter Companion
(`signalk-openrouter-companion`).

## Code of Conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). By
participating, you agree to uphold it.

## Reporting bugs

Check existing issues first to avoid duplicates, then open a
[bug report](https://github.com/NearlCrews/signalk-openrouter-companion/issues/new?template=bug_report.yml)
with:

- A clear title and description
- Steps to reproduce
- Expected and actual behavior
- Environment details (plugin version, Signal K server version, Node.js
  version, OS, and the affected analyzer)
- Relevant log output, with API keys redacted

## Suggesting enhancements

Open a [feature request](https://github.com/NearlCrews/signalk-openrouter-companion/issues/new?template=feature_request.yml)
describing the proposed feature, the use case it serves, and any
implementation ideas you have. New monitoring domains are usually a fit
for the `Analyzer` extension point; check whether your idea is one of
those before proposing a structural change.

## Pull requests

1. Fork the repository and create a feature branch from `main`.
2. Install dependencies with `npm install`, then build and verify with
   `npm run build` and `npm test`.
3. Make focused commits with clear messages (see below).
4. Add or update tests under `tests/` and keep the existing suite green.
5. Run the pre-publish gate locally before pushing:

   ```bash
   npm run prepublishOnly
   ```

   This runs the type check, Biome lint, the Vitest suite, and the build.
   It must be clean.

6. Update documentation (`README.md`, `CHANGELOG.md`, `docs/`) as needed.
7. Open a pull request against `main` with a clear description, and fill
   in the PR template.

## Code style

- TypeScript 6, strict mode, ESM. Node 20.18 or newer (CI runs on Node 20
  and 22).
- Biome handles lint and format: `npm run lint`, or `npm run lint:fix` to
  auto-fix. The Biome config in `biome.json` is the source of truth.
- No em dashes anywhere: in code, commits, PR descriptions, or docs. Use
  a colon, a comma, or split into two sentences.
- Default to no comments. Add a comment only when it explains a
  non-obvious WHY (a hidden constraint, a subtle invariant, a
  workaround). Skip WHAT-comments and change-narrative comments; the code
  says what, the PR description says why.
- Trust internal callers. Only validate at system boundaries (user input,
  external APIs). Skip defensive runtime checks for scenarios that cannot
  happen.
- Prefer the shared helpers in `src/core/`: `buildTriggers` and
  `manualPutCtx`, `bankPaths`, `enginePaths`, and
  `notificationReportPath`, `escapeSqlLiteral` plus `indexColumns`,
  `publishReport`, `clampPositiveInt`, `fmtNumber`, `fmtPct`, `fmtUnit`,
  and `fmtRatio`, and `asTreeMap` plus `readBankSnapshot` for Signal K
  battery trees. Adding a new analyzer should mostly be wiring these
  together.

## Architecture rule

This repository ships exactly ONE npm package and ONE Signal K plugin.
New monitoring domains go in as `Analyzer` modules under
`src/analyzers/`, not as sibling packages or a monorepo. See the
[development guide](../docs/DEVELOPMENT.md) for the full architectural
rules and the standardized triggers contract.

Seven analyzers ship today: `maintenance`, `health`, `alerts`, `aging`,
`drift`, `liveness`, and `forecast`. Split by purpose:

- **State** analyzers describe "now" (`maintenance`, `health`,
  `liveness`).
- **Transition** analyzers describe a threshold crossing (`alerts`).
- **Trend** analyzers describe gradual change over time (`aging`,
  `drift`, and `forecast`; `aging` and `drift` read QuestDB history, and
  `forecast` uses it as an optional baseline).

### Adding a new analyzer

See the [development guide](../docs/DEVELOPMENT.md) for the full
walkthrough. Short version:

1. Implement the `Analyzer` interface in `src/analyzers/Analyzer.ts`:
   `id` (typed as `AnalyzerId`), `title`, `triggers`, `collectContext`,
   `buildPrompt`, optional `publishOutput`, and optional `watchedPaths`.
2. Use `buildTriggers(cfg.triggers, eventMapper?)` so the cron, PUT, and
   events block stays uniform.
3. Use `publisher.publishReport(this.id, ctx, text)` for the canonical
   `notifications.openrouter-companion.<id>.report` shape.
4. Append the id to `src/analyzers/ids.ts::ANALYZER_IDS`, the factory
   closure to `src/analyzers/registry.ts::ANALYZER_FACTORIES` and the
   default prompt to `ANALYZER_DEFAULT_SYSTEM_PROMPTS` in the same file,
   and the config section to `src/schema.ts` plus `src/types.ts`.
   `index.ts` instantiates from the registry automatically.
5. Add tests under `tests/` using `makeAnalyzerDeps` (and
   `makeQuestDBStub` for trend analyzers) from `tests/_mocks.ts`.

## Commit messages

Use conventional-commit prefixes that match the actual diff scope:

- `feat`: new feature
- `fix`: bug fix
- `refactor`: internal cleanup with no behavior change
- `perf`: measurable per-request, per-delta, or per-render win
- `docs`, `test`, `chore`, `ci`: docs, tests, maintenance, CI

## License and attribution

By contributing, you agree your contributions are licensed under the
Apache-2.0 License that covers this project. See [LICENSE](../LICENSE).
