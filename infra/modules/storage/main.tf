# Two private buckets: media (uploads, job sources, finished clips, skills; docs/CONTRACTS.md §7) and web (the
# built PWA, read only by CloudFront). The media bucket's CORS is set in envs/prod, because it names the
# CloudFront origin and the frontend module already depends on this one.
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

locals {
  tags = { Component = "storage" }
  buckets = {
    media = "${var.name}-media-${var.account_id}"
    web   = "${var.name}-web-${var.account_id}"
  }
}

resource "aws_s3_bucket" "this" {
  for_each = local.buckets
  bucket   = each.value
  tags     = local.tags

  # Owner rule (2026-11-17): holds the owner's data, so Terraform must never destroy or replace it. The deploy's
  # delete gate (scripts/check-plan-deletes.sh) checks the plan too.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each                = aws_s3_bucket.this
  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# Only the web bucket is versioned: a bad deploy can be rolled back. Media is not, since a declined clip's video
# must really be gone and video versions would double the storage bill.
resource "aws_s3_bucket_versioning" "web" {
  bucket = aws_s3_bucket.this["web"].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "web" {
  bucket     = aws_s3_bucket.this["web"].id
  depends_on = [aws_s3_bucket_versioning.web]
  rule {
    id     = "old-builds"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.this["media"].id

  rule {
    id     = "uploads-14-days"
    status = "Enabled"
    filter {
      prefix = "uploads/"
    }
    expiration {
      days = var.temporary_media_days
    }
  }

  # Lifecycle filters cannot match jobs/*/source/, so the agent tags what it writes there (docs/CONTRACTS.md §7).
  rule {
    id     = "job-sources-14-days"
    status = "Enabled"
    filter {
      and {
        prefix = "jobs/"
        tags   = { (var.temporary_tag_key) = var.temporary_tag_value }
      }
    }
    expiration {
      days = var.temporary_media_days
    }
  }

  # Uploads of up to 5 GB are multipart; a tab closed mid-upload must not leave billed parts behind.
  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_policy" "media" {
  bucket     = aws_s3_bucket.this["media"].id
  depends_on = [aws_s3_bucket_public_access_block.this]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "TlsOnly"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.this["media"].arn, "${aws_s3_bucket.this["media"].arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}
