output "vector_bucket" { value = aws_s3vectors_vector_bucket.this.vector_bucket_name }
output "vector_bucket_arn" { value = aws_s3vectors_vector_bucket.this.vector_bucket_arn }
output "vector_index" { value = aws_s3vectors_index.clips.index_name }
output "vector_index_arn" { value = aws_s3vectors_index.clips.index_arn }
