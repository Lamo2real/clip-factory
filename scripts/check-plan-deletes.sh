#!/usr/bin/env bash
# The delete gate (owner rule, 2026-11-17: "deploys must never reset my connected platforms or my data").
#
# Reads a saved Terraform plan as JSON (terraform show -json prod.tfplan) and fails when the plan would delete or
# replace anything that holds the owner's data:
#   - the DynamoDB table (jobs, clips, posts, numbers, learnings, connected accounts)
#   - the Cognito user pool and its users (the owner's sign-in)
#   - any Secrets Manager secret
#   - any S3 bucket and the S3 Vectors bucket and index (videos, skills, clip memory)
# A replace is a delete followed by a create, so it is refused too. Nothing is applied when this fails.
#
# Usage: bash scripts/check-plan-deletes.sh plan.json
# Exit 0: nothing protected is deleted. Exit 1: at least one is (each is named, with the reason, in plain words).
# Exit 2: the plan file is missing or is not a Terraform plan.
set -euo pipefail

plan="${1:-}"
if [ -z "$plan" ] || [ ! -f "$plan" ]; then
  echo "check-plan-deletes: give the path of the plan as JSON (terraform show -json prod.tfplan > plan.json)." >&2
  exit 2
fi
if ! jq -e 'has("resource_changes") or has("format_version")' "$plan" >/dev/null 2>&1; then
  echo "check-plan-deletes: ${plan} is not a Terraform plan in JSON." >&2
  exit 2
fi

# One line per protected resource the plan deletes: "<address>\t<type>\t<actions>".
hits="$(jq -r '
  def protected:
    {
      "aws_dynamodb_table": "it holds all of the owner'"'"'s jobs, clips, numbers, learnings and connected accounts",
      "aws_cognito_user_pool": "it holds the owner'"'"'s sign-in",
      "aws_cognito_user": "it is the owner'"'"'s sign-in",
      "aws_secretsmanager_secret": "it holds keys or tokens the app needs",
      "aws_secretsmanager_secret_version": "it is the key or token the app needs right now",
      "aws_s3_bucket": "it holds the owner'"'"'s videos, skills or the app",
      "aws_s3vectors_vector_bucket": "it holds the memory of the owner'"'"'s clips",
      "aws_s3vectors_index": "it holds the memory of the owner'"'"'s clips"
    };
  (.resource_changes // [])[]
  | select(.mode == "managed")
  | select(protected[.type] != null)
  | select((.change.actions // []) | index("delete"))
  | [.address, .type, ((.change.actions // []) | join("+")), protected[.type]]
  | @tsv
' "$plan")"

if [ -z "$hits" ]; then
  echo "Delete gate: the plan deletes or replaces nothing that holds the owner's data."
  exit 0
fi

echo "Delete gate: this deploy is stopped. The plan would delete or replace something that holds the owner's data:" >&2
while IFS=$'\t' read -r address type actions why; do
  case "$actions" in
    "delete") what="delete" ;;
    *) what="replace (delete, then create again empty)" ;;
  esac
  echo "  - ${address} (${type}): the plan would ${what} it, and ${why}." >&2
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "- \`${address}\` would be ${what%% *}d: ${why}." >>"$GITHUB_STEP_SUMMARY"
  fi
done <<<"$hits"
echo "Nothing was changed. Change the Terraform so this resource is kept (for example undo a renamed or moved" >&2
echo "resource, or add a moved block), then push again." >&2
exit 1
