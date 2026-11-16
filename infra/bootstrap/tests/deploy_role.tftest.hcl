# Offline plan test (mock AWS provider, no credentials, no AWS calls):
#   cd infra/bootstrap && terraform init -backend=false && terraform test
#
# The deploy role must not be able to make itself an administrator through IAM on cf-prod-* roles: it can grant
# permissions to such a role only when the role carries the cf-prod-role-boundary permissions boundary, it can never
# remove that boundary, and the boundary itself allows no IAM.

mock_provider "aws" {
  override_during = plan

  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }

  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::123456789012:policy/cf-prod-role-boundary" }
  }
}

run "grants_only_within_the_boundary" {
  command = plan

  assert {
    condition = jsondecode(aws_iam_policy.role_boundary.policy).Statement == [{
      Sid = "NoIamOrAccount", Effect = "Allow", NotAction = ["iam:*", "organizations:*", "account:*"], Resource = "*"
    }]
    error_message = "The boundary allows everything except IAM, Organizations and account settings."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.stack_roles.policy).Statement :
      s.Sid == "GrantOnlyWithinBoundary" && toset(s.Action) == toset(["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy"]) &&
      s.Condition == { StringEquals = { "iam:PermissionsBoundary" = "arn:aws:iam::123456789012:policy/cf-prod-role-boundary" } }
    ])
    error_message = "CreateRole, PutRolePolicy and AttachRolePolicy need the cf-prod-role-boundary boundary."
  }

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.stack_roles.policy).Statement : [
        for a in flatten([s.Action]) : !contains(["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:PutRolePermissionsBoundary"], a) || s.Effect == "Deny" || try(s.Condition.StringEquals["iam:PermissionsBoundary"], "") == "arn:aws:iam::123456789012:policy/cf-prod-role-boundary"
      ]
    ]))
    error_message = "No statement may grant permissions to a cf-prod-* role without the boundary condition."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.stack_roles.policy).Statement :
      s.Sid == "KeepTheBoundary" && s.Effect == "Deny" && s.Action == ["iam:DeleteRolePermissionsBoundary"]
    ])
    error_message = "The deploy role can never remove the boundary from a cf-prod-* role."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.stack_roles.policy).Statement :
      s.Sid == "BoundaryIsReadOnly" && s.Effect == "Deny" && s.Resource == "arn:aws:iam::123456789012:policy/cf-prod-role-boundary"
    ])
    error_message = "The deploy role can never change the boundary policy."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.stack_roles.policy).Statement :
      s.Sid == "PassStackRoles" && length(s.Condition.StringEquals["iam:PassedToService"]) == 3
    ])
    error_message = "iam:PassRole stays limited to Lambda, AgentCore and API Gateway."
  }

  assert {
    condition     = output.role_boundary_arn == "arn:aws:iam::123456789012:policy/cf-prod-role-boundary"
    error_message = "The boundary ARN is an output, for the repository variable CF_ROLE_BOUNDARY_ARN."
  }
}

run "switch_over_keeps_old_grants" {
  command = plan

  variables {
    enforce_role_boundary = false
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.stack_roles.policy).Statement :
      s.Sid == "GrantBeforeBoundarySwitchOver" && try(s.Condition, null) == null
      ]) && !anytrue([
      for s in jsondecode(aws_iam_role_policy.stack_roles.policy).Statement : s.Sid == "GrantOnlyWithinBoundary"
    ])
    error_message = "During the switch-over the old grants stay, so the next deploy can add the boundary to existing roles."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.stack_roles.policy).Statement :
      s.Sid == "SetTheBoundaryOnly" && s.Action == ["iam:PutRolePermissionsBoundary"]
    ])
    error_message = "The deploy role can set the boundary (and only that one) on existing cf-prod-* roles."
  }
}

run "deploy_role_is_not_a_stack_role" {
  command = plan

  variables {
    role_name = "cf-prod-deploy"
  }

  expect_failures = [var.role_name]
}
