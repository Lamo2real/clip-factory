#!/usr/bin/env bash
# Prints the "What's new" labels for a release as a JSON array (docs/CONTRACTS.md §12.2), for example
#   ["Settings","Profile picture"]
# Usage: scripts/release-areas.sh <prev-sha> <new-sha>
#   Run inside the repository (deploy.yml checks out with fetch-depth 0, so the whole history is there).
#   AREAS_FILE  optional, default <repository>/web/areas.json: {"web/src/routes/settings": "Settings", ...}
# Where the labels come from, first match wins:
#   1. "Area: <label>" lines (trailers, or own lines in the message) in the commits after <prev-sha> up to <new-sha> (newest first)
#   2. the changed files mapped through AREAS_FILE (longest matching folder wins; most-changed area first)
#   3. ["Improvements"], also when <prev-sha> is unknown here or not an ancestor of <new-sha>
# Labels are trimmed, cut to 3 words, de-duplicated (ignoring case), and at most 3 are printed. A cut never leaves a
# joining word or punctuation hanging at the end: "Fixes: Home and Jobs" prints "Fixes: Home", not "Fixes: Home and".
# A label of 3 words or fewer is printed as written ("Sign in" stays "Sign in").
# Never fails a deploy over labels: anything unexpected falls back to ["Improvements"] with a warning on stderr.
set -euo pipefail

FALLBACK='["Improvements"]'
MAX_LABELS=3

warn() { echo "release-areas: $*" >&2; }

if [ "$#" -ne 2 ] || [ -z "$1" ] || [ -z "$2" ]; then
  echo "usage: $(basename "$0") <prev-sha> <new-sha>" >&2
  exit 2
fi
command -v jq >/dev/null || { warn "jq is required"; exit 2; }
command -v git >/dev/null || { warn "git is required"; exit 2; }

repo="$(git rev-parse --show-toplevel 2>/dev/null)" || { warn "not inside a git repository"; exit 2; }
AREAS_FILE="${AREAS_FILE:-${repo}/web/areas.json}"

fallback() {
  [ -z "${1:-}" ] || warn "$1; using ${FALLBACK}"
  printf '%s\n' "$FALLBACK"
  exit 0
}

new="$(git rev-parse --verify --quiet "${2}^{commit}")" || { warn "unknown commit $2"; exit 2; }
prev="$(git rev-parse --verify --quiet "${1}^{commit}" 2>/dev/null)" || fallback "commit $1 is not in this history"
git merge-base --is-ancestor "$prev" "$new" || fallback "commit $1 is not an ancestor of $2"

# Cleans, de-duplicates and caps a JSON array of raw labels. Commas split one trailer into several labels.
# shellcheck disable=SC2016 # jq variables, not shell ones
tidy='
  ["and","&","+","or","of","the","a","an","for","to","with","in","on","at","by","from"] as $joiners |
  [ .[] | strings | split(",")[]
    | gsub("[\\s]+"; " ") | sub("^ "; "") | sub(" $"; "")
    | select(length > 0)
    | (split(" ") as $words
        | if ($words | length) > 3 then
            ($words[:3]
              | until(length <= 1 or ((.[-1] | ascii_downcase) as $w | $joiners | index($w) | not); .[:-1])
              | join(" ") | sub("[\\s:;,.&+/-]+$"; ""))
          else $words | join(" ") end)
    | .[:40] | sub(" $"; "")
    | select(length > 0) ]
  | reduce .[] as $l ([]; if any(.[]; ascii_downcase == ($l | ascii_downcase)) then . else . + [$l] end)
  | .[:$max]'

# 1. "Area:" lines. Read from the whole message, not only git's trailer block, so a blank line between
#    "Area:" and "Co-Authored-By:" (which leaves Area outside the trailers) still counts.
trailers="$(git log --format='%B' "${prev}..${new}" | sed -n -E 's/^[[:space:]]*Area:[[:space:]]*(.*)$/\1/p' || true)"
labels="$(jq -cR -s --argjson max "$MAX_LABELS" "split(\"\\n\") | ${tidy}" <<<"$trailers")" ||
  fallback "could not read the Area trailers"
if [ "$labels" != "[]" ]; then
  printf '%s\n' "$labels"
  exit 0
fi

# 2. Changed files through the areas map.
[ -f "$AREAS_FILE" ] || fallback ""
jq -e 'type == "object"' "$AREAS_FILE" >/dev/null 2>&1 || fallback "${AREAS_FILE} is not a JSON object"

changed="$(git diff --name-only --no-renames "$prev" "$new")"
labels="$(jq -cR -s --argjson max "$MAX_LABELS" --slurpfile areas "$AREAS_FILE" "
  (\$areas[0] | to_entries
    | map(select((.value | type) == \"string\") | .key |= sub(\"/+\$\"; \"\"))
    | map(select(.key != \"\"))) as \$map
  | [ split(\"\\n\")[] | select(length > 0) as \$file
      | (\$map | map(.key as \$k | select(\$file == \$k or (\$file | startswith(\$k + \"/\"))))
        | max_by(.key | length) | .value) // empty ]
  | to_entries
  | group_by(.value)
  | map({label: .[0].value, count: length, first: (map(.key) | min)})
  | sort_by(-.count, .first)
  | map(.label)
  | ${tidy}" <<<"$changed")" || fallback "could not map the changed files through ${AREAS_FILE}"
if [ "$labels" != "[]" ]; then
  printf '%s\n' "$labels"
  exit 0
fi

# 3. Nothing to name.
fallback ""
