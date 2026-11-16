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
  # Every cf-prod-* role must carry this permissions boundary (the prod stack sets it from the repository variable
  # CF_ROLE_BOUNDARY_ARN). Without it, creating cf-prod-x with AdministratorAccess and assuming it would make the
  # deploy role an administrator.
  boundary_arn = "arn:aws:iam::${local.account_id}:policy/${var.role_boundary_name}"
  must_carry_boundary = {
    StringEquals = { "iam:PermissionsBoundary" = local.boundary_arn }
  }
  # Granting permissions to a cf-prod-* role. Enforced: only to a role that carries the boundary. Not enforced (the
  # one-time switch-over of an existing stack, see README.md): as before, so the next deploy can add the boundary.
  grant_actions = ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy"]
}

# The most any cf-prod-* role (Lambda, AgentCore, API Gateway logging) can ever do, whatever is attached to it: no
# IAM, Organizations or account settings. The roles need none of those, and the deploy role already has the rest.
resource "aws_iam_policy" "role_boundary" {
  name        = var.role_boundary_name
  description = "Permissions boundary for every cf-prod-* role: everything except IAM, Organizations and account settings."
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "NoIamOrAccount"
      Effect    = "Allow"
      NotAction = ["iam:*", "organizations:*", "account:*"]
      Resource  = "*"
    }]
  })
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
          # Both subject formats: the classic "repo:owner/name" and GitHub's immutable "repo:owner@id/name@id"
          # (this repository sends the immutable one).
          "${local.github_host}:sub" = [
            "repo:${var.github_repository}:ref:refs/heads/${var.branch}",
            "${var.github_immutable_subject_prefix}:ref:refs/heads/${var.branch}",
          ]
        }
      }
    }]
  })
}

# PowerUserAccess is everything except IAM, Organizations and account settings. IAM is added only for the stack's
# own cf-prod-* roles, and permissions can be granted to such a role only when it carries the boundary above, so
# the deploy role cannot use IAM to give itself (or a role it can reach) more than PowerUserAccess.
resource "aws_iam_role_policy_attachment" "power_user" {
  role       = aws_iam_role.deploy.name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

resource "aws_iam_role_policy" "stack_roles" {
  name = "manage-cf-prod-roles"
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          # Reading, tagging and taking permissions away need no boundary check.
          Sid    = "ManageStackRoles"
          Effect = "Allow"
          Action = [
            "iam:DeleteRole", "iam:GetRole", "iam:UpdateRole", "iam:UpdateAssumeRolePolicy", "iam:TagRole", "iam:UntagRole",
            "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole",
            "iam:GetRolePolicy", "iam:DeleteRolePolicy", "iam:DetachRolePolicy",
          ]
          Resource = local.stack_roles
        },
        {
          Sid       = "SetTheBoundaryOnly"
          Effect    = "Allow"
          Action    = ["iam:PutRolePermissionsBoundary"]
          Resource  = local.stack_roles
          Condition = local.must_carry_boundary
        },
      ],
      # One of the two, picked by enforce_role_boundary.
      [for st in [
        {
          Sid       = "GrantOnlyWithinBoundary"
          Effect    = "Allow"
          Action    = local.grant_actions
          Resource  = local.stack_roles
          Condition = local.must_carry_boundary
        },
        {
          Sid      = "GrantBeforeBoundarySwitchOver"
          Effect   = "Allow"
          Action   = local.grant_actions
          Resource = local.stack_roles
        },
      ] : st if(st.Sid == "GrantOnlyWithinBoundary") == var.enforce_role_boundary],
      [
        {
          Sid      = "KeepTheBoundary"
          Effect   = "Deny"
          Action   = ["iam:DeleteRolePermissionsBoundary"]
          Resource = local.stack_roles
        },
        {
          Sid      = "BoundaryIsReadOnly"
          Effect   = "Deny"
          Action   = ["iam:CreatePolicyVersion", "iam:DeletePolicy", "iam:DeletePolicyVersion", "iam:SetDefaultPolicyVersion"]
          Resource = aws_iam_policy.role_boundary.arn
        },
        {
          Sid      = "PassStackRoles"
          Effect   = "Allow"
          Action   = ["iam:PassRole"]
          Resource = local.stack_roles
          # Lambda execution roles, the AgentCore runtime role, and cf-prod-apigw-cloudwatch set on the API Gateway account.
          Condition = { StringEquals = { "iam:PassedToService" = ["lambda.amazonaws.com", "bedrock-agentcore.amazonaws.com", "apigateway.amazonaws.com"] } }
        },
        {
          # First use of Lambda, AgentCore, CloudFront and friends in a fresh account creates their service-linked roles.
          Sid      = "ServiceLinkedRoles"
          Effect   = "Allow"
          Action   = ["iam:CreateServiceLinkedRole"]
          Resource = "arn:aws:iam::${local.account_id}:role/aws-service-role/*"
        },
      ],
    )
  })
}
