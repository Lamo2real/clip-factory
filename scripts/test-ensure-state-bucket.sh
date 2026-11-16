#!/usr/bin/env bash
# Unit test for scripts/ensure-state-bucket.sh. Puts a fake `aws` first on PATH that records every call and answers
# like S3 would in each case, then checks what the script did. Never calls AWS; writes only to a temporary folder.
# Run: bash scripts/test-ensure-state-bucket.sh   (ci.yml runs it on every push)
set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ensure-state-bucket.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

passed=0
failed=0
ok() { passed=$((passed + 1)); echo "ok   - $1"; }
not_ok() { failed=$((failed + 1)); echo "FAIL - $1" >&2; }

# The fake aws. HEAD_RESULT: ok | 404 | 403. ACCOUNT_ID: what sts get-caller-identity prints.
mkdir -p "${work}/bin"
cat >"${work}/bin/aws" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$AWS_CALLS"
case "$1 $2" in
  "sts get-caller-identity")
    [ "$ACCOUNT_ID" = "FAIL" ] && { echo "An error occurred (ExpiredToken) when calling the GetCallerIdentity operation" >&2; exit 254; }
    echo "$ACCOUNT_ID" ;;
  "s3api head-bucket")
    case "$HEAD_RESULT" in
      ok) exit 0 ;;
      404) echo "An error occurred (404) when calling the HeadBucket operation: Not Found" >&2; exit 254 ;;
      403) echo "An error occurred (403) when calling the HeadBucket operation: Forbidden" >&2; exit 254 ;;
    esac ;;
  "s3api get-bucket-location") echo "eu-north-1" ;;
esac
exit 0
FAKE
chmod +x "${work}/bin/aws"

# run <name> <head result> [account id]: sets $calls and $log; returns the script's exit code.
run() {
  local name="$1" head="$2" account="${3:-123456789012}"
  calls="${work}/${name}.calls"
  log="${work}/${name}.log"
  : >"$calls"
  PATH="${work}/bin:${PATH}" AWS_CALLS="$calls" HEAD_RESULT="$head" ACCOUNT_ID="$account" \
    STATE_BUCKET="cf-test-state" AWS_REGION="eu-north-1" GITHUB_OUTPUT="${work}/${name}.out" \
    bash "$SCRIPT" >"$log" 2>&1
}

# Every S3 call except create-bucket (which has no such option) names the expected owner.
every_s3_call_checks_owner() {
  ! grep '^s3api ' "$calls" | grep -v '^s3api create-bucket ' | grep -vq -- '--expected-bucket-owner 123456789012'
}

# 1. An existing bucket of this account is used, and the check names the account.
if run existing ok; then
  if grep -q '^s3api head-bucket --bucket cf-test-state --expected-bucket-owner 123456789012' "$calls" \
    && every_s3_call_checks_owner && ! grep -q '^s3api put-' "$calls" \
    && grep -q '^region=eu-north-1$' "${work}/existing.out"; then
    ok "an existing bucket of this account is used as it is, checked with --expected-bucket-owner"
  else
    not_ok "existing bucket: unexpected calls: $(cat "$calls")"
  fi
else
  not_ok "existing bucket failed: $(cat "$log")"
fi

# 2. A bucket of that name in another account (head-bucket 403 with the owner check) stops the deploy.
if run foreign 403; then
  not_ok "a bucket owned by another account must stop the deploy"
else
  if grep -q 'belongs to another AWS account' "$log" && ! grep -q '^s3api put-' "$calls"; then
    ok "a bucket in another account is refused, with what to do next, and nothing is written to it"
  else
    not_ok "foreign bucket: unexpected output: $(cat "$log")"
  fi
fi

# 3. A missing bucket is created and every setting is applied with the owner check.
if run missing 404; then
  if grep -q '^s3api create-bucket --bucket cf-test-state --region eu-north-1' "$calls" && every_s3_call_checks_owner \
    && [ "$(grep -c '^s3api put-' "$calls")" -eq 7 ]; then
    ok "a missing bucket is created and set up, every call checked with --expected-bucket-owner"
  else
    not_ok "missing bucket: unexpected calls: $(cat "$calls")"
  fi
else
  not_ok "missing bucket failed: $(cat "$log")"
fi

# 4. Without a readable account id nothing is touched.
if run no_account ok "None"; then
  not_ok "an unreadable account id must stop the deploy"
else
  if ! grep -q '^s3api ' "$calls" && grep -q "Could not read this AWS account's id" "$log"; then
    ok "an unreadable account id stops before any S3 call"
  else
    not_ok "no account: unexpected calls: $(cat "$calls")"
  fi
fi

# 5. A failing sts call also stops with the plain message (not silently under set -e).
if run sts_fails ok "FAIL"; then
  not_ok "a failing sts call must stop the deploy"
else
  if ! grep -q '^s3api ' "$calls" && grep -q "Could not read this AWS account's id" "$log"; then
    ok "a failing sts call stops before any S3 call, with what to do next"
  else
    not_ok "sts fails: unexpected output: $(cat "$log")"
  fi
fi

echo "${passed} passed, ${failed} failed"
[ "$failed" -eq 0 ]
