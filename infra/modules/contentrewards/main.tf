# Content Rewards campaigns (docs/CONTRACTS.md §38.16, docs/DECISIONS.md ADR-62):
#   cf-prod-campaigns  reads a campaign's rules with Claude from the item's own text (the brief cf-prod-api and
#                      cf-prod-stats stored there), fetches a Google Drive or Dropbox logo the owner pasted and copies the
#                      brand's picture. Async only (cf-prod-api and cf-prod-stats invoke it with InvocationType=Event).
#                      Since §41 (ADR-65) its "find" action is the campaign finder's look: it reads Content Rewards'
#                      public campaign pages that robots.txt allows (/robots.txt, /sitemap.xml, /c/campaigns/{uuid}),
#                      anonymously and only from here (never /api/), into the shared CRPUBLIC cache, and matches each
#                      owner from it. CR_FINDER (cr_finder_enabled, default off) turns that action on.
#
# It reads untrusted brand text and fetches outside files, so it has NO secretsmanager action at all and never calls
# Content Rewards' API; since §41 it reads the public pages robots.txt allows. The token stays reachable only from
# cf-prod-api, cf-prod-clip-flow and cf-prod-stats.
# Additive only: a new function, role, policy and log group. No table, index, secret or bucket is created, changed or
# deleted here; the CR secrets are made at runtime and never in Terraform. The role has no DeleteItem.
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

locals {
  tags          = { Component = "contentrewards" }
  function_name = "${var.name}-campaigns"
}

resource "aws_cloudwatch_log_group" "campaigns" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_iam_role" "campaigns" {
  name                 = "${var.name}-fn-campaigns"
  permissions_boundary = var.permissions_boundary_arn == "" ? null : var.permissions_boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
  tags = local.tags
}

# Exactly what api/src/clipfactory_api/contentrewards/handler.py calls, beyond logs and traces. The finder (§41.5)
# needs nothing new: Query, GetItem, PutItem and UpdateItem on CRPUBLIC (CAMP#, PUB#, STATE), CROWNERS and the
# owners' CRFIND, SETUP#, ACCOUNT# and CAMPAIGN# items; old cache items leave by the table's TTL, never DeleteItem.
resource "aws_iam_role_policy" "campaigns" {
  name = "least-privilege"
  role = aws_iam_role.campaigns.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Logs", Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.campaigns.arn}:*" },
      { Sid = "Tracing", Effect = "Allow", Action = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"], Resource = "*" },
      # The CAMPAIGN# item (rules, logo state, brand picture key) and the owner's FOLLOW# items (channel links).
      # Never DeleteItem and never Scan.
      { Sid = "Data", Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"], Resource = [var.table_arn] },
      # Only the campaigns/ prefix: the logo files and the brand picture. Jobs copy their own logo (cf-prod-api).
      { Sid = "CampaignFiles", Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = ["${var.media_bucket_arn}/campaigns/*"] },
      # One Converse call per rules read, the clip agent's model.
      { Sid = "RulesModel", Effect = "Allow", Action = ["bedrock:InvokeModel"], Resource = var.model_invoke_arns },
    ]
  })
}

resource "aws_lambda_function" "campaigns" {
  function_name    = local.function_name
  role             = aws_iam_role.campaigns.arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = "clipfactory_api.contentrewards.handler.handler"
  filename         = var.lambda_zip_path
  source_code_hash = filebase64sha256(var.lambda_zip_path)
  timeout          = 120 # a 60 s model call (one retry on a throttle), a 10 s logo fetch or a finder look (100 s)
  memory_size      = 512

  tracing_config {
    mode = "Active"
  }
  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.campaigns.name
  }
  environment {
    variables = {
      TABLE_NAME      = var.table_name
      MEDIA_BUCKET    = var.media_bucket
      MODEL_ID        = var.model_id
      APP_URL         = var.app_url
      CONTENT_REWARDS = var.content_rewards_enabled ? "on" : "off"
      # §41.6: the "find" action answers {"outcome": "off"} unless CR_FINDER=on. An in-place env change.
      CR_FINDER = var.cr_finder_enabled ? "on" : "off"
    }
  }

  tags = local.tags
  # The role's policy must exist before the function first runs.
  depends_on = [aws_iam_role_policy.campaigns]
}

# Only ever invoked asynchronously. A failed read ends as rulesState "failed" (the card offers Check now), so it is
# never retried. A finder look is never retried either: its lease already counted it (§41.2); the next look comes.
resource "aws_lambda_function_event_invoke_config" "campaigns" {
  function_name                = aws_lambda_function.campaigns.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 3600
}
