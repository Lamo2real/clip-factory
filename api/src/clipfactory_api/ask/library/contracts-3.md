## 3. Authentication (Cognito)

* One user pool `cf-prod-users`, **admin-create only** (no sign-up). Terraform creates the owner from `owner_email`
  (Cognito emails a temporary password; first sign-in sets a new one).
* App client `cf-prod-web`: public (no secret), `ALLOW_USER_SRP_AUTH` only, `access_token_validity = 15`,
  `id_token_validity = 15` (minutes), `refresh_token_validity = 30` (days), **refresh token rotation ENABLED**
  (`retry_grace_period_seconds = 10`), token revocation on, `prevent_user_existence_errors = ENABLED`.
  Rotation means every refresh issues a new 30-day refresh token: an owner who uses the app stays signed in
  indefinitely; one month of inactivity requires a new sign-in.
* The web app uses **AWS Amplify v6** (`aws-amplify/auth`: `signIn`, `confirmSignIn` for NEW_PASSWORD_REQUIRED,
  `fetchAuthSession`, `signOut`). Amplify refreshes tokens itself. Its own glassy sign-in screen, no hosted UI.
* API: API Gateway HTTP API **JWT authorizer** (issuer `https://cognito-idp.<region>.amazonaws.com/<poolId>`,
  audience = app client id). The web sends `Authorization: Bearer <accessToken>`. Lambdas read the user id from
  `requestContext.authorizer.jwt.claims.sub`; never from the body.
* WebSocket API: the same access token in the `$connect` query string (`?token=`), checked by the Lambda REQUEST
  authorizer `cf-prod-ws-authorizer` (§14.2). The REST API (§14.3) is public (platform webhooks), no Cognito.
