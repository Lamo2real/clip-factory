## ADR-73 Publishing isolation: checked before every call, no default account, IAM as the last wall

- **Context.** "A video created in Lamo Stories must only be published to Lamo Stories-connected accounts", every
  publishing job must reference workspace, content, social account, platform and status, the relationships must be
  validated before every operation, and a missing or ambiguous destination must stop and ask. The platform publishers
  (§17.6) take their credentials and video in a `PublishJob` and touch no store.
- **Options.** (1) Teach the clip flow about workspaces (changes Lamo Clips' most delicate code); (2) a new durable
  function for Lamo Stories that reuses the publishers unchanged, with one validation function run by the API at the
  tap and by the flow before each platform call, and its own IAM role.
- **Decision.** (CONTRACTS §45.14, §45.15) Option 2: `cf-prod-story-flow`. A publishing job records the account's
  identity at the tap; the flow re-checks the workspace, the story, the account (same partition, same platform,
  connected, same identity, not Lamo Clips' own unless shared on purpose) and builds the secret name from the checked
  ids only. Its role can read `cf-prod/workspaces/*` and the `…/app` secrets and nothing else; the Lamo Clips roles
  cannot read `cf-prod/workspaces/*`.
- **Consequences.** A code mistake in either flow cannot reach the other workspace's tokens (Terraform tests hold the
  policies). A reconnect to a different account stops queued jobs instead of sending them somewhere new. Lamo Stories
  numbers are read by the flow at 1 h, 24 h and 72 h, not by the 15-minute stats poller.
