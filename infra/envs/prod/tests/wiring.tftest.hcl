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
      "api", "job-flow", "clip-flow", "ws", "broadcast", "hooks", "stats", "learn", "follow-tick", "money", "ask",
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
    condition     = toset(keys(module.monitoring.schedule_alarm_names)) == toset(["stats", "follow-tick", "money"])
    error_message = "The stats, follow-tick and money rules are watched for failed invocations."
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

# docs/CONTRACTS.md §19.5 and §19.9: Ask Clip Factory is on in prod, calls Claude Haiku through the EU geo profile
# (per-model profilePrefix override in config/models.json) and may invoke only that profile and its six EU models.
run "help_assistant_is_wired" {
  command = plan

  assert {
    condition     = local.help_model.modelId == "anthropic.claude-haiku-5-5" && local.models.helpModel == "haiku-5-5" && local.agent_model.modelId == "anthropic.claude-fable-5-1"
    error_message = "config/models.json parses, helpModel points at the Haiku 5.5 entry and agentModel still at Fable."
  }

  assert {
    condition     = local.help_model_id == "eu.anthropic.claude-haiku-5-5" && local.model_id == "global.anthropic.claude-fable-5-1"
    error_message = "Haiku uses its own eu. profilePrefix; Fable keeps the top-level global. prefix."
  }

  assert {
    condition = toset(local.help_model_invoke_arns) == toset([
      "arn:aws:bedrock:eu-north-1:123456789012:inference-profile/eu.anthropic.claude-haiku-5-5",
      "arn:aws:bedrock:eu-central-1::foundation-model/anthropic.claude-haiku-5-5",
      "arn:aws:bedrock:eu-north-1::foundation-model/anthropic.claude-haiku-5-5",
      "arn:aws:bedrock:eu-south-1::foundation-model/anthropic.claude-haiku-5-5",
      "arn:aws:bedrock:eu-south-2::foundation-model/anthropic.claude-haiku-5-5",
      "arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-haiku-5-5",
      "arn:aws:bedrock:eu-west-3::foundation-model/anthropic.claude-haiku-5-5",
    ]) && length(local.help_model_invoke_arns) == 7
    error_message = "The help model may be invoked only on the EU profile and the foundation model in its six destination regions."
  }

  assert {
    condition     = module.monitoring.help_alarm_name == "cf-prod-help-model-failures"
    error_message = "The help model failures alarm cf-prod-help-model-failures exists in prod."
  }

  assert {
    condition     = var.help_enabled == true && var.help_monthly_cap == 2000
    error_message = "Ask Clip Factory is on in prod (HELP_ENABLED true) with a 2000-answer model cap per 30 days."
  }
}

# docs/DECISIONS.md ADR-40: the deep analysis's second watcher is Amazon Nova 2 Lite through the EU geo profile, read
# from config/models.json like the other models, and the agent may invoke only that profile and its six EU models.
run "deep_analysis_watch_model_is_wired" {
  command = plan

  assert {
    condition     = local.models.watchModel == "nova-2-lite" && local.watch_model.modelId == "amazon.nova-2-lite-v1:0"
    error_message = "config/models.json's watchModel points at the Nova 2 Lite entry."
  }

  assert {
    condition     = local.watch_model_id == "eu.amazon.nova-2-lite-v1:0"
    error_message = "Nova 2 Lite uses its own eu. profilePrefix (it is not callable In-Region from eu-north-1)."
  }

  assert {
    condition = toset(local.watch_model_invoke_arns) == toset([
      "arn:aws:bedrock:eu-north-1:123456789012:inference-profile/eu.amazon.nova-2-lite-v1:0",
      "arn:aws:bedrock:eu-central-1::foundation-model/amazon.nova-2-lite-v1:0",
      "arn:aws:bedrock:eu-north-1::foundation-model/amazon.nova-2-lite-v1:0",
      "arn:aws:bedrock:eu-south-1::foundation-model/amazon.nova-2-lite-v1:0",
      "arn:aws:bedrock:eu-south-2::foundation-model/amazon.nova-2-lite-v1:0",
      "arn:aws:bedrock:eu-west-1::foundation-model/amazon.nova-2-lite-v1:0",
      "arn:aws:bedrock:eu-west-3::foundation-model/amazon.nova-2-lite-v1:0",
    ]) && length(local.watch_model_invoke_arns) == 7
    error_message = "The watch model may be invoked only on the EU profile and the foundation model in its six destination regions."
  }
}

# docs/DECISIONS.md ADR-42: the owner picks the model for clip jobs from clipModels in config/models.json. The agent
# may call every one of them (each profile here, the foundation model in any region for a global profile, in the six
# listed EU regions for Haiku's geo profile); CF_MODEL_ID stays the default, Fable 5.1.
run "clip_models_are_wired" {
  command = plan

  assert {
    condition     = local.models.clipModels == ["fable-5-2", "fable-5-1", "opus-5-5", "sonnet-5-5", "haiku-5-5"] && local.models.agentModel == "fable-5-1"
    error_message = "clipModels lists the owner's five choices in display order, and the default stays Fable 5.1."
  }

  assert {
    condition = local.clip_model_ids == {
      "fable-5-2"  = "global.anthropic.claude-fable-5-2"
      "fable-5-1"  = "global.anthropic.claude-fable-5-1"
      "opus-5-5"   = "global.anthropic.claude-opus-5-5"
      "sonnet-5-5" = "global.anthropic.claude-sonnet-5-5"
      "haiku-5-5"  = "eu.anthropic.claude-haiku-5-5"
    }
    error_message = "Each clip model goes through its profile: global for Fable, Opus and Sonnet, eu for Haiku."
  }

  assert {
    condition = toset(local.clip_model_invoke_arns) == toset([
      "arn:aws:bedrock:eu-north-1:123456789012:inference-profile/global.anthropic.claude-fable-5-2",
      "arn:aws:bedrock:eu-north-1:123456789012:inference-profile/global.anthropic.claude-fable-5-1",
      "arn:aws:bedrock:eu-north-1:123456789012:inference-profile/global.anthropic.claude-opus-5-5",
      "arn:aws:bedrock:eu-north-1:123456789012:inference-profile/global.anthropic.claude-sonnet-5-5",
      "arn:aws:bedrock:eu-north-1:123456789012:inference-profile/eu.anthropic.claude-haiku-5-5",
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-fable-5-2",
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-fable-5-1",
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-opus-5-5",
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-5-5",
      "arn:aws:bedrock:eu-central-1::foundation-model/anthropic.claude-haiku-5-5",
      "arn:aws:bedrock:eu-north-1::foundation-model/anthropic.claude-haiku-5-5",
      "arn:aws:bedrock:eu-south-1::foundation-model/anthropic.claude-haiku-5-5",
      "arn:aws:bedrock:eu-south-2::foundation-model/anthropic.claude-haiku-5-5",
      "arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-haiku-5-5",
      "arn:aws:bedrock:eu-west-3::foundation-model/anthropic.claude-haiku-5-5",
    ]) && length(local.clip_model_invoke_arns) == 15
    error_message = "The agent may call exactly the five clip models' profiles and their foundation models."
  }

  assert {
    condition     = length(local.clip_model_profile_arns) == 5 && local.model_id == "global.anthropic.claude-fable-5-1"
    error_message = "ReadProfile gets the five clip model profiles; CF_MODEL_ID stays the Fable 5.1 default."
  }
}

# §24.3 Follow creators: the tick gets the hooks URL (Twitch's webhook callback) and is watched like every function.
run "follow_creators_is_wired" {
  command = plan

  assert {
    condition     = module.stats.follow_tick_function_arn == "arn:aws:lambda:eu-north-1:123456789012:function:cf-prod-follow-tick"
    error_message = "The follow tick is cf-prod-follow-tick."
  }

  assert {
    condition     = module.monitoring.schedule_alarm_names["follow-tick"] == "cf-prod-follow-tick-failed-invocations"
    error_message = "The follow rule is watched for failed invocations."
  }
}

# docs/CONTRACTS.md §27.1 and §27.12: Ask as a full assistant. Claude Opus 5.5 with Opus 4.8 as the refusal fallback,
# bare Mantle ids in-Region in Stockholm, cf-prod-api starts cf-prod-ask, and the media bucket gets the ask-1-day rule
# next to the existing ones (an in-place update; the bucket keeps prevent_destroy).
run "ask_assistant_is_wired" {
  command = plan

  assert {
    condition = (local.ask_model_id == "anthropic.claude-opus-5-5" && local.ask_fallback_model_id == "anthropic.claude-opus-4-8" &&
    local.ask_region == "eu-north-1" && !contains(local.models.clipModels, "opus-4-8"))
    error_message = "Ask uses the bare Opus 5.5 id (fallback Opus 4.8) in eu-north-1; Opus 4.8 is not a clip model."
  }

  assert {
    condition = (one(module.ask.function_names["ask"] == "cf-prod-ask" ? ["ok"] : []) == "ok" &&
    module.ask.ask_function_arn == "arn:aws:lambda:eu-north-1:123456789012:function:cf-prod-ask")
    error_message = "cf-prod-ask exists and cf-prod-api gets its unqualified ARN."
  }

  assert {
    condition     = toset([for r in module.storage.media_lifecycle_rule_ids : r]) == toset(["uploads-14-days", "job-sources-14-days", "ask-1-day", "abort-incomplete-uploads"])
    error_message = "The media bucket keeps its rules and gains ask-1-day."
  }
}
