# The clip agent on Amazon Bedrock AgentCore Runtime (docs/CONTRACTS.md §8): its image repository, the image
# itself (built and pushed during apply), a least-privilege execution role and the runtime.
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

locals {
  tags = { Component = "agent" }
  # Built from the name, not taken from modules/flows: job-flow already depends on this module's runtime ARN.
  # Callbacks are authorized against the durable execution ARN (function:NAME:<version>/durable-execution/...).
  job_flow_executions = "arn:aws:lambda:${var.region}:${var.account_id}:function:${var.name}-job-flow:*"
  runtime_name        = "${replace(var.name, "-", "_")}_clip_agent"
  repo_root           = abspath("${path.module}/../../..")
}

resource "aws_ecr_repository" "agent" {
  name                 = "${var.name}-agent"
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

# Built and pushed during `terraform apply`, after the repository exists and before the runtime, so one plan
# deploys from nothing. A new tag rebuilds; an existing tag is left alone (scripts/push-image.sh).
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
      DOCKERFILE  = "${local.repo_root}/agent/Dockerfile"
    }
  }
}

resource "aws_iam_role" "agent" {
  name = "${var.name}-agent"
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

resource "aws_iam_role_policy" "agent" {
  name = "clip-agent"
  role = aws_iam_role.agent.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "PullImage", Effect = "Allow", Action = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], Resource = aws_ecr_repository.agent.arn },
      { Sid = "EcrToken", Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      {
        Sid      = "Logs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams", "logs:DescribeLogGroups"]
        Resource = ["arn:aws:logs:${var.region}:${var.account_id}:log-group:/aws/bedrock-agentcore/runtimes/*", "arn:aws:logs:${var.region}:${var.account_id}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*"]
      },
      { Sid = "Tracing", Effect = "Allow", Action = ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"], Resource = "*" },
      {
        Sid       = "Metrics"
        Effect    = "Allow"
        Action    = ["cloudwatch:PutMetricData"]
        Resource  = "*"
        Condition = { StringEquals = { "cloudwatch:namespace" = "bedrock-agentcore" } }
      },
      {
        Sid      = "WorkloadIdentity"
        Effect   = "Allow"
        Action   = ["bedrock-agentcore:GetWorkloadAccessToken", "bedrock-agentcore:GetWorkloadAccessTokenForJWT", "bedrock-agentcore:GetWorkloadAccessTokenForUserId"]
        Resource = ["arn:aws:bedrock-agentcore:${var.region}:${var.account_id}:workload-identity-directory/default", "arn:aws:bedrock-agentcore:${var.region}:${var.account_id}:workload-identity-directory/default/workload-identity/${local.runtime_name}-*"]
      },
      {
        Sid      = "JobData"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem", "dynamodb:ConditionCheckItem"]
        Resource = [var.table_arn, "${var.table_arn}/index/*"]
      },
      {
        Sid      = "MediaObjects"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:PutObjectTagging", "s3:GetObjectTagging", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]
        Resource = "${var.media_bucket_arn}/*"
      },
      { Sid = "MediaList", Effect = "Allow", Action = ["s3:ListBucket"], Resource = var.media_bucket_arn },
      {
        Sid      = "Transcribe"
        Effect   = "Allow"
        Action   = ["transcribe:StartTranscriptionJob", "transcribe:GetTranscriptionJob", "transcribe:DeleteTranscriptionJob"]
        Resource = "arn:aws:transcribe:${var.region}:${var.account_id}:transcription-job/*"
      },
      {
        Sid      = "InvokeFable"
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:Converse*"]
        Resource = var.model_invoke_arns
      },
      { Sid = "ReadProfile", Effect = "Allow", Action = ["bedrock:GetInferenceProfile"], Resource = var.model_profile_arn },
      # Ends the job's durable execution: heartbeats while it runs, then success or failure (§14.4).
      {
        Sid      = "JobFlowCallback"
        Effect   = "Allow"
        Action   = ["lambda:SendDurableExecutionCallbackSuccess", "lambda:SendDurableExecutionCallbackFailure", "lambda:SendDurableExecutionCallbackHeartbeat"]
        Resource = local.job_flow_executions
      },
      # "What worked before": put new clips' vectors at finalize, query similar performed clips before select (§14.6).
      # A filtered query that returns metadata also needs GetVectors.
      {
        Sid      = "ClipVectors"
        Effect   = "Allow"
        Action   = ["s3vectors:PutVectors", "s3vectors:QueryVectors", "s3vectors:GetVectors"]
        Resource = var.vector_index_arn
      },
      { Sid = "Embeddings", Effect = "Allow", Action = ["bedrock:InvokeModel"], Resource = var.embed_model_arn },
    ]
  })
}

resource "aws_bedrockagentcore_agent_runtime" "agent" {
  depends_on         = [terraform_data.image, aws_iam_role_policy.agent]
  agent_runtime_name = local.runtime_name
  description        = "Clip Factory agent: turns one source video into reviewed vertical clips"
  role_arn           = aws_iam_role.agent.arn
  platform_version   = "V2"
  agent_runtime_artifact {
    container_configuration {
      container_uri = "${aws_ecr_repository.agent.repository_url}:${var.image_tag}"
    }
  }
  network_configuration {
    network_mode = "PUBLIC" # downloads from YouTube, Twitch and Kick; inbound only through AgentCore with IAM
  }
  # A job runs in the background of one session. The agent answers HealthyBusy while it works, so the 15-minute
  # idle timeout only ends sessions that are really done; 8 hours is the hard cap for one job.
  lifecycle_configuration {
    idle_runtime_session_timeout = 900
    max_lifetime                 = 28800
  }
  environment_variables = {
    CF_REGION               = var.region
    CF_TABLE                = var.table_name
    CF_MEDIA_BUCKET         = var.media_bucket
    CF_MODEL_ID             = var.model_id
    CF_SKILLS_DIR           = "/app/skills"
    CLAUDE_CODE_USE_BEDROCK = "1"
    ANTHROPIC_MODEL         = var.model_id
    AWS_REGION              = var.region
    CF_VECTOR_BUCKET        = var.vector_bucket
    CF_VECTOR_INDEX         = var.vector_index
    CF_EMBED_MODEL_ID       = var.embed_model_id
  }
  tags = local.tags
}
