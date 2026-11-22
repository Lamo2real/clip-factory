# Offline plan test (mock AWS providers, no credentials, no AWS calls; plan never builds the image):
#   cd infra/modules/stories_agent && terraform init -backend=false && terraform test
#
# docs/CONTRACTS.md §45.11, §45.15, §45.24, §45.31 and ADR-76, ADR-80: Lamo Stories' own AgentCore runtime
# cf_prod_story_agent, its own ECR repository, image build trigger, log group and role. The role writes and reads
# DynamoDB only under USER#*#WS#* and USER#*#WSREG, touches S3 only under ws/, calls only the models of
# stories/config/models.json plus Nova Canvas in eu-west-1 (and Nova Reel in us-east-1 only with the bucket switch),
# and reads only the provider keys under <name>/workspaces/*/providers/*: no Lamo Clips token, app key, partition,
# prefix or log group. IAM patterns are checked as globs against sample ARNs and keys: "*" becomes ".*" and "?" becomes
# "." in an anchored regex, dots escaped.

mock_provider "aws" {
  override_during = plan

  mock_resource "aws_ecr_repository" {
    defaults = {
      arn            = "arn:aws:ecr:eu-north-1:123456789012:repository/cf-test-stories-agent"
      repository_url = "123456789012.dkr.ecr.eu-north-1.amazonaws.com/cf-test-stories-agent"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/cf-test-stories-agent" }
  }

  mock_resource "aws_bedrockagentcore_agent_runtime" {
    defaults = {
      agent_runtime_arn = "arn:aws:bedrock-agentcore:eu-north-1:123456789012:runtime/cf_test_story_agent-AbCdEf1234"
      agent_runtime_id  = "cf_test_story_agent-AbCdEf1234"
    }
  }
}

mock_provider "aws" {
  alias           = "us_east_1"
  override_during = plan

  mock_resource "aws_s3_bucket" {
    defaults = {
      arn = "arn:aws:s3:::cf-test-stories-video-123456789012-us"
      id  = "cf-test-stories-video-123456789012-us"
    }
  }
}

variables {
  name                           = "cf-test"
  region                         = "eu-north-1"
  account_id                     = "123456789012"
  image_tag                      = "stories-agent-0123456789abcdef"
  table_name                     = "cf-test-data"
  table_arn                      = "arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data"
  media_bucket                   = "cf-test-media"
  media_bucket_arn               = "arn:aws:s3:::cf-test-media"
  workspace_provider_secrets_arn = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/workspaces/*/providers/*"
}

run "its_own_repository_image_and_runtime" {
  command = plan

  assert {
    condition = (aws_ecr_repository.agent.name == "cf-test-stories-agent" && aws_ecr_repository.agent.image_tag_mutability == "IMMUTABLE" &&
    jsondecode(aws_ecr_lifecycle_policy.agent.policy).rules[0].selection.countNumber == 15)
    error_message = "ECR repository cf-prod-stories-agent: immutable tags, the last 15 images kept (§45.15)."
  }

  assert {
    condition     = terraform_data.image.triggers_replace == ["stories-agent-0123456789abcdef"]
    error_message = "A new image tag (and only that) rebuilds the image: the build trigger is the one replaced resource (§45.18)."
  }

  # The trigger pushes stories/agent/Dockerfile with scripts/push-image.sh (provisioner settings are not in the plan).
  assert {
    condition = (length(terraform_data.image.triggers_replace) == 1 && strcontains(file("main.tf"), "command = \"bash $${local.repo_root}/scripts/push-image.sh\"") &&
    strcontains(file("main.tf"), "DOCKERFILE  = \"$${local.repo_root}/stories/agent/Dockerfile\""))
    error_message = "terraform_data.image pushes stories/agent/Dockerfile with scripts/push-image.sh."
  }

  assert {
    condition = (aws_bedrockagentcore_agent_runtime.agent.agent_runtime_name == "cf_test_story_agent" &&
      aws_bedrockagentcore_agent_runtime.agent.role_arn == aws_iam_role.agent.arn &&
      aws_iam_role.agent.name == "cf-test-stories-agent" &&
      one(aws_bedrockagentcore_agent_runtime.agent.network_configuration).network_mode == "PUBLIC" &&
      one(aws_bedrockagentcore_agent_runtime.agent.lifecycle_configuration).idle_runtime_session_timeout == 900 &&
    one(aws_bedrockagentcore_agent_runtime.agent.lifecycle_configuration).max_lifetime == 28800)
    error_message = "Runtime cf_prod_story_agent with its own role, public network, 15-minute idle and 8-hour maximum, like the clip runtime."
  }

  assert {
    condition     = one(one(aws_bedrockagentcore_agent_runtime.agent.agent_runtime_artifact).container_configuration).container_uri == "123456789012.dkr.ecr.eu-north-1.amazonaws.com/cf-test-stories-agent:stories-agent-0123456789abcdef"
    error_message = "The runtime runs its own repository's image at the Lamo Stories tag."
  }

  assert {
    condition     = output.image_tag == "stories-agent-0123456789abcdef" && output.ecr_repository_url == "123456789012.dkr.ecr.eu-north-1.amazonaws.com/cf-test-stories-agent"
    error_message = "image_tag is the tag the runtime runs (deploy.yml keeps it when a new image does not build), and the repository URL has no tag."
  }

  assert {
    condition = aws_bedrockagentcore_agent_runtime.agent.environment_variables == tomap({
      CF_STORIES_TABLE  = "cf-test-data"
      CF_MEDIA_BUCKET   = "cf-test-media"
      CF_REGION         = "eu-north-1"
      CF_IMAGE_MODEL_ID = "amazon.nova-canvas-v1:0"
      CF_IMAGE_REGION   = "eu-west-1"
      AWS_REGION        = "eu-north-1"
    })
    error_message = "The runtime gets §45.11.4's settings; CF_VIDEO_BUCKET only while the us-east-1 bucket exists."
  }

  assert {
    condition = (terraform_data.runtime_logs.input.log_group == "/aws/bedrock-agentcore/runtimes/cf_test_story_agent-AbCdEf1234-DEFAULT" &&
      terraform_data.runtime_logs.input.retention_days == 30 && output.log_group_name == terraform_data.runtime_logs.input.log_group &&
    strcontains(file("main.tf"), "Component=stories_agent\""))
    error_message = "The runtime's log group follows the clip runtime's pattern (created if missing, 30 days), tagged stories_agent."
  }

  assert {
    condition     = aws_ecr_repository.agent.tags == tomap({ Component = "stories_agent" }) && aws_iam_role.agent.tags == tomap({ Component = "stories_agent" })
    error_message = "Every resource of the module is tagged Component = stories_agent."
  }

  assert {
    condition     = length(aws_s3_bucket.video_us) == 0 && output.video_bucket == ""
    error_message = "The us-east-1 bucket is off by default (stories_video_us_bucket = false)."
  }
}

run "role_matches_the_contract" {
  command = plan

  assert {
    condition = toset(flatten([for s in jsondecode(aws_iam_role_policy.agent.policy).Statement : s.Action])) == toset([
      "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:GetAuthorizationToken",
      "logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams", "logs:DescribeLogGroups",
      "xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets",
      "cloudwatch:PutMetricData",
      "bedrock-agentcore:GetWorkloadAccessToken", "bedrock-agentcore:GetWorkloadAccessTokenForJWT", "bedrock-agentcore:GetWorkloadAccessTokenForUserId",
      "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:TransactWriteItems", "dynamodb:ConditionCheckItem",
      "dynamodb:GetItem", "dynamodb:Query", "dynamodb:BatchGetItem",
      "s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts", "s3:ListBucket",
      "bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream",
      "secretsmanager:GetSecretValue",
    ])
    error_message = "The story agent's actions must match docs/CONTRACTS.md §45.15 (no Transcribe, no async video jobs while the switch is off)."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement : s.Effect == "Allow" && alltrue([
        for a in flatten([s.Action]) : a != "*" && !endswith(a, ":*") && !startswith(a, "transcribe:") && !startswith(a, "s3vectors:") && !startswith(a, "lambda:")
      ])
    ])
    error_message = "No wildcard action, no Transcribe, no clip vectors and no Lambda callbacks (those are Clip Factory's agent's)."
  }

  # DynamoDB: every statement is on the table only (no index), limited to Lamo Stories' partitions.
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement :
      s.Resource == ["arn:aws:dynamodb:eu-north-1:123456789012:table/cf-test-data"] &&
      s.Condition == { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["USER#*#WS#*", "USER#*#WSREG"] } }
      if anytrue([for a in flatten([s.Action]) : startswith(a, "dynamodb:")])
    ])
    error_message = "Every DynamoDB statement of the story agent is limited by dynamodb:LeadingKeys to USER#*#WS#* and USER#*#WSREG, on the table only."
  }

  # No DynamoDB statement reaches Lamo Clips' own partition or any other; each workspace partition is reachable.
  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement : [
        for key in ["USER#u1", "OAUTH#n1", "OAUTH#ws.n1", "RATE#x", "RATE#WS#stories#x", "HOOK#h1", "FOLLOWED", "CREATOR", "WATCH"] : !anytrue([
          for r in try(s.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"], ["*"]) : can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", key))
        ])
      ] if anytrue([for a in flatten([s.Action]) : startswith(a, "dynamodb:")])
    ]))
    error_message = "The story agent never reads or writes USER#{userId} (Lamo Clips), OAuth states, rate budgets or any other partition."
  }

  assert {
    condition = alltrue([
      for key in ["USER#u1#WS#stories", "USER#u1#WS#01JD0000000000000000000000", "USER#u1#WSREG"] : anytrue([
        for s in jsondecode(aws_iam_role_policy.agent.policy).Statement : anytrue([
          for r in try(s.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"], []) : can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", key))
        ]) if contains(flatten([s.Action]), "dynamodb:UpdateItem")
      ])
    ])
    error_message = "The story agent can update its workspace partitions and the workspace registry."
  }

  # S3: objects only under ws/, listing only with the ws/ prefix.
  assert {
    condition = toset(flatten([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement : s.Resource
      if anytrue([for a in flatten([s.Action]) : startswith(a, "s3:") && a != "s3:ListBucket"])
    ])) == toset(["arn:aws:s3:::cf-test-media/ws/*"])
    error_message = "The story agent's S3 object access is exactly ws/* (§45.4)."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement :
      s.Action == ["s3:ListBucket"] && s.Resource == ["arn:aws:s3:::cf-test-media"] && s.Condition == { StringLike = { "s3:prefix" = ["ws/*"] } }
    ])
    error_message = "ListBucket only with the prefix ws/."
  }

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement : [
        for key in ["uploads/u1/v.mp4", "jobs/j1/clips/c1.mp4", "skills/u1/s1/SKILL.md", "private/u1/cookies.txt", "ask/u1/f1.png", "campaigns/c1/logo.png"] :
        !anytrue([for r in flatten([s.Resource]) : can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", "arn:aws:s3:::cf-test-media/${key}"))])
      ] if anytrue([for a in flatten([s.Action]) : startswith(a, "s3:")])
    ]))
    error_message = "No S3 statement of the story agent reaches a Lamo Clips prefix (uploads/, jobs/, skills/, private/, ask/, campaigns/)."
  }

  # Secrets: only the provider keys of a workspace; never a token, a pending choice or an app key of either app.
  assert {
    condition = toset(flatten([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement : s.Resource if anytrue([for a in flatten([s.Action]) : startswith(a, "secretsmanager:")])
    ])) == toset(["arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/workspaces/*/providers/*"])
    error_message = "The story agent reads only <name>/workspaces/*/providers/* (§45.15)."
  }

  assert {
    condition = alltrue(flatten([
      for sample in [
        "cf-test/platforms/youtube/token-AbC123", "cf-test/platforms/youtube/pending-AbC123", "cf-test/platforms/youtube/app-AbC123",
        "cf-test/platforms/youtube/token", "cf-test/workspaces/stories/youtube/token-AbC123", "cf-test/workspaces/stories/youtube/token",
        "cf-test/workspaces/stories/facebook/pending-AbC123", "cf-test/workspaces/stories/instagram/app-AbC123",
        "cf-test/oauth/state-key-AbC123", "cf-test/ask/search-key-AbC123", "cf-test/agent/youtube-proxy-AbC123",
        ] : [
        for s in jsondecode(aws_iam_role_policy.agent.policy).Statement : [
          for r in flatten([s.Resource]) : !can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", "arn:aws:secretsmanager:eu-north-1:123456789012:secret:${sample}"))
        ] if anytrue([for a in flatten([s.Action]) : startswith(a, "secretsmanager:") || a == "*"])
      ]
    ]))
    error_message = "…:secret:<name>/platforms/youtube/token-AbC123, …/pending-AbC123 and every social token or app key (Lamo Clips' or a workspace's) match no story agent resource."
  }

  assert {
    condition = alltrue([
      for sample in ["cf-test/workspaces/stories/providers/acme-AbC123", "cf-test/workspaces/stories/providers/acme"] : anytrue(flatten([
        for s in jsondecode(aws_iam_role_policy.agent.policy).Statement : [
          for r in flatten([s.Resource]) : can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", "arn:aws:secretsmanager:eu-north-1:123456789012:secret:${sample}"))
        ] if contains(flatten([s.Action]), "secretsmanager:GetSecretValue")
      ]))
    ])
    error_message = "The story agent can read a provider key the owner saved (by its full and its bare name)."
  }

  # Logs: its own runtime's group only, never the clip runtime's.
  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement : [
        for r in flatten([s.Resource]) : !can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", "arn:aws:logs:eu-north-1:123456789012:log-group:/aws/bedrock-agentcore/runtimes/cf_test_clip_agent-AbCdEf1234-DEFAULT:log-stream:x"))
      ] if anytrue([for a in flatten([s.Action]) : contains(["logs:CreateLogStream", "logs:PutLogEvents", "logs:CreateLogGroup"], a)])
    ]))
    error_message = "The story agent never writes the clip runtime's log group."
  }

  assert {
    condition = anytrue(flatten([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement : [
        for r in flatten([s.Resource]) : can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", "arn:aws:logs:eu-north-1:123456789012:log-group:/aws/bedrock-agentcore/runtimes/cf_test_story_agent-AbCdEf1234-DEFAULT:log-stream:x"))
      ] if contains(flatten([s.Action]), "logs:PutLogEvents")
    ]))
    error_message = "The story agent writes its own runtime's log streams."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement :
      s.Sid == "PullImage" && s.Resource == "arn:aws:ecr:eu-north-1:123456789012:repository/cf-test-stories-agent"
    ])
    error_message = "The runtime pulls only from its own repository, never cf-prod-agent."
  }

  assert {
    condition = jsondecode(aws_iam_role.agent.assume_role_policy).Statement == [{
      Effect    = "Allow"
      Principal = { Service = "bedrock-agentcore.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = "123456789012" }
        ArnLike      = { "aws:SourceArn" = "arn:aws:bedrock-agentcore:eu-north-1:123456789012:*" }
      }
    }]
    error_message = "Only AgentCore in this account may assume the story agent's role."
  }
}

# The Bedrock grants: every reasoning model the owner may pick or add (§45.34: any foundation model, any inference
# profile and application inference profile of this account, Converse and ConverseStream only), which covers each
# model of stories/config/models.json (model_invoke_arns, built from that file as the clip agent's are built from
# config/models.json), plus Nova Canvas in eu-west-1; never Clip Factory's file.
run "models_come_from_the_stories_file" {
  command = plan

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement :
      s.Sid == "StoryModels" && s.Action == ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"] && toset(s.Resource) == toset([
        "arn:aws:bedrock:*::foundation-model/*",
        "arn:aws:bedrock:*:123456789012:inference-profile/*",
        "arn:aws:bedrock:*:123456789012:application-inference-profile/*",
      ])
    ])
    error_message = "StoryModels grants Converse and ConverseStream on every foundation model and on this account's inference profiles and application inference profiles, nothing more (§45.34)."
  }

  assert {
    condition = alltrue([
      for arn in concat(output.model_invoke_arns, [
        "arn:aws:bedrock:eu-west-1:123456789012:inference-profile/eu.meta.llama-custom-v1:0",
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123",
        "arn:aws:bedrock:us-west-2::foundation-model/mistral.mistral-large-custom",
        "arn:aws:bedrock:::foundation-model/anthropic.claude-fable-5-2",
        ]) : anytrue([
        for s in jsondecode(aws_iam_role_policy.agent.policy).Statement : anytrue([
          for r in s.Resource : can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", arn))
        ]) if s.Sid == "StoryModels"
      ])
    ])
    error_message = "Every bundled model (its profile and foundation models) and a model the owner adds (any Region, profile or application profile of this account) is covered by StoryModels."
  }

  assert {
    condition = !anytrue([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement : anytrue([
        for r in s.Resource : can(regex("^${replace(replace(replace(r, ".", "\\."), "?", "."), "*", ".*")}$", "arn:aws:bedrock:eu-north-1:999999999999:inference-profile/global.anthropic.claude-opus-5-5"))
      ]) if s.Sid == "StoryModels"
    ])
    error_message = "Inference profiles of another account are never granted."
  }

  assert {
    condition = !anytrue(flatten([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement : [for a in flatten([s.Action]) : a == "bedrock:StartAsyncInvoke" || a == "bedrock:*"]
    ]))
    error_message = "With the bucket switch off nothing can start a Nova Reel job (the wide model grant is Converse and ConverseStream only)."
  }

  assert {
    condition = (contains(output.model_invoke_arns, "arn:aws:bedrock:eu-north-1:123456789012:inference-profile/global.anthropic.claude-opus-5-5") &&
      contains(output.model_invoke_arns, "arn:aws:bedrock:*::foundation-model/anthropic.claude-fable-5-2") &&
      contains(output.model_invoke_arns, "arn:aws:bedrock:eu-north-1:123456789012:inference-profile/eu.anthropic.claude-haiku-5-5") &&
      contains(output.model_invoke_arns, "arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-haiku-5-5") &&
    !contains(output.model_invoke_arns, "arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-5-5"))
    error_message = "Global profiles reach their model in any Region; Haiku's EU geo profile only in its six EU Regions."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement :
      s.Sid == "ImageModel" && s.Action == ["bedrock:InvokeModel"] && s.Resource == ["arn:aws:bedrock:eu-west-1::foundation-model/amazon.nova-canvas-v1:0"]
    ]) && output.image_model_arn == "arn:aws:bedrock:eu-west-1::foundation-model/amazon.nova-canvas-v1:0"
    error_message = "Nova Canvas is granted in eu-west-1 only, by its own model id (imageModel)."
  }

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement : [
        for r in flatten([s.Resource]) : r != "*" && !strcontains(r, "titan-embed") && !strcontains(r, "nova-2-lite") && !strcontains(r, "nova-reel")
      ] if anytrue([for a in flatten([s.Action]) : startswith(a, "bedrock:")])
    ]))
    error_message = "No Bedrock wildcard, none of Clip Factory's other models (embeddings, the watch model), and no Nova Reel while its switch is off."
  }

  assert {
    condition     = length(output.model_invoke_arns) > 0 && !strcontains(file("main.tf"), "../config/models.json") && !strcontains(file("main.tf"), "}/config/models.json")
    error_message = "Clip Factory's config/models.json is never read by Lamo Stories' agent (§45.11.4)."
  }
}

run "geo_and_in_region_models" {
  command = plan

  variables {
    models_config_path = "tests/fixtures/models-geo.json"
  }

  assert {
    condition = toset(output.model_invoke_arns) == toset([
      "arn:aws:bedrock:eu-north-1:123456789012:inference-profile/global.anthropic.claude-g",
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-g",
      "arn:aws:bedrock:eu-north-1:123456789012:inference-profile/eu.anthropic.claude-e",
      "arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-e",
      "arn:aws:bedrock:eu-north-1::foundation-model/anthropic.claude-e",
      "arn:aws:bedrock:eu-north-1::foundation-model/amazon.r-v1:0",
    ])
    error_message = "A global profile: the profile plus the model anywhere; a geo profile: the profile plus each listed Region; no profile: the model in this Region."
  }
}

run "a_wildcard_model_stops_the_plan" {
  command = plan

  variables {
    models_config_path = "tests/fixtures/models-wildcard.json"
  }

  expect_failures = [aws_iam_role_policy.agent]
}

run "provider_keys_pattern_is_checked" {
  command = plan

  variables {
    workspace_provider_secrets_arn = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:cf-test/workspaces/*"
  }

  expect_failures = [var.workspace_provider_secrets_arn]
}

# §45.31 and ADR-80: the Nova Reel switch adds the us-east-1 bucket (private, TLS only, 14 days), its grants and
# CF_VIDEO_BUCKET, and nothing else.
run "nova_reel_bucket_switch_on" {
  command = plan

  variables {
    stories_video_us_bucket = true
  }

  assert {
    condition     = aws_s3_bucket.video_us[0].bucket == "cf-test-stories-video-123456789012-us" && output.video_bucket == "cf-test-stories-video-123456789012-us"
    error_message = "The bucket is <name>-stories-video-<account>-us."
  }

  assert {
    condition = (length(aws_s3_bucket.video_us) == 1 && length(regexall("(?m)^  provider\\s+= aws\\.us_east_1$", file("main.tf"))) == 6 &&
    length(regexall("aws\\.us_east_1", file("main.tf"))) == 7)
    error_message = "Every resource of the bucket is made through the aliased us-east-1 provider (Nova Reel writes only there)."
  }

  assert {
    condition = (aws_s3_bucket_public_access_block.video_us[0].block_public_acls && aws_s3_bucket_public_access_block.video_us[0].block_public_policy &&
      aws_s3_bucket_public_access_block.video_us[0].ignore_public_acls && aws_s3_bucket_public_access_block.video_us[0].restrict_public_buckets &&
    one(aws_s3_bucket_ownership_controls.video_us[0].rule).object_ownership == "BucketOwnerEnforced")
    error_message = "The bucket is private."
  }

  assert {
    condition = jsondecode(aws_s3_bucket_policy.video_us[0].policy).Statement == [{
      Sid       = "TlsOnly"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = ["arn:aws:s3:::cf-test-stories-video-123456789012-us", "arn:aws:s3:::cf-test-stories-video-123456789012-us/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
    error_message = "The bucket refuses every request without TLS."
  }

  assert {
    condition = (one(one(aws_s3_bucket_lifecycle_configuration.video_us[0].rule).expiration).days == 14 &&
    one(aws_s3_bucket_lifecycle_configuration.video_us[0].rule).status == "Enabled")
    error_message = "Generated shots are deleted after 14 days."
  }

  assert {
    condition     = aws_bedrockagentcore_agent_runtime.agent.environment_variables["CF_VIDEO_BUCKET"] == "cf-test-stories-video-123456789012-us"
    error_message = "With the switch on, the runtime gets CF_VIDEO_BUCKET."
  }

  assert {
    condition = (anytrue([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement :
      s.Sid == "VideoModel" && toset(s.Action) == toset(["bedrock:InvokeModel", "bedrock:StartAsyncInvoke"]) &&
      toset(s.Resource) == toset(["arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-reel-v1:1", "arn:aws:bedrock:us-east-1:123456789012:async-invoke/*"])
      ]) && anytrue([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement :
      s.Sid == "VideoJobs" && s.Action == ["bedrock:GetAsyncInvoke"] && s.Resource == ["arn:aws:bedrock:us-east-1:123456789012:async-invoke/*"]
    ]))
    error_message = "With the switch on: StartAsyncInvoke and GetAsyncInvoke on Nova Reel in us-east-1 only."
  }

  assert {
    condition = toset(flatten([
      for s in jsondecode(aws_iam_role_policy.agent.policy).Statement : s.Resource if startswith(s.Sid, "VideoFiles")
    ])) == toset(["arn:aws:s3:::cf-test-stories-video-123456789012-us/*", "arn:aws:s3:::cf-test-stories-video-123456789012-us"])
    error_message = "The video grants reach only the us-east-1 bucket."
  }

  # Everything that is not the video switch's stays as it is with the switch off.
  assert {
    condition = toset([for s in jsondecode(aws_iam_role_policy.agent.policy).Statement : s.Sid if !startswith(s.Sid, "Video")]) == toset([
      "PullImage", "EcrToken", "Logs", "LogGroups", "Tracing", "Metrics", "WorkloadIdentity", "StoryWrites", "StoryReads",
      "StoryFiles", "StoryFilesList", "StoryModels", "ImageModel", "ProviderKeys",
    ])
    error_message = "The switch adds only the Video statements."
  }
}

run "roles_carry_the_permissions_boundary" {
  command = plan

  variables {
    permissions_boundary_arn = "arn:aws:iam::123456789012:policy/cf-test-role-boundary"
  }

  assert {
    condition     = aws_iam_role.agent.permissions_boundary == "arn:aws:iam::123456789012:policy/cf-test-role-boundary"
    error_message = "The story agent's role carries the deploy role's permissions boundary."
  }
}
