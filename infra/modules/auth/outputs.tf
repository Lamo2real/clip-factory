output "user_pool_id" { value = aws_cognito_user_pool.this.id }
output "user_pool_arn" { value = aws_cognito_user_pool.this.arn }
output "user_pool_client_id" { value = aws_cognito_user_pool_client.web.id }

# The JWT issuer the HTTP API trusts.
output "issuer" { value = "https://${aws_cognito_user_pool.this.endpoint}" }
