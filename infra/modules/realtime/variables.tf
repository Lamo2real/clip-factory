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

variable "stream_arn" {
  type        = string
  description = "The table's stream (NEW_AND_OLD_IMAGES), read by cf-prod-broadcast."
}

variable "user_pool_id" {
  type        = string
  description = "Cognito user pool whose access tokens open a connection."
}

variable "user_pool_client_id" {
  type        = string
  description = "The web app client; tokens of any other client are refused."
}

variable "connection_ttl_seconds" {
  type        = number
  default     = 7200
  description = "Connection items expire after API Gateway's 2-hour connection cap."
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
