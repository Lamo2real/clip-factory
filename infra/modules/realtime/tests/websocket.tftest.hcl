# Offline plan test (mock AWS provider, no credentials, no AWS calls):
#   cd infra/modules/realtime && terraform init -backend=false && terraform test
#
# docs/CONTRACTS.md §14.2 and §14.12: the WebSocket authorizer sets no HTTP-only settings, the token in the query
# string never reaches a log, the stream mapping has exactly one filter with the seven item prefixes (§16.9 adds WEEK#,
# §17.9 adds ACCOUNT# and SETUP#), and each function may do only what its code does.

mock_provider "aws" {
  override_during = plan

  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:eu-north-1:123456789012:log-group:cf-test" }
  }

  mock_resource "aws_apigatewayv2_api" {
    defaults = {
      id            = "wsapi123"
      execution_arn = "arn:aws:execute-api:eu-north-1:123456789012:wsapi123"
    }
  }

  mock_resource "aws_lambda_function" {
    defaults = {
      arn        = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-fn"
      invoke_arn = "arn:aws:apigateway:eu-north-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-north-1:123456789012:function:cf-test-fn/invocations"
    }
  }
}

variables {
  name                = "cf-test"
  region              = "eu-north-1"
  account_id          = "123456789012"
  lambda_zip_path     = "main.tf"
  table_name          = "cf-test-data"
  table_arn           = "arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data"
  stream_arn          = "arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data/stream/2026-11-15T00:00:00.000"
  user_pool_id        = "eu-north-1_test"
  user_pool_client_id = "testclient"
}

run "api_routes_and_authorizer" {
  command = plan

  assert {
    condition     = aws_apigatewayv2_api.ws.protocol_type == "WEBSOCKET" && aws_apigatewayv2_api.ws.route_selection_expression == "$request.body.action"
    error_message = "cf-prod-ws must be a WebSocket API routed on $request.body.action."
  }

  assert {
    condition     = aws_apigatewayv2_authorizer.token.authorizer_type == "REQUEST" && toset(aws_apigatewayv2_authorizer.token.identity_sources) == toset(["route.request.querystring.token"])
    error_message = "The authorizer must be a REQUEST authorizer on the token query parameter."
  }

  assert {
    condition     = aws_apigatewayv2_authorizer.token.authorizer_payload_format_version == null && aws_apigatewayv2_authorizer.token.enable_simple_responses == null
    error_message = "Payload format version and simple responses are HTTP-API settings and must stay unset."
  }

  # The TTL is optional and computed in the provider, so a plan cannot tell "unset" from "set"; check the source.
  assert {
    condition = aws_apigatewayv2_authorizer.token.authorizer_type == "REQUEST" && alltrue([
      for a in ["authorizer_result_ttl_in_seconds", "authorizer_payload_format_version", "enable_simple_responses"] :
      !strcontains(file("main.tf"), a)
    ])
    error_message = "The WebSocket authorizer must not set authorizer_result_ttl_in_seconds, authorizer_payload_format_version or enable_simple_responses."
  }

  assert {
    condition     = aws_apigatewayv2_route.connect.route_key == "$connect" && aws_apigatewayv2_route.connect.authorization_type == "CUSTOM"
    error_message = "$connect must use the custom authorizer."
  }

  assert {
    condition     = toset(keys(aws_apigatewayv2_route.open)) == toset(["$disconnect", "$default"])
    error_message = "$disconnect and $default routes must exist."
  }

  assert {
    condition     = aws_apigatewayv2_stage.live.name == "live" && aws_apigatewayv2_stage.live.auto_deploy
    error_message = "The stage must be live with auto_deploy."
  }

  assert {
    condition     = output.ws_url == "wss://wsapi123.execute-api.eu-north-1.amazonaws.com/live" && output.ws_endpoint == "https://wsapi123.execute-api.eu-north-1.amazonaws.com/live"
    error_message = "ws_url and ws_endpoint must point at stage live."
  }

  assert {
    condition     = aws_lambda_permission.authorizer.source_arn == "arn:aws:execute-api:eu-north-1:123456789012:wsapi123/authorizers/*" && aws_lambda_permission.ws.source_arn == "arn:aws:execute-api:eu-north-1:123456789012:wsapi123/*"
    error_message = "Lambda permissions must be scoped to this API's routes and authorizers."
  }
}

run "the_token_is_never_logged" {
  command = plan

  assert {
    condition     = toset(keys(jsondecode(one(aws_apigatewayv2_stage.live.access_log_settings).format))) == toset(["requestId", "connectionId", "eventType", "routeKey", "status", "requestTime", "integrationError", "authorizerError"])
    error_message = "The WebSocket access log must have exactly the eight agreed fields."
  }

  assert {
    condition = alltrue([
      for v in values(jsondecode(one(aws_apigatewayv2_stage.live.access_log_settings).format)) :
      !strcontains(v, "requestOverride") && !strcontains(lower(v), "querystring") && !strcontains(lower(v), "header")
    ])
    error_message = "The access log must not contain the query string, headers or request overrides."
  }

  assert {
    condition     = one(aws_apigatewayv2_stage.live.default_route_settings).data_trace_enabled == false && one(aws_apigatewayv2_stage.live.default_route_settings).logging_level == "ERROR"
    error_message = "Execution logs must be ERROR only with data tracing off."
  }

  assert {
    condition     = one(aws_apigatewayv2_stage.live.default_route_settings).throttling_rate_limit == 50 && one(aws_apigatewayv2_stage.live.default_route_settings).throttling_burst_limit == 100
    error_message = "WebSocket throttling must be 50 rps, burst 100."
  }
}

run "stream_mapping_has_one_filter_with_seven_prefixes" {
  command = plan

  assert {
    condition     = length(one(aws_lambda_event_source_mapping.broadcast.filter_criteria).filter) == 1
    error_message = "The stream mapping must have exactly one filter."
  }

  assert {
    condition = jsondecode(one(one(aws_lambda_event_source_mapping.broadcast.filter_criteria).filter).pattern) == {
      dynamodb = { Keys = { sk = { S = [{ prefix = "JOB#" }, { prefix = "CLIP#" }, { prefix = "POST#" }, { prefix = "LEARNING#" }, { prefix = "WEEK#" }, { prefix = "ACCOUNT#" }, { prefix = "SETUP#" }] } } }
    }
    error_message = "The filter must pass only JOB#, CLIP#, POST#, LEARNING#, WEEK#, ACCOUNT# and SETUP# items (never STAT#, RATE# or OAUTH#/STATE)."
  }

  assert {
    condition = (aws_lambda_event_source_mapping.broadcast.starting_position == "LATEST" &&
      aws_lambda_event_source_mapping.broadcast.batch_size == 100 &&
      aws_lambda_event_source_mapping.broadcast.maximum_batching_window_in_seconds == 1 &&
      aws_lambda_event_source_mapping.broadcast.maximum_retry_attempts == 2 &&
      aws_lambda_event_source_mapping.broadcast.maximum_record_age_in_seconds == 600 &&
      aws_lambda_event_source_mapping.broadcast.bisect_batch_on_function_error &&
    toset(aws_lambda_event_source_mapping.broadcast.function_response_types) == toset(["ReportBatchItemFailures"]))
    error_message = "The stream mapping settings must match docs/CONTRACTS.md §14.2."
  }
}

run "functions_and_permissions" {
  command = plan

  assert {
    condition = (aws_lambda_function.fn["ws-authorizer"].memory_size == 128 && aws_lambda_function.fn["ws-authorizer"].timeout == 10 &&
      aws_lambda_function.fn["ws"].memory_size == 128 && aws_lambda_function.fn["ws"].timeout == 10 &&
    aws_lambda_function.fn["broadcast"].memory_size == 256 && aws_lambda_function.fn["broadcast"].timeout == 60)
    error_message = "Sizes: authorizer 128 MB/10 s, ws 128 MB/10 s, broadcast 256 MB/60 s."
  }

  assert {
    condition     = toset(keys(one(aws_lambda_function.fn["ws-authorizer"].environment).variables)) == toset(["USER_POOL_ID", "USER_POOL_CLIENT_ID"])
    error_message = "The authorizer gets only USER_POOL_ID and USER_POOL_CLIENT_ID."
  }

  assert {
    condition     = one(aws_lambda_function.fn["ws"].environment).variables == tomap({ TABLE_NAME = "cf-test-data", WS_ENDPOINT = "https://wsapi123.execute-api.eu-north-1.amazonaws.com/live", CONN_TTL_SECONDS = "7200" })
    error_message = "cf-prod-ws environment must match docs/CONTRACTS.md §9."
  }

  assert {
    condition     = one(aws_lambda_function.fn["broadcast"].environment).variables == tomap({ TABLE_NAME = "cf-test-data", WS_ENDPOINT = "https://wsapi123.execute-api.eu-north-1.amazonaws.com/live" })
    error_message = "cf-prod-broadcast environment must match docs/CONTRACTS.md §9."
  }

  assert {
    condition     = toset(flatten([for s in jsondecode(aws_iam_role_policy.fn["ws-authorizer"].policy).Statement : s.Action])) == toset(["logs:CreateLogStream", "logs:PutLogEvents", "xray:PutTraceSegments", "xray:PutTelemetryRecords"])
    error_message = "The authorizer needs no AWS permissions beyond logs and traces."
  }

  assert {
    condition = toset(flatten([for s in jsondecode(aws_iam_role_policy.fn["ws"].policy).Statement : s.Action])) == toset([
      "logs:CreateLogStream", "logs:PutLogEvents", "xray:PutTraceSegments", "xray:PutTelemetryRecords",
      "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query", "execute-api:ManageConnections",
    ])
    error_message = "cf-prod-ws actions must match docs/CONTRACTS.md §14.2."
  }

  assert {
    condition = toset(flatten([for s in jsondecode(aws_iam_role_policy.fn["broadcast"].policy).Statement : s.Action])) == toset([
      "logs:CreateLogStream", "logs:PutLogEvents", "xray:PutTraceSegments", "xray:PutTelemetryRecords",
      "dynamodb:Query", "dynamodb:DeleteItem", "dynamodb:DescribeStream", "dynamodb:GetRecords",
      "dynamodb:GetShardIterator", "dynamodb:ListStreams", "execute-api:ManageConnections",
    ])
    error_message = "cf-prod-broadcast actions must match docs/CONTRACTS.md §14.2."
  }

  assert {
    condition = alltrue([
      for k in ["ws", "broadcast"] : anytrue([
        for s in jsondecode(aws_iam_role_policy.fn[k].policy).Statement :
        s.Sid == "PostToConnections" && s.Resource == ["arn:aws:execute-api:eu-north-1:123456789012:wsapi123/live/POST/@connections/*"]
      ])
    ])
    error_message = "ManageConnections must be limited to this API's live stage connections."
  }

  assert {
    condition     = output.function_names == { ws = "cf-test-ws", broadcast = "cf-test-broadcast" }
    error_message = "function_names must list ws and broadcast and leave the authorizer out."
  }
}
