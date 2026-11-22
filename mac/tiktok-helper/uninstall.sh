#!/bin/bash
# Stops Clip Factory's TikTok helper on this Mac and removes its launchd job. Keeps the Chrome profile (the TikTok
# login), state and settings, so ./install.sh brings it back as it was.
#   ./uninstall.sh          stop and remove the job
#   ./uninstall.sh --all    also delete the Chrome profile, state, settings and the keychain sign-in
set -euo pipefail
base="${CF_TT_BASE:-$HOME/Library/Application Support/Clip Factory TikTok}"
plist="$HOME/Library/LaunchAgents/com.clipfactory.tiktok-helper.plist"
launchctl bootout "gui/$(id -u)/com.clipfactory.tiktok-helper" 2>/dev/null || true
rm -f "$plist"
if [ "${1:-}" = "--all" ]; then
  security delete-generic-password -s "Clip Factory TikTok helper" -a refresh-token >/dev/null 2>&1 || true
  rm -rf "$base"
  echo "Removed the helper, its Chrome profile, its state and its sign-in."
else
  echo "Stopped. The TikTok login and settings are kept in $base."
fi
