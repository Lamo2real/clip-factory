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

# docs/CONTRACTS.md §14.8.
output "ws_url" { value = module.realtime.ws_url } # config.json wsUrl (required by write-web-config.sh)
output "hooks_url" { value = module.hooks.hooks_url }
output "vector_bucket" { value = module.vectors.vector_bucket }
output "vector_index" { value = module.vectors.vector_index }
output "job_flow_alias_arn" { value = module.flows.job_flow_alias_arn }
output "clip_flow_alias_arn" { value = module.flows.clip_flow_alias_arn }
output "hooks_verify_token_parameter" { value = module.hooks.verify_token_parameter }

# docs/CONTRACTS.md §16.9.
output "stats_function_name" { value = module.stats.function_names["stats"] }
output "learn_function_name" { value = module.stats.function_names["learn"] }
output "stats_rule_name" { value = module.stats.stats_rule_name }
output "stats_tick_minutes" { value = module.stats.stats_tick_minutes } # lowest minIntervalMinutes in config/platforms.json
