# The PWA: CloudFront in front of the private web bucket (Origin Access Control), HTTPS only, security headers,
# and a viewer-request function that serves index.html for app routes (single-page app).
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

locals {
  tags = { Component = "frontend" }

  # AWS managed cache policies.
  caching_optimized = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  caching_disabled  = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"

  # Fetched on every visit so a deploy reaches the owner at once (the service worker and runtime config included).
  # /version.json drives the "new version" banner and /downloads/manifest.json says which desktop downloads exist
  # (docs/CONTRACTS.md §12): a cached copy would hide an update or offer a file that is gone.
  no_cache_paths = [
    "/index.html",
    "/config.json",
    "/sw.js",
    "/manifest.webmanifest",
    "/version.json",
    "/downloads/manifest.json",
  ]

  # The desktop installers (.dmg, .exe, .AppImage) keep their names and are overwritten on each release, so edges
  # keep them only briefly. Must follow /downloads/manifest.json: CloudFront uses the first matching behaviour.
  downloads_path = "/downloads/*"

  # Presigned uploads (PUT) and clip and cover downloads come straight from the media bucket.
  media_origins = "https://${var.media_bucket}.s3.${var.region}.amazonaws.com https://${var.media_bucket}.s3.amazonaws.com"

  # The browser talks to itself, the HTTP API, the WebSocket API (live updates, wss://), Cognito (SRP sign-in and
  # token refresh) and the media bucket. The APIs' hosts are matched by wildcard: naming them would make this module
  # wait for the APIs, whose CORS and redirects already wait for this distribution's address.
  csp = join("; ", [
    "default-src 'self'",
    "script-src 'self'",
    # React's style props and the liquid-glass layers set inline styles; scripts stay strict.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    # Source thumbnails come from YouTube, Twitch and Kick CDNs; images cannot run code.
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: ${local.media_origins}",
    "connect-src 'self' https://*.execute-api.${var.region}.amazonaws.com wss://*.execute-api.${var.region}.amazonaws.com https://cognito-idp.${var.region}.amazonaws.com ${local.media_origins}",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ])
}

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "${var.name}-web"
  description                       = "CloudFront reads the Clip Factory web bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_function" "spa" {
  name    = "${var.name}-spa-rewrite"
  runtime = "cloudfront-js-2.0"
  comment = "Serve index.html for app routes (paths without a file extension)"
  publish = true
  code    = file("${path.module}/spa-rewrite.js")
}

# Short-lived edge copies for the overwritten installers; an object uploaded with its own Cache-Control is honoured
# up to the maximum. No cookies, headers or query strings reach S3 or split the cache.
resource "aws_cloudfront_cache_policy" "downloads" {
  name        = "${var.name}-downloads-short-ttl"
  comment     = "Desktop installers: overwritten on each release, cached at most 5 minutes"
  min_ttl     = 0
  default_ttl = 60
  max_ttl     = 300
  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = false
    enable_accept_encoding_gzip   = false
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

resource "aws_cloudfront_response_headers_policy" "security" {
  name = "${var.name}-security-headers"
  security_headers_config {
    content_security_policy {
      content_security_policy = local.csp
      override                = true
    }
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
  }
  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = "camera=(), microphone=(), geolocation=(), payment=()"
      override = true
    }
  }
}

resource "aws_cloudfront_distribution" "web" {
  enabled             = true
  comment             = "Clip Factory web app"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  http_version        = "http2and3"
  is_ipv6_enabled     = true

  origin {
    origin_id                = "web"
    domain_name              = var.web_bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  # Hashed build assets; app routes are rewritten to /index.html by the function. index.html itself is uploaded
  # with Cache-Control: no-cache, which this policy honours.
  default_cache_behavior {
    target_origin_id           = "web"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.caching_optimized
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa.arn
    }
  }

  dynamic "ordered_cache_behavior" {
    for_each = local.no_cache_paths
    content {
      path_pattern               = ordered_cache_behavior.value
      target_origin_id           = "web"
      viewer_protocol_policy     = "redirect-to-https"
      allowed_methods            = ["GET", "HEAD"]
      cached_methods             = ["GET", "HEAD"]
      compress                   = true
      cache_policy_id            = local.caching_disabled
      response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
    }
  }

  # After the no-cache paths, so /downloads/manifest.json keeps its own behaviour. No SPA rewrite here: a missing
  # installer must stay a 403/404, never index.html saved as "Clip-Factory.dmg".
  ordered_cache_behavior {
    path_pattern               = local.downloads_path
    target_origin_id           = "web"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = false # installers are already compressed
    cache_policy_id            = aws_cloudfront_cache_policy.downloads.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # The default *.cloudfront.net certificate. With it CloudFront always applies the TLSv1 security policy whatever
  # minimum_protocol_version says, so setting a stricter one here is never applied and shows a change on every plan.
  # A TLS 1.2 floor needs a custom domain with an ACM certificate in us-east-1: set acm_certificate_arn,
  # ssl_support_method = "sni-only" and minimum_protocol_version = "TLSv1.2_2021" then, and drop this flag.
  # tests/viewer_certificate.tftest.hcl keeps the two from being combined again.
  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = local.tags
}

resource "aws_s3_bucket_policy" "web" {
  bucket = var.web_bucket_id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "CloudFrontOnly"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${var.web_bucket_arn}/*"
        Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.web.arn } }
      },
      {
        Sid       = "TlsOnly"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [var.web_bucket_arn, "${var.web_bucket_arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  })
}
