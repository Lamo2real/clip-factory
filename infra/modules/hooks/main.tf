# Platform webhooks and OAuth callbacks (docs/CONTRACTS.md §14.3): the REST API cf-prod-hooks (stage v1), the
# cf-prod-hooks Lambda behind it, the Meta verify token in SSM, and the account-level CloudWatch role API Gateway
# needs for REST and WebSocket logs.
#
# Public on purpose (platforms cannot send a Cognito token), so it is throttled hard and stores what arrives
# without running anything else. OAuth callbacks carry code/state in the query string: no log contains it.
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws    = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
    random = { source = "hashicorp/random", version = ">= 3.7.0, < 4.0.0" }
  }
}

locals {
  tags              = { Component = "hooks" }
  function_name     = "${var.name}-hooks"
  stage_name        = "v1"
  verify_token_name = "/${var.name}/hooks/verify-token"
  verify_token_arn  = "arn:aws:ssm:${var.region}:${var.account_id}:parameter${local.verify_token_name}"

  # The three public methods, keyed for for_each.
  methods = {
    hooks-get      = { resource_id = aws_api_gateway_resource.hooks_platform.id, http_method = "GET" }
    hooks-post     = { resource_id = aws_api_gateway_resource.hooks_platform.id, http_method = "POST" }
    oauth-callback = { resource_id = aws_api_gateway_resource.oauth_callback.id, http_method = "GET" }
  }
}

# ---------- Lambda ----------
resource "aws_cloudwatch_log_group" "fn" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_iam_role" "fn" {
  name = "${var.name}-fn-hooks"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
  tags = local.tags
}

# Stores hook events (PutItem) and reads the verify token (the aws/ssm key needs no IAM statement).
resource "aws_iam_role_policy" "fn" {
  name = "least-privilege"
  role = aws_iam_role.fn.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Logs", Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.fn.arn}:*" },
      { Sid = "Tracing", Effect = "Allow", Action = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"], Resource = "*" },
      { Sid = "HookEvents", Effect = "Allow", Action = ["dynamodb:PutItem"], Resource = [var.table_arn] },
      { Sid = "VerifyToken", Effect = "Allow", Action = ["ssm:GetParameter"], Resource = [local.verify_token_arn] },
    ]
  })
}

resource "aws_lambda_function" "fn" {
  function_name    = local.function_name
  role             = aws_iam_role.fn.arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = "clipfactory_api.hooks.handler"
  filename         = var.lambda_zip_path
  source_code_hash = filebase64sha256(var.lambda_zip_path)
  timeout          = 10
  memory_size      = 256
  tracing_config {
    mode = "Active"
  }
  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.fn.name
  }
  environment {
    variables = {
      TABLE_NAME         = var.table_name
      APP_URL            = var.app_url
      VERIFY_TOKEN_PARAM = local.verify_token_name
    }
  }
  tags       = local.tags
  depends_on = [aws_iam_role_policy.fn]
}

# ---------- Meta verify token ----------
# Generated during apply and written only to SSM (write-only argument): it never enters the plan or the state.
# The owner reads it in the SSM console when registering Meta webhooks. Bump value_wo_version to rotate it.
ephemeral "random_password" "verify_token" {
  length  = 40
  special = false
}

resource "aws_ssm_parameter" "verify_token" {
  name             = local.verify_token_name
  description      = "Verify token for Meta (Instagram, Facebook) webhook subscriptions."
  type             = "SecureString" # AWS managed key aws/ssm
  value_wo         = ephemeral.random_password.verify_token.result
  value_wo_version = 1
  tags             = local.tags
}

# ---------- REST API ----------
resource "aws_api_gateway_rest_api" "hooks" {
  name        = "${var.name}-hooks"
  description = "Clip Factory platform webhooks and OAuth callbacks"
  endpoint_configuration {
    types = ["REGIONAL"]
  }
  tags = local.tags
}

resource "aws_api_gateway_resource" "hooks" {
  rest_api_id = aws_api_gateway_rest_api.hooks.id
  parent_id   = aws_api_gateway_rest_api.hooks.root_resource_id
  path_part   = "hooks"
}

resource "aws_api_gateway_resource" "hooks_platform" {
  rest_api_id = aws_api_gateway_rest_api.hooks.id
  parent_id   = aws_api_gateway_resource.hooks.id
  path_part   = "{platform}"
}

resource "aws_api_gateway_resource" "oauth" {
  rest_api_id = aws_api_gateway_rest_api.hooks.id
  parent_id   = aws_api_gateway_rest_api.hooks.root_resource_id
  path_part   = "oauth"
}

resource "aws_api_gateway_resource" "oauth_platform" {
  rest_api_id = aws_api_gateway_rest_api.hooks.id
  parent_id   = aws_api_gateway_resource.oauth.id
  path_part   = "{platform}"
}

resource "aws_api_gateway_resource" "oauth_callback" {
  rest_api_id = aws_api_gateway_rest_api.hooks.id
  parent_id   = aws_api_gateway_resource.oauth_platform.id
  path_part   = "callback"
}

# Path parameters only: webhook bodies differ per platform, so the Lambda checks them.
resource "aws_api_gateway_request_validator" "params" {
  rest_api_id                 = aws_api_gateway_rest_api.hooks.id
  name                        = "${var.name}-hooks-params"
  validate_request_parameters = true
  validate_request_body       = false
}

resource "aws_api_gateway_method" "this" {
  for_each             = local.methods
  rest_api_id          = aws_api_gateway_rest_api.hooks.id
  resource_id          = each.value.resource_id
  http_method          = each.value.http_method
  authorization        = "NONE"
  request_validator_id = aws_api_gateway_request_validator.params.id
  request_parameters   = { "method.request.path.platform" = true }
}

resource "aws_api_gateway_integration" "this" {
  for_each                = local.methods
  rest_api_id             = aws_api_gateway_rest_api.hooks.id
  resource_id             = each.value.resource_id
  http_method             = aws_api_gateway_method.this[each.key].http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"
  uri                     = aws_lambda_function.fn.invoke_arn
  timeout_milliseconds    = 29000
}

resource "aws_lambda_permission" "rest" {
  statement_id  = "rest-api"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.hooks.execution_arn}/*"
}

# A new deployment whenever a resource, method or integration changes.
resource "aws_api_gateway_deployment" "hooks" {
  rest_api_id = aws_api_gateway_rest_api.hooks.id
  triggers = {
    redeployment = sha1(jsonencode([
      aws_api_gateway_resource.hooks,
      aws_api_gateway_resource.hooks_platform,
      aws_api_gateway_resource.oauth,
      aws_api_gateway_resource.oauth_platform,
      aws_api_gateway_resource.oauth_callback,
      aws_api_gateway_request_validator.params,
      aws_api_gateway_method.this,
      aws_api_gateway_integration.this,
    ]))
  }
  lifecycle {
    create_before_destroy = true
  }
  depends_on = [aws_api_gateway_integration.this]
}

resource "aws_cloudwatch_log_group" "access" {
  name              = "/aws/apigateway/${var.name}-hooks"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

# Created by API Gateway on first use with no expiry; owning it here gives it the same retention as the rest.
resource "aws_cloudwatch_log_group" "execution" {
  name              = "API-Gateway-Execution-Logs_${aws_api_gateway_rest_api.hooks.id}/${local.stage_name}"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_api_gateway_stage" "v1" {
  rest_api_id          = aws_api_gateway_rest_api.hooks.id
  deployment_id        = aws_api_gateway_deployment.hooks.id
  stage_name           = local.stage_name
  xray_tracing_enabled = true

  # No query string: OAuth callbacks carry code and state there.
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn
    format = jsonencode({
      requestId          = "$context.requestId"
      ip                 = "$context.identity.sourceIp"
      httpMethod         = "$context.httpMethod"
      resourcePath       = "$context.resourcePath"
      status             = "$context.status"
      responseLength     = "$context.responseLength"
      requestTime        = "$context.requestTime"
      integrationLatency = "$context.integrationLatency"
    })
  }

  tags = local.tags
  # Logging needs the account's CloudWatch role first.
  depends_on = [aws_api_gateway_account.this, aws_cloudwatch_log_group.execution]
}

resource "aws_api_gateway_method_settings" "all" {
  rest_api_id = aws_api_gateway_rest_api.hooks.id
  stage_name  = aws_api_gateway_stage.v1.stage_name
  method_path = "*/*"
  settings {
    metrics_enabled        = true
    logging_level          = "ERROR"
    data_trace_enabled     = false
    throttling_rate_limit  = 10
    throttling_burst_limit = 20
  }
}

# No API key is required (platforms cannot send one): the method throttle above is the effective limit, and this
# plan is the ceiling for keyed clients later.
resource "aws_api_gateway_usage_plan" "hooks" {
  name        = "${var.name}-hooks"
  description = "Ceiling for the public webhook API"
  api_stages {
    api_id = aws_api_gateway_rest_api.hooks.id
    stage  = aws_api_gateway_stage.v1.stage_name
  }
  throttle_settings {
    rate_limit  = 10
    burst_limit = 20
  }
  quota_settings {
    limit  = 100000
    period = "MONTH"
  }
  tags = local.tags
}

# ---------- API Gateway account settings (one per account and Region) ----------
# REST execution and access logs and WebSocket logs are written with this role. Turn manage_api_gateway_account off
# when something else already manages the account's setting.
resource "aws_iam_role" "apigw_cloudwatch" {
  count = var.manage_api_gateway_account ? 1 : 0
  name  = "${var.name}-apigw-cloudwatch"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "apigateway.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = var.account_id } }
    }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "apigw_cloudwatch" {
  count      = var.manage_api_gateway_account ? 1 : 0
  role       = aws_iam_role.apigw_cloudwatch[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs"
}

resource "aws_api_gateway_account" "this" {
  count               = var.manage_api_gateway_account ? 1 : 0
  cloudwatch_role_arn = aws_iam_role.apigw_cloudwatch[0].arn
  depends_on          = [aws_iam_role_policy_attachment.apigw_cloudwatch]
}
