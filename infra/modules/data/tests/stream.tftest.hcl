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
