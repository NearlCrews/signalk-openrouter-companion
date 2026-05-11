#!/bin/bash
set -euo pipefail
input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // .tool_input.path // ""')

# Only rebuild for the schema file
case "$file_path" in
  */src/schema.ts)
    cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
    if [ -f package.json ] && grep -q '"build:bundle"' package.json; then
      npm run build:bundle 2>&1 | tail -3 || echo "build failed; check manually" >&2
    fi
    ;;
esac
exit 0
