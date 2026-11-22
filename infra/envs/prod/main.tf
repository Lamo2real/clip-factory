# Clip Factory Cloud, production. Applied by .github/workflows/deploy.yml on every push to main, from nothing on
# the first run. The state bucket is passed at init time: terraform init -backend-config=... (backend.hcl.example).
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws    = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
    random = { source = "hashicorp/random", version = ">= 3.7.0, < 4.0.0" } # the webhook verify token (ephemeral)
    tls    = { source = "hashicorp/tls", version = ">= 4.1.0, < 5.0.0" }    # the VAPID key (ephemeral, §32.2)
  }
  backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project     = "clip-factory"
      Environment = "prod"
      ManagedBy   = "terraform"
    }
  }
}

# Lamo Stories' Nova Reel bucket only (docs/CONTRACTS.md §45.31): Nova Reel writes its shots to a bucket in its own
# Region. Nothing uses this provider while stories_video_us_bucket is false.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = {
      Project     = "clip-factory"
      Environment = "prod"
      ManagedBy   = "terraform"
    }
  }
}

data "aws_caller_identity" "me" {}

locals {
  name       = "cf-prod"
  account_id = data.aws_caller_identity.me.account_id

  # config/models.json is the only place model ids live (docs/CONTRACTS.md §1).
  models      = jsondecode(file("${path.module}/../../../config/models.json"))
  agent_model = local.models.models[local.models.agentModel]
  # A model's own profilePrefix overrides the top-level one (§19.5); Fable has none, so it stays global.
  model_id = "${try(local.agent_model.profilePrefix, local.models.profilePrefix)}.${local.agent_model.modelId}"
  # A call through a cross-region profile is authorised on the profile here and on the foundation model in
  # whichever region serves it (none, for a global profile), hence the region wildcard.
  model_profile_arn = "arn:aws:bedrock:${var.region}:${local.account_id}:inference-profile/${local.model_id}"
  model_invoke_arns = [
    local.model_profile_arn,
    "arn:aws:bedrock:*::foundation-model/${local.agent_model.modelId}",
  ]

  # The models the owner may pick for clip jobs (Settings › Clip making › AI model, clipModels in config/models.json,
  # docs/DECISIONS.md ADR-42). The agent may call each one the way it calls the default: its profile here, and the
  # foundation model in any region for a global profile, or in the listed destination regions for a geo profile.
  # CF_MODEL_ID stays the default (agentModel); the owner's pick travels with each job's settings.
  clip_models = { for k in local.models.clipModels : k => local.models.models[k] }
  clip_model_ids = {
    for k, m in local.clip_models : k => "${try(m.profilePrefix, local.models.profilePrefix)}.${m.modelId}"
  }
  clip_model_profile_arns = sort([
    for k, id in local.clip_model_ids : "arn:aws:bedrock:${var.region}:${local.account_id}:inference-profile/${id}"
  ])
  clip_model_invoke_arns = sort(distinct(concat(
    local.clip_model_profile_arns,
    flatten([
      for k, m in local.clip_models : try(m.profilePrefix, local.models.profilePrefix) == "global"
      ? ["arn:aws:bedrock:*::foundation-model/${m.modelId}"]
      : [for r in m.profileRegions : "arn:aws:bedrock:${r}::foundation-model/${m.modelId}"]
    ]),
  )))

  # Titan Text Embeddings V2 is called in-Region, never through a profile (docs/CONTRACTS.md §1, §14.6).
  embed_model_id   = local.models.embeddingModel.modelId
  embed_dimensions = local.models.embeddingModel.dimensions
  embed_model_arn  = "arn:aws:bedrock:${var.region}::foundation-model/${local.embed_model_id}"

  # Ask Clip Factory (docs/CONTRACTS.md §19.5, §19.9): Claude Haiku through the EU geo profile, so questions stay in
  # the EU. A geo profile is authorised on the profile here and on the foundation model in each destination region
  # it may route to, listed in config/models.json (no region wildcard, unlike the global profile above).
  help_model     = local.models.models[local.models.helpModel]
  help_model_id  = "${try(local.help_model.profilePrefix, local.models.profilePrefix)}.${local.help_model.modelId}"
  help_model_arn = "arn:aws:bedrock:${var.region}:${local.account_id}:inference-profile/${local.help_model_id}"
  help_model_invoke_arns = concat(
    [local.help_model_arn],
    [for r in local.help_model.profileRegions : "arn:aws:bedrock:${r}::foundation-model/${local.help_model.modelId}"],
  )

  # Ask as a full assistant (docs/CONTRACTS.md §28.1, ADR-51): Claude in Amazon Bedrock (Mantle) in-Region, so the
  # bare model ids are used (profilePrefix does not apply) and questions stay in askEndpoint.region (Stockholm).
  ask_region            = local.models.askEndpoint.region
  ask_model_id          = local.models.models[local.models.askModel].modelId
  ask_fallback_model_id = local.models.models[local.models.askFallbackModel].modelId
  ask_search_secret     = "${local.name}/ask/search-key"
  ask_search_secret_arn = "arn:aws:secretsmanager:${var.region}:${local.account_id}:secret:${local.ask_search_secret}-??????"

  # The optional YouTube proxy (docs/CONTRACTS.md §29.8): the owner may create this secret later (value
  # http://user:pass@host:port). Not managed here: no apply creates, replaces or deletes it.
  youtube_proxy_secret     = "${local.name}/agent/youtube-proxy"
  youtube_proxy_secret_arn = "arn:aws:secretsmanager:${var.region}:${local.account_id}:secret:${local.youtube_proxy_secret}-??????"

  # The deep analysis's second watcher (docs/DECISIONS.md ADR-40): Amazon Nova 2 Lite through the EU geo profile, so
  # the video parts it watches stay in the EU. Same shape as the help model: the profile here plus the foundation
  # model in each region the profile may route to, listed in config/models.json (no region wildcard).
  watch_model     = local.models.models[local.models.watchModel]
  watch_model_id  = "${try(local.watch_model.profilePrefix, local.models.profilePrefix)}.${local.watch_model.modelId}"
  watch_model_arn = "arn:aws:bedrock:${var.region}:${local.account_id}:inference-profile/${local.watch_model_id}"
  watch_model_invoke_arns = concat(
    [local.watch_model_arn],
    [for r in local.watch_model.profileRegions : "arn:aws:bedrock:${r}::foundation-model/${local.watch_model.modelId}"],
  )

  # Lamo Stories (docs/CONTRACTS.md §45.13.1, §45.15): its tokens, pending Meta choices, own app keys and provider keys
  # live under a prefix of their own, which none of Clip Factory's grants reaches. Created at runtime by
  # cf-prod-stories-api, never by Terraform. No "-" before the "*" in the token and provider patterns: a secret that
  # does not exist is checked by its bare name, and the code needs "not found" there, not AccessDenied.
  ws_secret_prefix               = "${local.name}/workspaces/"
  workspace_secrets_arn          = "arn:aws:secretsmanager:${var.region}:${local.account_id}:secret:${local.ws_secret_prefix}*"
  workspace_token_secrets_arn    = "arn:aws:secretsmanager:${var.region}:${local.account_id}:secret:${local.ws_secret_prefix}*/token*"
  workspace_provider_secrets_arn = "arn:aws:secretsmanager:${var.region}:${local.account_id}:secret:${local.ws_secret_prefix}*/providers/*"
}

module "storage" {
  source     = "../../modules/storage"
  name       = local.name
  account_id = local.account_id
}

module "data" {
  source = "../../modules/data"
  name   = local.name
}

module "frontend" {
  source                          = "../../modules/frontend"
  name                            = local.name
  region                          = var.region
  web_bucket_id                   = module.storage.web_bucket_id
  web_bucket_arn                  = module.storage.web_bucket_arn
  web_bucket_regional_domain_name = module.storage.web_bucket_regional_domain_name
  media_bucket                    = module.storage.media_bucket
}

# Here rather than in the storage module: it names the CloudFront origin, and the frontend reads storage.
resource "aws_s3_bucket_cors_configuration" "media" {
  bucket = module.storage.media_bucket_id
  cors_rule {
    allowed_origins = [module.frontend.app_url, var.web_dev_origin]
    allowed_methods = ["PUT", "GET", "HEAD"]
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

module "auth" {
  source      = "../../modules/auth"
  name        = local.name
  owner_email = var.owner_email
  app_url     = module.frontend.app_url
}

module "vectors" {
  source     = "../../modules/vectors"
  name       = local.name
  account_id = local.account_id
  dimension  = local.embed_dimensions
}

module "agent" {
  source            = "../../modules/agent"
  name              = local.name
  region            = var.region
  account_id        = local.account_id
  image_tag         = var.agent_image_tag
  table_name        = module.data.table_name
  table_arn         = module.data.table_arn
  media_bucket      = module.storage.media_bucket
  media_bucket_arn  = module.storage.media_bucket_arn
  model_id          = local.model_id
  model_profile_arn = local.model_profile_arn
  model_invoke_arns = local.model_invoke_arns
  vector_bucket     = module.vectors.vector_bucket
  vector_index      = module.vectors.vector_index
  vector_index_arn  = module.vectors.vector_index_arn
  embed_model_id    = local.embed_model_id
  embed_model_arn   = local.embed_model_arn

  # The owner's choice of model for clip jobs (ADR-42): every model in clipModels may be called.
  clip_model_profile_arns = local.clip_model_profile_arns
  clip_model_invoke_arns  = local.clip_model_invoke_arns

  # "Watch the video" (ADR-40): the second watcher. Fable, the main watcher, needs nothing new.
  watch_model_id          = local.watch_model_id
  watch_model_invoke_arns = local.watch_model_invoke_arns

  # YouTube from the cloud (§29.8): the optional proxy secret, read only.
  youtube_proxy_secret     = local.youtube_proxy_secret
  youtube_proxy_secret_arn = local.youtube_proxy_secret_arn

  # Every cf-prod-* role carries the deploy role's permissions boundary (docs/DEPLOYMENT.md, infra/bootstrap).
  permissions_boundary_arn = var.role_permissions_boundary_arn
}

# Durable functions: cf-prod-job-flow (agent run + callback) and cf-prod-clip-flow (publish, 48 h wait, learn).
module "flows" {
  source            = "../../modules/flows"
  name              = local.name
  lambda_zip_path   = var.lambda_zip_path
  table_name        = module.data.table_name
  table_arn         = module.data.table_arn
  media_bucket      = module.storage.media_bucket
  media_bucket_arn  = module.storage.media_bucket_arn
  agent_runtime_arn = module.agent.runtime_arn
  model_id          = local.model_id
  model_invoke_arns = local.model_invoke_arns
  embed_model_id    = local.embed_model_id
  embed_model_arn   = local.embed_model_arn
  vector_bucket     = module.vectors.vector_bucket
  vector_index      = module.vectors.vector_index
  vector_index_arn  = module.vectors.vector_index_arn
  # §17.6: the clip flow posts with the owner's tokens (read, refresh).
  secret_prefix              = module.hooks.secret_prefix
  platform_secrets_arn       = module.hooks.platform_secrets_arn
  platform_token_secrets_arn = module.hooks.platform_token_secrets_arn
  # §45.15: cf-prod-story-flow posts with Lamo Stories' own tokens only.
  ws_secret_prefix            = local.ws_secret_prefix
  workspace_secrets_arn       = local.workspace_secrets_arn
  workspace_token_secrets_arn = local.workspace_token_secrets_arn

  # §38.12: campaign posts go to Content Rewards only while the switch is on.
  content_rewards_enabled = var.content_rewards_enabled

  # Every cf-prod-* role carries the deploy role's permissions boundary (docs/DEPLOYMENT.md, infra/bootstrap).
  permissions_boundary_arn = var.role_permissions_boundary_arn
}

# Clip numbers (cf-prod-stats on an EventBridge tick from config/platforms.json) and the weekly best learning
# (cf-prod-learn), docs/CONTRACTS.md §16.
module "stats" {
  source                     = "../../modules/stats"
  name                       = local.name
  region                     = var.region
  account_id                 = local.account_id
  lambda_zip_path            = var.lambda_zip_path
  table_name                 = module.data.table_name
  table_arn                  = module.data.table_arn
  media_bucket               = module.storage.media_bucket
  media_bucket_arn           = module.storage.media_bucket_arn
  model_id                   = local.model_id
  model_invoke_arns          = local.model_invoke_arns
  embed_model_id             = local.embed_model_id
  embed_model_arn            = local.embed_model_arn
  vector_bucket              = module.vectors.vector_bucket
  vector_index               = module.vectors.vector_index
  vector_index_arn           = module.vectors.vector_index_arn
  platforms_config_path      = "${path.module}/../../../config/platforms.json"
  secret_prefix              = module.hooks.secret_prefix
  platform_secrets_arn       = module.hooks.platform_secrets_arn
  platform_token_secrets_arn = module.hooks.platform_token_secrets_arn
  # §24: the follow tick gives Twitch {hooks_url}/hooks/twitch as the webhook callback.
  hooks_url = module.hooks.hooks_url
  # §38.12: Content Rewards checking rides the stats tick; a changed brief starts a rules read.
  content_rewards_enabled = var.content_rewards_enabled
  campaigns_function_arn  = module.contentrewards.campaigns_function_arn
  # §41.5: the campaign finder's scheduled look rides the same tick (CR_FINDER), on since its switch PR.
  cr_finder_enabled = var.cr_finder_enabled

  # Every cf-prod-* role carries the deploy role's permissions boundary (docs/DEPLOYMENT.md, infra/bootstrap).
  permissions_boundary_arn = var.role_permissions_boundary_arn
}

# Content Rewards campaigns (docs/CONTRACTS.md §38.16): cf-prod-campaigns reads a campaign's rules, fetches a logo
# link and copies the brand's picture. Additive: a new function, role, policy and log group; no secret access at all,
# and the CR secrets are made at runtime, never here. Off (CONTENT_REWARDS=off) until the switch PR. Since §41 its
# "find" action reads Content Rewards' public campaign pages that robots.txt allows (never its API) for the campaign
# finder, behind CR_FINDER (cr_finder_enabled).
module "contentrewards" {
  source                  = "../../modules/contentrewards"
  name                    = local.name
  region                  = var.region
  account_id              = local.account_id
  lambda_zip_path         = var.lambda_zip_path
  table_name              = module.data.table_name
  table_arn               = module.data.table_arn
  media_bucket            = module.storage.media_bucket
  media_bucket_arn        = module.storage.media_bucket_arn
  model_id                = local.model_id
  model_invoke_arns       = local.model_invoke_arns
  app_url                 = module.frontend.app_url
  content_rewards_enabled = var.content_rewards_enabled
  # §41.2: the campaign finder's look (CR_FINDER), on since its switch PR.
  cr_finder_enabled = var.cr_finder_enabled

  # Every cf-prod-* role carries the deploy role's permissions boundary (docs/DEPLOYMENT.md, infra/bootstrap).
  permissions_boundary_arn = var.role_permissions_boundary_arn
}

# Real earnings (docs/CONTRACTS.md §25): cf-prod-money once a day and on "Check now". Additive: a new function, role,
# log group and schedule; it reads and refreshes tokens exactly like cf-prod-stats and can never delete anything.
module "money" {
  source                     = "../../modules/money"
  name                       = local.name
  region                     = var.region
  account_id                 = local.account_id
  lambda_zip_path            = var.lambda_zip_path
  table_name                 = module.data.table_name
  table_arn                  = module.data.table_arn
  secret_prefix              = module.hooks.secret_prefix
  platform_secrets_arn       = module.hooks.platform_secrets_arn
  platform_token_secrets_arn = module.hooks.platform_token_secrets_arn

  # Every cf-prod-* role carries the deploy role's permissions boundary (docs/DEPLOYMENT.md, infra/bootstrap).
  permissions_boundary_arn = var.role_permissions_boundary_arn
}

module "api" {
  source               = "../../modules/api"
  name                 = local.name
  lambda_zip_path      = var.lambda_zip_path
  app_version          = coalesce(var.app_version, var.agent_image_tag)
  app_url              = module.frontend.app_url
  web_dev_origin       = var.web_dev_origin
  jwt_issuer           = module.auth.issuer
  jwt_audience         = module.auth.user_pool_client_id
  table_name           = module.data.table_name
  table_arn            = module.data.table_arn
  media_bucket         = module.storage.media_bucket
  media_bucket_arn     = module.storage.media_bucket_arn
  agent_runtime_arn    = module.agent.runtime_arn
  job_flow_alias_arn   = module.flows.job_flow_alias_arn
  clip_flow_alias_arn  = module.flows.clip_flow_alias_arn
  job_flow_arn_prefix  = module.flows.function_arns["job-flow"]
  clip_flow_arn_prefix = module.flows.function_arns["clip-flow"]
  stats_function_arn   = module.stats.stats_function_arn
  learn_function_arn   = module.stats.learn_function_arn
  money_function_arn   = module.money.money_function_arn
  vector_bucket        = module.vectors.vector_bucket
  vector_index         = module.vectors.vector_index
  vector_index_arn     = module.vectors.vector_index_arn
  # Set up posting (docs/CONTRACTS.md §17.4, §17.9): api ← hooks ← frontend, no cycle.
  hooks_url               = module.hooks.hooks_url
  secret_prefix           = module.hooks.secret_prefix
  platform_secrets_arn    = module.hooks.platform_secrets_arn
  oauth_state_secret_arn  = module.hooks.oauth_state_secret_arn
  oauth_state_secret_name = module.hooks.oauth_state_secret_name
  web_bucket              = module.storage.web_bucket
  web_bucket_arn          = module.storage.web_bucket_arn
  distribution_id         = module.frontend.distribution_id
  distribution_arn        = module.frontend.distribution_arn
  # Lamo Stories (§45.15): ANY /v1/workspaces(/{proxy+}), their public OPTIONS and its OAuth callback reach
  # cf-prod-stories-api. cf-prod-api's function, role and environment do not use these.
  stories_routes_enabled    = true
  stories_api_function_name = module.stories_api.function_name
  stories_api_invoke_arn    = module.stories_api.invoke_arn
  # Ask Clip Factory (§19.9). The kill switch item in the table can still turn it off without a deploy.
  help_enabled           = var.help_enabled
  help_model_id          = local.help_model_id
  help_model_invoke_arns = local.help_model_invoke_arns
  help_monthly_cap       = var.help_monthly_cap
  # Ask as a full assistant (§28): start cf-prod-ask, keep the web search key.
  ask_enabled        = var.ask_enabled
  ask_function_name  = module.ask.ask_function_name
  ask_function_arn   = module.ask.ask_function_arn
  search_secret_name = local.ask_search_secret
  search_secret_arn  = local.ask_search_secret_arn
  # Notifications (§32.3): read the VAPID key (its public half, "Send a test").
  vapid_secret_name = module.notify.vapid_secret_name
  vapid_secret_arn  = module.notify.vapid_secret_arn
  # Content Rewards (§38.8, §38.16): 503 on every /v1/contentrewards route until the switch is on.
  content_rewards_enabled = var.content_rewards_enabled
  campaigns_function_arn  = module.contentrewards.campaigns_function_arn
  # §39.3: the campaign copy of a clip (CR_REMAKE), on since its switch PR.
  cr_remake_enabled = var.cr_remake_enabled
  # §41.5: the campaign finder's seven routes (CR_FINDER), on since its switch PR (503 "Coming soon." when off).
  cr_finder_enabled = var.cr_finder_enabled
  # §40.6: "Connect Whop" (WHOP_CONNECT), off until its switch PR; an in-place env change.
  whop_connect_enabled = var.whop_connect_enabled

  # Every cf-prod-* role carries the deploy role's permissions boundary (docs/DEPLOYMENT.md, infra/bootstrap).
  permissions_boundary_arn = var.role_permissions_boundary_arn
}

# Platform webhooks (REST API), the OAuth callback and its state key and the account's API Gateway logging role, which the WebSocket stage needs too.
module "hooks" {
  source                     = "../../modules/hooks"
  name                       = local.name
  region                     = var.region
  account_id                 = local.account_id
  lambda_zip_path            = var.lambda_zip_path
  table_name                 = module.data.table_name
  table_arn                  = module.data.table_arn
  app_url                    = module.frontend.app_url
  manage_api_gateway_account = var.manage_api_gateway_account
  # §17.6: a connect releases the owner's waiting posts and starts the clip flow for them (flows → hooks reads only
  # the hooks module's names, so there is no cycle).
  clip_flow_alias_arn  = module.flows.clip_flow_alias_arn
  clip_flow_arn_prefix = module.flows.function_arns["clip-flow"]
  # §45.13.3: a w1. (Lamo Stories) state is forwarded to Lamo Stories' own callback; nothing else of Lamo Stories here.
  stories_oauth_callback = module.api.stories_callback_base

  # Every cf-prod-* role carries the deploy role's permissions boundary (docs/DEPLOYMENT.md, infra/bootstrap).
  permissions_boundary_arn = var.role_permissions_boundary_arn
}

# Live updates (WebSocket API). After hooks: API Gateway allows one CreateDeployment per 5 s per account, and the
# stage's logging needs the account's CloudWatch role that hooks sets.
module "realtime" {
  source              = "../../modules/realtime"
  name                = local.name
  region              = var.region
  account_id          = local.account_id
  lambda_zip_path     = var.lambda_zip_path
  table_name          = module.data.table_name
  table_arn           = module.data.table_arn
  stream_arn          = module.data.stream_arn
  user_pool_id        = module.auth.user_pool_id
  user_pool_client_id = module.auth.user_pool_client_id
  depends_on          = [module.hooks]

  # Every cf-prod-* role carries the deploy role's permissions boundary (docs/DEPLOYMENT.md, infra/bootstrap).
  permissions_boundary_arn = var.role_permissions_boundary_arn
}

# Ask as a full assistant (docs/CONTRACTS.md §28): cf-prod-ask answers with Claude Opus 5.5 and streams the answer
# over the WebSocket. Additive: a new function, role, log group and async-invoke config; nothing that holds data.
module "ask" {
  source                = "../../modules/ask"
  name                  = local.name
  region                = var.region
  account_id            = local.account_id
  lambda_zip_path       = var.lambda_zip_path
  table_name            = module.data.table_name
  table_arn             = module.data.table_arn
  media_bucket          = module.storage.media_bucket
  media_bucket_arn      = module.storage.media_bucket_arn
  ws_endpoint           = module.realtime.ws_endpoint
  ws_connections_arn    = module.realtime.ws_connections_arn
  ask_model_id          = local.ask_model_id
  ask_fallback_model_id = local.ask_fallback_model_id
  ask_region            = local.ask_region
  search_secret_name    = local.ask_search_secret
  search_secret_arn     = local.ask_search_secret_arn
  help_enabled          = var.help_enabled
  ask_eager_tools       = var.ask_eager_tools

  # Every cf-prod-* role carries the deploy role's permissions boundary (docs/DEPLOYMENT.md, infra/bootstrap).
  permissions_boundary_arn = var.role_permissions_boundary_arn
}

# Notifications on the owner's phone and computer (docs/CONTRACTS.md §32): the VAPID key (write-only, never destroyed)
# and cf-prod-notify, a second reader of the table's stream. Additive: a new secret, function, role, log group and
# event source mapping; nothing that holds the owner's data is changed.
module "notify" {
  source          = "../../modules/notify"
  name            = local.name
  lambda_zip_path = var.lambda_zip_path
  table_name      = module.data.table_name
  table_arn       = module.data.table_arn
  stream_arn      = module.data.stream_arn
  app_url         = module.frontend.app_url

  # Every cf-prod-* role carries the deploy role's permissions boundary (docs/DEPLOYMENT.md, infra/bootstrap).
  permissions_boundary_arn = var.role_permissions_boundary_arn
}

# Lamo Stories (docs/CONTRACTS.md §45, ADR-76): its own AgentCore runtime cf_prod_story_agent (its own image from
# stories/agent/, ECR repository, role and log group) and its own API Lambda cf-prod-stories-api. Additive: new
# resources and roles only; Clip Factory's agent, cf-prod-api and their roles are not touched. Its publisher,
# cf-prod-story-flow, is in module.flows.
module "stories_agent" {
  source     = "../../modules/stories_agent"
  name       = local.name
  region     = var.region
  account_id = local.account_id
  image_tag  = var.stories_agent_image_tag
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }
  table_name                     = module.data.table_name
  table_arn                      = module.data.table_arn
  media_bucket                   = module.storage.media_bucket
  media_bucket_arn               = module.storage.media_bucket_arn
  workspace_provider_secrets_arn = local.workspace_provider_secrets_arn
  # §45.31: Nova Reel's us-east-1 bucket, off until the owner allows it.
  stories_video_us_bucket = var.stories_video_us_bucket

  # Every cf-prod-* role carries the deploy role's permissions boundary (docs/DEPLOYMENT.md, infra/bootstrap).
  permissions_boundary_arn = var.role_permissions_boundary_arn
}

module "stories_api" {
  source                    = "../../modules/stories_api"
  name                      = local.name
  lambda_zip_path           = var.lambda_zip_path
  app_version               = coalesce(var.app_version, var.agent_image_tag)
  app_url                   = module.frontend.app_url
  table_name                = module.data.table_name
  table_arn                 = module.data.table_arn
  media_bucket              = module.storage.media_bucket
  media_bucket_arn          = module.storage.media_bucket_arn
  stories_agent_runtime_arn = module.stories_agent.runtime_arn
  story_flow_alias_arn      = module.flows.story_flow_alias_arn
  ws_secret_prefix          = local.ws_secret_prefix
  workspace_secrets_arn     = local.workspace_secrets_arn
  # Clip Factory's YouTube, TikTok and X app keys (the owner's shared-app choice, read only) and the state key.
  secret_prefix           = module.hooks.secret_prefix
  platform_secrets_arn    = module.hooks.platform_secrets_arn
  oauth_state_secret_name = module.hooks.oauth_state_secret_name
  oauth_state_secret_arn  = module.hooks.oauth_state_secret_arn
  hooks_url               = module.hooks.hooks_url
  stories_oauth_callback  = module.api.stories_callback_base

  # Every cf-prod-* role carries the deploy role's permissions boundary (docs/DEPLOYMENT.md, infra/bootstrap).
  permissions_boundary_arn = var.role_permissions_boundary_arn
}

module "monitoring" {
  source      = "../../modules/monitoring"
  name        = local.name
  account_id  = local.account_id
  alarm_email = var.alarm_email
  function_names = merge(
    module.api.function_names,
    module.flows.function_names,
    module.realtime.function_names,
    module.hooks.function_names,
    module.stats.function_names,
    module.money.function_names,
    module.ask.function_names,
    module.notify.function_names,
    module.contentrewards.function_names,
    module.stories_api.function_names,
  )
  schedule_rule_names    = merge(module.stats.schedule_rule_names, module.money.schedule_rule_names)
  durable_function_names = module.flows.durable_function_names
  stream_consumer_name   = module.realtime.broadcast_function_name
  hooks_api_name         = module.hooks.hooks_api_name
  hooks_stage_name       = module.hooks.hooks_stage_name
  # §19.9: Ask Clip Factory's model calls that fell back to plain answers (errors and timeouts).
  help_log_group_name = module.api.log_group_name
  # §28.10, §28.11: Ask's model failures and its daily token use.
  ask_log_group_name         = module.ask.log_group_name
  ask_tokens_alarm_threshold = var.ask_tokens_alarm_threshold
  # §45.15: Lamo Stories' agent runtime, watched for error lines in its own log group.
  stories_agent_alarm_enabled  = true
  stories_agent_log_group_name = module.stories_agent.log_group_name
}
