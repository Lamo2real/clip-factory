# Offline plan test (mock AWS provider, no credentials, no AWS calls):
#   cd infra/modules/api && terraform init -backend=false && terraform test
#
# docs/CONTRACTS.md §9, §14.1 and §14.4-14.6: the module holds only cf-prod-api and the HTTP API. The API starts the
# durable flows on their alias and reads/deletes clip vectors; the publish queue, scheduler and watchdog are gone.
# §17.9 and §17.12: Set up posting adds the platform secrets (prefix only), the state key (read only), the TikTok
# verification file (web bucket tiktok* only) and one CloudFront invalidation permission.

mock_provider "aws" {
  override_during = plan

  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:eu-north-1:123456789012:log-group:cf-test" }
  }
}

variables {
  name = "cf-test"
  # Any existing file: the module only hashes it.
  lambda_zip_path      = "main.tf"
  app_version          = "test"
  app_url              = "https://app.example.test"
  web_dev_origin       = "http://localhost:5173"
  jwt_issuer           = "https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_test"
  jwt_audience         = "testclient"
  table_name           = "cf-test-data"
  table_arn            = "arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data"
  media_bucket         = "cf-test-media"
  media_bucket_arn     = "arn:aws:s3:::cf-test-media"
  agent_runtime_arn    = "arn:aws:bedrock-agentcore:eu-north-1:123456789012:runtime/cf_test_clip_agent-abc"
  job_flow_alias_arn   = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-job-flow:live"
  clip_flow_alias_arn  = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-clip-flow:live"
  job_flow_arn_prefix  = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-job-flow"
  clip_flow_arn_prefix = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-clip-flow"
  stats_function_arn   = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-stats"
  learn_function_arn   = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-learn"
  money_function_arn   = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-money"
  vector_bucket        = "cf-test-vectors-123456789012"
  vector_index         = "clips"
  vector_index_arn     = "arn:aws:s3vectors:eu-north-1:123456789012:bucket/cf-test-vectors-123456789012/index/clips"

  hooks_url               = "https://rest123.execute-api.eu-north-1.amazonaws.com/v1"
  secret_prefix           = "cf-test/platforms/"
  platform_secrets_arn    = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*"
  oauth_state_secret_arn  = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/oauth/state-key-AbCdEf"
  oauth_state_secret_name = "cf-test/oauth/state-key"
  web_bucket              = "cf-test-web-123456789012"
  web_bucket_arn          = "arn:aws:s3:::cf-test-web-123456789012"
  distribution_id         = "E2EXAMPLE"
  distribution_arn        = "arn:aws:cloudfront::123456789012:distribution/E2EXAMPLE"
}

run "only_the_api_function_remains" {
  command = plan

  assert {
    condition     = keys(aws_lambda_function.fn) == ["api"]
    error_message = "publisher, perf-check and watchdog are replaced by the durable flows; only cf-prod-api remains here."
  }

  assert {
    condition     = output.function_names == { api = "cf-test-api" }
    error_message = "function_names must be { api = <name>-api }."
  }
}

run "environment_names_the_flow_aliases" {
  command = plan

  assert {
    condition = one(aws_lambda_function.fn["api"].environment).variables == tomap({
      TABLE_NAME         = "cf-test-data"
      MEDIA_BUCKET       = "cf-test-media"
      AGENT_RUNTIME_ARN  = "arn:aws:bedrock-agentcore:eu-north-1:123456789012:runtime/cf_test_clip_agent-abc"
      JOB_FLOW_ARN       = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-job-flow:live"
      CLIP_FLOW_ARN      = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-clip-flow:live"
      VECTOR_BUCKET      = "cf-test-vectors-123456789012"
      VECTOR_INDEX       = "clips"
      APP_URL            = "https://app.example.test"
      VERSION            = "test"
      STATS_FUNCTION_ARN = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-stats"
      LEARN_FUNCTION_ARN = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-learn"
      MONEY_FUNCTION_ARN = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-money"
      HOOKS_URL          = "https://rest123.execute-api.eu-north-1.amazonaws.com/v1"
      SECRET_PREFIX      = "cf-test/platforms/"
      OAUTH_STATE_SECRET = "cf-test/oauth/state-key"
      WEB_BUCKET         = "cf-test-web-123456789012"
      DISTRIBUTION_ID    = "E2EXAMPLE"
      # §19.9 module defaults: help off, no model.
      HELP_ENABLED         = "false"
      HELP_MONTHLY_CAP     = "2000"
      HELP_RATE_PER_MINUTE = "6"
      HELP_RATE_PER_HOUR   = "60"
      # §26: picture questions per owner per day.
      HELP_PICTURE_QUESTIONS_PER_DAY = "40"
      # §28.12 module default: no assistant worker, so off.
      ASK_ENABLED = "false"
      # §38.16 module default: Content Rewards off.
      CONTENT_REWARDS = "off"
      # §39.3 module default: the campaign copy off.
      CR_REMAKE = "off"
      # §41.6 module default: the campaign finder off.
      CR_FINDER = "off"
      # §40.6 module default: Connect Whop off.
      WHOP_CONNECT = "off"
      # §40.5.11 module default: Your bank off.
      BANK_READING = "off"
    })
    error_message = "cf-prod-api environment must match docs/CONTRACTS.md §9, §16.9, §17.9, §19.9, §38.16, §40.5.11, §40.6 and §41.6 (HOOKS_URL, SECRET_PREFIX, OAUTH_STATE_SECRET, WEB_BUCKET, DISTRIBUTION_ID, HELP_*; no PUBLISH_QUEUE_URL, PERF_CHECK_FUNCTION_ARN, SCHEDULER_ROLE_ARN or SCHEDULE_GROUP)."
  }
}

run "stats_arns_must_be_unqualified" {
  command = plan

  variables {
    stats_function_arn = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-stats:live"
  }

  expect_failures = [var.stats_function_arn]
}

run "hooks_url_needs_https_without_trailing_slash" {
  command = plan

  variables {
    hooks_url = "https://rest123.execute-api.eu-north-1.amazonaws.com/v1/"
  }

  expect_failures = [var.hooks_url]
}

run "platform_secrets_arn_must_be_the_prefix" {
  command = plan

  variables {
    platform_secrets_arn = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:*"
  }

  expect_failures = [var.platform_secrets_arn]
}

run "set_up_posting_permissions" {
  command = plan

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement :
      s.Sid == "PlatformSecrets" && toset(s.Action) == toset([
        "secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret", "secretsmanager:DeleteSecret", "secretsmanager:TagResource",
      ]) && s.Resource == ["arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*"]
    ])
    error_message = "The API manages keys and tokens only under <name>/platforms/* (§17.4)."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement :
      s.Sid == "OAuthStateKey" && s.Action == ["secretsmanager:GetSecretValue"] &&
      s.Resource == ["arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/oauth/state-key-AbCdEf"]
    ])
    error_message = "The API may only read the OAuth state key."
  }

  assert {
    condition = toset(flatten([
      for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement : s.Resource if anytrue([for a in s.Action : startswith(a, "secretsmanager:")])
      ])) == toset([
      "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*",
      "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/oauth/state-key-AbCdEf",
    ])
    error_message = "No Secrets Manager access beyond the platform prefix and the state key."
  }

  assert {
    condition = toset(flatten([
      for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement : s.Action if contains(flatten([s.Resource]), "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/oauth/state-key-AbCdEf")
    ])) == toset(["secretsmanager:GetSecretValue"])
    error_message = "The state key is read only for the API (Terraform owns it)."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement :
      s.Sid == "VerificationFiles" && toset(s.Action) == toset(["s3:PutObject", "s3:DeleteObject"]) &&
      s.Resource == ["arn:aws:s3:::cf-test-web-123456789012/tiktok*"]
    ])
    error_message = "The API may write and delete only tiktok* files in the web bucket."
  }

  assert {
    condition = toset(flatten([
      for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement : s.Resource if anytrue([for r in flatten([s.Resource]) : startswith(r, "arn:aws:s3:::cf-test-web")])
    ])) == toset(["arn:aws:s3:::cf-test-web-123456789012/tiktok*"])
    error_message = "Nothing else in the web bucket is reachable from the API."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement :
      s.Sid == "Invalidate" && s.Action == ["cloudfront:CreateInvalidation"] && s.Resource == ["arn:aws:cloudfront::123456789012:distribution/E2EXAMPLE"]
    ])
    error_message = "The API may invalidate only the app's distribution."
  }
}

run "permissions" {
  command = plan

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement :
      s.Sid == "StartFlows" && s.Action == ["lambda:InvokeFunction"] && s.Resource == [
        "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-job-flow:*",
        "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-clip-flow:*",
      ]
    ])
    error_message = "The API may invoke only the two flows (any qualifier, so the live alias)."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement :
      s.Sid == "JobFlowMacCallback" && s.Action == [
        "lambda:SendDurableExecutionCallbackSuccess",
        "lambda:SendDurableExecutionCallbackFailure",
        ] && s.Resource == [
        "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-job-flow:*",
      ]
    ])
    error_message = "The API may end only the job flow's callbacks (the wait for the owner's Mac, §35), and never heartbeat them."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement :
      s.Sid == "MacUploadAbort" && s.Action == ["s3:AbortMultipartUpload"] && s.Resource == ["arn:aws:s3:::cf-test-media/uploads/*"]
    ])
    error_message = "The API may abort only multipart uploads under uploads/ (the Mac's video, §35)."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement :
      s.Sid == "StatsAndLearn" && s.Action == ["lambda:InvokeFunction"] && s.Resource == [
        "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-stats",
        "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-learn",
      ]
    ])
    error_message = "The API may invoke cf-prod-stats (manual refresh) and cf-prod-learn (weekly best), unqualified."
  }

  assert {
    condition = toset(flatten([
      for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement : s.Resource if contains(s.Action, "lambda:InvokeFunction")
      ])) == toset([
      "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-job-flow:*",
      "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-clip-flow:*",
      "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-stats",
      "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-learn",
      "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-money",
    ])
    error_message = "lambda:InvokeFunction covers exactly the two flows, cf-prod-stats, cf-prod-learn and cf-prod-money."
  }

  # §25.5: "Check now" on Settings › Posting › Money.
  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement :
      s.Sid == "Money" && s.Action == ["lambda:InvokeFunction"] && s.Resource == ["arn:aws:lambda:eu-north-1:123456789012:function:cf-test-money"]
    ])
    error_message = "The API may invoke cf-prod-money (Check now), unqualified, and nothing else for money."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement :
      s.Sid == "Vectors" && toset(s.Action) == toset(["s3vectors:GetVectors", "s3vectors:QueryVectors", "s3vectors:DeleteVectors"]) &&
      s.Resource == ["arn:aws:s3vectors:eu-north-1:123456789012:bucket/cf-test-vectors-123456789012/index/clips"]
    ])
    error_message = "The API needs GetVectors, QueryVectors and DeleteVectors on the clips index only."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement :
      contains(s.Action, "dynamodb:TransactWriteItems") && contains(s.Resource, "arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data")
    ])
    error_message = "Confirm writes the clip and its posts in one TransactWriteItems."
  }

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement : [
        for a in s.Action : !startswith(a, "sqs:") && !startswith(a, "scheduler:") && !startswith(a, "bedrock:") && a != "iam:PassRole"
      ]
    ]))
    error_message = "No queue, scheduler, PassRole or Bedrock model permissions on the API while help has no model."
  }
}

# docs/CONTRACTS.md §19.9: Ask Clip Factory on, with Claude Haiku through the EU geo profile.
run "help_assistant_with_model" {
  command = plan

  variables {
    help_enabled  = true
    help_model_id = "eu.anthropic.claude-haiku-5-5"
    help_model_invoke_arns = [
      "arn:aws:bedrock:eu-north-1:123456789012:inference-profile/eu.anthropic.claude-haiku-5-5",
      "arn:aws:bedrock:eu-central-1::foundation-model/anthropic.claude-haiku-5-5",
      "arn:aws:bedrock:eu-north-1::foundation-model/anthropic.claude-haiku-5-5",
      "arn:aws:bedrock:eu-south-1::foundation-model/anthropic.claude-haiku-5-5",
      "arn:aws:bedrock:eu-south-2::foundation-model/anthropic.claude-haiku-5-5",
      "arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-haiku-5-5",
      "arn:aws:bedrock:eu-west-3::foundation-model/anthropic.claude-haiku-5-5",
    ]
  }

  assert {
    condition = (
      one(aws_lambda_function.fn["api"].environment).variables["HELP_ENABLED"] == "true" &&
      one(aws_lambda_function.fn["api"].environment).variables["HELP_MODEL_ID"] == "eu.anthropic.claude-haiku-5-5" &&
      one(aws_lambda_function.fn["api"].environment).variables["HELP_MONTHLY_CAP"] == "2000" &&
      one(aws_lambda_function.fn["api"].environment).variables["HELP_RATE_PER_MINUTE"] == "6" &&
      one(aws_lambda_function.fn["api"].environment).variables["HELP_RATE_PER_HOUR"] == "60" &&
      one(aws_lambda_function.fn["api"].environment).variables["HELP_PICTURE_QUESTIONS_PER_DAY"] == "40" &&
      one(aws_lambda_function.fn["api"].environment).variables["APP_URL"] == "https://app.example.test"
    )
    error_message = "cf-prod-api gets HELP_ENABLED, HELP_MODEL_ID, HELP_MONTHLY_CAP 2000, 6 per minute, 60 per hour, and APP_URL for the corpus."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement :
      s.Sid == "HelpModel" && s.Action == ["bedrock:InvokeModel"] && toset(s.Resource) == toset(var.help_model_invoke_arns) && length(s.Resource) == 7
    ])
    error_message = "HelpModel allows only bedrock:InvokeModel on the profile and its six destination foundation models."
  }

  assert {
    condition = toset(flatten([
      for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement : s.Action if anytrue([for a in s.Action : startswith(a, "bedrock:")])
    ])) == toset(["bedrock:InvokeModel"])
    error_message = "The only Bedrock action on the API is InvokeModel (no streaming, Converse needs nothing else)."
  }

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement : s if anytrue([for a in s.Action : startswith(a, "bedrock:")])]) == 1
    error_message = "Bedrock appears in exactly one statement, HelpModel."
  }
}

run "help_kb_only_without_model" {
  command = plan

  variables {
    help_enabled = true
  }

  assert {
    condition = (
      one(aws_lambda_function.fn["api"].environment).variables["HELP_ENABLED"] == "true" &&
      !contains(keys(one(aws_lambda_function.fn["api"].environment).variables), "HELP_MODEL_ID")
    )
    error_message = "Without a model id the help assistant runs on plain answers: no HELP_MODEL_ID."
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement : try(s.Sid, "") != "HelpModel"])
    error_message = "No model id, no HelpModel statement."
  }
}

run "help_model_needs_its_arns" {
  command = plan

  variables {
    help_model_id = "eu.anthropic.claude-haiku-5-5"
  }

  expect_failures = [var.help_model_invoke_arns]
}

run "help_cap_is_a_whole_number" {
  command = plan

  variables {
    help_monthly_cap = 1.5
  }

  expect_failures = [var.help_monthly_cap]
}

# §19.6: a 429 carries Retry-After, which the browser can only read when CORS exposes it.
run "cors_exposes_retry_after" {
  command = plan

  assert {
    condition     = one(aws_apigatewayv2_api.http.cors_configuration).expose_headers == toset(["retry-after"])
    error_message = "HTTP API CORS must expose retry-after (and nothing else)."
  }

  assert {
    condition     = aws_apigatewayv2_route.authorized.route_key == "ANY /v1/{proxy+}"
    error_message = "Help adds no route: it is served by the single ANY /v1/{proxy+} route."
  }

  assert {
    condition     = output.log_group_name == "/aws/lambda/cf-test-api"
    error_message = "log_group_name is cf-prod-api's log group, for the help model alarm."
  }
}

# docs/CONTRACTS.md §28.12: the assistant adds starting cf-prod-ask, the search key and the ask/ media prefix. Nothing
# else changes: no new route (ANY /v1/{proxy+} covers the new paths) and retry-after is already exposed.
run "ask_assistant_additions" {
  command = plan
  variables {
    ask_enabled        = true
    ask_function_name  = "cf-test-ask"
    ask_function_arn   = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-ask"
    search_secret_name = "cf-test/ask/search-key"
    search_secret_arn  = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/ask/search-key-??????"
  }

  assert {
    condition = (one(aws_lambda_function.fn["api"].environment).variables["ASK_ENABLED"] == "true" &&
      one(aws_lambda_function.fn["api"].environment).variables["ASK_FUNCTION_NAME"] == "cf-test-ask" &&
    one(aws_lambda_function.fn["api"].environment).variables["ASK_SEARCH_SECRET"] == "cf-test/ask/search-key")
    error_message = "ASK_ENABLED, ASK_FUNCTION_NAME and ASK_SEARCH_SECRET are set."
  }

  assert {
    condition = contains(jsondecode(aws_iam_role_policy.fn["api"].policy).Statement, {
      Sid = "AskWorker", Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = ["arn:aws:lambda:eu-north-1:123456789012:function:cf-test-ask"]
    })
    error_message = "cf-prod-api may start cf-prod-ask and nothing else new."
  }

  assert {
    condition = contains(jsondecode(aws_iam_role_policy.fn["api"].policy).Statement, {
      Sid      = "AskSearchKey", Effect = "Allow"
      Action   = ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:DescribeSecret", "secretsmanager:DeleteSecret", "secretsmanager:TagResource"]
      Resource = ["arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/ask/search-key-??????"]
    })
    error_message = "The search key secret is managed by the app, only under its own name."
  }

  assert {
    condition     = contains(flatten([for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement : s.Resource if try(s.Sid, "") == "MediaObjects"]), "arn:aws:s3:::cf-test-media/ask/*")
    error_message = "Presigned PUTs and DELETE work under ask/."
  }

  assert {
    condition     = toset([for r in [aws_apigatewayv2_route.authorized, aws_apigatewayv2_route.health, aws_apigatewayv2_route.preflight] : r.route_key]) == toset(["ANY /v1/{proxy+}", "GET /v1/health", "OPTIONS /v1/{proxy+}"])
    error_message = "No new HTTP API routes."
  }
}

run "ask_off_without_a_worker" {
  command = plan

  assert {
    condition     = one(aws_lambda_function.fn["api"].environment).variables["ASK_ENABLED"] == "false" && !strcontains(aws_iam_role_policy.fn["api"].policy, "AskWorker")
    error_message = "Without the worker the assistant is off and no permission is granted."
  }
}

# docs/CONTRACTS.md §5: the browser's CORS preflight carries no token, so it must not hit the JWT authorizer of
# ANY /v1/{proxy+} (it got 401 and every signed-in call failed in every browser). A public OPTIONS route, with no
# integration, lets API Gateway's CORS answer it.
run "browser_preflight_is_public" {
  command = plan

  override_resource {
    target          = aws_apigatewayv2_integration.api
    override_during = plan
    values          = { id = "integ123" }
  }

  assert {
    condition     = aws_apigatewayv2_route.preflight.route_key == "OPTIONS /v1/{proxy+}"
    error_message = "The HTTP API needs an OPTIONS /v1/{proxy+} route for the browser's CORS preflight."
  }

  assert {
    condition     = aws_apigatewayv2_route.preflight.authorization_type == "NONE"
    error_message = "The preflight route must be public: browsers send OPTIONS without the Authorization header."
  }

  assert {
    condition     = aws_apigatewayv2_route.preflight.target == "integrations/integ123"
    error_message = "The preflight route needs the API integration: AWS skips a route with no target, so OPTIONS falls through to the JWT route and gets 401."
  }

  assert {
    condition     = contains(one(aws_apigatewayv2_api.http.cors_configuration).allow_origins, "https://app.example.test")
    error_message = "CORS must allow the app's origin."
  }

  assert {
    condition     = contains(one(aws_apigatewayv2_api.http.cors_configuration).allow_headers, "authorization")
    error_message = "CORS must allow the authorization header, or every signed-in call fails in the browser."
  }

  assert {
    condition     = aws_apigatewayv2_route.authorized.authorization_type == "JWT"
    error_message = "Every other /v1 route still needs the JWT."
  }
}

# docs/CONTRACTS.md §45.5, §45.13.3 and §45.15: Lamo Stories' own Lambda behind its own routes. ANY /v1/workspaces and
# ANY /v1/workspaces/{proxy+} take the same JWT authorizer; their OPTIONS twins are public (the more specific paths
# would otherwise catch the browser's token-less preflight, the §5 lesson); the OAuth callback is public with a route
# throttle of 5 per second, burst 10. All five reach cf-prod-stories-api; every other path, cf-prod-api's function,
# role and environment and the three existing routes stay exactly as they are.
run "lamo_stories_routes" {
  command = plan

  variables {
    stories_routes_enabled    = true
    stories_api_function_name = "cf-test-stories-api"
    stories_api_invoke_arn    = "arn:aws:apigateway:eu-north-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-north-1:123456789012:function:cf-test-stories-api/invocations"
  }

  override_resource {
    target          = aws_apigatewayv2_integration.api
    override_during = plan
    values          = { id = "integ123" }
  }

  override_resource {
    target          = aws_apigatewayv2_integration.stories[0]
    override_during = plan
    values          = { id = "story123" }
  }

  override_resource {
    target          = aws_lambda_function.fn["api"]
    override_during = plan
    values          = { invoke_arn = "arn:aws:apigateway:eu-north-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-north-1:123456789012:function:cf-test-api/invocations" }
  }

  override_resource {
    target          = aws_apigatewayv2_authorizer.jwt
    override_during = plan
    values          = { id = "auth123" }
  }

  override_resource {
    target          = aws_apigatewayv2_api.http
    override_during = plan
    values = {
      api_endpoint  = "https://http123.execute-api.eu-north-1.amazonaws.com"
      execution_arn = "arn:aws:execute-api:eu-north-1:123456789012:http123"
    }
  }

  assert {
    condition = toset(keys(aws_apigatewayv2_route.stories)) == toset([
      "ANY /v1/workspaces", "ANY /v1/workspaces/{proxy+}", "OPTIONS /v1/workspaces", "OPTIONS /v1/workspaces/{proxy+}",
      "GET /v1/stories-oauth/{platform}/callback",
    ]) && output.stories_route_keys == toset(keys(aws_apigatewayv2_route.stories))
    error_message = "Lamo Stories adds exactly its five routes (§45.15)."
  }

  assert {
    condition = alltrue([
      for k, r in aws_apigatewayv2_route.stories : r.route_key == k && r.target == "integrations/story123" && (
        startswith(k, "ANY ") ? r.authorization_type == "JWT" && r.authorizer_id == "auth123" : r.authorization_type == "NONE" && r.authorizer_id == null
      )
    ])
    error_message = "Every Lamo Stories route reaches cf-prod-stories-api; ANY routes need the same JWT, OPTIONS and the callback are public."
  }

  assert {
    condition = (aws_apigatewayv2_integration.stories[0].integration_uri == var.stories_api_invoke_arn &&
      aws_apigatewayv2_integration.stories[0].integration_type == "AWS_PROXY" &&
      aws_apigatewayv2_integration.stories[0].payload_format_version == "2.0" &&
    aws_apigatewayv2_integration.stories[0].timeout_milliseconds == 29000)
    error_message = "The Lamo Stories integration is a 2.0 proxy to cf-prod-stories-api, 29 s like cf-prod-api's."
  }

  assert {
    condition = (aws_apigatewayv2_integration.api.integration_uri == "arn:aws:apigateway:eu-north-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-north-1:123456789012:function:cf-test-api/invocations" &&
      aws_apigatewayv2_route.authorized.route_key == "ANY /v1/{proxy+}" && aws_apigatewayv2_route.authorized.target == "integrations/integ123" &&
      aws_apigatewayv2_route.authorized.authorization_type == "JWT" && aws_apigatewayv2_route.authorized.authorizer_id == "auth123" &&
      aws_apigatewayv2_route.preflight.route_key == "OPTIONS /v1/{proxy+}" && aws_apigatewayv2_route.preflight.target == "integrations/integ123" &&
    aws_apigatewayv2_route.health.route_key == "GET /v1/health" && aws_apigatewayv2_route.health.target == "integrations/integ123")
    error_message = "cf-prod-api's integration and its three routes are unchanged: every other path still reaches cf-prod-api."
  }

  assert {
    condition = (one(aws_apigatewayv2_stage.http.default_route_settings).throttling_rate_limit == 20 &&
      one(aws_apigatewayv2_stage.http.default_route_settings).throttling_burst_limit == 50 &&
      length(aws_apigatewayv2_stage.http.route_settings) == 1 &&
      one(aws_apigatewayv2_stage.http.route_settings).route_key == "GET /v1/stories-oauth/{platform}/callback" &&
      one(aws_apigatewayv2_stage.http.route_settings).throttling_rate_limit == 5 &&
    one(aws_apigatewayv2_stage.http.route_settings).throttling_burst_limit == 10)
    error_message = "The public Lamo Stories callback has its own route throttle (5 per second, burst 10); the stage default stays 20/50."
  }

  assert {
    condition = (aws_lambda_permission.stories[0].function_name == "cf-test-stories-api" &&
      aws_lambda_permission.stories[0].principal == "apigateway.amazonaws.com" &&
      aws_lambda_permission.stories[0].action == "lambda:InvokeFunction" &&
      aws_lambda_permission.stories[0].source_arn == "arn:aws:execute-api:eu-north-1:123456789012:http123/*/*" &&
    aws_lambda_permission.http.function_name == aws_lambda_function.fn["api"].function_name)
    error_message = "API Gateway may invoke cf-prod-stories-api; cf-prod-api's own permission is unchanged."
  }

  assert {
    condition     = output.stories_callback_base == "https://http123.execute-api.eu-north-1.amazonaws.com/v1/stories-oauth"
    error_message = "storiesCallbackBase is {apiUrl}/v1/stories-oauth (§45.13.3)."
  }

  # cf-prod-api's function, role and environment are not touched: the same environment as with Lamo Stories off, no
  # Lamo Stories name in its policy, and the two variables are used only by the new routes and permission.
  assert {
    condition = (keys(aws_lambda_function.fn) == ["api"] && aws_lambda_function.fn["api"].handler == "clipfactory_api.http.handler" &&
      aws_lambda_function.fn["api"].memory_size == 512 && aws_lambda_function.fn["api"].timeout == 29 &&
      !anytrue([for k in keys(one(aws_lambda_function.fn["api"].environment).variables) : strcontains(k, "STOR") || strcontains(k, "WS_")]) &&
      !strcontains(aws_iam_role_policy.fn["api"].policy, "stories") && !strcontains(aws_iam_role_policy.fn["api"].policy, "workspaces") &&
      !strcontains(aws_iam_role_policy.fn["api"].policy, "/ws/") &&
      length(regexall("var\\.stories_api_invoke_arn", file("main.tf"))) == 1 &&
      length(regexall("var\\.stories_routes_enabled", file("main.tf"))) == 1 &&
      length(regexall("(?m)^  integration_uri\\s+= var\\.stories_api_invoke_arn$", file("main.tf"))) == 1 &&
      length(regexall("var\\.stories_api_function_name", file("main.tf"))) == 1 &&
    length(regexall("(?m)^  function_name = var\\.stories_api_function_name$", file("main.tf"))) == 1)
    error_message = "cf-prod-api's function, role and environment never see Lamo Stories (§45.15): the stories variables reach only the new integration and permission."
  }

  assert {
    condition = alltrue([
      for k, v in one(aws_lambda_function.fn["api"].environment).variables :
      !strcontains(lower(v), "stories") && !strcontains(v, "/workspaces") && !strcontains(k, "WORKSPACE")
      ]) && (one(aws_lambda_function.fn["api"].environment).variables["AGENT_RUNTIME_ARN"] == var.agent_runtime_arn &&
      one(aws_lambda_function.fn["api"].environment).variables["HOOKS_URL"] == var.hooks_url &&
    one(aws_lambda_function.fn["api"].environment).variables["SECRET_PREFIX"] == "cf-test/platforms/")
    error_message = "With the Lamo Stories routes, cf-prod-api keeps Clip Factory's agent, hooks and secret prefix and gets no Lamo Stories value."
  }
}

# §45.15's sample ARN the other way round: no cf-prod-api Secrets Manager (or S3) grant reaches a Lamo Stories secret or
# file, with every optional grant switched on. Globs: "*" becomes ".*" and "?" becomes "." in an anchored regex.
run "cf_prod_api_never_reaches_lamo_stories" {
  command = plan

  variables {
    stories_routes_enabled    = true
    stories_api_function_name = "cf-test-stories-api"
    stories_api_invoke_arn    = "arn:aws:apigateway:eu-north-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-north-1:123456789012:function:cf-test-stories-api/invocations"
    ask_function_name         = "cf-test-ask"
    ask_function_arn          = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-ask"
    search_secret_arn         = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/ask/search-key-??????"
    vapid_secret_name         = "cf-test/notify/vapid"
    vapid_secret_arn          = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/notify/vapid-AbCdEf"
  }

  assert {
    condition = alltrue(flatten([
      for sample in [
        "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/workspaces/stories/youtube/token-AbC123",
        "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/workspaces/stories/youtube/token",
        "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/workspaces/stories/instagram/app-AbC123",
        "arn:aws:s3:::cf-test-media/ws/u1/stories/stories/s1/final/v1.mp4",
        ] : [
        for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement : [
          for r in flatten([s.Resource]) : !can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", sample))
        ] if anytrue([for a in flatten([s.Action]) : startswith(a, "secretsmanager:") || startswith(a, "s3:") || a == "*"])
      ]
    ]))
    error_message = "…:secret:<name>/workspaces/stories/youtube/token-AbC123 (and Lamo Stories' ws/ files) match no cf-prod-api resource."
  }
}

run "lamo_stories_routes_off_by_default" {
  command = plan

  assert {
    condition = (length(aws_apigatewayv2_route.stories) == 0 && length(aws_apigatewayv2_integration.stories) == 0 &&
    length(aws_lambda_permission.stories) == 0 && length(aws_apigatewayv2_stage.http.route_settings) == 0)
    error_message = "Without cf-prod-stories-api the module adds no route, integration, permission or route throttle."
  }
}

run "lamo_stories_routes_never_reach_cf_prod_api" {
  command = plan

  variables {
    stories_routes_enabled    = true
    stories_api_function_name = "cf-test-api"
    stories_api_invoke_arn    = "arn:aws:apigateway:eu-north-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-north-1:123456789012:function:cf-test-stories-api/invocations"
  }

  expect_failures = [var.stories_api_function_name]
}

run "lamo_stories_integration_is_never_cf_prod_api" {
  command = plan

  variables {
    stories_routes_enabled    = true
    stories_api_function_name = "cf-test-stories-api"
    stories_api_invoke_arn    = "arn:aws:apigateway:eu-north-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-north-1:123456789012:function:cf-test-api/invocations"
  }

  expect_failures = [var.stories_api_invoke_arn]
}

# docs/CONTRACTS.md §32.3: with the VAPID secret, cf-prod-api may only read it (public key, "Send a test").
run "push_key_is_read_only" {
  command = plan

  variables {
    vapid_secret_name = "cf-test/notify/vapid"
    vapid_secret_arn  = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/notify/vapid-AbCdEf"
  }

  assert {
    condition     = aws_lambda_function.fn["api"].environment[0].variables.PUSH_VAPID_SECRET == "cf-test/notify/vapid" && aws_lambda_function.fn["api"].environment[0].variables.PUSH_SUBJECT == "https://app.example.test"
    error_message = "cf-test-api gets the VAPID secret's name and the subject."
  }

  assert {
    condition     = one([for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement : s.Action if try(s.Sid, "") == "VapidKey"]) == ["secretsmanager:GetSecretValue"]
    error_message = "cf-test-api may only read the VAPID key."
  }
}

run "push_off_without_a_key" {
  command = plan

  assert {
    condition     = !contains(keys(aws_lambda_function.fn["api"].environment[0].variables), "PUSH_VAPID_SECRET") && length(regexall("VapidKey", aws_iam_role_policy.fn["api"].policy)) == 0
    error_message = "Without the VAPID secret there is no push environment and no permission."
  }
}

# docs/CONTRACTS.md §38.16: Content Rewards. Off by default; on with the switch. The api invokes cf-prod-campaigns and
# reaches only the media bucket's campaigns/ prefix for it; the CR secrets ride the existing PlatformSecrets grant.
run "content_rewards_off_by_default_without_a_grant" {
  command = plan

  assert {
    condition     = one(aws_lambda_function.fn["api"].environment).variables["CONTENT_REWARDS"] == "off" && !contains(keys(one(aws_lambda_function.fn["api"].environment).variables), "CAMPAIGNS_FUNCTION_ARN")
    error_message = "Without the switch and the function, CONTENT_REWARDS is off and no CAMPAIGNS_FUNCTION_ARN is set."
  }

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement : s if try(s.Sid, "") == "Campaigns"]) == 0
    error_message = "No invoke grant for cf-prod-campaigns without its ARN."
  }
}

run "content_rewards_on" {
  command = plan

  variables {
    content_rewards_enabled = true
    campaigns_function_arn  = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-campaigns"
  }

  assert {
    condition = (one(aws_lambda_function.fn["api"].environment).variables["CONTENT_REWARDS"] == "on" &&
    one(aws_lambda_function.fn["api"].environment).variables["CAMPAIGNS_FUNCTION_ARN"] == "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-campaigns")
    error_message = "With the switch on, CONTENT_REWARDS is on and CAMPAIGNS_FUNCTION_ARN names cf-prod-campaigns."
  }

  assert {
    condition = one([for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement : s if try(s.Sid, "") == "Campaigns"]) == {
      Sid = "Campaigns", Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = ["arn:aws:lambda:eu-north-1:123456789012:function:cf-test-campaigns"]
    }
    error_message = "The api may invoke cf-prod-campaigns and nothing else new."
  }

  assert {
    condition     = contains(one([for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement : s.Resource if try(s.Sid, "") == "MediaObjects"]), "arn:aws:s3:::cf-test-media/campaigns/*")
    error_message = "The api reads, writes and deletes campaign files under campaigns/ (logos, brand pictures)."
  }

  assert {
    condition     = !contains(one([for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement : s.Condition.StringLike["s3:prefix"] if try(s.Sid, "") == "MediaList"]), "campaigns/*")
    error_message = "The api never lists campaigns/: removing a campaign deletes its files by name."
  }
}

# docs/CONTRACTS.md §39.3: the campaign copy of a clip waits behind CR_REMAKE, off by default; the switch is an
# in-place environment change (no new grant, nothing replaced).
run "cr_remake_off_by_default" {
  command = plan

  assert {
    condition     = one(aws_lambda_function.fn["api"].environment).variables["CR_REMAKE"] == "off"
    error_message = "cr_remake_enabled defaults to false: CR_REMAKE is off."
  }
}

run "cr_remake_on" {
  command = plan

  variables {
    content_rewards_enabled = true
    cr_remake_enabled       = true
    campaigns_function_arn  = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-campaigns"
  }

  assert {
    condition     = one(aws_lambda_function.fn["api"].environment).variables["CR_REMAKE"] == "on"
    error_message = "With cr_remake_enabled, CR_REMAKE is on."
  }

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement : s if try(s.Sid, "") == "Campaigns"]) == 1
    error_message = "The copy needs no new permission: the api's grants are the ones Content Rewards already has."
  }
}

# docs/CONTRACTS.md §41.5 and §41.6: the campaign finder's seven routes answer 503 "Coming soon." until CR_FINDER=on,
# off by default and independent of the other Content Rewards switches; the switch is an in-place environment change
# (its look invoke and send_feedback use the Campaigns and PlatformSecrets grants Content Rewards already has).
run "cr_finder_off_by_default" {
  command = plan

  variables {
    content_rewards_enabled = true
    cr_remake_enabled       = true
    campaigns_function_arn  = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-campaigns"
  }

  assert {
    condition     = one(aws_lambda_function.fn["api"].environment).variables["CR_FINDER"] == "off"
    error_message = "cr_finder_enabled defaults to false: CR_FINDER is off even with Content Rewards and the copy on."
  }
}

run "cr_finder_on" {
  command = plan

  variables {
    content_rewards_enabled = true
    cr_finder_enabled       = true
    campaigns_function_arn  = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-campaigns"
  }

  assert {
    condition = (one(aws_lambda_function.fn["api"].environment).variables["CR_FINDER"] == "on" &&
      one(aws_lambda_function.fn["api"].environment).variables["CONTENT_REWARDS"] == "on" &&
      one(aws_lambda_function.fn["api"].environment).variables["CR_REMAKE"] == "off" &&
    one(aws_lambda_function.fn["api"].environment).variables["CAMPAIGNS_FUNCTION_ARN"] == "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-campaigns")
    error_message = "With cr_finder_enabled, CR_FINDER is on and the other Content Rewards env vars keep their own switches."
  }

  assert {
    condition = one([for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement : s if try(s.Sid, "") == "Campaigns"]) == {
      Sid = "Campaigns", Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = ["arn:aws:lambda:eu-north-1:123456789012:function:cf-test-campaigns"]
    }
    error_message = "A look is started through the same cf-prod-campaigns invoke grant, nothing new."
  }

  assert {
    condition     = aws_lambda_function.fn["api"].function_name == "cf-test-api" && aws_lambda_function.fn["api"].timeout == 29
    error_message = "The same function: the switch changes only its environment."
  }
}

# The finder switch reaches only the CR_FINDER env var: one use of var.cr_finder_enabled in this module, inside the
# Content Rewards env, so it can never add a grant or replace anything (the deploy's delete gate stays quiet).
run "cr_finder_switch_only_sets_its_env_var" {
  command = plan

  assert {
    condition = (one(aws_lambda_function.fn["api"].environment).variables["CR_FINDER"] == "off" &&
      length(regexall("var\\.cr_finder_enabled", file("main.tf"))) == 1 &&
    length(regexall("(?m)^\\s+CR_FINDER\\s+=\\s+var\\.cr_finder_enabled \\? \"on\" : \"off\"$", file("main.tf"))) == 1)
    error_message = "var.cr_finder_enabled is used once, as CR_FINDER = var.cr_finder_enabled ? \"on\" : \"off\"."
  }
}

# docs/CONTRACTS.md §40.6: "Connect Whop" waits behind WHOP_CONNECT, off by default; the switch is an in-place
# environment change of the same function (no new grant, nothing replaced).
run "whop_connect_off_by_default" {
  command = plan

  assert {
    condition     = var.whop_connect_enabled == false && one(aws_lambda_function.fn["api"].environment).variables["WHOP_CONNECT"] == "off"
    error_message = "whop_connect_enabled defaults to false: WHOP_CONNECT is off."
  }
}

run "whop_connect_on" {
  command = plan

  variables {
    whop_connect_enabled = true
  }

  assert {
    condition     = one(aws_lambda_function.fn["api"].environment).variables["WHOP_CONNECT"] == "on"
    error_message = "With whop_connect_enabled, WHOP_CONNECT is on."
  }

  assert {
    condition     = aws_lambda_function.fn["api"].function_name == "cf-test-api" && keys(aws_lambda_function.fn) == ["api"]
    error_message = "The switch changes only cf-test-api's environment: the same function, nothing replaced."
  }

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement : s if can(regex("(?i)whop", jsonencode(s)))]) == 0
    error_message = "Connect Whop needs no new permission: its secrets ride the existing PlatformSecrets grant."
  }
}

# docs/CONTRACTS.md §40.5.11: Your bank waits behind BANK_READING, off by default; the switch is an in-place
# environment change of the same function (no new grant, nothing replaced).
run "bank_reading_off_by_default" {
  command = plan

  assert {
    condition     = var.bank_reading_enabled == false && one(aws_lambda_function.fn["api"].environment).variables["BANK_READING"] == "off"
    error_message = "bank_reading_enabled defaults to false: BANK_READING is off."
  }
}

run "bank_reading_on" {
  command = plan

  variables {
    bank_reading_enabled = true
  }

  assert {
    condition     = one(aws_lambda_function.fn["api"].environment).variables["BANK_READING"] == "on"
    error_message = "With bank_reading_enabled, BANK_READING is on."
  }

  assert {
    condition     = aws_lambda_function.fn["api"].function_name == "cf-test-api" && keys(aws_lambda_function.fn) == ["api"]
    error_message = "The switch changes only cf-test-api's environment: the same function, nothing replaced."
  }

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.fn["api"].policy).Statement : s if can(regex("(?i)bank", jsonencode(s)))]) == 0
    error_message = "Your bank needs no new permission: its secrets ride the existing PlatformSecrets grant."
  }
}
