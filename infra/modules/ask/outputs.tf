output "ask_function_name" { value = aws_lambda_function.ask.function_name }
# Unqualified ARN built from the name: cf-prod-api invokes it with InvocationType=Event.
output "ask_function_arn" { value = "arn:aws:lambda:${var.region}:${var.account_id}:function:${local.function_name}" }
output "log_group_name" { value = aws_cloudwatch_log_group.ask.name }

# Merged into monitoring (errors alarm).
output "function_names" { value = { ask = aws_lambda_function.ask.function_name } }
