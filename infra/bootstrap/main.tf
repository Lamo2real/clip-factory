# Optional, run once by the owner with their own admin credentials (see README.md): the GitHub OIDC provider
# (created only if the account does not have it yet) and the role deploy.yml assumes. Local state on purpose:
# it runs before the state bucket exists, and it is two resources the owner can re-import at any time.
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project     = "clip-factory"
      Environment = "prod"
      ManagedBy   = "terraform"
    }
  }
}

data "aws_caller_identity" "me" {}

locals {
  github_host  = "token.actions.githubusercontent.com"
  account_id   = data.aws_caller_identity.me.account_id
  provider_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : "arn:aws:iam::${local.account_id}:oidc-provider/${local.github_host}"
  # Every role the prod stack creates is named cf-prod-*; the deploy role may manage only those.
  stack_roles = "arn:aws:iam::${local.account_id}:role/cf-prod-*"
}

resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_oidc_provider ? 1 : 0
  url            = "https://${local.github_host}"
  client_id_list = ["sts.amazonaws.com"]
}

resource "aws_iam_role" "deploy" {
  name                 = var.role_name
  description          = "Assumed by GitHub Actions (deploy.yml) on ${var.github_repository}, branch ${var.branch} only."
  max_session_duration = 7200 # a first deploy builds the agent image inside terraform apply
  # The same trust as github-oidc-trust-policy.json (the copy for setting the role up by hand).
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "GitHubClipFactoryMainOnly"
      Effect    = "Allow"
      Principal = { Federated = local.provider_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${local.github_host}:aud" = "sts.amazonaws.com"
          "${local.github_host}:sub" = "repo:${var.github_repository}:ref:refs/heads/${var.branch}"
        }
      }
    }]
  })
}

# Everything except IAM and Organizations, plus IAM limited to the stack's own roles. Narrower than administrator,
# broad enough that new modules deploy without editing this role.
resource "aws_iam_role_policy_attachment" "power_user" {
  role       = aws_iam_role.deploy.name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

resource "aws_iam_role_policy" "stack_roles" {
  name = "manage-cf-prod-roles"
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ManageStackRoles"
        Effect = "Allow"
        Action = [
          "iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:UpdateRole", "iam:UpdateAssumeRolePolicy", "iam:TagRole", "iam:UntagRole",
          "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole",
          "iam:PutRolePolicy", "iam:GetRolePolicy", "iam:DeleteRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy",
        ]
        Resource = local.stack_roles
      },
      {
        Sid       = "PassStackRoles"
        Effect    = "Allow"
        Action    = ["iam:PassRole"]
        Resource  = local.stack_roles
        Condition = { StringEquals = { "iam:PassedToService" = ["lambda.amazonaws.com", "bedrock-agentcore.amazonaws.com", "scheduler.amazonaws.com"] } }
      },
      {
        # First use of Lambda, AgentCore, CloudFront and friends in a fresh account creates their service-linked roles.
        Sid      = "ServiceLinkedRoles"
        Effect   = "Allow"
        Action   = ["iam:CreateServiceLinkedRole"]
        Resource = "arn:aws:iam::${local.account_id}:role/aws-service-role/*"
      },
    ]
  })
}
