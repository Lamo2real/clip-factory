#!/usr/bin/env bash
# Deploy drain (docs/CONTRACTS.md §30.7): before terraform apply replaces the agent image or updates the AgentCore
# runtime, wait until no job is being made, so a deploy never stops one partway. Reads only: one projection-only Scan
# of the table every POLL_SECONDS. Prints counts, never job ids or titles (the Actions logs are public).
#
#   bash scripts/wait-for-jobs.sh <plan.json>      (terraform show -json prod.tfplan)
#
# - Nothing under module.agent changes in the plan: exits 0 at once.
# - Otherwise counts jobs that are queued or running with a heartbeat newer than STALE_SECONDS (a job whose container
#   is already gone is not waited for) and waits while there are any, at most WAIT_MAX_SECONDS. Then it goes on
#   anyway (exit 0): a job still running is stopped by the update, and the job flow resumes it on the new version.
# Env: TABLE (default cf-prod-data), WAIT_MAX_SECONDS (2700), POLL_SECONDS (30), STALE_SECONDS (180), NOW (epoch
# seconds, tests only).
set -euo pipefail

plan="${1:?usage: wait-for-jobs.sh <plan.json>}"
table="${TABLE:-cf-prod-data}"
wait_max="${WAIT_MAX_SECONDS:-2700}"
poll="${POLL_SECONDS:-30}"
stale="${STALE_SECONDS:-180}"

changes="$(jq '[.resource_changes[]? | select(.address | startswith("module.agent."))
  | select(.change.actions != ["no-op"] and .change.actions != ["read"])] | length' "$plan")"
if [ "$changes" -eq 0 ]; then
  echo "Drain: the agent does not change in this deploy; not waiting for jobs."
  exit 0
fi

iso() { # epoch seconds -> 2026-11-19T16:08:00.000Z (GNU date on the runner; BSD date for local runs)
  date -u -d "@$1" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%S.000Z
}

count_active() {
  local now since
  now="${NOW:-$(date -u +%s)}"
  since="$(iso $((now - stale)))"
  aws dynamodb scan --table-name "$table" \
    --projection-expression "sk" \
    --filter-expression "begins_with(sk, :job) AND #s IN (:q, :r) AND heartbeatAt > :since" \
    --expression-attribute-names '{"#s":"status"}' \
    --expression-attribute-values "{\":job\":{\"S\":\"JOB#\"},\":q\":{\"S\":\"queued\"},\":r\":{\"S\":\"running\"},\":since\":{\"S\":\"${since}\"}}" \
    --output json | jq '[.Items[]?] | length'
}

echo "Drain: the agent changes in this deploy (${changes} resource(s)); waiting for running jobs to finish."
waited=0
while true; do
  active="$(count_active)"
  if [ "$active" -eq 0 ]; then
    echo "Running jobs: 0; going on."
    exit 0
  fi
  if [ "$waited" -ge "$wait_max" ]; then
    echo "Running jobs: ${active}; continuing, they will pick up where they stopped."
    exit 0
  fi
  echo "Running jobs: ${active}; waiting (${waited}s of ${wait_max}s)."
  sleep "$poll"
  waited=$((waited + poll))
done
