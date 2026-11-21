output "function_arn" { value = aws_lambda_function.autopost.arn }

output "function_name" { value = aws_lambda_function.autopost.function_name }

# Merged into monitoring's function_names (the <fn>-errors alarm).
output "function_names" { value = { autopost = aws_lambda_function.autopost.function_name } }
# Not merged into monitoring's schedule_rule_names: its 15-minute alarm cannot fire for an hourly rule, and it would
# make a second alarm of the same name. The rule's failed invocations are watched here (schedule_alarm_names).
output "schedule_rule_names" { value = { autopost = aws_cloudwatch_event_rule.autopost.name } }
output "schedule_alarm_names" { value = { autopost = aws_cloudwatch_metric_alarm.hourly_failed.alarm_name } }
