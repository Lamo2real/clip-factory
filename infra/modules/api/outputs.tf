# No trailing slash: the web app appends /v1/... (docs/CONTRACTS.md §4).
output "api_url" { value = aws_apigatewayv2_api.http.api_endpoint }

output "function_names" { value = { for k, f in aws_lambda_function.fn : k => f.function_name } }

# cf-prod-api's log group, where monitoring counts Ask Clip Factory's model fallbacks (§19.9).
output "log_group_name" { value = aws_cloudwatch_log_group.fn["api"].name }

# Lamo Stories' own OAuth callback base (§45.13.3): {apiUrl}/v1/stories-oauth. Lamo Stories' own developer apps
# register {stories_callback_base}/{platform}/callback; cf-prod-hooks forwards w1. states there.
output "stories_callback_base" { value = "${aws_apigatewayv2_api.http.api_endpoint}/v1/stories-oauth" }
output "stories_route_keys" { value = toset(keys(aws_apigatewayv2_route.stories)) }
