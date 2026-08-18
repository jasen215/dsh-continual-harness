#!/usr/bin/env bash
# Publishes dsh-continual-harness to the npm registry (registry.npmjs.org,
# explicitly — the machine's default registry may be a mirror such as
# registry.npmmirror.com, which must never receive a publish).
#
# Auth: either `npm login --registry https://registry.npmjs.org` (token then
# lives in ~/.npmrc) or pass NPM_TOKEN explicitly:
#   ./scripts/publish.sh                       # uses npm config auth (after npm login)
#   NPM_TOKEN=<token> ./scripts/publish.sh     # explicit access/automation token
#   NPM_TOKEN=<token> NPM_OTP=<code> ./scripts/publish.sh   # 2FA auth-and-writes
#
# The token is read from the environment only when given — it is never
# written to a file.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUMP="${1:-patch}"
REGISTRY="https://registry.npmjs.org"

# Keep npm's cache/logs inside the repo when the default location (~/.npm)
# is not writable (sandboxed builds, CI with a read-only home).
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$ROOT/.npm-cache}"
mkdir -p "$NPM_CONFIG_CACHE"

echo "==> building lib/ artifacts"
pnpm run build

NAME="$(node -p "require('./package.json').name")"
CURRENT="$(node -p "require('./package.json').version")"

# Auto-bump only when the current version is already published, so a plain
# re-run of this script after a successful publish is a no-op (same version
# is not re-published).
PUBLISHED="$(npm view "$NAME" version --registry "$REGISTRY" 2>/dev/null || true)"
if [[ "$CURRENT" == "$PUBLISHED" ]]; then
  echo "==> version $CURRENT already on the registry — bumping ($BUMP)"
  npm version "$BUMP" --no-git-tag-version >/dev/null
  CURRENT="$(node -p "require('./package.json').version")"
fi

echo "==> publishing $NAME@$CURRENT to $REGISTRY"
PUBLISH_ARGS=(--access public --registry "$REGISTRY")
if [[ -n "${NPM_TOKEN:-}" ]]; then
  # Explicit token wins; otherwise npm uses the auth stored by `npm login`.
  PUBLISH_ARGS+=(--//registry.npmjs.org/:_authToken="$NPM_TOKEN")
fi
if [[ -n "${NPM_OTP:-}" ]]; then PUBLISH_ARGS+=(--otp "$NPM_OTP"); fi
npm publish "${PUBLISH_ARGS[@]}"

echo "==> verifying"
LIVE="$(npm view "$NAME" version --registry "$REGISTRY")"
echo "✔ $NAME@$LIVE is live at https://www.npmjs.com/package/$NAME"
if [[ "$LIVE" != "$CURRENT" ]]; then
  echo "⚠  registry reports $LIVE (expected $CURRENT) — check the publish log above" >&2
  exit 1
fi
