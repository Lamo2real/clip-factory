#!/usr/bin/env bash
# Unit test for scripts/check-plan-deletes.sh (the delete gate in deploy.yml). Feeds it small hand-written plans in
# the `terraform show -json` shape and checks what it lets through. Needs bash and jq; writes only to a temp folder.
# Run: bash scripts/test-check-plan-deletes.sh   (ci.yml runs it on every push)
set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-plan-deletes.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

passed=0
failed=0
ok() { passed=$((passed + 1)); echo "ok   - $1"; }
not_ok() { failed=$((failed + 1)); echo "FAIL - $1" >&2; }

# plan <file> <address> <type> <actions as a JSON array>: one resource change.
plan() {
  jq -n --arg address "$2" --arg type "$3" --argjson actions "$4" \
    '{format_version: "1.2", resource_changes: [{address: $address, mode: "managed", type: $type, change: {actions: $actions}}]}' >"$1"
}

# expect <name> <exit code> <plan file> [text that must be in the output]
expect() {
  local name="$1" want="$2" file="$3" text="${4:-}" got=0 out
  out="$(bash "$SCRIPT" "$file" 2>&1)" || got=$?
  if [ "$got" != "$want" ]; then
    not_ok "${name}: exit ${got}, wanted ${want}: ${out}"
  elif [ -n "$text" ] && ! grep -qF -- "$text" <<<"$out"; then
    not_ok "${name}: the output does not say '${text}': ${out}"
  else
    ok "$name"
  fi
}

plan "${work}/table-delete.json" 'module.data.aws_dynamodb_table.this' aws_dynamodb_table '["delete"]'
expect "deleting the table stops the deploy" 1 "${work}/table-delete.json" "module.data.aws_dynamodb_table.this"

plan "${work}/table-replace.json" 'module.data.aws_dynamodb_table.this' aws_dynamodb_table '["delete","create"]'
expect "replacing the table stops the deploy" 1 "${work}/table-replace.json" "replace (delete, then create again empty)"

plan "${work}/table-replace-cbd.json" 'module.data.aws_dynamodb_table.this' aws_dynamodb_table '["create","delete"]'
expect "create-before-destroy replace of the table stops the deploy" 1 "${work}/table-replace-cbd.json"

plan "${work}/pool.json" 'module.auth.aws_cognito_user_pool.this' aws_cognito_user_pool '["delete","create"]'
expect "replacing the user pool stops the deploy" 1 "${work}/pool.json" "the owner's sign-in"

plan "${work}/secret.json" 'module.hooks.aws_secretsmanager_secret.state_key' aws_secretsmanager_secret '["delete"]'
expect "deleting a secret stops the deploy" 1 "${work}/secret.json" "aws_secretsmanager_secret"

plan "${work}/secret-version.json" 'module.notify.aws_secretsmanager_secret_version.vapid' aws_secretsmanager_secret_version '["delete","create"]'
expect "replacing a secret's current value stops the deploy" 1 "${work}/secret-version.json" "aws_secretsmanager_secret_version"

plan "${work}/secret-version-update.json" 'module.notify.aws_secretsmanager_secret_version.vapid' aws_secretsmanager_secret_version '["update"]'
expect "an in-place update of a secret version goes through" 0 "${work}/secret-version-update.json"

plan "${work}/bucket.json" 'module.storage.aws_s3_bucket.this["media"]' aws_s3_bucket '["delete"]'
expect "deleting the media bucket stops the deploy" 1 "${work}/bucket.json" 'aws_s3_bucket.this["media"]'

plan "${work}/vectors.json" 'module.vectors.aws_s3vectors_index.clips' aws_s3vectors_index '["delete","create"]'
expect "replacing the clip memory stops the deploy" 1 "${work}/vectors.json"

plan "${work}/table-update.json" 'module.data.aws_dynamodb_table.this' aws_dynamodb_table '["update"]'
expect "an in-place update of the table goes through" 0 "${work}/table-update.json" "deletes or replaces nothing"

plan "${work}/lambda-replace.json" 'module.stats.aws_lambda_function.fn["learn"]' aws_lambda_function '["delete","create"]'
expect "replacing a function (no owner data) goes through" 0 "${work}/lambda-replace.json"

plan "${work}/rule-create.json" 'module.stats.aws_cloudwatch_event_rule.learn_daily' aws_cloudwatch_event_rule '["create"]'
expect "creating a new rule goes through" 0 "${work}/rule-create.json"

jq -n '{format_version: "1.2"}' >"${work}/empty.json"
expect "a plan with no changes goes through" 0 "${work}/empty.json"

jq -n '{format_version: "1.2", resource_changes: [{address: "data.aws_s3_bucket.x", mode: "data", type: "aws_s3_bucket", change: {actions: ["delete"]}}]}' >"${work}/data-source.json"
expect "a data source is not a resource that holds data" 0 "${work}/data-source.json"

echo '{"hello": 1}' >"${work}/not-a-plan.json"
expect "a file that is not a plan is refused" 2 "${work}/not-a-plan.json"
expect "a missing file is refused" 2 "${work}/missing.json"

echo "${passed} passed, ${failed} failed"
[ "$failed" -eq 0 ]
