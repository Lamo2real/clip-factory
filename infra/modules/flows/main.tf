# The two durable Lambda functions of docs/CONTRACTS.md §14.4 and §14.5:
#   cf-prod-job-flow   starts the agent for one job and waits (no compute) for its callback, up to 8.5 hours (41.5
#                      with a wait of up to 24 h for the owner's Mac when YouTube blocks the cloud, §35). A
#                      missed heartbeat (15 minutes) fails the job. Replaces the watchdog.
#   cf-prod-clip-flow  publishes a kept clip (start/check/finish per platform with the owner's tokens from Secrets
#                      Manager, §17.6), waits 48 hours (no compute), reads metrics, distils a learning and
#                      updates the clip's vector. Replaces the publish queue, its DLQ, the publisher, the Scheduler
#                      group and role, and perf-check.
#
# Durable execution can only be switched on when a function is created. Executions start through the alias `live`
# (an execution needs a qualified ARN) and stay pinned to the version they started on, so every code change
# publishes a new version and old versions are kept. Durable functions support no Lambda destinations.
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

locals {
  tags            = { Component = "flows" }
  table_resources = [var.table_arn, "${var.table_arn}/index/*"]

  # CheckpointDurableExecution and GetDurableExecutionState on function:NAME:*, plus basic CloudWatch Logs.
  durable_basic_policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicDurableExecutionRolePolicy"

  functions = {
    job-flow = {
      handler = "clipfactory_api.flows.job_flow.handler"
      memory  = 256
      timeout = 120 # one replay of the handler; waiting for the callback costs nothing
      # 8 h agent run, then (Mac fetches it, docs/CONTRACTS.md §35) up to 24 h waiting for the owner's Mac and a
      # second 8 h run on its video, with start and finish steps around each (41.5 h). Raised in place: Terraform
      # replaces a function only when durable_config is added or removed; running executions keep their own timeout.
      execution_timeout = 149400
      env = {
        TABLE_NAME        = var.table_name
        AGENT_RUNTIME_ARN = var.agent_runtime_arn
      }
    }
    clip-flow = {
      handler           = "clipfactory_api.flows.clip_flow.handler"
      memory            = 1024   # §17.9: 8 MB upload chunks and resumable platform uploads
      timeout           = 900    # a replay may publish a video or call Bedrock
      execution_timeout = 259200 # 48 h wait + publish, metrics and distil (3 days)
      env = {
        TABLE_NAME     = var.table_name
        MEDIA_BUCKET   = var.media_bucket
        MODEL_ID       = var.model_id
        EMBED_MODEL_ID = var.embed_model_id
        VECTOR_BUCKET  = var.vector_bucket
        VECTOR_INDEX   = var.vector_index
        SECRET_PREFIX  = var.secret_prefix # §17.6: the owner's platform keys and tokens
      }
    }
  }

  # Exactly what the code calls (api/src/clipfactory_api/flows/*.py), beyond checkpoints, logs and traces.
  permissions = {
    job-flow = [
      # Read the job and write ready/failed, each conditional on its sessionId.
      { Sid = "JobItem", Action = ["dynamodb:GetItem", "dynamodb:UpdateItem"], Resource = [var.table_arn] },
      # Step start-agent (process_job) and step stop-session; the session sub-resources are part of both calls.
      { Sid = "Agent", Action = ["bedrock-agentcore:InvokeAgentRuntime", "bedrock-agentcore:StopRuntimeSession"], Resource = [var.agent_runtime_arn, "${var.agent_runtime_arn}/*"] },
    ]
    clip-flow = [
      # The same table read/write set the API uses for posts, clips and learnings.
      {
        Sid      = "Data"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:BatchGetItem", "dynamodb:TransactWriteItems", "dynamodb:ConditionCheckItem"]
        Resource = local.table_resources
      },
      # Platform adapters upload the finished clip (phase 2).
      { Sid = "ClipFiles", Action = ["s3:GetObject"], Resource = ["${var.media_bucket_arn}/jobs/*"] },
      # Step distil reads the owner's skills (§18.6): keys come from the table, so no s3:ListBucket.
      { Sid = "Skills", Action = ["s3:GetObject"], Resource = ["${var.media_bucket_arn}/skills/*"] },
      # Step distil (Converse with Claude Fable through the global profile) and the clip text embedding (Titan).
      { Sid = "Models", Action = ["bedrock:InvokeModel"], Resource = concat(var.model_invoke_arns, [var.embed_model_arn]) },
      # Step upsert-vector: read the clip's vector and metadata, write it back with the measured performance.
      { Sid = "Vectors", Action = ["s3vectors:GetVectors", "s3vectors:PutVectors"], Resource = [var.vector_index_arn] },
      # §17.6: read the app keys and tokens; write a refreshed (rotated) token back, only to {platform}/token.
      # Never create or delete, never write the app keys or pending choices.
      { Sid = "PlatformSecretsRead", Action = ["secretsmanager:GetSecretValue"], Resource = [var.platform_secrets_arn] },
      { Sid = "PlatformTokens", Action = ["secretsmanager:PutSecretValue"], Resource = [var.platform_token_secrets_arn] },
    ]
  }
}

resource "aws_cloudwatch_log_group" "fn" {
  for_each          = local.functions
  name              = "/aws/lambda/${var.name}-${each.key}"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_iam_role" "fn" {
  for_each             = local.functions
  name                 = "${var.name}-fn-${each.key}"
  permissions_boundary = var.permissions_boundary_arn == "" ? null : var.permissions_boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "durable" {
  for_each   = local.functions
  role       = aws_iam_role.fn[each.key].name
  policy_arn = local.durable_basic_policy_arn
}

resource "aws_iam_role_policy" "fn" {
  for_each = local.functions
  name     = "least-privilege"
  role     = aws_iam_role.fn[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        { Sid = "Logs", Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.fn[each.key].arn}:*" },
        { Sid = "Tracing", Effect = "Allow", Action = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"], Resource = "*" },
      ],
      [for p in local.permissions[each.key] : merge({ Effect = "Allow" }, p)],
    )
  })
}

resource "aws_lambda_function" "fn" {
  for_each         = local.functions
  function_name    = "${var.name}-${each.key}"
  role             = aws_iam_role.fn[each.key].arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = each.value.handler
  filename         = var.lambda_zip_path
  source_code_hash = filebase64sha256(var.lambda_zip_path)
  timeout          = each.value.timeout
  memory_size      = each.value.memory
  publish          = true # the alias points at a numbered version, never $LATEST

  durable_config {
    execution_timeout = each.value.execution_timeout
    retention_period  = var.retention_days
  }

  tracing_config {
    mode = "Active"
  }
  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.fn[each.key].name
  }
  environment {
    variables = each.value.env
  }

  # Deleting a durable function first stops its running executions, which can take up to an hour.
  timeouts {
    delete = "60m"
  }

  tags       = local.tags
  depends_on = [aws_iam_role_policy.fn, aws_iam_role_policy_attachment.durable]
}

# The API starts executions on this alias (JOB_FLOW_ARN / CLIP_FLOW_ARN), never on the bare function.
resource "aws_lambda_alias" "live" {
  for_each         = local.functions
  name             = "live"
  description      = "Current version; new executions start here, running ones keep their own version."
  function_name    = aws_lambda_function.fn[each.key].function_name
  function_version = aws_lambda_function.fn[each.key].version
}
