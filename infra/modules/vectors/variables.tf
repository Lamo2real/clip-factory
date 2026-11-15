variable "name" {
  type        = string
  description = "Resource name prefix (cf-prod)."
}

variable "account_id" {
  type        = string
  description = "AWS account id; the vector bucket name carries it so it is unique."
}

variable "index_name" {
  type        = string
  default     = "clips"
  description = "The one vector index (CF_VECTOR_INDEX / VECTOR_INDEX in the code)."
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.index_name))
    error_message = "index_name must be 3 to 63 lowercase letters, digits, dots or hyphens."
  }
}

variable "dimension" {
  type        = number
  default     = 1024
  description = "Vector length; must equal embeddingModel.dimensions in config/models.json (Titan Text Embeddings V2)."
  validation {
    condition     = contains([256, 512, 1024], var.dimension)
    error_message = "Titan Text Embeddings V2 returns 256, 512 or 1024 dimensions."
  }
}
