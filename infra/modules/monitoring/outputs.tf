output "alarm_topic_arn" { value = aws_sns_topic.alarms.arn }
output "alarm_names" { value = { for k, a in aws_cloudwatch_metric_alarm.lambda_errors : k => a.alarm_name } }
output "schedule_alarm_names" { value = { for k, a in aws_cloudwatch_metric_alarm.schedule_failed : k => a.alarm_name } }
