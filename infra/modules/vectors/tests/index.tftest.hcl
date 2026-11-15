# Offline plan test (mock AWS provider, no credentials, no AWS calls):
#   cd infra/modules/vectors && terraform init -backend=false && terraform test
#
# The index settings must match what the code sends (docs/CONTRACTS.md §14.6): Titan V2 vectors of 1024 float32
# values compared by cosine distance, and the four display-only keys kept out of the filterable metadata.

mock_provider "aws" {}

variables {
  name       = "cf-test"
  account_id = "123456789012"
}

run "index_matches_the_embedding_contract" {
  command = plan

  assert {
    condition     = aws_s3vectors_vector_bucket.this.vector_bucket_name == "cf-test-vectors-123456789012"
    error_message = "The vector bucket must be named <name>-vectors-<accountId>."
  }

  assert {
    condition     = aws_s3vectors_vector_bucket.this.force_destroy == false
    error_message = "The vector bucket must never be force-destroyed with its vectors."
  }

  assert {
    condition     = aws_s3vectors_index.clips.index_name == "clips"
    error_message = "The index must be named clips."
  }

  assert {
    condition     = aws_s3vectors_index.clips.data_type == "float32" && aws_s3vectors_index.clips.dimension == 1024 && aws_s3vectors_index.clips.distance_metric == "cosine"
    error_message = "The index must be float32, 1024 dimensions, cosine (Titan Text Embeddings V2 defaults)."
  }

  assert {
    condition     = toset(one(aws_s3vectors_index.clips.metadata_configuration).non_filterable_metadata_keys) == toset(["hook", "title", "summary", "performance"])
    error_message = "Exactly hook, title, summary and performance must be non-filterable."
  }

  assert {
    condition     = output.vector_index == "clips"
    error_message = "vector_index output must be clips."
  }
}

run "rejects_a_dimension_titan_cannot_produce" {
  command = plan

  variables {
    dimension = 768
  }

  expect_failures = [var.dimension]
}
