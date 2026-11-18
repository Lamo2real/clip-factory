# Unqualified ARN built from the name: cf-prod-api invokes it with InvocationType=Event for "Check now".
output "money_function_arn" { value = "arn:aws:lambda:${var.region}:${var.account_id}:function:${local.function_name}" }

output "money_function_name" { value = aws_lambda_function.money.function_name }

# Merged into monitoring (errors alarm, and failed invocations of the daily rule).
output "function_names" { value = { money = aws_lambda_function.money.function_name } }
output "schedule_rule_names" { value = { money = aws_cloudwatch_event_rule.money.name } }
