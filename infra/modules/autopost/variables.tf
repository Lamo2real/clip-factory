variable "name" {
  type        = string
  description = "Resource name prefix (cf-prod)."
}

variable "lambda_zip_path" {
  type        = string
  description = "api/dist/lambda.zip, built before plan. Every function runs this one package."
}

variable "table_name" { type = string }

variable "table_arn" {
  type        = string
  description = "The one table (cf-prod-data). Read and written here, never replaced or deleted."
}

variable "media_bucket" {
  type        = string
  description = "The media bucket's name (MEDIA_BUCKET). A run reads no file and signs no link, so the role has no S3 access."
}

variable "clip_flow_alias_arn" {
  type        = string
  description = "cf-prod-clip-flow alias live (CLIP_FLOW_ARN): each auto-posted clip starts its publish execution on it (§46.7)."
  validation {
    condition     = can(regex("^arn:aws[a-z-]*:lambda:[a-z0-9-]+:[0-9]{12}:function:[A-Za-z0-9_-]+:live$", var.clip_flow_alias_arn))
    error_message = "clip_flow_alias_arn must be a Lambda function ARN with the alias live."
  }
}

variable "clip_flow_arn_prefix" {
  type        = string
  description = "Unqualified ARN of clip-flow; IAM grants NAME:*."
  validation {
    condition     = can(regex("^arn:aws[a-z-]*:lambda:[a-z0-9-]+:[0-9]{12}:function:[A-Za-z0-9_-]+$", var.clip_flow_arn_prefix))
    error_message = "clip_flow_arn_prefix must be one unqualified Lambda function ARN (no qualifier, no wildcard)."
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
  description = "ARN pattern arn:aws:secretsmanager:REGION:ACCT:secret:<name>/platforms/*: the campaign fit check reads keys and tokens, as the clip flow."
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

variable "content_rewards_enabled" {
  type        = bool
  default     = false
  description = "§38.16, §46.5 rule 4: CONTENT_REWARDS on/off. Off: every campaign clip waits for the owner's Upload."
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
