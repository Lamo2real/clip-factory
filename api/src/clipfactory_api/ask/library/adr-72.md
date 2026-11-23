## ADR-72 Separate social connections: own tokens, one callback, the owner's choice of developer app

- **Context.** The owner wants different accounts for Funded Clips on every platform and no accidental posting to
  Lamo Clips' destinations. He set up one developer app per platform (13 manual steps for YouTube) and asked never to
  have to redo it. Each app has one registered redirect URI, `…/oauth/{platform}/callback`. Lamo Clips' tokens are
  `cf-prod/platforms/{platform}/token`, one per platform, read by the clip flow, stats and money functions.
- **Options.** (1) A second developer app per platform for Funded Clips (hours of manual setup and platform reviews
  again); (2) the same apps and the same callback, with the stored OAuth state telling the callback which workspace it
  serves, tokens under a second Secrets Manager prefix; (3) nest Funded Clips tokens under `cf-prod/platforms/` (no IAM
  change, but every Lamo Clips function could read them).
- **Decision.** (CONTRACTS §45.13) Option 2 for the callback and the tokens; which developer app each platform uses is
  the owner's explicit choice, his own or Clip Factory's (ADR-79). A Funded Clips connect uses its own state format
  (`w1.` with the workspace id inside the signature) and its own state items (`OAUTH#ws.{nonce}`). Clip Factory's
  callback only forwards a `w1.` state to Funded Clips' own callback route on `cf-prod-stories-api` (Clip Factory's
  registered apps are not edited, so their redirect URI stays the hooks one); `v1.` states run today's code
  unchanged. Only Funded Clips' Lambda writes `cf-prod/workspaces/{workspaceId}/{platform}/token` and `SOCIAL#`. One account per platform per
  workspace. YouTube connects the one channel picked in Google's picker (`prompt=select_account consent`): a token
  posts to exactly one channel, so there is no channel list to choose from; Meta lists Pages. An identity equal to
  Lamo Clips' own is held as `same_as_clips` until the owner says "Use it for both". Disconnect never calls a
  platform's revoke endpoint (Google's and TikTok's revoke end the app's whole grant for that account, which can be
  Lamo Clips' too, as §40 found for AdSense).
- **Consequences.** With Clip Factory's app (YouTube, TikTok, X), quotas, credits and the owner's monthly X limit are
  shared (and counted together), and TikTok's Sandbox, private-account and review limits apply to both; a later key
  change asks Funded Clips to connect again. Meta always needs Funded Clips' own app, so Clip Factory's Meta grant is
  never touched.
  A Disconnect leaves the grant at the platform; the page says where to remove it by hand. `hooks.py` gains one
  forward, proven not to change the old path, and no IAM.
- **Amended by ADR-84 (2026-11-22).** "Use it for both" is gone: an account that is Clip Factory's own is never
  posted to, by any stable identity, at connect and before every upload, and the match is remembered (§45.37 G8).
