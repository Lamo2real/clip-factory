output "alarm_topic_arn" { value = aws_sns_topic.alarms.arn }
output "alarm_names" { value = { for k, a in aws_cloudwatch_metric_alarm.lambda_errors : k => a.alarm_name } }
# The failed and timed-out execution alarms of each durable function, keyed "<fn key>/<suffix>".
output "durable_alarm_names" { value = { for k, a in aws_cloudwatch_metric_alarm.durable : k => a.alarm_name } }
output "schedule_alarm_names" { value = { for k, a in aws_cloudwatch_metric_alarm.schedule_failed : k => a.alarm_name } }
output "help_alarm_name" { value = one(aws_cloudwatch_metric_alarm.help_model_failures[*].alarm_name) }
# Lamo Stories' agent runtime (§45.15), or null while it is not watched.
output "stories_agent_alarm_name" { value = one(aws_cloudwatch_metric_alarm.stories_agent_errors[*].alarm_name) }
