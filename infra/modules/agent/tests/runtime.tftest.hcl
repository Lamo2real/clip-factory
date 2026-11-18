# Offline plan test (mock AWS provider, no credentials, no AWS calls; plan never runs the image push):
#   cd infra/modules/agent && terraform init -backend=false && terraform test
#
# docs/CONTRACTS.md §8 and §14.4/§14.6: the agent ends the job's durable execution with a callback, writes and
# queries clip vectors and embeds clip text with Titan, so its environment and role must allow exactly that.

mock_provider "aws" {
  override_during = plan

  mock_resource "aws_bedrockagentcore_agent_runtime" {
    defaults = {
      agent_runtime_id  = "cf_test_clip_agent-AbCdEf1234"
      agent_runtime_arn = "arn:aws:bedrock-agentcore:eu-north-1:123456789012:runtime/cf_test_clip_agent-AbCdEf1234"
    }
  }

  mock_resource "aws_ecr_repository" {
    defaults = {
      arn            = "arn:aws:ecr:eu-north-1:123456789012:repository/cf-test-agent"
      repository_url = "123456789012.dkr.ecr.eu-north-1.amazonaws.com/cf-test-agent"
    }
  }
}

variables {
  name              = "cf-test"
  region            = "eu-north-1"
  account_id        = "123456789012"
  image_tag         = "test"
  table_name        = "cf-test-data"
  table_arn         = "arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data"
  media_bucket      = "cf-test-media"
  media_bucket_arn  = "arn:aws:s3:::cf-test-media"
  model_id          = "global.anthropic.claude-fable-5-1"
  model_profile_arn = "arn:aws:bedrock:eu-north-1:123456789012:inference-profile/global.anthropic.claude-fable-5-1"
  model_invoke_arns = ["arn:aws:bedrock:eu-north-1:123456789012:inference-profile/global.anthropic.claude-fable-5-1", "arn:aws:bedrock:*::foundation-model/anthropic.claude-fable-5-1"]
  vector_bucket     = "cf-test-vectors-123456789012"
  vector_index      = "clips"
  vector_index_arn  = "arn:aws:s3vectors:eu-north-1:123456789012:bucket/cf-test-vectors-123456789012/index/clips"
  embed_model_id    = "amazon.titan-embed-text-v2:0"
  embed_model_arn   = "arn:aws:bedrock:eu-north-1::foundation-model/amazon.titan-embed-text-v2:0"
  watch_model_id    = "eu.amazon.nova-2-lite-v1:0"
  watch_model_invoke_arns = [
    "arn:aws:bedrock:eu-north-1:123456789012:inference-profile/eu.amazon.nova-2-lite-v1:0",
    "arn:aws:bedrock:eu-central-1::foundation-model/amazon.nova-2-lite-v1:0",
    "arn:aws:bedrock:eu-north-1::foundation-model/amazon.nova-2-lite-v1:0",
    "arn:aws:bedrock:eu-south-1::foundation-model/amazon.nova-2-lite-v1:0",
    "arn:aws:bedrock:eu-south-2::foundation-model/amazon.nova-2-lite-v1:0",
    "arn:aws:bedrock:eu-west-1::foundation-model/amazon.nova-2-lite-v1:0",
    "arn:aws:bedrock:eu-west-3::foundation-model/amazon.nova-2-lite-v1:0",
  ]
}

run "environment_has_vectors_and_embeddings" {
  command = plan

  assert {
    condition = (aws_bedrockagentcore_agent_runtime.agent.environment_variables["CF_VECTOR_BUCKET"] == "cf-test-vectors-123456789012" &&
      aws_bedrockagentcore_agent_runtime.agent.environment_variables["CF_VECTOR_INDEX"] == "clips" &&
    aws_bedrockagentcore_agent_runtime.agent.environment_variables["CF_EMBED_MODEL_ID"] == "amazon.titan-embed-text-v2:0")
    error_message = "The agent needs CF_VECTOR_BUCKET, CF_VECTOR_INDEX and CF_EMBED_MODEL_ID."
  }

  assert {
    condition     = aws_bedrockagentcore_agent_runtime.agent.environment_variables["CF_MODEL_ID"] == "global.anthropic.claude-fable-5-1" && aws_bedrockagentcore_agent_runtime.agent.environment_variables["ANTHROPIC_MODEL"] == "global.anthropic.claude-fable-5-1"
    error_message = "The agent calls Fable through the global profile."
  }
}

run "role_allows_callbacks_vectors_and_titan" {
  command = plan

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement :
      s.Sid == "JobFlowCallback" && toset(s.Action) == toset([
        "lambda:SendDurableExecutionCallbackSuccess", "lambda:SendDurableExecutionCallbackFailure", "lambda:SendDurableExecutionCallbackHeartbeat",
      ]) && s.Resource == "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-job-flow:*"
    ])
    error_message = "The agent must be able to send job-flow callbacks (success, failure, heartbeat), and only to job-flow."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement :
      s.Sid == "ClipVectors" && toset(s.Action) == toset(["s3vectors:PutVectors", "s3vectors:QueryVectors", "s3vectors:GetVectors"]) &&
      s.Resource == "arn:aws:s3vectors:eu-north-1:123456789012:bucket/cf-test-vectors-123456789012/index/clips"
    ])
    error_message = "The agent needs PutVectors, QueryVectors and GetVectors on the clips index only."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement :
      s.Sid == "Embeddings" && s.Action == ["bedrock:InvokeModel"] && s.Resource == "arn:aws:bedrock:eu-north-1::foundation-model/amazon.titan-embed-text-v2:0"
    ])
    error_message = "The agent may invoke Titan Text Embeddings V2 in-Region."
  }

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement : [
        for a in flatten([s.Action]) : !contains(["s3vectors:DeleteVectors", "lambda:InvokeFunction"], a)
      ]
    ]))
    error_message = "The agent never deletes vectors or invokes Lambdas."
  }
}

run "runtime_logs_expire" {
  command = plan

  assert {
    condition     = terraform_data.runtime_logs.input.log_group == "/aws/bedrock-agentcore/runtimes/cf_test_clip_agent-AbCdEf1234-DEFAULT"
    error_message = "Terraform owns the runtime's log group /aws/bedrock-agentcore/runtimes/<runtime id>-DEFAULT."
  }

  assert {
    condition     = terraform_data.runtime_logs.input.retention_days == 30 && output.log_group_name == terraform_data.runtime_logs.input.log_group
    error_message = "The runtime's logs are kept 30 days, like every other log group (never forever)."
  }
}

run "runtime_logs_follow_the_retention" {
  command = plan

  variables {
    log_retention_days = 14
  }

  assert {
    condition     = terraform_data.runtime_logs.input.retention_days == 14
    error_message = "log_retention_days sets the runtime's log retention."
  }
}

run "role_carries_the_permissions_boundary" {
  command = plan

  variables {
    permissions_boundary_arn = "arn:aws:iam::123456789012:policy/cf-prod-role-boundary"
  }

  assert {
    condition     = aws_iam_role.agent.permissions_boundary == "arn:aws:iam::123456789012:policy/cf-prod-role-boundary"
    error_message = "The agent role carries the deploy role's permissions boundary (infra/bootstrap)."
  }
}

# "Watch the video" (docs/DECISIONS.md ADR-40): the deep analysis is on by default, the second watcher is Nova 2 Lite
# through the EU profile, and no other AWS service is added.
run "deep_analysis_environment" {
  command = plan

  assert {
    condition     = aws_bedrockagentcore_agent_runtime.agent.environment_variables["CF_WATCH_MODEL_ID"] == "eu.amazon.nova-2-lite-v1:0"
    error_message = "The agent needs CF_WATCH_MODEL_ID (the second watcher)."
  }

  assert {
    condition     = aws_bedrockagentcore_agent_runtime.agent.environment_variables["CF_DEEP"] == "on"
    error_message = "The deep analysis is on by default (CF_DEEP=on)."
  }
}

run "deep_analysis_can_be_switched_off" {
  command = plan

  variables {
    deep_analysis_enabled = false
  }

  assert {
    condition     = aws_bedrockagentcore_agent_runtime.agent.environment_variables["CF_DEEP"] == "off"
    error_message = "deep_analysis_enabled = false sets CF_DEEP=off."
  }
}

run "role_allows_the_watch_model_and_nothing_else_new" {
  command = plan

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement :
      s.Sid == "InvokeWatchModel" && s.Effect == "Allow" && s.Action == ["bedrock:InvokeModel"] &&
      toset(s.Resource) == toset(var.watch_model_invoke_arns) && length(s.Resource) == length(var.watch_model_invoke_arns)
    ])
    error_message = "InvokeWatchModel must allow bedrock:InvokeModel on exactly var.watch_model_invoke_arns."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement :
      alltrue([for r in flatten([s.Resource]) : !strcontains(r, "*")]) if s.Sid == "InvokeWatchModel"
    ])
    error_message = "The watch model's resources carry no wildcard: the profile and the EU regions it routes to, by name."
  }

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement : [
        for a in flatten([s.Action]) :
        !startswith(lower(a), "rekognition:") && !startswith(lower(a), "comprehend:") && !startswith(lower(a), "mediaconvert:")
      ]
    ]))
    error_message = "The deep analysis adds no Rekognition, Comprehend or MediaConvert action (ADR-40: none has an eu-north-1 endpoint or a use here)."
  }

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement : [
        for a in flatten([s.Action]) : !startswith(lower(a), "states:") && !startswith(lower(a), "batch:")
      ]
    ]))
    error_message = "The fan-out stays inside the agent: no Step Functions or Batch action."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement :
      s.Sid == "InvokeFable" && toset(s.Resource) == toset(var.model_invoke_arns)
    ])
    error_message = "Fable, the main watcher, keeps exactly its existing statement."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement :
      s.Sid == "Transcribe" && toset(s.Action) == toset(["transcribe:StartTranscriptionJob", "transcribe:GetTranscriptionJob", "transcribe:DeleteTranscriptionJob"])
    ])
    error_message = "Speaker labels need no new Transcribe action."
  }
}

# docs/DECISIONS.md ADR-42: the owner's choice of model for clip jobs. Every clip model joins the existing InvokeFable
# and ReadProfile statements (same Sids, so the policy changes in place); the environment keeps the default model.
run "role_allows_every_clip_model" {
  command = plan

  variables {
    clip_model_profile_arns = [
      "arn:aws:bedrock:eu-north-1:123456789012:inference-profile/global.anthropic.claude-fable-5-1",
      "arn:aws:bedrock:eu-north-1:123456789012:inference-profile/global.anthropic.claude-opus-5-5",
      "arn:aws:bedrock:eu-north-1:123456789012:inference-profile/eu.anthropic.claude-haiku-5-5",
    ]
    clip_model_invoke_arns = [
      "arn:aws:bedrock:eu-north-1:123456789012:inference-profile/global.anthropic.claude-fable-5-1",
      "arn:aws:bedrock:eu-north-1:123456789012:inference-profile/global.anthropic.claude-opus-5-5",
      "arn:aws:bedrock:eu-north-1:123456789012:inference-profile/eu.anthropic.claude-haiku-5-5",
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-fable-5-1",
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-opus-5-5",
      "arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-haiku-5-5",
    ]
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement :
      s.Sid == "InvokeFable" && toset(s.Resource) == toset(concat(var.model_invoke_arns, var.clip_model_invoke_arns)) &&
      length(s.Resource) == 6 &&
      toset(s.Action) == toset(["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:Converse*"])
    ])
    error_message = "InvokeFable covers the default model and every clip model, without repeats."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement :
      s.Sid == "ReadProfile" && toset(s.Resource) == toset(var.clip_model_profile_arns) && length(s.Resource) == 3
    ])
    error_message = "ReadProfile covers the default profile and every clip model profile, without repeats."
  }

  assert {
    condition     = aws_bedrockagentcore_agent_runtime.agent.environment_variables["CF_MODEL_ID"] == "global.anthropic.claude-fable-5-1"
    error_message = "CF_MODEL_ID stays the default model; the owner's pick travels with each job."
  }
}
