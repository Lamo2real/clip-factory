# What the web app connects to (config.json wsUrl).
output "ws_url" { value = local.ws_url }
output "ws_api_id" { value = aws_apigatewayv2_api.ws.id }

# Management endpoint for PostToConnection (WS_ENDPOINT).
output "ws_endpoint" { value = local.ws_endpoint }

# What may post to the owner's connections (cf-prod-ask streams its answers there, §28.5).
output "ws_connections_arn" {
  value = "arn:aws:execute-api:${var.region}:${var.account_id}:${aws_apigatewayv2_api.ws.id}/${local.stage_name}/POST/@connections/*"
}

# Watched for errors. The authorizer is left out on purpose: refusing a token raises by design.
output "function_names" {
  value = { for k, f in aws_lambda_function.fn : k => f.function_name if k != "ws-authorizer" }
}

# The stream consumer, for the iterator-age alarm.
output "broadcast_function_name" { value = aws_lambda_function.fn["broadcast"].function_name }
