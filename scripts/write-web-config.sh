#!/usr/bin/env bash
# Writes the web app's runtime config (docs/CONTRACTS.md §4) from Terraform's outputs:
#   { "region", "userPoolId", "userPoolClientId", "apiUrl", "version" }
# Inputs (all optional):
#   TF_OUTPUTS_FILE  a saved `terraform output -json`; when unset, the script runs it in TF_DIR
#   TF_DIR           Terraform root, default <repo>/infra/envs/prod
#   OUT              file to write, default <repo>/web/dist/config.json
#   VERSION          default $GITHUB_SHA, then `git rev-parse HEAD`
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="${TF_DIR:-${ROOT}/infra/envs/prod}"
OUT="${OUT:-${ROOT}/web/dist/config.json}"

command -v jq >/dev/null || { echo "write-web-config: jq is required" >&2; exit 1; }

if [ -n "${TF_OUTPUTS_FILE:-}" ]; then
  outputs="$(cat "$TF_OUTPUTS_FILE")"
else
  outputs="$(terraform -chdir="$TF_DIR" output -json)"
fi

version="${VERSION:-${GITHUB_SHA:-}}"
if [ -z "$version" ]; then
  version="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo dev)"
fi

# Fails (and names the output) when one is missing or empty, so a broken config never reaches users.
config="$(jq -e --arg version "$version" '
  def req($k): (.[$k].value // "") as $v
    | if ($v | type) == "string" and $v != "" then $v
      else error("terraform output \"\($k)\" is missing or empty") end;
  {
    region: req("region"),
    userPoolId: req("user_pool_id"),
    userPoolClientId: req("user_pool_client_id"),
    apiUrl: (req("api_url") | sub("/+$"; "")),
    version: $version
  }' <<<"$outputs")"

mkdir -p "$(dirname "$OUT")"
printf '%s\n' "$config" >"$OUT"
echo "Wrote ${OUT}:"
cat "$OUT"
