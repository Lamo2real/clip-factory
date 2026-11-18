# Cognito (docs/CONTRACTS.md §3): one owner, created here, no self-sign-up. The web app signs in with SRP on its
# own screen (Amplify v6); the HTTP API checks the access token with a JWT authorizer.
terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

locals {
  tags = { Component = "auth" }
}

resource "aws_cognito_user_pool" "this" {
  name                     = "${var.name}-users"
  deletion_protection      = var.deletion_protection ? "ACTIVE" : "INACTIVE"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  user_pool_tier           = "ESSENTIALS" # refresh token rotation needs Essentials or Plus

  username_configuration {
    case_sensitive = false
  }

  admin_create_user_config {
    allow_admin_create_user_only = true
    invite_message_template {
      email_subject = "Your Clip Factory account is ready"
      email_message = "<p>Hi,</p><p>Your Clip Factory account is ready.</p><p><b>1.</b> Open <a href=\"${var.app_url}/\">${var.app_url}</a></p><p><b>2.</b> Sign in with your email <b>{username}</b> and this temporary password: <b>{####}</b><br>(it works once and expires in 7 days)</p><p><b>3.</b> Choose your own password. You use it from then on.</p><p>Clip Factory</p>"
      sms_message   = "Clip Factory: user {username}, temporary password {####}"
    }
  }

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "Your Clip Factory code"
    email_message        = "<p>Your Clip Factory code is <b>{####}</b>.</p><p>If you did not ask for it, you can ignore this email.</p>"
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  tags = local.tags

  # Owner rule (2026-11-17): holds the owner's sign-in, so Terraform must never destroy or replace it. The deploy's
  # delete gate (scripts/check-plan-deletes.sh) checks the plan too.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_cognito_user_pool_client" "web" {
  name            = "${var.name}-web"
  user_pool_id    = aws_cognito_user_pool.this.id
  generate_secret = false
  # SRP only. ALLOW_REFRESH_TOKEN_AUTH is left out on purpose: with rotation on, Cognito refuses it and Amplify
  # refreshes through GetTokensFromRefreshToken instead.
  explicit_auth_flows           = ["ALLOW_USER_SRP_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true
  access_token_validity         = 15
  id_token_validity             = 15
  refresh_token_validity        = 30
  # Minutes the sign-in session (the challenge between steps) stays valid. The default 3 is too short for the
  # first sign-in, where the owner reads the temporary password from email and then chooses their own.
  auth_session_validity = 15
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
  refresh_token_rotation {
    feature                    = "ENABLED"
    retry_grace_period_seconds = 10
  }
}

# Cognito emails the temporary password; the owner chooses their own on first sign-in.
resource "aws_cognito_user" "owner" {
  user_pool_id             = aws_cognito_user_pool.this.id
  username                 = var.owner_email
  desired_delivery_mediums = ["EMAIL"]
  attributes = {
    email          = var.owner_email
    email_verified = "true"
  }
  lifecycle {
    ignore_changes = [attributes, temporary_password]
    # The owner's account: never destroyed by a deploy (owner rule, 2026-11-17).
    prevent_destroy = true
  }
}
