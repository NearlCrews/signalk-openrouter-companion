#!/bin/bash
# Reads the Bash tool's command from stdin (Claude Code hook contract).
# Blocks git push or npm publish unless .last-verified-sha matches HEAD.
#
# Strips quoted strings from the command first so that commands which merely
# mention "git push" inside an echoed message do not trigger a false block.
set -euo pipefail

input=$(cat)
cmd=$(echo "$input" | jq -r '.tool_input.command // ""')

# Drop single-quoted and double-quoted substrings so embedded literals in echo,
# comments, and heredocs do not match. Then look for the dangerous verbs at the
# start of the command or right after a chaining operator.
stripped=$(printf '%s' "$cmd" | sed -e "s/'[^']*'//g" -e 's/"[^"]*"//g')

if printf '%s' "$stripped" | grep -qE '(^|[;&|`(][[:space:]]*)(git[[:space:]]+push|npm[[:space:]]+publish)\b'; then
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
