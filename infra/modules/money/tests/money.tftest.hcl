# Offline plan test (mock AWS provider, no credentials, no AWS calls):
#   cd infra/modules/money && terraform init -backend=false && terraform test
#
# docs/CONTRACTS.md §25.6: cf-prod-money runs once a day at 06:00 UTC and on "Check now", never retries, may read
# and refresh platform tokens exactly like cf-prod-stats, and can never delete anything (no DeleteItem, no secret
# create or delete). Everything here is new: no owner-data resource is in this module.

mock_provider "aws" {
  override_during = plan

  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:eu-north-1:123456789012:log-group:/aws/lambda/cf-test-money" }
  }
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = { arn = "arn:aws:events:eu-north-1:123456789012:rule/cf-test-money-daily" }
  }
  mock_resource "aws_lambda_function" {
    defaults = { arn = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-money" }
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
  secret_prefix              = "cf-test/platforms/"
  platform_secrets_arn       = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*"
  platform_token_secrets_arn = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*/token-*"
}

run "daily_at_six_and_never_retried" {
  command = plan

  assert {
    condition     = aws_cloudwatch_event_rule.money.schedule_expression == "cron(0 6 * * ? *)" && aws_cloudwatch_event_rule.money.state == "ENABLED"
    error_message = "cf-test-money-daily must run at 06:00 UTC every day."
  }

  assert {
    condition     = aws_cloudwatch_event_target.money.retry_policy[0].maximum_retry_attempts == 0 && aws_lambda_function_event_invoke_config.money.maximum_retry_attempts == 0
    error_message = "The money run is never retried (tomorrow's run does the same work, and budgets are shared)."
  }

  assert {
    condition     = aws_lambda_function.money.function_name == "cf-test-money" && aws_lambda_function.money.handler == "clipfactory_api.money.handler.handler"
    error_message = "cf-test-money runs clipfactory_api.money.handler.handler."
  }

  assert {
    condition     = aws_lambda_function.money.environment[0].variables.SECRET_PREFIX == "cf-test/platforms/" && aws_lambda_function.money.environment[0].variables.TABLE_NAME == "cf-test-data"
    error_message = "The function gets TABLE_NAME and SECRET_PREFIX."
  }

  assert {
    condition     = output.money_function_arn == "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-money"
    error_message = "cf-prod-api gets the unqualified ARN of cf-prod-money."
  }

  assert {
    condition     = output.function_names == { money = "cf-test-money" } && output.schedule_rule_names == { money = "cf-test-money-daily" }
    error_message = "The function and its rule are handed to monitoring."
  }
}

run "least_privilege_and_nothing_can_be_deleted" {
  command = plan

  assert {
    condition = (
      toset(one([for s in jsondecode(aws_iam_role_policy.money.policy).Statement : s.Action if s.Sid == "Data"])) ==
      toset(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"])
    )
    error_message = "The money role may only GetItem, PutItem, UpdateItem and Query: no DeleteItem, no Scan."
  }

  assert {
    condition     = !strcontains(aws_iam_role_policy.money.policy, "Delete") && !strcontains(aws_iam_role_policy.money.policy, "CreateSecret") && !strcontains(aws_iam_role_policy.money.policy, "dynamodb:Scan")
    error_message = "Nothing in the money role can delete data or create secrets."
  }

  assert {
    condition = (
      one([for s in jsondecode(aws_iam_role_policy.money.policy).Statement : s.Resource if s.Sid == "PlatformTokens"]) ==
      ["arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*/token-*"]
    )
    error_message = "PutSecretValue only on the token secrets (a refreshed token), like cf-prod-stats."
  }

  assert {
    condition = (
      one([for s in jsondecode(aws_iam_role_policy.money.policy).Statement : s.Resource if s.Sid == "PlatformSecretsRead"]) ==
      ["arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*"]
    )
    error_message = "GetSecretValue on the platform keys and tokens only."
  }
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

# docs/CONTRACTS.md §45.13.1, §45.15 and ADR-73: Lamo Clips' money role cannot reach a Lamo Stories workspace token.
# IAM patterns are checked as globs against the sample ARN: "*" becomes ".*" and "?" becomes "." in an anchored regex,
# dots escaped.
run "no_lamo_stories_secrets" {
  command = plan

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.money.policy).Statement : [
        for r in flatten([s.Resource]) : !can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/workspaces/stories/youtube/token-AbC123"))
      ] if anytrue([for a in flatten([s.Action]) : startswith(a, "secretsmanager:") || a == "*"])
    ]))
    error_message = "…:secret:<name>/workspaces/stories/youtube/token-AbC123 must match no money Secrets Manager resource."
  }
}

# docs/CONTRACTS.md §40.5.11: the bank reader follows BANK_READING (off by default, the same switch as cf-prod-api),
# suggests Content Rewards only while CONTENT_REWARDS is on, and fills psu-referer from APP_URL. In-place env changes
# of the same function: no new permission (the bank secrets ride the existing PlatformSecretsRead grant), still no
# DeleteItem and no secret write it didn't have.
run "your_bank_is_off_by_default" {
  command = plan

  assert {
    condition = (aws_lambda_function.money.environment[0].variables.BANK_READING == "off" &&
      aws_lambda_function.money.environment[0].variables.CONTENT_REWARDS == "off" &&
    !contains(keys(aws_lambda_function.money.environment[0].variables), "APP_URL"))
    error_message = "By default the bank reader is off, Content Rewards is off and there is no APP_URL."
  }
}

run "your_bank_on" {
  command = plan

  variables {
    bank_reading_enabled    = true
    content_rewards_enabled = true
    app_url                 = "https://app.example.test"
  }

  assert {
    condition = (aws_lambda_function.money.environment[0].variables.BANK_READING == "on" &&
      aws_lambda_function.money.environment[0].variables.CONTENT_REWARDS == "on" &&
    aws_lambda_function.money.environment[0].variables.APP_URL == "https://app.example.test")
    error_message = "With the switch on the reader gets BANK_READING=on, CONTENT_REWARDS=on and APP_URL."
  }

  assert {
    condition = (aws_lambda_function.money.function_name == "cf-test-money" &&
    length([for s in jsondecode(aws_iam_role_policy.money.policy).Statement : s if can(regex("(?i)bank|DeleteItem|CreateSecret|DeleteSecret", jsonencode(s)))]) == 0)
    error_message = "The same function and no new permission: no bank-named grant, no DeleteItem, no secret create or delete."
  }
}

run "app_url_is_validated" {
  command = plan

  variables {
    app_url = "http://app.example.test/"
  }

  expect_failures = [var.app_url]
}
