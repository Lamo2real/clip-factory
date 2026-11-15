# Offline plan test (mock AWS provider, no credentials, no AWS calls):
#   cd infra/modules/frontend && terraform init -backend=false && terraform test
#
# With the default *.cloudfront.net certificate CloudFront always reports MinimumProtocolVersion = TLSv1, whatever
# was sent. Any other value in the config is never applied and shows an in-place update on every plan, so it may
# only be set together with a custom ACM certificate.

mock_provider "aws" {}

variables {
  name                            = "cf-test"
  region                          = "us-east-1"
  web_bucket_id                   = "cf-test-web"
  web_bucket_arn                  = "arn:aws:s3:::cf-test-web"
  web_bucket_regional_domain_name = "cf-test-web.s3.us-east-1.amazonaws.com"
  media_bucket                    = "cf-test-media"
}

run "default_certificate_keeps_the_policy_cloudfront_reports" {
  command = plan

  assert {
    condition     = one(aws_cloudfront_distribution.web.viewer_certificate).cloudfront_default_certificate
    error_message = "The distribution is expected to use the default *.cloudfront.net certificate."
  }

  assert {
    condition = alltrue([
      for vc in aws_cloudfront_distribution.web.viewer_certificate :
      coalesce(vc.minimum_protocol_version, "TLSv1") == "TLSv1" if vc.cloudfront_default_certificate
    ])
    error_message = "minimum_protocol_version must stay unset (TLSv1) with cloudfront_default_certificate = true: CloudFront ignores any other value, so every plan would show a change that never applies."
  }
}
