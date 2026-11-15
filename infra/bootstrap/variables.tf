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
