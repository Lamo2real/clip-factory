variable "name" {
  type        = string
  description = "Resource name prefix (cf-prod)."
}

variable "region" { type = string }
variable "account_id" { type = string }

variable "lambda_zip_path" {
  type        = string
  description = "api/dist/lambda.zip, built before plan. Every function runs this one package."
}

variable "table_name" { type = string }
variable "table_arn" { type = string }

variable "model_id" {
  type        = string
  description = "Inference profile id the weekly learning calls (global.anthropic.claude-fable-5-1)."
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

variable "platforms_config_path" {
  type        = string
  description = "config/platforms.json (docs/CONTRACTS.md §16.4). The schedule runs at its lowest minIntervalMinutes."
  validation {
    condition     = fileexists(var.platforms_config_path)
    error_message = "platforms_config_path must point at config/platforms.json."
  }
}

variable "log_retention_days" {
  type    = number
  default = 30
}
