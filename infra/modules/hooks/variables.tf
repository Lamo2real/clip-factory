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

variable "app_url" {
  type        = string
  description = "The web app's origin: OAuth callbacks redirect back to its Settings screen."
}

variable "stories_oauth_callback" {
  type        = string
  default     = ""
  description = "Funded Clips' own OAuth callback base, {apiUrl}/v1/stories-oauth (STORIES_OAUTH_CALLBACK, docs/CONTRACTS.md §45.13.3): a w1. state is answered 302 to {STORIES_OAUTH_CALLBACK}/{platform}/callback. Empty: not set (w1. states are not forwarded)."
  validation {
    condition     = var.stories_oauth_callback == "" || can(regex("^https://[^/]+/v1/stories-oauth$", var.stories_oauth_callback))
    error_message = "stories_oauth_callback must be empty or https://<host>/v1/stories-oauth (no trailing slash)."
  }
}

variable "clip_flow_alias_arn" {
  type        = string
  description = "cf-prod-clip-flow alias live (CLIP_FLOW_ARN): a connect starts publish executions for waiting posts on it (§17.6)."
}

variable "clip_flow_arn_prefix" {
  type        = string
  description = "Unqualified ARN of clip-flow; IAM grants NAME:*."
}

variable "manage_api_gateway_account" {
  type        = bool
  default     = true
  description = "Create the API Gateway CloudWatch logging role and set it on the account (one per account and Region). false when it is managed elsewhere; that role must then already be set."
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
