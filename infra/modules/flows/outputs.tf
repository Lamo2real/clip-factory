# Qualified ARNs (…:function:NAME:live). The API invokes these; an unqualified ARN cannot start an execution.
output "job_flow_alias_arn" { value = aws_lambda_alias.live["job-flow"].arn }
output "clip_flow_alias_arn" { value = aws_lambda_alias.live["clip-flow"].arn }
# Lamo Stories (§45.14): the API starts story publishing on it (STORY_FLOW_ARN).
output "story_flow_alias_arn" { value = aws_lambda_alias.live["story-flow"].arn }

# Unqualified function ARNs: callers' IAM grants "<arn>:*" (every alias, version and durable execution).
output "function_arns" { value = { for k, f in aws_lambda_function.fn : k => f.arn } }

output "function_names" { value = { for k, f in aws_lambda_function.fn : k => f.function_name } }

# The functions that emit the AWS/Lambda DurableExecution* metrics.
output "durable_function_names" { value = { for k, f in aws_lambda_function.fn : k => f.function_name } }
