variable "region" {
  type        = string
  default     = "eu-north-1"
  description = "One region for everything (CloudFront is global)."
}

variable "owner_email" {
  type        = string
  description = "The only login. Cognito emails it a temporary password on the first deploy."
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.owner_email))
    error_message = "owner_email must be an email address."
  }
}

variable "agent_image_tag" {
  type        = string
  description = "Tag of the agent image. The deploy workflow sets it from a hash of agent/, skills/ and config/, so it only changes when the agent changes. terraform apply builds and pushes it before the runtime."
  validation {
    condition     = can(regex("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$", var.agent_image_tag))
    error_message = "agent_image_tag must be a valid Docker tag (letters, digits, _ . -, at most 128 characters)."
  }
}

variable "app_version" {
  type        = string
  default     = ""
  description = "Release version reported by GET /v1/health: the git sha the deploy workflow passes as TF_VAR_app_version (the same value config.json and version.json carry). Empty: falls back to agent_image_tag."
  validation {
    condition     = var.app_version == "" || can(regex("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$", var.app_version))
    error_message = "app_version must be empty or a short version string (letters, digits, _ . -, at most 128 characters)."
  }
}

variable "lambda_zip_path" {
  type        = string
  default     = "../../../api/dist/lambda.zip"
  description = "The API package, built before plan. Relative to infra/envs/prod."
}

variable "alarm_email" {
  type        = string
  default     = ""
  description = "Optional address for alarm emails (Lambda errors, failed or timed-out durable executions, live-update lag, webhook 5xx). Empty: no email."
  validation {
    condition     = var.alarm_email == "" || can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alarm_email))
    error_message = "alarm_email must be empty or an email address."
  }
}

variable "web_dev_origin" {
  type        = string
  default     = "http://localhost:5173"
  description = "Local Vite dev server, allowed by the API's and the media bucket's CORS."
}

variable "manage_api_gateway_account" {
  type        = bool
  default     = true
  description = "Set the account's API Gateway CloudWatch logging role (one per account and Region; needed for REST and WebSocket logs). false when the account's setting is managed elsewhere."
}
