---
description: Pre-push gate: run type-check, lint, test, build. On success, record HEAD SHA to .last-verified-sha.
---

Run the full verification gate for `signalk-openrouter-companion`. The marker file `.last-verified-sha` is consumed by a PreToolUse hook that blocks `git push` until verification matches the current HEAD.

## Steps

1. From `/home/dietpi/src/signalk-openrouter-companion`, run in order and capture exit status of each:
   - `npm run type-check`
   - `npm run lint`
   - `npm test`
   - `npm run build`

   You may chain them as `npm run type-check && npm run lint && npm test && npm run build` for speed, but if anything fails, re-identify which specific step failed so the report is precise.

2. **If all four pass:**
   - Capture the current HEAD SHA: `git -C /home/dietpi/src/signalk-openrouter-companion rev-parse HEAD`.
   - Write that SHA (and only that SHA, no trailing newline beyond what `rev-parse` emits) to `/home/dietpi/src/signalk-openrouter-companion/.last-verified-sha`.
   - Report: "Verified <short-sha>. Safe to push." with a one-line confirmation per check.

3. **If any step fails:**
   - Do NOT touch `.last-verified-sha`. Leave any prior value intact.
   - Report which step failed (type-check / lint / test / build), include the relevant failure output verbatim (trim to the actionable section if huge), and recommend the next action: fix and re-run `/sk-verify`, or investigate with the appropriate skill.

## Style

- No em dashes anywhere in the report.
- Be terse on success, precise on failure.
