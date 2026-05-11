---
description: Project-flavored /simplify with 4 parallel agents (reuse, quality, efficiency, signalk-plugin-expert)
argument-hint: [optional SHA range, e.g. main..HEAD; defaults to changes since last commit]
---

Run a `signalk-openrouter-companion`-flavored simplify pass on the diff. Spawn **4 parallel agents** in one dispatch.

## Scope

- If `$ARGUMENTS` is provided, treat it as a SHA range (e.g. `main..HEAD`, `HEAD~3..HEAD`) and run against `git diff $ARGUMENTS`.
- Otherwise, run against the working-tree changes since the last commit: `git diff HEAD` plus untracked files surfaced by `git status --short`.

## The 4 agents

**Agent 1: Reuse**
- Look for opportunities to reuse these project primitives instead of reimplementing or inlining:
  - The `Analyzer` interface (`src/analyzers/`)
  - `enabledGate`
  - `triggerSchema`
  - `CRON_PRESETS`
  - `ALARM_STATES`
  - `readNumberAt`
  - The `_mocks.ts` test harness
- Flag duplicated helpers, parallel constants, and any "almost the same as X but slightly different" patterns.

**Agent 2: Quality**
- Stringly-typed values where a named constant or enum exists.
- Dead code, redundant guards after construction, unused exports, `any`/`unknown` regressions.
- Unnecessary comments (comments restating code).
- Biome lint and `tsc --noEmit` cleanliness on the diff.

**Agent 3: Efficiency**
- Hot-path allocations in subscription handlers (`onDelta` and friends).
- Missing `Set` usage for `watchedPaths` membership checks where an `Array.includes` is used per delta.
- Regex compiled inside per-delta paths rather than at module scope.
- Unnecessary `getSelfPath` calls within a single analyzer pass when one read could be cached.
- Other per-tick / per-delta CPU or GC waste.

**Agent 4: `signalk-plugin-expert`**
- Invoke only if the diff touches schemas, delta-emitting code, plugin lifecycle (`start`/`stop`/subscribe/unsubscribe), or anything user-facing in the SK sense.
- Reviews for Signal K conventions, app-store readiness, lifecycle hygiene.
- If the diff is purely internal (e.g. test refactor, internal helper rename with no SK surface touched), note that this agent had nothing actionable and move on.

## Brief to every agent

- No em dashes in any output. Use colons, commas, or sentence splits.
- Cite file path and line for every finding.
- Mark each finding as Critical / Important / Nit so the fix pass can triage.
- Coordinate via mailbox if findings overlap (e.g. reuse and efficiency both spot the same `Array.includes` over `watchedPaths`); merge into one item.

## Fix pass

After agents report:
1. Apply all high-confidence **Important** findings directly.
2. Surface **Critical** findings to the user before touching anything destructive (deletions, API shape changes, behavior changes).
3. Note **Nit** findings in the report but only apply them if they cluster cheaply with an Important fix in the same file.
4. Re-run `npm run lint && npm run type-check && npm test` after fixes and include the receipt in the final report.

## Style

- Concise final report: what each agent found, what got fixed, what's pending user decision.
- No em dashes.
