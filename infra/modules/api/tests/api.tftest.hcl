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
      # §27.12 module default: no assistant worker, so off.
      ASK_ENABLED = "false"
    })
    error_message = "cf-prod-api environment must match docs/CONTRACTS.md §9, §16.9, §17.9 and §19.9 (HOOKS_URL, SECRET_PREFIX, OAUTH_STATE_SECRET, WEB_BUCKET, DISTRIBUTION_ID, HELP_*; no PUBLISH_QUEUE_URL, PERF_CHECK_FUNCTION_ARN, SCHEDULER_ROLE_ARN or SCHEDULE_GROUP)."
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

# docs/CONTRACTS.md §27.12: the assistant adds starting cf-prod-ask, the search key and the ask/ media prefix. Nothing
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
    condition     = toset([for r in [aws_apigatewayv2_route.authorized, aws_apigatewayv2_route.health] : r.route_key]) == toset(["ANY /v1/{proxy+}", "GET /v1/health"])
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
