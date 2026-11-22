# Offline plan test (mock AWS provider, no credentials, no AWS calls):
#   cd infra/modules/flows && terraform init -backend=false && terraform test
#
# docs/CONTRACTS.md §14.4, §14.5 and §14.12: both flows are durable functions with a published version and an alias
# `live`, the agreed execution timeouts and retention, a 60-minute delete timeout, no Lambda destinations, and roles
# that allow exactly what the code calls. §17.9: clip-flow reads and refreshes platform tokens (1024 MB); job-flow
# gets no Secrets Manager access. §45.15: Lamo Stories' story-flow is a third durable function with its own role
# (run "story_flow_is_kept_apart"); the generic asserts below cover it too.

mock_provider "aws" {
  override_during = plan

  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:eu-north-1:123456789012:log-group:cf-test" }
  }
}

variables {
  name = "cf-test"
  # Any existing file: the module only hashes it.
  lambda_zip_path   = "main.tf"
  table_name        = "cf-test-data"
  table_arn         = "arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data"
  media_bucket      = "cf-test-media"
  media_bucket_arn  = "arn:aws:s3:::cf-test-media"
  agent_runtime_arn = "arn:aws:bedrock-agentcore:eu-north-1:123456789012:runtime/cf_test_clip_agent-abc"
  model_id          = "global.anthropic.claude-fable-5-1"
  model_invoke_arns = ["arn:aws:bedrock:eu-north-1:123456789012:inference-profile/global.anthropic.claude-fable-5-1", "arn:aws:bedrock:*::foundation-model/anthropic.claude-fable-5-1"]
  embed_model_id    = "amazon.titan-embed-text-v2:0"
  embed_model_arn   = "arn:aws:bedrock:eu-north-1::foundation-model/amazon.titan-embed-text-v2:0"
  vector_bucket     = "cf-test-vectors-123456789012"
  vector_index      = "clips"
  vector_index_arn  = "arn:aws:s3vectors:eu-north-1:123456789012:bucket/cf-test-vectors-123456789012/index/clips"

  secret_prefix              = "cf-test/platforms/"
  platform_secrets_arn       = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*"
  platform_token_secrets_arn = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*/token-*"

  # §45.15: Lamo Stories' workspace tokens (the hooks module's names).
  ws_secret_prefix            = "cf-test/workspaces/"
  workspace_secrets_arn       = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/workspaces/*"
  workspace_token_secrets_arn = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/workspaces/*/token*"
}

run "both_flows_are_durable_with_alias_live" {
  command = plan

  assert {
    condition     = alltrue([for f in aws_lambda_function.fn : f.publish])
    error_message = "Both flows need publish = true so the alias points at a numbered version, not $LATEST."
  }

  assert {
    condition     = alltrue([for a in aws_lambda_alias.live : a.name == "live"])
    error_message = "Both flows need an alias named live."
  }

  assert {
    condition     = one(aws_lambda_function.fn["job-flow"].durable_config).execution_timeout == 149400
    error_message = "job-flow execution_timeout must be 149400 s (8 h run + 24 h waiting for the Mac + 8 h run, §35)."
  }

  assert {
    condition     = one(aws_lambda_function.fn["clip-flow"].durable_config).execution_timeout == 259200
    error_message = "clip-flow execution_timeout must be 259200 s (48 h wait + publish, metrics, distil)."
  }

  assert {
    condition     = alltrue([for f in aws_lambda_function.fn : one(f.durable_config).retention_period == 14])
    error_message = "Durable executions must be kept 14 days."
  }

  assert {
    condition     = alltrue([for f in aws_lambda_function.fn : f.timeouts.delete == "60m"])
    error_message = "Deleting a durable function can take up to an hour: timeouts.delete must be 60m."
  }

  assert {
    condition     = alltrue([for f in aws_lambda_function.fn : f.runtime == "python3.13" && one(f.architectures) == "arm64"])
    error_message = "The flows run python3.13 on arm64 like every other function."
  }

  assert {
    condition     = aws_lambda_function.fn["job-flow"].function_name == "cf-test-job-flow" && aws_lambda_function.fn["clip-flow"].function_name == "cf-test-clip-flow"
    error_message = "Function names must be <name>-job-flow and <name>-clip-flow."
  }

  assert {
    condition     = aws_lambda_function.fn["job-flow"].handler == "clipfactory_api.flows.job_flow.handler" && aws_lambda_function.fn["clip-flow"].handler == "clipfactory_api.flows.clip_flow.handler"
    error_message = "Handlers must match docs/CONTRACTS.md §9."
  }

  assert {
    condition = (aws_lambda_function.fn["job-flow"].memory_size == 256 && aws_lambda_function.fn["job-flow"].timeout == 120 &&
    aws_lambda_function.fn["clip-flow"].memory_size == 1024 && aws_lambda_function.fn["clip-flow"].timeout == 900)
    error_message = "job-flow is 256 MB / 120 s, clip-flow 1024 MB / 900 s (§17.9)."
  }
}

run "environment_matches_the_contract" {
  command = plan

  assert {
    condition     = toset(keys(one(aws_lambda_function.fn["job-flow"].environment).variables)) == toset(["AGENT_RUNTIME_ARN", "TABLE_NAME"])
    error_message = "job-flow gets exactly TABLE_NAME and AGENT_RUNTIME_ARN."
  }

  assert {
    condition     = toset(keys(one(aws_lambda_function.fn["clip-flow"].environment).variables)) == toset(["CONTENT_REWARDS", "EMBED_MODEL_ID", "MEDIA_BUCKET", "MODEL_ID", "SECRET_PREFIX", "TABLE_NAME", "VECTOR_BUCKET", "VECTOR_INDEX"])
    error_message = "clip-flow gets exactly TABLE_NAME, MEDIA_BUCKET, MODEL_ID, EMBED_MODEL_ID, VECTOR_BUCKET, VECTOR_INDEX, SECRET_PREFIX and CONTENT_REWARDS (§38.16)."
  }

  assert {
    condition     = one(aws_lambda_function.fn["clip-flow"].environment).variables["CONTENT_REWARDS"] == "off"
    error_message = "§38.16: the clip flow sends nothing to Content Rewards until the switch is on (default off)."
  }

  assert {
    condition     = one(aws_lambda_function.fn["clip-flow"].environment).variables["SECRET_PREFIX"] == "cf-test/platforms/"
    error_message = "clip-flow's SECRET_PREFIX is <name>/platforms/ (§17.9)."
  }

  assert {
    condition     = one(aws_lambda_function.fn["clip-flow"].environment).variables["MODEL_ID"] == "global.anthropic.claude-fable-5-1"
    error_message = "clip-flow distils through the global Fable profile."
  }
}

run "roles_allow_exactly_what_the_code_calls" {
  command = plan

  assert {
    condition     = alltrue([for a in aws_iam_role_policy_attachment.durable : a.policy_arn == "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicDurableExecutionRolePolicy"])
    error_message = "Both roles need AWSLambdaBasicDurableExecutionRolePolicy (checkpoints and state)."
  }

  assert {
    condition = toset(flatten([for s in jsondecode(aws_iam_role_policy.fn["job-flow"].policy).Statement : s.Action])) == toset([
      "logs:CreateLogStream", "logs:PutLogEvents", "xray:PutTraceSegments", "xray:PutTelemetryRecords",
      "dynamodb:GetItem", "dynamodb:UpdateItem",
      "bedrock-agentcore:InvokeAgentRuntime", "bedrock-agentcore:StopRuntimeSession",
    ])
    error_message = "job-flow may only read/update the job, start and stop the agent, log and trace."
  }

  assert {
    condition = toset(flatten([for s in jsondecode(aws_iam_role_policy.fn["clip-flow"].policy).Statement : s.Action])) == toset([
      "logs:CreateLogStream", "logs:PutLogEvents", "xray:PutTraceSegments", "xray:PutTelemetryRecords",
      "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:BatchGetItem",
      "dynamodb:TransactWriteItems", "dynamodb:ConditionCheckItem",
      "s3:GetObject", "bedrock:InvokeModel", "s3vectors:GetVectors", "s3vectors:PutVectors",
      "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue",
    ])
    error_message = "clip-flow's actions must match docs/CONTRACTS.md §14.5 and §17.9."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["clip-flow"].policy).Statement :
      s.Sid == "PlatformSecretsRead" && s.Action == ["secretsmanager:GetSecretValue"] &&
      s.Resource == ["arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*"]
    ])
    error_message = "clip-flow reads app keys and tokens only under <name>/platforms/*."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["clip-flow"].policy).Statement :
      s.Sid == "PlatformTokens" && s.Action == ["secretsmanager:PutSecretValue"] &&
      s.Resource == ["arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*/token-*"]
    ])
    error_message = "clip-flow writes only refreshed tokens (<name>/platforms/*/token-*), never app keys or pending choices."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.fn["clip-flow"].policy).Statement :
      !contains(s.Action, "secretsmanager:PutSecretValue") || s.Resource == ["arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*/token-*"]
    ])
    error_message = "clip-flow may not put any secret other than the token secrets."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.fn["job-flow"].policy).Statement : alltrue([for a in s.Action : !startswith(a, "secretsmanager:")])
    ])
    error_message = "job-flow gets no Secrets Manager access."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["clip-flow"].policy).Statement :
      s.Sid == "Vectors" && s.Resource == ["arn:aws:s3vectors:eu-north-1:123456789012:bucket/cf-test-vectors-123456789012/index/clips"]
    ])
    error_message = "S3 Vectors access must be limited to the clips index."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["clip-flow"].policy).Statement :
      s.Sid == "Models" && contains(s.Resource, "arn:aws:bedrock:eu-north-1::foundation-model/amazon.titan-embed-text-v2:0") &&
      contains(s.Resource, "arn:aws:bedrock:*::foundation-model/anthropic.claude-fable-5-1")
    ])
    error_message = "clip-flow must reach Fable (distil) and Titan (embeddings)."
  }

  assert {
    condition = alltrue(flatten([
      for k, p in aws_iam_role_policy.fn : [
        for s in jsondecode(p.policy).Statement : [
          for a in s.Action : !startswith(a, "sqs:") && !startswith(a, "scheduler:") && a != "iam:PassRole" && a != "dynamodb:Scan"
        ]
      ]
    ]))
    error_message = "No queue, scheduler, PassRole or Scan permissions remain: durable execution replaces them."
  }
}

# docs/CONTRACTS.md §18.6 and §18.8: the distil step loads the owner's skills, so clip-flow reads skills/* (keys come
# from the table) and nothing wider: no list, no write, no other prefix.
run "clip_flow_reads_skills_and_nothing_wider" {
  command = plan

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["clip-flow"].policy).Statement :
      s.Sid == "Skills" && s.Effect == "Allow" && s.Action == ["s3:GetObject"] && s.Resource == ["arn:aws:s3:::cf-test-media/skills/*"]
    ])
    error_message = "clip-flow needs { Sid = Skills, Action = [s3:GetObject], Resource = [<media>/skills/*] }."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["clip-flow"].policy).Statement :
      s.Sid == "ClipFiles" && s.Action == ["s3:GetObject"] && s.Resource == ["arn:aws:s3:::cf-test-media/jobs/*"]
    ])
    error_message = "ClipFiles stays s3:GetObject on jobs/* only."
  }

  assert {
    condition = toset(flatten([
      for s in jsondecode(aws_iam_role_policy.fn["clip-flow"].policy).Statement : s.Resource if anytrue([for a in s.Action : startswith(a, "s3:")])
    ])) == toset(["arn:aws:s3:::cf-test-media/jobs/*", "arn:aws:s3:::cf-test-media/skills/*"])
    error_message = "clip-flow's S3 access is exactly jobs/* and skills/*."
  }

  assert {
    condition = alltrue(flatten([
      for k, p in aws_iam_role_policy.fn : [
        for s in jsondecode(p.policy).Statement : [for a in s.Action : a != "s3:ListBucket" && a != "s3:PutObject" && a != "s3:DeleteObject"]
      ]
    ]))
    error_message = "Neither flow may list, write or delete S3 objects."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.fn["job-flow"].policy).Statement : alltrue([for a in s.Action : !startswith(a, "s3:")])
    ])
    error_message = "job-flow gets no S3 access (the agent reads skills itself)."
  }
}

run "alias_arns_are_the_outputs" {
  command = plan

  override_resource {
    target          = aws_lambda_alias.live["job-flow"]
    override_during = plan
    values          = { arn = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-job-flow:live" }
  }

  override_resource {
    target          = aws_lambda_alias.live["clip-flow"]
    override_during = plan
    values          = { arn = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-clip-flow:live" }
  }

  override_resource {
    target          = aws_lambda_alias.live["story-flow"]
    override_during = plan
    values          = { arn = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-story-flow:live" }
  }

  assert {
    condition     = endswith(output.job_flow_alias_arn, ":cf-test-job-flow:live") && endswith(output.clip_flow_alias_arn, ":cf-test-clip-flow:live")
    error_message = "The alias ARN outputs must end in :live."
  }

  assert {
    condition     = output.story_flow_alias_arn == "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-story-flow:live"
    error_message = "story_flow_alias_arn is the story flow's alias live (the API's STORY_FLOW_ARN, §45.15)."
  }

  assert {
    condition     = output.durable_function_names == { job-flow = "cf-test-job-flow", clip-flow = "cf-test-clip-flow", story-flow = "cf-test-story-flow" }
    error_message = "durable_function_names must name the three flows (the story flow's alarms join them, §45.15)."
  }
}

# docs/CONTRACTS.md §45.15, ADR-73: cf-prod-story-flow, Lamo Stories' publisher. Durable for longer than the 7-day
# numbers, its own role (not clip-flow's statements): DynamoDB writes only under USER#*#WS#* and RATE#*, reads on
# USER#*#WS#*, USER#*#WSREG and RATE#*, plus GetItem of five attributes on USER#* (Lamo Clips' ACCOUNT#), the table
# only; S3 GetObject on ws/* only; the workspace secrets and Clip Factory's YouTube, TikTok and X app keys read, a
# workspace token put back; no Bedrock, no Delete, no Scan. IAM patterns are checked as globs against sample ARNs and
# keys: "*" becomes ".*" and "?" becomes "." in an anchored regex, dots escaped.
run "story_flow_is_kept_apart" {
  command = plan

  assert {
    condition = (aws_lambda_function.fn["story-flow"].function_name == "cf-test-story-flow" &&
      aws_lambda_function.fn["story-flow"].handler == "clipfactory_api.flows.story_flow.handler" &&
      aws_lambda_function.fn["story-flow"].memory_size == 1024 && aws_lambda_function.fn["story-flow"].timeout == 900 &&
    aws_lambda_function.fn["story-flow"].publish && aws_lambda_alias.live["story-flow"].name == "live")
    error_message = "story-flow is cf-test-story-flow, clipfactory_api.flows.story_flow.handler, 1024 MB / 900 s, published with an alias live."
  }

  assert {
    condition     = one(aws_lambda_function.fn["story-flow"].durable_config).execution_timeout == 777600
    error_message = "story-flow execution_timeout must be 777600 s (9 days: the 7-day numbers and the publish loops)."
  }

  assert {
    condition     = one(aws_lambda_function.fn["story-flow"].durable_config).execution_timeout > 7 * 24 * 3600
    error_message = "story-flow must run longer than 7 days (its last numbers are read 7 days after the post)."
  }

  assert {
    condition = one(aws_lambda_function.fn["story-flow"].environment).variables == tomap({
      TABLE_NAME       = "cf-test-data"
      MEDIA_BUCKET     = "cf-test-media"
      WS_SECRET_PREFIX = "cf-test/workspaces/"
      SECRET_PREFIX    = "cf-test/platforms/"
    })
    error_message = "story-flow gets exactly TABLE_NAME, MEDIA_BUCKET, WS_SECRET_PREFIX and SECRET_PREFIX (for the app keys only)."
  }

  assert {
    condition     = aws_iam_role.fn["story-flow"].name == "cf-test-fn-story-flow" && aws_iam_role.fn["clip-flow"].name == "cf-test-fn-clip-flow"
    error_message = "story-flow has its own role, never clip-flow's."
  }

  assert {
    condition = toset(flatten([for s in jsondecode(aws_iam_role_policy.fn["story-flow"].policy).Statement : s.Action])) == toset([
      "logs:CreateLogStream", "logs:PutLogEvents", "xray:PutTraceSegments", "xray:PutTelemetryRecords",
      "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:TransactWriteItems", "dynamodb:ConditionCheckItem",
      "dynamodb:GetItem", "dynamodb:Query", "dynamodb:BatchGetItem",
      "s3:GetObject", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue",
    ])
    error_message = "story-flow's actions must match docs/CONTRACTS.md §45.15 exactly."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.fn["story-flow"].policy).Statement : alltrue([
        for a in flatten([s.Action]) : !startswith(a, "bedrock") && a != "*" && !endswith(a, ":*")
      ])
    ])
    error_message = "story-flow has no Bedrock action (and no wildcard action)."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.fn["story-flow"].policy).Statement : alltrue([
        for a in flatten([s.Action]) : !contains(["dynamodb:DeleteItem", "dynamodb:BatchWriteItem", "dynamodb:Scan", "secretsmanager:CreateSecret", "secretsmanager:DeleteSecret", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "lambda:InvokeFunction"], a)
      ])
    ])
    error_message = "story-flow never deletes or scans items, creates or deletes secrets, writes or lists files, or starts functions."
  }

  # Writes only under USER#*#WS#* and RATE#*, on the table itself.
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.fn["story-flow"].policy).Statement :
      s.Resource == ["arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data"] &&
      s.Condition == { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["USER#*#WS#*", "RATE#*"] } }
      if anytrue([for a in flatten([s.Action]) : contains(["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem", "dynamodb:TransactWriteItems", "dynamodb:ConditionCheckItem"], a)])
    ])
    error_message = "Every story-flow DynamoDB write is limited by dynamodb:LeadingKeys to USER#*#WS#* and RATE#*, on the table only."
  }

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.fn["story-flow"].policy).Statement : [
        for key in ["USER#u1", "OAUTH#n1", "HOOK#h1", "USER#u1#WSREG"] : !anytrue([
          for r in try(s.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"], ["*"]) : can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", key))
        ])
      ] if anytrue([for a in flatten([s.Action]) : contains(["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:TransactWriteItems", "dynamodb:ConditionCheckItem"], a)])
    ]))
    error_message = "No story-flow write reaches Lamo Clips' USER#{userId} partition, the workspace registry or any other partition."
  }

  assert {
    condition = alltrue([
      for key in ["USER#u1#WS#stories", "USER#u1#WS#01JD0000000000000000000000", "RATE#x"] : anytrue([
        for s in jsondecode(aws_iam_role_policy.fn["story-flow"].policy).Statement : anytrue([
          for r in try(s.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"], []) : can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", key))
        ]) if contains(flatten([s.Action]), "dynamodb:UpdateItem")
      ])
    ])
    error_message = "story-flow can update its workspace partitions and the shared rate budgets."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["story-flow"].policy).Statement :
      s.Sid == "Reads" && toset(s.Action) == toset(["dynamodb:GetItem", "dynamodb:Query", "dynamodb:BatchGetItem"]) &&
      s.Resource == ["arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data"] &&
      s.Condition == { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["USER#*#WS#*", "USER#*#WSREG", "RATE#*"] } }
    ])
    error_message = "story-flow reads (GetItem, Query, BatchGetItem) only USER#*#WS#*, USER#*#WSREG and RATE#* on the table, no index."
  }

  # Lamo Clips' ACCOUNT# items: GetItem only, five attributes, nothing returned by a write (§45.15).
  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn["story-flow"].policy).Statement :
      s.Sid == "ClipsAccountRead" && s.Action == ["dynamodb:GetItem"] &&
      s.Resource == ["arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data"] &&
      s.Condition == {
        "ForAllValues:StringLike"   = { "dynamodb:LeadingKeys" = ["USER#*"] }
        "ForAllValues:StringEquals" = { "dynamodb:Attributes" = ["pk", "sk", "platform", "status", "accountId"] }
        "StringEqualsIfExists"      = { "dynamodb:Select" = "SPECIFIC_ATTRIBUTES", "dynamodb:ReturnValues" = "NONE" }
      }
    ])
    error_message = "story-flow reads Lamo Clips' ACCOUNT# items only with GetItem of pk, sk, platform, status and accountId."
  }

  # Every statement that reaches Lamo Clips' own partition (USER#u1) is that attribute-limited GetItem: no Query, no
  # BatchGetItem, no write and no unrestricted read of USER#{userId}.
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.fn["story-flow"].policy).Statement :
      flatten([s.Action]) == ["dynamodb:GetItem"] && try(s.Condition["ForAllValues:StringEquals"]["dynamodb:Attributes"], []) == ["pk", "sk", "platform", "status", "accountId"]
      if anytrue([for a in flatten([s.Action]) : startswith(a, "dynamodb:")]) && anytrue([
        for r in try(s.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"], ["*"]) : can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", "USER#u1"))
      ])
    ])
    error_message = "story-flow reaches USER#{userId} (Lamo Clips) only through the five-attribute GetItem."
  }

  assert {
    condition = toset(flatten([
      for s in jsondecode(aws_iam_role_policy.fn["story-flow"].policy).Statement : s.Resource if anytrue([for a in flatten([s.Action]) : startswith(a, "s3:")])
    ])) == toset(["arn:aws:s3:::cf-test-media/ws/*"])
    error_message = "story-flow's S3 access is exactly GetObject on ws/*."
  }

  assert {
    condition = toset(flatten([
      for s in jsondecode(aws_iam_role_policy.fn["story-flow"].policy).Statement : s.Resource if contains(flatten([s.Action]), "secretsmanager:GetSecretValue")
      ])) == toset([
      "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/workspaces/*",
      "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/youtube/app*",
      "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/tiktok/app*",
      "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/x/app*",
    ])
    error_message = "story-flow reads the workspace secrets and Clip Factory's YouTube, TikTok and X app keys (the shared-app choice, never Meta's), nothing else."
  }

  assert {
    condition = toset(flatten([
      for s in jsondecode(aws_iam_role_policy.fn["story-flow"].policy).Statement : s.Resource if contains(flatten([s.Action]), "secretsmanager:PutSecretValue")
    ])) == toset(["arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/workspaces/*/token*"])
    error_message = "story-flow writes back only refreshed workspace tokens (<name>/workspaces/*/token*)."
  }

  # §45.14: a missing secret means "not set up" or "not connected". Secrets Manager checks a secret that does not
  # exist by its bare name (no random suffix), so the app-key read and the token put must match the bare names too
  # (otherwise the code gets AccessDenied instead of ResourceNotFoundException).
  assert {
    condition = alltrue([
      for sample in [
        "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/youtube/app",
        "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/x/app",
        "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/workspaces/stories/youtube/token",
        ] : anytrue(flatten([
          for s in jsondecode(aws_iam_role_policy.fn["story-flow"].policy).Statement : [
            for r in flatten([s.Resource]) : can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", sample))
          ] if contains(flatten([s.Action]), "secretsmanager:GetSecretValue")
      ]))
      ]) && anytrue(flatten([
        for s in jsondecode(aws_iam_role_policy.fn["story-flow"].policy).Statement : [
          for r in flatten([s.Resource]) : can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/workspaces/stories/youtube/token"))
        ] if contains(flatten([s.Action]), "secretsmanager:PutSecretValue")
    ]))
    error_message = "A deleted app key or workspace token must read as not found: story-flow's grants match the bare secret names."
  }

  # The sample ARNs of §45.15: no Secrets Manager grant of story-flow reaches a Lamo Clips token or pending choice.
  assert {
    condition = alltrue(flatten([
      for sample in [
        "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/youtube/token-AbC123",
        "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/youtube/pending-AbC123",
        "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/tiktok/token-AbC123",
        "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/twitch/app-AbC123",
        "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/oauth/state-key-AbC123",
        # Meta always uses Lamo Stories' own app (§45.30): Clip Factory's Instagram and Facebook keys are never read.
        "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/instagram/app-AbC123",
        "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/facebook/app-AbC123",
        # The same by their bare names (how a secret that does not exist is checked).
        "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/youtube/token",
        "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/youtube/pending",
        "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/twitch/app",
        "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/kick/app",
        "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/instagram/app",
        "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/facebook/app",
        ] : [
        for s in jsondecode(aws_iam_role_policy.fn["story-flow"].policy).Statement : [
          for r in flatten([s.Resource]) : !can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", sample))
        ] if anytrue([for a in flatten([s.Action]) : startswith(a, "secretsmanager:") || a == "*"])
      ]
    ]))
    error_message = "…:secret:<name>/platforms/youtube/token-AbC123 and …/pending-AbC123 (and Meta's, Twitch's and Kick's app keys and the state key) must match no story-flow Secrets Manager resource."
  }

  assert {
    condition = alltrue([
      for sample in [
        "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/workspaces/stories/youtube/token-AbC123",
        "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/youtube/app-AbC123",
        "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/x/app-AbC123",
        ] : anytrue(flatten([
          for s in jsondecode(aws_iam_role_policy.fn["story-flow"].policy).Statement : [
            for r in flatten([s.Resource]) : can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", sample))
          ] if contains(flatten([s.Action]), "secretsmanager:GetSecretValue")
      ]))
    ])
    error_message = "story-flow can read a workspace token and the platform app keys."
  }

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.fn["story-flow"].policy).Statement : [
        for r in flatten([s.Resource]) : [
          for sample in ["stories/facebook/pending-AbC123", "stories/facebook/pending"] :
          !can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/workspaces/${sample}"))
        ]
      ] if contains(flatten([s.Action]), "secretsmanager:PutSecretValue")
    ]))
    error_message = "story-flow never writes a workspace's pending Meta choices."
  }

  # The other way round: …:secret:<name>/workspaces/stories/youtube/token-AbC123 matches no clip-flow or job-flow
  # resource (stats and money: their own module tests).
  assert {
    condition = alltrue(flatten([
      for k in ["clip-flow", "job-flow"] : [
        for s in jsondecode(aws_iam_role_policy.fn[k].policy).Statement : [
          for r in flatten([s.Resource]) : !can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/workspaces/stories/youtube/token-AbC123"))
        ] if anytrue([for a in flatten([s.Action]) : startswith(a, "secretsmanager:") || a == "*"])
      ]
    ]))
    error_message = "No clip-flow or job-flow Secrets Manager resource may match a Lamo Stories workspace token."
  }
}

# docs/CONTRACTS.md §40.5.11: clip-flow can read <name>/platforms/*, so an in-place Deny keeps it off Your bank's
# secrets (the bank key and each bank link's session); only clip-flow gets it, and no Allow changes.
run "clip_flow_never_reads_bank_secrets" {
  command = plan

  assert {
    condition = [for s in jsondecode(aws_iam_role_policy.fn["clip-flow"].policy).Statement : s if try(s.Sid, "") == "NoBankSecrets"] == [{
      Sid      = "NoBankSecrets"
      Effect   = "Deny"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = ["arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/bank/*"]
    }]
    error_message = "clip-flow has exactly one NoBankSecrets statement: Effect Deny, GetSecretValue, <name>/platforms/bank/*."
  }

  assert {
    condition = alltrue(flatten([
      for k, p in aws_iam_role_policy.fn : [
        for s in jsondecode(p.policy).Statement : s.Effect == "Allow" if k != "clip-flow" || try(s.Sid, "") != "NoBankSecrets"
      ]
    ]))
    error_message = "Only clip-flow gets the Deny; every other statement stays an Allow."
  }

  assert {
    condition = alltrue(flatten([
      for k, p in aws_iam_role_policy.fn : [
        for s in jsondecode(p.policy).Statement : !strcontains(jsonencode(s.Resource), "/bank") if s.Effect == "Allow"
      ]
    ]))
    error_message = "No Allow statement names Your bank's secrets."
  }

  assert {
    condition     = aws_iam_role_policy.fn["clip-flow"].name == "least-privilege" && aws_iam_role.fn["clip-flow"].name == "cf-test-fn-clip-flow"
    error_message = "The Deny is an in-place change of clip-flow's own role policy (same role, same policy name)."
  }
}
