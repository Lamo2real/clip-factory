variable "name" {
  type        = string
  description = "Resource name prefix (cf-prod)."
}

variable "lambda_zip_path" {
  type        = string
  description = "api/dist/lambda.zip, built before plan (it vendors the durable execution SDK)."
}

variable "table_name" { type = string }
variable "table_arn" { type = string }
variable "media_bucket" { type = string }
variable "media_bucket_arn" { type = string }

variable "agent_runtime_arn" {
  type        = string
  description = "The AgentCore runtime job-flow starts (process_job) and stops."
}

variable "model_id" {
  type        = string
  description = "Inference profile id the distil step calls (global.anthropic.claude-fable-5-1)."
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
  description = "ARN pattern arn:aws:secretsmanager:REGION:ACCT:secret:<name>/platforms/*: clip-flow reads tokens and writes refreshed ones."
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

variable "retention_days" {
  type        = number
  default     = 14
  description = "Days a finished durable execution (and its name) is kept."
  validation {
    condition     = var.retention_days >= 1 && var.retention_days <= 90
    error_message = "Durable execution retention must be 1 to 90 days."
  }
}

variable "content_rewards_enabled" {
  type        = bool
  default     = false
  description = "§38.16: CONTENT_REWARDS on/off for the clip flow's cr-send steps."
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
