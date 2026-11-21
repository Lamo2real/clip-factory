variable "name" {
  type        = string
  description = "Resource name prefix (cf-prod)."
}

variable "region" { type = string }
variable "account_id" { type = string }

variable "lambda_zip_path" {
  type        = string
  description = "api/dist/lambda.zip, built before plan. Every function runs this one package."
}

variable "table_name" { type = string }
variable "table_arn" { type = string }

variable "media_bucket" {
  type        = string
  description = "Media bucket name; cf-prod-learn reads the owner's skills from skills/* (§18.8)."
}
variable "media_bucket_arn" { type = string }

variable "model_id" {
  type        = string
  description = "Inference profile id the weekly learning calls (global.anthropic.claude-fable-5-1)."
}

variable "model_invoke_arns" {
  type        = list(string)
  description = "Every ARN a Bedrock call through that profile touches."
}

variable "embed_model_id" {
  type        = string
  description = "Titan Text Embeddings V2 model id (in-Region, no profile)."
}

variable "embed_model_arn" { type = string }
variable "vector_bucket" { type = string }
variable "vector_index" { type = string }
variable "vector_index_arn" { type = string }

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
  description = "ARN pattern arn:aws:secretsmanager:REGION:ACCT:secret:<name>/platforms/*: stats reads tokens and writes refreshed ones."
  validation {
    condition     = can(regex("^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9_-]+/platforms/\\*$", var.platform_secrets_arn))
    error_message = "platform_secrets_arn must be a secretsmanager ARN ending in /platforms/*."
  }
}

variable "platform_token_secrets_arn" {
  type        = string
  description = "ARN pattern arn:aws:secretsmanager:REGION:ACCT:secret:<name>/platforms/*/token-*: the only secrets this function may write (a refreshed token)."
  validation {
    condition     = can(regex("^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9_-]+/platforms/\\*/token-\\*$", var.platform_token_secrets_arn))
    error_message = "platform_token_secrets_arn must be a secretsmanager ARN ending in /platforms/*/token-*."
  }
}

variable "hooks_url" {
  type        = string
  default     = ""
  description = "cf-prod-hooks' base URL (https://{id}.execute-api.{region}.amazonaws.com/v1): the follow tick gives Twitch {hooks_url}/hooks/twitch. Empty: no Twitch webhooks (the tick still polls)."
  validation {
    condition     = var.hooks_url == "" || can(regex("^https://", var.hooks_url))
    error_message = "hooks_url must be empty or start with https://."
  }
}

variable "platforms_config_path" {
  type        = string
  description = "config/platforms.json (docs/CONTRACTS.md §16.4). The schedule runs at its lowest minIntervalMinutes."
  validation {
    condition     = fileexists(var.platforms_config_path)
    error_message = "platforms_config_path must point at config/platforms.json."
  }
}

variable "content_rewards_enabled" {
  type        = bool
  default     = false
  description = "§38.16: CONTENT_REWARDS on/off for the stats tick's Content Rewards checking."
}

variable "campaigns_function_arn" {
  type        = string
  default     = ""
  description = "Unqualified ARN of cf-prod-campaigns (CAMPAIGNS_FUNCTION_ARN). Empty: no grant."
  validation {
    condition     = var.campaigns_function_arn == "" || can(regex("^arn:aws[a-z-]*:lambda:[a-z0-9-]+:[0-9]{12}:function:[A-Za-z0-9_-]+$", var.campaigns_function_arn))
    error_message = "campaigns_function_arn must be empty or an unqualified Lambda function ARN."
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
