# Notifications on the owner's phone and computer (docs/CONTRACTS.md §32, docs/DECISIONS.md ADR-56):
#   cf-prod/notify/vapid  the VAPID key that signs every Web Push message. Generated during apply from an ephemeral
#                         key and written only to Secrets Manager (write-only argument): it is never in a plan, the
#                         state or a log. Never destroyed (prevent_destroy): a new key would silently end every
#                         subscription the owner's devices hold.
#   cf-prod-notify        reads JOB# changes from the table's stream and sends "Your clips are ready", "It stopped"
#                         and (when the owner asks) each new step to the owner's devices.
#
# Additive only: a new secret, function, role, log group and a second consumer on the existing stream. No table,
# index or bucket is created, changed or deleted here. The role has no DeleteItem: a device that is gone is marked
# with a TTL and the table removes it.
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
    tls = { source = "hashicorp/tls", version = ">= 4.1.0, < 5.0.0" } # the ephemeral VAPID key
  }
}

locals {
  tags          = { Component = "notify" }
  function_name = "${var.name}-notify"
  vapid_name    = "${var.name}/notify/vapid"
  # Only job items, and only changes (a new job never needs a notification): filtered before Lambda runs.
  stream_filter = jsonencode({
    eventName = ["MODIFY"]
    dynamodb  = { Keys = { sk = { S = [{ prefix = "JOB#" }] } } }
  })
}

# ---------- VAPID key ----------
ephemeral "tls_private_key" "vapid" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "aws_secretsmanager_secret" "vapid" {
  name        = local.vapid_name
  description = "Signs Clip Factory's Web Push notifications (VAPID, docs/CONTRACTS.md §32.2). Never shown."
  tags        = local.tags

  # Owner rule (2026-11-17): deploys never reset what the owner set up. A new key would turn off notifications on
  # every device, so Terraform must never destroy or replace it. The deploy's delete gate checks the plan too.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_secretsmanager_secret_version" "vapid" {
  secret_id                = aws_secretsmanager_secret.vapid.id
  secret_string_wo         = ephemeral.tls_private_key.vapid.private_key_pem
  secret_string_wo_version = 1 # never bumped: every device would have to turn notifications on again

  # Destroying or replacing the version removes the current key just like the secret would: same rule.
  lifecycle {
    prevent_destroy = true
  }
}

# ---------- cf-prod-notify ----------
resource "aws_cloudwatch_log_group" "notify" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_iam_role" "notify" {
  name                 = "${var.name}-fn-notify"
  permissions_boundary = var.permissions_boundary_arn == "" ? null : var.permissions_boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
  tags = local.tags
}

# Exactly what api/src/clipfactory_api/push/notify.py calls, beyond logs and traces.
resource "aws_iam_role_policy" "notify" {
  name = "least-privilege"
  role = aws_iam_role.notify.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Logs", Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.notify.arn}:*" },
      { Sid = "Tracing", Effect = "Allow", Action = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"], Resource = "*" },
      # Settings and devices (GetItem, Query), the once-only and every-2-minutes marks (PutItem, UpdateItem), and the
      # "gone" mark on a device. Never DeleteItem, never Scan.
      { Sid = "Data", Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem"], Resource = [var.table_arn] },
      # Read by the event source mapping.
      { Sid = "Stream", Effect = "Allow", Action = ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:ListStreams"], Resource = [var.stream_arn] },
      { Sid = "VapidKey", Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [aws_secretsmanager_secret.vapid.arn] },
    ]
  })
}

resource "aws_lambda_function" "notify" {
  function_name    = local.function_name
  role             = aws_iam_role.notify.arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = "clipfactory_api.push.notify.handler"
  filename         = var.lambda_zip_path
  source_code_hash = filebase64sha256(var.lambda_zip_path)
  timeout          = 60 # each push service gets at most 10 s
  memory_size      = 256

  tracing_config {
    mode = "Active"
  }
  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.notify.name
  }
  environment {
    variables = {
      TABLE_NAME        = var.table_name
      PUSH_VAPID_SECRET = local.vapid_name
      PUSH_SUBJECT      = var.app_url # the VAPID "sub": who push services contact about these messages
    }
  }

  tags = local.tags
  # The role's policy must exist before the function first runs.
  depends_on = [aws_iam_role_policy.notify]
}

# A second reader of the stream (cf-prod-broadcast is the first; DynamoDB allows two). Sending is best effort and
# deduplicated, so a failed batch is retried at most twice and dropped after 10 minutes: an old "ready" is not news.
resource "aws_lambda_event_source_mapping" "notify" {
  event_source_arn                   = var.stream_arn
  function_name                      = aws_lambda_function.notify.arn
  starting_position                  = "LATEST"
  batch_size                         = 100
  maximum_batching_window_in_seconds = 2
  maximum_retry_attempts             = 2
  maximum_record_age_in_seconds      = 600
  bisect_batch_on_function_error     = true
  function_response_types            = ["ReportBatchItemFailures"]

  filter_criteria {
    filter {
      pattern = local.stream_filter
    }
  }

  tags = local.tags
}
