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

variable "log_retention_days" {
  type    = number
  default = 30
}
