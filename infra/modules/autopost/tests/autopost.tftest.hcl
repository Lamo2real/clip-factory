# Offline plan test (mock AWS provider, no credentials, no AWS calls):
#   cd infra/modules/autopost && terraform init -backend=false && terraform test
#
# docs/CONTRACTS.md §46.11 and ADR-81: cf-prod-autopost fires every hour on the hour (EventBridge rule
# cf-prod-autopost-hourly), a retried delivery resumes its own run (2 retries, never older than 55 minutes), and the
# role is exactly what the run calls: the table without DeleteItem or Scan, starting the clip flow and nothing else,
# and the clip flow's platform secret grants for the campaign fit check. No S3, no iam:*, no scheduler:*. Everything
# here is new: no owner-data resource is in this module.

mock_provider "aws" {
  override_during = plan

  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:eu-north-1:123456789012:log-group:/aws/lambda/cf-test-autopost" }
  }
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = { arn = "arn:aws:events:eu-north-1:123456789012:rule/cf-test-autopost-hourly" }
  }
  mock_resource "aws_lambda_function" {
    defaults = { arn = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-autopost" }
  }
}

variables {
  name = "cf-test"
  # Any existing file: the module only hashes it.
  lambda_zip_path            = "main.tf"
  table_name                 = "cf-test-data"
  table_arn                  = "arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data"
  media_bucket               = "cf-test-media-123456789012"
  clip_flow_alias_arn        = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-clip-flow:live"
  clip_flow_arn_prefix       = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-clip-flow"
  secret_prefix              = "cf-test/platforms/"
  platform_secrets_arn       = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*"
  platform_token_secrets_arn = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*/token-*"
  content_rewards_enabled    = true
  permissions_boundary_arn   = "arn:aws:iam::123456789012:policy/cf-test-role-boundary"
}

run "the_function" {
  command = plan

  assert {
    condition     = aws_lambda_function.autopost.function_name == "cf-test-autopost" && aws_lambda_function.autopost.handler == "clipfactory_api.autopost.handler.handler"
    error_message = "cf-test-autopost runs clipfactory_api.autopost.handler.handler."
  }

  assert {
    condition = (aws_lambda_function.autopost.runtime == "python3.13" && aws_lambda_function.autopost.architectures == tolist(["arm64"]) &&
    aws_lambda_function.autopost.memory_size == 256 && aws_lambda_function.autopost.timeout == 300)
    error_message = "python3.13 on arm64, 256 MB, 300 s (the run stops starting new clips after 240 s)."
  }

  assert {
    condition = (aws_lambda_function.autopost.tracing_config[0].mode == "Active" &&
      aws_lambda_function.autopost.logging_config[0].log_format == "JSON" &&
      aws_lambda_function.autopost.logging_config[0].log_group == "/aws/lambda/cf-test-autopost" &&
    aws_cloudwatch_log_group.autopost.name == "/aws/lambda/cf-test-autopost" && aws_cloudwatch_log_group.autopost.retention_in_days == 30)
    error_message = "X-Ray is on and JSON logs go to /aws/lambda/cf-test-autopost (30 days, as the others)."
  }

  assert {
    condition = aws_lambda_function.autopost.environment[0].variables == tomap({
      TABLE_NAME                   = "cf-test-data"
      MEDIA_BUCKET                 = "cf-test-media-123456789012"
      CLIP_FLOW_ARN                = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-clip-flow:live"
      SECRET_PREFIX                = "cf-test/platforms/"
      CONTENT_REWARDS              = "on"
      AUTOPOST_TIME_BUDGET_SECONDS = "240"
    })
    error_message = "The env is exactly TABLE_NAME, MEDIA_BUCKET, CLIP_FLOW_ARN (the clip flow's live alias), SECRET_PREFIX, CONTENT_REWARDS and AUTOPOST_TIME_BUDGET_SECONDS=240."
  }

  assert {
    condition = (output.function_name == "cf-test-autopost" &&
    output.function_arn == "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-autopost")
    error_message = "The module hands out the function's name and unqualified ARN."
  }

  assert {
    condition     = output.function_names == { autopost = "cf-test-autopost" } && output.schedule_rule_names == { autopost = "cf-test-autopost-hourly" }
    error_message = "The function and its rule are handed to monitoring."
  }
}

run "content_rewards_off" {
  command = plan

  variables {
    content_rewards_enabled = false
  }

  assert {
    condition     = aws_lambda_function.autopost.environment[0].variables.CONTENT_REWARDS == "off"
    error_message = "With Content Rewards off the run gets CONTENT_REWARDS=off (every campaign clip waits)."
  }
}

run "every_hour_on_the_hour_and_retries_resume" {
  command = plan

  assert {
    condition = (aws_cloudwatch_event_rule.autopost.name == "cf-test-autopost-hourly" &&
      aws_cloudwatch_event_rule.autopost.schedule_expression == "cron(0 * * * ? *)" &&
    aws_cloudwatch_event_rule.autopost.state == "ENABLED" && aws_cloudwatch_event_rule.autopost.description != "")
    error_message = "cf-test-autopost-hourly fires every hour at :00 UTC and is ENABLED."
  }

  assert {
    condition = (aws_cloudwatch_event_target.autopost.rule == "cf-test-autopost-hourly" &&
      aws_cloudwatch_event_target.autopost.arn == aws_lambda_function.autopost.arn &&
    aws_cloudwatch_event_target.autopost.arn == "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-autopost")
    error_message = "The rule's target is the function (unqualified: always the current code)."
  }

  assert {
    condition = (aws_cloudwatch_event_target.autopost.retry_policy[0].maximum_retry_attempts == 2 &&
    aws_cloudwatch_event_target.autopost.retry_policy[0].maximum_event_age_in_seconds == 3300)
    error_message = "EventBridge retries a missed delivery twice, never later than 55 minutes (before the next tick)."
  }

  assert {
    condition = (aws_lambda_function_event_invoke_config.autopost.function_name == "cf-test-autopost" &&
      aws_lambda_function_event_invoke_config.autopost.maximum_retry_attempts == 2 &&
    aws_lambda_function_event_invoke_config.autopost.maximum_event_age_in_seconds == 3300)
    error_message = "A failed run is retried twice (the same event resumes its own run), never older than 55 minutes."
  }

  assert {
    condition = (aws_lambda_permission.autopost.principal == "events.amazonaws.com" &&
      aws_lambda_permission.autopost.action == "lambda:InvokeFunction" &&
      aws_lambda_permission.autopost.function_name == "cf-test-autopost" &&
      aws_lambda_permission.autopost.source_arn == aws_cloudwatch_event_rule.autopost.arn &&
    aws_lambda_permission.autopost.source_arn == "arn:aws:events:eu-north-1:123456789012:rule/cf-test-autopost-hourly")
    error_message = "Only the hourly rule may invoke cf-test-autopost."
  }
}

run "least_privilege_and_nothing_can_be_deleted" {
  command = plan

  assert {
    condition     = aws_iam_role.autopost.name == "cf-test-fn-autopost" && aws_iam_role.autopost.permissions_boundary == "arn:aws:iam::123456789012:policy/cf-test-role-boundary"
    error_message = "The role is cf-test-fn-autopost and carries the deploy role's permissions boundary."
  }

  assert {
    condition = (
      toset([for s in jsondecode(aws_iam_role_policy.autopost.policy).Statement : s.Sid]) ==
      toset(["Logs", "Tracing", "Data", "StartClipFlow", "PlatformSecretsRead", "PlatformTokens"]) &&
      alltrue([for s in jsondecode(aws_iam_role_policy.autopost.policy).Statement : s.Effect == "Allow"])
    )
    error_message = "The role has exactly the logs, tracing, table, clip flow start and platform secret statements: nothing else."
  }

  assert {
    condition = (
      toset(one([for s in jsondecode(aws_iam_role_policy.autopost.policy).Statement : s.Action if s.Sid == "Data"])) ==
      toset(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:BatchGetItem", "dynamodb:TransactWriteItems", "dynamodb:ConditionCheckItem"]) &&
      one([for s in jsondecode(aws_iam_role_policy.autopost.policy).Statement : s.Resource if s.Sid == "Data"]) ==
      ["arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data", "arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data/index/*"]
    )
    error_message = "The table (and its indexes) with GetItem, PutItem, UpdateItem, Query, BatchGetItem, TransactWriteItems and ConditionCheckItem only."
  }

  assert {
    condition = alltrue([
      for a in flatten([for s in jsondecode(aws_iam_role_policy.autopost.policy).Statement : flatten([s.Action])]) :
      !strcontains(a, "Delete") && a != "dynamodb:Scan" && !startswith(a, "iam:") && !startswith(a, "scheduler:") &&
      !startswith(a, "s3:") && !strcontains(a, "*") && !strcontains(a, "CreateSecret")
    ])
    error_message = "No DeleteItem, no Scan, no iam:*, no scheduler:*, no S3, no wildcard action and no secret creation."
  }

  assert {
    condition = (
      [for s in jsondecode(aws_iam_role_policy.autopost.policy).Statement : s.Resource if contains(flatten([s.Action]), "lambda:InvokeFunction")] ==
      [["arn:aws:lambda:eu-north-1:123456789012:function:cf-test-clip-flow:*"]] &&
      one([for s in jsondecode(aws_iam_role_policy.autopost.policy).Statement : s.Action if s.Sid == "StartClipFlow"]) == ["lambda:InvokeFunction"] &&
      alltrue([
        for a in flatten([for s in jsondecode(aws_iam_role_policy.autopost.policy).Statement : flatten([s.Action]) if s.Sid != "StartClipFlow"]) :
        !startswith(a, "lambda:")
      ])
    )
    error_message = "The only invoke grant is the clip flow (any qualifier of cf-test-clip-flow, for its live alias); no other Lambda call."
  }

  assert {
    condition = (
      one([for s in jsondecode(aws_iam_role_policy.autopost.policy).Statement : s.Action if s.Sid == "PlatformSecretsRead"]) == ["secretsmanager:GetSecretValue"] &&
      one([for s in jsondecode(aws_iam_role_policy.autopost.policy).Statement : s.Resource if s.Sid == "PlatformSecretsRead"]) ==
      ["arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*"]
    )
    error_message = "GetSecretValue on the platform keys and tokens only, as the clip flow."
  }

  assert {
    condition = (
      one([for s in jsondecode(aws_iam_role_policy.autopost.policy).Statement : s.Action if s.Sid == "PlatformTokens"]) == ["secretsmanager:PutSecretValue"] &&
      one([for s in jsondecode(aws_iam_role_policy.autopost.policy).Statement : s.Resource if s.Sid == "PlatformTokens"]) ==
      ["arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*/token-*"]
    )
    error_message = "PutSecretValue only on the token secrets (a refreshed token), as the clip flow."
  }

  assert {
    condition = (
      one([for s in jsondecode(aws_iam_role_policy.autopost.policy).Statement : s.Resource if s.Sid == "Logs"]) ==
      "arn:aws:logs:eu-north-1:123456789012:log-group:/aws/lambda/cf-test-autopost:*"
    )
    error_message = "Logs only to its own log group."
  }
}

run "no_boundary_when_empty" {
  command = plan

  variables {
    permissions_boundary_arn = ""
  }

  assert {
    condition     = aws_iam_role.autopost.permissions_boundary == null
    error_message = "An empty boundary ARN sets none (as every other module)."
  }
}

run "invoke_grant_cannot_widen" {
  command = plan

  variables {
    clip_flow_arn_prefix = "arn:aws:lambda:eu-north-1:123456789012:function:*"
  }

  expect_failures = [var.clip_flow_arn_prefix]
}

run "clip_flow_must_be_the_live_alias" {
  command = plan

  variables {
    clip_flow_alias_arn = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-clip-flow"
  }

  expect_failures = [var.clip_flow_alias_arn]
}

run "token_secret_pattern_is_validated" {
  command = plan

  variables {
    platform_token_secrets_arn = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:*"
  }

  expect_failures = [var.platform_token_secrets_arn]
}

run "secret_pattern_is_validated" {
  command = plan

  variables {
    platform_secrets_arn = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:*"
  }

  expect_failures = [var.platform_secrets_arn]
}

# docs/CONTRACTS.md §45.13.1, §45.15 and ADR-73: Lamo Clips' auto-posting role cannot reach a Lamo Stories workspace
# token. IAM patterns are checked as globs against the sample ARN: "*" becomes ".*" and "?" becomes "." in an anchored
# regex, dots escaped.
run "no_lamo_stories_secrets" {
  command = plan

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.autopost.policy).Statement : [
        for r in flatten([s.Resource]) : !can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/workspaces/stories/youtube/token-AbC123"))
      ] if anytrue([for a in flatten([s.Action]) : startswith(a, "secretsmanager:") || a == "*"])
    ]))
    error_message = "…:secret:<name>/workspaces/stories/youtube/token-AbC123 must match no auto-posting Secrets Manager resource."
  }
}
