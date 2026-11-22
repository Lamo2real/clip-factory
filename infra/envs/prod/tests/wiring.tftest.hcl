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

# Lamo Stories' Nova Reel bucket provider (us-east-1, §45.31): mocked too, so no plan ever configures a real provider.
mock_provider "aws" {
  alias = "us_east_1"
}

variables {
  owner_email     = "owner@example.test"
  agent_image_tag = "test"
  # §45.15: Lamo Stories' agent image tag (deploy.yml passes stories-agent-<hash>).
  stories_agent_image_tag = "stories-agent-test"
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
      "api", "job-flow", "clip-flow", "ws", "broadcast", "hooks", "stats", "learn", "follow-tick", "money", "ask", "notify",
      "campaigns", "story-flow", "stories-api", "autopost",
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

# docs/CONTRACTS.md §28.1 and §28.12: Ask as a full assistant. Claude Opus 5.5 with Opus 4.8 as the refusal fallback,
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

  assert {
    condition     = local.ask_search_secret_arn == "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-prod/ask/search-key-??????"
    error_message = "The search key permission covers exactly cf-prod/ask/search-key plus the 6-character suffix Secrets Manager adds (no trailing *)."
  }

  assert {
    condition     = local.youtube_proxy_secret_arn == "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-prod/agent/youtube-proxy-??????" && local.youtube_proxy_secret == "cf-prod/agent/youtube-proxy"
    error_message = "The YouTube proxy permission covers exactly cf-prod/agent/youtube-proxy plus the 6-character suffix (docs/CONTRACTS.md §29.8)."
  }
}

# docs/CONTRACTS.md §32: notifications. cf-prod-notify reads the stream next to cf-prod-broadcast and signs with the
# cf-prod/notify/vapid key (its errors alarm is checked in whole_stack_plans).
run "notifications_are_wired" {
  command = plan

  assert {
    condition     = module.notify.notify_function_name == "cf-prod-notify" && module.notify.vapid_secret_name == "cf-prod/notify/vapid"
    error_message = "cf-prod-notify and the cf-prod/notify/vapid secret exist."
  }
}

# docs/CONTRACTS.md §45.15, §45.24 and ADR-76: Lamo Stories is its own application. Its runtime cf_prod_story_agent,
# its API Lambda cf-prod-stories-api behind its own routes, and its publisher cf-prod-story-flow are wired; each is
# watched; the hooks forward targets Lamo Stories' own callback; its secrets live under cf-prod/workspaces/, which no
# Clip Factory pattern reaches and which reaches no Clip Factory token. Clip Factory's agent, cf-prod-api and
# config/models.json are not touched (their own tests and the deploy's scripted plan check). IAM patterns are checked
# as globs against sample ARNs: "*" becomes ".*" and "?" becomes "." in an anchored regex, dots escaped.
run "lamo_stories_is_wired" {
  command = plan

  override_resource {
    target          = module.flows.aws_lambda_alias.live["story-flow"]
    override_during = plan
    values          = { arn = "arn:aws:lambda:eu-north-1:123456789012:function:cf-prod-story-flow:live" }
  }

  override_resource {
    target          = module.stories_agent.aws_bedrockagentcore_agent_runtime.agent
    override_during = plan
    values = {
      agent_runtime_arn = "arn:aws:bedrock-agentcore:eu-north-1:123456789012:runtime/cf_prod_story_agent-AbCdEf1234"
      agent_runtime_id  = "cf_prod_story_agent-AbCdEf1234"
    }
  }

  # Known at plan here so the runtime's image (and so stories_agent_image_tag) is known too.
  override_resource {
    target          = module.stories_agent.aws_ecr_repository.agent
    override_during = plan
    values = {
      repository_url = "123456789012.dkr.ecr.eu-north-1.amazonaws.com/cf-prod-stories-agent"
      arn            = "arn:aws:ecr:eu-north-1:123456789012:repository/cf-prod-stories-agent"
    }
  }

  override_resource {
    target          = module.api.aws_apigatewayv2_api.http
    override_during = plan
    values = {
      api_endpoint  = "https://http123.execute-api.eu-north-1.amazonaws.com"
      execution_arn = "arn:aws:execute-api:eu-north-1:123456789012:http123"
    }
  }

  assert {
    condition = (module.stories_agent.runtime_name == "cf_prod_story_agent" && module.agent.runtime_name == "cf_prod_clip_agent" &&
      output.stories_agent_runtime_arn == "arn:aws:bedrock-agentcore:eu-north-1:123456789012:runtime/cf_prod_story_agent-AbCdEf1234" &&
    module.stories_agent.log_group_name == "/aws/bedrock-agentcore/runtimes/cf_prod_story_agent-AbCdEf1234-DEFAULT")
    error_message = "Lamo Stories has its own runtime, cf_prod_story_agent, beside Clip Factory's cf_prod_clip_agent."
  }

  assert {
    condition = (output.stories_agent_image_tag == "stories-agent-test" && output.stories_agent_image_tag != var.agent_image_tag &&
    output.stories_ecr_repository_url == "123456789012.dkr.ecr.eu-north-1.amazonaws.com/cf-prod-stories-agent")
    error_message = "deploy.yml reads stories_agent_image_tag (the tag Lamo Stories' runtime runs) before the plan; it is never Clip Factory's tag."
  }

  assert {
    condition = (output.stories_api_function_name == "cf-prod-stories-api" && module.api.function_names == { api = "cf-prod-api" } &&
    module.stories_api.function_names == { stories-api = "cf-prod-stories-api" })
    error_message = "Lamo Stories has its own API Lambda, cf-prod-stories-api; cf-prod-api stays the only function of module.api."
  }

  assert {
    condition = (module.flows.function_names["story-flow"] == "cf-prod-story-flow" &&
    output.story_flow_alias_arn == "arn:aws:lambda:eu-north-1:123456789012:function:cf-prod-story-flow:live")
    error_message = "cf-prod-story-flow exists with its alias live (cf-prod-stories-api's STORY_FLOW_ARN)."
  }

  assert {
    condition = module.api.stories_route_keys == toset([
      "ANY /v1/workspaces", "ANY /v1/workspaces/{proxy+}", "OPTIONS /v1/workspaces", "OPTIONS /v1/workspaces/{proxy+}",
      "GET /v1/stories-oauth/{platform}/callback",
    ])
    error_message = "The HTTP API gets Lamo Stories' five routes (§45.15)."
  }

  assert {
    condition = (output.stories_callback_base == "https://http123.execute-api.eu-north-1.amazonaws.com/v1/stories-oauth" &&
    output.stories_callback_base == "${output.api_url}/v1/stories-oauth")
    error_message = "storiesCallbackBase is {apiUrl}/v1/stories-oauth (the hooks forward target and own apps' redirect URI base)."
  }

  assert {
    condition = (module.monitoring.alarm_names["stories-api"] == "cf-prod-stories-api-errors" &&
      module.monitoring.alarm_names["story-flow"] == "cf-prod-story-flow-errors" &&
      module.monitoring.stories_agent_alarm_name == "cf-prod-stories-agent-errors" &&
      toset([for k, v in module.monitoring.durable_alarm_names : v]) == toset([
        "cf-prod-job-flow-durable-failed", "cf-prod-job-flow-durable-timed-out",
        "cf-prod-clip-flow-durable-failed", "cf-prod-clip-flow-durable-timed-out",
        "cf-prod-story-flow-durable-failed", "cf-prod-story-flow-durable-timed-out",
    ]))
    error_message = "cf-prod-stories-api and cf-prod-story-flow are watched for errors (and the flow's failed and timed-out executions), the story runtime for error lines."
  }

  assert {
    condition = (local.ws_secret_prefix == "cf-prod/workspaces/" &&
      local.workspace_secrets_arn == "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-prod/workspaces/*" &&
      local.workspace_token_secrets_arn == "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-prod/workspaces/*/token*" &&
    local.workspace_provider_secrets_arn == "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-prod/workspaces/*/providers/*")
    error_message = "Lamo Stories' secrets live under cf-prod/workspaces/ (§45.13.1)."
  }

  # What Clip Factory's functions read and write (cf-prod/platforms/*, …/token-*, the clip agent's YouTube proxy and
  # Ask's search key) never reaches a Lamo Stories secret.
  assert {
    condition = alltrue([
      for r in [module.hooks.platform_secrets_arn, module.hooks.platform_token_secrets_arn, local.youtube_proxy_secret_arn, local.ask_search_secret_arn] :
      !can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-prod/workspaces/stories/youtube/token-AbC123"))
    ])
    error_message = "…:secret:cf-prod/workspaces/stories/youtube/token-AbC123 must match none of Clip Factory's secret patterns."
  }

  # And Lamo Stories' patterns never reach Clip Factory's tokens or pending choices.
  assert {
    condition = alltrue(flatten([
      for r in [local.workspace_secrets_arn, local.workspace_token_secrets_arn, local.workspace_provider_secrets_arn] : [
        for sample in [
          "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-prod/platforms/youtube/token-AbC123",
          "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-prod/platforms/youtube/pending-AbC123",
          "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-prod/platforms/youtube/token",
        ] : !can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", sample))
      ]
    ]))
    error_message = "…:secret:cf-prod/platforms/youtube/token-AbC123 and …/pending-AbC123 must match no Lamo Stories secret pattern."
  }

  # The story agent's model grants come from stories/config/models.json, never from Clip Factory's config/models.json.
  assert {
    condition = (contains(module.stories_agent.model_invoke_arns, "arn:aws:bedrock:eu-north-1:123456789012:inference-profile/global.anthropic.claude-opus-5-5") &&
      module.stories_agent.image_model_arn == "arn:aws:bedrock:eu-west-1::foundation-model/amazon.nova-canvas-v1:0" &&
    !contains(keys(local.models), "imageModel") && !contains(keys(local.models), "videoModel"))
    error_message = "Lamo Stories' models come from stories/config/models.json (Nova Canvas in eu-west-1); config/models.json gains nothing (§45.11.4)."
  }

  assert {
    condition     = var.stories_video_us_bucket == false && module.stories_agent.video_bucket == ""
    error_message = "Nova Reel's us-east-1 bucket is off until the owner allows it (§45.31)."
  }
}

run "lamo_stories_nova_reel_switch_plans" {
  command = plan

  variables {
    stories_video_us_bucket = true
  }

  assert {
    condition     = module.stories_agent.video_bucket == "cf-prod-stories-video-123456789012-us"
    error_message = "With the switch on, the us-east-1 bucket is cf-prod-stories-video-<account>-us."
  }

  assert {
    condition = (output.table_name == "cf-prod-data" && output.media_bucket == "cf-prod-media-123456789012" &&
    output.vector_bucket == "cf-prod-vectors-123456789012" && output.web_bucket == "cf-prod-web-123456789012")
    error_message = "The table and the buckets that hold the owner's data keep their names."
  }
}

# docs/CONTRACTS.md §38.16: Content Rewards. cf-prod-campaigns is planned and watched, the switch defaults to on (every
# builder's part has merged), the api and the stats tick get its unqualified ARN, and the stack still plans with it off.
run "content_rewards_is_wired_and_on" {
  command = plan

  assert {
    condition     = var.content_rewards_enabled == true
    error_message = "content_rewards_enabled defaults to true now that every builder's part of §38.19 has merged."
  }

  assert {
    condition = (module.contentrewards.campaigns_function_arn == "arn:aws:lambda:eu-north-1:123456789012:function:cf-prod-campaigns" &&
    module.contentrewards.campaigns_function_name == "cf-prod-campaigns")
    error_message = "cf-prod-campaigns is planned with an unqualified ARN for the api and the stats tick."
  }

  assert {
    condition     = contains(keys(module.monitoring.alarm_names), "campaigns")
    error_message = "cf-prod-campaigns joins monitoring's errors alarm."
  }
}

run "content_rewards_switch_off_plans" {
  command = plan

  variables {
    content_rewards_enabled = false
  }

  assert {
    condition     = module.contentrewards.function_names == { campaigns = "cf-prod-campaigns" }
    error_message = "With the switch off the stack still plans and cf-prod-campaigns is the same function."
  }
}

# docs/CONTRACTS.md §39.3: the campaign copy (CR_REMAKE) defaults to on (G, H and I of §39.4 have merged) and only
# changes the api's environment; the stack still plans with it off.
run "cr_remake_is_wired_and_on" {
  command = plan

  assert {
    condition     = var.cr_remake_enabled == true
    error_message = "cr_remake_enabled defaults to true now that G, H and I of §39.4 have merged."
  }
}

run "cr_remake_switch_off_plans" {
  command = plan

  variables {
    content_rewards_enabled = true
    cr_remake_enabled       = false
  }

  assert {
    condition     = module.api.function_names == { api = "cf-prod-api" }
    error_message = "With the copy switched off the stack still plans and cf-prod-api is the same function."
  }
}

# docs/CONTRACTS.md §41.6: the campaign finder. cr_finder_enabled defaults to true now that P, Q, R, S and T have
# merged; it is wired to exactly the three functions that read CR_FINDER (cf-prod-api, cf-prod-stats and
# cf-prod-campaigns) and nowhere else. Each module's own test proves the switch reaches only that env var (one use,
# CR_FINDER = var.cr_finder_enabled ? "on" : "off"), so flipping it changes three env vars in place and can never
# delete or replace what holds the owner's data (the deploy's delete gate stays quiet). The stack still plans with it
# off, the one-line way to stop the finder the same day if Content Rewards or Whop asks.
run "cr_finder_is_wired_and_on" {
  command = plan

  assert {
    condition     = var.cr_finder_enabled == true
    error_message = "cr_finder_enabled defaults to true now that P, Q, R, S and T of §41.6 have merged."
  }

  assert {
    condition = (module.contentrewards.function_names == { campaigns = "cf-prod-campaigns" } &&
      length(regexall("var\\.cr_finder_enabled", file("main.tf"))) == 3 &&
      length(regexall("(?m)^  cr_finder_enabled = var\\.cr_finder_enabled$", file("main.tf"))) == 3 &&
      strcontains(regex("(?s)\nmodule \"api\" \\{\n(.*?)\n\\}\n", file("main.tf"))[0], "\n  cr_finder_enabled = var.cr_finder_enabled\n") &&
      strcontains(regex("(?s)\nmodule \"stats\" \\{\n(.*?)\n\\}\n", file("main.tf"))[0], "\n  cr_finder_enabled = var.cr_finder_enabled\n") &&
    strcontains(regex("(?s)\nmodule \"contentrewards\" \\{\n(.*?)\n\\}\n", file("main.tf"))[0], "\n  cr_finder_enabled = var.cr_finder_enabled\n"))
    error_message = "cr_finder_enabled is passed to the api, stats and contentrewards modules, and to nothing else."
  }

  assert {
    condition = (module.contentrewards.function_names == { campaigns = "cf-prod-campaigns" } &&
      module.api.function_names == { api = "cf-prod-api" } &&
    output.stats_function_name == "cf-prod-stats" && output.stats_rule_name == "cf-prod-stats")
    error_message = "With the finder on the stack plans the same cf-prod-api, cf-prod-stats (and its tick) and cf-prod-campaigns."
  }

  assert {
    condition = (output.table_name == "cf-prod-data" && output.media_bucket == "cf-prod-media-123456789012" &&
    output.vector_bucket == "cf-prod-vectors-123456789012" && output.web_bucket == "cf-prod-web-123456789012")
    error_message = "The table and the buckets that hold the owner's data keep their names: the finder adds no table, bucket or secret."
  }

  assert {
    condition = toset(keys(module.monitoring.alarm_names)) == toset([
      "api", "job-flow", "clip-flow", "ws", "broadcast", "hooks", "stats", "learn", "follow-tick", "money", "ask", "notify",
      "campaigns", "story-flow", "stories-api", "autopost",
    ])
    error_message = "No new function: the finder runs in cf-prod-campaigns, started by the stats tick and the api."
  }
}

run "cr_finder_switch_off_plans" {
  command = plan

  variables {
    cr_finder_enabled = false
  }

  assert {
    condition = (module.contentrewards.function_names == { campaigns = "cf-prod-campaigns" } &&
      module.api.function_names == { api = "cf-prod-api" } &&
    output.stats_function_name == "cf-prod-stats" && output.stats_rule_name == "cf-prod-stats")
    error_message = "With the finder switched off the stack still plans: the same cf-prod-api, cf-prod-stats (and its tick) and cf-prod-campaigns."
  }

  assert {
    condition = (output.table_name == "cf-prod-data" && output.media_bucket == "cf-prod-media-123456789012" &&
    output.vector_bucket == "cf-prod-vectors-123456789012" && output.web_bucket == "cf-prod-web-123456789012")
    error_message = "Switching the finder off keeps the table and the buckets that hold the owner's data: the stored items stay."
  }
}

# docs/CONTRACTS.md §40.6: "Connect Whop" (WHOP_CONNECT) defaults to off until K, L and M of §40.8 have merged; it only
# changes cf-prod-api's environment, so the stack plans the same functions with it on.
run "whop_connect_is_wired_and_off" {
  command = plan

  assert {
    condition     = var.whop_connect_enabled == false
    error_message = "whop_connect_enabled defaults to false until K, L and M of §40.8 have merged (then one switch PR)."
  }

  assert {
    condition     = module.api.function_names == { api = "cf-prod-api" }
    error_message = "cf-prod-api is planned with the switch off."
  }
}

run "whop_connect_switch_on_plans" {
  command = plan

  variables {
    whop_connect_enabled = true
  }

  assert {
    condition     = module.api.function_names == { api = "cf-prod-api" } && module.money.function_names == { money = "cf-prod-money" } && module.notify.notify_function_name == "cf-prod-notify"
    error_message = "With the switch on the stack still plans and cf-prod-api, cf-prod-money and cf-prod-notify are the same functions."
  }
}

# docs/CONTRACTS.md §46.11 and ADR-81: auto-posting. cf-prod-autopost and its hourly rule are planned and watched (its
# errors in monitoring, the rule's failed invocations by the module's own hourly alarm on the same topic: two new
# alarms), it starts the clip flow on its live alias, gets SECRET_PREFIX but no secret grant (the campaign fit check
# reads only the table), the Content Rewards switch and the boundary, and the switch off still plans it. The module's
# own test (modules/autopost) proves the role, the cron, the retries and the alarm's hourly window.
run "autopost_is_wired" {
  command = plan

  assert {
    condition = (module.autopost.function_names == { autopost = "cf-prod-autopost" } &&
      module.autopost.schedule_rule_names == { autopost = "cf-prod-autopost-hourly" } &&
    module.autopost.function_name == "cf-prod-autopost")
    error_message = "cf-prod-autopost and its rule cf-prod-autopost-hourly are planned."
  }

  assert {
    condition = (module.monitoring.alarm_names["autopost"] == "cf-prod-autopost-errors" &&
      module.autopost.schedule_alarm_names == { autopost = "cf-prod-autopost-hourly-failed-invocations" } &&
    !contains(keys(module.monitoring.schedule_alarm_names), "autopost"))
    error_message = "cf-prod-autopost is watched for errors and its hourly rule for failed invocations, by one alarm of that name (the module's hourly one, not monitoring's 15-minute one)."
  }

  assert {
    condition = module.autopost.function_name == "cf-prod-autopost" && alltrue([
      for line in [
        "\n  clip_flow_alias_arn  = module.flows.clip_flow_alias_arn\n",
        "\n  clip_flow_arn_prefix = module.flows.function_arns[\"clip-flow\"]\n",
        "\n  secret_prefix = module.hooks.secret_prefix\n",
        "\n  content_rewards_enabled = var.content_rewards_enabled\n",
        "\n  cr_remake_enabled = var.cr_remake_enabled\n",
        "\n  alarm_topic_arn = module.monitoring.alarm_topic_arn\n",
        "\n  permissions_boundary_arn = var.role_permissions_boundary_arn\n",
        "\n  table_arn       = module.data.table_arn\n",
      ] : strcontains("\n${regex("(?s)\nmodule \"autopost\" \\{\n(.*?)\n\\}\n", file("main.tf"))[0]}\n", line)
    ])
    error_message = "module.autopost gets the clip flow's live alias and unqualified ARN, SECRET_PREFIX, the Content Rewards switch, the alarms topic, the table and the boundary."
  }

  assert {
    condition     = module.autopost.function_name == "cf-prod-autopost" && !strcontains(regex("(?s)\nmodule \"autopost\" \\{\n(.*?)\n\\}\n", file("main.tf"))[0], "secrets_arn")
    error_message = "module.autopost gets no secret ARN: the campaign fit check reads only the table, so the role reads and writes no secret."
  }
}

run "autopost_with_content_rewards_off_plans" {
  command = plan

  variables {
    content_rewards_enabled = false
  }

  assert {
    condition     = module.autopost.function_names == { autopost = "cf-prod-autopost" } && module.autopost.schedule_rule_names == { autopost = "cf-prod-autopost-hourly" }
    error_message = "With Content Rewards off the stack still plans the same cf-prod-autopost and its rule (campaign clips then wait)."
  }
}
