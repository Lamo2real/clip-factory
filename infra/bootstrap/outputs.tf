# Put this in the repository variable CF_DEPLOY_ROLE_ARN.
output "deploy_role_arn" { value = aws_iam_role.deploy.arn }
