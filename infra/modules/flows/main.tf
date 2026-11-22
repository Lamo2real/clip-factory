# The durable Lambda functions of docs/CONTRACTS.md §14.4, §14.5 and §45.15:
#   cf-prod-job-flow   starts the agent for one job and waits (no compute) for its callback, up to 8.5 hours (41.5
#                      with a wait of up to 24 h for the owner's Mac when YouTube blocks the cloud, §35). A
#                      missed heartbeat (15 minutes) fails the job. Replaces the watchdog.
#   cf-prod-clip-flow  publishes a kept clip (start/check/finish per platform with the owner's tokens from Secrets
#                      Manager, §17.6), waits 48 hours (no compute), reads metrics, distils a learning and
#                      updates the clip's vector. Replaces the publish queue, its DLQ, the publisher, the Scheduler
#                      group and role, and perf-check.
#   cf-prod-story-flow Lamo Stories (§45.14, ADR-73): sends one approved story video to the workspace's own social
#                      accounts, checking each destination before every platform call, and reads its numbers at 1 h,
#                      24 h, 72 h and 7 days. Its own role: only the workspace partitions, tokens and files, Clip
#                      Factory's YouTube, TikTok and X app keys (read only), five attributes of Lamo Clips' ACCOUNT#
#                      items (read only) and the rate budgets; never a Lamo Clips token, and no other Lamo Clips item.
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

  # Lamo Stories may use Clip Factory's developer app, on the owner's choice, only for these three platforms
  # (docs/CONTRACTS.md §45.30; Facebook and Instagram always use Lamo Stories' own Meta app, whose keys live under
  # <name>/workspaces/). The story flow reads only their app keys, <name>/platforms/{platform}/app*, never Meta's,
  # Twitch's or Kick's and never a {platform}/token or /pending secret. No "-" before the "*" (as cf-prod-hooks' app
  # keys): when Lamo Clips' keys were deleted, Secrets Manager checks the bare name and the read must give
  # ResourceNotFoundException ("not set up", §45.14), not AccessDenied.
  story_shared_app_platforms = ["youtube", "tiktok", "x"]
  story_app_secret_arns      = [for p in local.story_shared_app_platforms : "${trimsuffix(var.platform_secrets_arn, "*")}${p}/app*"]

  # The attributes of Clip Factory's items the story flow may read, and only with GetItem (§45.15, §45.37): its
  # ACCOUNT#{platform}'s id and username ("handle"), what "never Clip Factory's own account" compares (G8 b), and its
  # SETTINGS item's autoPost, the schedule whose share Lamo Stories leaves to it on a shared developer app (G6 b). IAM
  # limits partitions, not sort keys; the code reads only ACCOUNT#{platform} (pk, sk, platform, status, accountId,
  # handle) and SETTINGS (pk, sk, autoPost) with a ProjectionExpression of those names, so nothing else of
  # USER#{userId} is ever returned. Widened in place (more names in the same statement): nothing is replaced.
  clips_account_attributes = ["pk", "sk", "platform", "status", "accountId", "handle", "autoPost"]

  # Clip Factory's own rate counters (db.rate_pk): the story flow reads them, never writes them (§45.37 G6 a).
  clips_rate_keys = ["RATE#youtube", "RATE#tiktok", "RATE#x", "RATE#instagram", "RATE#facebook"]

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
        # §38.12: campaign posts are sent to Content Rewards only while this is "on".
        CONTENT_REWARDS = var.content_rewards_enabled ? "on" : "off"
      }
    }
    # A new function (its durable_config is set at creation); job-flow and clip-flow are not touched.
    story-flow = {
      handler = "clipfactory_api.flows.story_flow.handler"
      memory  = 1024 # the same 8 MB upload chunks and resumable uploads as clip-flow (§17.9)
      timeout = 900  # a replay may upload a video
      # 40 days: numbers at 1 h, 24 h, 72 h and 7 days after each platform's post, the longest publish loop, and a
      # post that waits for room on Clip Factory's shared developer app (§45.37 G6: up to the next month on X).
      # Raised in place, like job-flow's: Terraform replaces a function only when durable_config is added or removed;
      # running executions keep their own timeout.
      execution_timeout = 3456000
      env = {
        TABLE_NAME       = var.table_name
        MEDIA_BUCKET     = var.media_bucket
        WS_SECRET_PREFIX = var.ws_secret_prefix # §45.13.1: the workspace's own tokens
        SECRET_PREFIX    = var.secret_prefix    # only for the five platform app keys, read only
        # The rate budgets and publish settings come from config/platforms.json in the zip, as for clip-flow.
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
      # §40.5.11: Your bank's secrets (<name>/platforms/bank/app, the bank key; …/bank/token_{linkId}, each bank
      # link's session) are read only by cf-prod-api, cf-prod-hooks and cf-prod-money. The explicit Effect wins over
      # the merge's Allow; an in-place change of this role policy.
      { Sid = "NoBankSecrets", Effect = "Deny", Action = ["secretsmanager:GetSecretValue"], Resource = ["${trimsuffix(var.platform_secrets_arn, "*")}bank/*"] },
    ]
    # docs/CONTRACTS.md §45.15 and ADR-73: its own statements, not clip-flow's. No Delete, no Scan, no index, no
    # Bedrock, no other S3 prefix, no Lamo Clips token.
    story-flow = [
      # Writes only in a workspace partition (USER#{userId}#WS#{workspaceId}: the story, its publishing jobs and
      # activity) and the shared rate budgets (RATE#{platform}: one X bill, one Google project, §45.14).
      {
        Sid       = "WorkspaceWrites"
        Action    = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:TransactWriteItems", "dynamodb:ConditionCheckItem"]
        Resource  = [var.table_arn]
        Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["USER#*#WS#*", "RATE#*"] } }
      },
      # Reads the workspace partitions, the workspace registry and the budgets.
      {
        Sid       = "Reads"
        Action    = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:BatchGetItem"]
        Resource  = [var.table_arn]
        Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["USER#*#WS#*", "USER#*#WSREG", "RATE#*"] } }
      },
      # Lamo Clips' ACCOUNT#{platform} item (the "never Clip Factory's own account" rule) and its settings' autoPost
      # (the share it keeps on a shared app), read only: GetItem with a ProjectionExpression of those names; no
      # Query, no other attribute, nothing returned by a write.
      {
        Sid      = "ClipsAccountRead"
        Action   = ["dynamodb:GetItem"]
        Resource = [var.table_arn]
        Condition = {
          "ForAllValues:StringLike"   = { "dynamodb:LeadingKeys" = ["USER#*"] }
          "ForAllValues:StringEquals" = { "dynamodb:Attributes" = local.clips_account_attributes }
          "StringEqualsIfExists"      = { "dynamodb:Select" = "SPECIFIC_ATTRIBUTES", "dynamodb:ReturnValues" = "NONE" }
        }
      },
      # The finished story video (final/v{n}.mp4) the platform publishers upload.
      { Sid = "StoryFiles", Action = ["s3:GetObject"], Resource = ["${var.media_bucket_arn}/ws/*"] },
      # The workspace's tokens and own app keys, and Clip Factory's YouTube, TikTok and X apps (the owner's shared-app
      # choice, read only, §45.30).
      { Sid = "WorkspaceSecretsRead", Action = ["secretsmanager:GetSecretValue"], Resource = [var.workspace_secrets_arn] },
      { Sid = "PlatformAppKeysRead", Action = ["secretsmanager:GetSecretValue"], Resource = local.story_app_secret_arns },
      # A refreshed (rotated) workspace token, put only: never create, delete or touch the pending choices. The pattern
      # is <name>/workspaces/*/token* (no "-"), so a put on a token a Disconnect deleted reads "not connected".
      { Sid = "WorkspaceTokens", Action = ["secretsmanager:PutSecretValue"], Resource = [var.workspace_token_secrets_arn] },
      # §45.37 G4: the owner's AI provider keys (<name>/workspaces/{ws}/providers/{anthropic|openai_compatible|
      # elevenlabs}) are read only by Lamo Stories' agent; the publisher never needs them. The explicit Deny wins over
      # WorkspaceSecretsRead's Allow; an additive, in-place change of this role policy (like clip-flow's NoBankSecrets).
      { Sid = "NoProviderKeys", Effect = "Deny", Action = ["secretsmanager:GetSecretValue"], Resource = ["${trimsuffix(var.workspace_secrets_arn, "*")}*/providers/*"] },
      # §45.37 G6 (a): Lamo Stories never writes Clip Factory's own rate counters (RATE#{platform}); its own are all
      # RATE#WS#… (its own app's, and the one counter of Clip Factory's shared app, RATE#WS#~shared#{platform}). The
      # explicit Deny wins over WorkspaceWrites' RATE#* Allow; additive and in place.
      {
        Sid       = "NoClipsRateWrites"
        Effect    = "Deny"
        Action    = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:TransactWriteItems"]
        Resource  = [var.table_arn]
        Condition = { "ForAnyValue:StringEquals" = { "dynamodb:LeadingKeys" = local.clips_rate_keys } }
      },
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
