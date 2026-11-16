#!/usr/bin/env bash
# Unit test for scripts/release-areas.sh. Builds a throwaway git repository in a temporary folder, makes commits
# in it, and checks the labels the script prints. Needs only bash, git and jq; never touches this repository.
# Run: bash scripts/test-release-areas.sh   (ci.yml runs it on every push)
set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-areas.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

passed=0
failed=0

# A clean git identity and config, whatever the machine has.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com

repo="${work}/repo"
mkdir -p "$repo"
cd "$repo"
git init -q -b main

g() { git -c commit.gpgsign=false "$@"; }

# Writes a file and commits it with the given message (which may carry trailers).
change() {
  local file="$1" message="$2"
  mkdir -p "$(dirname "$file")"
  echo "$RANDOM $file" >>"$file"
  git add -A
  g commit -q -m "$message"
  git rev-parse HEAD
}

check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    passed=$((passed + 1))
    echo "ok   ${name}"
  else
    failed=$((failed + 1))
    echo "FAIL ${name}"
    echo "     expected: ${expected}"
    echo "     actual:   ${actual}"
  fi
}

run() { bash "$SCRIPT" "$@" 2>/dev/null; }

mkdir -p web
cat >web/areas.json <<'JSON'
{
  "web/src/routes/settings": "Settings",
  "web/src/routes/settings/profile-picture": "Profile picture",
  "web/src/routes/library/": "Library",
  "api": "Behind the scenes",
  "web/src/ignored": 42
}
JSON
base="$(change README.md "first commit")"

# 1. Trailers win over files, newest commit first, de-duplicated ignoring case, at most three.
c1="$(change web/src/routes/library/a.ts "library tweak

Area: Library")"
check "single trailer" '["Library"]' "$(run "$base" "$c1")"

c2="$(change api/x.py "faster api

Area: Settings
Area:   profile   picture  ")"
c3="$(change api/y.py "more

Area: library, Sharing
Area: Upload button")"
check "trailers: newest first, comma split, dedupe, max 3" \
  '["library","Sharing","Upload button"]' "$(run "$base" "$c3")"
check "trailers: only the commits after prev" '["Settings","profile picture"]' "$(run "$c1" "$c2")"

c4="$(change api/z.py "long label

Area: one two three four five")"
check "trailers: labels cut to three words" '["one two three"]' "$(run "$c3" "$c4")"

c4b="$(change api/z2.py "labels that would end on a joining word

Area: Fixes: Home and Jobs
Area: Sign in
Area: Tips for the new clips")"
check "trailers: a cut never ends on a joining word; short labels stay as written" \
  '["Fixes: Home","Sign in","Tips"]' "$(run "$c4" "$c4b")"
c4c="$(change api/z3.py "a label of joining words only

Area: of the and for")"
check "trailers: a cut keeps at least one word" '["of"]' "$(run "$c4b" "$c4c")"

# 2. No trailers: changed files through web/areas.json, longest prefix wins, most-changed area first.
c5="$(
  change web/src/routes/settings/profile-picture/Pic.tsx "pic" >/dev/null
  change web/src/routes/settings/profile-picture/Crop.tsx "crop" >/dev/null
  change web/src/routes/settings/Theme.tsx "theme"
)"
check "files: longest prefix, most-changed first" '["Profile picture","Settings"]' "$(run "$c4c" "$c5")"

c6="$(change web/src/routes/settings-old/x.ts "lookalike folder is not settings")"
check "files: a prefix must end at a folder boundary" '["Improvements"]' "$(run "$c5" "$c6")"

c7="$(
  change web/src/routes/library/L.tsx "lib" >/dev/null
  change api/handler.py "api" >/dev/null
  change web/src/ignored/i.ts "non-string label is ignored" >/dev/null
  change web/src/routes/settings/S.tsx "settings" >/dev/null
  change web/src/routes/settings/profile-picture/P.tsx "pic"
)"
check "files: at most three, ties in path order" '["Behind the scenes","Library","Settings"]' "$(run "$c6" "$c7")"

# 3. Fallbacks.
c8="$(change docs/notes.md "no area here")"
check "unmapped files" '["Improvements"]' "$(run "$c7" "$c8")"
check "same commit" '["Improvements"]' "$(run "$c8" "$c8")"
check "prev unknown here" '["Improvements"]' "$(run 0123456789abcdef0123456789abcdef01234567 "$c8")"
check "prev is newer than new (rollback)" '["Improvements"]' "$(run "$c8" "$c7")"
check "short shas work" '["Profile picture","Settings"]' "$(run "${c4c:0:7}" "${c5:0:7}")"
check "missing areas file" '["Improvements"]' "$(AREAS_FILE="${work}/none.json" run "$c4c" "$c5")"
echo '[1,2]' >"${work}/bad.json"
check "areas file that is not an object" '["Improvements"]' "$(AREAS_FILE="${work}/bad.json" run "$c4c" "$c5")"

g checkout -q -b side "$base"
side="$(change other.txt "side branch

Area: Elsewhere")"
check "prev on another branch" '["Improvements"]' "$(run "$side" "$c8")"
g checkout -q main

# 3b. An "Area:" line split from Co-Authored-By by a blank line is not a git trailer, but still counts.
c9="$(change web/src/x.ts "split area line

Area: Clip numbers, This week

Co-Authored-By: someone <someone@example.com>")"
check "Area line outside the trailer block" '["Clip numbers","This week"]' "$(run "$c8" "$c9")"

# 4. Usage errors exit non-zero.
if run "$c8" >/dev/null; then
  check "missing argument fails" "exit 2" "exit 0"
else
  check "missing argument fails" "exit 2" "exit $?"
fi
if run "$c8" deadbeefdeadbeef >/dev/null; then
  check "unknown new commit fails" "exit 2" "exit 0"
else
  check "unknown new commit fails" "exit 2" "exit $?"
fi

# Every result is a JSON array of strings.
out="$(run "$base" "$c3")"
if jq -e 'type == "array" and all(.[]; type == "string")' <<<"$out" >/dev/null; then
  check "output is a JSON array of strings" ok ok
else
  check "output is a JSON array of strings" ok "$out"
fi

echo
echo "release-areas: ${passed} passed, ${failed} failed"
[ "$failed" -eq 0 ]
