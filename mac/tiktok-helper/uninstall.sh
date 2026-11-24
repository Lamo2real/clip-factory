#!/bin/bash
# Stops Clip Factory's TikTok helper on this Mac and removes its launchd job. Keeps the Chrome profiles (the TikTok
# logins: chrome/ for Clip Factory, chrome-ws-*/ for Clips Funded), state and settings, so ./install.sh brings it back
# as it was.
#   ./uninstall.sh          stop and remove the job
#   ./uninstall.sh --all    also delete every Chrome profile, state, settings and the keychain items (the sign-in and
#                           the saved TikTok login)
set -euo pipefail
base="${CF_TT_BASE:-$HOME/Library/Application Support/Clip Factory TikTok}"
plist="$HOME/Library/LaunchAgents/com.clipfactory.tiktok-helper.plist"
launchctl bootout "gui/$(id -u)/com.clipfactory.tiktok-helper" 2>/dev/null || true
rm -f "$plist"
if [ "${1:-}" = "--all" ]; then
  for account in refresh-token tiktok-username tiktok-password; do
    security delete-generic-password -s "Clip Factory TikTok helper" -a "$account" >/dev/null 2>&1 || true
  done
  rm -rf "$base"
  echo "Removed the helper, its Chrome profiles, its state, its sign-in and the saved TikTok login."
else
  echo "Stopped. The TikTok logins and settings are kept in $base."
fi
