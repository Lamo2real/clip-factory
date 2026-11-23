variable "name" {
  type        = string
  description = "Resource name prefix (cf-prod)."
}

variable "region" { type = string }
variable "account_id" { type = string }

variable "image_tag" {
  type        = string
  description = "Clips Funded's agent image tag (stories-agent- + a hash of stories/** and web/src/stories/engine/**, deploy.yml). A new tag builds and pushes a new image during apply."
  validation {
    condition     = can(regex("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$", var.image_tag))
    error_message = "image_tag must be a valid Docker tag (letters, digits, _ . -, at most 128 characters)."
  }
}

variable "table_name" { type = string }
variable "table_arn" { type = string }
variable "media_bucket" { type = string }
variable "media_bucket_arn" { type = string }

variable "models_config_path" {
  type        = string
  default     = ""
  description = "Clips Funded's model list (docs/CONTRACTS.md §45.25). Empty: the repository's stories/config/models.json. The runtime's Bedrock grants are built from it; Clip Factory's config/models.json is never read here."
}

variable "workspace_provider_secrets_arn" {
  type        = string
  description = "ARN pattern of the provider keys the owner pastes in Clips Funded (arn:aws:secretsmanager:REGION:ACCT:secret:<name>/workspaces/*/providers/*, §45.31): the only secrets the runtime may read."
  validation {
    condition     = can(regex("^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9_-]+/workspaces/\\*/providers/\\*$", var.workspace_provider_secrets_arn))
    error_message = "workspace_provider_secrets_arn must be a secretsmanager ARN ending in /workspaces/*/providers/*."
  }
}

variable "stories_video_us_bucket" {
  type        = bool
  default     = false
  description = "Nova Reel (docs/CONTRACTS.md §45.31, ADR-80): true adds the S3 bucket <name>-stories-video-<account>-us in us-east-1 (Nova Reel writes only there; private, TLS only, files kept 14 days) and the runtime's StartAsyncInvoke/GetAsyncInvoke grants. Off until the owner allows Clips Funded to keep generated shots in the US."
}

variable "stories_video_west_bucket" {
  type        = bool
  default     = false
  description = "Luma AI Ray2 (docs/CONTRACTS.md §45.37 G7): true adds the S3 bucket <name>-stories-video-<account>-usw2 in us-west-2 (Luma AI Ray2 runs only there; private, TLS only, files kept 14 days), CF_VIDEO_WEST_BUCKET and the runtime's us-west-2 async video grants. Off until the owner allows Clips Funded to keep generated shots in the US (Oregon)."
}

variable "permissions_boundary_arn" {
  type        = string
  default     = ""
  description = "Permissions boundary for this module's IAM role (infra/bootstrap's cf-prod-role-boundary). Empty: none."
}

variable "log_retention_days" {
  type        = number
  default     = 30
  description = "Retention of the runtime's log group, the same as every other log group in the stack."
}
