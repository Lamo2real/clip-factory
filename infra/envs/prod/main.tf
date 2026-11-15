# Clip Factory Cloud, production. Applied by .github/workflows/deploy.yml on every push to main, from nothing on
# the first run. The state bucket is passed at init time: terraform init -backend-config=... (backend.hcl.example).
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
  backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project     = "clip-factory"
      Environment = "prod"
      ManagedBy   = "terraform"
    }
  }
}

data "aws_caller_identity" "me" {}

locals {
  name       = "cf-prod"
  account_id = data.aws_caller_identity.me.account_id

  # config/models.json is the only place model ids live (docs/CONTRACTS.md §1).
  models      = jsondecode(file("${path.module}/../../../config/models.json"))
  agent_model = local.models.models[local.models.agentModel]
  model_id    = "${local.models.profilePrefix}.${local.agent_model.modelId}"
  # A call through a cross-region profile is authorised on the profile here and on the foundation model in
  # whichever region serves it (none, for a global profile), hence the region wildcard.
  model_profile_arn = "arn:aws:bedrock:${var.region}:${local.account_id}:inference-profile/${local.model_id}"
  model_invoke_arns = [
    local.model_profile_arn,
    "arn:aws:bedrock:*::foundation-model/${local.agent_model.modelId}",
  ]
}

module "storage" {
  source     = "../../modules/storage"
  name       = local.name
  account_id = local.account_id
}

module "data" {
  source = "../../modules/data"
  name   = local.name
}

module "frontend" {
  source                          = "../../modules/frontend"
  name                            = local.name
  region                          = var.region
  web_bucket_id                   = module.storage.web_bucket_id
  web_bucket_arn                  = module.storage.web_bucket_arn
  web_bucket_regional_domain_name = module.storage.web_bucket_regional_domain_name
  media_bucket                    = module.storage.media_bucket
}

# Here rather than in the storage module: it names the CloudFront origin, and the frontend reads storage.
resource "aws_s3_bucket_cors_configuration" "media" {
  bucket = module.storage.media_bucket_id
  cors_rule {
    allowed_origins = [module.frontend.app_url, var.web_dev_origin]
    allowed_methods = ["PUT", "GET", "HEAD"]
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

module "auth" {
  source      = "../../modules/auth"
  name        = local.name
  owner_email = var.owner_email
  app_url     = module.frontend.app_url
}

module "agent" {
  source            = "../../modules/agent"
  name              = local.name
  region            = var.region
  account_id        = local.account_id
  image_tag         = var.agent_image_tag
  table_name        = module.data.table_name
  table_arn         = module.data.table_arn
  media_bucket      = module.storage.media_bucket
  media_bucket_arn  = module.storage.media_bucket_arn
  model_id          = local.model_id
  model_profile_arn = local.model_profile_arn
  model_invoke_arns = local.model_invoke_arns
}

module "api" {
  source            = "../../modules/api"
  name              = local.name
  region            = var.region
  account_id        = local.account_id
  lambda_zip_path   = var.lambda_zip_path
  app_version       = coalesce(var.app_version, var.agent_image_tag)
  app_url           = module.frontend.app_url
  web_dev_origin    = var.web_dev_origin
  jwt_issuer        = module.auth.issuer
  jwt_audience      = module.auth.user_pool_client_id
  table_name        = module.data.table_name
  table_arn         = module.data.table_arn
  media_bucket      = module.storage.media_bucket
  media_bucket_arn  = module.storage.media_bucket_arn
  agent_runtime_arn = module.agent.runtime_arn
  model_id          = local.model_id
  model_invoke_arns = local.model_invoke_arns
}

module "monitoring" {
  source         = "../../modules/monitoring"
  name           = local.name
  account_id     = local.account_id
  alarm_email    = var.alarm_email
  dlq_name       = module.api.publish_dlq_name
  function_names = module.api.function_names
}
