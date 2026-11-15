#!/usr/bin/env bash
# Writes the release's /version.json (docs/CONTRACTS.md §12.2), which drives the "What's new" banner and Reload:
#   {"version":"<short sha>","builtAt":"<ISO 8601 UTC>","areas":["Settings","Profile picture"]}
# Inputs (environment):
#   PREV_VERSION  the "version" of the live /version.json; empty on the first deploy -> ["First release"]
#   NEW_SHA       optional, default $GITHUB_SHA, then `git rev-parse HEAD`
#   OUT           optional, default <repo>/web/dist/version.json
# The short sha is always the first 7 characters, the same value the web build gets as VITE_APP_VERSION.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${OUT:-${ROOT}/web/dist/version.json}"
PREV_VERSION="${PREV_VERSION:-}"

command -v jq >/dev/null || { echo "write-version-json: jq is required" >&2; exit 1; }

new_sha="${NEW_SHA:-${GITHUB_SHA:-}}"
[ -n "$new_sha" ] || new_sha="$(git -C "$ROOT" rev-parse HEAD)"
version="${new_sha:0:7}"

if [ -z "$PREV_VERSION" ]; then
  areas='["First release"]'
else
  areas="$(cd "$ROOT" && bash scripts/release-areas.sh "$PREV_VERSION" "$new_sha")"
fi

mkdir -p "$(dirname "$OUT")"
jq -n --arg version "$version" --arg builtAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson areas "$areas" \
  '{version: $version, builtAt: $builtAt, areas: $areas}' >"$OUT"
echo "Wrote ${OUT}:"
cat "$OUT"
