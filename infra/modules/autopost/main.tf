# Auto-posting (docs/CONTRACTS.md §46, docs/DECISIONS.md ADR-81):
#   cf-prod-autopost  fires every hour on the hour (EventBridge, cf-prod-autopost-hourly). For each owner in
#                     AUTOPOSTOWNERS (one Query) it runs only when his X hours are up (§46.4), picks the oldest clips
#                     in Review (§46.5) and sends each one through Upload's own code (§46.7): one conditional
#                     transaction per clip and the idempotent start of cf-prod-clip-flow on its live alias, so a clip
#                     is confirmed and started only once, even when a tick is retried or two runs overlap.
#
# Additive only: a new function, role, log group, async-invoke config, rule, target and permission. No table, index,
# secret or bucket is created, changed or deleted here, and cf-prod-api is not touched (its run-now test actions run
# inline with Upload's existing grants). The role has no DeleteItem, no Scan and no S3.
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

locals {
  tags            = { Component = "autopost" }
  function_name   = "${var.name}-autopost"
  table_resources = [var.table_arn, "${var.table_arn}/index/*"]
}

resource "aws_cloudwatch_log_group" "autopost" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_iam_role" "autopost" {
  name                 = "${var.name}-fn-autopost"
  permissions_boundary = var.permissions_boundary_arn == "" ? null : var.permissions_boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
  tags = local.tags
}

# Exactly what api/src/clipfactory_api/autopost/** and Upload's core (uploads.upload_review_clip) call, beyond logs
# and traces (§46.11).
resource "aws_iam_role_policy" "autopost" {
  name = "least-privilege"
  role = aws_iam_role.autopost.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Logs", Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.autopost.arn}:*" },
      { Sid = "Tracing", Effect = "Allow", Action = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"], Resource = "*" },
      # AUTOPOSTOWNERS (Query), the owner's settings, AUTOPOST and AUTORUN# items, his clips, jobs, posts, accounts and
      # campaigns, and Upload's one transaction per clip (confirmed and its posts, conditional on status = review).
      # Never DeleteItem and never Scan: nothing here can remove the owner's data.
      {
        Sid      = "Data"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:BatchGetItem", "dynamodb:TransactWriteItems", "dynamodb:ConditionCheckItem"]
        Resource = local.table_resources
      },
      # Starts clip-{clipId}-{flowRun} on the clip flow's live alias (any qualifier of clip-flow, never another
      # function), as the API's StartFlows and the hooks' StartClipFlow.
      { Sid = "StartClipFlow", Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = ["${var.clip_flow_arn_prefix}:*"] },
      # For the campaign fit check only (§46.5 rule 4), the clip flow's Content Rewards grants: read the app keys and
      # tokens; write a refreshed (rotated) token back, only to {platform}/token. Never create or delete a secret,
      # never write the app keys or pending choices.
      { Sid = "PlatformSecretsRead", Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [var.platform_secrets_arn] },
      { Sid = "PlatformTokens", Effect = "Allow", Action = ["secretsmanager:PutSecretValue"], Resource = [var.platform_token_secrets_arn] },
    ]
  })
}

resource "aws_lambda_function" "autopost" {
  function_name    = local.function_name
  role             = aws_iam_role.autopost.arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = "clipfactory_api.autopost.handler.handler"
  filename         = var.lambda_zip_path
  source_code_hash = filebase64sha256(var.lambda_zip_path)
  timeout          = 300 # a run starts no new clip after AUTOPOST_TIME_BUDGET_SECONDS (240)
  memory_size      = 256

  tracing_config {
    mode = "Active"
  }
  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.autopost.name
  }
  environment {
    variables = {
      TABLE_NAME    = var.table_name
      MEDIA_BUCKET  = var.media_bucket
      CLIP_FLOW_ARN = var.clip_flow_alias_arn # executions start on the alias live, never on the bare function
      SECRET_PREFIX = var.secret_prefix
      # §38.12, §46.5 rule 4: campaign clips are only ever taken while this is "on".
      CONTENT_REWARDS              = var.content_rewards_enabled ? "on" : "off"
      AUTOPOST_TIME_BUDGET_SECONDS = "240"
    }
  }

  tags = local.tags
  # The role's policy must exist before the function first runs.
  depends_on = [aws_iam_role_policy.autopost]
}

# Only ever invoked asynchronously (EventBridge). A retry is the same event, so the same slot and runId: it resumes its
# own run (§46.7 step 3) and never posts a clip twice. Nothing older than 55 minutes: the next tick comes first.
resource "aws_lambda_function_event_invoke_config" "autopost" {
  function_name                = aws_lambda_function.autopost.function_name
  maximum_retry_attempts       = 2
  maximum_event_age_in_seconds = 3300
}

# Every hour at :00 UTC (§46.4). The function itself decides whether an owner's X hours are up, so a saved change
# takes effect from the next full hour without a redeploy, and the gaps stay even across midnight.
resource "aws_cloudwatch_event_rule" "autopost" {
  name                = "${var.name}-autopost-hourly"
  description         = "Every hour on the hour: posts the oldest clips in Review when an owner's auto-posting is due (Auto-posting)."
  schedule_expression = "cron(0 * * * ? *)"
  state               = "ENABLED"
  tags                = local.tags
}

resource "aws_cloudwatch_event_target" "autopost" {
  rule      = aws_cloudwatch_event_rule.autopost.name
  target_id = "autopost-hourly"
  arn       = aws_lambda_function.autopost.arn # unqualified: always the current code
  retry_policy {
    maximum_event_age_in_seconds = 3300
    maximum_retry_attempts       = 2
  }
}

resource "aws_lambda_permission" "autopost" {
  statement_id  = "events-autopost-hourly"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.autopost.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.autopost.arn
}
