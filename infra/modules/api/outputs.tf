# No trailing slash: the web app appends /v1/... (docs/CONTRACTS.md §4).
output "api_url" { value = aws_apigatewayv2_api.http.api_endpoint }

output "function_names" { value = { for k, f in aws_lambda_function.fn : k => f.function_name } }
