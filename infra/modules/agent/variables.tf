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
