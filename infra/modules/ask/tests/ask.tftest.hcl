# Offline plan test (mock AWS provider, no credentials, no AWS calls):
#   cd infra/modules/ask && terraform init -backend=false && terraform test
#
# docs/CONTRACTS.md §27.12: cf-prod-ask is one arm64 function on the shared zip, started only asynchronously and never
# retried, with exactly the permissions it calls: the two Ask models on Bedrock Mantle (by the bedrock-mantle:Model
# condition), the question's files under ask/ (read and delete), skill files (read), the owner's items (no Put or
# Delete), PostToConnection on the live stage and the search key (read).

mock_provider "aws" {
  override_during = plan

  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:eu-north-1:123456789012:log-group:/aws/lambda/cf-test-ask" }
  }
}

variables {
  name                  = "cf-test"
  region                = "eu-north-1"
  account_id            = "123456789012"
  lambda_zip_path       = "main.tf"
  table_name            = "cf-test-data"
  table_arn             = "arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data"
  media_bucket          = "cf-test-media"
  media_bucket_arn      = "arn:aws:s3:::cf-test-media"
  ws_endpoint           = "https://ws123.execute-api.eu-north-1.amazonaws.com/live"
  ws_connections_arn    = "arn:aws:execute-api:eu-north-1:123456789012:ws123/live/POST/@connections/*"
  ask_model_id          = "anthropic.claude-opus-5-5"
  ask_fallback_model_id = "anthropic.claude-opus-4-8"
  search_secret_name    = "cf-test/ask/search-key"
  search_secret_arn     = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/ask/search-key-??????"
  help_enabled          = true
}

run "function_and_async_config" {
  command = plan

  assert {
    condition = (aws_lambda_function.ask.function_name == "cf-test-ask" && aws_lambda_function.ask.runtime == "python3.13" &&
      one(aws_lambda_function.ask.architectures) == "arm64" && aws_lambda_function.ask.handler == "clipfactory_api.ask.worker.handler" &&
    aws_lambda_function.ask.timeout == 150 && aws_lambda_function.ask.memory_size == 1024)
    error_message = "cf-test-ask: python3.13 on arm64, clipfactory_api.ask.worker.handler, 150 s, 1024 MB."
  }

  assert {
    condition     = aws_lambda_function_event_invoke_config.ask.maximum_retry_attempts == 0 && aws_lambda_function_event_invoke_config.ask.maximum_event_age_in_seconds == 60
    error_message = "An answer never runs twice: async retries 0, events older than 60 s dropped."
  }

  assert {
    condition     = aws_lambda_function.ask.reserved_concurrent_executions == null || aws_lambda_function.ask.reserved_concurrent_executions == -1
    error_message = "No reserved concurrency (this account cannot reserve any)."
  }

  assert {
    condition = one(aws_lambda_function.ask.environment).variables == tomap({
      TABLE_NAME            = "cf-test-data"
      MEDIA_BUCKET          = "cf-test-media"
      WS_ENDPOINT           = "https://ws123.execute-api.eu-north-1.amazonaws.com/live"
      ASK_MODEL_ID          = "anthropic.claude-opus-5-5"
      ASK_FALLBACK_MODEL_ID = "anthropic.claude-opus-4-8"
      ASK_REGION            = "eu-north-1"
      ASK_EFFORT            = "medium"
      ASK_EAGER_TOOLS       = "true"
      ASK_SEARCH_SECRET     = "cf-test/ask/search-key"
      HELP_ENABLED          = "true"
    })
    error_message = "The worker's environment is exactly the contract's (§27.12)."
  }

  assert {
    condition     = output.ask_function_arn == "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-ask"
    error_message = "cf-prod-api gets the unqualified ARN."
  }
}

run "least_privilege" {
  command = plan

  assert {
    condition = jsondecode(aws_iam_role_policy.ask.policy).Statement == [
      { Sid = "Logs", Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "arn:aws:logs:eu-north-1:123456789012:log-group:/aws/lambda/cf-test-ask:*" },
      { Sid = "Tracing", Effect = "Allow", Action = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"], Resource = "*" },
      {
        Sid       = "AskModel"
        Effect    = "Allow"
        Action    = ["bedrock-mantle:CreateInference"]
        Resource  = ["arn:aws:bedrock-mantle:eu-north-1:123456789012:project/*"]
        Condition = { StringEquals = { "bedrock-mantle:Model" = ["anthropic.claude-opus-5-5", "anthropic.claude-opus-4-8"] } }
      },
      { Sid = "AskFiles", Effect = "Allow", Action = ["s3:GetObject", "s3:DeleteObject"], Resource = ["arn:aws:s3:::cf-test-media/ask/*"] },
      { Sid = "SkillFiles", Effect = "Allow", Action = ["s3:GetObject"], Resource = ["arn:aws:s3:::cf-test-media/skills/*"] },
      { Sid = "Data", Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:Query"], Resource = ["arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data", "arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data/index/*"] },
      { Sid = "Stream", Effect = "Allow", Action = ["execute-api:ManageConnections"], Resource = ["arn:aws:execute-api:eu-north-1:123456789012:ws123/live/POST/@connections/*"] },
      { Sid = "SearchKey", Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = ["arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/ask/search-key-??????"] },
    ]
    error_message = "cf-prod-ask has exactly the contract's permissions: no bedrock:*, no bearer token, no Put or Delete on the table."
  }

  assert {
    condition     = !strcontains(aws_iam_role_policy.ask.policy, "bedrock:") && !strcontains(aws_iam_role_policy.ask.policy, "CallWithBearerToken") && !strcontains(aws_iam_role_policy.ask.policy, "DeleteItem")
    error_message = "No bedrock:*, no CallWithBearerToken, no DeleteItem."
  }
}

run "bare_model_ids_only" {
  command = plan
  variables {
    ask_model_id = "eu.anthropic.claude-opus-5-5"
  }
  expect_failures = [var.ask_model_id]
}
