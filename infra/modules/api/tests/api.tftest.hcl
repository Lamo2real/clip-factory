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
      HOOKS_URL          = "https://rest123.execute-api.eu-north-1.amazonaws.com/v1"
      SECRET_PREFIX      = "cf-test/platforms/"
      OAUTH_STATE_SECRET = "cf-test/oauth/state-key"
      WEB_BUCKET         = "cf-test-web-123456789012"
      DISTRIBUTION_ID    = "E2EXAMPLE"
    })
    error_message = "cf-prod-api environment must match docs/CONTRACTS.md §9, §16.9 and §17.9 (HOOKS_URL, SECRET_PREFIX, OAUTH_STATE_SECRET, WEB_BUCKET, DISTRIBUTION_ID; no PUBLISH_QUEUE_URL, PERF_CHECK_FUNCTION_ARN, SCHEDULER_ROLE_ARN or SCHEDULE_GROUP)."
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
    ])
    error_message = "lambda:InvokeFunction covers exactly the two flows, cf-prod-stats and cf-prod-learn."
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
    error_message = "No queue, scheduler, PassRole or Bedrock model permissions remain on the API."
  }
}
