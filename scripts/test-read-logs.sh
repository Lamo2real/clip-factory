#!/usr/bin/env bash
# Unit test for .github/workflows/read-logs.yml: runs its "read" step with a fake `aws` first on PATH that answers from
# saved CloudWatch and DynamoDB fixtures and records every call. Checks that the Content Rewards lines (cr.* and
# campaigns.*, also from cf-prod-campaigns and cf-prod-stats) and the CRCONN summary are printed, that nothing secret
# (a token, an email, a name or an id) is, and that every AWS call only reads. Never calls AWS; writes only to a
# temporary folder. Needs GNU date and sed, like the workflow (ubuntu-24.04): on a Mac without them it skips, in CI
# (CI set) it fails instead.
# Run: bash scripts/test-read-logs.sh   (ci.yml runs it on every push)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workflow="${READ_LOGS_YML:-${root}/.github/workflows/read-logs.yml}"

if ! date -u -d @0 +%s >/dev/null 2>&1 || ! echo x | sed -E 's/x/y/Ig' >/dev/null 2>&1; then
  if [ -n "${CI:-}" ]; then echo "FAIL - needs GNU date and sed" >&2; exit 1; fi
  echo "skip - needs GNU date and sed (CI runs this on Ubuntu)"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

passed=0
failed=0
ok() { passed=$((passed + 1)); echo "ok   - $1"; }
not_ok() { failed=$((failed + 1)); echo "FAIL - $1" >&2; }

# The read step's script: the lines under "run: |", without their 10 spaces of indentation.
awk '/^        run: \|$/ { on = 1; next } on && /^          / { print substr($0, 11); next } on && /^$/ { print ""; next }
  on { exit }' "$workflow" >"${work}/read.sh"

mkdir -p "${work}/bin" "${work}/results" "${work}/queries"
cat >"${work}/bin/aws" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" | tr '\n' ' ' >>"$AWS_CALLS"; echo >>"$AWS_CALLS" # one line per call
arg() { # arg <flag> "$@": the value after <flag>
  local want="$1"; shift
  while [ "$#" -gt 1 ]; do [ "$1" = "$want" ] && { printf '%s' "$2"; return; }; shift; done
}
case "$1 $2" in
  "logs describe-log-groups")
    prefix="$(arg --log-group-name-prefix "$@")"
    case "$prefix" in /aws/lambda/*) echo "$prefix" ;; esac ;; # every Lambda group exists, no agent runtime
  "logs start-query")
    id="q-$(basename "$(arg --log-group-name "$@")")"
    arg --query-string "$@" >"${AWS_DIR}/queries/${id}"
    echo "$id" ;;
  "logs get-query-results")
    id="$(arg --query-id "$@")"
    if [ "$(arg --query "$@")" = "status" ]; then echo Complete
    elif [ -f "${AWS_DIR}/results/${id}.json" ]; then cat "${AWS_DIR}/results/${id}.json"
    else echo '{"status":"Complete","results":[]}'; fi ;;
  "dynamodb scan")
    if grep -q '"CRCONN"' <<<"$*"; then cat "${AWS_DIR}/crconn.json"; else echo '{"Items":[]}'; fi ;;
  *) echo "fake aws: unexpected call: $*" >&2; exit 2 ;;
esac
FAKE
chmod +x "${work}/bin/aws"

results() { # results <function> <message>...: the saved Logs Insights answer for that function's query
  local fn="$1"; shift
  # shellcheck disable=SC2016 # a jq program; $LATEST is part of a log stream name
  printf '%s\n' "$@" | jq -R '[{field: "@timestamp", value: "2026-11-21 17:16:00.000"},
      {field: "@logStream", value: "2026/11/21/[$LATEST]0123456789abcdef"}, {field: "@message", value: .}]' \
    | jq -s '{status: "Complete", results: .}' >"${work}/results/q-${fn}.json"
}
# Lines as clipfactory_api.log prints them (json.dumps: ", " and ": ").
results cf-prod-api \
  '{"level": "info", "event": "cr.connected", "ts": "2026-11-21T17:16:00+00:00", "result": "not_allowed"}' \
  '{"level": "info", "event": "cr.connect_read_failed", "ts": "2026-11-21T17:16:01+00:00", "code": "permission_denied"}' \
  '{"level": "info", "event": "cr.said_cant_connect", "ts": "2026-11-21T17:16:02+00:00", "signedIn": false}' \
  '{"level": "info", "event": "cr.campaign_added", "ts": "2026-11-21T17:16:03+00:00", "membership": "unknown"}' \
  'Traceback (most recent call last): https://contentrewards.com/b/oauth/consent?ix=secret-ix-123'
results cf-prod-clip-flow \
  '{"level": "info", "event": "cr.sent", "ts": "2026-11-21T17:17:00+00:00", "postId": "post-secret-77", "platform": "youtube"}'
results cf-prod-stats '{"level": "info", "event": "cr.tick", "ts": "2026-11-21T17:20:00+00:00", "owners": 1}'
results cf-prod-campaigns '{"level": "info", "event": "campaigns.read", "ts": "2026-11-21T17:21:00+00:00", "rules": 3}'
results cf-prod-autopost \
  '{"level": "info", "event": "autopost.planned", "ts": "2026-11-22T10:00:01+00:00", "runId": "2026-11-22T10:00:00.000Z#scheduled", "mode": "live", "clips": 1, "note": ""}' \
  '{"level": "error", "event": "autopost.owner_failed", "ts": "2026-11-22T10:00:02+00:00", "userId": "user-secret-42", "slot": "2026-11-22T10:00:00.000Z", "error": "Boom"}'

# Three CRCONN items: the pilot case (refused, email sent, steps as a string set), a connected one (steps as a list,
# sign-in date far ahead) and a connected one past its sign-in date (the setup page says sign in again).
cat >"${work}/crconn.json" <<'JSON'
{"Items": [
  {"pk": {"S": "USER#owner-secret-id"}, "sk": {"S": "CRCONN"}, "type": {"S": "crconn"},
   "userId": {"S": "owner-secret-id"}, "status": {"S": "not_connected"}, "canSubmit": {"BOOL": false},
   "lastResult": {"S": "not_allowed"}, "pilotSentAt": {"S": "2026-11-21T17:25:26.000Z"},
   "stepsDone": {"SS": ["ready-link", "ready-account"]}, "email": {"S": "owner@example.com"},
   "updatedAt": {"S": "2026-11-21T17:26:00.000Z"}},
  {"pk": {"S": "USER#other-secret-id"}, "sk": {"S": "CRCONN"}, "type": {"S": "crconn"},
   "status": {"S": "connected"}, "canSubmit": {"BOOL": true}, "lastResult": {"S": "connected"},
   "stepsDone": {"L": [{"S": "ready-account"}]}, "creatorId": {"S": "creator-secret-9"},
   "tokenVersionId": {"S": "token-version-secret"}, "refreshLeaseUntil": {"S": "2026-11-21T18:00:00.000Z"},
   "connectedAt": {"S": "2026-11-20T10:00:00.000Z"}, "signInBy": {"S": "2099-02-18T10:00:00.000Z"},
   "missing": {"L": [{"S": "my_submissions:write"}]},
   "check": {"M": {"at": {"S": "2026-11-20T10:01:00.000Z"}, "ok": {"BOOL": true}, "code": {"S": "ok"},
                   "message": {"S": "Content Rewards answers. You're signed in."}}}},
  {"pk": {"S": "USER#third-secret-id"}, "sk": {"S": "CRCONN"}, "type": {"S": "crconn"},
   "status": {"S": "connected"}, "canSubmit": {"BOOL": true}, "lastResult": {"S": "connected"},
   "connectedAt": {"S": "2026-05-22T09:00:00.000Z"}, "signInBy": {"S": "2026-08-20T09:00:00.000Z"}}
]}
JSON

calls="${work}/calls"
log="${work}/out.log"
: >"$calls"
status=0
PATH="${work}/bin:${PATH}" AWS_CALLS="$calls" AWS_DIR="$work" AWS_REGION=eu-north-1 MINUTES=60 END_AT="" JOB_ID="" \
  bash "${work}/read.sh" >"$log" 2>&1 || status=$?

# 1. The step runs to the end against the fake.
if [ "$status" -eq 0 ] && grep -q '::group::Content Rewards connection' "$log"; then
  ok "the read step runs to the end"
else
  not_ok "the read step did not run to the end (exit ${status}): $(cat "$log")"
fi

# 2. cf-prod-campaigns and cf-prod-stats are read, next to the groups read before.
missing=""
for fn in cf-prod-job-flow cf-prod-api cf-prod-clip-flow cf-prod-hooks cf-prod-campaigns cf-prod-stats cf-prod-autopost; do
  [ -f "${work}/queries/q-${fn}" ] || missing="${missing} ${fn}"
done
if [ -z "$missing" ]; then
  ok "the Lambda log groups read include cf-prod-campaigns, cf-prod-stats and cf-prod-autopost"
else
  not_ok "no query for:${missing}"
fi

# 3. Every Lambda query keeps cr.* and campaigns.* events (also when Lambda wraps the line) and no unrelated info line.
matches() { perl -e 'exit(($ARGV[1] =~ /$ARGV[0]/) ? 0 : 1)' "$1" "$2"; }
bad=""
for q in "${work}"/queries/q-cf-prod-*; do
  re="$(grep -o 'filter @message like /.*/' "$q" | head -1 | sed -E 's#^filter @message like /(.*)/$#\1#')"
  if [ -z "$re" ] \
    || ! matches "$re" '{"level": "info", "event": "cr.connected", "ts": "x", "result": "not_allowed"}' \
    || ! matches "$re" '{"level":"info","event":"cr.tick","owners":1}' \
    || ! matches "$re" '{"message": "{\"level\": \"info\", \"event\": \"cr.refreshed\"}"}' \
    || ! matches "$re" '{"level": "info", "event": "campaigns.read", "rules": 3}' \
    || ! matches "$re" '{"level": "info", "event": "autopost.planned", "runId": "x#scheduled"}' \
    || ! matches "$re" '{"message": "{\"level\": \"info\", \"event\": \"autopost.tick\"}"}' \
    || matches "$re" '{"level": "info", "event": "stats.polled", "note": "ocr.done", "descr.": 1}'; then
    bad="${bad} $(basename "$q")"
  fi
done
if [ -z "$bad" ]; then
  ok "every Lambda query keeps cr.* and campaigns.* events and skips unrelated info lines"
else
  not_ok "queries that miss Content Rewards events:${bad}"
fi

# 4. The Content Rewards lines are printed with the fields that tell what happened.
if grep -q '"event":"cr.connected","result":"not_allowed"' "$log" \
  && grep -q '"event":"cr.connect_read_failed","code":"permission_denied"' "$log" \
  && grep -q '"event":"cr.sent","platform":"youtube"' "$log" \
  && grep -q '"event":"cr.tick","owners":1' "$log" && grep -q '"event":"campaigns.read","rules":3' "$log" \
  && grep -q '"event":"cr.said_cant_connect","signedIn":false' "$log" \
  && grep -q '"event":"cr.campaign_added","membership":"unknown"' "$log"; then
  ok "cr.* and campaigns.* lines are printed (result, code, platform, owners, rules, signedIn, membership)"
else
  not_ok "Content Rewards lines missing: $(cat "$log")"
fi

# 4b. Auto-posting lines (CONTRACTS §46) are printed with the run, its mode, how many clips and the slot, never the
# owner's id.
if grep -q '"event":"autopost.planned","runId":"2026-11-22T10:00:00.000Z#scheduled","mode":"live","clips":1,"note":""' "$log" \
  && grep -q '"level":"error","event":"autopost.owner_failed","error":"Boom","slot":"2026-11-22T10:00:00.000Z"' "$log" \
  && ! grep -q 'user-secret-42' "$log"; then
  ok "autopost.* lines are printed (runId, mode, clips, note, slot, error) without the owner's id"
else
  not_ok "auto-posting lines missing or carrying the owner's id: $(grep -n autopost "$log" || true)"
fi

# 5. The CRCONN summary: status, last result, whether the pilot email was sent, steps done, Connect and sign-in dates,
# and whether the sign-in date has passed.
summary="$(grep -F '{"status":' "$log" | grep -F '"pilotSentAtSet"' || true)"
first="$(sed -n 1p <<<"$summary")"
second="$(sed -n 2p <<<"$summary")"
third="$(sed -n 3p <<<"$summary")"
if [ "$(jq -r '[.status, .lastResult, .pilotSentAtSet, (.stepsDone | join(",")), .canSubmit, .pastReconnectBy]
        | join(" ")' <<<"$first")" = "not_connected not_allowed true ready-account,ready-link false false" ] \
  && [ "$(jq -r '[.status, .pilotSentAtSet, (.stepsDone | join(",")), .connectedAt, .reconnectBy, .pastReconnectBy,
        .check.code, (.missing | join(","))] | join(" ")' <<<"$second")" \
    = "connected false ready-account 2026-11-20T10:00:00.000Z 2099-02-18T10:00:00.000Z false ok my_submissions:write" ] \
  && [ "$(jq -r '[.status, .reconnectBy, .pastReconnectBy] | join(" ")' <<<"$third")" \
    = "connected 2026-08-20T09:00:00.000Z true" ] \
  && jq -e '.fields | index("pilotSentAt") and index("lastResult") and (index("pk") | not)' <<<"$first" >/dev/null; then
  ok "the CRCONN summary shows status, lastResult, pilotSentAt set or not, stepsDone, connectedAt, reconnectBy and pastReconnectBy"
else
  not_ok "CRCONN summary: ${summary:-none}"
fi

# 6. Nothing secret is printed: no token, email, name, id, URL query or the pilot email's time.
leaks="$(grep -nE 'owner-secret-id|other-secret-id|third-secret-id|creator-secret-9|token-version-secret|owner@example\.com|post-secret-77|secret-ix-123|2026-11-21T17:25:26|2026-11-21T18:00:00' "$log" || true)"
if [ -z "$leaks" ] && grep -q '<url>' "$log"; then
  ok "no token, email, name, id, URL query or pilot time is printed"
else
  not_ok "secret values printed:"$'\n'"${leaks:-(the URL was not blanked)}"
fi

# 7. Every AWS call only reads (logs Describe*/StartQuery/GetQueryResults, dynamodb Scan).
writes="$(grep -vE '^(logs (describe-log-groups|describe-log-streams|start-query|get-query-results|filter-log-events)|dynamodb scan) ' "$calls" || true)"
if [ -z "$writes" ] && grep -q '^dynamodb scan .*CRCONN' "$calls"; then
  ok "every AWS call only reads, and CRCONN is read with one Scan"
else
  not_ok "calls that are not reads:"$'\n'"${writes}"
fi

echo "${passed} passed, ${failed} failed"
[ "$failed" -eq 0 ]
