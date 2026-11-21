## ADR-72 Separate social connections over the same developer apps

- **Context.** The owner wants different accounts for Lamo Stories on every platform and no accidental posting to
  Lamo Clips' destinations. He set up one developer app per platform (13 manual steps for YouTube) and asked never to
  have to redo it. Each app has one registered redirect URI, `…/oauth/{platform}/callback`. Lamo Clips' tokens are
  `cf-prod/platforms/{platform}/token`, one per platform, read by the clip flow, stats and money functions.
- **Options.** (1) A second developer app per platform for Lamo Stories (hours of manual setup and platform reviews
  again); (2) the same apps and the same callback, with the stored OAuth state telling the callback which workspace it
  serves, tokens under a second Secrets Manager prefix; (3) nest Lamo Stories tokens under `cf-prod/platforms/` (no IAM
  change, but every Lamo Clips function could read them).
- **Decision.** (CONTRACTS §45.13) Option 2. The state item gains `workspaceId`; only then does the callback take the
  workspace path, which writes `cf-prod/workspaces/{workspaceId}/{platform}/token` and a `SOCIAL#{platform}` item and
  nothing of Lamo Clips. One account per platform per workspace. YouTube connects with `prompt=select_account
  consent` and lists every channel the token can post to; Meta lists Pages. An identity equal to Lamo Clips' own is
  held as `same_as_clips` until the owner says "Use it for both".
- **Consequences.** No platform setup again. App keys are shared, so quotas and credits are shared (YouTube's daily
  units, X's credits) and TikTok's Sandbox and review limits apply to both. Meta's page picker is per Facebook login:
  unticking Lamo Clips' Page while connecting Lamo Stories would cut Lamo Clips off, so the page says so and checks
  afterwards. The OAuth callback gains one branch, proven not to change the old path.
