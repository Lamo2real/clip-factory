variable "name" {
  type        = string
  description = "Resource name prefix (cf-prod)."
}

variable "owner_email" {
  type        = string
  description = "The only login. Cognito emails this address a temporary password."
}

variable "app_url" {
  type        = string
  description = "The web app's HTTPS origin, linked from the invitation email."
}

variable "deletion_protection" {
  type        = bool
  default     = true
  description = "Set false (and apply) before terraform destroy."
}
