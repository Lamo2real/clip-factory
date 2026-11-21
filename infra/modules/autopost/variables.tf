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
  description = "SECRET_PREFIX (<name>/platforms/): only so the Content Rewards deps, and with them the campaign fit check, are built. The fit check reads only the table, so the role reads no secret."
  validation {
    condition     = endswith(var.secret_prefix, "/platforms/")
    error_message = "secret_prefix must end with /platforms/."
  }
}

variable "alarm_topic_arn" {
  type        = string
  description = "The alarms topic (monitoring's alarm_topic_arn, cf-prod-alarms): the hourly rule's failed-invocations alarm goes there."
  validation {
    condition     = can(regex("^arn:aws[a-z-]*:sns:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]+$", var.alarm_topic_arn))
    error_message = "alarm_topic_arn must be one SNS topic ARN."
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
