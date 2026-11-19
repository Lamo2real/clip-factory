variable "name" {
  type        = string
  description = "Resource name prefix (cf-prod)."
}

variable "region" { type = string }
variable "account_id" { type = string }

variable "image_tag" {
  type        = string
  description = "Agent image tag (the git sha). A new tag builds and pushes a new image during apply."
}

variable "table_name" { type = string }
variable "table_arn" { type = string }
variable "media_bucket" { type = string }
variable "media_bucket_arn" { type = string }

variable "model_id" {
  type        = string
  description = "Inference profile id the agent calls, <profilePrefix>.<modelId> from config/models.json."
}

variable "model_profile_arn" {
  type        = string
  description = "ARN of that system inference profile in this region."
}

variable "model_invoke_arns" {
  type        = list(string)
  description = "Every ARN a Bedrock call through the profile touches: the profile and the foundation model in any region."
}

variable "clip_model_profile_arns" {
  type        = list(string)
  default     = []
  description = "Inference profile ARNs (this region) of every model the owner may pick for clip jobs (clipModels in config/models.json, docs/DECISIONS.md ADR-42). Added to ReadProfile next to model_profile_arn."
}

variable "clip_model_invoke_arns" {
  type        = list(string)
  default     = []
  description = "Every ARN a call to one of the owner's clip models touches: each profile, and its foundation model in any region (global profile) or in the profile's listed regions (geo profile). Added to InvokeFable next to model_invoke_arns."
}

variable "watch_model_id" {
  type        = string
  description = "Inference profile id of the second watcher of the deep analysis (CF_WATCH_MODEL_ID): Amazon Nova 2 Lite through the EU geo profile, <profilePrefix>.<modelId> of watchModel in config/models.json (docs/DECISIONS.md ADR-40)."
}

variable "watch_model_invoke_arns" {
  type        = list(string)
  description = "Every ARN a call to the watch model touches: its inference profile in this region and the foundation model in each region the profile routes to (no wildcard)."
}

variable "deep_analysis_enabled" {
  type        = bool
  default     = true
  description = "CF_DEEP: true (on) watches the whole picture before picking moments; false (off) skips the picture download and the watch step, which is exactly the pipeline before ADR-40."
}

variable "vector_bucket" {
  type        = string
  description = "S3 Vectors bucket holding one vector per clip (CF_VECTOR_BUCKET)."
}

variable "vector_index" {
  type        = string
  description = "The clips index (CF_VECTOR_INDEX)."
}

variable "vector_index_arn" { type = string }

variable "embed_model_id" {
  type        = string
  description = "Titan Text Embeddings V2 model id, in-Region (CF_EMBED_MODEL_ID)."
}

variable "embed_model_arn" { type = string }

variable "permissions_boundary_arn" {
  type        = string
  default     = ""
  description = "Permissions boundary for this module's IAM roles (infra/bootstrap's cf-prod-role-boundary). Empty: none."
}

variable "log_retention_days" {
  type        = number
  default     = 30
  description = "Retention of the runtime's log group, the same as every other log group in the stack."
}

variable "youtube_proxy_secret" {
  type        = string
  description = "Name of the optional Secrets Manager secret with a proxy URL for YouTube (CF_YOUTUBE_PROXY_SECRET, docs/CONTRACTS.md §29.8). It may not exist."
}

variable "youtube_proxy_secret_arn" {
  type        = string
  description = "ARN pattern of that secret (name plus the 6-character suffix Secrets Manager adds)."
}
