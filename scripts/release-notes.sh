#!/usr/bin/env bash
# Generates markdown release notes from git history between two refs,
# categorized by conventional-commit prefix (feat/fix/refactor/docs/...).
# Used by .github/workflows/release.yml and for local previews:
#
#   ./scripts/release-notes.sh              # previous tag..HEAD
#   ./scripts/release-notes.sh v0.2.2       # v0.2.2..HEAD
#   ./scripts/release-notes.sh v0.2.2 v0.3.0
#
# Compatible with bash 3.2 (macOS default): no mapfile, no associative
# arrays. Uses an ordered list of section names; the commit type is matched
# with a case statement.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FROM="${1:-$(git describe --tags --abbrev=0 'HEAD^' 2>/dev/null || git rev-list --max-parents=0 HEAD | tail -1)}"
TO="${2:-HEAD}"

# GitHub repo slug for links; derived from the origin remote.
REPO="$(git config --get remote.origin.url | sed -E 's#^[^@]+@[^:]+:##; s#^https?://[^/]+/##; s#\.git$##' | tr -d '\n')"

# Ordered sections, newest first. Each holds accumulated "- item" lines
# (without the leading newline of the first item).
SECTION_FEATURES=""
SECTION_FIXES=""
SECTION_REFACTOR=""
SECTION_PERF=""
SECTION_DOCS=""
SECTION_TESTS=""
SECTION_MAINT=""
SECTION_OTHER=""

section_for() {
  local type="$1"
  case "$type" in
    feat) echo "FEATURES" ;;
    fix) echo "FIXES" ;;
    refactor) echo "REFACTOR" ;;
    perf) echo "PERF" ;;
    docs) echo "DOCS" ;;
    test) echo "TESTS" ;;
    chore|ci|build|deps) echo "MAINT" ;;
    *) echo "OTHER" ;;
  esac
}

append_item() {
  local var="$1" line="$2"
  case "$var" in
    FEATURES) SECTION_FEATURES="${SECTION_FEATURES}"$'\n'"$line" ;;
    FIXES) SECTION_FIXES="${SECTION_FIXES}"$'\n'"$line" ;;
    REFACTOR) SECTION_REFACTOR="${SECTION_REFACTOR}"$'\n'"$line" ;;
    PERF) SECTION_PERF="${SECTION_PERF}"$'\n'"$line" ;;
    DOCS) SECTION_DOCS="${SECTION_DOCS}"$'\n'"$line" ;;
    TESTS) SECTION_TESTS="${SECTION_TESTS}"$'\n'"$line" ;;
    MAINT) SECTION_MAINT="${SECTION_MAINT}"$'\n'"$line" ;;
    OTHER) SECTION_OTHER="${SECTION_OTHER}"$'\n'"$line" ;;
  esac
}

while IFS=$'\t' read -r sha subject; do
  # conventional commit prefix, e.g. "fix(refine): ..." -> "fix"
  type="$(sed -E 's/^([a-z]+)(\([^)]*\))?:.*/\1/' <<<"$subject")"
  section="$(section_for "$type")"
  # Pull request number in the subject, e.g. "feat(x): ... (#42)".
  pr="$(sed -nE 's/.*\(#([0-9]+)\)$/\1/p' <<<"$subject")"
  if [[ -n "$pr" && -n "$REPO" ]]; then
    link="https://github.com/${REPO}/pull/${pr}"
  else
    link="https://github.com/${REPO}/commit/${sha:0:10}"
  fi
  # Drop the "(#42)" suffix from the display text.
  clean="$(sed -E 's/ \(#[0-9]+\)$//' <<<"$subject")"
  append_item "$section" "- ${clean} — ${link}"
done < <(git log --format='%H%x09%s' "${FROM}..${TO}")

echo "## What's Changed"
print_section() {
  local title="$1" body="$2"
  [[ -n "$body" ]] || return 0
  printf '\n### %s\n' "$title"
  printf '%s\n' "${body:1}"
}
print_section "🚀 Features" "$SECTION_FEATURES"
print_section "🐛 Bug Fixes" "$SECTION_FIXES"
print_section "♻️ Refactors" "$SECTION_REFACTOR"
print_section "⚡ Performance" "$SECTION_PERF"
print_section "📝 Docs" "$SECTION_DOCS"
print_section "🧪 Tests" "$SECTION_TESTS"
print_section "🧰 Maintenance" "$SECTION_MAINT"
print_section "🎨 Other Changes" "$SECTION_OTHER"
printf '\n**Full Changelog**: https://github.com/%s/compare/%s...%s\n' "$REPO" "${FROM}" "${TO}"
