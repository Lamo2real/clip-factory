# cf-prod-stories-api: Lamo Stories' own API Lambda (docs/CONTRACTS.md §45.5, §45.15, §45.24, ADR-76). The same zip as
# cf-prod-api, another handler (clipfactory_api.workspaces.http.handler, which dispatches only the /v1/workspaces routes
# and Lamo Stories' OAuth callback), its own log group and its own role. API Gateway sends it ANY /v1/workspaces,
# ANY /v1/workspaces/{proxy+} and GET /v1/stories-oauth/{platform}/callback (modules/api); every other path still
# reaches cf-prod-api, whose function, role and environment this module never touches. Its errors alarm comes from
# modules/monitoring through function_names.
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

locals {
  tags          = { Component = "stories_api" }
  function_name = "${var.name}-stories-api"

  # Lamo Stories' partitions (§45.3): the workspace partitions, the workspace registry and its own OAuth connect states
  # (OAUTH#ws.{nonce}, never Clip Factory's OAUTH#{nonce}).
  story_leading_keys = ["USER#*#WS#*", "USER#*#WSREG", "OAUTH#ws.*"]

  # The five attributes of Lamo Clips' ACCOUNT# items "same as Clip Factory" compares (§45.13.3, §45.15): GetItem with a
  # ProjectionExpression of these names only. IAM limits partitions, not sort keys; the code reads only
  # ACCOUNT#{platform}, so nothing else of USER#{userId} is ever returned.
  clips_account_attributes = ["pk", "sk", "platform", "status", "accountId"]

  # Clip Factory's developer apps Lamo Stories may use on the owner's choice (§45.30): YouTube, TikTok and X only,
  # read only. Facebook and Instagram always use Lamo Stories' own Meta app (under <name>/workspaces/). No "-" before
  # the "*": deleted keys must read as not found, not AccessDenied.
  shared_app_platforms   = ["youtube", "tiktok", "x"]
  shared_app_secret_arns = [for p in local.shared_app_platforms : "${trimsuffix(var.platform_secrets_arn, "*")}${p}/app*"]

  env = {
    TABLE_NAME                = var.table_name
    MEDIA_BUCKET              = var.media_bucket
    STORIES_AGENT_RUNTIME_ARN = var.stories_agent_runtime_arn
    STORY_FLOW_ARN            = var.story_flow_alias_arn
    WS_SECRET_PREFIX          = var.ws_secret_prefix
    SECRET_PREFIX             = var.secret_prefix
    OAUTH_STATE_SECRET        = var.oauth_state_secret_name
    HOOKS_URL                 = var.hooks_url
    STORIES_OAUTH_CALLBACK    = var.stories_oauth_callback
    APP_URL                   = var.app_url
    VERSION                   = var.app_version
  }

  permissions = [
    # Every Lamo Stories item (§45.3): the table itself, no index (no Lamo Stories item sets gsi1 or gsi2).
    {
      Sid       = "WorkspaceData"
      Action    = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem", "dynamodb:TransactWriteItems", "dynamodb:ConditionCheckItem"]
      Resource  = [var.table_arn]
      Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = local.story_leading_keys } }
    },
    # Lamo Clips' ACCOUNT#{platform}: read only, five attributes, GetItem only ("same as Lamo Clips", Lamo Clips'
    # destinations on the Connections page). No Query of USER#{userId}, nothing returned by a write.
    {
      Sid      = "ClipsAccountRead"
      Action   = ["dynamodb:GetItem"]
      Resource = [var.table_arn]
      Condition = {
        "ForAllValues:StringLike"   = { "dynamodb:LeadingKeys" = ["USER#*"] }
        "ForAllValues:StringEquals" = { "dynamodb:Attributes" = local.clips_account_attributes }
        "StringEqualsIfExists"      = { "dynamodb:Select" = "SPECIFIC_ATTRIBUTES", "dynamodb:ReturnValues" = "NONE" }
      }
    },
    # Presigned uploads and downloads (references, skills, chat pictures, multipart reference videos), HEAD checks and
    # deletes, all under ws/ (§45.4); a listing only with the ws/ prefix.
    {
      Sid      = "WorkspaceFiles"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]
      Resource = ["${var.media_bucket_arn}/ws/*"]
    },
    {
      Sid       = "WorkspaceFilesList"
      Action    = ["s3:ListBucket"]
      Resource  = [var.media_bucket_arn]
      Condition = { StringLike = { "s3:prefix" = ["ws/*"] } }
    },
    # Lamo Stories' tokens, pending Meta choices, own app keys and provider keys (§45.13.1, §45.30, §45.31).
    {
      Sid      = "WorkspaceSecrets"
      Action   = ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret", "secretsmanager:DeleteSecret", "secretsmanager:TagResource"]
      Resource = [var.workspace_secrets_arn]
    },
    # Clip Factory's YouTube, TikTok and X app keys: read only (never written, rotated or deleted, never Meta's).
    { Sid = "ClipsAppKeysRead", Action = ["secretsmanager:GetSecretValue"], Resource = local.shared_app_secret_arns },
    # Sign the w1. state and derive the PKCE verifier (the same key as Clip Factory's states, read only).
    { Sid = "OAuthStateKey", Action = ["secretsmanager:GetSecretValue"], Resource = [var.oauth_state_secret_arn] },
    # Lamo Stories' own runtime only (cfstory- sessions); never cf_prod_clip_agent.
    {
      Sid      = "StoryAgent"
      Action   = ["bedrock-agentcore:InvokeAgentRuntime", "bedrock-agentcore:StopRuntimeSession"]
      Resource = [var.stories_agent_runtime_arn, "${var.stories_agent_runtime_arn}/*"]
    },
    # Start publishing on the story flow's alias live (§45.14), and no other function.
    { Sid = "StartStoryFlow", Action = ["lambda:InvokeFunction"], Resource = [var.story_flow_alias_arn] },
  ]
}

resource "aws_cloudwatch_log_group" "fn" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_iam_role" "fn" {
  name                 = "${var.name}-fn-stories-api"
  permissions_boundary = var.permissions_boundary_arn == "" ? null : var.permissions_boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy" "fn" {
  name = "least-privilege"
  role = aws_iam_role.fn.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        { Sid = "Logs", Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.fn.arn}:*" },
        { Sid = "Tracing", Effect = "Allow", Action = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"], Resource = "*" },
      ],
      [for p in local.permissions : merge({ Effect = "Allow" }, p)],
    )
  })
}

resource "aws_lambda_function" "fn" {
  function_name    = local.function_name
  role             = aws_iam_role.fn.arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = "clipfactory_api.workspaces.http.handler"
  filename         = var.lambda_zip_path
  source_code_hash = filebase64sha256(var.lambda_zip_path)
  timeout          = 29
  memory_size      = 1024
  tracing_config {
    mode = "Active"
  }
  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.fn.name
  }
  environment {
    variables = local.env
  }
  tags = local.tags
  # The role's policy must exist before the function first runs.
  depends_on = [aws_iam_role_policy.fn]
}
