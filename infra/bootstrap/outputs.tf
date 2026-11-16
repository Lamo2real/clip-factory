# Put this in the repository variable CF_DEPLOY_ROLE_ARN.
output "deploy_role_arn" { value = aws_iam_role.deploy.arn }

# Put this in the repository variable CF_ROLE_BOUNDARY_ARN: every cf-prod-* role then carries it.
output "role_boundary_arn" { value = aws_iam_policy.role_boundary.arn }
