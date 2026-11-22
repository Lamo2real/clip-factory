#!/bin/bash
# Installs (or updates) Clip Factory's TikTok helper on this Mac. Copies the helper out of the repo, installs its one
# dependency, and loads the launchd job. Safe to run again: the Chrome profile, state and settings are kept.
#   ./install.sh            install or update, and start the job
#   ./install.sh --no-start install or update only (the job is not loaded)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
base="${CF_TT_BASE:-$HOME/Library/Application Support/Clip Factory TikTok}"
app="$base/app"
plist="$HOME/Library/LaunchAgents/com.clipfactory.tiktok-helper.plist"
node="$(command -v node)"
[ -n "$node" ] || { echo "Node is missing (brew install node)." >&2; exit 1; }

mkdir -p "$app"
rsync -a --delete --exclude node_modules --exclude test "$here/" "$app/"
(cd "$app" && npm ci --omit=dev --no-audit --no-fund --silent)

sed -e "s#@NODE@#$node#g" -e "s#@APP@#$app#g" -e "s#@BASE@#$base#g" \
  "$here/launchd/com.clipfactory.tiktok-helper.plist" > "$plist"

launchctl bootout "gui/$(id -u)/com.clipfactory.tiktok-helper" 2>/dev/null || true
if [ "${1:-}" != "--no-start" ]; then
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "Clip Factory TikTok helper is running (every minute). Log: $base/helper.log"
else
  echo "Installed, not started. Start it: launchctl bootstrap gui/$(id -u) \"$plist\""
fi
