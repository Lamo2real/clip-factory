#!/usr/bin/env bash
# Called by Terraform (infra, during `terraform apply`) after the ECR repository exists and before the
# AgentCore runtime is created, so one apply can deploy from nothing. Builds the agent image for ARM64
# and pushes it. The tag is a hash of agent/**, skills/** and config/** (deploy.yml), and an image that
# is already in ECR is left alone, so pushes that do not touch the agent do not rebuild it.
# Needs Docker with buildx (plus QEMU on x86 runners; deploy.yml sets both up before the apply).
#   REPO_URL     ECR repository URL (<account>.dkr.ecr.<region>.amazonaws.com/<name>)
#   IMAGE_TAG    tag to push
#   AWS_REGION   region of the repository
#   CONTEXT_DIR  build context: the repository root (the image bundles skills/ and config/)
#   DOCKERFILE   optional, default <CONTEXT_DIR>/agent/Dockerfile
set -euo pipefail
: "${REPO_URL:?REPO_URL must be set}" "${IMAGE_TAG:?IMAGE_TAG must be set}"
: "${AWS_REGION:?AWS_REGION must be set}" "${CONTEXT_DIR:?CONTEXT_DIR must be set}"
DOCKERFILE="${DOCKERFILE:-${CONTEXT_DIR}/agent/Dockerfile}"

REPO_NAME="${REPO_URL#*/}"
if aws ecr describe-images --region "$AWS_REGION" --repository-name "$REPO_NAME" \
  --image-ids "imageTag=${IMAGE_TAG}" >/dev/null 2>&1; then
  echo "Image ${REPO_URL}:${IMAGE_TAG} is already in ECR."
  exit 0
fi

aws ecr get-login-password --region "$AWS_REGION" |
  docker login --username AWS --password-stdin "${REPO_URL%%/*}"
# --provenance=false keeps the push a single-platform image manifest, which AgentCore expects.
docker buildx build --platform linux/arm64 \
  -f "$DOCKERFILE" \
  -t "${REPO_URL}:${IMAGE_TAG}" --provenance=false --push "$CONTEXT_DIR"
echo "Pushed ${REPO_URL}:${IMAGE_TAG}."
