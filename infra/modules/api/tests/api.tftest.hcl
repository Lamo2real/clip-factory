# Offline plan test (mock AWS provider, no credentials, no AWS calls):
#   cd infra/modules/api && terraform init -backend=false && terraform test
#
# docs/CONTRACTS.md §9, §14.1 and §14.4-14.6: the module holds only cf-prod-api and the HTTP API. The API starts the
# durable flows on their alias and reads/deletes clip vectors; the publish queue, scheduler and watchdog are gone.

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
  vector_bucket        = "cf-test-vectors-123456789012"
  vector_index         = "clips"
  vector_index_arn     = "arn:aws:s3vectors:eu-north-1:123456789012:bucket/cf-test-vectors-123456789012/index/clips"
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
      TABLE_NAME        = "cf-test-data"
      MEDIA_BUCKET      = "cf-test-media"
      AGENT_RUNTIME_ARN = "arn:aws:bedrock-agentcore:eu-north-1:123456789012:runtime/cf_test_clip_agent-abc"
      JOB_FLOW_ARN      = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-job-flow:live"
      CLIP_FLOW_ARN     = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-clip-flow:live"
      VECTOR_BUCKET     = "cf-test-vectors-123456789012"
      VECTOR_INDEX      = "clips"
      APP_URL           = "https://app.example.test"
      VERSION           = "test"
    })
    error_message = "cf-prod-api environment must match docs/CONTRACTS.md §9 (no PUBLISH_QUEUE_URL, PERF_CHECK_FUNCTION_ARN, SCHEDULER_ROLE_ARN or SCHEDULE_GROUP)."
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
