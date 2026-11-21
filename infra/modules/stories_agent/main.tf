# Lamo Stories' own agent on Amazon Bedrock AgentCore Runtime (docs/CONTRACTS.md §45.11, §45.15, §45.24, ADR-76): its
# image repository, the image itself (built from stories/agent/Dockerfile and pushed during apply), a role that names
# only Lamo Stories' keys, prefix and secrets, the runtime cf_prod_story_agent and its log group. Nothing here is shared
# with Clip Factory's agent (modules/agent): not the repository, the image, the role, the runtime or its sessions.
#
# The optional us-east-1 bucket for Amazon Nova Reel (§45.31, ADR-80) is made only when stories_video_us_bucket is
# true (an aliased provider: Nova Reel writes its shots only to a bucket in its own Region).
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = ">= 6.68.0, < 7.0.0"
      configuration_aliases = [aws.us_east_1]
    }
  }
}

locals {
  tags         = { Component = "stories_agent" }
  runtime_name = "${replace(var.name, "-", "_")}_story_agent"
  repo_root    = abspath("${path.module}/../../..")

  # Lamo Stories' own model list (§45.25); Clip Factory's config/models.json is never read here.
  models = jsondecode(file(var.models_config_path != "" ? var.models_config_path : "${local.repo_root}/stories/config/models.json"))
  model_list = [
    for m in local.models.models : {
      modelId = m.modelId
      profile = try(m.profile, null) == null ? "" : m.profile
      regions = try(m.regions, null) == null ? [] : m.regions
    }
  ]

  # The reasoning models, granted the way the clip agent's are (envs/prod): each model's inference profile in this
  # Region, and its foundation model in any Region for a global profile ("*" in regions) or in each listed destination
  # Region for a geo profile. A model without a profile is called in this Region. Converse is authorised as
  # InvokeModel, ConverseStream as InvokeModelWithResponseStream.
  model_profile_arns = sort(distinct([
    for m in local.model_list : "arn:aws:bedrock:${var.region}:${var.account_id}:inference-profile/${m.profile}" if m.profile != ""
  ]))
  model_foundation_arns = sort(distinct(flatten([
    for m in local.model_list : (
      m.profile == "" ? ["arn:aws:bedrock:${var.region}::foundation-model/${m.modelId}"] :
      contains(m.regions, "*") ? ["arn:aws:bedrock:*::foundation-model/${m.modelId}"] :
      [for r in m.regions : "arn:aws:bedrock:${r}::foundation-model/${m.modelId}"]
    )
  ])))
  model_invoke_arns = concat(local.model_profile_arns, local.model_foundation_arns)

  # Amazon Nova Canvas (character portraits, §45.11.6) in its own Region, never through a profile.
  image_model_id     = local.models.imageModel.modelId
  image_model_region = local.models.imageModel.region
  image_model_arn    = "arn:aws:bedrock:${local.image_model_region}::foundation-model/${local.image_model_id}"

  # Amazon Nova Reel (§45.31): an asynchronous job that writes its shots to the us-east-1 bucket below.
  video_model_arn   = "arn:aws:bedrock:${local.models.videoModel.region}::foundation-model/${local.models.videoModel.modelId}"
  video_jobs_arn    = "arn:aws:bedrock:${local.models.videoModel.region}:${var.account_id}:async-invoke/*"
  video_bucket_name = "${var.name}-stories-video-${var.account_id}-us"
  video_bucket_arn  = "arn:aws:s3:::${local.video_bucket_name}"

  # The runtime's log group is /aws/bedrock-agentcore/runtimes/<runtime id>-DEFAULT, and runtime ids start with the
  # runtime's name: this role writes only its own runtime's logs, never cf_prod_clip_agent's.
  log_group_arn = "arn:aws:logs:${var.region}:${var.account_id}:log-group:/aws/bedrock-agentcore/runtimes/${local.runtime_name}-*"

  # Writes and reads only in Lamo Stories' partitions (§45.3, §45.15): USER#{userId}#WS#{workspaceId} and the
  # workspace registry USER#{userId}#WSREG. Never Lamo Clips' USER#{userId}, OAUTH#, RATE# or any other partition.
  story_leading_keys = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["USER#*#WS#*", "USER#*#WSREG"] } }

  video_permissions = var.stories_video_us_bucket ? [
    # Start a Nova Reel job in us-east-1 and read its state (StartAsyncInvoke also checks InvokeModel on the model).
    { Sid = "VideoModel", Action = ["bedrock:InvokeModel", "bedrock:StartAsyncInvoke"], Resource = [local.video_model_arn, local.video_jobs_arn] },
    { Sid = "VideoJobs", Action = ["bedrock:GetAsyncInvoke"], Resource = [local.video_jobs_arn] },
    # Nova Reel writes the shots with the caller's identity; the agent reads them back and cleans up.
    {
      Sid      = "VideoFiles"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]
      Resource = ["${local.video_bucket_arn}/*"]
    },
    { Sid = "VideoFilesList", Action = ["s3:ListBucket"], Resource = [local.video_bucket_arn] },
  ] : []
}

resource "aws_ecr_repository" "agent" {
  name                 = "${var.name}-stories-agent"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "AES256"
  }
  tags = local.tags
}

resource "aws_ecr_lifecycle_policy" "agent" {
  repository = aws_ecr_repository.agent.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 15 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 15 }
      action       = { type = "expire" }
    }]
  })
}

# Built and pushed during `terraform apply`, after the repository exists and before the runtime, so one plan deploys
# from nothing. A new tag rebuilds (the only resource of this module a deploy replaces, §45.18); an existing tag is left
# alone (scripts/push-image.sh). The build context is the repository root; stories/agent/Dockerfile.dockerignore sends
# only what the image copies.
resource "terraform_data" "image" {
  triggers_replace = [var.image_tag]
  depends_on       = [aws_ecr_repository.agent]
  provisioner "local-exec" {
    command = "bash ${local.repo_root}/scripts/push-image.sh"
    environment = {
      REPO_URL    = aws_ecr_repository.agent.repository_url
      IMAGE_TAG   = var.image_tag
      AWS_REGION  = var.region
      CONTEXT_DIR = local.repo_root
      DOCKERFILE  = "${local.repo_root}/stories/agent/Dockerfile"
    }
  }
}

resource "aws_iam_role" "agent" {
  name                 = "${var.name}-stories-agent"
  permissions_boundary = var.permissions_boundary_arn == "" ? null : var.permissions_boundary_arn
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "bedrock-agentcore.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.account_id }
        ArnLike      = { "aws:SourceArn" = "arn:aws:bedrock-agentcore:${var.region}:${var.account_id}:*" }
      }
    }]
  })
  tags = local.tags
}

# docs/CONTRACTS.md §45.15: no Transcribe, no Clip Factory prefix, partition, model list, secret or skill; Secrets
# Manager only for the provider keys the owner pastes in Lamo Stories.
resource "aws_iam_role_policy" "agent" {
  name = "story-agent"
  role = aws_iam_role.agent.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [for p in concat([
      { Sid = "PullImage", Action = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], Resource = aws_ecr_repository.agent.arn },
      { Sid = "EcrToken", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      # The runtime's group is created (with retention) by terraform_data.runtime_logs right after the runtime;
      # CreateLogGroup stays so a first log line written before that step is not lost.
      {
        Sid      = "Logs"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
        Resource = [local.log_group_arn, "${local.log_group_arn}:log-stream:*"]
      },
      { Sid = "LogGroups", Action = ["logs:DescribeLogGroups"], Resource = ["arn:aws:logs:${var.region}:${var.account_id}:log-group:/aws/bedrock-agentcore/runtimes/*"] },
      { Sid = "Tracing", Action = ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"], Resource = "*" },
      {
        Sid       = "Metrics"
        Action    = ["cloudwatch:PutMetricData"]
        Resource  = "*"
        Condition = { StringEquals = { "cloudwatch:namespace" = "bedrock-agentcore" } }
      },
      {
        Sid      = "WorkloadIdentity"
        Action   = ["bedrock-agentcore:GetWorkloadAccessToken", "bedrock-agentcore:GetWorkloadAccessTokenForJWT", "bedrock-agentcore:GetWorkloadAccessTokenForUserId"]
        Resource = ["arn:aws:bedrock-agentcore:${var.region}:${var.account_id}:workload-identity-directory/default", "arn:aws:bedrock-agentcore:${var.region}:${var.account_id}:workload-identity-directory/default/workload-identity/${local.runtime_name}-*"]
      },
      # Jobs, tasks, chat turns, usage and model status: every write is fenced on its item (§45.11.1), in Lamo Stories'
      # partitions only. The table itself, no index (no Lamo Stories item sets gsi1 or gsi2).
      {
        Sid       = "StoryWrites"
        Action    = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:TransactWriteItems", "dynamodb:ConditionCheckItem"]
        Resource  = [var.table_arn]
        Condition = local.story_leading_keys
      },
      {
        Sid       = "StoryReads"
        Action    = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:BatchGetItem"]
        Resource  = [var.table_arn]
        Condition = local.story_leading_keys
      },
      # Scripts, scenes, audio, captions, finished videos, references, skills and chat pictures: ws/ only (§45.4).
      {
        Sid      = "StoryFiles"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]
        Resource = ["${var.media_bucket_arn}/ws/*"]
      },
      {
        Sid       = "StoryFilesList"
        Action    = ["s3:ListBucket"]
        Resource  = [var.media_bucket_arn]
        Condition = { StringLike = { "s3:prefix" = ["ws/*"] } }
      },
      # The models of stories/config/models.json (the owner's pick per workspace, agent, task and request, §45.25).
      { Sid = "StoryModels", Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], Resource = local.model_invoke_arns },
      # Amazon Nova Canvas in eu-west-1 (character portraits, off until the owner picks it, §45.11.6).
      { Sid = "ImageModel", Action = ["bedrock:InvokeModel"], Resource = [local.image_model_arn] },
      # Provider keys the owner pastes in Lamo Stories › Settings (§45.31): read only, never a social token or app key.
      { Sid = "ProviderKeys", Action = ["secretsmanager:GetSecretValue"], Resource = [var.workspace_provider_secrets_arn] },
    ], local.video_permissions) : merge({ Effect = "Allow" }, p)]
  })

  lifecycle {
    precondition {
      condition = alltrue([
        for m in local.model_list : trimspace(m.modelId) != "" && !strcontains(m.modelId, "*") && !strcontains(m.profile, "*") &&
        length(m.regions) > 0 && (contains(m.regions, "*") ? length(m.regions) == 1 && startswith(m.profile, "global.") : alltrue([for r in m.regions : can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]$", r))]))
      ])
      error_message = "stories/config/models.json: every model needs a modelId and a profile without wildcards, and regions that are either [\"*\"] (a global profile) or real Region names."
    }
    precondition {
      condition = (!strcontains(local.image_model_id, "*") && local.image_model_region == "eu-west-1" &&
      !strcontains(local.models.videoModel.modelId, "*") && local.models.videoModel.region == "us-east-1")
      error_message = "stories/config/models.json: imageModel (Nova Canvas) is called in eu-west-1 and videoModel (Nova Reel) in us-east-1, by their own model ids."
    }
  }
}

resource "aws_bedrockagentcore_agent_runtime" "agent" {
  depends_on         = [terraform_data.image, aws_iam_role_policy.agent]
  agent_runtime_name = local.runtime_name
  description        = "Lamo Stories agent: writes, draws, animates and checks short animated story videos"
  role_arn           = aws_iam_role.agent.arn
  platform_version   = "V2"
  agent_runtime_artifact {
    container_configuration {
      container_uri = "${aws_ecr_repository.agent.repository_url}:${var.image_tag}"
    }
  }
  network_configuration {
    network_mode = "PUBLIC" # Bedrock and S3 over the internet; inbound only through AgentCore with IAM
  }
  # Like the clip runtime: a job runs in the background of one session and the agent answers HealthyBusy while it
  # works, so the 15-minute idle timeout only ends sessions that are really done; 8 hours is the hard cap.
  lifecycle_configuration {
    idle_runtime_session_timeout = 900
    max_lifetime                 = 28800
  }
  # §45.11.4. CF_VIDEO_BUCKET is set only while the us-east-1 bucket exists (absent reads as empty: Nova Reel off).
  environment_variables = merge({
    CF_STORIES_TABLE  = var.table_name
    CF_MEDIA_BUCKET   = var.media_bucket
    CF_REGION         = var.region
    CF_IMAGE_MODEL_ID = local.image_model_id
    CF_IMAGE_REGION   = local.image_model_region
    AWS_REGION        = var.region
  }, var.stories_video_us_bucket ? { CF_VIDEO_BUCKET = local.video_bucket_name } : {})
  tags = local.tags
}

# The clip runtime's pattern (modules/agent): AgentCore writes the runtime's logs to
# /aws/bedrock-agentcore/runtimes/<runtime id>-DEFAULT and, left alone, creates that group with no expiry. The name is
# only known once the runtime exists, so the apply creates it if it is missing and always sets the same retention as
# every other log group in the stack. It runs again whenever the runtime (its id) or the retention changes. A destroy
# leaves the group in place.
resource "terraform_data" "runtime_logs" {
  triggers_replace = [aws_bedrockagentcore_agent_runtime.agent.agent_runtime_id, var.log_retention_days]
  input = {
    log_group      = "/aws/bedrock-agentcore/runtimes/${aws_bedrockagentcore_agent_runtime.agent.agent_runtime_id}-DEFAULT"
    retention_days = var.log_retention_days
  }
  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-EOT
      set -euo pipefail
      if out="$(aws logs create-log-group --log-group-name "$LOG_GROUP" --tags "Project=clip-factory,Environment=prod,ManagedBy=terraform,Component=stories_agent" 2>&1)"; then
        echo "Created $LOG_GROUP."
      elif grep -q ResourceAlreadyExistsException <<<"$out"; then
        echo "$LOG_GROUP already exists."
      else
        echo "$out" >&2
        exit 1
      fi
      aws logs put-retention-policy --log-group-name "$LOG_GROUP" --retention-in-days "$RETENTION_DAYS"
      echo "$LOG_GROUP keeps logs for $RETENTION_DAYS days."
    EOT
    environment = {
      LOG_GROUP      = self.input.log_group
      RETENTION_DAYS = tostring(self.input.retention_days)
      AWS_REGION     = var.region
    }
  }
}

# ---------- Nova Reel's bucket in us-east-1 (only with stories_video_us_bucket) ----------
# Generated shots only (realistic AI footage, posted only with the platforms' AI labels, §45.14): private, TLS only,
# deleted after 14 days. The agent copies what a story keeps into ws/ in the media bucket.
resource "aws_s3_bucket" "video_us" {
  count    = var.stories_video_us_bucket ? 1 : 0
  provider = aws.us_east_1
  bucket   = local.video_bucket_name
  tags     = local.tags
}

resource "aws_s3_bucket_ownership_controls" "video_us" {
  count    = var.stories_video_us_bucket ? 1 : 0
  provider = aws.us_east_1
  bucket   = aws_s3_bucket.video_us[0].id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "video_us" {
  count                   = var.stories_video_us_bucket ? 1 : 0
  provider                = aws.us_east_1
  bucket                  = aws_s3_bucket.video_us[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "video_us" {
  count    = var.stories_video_us_bucket ? 1 : 0
  provider = aws.us_east_1
  bucket   = aws_s3_bucket.video_us[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "video_us" {
  count    = var.stories_video_us_bucket ? 1 : 0
  provider = aws.us_east_1
  bucket   = aws_s3_bucket.video_us[0].id
  rule {
    id     = "shots-14-days"
    status = "Enabled"
    filter {}
    expiration {
      days = 14
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_policy" "video_us" {
  count      = var.stories_video_us_bucket ? 1 : 0
  provider   = aws.us_east_1
  bucket     = aws_s3_bucket.video_us[0].id
  depends_on = [aws_s3_bucket_public_access_block.video_us]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "TlsOnly"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.video_us[0].arn, "${aws_s3_bucket.video_us[0].arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}
