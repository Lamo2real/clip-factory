# No trailing slash: the web app appends /v1/... (docs/CONTRACTS.md §4).
output "api_url" { value = aws_apigatewayv2_api.http.api_endpoint }

output "function_names" { value = { for k, f in aws_lambda_function.fn : k => f.function_name } }
output "publish_queue_url" { value = aws_sqs_queue.publish.url }
output "publish_dlq_name" { value = aws_sqs_queue.publish_dlq.name }
output "schedule_group" { value = aws_scheduler_schedule_group.this.name }
output "scheduler_role_arn" { value = aws_iam_role.scheduler.arn }
