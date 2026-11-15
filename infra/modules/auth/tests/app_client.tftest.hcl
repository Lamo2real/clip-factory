# Offline plan test (mock AWS provider, no credentials, no AWS calls):
#   cd infra/modules/auth && terraform init -backend=false && terraform test
#
# On first sign-in the owner reads the temporary password from email and then chooses their own. Both steps run in
# one Cognito auth session, which by default expires after 3 minutes; that is too short, so it is set to 15.

mock_provider "aws" {}

variables {
  name        = "cf-test"
  owner_email = "owner@example.test"
  app_url     = "https://app.example.test"
}

run "first_sign_in_session_lasts_fifteen_minutes" {
  command = plan

  assert {
    condition     = aws_cognito_user_pool_client.web.auth_session_validity == 15
    error_message = "auth_session_validity must be 15 minutes so the choose-a-password step does not expire."
  }
}
