# Offline plan test (mock AWS provider, no credentials, no AWS calls; the random provider runs locally):
#   cd infra/modules/hooks && terraform init -backend=false && terraform test
#
# docs/CONTRACTS.md §14.3, §14.12, §17.9 and §17.12: three public methods with a path-parameter validator,
# throttling, a usage plan, logs without the query string or data tracing, the verify token and the OAuth state key
# kept out of state, and a Lambda that may only store hook events, read the verify token, consume OAuth state items
# read the platform app keys and write the token and pending secrets under <name>/platforms/ (never the app keys).

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

  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/oauth/state-key-AbCdEf" }
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

  clip_flow_alias_arn  = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-clip-flow:live"
  clip_flow_arn_prefix = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-clip-flow"
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
    condition = one(aws_lambda_function.fn.environment).variables == tomap({
      TABLE_NAME         = "cf-test-data"
      APP_URL            = "https://app.example.test"
      VERIFY_TOKEN_PARAM = "/cf-test/hooks/verify-token"
      SECRET_PREFIX      = "cf-test/platforms/"
      OAUTH_STATE_SECRET = "cf-test/oauth/state-key"
      CLIP_FLOW_ARN      = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-clip-flow:live"
    })
    error_message = "cf-prod-hooks environment must match docs/CONTRACTS.md §9, §17.9 (SECRET_PREFIX, OAUTH_STATE_SECRET) and §17.6 (CLIP_FLOW_ARN)."
  }

  assert {
    condition     = aws_lambda_function.fn.memory_size == 256 && aws_lambda_function.fn.timeout == 28 && aws_lambda_function.fn.handler == "clipfactory_api.hooks.handler"
    error_message = "cf-prod-hooks is 256 MB / 28 s (the OAuth callback exchanges the code, §17.9), handler clipfactory_api.hooks.handler."
  }

  assert {
    condition = toset(flatten([for s in jsondecode(aws_iam_role_policy.fn.policy).Statement : s.Action])) == toset([
      "logs:CreateLogStream", "logs:PutLogEvents", "xray:PutTraceSegments", "xray:PutTelemetryRecords",
      "dynamodb:PutItem", "ssm:GetParameter",
      "dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query",
      "secretsmanager:GetSecretValue", "secretsmanager:CreateSecret", "secretsmanager:PutSecretValue",
      "secretsmanager:DescribeSecret", "secretsmanager:DeleteSecret", "secretsmanager:TagResource",
      "dynamodb:TransactWriteItems", "lambda:InvokeFunction",
    ])
    error_message = "cf-prod-hooks may only store hook events, read the verify token, handle OAuth items and the platform secrets (§17.9), set followed creators' live state (§24.4), and release waiting posts with a clip flow start (§17.6)."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn.policy).Statement :
      s.Sid == "ReleaseWaitingPosts" && toset(s.Action) == toset(["dynamodb:GetItem", "dynamodb:Query", "dynamodb:UpdateItem", "dynamodb:TransactWriteItems"]) &&
      s.Resource == ["arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data"] &&
      s.Condition == { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["USER#*"] } }
    ])
    error_message = "§17.6: releasing waiting posts reads and updates the owner's USER# items only (no PutItem, no DeleteItem, no indexes)."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn.policy).Statement :
      s.Sid == "StartClipFlow" && s.Action == ["lambda:InvokeFunction"] &&
      s.Resource == ["arn:aws:lambda:eu-north-1:123456789012:function:cf-test-clip-flow:*"]
    ])
    error_message = "§17.6: cf-prod-hooks may start the clip flow (any qualifier of clip-flow) and no other function."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn.policy).Statement :
      s.Sid == "FollowItems" && toset(s.Action) == toset(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"]) &&
      s.Resource == ["arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data"] &&
      s.Condition == { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["FOLLOWED", "CREATOR", "WATCH", "USER#*"] } }
    ])
    error_message = "§24.4: a Twitch or Kick delivery reads FOLLOWED and sets CREATOR, WATCH and the owner's FOLLOW# items only (no DeleteItem, no Scan, no indexes)."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn.policy).Statement :
      s.Sid == "TwitchEventSubSecret" && s.Action == ["secretsmanager:GetSecretValue"] &&
      s.Resource == ["arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/twitch/eventsub*"]
    ])
    error_message = "§24.4: the Twitch EventSub secret may only be read."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.fn.policy).Statement : !contains(flatten([s.Action]), "dynamodb:Scan")
    ])
    error_message = "cf-prod-hooks never scans the table."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn.policy).Statement :
      s.Sid == "OAuthItems" && toset(s.Action) == toset(["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]) &&
      s.Resource == ["arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data"] &&
      s.Condition == { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["OAUTH#*", "USER#*"] } }
    ])
    error_message = "The callback consumes OAUTH#/STATE (DeleteItem) and updates USER# ACCOUNT#/SETUP# on the table only (no indexes, no other partitions)."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn.policy).Statement :
      s.Sid == "HookEvents" && s.Action == ["dynamodb:PutItem"] &&
      s.Condition == { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["HOOK#*", "USER#*"] } }
    ])
    error_message = "PutItem is limited to hook events (HOOK#) and the owner's Account items (USER#)."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn.policy).Statement :
      s.Sid == "OAuthStateKey" && s.Action == ["secretsmanager:GetSecretValue"] &&
      s.Resource == ["arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/oauth/state-key-AbCdEf"]
    ])
    error_message = "The state key may only be read, and only that one secret."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn.policy).Statement :
      s.Sid == "PlatformAppKeys" && toset(s.Action) == toset(["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]) &&
      s.Resource == ["arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*/app*"]
    ])
    error_message = "The owner's app keys ({platform}/app) may only be read by cf-prod-hooks (§17.4)."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn.policy).Statement :
      s.Sid == "PlatformTokens" && toset(s.Action) == toset([
        "secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret", "secretsmanager:TagResource",
      ]) && s.Resource == ["arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*/token*"]
    ])
    error_message = "The callback writes {platform}/token and never deletes it."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn.policy).Statement :
      s.Sid == "PlatformPending" && toset(s.Action) == toset([
        "secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret", "secretsmanager:DeleteSecret", "secretsmanager:TagResource",
      ]) && s.Resource == ["arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*/pending*"]
    ])
    error_message = "The callback writes and deletes {platform}/pending only."
  }

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.fn.policy).Statement : [
        for r in flatten([s.Resource]) : !(strcontains(r, "/app") || r == "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*") || toset(flatten([s.Action])) == toset(["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"])
      ]
    ]))
    error_message = "cf-prod-hooks is public: it must never create, change or delete the owner's app keys."
  }

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.fn.policy).Statement : [
        for r in flatten([s.Resource]) : startswith(s.Sid == null ? "" : s.Sid, "Tracing") || !strcontains(r, "*") || contains([
          "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*/app*",
          "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*/token*",
          "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*/pending*",
          "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/twitch/eventsub*",
        ], r) || endswith(r, ":*")
      ]
    ]))
    error_message = "No wildcard resources beyond the three platform secret kinds, the Twitch EventSub secret, the log group streams and X-Ray."
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

run "oauth_state_key_stays_out_of_state" {
  command = plan

  assert {
    condition     = aws_secretsmanager_secret.state_key.name == "cf-test/oauth/state-key"
    error_message = "The OAuth state key is the secret <name>/oauth/state-key."
  }

  assert {
    condition     = aws_secretsmanager_secret_version.state_key.secret_string_wo_version == 1 && length(regexall("(?m)^\\s+secret_string\\s+=", file("main.tf"))) == 0
    error_message = "The state key must be written with secret_string_wo (never secret_string), so it never enters the state."
  }

  assert {
    condition     = output.oauth_callback_base == "https://rest123.execute-api.eu-north-1.amazonaws.com/v1/oauth" && endswith(output.oauth_callback_base, "/oauth")
    error_message = "oauth_callback_base is {hooks_url}/oauth (the web appends /{platform}/callback)."
  }

  assert {
    condition     = output.oauth_state_secret_arn == "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/oauth/state-key-AbCdEf"
    error_message = "oauth_state_secret_arn is the state key's ARN (callers may only read it)."
  }

  assert {
    condition     = output.platform_secrets_arn == "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*" && output.secret_prefix == "cf-test/platforms/"
    error_message = "platform_secrets_arn covers exactly <name>/platforms/*."
  }

  assert {
    condition     = output.platform_token_secrets_arn == "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*/token-*"
    error_message = "platform_token_secrets_arn covers only the <name>/platforms/{platform}/token secrets."
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

run "roles_carry_the_permissions_boundary" {
  command = plan

  variables {
    permissions_boundary_arn = "arn:aws:iam::123456789012:policy/cf-prod-role-boundary"
  }

  assert {
    condition = (aws_iam_role.fn.permissions_boundary == "arn:aws:iam::123456789012:policy/cf-prod-role-boundary" &&
    aws_iam_role.apigw_cloudwatch[0].permissions_boundary == "arn:aws:iam::123456789012:policy/cf-prod-role-boundary")
    error_message = "Both cf-prod-hooks roles carry the deploy role's permissions boundary (infra/bootstrap)."
  }
}

run "no_boundary_when_none_is_given" {
  command = plan

  assert {
    condition     = aws_iam_role.fn.permissions_boundary == null && aws_iam_role.apigw_cloudwatch[0].permissions_boundary == null
    error_message = "Without permissions_boundary_arn the roles have no boundary (as before)."
  }
}
