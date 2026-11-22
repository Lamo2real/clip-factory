variable "region" {
  type        = string
  default     = "eu-north-1"
  description = "One region for everything (CloudFront is global)."
}

variable "owner_email" {
  type        = string
  description = "The only login. Cognito emails it a temporary password on the first deploy."
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.owner_email))
    error_message = "owner_email must be an email address."
  }
}

variable "agent_image_tag" {
  type        = string
  description = "Tag of the agent image. The deploy workflow sets it from a hash of agent/, skills/ and config/, so it only changes when the agent changes. terraform apply builds and pushes it before the runtime."
  validation {
    condition     = can(regex("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$", var.agent_image_tag))
    error_message = "agent_image_tag must be a valid Docker tag (letters, digits, _ . -, at most 128 characters)."
  }
}

variable "stories_agent_image_tag" {
  type        = string
  description = "Tag of Lamo Stories' agent image (docs/CONTRACTS.md §45.15). The deploy workflow sets it to stories-agent- plus a hash of stories/** and web/src/stories/engine/**, so it only changes when Lamo Stories' agent changes; Clip Factory's agent_image_tag never changes because of it. terraform apply builds and pushes it before the runtime."
  validation {
    condition     = can(regex("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$", var.stories_agent_image_tag))
    error_message = "stories_agent_image_tag must be a valid Docker tag (letters, digits, _ . -, at most 128 characters)."
  }
}

variable "stories_video_us_bucket" {
  type        = bool
  default     = false
  description = "Amazon Nova Reel for Lamo Stories (docs/CONTRACTS.md §45.31): true makes the bucket cf-prod-stories-video-<account>-us in us-east-1 (private, TLS only, shots kept 14 days) and lets cf_prod_story_agent start Nova Reel jobs there. Off until the owner allows Lamo Stories to keep generated shots in the US (N. Virginia)."
}

variable "stories_video_west_bucket" {
  type        = bool
  default     = false
  description = "Luma AI Ray2 for Lamo Stories (docs/CONTRACTS.md §45.37 G7): true makes the bucket cf-prod-stories-video-<account>-usw2 in us-west-2 (private, TLS only, shots kept 14 days) and lets cf_prod_story_agent start Luma AI Ray2 jobs there. Off until the owner allows Lamo Stories to keep generated shots in the US (Oregon)."
}

variable "app_version" {
  type        = string
  default     = ""
  description = "Release version reported by GET /v1/health: the git sha the deploy workflow passes as TF_VAR_app_version (the same value config.json and version.json carry). Empty: falls back to agent_image_tag."
  validation {
    condition     = var.app_version == "" || can(regex("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$", var.app_version))
    error_message = "app_version must be empty or a short version string (letters, digits, _ . -, at most 128 characters)."
  }
}

variable "lambda_zip_path" {
  type        = string
  default     = "../../../api/dist/lambda.zip"
  description = "The API package, built before plan. Relative to infra/envs/prod."
}

variable "alarm_email" {
  type        = string
  default     = ""
  description = "Optional address for alarm emails (Lambda errors, failed or timed-out durable executions, live-update lag, webhook 5xx). Empty: no email."
  validation {
    condition     = var.alarm_email == "" || can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alarm_email))
    error_message = "alarm_email must be empty or an email address."
  }
}

variable "web_dev_origin" {
  type        = string
  default     = "http://localhost:5173"
  description = "Local Vite dev server, allowed by the API's and the media bucket's CORS."
}

variable "content_rewards_enabled" {
  type        = bool
  default     = true
  description = "Content Rewards campaigns (docs/CONTRACTS.md §38.16). On: every builder's part of §38.19 has merged. Set false to turn it off again; then every /v1/contentrewards route answers 503 and the clip flow sends nothing."
}

variable "cr_remake_enabled" {
  type        = bool
  default     = true
  description = "The campaign copy of a clip (docs/CONTRACTS.md §39.3, CR_REMAKE). On: G, H and I of §39.4 have merged. Set false to turn it off again; then the copy route answers 503 \"Coming soon.\" and no fit offers a copy."
}

variable "cr_finder_enabled" {
  type        = bool
  default     = true
  description = "The campaign finder (docs/CONTRACTS.md §41, CR_FINDER on cf-prod-api, cf-prod-stats and cf-prod-campaigns). On: P, Q, R, S and T of §41.6 have merged. Set false to turn it off again (the same day if Content Rewards or Whop asks Clip Factory to stop reading): every finder route answers 503 \"Coming soon.\", the tick starts no look and the stored items stay."
}

variable "whop_connect_enabled" {
  type        = bool
  default     = true
  description = "\"Connect Whop\" on the Content Rewards Get paid page (docs/CONTRACTS.md §40.6, WHOP_CONNECT on cf-prod-api). On: K, L and M of §40.8 have merged. Set false to turn it off again: the card says \"Coming soon: your Whop payouts here.\", the Whop routes answer 503 and every saved key, token and payout stays."
}

variable "bank_reading_enabled" {
  type        = bool
  default     = false
  description = "Your bank (docs/CONTRACTS.md §40.5, ADR-82: Enable Banking restricted mode, BANK_READING on cf-prod-api and cf-prod-money). Off until BA, BR, BW and BD of §40.5.12 have merged; then one switch PR sets it to true. Set false to turn it off again (the same day if Enable Banking says no): every screen says \"Clip Factory can't see your bank.\", the bank routes answer 503, the daily read stops, and every stored deposit, payer, link and secret stays."
}

variable "help_enabled" {
  type        = bool
  default     = true
  description = "Ask Clip Factory, the in-app help assistant (docs/CONTRACTS.md §19). On in prod; the HELP/SWITCH item in the table turns it (or only its model) off without a deploy."
}

variable "help_monthly_cap" {
  type        = number
  default     = 2000
  description = "Most model-written help answers per 30-day window (§19.6). Past it, answers are the plain ones from the help knowledge."
  validation {
    condition     = var.help_monthly_cap >= 0 && floor(var.help_monthly_cap) == var.help_monthly_cap
    error_message = "help_monthly_cap must be a whole number, 0 or more."
  }
}

variable "manage_api_gateway_account" {
  type        = bool
  default     = true
  description = "Set the account's API Gateway CloudWatch logging role (one per account and Region; needed for REST and WebSocket logs). false when the account's setting is managed elsewhere."
}

variable "role_permissions_boundary_arn" {
  type        = string
  default     = ""
  description = "Permissions boundary every cf-prod-* IAM role carries (infra/bootstrap output role_boundary_arn; deploy.yml passes the repository variable CF_ROLE_BOUNDARY_ARN). Empty: no boundary, only for a deploy role without the boundary rule (docs/DEPLOYMENT.md)."
  validation {
    condition     = var.role_permissions_boundary_arn == "" || can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:policy/[A-Za-z0-9+=,.@_/-]+$", var.role_permissions_boundary_arn))
    error_message = "role_permissions_boundary_arn must be empty or an IAM policy ARN (arn:aws:iam::<account>:policy/<name>)."
  }
}

variable "ask_enabled" {
  type        = bool
  default     = true
  description = "Ask as a full assistant (docs/CONTRACTS.md §28): ASK_ENABLED on cf-prod-api. The kill switch item (HELP/SWITCH assistant) can still turn it off without a deploy."
}

variable "ask_tokens_alarm_threshold" {
  type        = number
  default     = 20000000
  description = "Ask's new input tokens in 24 hours before the cf-prod-ask-tokens-day alarm tells the owner. It blocks nothing."
}

variable "ask_eager_tools" {
  type        = bool
  default     = true
  description = "ASK_EAGER_TOOLS on cf-prod-ask: eager_input_streaming on Ask's tools. Set false if Bedrock rejects the field (docs/DEPLOYMENT.md)."
}
