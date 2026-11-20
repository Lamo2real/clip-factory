# cf-prod-api reads the key to give the browser its public half and to send "Send a test" (§32.3).
output "vapid_secret_name" { value = aws_secretsmanager_secret.vapid.name }
output "vapid_secret_arn" { value = aws_secretsmanager_secret.vapid.arn }

output "notify_function_name" { value = aws_lambda_function.notify.function_name }

# Merged into monitoring (errors alarm).
output "function_names" { value = { notify = aws_lambda_function.notify.function_name } }
