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

variable "vector_bucket" { type = string }
variable "vector_index" { type = string }
variable "vector_index_arn" { type = string }

variable "log_retention_days" {
  type    = number
  default = 30
}
