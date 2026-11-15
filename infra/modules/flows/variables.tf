variable "name" {
  type        = string
  description = "Resource name prefix (cf-prod)."
}

variable "lambda_zip_path" {
  type        = string
  description = "api/dist/lambda.zip, built before plan (it vendors the durable execution SDK)."
}

variable "table_name" { type = string }
variable "table_arn" { type = string }
variable "media_bucket" { type = string }
variable "media_bucket_arn" { type = string }

variable "agent_runtime_arn" {
  type        = string
  description = "The AgentCore runtime job-flow starts (process_job) and stops."
}

variable "model_id" {
  type        = string
  description = "Inference profile id the distil step calls (global.anthropic.claude-fable-5-1)."
}

variable "model_invoke_arns" {
  type        = list(string)
  description = "Every ARN a Bedrock call through that profile touches."
}

variable "embed_model_id" {
  type        = string
  description = "Titan Text Embeddings V2 model id (in-Region, no profile)."
}

variable "embed_model_arn" { type = string }
variable "vector_bucket" { type = string }
variable "vector_index" { type = string }
variable "vector_index_arn" { type = string }

variable "retention_days" {
  type        = number
  default     = 14
  description = "Days a finished durable execution (and its name) is kept."
  validation {
    condition     = var.retention_days >= 1 && var.retention_days <= 90
    error_message = "Durable execution retention must be 1 to 90 days."
  }
}

variable "log_retention_days" {
  type    = number
  default = 30
}
