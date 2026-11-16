# Unqualified ARNs (built from the names): cf-prod-api invokes both with InvocationType=Event.
output "stats_function_arn" { value = "${local.arn_prefix}-stats" }
output "learn_function_arn" { value = "${local.arn_prefix}-learn" }

output "stats_rule_name" { value = aws_cloudwatch_event_rule.stats.name }

# Minutes between automatic ticks: the lowest minIntervalMinutes in config/platforms.json.
output "stats_tick_minutes" { value = local.stats_tick }

# Merged into monitoring (errors alarms).
output "function_names" { value = { for k, f in aws_lambda_function.fn : k => f.function_name } }

# Watched for failed invocations (monitoring).
output "schedule_rule_names" { value = { stats = aws_cloudwatch_event_rule.stats.name } }
