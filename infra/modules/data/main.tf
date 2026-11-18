# The single DynamoDB table (docs/CONTRACTS.md §6): on demand, point-in-time recovery, TTL, two GSIs, and a stream
# (new and old images) that feeds the live-update broadcaster (§14.2).
#   gsi1  posts of a clip and other lookups (§6).
#   gsi2  posts whose numbers are due: gsi2pk "STATS", gsi2sk "{statsDueAt}#{postId}" (§16.3). Sparse: only posts
#         inside their 30-day window carry the keys. Added online; existing items need no migration.
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

resource "aws_dynamodb_table" "this" {
  name                        = "${var.name}-data"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "pk"
  range_key                   = "sk"
  deletion_protection_enabled = var.deletion_protection
  stream_enabled              = true
  stream_view_type            = "NEW_AND_OLD_IMAGES"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  attribute {
    name = "gsi1pk"
    type = "S"
  }
  attribute {
    name = "gsi1sk"
    type = "S"
  }
  attribute {
    name = "gsi2pk"
    type = "S"
  }
  attribute {
    name = "gsi2sk"
    type = "S"
  }

  global_secondary_index {
    name            = "gsi1"
    projection_type = "ALL"
    key_schema {
      attribute_name = "gsi1pk"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "gsi1sk"
      key_type       = "RANGE"
    }
  }

  global_secondary_index {
    name            = "gsi2"
    projection_type = "ALL"
    key_schema {
      attribute_name = "gsi2pk"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "gsi2sk"
      key_type       = "RANGE"
    }
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true # AWS managed key; no customer key to administer for one owner
  }

  tags = { Component = "data" }

  # Owner rule (2026-11-17): holds the owner's data, so Terraform must never destroy or replace it. The deploy's
  # delete gate (scripts/check-plan-deletes.sh) checks the plan too.
  lifecycle {
    prevent_destroy = true
  }
}
