# https://{id}.execute-api.{region}.amazonaws.com/v1. Platform consoles get {hooks_url}/hooks/{platform} and
# {hooks_url}/oauth/{platform}/callback.
output "hooks_url" { value = aws_api_gateway_stage.v1.invoke_url }
output "hooks_api_id" { value = aws_api_gateway_rest_api.hooks.id }
output "hooks_api_name" { value = aws_api_gateway_rest_api.hooks.name }
output "hooks_stage_name" { value = aws_api_gateway_stage.v1.stage_name }

# Name of the SSM parameter holding the Meta verify token (the value is never an output).
output "verify_token_parameter" { value = aws_ssm_parameter.verify_token.name }

output "function_names" { value = { hooks = aws_lambda_function.fn.function_name } }

# §17.9: the OAuth state key (the value is never an output), the callback base the web shows in the setup steps
# ({oauth_callback_base}/{platform}/callback) and the ARN pattern of the runtime platform secrets.
output "oauth_state_secret_arn" { value = aws_secretsmanager_secret.state_key.arn }
output "oauth_state_secret_name" { value = aws_secretsmanager_secret.state_key.name }
output "oauth_callback_base" { value = "${aws_api_gateway_stage.v1.invoke_url}/oauth" }
output "secret_prefix" { value = local.secret_prefix }
output "platform_secrets_arn" { value = local.platform_secrets_arn }
output "platform_token_secrets_arn" { value = local.platform_token_secrets_arn }
