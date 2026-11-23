#!/usr/bin/env bash
# Unit test for scripts/check-plan-clips-unchanged.sh (the "Clip Factory unchanged" plan check in deploy.yml,
# docs/CONTRACTS.md §45.15). Feeds it sample plans in the `terraform show -json` shape, with small local git histories
# standing in for the commits since the live release, and checks what it lets through. The cf-prod-api and
# cf-prod-hooks changes below have the shape the AWS provider (6.x) plans on every deploy (read from a real deploy
# log): a new source_code_hash, last_modified unknown, and for cf-prod-api a new VERSION. Needs bash, git and jq;
# writes only to a temp folder; never calls AWS or the network.
# Run: bash scripts/test-check-plan-clips-unchanged.sh   (scripts/test-deploy-workflow.sh runs it too)
set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-plan-clips-unchanged.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

passed=0
failed=0
ok() { passed=$((passed + 1)); echo "ok   - $1"; }
not_ok() { failed=$((failed + 1)); echo "FAIL - $1" >&2; }

# ---------- Small histories: what was deployed last (live), and the commits after it ----------
# g <repo> <git args>: git with a fixed identity, no signing, no hooks, no global config.
g() {
  local repo="$1"
  shift
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -C "$repo" -c user.name=test -c user.email=test@example.invalid \
    -c commit.gpgsign=false -c core.hooksPath=/dev/null -c init.defaultBranch=main "$@"
}
# commit <repo> <message> <file>...: writes each file (new content) and commits them.
commit() {
  local repo="$1" message="$2" f
  shift 2
  for f in "$@"; do
    mkdir -p "${repo}/$(dirname "$f")"
    echo "$RANDOM $message" >>"${repo}/${f}"
  done
  g "$repo" add -A
  g "$repo" commit -q -m "$message"
}
# new_repo <name>: a repository with one commit (the live release); prints nothing, sets live_<name>.
new_repo() {
  local repo="${work}/$1"
  mkdir -p "$repo"
  g "$repo" init -q
  commit "$repo" "chore: the live release" README.md infra/modules/api/main.tf agent/src/x.py
}

# A Lamo Stories pull request that changes infra (the realistic case for this check).
new_repo stories
commit "${work}/stories" "feat: Lamo Stories' routes and its own API Lambda" infra/modules/stories_api/main.tf infra/modules/api/main.tf
# Clip Factory's own pull request (an "off until its switch" env flag on cf-prod-api, as Get paid's WHOP_CONNECT).
new_repo clips
commit "${work}/clips" "feat: Get paid collector (WHOP_CONNECT off until its switch)" infra/modules/api/main.tf api/src/clipfactory_api/getpaid.py
# The same Clip Factory change, its message holding the words "funded clips" only inside other words.
new_repo clips-words
commit "${work}/clips-words" "fix: skip unfunded clipsets in Get paid (WHOP_CONNECT off)" infra/modules/api/main.tf api/src/clipfactory_api/getpaid.py
# The same, with the words "clips funded" only inside other words.
new_repo clips-words-cf
commit "${work}/clips-words-cf" "fix: paperclips fundedness check in Get paid (WHOP_CONNECT off)" infra/modules/api/main.tf api/src/clipfactory_api/getpaid.py
# A Lamo Stories pull request merged with a merge commit; its own commits never name Lamo Stories.
new_repo merge
g "${work}/merge" checkout -q -b feat/stories-api-core
commit "${work}/merge" "wip: routes" stories/agent/src/x.py
commit "${work}/merge" "wip: more" infra/modules/api/main.tf
g "${work}/merge" checkout -q main
commit "${work}/merge" "fix: a Clip Factory fix landed first" web/src/features/x.tsx
g "${work}/merge" merge -q --no-ff -m "Merge pull request #115 from example/feat/stories-api-core" feat/stories-api-core
# A Lamo Stories fix that edits only a shared module, named in its message.
new_repo message
commit "${work}/message" "fix: the Lamo Stories callback throttle" infra/modules/api/main.tf
# The same, named with today's name "Clips Funded", and with the names between, "Clip Factory Stories", "Clip Stories"
# and "Funded Clips".
new_repo message-cf
commit "${work}/message-cf" "fix: the Clips Funded callback throttle" infra/modules/api/main.tf
new_repo message-clip
commit "${work}/message-clip" "fix: the Funded Clips callback throttle" infra/modules/api/main.tf
new_repo message-cfs
commit "${work}/message-cfs" "fix: the Clip Factory Stories callback throttle" infra/modules/api/main.tf
new_repo message-cs
commit "${work}/message-cs" "fix: the Clip Stories callback throttle" infra/modules/api/main.tf
# A Lamo Stories web-only change (nothing that feeds the plan) deployed together with a Clip Factory env flag.
new_repo web
commit "${work}/web" "feat: Lamo Stories dashboard" web/src/stories/screens/Dashboard.tsx
commit "${work}/web" "feat: campaign finder switch" infra/modules/api/main.tf
# A Lamo Stories change that edits Clip Factory's agent sources (the first round's imageModel in config/models.json).
new_repo agent
commit "${work}/agent" "feat: Lamo Stories image model" config/models.json stories/config/models.json
# Nothing new since the live release (a rerun of the same commit).
new_repo rerun

live_of() { g "${work}/$1" rev-parse "${2:-HEAD~1}"; }
LIVE_STORIES="$(live_of stories)"
LIVE_CLIPS="$(live_of clips)"
LIVE_CLIPS_WORDS="$(live_of clips-words)"
LIVE_CLIPS_WORDS_CF="$(live_of clips-words-cf)"
LIVE_MERGE="$(g "${work}/merge" rev-list --max-parents=0 HEAD)"
LIVE_MESSAGE="$(live_of message)"
LIVE_MESSAGE_CF="$(live_of message-cf)"
LIVE_MESSAGE_CLIP="$(live_of message-clip)"
LIVE_MESSAGE_CFS="$(live_of message-cfs)"
LIVE_MESSAGE_CS="$(live_of message-cs)"
LIVE_WEB="$(live_of web HEAD~2)"
LIVE_AGENT="$(live_of agent)"
LIVE_RERUN="$(live_of rerun HEAD)"

# ---------- Sample plans ----------
# cf-prod-api as it is in the state ($LATEST is literal JSON); VERSION is the live release.
# shellcheck disable=SC2016
fn_before='{
  "function_name": "cf-prod-api", "handler": "clipfactory_api.http.handler", "runtime": "python3.13",
  "architectures": ["arm64"], "memory_size": 512, "timeout": 29, "role": "arn:aws:iam::123456789012:role/cf-prod-fn-api",
  "filename": "lambda.zip", "source_code_hash": "old-hash", "last_modified": "2026-11-20T10:00:00.000+0000",
  "version": "$LATEST", "qualified_arn": "arn:aws:lambda:eu-north-1:123456789012:function:cf-prod-api:$LATEST",
  "publish": false, "tags": {"Component": "api"},
  "environment": [{"variables": {"TABLE_NAME": "cf-prod-data", "CR_FINDER": "off", "HOOKS_URL": "https://h.example/v1", "VERSION": "LIVE"}}],
  "tracing_config": [{"mode": "Active"}], "logging_config": [{"log_format": "JSON", "log_group": "/aws/lambda/cf-prod-api"}]
}'
fn_unknown='{"last_modified": true, "architectures": [false], "environment": [{"variables": {}}], "tags": {}, "tracing_config": [{}], "logging_config": [{}]}'
# cf-prod-hooks: the new zip, and Lamo Stories' one env key (the forward of w1. states, §45.13.3).
# shellcheck disable=SC2016
hooks_before='{
  "function_name": "cf-prod-hooks", "handler": "clipfactory_api.hooks.handler", "runtime": "python3.13",
  "memory_size": 512, "timeout": 29, "role": "arn:aws:iam::123456789012:role/cf-prod-hooks",
  "source_code_hash": "old-hash", "last_modified": "2026-11-20T10:00:00.000+0000", "version": "$LATEST",
  "environment": [{"variables": {"TABLE_NAME": "cf-prod-data", "APP_URL": "https://app.example", "SECRET_PREFIX": "cf-prod/platforms/"}}]
}'
hooks_after="$(jq -c '.source_code_hash = "new-hash" | del(.last_modified)
  | .environment[0].variables.STORIES_OAUTH_CALLBACK = "https://api.example/v1/stories-oauth"' <<<"$hooks_before")"
hooks_unknown='{"last_modified": true, "environment": [{"variables": {}}]}'
# The HTTP API's stage: the callback's route throttle is added (its logging_level is known only after apply).
# shellcheck disable=SC2016
stage_before='{
  "name": "$default", "auto_deploy": true, "deployment_id": "dep1", "tags": {"Component": "api"},
  "default_route_settings": [{"throttling_burst_limit": 50, "throttling_rate_limit": 20, "data_trace_enabled": false, "detailed_metrics_enabled": false, "logging_level": ""}],
  "route_settings": [], "access_log_settings": [{"destination_arn": "arn:aws:logs:eu-north-1:123456789012:log-group:/aws/apigateway/cf-prod-http", "format": "{}"}]
}'
stage_after="$(jq -c '.route_settings = [{"route_key": "GET /v1/stories-oauth/{platform}/callback", "throttling_rate_limit": 5, "throttling_burst_limit": 10, "data_trace_enabled": false, "detailed_metrics_enabled": false}]' <<<"$stage_before")"
stage_unknown='{"route_settings": [{"logging_level": true}], "default_route_settings": [{}], "access_log_settings": [{}], "tags": {}}'

# base_plan <live sha>: a Lamo Stories deploy. Clip Factory's agent, cf-prod-api's role and policy, the HTTP API, its
# authorizer and permission, hooks' role and policy and the existing routes are no-op; cf-prod-api gets the new zip and
# VERSION; hooks the new zip and STORIES_OAUTH_CALLBACK; the stage the callback's throttle; Lamo Stories' modules and
# five routes are created.
base_plan() {
  local live="$1"
  jq -n --arg live "$live" --arg sha "0123456789abcdef0123456789abcdef01234567" \
    --argjson before "$fn_before" --argjson unknown "$fn_unknown" \
    --argjson hb "$hooks_before" --argjson ha "$hooks_after" --argjson hu "$hooks_unknown" \
    --argjson sb "$stage_before" --argjson sa "$stage_after" --argjson su "$stage_unknown" '
    ($before | .environment[0].variables.VERSION = $live) as $fb
    | ($fb | .source_code_hash = "new-hash" | del(.last_modified) | .environment[0].variables.VERSION = $sha) as $fa
    | def r($a; $t; $acts): {address: $a, mode: "managed", type: $t, change: {actions: $acts, before: {}, after: {}, after_unknown: {}}};
    def route($k): {address: "module.api.aws_apigatewayv2_route.stories[\"\($k)\"]", mode: "managed", type: "aws_apigatewayv2_route",
      change: {actions: ["create"], before: null, after: {route_key: $k}, after_unknown: {id: true}}};
    {format_version: "1.2", resource_changes: [
      r("module.agent.terraform_data.image"; "terraform_data"; ["no-op"]),
      r("module.agent.aws_bedrockagentcore_agent_runtime.agent"; "aws_bedrockagentcore_agent_runtime"; ["no-op"]),
      r("module.agent.aws_iam_role_policy.agent"; "aws_iam_role_policy"; ["no-op"]),
      r("module.api.aws_iam_role.fn[\"api\"]"; "aws_iam_role"; ["no-op"]),
      r("module.api.aws_iam_role_policy.fn[\"api\"]"; "aws_iam_role_policy"; ["no-op"]),
      {address: "module.api.aws_lambda_function.fn[\"api\"]", mode: "managed", type: "aws_lambda_function",
       change: {actions: ["update"], before: $fb, after: $fa, after_unknown: $unknown}},
      r("module.api.aws_apigatewayv2_api.http"; "aws_apigatewayv2_api"; ["no-op"]),
      r("module.api.aws_apigatewayv2_authorizer.jwt"; "aws_apigatewayv2_authorizer"; ["no-op"]),
      r("module.api.aws_lambda_permission.http"; "aws_lambda_permission"; ["no-op"]),
      r("module.api.aws_apigatewayv2_integration.api"; "aws_apigatewayv2_integration"; ["no-op"]),
      r("module.api.aws_apigatewayv2_route.authorized"; "aws_apigatewayv2_route"; ["no-op"]),
      r("module.api.aws_apigatewayv2_route.preflight"; "aws_apigatewayv2_route"; ["no-op"]),
      r("module.api.aws_apigatewayv2_route.health"; "aws_apigatewayv2_route"; ["no-op"]),
      {address: "module.api.aws_apigatewayv2_stage.http", mode: "managed", type: "aws_apigatewayv2_stage",
       change: {actions: ["update"], before: $sb, after: $sa, after_unknown: $su}},
      r("module.api.aws_apigatewayv2_integration.stories[0]"; "aws_apigatewayv2_integration"; ["create"]),
      route("ANY /v1/workspaces"), route("ANY /v1/workspaces/{proxy+}"), route("OPTIONS /v1/workspaces"),
      route("OPTIONS /v1/workspaces/{proxy+}"), route("GET /v1/stories-oauth/{platform}/callback"),
      r("module.api.aws_lambda_permission.stories[0]"; "aws_lambda_permission"; ["create"]),
      r("module.hooks.aws_iam_role.fn"; "aws_iam_role"; ["no-op"]),
      r("module.hooks.aws_iam_role_policy.fn"; "aws_iam_role_policy"; ["no-op"]),
      {address: "module.hooks.aws_lambda_function.fn", mode: "managed", type: "aws_lambda_function",
       change: {actions: ["update"], before: $hb, after: $ha, after_unknown: $hu}},
      r("module.stories_agent.terraform_data.image"; "terraform_data"; ["delete", "create"]),
      r("module.stories_agent.aws_bedrockagentcore_agent_runtime.agent"; "aws_bedrockagentcore_agent_runtime"; ["update"]),
      r("module.stories_api.aws_lambda_function.fn"; "aws_lambda_function"; ["update"]),
      {address: "data.aws_caller_identity.me", mode: "data", type: "aws_caller_identity", change: {actions: ["read"]}}
    ]}'
}

# variant <file> <jq filter over the base plan> [live sha]: the base plan of a Lamo Stories deploy, changed.
variant() { base_plan "${3:-$LIVE_STORIES}" | jq "$2" >"$1"; }
# set_change <address> <jq update of that change>
set_change() { printf '.resource_changes |= map(if .address == %s then %s else . end)' "$(jq -Rn --arg a "$1" '$a')" "$2"; }

# expect <name> <exit code> <plan file> [text that must be in the output] [text that must not be in it]
# REPO (default: the Lamo Stories history) and ALLOW (ALLOW_CLIPS_CHANGE) are read from the environment.
expect() {
  local name="$1" want="$2" file="$3" text="${4:-}" never="${5:-}" got=0 out
  out="$(GITHUB_STEP_SUMMARY="" CLIPS_CHECK_GIT_DIR="${REPO:-${work}/stories}" ALLOW_CLIPS_CHANGE="${ALLOW:-}" \
    bash "$SCRIPT" "$file" 2>&1)" || got=$?
  if [ "$got" != "$want" ]; then
    not_ok "${name}: exit ${got}, wanted ${want}: ${out}"
  elif [ -n "$text" ] && ! grep -qF -- "$text" <<<"$out"; then
    not_ok "${name}: the output does not say '${text}': ${out}"
  elif [ -n "$never" ] && grep -qF -- "$never" <<<"$out"; then
    not_ok "${name}: the output says '${never}': ${out}"
  else
    ok "$name"
  fi
}

base_plan "$LIVE_STORIES" >"${work}/base.json"
expect "a Clips Funded deploy (new modules and routes, cf-prod-api's new zip and VERSION, hooks' one key, the callback throttle) goes through" 0 \
  "${work}/base.json" "the plan changes nothing of Clip Factory"
expect "it says cf-prod-api only gets this release's package" 0 "${work}/base.json" "gets this release's package and VERSION"
expect "it lists what the plan replaces (here only Clips Funded's image build trigger)" 0 "${work}/base.json" \
  "  - module.stories_agent.terraform_data.image (replace)"
expect "it names the Clips Funded commit it found since the live release" 0 "${work}/base.json" \
  "feat: Lamo Stories' routes and its own API Lambda"

# --- Clip Factory's agent ---
variant "${work}/agent-policy.json" "$(set_change 'module.agent.aws_iam_role_policy.agent' '.change.actions = ["update"]')"
expect "Clip Factory's agent role changing without a new agent tag stops the deploy" 1 "${work}/agent-policy.json" \
  "module.agent.aws_iam_role_policy.agent: Clip Factory's agent would update in place, but its image tag did not change"

variant "${work}/agent-runtime.json" "$(set_change 'module.agent.aws_bedrockagentcore_agent_runtime.agent' '.change.actions = ["update"]')"
expect "Clip Factory's runtime changing (for example a new env var) without a new agent tag stops the deploy" 1 "${work}/agent-runtime.json" \
  "module.agent.aws_bedrockagentcore_agent_runtime.agent"

variant "${work}/agent-tag.json" "$(set_change 'module.agent.terraform_data.image' '.change.actions = ["delete","create"]') | $(set_change 'module.agent.aws_bedrockagentcore_agent_runtime.agent' '.change.actions = ["update"]')"
expect "a new Clip Factory agent tag (its own change) lets its image and runtime update" 0 "${work}/agent-tag.json" \
  "Clip Factory's agent image tag changed in this deploy"

variant "${work}/agent-new.json" '.resource_changes += [{address: "module.agent.aws_iam_role_policy_attachment.x", mode: "managed", type: "aws_iam_role_policy_attachment", change: {actions: ["create"]}}]'
expect "a new resource under module.agent. without a new agent tag is refused too" 1 "${work}/agent-new.json" "module.agent.aws_iam_role_policy_attachment.x"

variant "${work}/agent-sources.json" "$(set_change 'module.agent.terraform_data.image' '.change.actions = ["delete","create"]') | $(set_change 'module.agent.aws_bedrockagentcore_agent_runtime.agent' '.change.actions = ["update"]')" "$LIVE_AGENT"
REPO="${work}/agent" expect "a Clips Funded commit that edits Clip Factory's agent sources (config/models.json) stops the deploy, new agent tag or not" 1 \
  "${work}/agent-sources.json" "this Clips Funded commit changes Clip Factory's agent sources"

# --- cf-prod-api's role and policy ---
variant "${work}/api-policy.json" "$(set_change 'module.api.aws_iam_role_policy.fn["api"]' '.change.actions = ["update"]')"
expect "cf-prod-api's policy changing stops the deploy" 1 "${work}/api-policy.json" "cf-prod-api's role or policy would update in place"

variant "${work}/api-role.json" "$(set_change 'module.api.aws_iam_role.fn["api"]' '.change.actions = ["delete","create"]')"
expect "cf-prod-api's role being replaced stops the deploy" 1 "${work}/api-role.json" "cf-prod-api's role or policy would replace"

# --- cf-prod-api's function ---
variant "${work}/api-env-new.json" "$(set_change 'module.api.aws_lambda_function.fn["api"]' '.change.after.environment[0].variables.STORY_FLOW_ARN = "arn:aws:lambda:eu-north-1:123456789012:function:cf-prod-story-flow:live"')"
expect "a new environment key on cf-prod-api (the first round's STORY_FLOW_ARN) stops the deploy" 1 "${work}/api-env-new.json" \
  "cf-prod-api would change its environment key(s) STORY_FLOW_ARN" "cf-prod-story-flow:live"

variant "${work}/api-env-value.json" "$(set_change 'module.api.aws_lambda_function.fn["api"]' '.change.after.environment[0].variables.CR_FINDER = "on" | .change.after.environment[0].variables.HOOKS_URL = "https://s3cr3t.example/v1"')"
expect "another environment value of cf-prod-api changing stops the deploy, naming only the keys" 1 "${work}/api-env-value.json" \
  "its environment key(s) CR_FINDER, HOOKS_URL" "s3cr3t"

variant "${work}/api-env-gone.json" "$(set_change 'module.api.aws_lambda_function.fn["api"]' '.change.after.environment[0].variables |= del(.TABLE_NAME)')"
expect "an environment key removed from cf-prod-api stops the deploy" 1 "${work}/api-env-gone.json" "TABLE_NAME"

for attr in 'handler = "clipfactory_api.workspaces.http.handler"' 'runtime = "python3.14"' 'memory_size = 1024' 'timeout = 60' \
  'role = "arn:aws:iam::123456789012:role/cf-prod-fn-stories-api"'; do
  key="${attr%% *}"
  variant "${work}/api-${key}.json" "$(set_change 'module.api.aws_lambda_function.fn["api"]' ".change.after.${attr}")"
  expect "cf-prod-api's ${key} changing stops the deploy" 1 "${work}/api-${key}.json" "cf-prod-api would change its ${key}"
done

variant "${work}/api-unknown.json" "$(set_change 'module.api.aws_lambda_function.fn["api"]' '.change.after_unknown.role = true | .change.after |= del(.role)')"
expect "an attribute of cf-prod-api that becomes unknown (other than the release ones) stops the deploy" 1 "${work}/api-unknown.json" "its role"

variant "${work}/api-replace.json" "$(set_change 'module.api.aws_lambda_function.fn["api"]' '.change.actions = ["delete","create"]')"
expect "cf-prod-api being replaced stops the deploy" 1 "${work}/api-replace.json" "cf-prod-api would replace"

variant "${work}/api-noop.json" "$(set_change 'module.api.aws_lambda_function.fn["api"]' '.change.actions = ["no-op"]')"
expect "cf-prod-api with no change at all goes through" 0 "${work}/api-noop.json" "the plan changes nothing" "gets this release's package"

# --- the HTTP API's existing routes and integration ---
variant "${work}/route-update.json" "$(set_change 'module.api.aws_apigatewayv2_route.authorized' '.change.actions = ["update"]')"
expect "an existing route changing (ANY /v1/{proxy+}) stops the deploy" 1 "${work}/route-update.json" \
  "module.api.aws_apigatewayv2_route.authorized: an HTTP API route or integration would update in place"

variant "${work}/route-delete.json" "$(set_change 'module.api.aws_apigatewayv2_route.preflight' '.change.actions = ["delete"]')"
expect "an existing route being deleted (the CORS preflight) stops the deploy" 1 "${work}/route-delete.json" "aws_apigatewayv2_route.preflight"

variant "${work}/integration.json" "$(set_change 'module.api.aws_apigatewayv2_integration.api' '.change.actions = ["update"]')"
expect "cf-prod-api's integration changing stops the deploy" 1 "${work}/integration.json" "aws_apigatewayv2_integration.api"

variant "${work}/stories-route-update.json" "$(set_change 'module.api.aws_apigatewayv2_route.stories["ANY /v1/workspaces"]' '.change.actions = ["update"] | .change.before = {route_key: "ANY /v1/workspaces"}') | $(set_change 'module.api.aws_apigatewayv2_integration.stories[0]' '.change.actions = ["update"]')"
expect "Clips Funded's own route and integration may change (they are not Clip Factory's)" 0 "${work}/stories-route-update.json"

# --- the shared HTTP API, its sign-in check, cf-prod-api's permission and the stage ---
variant "${work}/http-api.json" "$(set_change 'module.api.aws_apigatewayv2_api.http' '.change.actions = ["update"]')"
expect "the HTTP API's own settings changing (for example a new CORS header) stops the deploy" 1 "${work}/http-api.json" \
  "module.api.aws_apigatewayv2_api.http: the HTTP API's own settings (CORS and the rest, for every Clip Factory call) would update in place"

variant "${work}/authorizer.json" "$(set_change 'module.api.aws_apigatewayv2_authorizer.jwt' '.change.actions = ["update"]')"
expect "the JWT authorizer changing stops the deploy" 1 "${work}/authorizer.json" "the sign-in check of every Clip Factory route would update in place"

variant "${work}/permission.json" "$(set_change 'module.api.aws_lambda_permission.http' '.change.actions = ["delete","create"]')"
expect "API Gateway's permission to call cf-prod-api being replaced stops the deploy" 1 "${work}/permission.json" \
  "API Gateway's permission to call cf-prod-api would replace"

variant "${work}/stage-default.json" "$(set_change 'module.api.aws_apigatewayv2_stage.http' '.change.after.default_route_settings[0].throttling_rate_limit = 100')"
expect "the stage's default throttle changing stops the deploy" 1 "${work}/stage-default.json" \
  "the HTTP API's stage would change its default_route_settings"

variant "${work}/stage-clips-route.json" "$(set_change 'module.api.aws_apigatewayv2_stage.http' '.change.after.route_settings += [{route_key: "ANY /v1/{proxy+}", throttling_rate_limit: 1, throttling_burst_limit: 1}] | .change.after_unknown.route_settings += [{logging_level: true}]')"
expect "a route throttle on a Clip Factory route stops the deploy" 1 "${work}/stage-clips-route.json" "the HTTP API's stage would change its route_settings"

variant "${work}/stage-log.json" "$(set_change 'module.api.aws_apigatewayv2_stage.http' '.change.after.access_log_settings[0].format = "{\"x\":1}"')"
expect "the stage's access log changing stops the deploy" 1 "${work}/stage-log.json" "its access_log_settings"

variant "${work}/stage-replace.json" "$(set_change 'module.api.aws_apigatewayv2_stage.http' '.change.actions = ["delete","create"]')"
expect "the stage being replaced stops the deploy" 1 "${work}/stage-replace.json" "the HTTP API's stage would replace"

variant "${work}/stage-unknown-key.json" "$(set_change 'module.api.aws_apigatewayv2_stage.http' '.change.after.route_settings[0] |= del(.route_key) | .change.after_unknown.route_settings[0].route_key = true')"
expect "a stage route throttle whose route is not known before apply stops the deploy" 1 "${work}/stage-unknown-key.json" "its route_settings"

# --- cf-prod-hooks ---
variant "${work}/hooks-env.json" "$(set_change 'module.hooks.aws_lambda_function.fn' '.change.after.environment[0].variables.WS_SECRET_PREFIX = "cf-prod/workspaces/"')"
expect "another environment key on cf-prod-hooks (the first round's WS_SECRET_PREFIX) stops the deploy" 1 "${work}/hooks-env.json" \
  "cf-prod-hooks would change its environment key(s) WS_SECRET_PREFIX" "cf-prod/workspaces/"

variant "${work}/hooks-handler.json" "$(set_change 'module.hooks.aws_lambda_function.fn' '.change.after.handler = "clipfactory_api.workspaces.http.handler"')"
expect "cf-prod-hooks' handler changing stops the deploy" 1 "${work}/hooks-handler.json" "cf-prod-hooks would change its handler"

variant "${work}/hooks-callback.json" "$(set_change 'module.hooks.aws_lambda_function.fn' '.change.before.environment[0].variables.STORIES_OAUTH_CALLBACK = "https://old.example/v1/stories-oauth"')"
expect "STORIES_OAUTH_CALLBACK changing its value on cf-prod-hooks goes through" 0 "${work}/hooks-callback.json"

variant "${work}/hooks-callback-unknown.json" "$(set_change 'module.hooks.aws_lambda_function.fn' '.change.after.environment[0].variables |= del(.STORIES_OAUTH_CALLBACK) | .change.after_unknown.environment[0].variables.STORIES_OAUTH_CALLBACK = true')"
expect "STORIES_OAUTH_CALLBACK known only after apply goes through" 0 "${work}/hooks-callback-unknown.json"

variant "${work}/hooks-role.json" "$(set_change 'module.hooks.aws_iam_role.fn' '.change.actions = ["update"]')"
expect "cf-prod-hooks' role changing stops the deploy" 1 "${work}/hooks-role.json" "cf-prod-hooks' role or policy would update in place"

variant "${work}/hooks-policy.json" "$(set_change 'module.hooks.aws_iam_role_policy.fn' '.change.actions = ["update"]')"
expect "cf-prod-hooks' policy changing (the first round's workspace secrets) stops the deploy" 1 "${work}/hooks-policy.json" \
  "module.hooks.aws_iam_role_policy.fn: cf-prod-hooks' role or policy would update in place"

# --- the route rule: always stops, even for Clip Factory's own deploys or a run by hand ---
hijack='.resource_changes += [{address: "module.api.aws_apigatewayv2_route.stories[\"ANY /v1/jobs/{proxy+}\"]", mode: "managed", type: "aws_apigatewayv2_route", change: {actions: ["create"], after: {route_key: "ANY /v1/jobs/{proxy+}"}}}]'
variant "${work}/hijack.json" "$hijack"
expect "a Clips Funded route on a Clip Factory path (/v1/jobs) stops the deploy" 1 "${work}/hijack.json" \
  "a Clips Funded route would take a path that is not its own (ANY /v1/jobs/{proxy+})"
ALLOW=true expect "the route rule stops the deploy even with \"Clip Factory changes on purpose\"" 1 "${work}/hijack.json" \
  "does not let this through"
variant "${work}/hijack-clips.json" "$hijack" "$LIVE_CLIPS"
REPO="${work}/clips" expect "the route rule stops the deploy even when no Clips Funded work is in it" 1 "${work}/hijack-clips.json" "ANY /v1/jobs/{proxy+}"

# --- whose change: Clip Factory's own pull requests keep reaching production ---
whop="$(set_change 'module.api.aws_lambda_function.fn["api"]' '.change.after.environment[0].variables.WHOP_CONNECT = "off"')"
variant "${work}/clips-env.json" "$whop" "$LIVE_CLIPS"
REPO="${work}/clips" expect "Clip Factory's own new env flag on cf-prod-api (Get paid's WHOP_CONNECT) goes through as a notice" 0 "${work}/clips-env.json" \
  "::notice title=Clip Factory's own change::module.api.aws_lambda_function.fn[\"api\"]: cf-prod-api would change its environment key(s) WHOP_CONNECT."
variant "${work}/clips-words-env.json" "$whop" "$LIVE_CLIPS_WORDS"
REPO="${work}/clips-words" expect "a Clip Factory message with \"unfunded clipsets\" is not Clips Funded work: the env flag goes through as a notice" 0 \
  "${work}/clips-words-env.json" "::notice title=Clip Factory's own change::"
variant "${work}/clips-words-cf-env.json" "$whop" "$LIVE_CLIPS_WORDS_CF"
REPO="${work}/clips-words-cf" expect "a Clip Factory message with \"paperclips fundedness\" is not Clips Funded work: the env flag goes through as a notice" 0 \
  "${work}/clips-words-cf-env.json" "::notice title=Clip Factory's own change::"
variant "${work}/clips-agent.json" "$(set_change 'module.agent.aws_bedrockagentcore_agent_runtime.agent' '.change.actions = ["update"]') | $(set_change 'module.agent.aws_iam_role_policy.agent' '.change.actions = ["update"]')" "$LIVE_CLIPS"
REPO="${work}/clips" expect "Clip Factory's own agent switch or grant (no new tag) goes through as a notice" 0 "${work}/clips-agent.json" \
  "no Clips Funded work"
variant "${work}/clips-policy.json" "$(set_change 'module.api.aws_iam_role_policy.fn["api"]' '.change.actions = ["update"]')" "$LIVE_CLIPS"
REPO="${work}/clips" expect "Clip Factory's own grant on cf-prod-api goes through as a notice" 0 "${work}/clips-policy.json" "Clip Factory's own change"
variant "${work}/web-env.json" "$whop" "$LIVE_WEB"
REPO="${work}/web" expect "a Clips Funded web-only change deployed with Clip Factory's env flag lets the flag through" 0 "${work}/web-env.json" \
  "Clip Factory's own change"
variant "${work}/rerun-env.json" "$whop" "$LIVE_RERUN"
REPO="${work}/rerun" expect "a rerun of the live commit (nothing new) treats a change as Clip Factory's own" 0 "${work}/rerun-env.json" "Clip Factory's own change"

# --- whose change: Lamo Stories work in the deploy keeps the rule strict ---
variant "${work}/stories-env.json" "$whop"
expect "the same env flag with a Clips Funded infra commit in the deploy stops it and names the commit" 1 "${work}/stories-env.json" \
  "feat: Lamo Stories' routes and its own API Lambda"
variant "${work}/merge-env.json" "$whop" "$LIVE_MERGE"
REPO="${work}/merge" expect "a Clips Funded pull request merged with a merge commit counts as Clips Funded work" 1 "${work}/merge-env.json" \
  "Merge pull request #115"
variant "${work}/message-env.json" "$whop" "$LIVE_MESSAGE"
REPO="${work}/message" expect "a commit that names Lamo Stories (its old name) and edits a shared module counts as Clips Funded work" 1 "${work}/message-env.json" \
  "fix: the Lamo Stories callback throttle"
variant "${work}/message-cf-env.json" "$whop" "$LIVE_MESSAGE_CF"
REPO="${work}/message-cf" expect "a commit that names Clips Funded and edits a shared module counts as Clips Funded work" 1 \
  "${work}/message-cf-env.json" "fix: the Clips Funded callback throttle"
variant "${work}/message-clip-env.json" "$whop" "$LIVE_MESSAGE_CLIP"
REPO="${work}/message-clip" expect "a commit that names Funded Clips (its old name) and edits a shared module counts as Clips Funded work" 1 \
  "${work}/message-clip-env.json" "fix: the Funded Clips callback throttle"
variant "${work}/message-cfs-env.json" "$whop" "$LIVE_MESSAGE_CFS"
REPO="${work}/message-cfs" expect "a commit that names Clip Factory Stories and edits a shared module counts as Clips Funded work" 1 \
  "${work}/message-cfs-env.json" "fix: the Clip Factory Stories callback throttle"
variant "${work}/message-cs-env.json" "$whop" "$LIVE_MESSAGE_CS"
REPO="${work}/message-cs" expect "a commit that names Clip Stories and edits a shared module counts as Clips Funded work" 1 \
  "${work}/message-cs-env.json" "fix: the Clip Stories callback throttle"
variant "${work}/unknown-env.json" "$whop" "89abcdef0123456789abcdef0123456789abcdef"
expect "a live release that is not in the history stops a Clip Factory change (it cannot tell whose it is)" 1 "${work}/unknown-env.json" \
  "is not in this checkout's history"
variant "${work}/no-live-env.json" "$whop | $(set_change 'module.api.aws_lambda_function.fn["api"]' '.change.before.environment[0].variables |= del(.VERSION)')"
expect "a plan without a live release stops a Clip Factory change" 1 "${work}/no-live-env.json" "the plan has no live release"
REPO="${work}/missing" expect "a folder that is not a repository stops a Clip Factory change" 1 "${work}/stories-env.json" "Whose change: unknown"

# --- other cases ---
variant "${work}/allowed.json" "$(set_change 'module.api.aws_lambda_function.fn["api"]' '.change.after.environment[0].variables.CR_FINDER = "on"')"
ALLOW=true expect "a Clip Factory change made on purpose with Clips Funded work in the deploy (ALLOW_CLIPS_CHANGE=true) goes through with a warning per finding" 0 \
  "${work}/allowed.json" '::warning title=Clip Factory changes on purpose::module.api.aws_lambda_function.fn["api"]: cf-prod-api would change its environment key(s) CR_FINDER.'

summary_file="${work}/summary.md"
: >"$summary_file"
GITHUB_STEP_SUMMARY="$summary_file" CLIPS_CHECK_GIT_DIR="${work}/stories" bash "$SCRIPT" "${work}/api-policy.json" >/dev/null 2>&1 || true
# shellcheck disable=SC2016  # the backticks are Markdown in the summary, not a command
if grep -qF '`module.api.aws_iam_role_policy.fn["api"]`' "$summary_file"; then
  ok "a stopped deploy names the finding in the step summary"
else
  not_ok "summary: $(cat "$summary_file")"
fi

jq -n '{format_version: "1.2", resource_changes: [
  {address: "module.agent.terraform_data.image", mode: "managed", type: "terraform_data", change: {actions: ["create"]}},
  {address: "module.agent.aws_iam_role.agent", mode: "managed", type: "aws_iam_role", change: {actions: ["create"]}},
  {address: "module.api.aws_iam_role.fn[\"api\"]", mode: "managed", type: "aws_iam_role", change: {actions: ["create"]}},
  {address: "module.api.aws_lambda_function.fn[\"api\"]", mode: "managed", type: "aws_lambda_function", change: {actions: ["create"]}},
  {address: "module.api.aws_apigatewayv2_api.http", mode: "managed", type: "aws_apigatewayv2_api", change: {actions: ["create"]}},
  {address: "module.api.aws_apigatewayv2_stage.http", mode: "managed", type: "aws_apigatewayv2_stage", change: {actions: ["create"]}},
  {address: "module.hooks.aws_lambda_function.fn", mode: "managed", type: "aws_lambda_function", change: {actions: ["create"]}},
  {address: "module.api.aws_apigatewayv2_route.authorized", mode: "managed", type: "aws_apigatewayv2_route", change: {actions: ["create"]}}
]}' >"${work}/fresh.json"
expect "a stack deployed from nothing (everything created) goes through" 0 "${work}/fresh.json"

jq -n '{format_version: "1.2"}' >"${work}/empty.json"
expect "a plan with no changes goes through" 0 "${work}/empty.json"

echo '{"hello": 1}' >"${work}/not-a-plan.json"
expect "a file that is not a plan is refused" 2 "${work}/not-a-plan.json"
expect "a missing file is refused" 2 "${work}/missing.json"

echo "${passed} passed, ${failed} failed"
[ "$failed" -eq 0 ]
