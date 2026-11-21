# Offline plan test (mock AWS provider, no credentials, no AWS calls):
#   cd infra/modules/contentrewards && terraform init -backend=false && terraform test
#
# docs/CONTRACTS.md §38.16: cf-prod-campaigns reads untrusted brand text and fetches outside files, so it has no
# secretsmanager action at all, reaches only the media bucket's campaigns/ prefix, never deletes a table item, is
# async only and never retried. CONTENT_REWARDS is off unless the switch is on. Everything here is new: no owner-data
# resource is in this module (no table, bucket or secret).

mock_provider "aws" {
  override_during = plan

  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:eu-north-1:123456789012:log-group:/aws/lambda/cf-test-campaigns" }
  }
  mock_resource "aws_lambda_function" {
    defaults = { arn = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-campaigns" }
  }
}

variables {
  name       = "cf-test"
  region     = "eu-north-1"
  account_id = "123456789012"
  # Any existing file: the module only hashes it.
  lambda_zip_path  = "main.tf"
  table_name       = "cf-test-data"
  table_arn        = "arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data"
  media_bucket     = "cf-test-media"
  media_bucket_arn = "arn:aws:s3:::cf-test-media"
  model_id         = "global.anthropic.claude-fable-5-1"
  model_invoke_arns = [
    "arn:aws:bedrock:eu-north-1:123456789012:inference-profile/global.anthropic.claude-fable-5-1",
    "arn:aws:bedrock:::foundation-model/anthropic.claude-fable-5-1",
  ]
  app_url = "https://app.example.test"
}

run "the_function_and_its_environment" {
  command = plan

  assert {
    condition = (aws_lambda_function.campaigns.function_name == "cf-test-campaigns" &&
      aws_lambda_function.campaigns.handler == "clipfactory_api.contentrewards.handler.handler" &&
    aws_lambda_function.campaigns.memory_size == 512 && aws_lambda_function.campaigns.timeout == 120)
    error_message = "cf-test-campaigns runs clipfactory_api.contentrewards.handler.handler with 512 MB and 120 s."
  }

  assert {
    condition = one(aws_lambda_function.campaigns.environment).variables == tomap({
      TABLE_NAME      = "cf-test-data"
      MEDIA_BUCKET    = "cf-test-media"
      MODEL_ID        = "global.anthropic.claude-fable-5-1"
      APP_URL         = "https://app.example.test"
      CONTENT_REWARDS = "off"
    })
    error_message = "Exactly TABLE_NAME, MEDIA_BUCKET, MODEL_ID, APP_URL and CONTENT_REWARDS (off by default); no SECRET_PREFIX."
  }

  assert {
    condition     = aws_lambda_function_event_invoke_config.campaigns.maximum_retry_attempts == 0
    error_message = "Async only and never retried (a failed read shows as rulesState failed)."
  }

  assert {
    condition     = aws_cloudwatch_log_group.campaigns.name == "/aws/lambda/cf-test-campaigns" && aws_cloudwatch_log_group.campaigns.retention_in_days == 30
    error_message = "Its own log group with the same retention."
  }

  assert {
    condition = (output.campaigns_function_arn == "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-campaigns" &&
    output.function_names == { campaigns = "cf-test-campaigns" })
    error_message = "cf-prod-api and cf-prod-stats get the unqualified ARN; monitoring gets the name."
  }
}

run "switched_on" {
  command = plan

  variables {
    content_rewards_enabled = true
  }

  assert {
    condition     = one(aws_lambda_function.campaigns.environment).variables["CONTENT_REWARDS"] == "on"
    error_message = "content_rewards_enabled = true turns CONTENT_REWARDS on."
  }
}

run "least_privilege_and_no_secrets" {
  command = plan

  assert {
    condition     = length(regexall("secretsmanager", aws_iam_role_policy.campaigns.policy)) == 0
    error_message = "cf-prod-campaigns has no secretsmanager action at all (§38.16)."
  }

  assert {
    condition = (
      toset(one([for s in jsondecode(aws_iam_role_policy.campaigns.policy).Statement : s.Action if s.Sid == "Data"])) ==
      toset(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"])
    )
    error_message = "Only GetItem, PutItem, UpdateItem and Query on the table: no DeleteItem, no Scan."
  }

  assert {
    condition = one([for s in jsondecode(aws_iam_role_policy.campaigns.policy).Statement : s if s.Sid == "CampaignFiles"]) == {
      Sid = "CampaignFiles", Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = ["arn:aws:s3:::cf-test-media/campaigns/*"]
    }
    error_message = "Media only under campaigns/*."
  }

  assert {
    condition = (
      toset([for s in jsondecode(aws_iam_role_policy.campaigns.policy).Statement : s.Sid]) ==
      toset(["Logs", "Tracing", "Data", "CampaignFiles", "RulesModel"])
    )
    error_message = "Nothing beyond logs, traces, the table, campaigns/* and the model."
  }

  assert {
    condition = one([for s in jsondecode(aws_iam_role_policy.campaigns.policy).Statement : s.Resource if s.Sid == "RulesModel"]) == [
      "arn:aws:bedrock:eu-north-1:123456789012:inference-profile/global.anthropic.claude-fable-5-1",
      "arn:aws:bedrock:::foundation-model/anthropic.claude-fable-5-1",
    ]
    error_message = "bedrock:InvokeModel only on the clip agent's model."
  }

  assert {
    condition     = length(regexall("lambda:", aws_iam_role_policy.campaigns.policy)) == 0
    error_message = "cf-prod-campaigns starts nothing else."
  }
}
