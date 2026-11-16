#!/usr/bin/env bash
# Uploads the built web app to its S3 bucket and refreshes CloudFront. Run by deploy.yml.
#   WEB_BUCKET       bucket name (Terraform output web_bucket)
#   DISTRIBUTION_ID  CloudFront distribution (Terraform output distribution_id)
#   DIST_DIR         optional, default <repo>/web/dist (must already contain config.json)
#   WAIT             optional, "1" (default) waits for the invalidation so the smoke test sees this release
# Cache policy:
#   assets/**                          content-hashed by Vite: immutable for a year
#   index.html, sw.js, manifest, ...   revalidated on every load, so a release shows up at once
#   config.json                        no-store (docs/CONTRACTS.md §4)
#   version.json                       no-cache, uploaded after everything else (it starts the update banner)
#   downloads/manifest.json            no-cache; uploaded when DIST_DIR has one, else an empty one is created
#                                      when the bucket has none yet (deploy.yml's desktop jobs rewrite it)
#   everything else (icons, ...)       one hour: not hashed, but rarely changes
# New files go up before the entry points that reference them; stale files are deleted last. The downloads/
# prefix (desktop installers, built by deploy.yml's desktop jobs) and the TikTok URL-verification files
# (tiktok*.txt at the bucket root, uploaded from the app's Set up posting, docs/CONTRACTS.md §17.3) are never
# deleted here.
set -euo pipefail
: "${WEB_BUCKET:?WEB_BUCKET must be set}" "${DISTRIBUTION_ID:?DISTRIBUTION_ID must be set}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${DIST_DIR:-${ROOT}/web/dist}"
WAIT="${WAIT:-1}"
DEST="s3://${WEB_BUCKET}"

[ -f "${DIST_DIR}/index.html" ] || { echo "upload-web: ${DIST_DIR}/index.html not found; build the web app first" >&2; exit 1; }
[ -f "${DIST_DIR}/config.json" ] || { echo "upload-web: ${DIST_DIR}/config.json not found; run scripts/write-web-config.sh first" >&2; exit 1; }

IMMUTABLE="public, max-age=31536000, immutable"
NO_CACHE="no-cache"
SHORT="public, max-age=3600"

# Entry points: their names never change, so browsers and CloudFront must always revalidate them.
entry_points=(index.html sw.js registerSW.js manifest.webmanifest manifest.json)
exclude_entry=()
for f in "${entry_points[@]}" config.json version.json; do exclude_entry+=(--exclude "$f"); done
# Desktop installers and their manifest are managed by deploy.yml's desktop jobs, never by the web sync.
keep_downloads=(--exclude "downloads/*")
# TikTok checks its verification file at {APP_URL}/{filename}; the owner uploads it in the app, not in a build.
keep_verification=(--exclude "tiktok*.txt")

if [ -d "${DIST_DIR}/assets" ]; then
  aws s3 sync "${DIST_DIR}/assets" "${DEST}/assets" --cache-control "$IMMUTABLE" --only-show-errors
fi

aws s3 sync "$DIST_DIR" "$DEST" --exclude "assets/*" "${exclude_entry[@]}" "${keep_downloads[@]}" \
  --cache-control "$SHORT" --only-show-errors

for f in "${entry_points[@]}"; do
  [ -f "${DIST_DIR}/${f}" ] || continue
  extra=()
  case "$f" in
    *.webmanifest | manifest.json) extra=(--content-type "application/manifest+json") ;;
  esac
  aws s3 cp "${DIST_DIR}/${f}" "${DEST}/${f}" --cache-control "$NO_CACHE" ${extra[@]+"${extra[@]}"} --only-show-errors
done

aws s3 cp "${DIST_DIR}/config.json" "${DEST}/config.json" \
  --cache-control "no-store" --content-type "application/json" --only-show-errors

# Which desktop downloads exist (docs/CONTRACTS.md §12.1). The app must always find valid JSON here, so the
# first deploy creates an empty manifest; deploy.yml's desktop-manifest job rewrites it after each build.
manifest_key="downloads/manifest.json"
if [ -f "${DIST_DIR}/${manifest_key}" ]; then
  aws s3 cp "${DIST_DIR}/${manifest_key}" "${DEST}/${manifest_key}" \
    --cache-control "$NO_CACHE" --content-type "application/json" --only-show-errors
elif ! aws s3api head-object --bucket "$WEB_BUCKET" --key "$manifest_key" >/dev/null 2>&1; then
  desktop_version="$(jq -r '.version // ""' "${ROOT}/desktop/src-tauri/tauri.conf.json" 2>/dev/null || true)"
  jq -n --arg version "$desktop_version" '{version: $version, files: {}}' \
    | aws s3 cp - "${DEST}/${manifest_key}" \
      --cache-control "$NO_CACHE" --content-type "application/json" --only-show-errors
  echo "Created an empty ${manifest_key} (no desktop downloads yet)."
fi

# Last of the new files: a changed version.json tells open apps to show "What's new" and Reload, so everything
# it points to must already be in place.
if [ -f "${DIST_DIR}/version.json" ]; then
  aws s3 cp "${DIST_DIR}/version.json" "${DEST}/version.json" \
    --cache-control "$NO_CACHE" --content-type "application/json" --only-show-errors
else
  echo "upload-web: ${DIST_DIR}/version.json not found; open apps will not offer this release" >&2
fi

# Every file was just uploaded, so --size-only finds nothing to copy and only removes stale objects.
aws s3 sync "$DIST_DIR" "$DEST" --delete --size-only "${keep_downloads[@]}" "${keep_verification[@]}" --only-show-errors

invalidation_id="$(aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" \
  --paths "/*" --query Invalidation.Id --output text)"
echo "CloudFront invalidation ${invalidation_id} started."
if [ "$WAIT" = "1" ]; then
  aws cloudfront wait invalidation-completed --distribution-id "$DISTRIBUTION_ID" --id "$invalidation_id"
  echo "CloudFront invalidation ${invalidation_id} completed."
fi
