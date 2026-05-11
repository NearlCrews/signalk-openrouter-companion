#!/bin/bash
# Reads the Bash tool's command from stdin (Claude Code hook contract).
# If the command is git push or npm publish, ensure .last-verified-sha matches HEAD.
set -euo pipefail

# Hook input arrives as JSON on stdin per the Claude Code hook spec.
input=$(cat)
cmd=$(echo "$input" | jq -r '.tool_input.command // ""')

# Only act on push or publish
if echo "$cmd" | grep -qE '(git[[:space:]]+push|npm[[:space:]]+publish)'; then
  cd "$(git rev-parse --show-toplevel)"
  head=$(git rev-parse HEAD 2>/dev/null || true)
  marker_path=.last-verified-sha
  if [ ! -f "$marker_path" ]; then
    echo "BLOCKED: $marker_path missing. Run /sk-verify before pushing or publishing." >&2
    exit 2
  fi
  marker=$(cat "$marker_path")
  if [ "$marker" != "$head" ]; then
    echo "BLOCKED: $marker_path is stale (marker=$marker, HEAD=$head). Run /sk-verify after your last change." >&2
    exit 2
  fi
fi
exit 0
