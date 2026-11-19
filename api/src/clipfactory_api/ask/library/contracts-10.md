## 10. Terraform outputs (read by deploy.yml)

`app_url`, `api_url`, `region`, `user_pool_id`, `user_pool_client_id`, `web_bucket`, `distribution_id`,
`media_bucket`, `table_name`, `agent_runtime_arn`, `ecr_repository_url`, and from §14: `ws_url`, `hooks_url`,
`vector_bucket`, `vector_index`, `job_flow_alias_arn`, `clip_flow_alias_arn`, and from §16: `stats_function_name`,
`learn_function_name`, `stats_rule_name`, `stats_tick_minutes`, and from §17: `oauth_callback_base`.
`write-web-config.sh` requires `ws_url` and `oauth_callback_base`.

Terraform input variables (envs/prod): `region`, `owner_email`, `agent_image_tag`, `lambda_zip_path`
(default `../../../api/dist/lambda.zip`), `alarm_email` (optional; deploy.yml sets it from the secret
`CF_ALARM_EMAIL`, else `CF_OWNER_EMAIL`, so prod alarms always email someone), `web_dev_origin` (default `http://localhost:5173`),
`manage_api_gateway_account` (bool, default `true`, §14.3), `role_permissions_boundary_arn` (default empty; deploy.yml
sets it from the repository variable `CF_ROLE_BOUNDARY_ARN`, and every `cf-prod-*` IAM role then carries that
permissions boundary, docs/DEPLOYMENT.md §2). Every log group keeps logs 30 days (`log_retention_days`), including the
AgentCore runtime's `/aws/bedrock-agentcore/runtimes/<runtime id>-DEFAULT`, which the apply creates if missing.
