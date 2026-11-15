variable "name" {
  type        = string
  description = "Resource name prefix (cf-prod)."
}

variable "account_id" {
  type        = string
  description = "AWS account id; bucket names carry it so they are globally unique."
}

variable "temporary_media_days" {
  type        = number
  default     = 14
  description = "Days before uploaded sources and job source files (audio, transcript, analysis) expire."
}

variable "temporary_tag_key" {
  type        = string
  default     = "cf-retention"
  description = "Object tag the agent sets on jobs/{jobId}/source/* objects so the lifecycle rule can expire them."
}

variable "temporary_tag_value" {
  type    = string
  default = "temporary"
}
