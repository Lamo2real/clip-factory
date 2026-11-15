# Read by deploy.yml and scripts/write-web-config.sh (docs/CONTRACTS.md §10).
output "app_url" { value = module.frontend.app_url }
output "api_url" { value = module.api.api_url }
output "region" { value = var.region }
output "user_pool_id" { value = module.auth.user_pool_id }
output "user_pool_client_id" { value = module.auth.user_pool_client_id }
output "web_bucket" { value = module.storage.web_bucket }
output "distribution_id" { value = module.frontend.distribution_id }
output "media_bucket" { value = module.storage.media_bucket }
output "table_name" { value = module.data.table_name }
output "agent_runtime_arn" { value = module.agent.runtime_arn }
output "ecr_repository_url" { value = module.agent.ecr_repository_url }
