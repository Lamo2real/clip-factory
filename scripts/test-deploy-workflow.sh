#!/usr/bin/env bash
# Static checks of .github/workflows/*.yml that review found missing once. Needs only bash, grep and awk.
# deploy.yml releases prod; desktop.yml builds the desktop apps after it, outside the deploy-prod lock.
#   - deploy.yml passes alarm_email to Terraform, so the alarm topic always emails someone (§14.9).
#   - the desktop build job (npm ci, cargo, Tauri) cannot mint the deploy role's OIDC token; only the small
#     desktop-upload job can, and no other job (in either workflow) that runs npm ci has it either.
#   - every action is pinned to a full commit SHA (with its version in a comment).
#   - the updater signing key reaches only the desktop build job (which has no OIDC token), and latest.json is
#     written by desktop-manifest, which runs after desktop-upload (§12.6).
#   - the smoke job checks that the deployed Ask model reads a picture (ADR-53).
#   - the tool manifest's key (CF_TOOLS_SIGNING_KEY) reaches only desktop-tools, which has no OIDC token; the pinned
#     tools never rebuild the app (desktop-plan's hash leaves out desktop/tools), and the app build gets the media
#     bucket's host (§35).
#   - the desktop jobs are in desktop.yml, not deploy.yml (so they never hold the deploy-prod lock); desktop.yml
#     runs only after a successful deploy, builds that deploy's commit, keeps the deploy's run number as the
#     version (its own would go down) and never cancels a started run.
#   - desktop.yml trusts only a push or run by hand of deploy in this repository, never a fork's pull request
#     (which can also complete as "deploy" on a branch it calls main), in its concurrency group, resolve's `if`, the
#     run-by-hand lookup and a second look at the run through the API.
# Run: bash scripts/test-deploy-workflow.sh   (ci.yml runs it on every push)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
deploy="${DEPLOY_YML:-${root}/.github/workflows/deploy.yml}"
desktop_wf="${DESKTOP_YML:-${root}/.github/workflows/desktop.yml}"

passed=0
failed=0
ok() { passed=$((passed + 1)); echo "ok   - $1"; }
not_ok() { failed=$((failed + 1)); echo "FAIL - $1" >&2; }

# job <name> [file]: prints the lines of one job of a workflow (default deploy.yml).
job() {
  awk -v name="  $1:" '
    $0 == "jobs:" { jobs = 1; next }
    jobs && $0 == name { on = 1; print; next }
    on && /^  [A-Za-z0-9_-]+:$/ { exit }
    on { print }
  ' "${2:-$deploy}"
}

# job_names <file>: the job names of one workflow.
job_names() {
  awk '$0 == "jobs:" { on = 1; next } on && /^  [A-Za-z0-9_-]+:$/ { sub(/^  /, ""); sub(/:$/, ""); print }' "$1"
}

# all_jobs: "<file> <job>" for every job of deploy.yml and desktop.yml, so a rule holds wherever a job lives.
all_jobs() {
  local f name
  for f in "$deploy" "$desktop_wf"; do
    while IFS= read -r name; do printf '%s %s\n' "$f" "$name"; done < <(job_names "$f")
  done
}

# 1. alarm_email reaches Terraform, from CF_ALARM_EMAIL or the owner's email.
if grep -Eq '^\s+TF_VAR_alarm_email: \$\{\{ secrets\.CF_ALARM_EMAIL \|\| secrets\.CF_OWNER_EMAIL \}\}$' "$deploy"; then
  ok "terraform plan gets TF_VAR_alarm_email (CF_ALARM_EMAIL, else CF_OWNER_EMAIL)"
else
  not_ok "deploy.yml must set TF_VAR_alarm_email in the terraform plan step"
fi

# 2. The desktop build job has no id-token; desktop-upload has it and runs no npm, cargo or tauri.
desktop="$(job desktop "$desktop_wf")"
upload="$(job desktop-upload "$desktop_wf")"
if [ -z "$desktop" ] || [ -z "$upload" ]; then
  not_ok "desktop.yml must have the jobs desktop and desktop-upload"
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
while read -r file name; do
  body="$(job "$name" "$file")"
  if grep -Eq '^\s+id-token: write' <<<"$body" && grep -Eq 'npm ci|npx ' <<<"$body"; then
    risky+=("$name")
  fi
done < <(all_jobs)
if [ "${#risky[@]}" -eq 0 ]; then
  ok "no deploy or desktop job runs npm and holds id-token: write"
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

# 5. The delete gate runs on the saved plan after terraform plan and before terraform apply (owner rule 2026-11-17).
infra="$(job infra)"
plan_line="$(grep -n 'terraform plan -input=false -out=prod.tfplan' <<<"$infra" | head -1 | cut -d: -f1)"
gate_line="$(grep -n 'scripts/check-plan-deletes.sh' <<<"$infra" | head -1 | cut -d: -f1)"
apply_line="$(grep -n 'terraform apply -input=false -auto-approve prod.tfplan' <<<"$infra" | head -1 | cut -d: -f1)"
if [ -n "$plan_line" ] && [ -n "$gate_line" ] && [ -n "$apply_line" ] \
  && [ "$plan_line" -lt "$gate_line" ] && [ "$gate_line" -lt "$apply_line" ] \
  && grep -q 'terraform show -json prod.tfplan' <<<"$infra"; then
  ok "the delete gate checks the saved plan between terraform plan and terraform apply"
else
  not_ok "deploy.yml must run scripts/check-plan-deletes.sh on terraform show -json prod.tfplan before the apply"
fi

# 5b. The deploy drain (docs/CONTRACTS.md §30.7) runs after the delete gate and before the apply.
drain_line="$(grep -n 'scripts/wait-for-jobs.sh' <<<"$infra" | head -1 | cut -d: -f1)"
if [ -n "$drain_line" ] && [ -n "$gate_line" ] && [ -n "$apply_line" ] \
  && [ "$gate_line" -lt "$drain_line" ] && [ "$drain_line" -lt "$apply_line" ]; then
  ok "the deploy drain waits for running jobs between the delete gate and terraform apply"
else
  not_ok "deploy.yml must run scripts/wait-for-jobs.sh after the delete gate and before the apply"
fi

# 6. The updater signing key (TAURI_SIGNING_PRIVATE_KEY and its password) is read only by the desktop build job, and
#    desktop-plan, which may only ask whether it is set.
key_users=()
while read -r file name; do
  body="$(job "$name" "$file")"
  if grep -q 'secrets\.TAURI_SIGNING_PRIVATE_KEY' <<<"$body"; then key_users+=("$name"); fi
done < <(all_jobs)
plan_refs="$(job desktop-plan "$desktop_wf" | grep -o 'secrets\.TAURI_SIGNING_PRIVATE_KEY[^}]*' || true)"
if [ "${key_users[*]:-}" = "desktop-plan desktop" ] \
  && [ "$plan_refs" = "secrets.TAURI_SIGNING_PRIVATE_KEY != '' " ] \
  && [ "$(grep -c 'secrets\.TAURI_SIGNING_PRIVATE_KEY' <<<"$desktop")" -eq 2 ]; then
  ok "the updater signing key reaches only the desktop build job (desktop-plan only checks it is set)"
else
  not_ok "secrets.TAURI_SIGNING_PRIVATE_KEY* used outside the desktop build step: ${key_users[*]:-none}; desktop-plan: ${plan_refs:-none}"
fi

# 7. latest.json is written only by desktop-manifest, after desktop-upload has put the bundles in place.
writers=()
while read -r file name; do
  if job "$name" "$file" | grep -q '/downloads/latest\.json" '; then writers+=("$name"); fi
done < <(all_jobs)
if [ "${writers[*]:-}" = "desktop-manifest" ] \
  && job desktop-manifest "$desktop_wf" | grep -Eq '^    needs: \[.*desktop-upload.*\]$'; then
  ok "only desktop-manifest writes downloads/latest.json, after desktop-upload"
else
  not_ok "downloads/latest.json must be written only by desktop-manifest, which needs desktop-upload (writers: ${writers[*]:-none})"
fi

# 8. The smoke job checks Ask with the real model (ADR-53): it invokes the worker with {"smoke":"ask"}, needs
#    smoke_ok, and runs no npm (it holds id-token: write).
smoke="$(job smoke)"
if grep -q '"smoke":"ask"' <<<"$smoke" && grep -q "outcome == \"smoke_ok\"" <<<"$smoke" && ! grep -Eq 'npm |npx ' <<<"$smoke"; then
  ok "the smoke job asks the deployed Ask model about a picture and needs smoke_ok"
else
  not_ok "the smoke job must invoke the Ask worker with {\"smoke\":\"ask\"} and require outcome smoke_ok"
fi

# 9. ask_enabled = false really skips the Ask check (jq's `//` would turn false into true), and only access or
#    not_found warn instead of failing.
enabled_expr="$(grep -o "jq -r '[^']*ask_enabled[^']*'" <<<"$smoke" | head -1 | sed -E "s/^jq -r '(.*)'$/\1/")"
if [ -n "$enabled_expr" ] \
  && [ "$(jq -r "$enabled_expr" <<<'{"ask_enabled":{"value":false}}')" = "false" ] \
  && [ "$(jq -r "$enabled_expr" <<<'{"ask_enabled":{"value":true}}')" = "true" ] \
  && [ "$(jq -r "$enabled_expr" <<<'{}')" = "true" ] \
  && grep -q 'reason" = "not_found"' <<<"$smoke" && ! grep -q 'turn on model access' <<<"$smoke"; then
  ok "ask_enabled = false skips the Ask check, and the access hint names today's Bedrock steps"
else
  not_ok "the Ask check must read ask_enabled = false as off and give the Model catalog steps (expr: ${enabled_expr:-none})"
fi

# 10. The agent image is built on native ARM64, never under QEMU: its PO token self-check runs Deno, which crashes at
#     random with SIGILL (exit -4) under emulation. Both the deploy's image build (infra) and CI's (agent) are checked.
ci="${CI_YML:-${root}/.github/workflows/ci.yml}"
ci_agent="$(awk '$0 == "  agent:" { on = 1; print; next } on && /^  [A-Za-z0-9_-]+:$/ { exit } on { print }' "$ci")"
if grep -Eq '^    runs-on: ubuntu-24.04-arm$' <<<"$infra" && ! grep -q 'setup-qemu-action' <<<"$infra" \
  && grep -Eq '^    runs-on: ubuntu-24.04-arm$' <<<"$ci_agent" && ! grep -q 'setup-qemu-action' <<<"$ci_agent" \
  && grep -q 'agent/Dockerfile' <<<"$ci_agent" && grep -q '^RUN python -m clipfactory_agent.pot$' "${root}/agent/Dockerfile"; then
  ok "the agent image (and its PO token self-check) is built on native ARM64 in CI and in the deploy, never under QEMU"
else
  not_ok "deploy.yml infra and ci.yml agent must run on ubuntu-24.04-arm without setup-qemu-action, and the Dockerfile must run the PO token self-check"
fi

# 11. Mac fetches it (§35.4): the tool manifest's signing key reaches only desktop-tools, which cannot mint an OIDC
#     token and is never the updater key's job; desktop-tools-upload assumes the role but never sees the key.
tools="$(job desktop-tools "$desktop_wf")"
tools_upload="$(job desktop-tools-upload "$desktop_wf")"
tool_key_users=()
while read -r file name; do
  if job "$name" "$file" | grep -q 'secrets\.CF_TOOLS_SIGNING_KEY'; then tool_key_users+=("$name"); fi
done < <(all_jobs)
if [ "${tool_key_users[*]:-}" = "desktop-tools" ] \
  && ! grep -Eq '^\s+id-token:' <<<"$tools" && ! grep -q 'configure-aws-credentials' <<<"$tools" \
  && ! grep -q 'TAURI_SIGNING' <<<"$tools" \
  && grep -q 'id-token: write' <<<"$tools_upload" && ! grep -q 'CF_TOOLS_SIGNING_KEY' <<<"$tools_upload"; then
  ok "the tool manifest key reaches only desktop-tools (no OIDC token there), never the updater key"
else
  not_ok "CF_TOOLS_SIGNING_KEY must be used only in desktop-tools, which must have no id-token (users: ${tool_key_users[*]:-none})"
fi

# 12. Bumping a pinned tool never rebuilds the app, and the app build knows where to send the Mac's video.
plan="$(job desktop-plan "$desktop_wf")"
# shellcheck disable=SC2016  # the literal text "$MEDIA_HOST" is what the workflow must contain
if grep -q "'!desktop/tools/\*\*'" <<<"$plan" && grep -q 'CF_MEDIA_HOST: ' <<<"$desktop" \
  && grep -q '"$MEDIA_HOST"' <<<"$plan"; then
  ok "desktop/tools is left out of the app's source hash, and the app build gets the media bucket host"
else
  not_ok "desktop-plan must hash desktop/** without desktop/tools/** and the desktop build must set CF_MEDIA_HOST"
fi

# 13. The desktop jobs never hold the deploy-prod lock: they live in desktop.yml, which runs after a successful deploy
#     of main, from the values its infra job hands off, and builds exactly the deployed commit.
resolve="$(job resolve "$desktop_wf")"
deploy_desktop_jobs="$(job_names "$deploy" | grep '^desktop' || true)"
checkouts="$(grep -c 'uses: actions/checkout@' "$desktop_wf" || true)"
# shellcheck disable=SC2016  # literal workflow expressions
deployed_refs="$(grep -cF 'ref: ${{ needs.resolve.outputs.sha }}' "$desktop_wf" || true)"
# shellcheck disable=SC2016
if [ -z "$deploy_desktop_jobs" ] \
  && grep -Eq '^    workflows: \[deploy\]$' "$desktop_wf" && grep -Eq '^    branches: \[main\]$' "$desktop_wf" \
  && grep -qF "github.event.workflow_run.conclusion == 'success'" <<<"$resolve" \
  && grep -qF 'SHA: ${{ github.event.workflow_run.head_sha }}' <<<"$resolve" \
  && [ "$checkouts" -gt 0 ] && [ "$checkouts" = "$deployed_refs" ] \
  && job infra | grep -q 'name: desktop-handoff' \
  && grep -q 'name: desktop-handoff' <<<"$resolve" && grep -qF 'run-id: ${{ steps.run.outputs.run_id }}' <<<"$resolve"; then
  ok "the desktop jobs run in desktop.yml after a successful deploy, on the deployed commit, from infra's hand-off"
else
  not_ok "desktop.yml must hold every desktop job (deploy.yml: ${deploy_desktop_jobs:-none}), run on deploy's success, check out workflow_run.head_sha in every job (${deployed_refs}/${checkouts}) and read infra's desktop-handoff"
fi

# 13b. Only this repository's push or run-by-hand deploys get desktop.yml's secrets and the deploy role: a fork's pull
#      request can run a deploy.yml of its own, named deploy, from a branch it calls main.
group_line="$(awk '/^concurrency:$/ { on = 1; next } on && /^[^ ]/ { exit } on && /^  group:/' "$desktop_wf")"
trusted_repo='github.event.workflow_run.head_repository.full_name == github.repository'
trusted_event="github.event.workflow_run.event == 'push'"
# shellcheck disable=SC2016  # literal shell and jq text the workflow must contain
if grep -qF "$trusted_repo" <<<"$resolve" && grep -qF "$trusted_event" <<<"$resolve" \
  && grep -qF "$trusted_repo" <<<"$group_line" && grep -qF "$trusted_event" <<<"$group_line" \
  && grep -qF "github.ref == 'refs/heads/main'" <<<"$group_line" \
  && grep -qF '.head_repository.full_name == $repo' <<<"$resolve" \
  && grep -qF 'want="${REPO} main .github/workflows/deploy.yml success ${SHA} ${RUN_NUMBER}"' <<<"$resolve" \
  && grep -qF 'compare/${SHA}...main' <<<"$resolve"; then
  ok "desktop.yml builds and signs only for this repository's push or run-by-hand deploys of main"
else
  not_ok "desktop.yml must check workflow_run.event and head_repository in its concurrency group and resolve, filter the run-by-hand lookup the same way, and re-check the run and its commit through the API"
fi

# 14. The version stays 1.<deploy run number>.0 (desktop.yml's own number started again at 1, and the updater never
#     takes a lower version), and a started desktop run is never cancelled (desktop-prod, cancel-in-progress: false).
# shellcheck disable=SC2016
if ! grep -Eq '\$\{\{[^}]*github\.run_number' "$desktop_wf" \
  && grep -qF 'RUN_NUMBER: ${{ github.event.workflow_run.run_number }}' <<<"$resolve" \
  && grep -qF 'RUN_NUMBER: ${{ needs.resolve.outputs.run_number }}' <<<"$plan" \
  && grep -qF 'version="1.${RUN_NUMBER}.0"' <<<"$plan" \
  && grep -qF "&& 'desktop-prod' ||" "$desktop_wf" \
  && awk '/^concurrency:$/ { on = 1; next } on && /^[^ ]/ { exit } on' "$desktop_wf" | grep -Eq '^  cancel-in-progress: false$' \
  && awk '/^concurrency:$/ { on = 1; next } on && /^[^ ]/ { exit } on' "$deploy" | grep -Eq '^  group: deploy-prod$'; then
  ok "desktop versions are 1.<deploy run number>.0, and desktop.yml never cancels a started run"
else
  not_ok "desktop.yml must take its version from the deploy run (never github.run_number) and run in desktop-prod with cancel-in-progress: false"
fi

echo "${passed} passed, ${failed} failed"
[ "$failed" -eq 0 ]
