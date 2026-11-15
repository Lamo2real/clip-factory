#!/usr/bin/env bash
# Regenerates the desktop app icons from the web app icon (web/public/icons/icon-512.png), keeping only the
# files the Mac and Windows bundles use. Run from anywhere after `npm ci` in desktop/:
#   bash desktop/scripts/make-icons.sh            (or: npm run icons, inside desktop/)
#   SOURCE=path/to/icon.png bash desktop/scripts/make-icons.sh
# deploy.yml runs it before every desktop build, so a new app icon always reaches the installers.
set -euo pipefail
DESKTOP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "${DESKTOP}/.." && pwd)"
SOURCE="${SOURCE:-${ROOT}/web/public/icons/icon-512.png}"
OUT="${DESKTOP}/src-tauri/icons"

[ -f "$SOURCE" ] || { echo "make-icons: ${SOURCE} not found" >&2; exit 1; }
[ -x "${DESKTOP}/node_modules/.bin/tauri" ] || { echo "make-icons: run 'npm ci' in ${DESKTOP} first" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

if ! "${DESKTOP}/node_modules/.bin/tauri" icon "$SOURCE" --output "${tmp}/out" >"${tmp}/log" 2>&1; then
  cat "${tmp}/log" >&2
  echo "make-icons: tauri icon failed" >&2
  exit 1
fi
tmp="${tmp}/out"

mkdir -p "$OUT"
for f in 32x32.png 128x128.png 128x128@2x.png icon.icns icon.ico icon.png; do
  [ -s "${tmp}/${f}" ] || { echo "make-icons: tauri icon did not produce ${f}" >&2; exit 1; }
  cp "${tmp}/${f}" "${OUT}/${f}"
done
echo "make-icons: wrote $(cd "$OUT" && echo *) to ${OUT}"
