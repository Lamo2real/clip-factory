#!/usr/bin/env bash
# Deploy drain (docs/CONTRACTS.md §30.7, §45.11.1, §45.15): before terraform apply replaces an agent image or updates
# an AgentCore runtime, wait until nothing that runtime runs is being made, so a deploy never stops one partway. Reads
# only: one projection-only Scan of the table every POLL_SECONDS. Prints counts, never ids or titles (the Actions logs
# are public).
#
#   bash scripts/wait-for-jobs.sh <plan.json>      (terraform show -json prod.tfplan)
#
# Two runtimes, each drained only when it changes:
# - Clip Factory's agent (module.agent.): clip jobs (JOB#) that are queued or running, exactly as before Lamo Stories.
# - Lamo Stories' agent (module.stories_agent.): in a workspace partition (pk contains #WS#), production jobs (PJOB#)
#   queued or running, AI tasks (TASK#) running and chat answers (MSG#) streaming. A story job stopped by the update is
#   failed by the API's fence and "Try again" resumes it from its first unfinished step.
# - Neither changes in the plan: exits 0 at once.
# Only items with a heartbeat newer than STALE_SECONDS count (one whose container is already gone is not waited for),
# and the drain waits at most WAIT_MAX_SECONDS. Then it goes on anyway (exit 0): a job still running is stopped by the
# update and picks up where it stopped. A Scan that fails three times in a row: goes on without waiting (exit 0).
# Env: TABLE (default cf-prod-data), WAIT_MAX_SECONDS (1500), POLL_SECONDS (30), STALE_SECONDS (180), RETRY_SECONDS
# (5), NOW (epoch seconds, tests only).
set -euo pipefail

plan="${1:?usage: wait-for-jobs.sh <plan.json>}"
table="${TABLE:-cf-prod-data}"
wait_max="${WAIT_MAX_SECONDS:-1500}"
poll="${POLL_SECONDS:-30}"
stale="${STALE_SECONDS:-180}"
retry_wait="${RETRY_SECONDS:-5}"

changes_under() { # changes_under <address prefix>: how many resources under it the plan creates, updates or deletes
  jq --arg p "$1" '[.resource_changes[]? | select(.address | startswith($p))
    | select(.change.actions != ["no-op"] and .change.actions != ["read"])] | length' "$plan"
}
clip_changes="$(changes_under "module.agent.")"
story_changes="$(changes_under "module.stories_agent.")"
if [ "$clip_changes" -eq 0 ] && [ "$story_changes" -eq 0 ]; then
  echo "Drain: neither Clip Factory's agent nor Clips Funded's agent changes in this deploy; not waiting for jobs."
  exit 0
fi

# Clip Factory's filter is the one it has always used; Lamo Stories' never matches a Clip Factory item (its sort keys
# start PJOB#, TASK# or MSG# and live only in USER#{userId}#WS#{workspaceId} partitions, §45.3).
clip_filter="begins_with(sk, :job) AND #s IN (:q, :r) AND heartbeatAt > :since"
story_filter="contains(pk, :ws) AND heartbeatAt > :since AND ((begins_with(sk, :pjob) AND #s IN (:q, :r)) OR (begins_with(sk, :task) AND #s = :r) OR (begins_with(sk, :msg) AND #s = :st))"
if [ "$clip_changes" -gt 0 ] && [ "$story_changes" -gt 0 ]; then
  filter="(${clip_filter}) OR (${story_filter})"
elif [ "$clip_changes" -gt 0 ]; then
  filter="$clip_filter"
else
  filter="$story_filter"
fi

iso() { # epoch seconds -> 2026-11-19T16:08:00.000Z (GNU date on the runner; BSD date for local runs)
  date -u -d "@$1" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%S.000Z
}

values_json() { # the placeholders the filter uses, and no other (DynamoDB refuses unused ones)
  local since="$1" head=""
  if [ "$clip_changes" -gt 0 ]; then
    head='":job":{"S":"JOB#"},'
  fi
  if [ "$story_changes" -gt 0 ]; then
    head="${head}"'":ws":{"S":"#WS#"},":pjob":{"S":"PJOB#"},":task":{"S":"TASK#"},":msg":{"S":"MSG#"},":st":{"S":"streaming"},'
  fi
  echo "{${head}\":q\":{\"S\":\"queued\"},\":r\":{\"S\":\"running\"},\":since\":{\"S\":\"${since}\"}}"
}

scan_once() {
  local now since
  now="${NOW:-$(date -u +%s)}"
  since="$(iso $((now - stale)))"
  aws dynamodb scan --table-name "$table" \
    --projection-expression "sk" \
    --filter-expression "$filter" \
    --expression-attribute-names '{"#s":"status"}' \
    --expression-attribute-values "$(values_json "$since")" \
    --output json 2>/dev/null | jq -e '[.Items[]?] | length'
}

# One failed Scan (throttling, a network blip, AccessDenied) never stops the deploy: it is tried three times, and
# when it still fails the drain goes on without waiting (the job flow resumes a job the update stops).
count_active() {
  local n try
  for try in 1 2 3; do
    if n="$(scan_once)" && [[ "$n" =~ ^[0-9]+$ ]]; then
      echo "$n"
      return 0
    fi
    [ "$try" -lt 3 ] && sleep "$retry_wait"
  done
  echo "unknown"
}

if [ "$clip_changes" -gt 0 ]; then
  echo "Drain: the agent changes in this deploy (${clip_changes} resource(s)); waiting for running jobs to finish."
fi
if [ "$story_changes" -gt 0 ]; then
  echo "Drain: Clips Funded's agent changes in this deploy (${story_changes} resource(s)); waiting for its running jobs, tasks and chat answers to finish."
fi
waited=0
while true; do
  active="$(count_active)"
  if [ "$active" = "unknown" ]; then
    echo "Running jobs: could not be counted; going on, a stopped job picks up where it stopped."
    exit 0
  fi
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
