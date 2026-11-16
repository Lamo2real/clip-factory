#!/usr/bin/env bash
# Static checks of .github/workflows/*.yml that review found missing once. Needs only bash, grep and awk.
#   - deploy.yml passes alarm_email to Terraform, so the alarm topic always emails someone (§14.9).
#   - the desktop build job (npm ci, cargo, Tauri) cannot mint the deploy role's OIDC token; only the small
#     desktop-upload job can, and no other job that runs npm ci has it either.
#   - every action is pinned to a full commit SHA (with its version in a comment).
# Run: bash scripts/test-deploy-workflow.sh   (ci.yml runs it on every push)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
deploy="${DEPLOY_YML:-${root}/.github/workflows/deploy.yml}"

passed=0
failed=0
ok() { passed=$((passed + 1)); echo "ok   - $1"; }
not_ok() { failed=$((failed + 1)); echo "FAIL - $1" >&2; }

# job <name>: prints the lines of one top-level job of deploy.yml.
job() {
  awk -v name="  $1:" '
    $0 == name { on = 1; print; next }
    on && /^  [A-Za-z0-9_-]+:$/ { exit }
    on { print }
  ' "$deploy"
}

# 1. alarm_email reaches Terraform, from CF_ALARM_EMAIL or the owner's email.
if grep -Eq '^\s+TF_VAR_alarm_email: \$\{\{ secrets\.CF_ALARM_EMAIL \|\| secrets\.CF_OWNER_EMAIL \}\}$' "$deploy"; then
  ok "terraform plan gets TF_VAR_alarm_email (CF_ALARM_EMAIL, else CF_OWNER_EMAIL)"
else
  not_ok "deploy.yml must set TF_VAR_alarm_email in the terraform plan step"
fi

# 2. The desktop build job has no id-token; desktop-upload has it and runs no npm, cargo or tauri.
desktop="$(job desktop)"
upload="$(job desktop-upload)"
if [ -z "$desktop" ] || [ -z "$upload" ]; then
  not_ok "deploy.yml must have the jobs desktop and desktop-upload"
else
  if grep -Eq '^\s+id-token:' <<<"$desktop"; then
    not_ok "the desktop build job must not have id-token: write"
  elif grep -q 'configure-aws-credentials' <<<"$desktop"; then
    not_ok "the desktop build job must not assume the deploy role"
  else
    ok "the desktop build job (npm ci, cargo, tauri) cannot mint an OIDC token"
  fi
  if grep -q 'id-token: write' <<<"$upload" && ! grep -Eq 'npm |npx |cargo |tauri' <<<"$upload"; then
    ok "only desktop-upload assumes the role, and it runs no build tools"
  else
    not_ok "desktop-upload must have id-token: write and run no npm, npx, cargo or tauri"
  fi
fi

# 3. No job that runs npm ci (or npx) may also have id-token: write.
risky=()
while IFS= read -r name; do
  body="$(job "$name")"
  if grep -Eq '^\s+id-token: write' <<<"$body" && grep -Eq 'npm ci|npx ' <<<"$body"; then
    risky+=("$name")
  fi
done < <(grep -E '^  [A-Za-z0-9_-]+:$' "$deploy" | sed -E 's/^  ([^:]+):$/\1/')
if [ "${#risky[@]}" -eq 0 ]; then
  ok "no deploy job runs npm and holds id-token: write"
else
  not_ok "jobs that run npm and can mint an OIDC token: ${risky[*]}"
fi

# 4. Every action, in every workflow, is pinned to a 40-character commit SHA with a version comment.
unpinned="$(grep -HnE '^\s*(- )?uses: ' "${root}"/.github/workflows/*.yml \
  | grep -vE 'uses: [A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[0-9a-f]{40} # \S+' || true)"
if [ -z "$unpinned" ]; then
  ok "every action is pinned to a commit SHA"
else
  not_ok "actions not pinned to a commit SHA (with '# <version>'):"$'\n'"${unpinned}"
fi

echo "${passed} passed, ${failed} failed"
[ "$failed" -eq 0 ]
