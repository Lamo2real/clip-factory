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
#     (which can also complete as "deploy" on a branch it calls main), in its concurrency group, desktop-plan's `if`,
#     the run-by-hand lookup and a second look at the run through the API.
#   - nothing in desktop.yml gets past desktop-plan's trust steps (what was the resolve job): every other job needs
#     desktop-plan and runs only when it enabled the build (never always()), and inside desktop-plan every later step
#     runs only then, never fails the run, and the deploy role comes after the hand-off and the tools-lock script; no
#     secret is read outside a job, the hand-off counts only when it is the only one made since the deploy run's
#     latest infra job started, and before it ended, and is downloaded by id, and the run-by-hand lookup asks GitHub
#     for pushes and runs by hand only.
#   - desktop-manifest still runs after every upload: desktop-plan skips it only when nothing is built, the tools
#     lock is unchanged and manifest.json records the same inputs both jobs work out (run on samples); desktop-plan
#     skips desktop-tools only with the same lock question desktop-tools asks again itself.
#   - Clips Funded (docs/CONTRACTS.md §45.15, §45.18): its agent image has its own tag (stories-agent- + a hash of
#     stories/** and web/src/stories/engine/**), shown with Clip Factory's unchanged one in the summary; it is built
#     before the plan and one that does not build keeps the live tag; the Clip Factory check
#     (scripts/check-plan-clips-unchanged.sh) runs on the saved plan after the delete gate and before the apply, with
#     the history fetched, and passes its own sample plans; the smoke job preflights the /v1/workspaces routes last.
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

# job_needs: the needs of a job body on stdin (inline list, single name or block list), one per line.
job_needs() {
  awk '
    /^    needs: *$/ { on = 1; next }
    /^    needs: / { v = $0; sub(/^    needs: */, "", v); gsub(/[][ ]/, "", v); n = split(v, a, ","); for (i = 1; i <= n; i++) print a[i]; exit }
    on && /^      - / { v = $0; sub(/^      - */, "", v); print v; next }
    on { exit }
  '
}

# job_if: the job-level if: of a job body on stdin (folded or not), on one line, without a ${{ }} around it.
job_if() {
  awk '
    /^    if:/ { on = 1; v = $0; sub(/^    if: */, "", v); if (v !~ /^[>|][-+]?$/) printf "%s ", v; next }
    on && /^      / { printf "%s ", $0; next }
    on { exit }
  ' | tr -s ' ' | sed -E 's/^ //; s/ $//; s/^\$\{\{ *(.*[^ ]) *\}\}$/\1/'
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
# resolve: desktop-plan's header and its trust steps, up to the end of "read the hand-off" (what was the resolve
# job); plan_later: every step after them.
resolve="$(awk '/^        id: handoff$/ { h = 1 } h && /^      - / { exit } { print }' <<<"$plan")"
plan_later="$(awk '/^        id: handoff$/ { h = 1 } h && /^      - / { on = 1 } on { print }' <<<"$plan")"
deploy_desktop_jobs="$(job_names "$deploy" | grep '^desktop' || true)"
checkouts="$(grep -c 'uses: actions/checkout@' "$desktop_wf" || true)"
# Every job's checkout is desktop-plan's sha; desktop-plan's own (its one checkout) is the sha its first step found.
# shellcheck disable=SC2016  # literal workflow expressions
deployed_refs="$(grep -cF 'ref: ${{ needs.desktop-plan.outputs.sha }}' "$desktop_wf" || true)"
# shellcheck disable=SC2016
own_ref="$(grep -cF 'ref: ${{ steps.run.outputs.sha }}' "$desktop_wf" || true)"
# shellcheck disable=SC2016
if [ -z "$deploy_desktop_jobs" ] && [ "$own_ref" = 1 ] \
  && [ "$(grep -c 'uses: actions/checkout@' <<<"$plan")" = 1 ] \
  && grep -qF 'ref: ${{ steps.run.outputs.sha }}' <<<"$plan_later" \
  && grep -Eq '^    workflows: \[deploy\]$' "$desktop_wf" && grep -Eq '^    branches: \[main\]$' "$desktop_wf" \
  && grep -qF "github.event.workflow_run.conclusion == 'success'" <<<"$resolve" \
  && grep -qF 'SHA: ${{ github.event.workflow_run.head_sha }}' <<<"$resolve" \
  && [ "$checkouts" -gt 1 ] && [ "$checkouts" = "$((deployed_refs + own_ref))" ] \
  && job infra | grep -q 'name: desktop-handoff' \
  && grep -qF 'artifact-ids: ${{ steps.run.outputs.artifact_id }}' <<<"$resolve" && grep -qF 'merge-multiple: true' <<<"$resolve" \
  && grep -qF 'run-id: ${{ steps.run.outputs.run_id }}' <<<"$resolve"; then
  ok "the desktop jobs run in desktop.yml after a successful deploy, on the deployed commit, from infra's hand-off"
else
  not_ok "desktop.yml must hold every desktop job (deploy.yml: ${deploy_desktop_jobs:-none}), run on deploy's success, check out workflow_run.head_sha in every job ($((deployed_refs + own_ref))/${checkouts}, desktop-plan's own ${own_ref}) and download infra's desktop-handoff by the id desktop-plan checked"
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
  not_ok "desktop.yml must check workflow_run.event and head_repository in its concurrency group and desktop-plan's trust steps, filter the run-by-hand lookup the same way, and re-check the run and its commit through the API"
fi

# 13c. Nothing in desktop.yml gets past desktop-plan. Every other job needs desktop-plan, and its `if` requires
#      needs.desktop-plan.outputs.enabled == 'true' (one of its && parts, with no || to get around it, and no ${{ }}
#      inside, which would make the `if` a string, always true); no job uses always(), which runs a job even when
#      desktop-plan failed or was skipped. No secret is read outside a job: the workflow's env, run-name and
#      concurrency are worked out for every run, a fork's pull request's too. Every job key must be one these checks
#      can read, so a job cannot hide from them.
enabled="needs.desktop-plan.outputs.enabled == 'true'"
# shellcheck disable=SC2016  # the literal text ${{
expr_open='${{'
expr_close='}}'
unguarded=()
while IFS= read -r name; do
  body="$(job "$name" "$desktop_wf")"
  if grep -qF 'always()' <<<"$body"; then unguarded+=("${name} (always())"); continue; fi
  [ "$name" = desktop-plan ] && continue
  cond="$(job_if <<<"$body")"
  if ! job_needs <<<"$body" | grep -qx desktop-plan; then
    unguarded+=("${name} (does not need desktop-plan)")
  elif [[ "$cond" == *"||"* || "$cond" == *"$expr_open"* || "$cond" == *"$expr_close"* ]] \
    || ! awk -F ' *&& *' '{ for (i = 1; i <= NF; i++) print $i }' <<<"$cond" | grep -qxF "$enabled"; then
    unguarded+=("${name} (if: ${cond:-none})")
  fi
done < <(job_names "$desktop_wf")
unreadable="$(awk '$0 == "jobs:" { on = 1; next } on && /^[^ #]/ { exit } on && /^  [^ #]/ && !/^  [A-Za-z0-9_-]+:$/' "$desktop_wf")"
outside_secrets="$(awk '/^[^ #]/ { top = $1 } top != "jobs:" && !/^[[:space:]]*#/ { print NR ": " $0 }' "$desktop_wf" \
  | grep -w 'secrets' || true)"
if [ "$(job_names "$desktop_wf" | head -1)" = desktop-plan ] && [ "${#unguarded[@]}" -eq 0 ] \
  && [ -z "$unreadable" ] && [ -z "$outside_secrets" ]; then
  ok "every desktop.yml job but desktop-plan needs it and runs only when it enabled the build; no always(), no secret outside a job"
else
  not_ok "desktop.yml jobs must need desktop-plan and require ${enabled}, without always(), || or an inner \${{ }}: ${unguarded[*]:-}${unreadable:+; unreadable job keys: ${unreadable}}${outside_secrets:+; secrets outside a job: ${outside_secrets}}"
fi

# 13c2. Inside desktop-plan, nothing runs before its trust steps (which deploy run, the download, read the hand-off;
#       resolve's, which may fail the run), and every later step runs only when they enabled the build and never
#       fails the run (the plan never did), so the job itself has no continue-on-error. Its one checkout, the tools
#       lock's script (code from the commit) and only then the deploy role, in that order, so the script never runs
#       with AWS keys set; and nothing here installs or builds (npm, npx, cargo, uv, pip, yarn, pnpm).
step_gate="        if: steps.handoff.outputs.enabled == 'true'"
# later_steps: "<steps> <steps without the gate or continue-on-error: true>" of a list of steps on stdin.
later_steps() {
  awk -v gate="$step_gate" '
    /^      - / { if (n && !(g && c)) bad++; n++; g = 0; c = 0; next }
    $0 == gate { g = 1 }
    $0 == "        continue-on-error: true" { c = 1 }
    END { if (n && !(g && c)) bad++; print n + 0, bad + 0 }
  '
}
line_of() { grep -nF -- "$1" <<<"$plan" | head -1 | cut -d: -f1 || true; }
handoff_at="$(line_of '        id: handoff')"
checkout_at="$(line_of 'uses: actions/checkout@')"
tools_at="$(line_of '        id: tools')"
role_at="$(line_of 'uses: aws-actions/configure-aws-credentials@')"
plan_at="$(line_of '        id: plan')"
# shellcheck disable=SC2016
if [ "$(grep -c '^      - ' <<<"$resolve")" = 3 ] && [ "$(later_steps <<<"$plan_later")" = "4 0" ] \
  && [ -n "$handoff_at" ] && [ -n "$checkout_at" ] && [ -n "$tools_at" ] && [ -n "$role_at" ] && [ -n "$plan_at" ] \
  && [ "$handoff_at" -lt "$checkout_at" ] && [ "$checkout_at" -lt "$tools_at" ] && [ "$tools_at" -lt "$role_at" ] \
  && [ "$role_at" -lt "$plan_at" ] && [ "$(grep -c 'configure-aws-credentials' <<<"$plan")" = 1 ] \
  && ! grep -Eq '^    continue-on-error:' <<<"$plan" \
  && grep -Eq '^      actions: read$' <<<"$plan" && grep -Eq '^      id-token: write$' <<<"$plan" \
  && ! grep -v '^[[:space:]]*#' <<<"$plan" | grep -Eq '(^|[^A-Za-z0-9_./-])(npm|npx|cargo|uv|uvx|pip|pip3|yarn|pnpm) '; then
  ok "desktop-plan checks out, runs the lock script and assumes the deploy role only after its trust steps enabled the build"
else
  not_ok "desktop-plan must start with its 3 trust steps, then checkout, the tools step, the role and the plan, each with \"if: steps.handoff.outputs.enabled == 'true'\" and continue-on-error: true (steps without: $(later_steps <<<"$plan_later")), no job-level continue-on-error, and run no npm, cargo, uv or pip"
fi

# 13d. The hand-off counts only when it is the only one made since the deploy run's latest successful infra job started,
#      and before it ended (a minute's grace): code earlier in the same deploy, a bad npm dependency in its build job
#      say, could otherwise upload a forged one first, and an earlier attempt's (each re-run keeps its own) is left
#      out. The run-by-hand lookup asks GitHub for pushes and runs by hand by event, each page on its own (a failed gh
#      fails the step), so a stream of fork runs on a branch called main can never crowd them off the page. Both jq
#      programs are run on samples.
# between_quotes: the text between the first and the last ' of stdin.
between_quotes() { local s; s="$(cat)"; s="${s#*\'}"; printf '%s' "${s%\'*}"; }
# shellcheck disable=SC2016  # literal workflow text
verdict_prog="$(awk 'index($0, "why=\"$(jq -rn ") { on = 1 } on { print } on && index($0, "end'"'"')\" || why=") { exit }' <<<"$resolve" | between_quotes)"
# shellcheck disable=SC2016
lookup_prog="$(awk 'index($0, "| jq -rs --arg repo \"$REPO\" '"'"'") { on = 1 } on { print } on && index($0, "\\(.head_sha)\"'"'"'") { exit }' <<<"$resolve" | between_quotes)"
infra_one='{"started_at":"2026-11-21T21:25:58Z","completed_at":"2026-11-21T21:30:10Z"}'
infra_job="[${infra_one}]"
in_build='{"id":10,"expired":false,"created_at":"2026-11-21T21:23:25Z"}'
in_infra='{"id":20,"expired":false,"created_at":"2026-11-21T21:30:06Z"}'
in_grace='{"id":30,"expired":false,"created_at":"2026-11-21T21:30:40Z"}'
after_infra='{"id":40,"expired":false,"created_at":"2026-11-21T21:31:11Z"}'
expired_in_infra='{"id":15,"expired":true,"created_at":"2026-11-21T21:29:00Z"}'
verdict() { jq -rn --argjson h "$1" --argjson i "$2" "$verdict_prog" 2>/dev/null || echo unreadable; }
untrusted() { [[ ! "$(verdict "$1" "$2")" =~ ^ok ]]; }
lookup() { jq -rs --arg repo o/r "$lookup_prog" 2>/dev/null || echo unreadable; }
pages='{"workflow_runs":[{"id":1,"run_number":7,"head_sha":"a","event":"push","head_repository":{"full_name":"o/r"}},
  {"id":9,"run_number":99,"head_sha":"f","event":"pull_request","head_repository":{"full_name":"fork/r"}},
  {"id":8,"run_number":98,"head_sha":"e","event":"push","head_repository":{"full_name":"fork/r"}}]}
  {"workflow_runs":[{"id":2,"run_number":8,"head_sha":"b","event":"workflow_dispatch","head_repository":{"full_name":"o/r"}}]}'
numeric='{"workflow_runs":[{"id":3,"run_number":10,"head_sha":"c","event":"push","head_repository":{"full_name":"o/r"}}]}
  {"workflow_runs":[{"id":4,"run_number":9,"head_sha":"d","event":"workflow_dispatch","head_repository":{"full_name":"o/r"}}]}'
# shellcheck disable=SC2016
if [ -n "$verdict_prog" ] && [ -n "$lookup_prog" ] \
  && [ "$(verdict "[${in_infra}]" "$infra_job")" = "ok 20" ] \
  && [ "$(verdict "[${in_build},${in_infra}]" "$infra_job")" = "ok 20" ] \
  && [ "$(verdict "[${expired_in_infra},${in_infra}]" "$infra_job")" = "ok 20" ] \
  && [ "$(verdict "[${in_grace}]" "$infra_job")" = "ok 30" ] \
  && untrusted "[${in_build}]" "$infra_job" \
  && untrusted "[${after_infra}]" "$infra_job" \
  && untrusted "[${in_build},${after_infra}]" "$infra_job" \
  && untrusted "[${in_infra},${after_infra}]" "$infra_job" \
  && untrusted "[${in_infra},${in_grace}]" "$infra_job" \
  && untrusted "[${in_infra},${in_infra}]" "$infra_job" \
  && untrusted "[${expired_in_infra}]" "$infra_job" \
  && untrusted "[${in_infra}]" '[]' \
  && untrusted "[${in_infra}]" "[${infra_one},${infra_one}]" \
  && untrusted '[{"id":5,"expired":false,"created_at":null}]' "$infra_job" \
  && untrusted "[${in_infra}]" '[{"started_at":"2026-11-21T21:25:58Z","completed_at":null}]' \
  && untrusted "[${in_infra}]" '[{"started_at":null,"completed_at":"2026-11-21T21:30:10Z"}]' \
  && grep -qF 'artifacts?name=desktop-handoff' <<<"$resolve" && grep -qF 'jobs?filter=latest' <<<"$resolve" \
  && grep -qF '[.artifacts[] | {id, expired, created_at}]' <<<"$resolve" \
  && grep -qF '[.jobs[] | select(.name == "infra" and .conclusion == "success") | {started_at, completed_at}]' <<<"$resolve" \
  && grep -qF '[[ "$why" =~ ^ok\ ([0-9]+)$ ]] || {' <<<"$resolve" \
  && grep -qF 'artifact_id="${BASH_REMATCH[1]}"' <<<"$resolve" && grep -qF 'echo "artifact_id=${artifact_id}"' <<<"$resolve" \
  && [ "$(lookup <<<"$pages")" = "2 8 b" ] \
  && [ "$(lookup <<<"$numeric")" = "3 10 c" ] \
  && [ -z "$(lookup <<<'{"workflow_runs":[]}{"workflow_runs":[]}')" ] \
  && grep -qF 'runs?branch=main&status=success&per_page=20"' <<<"$resolve" \
  && grep -qF 'pushes="$(gh api "${runs}&event=push")"' <<<"$resolve" \
  && grep -qF 'dispatches="$(gh api "${runs}&event=workflow_dispatch")"' <<<"$resolve" \
  && ! grep -qF 'per_page=50' <<<"$resolve"; then
  ok "desktop-plan takes only the hand-off made since the deploy run's latest infra job started, and asks GitHub by event for the run by hand"
else
  not_ok "desktop-plan must accept the one desktop-handoff made since its latest infra job's started_at (and by completed_at plus a minute), and look up the run by hand with event=push and event=workflow_dispatch, one gh call each (newest run_number)"
fi

# 14. The version stays 1.<deploy run number>.0 (desktop.yml's own number started again at 1, and the updater never
#     takes a lower version), and a started desktop run is never cancelled (desktop-prod, cancel-in-progress: false).
# shellcheck disable=SC2016
if ! grep -Eq '\$\{\{[^}]*github\.run_number' "$desktop_wf" \
  && grep -qF 'RUN_NUMBER: ${{ github.event.workflow_run.run_number }}' <<<"$resolve" \
  && grep -qF 'RUN_NUMBER: ${{ steps.run.outputs.run_number }}' <<<"$plan_later" \
  && grep -qF 'version="1.${RUN_NUMBER}.0"' <<<"$plan" \
  && grep -qF "&& 'desktop-prod' ||" "$desktop_wf" \
  && awk '/^concurrency:$/ { on = 1; next } on && /^[^ ]/ { exit } on' "$desktop_wf" | grep -Eq '^  cancel-in-progress: false$' \
  && awk '/^concurrency:$/ { on = 1; next } on && /^[^ ]/ { exit } on' "$deploy" | grep -Eq '^  group: deploy-prod$'; then
  ok "desktop versions are 1.<deploy run number>.0, and desktop.yml never cancels a started run"
else
  not_ok "desktop.yml must take its version from the deploy run (never github.run_number) and run in desktop-prod with cancel-in-progress: false"
fi

# conjuncts: the && parts of a job's `if` (from job_if), one per line.
conjuncts() { awk -F ' *&& *' '{ for (i = 1; i <= NF; i++) print $i }'; }
# step <name> <job body>: one step of a job, from its "- name:" line to the next step.
step() { awk -v name="      - name: $1" '$0 == name { on = 1; print; next } on && /^      - / { exit } on { print }' <<<"$2"; }

# 14b. A release that changes no tool never starts desktop-tools: desktop-plan asks the same question (the same lock
#      hash, live manifest and comparison lines) before the deploy role, and desktop-tools is skipped only on its
#      "false". desktop-tools still asks again itself, and fetches, signs and uploads only on its own answer.
# shellcheck disable=SC2016  # literal workflow text
lock_question() { grep -E '^          (want=|live=|if \[ "\$live" = "\$want" \]; then$)' <<<"$1" || true; }
plan_tools_step="$(step 'are the live tools this lock' "$plan")"
own_tools_step="$(step 'is the live manifest this lock' "$tools")"
# shellcheck disable=SC2016  # literal workflow text
if [ "$(lock_question "$plan_tools_step" | wc -l | tr -d ' ')" = 3 ] \
  && [ "$(lock_question "$plan_tools_step")" = "$(lock_question "$own_tools_step")" ] \
  && grep -A1 -F 'if [ "$live" = "$want" ]; then' <<<"$plan_tools_step" | grep -qF 'echo "changed=false" >> "$GITHUB_OUTPUT"' \
  && [ "$(grep -c 'changed=false' <<<"$plan_tools_step")" = 1 ] \
  && grep -Fxq '      tools: ${{ steps.tools.outputs.changed }}' <<<"$plan" \
  && job_if <<<"$tools" | conjuncts | grep -qxF "needs.desktop-plan.outputs.tools != 'false'" \
  && [ "$(grep -c "^        if: steps.plan.outputs.changed == 'true'$" <<<"$tools")" = 3 ]; then
  ok "desktop-plan skips desktop-tools only when the live tool manifest has this lock (desktop-tools asks again)"
else
  not_ok "desktop-plan's tools step must ask desktop-tools' own question (want=, live=, the comparison) and desktop-tools must run unless its output is 'false', still gating its 3 steps on its own check"
fi

# 14c. desktop-manifest still runs after every upload: it needs desktop-upload and desktop-tools-upload, runs with
#      !cancelled() (those are skipped when nothing is built), and desktop-plan's "false" is its only skip. That is said
#      only when nothing is built, the tools lock is unchanged and manifest.json records (S3 metadata "inputs", read
#      after latest.json is written) the same inputs as now; both jobs work them out with the same manifest_inputs.
#      The decision is run on samples, with a stand-in for aws that answers head-object from "<key> <query> <value>"
#      lines.
manifest_job="$(job desktop-manifest "$desktop_wf")"
inputs_fn() { awk '/^          manifest_inputs\(\) \{$/ { on = 1 } on { print } on && /^          \}$/ { exit }' <<<"$1"; }
plan_inputs_fn="$(inputs_fn "$plan")"
manifest_inputs_fn="$(inputs_fn "$manifest_job")"
decision="$(awk '/^          manifest=true$/ { on = 1 } on { print } on && /^          fi$/ { exit }' <<<"$plan")"
fake_aws() {
  local key="" query="" line
  while [ "$#" -gt 0 ]; do
    case "$1" in --key) key="$2"; shift ;; --query) query="$2"; shift ;; esac
    shift
  done
  line="$(grep -F -- "${key} ${query} " <<<"$FAKE_S3" | head -1 || true)"
  [ -n "$line" ] || return 254
  printf '%s\n' "${line#* * }"
}
# inputs_now <fake S3>: what desktop-manifest records; decide <stale> <tools changed> <fake S3>: desktop-plan's output.
# The workflow's own text runs them (eval), with these variables and aws().
# SC2317 is the older shellcheck name (the CI runner's) for SC2329: aws() is called through eval.
# shellcheck disable=SC2317,SC2329
inputs_now() { (FAKE_S3="$1"; WEB_BUCKET=web; aws() { fake_aws "$@"; }; eval "$manifest_inputs_fn"; manifest_inputs) 2>/dev/null || echo unreadable; }
# shellcheck disable=SC2034,SC2154,SC2317,SC2329
decide() {
  (FAKE_S3="$3"; stale="$1"; TOOLS_CHANGED="$2"; WEB_BUCKET=web; summary=(); aws() { fake_aws "$@"; }
    eval "$plan_inputs_fn"; eval "$decision"; printf '%s\n' "$manifest") 2>/dev/null || echo unreadable
}
bucket='downloads/Clip-Factory.dmg ETag "d1"
downloads/Clip-Factory-Setup.exe ETag "w1"
downloads/updates/mac.json ETag "m1"
downloads/updates/windows.json ETag "p1"
downloads/latest.json ETag "l1"'
recorded="$(inputs_now "$bucket")"
written="${bucket}"$'\n'"downloads/manifest.json Metadata.inputs ${recorded}"
latest_at="$(grep -n '/downloads/latest\.json" ' <<<"$manifest_job" | head -1 | cut -d: -f1 || true)"
# shellcheck disable=SC2016  # literal workflow text
inputs_at="$(grep -nxF '          inputs="$(manifest_inputs)"' <<<"$manifest_job" | head -1 | cut -d: -f1 || true)"
# shellcheck disable=SC2016
record_at="$(grep -nF -- '--metadata "inputs=${inputs}"' <<<"$manifest_job" | head -1 | cut -d: -f1 || true)"
manifest_needs="$(job_needs <<<"$manifest_job" | sort | tr '\n' ' ' || true)"
# shellcheck disable=SC2016
if [ -n "$plan_inputs_fn" ] && [ "$plan_inputs_fn" = "$manifest_inputs_fn" ] && [ -n "$decision" ] \
  && [[ "$recorded" =~ ^[0-9a-f]{32}$ ]] \
  && [ "$(decide false false "$written")" = false ] \
  && [ "$(decide true false "$written")" = true ] \
  && [ "$(decide false true "$written")" = true ] \
  && [ "$(decide false '' "$written")" = true ] \
  && [ "$(decide false false "${written//\"m1\"/\"m2\"}")" = true ] \
  && [ "$(decide false false "$(grep -v Clip-Factory-Setup <<<"$written")")" = true ] \
  && [ "$(decide false false "$bucket")" = true ] \
  && [ "$(decide false false "${bucket}"$'\n''downloads/manifest.json Metadata.inputs None')" = true ] \
  && [ "$(decide false false '')" = true ] \
  && [ "$(grep -c 'manifest=false' <<<"$plan")" = 1 ] && grep -q 'manifest=false' <<<"$decision" \
  && grep -Fxq '            echo "manifest=${manifest}"' <<<"$plan" \
  && grep -Fxq '      manifest: ${{ steps.plan.outputs.manifest }}' <<<"$plan" \
  && [ "$manifest_needs" = "desktop desktop-plan desktop-tools-upload desktop-upload " ] \
  && job_if <<<"$manifest_job" | conjuncts | grep -qxF '!cancelled()' \
  && job_if <<<"$manifest_job" | conjuncts | grep -qxF "needs.desktop-plan.outputs.manifest != 'false'" \
  && [ -n "$latest_at" ] && [ -n "$inputs_at" ] && [ -n "$record_at" ] \
  && [ "$latest_at" -lt "$inputs_at" ] && [ "$inputs_at" -lt "$record_at" ] \
  && grep -F -- '--metadata "inputs=${inputs}"' <<<"$manifest_job" | grep -q '^            --cache-control "no-cache" --content-type "application/json"' \
  && grep -B1 -F -- '--metadata "inputs=${inputs}"' <<<"$manifest_job" | grep -qF '/downloads/manifest.json" '; then
  ok "desktop-manifest runs after every upload; desktop-plan skips it only with nothing built, no tool change and manifest.json up to date"
else
  not_ok "desktop-manifest must need desktop-upload and desktop-tools-upload, run on !cancelled() unless desktop-plan says manifest 'false', and record manifest_inputs (the same in both jobs) on manifest.json after latest.json; desktop-plan may say 'false' only with nothing stale, tools 'false' and the same inputs (needs: ${manifest_needs}; recorded: ${recorded})"
fi

# 15. Two agent images, two tags (docs/CONTRACTS.md §45.15, ADR-76): Clip Factory's tag hash stays agent/**, skills/**
#     and config/** (so a Clips Funded change never rebuilds or drains Clip Factory's agent); Clips Funded's tag is
#     stories-agent- plus 16 characters of a hash of stories/** and web/src/stories/engine/**, passed to the plan
#     (through the image step below); the build's summary shows both tags (§45.23: Clip Factory's tag unchanged).
build="$(job build)"
# shellcheck disable=SC2016  # the literal ${{ }} and ${...} text is what the workflow must contain
if grep -Fxq "          SOURCES_HASH: \${{ hashFiles('agent/**', 'skills/**', 'config/**') }}" <<<"$build" \
  && grep -Fq 'echo "tag=agent-${SOURCES_HASH:0:16}" >> "$GITHUB_OUTPUT"' <<<"$build" \
  && [ "$(grep -c 'hashFiles(' <<<"$build")" -eq 2 ] \
  && grep -Fxq "          STORIES_HASH: \${{ hashFiles('stories/**', 'web/src/stories/engine/**') }}" <<<"$build" \
  && grep -Fq 'tag="stories-agent-${STORIES_HASH:0:16}"' <<<"$build" \
  && grep -Fq 'echo "tag=${tag}" >> "$GITHUB_OUTPUT"' <<<"$build" \
  && grep -Fxq '      stories_image_tag: ${{ steps.stories_image.outputs.tag }}' <<<"$build" \
  && grep -Fxq '          NEW_TAG: ${{ needs.build.outputs.stories_image_tag }}' <<<"$infra" \
  && grep -Fxq '          TF_VAR_stories_agent_image_tag: ${{ steps.stories_push.outputs.tag }}' <<<"$infra" \
  && grep -Fxq '          TF_VAR_agent_image_tag: ${{ needs.build.outputs.image_tag }}' <<<"$infra"; then
  ok "Clip Factory's agent tag still hashes agent/, skills/ and config/; Clips Funded's agent has its own stories-agent- tag"
else
  not_ok "the build job must keep SOURCES_HASH (agent/**, skills/**, config/**) and add STORIES_HASH (stories/**, web/src/stories/engine/**) as stories-agent-<16>, passed as TF_VAR_stories_agent_image_tag"
fi
tag_step="$(awk '/^      - name: Clips Funded agent image tag/ { on = 1; print; next } on && /^      - / { exit } on { print }' <<<"$build")"
# shellcheck disable=SC2016
if grep -Fxq '          CLIPS_TAG: ${{ steps.image.outputs.tag }}' <<<"$tag_step" \
  && grep -Fq 'echo "- Clip Factory agent image: \`${CLIPS_TAG}\`"' <<<"$tag_step" \
  && grep -Fq 'echo "- Clips Funded agent image: \`${tag}\`"' <<<"$tag_step" \
  && grep -Fq '} >> "$GITHUB_STEP_SUMMARY"' <<<"$tag_step"; then
  ok "the deploy summary shows Clip Factory's and Clips Funded's agent image tags"
else
  not_ok "the Clips Funded tag step must write both agent image tags to the step summary"
fi

# 16. Clips Funded's image is built before the plan once its runtime is live (read from Terraform's outputs), with
#     Clip Factory's push-image.sh and stories/agent/Dockerfile; one that does not build keeps the live tag, so the
#     apply never fails on it and Clip Factory still ships. It never builds Clip Factory's agent.
push_step="$(awk '/^      - name: Clips Funded agent image \(built before the plan/ { on = 1; print; next } on && /^      - / { exit } on { print }' <<<"$infra")"
push_line="$(grep -n '^      - name: Clips Funded agent image (built before the plan' <<<"$infra" | head -1 | cut -d: -f1)"
plan_line="$(grep -n '^      - name: terraform plan$' <<<"$infra" | head -1 | cut -d: -f1)"
init_line="$(grep -n '^      - name: terraform init$' <<<"$infra" | head -1 | cut -d: -f1)"
# shellcheck disable=SC2016
if [ -n "$push_line" ] && [ -n "$plan_line" ] && [ -n "$init_line" ] && [ "$init_line" -lt "$push_line" ] && [ "$push_line" -lt "$plan_line" ] \
  && grep -Fq 'terraform output -raw stories_ecr_repository_url' <<<"$push_step" \
  && grep -Fq 'terraform output -raw stories_agent_image_tag' <<<"$push_step" \
  && grep -Fq 'DOCKERFILE="${GITHUB_WORKSPACE}/stories/agent/Dockerfile" bash "${GITHUB_WORKSPACE}/scripts/push-image.sh"' <<<"$push_step" \
  && grep -Fq 'echo "tag=${live}" >> "$GITHUB_OUTPUT"' <<<"$push_step" \
  && grep -Fq '::error title=Clips Funded agent image::' <<<"$push_step" \
  && ! grep -q 'agent/Dockerfile"' <<<"$(grep -v 'stories/agent/Dockerfile' <<<"$push_step")" \
  && ! grep -Eq 'exit 1|continue-on-error' <<<"$push_step" \
  && grep -Fq 'output "stories_agent_image_tag"' "${root}/infra/envs/prod/outputs.tf"; then
  ok "Clips Funded's image is built before the plan; one that does not build keeps the live tag and never stops Clip Factory"
else
  not_ok "infra must build Clips Funded's image between terraform init and plan, keep the live tag (stories_agent_image_tag) when it fails, and never exit 1 there"
fi

# 17. The Clip Factory check runs on the saved plan after the delete gate and before the drain and the apply, with the
#     history since the live release fetched first (it decides whose change it is); only a manual run with the "Clip
#     Factory changes on purpose" input can make it warn instead of stopping the deploy.
# shellcheck disable=SC2016  # the literal ${RUNNER_TEMP} and ${{ }} text is what the workflow must contain
check_line="$(grep -n 'scripts/check-plan-clips-unchanged.sh "${RUNNER_TEMP}/plan.json"' <<<"$infra" | head -1 | cut -d: -f1)"
# shellcheck disable=SC2016
fetch_line="$(grep -n 'git fetch -q --no-tags --unshallow origin "$GITHUB_SHA"' <<<"$infra" | head -1 | cut -d: -f1)"
# shellcheck disable=SC2016
if [ -n "$check_line" ] && [ -n "$gate_line" ] && [ -n "$drain_line" ] && [ -n "$apply_line" ] && [ -n "$fetch_line" ] \
  && [ "$gate_line" -lt "$fetch_line" ] && [ "$fetch_line" -lt "$check_line" ] \
  && [ "$gate_line" -lt "$check_line" ] && [ "$check_line" -lt "$drain_line" ] && [ "$check_line" -lt "$apply_line" ] \
  && grep -Fq "ALLOW_CLIPS_CHANGE: \${{ github.event_name == 'workflow_dispatch' && inputs.allow_clip_factory_change && 'true' || 'false' }}" <<<"$infra" \
  && [ "$(grep -c 'ALLOW_CLIPS_CHANGE' "$deploy")" -eq 1 ] \
  && awk '/^  workflow_dispatch:$/ { on = 1 } on && /^      allow_clip_factory_change:$/ { found = 1 } on && /^[a-z]/ { exit } END { exit !found }' "$deploy" \
  && grep -A3 '^      allow_clip_factory_change:$' "$deploy" | grep -q '^        default: false$'; then
  ok "the Clip Factory check runs on the saved plan between the delete gate and the apply, with the history fetched (off only by a manual input)"
else
  not_ok "deploy.yml must fetch the history and run scripts/check-plan-clips-unchanged.sh on the plan after check-plan-deletes.sh and before the drain and the apply"
fi

# 18. The Clip Factory check passes its own sample plans (its unit test; the scripts job of ci.yml runs this file).
if out="$(bash "${root}/scripts/test-check-plan-clips-unchanged.sh" 2>&1)"; then
  ok "the Clip Factory check passes its sample plans ($(tail -1 <<<"$out"))"
else
  not_ok "scripts/test-check-plan-clips-unchanged.sh failed:"$'\n'"${out}"
fi

# 19. The smoke job also sends the browser's preflight to Clips Funded's routes (/v1/workspaces and a deep
#     /v1/workspaces/stories/dashboard path) and checks the CORS answer, as its last step, so a Clips Funded failure
#     never hides a Clip Factory check.
last_smoke_step="$(grep '^      - name: ' <<<"$smoke" | tail -1)"
# shellcheck disable=SC2016  # the literal ${API_URL%/} text is what the workflow must contain
if grep -Fq 'for path in /v1/workspaces /v1/workspaces/stories/dashboard; do' <<<"$smoke" \
  && grep -A12 'for path in /v1/workspaces /v1/workspaces/stories/dashboard; do' <<<"$smoke" | grep -q -- '-X OPTIONS' \
  && grep -A20 'for path in /v1/workspaces /v1/workspaces/stories/dashboard; do' <<<"$smoke" | grep -q 'access-control-allow-origin' \
  && grep -q 'url="${API_URL%/}/v1/jobs"' <<<"$smoke" \
  && [ "$last_smoke_step" = "      - name: the Clips Funded routes let the app's browsers in (CORS preflight)" ]; then
  ok "the smoke job preflights /v1/workspaces and /v1/workspaces/stories/dashboard last (and still /v1/jobs)"
else
  not_ok "the smoke job must send a CORS preflight to /v1/workspaces and /v1/workspaces/stories/dashboard as its last step (last: ${last_smoke_step})"
fi

echo "${passed} passed, ${failed} failed"
[ "$failed" -eq 0 ]
