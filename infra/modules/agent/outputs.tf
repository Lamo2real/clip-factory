output "runtime_arn" { value = aws_bedrockagentcore_agent_runtime.agent.agent_runtime_arn }
output "runtime_name" { value = local.runtime_name }
output "role_arn" { value = aws_iam_role.agent.arn }
output "ecr_repository_url" { value = aws_ecr_repository.agent.repository_url }
output "log_group_name" { value = terraform_data.runtime_logs.input.log_group }
