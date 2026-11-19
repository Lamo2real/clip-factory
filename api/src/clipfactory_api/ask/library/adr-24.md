## ADR-24 A separate REST API for public platform webhooks

- **Context.** Phase 2 needs public endpoints that YouTube, Meta, TikTok and X can call: webhook verification, webhook
  events and OAuth callbacks. They cannot carry the owner's Cognito token. The owner asked for "HTTP, REST API on those
  API gateways".
- **Decision.** A Regional API Gateway REST API `cf-prod-hooks` (stage `v1`) with `/hooks/{platform}` (GET, POST) and
  `/oauth/{platform}/callback` (GET), no authorization, a required `platform` path parameter, per-method throttling
  (10 requests a second, burst 20), a usage plan as a ceiling, X-Ray, and access logs without the query string. One
  Lambda, `cf-prod-hooks`, answers challenges (the Meta verify token is an SSM SecureString generated as a write-only
  value), stores events as `HOOK#` items with a 14-day TTL, and redirects OAuth callbacks to Settings until phase 2.
- **Alternatives.** *More routes on the HTTP API* (cheaper per request, but it would mix unauthenticated public routes
  into the JWT-protected app API, and HTTP APIs have no usage plans, request validators or per-method throttling).
  *Lambda function URLs* (no throttling or validation in front of the code).
- **Consequences.** The app API stays JWT-only; the public surface is small, throttled and separately logged and
  alarmed (`cf-prod-hooks-5xx`). REST API logging needs the account-level API Gateway CloudWatch role, which Terraform
  manages behind `manage_api_gateway_account` ([DEPLOYMENT.md](DEPLOYMENT.md#5-api-gateway-logging-role-one-per-account-and-region)).
  CreateDeployment is limited to one call every 5 seconds per account, so the WebSocket module deploys after the REST
  module. Signature checks are a stub (`unverified`) until the platforms' app secrets exist in phase 2.
