#!/usr/bin/env bash
# Makes sure the Terraform state bucket exists, so the owner only has to provide the OIDC deploy role.
# Run by deploy.yml with the deploy role's credentials.
#   STATE_BUCKET  bucket name (deploy.yml: vars.CF_STATE_BUCKET, default lamo-labs-state-bucket)
#   AWS_REGION    region to create it in when it does not exist yet
# Every call passes --expected-bucket-owner with this account's id, so a bucket of that name in another
# account is refused even when its owner lets this role in (the name is public: Terraform state holds secrets).
# An existing bucket of this account is used as it is (its settings are not touched) and its own region is reported,
# because the S3 backend must talk to the bucket's region. A missing bucket is created private
# (public access blocked, bucket-owner-enforced), versioned, encrypted (SSE-KMS, AWS-managed key),
# TLS-only and tagged.
# Writes bucket=<name> and region=<region> to $GITHUB_OUTPUT when it is set.
set -euo pipefail
: "${STATE_BUCKET:?STATE_BUCKET must be set}" "${AWS_REGION:?AWS_REGION must be set}"
BUCKET="$STATE_BUCKET"
# "|| true": a failed call must reach the plain message below, not stop silently under set -e.
ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>&1)" || true
[[ "$ACCOUNT" =~ ^[0-9]{12}$ ]] || {
  echo "::error::Could not read this AWS account's id (got '${ACCOUNT}'). Check the deploy role, then run the deploy again."
  exit 1
}
OWNER=(--expected-bucket-owner "$ACCOUNT")

if err="$(aws s3api head-bucket --bucket "$BUCKET" "${OWNER[@]}" 2>&1 >/dev/null)"; then
  loc="$(aws s3api get-bucket-location --bucket "$BUCKET" "${OWNER[@]}" --query LocationConstraint --output text)"
  # get-bucket-location reports us-east-1 as null and the oldest eu-west-1 buckets as "EU".
  case "$loc" in None | null | "") REGION="us-east-1" ;; EU) REGION="eu-west-1" ;; *) REGION="$loc" ;; esac
  echo "State bucket ${BUCKET} already exists (region ${REGION}); using it as it is."
elif printf '%s' "$err" | grep -q '404\|Not Found'; then
  REGION="$AWS_REGION"
  echo "Creating state bucket ${BUCKET} in ${REGION} ..."
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null
  fi
  aws s3api wait bucket-exists --bucket "$BUCKET" "${OWNER[@]}"
  aws s3api put-public-access-block --bucket "$BUCKET" "${OWNER[@]}" --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
  aws s3api put-bucket-ownership-controls --bucket "$BUCKET" "${OWNER[@]}" \
    --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
  aws s3api put-bucket-versioning --bucket "$BUCKET" "${OWNER[@]}" --versioning-configuration Status=Enabled
  aws s3api put-bucket-encryption --bucket "$BUCKET" "${OWNER[@]}" --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"},"BucketKeyEnabled":true}]}'
  aws s3api put-bucket-policy --bucket "$BUCKET" "${OWNER[@]}" --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"TlsOnly\",\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:*\",\"Resource\":[\"arn:aws:s3:::${BUCKET}\",\"arn:aws:s3:::${BUCKET}/*\"],\"Condition\":{\"Bool\":{\"aws:SecureTransport\":\"false\"}}}]}"
  aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" "${OWNER[@]}" --lifecycle-configuration \
    '{"Rules":[{"ID":"old-state-versions","Status":"Enabled","Filter":{},"NoncurrentVersionExpiration":{"NoncurrentDays":90},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7}}]}'
  aws s3api put-bucket-tagging --bucket "$BUCKET" "${OWNER[@]}" --tagging \
    'TagSet=[{Key=Project,Value=clip-factory},{Key=Environment,Value=prod},{Key=ManagedBy,Value=deploy.yml},{Key=Component,Value=terraform-state}]'
  echo "Created ${BUCKET}."
elif printf '%s' "$err" | grep -q '403\|Forbidden'; then
  echo "::error::State bucket ${BUCKET} belongs to another AWS account (not ${ACCOUNT}), or this role may not read it. Pick a name that is free (the repository variable CF_STATE_BUCKET, docs/DEPLOYMENT.md) and run the deploy again."
  exit 1
else
  echo "::error::Could not check the state bucket ${BUCKET}: ${err}. Run the deploy again; if it keeps failing, check the deploy role's S3 permissions."
  exit 1
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "bucket=${BUCKET}" >>"$GITHUB_OUTPUT"
  echo "region=${REGION}" >>"$GITHUB_OUTPUT"
fi
echo "bucket=${BUCKET} region=${REGION}"
