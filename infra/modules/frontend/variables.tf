variable "name" {
  type        = string
  description = "Resource name prefix (cf-prod)."
}

variable "region" {
  type        = string
  description = "Region of the API, Cognito and the media bucket, for the Content Security Policy."
}

variable "web_bucket_id" { type = string }
variable "web_bucket_arn" { type = string }
variable "web_bucket_regional_domain_name" { type = string }

variable "media_bucket" {
  type        = string
  description = "Media bucket name: presigned uploads and downloads go straight to it."
}
