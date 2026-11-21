output "function_arn" { value = aws_lambda_function.autopost.arn }

output "function_name" { value = aws_lambda_function.autopost.function_name }

# Merged into monitoring (errors alarm, and failed invocations of the hourly rule).
output "function_names" { value = { autopost = aws_lambda_function.autopost.function_name } }
output "schedule_rule_names" { value = { autopost = aws_cloudwatch_event_rule.autopost.name } }
