# Offline plan test (mock AWS provider, no credentials, no AWS calls):
#   cd infra/modules/flows && terraform init -backend=false && terraform test
#
# docs/CONTRACTS.md §14.4, §14.5 and §14.12: both flows are durable functions with a published version and an alias
# `live`, the agreed execution timeouts and retention, a 60-minute delete timeout, no Lambda destinations, and roles
# that allow exactly what the code calls.

mock_provider "aws" {
  override_during = plan

  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:eu-north-1:123456789012:log-group:cf-test" }
  }
}

variables {
  name = "cf-test"
  # Any existing file: the module only hashes it.
  lambda_zip_path   = "main.tf"
  table_name        = "cf-test-data"
  table_arn         = "arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data"
  media_bucket      = "cf-test-media"
  media_bucket_arn  = "arn:aws:s3:::cf-test-media"
  agent_runtime_arn = "arn:aws:bedrock-agentcore:eu-north-1:123456789012:runtime/cf_test_clip_agent-abc"
  model_id          = "global.anthropic.claude-fable-5-1"
  model_invoke_arns = ["arn:aws:bedrock:eu-north-1:123456789012:inference-profile/global.anthropic.claude-fable-5-1", "arn:aws:bedrock:*::foundation-model/anthropic.claude-fable-5-1"]
  embed_model_id    = "amazon.titan-embed-text-v2:0"
  embed_model_arn   = "arn:aws:bedrock:eu-north-1::foundation-model/amazon.titan-embed-text-v2:0"
  vector_bucket     = "cf-test-vectors-123456789012"
  vector_index      = "clips"
  vector_index_arn  = "arn:aws:s3vectors:eu-north-1:123456789012:bucket/cf-test-vectors-123456789012/index/clips"
}

run "both_flows_are_durable_with_alias_live" {
  command = plan

  assert {
    condition     = alltrue([for f in aws_lambda_function.fn : f.publish])
    error_message = "Both flows need publish = true so the alias points at a numbered version, not $LATEST."
  }

  assert {
    condition     = alltrue([for a in aws_lambda_alias.live : a.name == "live"])
    error_message = "Both flows need an alias named live."
  }

  assert {
    condition     = one(aws_lambda_function.fn["job-flow"].durable_config).execution_timeout == 30600
    error_message = "job-flow execution_timeout must be 30600 s (8 h callback + start and finish)."
  }

  assert {
    condition     = one(aws_lambda_function.fn["clip-flow"].durable_config).execution_timeout == 259200
    error_message = "clip-flow execution_timeout must be 259200 s (48 h wait + publish, metrics, distil)."
  }

  assert {
    condition     = alltrue([for f in aws_lambda_function.fn : one(f.durable_config).retention_period == 14])
    error_message = "Durable executions must be kept 14 days."
  }

  assert {
    condition     = alltrue([for f in aws_lambda_function.fn : f.timeouts.delete == "60m"])
    error_message = "Deleting a durable function can take up to an hour: timeouts.delete must be 60m."
  }

  assert {
    condition     = alltrue([for f in aws_lambda_function.fn : f.runtime == "python3.13" && one(f.architectures) == "arm64"])
    error_message = "The flows run python3.13 on arm64 like every other function."
  }

  assert {
    condition     = aws_lambda_function.fn["job-flow"].function_name == "cf-test-job-flow" && aws_lambda_function.fn["clip-flow"].function_name == "cf-test-clip-flow"
    error_message = "Function names must be <name>-job-flow and <name>-clip-flow."
  }

  assert {
    condition     = aws_lambda_function.fn["job-flow"].handler == "clipfactory_api.flows.job_flow.handler" && aws_lambda_function.fn["clip-flow"].handler == "clipfactory_api.flows.clip_flow.handler"
    error_message = "Handlers must match docs/CONTRACTS.md §9."
  }

  assert {
    condition = (aws_lambda_function.fn["job-flow"].memory_size == 256 && aws_lambda_function.fn["job-flow"].timeout == 120 &&
    aws_lambda_function.fn["clip-flow"].memory_size == 512 && aws_lambda_function.fn["clip-flow"].timeout == 900)
    error_message = "job-flow is 256 MB / 120 s, clip-flow 512 MB / 900 s."
  }
}

run "environment_matches_the_contract" {
  command = plan

  assert {
    condition     = toset(keys(one(aws_lambda_function.fn["job-flow"].environment).variables)) == toset(["AGENT_RUNTIME_ARN", "TABLE_NAME"])
    error_message = "job-flow gets exactly TABLE_NAME and AGENT_RUNTIME_ARN."
  }

  assert {
    condition     = toset(keys(one(aws_lambda_function.fn["clip-flow"].environment).variables)) == toset(["EMBED_MODEL_ID", "MEDIA_BUCKET", "MODEL_ID", "TABLE_NAME", "VECTOR_BUCKET", "VECTOR_INDEX"])
    error_message = "clip-flow gets exactly TABLE_NAME, MEDIA_BUCKET, MODEL_ID, EMBED_MODEL_ID, VECTOR_BUCKET and VECTOR_INDEX."
  }

  assert {
    condition     = one(aws_lambda_function.fn["clip-flow"].environment).variables["MODEL_ID"] == "global.anthropic.claude-fable-5-1"
    error_message = "clip-flow distils through the global Fable profile."
  }
}

run "roles_allow_exactly_what_the_code_calls" {
  command = plan

  assert {
    condition     = alltrue([for a in aws_iam_role_policy_attachment.durable : a.policy_arn == "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicDurableExecutionRolePolicy"])
    error_message = "Both roles need AWSLambdaBasicDurableExecutionRolePolicy (checkpoints and state)."
  }

  assert {
    condition = toset(flatten([for s in jsondecode(aws_iam_role_policy.fn["job-flow"].policy).Statement : s.Action])) == toset([
      "logs:CreateLogStream", "logs:PutLogEvents", "xray:PutTraceSegments", "xray:PutTelemetryRecords",
      "dynamodb:GetItem", "dynamodb:UpdateItem",
      "bedrock-agentcore:InvokeAgentRuntime", "bedrock-agentcore:StopRuntimeSession",
    ])
    error_message = "job-flow may only read/update the job, start and stop the agent, log and trace."
  }

  assert {
    condition = toset(flatten([for s in jsondecode(aws_iam_role_policy.fn["clip-flow"].policy).Statement : s.Action])) == toset([
      "logs:CreateLogStream", "logs:PutLogEvents", "xray:PutTraceSegments", "xray:PutTelemetryRecords",
      "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:BatchGetItem",
      "dynamodb:TransactWriteItems", "dynamodb:ConditionCheckItem",
      "s3:GetObject", "bedrock:InvokeModel", "s3vectors:GetVectors", "s3vectors:PutVectors",
    ])
    error_message = "clip-flow's actions must match docs/CONTRACTS.md §14.5."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["clip-flow"].policy).Statement :
      s.Sid == "Vectors" && s.Resource == ["arn:aws:s3vectors:eu-north-1:123456789012:bucket/cf-test-vectors-123456789012/index/clips"]
    ])
    error_message = "S3 Vectors access must be limited to the clips index."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["clip-flow"].policy).Statement :
      s.Sid == "Models" && contains(s.Resource, "arn:aws:bedrock:eu-north-1::foundation-model/amazon.titan-embed-text-v2:0") &&
      contains(s.Resource, "arn:aws:bedrock:*::foundation-model/anthropic.claude-fable-5-1")
    ])
    error_message = "clip-flow must reach Fable (distil) and Titan (embeddings)."
  }

  assert {
    condition = alltrue(flatten([
      for k, p in aws_iam_role_policy.fn : [
        for s in jsondecode(p.policy).Statement : [
          for a in s.Action : !startswith(a, "sqs:") && !startswith(a, "scheduler:") && a != "iam:PassRole" && a != "dynamodb:Scan"
        ]
      ]
    ]))
    error_message = "No queue, scheduler, PassRole or Scan permissions remain: durable execution replaces them."
  }
}

run "alias_arns_are_the_outputs" {
  command = plan

  override_resource {
    target          = aws_lambda_alias.live["job-flow"]
    override_during = plan
    values          = { arn = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-job-flow:live" }
  }

  override_resource {
    target          = aws_lambda_alias.live["clip-flow"]
    override_during = plan
    values          = { arn = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-clip-flow:live" }
  }

  assert {
    condition     = endswith(output.job_flow_alias_arn, ":cf-test-job-flow:live") && endswith(output.clip_flow_alias_arn, ":cf-test-clip-flow:live")
    error_message = "The alias ARN outputs must end in :live."
  }

  assert {
    condition     = output.durable_function_names == { job-flow = "cf-test-job-flow", clip-flow = "cf-test-clip-flow" }
    error_message = "durable_function_names must name both flows."
  }
}
