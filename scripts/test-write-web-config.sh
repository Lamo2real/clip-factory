#!/usr/bin/env bash
# Unit test for scripts/write-web-config.sh. Feeds it saved `terraform output -json` fixtures and checks the
# config.json it writes (docs/CONTRACTS.md §4) or the error it stops with. Needs only bash and jq; never calls
# Terraform or AWS and writes only to a temporary folder.
# Run: bash scripts/test-write-web-config.sh   (ci.yml runs it on every push)
set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/write-web-config.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

passed=0
failed=0

ok() { passed=$((passed + 1)); echo "ok   - $1"; }
not_ok() { failed=$((failed + 1)); echo "FAIL - $1" >&2; }

# Terraform outputs as `terraform output -json` prints them. Extra outputs must be ignored.
fixture() {
  jq -n '{
    region:              {value: "eu-north-1", type: "string", sensitive: false},
    user_pool_id:        {value: "eu-north-1_AbCdEf123", type: "string", sensitive: false},
    user_pool_client_id: {value: "1example23clientid", type: "string", sensitive: false},
    api_url:             {value: "https://abc123.execute-api.eu-north-1.amazonaws.com/", type: "string", sensitive: false},
    ws_url:              {value: "wss://wsid42.execute-api.eu-north-1.amazonaws.com/live", type: "string", sensitive: false},
    hooks_url:           {value: "https://rest99.execute-api.eu-north-1.amazonaws.com/v1", type: "string", sensitive: false},
    app_url:             {value: "https://d111111abcdef8.cloudfront.net", type: "string", sensitive: false}
  }'
}

# run <name> <jq filter applied to the fixture>: runs the script; sets $out (config file) and $log, returns its exit code.
run() {
  local name="$1" filter="$2"
  out="${work}/${name}/config.json"
  log="${work}/${name}.log"
  fixture | jq "$filter" >"${work}/${name}.json"
  TF_OUTPUTS_FILE="${work}/${name}.json" OUT="$out" VERSION="0123456789abcdef0123456789abcdef01234567" \
    bash "$SCRIPT" >"$log" 2>&1
}

# 1. Every field, in the contract's shape, with the trailing slash of api_url removed.
if run full '.'; then
  expected='{"region":"eu-north-1","userPoolId":"eu-north-1_AbCdEf123","userPoolClientId":"1example23clientid","apiUrl":"https://abc123.execute-api.eu-north-1.amazonaws.com","wsUrl":"wss://wsid42.execute-api.eu-north-1.amazonaws.com/live","version":"0123456789abcdef0123456789abcdef01234567"}'
  if [ "$(jq -cS . "$out")" = "$(jq -cS . <<<"$expected")" ]; then
    ok "writes region, pool ids, apiUrl, wsUrl and version"
  else
    not_ok "unexpected config: $(cat "$out")"
  fi
  if [ "$(jq -r 'keys_unsorted | join(",")' "$out")" = "region,userPoolId,userPoolClientId,apiUrl,wsUrl,version" ]; then
    ok "writes exactly the contract's keys, nothing from other outputs"
  else
    not_ok "unexpected keys: $(jq -c 'keys_unsorted' "$out")"
  fi
else
  not_ok "the full fixture failed: $(cat "$log")"
fi

# 2. A trailing slash on ws_url is removed too.
if run ws_slash '.ws_url.value += "/"' && [ "$(jq -r .wsUrl "$out")" = "wss://wsid42.execute-api.eu-north-1.amazonaws.com/live" ]; then
  ok "removes a trailing slash from wsUrl"
else
  not_ok "trailing slash on ws_url: $(cat "$log")"
fi

# expect_failure <name> <filter> <text the error must contain>
expect_failure() {
  local name="$1" filter="$2" text="$3"
  if run "$name" "$filter"; then
    not_ok "${name}: expected a failure, got $(cat "$out")"
  elif [ -e "$out" ]; then
    not_ok "${name}: failed but still wrote ${out}"
  elif grep -qF "$text" "$log"; then
    ok "${name}: stops and says ${text}"
  else
    not_ok "${name}: error does not mention '${text}': $(cat "$log")"
  fi
}

expect_failure missing_ws 'del(.ws_url)' 'terraform output "ws_url" is missing or empty'
expect_failure empty_ws '.ws_url.value = ""' 'terraform output "ws_url" is missing or empty'
expect_failure ws_not_wss '.ws_url.value = "https://wsid42.execute-api.eu-north-1.amazonaws.com/live"' 'terraform output "ws_url" must start with wss://'
expect_failure ws_scheme_only '.ws_url.value = "wss://"' 'terraform output "ws_url" must start with wss://'
expect_failure api_not_https '.api_url.value = "http://abc123.execute-api.eu-north-1.amazonaws.com"' 'terraform output "api_url" must start with https://'
expect_failure missing_api 'del(.api_url)' 'terraform output "api_url" is missing or empty'
expect_failure missing_pool 'del(.user_pool_id)' 'terraform output "user_pool_id" is missing or empty'
expect_failure ws_not_string '.ws_url.value = 42' 'terraform output "ws_url" is missing or empty'

echo
echo "${passed} passed, ${failed} failed"
[ "$failed" -eq 0 ]
