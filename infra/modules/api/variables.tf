variable "name" {
  type        = string
  description = "Resource name prefix (cf-prod)."
}

variable "lambda_zip_path" {
  type        = string
  description = "api/dist/lambda.zip, built before plan. Every function runs this one package."
}

variable "app_version" {
  type        = string
  description = "Release version reported by GET /v1/health (the git sha of the release)."
}

variable "app_url" {
  type        = string
  description = "The web app's origin: CORS and links in API responses."
}

variable "web_dev_origin" {
  type        = string
  description = "Local Vite dev server origin, also allowed by CORS."
}

variable "jwt_issuer" { type = string }

variable "jwt_audience" {
  type        = string
  description = "The Cognito app client id."
}

variable "table_name" { type = string }
variable "table_arn" { type = string }
variable "media_bucket" { type = string }
variable "media_bucket_arn" { type = string }
variable "agent_runtime_arn" { type = string }

variable "job_flow_alias_arn" {
  type        = string
  description = "cf-prod-job-flow alias live (JOB_FLOW_ARN): the API starts job executions on it."
}

variable "clip_flow_alias_arn" {
  type        = string
  description = "cf-prod-clip-flow alias live (CLIP_FLOW_ARN): the API starts publish executions on it."
}

variable "job_flow_arn_prefix" {
  type        = string
  description = "Unqualified ARN arn:aws:lambda:REGION:ACCT:function:NAME of job-flow; IAM grants NAME:*."
}

variable "clip_flow_arn_prefix" {
  type        = string
  description = "Unqualified ARN of clip-flow; IAM grants NAME:*."
}

variable "stats_function_arn" {
  type        = string
  description = "Unqualified ARN of cf-prod-stats (STATS_FUNCTION_ARN): manual \"Refresh numbers\"."
  validation {
    condition     = can(regex("^arn:aws[a-z-]*:lambda:[a-z0-9-]+:[0-9]{12}:function:[A-Za-z0-9_-]+$", var.stats_function_arn))
    error_message = "stats_function_arn must be an unqualified Lambda function ARN."
  }
}

variable "learn_function_arn" {
  type        = string
  description = "Unqualified ARN of cf-prod-learn (LEARN_FUNCTION_ARN): weekly best learning."
  validation {
    condition     = can(regex("^arn:aws[a-z-]*:lambda:[a-z0-9-]+:[0-9]{12}:function:[A-Za-z0-9_-]+$", var.learn_function_arn))
    error_message = "learn_function_arn must be an unqualified Lambda function ARN."
  }
}

variable "money_function_arn" {
  type        = string
  description = "Unqualified ARN of cf-prod-money (MONEY_FUNCTION_ARN): \"Check now\" on Settings › Posting › Money (§25.5)."
  validation {
    condition     = can(regex("^arn:aws[a-z-]*:lambda:[a-z0-9-]+:[0-9]{12}:function:[A-Za-z0-9_-]+$", var.money_function_arn))
    error_message = "money_function_arn must be an unqualified Lambda function ARN."
  }
}

# ---------- Content Rewards campaigns (docs/CONTRACTS.md §38.16) ----------
variable "campaigns_function_arn" {
  type        = string
  default     = ""
  description = "Unqualified ARN of cf-prod-campaigns (CAMPAIGNS_FUNCTION_ARN): rules reads, logo links, brand pictures. Empty: no grant."
  validation {
    condition     = var.campaigns_function_arn == "" || can(regex("^arn:aws[a-z-]*:lambda:[a-z0-9-]+:[0-9]{12}:function:[A-Za-z0-9_-]+$", var.campaigns_function_arn))
    error_message = "campaigns_function_arn must be empty or an unqualified Lambda function ARN."
  }
}

variable "content_rewards_enabled" {
  type        = bool
  default     = false
  description = "§38.16: CONTENT_REWARDS on/off. Off until every builder's part of §38.19 has merged."
}

variable "cr_remake_enabled" {
  type        = bool
  default     = false
  description = "§39.3: CR_REMAKE on/off, the campaign copy of a clip. Off until G, H and I of §39.4 have merged."
}

variable "cr_finder_enabled" {
  type        = bool
  default     = false
  description = "§41.6: CR_FINDER on/off, the campaign finder's routes. Off until every builder's part of §41.6 has merged."
}

variable "whop_connect_enabled" {
  type        = bool
  default     = false
  description = "§40.6: WHOP_CONNECT on/off, \"Connect Whop\" on the Content Rewards Get paid page. Off until K, L and M of §40.8 have merged; while off the Whop routes answer 503 \"Coming soon.\"."
}

# ---------- Set up posting (docs/CONTRACTS.md §17.4, §17.9) ----------
variable "hooks_url" {
  type        = string
  description = "cf-prod-hooks stage URL (HOOKS_URL): redirect URIs are {hooks_url}/oauth/{platform}/callback."
  validation {
    condition     = can(regex("^https://[^/]+/[A-Za-z0-9_-]+$", var.hooks_url))
    error_message = "hooks_url must be the https stage invoke URL with no trailing slash."
  }
}

variable "secret_prefix" {
  type        = string
  description = "Name prefix of the owner's platform key and token secrets (SECRET_PREFIX, <name>/platforms/)."
  validation {
    condition     = endswith(var.secret_prefix, "/platforms/")
    error_message = "secret_prefix must end with /platforms/."
  }
}

variable "platform_secrets_arn" {
  type        = string
  description = "ARN pattern arn:aws:secretsmanager:REGION:ACCT:secret:<name>/platforms/* the API may manage."
  validation {
    condition     = can(regex("^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9_-]+/platforms/\\*$", var.platform_secrets_arn))
    error_message = "platform_secrets_arn must be a secretsmanager ARN ending in /platforms/*."
  }
}

variable "oauth_state_secret_arn" {
  type        = string
  description = "ARN of the OAuth state key secret (read only)."
}

variable "oauth_state_secret_name" {
  type        = string
  description = "Name of the OAuth state key secret (OAUTH_STATE_SECRET, <name>/oauth/state-key)."
}

variable "web_bucket" {
  type        = string
  description = "Web bucket name (WEB_BUCKET): the TikTok verification file is written at its root."
}

variable "web_bucket_arn" { type = string }

variable "distribution_id" {
  type        = string
  description = "CloudFront distribution id (DISTRIBUTION_ID): invalidates /{verification file}."
}

variable "distribution_arn" { type = string }

variable "vector_bucket" { type = string }
variable "vector_index" { type = string }
variable "vector_index_arn" { type = string }

variable "help_enabled" {
  type        = bool
  default     = false
  description = "Ask Clip Factory (docs/CONTRACTS.md §19): HELP_ENABLED. Off unless the environment turns it on."
}

variable "help_model_id" {
  type        = string
  default     = ""
  description = "HELP_MODEL_ID, the inference profile the help model step calls (<profilePrefix>.<modelId> of helpModel in config/models.json). Empty: no model, plain answers only, and no Bedrock permission."
  validation {
    condition     = var.help_model_id == "" || can(regex("^[a-z]+\\.[a-z0-9.-]+$", var.help_model_id))
    error_message = "help_model_id must be empty or an inference profile id such as eu.anthropic.claude-haiku-5-5."
  }
}

variable "help_model_invoke_arns" {
  type        = list(string)
  default     = []
  description = "What HELP_MODEL_ID may invoke: its inference profile ARN and the foundation model in each destination region of the profile."
  validation {
    condition     = alltrue([for a in var.help_model_invoke_arns : can(regex("^arn:aws[a-z-]*:bedrock:[a-z0-9-]+:([0-9]{12}:inference-profile|:foundation-model)/[a-z0-9.:-]+$", a))])
    error_message = "help_model_invoke_arns must be Bedrock inference-profile or foundation-model ARNs."
  }
  validation {
    condition     = (var.help_model_id == "") == (length(var.help_model_invoke_arns) == 0)
    error_message = "help_model_id and help_model_invoke_arns go together: both set or both empty."
  }
}

variable "help_monthly_cap" {
  type        = number
  default     = 2000
  description = "HELP_MONTHLY_CAP: most model-written help answers per 30-day window."
  validation {
    condition     = var.help_monthly_cap >= 0 && floor(var.help_monthly_cap) == var.help_monthly_cap
    error_message = "help_monthly_cap must be a whole number, 0 or more."
  }
}

variable "ask_enabled" {
  type        = bool
  default     = false
  description = "ASK_ENABLED: Ask as a full assistant (docs/CONTRACTS.md §28). Off by default; prod turns it on."
}

variable "ask_function_name" {
  type    = string
  default = ""
}

variable "ask_function_arn" {
  type        = string
  default     = ""
  description = "cf-prod-ask (unqualified ARN), started with InvocationType=Event. Empty: no assistant, no permission."
  validation {
    condition     = var.ask_function_arn == "" || can(regex("^arn:aws[a-z-]*:lambda:[a-z0-9-]+:[0-9]{12}:function:[A-Za-z0-9_-]+$", var.ask_function_arn))
    error_message = "ask_function_arn must be empty or an unqualified Lambda function ARN."
  }
}

variable "search_secret_name" {
  type    = string
  default = "cf-prod/ask/search-key"
}

variable "search_secret_arn" {
  type        = string
  default     = ""
  description = "arn:aws:secretsmanager:REGION:ACCT:secret:cf-prod/ask/search-key-??????: the web search key the owner saves (created by the app, never by Terraform with a value)."
  validation {
    condition     = (var.ask_function_arn == "") == (var.search_secret_arn == "")
    error_message = "ask_function_arn and search_secret_arn go together: both set or both empty."
  }
}

variable "vapid_secret_name" {
  type        = string
  default     = ""
  description = "cf-prod/notify/vapid (infra/modules/notify). Empty with vapid_secret_arn: the push routes answer 503."
}

variable "vapid_secret_arn" {
  type        = string
  default     = ""
  description = "The VAPID key's secret ARN: cf-prod-api may only read it (GetSecretValue)."
  validation {
    condition     = (var.vapid_secret_arn == "") == (var.vapid_secret_name == "")
    error_message = "vapid_secret_name and vapid_secret_arn go together: both set or both empty."
  }
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "permissions_boundary_arn" {
  type        = string
  default     = ""
  description = "Permissions boundary for this module's IAM roles (infra/bootstrap's cf-prod-role-boundary). Empty: none."
}

# ---------- Lamo Stories (docs/CONTRACTS.md §45.5, §45.13.3, §45.15): its own Lambda behind new routes ----------
# Off (the default): no Lamo Stories route, integration, permission or route throttle. cf-prod-api's function, role
# and environment never use these. A plain switch, because the invoke ARN is only known once the function exists.
variable "stories_routes_enabled" {
  type        = bool
  default     = false
  description = "Add Lamo Stories' five routes (ANY and public OPTIONS for /v1/workspaces and /v1/workspaces/{proxy+}, and the public GET /v1/stories-oauth/{platform}/callback), integrated with cf-prod-stories-api."
}

variable "stories_api_function_name" {
  type        = string
  default     = ""
  description = "cf-prod-stories-api (modules/stories_api): API Gateway may invoke it for the Lamo Stories routes."
  validation {
    condition     = var.stories_api_function_name == "" || endswith(var.stories_api_function_name, "-stories-api")
    error_message = "stories_api_function_name must be empty or Lamo Stories' own <name>-stories-api (never cf-prod-api)."
  }
}

variable "stories_api_invoke_arn" {
  type        = string
  default     = ""
  description = "cf-prod-stories-api's invoke ARN: ANY /v1/workspaces, ANY /v1/workspaces/{proxy+}, their public OPTIONS and GET /v1/stories-oauth/{platform}/callback are integrated with it."
  validation {
    condition = ((var.stories_api_invoke_arn != "" && var.stories_api_function_name != "") == var.stories_routes_enabled &&
    (var.stories_api_invoke_arn == "" || strcontains(var.stories_api_invoke_arn, "-stories-api/invocations")))
    error_message = "With stories_routes_enabled, stories_api_function_name and stories_api_invoke_arn are both set (and only then), and the invoke ARN must be cf-prod-stories-api's."
  }
}
