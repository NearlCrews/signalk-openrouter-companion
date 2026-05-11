---
description: Dispatch a 3-agent SignalK-flavored team (semantics + internals/tests + reuse/lint) for the given task
argument-hint: <task description, e.g. "add an analyzer for fuel consumption tracking">
---

You are coordinating a 3-agent team to tackle this task in `signalk-openrouter-companion`:

**Task:** $ARGUMENTS

Spawn **agent teammates** (not subagents) so they can communicate directly via the team mailbox. `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set. All three teammates run in a single turn (one dispatch) so they execute concurrently.

## Teammates and lenses

**Lens A: Signal K semantics (uses `signalk-plugin-expert` agent)**
- Reviews any proposed or applied changes against Signal K conventions: path naming, delta shapes (`{ context, updates: [{ source, timestamp, values: [{ path, value }] }] }`), unit conventions (SI), source identification.
- Verifies plugin lifecycle hygiene: `start`/`stop` symmetry, unsubscribe-on-stop, no leaked timers/intervals, idempotent restart.
- Confirms app-store readiness for any user-facing surface (schema, README hints, capabilities, no console.log noise in hot paths).

**Lens B: Plugin internals and tests**
- Verifies the change conforms to the modular `Analyzer` framework (see `src/analyzers/`): correct interface implementation, `watchedPaths` declared up front, `onDelta`/`onTick` shape.
- Runs `npm run lint && npm run type-check && npm test` from `/home/dietpi/src/signalk-openrouter-companion` and reports any failures verbatim.
- Checks for behavioral regressions in existing analyzers and in the `_mocks.ts` test harness.

**Lens C: Cross-cutting reuse and biome/tsc cleanliness**
- Looks for duplication with existing helpers: `readNumberAt`, `enabledGate`, `triggerSchema`, `CRON_PRESETS`, `ALARM_STATES`, and anything else under `src/lib/` or shared utilities.
- Flags stringly-typed code where named constants or enums already exist.
- Ensures biome lint and `tsc --noEmit` stay green; flags `any`/`unknown` regressions, unused exports, dead branches.

## Ground rules for all teammates

- **Coordinate via mailbox messaging.** Share findings, challenge each other's conclusions, and resolve disagreements directly. Do not route everything through the lead. That is the entire point of teams vs subagents.
- **Single-package constraint.** ALL work stays inside the `signalk-openrouter-companion` package. Do not propose splitting monitoring domains into separate npm packages, workspaces, or submodules.
- **Standardized triggers contract.** Any new analyzer or trigger source must conform to the existing `triggerSchema` and use `CRON_PRESETS` / `ALARM_STATES` where applicable rather than inventing parallel structures.
- **No em dashes.** Do not use `—` in any output, ever: reports, code comments, commit messages, mailbox messages. Use a colon, a comma, or split into two sentences. Briefs to teammates: include this rule verbatim.
- **Verify before claiming.** Every "tests pass" / "lint clean" / "this matches convention X" claim must be backed by an actual command run or a file-read receipt.

## Deliverable

After teammates report and converge, summarize:
1. What changed (files + one-line per change).
2. Verification receipts (lint, type-check, test, build status with the actual exit results).
3. Any unresolved disagreements between teammates, with the recommended resolution.
4. Next-step recommendation (commit, push, more work, etc.).
