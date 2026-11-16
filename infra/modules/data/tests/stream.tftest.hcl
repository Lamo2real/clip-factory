# Offline plan test (mock AWS provider, no credentials, no AWS calls):
#   cd infra/modules/data && terraform init -backend=false && terraform test
#
# docs/CONTRACTS.md §6 and §14.2: the table's stream (new and old images) feeds cf-prod-broadcast.

mock_provider "aws" {}

variables {
  name = "cf-test"
}

run "table_has_a_stream_with_both_images" {
  command = plan

  assert {
    condition     = aws_dynamodb_table.this.stream_enabled && aws_dynamodb_table.this.stream_view_type == "NEW_AND_OLD_IMAGES"
    error_message = "The table needs a NEW_AND_OLD_IMAGES stream: deletes are broadcast from OldImage."
  }

  assert {
    condition     = aws_dynamodb_table.this.billing_mode == "PAY_PER_REQUEST" && one(aws_dynamodb_table.this.point_in_time_recovery).enabled
    error_message = "The table stays on demand with point-in-time recovery."
  }
}

# docs/CONTRACTS.md §16.3 and §16.9: the stats poller queries gsi2 (gsi2pk = "STATS", gsi2sk <= "{now}#~").
run "table_has_the_stats_index" {
  command = plan

  assert {
    condition = anytrue([
      for g in aws_dynamodb_table.this.global_secondary_index :
      g.name == "gsi2" && g.projection_type == "ALL" &&
      toset([for k in g.key_schema : "${k.attribute_name}:${k.key_type}"]) == toset(["gsi2pk:HASH", "gsi2sk:RANGE"])
    ])
    error_message = "gsi2 must be keyed gsi2pk (hash) / gsi2sk (range) with projection ALL."
  }

  assert {
    condition = anytrue([
      for g in aws_dynamodb_table.this.global_secondary_index :
      g.name == "gsi1" && toset([for k in g.key_schema : "${k.attribute_name}:${k.key_type}"]) == toset(["gsi1pk:HASH", "gsi1sk:RANGE"])
    ])
    error_message = "gsi1 stays as it was."
  }

  assert {
    condition = toset([for a in aws_dynamodb_table.this.attribute : "${a.name}:${a.type}"]) == toset([
      "pk:S", "sk:S", "gsi1pk:S", "gsi1sk:S", "gsi2pk:S", "gsi2sk:S",
    ])
    error_message = "Only key attributes are declared: pk, sk, gsi1pk, gsi1sk, gsi2pk and gsi2sk (all strings)."
  }
}
