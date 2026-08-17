#!/usr/bin/env bash
# Sync the built plugin into the host dsh installation's node_modules so the
# web/headless profile loader can resolve `dsh-continual-harness` as a bare
# name. The host tree is discovered through the dsh home's flat fallback
# symlinks (~/.dsh/profiles/node_modules/@deepseek-ai/<pkg> -> host install).
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm run build

PROBE="$HOME/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm"
HOST_NM="$(readlink "$PROBE" 2>/dev/null | sed 's|/node_modules/@deepseek-ai/dsh-llm$||')/node_modules"
if [[ ! -d "$HOST_NM" ]]; then
  echo "cannot locate host dsh node_modules (probe: $PROBE)" >&2
  exit 1
fi

HOST="$HOST_NM/dsh-continual-harness"
mkdir -p "$HOST"
rsync -a --delete \
  --exclude node_modules --exclude tests --exclude pnpm-lock.yaml \
  --exclude pnpm-workspace.yaml --exclude 'tsconfig*.json' --exclude vitest.config.ts \
  ./ "$HOST/"
echo "synced to $HOST"
