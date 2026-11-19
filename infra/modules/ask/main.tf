# Ask as a full assistant (docs/CONTRACTS.md §28, docs/DECISIONS.md ADR-51):
#   cf-prod-ask  answers one question with Claude Opus 5.5 on Claude in Amazon Bedrock (the bedrock-mantle Messages
#                API, in-Region eu-north-1) and streams it to the owner's WebSocket connection. cf-prod-api starts it
#                with an async Invoke (retries 0, so an answer never runs twice).
#
# Additive only: a new function, role, log group and async-invoke config. No table, index, bucket or secret is created,
# changed or deleted here. The role reads the owner's data and the question's files, deletes those files, writes only
# the rate and Stop items it already shares with cf-prod-api, posts to WebSocket connections and reads the search key.
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

locals {
  tags          = { Component = "ask" }
  function_name = "${var.name}-ask"
  # bedrock-mantle:CreateInference takes the project resource (Service Authorization Reference, "Amazon Bedrock
  # Powered by AWS Mantle", checked 2026-11-19): arn:${Partition}:bedrock-mantle:${Region}:${Account}:project/${ResourceId}.
  # Models are narrowed with the bedrock-mantle:Model condition key, so only the two Ask models can be called.
  mantle_project_arn = "arn:aws:bedrock-mantle:${var.ask_region}:${var.account_id}:project/*"
}

resource "aws_cloudwatch_log_group" "ask" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_iam_role" "ask" {
  name                 = "${var.name}-fn-ask"
  permissions_boundary = var.permissions_boundary_arn == "" ? null : var.permissions_boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
  tags = local.tags
}

# Exactly what api/src/clipfactory_api/ask/** calls, beyond logs and traces.
resource "aws_iam_role_policy" "ask" {
  name = "least-privilege"
  role = aws_iam_role.ask.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Logs", Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.ask.arn}:*" },
      { Sid = "Tracing", Effect = "Allow", Action = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"], Resource = "*" },
      # Opus 5.5 and its refusal fallback Opus 4.8, nothing else. No bedrock:* and no bearer tokens.
      {
        Sid       = "AskModel"
        Effect    = "Allow"
        Action    = ["bedrock-mantle:CreateInference"]
        Resource  = [local.mantle_project_arn]
        Condition = { StringEquals = { "bedrock-mantle:Model" = [var.ask_model_id, var.ask_fallback_model_id] } }
      },
      # The question's files: read once, deleted when the answer ends. The owner's skill files (§18.6).
      { Sid = "AskFiles", Effect = "Allow", Action = ["s3:GetObject", "s3:DeleteObject"], Resource = ["${var.media_bucket_arn}/ask/*"] },
      { Sid = "SkillFiles", Effect = "Allow", Action = ["s3:GetObject"], Resource = ["${var.media_bucket_arn}/skills/*"] },
      # APP STATE and read_my_clip_factory (Get, Query), the Stop item (Get). Read only: no writes of any kind.
      { Sid = "Data", Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:Query"], Resource = [var.table_arn, "${var.table_arn}/index/*"] },
      # Stream the answer to the owner's own connection (the id was checked by cf-prod-api).
      { Sid = "Stream", Effect = "Allow", Action = ["execute-api:ManageConnections"], Resource = [var.ws_connections_arn] },
      # The web search key, saved by the owner in Settings › App & account › Ask.
      { Sid = "SearchKey", Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [var.search_secret_arn] },
    ]
  })
}

resource "aws_lambda_function" "ask" {
  function_name    = local.function_name
  role             = aws_iam_role.ask.arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = "clipfactory_api.ask.worker.handler"
  filename         = var.lambda_zip_path
  source_code_hash = filebase64sha256(var.lambda_zip_path)
  timeout          = 150 # the answer's hard budget is 110 s; files and the last events fit in the rest
  memory_size      = 1024

  tracing_config {
    mode = "Active"
  }
  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.ask.name
  }
  environment {
    variables = {
      TABLE_NAME            = var.table_name
      MEDIA_BUCKET          = var.media_bucket
      WS_ENDPOINT           = var.ws_endpoint
      ASK_MODEL_ID          = var.ask_model_id
      ASK_FALLBACK_MODEL_ID = var.ask_fallback_model_id
      ASK_REGION            = var.ask_region
      ASK_EFFORT            = var.ask_effort
      ASK_EAGER_TOOLS       = var.ask_eager_tools ? "true" : "false"
      ASK_SEARCH_SECRET     = var.search_secret_name
      HELP_ENABLED          = var.help_enabled ? "true" : "false"
    }
  }

  tags = local.tags
  # The role's policy must exist before the function first runs.
  depends_on = [aws_iam_role_policy.ask]
}

# No reserved concurrency (spec §28.12 asked for 3): this account cannot reserve any (docs/DECISIONS.md, the stats
# and follow ticks hit the same limit), and a deploy that tries fails. The per-owner rate limit (6 a minute, 60 an
# hour, 400 a day, one conditional write in cf-prod-api) bounds how many answers run at once instead.
# Only ever invoked asynchronously by cf-prod-api. Never retried (an answer must not run twice); a question that
# waited a minute is dropped (the panel has long given up and answered from the help corpus).
resource "aws_lambda_function_event_invoke_config" "ask" {
  function_name                = aws_lambda_function.ask.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 60
}
