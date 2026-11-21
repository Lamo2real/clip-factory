#!/usr/bin/env bash
# Unit test for scripts/check-plan-clips-unchanged.sh (the "Clip Factory unchanged" plan check in deploy.yml,
# docs/CONTRACTS.md §45.15). Feeds it sample plans in the `terraform show -json` shape and checks what it lets through.
# The cf-prod-api change below has the shape the AWS provider (6.x) plans on every deploy: a new source_code_hash,
# last_modified unknown, and a new VERSION. Needs bash and jq; writes only to a temp folder; never calls AWS.
# Run: bash scripts/test-check-plan-clips-unchanged.sh   (scripts/test-deploy-workflow.sh runs it too)
set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-plan-clips-unchanged.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

passed=0
failed=0
ok() { passed=$((passed + 1)); echo "ok   - $1"; }
not_ok() { failed=$((failed + 1)); echo "FAIL - $1" >&2; }

# cf-prod-api as it is in the state, and the routes and integration of the HTTP API ($LATEST is literal JSON).
# shellcheck disable=SC2016
fn_before='{
  "function_name": "cf-prod-api", "handler": "clipfactory_api.http.handler", "runtime": "python3.13",
  "architectures": ["arm64"], "memory_size": 512, "timeout": 29, "role": "arn:aws:iam::123456789012:role/cf-prod-fn-api",
  "filename": "lambda.zip", "source_code_hash": "old-hash", "last_modified": "2026-11-20T10:00:00.000+0000",
  "version": "$LATEST", "qualified_arn": "arn:aws:lambda:eu-north-1:123456789012:function:cf-prod-api:$LATEST",
  "publish": false, "tags": {"Component": "api"},
  "environment": [{"variables": {"TABLE_NAME": "cf-prod-data", "CR_FINDER": "off", "HOOKS_URL": "https://h.example/v1", "VERSION": "oldsha"}}],
  "tracing_config": [{"mode": "Active"}], "logging_config": [{"log_format": "JSON", "log_group": "/aws/lambda/cf-prod-api"}]
}'
# What every deploy plans for it: the new zip (hash), last_modified unknown, the new release sha.
fn_after="$(jq -c '.source_code_hash = "new-hash" | del(.last_modified) | .environment[0].variables.VERSION = "newsha"' <<<"$fn_before")"
fn_unknown='{"last_modified": true, "architectures": [false], "environment": [{"variables": {}}], "tags": {}, "tracing_config": [{}], "logging_config": [{}]}'

# base_plan: a Lamo Stories deploy. Clip Factory's agent, cf-prod-api's role and policy and the existing routes are
# no-op; cf-prod-api gets the new zip and VERSION; Lamo Stories' modules and five routes are created.
base_plan() {
  jq -n --argjson before "$fn_before" --argjson after "$fn_after" --argjson unknown "$fn_unknown" '
    def r($a; $t; $acts): {address: $a, mode: "managed", type: $t, change: {actions: $acts, before: {}, after: {}, after_unknown: {}}};
    def route($k): {address: "module.api.aws_apigatewayv2_route.stories[\"\($k)\"]", mode: "managed", type: "aws_apigatewayv2_route",
      change: {actions: ["create"], before: null, after: {route_key: $k}, after_unknown: {id: true}}};
    {format_version: "1.2", resource_changes: [
      r("module.agent.terraform_data.image"; "terraform_data"; ["no-op"]),
      r("module.agent.aws_bedrockagentcore_agent_runtime.agent"; "aws_bedrockagentcore_agent_runtime"; ["no-op"]),
      r("module.agent.aws_iam_role_policy.agent"; "aws_iam_role_policy"; ["no-op"]),
      r("module.api.aws_iam_role.fn[\"api\"]"; "aws_iam_role"; ["no-op"]),
      r("module.api.aws_iam_role_policy.fn[\"api\"]"; "aws_iam_role_policy"; ["no-op"]),
      {address: "module.api.aws_lambda_function.fn[\"api\"]", mode: "managed", type: "aws_lambda_function",
       change: {actions: ["update"], before: $before, after: $after, after_unknown: $unknown}},
      r("module.api.aws_apigatewayv2_integration.api"; "aws_apigatewayv2_integration"; ["no-op"]),
      r("module.api.aws_apigatewayv2_route.authorized"; "aws_apigatewayv2_route"; ["no-op"]),
      r("module.api.aws_apigatewayv2_route.preflight"; "aws_apigatewayv2_route"; ["no-op"]),
      r("module.api.aws_apigatewayv2_route.health"; "aws_apigatewayv2_route"; ["no-op"]),
      r("module.api.aws_apigatewayv2_stage.http"; "aws_apigatewayv2_stage"; ["update"]),
      r("module.api.aws_apigatewayv2_integration.stories[0]"; "aws_apigatewayv2_integration"; ["create"]),
      route("ANY /v1/workspaces"), route("ANY /v1/workspaces/{proxy+}"), route("OPTIONS /v1/workspaces"),
      route("OPTIONS /v1/workspaces/{proxy+}"), route("GET /v1/stories-oauth/{platform}/callback"),
      r("module.api.aws_lambda_permission.stories[0]"; "aws_lambda_permission"; ["create"]),
      r("module.stories_agent.terraform_data.image"; "terraform_data"; ["delete", "create"]),
      r("module.stories_agent.aws_bedrockagentcore_agent_runtime.agent"; "aws_bedrockagentcore_agent_runtime"; ["update"]),
      r("module.stories_api.aws_lambda_function.fn"; "aws_lambda_function"; ["update"]),
      r("module.hooks.aws_lambda_function.fn"; "aws_lambda_function"; ["update"]),
      {address: "data.aws_caller_identity.me", mode: "data", type: "aws_caller_identity", change: {actions: ["read"]}}
    ]}'
}

# variant <file> <jq filter over the base plan>
variant() { base_plan | jq "$2" >"$1"; }
# set_change <address> <jq update of that change>
set_change() { printf '.resource_changes |= map(if .address == %s then %s else . end)' "$(jq -Rn --arg a "$1" '$a')" "$2"; }

# expect <name> <exit code> <plan file> [text that must be in the output] [text that must not be in it]
expect() {
  local name="$1" want="$2" file="$3" text="${4:-}" never="${5:-}" got=0 out
  out="$(GITHUB_STEP_SUMMARY="" bash "$SCRIPT" "$file" 2>&1)" || got=$?
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

base_plan >"${work}/base.json"
expect "a Lamo Stories deploy (new modules and routes, cf-prod-api's new zip and VERSION) goes through" 0 "${work}/base.json" \
  "the plan changes nothing of Clip Factory"
expect "it says cf-prod-api only gets this release's package" 0 "${work}/base.json" "gets this release's package and VERSION"
expect "it lists what the plan replaces (here only Lamo Stories' image build trigger)" 0 "${work}/base.json" \
  "  - module.stories_agent.terraform_data.image (replace)"

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

variant "${work}/hijack.json" '.resource_changes += [{address: "module.api.aws_apigatewayv2_route.stories[\"ANY /v1/jobs/{proxy+}\"]", mode: "managed", type: "aws_apigatewayv2_route", change: {actions: ["create"], after: {route_key: "ANY /v1/jobs/{proxy+}"}}}]'
expect "a Lamo Stories route on a Clip Factory path (/v1/jobs) stops the deploy" 1 "${work}/hijack.json" \
  "a Lamo Stories route would take a path that is not its own (ANY /v1/jobs/{proxy+})"

variant "${work}/stage.json" "$(set_change 'module.api.aws_apigatewayv2_stage.http' '.change.actions = ["update"]')"
expect "the stage gaining the callback's route throttle goes through" 0 "${work}/stage.json"

# --- other cases ---
variant "${work}/allowed.json" "$(set_change 'module.api.aws_lambda_function.fn["api"]' '.change.after.environment[0].variables.CR_FINDER = "on"')"
out="$(ALLOW_CLIPS_CHANGE=true GITHUB_STEP_SUMMARY="" bash "$SCRIPT" "${work}/allowed.json" 2>&1)" && got=0 || got=$?
if [ "$got" = 0 ] && grep -qF '::warning title=Clip Factory changes on purpose::module.api.aws_lambda_function.fn["api"]: cf-prod-api would change its environment key(s) CR_FINDER.' <<<"$out"; then
  ok "a Clip Factory change made on purpose (ALLOW_CLIPS_CHANGE=true) goes through with a warning per finding"
else
  not_ok "on purpose: exit ${got}: ${out}"
fi

summary_file="${work}/summary.md"
: >"$summary_file"
GITHUB_STEP_SUMMARY="$summary_file" bash "$SCRIPT" "${work}/api-policy.json" >/dev/null 2>&1 || true
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
