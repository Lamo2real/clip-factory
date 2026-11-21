# Lamo Stories' runtime: cf-prod-stories-api invokes it (STORIES_AGENT_RUNTIME_ARN, §45.5); never Clip Factory's.
output "runtime_arn" { value = aws_bedrockagentcore_agent_runtime.agent.agent_runtime_arn }
output "runtime_name" { value = local.runtime_name }
output "role_arn" { value = aws_iam_role.agent.arn }
output "ecr_repository_url" { value = aws_ecr_repository.agent.repository_url }
# The tag the runtime runs (from its container URI, so it is the live one, never only the requested one). deploy.yml
# reads it before the plan: a new Lamo Stories image that does not build keeps this one, and Clip Factory still ships.
output "image_tag" {
  value = reverse(split(":", one(one(aws_bedrockagentcore_agent_runtime.agent.agent_runtime_artifact).container_configuration).container_uri))[0]
}
# Watched by monitoring for error lines (§45.15).
output "log_group_name" { value = terraform_data.runtime_logs.input.log_group }

# What the role may call, built from stories/config/models.json (read by the prod wiring test).
output "model_invoke_arns" { value = local.model_invoke_arns }
output "image_model_arn" { value = local.image_model_arn }

# Nova Reel's us-east-1 bucket, or "" while stories_video_us_bucket is off.
output "video_bucket" { value = var.stories_video_us_bucket ? aws_s3_bucket.video_us[0].bucket : "" }
