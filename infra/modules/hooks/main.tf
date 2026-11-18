# Platform webhooks and OAuth callbacks (docs/CONTRACTS.md §14.3, §17.5, §17.9): the REST API cf-prod-hooks (stage
# v1), the cf-prod-hooks Lambda behind it, the Meta verify token in SSM, the OAuth state key in Secrets Manager, and
# the account-level CloudWatch role API Gateway needs for REST and WebSocket logs.
#
# Public on purpose (platforms cannot send a Cognito token), so it is throttled hard. Webhooks are only stored, except
# Twitch and Kick (§24, Follow creators): signed deliveries only, which change a followed creator's live badge. The
# OAuth callback checks the signed single-use state, exchanges the code and writes the owner's token to Secrets
# Manager (cf-prod/platforms/*), never to DynamoDB or a log. Callbacks carry code/state in the query string: no log
# contains it.
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

  # §17.4: the owner's platform app keys, tokens and pending Meta choices are secrets created at runtime under this
  # prefix (secret ARNs end in a random 6-character suffix, hence the wildcard).
  secret_prefix        = "${var.name}/platforms/"
  platform_secrets_arn = "arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:${local.secret_prefix}*"
  # Only the {platform}/token secrets: what clip-flow and stats may write back after a refresh.
  platform_token_secrets_arn = "arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:${local.secret_prefix}*/token-*"
  # cf-prod-hooks, per kind: the owner's app keys ({platform}/app, written only by cf-prod-api) are only read; the
  # token and the short-lived Meta choices ({platform}/pending) are written, and pending is deleted. No "-" before
  # the "*": for a secret that does not exist yet, Secrets Manager checks the name without its random suffix, and
  # the code needs ResourceNotFoundException there (not AccessDenied) to create it or to read "not set up".
  platform_app_secrets_arn     = "arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:${local.secret_prefix}*/app*"
  platform_token_names_arn     = "arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:${local.secret_prefix}*/token*"
  platform_pending_secrets_arn = "arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:${local.secret_prefix}*/pending*"
  state_key_name               = "${var.name}/oauth/state-key"
  # §24: Twitch signs Follow creators' webhooks with this secret (made by cf-prod-api when the Twitch keys are saved).
  twitch_eventsub_secret_arn = "arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:${local.secret_prefix}twitch/eventsub*"

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
  name                 = "${var.name}-fn-hooks"
  permissions_boundary = var.permissions_boundary_arn == "" ? null : var.permissions_boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
  tags = local.tags
}

# Stores hook events (PutItem on HOOK#) and reads the verify token (the aws/ssm key needs no IAM statement). The
# OAuth callback consumes the state item (DeleteItem on OAUTH#), writes and updates the owner's ACCOUNT#/SETUP#
# items (USER#), reads the state key and the platform's app keys, writes the token and pending secrets and deletes
# the pending one (the aws/secretsmanager key needs no IAM statement either). This Lambda is public, so it can
# never change or delete the owner's app keys, and touches only those three partitions of the table.
resource "aws_iam_role_policy" "fn" {
  name = "least-privilege"
  role = aws_iam_role.fn.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Logs", Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.fn.arn}:*" },
      { Sid = "Tracing", Effect = "Allow", Action = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"], Resource = "*" },
      {
        Sid       = "HookEvents"
        Effect    = "Allow"
        Action    = ["dynamodb:PutItem"]
        Resource  = [var.table_arn]
        Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["HOOK#*", "USER#*"] } }
      },
      { Sid = "VerifyToken", Effect = "Allow", Action = ["ssm:GetParameter"], Resource = [local.verify_token_arn] },
      {
        Sid       = "OAuthItems"
        Effect    = "Allow"
        Action    = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
        Resource  = [var.table_arn]
        Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["OAUTH#*", "USER#*"] } }
      },
      { Sid = "OAuthStateKey", Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [aws_secretsmanager_secret.state_key.arn] },
      {
        Sid      = "PlatformAppKeys"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
        Resource = [local.platform_app_secrets_arn]
      },
      {
        Sid      = "PlatformTokens"
        Effect   = "Allow"
        Action   = ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret", "secretsmanager:TagResource"]
        Resource = [local.platform_token_names_arn]
      },
      # §24 Follow creators: a signed Twitch or Kick delivery finds the creator's followers (Query on FOLLOWED), sets the
      # live state on the CREATOR item and each follower's FOLLOW# item, notices a finished stream (PutItem on WATCH)
      # and is stored once by message id (HOOK#, above). No DeleteItem, no Scan, no other partition.
      {
        Sid       = "FollowItems"
        Effect    = "Allow"
        Action    = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"]
        Resource  = [var.table_arn]
        Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["FOLLOWED", "CREATOR", "WATCH", "USER#*"] } }
      },
      { Sid = "TwitchEventSubSecret", Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [local.twitch_eventsub_secret_arn] },
      {
        Sid      = "PlatformPending"
        Effect   = "Allow"
        Action   = ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret", "secretsmanager:DeleteSecret", "secretsmanager:TagResource"]
        Resource = [local.platform_pending_secrets_arn]
      },
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
  timeout          = 28 # the OAuth callback makes several platform calls; the REST integration waits 29 s
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
      SECRET_PREFIX      = local.secret_prefix
      OAUTH_STATE_SECRET = local.state_key_name
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

# ---------- OAuth state key (§17.4) ----------
# HMAC key that signs the single-use OAuth state and derives the PKCE verifier. Generated during apply and written
# only to Secrets Manager (write-only argument): it never enters the plan or the state. Bump
# secret_string_wo_version to rotate it (connects started before the rotation then come back "expired").
ephemeral "random_password" "state_key" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "state_key" {
  name        = local.state_key_name
  description = "Signs Clip Factory's OAuth state and PKCE verifier (docs/CONTRACTS.md §17.4)."
  tags        = local.tags

  # Owner rule (2026-11-17): holds the owner's data, so Terraform must never destroy or replace it. The deploy's
  # delete gate (scripts/check-plan-deletes.sh) checks the plan too.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_secretsmanager_secret_version" "state_key" {
  secret_id                = aws_secretsmanager_secret.state_key.id
  secret_string_wo         = ephemeral.random_password.state_key.result
  secret_string_wo_version = 1
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
  count                = var.manage_api_gateway_account ? 1 : 0
  name                 = "${var.name}-apigw-cloudwatch"
  permissions_boundary = var.permissions_boundary_arn == "" ? null : var.permissions_boundary_arn
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
