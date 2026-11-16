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
      "api", "job-flow", "clip-flow", "ws", "broadcast", "hooks", "stats", "learn",
    ])
    error_message = "Every function except the WebSocket authorizer is watched for errors."
  }
}

# docs/CONTRACTS.md §16.9 and §10: the stats tick comes from config/platforms.json, the API knows both new
# functions, the table has gsi2 and the broadcaster passes WEEK# items.
run "clip_performance_is_wired" {
  command = plan

  assert {
    condition = (output.stats_function_name == "cf-prod-stats" && output.learn_function_name == "cf-prod-learn" &&
    output.stats_rule_name == "cf-prod-stats" && output.stats_tick_minutes == 15)
    error_message = "§10 outputs: stats_function_name cf-prod-stats, learn_function_name cf-prod-learn, stats_rule_name cf-prod-stats, stats_tick_minutes 15."
  }

  assert {
    condition     = module.stats.stats_tick_minutes == min([for p in values(jsondecode(file("../../../config/platforms.json")).platforms) : p.minIntervalMinutes]...)
    error_message = "The tick is the lowest minIntervalMinutes in config/platforms.json."
  }

  assert {
    condition = (module.stats.stats_function_arn == "arn:aws:lambda:eu-north-1:123456789012:function:cf-prod-stats" &&
    module.stats.learn_function_arn == "arn:aws:lambda:eu-north-1:123456789012:function:cf-prod-learn")
    error_message = "cf-prod-api gets the unqualified ARNs of cf-prod-stats and cf-prod-learn."
  }

  assert {
    condition     = toset(keys(module.monitoring.schedule_alarm_names)) == toset(["stats"])
    error_message = "The stats rule is watched for failed invocations."
  }
}

# docs/CONTRACTS.md §17.9 and §17.12: Set up posting. The callback base is {hooks_url}/oauth (config.json
# oauthCallbackBase) and the secret names the modules share come from the hooks module (per-module tests check each
# role and environment).
run "posting_setup_is_wired" {
  command = plan

  override_resource {
    target          = module.hooks.aws_api_gateway_stage.v1
    override_during = plan
    values          = { invoke_url = "https://rest123.execute-api.eu-north-1.amazonaws.com/v1" }
  }

  assert {
    condition     = output.oauth_callback_base == "https://rest123.execute-api.eu-north-1.amazonaws.com/v1/oauth" && endswith(output.oauth_callback_base, "/oauth")
    error_message = "oauth_callback_base must be {hooks_url}/oauth."
  }

  assert {
    condition     = module.hooks.platform_secrets_arn == "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-prod/platforms/*" && module.hooks.secret_prefix == "cf-prod/platforms/"
    error_message = "Platform keys and tokens live under cf-prod/platforms/ (§17.4)."
  }

  assert {
    condition     = module.hooks.platform_token_secrets_arn == "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-prod/platforms/*/token-*"
    error_message = "clip-flow and stats may only write the cf-prod/platforms/{platform}/token secrets."
  }

  assert {
    condition     = module.hooks.oauth_state_secret_name == "cf-prod/oauth/state-key"
    error_message = "The OAuth state key is cf-prod/oauth/state-key."
  }
}
