# Watched for errors by modules/monitoring (merged into function_names, keyed stories-api).
output "function_names" { value = { stories-api = aws_lambda_function.fn.function_name } }
output "function_name" { value = aws_lambda_function.fn.function_name }
output "function_arn" { value = aws_lambda_function.fn.arn }
# modules/api integrates the /v1/workspaces routes and the Lamo Stories OAuth callback with it.
output "invoke_arn" { value = aws_lambda_function.fn.invoke_arn }
output "role_arn" { value = aws_iam_role.fn.arn }
output "log_group_name" { value = aws_cloudwatch_log_group.fn.name }
