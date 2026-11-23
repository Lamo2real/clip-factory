# Offline plan test (mock AWS provider, no credentials, no AWS calls):
#   cd infra/modules/stories_api && terraform init -backend=false && terraform test
#
# docs/CONTRACTS.md §45.5, §45.13, §45.15, §45.24 and ADR-76: cf-prod-stories-api, Lamo Stories' own API Lambda (the
# same zip, its own handler, log group and role). The role writes and reads DynamoDB only under USER#*#WS#*,
# USER#*#WSREG and OAUTH#ws.*, reads five attributes of Lamo Clips' ACCOUNT# items with GetItem, touches S3 only under
# ws/, manages only <name>/workspaces/* secrets, reads Clip Factory's YouTube, TikTok and X app keys and the OAuth state
# key, invokes only cf_prod_story_agent and starts only cf-prod-story-flow:live. IAM patterns are checked as globs
# against sample ARNs and keys: "*" becomes ".*" and "?" becomes "." in an anchored regex, dots escaped.

mock_provider "aws" {
  override_during = plan

  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:eu-north-1:123456789012:log-group:/aws/lambda/cf-test-stories-api" }
  }

  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/cf-test-fn-stories-api" }
  }
}

variables {
  name = "cf-test"
  # Any existing file: the module only hashes it.
  lambda_zip_path           = "main.tf"
  app_version               = "test"
  app_url                   = "https://app.example.test"
  table_name                = "cf-test-data"
  table_arn                 = "arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data"
  media_bucket              = "cf-test-media"
  media_bucket_arn          = "arn:aws:s3:::cf-test-media"
  stories_agent_runtime_arn = "arn:aws:bedrock-agentcore:eu-north-1:123456789012:runtime/cf_test_story_agent-AbCdEf1234"
  story_flow_alias_arn      = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-story-flow:live"
  ws_secret_prefix          = "cf-test/workspaces/"
  workspace_secrets_arn     = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/workspaces/*"
  secret_prefix             = "cf-test/platforms/"
  platform_secrets_arn      = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/*"
  oauth_state_secret_name   = "cf-test/oauth/state-key"
  oauth_state_secret_arn    = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/oauth/state-key-AbCdEf"
  hooks_url                 = "https://rest123.execute-api.eu-north-1.amazonaws.com/v1"
  stories_oauth_callback    = "https://http123.execute-api.eu-north-1.amazonaws.com/v1/stories-oauth"
}

run "its_own_function" {
  command = plan

  assert {
    condition = (aws_lambda_function.fn.function_name == "cf-test-stories-api" &&
      aws_lambda_function.fn.handler == "clipfactory_api.workspaces.http.handler" &&
      aws_lambda_function.fn.runtime == "python3.13" && aws_lambda_function.fn.architectures == tolist(["arm64"]) &&
      aws_lambda_function.fn.memory_size == 1024 && aws_lambda_function.fn.timeout == 29 &&
    aws_lambda_function.fn.filename == "main.tf" && aws_lambda_function.fn.source_code_hash == filebase64sha256("main.tf"))
    error_message = "cf-prod-stories-api: the same zip as cf-prod-api, handler clipfactory_api.workspaces.http.handler, Python 3.13 arm64, 1024 MB, 29 s (§45.15)."
  }

  assert {
    condition = (aws_iam_role.fn.name == "cf-test-fn-stories-api" && aws_lambda_function.fn.role == aws_iam_role.fn.arn &&
      aws_cloudwatch_log_group.fn.name == "/aws/lambda/cf-test-stories-api" && aws_cloudwatch_log_group.fn.retention_in_days == 30 &&
    one(aws_lambda_function.fn.logging_config).log_group == "/aws/lambda/cf-test-stories-api")
    error_message = "Its own role (never cf-prod-fn-api) and its own log group, kept 30 days."
  }

  assert {
    condition     = output.function_names == { stories-api = "cf-test-stories-api" }
    error_message = "function_names is { stories-api = <name>-stories-api } (its errors alarm, modules/monitoring)."
  }

  assert {
    condition = one(aws_lambda_function.fn.environment).variables == tomap({
      TABLE_NAME                = "cf-test-data"
      MEDIA_BUCKET              = "cf-test-media"
      STORIES_AGENT_RUNTIME_ARN = "arn:aws:bedrock-agentcore:eu-north-1:123456789012:runtime/cf_test_story_agent-AbCdEf1234"
      STORY_FLOW_ARN            = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-story-flow:live"
      WS_SECRET_PREFIX          = "cf-test/workspaces/"
      SECRET_PREFIX             = "cf-test/platforms/"
      OAUTH_STATE_SECRET        = "cf-test/oauth/state-key"
      HOOKS_URL                 = "https://rest123.execute-api.eu-north-1.amazonaws.com/v1"
      STORIES_OAUTH_CALLBACK    = "https://http123.execute-api.eu-north-1.amazonaws.com/v1/stories-oauth"
      APP_URL                   = "https://app.example.test"
      VERSION                   = "test"
    })
    error_message = "cf-prod-stories-api's environment is §45.15's list plus STORIES_OAUTH_CALLBACK (its own callback base): no AGENT_RUNTIME_ARN, JOB_FLOW_ARN or CLIP_FLOW_ARN of Clip Factory's."
  }
}

run "role_matches_the_contract" {
  command = plan

  assert {
    condition = toset(flatten([for s in jsondecode(aws_iam_role_policy.fn.policy).Statement : s.Action])) == toset([
      "logs:CreateLogStream", "logs:PutLogEvents", "xray:PutTraceSegments", "xray:PutTelemetryRecords",
      "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query",
      "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem", "dynamodb:TransactWriteItems", "dynamodb:ConditionCheckItem",
      "s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts", "s3:ListBucket",
      "secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret",
      "secretsmanager:DeleteSecret", "secretsmanager:TagResource",
      "bedrock-agentcore:InvokeAgentRuntime", "bedrock-agentcore:StopRuntimeSession",
      "lambda:InvokeFunction",
    ])
    error_message = "cf-prod-stories-api's actions must match docs/CONTRACTS.md §45.15 (no Bedrock model, no CloudFront, no web bucket)."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.fn.policy).Statement : s.Effect == "Allow" && alltrue([
        for a in flatten([s.Action]) : a != "*" && !endswith(a, ":*") && !startswith(a, "bedrock:") && !startswith(a, "s3vectors:") && !startswith(a, "cloudfront:")
      ])
    ])
    error_message = "No wildcard action, no model call, no clip vectors and no CloudFront."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn.policy).Statement :
      s.Sid == "WorkspaceData" && s.Resource == ["arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data"] &&
      s.Condition == { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["USER#*#WS#*", "USER#*#WSREG", "OAUTH#ws.*"] } }
    ])
    error_message = "Workspace data: writes and reads with dynamodb:LeadingKeys USER#*#WS#*, USER#*#WSREG and OAUTH#ws.*, the table only."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn.policy).Statement :
      s.Sid == "ClipsAccountRead" && s.Action == ["dynamodb:GetItem"] &&
      s.Resource == ["arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data"] &&
      s.Condition == {
        "ForAllValues:StringLike"   = { "dynamodb:LeadingKeys" = ["USER#*"] }
        "ForAllValues:StringEquals" = { "dynamodb:Attributes" = ["pk", "sk", "platform", "status", "accountId", "handle"] }
        "StringEqualsIfExists"      = { "dynamodb:Select" = "SPECIFIC_ATTRIBUTES", "dynamodb:ReturnValues" = "NONE" }
      }
    ])
    error_message = "Lamo Clips' ACCOUNT# items: GetItem of pk, sk, platform, status, accountId and handle only, nothing returned by a write (§45.15, §45.37 G8)."
  }

  # Writes: never Lamo Clips' USER#{userId}, Clip Factory's OAUTH#{nonce}, the rate budgets or any other partition.
  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.fn.policy).Statement : [
        for key in ["USER#u1", "OAUTH#n1", "OAUTH#wsx", "RATE#x", "HOOK#h1", "FOLLOWED", "CREATOR", "WATCH"] : !anytrue([
          for r in try(s.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"], ["*"]) : can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", key))
        ])
      ] if anytrue([for a in flatten([s.Action]) : contains(["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem", "dynamodb:TransactWriteItems", "dynamodb:ConditionCheckItem"], a)])
    ]))
    error_message = "cf-prod-stories-api writes no USER#{userId} item (Lamo Clips), no Clip Factory OAuth state and no other partition."
  }

  assert {
    condition = alltrue([
      for key in ["USER#u1#WS#stories", "USER#u1#WS#01JD0000000000000000000000", "USER#u1#WSREG", "OAUTH#ws.n1"] : anytrue([
        for s in jsondecode(aws_iam_role_policy.fn.policy).Statement : anytrue([
          for r in try(s.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"], []) : can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", key))
        ]) if contains(flatten([s.Action]), "dynamodb:PutItem")
      ])
    ])
    error_message = "cf-prod-stories-api writes its workspace partitions, the registry and its own OAuth connect states."
  }

  # The only statement that reaches USER#{userId} is the six-attribute GetItem.
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.fn.policy).Statement :
      flatten([s.Action]) == ["dynamodb:GetItem"] && try(s.Condition["ForAllValues:StringEquals"]["dynamodb:Attributes"], []) == ["pk", "sk", "platform", "status", "accountId", "handle"]
      if anytrue([for a in flatten([s.Action]) : startswith(a, "dynamodb:")]) && anytrue([
        for r in try(s.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"], ["*"]) : can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", "USER#u1"))
      ])
    ])
    error_message = "cf-prod-stories-api reaches USER#{userId} (Lamo Clips) only through the six-attribute GetItem."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.fn.policy).Statement : s.Resource == ["arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data"]
      if anytrue([for a in flatten([s.Action]) : startswith(a, "dynamodb:")])
    ])
    error_message = "Every DynamoDB statement is on the table only (no index)."
  }

  # S3: objects only under ws/, listing only with the ws/ prefix, no Lamo Clips prefix and no web bucket.
  assert {
    condition = toset(flatten([
      for s in jsondecode(aws_iam_role_policy.fn.policy).Statement : s.Resource
      if anytrue([for a in flatten([s.Action]) : startswith(a, "s3:") && a != "s3:ListBucket"])
    ])) == toset(["arn:aws:s3:::cf-test-media/ws/*"])
    error_message = "cf-prod-stories-api's S3 object access is exactly ws/* (§45.4)."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.fn.policy).Statement :
      s.Action == ["s3:ListBucket"] && s.Resource == ["arn:aws:s3:::cf-test-media"] && s.Condition == { StringLike = { "s3:prefix" = ["ws/*"] } }
    ])
    error_message = "ListBucket only with the prefix ws/."
  }

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.fn.policy).Statement : [
        for key in ["uploads/u1/v.mp4", "jobs/j1/clips/c1.mp4", "skills/u1/s1/SKILL.md", "private/u1/cookies.txt", "ask/u1/f1.png", "campaigns/c1/logo.png"] :
        !anytrue([for r in flatten([s.Resource]) : can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", "arn:aws:s3:::cf-test-media/${key}"))])
      ] if anytrue([for a in flatten([s.Action]) : startswith(a, "s3:")])
    ]))
    error_message = "No S3 statement reaches a Lamo Clips prefix (uploads/, jobs/, skills/, private/, ask/, campaigns/)."
  }

  # Secrets.
  assert {
    condition = toset(flatten([
      for s in jsondecode(aws_iam_role_policy.fn.policy).Statement : s.Resource if contains(flatten([s.Action]), "secretsmanager:GetSecretValue")
      ])) == toset([
      "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/workspaces/*",
      "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/youtube/app*",
      "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/tiktok/app*",
      "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/platforms/x/app*",
      "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/oauth/state-key-AbCdEf",
    ])
    error_message = "cf-prod-stories-api reads Clips Funded's secrets, Clip Factory's YouTube, TikTok and X app keys and the OAuth state key, nothing else."
  }

  assert {
    condition = toset(flatten([
      for s in jsondecode(aws_iam_role_policy.fn.policy).Statement : s.Resource
      if anytrue([for a in flatten([s.Action]) : startswith(a, "secretsmanager:") && a != "secretsmanager:GetSecretValue"])
    ])) == toset(["arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/workspaces/*"])
    error_message = "cf-prod-stories-api creates, writes, describes, tags and deletes only <name>/workspaces/* secrets."
  }

  assert {
    condition = alltrue(flatten([
      for sample in [
        "cf-test/platforms/youtube/token-AbC123", "cf-test/platforms/youtube/pending-AbC123", "cf-test/platforms/youtube/token",
        "cf-test/platforms/youtube/pending", "cf-test/platforms/tiktok/token-AbC123", "cf-test/platforms/instagram/app-AbC123",
        "cf-test/platforms/facebook/app", "cf-test/platforms/twitch/app-AbC123", "cf-test/platforms/kick/app",
        "cf-test/platforms/twitch/eventsub-AbC123", "cf-test/contentrewards/key-AbC123", "cf-test/ask/search-key-AbC123",
        ] : [
        for s in jsondecode(aws_iam_role_policy.fn.policy).Statement : [
          for r in flatten([s.Resource]) : !can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", "arn:aws:secretsmanager:eu-north-1:123456789012:secret:${sample}"))
        ] if anytrue([for a in flatten([s.Action]) : startswith(a, "secretsmanager:") || a == "*"])
      ]
    ]))
    error_message = "…:secret:<name>/platforms/youtube/token-AbC123, …/pending-AbC123, Meta's app keys and every other Clip Factory secret match no cf-prod-stories-api resource."
  }

  assert {
    condition = alltrue([
      for sample in [
        "cf-test/workspaces/stories/youtube/token-AbC123", "cf-test/workspaces/stories/youtube/token",
        "cf-test/workspaces/stories/facebook/pending", "cf-test/workspaces/stories/instagram/app-AbC123",
        "cf-test/workspaces/stories/providers/acme",
        ] : alltrue([
          for action in ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:GetSecretValue", "secretsmanager:DeleteSecret"] : anytrue(flatten([
            for s in jsondecode(aws_iam_role_policy.fn.policy).Statement : [
              for r in flatten([s.Resource]) : can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", "arn:aws:secretsmanager:eu-north-1:123456789012:secret:${sample}"))
            ] if contains(flatten([s.Action]), action)
          ]))
      ])
    ])
    error_message = "cf-prod-stories-api manages the workspace tokens, pending choices, own app keys and provider keys (bare and suffixed names)."
  }

  assert {
    condition = alltrue([
      for sample in ["cf-test/platforms/youtube/app", "cf-test/platforms/tiktok/app-AbC123", "cf-test/platforms/x/app"] : anytrue(flatten([
        for s in jsondecode(aws_iam_role_policy.fn.policy).Statement : [
          for r in flatten([s.Resource]) : can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", "arn:aws:secretsmanager:eu-north-1:123456789012:secret:${sample}"))
        ] if contains(flatten([s.Action]), "secretsmanager:GetSecretValue")
      ]))
    ])
    error_message = "With the shared-app choice, Clip Factory's YouTube, TikTok and X app keys can be read (a deleted one reads as not found)."
  }

  # The agent and the flow: Lamo Stories' own only.
  assert {
    condition = (toset(flatten([
      for s in jsondecode(aws_iam_role_policy.fn.policy).Statement : s.Resource if anytrue([for a in flatten([s.Action]) : startswith(a, "bedrock-agentcore:")])
      ])) == toset([
      "arn:aws:bedrock-agentcore:eu-north-1:123456789012:runtime/cf_test_story_agent-AbCdEf1234",
      "arn:aws:bedrock-agentcore:eu-north-1:123456789012:runtime/cf_test_story_agent-AbCdEf1234/*",
      ]) && toset(flatten([
        for s in jsondecode(aws_iam_role_policy.fn.policy).Statement : s.Resource if contains(flatten([s.Action]), "lambda:InvokeFunction")
    ])) == toset(["arn:aws:lambda:eu-north-1:123456789012:function:cf-test-story-flow:live"]))
    error_message = "cf-prod-stories-api invokes only cf_prod_story_agent and starts only cf-prod-story-flow:live (never the clip agent or a Clip Factory flow)."
  }
}

run "the_clip_agent_is_refused" {
  command = plan

  variables {
    stories_agent_runtime_arn = "arn:aws:bedrock-agentcore:eu-north-1:123456789012:runtime/cf_test_clip_agent-AbCdEf1234"
  }

  expect_failures = [var.stories_agent_runtime_arn]
}

run "the_flow_must_be_the_story_flow_alias" {
  command = plan

  variables {
    story_flow_alias_arn = "arn:aws:lambda:eu-north-1:123456789012:function:cf-test-clip-flow:live"
  }

  expect_failures = [var.story_flow_alias_arn]
}

run "callback_base_has_no_trailing_slash" {
  command = plan

  variables {
    stories_oauth_callback = "https://http123.execute-api.eu-north-1.amazonaws.com/v1/stories-oauth/"
  }

  expect_failures = [var.stories_oauth_callback]
}

run "workspace_secrets_never_under_platforms" {
  command = plan

  variables {
    ws_secret_prefix = "cf-test/platforms/workspaces/"
  }

  expect_failures = [var.ws_secret_prefix]
}

run "role_carries_the_permissions_boundary" {
  command = plan

  variables {
    permissions_boundary_arn = "arn:aws:iam::123456789012:policy/cf-test-role-boundary"
  }

  assert {
    condition     = aws_iam_role.fn.permissions_boundary == "arn:aws:iam::123456789012:policy/cf-test-role-boundary"
    error_message = "cf-prod-stories-api's role carries the deploy role's permissions boundary."
  }
}
