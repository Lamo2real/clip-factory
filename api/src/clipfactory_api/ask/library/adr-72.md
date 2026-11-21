## ADR-72 Separate social connections over the same developer apps

- **Context.** The owner wants different accounts for Lamo Stories on every platform and no accidental posting to
  Lamo Clips' destinations. He set up one developer app per platform (13 manual steps for YouTube) and asked never to
  have to redo it. Each app has one registered redirect URI, `…/oauth/{platform}/callback`. Lamo Clips' tokens are
  `cf-prod/platforms/{platform}/token`, one per platform, read by the clip flow, stats and money functions.
- **Options.** (1) A second developer app per platform for Lamo Stories (hours of manual setup and platform reviews
  again); (2) the same apps and the same callback, with the stored OAuth state telling the callback which workspace it
  serves, tokens under a second Secrets Manager prefix; (3) nest Lamo Stories tokens under `cf-prod/platforms/` (no IAM
  change, but every Lamo Clips function could read them).
- **Decision.** (CONTRACTS §45.13) Option 2. A Lamo Stories connect uses its own state format (`w1.` with the
  workspace id inside the signature) and the callback routes on that prefix before verifying anything: `v1.` states
  run today's code unchanged, `w1.` states always land on Lamo Stories' Connections page and write only
  `cf-prod/workspaces/{workspaceId}/{platform}/token` and a `SOCIAL#{platform}` item. One account per platform per
  workspace. YouTube connects the one channel picked in Google's picker (`prompt=select_account consent`): a token
  posts to exactly one channel, so there is no channel list to choose from; Meta lists Pages. An identity equal to
  Lamo Clips' own is held as `same_as_clips` until the owner says "Use it for both". Disconnect never calls a
  platform's revoke endpoint (Google's and TikTok's revoke end the app's whole grant for that account, which can be
  Lamo Clips' too, as §40 found for AdSense).
- **Consequences.** No platform setup again. App keys are shared, so quotas, credits and the owner's monthly X limit
  are shared (and counted together), and TikTok's Sandbox, private-account and review limits apply to both; a later
  key change in Lamo Clips asks Lamo Stories to connect again. Meta's page picker is per Facebook login: unticking
  Lamo Clips' Page while connecting Lamo Stories would cut Lamo Clips off, so the page says so and checks afterwards.
  A Disconnect leaves the grant at the platform; the page says where to remove it by hand. The OAuth callback and
  `hooks.py` gain one prefix branch, proven not to change the old path.
