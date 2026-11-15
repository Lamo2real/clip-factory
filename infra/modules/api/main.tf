# The four Lambdas of docs/CONTRACTS.md §9 (one zip), the HTTP API in front of cf-prod-api, the publish queue and
# its dead-letter queue, the EventBridge Scheduler group for the 48-hour performance checks and the watchdog rule.
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

locals {
  tags = { Component = "api" }

  publisher_timeout = 120

  # Built from the name, not referenced: the publisher's environment needs it, and both live in one for_each.
  perf_check_arn   = "arn:aws:lambda:${var.region}:${var.account_id}:function:${var.name}-perf-check"
  schedule_arns    = "arn:aws:scheduler:${var.region}:${var.account_id}:schedule/${var.name}/*"
  data_rw          = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem", "dynamodb:ConditionCheckItem"]
  table_resources  = [var.table_arn, "${var.table_arn}/index/*"]
  media_prefixes   = ["uploads", "jobs", "skills", "private"]
  pass_scheduler   = { Action = ["iam:PassRole"], Resource = [aws_iam_role.scheduler.arn], Condition = { StringEquals = { "iam:PassedToService" = "scheduler.amazonaws.com" } } }
  manage_schedules = { Action = ["scheduler:CreateSchedule", "scheduler:DeleteSchedule", "scheduler:GetSchedule"], Resource = [local.schedule_arns] }

  functions = {
    api = {
      handler = "clipfactory_api.http.handler"
      timeout = 29
      memory  = 512
      env = {
        TABLE_NAME        = var.table_name
        MEDIA_BUCKET      = var.media_bucket
        AGENT_RUNTIME_ARN = var.agent_runtime_arn
        PUBLISH_QUEUE_URL = aws_sqs_queue.publish.url
        APP_URL           = var.app_url
        VERSION           = var.app_version
      }
    }
    publisher = {
      handler = "clipfactory_api.publisher.handler"
      timeout = local.publisher_timeout
      memory  = 256
      env = {
        TABLE_NAME              = var.table_name
        MEDIA_BUCKET            = var.media_bucket
        PERF_CHECK_FUNCTION_ARN = local.perf_check_arn
        SCHEDULER_ROLE_ARN      = aws_iam_role.scheduler.arn
        SCHEDULE_GROUP          = aws_scheduler_schedule_group.this.name
      }
    }
    perf-check = {
      handler = "clipfactory_api.perf_check.handler"
      timeout = 120
      memory  = 256
      env = {
        TABLE_NAME = var.table_name
        MODEL_ID   = var.model_id
      }
    }
    watchdog = {
      handler = "clipfactory_api.watchdog.handler"
      timeout = 60
      memory  = 256
      env = {
        TABLE_NAME = var.table_name
        # Without it the watchdog only fails stale jobs and never resumes a Confirm that stopped before queueing.
        PUBLISH_QUEUE_URL = aws_sqs_queue.publish.url
      }
    }
  }

  # What each function may do beyond writing its own logs and traces.
  permissions = {
    api = [
      { Action = local.data_rw, Resource = local.table_resources },
      # Presigned uploads and downloads, decline (deletes the clip's files), skill and cookie files.
      { Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = [for p in local.media_prefixes : "${var.media_bucket_arn}/${p}/*"] },
      { Action = ["s3:ListBucket"], Resource = [var.media_bucket_arn], Condition = { StringLike = { "s3:prefix" = [for p in local.media_prefixes : "${p}/*"] } } },
      { Action = ["sqs:SendMessage"], Resource = [aws_sqs_queue.publish.arn] },
      # Start and cancel jobs on the agent; the session sub-resources are part of the invoke.
      { Action = ["bedrock-agentcore:InvokeAgentRuntime", "bedrock-agentcore:StopRuntimeSession"], Resource = [var.agent_runtime_arn, "${var.agent_runtime_arn}/*"] },
    ]
    publisher = [
      { Action = local.data_rw, Resource = local.table_resources },
      { Action = ["s3:GetObject"], Resource = ["${var.media_bucket_arn}/jobs/*"] },
      { Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"], Resource = [aws_sqs_queue.publish.arn] },
      local.manage_schedules,
      local.pass_scheduler,
    ]
    perf-check = [
      { Action = local.data_rw, Resource = local.table_resources },
      { Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], Resource = var.model_invoke_arns },
    ]
    # Finds running jobs whose heartbeat stopped and confirmed clips stuck at publishState pending; both are spread
    # over users, so it scans. Resuming a publish reads the owner's settings (GetItem) and the clip's posts (Query),
    # creates the missing posts (PutItem), marks the clip (UpdateItem) and sends the publish message.
    watchdog = [
      { Action = ["dynamodb:Scan", "dynamodb:Query", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"], Resource = local.table_resources },
      { Action = ["sqs:SendMessage"], Resource = [aws_sqs_queue.publish.arn] },
    ]
  }
}

# ---------- Lambdas ----------
resource "aws_cloudwatch_log_group" "fn" {
  for_each          = local.functions
  name              = "/aws/lambda/${var.name}-${each.key}"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_iam_role" "fn" {
  for_each = local.functions
  name     = "${var.name}-fn-${each.key}"
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
        { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.fn[each.key].arn}:*" },
        { Effect = "Allow", Action = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"], Resource = "*" },
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
  # The role's policy must exist before the function first runs (the SQS mapping polls immediately).
  depends_on = [aws_iam_role_policy.fn]
}

# ---------- HTTP API ----------
resource "aws_cloudwatch_log_group" "http" {
  name              = "/aws/apigateway/${var.name}-http"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

# With CORS configured here, API Gateway answers every preflight OPTIONS itself, before routes and the authorizer.
resource "aws_apigatewayv2_api" "http" {
  name          = "${var.name}-http"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = [var.app_url, var.web_dev_origin]
    allow_methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    allow_headers = ["authorization", "content-type"]
    max_age       = 3600
  }
  tags = local.tags
}

resource "aws_apigatewayv2_authorizer" "jwt" {
  api_id           = aws_apigatewayv2_api.http.id
  name             = "cognito"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  jwt_configuration {
    issuer   = var.jwt_issuer
    audience = [var.jwt_audience]
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.fn["api"].invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

resource "aws_apigatewayv2_route" "authorized" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "ANY /v1/{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

# The one public route: it says only whether the API is up and which version runs.
resource "aws_apigatewayv2_route" "health" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /v1/health"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "NONE"
}

resource "aws_apigatewayv2_stage" "http" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_burst_limit = 50
    throttling_rate_limit  = 20
  }
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.http.arn
    format = jsonencode({
      requestId = "$context.requestId"
      route     = "$context.routeKey"
      status    = "$context.status"
      latency   = "$context.responseLatency"
      authError = "$context.authorizer.error"
      error     = "$context.integrationErrorMessage"
    })
  }
  tags = local.tags
}

resource "aws_lambda_permission" "http" {
  statement_id  = "http-api"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn["api"].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

# ---------- publish queue → publisher ----------
resource "aws_sqs_queue" "publish_dlq" {
  name                      = "${var.name}-publish-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = local.tags
}

resource "aws_sqs_queue" "publish" {
  name                       = "${var.name}-publish"
  visibility_timeout_seconds = 6 * local.publisher_timeout # AWS guidance for Lambda consumers
  message_retention_seconds  = 345600
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.publish_dlq.arn
    maxReceiveCount     = 3
  })
  tags = local.tags
}

resource "aws_sqs_queue_redrive_allow_policy" "publish_dlq" {
  queue_url = aws_sqs_queue.publish_dlq.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.publish.arn]
  })
}

resource "aws_sqs_queue_policy" "tls_only" {
  for_each  = { publish = aws_sqs_queue.publish, publish-dlq = aws_sqs_queue.publish_dlq }
  queue_url = each.value.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "TlsOnly"
      Effect    = "Deny"
      Principal = "*"
      Action    = "sqs:*"
      Resource  = each.value.arn
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

resource "aws_lambda_event_source_mapping" "publish" {
  event_source_arn        = aws_sqs_queue.publish.arn
  function_name           = aws_lambda_function.fn["publisher"].arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
  scaling_config {
    maximum_concurrency = 2 # the lowest SQS allows; posting is not urgent and platform APIs rate-limit
  }
  tags = local.tags
}

# ---------- 48-hour performance checks (EventBridge Scheduler) ----------
resource "aws_scheduler_schedule_group" "this" {
  name = var.name
  tags = local.tags
}

# Assumed by EventBridge Scheduler for the one-time perf-{postId} schedules the publisher creates.
resource "aws_iam_role" "scheduler" {
  name = "${var.name}-scheduler"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.account_id }
        ArnLike      = { "aws:SourceArn" = aws_scheduler_schedule_group.this.arn }
      }
    }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy" "scheduler" {
  name = "invoke-perf-check"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [aws_lambda_function.fn["perf-check"].arn, "${aws_lambda_function.fn["perf-check"].arn}:*"]
    }]
  })
}

# ---------- watchdog every 10 minutes ----------
resource "aws_cloudwatch_event_rule" "watchdog" {
  name                = "${var.name}-watchdog"
  description         = "Fails running jobs whose agent stopped sending heartbeats."
  schedule_expression = "rate(10 minutes)"
  tags                = local.tags
}

resource "aws_cloudwatch_event_target" "watchdog" {
  rule      = aws_cloudwatch_event_rule.watchdog.name
  target_id = "watchdog"
  arn       = aws_lambda_function.fn["watchdog"].arn
}

resource "aws_lambda_permission" "watchdog" {
  statement_id  = "events-watchdog"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn["watchdog"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.watchdog.arn
}

# The next run comes ten minutes later; retrying a failed sweep would only overlap with it.
resource "aws_lambda_function_event_invoke_config" "watchdog" {
  function_name          = aws_lambda_function.fn["watchdog"].function_name
  maximum_retry_attempts = 0
}
