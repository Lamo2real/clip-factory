## ADR-76 Lamo Stories is its own application: its own API Lambda, AgentCore runtime and IAM roles

- **Context.** The owner's second request (2026-11-21): "Lamo Stories must be treated as an independent application
  within the existing Clip Factory application shell … The only shared element should be the application shell",
  with its own AgentCore environment, agents, skills, models, chat, memory, settings, OAuth credentials and data, "two
  separate applications accessible through one desktop application", while shared AWS infrastructure is fine "where
  appropriate" with "strict authorization and data boundaries". The first plan ran Lamo Stories' routes in
  `cf-prod-api` and its videos as new actions of Clip Factory's agent runtime.
- **Options.** (1) Keep the first plan (one API Lambda and one agent runtime, separated in code only); (2) separate
  route modules in `cf-prod-api` but Lamo Stories' own runtime; (3) Lamo Stories' own Lambda (`cf-prod-stories-api`,
  the same zip and HTTP API, its own routes and role) and its own AgentCore runtime (`cf_prod_story_agent`, its own
  image from `stories/agent/`, role and sessions), each role allowed only Lamo Stories' keys, prefix and secrets;
  (4) a second AWS account or a second app (duplicated sign-in and infrastructure, which the first request ruled out).
- **Decision.** (CONTRACTS §45.24, §45.15) Option 3. Shared on purpose: the shell and Cognito sign-in, the HTTP API
  (separate routes), the table, bucket and Secrets Manager (separate namespaces, enforced by IAM leading keys and
  prefixes), Clip Factory's OAuth callback only as a forward of `w1.` states (its registered apps are not edited),
  and the platform publisher library code.
- **Consequences.** Clip Factory's API Lambda, its route table, its agent runtime, image and roles do not change at
  all, and a Lamo Stories change never redeploys or drains them. Lamo Stories has its own image to build and its own
  CI job. Code shared as a library (the publishers, `db`, `http.dispatch`) is used read-only; a change there is a
  Clip Factory change and is reviewed as one.
