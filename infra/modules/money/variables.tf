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
  description = "ARN pattern arn:aws:secretsmanager:REGION:ACCT:secret:<name>/platforms/*: the money run reads keys and tokens."
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

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "permissions_boundary_arn" {
  type        = string
  default     = ""
  description = "Permissions boundary for this module's IAM role (infra/bootstrap's cf-prod-role-boundary). Empty: none."
}

# ---------- Your bank (docs/CONTRACTS.md §40.5.6, §40.5.11) ----------
variable "bank_reading_enabled" {
  type        = bool
  default     = false
  description = "§40.5.11: BANK_READING on/off for the bank reader (the same switch as cf-prod-api). Off: nothing is read from any bank; stored deposits, payers and links stay."
}

variable "content_rewards_enabled" {
  type        = bool
  default     = false
  description = "§38.16: CONTENT_REWARDS on/off. The bank reader suggests Content Rewards for a Whop payment only while it is on (§40.5.8 rule 8)."
}

variable "app_url" {
  type        = string
  default     = ""
  description = "The app's https address (APP_URL): the psu-referer header of his own bank Check now. Empty: that header can't be filled, so a bank that needs it is read unattended."
  validation {
    condition     = var.app_url == "" || (startswith(var.app_url, "https://") && !endswith(var.app_url, "/"))
    error_message = "app_url must be empty or an https address without a trailing slash."
  }
}
