variable "name" {
  type        = string
  description = "Resource name prefix (cf-prod)."
}

variable "lambda_zip_path" {
  type        = string
  description = "api/dist/lambda.zip, built before plan: the same package as cf-prod-api (docs/CONTRACTS.md §45.15)."
}

variable "app_version" {
  type        = string
  description = "Release version (VERSION), the same value cf-prod-api reports."
}

variable "app_url" {
  type        = string
  description = "The web app's origin (APP_URL): the Clips Funded OAuth callback lands on {APP_URL}/stories/connections."
}

variable "table_name" { type = string }
variable "table_arn" { type = string }
variable "media_bucket" { type = string }
variable "media_bucket_arn" { type = string }

variable "stories_agent_runtime_arn" {
  type        = string
  description = "Clips Funded's own AgentCore runtime (cf_prod_story_agent, STORIES_AGENT_RUNTIME_ARN). Never Clip Factory's cf_prod_clip_agent."
  validation {
    condition     = can(regex("^arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:[0-9]{12}:runtime/[A-Za-z0-9_]*_story_agent-[A-Za-z0-9]+$", var.stories_agent_runtime_arn))
    error_message = "stories_agent_runtime_arn must be the ARN of the *_story_agent runtime (never the clip agent's)."
  }
}

variable "story_flow_alias_arn" {
  type        = string
  description = "cf-prod-story-flow's alias live (STORY_FLOW_ARN): publishing starts there (§45.14)."
  validation {
    condition     = can(regex("^arn:aws[a-z-]*:lambda:[a-z0-9-]+:[0-9]{12}:function:[A-Za-z0-9_-]+-story-flow:live$", var.story_flow_alias_arn))
    error_message = "story_flow_alias_arn must be the story flow's alias ARN, ending in -story-flow:live."
  }
}

variable "ws_secret_prefix" {
  type        = string
  description = "Name prefix of Clips Funded's secrets (WS_SECRET_PREFIX, <name>/workspaces/, §45.13.1)."
  validation {
    condition     = endswith(var.ws_secret_prefix, "/workspaces/") && !strcontains(var.ws_secret_prefix, "/platforms/")
    error_message = "ws_secret_prefix must end with /workspaces/ and never be under /platforms/."
  }
}

variable "workspace_secrets_arn" {
  type        = string
  description = "ARN pattern arn:aws:secretsmanager:REGION:ACCT:secret:<name>/workspaces/*: the workspace tokens, pending choices, own app keys and provider keys this function manages."
  validation {
    condition     = can(regex("^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9_-]+/workspaces/\\*$", var.workspace_secrets_arn))
    error_message = "workspace_secrets_arn must be a secretsmanager ARN ending in /workspaces/*."
  }
}

variable "secret_prefix" {
  type        = string
  description = "Name prefix of Clip Factory's platform secrets (SECRET_PREFIX, <name>/platforms/): only its YouTube, TikTok and X app keys are read, for the owner's shared-app choice (§45.30)."
  validation {
    condition     = endswith(var.secret_prefix, "/platforms/")
    error_message = "secret_prefix must end with /platforms/."
  }
}

variable "platform_secrets_arn" {
  type        = string
  description = "ARN pattern arn:aws:secretsmanager:REGION:ACCT:secret:<name>/platforms/*; the grants are narrowed to {youtube,tiktok,x}/app* from it."
  validation {
    condition     = can(regex("^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9_-]+/platforms/\\*$", var.platform_secrets_arn))
    error_message = "platform_secrets_arn must be a secretsmanager ARN ending in /platforms/*."
  }
}

variable "oauth_state_secret_name" {
  type        = string
  description = "The OAuth state key's name (OAUTH_STATE_SECRET): the same key and 10 minutes as Clip Factory's states (§45.13.2)."
}

variable "oauth_state_secret_arn" {
  type        = string
  description = "The OAuth state key's ARN (read only)."
}

variable "hooks_url" {
  type        = string
  description = "https://{id}.execute-api.{region}.amazonaws.com/v1 (HOOKS_URL): Clip Factory's registered redirect URIs, used with Clip Factory's app (§45.30)."
  validation {
    condition     = startswith(var.hooks_url, "https://") && !endswith(var.hooks_url, "/")
    error_message = "hooks_url must start with https:// and have no trailing slash."
  }
}

variable "stories_oauth_callback" {
  type        = string
  description = "Clips Funded's own callback base {apiUrl}/v1/stories-oauth (STORIES_OAUTH_CALLBACK, §45.13.3): the redirect URI Clips Funded's own developer apps register."
  validation {
    condition     = can(regex("^https://[^/]+/v1/stories-oauth$", var.stories_oauth_callback))
    error_message = "stories_oauth_callback must be https://<host>/v1/stories-oauth (no trailing slash)."
  }
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "permissions_boundary_arn" {
  type        = string
  default     = ""
  description = "Permissions boundary for this module's IAM role (infra/bootstrap's cf-prod-role-boundary). Empty: none."
}
