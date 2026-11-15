# Offline test (mock AWS provider, no credentials, no AWS calls):
#   cd infra/modules/api && terraform init -backend=false && terraform test
#
# The watchdog resumes Confirms that stopped before the clip was queued for publishing
# (api/src/clipfactory_api/watchdog.py). It only does so when PUBLISH_QUEUE_URL is set, and the resume creates the
# missing posts (PutItem) and sends the publish message (sqs:SendMessage), so both must be granted.

# The policy embeds the log group and queue ARNs; giving them at plan time makes it known to the asserts.
mock_provider "aws" {
  override_during = plan

  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:cf-test" }
  }
}

override_resource {
  target          = aws_sqs_queue.publish
  override_during = plan
  values = {
    arn = "arn:aws:sqs:us-east-1:123456789012:cf-test-publish"
    url = "https://sqs.us-east-1.amazonaws.com/123456789012/cf-test-publish"
  }
}

variables {
  name       = "cf-test"
  region     = "us-east-1"
  account_id = "123456789012"
  # Any existing file: the module only hashes it.
  lambda_zip_path   = "main.tf"
  app_version       = "test"
  app_url           = "https://app.example.test"
  web_dev_origin    = "http://localhost:5173"
  jwt_issuer        = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test"
  jwt_audience      = "testclient"
  table_name        = "cf-test"
  table_arn         = "arn:aws:dynamodb:us-east-1:123456789012:table/cf-test"
  media_bucket      = "cf-test-media"
  media_bucket_arn  = "arn:aws:s3:::cf-test-media"
  agent_runtime_arn = "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/cf_test"
  model_id          = "us.anthropic.test"
  model_invoke_arns = ["arn:aws:bedrock:us-east-1::foundation-model/test"]
}

run "watchdog_can_resume_publishes" {
  command = plan

  assert {
    condition     = one(aws_lambda_function.fn["watchdog"].environment).variables["PUBLISH_QUEUE_URL"] == "https://sqs.us-east-1.amazonaws.com/123456789012/cf-test-publish"
    error_message = "The watchdog needs PUBLISH_QUEUE_URL set to the publish queue, or it never resumes stuck Confirms."
  }

  assert {
    condition     = one(aws_lambda_function.fn["watchdog"].environment).variables["TABLE_NAME"] == "cf-test"
    error_message = "The watchdog needs TABLE_NAME."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["watchdog"].policy).Statement :
      s.Effect == "Allow" && contains(s.Action, "sqs:SendMessage") && s.Resource == ["arn:aws:sqs:us-east-1:123456789012:cf-test-publish"]
    ])
    error_message = "The watchdog must be allowed sqs:SendMessage on the publish queue (and only that queue)."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["watchdog"].policy).Statement :
      s.Effect == "Allow" && contains(s.Resource, "arn:aws:dynamodb:us-east-1:123456789012:table/cf-test") &&
      length(setsubtract(["dynamodb:Scan", "dynamodb:Query", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"], s.Action)) == 0
    ])
    error_message = "The watchdog must be allowed Scan, Query, GetItem, PutItem and UpdateItem on the table."
  }

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.fn["watchdog"].policy).Statement : [
        for a in s.Action : !contains(["dynamodb:DeleteItem", "dynamodb:BatchWriteItem", "sqs:ReceiveMessage", "sqs:DeleteMessage"], a)
      ]
    ]))
    error_message = "The watchdog never deletes items or consumes the queue; it must not be granted those actions."
  }
}
