# "What worked before" (docs/CONTRACTS.md §14.6): an S3 Vectors bucket and the one index `clips`, holding one
# Titan Text Embeddings V2 vector per clip. Pay per request and per GB stored; nothing runs while idle.
#
# Every argument of an S3 Vectors index forces a new index (and so the loss of its vectors), so the values below are
# frozen: a new non-filterable key or another dimension means a new index name and a backfill.
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

locals {
  tags = { Component = "vectors" }
}

# Encrypted with SSE-S3, the S3 Vectors default, so no encryption_configuration is sent.
resource "aws_s3vectors_vector_bucket" "this" {
  vector_bucket_name = "${var.name}-vectors-${var.account_id}"
  force_destroy      = false
  tags               = local.tags
}

resource "aws_s3vectors_index" "clips" {
  vector_bucket_name = aws_s3vectors_vector_bucket.this.vector_bucket_name
  index_name         = var.index_name
  data_type          = "float32"
  dimension          = var.dimension
  distance_metric    = "cosine"

  # Returned with query results but not usable in filters; keeps the filterable metadata (userId, momentType,
  # platforms, status, scoreBucket) far below the 2 KB limit.
  metadata_configuration {
    non_filterable_metadata_keys = ["hook", "title", "summary", "performance"]
  }

  tags = local.tags
}
