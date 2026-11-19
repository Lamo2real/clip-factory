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
variable "media_bucket" { type = string }
variable "media_bucket_arn" { type = string }

variable "ws_endpoint" {
  type        = string
  description = "https://{api-id}.execute-api.{region}.amazonaws.com/live, for PostToConnection."
}

variable "ws_connections_arn" {
  type        = string
  description = "arn:aws:execute-api:REGION:ACCT:{api-id}/live/POST/@connections/*"
  validation {
    condition     = can(regex("^arn:aws[a-z-]*:execute-api:[a-z0-9-]+:[0-9]{12}:[a-z0-9]+/live/POST/@connections/\\*$", var.ws_connections_arn))
    error_message = "ws_connections_arn must be the live stage's POST @connections ARN."
  }
}

variable "ask_model_id" {
  type        = string
  description = "ASK_MODEL_ID: the bare Bedrock model id (Mantle in-Region takes no profile prefix), askModel in config/models.json."
  validation {
    condition     = can(regex("^anthropic\\.claude-[a-z0-9-]+$", var.ask_model_id))
    error_message = "ask_model_id must be a bare anthropic.claude-* model id."
  }
}

variable "ask_fallback_model_id" {
  type        = string
  description = "ASK_FALLBACK_MODEL_ID: the refusal fallback model, askFallbackModel in config/models.json."
  validation {
    condition     = can(regex("^anthropic\\.claude-[a-z0-9-]+$", var.ask_fallback_model_id))
    error_message = "ask_fallback_model_id must be a bare anthropic.claude-* model id."
  }
}

variable "ask_region" {
  type        = string
  default     = "eu-north-1"
  description = "Where Ask's model runs (in-Region, so questions stay in Stockholm)."
}

variable "ask_effort" {
  type    = string
  default = "medium"
  validation {
    condition     = contains(["low", "medium", "high", "xhigh", "max"], var.ask_effort)
    error_message = "ask_effort must be low, medium, high, xhigh or max."
  }
}

variable "ask_eager_tools" {
  type        = bool
  default     = true
  description = "ASK_EAGER_TOOLS: eager_input_streaming on the tools; false if Bedrock rejects the field."
}

variable "search_secret_name" {
  type    = string
  default = "cf-prod/ask/search-key"
}

variable "search_secret_arn" {
  type        = string
  description = "arn:aws:secretsmanager:REGION:ACCT:secret:cf-prod/ask/search-key* (the secret gets a random suffix)."
  validation {
    condition     = can(regex("^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9_/-]+\\*$", var.search_secret_arn))
    error_message = "search_secret_arn must be a secretsmanager ARN ending in *."
  }
}

variable "help_enabled" {
  type    = bool
  default = false
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
