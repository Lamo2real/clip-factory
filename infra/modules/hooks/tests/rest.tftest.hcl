# Offline plan test (mock AWS provider, no credentials, no AWS calls; the random provider runs locally):
#   cd infra/modules/hooks && terraform init -backend=false && terraform test
#
# docs/CONTRACTS.md §14.3 and §14.12: three public methods with a path-parameter validator, throttling, a usage
# plan, logs without the query string or data tracing, the verify token kept out of state, and a Lambda that may only
# store hook events and read that token.

mock_provider "aws" {
  override_during = plan

  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:eu-north-1:123456789012:log-group:cf-test" }
  }

  mock_resource "aws_api_gateway_rest_api" {
    defaults = {
      id               = "rest123"
      root_resource_id = "root0"
      execution_arn    = "arn:aws:execute-api:eu-north-1:123456789012:rest123"
    }
  }

  mock_resource "aws_api_gateway_stage" {
    defaults = { invoke_url = "https://rest123.execute-api.eu-north-1.amazonaws.com/v1" }
  }
}

variables {
  name            = "cf-test"
  region          = "eu-north-1"
  account_id      = "123456789012"
  lambda_zip_path = "main.tf"
  table_name      = "cf-test-data"
  table_arn       = "arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data"
  app_url         = "https://app.example.test"
}

run "routes_and_validation" {
  command = plan

  assert {
    condition     = one(aws_api_gateway_rest_api.hooks.endpoint_configuration).types == tolist(["REGIONAL"])
    error_message = "cf-prod-hooks must be a REGIONAL REST API."
  }

  assert {
    condition = (tomap({ for k, m in aws_api_gateway_method.this : k => m.http_method }) == tomap({
      hooks-get = "GET", hooks-post = "POST", oauth-callback = "GET"
    }))
    error_message = "Exactly GET and POST /hooks/{platform} and GET /oauth/{platform}/callback must exist."
  }

  assert {
    condition     = aws_api_gateway_resource.hooks_platform.path_part == "{platform}" && aws_api_gateway_resource.oauth_callback.path_part == "callback" && aws_api_gateway_resource.oauth_platform.path_part == "{platform}"
    error_message = "Paths must be /hooks/{platform} and /oauth/{platform}/callback."
  }

  assert {
    condition     = alltrue([for m in aws_api_gateway_method.this : m.authorization == "NONE" && m.request_parameters == tomap({ "method.request.path.platform" = true })])
    error_message = "Every method is public and requires the platform path parameter."
  }

  assert {
    condition     = aws_api_gateway_request_validator.params.validate_request_parameters && !aws_api_gateway_request_validator.params.validate_request_body && aws_api_gateway_request_validator.params.name == "cf-test-hooks-params"
    error_message = "The validator checks parameters only (webhook bodies vary per platform)."
  }

  assert {
    condition     = alltrue([for i in aws_api_gateway_integration.this : i.type == "AWS_PROXY" && i.integration_http_method == "POST"])
    error_message = "Every method is an AWS_PROXY integration on cf-prod-hooks."
  }

  assert {
    condition     = output.hooks_url == "https://rest123.execute-api.eu-north-1.amazonaws.com/v1"
    error_message = "hooks_url must be the stage v1 invoke URL."
  }
}

run "throttling_logging_and_usage_plan" {
  command = plan

  assert {
    condition     = aws_api_gateway_stage.v1.stage_name == "v1" && aws_api_gateway_stage.v1.xray_tracing_enabled
    error_message = "Stage v1 with X-Ray tracing."
  }

  assert {
    condition     = toset(keys(jsondecode(one(aws_api_gateway_stage.v1.access_log_settings).format))) == toset(["requestId", "ip", "httpMethod", "resourcePath", "status", "responseLength", "requestTime", "integrationLatency"])
    error_message = "The REST access log must have exactly the eight agreed fields."
  }

  assert {
    condition = alltrue([
      for v in values(jsondecode(one(aws_api_gateway_stage.v1.access_log_settings).format)) :
      !strcontains(lower(v), "querystring") && !strcontains(v, "requestOverride") && !strcontains(v, "$context.path") && !strcontains(lower(v), "header")
    ])
    error_message = "The access log must not contain the query string (OAuth code/state), the raw path, headers or overrides."
  }

  assert {
    condition = (aws_api_gateway_method_settings.all.method_path == "*/*" &&
      one(aws_api_gateway_method_settings.all.settings).metrics_enabled &&
      one(aws_api_gateway_method_settings.all.settings).logging_level == "ERROR" &&
      one(aws_api_gateway_method_settings.all.settings).data_trace_enabled == false &&
      one(aws_api_gateway_method_settings.all.settings).throttling_rate_limit == 10 &&
    one(aws_api_gateway_method_settings.all.settings).throttling_burst_limit == 20)
    error_message = "Method settings */*: metrics on, ERROR logs, no data trace, 10 rps / burst 20."
  }

  assert {
    condition = (one(aws_api_gateway_usage_plan.hooks.throttle_settings).rate_limit == 10 &&
      one(aws_api_gateway_usage_plan.hooks.throttle_settings).burst_limit == 20 &&
      one(aws_api_gateway_usage_plan.hooks.quota_settings).limit == 100000 &&
    one(aws_api_gateway_usage_plan.hooks.quota_settings).period == "MONTH")
    error_message = "The usage plan is 10 rps / burst 20 and 100 000 requests per month."
  }

  assert {
    condition     = one(aws_api_gateway_usage_plan.hooks.api_stages).stage == "v1"
    error_message = "The usage plan covers stage v1."
  }
}

run "verify_token_and_lambda" {
  command = plan

  assert {
    condition     = aws_ssm_parameter.verify_token.name == "/cf-test/hooks/verify-token" && aws_ssm_parameter.verify_token.type == "SecureString"
    error_message = "The verify token is a SecureString at /<name>/hooks/verify-token."
  }

  assert {
    condition     = aws_ssm_parameter.verify_token.value_wo_version == 1 && length(regexall("(?m)^\\s+(value|insecure_value)\\s+=", file("main.tf"))) == 0
    error_message = "The token must be written with value_wo (never value), so it never enters the state."
  }

  assert {
    condition     = one(aws_lambda_function.fn.environment).variables == tomap({ TABLE_NAME = "cf-test-data", APP_URL = "https://app.example.test", VERIFY_TOKEN_PARAM = "/cf-test/hooks/verify-token" })
    error_message = "cf-prod-hooks environment must match docs/CONTRACTS.md §9."
  }

  assert {
    condition     = aws_lambda_function.fn.memory_size == 256 && aws_lambda_function.fn.timeout == 10 && aws_lambda_function.fn.handler == "clipfactory_api.hooks.handler"
    error_message = "cf-prod-hooks is 256 MB / 10 s, handler clipfactory_api.hooks.handler."
  }

  assert {
    condition = toset(flatten([for s in jsondecode(aws_iam_role_policy.fn.policy).Statement : s.Action])) == toset([
      "logs:CreateLogStream", "logs:PutLogEvents", "xray:PutTraceSegments", "xray:PutTelemetryRecords",
      "dynamodb:PutItem", "ssm:GetParameter",
    ])
    error_message = "cf-prod-hooks may only store hook events and read the verify token."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn.policy).Statement :
      s.Sid == "VerifyToken" && s.Resource == ["arn:aws:ssm:eu-north-1:123456789012:parameter/cf-test/hooks/verify-token"]
    ])
    error_message = "ssm:GetParameter must be limited to the verify token."
  }

  assert {
    condition     = aws_lambda_permission.rest.source_arn == "arn:aws:execute-api:eu-north-1:123456789012:rest123/*"
    error_message = "The Lambda permission must be scoped to this REST API."
  }

  assert {
    condition     = output.function_names == { hooks = "cf-test-hooks" }
    error_message = "function_names must list cf-prod-hooks."
  }
}

run "account_logging_role_by_default" {
  command = plan

  assert {
    condition     = length(aws_api_gateway_account.this) == 1 && aws_iam_role.apigw_cloudwatch[0].name == "cf-test-apigw-cloudwatch"
    error_message = "By default the module sets the account's API Gateway CloudWatch role."
  }

  assert {
    condition     = aws_iam_role_policy_attachment.apigw_cloudwatch[0].policy_arn == "arn:aws:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs"
    error_message = "The logging role uses AmazonAPIGatewayPushToCloudWatchLogs."
  }
}

run "account_setting_managed_elsewhere" {
  command = plan

  variables {
    manage_api_gateway_account = false
  }

  assert {
    condition     = length(aws_api_gateway_account.this) == 0 && length(aws_iam_role.apigw_cloudwatch) == 0
    error_message = "manage_api_gateway_account = false must leave the account setting alone."
  }
}
