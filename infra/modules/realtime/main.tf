# Live updates (docs/CONTRACTS.md §14.2): the WebSocket API cf-prod-ws (stage live), its Lambda REQUEST authorizer
# (the Cognito access token in ?token=), the connection handler, and the broadcaster that turns DynamoDB stream
# records into one message per changed job, clip, post or learning for the owner's open connections.
#
# The token travels in the query string, so nothing here may log it: the access log format has no query, headers or
# request overrides, and execution logging is ERROR only without data tracing.
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

locals {
  tags       = { Component = "realtime" }
  stage_name = "live"

  host        = "${aws_apigatewayv2_api.ws.id}.execute-api.${var.region}.amazonaws.com"
  ws_url      = "wss://${local.host}/${local.stage_name}"
  ws_endpoint = "https://${local.host}/${local.stage_name}" # management API (PostToConnection)

  manage_connections = {
    Sid      = "PostToConnections"
    Action   = ["execute-api:ManageConnections"]
    Resource = ["arn:aws:execute-api:${var.region}:${var.account_id}:${aws_apigatewayv2_api.ws.id}/${local.stage_name}/POST/@connections/*"]
  }

  functions = {
    ws-authorizer = {
      handler = "clipfactory_api.realtime.authorizer.handler"
      memory  = 128
      timeout = 10
      env = {
        USER_POOL_ID        = var.user_pool_id
        USER_POOL_CLIENT_ID = var.user_pool_client_id
      }
    }
    ws = {
      handler = "clipfactory_api.realtime.ws.handler"
      memory  = 128
      timeout = 10
      env = {
        TABLE_NAME       = var.table_name
        WS_ENDPOINT      = local.ws_endpoint
        CONN_TTL_SECONDS = tostring(var.connection_ttl_seconds)
      }
    }
    broadcast = {
      handler = "clipfactory_api.realtime.broadcast.handler"
      memory  = 256
      timeout = 60
      env = {
        TABLE_NAME  = var.table_name
        WS_ENDPOINT = local.ws_endpoint
      }
    }
  }

  # Beyond writing its own logs and traces. The authorizer only fetches Cognito's public keys over HTTPS.
  permissions = {
    ws-authorizer = []
    ws = [
      # Store the connection on $connect, delete it on $disconnect (found through gsi1 when the sub is missing).
      { Sid = "Connections", Action = ["dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query"], Resource = [var.table_arn, "${var.table_arn}/index/*"] },
      local.manage_connections,
    ]
    broadcast = [
      # The owner's connections (Query) and cleanup of closed ones (DeleteItem).
      { Sid = "Connections", Action = ["dynamodb:Query", "dynamodb:DeleteItem"], Resource = [var.table_arn] },
      # Read by the event source mapping.
      { Sid = "Stream", Action = ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:ListStreams"], Resource = [var.stream_arn] },
      local.manage_connections,
    ]
  }

  # Only these item types reach the broadcaster; CONN#, HOOK#, SETTINGS, SKILL#, STAT# (stats snapshots), the
  # RATE# budgets and OAuth STATE items never do. WEEK# carries the weekly best picks and learning state (§16.6);
  # ACCOUNT# and SETUP# become { type: "setup" } events for Set up posting (§17.4; they hold no keys or tokens).
  # CAMPAIGN#, CRCONN, CRSUB# and CRMONEY (§38.11) become { type: "contentrewards", partial: true }; CRSTATE# and
  # CROWNERS never match. CRFIND (§41.5, the owner's campaign finder) becomes { type: "contentrewards", op: "upsert",
  # id: "finder", partial: true }; the shared CRPUBLIC cache (CAMP#, PUB#, STATE) never matches. The mapping's filter
  # is updated in place.
  # FOLLOW# (§24) becomes { type: "follow" }: a followed creator's name, picture and live badge. FOLLOWKEYS# never
  # matches (its prefix differs after "FOLLOW"). JOBLIVE# (§31) becomes { type: "jobLive" }: the one-line live status
  # of a working job (allowed fields only; JOB# never matches it). GETPAID, PAYCONN#, PAYSTATE# and PAYOUT# (§40.7)
  # become { type: "getpaid", partial: true } (no item rides along; they hold no tokens or bank details).
  stream_filter = jsonencode({
    dynamodb = { Keys = { sk = { S = [{ prefix = "JOB#" }, { prefix = "CLIP#" }, { prefix = "POST#" }, { prefix = "LEARNING#" }, { prefix = "WEEK#" }, { prefix = "ACCOUNT#" }, { prefix = "SETUP#" }, { prefix = "FOLLOW#" }, { prefix = "JOBLIVE#" }, { prefix = "CAMPAIGN#" }, { prefix = "CRCONN" }, { prefix = "CRSUB#" }, { prefix = "CRMONEY" }, { prefix = "CRFIND" }, { prefix = "GETPAID" }, { prefix = "PAYCONN#" }, { prefix = "PAYSTATE#" }, { prefix = "PAYOUT#" }] } } }
  })
}

# ---------- Lambdas ----------
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
  # The stream mapping polls as soon as it exists; the role must already allow reading the stream.
  depends_on = [aws_iam_role_policy.fn]
}

# ---------- WebSocket API ----------
resource "aws_apigatewayv2_api" "ws" {
  name                       = "${var.name}-ws"
  description                = "Clip Factory live updates"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
  tags                       = local.tags
}

# API Gateway never caches WebSocket authorizer results, so no TTL (nor any other HTTP-only setting) is set.
resource "aws_apigatewayv2_authorizer" "token" {
  api_id           = aws_apigatewayv2_api.ws.id
  name             = "${var.name}-ws-token"
  authorizer_type  = "REQUEST"
  identity_sources = ["route.request.querystring.token"]
  authorizer_uri   = aws_lambda_function.fn["ws-authorizer"].invoke_arn
}

resource "aws_apigatewayv2_integration" "ws" {
  api_id             = aws_apigatewayv2_api.ws.id
  integration_type   = "AWS_PROXY"
  integration_method = "POST"
  integration_uri    = aws_lambda_function.fn["ws"].invoke_arn
}

resource "aws_apigatewayv2_route" "connect" {
  api_id             = aws_apigatewayv2_api.ws.id
  route_key          = "$connect"
  authorization_type = "CUSTOM"
  authorizer_id      = aws_apigatewayv2_authorizer.token.id
  target             = "integrations/${aws_apigatewayv2_integration.ws.id}"
}

resource "aws_apigatewayv2_route" "open" {
  for_each           = toset(["$disconnect", "$default"])
  api_id             = aws_apigatewayv2_api.ws.id
  route_key          = each.key
  authorization_type = "NONE" # only $connect can carry an authorizer; the connection is already authorized
  target             = "integrations/${aws_apigatewayv2_integration.ws.id}"
}

resource "aws_cloudwatch_log_group" "access" {
  name              = "/aws/apigateway/${var.name}-ws"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

# Created by API Gateway on first use with no expiry; owning it here gives it the same retention as the rest.
resource "aws_cloudwatch_log_group" "execution" {
  name              = "/aws/apigateway/${aws_apigatewayv2_api.ws.id}/${local.stage_name}"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_apigatewayv2_stage" "live" {
  api_id      = aws_apigatewayv2_api.ws.id
  name        = local.stage_name
  auto_deploy = true

  default_route_settings {
    logging_level          = "ERROR"
    data_trace_enabled     = false
    throttling_rate_limit  = 50
    throttling_burst_limit = 100
  }

  # Exactly these fields: no query string (the token), headers or request overrides.
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn
    format = jsonencode({
      requestId        = "$context.requestId"
      connectionId     = "$context.connectionId"
      eventType        = "$context.eventType"
      routeKey         = "$context.routeKey"
      status           = "$context.status"
      requestTime      = "$context.requestTime"
      integrationError = "$context.integrationErrorMessage"
      authorizerError  = "$context.authorizer.error"
    })
  }

  tags = local.tags

  # The routes must exist before the first auto-deployment, and execution logs need their group.
  depends_on = [aws_apigatewayv2_route.connect, aws_apigatewayv2_route.open, aws_cloudwatch_log_group.execution]
}

resource "aws_lambda_permission" "ws" {
  statement_id  = "websocket-routes"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn["ws"].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws.execution_arn}/*"
}

resource "aws_lambda_permission" "authorizer" {
  statement_id  = "websocket-authorizer"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn["ws-authorizer"].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws.execution_arn}/authorizers/*"
}

# ---------- DynamoDB stream → broadcast ----------
resource "aws_lambda_event_source_mapping" "broadcast" {
  event_source_arn                   = var.stream_arn
  function_name                      = aws_lambda_function.fn["broadcast"].arn
  starting_position                  = "LATEST"
  batch_size                         = 100
  maximum_batching_window_in_seconds = 1
  maximum_retry_attempts             = 2
  maximum_record_age_in_seconds      = 600
  bisect_batch_on_function_error     = true
  function_response_types            = ["ReportBatchItemFailures"]

  filter_criteria {
    filter {
      pattern = local.stream_filter
    }
  }

  tags = local.tags
}
