# CLAUDE.md: signalk-openrouter-companion

Project memory for Claude Code. Read at the start of every session.

## Architecture (Critical)

- This repo is **ONE npm package**. Each type of monitoring is a separate `Analyzer` module inside `src/analyzers/`. Never create a sibling repo or a separate npm package per domain. (On 2026-05-10 a session mistakenly created `signalk-openrouter-batteries-companion` and had to consolidate. Don't repeat that.)
- The `Analyzer` interface in `src/analyzers/Analyzer.ts` is the extension point. New analyzers implement: `id`, `title`, `triggers`, `collectContext`, `buildPrompt`, optional `publishOutput`.
- Standardized triggers block per analyzer: `{ cron: { enabled, pattern, timezone }, put: { enabled, path }, events: string[] }`. Same shape for every analyzer; the events array's enum is per-analyzer.
- Shared infra in `src/core/`: `logger`, `buffer`, `budget`, `engineDetector`, `batteryMonitor`, `cronScheduler`, `triggerRouter`, `openrouter`, `questdb`, `publisher`, `discovery`, `skNode`.
- Three analyzers ship today:
  - `maintenance`: engine sessions, fires on engine-stop.
  - `health`: daily battery health, fires on cron.
  - `alerts`: battery threshold notifications, fires on battery events.

## Conventions

- TypeScript 6, ESM, Node 22+. esbuild bundles to `dist/index.js`. vitest for tests. biome for lint and format.
- No em dashes anywhere in code, commits, or docs. Use colons, commas, or split sentences.
- Tests live in `tests/`. Share the `_mocks.ts` harness; don't re-mock fundamentals.
- Notification paths: `notifications.openrouter-companion.<analyzer>.<...>`.
- PUT paths: `plugins.openrouter-companion.<analyzer>.<verb>`.
- Apache-2.0 license. Author is Nearl Crews (`NearlCrews@users.noreply.github.com`).

## Standardized triggers contract

- Every analyzer's config has `triggers: AnalyzerTriggerCfg`. The plugin lifecycle in `src/index.ts` registers triggers from the analyzer's `.triggers` array dynamically, driven by config.
- Cron support comes from the `CronScheduler` (croner). PUT support comes from `app.registerPutHandler`. Event support is per-domain.
- Don't hardcode trigger registration logic in `index.ts`; let analyzers declare their triggers and let the lifecycle wire them.
- See `~/.claude/projects/-home-dietpi-src-signalk-openrouter-companion/memory/triggers_contract.md` for the full rules on adding a new analyzer.

## Pre-push gate

- Run `npm run prepublishOnly` (type-check + lint + test + build) before any push or publish. Never push without it being clean.
- Linked into `~/.signalk/node_modules/signalk-openrouter-companion` for live dev against the local Signal K server at port 3000.

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

- The `signalk-plugin-expert` agent (symlinked from user-global into `.claude/agents/`) is the source of truth for Signal K plugin semantics. Use it for any SK API or convention question.
- The `Read` tool gives access to the engine-plugin source under `/home/dietpi/src/signalk-server/` for reference. Don't modify it.
- The user's vessel exposes battery banks (house, starter, console, trolling) and a single engine (`port`). Use these for testing.

## Things to avoid (learned this session)

- Don't propose separate npm packages for new monitoring domains. Add them as Analyzer modules. (See CHANGELOG 0.2.0: the early `signalk-openrouter-batteries-companion` sibling repo was archived and its analyzers consolidated into this plugin.)
- Don't use `anyOf` for the cron-pattern dropdown with a freeform string branch. rjsf 5 only renders `anyOf` / `oneOf` as a single select when every branch is a constant; mixing in a freeform branch produces a doubled control. Use `enum + enumNames`. Custom (non-preset) cron values go in the saved JSON config file.
- Don't read user memory for credentials and echo them. They go through env vars only.
