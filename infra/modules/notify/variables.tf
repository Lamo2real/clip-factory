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

variable "stream_arn" {
  type        = string
  description = "The table's stream (NEW_AND_OLD_IMAGES): cf-prod-notify compares each job before and after."
}

variable "app_url" {
  type        = string
  description = "https://<distribution>.cloudfront.net: the VAPID subject push services may contact."
  validation {
    condition     = startswith(var.app_url, "https://")
    error_message = "app_url must be an https address."
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
