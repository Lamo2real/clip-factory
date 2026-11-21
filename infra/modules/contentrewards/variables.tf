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

variable "table_arn" {
  type        = string
  description = "The one table (cf-prod-data). Read and written here, never replaced or deleted."
}

variable "media_bucket" { type = string }

variable "media_bucket_arn" {
  type        = string
  description = "The media bucket. Only its campaigns/ prefix is reachable from cf-prod-campaigns."
}

variable "model_id" {
  type        = string
  description = "The clip agent's model id (MODEL_ID): one Converse call per rules read."
}

variable "model_invoke_arns" {
  type        = list(string)
  description = "The model's inference profile and foundation-model ARNs (bedrock:InvokeModel)."
}

variable "app_url" { type = string }

variable "content_rewards_enabled" {
  type        = bool
  default     = false
  description = "§38.16: CONTENT_REWARDS on/off. Off until every builder's part of §38.19 has merged."
}

variable "cr_finder_enabled" {
  type        = bool
  default     = false
  description = "§41.6: CR_FINDER on/off, the campaign finder's \"find\" action. Off until every builder's part of §41.6 has merged."
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
