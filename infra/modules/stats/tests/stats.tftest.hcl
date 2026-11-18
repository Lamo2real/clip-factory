# Offline plan test (mock AWS provider, no credentials, no AWS calls):
#   cd infra/modules/stats && terraform init -backend=false && terraform test
#
# docs/CONTRACTS.md §16.4, §16.5, §16.6 and §16.9: cf-prod-stats runs on an EventBridge rule whose rate comes from
# config/platforms.json (the lowest minIntervalMinutes), never retries, and may only touch the table and read/refresh
# platform tokens (§17.9); cf-prod-learn retries once and may also call Bedrock and the clips vector index.

mock_provider "aws" {
  override_during = plan

  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:eu-north-1:123456789012:log-group:cf-test" }
  }
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = { arn = "arn:aws:events:eu-north-1:123456789012:rule/cf-test-stats" }
  }
  mock_resource "aws_lambda_function" {
    defaults = { arn = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-stats" }
  }
}

variables {
  name       = "cf-test"
  region     = "eu-north-1"
  account_id = "123456789012"
  # Any existing file: the module only hashes it.
  lambda_zip_path            = "main.tf"
  table_name                 = "cf-test-data"
  table_arn                  = "arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data"
  media_bucket               = "cf-test-media"
  media_bucket_arn           = "arn:aws:s3:::cf-test-media"
  model_id                   = "global.anthropic.claude-fable-5-1"
  model_invoke_arns          = ["arn:aws:bedrock:eu-north-1:123456789012:inference-profile/global.anthropic.claude-fable-5-1", "arn:aws:bedrock:*::foundation-model/anthropic.claude-fable-5-1"]
  embed_model_id             = "amazon.titan-embed-text-v2:0"
  embed_model_arn            = "arn:aws:bedrock:eu-north-1::foundation-model/amazon.titan-embed-text-v2:0"
  vector_bucket              = "cf-test-vectors-123456789012"
  vector_index               = "clips"
  vector_index_arn           = "arn:aws:s3vectors:eu-north-1:123456789012:bucket/cf-test-vectors-123456789012/index/clips"
  platforms_config_path      = "../../../config/platforms.json"
  secret_prefix              = "cf-test/platforms/"
  platform_secrets_arn       = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*"
  platform_token_secrets_arn = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*/token-*"
}

run "tick_comes_from_platforms_json" {
  command = plan

  assert {
    condition     = aws_cloudwatch_event_rule.stats.name == "cf-test-stats" && aws_cloudwatch_event_rule.stats.schedule_expression == "rate(15 minutes)"
    error_message = "The rule <name>-stats must tick at rate(15 minutes): the lowest minIntervalMinutes in config/platforms.json."
  }

  assert {
    condition     = aws_cloudwatch_event_rule.stats.state == "ENABLED"
    error_message = "The stats rule must be ENABLED."
  }

  assert {
    condition     = output.stats_tick_minutes == 15 && output.stats_rule_name == "cf-test-stats"
    error_message = "stats_tick_minutes must be 15 and stats_rule_name cf-test-stats."
  }

  assert {
    condition     = local.platforms.platforms.instagram.minIntervalMinutes == 30 && local.platforms.platforms.facebook.minIntervalMinutes == 30 && local.platforms.platforms.x.minIntervalMinutes == 15
    error_message = "config/platforms.json must keep the §16.4 intervals (Instagram, Facebook 30; YouTube, TikTok, X 15)."
  }

  assert {
    condition     = local.platforms.order == ["youtube", "tiktok", "instagram", "facebook", "x"]
    error_message = "config/platforms.json order must be STATS_ORDER."
  }
}

run "tick_follows_an_override_with_every_interval_at_30" {
  command = plan

  variables {
    platforms_config_path = "tests/fixtures/platforms-all-30.json"
  }

  assert {
    condition     = aws_cloudwatch_event_rule.stats.schedule_expression == "rate(30 minutes)" && output.stats_tick_minutes == 30
    error_message = "With every interval at 30 minutes the rule must be rate(30 minutes)."
  }
}

run "one_minute_tick_is_singular" {
  command = plan

  variables {
    platforms_config_path = "tests/fixtures/platforms-one-minute.json"
  }

  assert {
    condition     = aws_cloudwatch_event_rule.stats.schedule_expression == "rate(1 minute)"
    error_message = "EventBridge needs rate(1 minute), singular."
  }
}

run "bad_config_fails_the_plan" {
  command = plan

  variables {
    platforms_config_path = "tests/fixtures/platforms-bad.json"
  }

  expect_failures = [aws_cloudwatch_event_rule.stats]
}

run "missing_config_is_rejected" {
  command = plan

  variables {
    platforms_config_path = "tests/fixtures/does-not-exist.json"
  }

  expect_failures = [var.platforms_config_path]
}

run "rule_targets_the_stats_function" {
  command = plan

  assert {
    condition     = aws_cloudwatch_event_target.stats.rule == "cf-test-stats" && aws_cloudwatch_event_target.stats.arn == aws_lambda_function.fn["stats"].arn
    error_message = "The rule's target must be the unqualified stats function."
  }

  assert {
    condition = (aws_lambda_permission.events.principal == "events.amazonaws.com" &&
      aws_lambda_permission.events.action == "lambda:InvokeFunction" &&
      aws_lambda_permission.events.function_name == "cf-test-stats" &&
    aws_lambda_permission.events.source_arn == aws_cloudwatch_event_rule.stats.arn)
    error_message = "Only this rule may invoke cf-test-stats through EventBridge."
  }
}

run "daily_learning_rule_targets_the_learn_function" {
  command = plan

  assert {
    condition = (aws_cloudwatch_event_rule.learn_daily.name == "cf-test-learn-daily" &&
      aws_cloudwatch_event_rule.learn_daily.schedule_expression == "cron(0 5 * * ? *)" &&
    aws_cloudwatch_event_rule.learn_daily.state == "ENABLED")
    error_message = "The rule <name>-learn-daily must run once a day at 05:00 UTC."
  }

  assert {
    condition     = aws_cloudwatch_event_target.learn_daily.rule == "cf-test-learn-daily" && aws_cloudwatch_event_target.learn_daily.arn == aws_lambda_function.fn["learn"].arn
    error_message = "The daily rule's target must be the unqualified learn function."
  }

  assert {
    condition = (aws_lambda_permission.learn_daily.principal == "events.amazonaws.com" &&
      aws_lambda_permission.learn_daily.action == "lambda:InvokeFunction" &&
      aws_lambda_permission.learn_daily.function_name == "cf-test-learn" &&
    aws_lambda_permission.learn_daily.source_arn == aws_cloudwatch_event_rule.learn_daily.arn)
    error_message = "Only the daily rule may invoke cf-test-learn through EventBridge."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.fn["learn"].policy).Statement : !contains(s.Action, "dynamodb:Scan")
    ])
    error_message = "cf-prod-learn finds owners through gsi2 (Query); it never gets dynamodb:Scan."
  }
}

run "functions_match_the_contract" {
  command = plan

  assert {
    condition     = output.function_names == { stats = "cf-test-stats", learn = "cf-test-learn" }
    error_message = "function_names must be { stats = <name>-stats, learn = <name>-learn }."
  }

  assert {
    condition     = output.stats_function_arn == "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-stats" && output.learn_function_arn == "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-learn"
    error_message = "The function ARN outputs are unqualified ARNs built from the names."
  }

  assert {
    condition     = aws_lambda_function.fn["stats"].handler == "clipfactory_api.stats.handler.handler" && aws_lambda_function.fn["learn"].handler == "clipfactory_api.weekly.handler"
    error_message = "Handlers must match docs/CONTRACTS.md §9."
  }

  assert {
    condition = (aws_lambda_function.fn["stats"].memory_size == 256 && aws_lambda_function.fn["stats"].timeout == 300 &&
    aws_lambda_function.fn["learn"].memory_size == 512 && aws_lambda_function.fn["learn"].timeout == 900)
    error_message = "stats is 256 MB / 300 s, learn 512 MB / 900 s (the daily run stops new work after 720 s)."
  }

  assert {
    condition = alltrue([for f in aws_lambda_function.fn : (
      f.runtime == "python3.13" && one(f.architectures) == "arm64" && one(f.tracing_config).mode == "Active" &&
      one(f.logging_config).log_format == "JSON" && one(f.logging_config).log_group == "/aws/lambda/${f.function_name}"
    )])
    error_message = "Both run python3.13 on arm64 with X-Ray and JSON logs in /aws/lambda/<function>."
  }

  assert {
    condition     = alltrue([for f in aws_lambda_function.fn : f.reserved_concurrent_executions == null || f.reserved_concurrent_executions == -1])
    error_message = "No reserved concurrency (new accounts cannot reserve any; budgets are conditional writes)."
  }

  assert {
    condition = one(aws_lambda_function.fn["stats"].environment).variables == tomap({
      TABLE_NAME                = "cf-test-data"
      STATS_TIME_BUDGET_SECONDS = "240"
      SECRET_PREFIX             = "cf-test/platforms/"
    })
    error_message = "cf-prod-stats gets exactly TABLE_NAME, STATS_TIME_BUDGET_SECONDS = 240 and SECRET_PREFIX (§17.9)."
  }

  assert {
    condition = one(aws_lambda_function.fn["learn"].environment).variables == tomap({
      TABLE_NAME     = "cf-test-data"
      MEDIA_BUCKET   = "cf-test-media"
      MODEL_ID       = "global.anthropic.claude-fable-5-1"
      EMBED_MODEL_ID = "amazon.titan-embed-text-v2:0"
      VECTOR_BUCKET  = "cf-test-vectors-123456789012"
      VECTOR_INDEX   = "clips"
    })
    error_message = "cf-prod-learn gets exactly TABLE_NAME, MEDIA_BUCKET, MODEL_ID, EMBED_MODEL_ID, VECTOR_BUCKET and VECTOR_INDEX."
  }
}

run "async_invoke_retries" {
  command = plan

  assert {
    condition = (aws_lambda_function_event_invoke_config.fn["stats"].maximum_retry_attempts == 0 &&
    aws_lambda_function_event_invoke_config.fn["stats"].maximum_event_age_in_seconds == 900)
    error_message = "stats never retries (rate budgets) and drops events older than 15 minutes."
  }

  assert {
    condition = (aws_lambda_function_event_invoke_config.fn["learn"].maximum_retry_attempts == 1 &&
    aws_lambda_function_event_invoke_config.fn["learn"].maximum_event_age_in_seconds == 3600)
    error_message = "learn retries once and keeps events for an hour."
  }
}

run "roles_allow_exactly_what_the_code_calls" {
  command = plan

  assert {
    condition     = aws_iam_role.fn["stats"].name == "cf-test-fn-stats" && aws_iam_role.fn["learn"].name == "cf-test-fn-learn"
    error_message = "Roles must be <name>-fn-stats and <name>-fn-learn."
  }

  assert {
    condition = toset(flatten([for s in jsondecode(aws_iam_role_policy.fn["stats"].policy).Statement : s.Action])) == toset([
      "logs:CreateLogStream", "logs:PutLogEvents", "xray:PutTraceSegments", "xray:PutTelemetryRecords",
      "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:BatchGetItem",
      "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue",
    ])
    error_message = "cf-prod-stats may only read/write the table (DeleteItem for forget), read/refresh platform tokens, log and trace (no Bedrock, no S3 Vectors)."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["stats"].policy).Statement :
      s.Sid == "Data" && s.Resource == ["arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data", "arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data/index/*"]
    ])
    error_message = "cf-prod-stats needs the table and its indexes (gsi2 STATS, gsi1 CLIP#)."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["stats"].policy).Statement :
      s.Sid == "PlatformSecretsRead" && s.Action == ["secretsmanager:GetSecretValue"] &&
      s.Resource == ["arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*"]
    ])
    error_message = "stats reads app keys and tokens only under <name>/platforms/*."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["stats"].policy).Statement :
      s.Sid == "PlatformTokens" && s.Action == ["secretsmanager:PutSecretValue"] &&
      s.Resource == ["arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*/token-*"]
    ])
    error_message = "stats writes only refreshed tokens (<name>/platforms/*/token-*), never app keys or pending choices."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.fn["stats"].policy).Statement :
      !contains(s.Action, "secretsmanager:PutSecretValue") || s.Resource == ["arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*/token-*"]
    ])
    error_message = "stats may not put any secret other than the token secrets."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.fn["learn"].policy).Statement : alltrue([for a in s.Action : !startswith(a, "secretsmanager:")])
    ])
    error_message = "cf-prod-learn gets no Secrets Manager access."
  }

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.fn["stats"].policy).Statement : [
        for a in s.Action : !startswith(a, "bedrock") && !startswith(a, "s3vectors:") && !startswith(a, "s3:") && !startswith(a, "lambda:")
      ]
    ]))
    error_message = "cf-prod-stats gets no bedrock, s3vectors, s3 or lambda permissions."
  }

  assert {
    condition = toset(flatten([for s in jsondecode(aws_iam_role_policy.fn["learn"].policy).Statement : s.Action])) == toset([
      "logs:CreateLogStream", "logs:PutLogEvents", "xray:PutTraceSegments", "xray:PutTelemetryRecords",
      "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:BatchGetItem",
      "bedrock:InvokeModel", "s3vectors:GetVectors", "s3vectors:PutVectors", "s3:GetObject",
    ])
    error_message = "cf-prod-learn's actions must match docs/CONTRACTS.md §16.9 and §18.8."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["learn"].policy).Statement :
      s.Sid == "Skills" && s.Effect == "Allow" && s.Action == ["s3:GetObject"] && s.Resource == ["arn:aws:s3:::cf-test-media/skills/*"]
    ])
    error_message = "cf-prod-learn reads the owner's skills: { Sid = Skills, Action = [s3:GetObject], Resource = [<media>/skills/*] } (§18.8)."
  }

  assert {
    condition = toset(flatten([
      for s in jsondecode(aws_iam_role_policy.fn["learn"].policy).Statement : s.Resource if anytrue([for a in s.Action : startswith(a, "s3:")])
    ])) == toset(["arn:aws:s3:::cf-test-media/skills/*"])
    error_message = "cf-prod-learn's only S3 access is skills/* (no list, no other prefix)."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["learn"].policy).Statement :
      s.Sid == "Models" && toset(s.Resource) == toset([
        "arn:aws:bedrock:eu-north-1:123456789012:inference-profile/global.anthropic.claude-fable-5-1",
        "arn:aws:bedrock:*::foundation-model/anthropic.claude-fable-5-1",
        "arn:aws:bedrock:eu-north-1::foundation-model/amazon.titan-embed-text-v2:0",
      ])
    ])
    error_message = "cf-prod-learn reaches Fable through the profile and Titan, nothing else."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["learn"].policy).Statement :
      s.Sid == "Vectors" && s.Resource == ["arn:aws:s3vectors:eu-north-1:123456789012:bucket/cf-test-vectors-123456789012/index/clips"]
    ])
    error_message = "S3 Vectors access must be limited to the clips index."
  }

  assert {
    condition = alltrue(flatten([
      for k, p in aws_iam_role_policy.fn : [
        for s in jsondecode(p.policy).Statement : [
          for a in s.Action : a != "dynamodb:Scan" && a != "iam:PassRole" && !endswith(a, "*")
        ]
      ]
    ]))
    error_message = "No Scan, PassRole or wildcard actions."
  }
}
