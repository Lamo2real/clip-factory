# Offline plan of the whole production stack (mock AWS provider, no credentials, no AWS calls; the backend is not
# used and plan never builds the agent image):
#   cd infra/envs/prod && terraform init -backend=false && terraform test
#
# Proves the modules wire together without cycles and that every output deploy.yml reads (docs/CONTRACTS.md §10)
# exists, with the model ids coming from config/models.json.

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
}

variables {
  owner_email     = "owner@example.test"
  agent_image_tag = "test"
  # Any existing file: the stack only hashes it.
  lambda_zip_path = "main.tf"
}

run "whole_stack_plans" {
  command = plan

  assert {
    condition     = output.region == "eu-north-1"
    error_message = "The stack stays in eu-north-1."
  }

  assert {
    condition     = output.vector_index == "clips"
    error_message = "vector_index must be clips."
  }

  assert {
    condition     = output.vector_bucket == "cf-prod-vectors-123456789012"
    error_message = "vector_bucket must be cf-prod-vectors-<accountId>."
  }

  assert {
    condition     = local.model_id == "global.anthropic.claude-fable-5-1" && local.embed_model_arn == "arn:aws:bedrock:eu-north-1::foundation-model/amazon.titan-embed-text-v2:0" && local.embed_dimensions == 1024
    error_message = "Model ids come from config/models.json: Fable through the global profile, Titan V2 in-Region at 1024 dimensions."
  }

  assert {
    condition = toset(keys(module.monitoring.alarm_names)) == toset([
      "api", "job-flow", "clip-flow", "ws", "broadcast", "hooks",
    ])
    error_message = "Every function except the WebSocket authorizer is watched for errors."
  }
}
