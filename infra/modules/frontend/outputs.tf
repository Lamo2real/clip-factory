output "app_url" { value = "https://${aws_cloudfront_distribution.web.domain_name}" }
output "distribution_id" { value = aws_cloudfront_distribution.web.id }
output "distribution_arn" { value = aws_cloudfront_distribution.web.arn }
