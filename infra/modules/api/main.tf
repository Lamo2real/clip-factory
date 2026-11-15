# cf-prod-api and the HTTP API in front of it (docs/CONTRACTS.md §5, §9). Background work runs elsewhere: the
# durable functions in modules/flows (jobs, publishing, the 48-hour check), live updates in modules/realtime and
# platform webhooks in modules/hooks (§14).
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

locals {
  tags = { Component = "api" }

  data_rw         = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem", "dynamodb:TransactWriteItems", "dynamodb:ConditionCheckItem"]
  table_resources = [var.table_arn, "${var.table_arn}/index/*"]
  media_prefixes  = ["uploads", "jobs", "skills", "private"]

  # One function; a map so the resource addresses (aws_lambda_function.fn["api"]) stay as they were.
  functions = {
    api = {
      handler = "clipfactory_api.http.handler"
      timeout = 29
      memory  = 512
      env = {
        TABLE_NAME        = var.table_name
        MEDIA_BUCKET      = var.media_bucket
        AGENT_RUNTIME_ARN = var.agent_runtime_arn
        JOB_FLOW_ARN      = var.job_flow_alias_arn
        CLIP_FLOW_ARN     = var.clip_flow_alias_arn
        VECTOR_BUCKET     = var.vector_bucket
        VECTOR_INDEX      = var.vector_index
        APP_URL           = var.app_url
        VERSION           = var.app_version
      }
    }
  }

  # What each function may do beyond writing its own logs and traces.
  permissions = {
    api = [
      # Confirm writes the clip and its posts in one transaction.
      { Sid = "Data", Action = local.data_rw, Resource = local.table_resources },
      # Presigned uploads and downloads, decline (deletes the clip's files), skill and cookie files.
      { Sid = "MediaObjects", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = [for p in local.media_prefixes : "${var.media_bucket_arn}/${p}/*"] },
      { Sid = "MediaList", Action = ["s3:ListBucket"], Resource = [var.media_bucket_arn], Condition = { StringLike = { "s3:prefix" = [for p in local.media_prefixes : "${p}/*"] } } },
      # Cancel a job on the agent (process_job is sent by cf-prod-job-flow); session sub-resources are part of it.
      { Sid = "Agent", Action = ["bedrock-agentcore:InvokeAgentRuntime", "bedrock-agentcore:StopRuntimeSession"], Resource = [var.agent_runtime_arn, "${var.agent_runtime_arn}/*"] },
      # Start durable executions on the live alias (any qualifier of the two flows, never other functions).
      { Sid = "StartFlows", Action = ["lambda:InvokeFunction"], Resource = ["${var.job_flow_arn_prefix}:*", "${var.clip_flow_arn_prefix}:*"] },
      # GET /v1/clips/{id}/similar (read the clip's vector, query with filters) and decline (delete the vector).
      { Sid = "Vectors", Action = ["s3vectors:GetVectors", "s3vectors:QueryVectors", "s3vectors:DeleteVectors"], Resource = [var.vector_index_arn] },
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
  # The role's policy must exist before the function first runs.
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
