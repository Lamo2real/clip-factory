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
# COUNTS: space-separated active-job counts, one per successful scan call (the last one repeats).
cat >"${work}/bin/aws" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$AWS_CALLS"
n="$(grep -c '^dynamodb scan' "$AWS_CALLS")"
# FAIL_CALLS: the first this many scans fail (throttling, a network blip).
if [ "$n" -le "${FAIL_CALLS:-0}" ]; then echo "An error occurred (ThrottlingException)" >&2; exit 254; fi
read -r -a counts <<<"$COUNTS"
i=$((n - ${FAIL_CALLS:-0} - 1)); [ "$i" -lt "${#counts[@]}" ] || i=$((${#counts[@]} - 1))
c="${counts[$i]}"
items=""
j=0
while [ "$j" -lt "$c" ]; do items="${items}${items:+,}{\"sk\":{\"S\":\"JOB#x\"}}"; j=$((j + 1)); done
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

agent_change='[{"address":"module.agent.terraform_data.image","change":{"actions":["delete","create"]}},
  {"address":"module.web.aws_s3_object.x","change":{"actions":["no-op"]}}]'

# 1. A plan that leaves the agent alone does not wait and does not read the table.
plan_with '[{"address":"module.web.aws_s3_object.x","change":{"actions":["update"]}},
  {"address":"module.agent.aws_iam_role.x","change":{"actions":["no-op"]}}]'
if run skip "3" && [ ! -s "$calls" ] && grep -q "not waiting" "$log"; then
  ok "no agent change: no wait, no table read"
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
if ! grep -q "JOB#" "${work}"/*.log; then
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
