variable "name" {
  type        = string
  description = "Resource name prefix (cf-prod)."
}

variable "deletion_protection" {
  type        = bool
  default     = true
  description = "Set false (and apply) before terraform destroy."
}
