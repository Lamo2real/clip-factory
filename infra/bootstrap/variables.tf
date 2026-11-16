variable "region" {
  type        = string
  default     = "eu-north-1"
  description = "Region for the provider; IAM itself is global."
}

variable "github_repository" {
  type        = string
  default     = "Lamo2real/clip-factory-legal"
  description = "owner/name of the repository whose workflows may assume the deploy role."
}

variable "branch" {
  type        = string
  default     = "main"
  description = "Only workflow runs on this branch may deploy."
}

variable "role_name" {
  type    = string
  default = "clip-factory-github-deploy"
  validation {
    # A deploy role named cf-prod-* could change its own trust and policies through the cf-prod-* IAM rule.
    condition     = !startswith(var.role_name, "cf-prod-")
    error_message = "role_name must not start with cf-prod- (those are the stack's roles, which the deploy role may change). Pick another name, for example clip-factory-github-deploy."
  }
}

variable "create_oidc_provider" {
  type        = bool
  default     = true
  description = "false when the account already has the token.actions.githubusercontent.com provider (one per account)."
}

variable "github_immutable_subject_prefix" {
  type        = string
  default     = "repo:Lamo2real@143636021/clip-factory-legal@1459036149"
  description = "The repository's immutable OIDC subject prefix (gh api repos/<owner>/<repo>/actions/oidc/customization/sub → sub_claim_prefix)."
}

variable "role_boundary_name" {
  type        = string
  default     = "cf-prod-role-boundary"
  description = "Name of the permissions boundary every cf-prod-* role must carry. Its ARN goes in the repository variable CF_ROLE_BOUNDARY_ARN."
}

variable "enforce_role_boundary" {
  type        = bool
  default     = true
  description = "true: the deploy role can grant permissions only to cf-prod-* roles that carry the boundary. false only for the one-time switch-over of a stack deployed before the boundary existed (README.md)."
}
