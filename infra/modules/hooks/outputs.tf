# https://{id}.execute-api.{region}.amazonaws.com/v1. Platform consoles get {hooks_url}/hooks/{platform} and
# {hooks_url}/oauth/{platform}/callback.
output "hooks_url" { value = aws_api_gateway_stage.v1.invoke_url }
output "hooks_api_id" { value = aws_api_gateway_rest_api.hooks.id }
output "hooks_api_name" { value = aws_api_gateway_rest_api.hooks.name }
output "hooks_stage_name" { value = aws_api_gateway_stage.v1.stage_name }

# Name of the SSM parameter holding the Meta verify token (the value is never an output).
output "verify_token_parameter" { value = aws_ssm_parameter.verify_token.name }

output "function_names" { value = { hooks = aws_lambda_function.fn.function_name } }
