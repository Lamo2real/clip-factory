# Real earnings (docs/CONTRACTS.md §25.6, docs/DECISIONS.md ADR-47):
#   cf-prod-money  once a day (06:00 UTC, after the 05:00 learning run) reads each connected platform's account numbers
#                  and the money the platform itself reports (YouTube Analytics estimatedRevenue; Facebook only after
#                  its live check), and writes ACCTSTAT#, REVENUE# and MONEYSTATE# items under the owner. cf-prod-api
#                  invokes it asynchronously for "Check now" (at most once an hour, one conditional write).
#
# Additive only: a new function, role, log group and schedule. No table, index, secret or bucket is created, changed
# or deleted here. Tokens are read and refreshed only through the shared token manager (its DynamoDB lease keeps X
# and TikTok rotations single), with exactly the secret access cf-prod-stats has. The role has no DeleteItem.
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

locals {
  tags            = { Component = "money" }
  function_name   = "${var.name}-money"
  table_resources = [var.table_arn]
}

resource "aws_cloudwatch_log_group" "money" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_iam_role" "money" {
  name                 = "${var.name}-fn-money"
  permissions_boundary = var.permissions_boundary_arn == "" ? null : var.permissions_boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
  tags = local.tags
}

# Exactly what api/src/clipfactory_api/money/** calls, beyond logs and traces.
resource "aws_iam_role_policy" "money" {
  name = "least-privilege"
  role = aws_iam_role.money.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Logs", Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.money.arn}:*" },
      { Sid = "Tracing", Effect = "Allow", Action = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"], Resource = "*" },
      # MONEYOWNERS (Query), the owner's accounts, posts, ACCTSTAT#/REVENUE#/MONEYSTATE#/MONEYPREFS items, the token
      # refresh lease on the Account, the moneyScopesMissing flag, each Post's revenue and the RATE#* budgets.
      # Never DeleteItem and never Scan: nothing here can remove the owner's data.
      { Sid = "Data", Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"], Resource = local.table_resources },
      # Read the owner's app keys and tokens; write a refreshed (rotated) token back, only to {platform}/token.
      # Never create or delete a secret, never write the app keys or pending choices. Same as cf-prod-stats.
      { Sid = "PlatformSecretsRead", Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [var.platform_secrets_arn] },
      { Sid = "PlatformTokens", Effect = "Allow", Action = ["secretsmanager:PutSecretValue"], Resource = [var.platform_token_secrets_arn] },
    ]
  })
}

resource "aws_lambda_function" "money" {
  function_name    = local.function_name
  role             = aws_iam_role.money.arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = "clipfactory_api.money.handler.handler"
  filename         = var.lambda_zip_path
  source_code_hash = filebase64sha256(var.lambda_zip_path)
  timeout          = 300 # the run stops starting new work after MONEY_TIME_BUDGET_SECONDS (240)
  memory_size      = 256

  tracing_config {
    mode = "Active"
  }
  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.money.name
  }
  environment {
    variables = merge({
      TABLE_NAME                = var.table_name
      SECRET_PREFIX             = var.secret_prefix
      MONEY_TIME_BUDGET_SECONDS = "240"
      # §40.5.11: Your bank's reader follows the same switch as cf-prod-api, so turning it off also stops the daily
      # read (the way back if Enable Banking says no). CONTENT_REWARDS: a Whop hint suggests Content Rewards only
      # while it is on. An in-place env change.
      BANK_READING    = var.bank_reading_enabled ? "on" : "off"
      CONTENT_REWARDS = var.content_rewards_enabled ? "on" : "off"
      # APP_URL fills the psu-referer header of his attended bank read ({APP_URL}/settings/posting/getpaid/bank).
    }, var.app_url == "" ? {} : { APP_URL = var.app_url })
  }

  tags = local.tags
  # The role's policy must exist before the function first runs.
  depends_on = [aws_iam_role_policy.money]
}

# Only ever invoked asynchronously (EventBridge, InvocationType=Event). Tomorrow's run does the same work: never retry
# (budgets), drop anything older than an hour.
resource "aws_lambda_function_event_invoke_config" "money" {
  function_name                = aws_lambda_function.money.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 3600
}

resource "aws_cloudwatch_event_rule" "money" {
  name                = "${var.name}-money-daily"
  description         = "Once a day: each platform's account numbers and the money it reports (Real earnings)."
  schedule_expression = "cron(0 6 * * ? *)" # 06:00 UTC, after the 05:00 learning run
  state               = "ENABLED"
  tags                = local.tags
}

resource "aws_cloudwatch_event_target" "money" {
  rule      = aws_cloudwatch_event_rule.money.name
  target_id = "money-daily"
  arn       = aws_lambda_function.money.arn # unqualified: always the current code
  retry_policy {
    maximum_event_age_in_seconds = 3600
    maximum_retry_attempts       = 0
  }
}

resource "aws_lambda_permission" "money" {
  statement_id  = "events-money-daily"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.money.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.money.arn
}
