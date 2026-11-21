## ADR-79 Developer apps: the owner picks Lamo Stories' own or Clip Factory's, per platform, never silently

- **Context.** The second request: Lamo Stories' "own OAuth credentials", "Do not reuse Clip Factory OAuth tokens. Do
  not modify existing OAuth authorizations." The tokens are already separate (ADR-72). A separate developer app means
  new setup and, for TikTok and Meta, a new app review that takes days to weeks; Meta's page picker is per login and
  per app, so re-authorizing Clip Factory's Meta app for a second Page can change Clip Factory's grant.
- **Options.** (1) Always Clip Factory's apps; (2) always new apps; (3) the owner's explicit choice per platform,
  shown on the card, with the trade-offs in plain words, and a recommendation of a separate app for Meta.
- **Decision.** (CONTRACTS §45.30) Option 3 for YouTube, TikTok and X; **Facebook and Instagram always use Lamo
  Stories' own Meta app** (re-authorizing Clip Factory's Meta app would change its existing grant). No default, no
  fallback; own keys in `cf-prod/workspaces/{ws}/{p}/app`; one helper picks the keys everywhere; quotas, credits and
  limits follow the app chosen.
- **Consequences.** Fully separate apps keep every Clip Factory authorization untouched and cost the owner the
  platforms' setup and reviews once; the quick choice shares quotas and review state and carries the Meta warning.
