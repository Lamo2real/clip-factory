# Unqualified ARN built from the name: cf-prod-api and cf-prod-stats invoke it with InvocationType=Event.
output "campaigns_function_arn" { value = "arn:aws:lambda:${var.region}:${var.account_id}:function:${local.function_name}" }

output "campaigns_function_name" { value = aws_lambda_function.campaigns.function_name }

# Merged into monitoring (the errors alarm).
output "function_names" { value = { campaigns = aws_lambda_function.campaigns.function_name } }
