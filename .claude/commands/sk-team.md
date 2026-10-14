---
description: On request only. Run three read-only Signal K lenses (semantics, analyzer framework and tests, reuse) on sonnet against a design question or a hard bug; the lead implements and runs the gate
argument-hint: <task, e.g. "two designs for a fuel consumption analyzer" or "why alerts double-publish after a restart">
---

Use this command only when the owner asks for a team, and only for multi-hypothesis debugging or for weighing competing designs. Routine review is one `/code-review` pass on the diff, not a team, and ordinary work stays solo.

**Task:** $ARGUMENTS

## Topology

Spawn three background teammates with the Agent tool (`run_in_background: true`), each with a `name`, `model: "sonnet"`, and a brief that loads the skills named below. There is no TeamCreate and no tmux pane: teammates talk through `SendMessage` and finish by reporting to the lead.

Teammates are READ-ONLY. They read code, docs, and git history, and may run light commands (git, grep, jq, `node --test` on one small file). They never edit files and never run heavy commands: no `tsc`, lint, Vitest, Playwright, builds, `npm ci` or `npm install`, or a Signal K server. The lead makes every change and runs the gate once at the end, so at most one heavy command runs from this session at a time.

## Lenses

**Lens A: Signal K semantics (loads the `signalk-development` skill)**

- Path naming, delta shape (`{ context, updates: [{ source, timestamp, values: [{ path, value }] }] }`), SI units, and source identification.
- Plugin lifecycle hygiene: `start` and `stop` symmetry, unsubscribe on stop, no leaked timers or intervals, idempotent restart.
- Notification paths and states as CLAUDE.md defines them, and App Store facing surfaces (schema, README).

**Lens B: Analyzer framework and tests (loads the `openrouter-llm` skill)**

- Conformance to the `Analyzer` interface in `src/analyzers/Analyzer.ts`: `id` from `src/analyzers/ids.ts`, `title` from `ANALYZER_TITLES`, `triggers` built with `buildTriggers`, `collectContext`, `buildPrompt`, and the optional `publishOutput`, `watchedPaths`, and `runKey`. Registration goes through `ANALYZER_FACTORIES` and `ANALYZER_DEFAULT_SYSTEM_PROMPTS` in `src/analyzers/registry.ts`.
- Prompt shape over telemetry: SI units labeled, arithmetic done before the model sees it, producer-controlled strings bounded with `capPromptRows` and `sanitizeForPrompt`.
- Test coverage through the shared `tests/_mocks.ts` harness (`makeAnalyzerDeps`, `makePluginRuntime`), with a happy-path test and at least one null-path test for each new `collectContext` path. Reads the tests; does not run them.

**Lens C: Reuse and cleanliness (loads the `standardize-project-toolchain` skill)**

- Duplication of existing helpers in `src/core/` and the leaf modules: `readNumberAt` and `readBankSnapshot` (`core/skNode.ts`), `clampPositiveInt`, `resolveSystemPrompt`, and the other `core/cfg.ts` helpers, the `core/format.ts` formatters, `enabledGate` and `triggerSchema` (`schema.ts`), `CRON_PRESETS` (`cronPresets.ts`), and `severityRank` (`types.ts`; the state order is private behind it).
- Stringly typed code where a named constant already exists, `any` or loose `unknown` regressions, unused exports, and dead branches.
- Type checks go through `npm run check` (`scripts/tsc.mjs`), never a bare `tsc`. Lens C reports what the lead should look for in that run rather than running it.

## Ground rules

- Single package: all work stays inside `signalk-openrouter-companion`. Never propose splitting a monitoring domain into a separate npm package, workspace, or submodule.
- Standardized triggers: any new analyzer or trigger source uses the existing `triggerSchema`, `buildTriggers`, and `CRON_PRESETS` rather than a parallel structure.
- Findings carry file and line evidence and say what was read. A claim about behavior that needs a command to prove goes to the lead as a request, not as a result.
- No em dashes, Oxford commas, and the word "and" rather than an ampersand in every message and report. Include this rule in each brief.

## Lead deliverable

1. The hypotheses or designs each lens weighed, and the one the evidence supports.
2. The changes the lead made, one line per file.
3. The lead's own `npm run verify` result with its exit status (add `npm run verify:browser` when the panel changed).
4. Open disagreements and the recommended resolution.
