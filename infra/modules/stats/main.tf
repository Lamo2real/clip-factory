# Clip numbers and weekly learning (docs/CONTRACTS.md §16.5, §16.6, §16.9):
#   cf-prod-stats  keeps every posted clip's numbers fresh for 30 days. An EventBridge rule ticks it every
#                  stats_tick minutes (the lowest platform interval in config/platforms.json); cf-prod-api invokes
#                  it asynchronously for "Refresh numbers". Each platform is polled no faster than its own interval,
#                  which the code enforces per post; the tick only sets the fastest possible pace.
#   cf-prod-learn  turns the owner's "Best this week" picks into one learning (Bedrock Converse, Fable) and marks
#                  the picked clips' vectors best = true. cf-prod-api invokes it asynchronously on PUT .../best.
#                  Once a day (05:00 UTC, its own EventBridge rule) it also learns from the clips that did far better
#                  than normal 7 days after posting (§16.12): no new winners, no model call.
#                  Like every model call it gets the owner's skills (§18.6), read from skills/* in the media bucket.
#
# Both run the shared package (api/dist/lambda.zip). No reserved concurrency: new accounts' limits forbid it, and
# the rate budgets are conditional DynamoDB writes, so two overlapping runs cannot overspend.
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

locals {
  tags            = { Component = "stats" }
  table_resources = [var.table_arn, "${var.table_arn}/index/*"]

  # config/platforms.json is the only place refresh intervals live (§16.4). The tick is the fastest interval.
  platforms  = jsondecode(file(var.platforms_config_path))
  stats_tick = min([for p in values(local.platforms.platforms) : p.minIntervalMinutes]...)
  # "rate(1 minute)" is singular; any other value is plural.
  stats_schedule = local.stats_tick == 1 ? "rate(1 minute)" : "rate(${local.stats_tick} minutes)"

  # Unqualified ARNs built from the names, so callers can be wired without waiting on these functions.
  arn_prefix = "arn:aws:lambda:${var.region}:${var.account_id}:function:${var.name}"

  functions = {
    stats = {
      handler = "clipfactory_api.stats.handler.handler"
      memory  = 256
      timeout = 300 # a tick stops starting new requests after STATS_TIME_BUDGET_SECONDS (240)
      env = {
        TABLE_NAME                = var.table_name
        STATS_TIME_BUDGET_SECONDS = "240"
        SECRET_PREFIX             = var.secret_prefix # §17.6: real platform tokens
      }
      # A missed tick is covered by the next one; a manual refresh is pressed again. Never retry (budgets).
      max_retries   = 0
      max_event_age = 900
    }
    learn = {
      handler = "clipfactory_api.weekly.handler"
      memory  = 512
      # The daily run stops starting new work after DAILY_BUDGET_SECONDS (720, api/.../learning_rules.py), so a few
      # creators' model calls fit. Changed in place (no replace).
      timeout = 900
      env = {
        TABLE_NAME     = var.table_name
        MEDIA_BUCKET   = var.media_bucket
        MODEL_ID       = var.model_id
        EMBED_MODEL_ID = var.embed_model_id
        VECTOR_BUCKET  = var.vector_bucket
        VECTOR_INDEX   = var.vector_index
      }
      # learn_week is idempotent per WEEK revision (a superseded run writes nothing) and the daily run is idempotent
      # (frozen posts, seen winners and fixed lesson ids), so one retry is safe.
      max_retries   = 1
      max_event_age = 3600
    }
  }

  # Exactly what the code calls (api/src/clipfactory_api/stats/** and weekly.py), beyond logs and traces.
  permissions = {
    stats = [
      # Due posts (gsi2 STATS), posts, accounts, STAT# snapshots, rate budgets and the manual refresh claim.
      # §17.6 "forget" (YouTube disconnect) deletes the YouTube posts' STAT# snapshots.
      { Sid = "Data", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:BatchGetItem"], Resource = local.table_resources },
      # Read the owner's app keys and tokens; write a refreshed (rotated) token back, only to {platform}/token.
      # Never create or delete, never write the app keys or pending choices.
      { Sid = "PlatformSecretsRead", Action = ["secretsmanager:GetSecretValue"], Resource = [var.platform_secrets_arn] },
      { Sid = "PlatformTokens", Action = ["secretsmanager:PutSecretValue"], Resource = [var.platform_token_secrets_arn] },
    ]
    learn = [
      # The WEEK item, the week's clips and posts, the "Best of week" learning (put, or deleted when no picks).
      # Daily (§16.12): owners through gsi2 STATS (Query, never Scan), posts, STAT# snapshots, clips, jobs, LESSON#
      # items and the LEARNSTATE item.
      { Sid = "Data", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:BatchGetItem"], Resource = local.table_resources },
      # Converse with Claude Fable through the global profile, and the Titan embedding for a missing vector.
      { Sid = "Models", Action = ["bedrock:InvokeModel"], Resource = concat(var.model_invoke_arns, [var.embed_model_arn]) },
      # Merge best = true / false into the picked and unpicked clips' vector metadata.
      { Sid = "Vectors", Action = ["s3vectors:GetVectors", "s3vectors:PutVectors"], Resource = [var.vector_index_arn] },
      # Read the owner's skills for the weekly learning call (§18.6): keys come from the table, so no s3:ListBucket.
      { Sid = "Skills", Action = ["s3:GetObject"], Resource = ["${var.media_bucket_arn}/skills/*"] },
    ]
  }
}

resource "aws_cloudwatch_log_group" "fn" {
  for_each          = local.functions
  name              = "/aws/lambda/${var.name}-${each.key}"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_iam_role" "fn" {
  for_each             = local.functions
  name                 = "${var.name}-fn-${each.key}"
  permissions_boundary = var.permissions_boundary_arn == "" ? null : var.permissions_boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy" "fn" {
  for_each = local.functions
  name     = "least-privilege"
  role     = aws_iam_role.fn[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        { Sid = "Logs", Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.fn[each.key].arn}:*" },
        { Sid = "Tracing", Effect = "Allow", Action = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"], Resource = "*" },
      ],
      [for p in local.permissions[each.key] : merge({ Effect = "Allow" }, p)],
    )
  })
}

resource "aws_lambda_function" "fn" {
  for_each         = local.functions
  function_name    = "${var.name}-${each.key}"
  role             = aws_iam_role.fn[each.key].arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = each.value.handler
  filename         = var.lambda_zip_path
  source_code_hash = filebase64sha256(var.lambda_zip_path)
  timeout          = each.value.timeout
  memory_size      = each.value.memory

  tracing_config {
    mode = "Active"
  }
  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.fn[each.key].name
  }
  environment {
    variables = each.value.env
  }

  tags = local.tags
  # The role's policy must exist before the function first runs.
  depends_on = [aws_iam_role_policy.fn]
}

# Both are only ever invoked asynchronously (EventBridge, InvocationType=Event).
resource "aws_lambda_function_event_invoke_config" "fn" {
  for_each                     = local.functions
  function_name                = aws_lambda_function.fn[each.key].function_name
  maximum_retry_attempts       = each.value.max_retries
  maximum_event_age_in_seconds = each.value.max_event_age
}

# ---------- Automatic refresh ----------
resource "aws_cloudwatch_event_rule" "stats" {
  name                = "${var.name}-stats"
  description         = "Refresh posted clips' numbers. Each platform is read no faster than its interval in config/platforms.json."
  schedule_expression = local.stats_schedule
  state               = "ENABLED"
  tags                = local.tags

  lifecycle {
    precondition {
      condition     = floor(local.stats_tick) == local.stats_tick && local.stats_tick >= 1 && local.stats_tick <= 1440
      error_message = "config/platforms.json: every minIntervalMinutes must be a whole number of minutes, and the lowest must be 1 to 1440."
    }
    precondition {
      condition     = toset(local.platforms.order) == toset(keys(local.platforms.platforms)) && length(local.platforms.order) == 5
      error_message = "config/platforms.json: order must list exactly the five platforms that platforms describes."
    }
  }
}

resource "aws_cloudwatch_event_target" "stats" {
  rule      = aws_cloudwatch_event_rule.stats.name
  target_id = "stats"
  arn       = aws_lambda_function.fn["stats"].arn # unqualified: always the current code
  # A tick that cannot be delivered within one interval is replaced by the next tick.
  retry_policy {
    maximum_event_age_in_seconds = 900
    maximum_retry_attempts       = 2
  }
}

resource "aws_lambda_permission" "events" {
  statement_id  = "events-stats-tick"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn["stats"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.stats.arn
}

# ---------- Daily learning from day-7 numbers (§16.12) ----------
resource "aws_cloudwatch_event_rule" "learn_daily" {
  name                = "${var.name}-learn-daily"
  description         = "Once a day: freeze day-7 numbers, find clips that did far better than normal and learn from them."
  schedule_expression = "cron(0 5 * * ? *)" # 05:00 UTC
  state               = "ENABLED"
  tags                = local.tags
}

resource "aws_cloudwatch_event_target" "learn_daily" {
  rule      = aws_cloudwatch_event_rule.learn_daily.name
  target_id = "learn-daily"
  arn       = aws_lambda_function.fn["learn"].arn # unqualified: always the current code
  # A run that cannot be delivered within an hour waits for tomorrow's (nothing is lost: posts stay unfrozen).
  retry_policy {
    maximum_event_age_in_seconds = 3600
    maximum_retry_attempts       = 2
  }
}

resource "aws_lambda_permission" "learn_daily" {
  statement_id  = "events-learn-daily"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn["learn"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.learn_daily.arn
}
