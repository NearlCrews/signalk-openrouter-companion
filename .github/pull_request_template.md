# Pull Request

## Summary

<!-- One or two sentences on what this PR changes and why. -->

## Type of change

<!-- Mark one with [x]. Conventional Commits prefix should match. -->

- [ ] `feat`: new feature
- [ ] `fix`: bug fix
- [ ] `refactor`: internal cleanup, no behavior change
- [ ] `perf`: measurable per-request, per-delta, or per-render win
- [ ] `docs`: documentation only
- [ ] `test`: tests only
- [ ] `chore` / `ci`: maintenance or CI changes
- [ ] Breaking change (describe migration below)

## Affected analyzer

- [ ] maintenance
- [ ] health
- [ ] alerts
- [ ] aging
- [ ] drift
- [ ] Plugin core (lifecycle / schema / triggers / shared infrastructure)
- [ ] None (docs / CI / tooling)

## Related issues

<!-- Use "Fixes #N" / "Closes #N" / "Relates to #N" -->

## Checklist

- [ ] `npm run prepublishOnly` passes locally (type-check + lint + tests + build)
- [ ] Tests cover the change. New `collectContext` paths have a happy-path test and at least one null-path test.
- [ ] No em dashes anywhere (code, commits, PR description, docs).
- [ ] Shared helpers used where applicable: `buildTriggers`, `bankPaths`/`enginePaths`, `notificationReportPath`/`pluginPutPath`, `publishReport`, `escapeSqlLiteral` + `indexColumns`, `fmtNumber`/`fmtPct`/`fmtUnit`/`fmtRatio`, `clampPositiveInt`.
- [ ] CHANGELOG entry under the relevant release (or `[Unreleased]` if applicable).
- [ ] No unrelated formatting churn.

## Adding a new analyzer (only if applicable)

- [ ] Implements `Analyzer<I>` interface (`id`, `title`, `triggers`, `collectContext`, `buildPrompt`, optional `publishOutput`).
- [ ] Constructor uses `buildTriggers(cfg.triggers, eventMapper?)`.
- [ ] `publishOutput` uses `publisher.publishReport(this.id, ctx, text)` unless the analyzer publishes on a per-event path (like `alerts`).
- [ ] Config block added to `src/types.ts::PluginOptions['analyzers']` and `DEFAULT_OPTIONS` (use `pluginPutPath('<id>')` for the default PUT path).
- [ ] Schema section added to `src/schema.ts` with sensible field bounds and admin-UI titles.
- [ ] README Analyzers table and Defaults table updated.
- [ ] CHANGELOG entry added.

## Breaking changes

<!-- If this PR breaks an existing config or notification path, describe the migration here. -->

## Testing

<!-- What did you run? Were tests run against a live Signal K server? -->

```
npm run prepublishOnly
# paste relevant output
```

## Notes for reviewers
