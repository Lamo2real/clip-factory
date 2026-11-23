#!/usr/bin/env bash
# Unit test for scripts/wait-for-jobs.sh (the deploy drain). A fake `aws` first on PATH answers the Scan from a list of
# counts, one per call, and records every call. Never calls AWS; writes only to a temporary folder.
# Run: bash scripts/test-wait-for-jobs.sh   (ci.yml runs it on every push)
set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/wait-for-jobs.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

passed=0
failed=0
ok() { passed=$((passed + 1)); echo "ok   - $1"; }
not_ok() { failed=$((failed + 1)); echo "FAIL - $1" >&2; }

mkdir -p "${work}/bin"
# COUNTS: space-separated active-job counts, one per successful scan call (the last one repeats). The last call's
# arguments are also kept one per line in $AWS_CALLS.last, so a test can read one argument exactly.
cat >"${work}/bin/aws" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$AWS_CALLS"
printf '%s\n' "$@" >"${AWS_CALLS}.last"
n="$(grep -c '^dynamodb scan' "$AWS_CALLS")"
# FAIL_CALLS: the first this many scans fail (throttling, a network blip).
if [ "$n" -le "${FAIL_CALLS:-0}" ]; then echo "An error occurred (ThrottlingException)" >&2; exit 254; fi
read -r -a counts <<<"$COUNTS"
i=$((n - ${FAIL_CALLS:-0} - 1)); [ "$i" -lt "${#counts[@]}" ] || i=$((${#counts[@]} - 1))
c="${counts[$i]}"
items=""
j=0
while [ "$j" -lt "$c" ]; do items="${items}${items:+,}{\"sk\":{\"S\":\"${ITEM_SK:-JOB#x}\"}}"; j=$((j + 1)); done
echo "{\"Items\":[${items}],\"Count\":${c}}"
FAKE
chmod +x "${work}/bin/aws"

plan_with() { # $1: the plan's resource changes as JSON
  echo "{\"resource_changes\": $1}" >"${work}/plan.json"
}

run() { # run <name> <counts> [wait max]: sets $calls and $log
  calls="${work}/$1.calls"
  log="${work}/$1.log"
  : >"$calls"
  PATH="${work}/bin:${PATH}" AWS_CALLS="$calls" COUNTS="$2" POLL_SECONDS=0 RETRY_SECONDS=0 WAIT_MAX_SECONDS="${3:-2700}" \
    NOW=1763568000 TABLE=cf-test-data bash "$SCRIPT" "${work}/plan.json" >"$log" 2>&1
}

arg_after() { # arg_after <flag>: the argument after <flag> in the last scan call
  awk -v f="$1" 'take { print; exit } $0 == f { take = 1 }' "${calls}.last"
}

# placeholders_match: every :name the filter uses is bound in the values, and every bound value is used (DynamoDB
# refuses a Scan with an unused or a missing placeholder).
placeholders_match() {
  local used bound
  used="$(grep -oE ':[a-z]+' <<<"$(arg_after --filter-expression)" | sort -u | tr '\n' ' ')"
  bound="$(arg_after --expression-attribute-values | jq -r 'keys[]' | sort -u | tr '\n' ' ')"
  [ -n "$used" ] && [ "$used" = "$bound" ]
}

agent_change='[{"address":"module.agent.terraform_data.image","change":{"actions":["delete","create"]}},
  {"address":"module.web.aws_s3_object.x","change":{"actions":["no-op"]}}]'
story_change='[{"address":"module.stories_agent.terraform_data.image","change":{"actions":["delete","create"]}},
  {"address":"module.stories_agent.aws_bedrockagentcore_agent_runtime.agent","change":{"actions":["update"]}},
  {"address":"module.agent.aws_iam_role.agent","change":{"actions":["no-op"]}}]'
both_change='[{"address":"module.agent.terraform_data.image","change":{"actions":["delete","create"]}},
  {"address":"module.stories_agent.terraform_data.image","change":{"actions":["delete","create"]}}]'

# Clip Factory's scan, exactly as it was before Funded Clips (main's wait-for-jobs.sh).
clip_filter='begins_with(sk, :job) AND #s IN (:q, :r) AND heartbeatAt > :since'
clip_values='{":job":{"S":"JOB#"},":q":{"S":"queued"},":r":{"S":"running"},":since":{"S":"2025-11-19T15:57:00.000Z"}}'

# 1. A plan that leaves both agents alone does not wait and does not read the table.
plan_with '[{"address":"module.web.aws_s3_object.x","change":{"actions":["update"]}},
  {"address":"module.agent.aws_iam_role.x","change":{"actions":["no-op"]}},
  {"address":"module.stories_agent.aws_iam_role.agent","change":{"actions":["no-op"]}},
  {"address":"module.stories_api.aws_lambda_function.fn","change":{"actions":["update"]}}]'
if run skip "3" && [ ! -s "$calls" ] && grep -q "not waiting" "$log"; then
  ok "no agent change (Funded Clips' API Lambda alone does not count): no wait, no table read"
else
  not_ok "no agent change: $(cat "$log") / $(cat "$calls")"
fi

# 2. Agent changes and jobs are running: it waits until there are none.
plan_with "$agent_change"
if run wait "2 1 0" && [ "$(grep -c '^dynamodb scan' "$calls")" -eq 3 ] && grep -q "Running jobs: 0; going on." "$log"; then
  ok "agent change with running jobs: waits until none are left"
else
  not_ok "waiting: $(cat "$log")"
fi

# 3. The scan reads only queued or running jobs with a fresh heartbeat (3 minutes), projection only, this table.
if grep -q -- "--table-name cf-test-data" "$calls" && grep -q -- '--projection-expression sk' "$calls" \
  && grep -q 'heartbeatAt > :since' "$calls" && grep -q '"2025-11-19T15:57:00.000Z"' "$calls" \
  && grep -q '#s IN (:q, :r)' "$calls"; then
  ok "only queued or running jobs with a heartbeat newer than 3 minutes are counted (a stale one is ignored)"
else
  not_ok "scan arguments: $(cat "$calls")"
fi

# 3b. When only Clip Factory's agent changes, the scan is byte for byte the one it was before Funded Clips: clip jobs
#     only, never a Funded Clips item (docs/CONTRACTS.md §45.15, ADR-76).
if [ "$(arg_after --filter-expression)" = "$clip_filter" ] && [ "$(arg_after --expression-attribute-values)" = "$clip_values" ] \
  && grep -q "^Drain: the agent changes in this deploy (1 resource(s)); waiting for running jobs to finish.$" "$log" \
  && ! grep -q "Funded Clips" "$log"; then
  ok "Clip Factory's agent alone: the same clip-job scan and message as before Funded Clips"
else
  not_ok "clip-only scan: $(arg_after --filter-expression) / $(arg_after --expression-attribute-values)"
fi

# 3c. When only Funded Clips' agent changes, the drain waits for its own work only: production jobs (PJOB#) queued or
#     running, AI tasks (TASK#) running and chat answers (MSG#) streaming, in workspace partitions, never clip jobs.
plan_with "$story_change"
if ITEM_SK="PJOB#x" run story "1 0" && [ "$(grep -c '^dynamodb scan' "$calls")" -eq 2 ] \
  && grep -q "Running jobs: 1; waiting" "$log" && grep -q "Running jobs: 0; going on." "$log" \
  && grep -q "^Drain: Funded Clips' agent changes in this deploy (2 resource(s)); waiting for its running jobs, tasks and chat answers to finish.$" "$log" \
  && ! grep -q "^Drain: the agent changes" "$log"; then
  ok "Funded Clips' agent alone: a running story job holds the deploy until it is done"
else
  not_ok "story drain: $(cat "$log")"
fi

story_filter="$(arg_after --filter-expression)"
story_values="$(arg_after --expression-attribute-values)"
if [ "$story_filter" = 'contains(pk, :ws) AND heartbeatAt > :since AND ((begins_with(sk, :pjob) AND #s IN (:q, :r)) OR (begins_with(sk, :task) AND #s = :r) OR (begins_with(sk, :msg) AND #s = :st))' ] \
  && [ "$(jq -r '[.[":ws"].S, .[":pjob"].S, .[":task"].S, .[":msg"].S, .[":q"].S, .[":r"].S, .[":st"].S, .[":since"].S] | join(",")' <<<"$story_values")" = "#WS#,PJOB#,TASK#,MSG#,queued,running,streaming,2025-11-19T15:57:00.000Z" ] \
  && ! grep -q ':job' <<<"$story_filter" && [ "$(jq -r 'has(":job")' <<<"$story_values")" = "false" ] && placeholders_match; then
  ok "the story scan: PJOB# queued or running, TASK# running, MSG# streaming, fresh heartbeat, workspace partitions only, no JOB#"
else
  not_ok "story scan arguments: ${story_filter} / ${story_values}"
fi

# 3d. Both agents change: one scan counts both, each with its own rules, and both messages are printed.
plan_with "$both_change"
if run both "0" && [ "$(arg_after --filter-expression)" = "(${clip_filter}) OR (${story_filter})" ] && placeholders_match \
  && [ "$(arg_after --expression-attribute-values | jq -r '[.[":job"].S, .[":pjob"].S, .[":st"].S] | join(",")')" = "JOB#,PJOB#,streaming" ] \
  && grep -q "^Drain: the agent changes in this deploy (1 resource(s))" "$log" && grep -q "^Drain: Funded Clips' agent changes" "$log"; then
  ok "both agents change: clip jobs and Funded Clips' work are counted in one scan"
else
  not_ok "both: $(arg_after --filter-expression) / $(cat "$log")"
fi

# 3e. Every placeholder is bound and used in Clip Factory's scan too.
plan_with "$agent_change"
if run placeholders "0" && placeholders_match; then
  ok "every filter placeholder is bound, and every bound value is used (DynamoDB refuses either mistake)"
else
  not_ok "placeholders: $(arg_after --filter-expression) / $(arg_after --expression-attribute-values)"
fi

# 4. Jobs that never finish: it gives up after the cap and goes on with exit 0.
if run cap "1" 0 && grep -q "Running jobs: 1; continuing, they will pick up where they stopped." "$log"; then
  ok "the cap is reached: the deploy goes on (exit 0) and says the jobs will pick up"
else
  not_ok "cap: $(cat "$log")"
fi

# 4b. A scan that fails twice is tried again and the drain still waits for the running job.
if FAIL_CALLS=2 run flaky "1 0" && [ "$(grep -c '^dynamodb scan' "$calls")" -eq 4 ] \
  && grep -q "Running jobs: 0; going on." "$log"; then
  ok "a failed scan is tried again; the drain goes on counting"
else
  not_ok "flaky scan: $(cat "$log")"
fi

# 4c. A scan that keeps failing never stops the deploy: three tries, then it goes on (exit 0).
if FAIL_CALLS=99 run broken "1" && [ "$(grep -c '^dynamodb scan' "$calls")" -eq 3 ] \
  && grep -q "could not be counted; going on" "$log" && ! grep -qi "throttl" "$log"; then
  ok "a scan that keeps failing: the deploy goes on after three tries"
else
  not_ok "broken scan: $(cat "$log")"
fi

# 5. Nothing it prints names a job.
if ! grep -qE "JOB#|PJOB#|TASK#|MSG#" "${work}"/*.log; then
  ok "no job ids in the output"
else
  not_ok "the output names a job"
fi

# 6. Only reads: the one call it makes is a Scan.
if ! grep -vq '^dynamodb scan ' "${work}"/*.calls; then
  ok "reads only (dynamodb scan)"
else
  not_ok "calls other than a scan: $(cat "${work}"/*.calls)"
fi

echo "${passed} passed, ${failed} failed"
[ "$failed" -eq 0 ]
