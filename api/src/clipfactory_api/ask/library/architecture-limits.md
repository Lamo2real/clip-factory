## Limits

- **YouTube may block cloud IP addresses.** Requests from AWS addresses are sometimes asked to "sign in to confirm
  you're not a bot". Two ways out: add a `cookies.txt` from a signed-in browser in Settings (stored privately at
  `private/<userId>/youtube-cookies.txt`, used only by yt-dlp), or download the video yourself and upload it. The job
  error says which one to try.
- **Twitch and Kick** VODs can be subscriber-only or deleted after a while; those fail at the resolve step with a
  plain reason.
- **Very long streams** are processed up to `maxSourceHours` (1–12). A job must finish within the 8-hour callback
  timeout (the job flow's execution limit is 8 h 30 min).
- **Uploads** are limited to 5 GB per file.
- **The agent container** is 2 vCPU and 8 GB (AgentCore's default; the Terraform resource cannot change it), so the
  picture for watching is small (768×432, 2 fps), its download must leave 3 GB of disk free, and a tall, long upload
  is decoded at its keyframes only when a timed probe shows the full decode would not finish in time. The second, larger download per link (the small picture) raises the chance of
  YouTube's bot check; when it is blocked only the watching is skipped.
- **AgentCore sessions** have a maximum lifetime; a job that would exceed it should lower `maxSourceHours`.
- **Durable functions**: the clip flow can run for up to 3 days; execution history is kept for 14 days. Durable
  settings can only be set when a function is created, so changing them means a new function.
- **WebSocket**: connections close after 10 minutes idle (the app pings every 5) and after 2 hours (the app reconnects
  at 110 minutes); one message is at most 128 KB, and the broadcaster keeps events under 24 KB.
- **S3 Vectors**: the index settings (1024 dimensions, cosine, the four non-filterable keys) are fixed at creation; a
  change needs a new index. Filterable metadata stays under 2 KB per vector.
- **Model location**: Claude Fable 5.1 is reached only through the global profile from `eu-north-1`, so prompts may be
  processed outside the EU, and the account must be opted in to `aws_review` data retention
  ([DEPLOYMENT.md](DEPLOYMENT.md#4-bedrock-model-access-and-data-retention)).
- **Presigned URLs** last 1 hour.
- **One owner**: the data model supports more users, but sign-up is off.
- **Desktop builds are unsigned** ([ADR-19](DECISIONS.md#adr-19-unsigned-desktop-builds-for-now)): macOS and Windows
  warn on the first open; the Get the app card explains the one extra click.
- **The desktop app has the app address built in.** If `app_url` changes (for example a custom domain), the desktop
  files must be rebuilt: delete them from `downloads/` and the next deploy rebuilds them
  ([DEPLOYMENT.md](DEPLOYMENT.md#desktop-downloads)). Already installed copies keep opening the old address.
- **No iPhone download.** Apple allows no app files outside its store; iPhone and iPad use Add to Home Screen.
- **Numbers are not live to the second.** YouTube's `viewCount` is cached and can trail YouTube Studio by minutes;
  since 31 March 2025 Shorts views count every play and replay. YouTube Analytics lags 48–72 hours, Meta says its
  numbers can be up to 48 hours late, and Meta's `reach` and skip rate are estimates. Each app counts views its own
  way, which the page says next to the total.
- **TikTok numbers need TikTok's audit.** An unaudited app can post only privately, and private posts have no public
  id and no numbers.
- **X's private numbers last 30 days.** Impressions, link clicks and watch-through percentages (`non_public_metrics`)
  are only given for posts younger than 30 days; after that only public numbers are read.
- **Facebook metrics are changing.** Graph API v25.0 retires `post_impressions_unique`, `total_video_impressions*` and
  `total_video_views_unique` when v26.0 ships, so they are never read; reach comes from
  `post_total_media_view_unique`, guarded (absent if it errors). The Graph version lives in `config/platforms.json`.
- **Help knows the app, not the world.** Ask Clip Factory answers only from the corpus built from the app; anything
  else gets "I don't know that one yet." It never reads the owner's clips itself; numbers come from the browser.
- **Help model first use.** Haiku 5.5 is billed through AWS Marketplace; on an account that has never used it the
  first calls may fail, and a new output schema can take Bedrock about 90 s to compile once. Both fall back to the
  plain answer ([DEPLOYMENT.md](DEPLOYMENT.md#4-bedrock-model-access-and-data-retention)).
- **Snapshots last 90 days** (TTL); the latest totals stay on the post for as long as the clip exists.
- **Each platform's app belongs to the owner** ([ADR-33](DECISIONS.md#adr-33-posting-setup-bring-your-own-keys-with-a-guided-list-per-platform)),
  so the platforms' limits for new apps apply: TikTok posts stay "Only me" until TikTok approves the app and its
  posting audit (it may refuse a tool used by one person); Facebook Reels may stay visible only to the owner until the
  Meta app is Live (Meta may ask for App Review first; unconfirmed); YouTube's Google app must stay **In production**,
  and Google deletes OAuth clients unused for 6 months; X charges per post.
- **Clips kept before a platform was connected** are not posted automatically after Connect
  ([roadmap](ROADMAP.md#phase-2-social-integrations)).
- **A new app address breaks Connect.** The redirect URIs and website addresses pasted on the platforms contain the
  CloudFront and REST API hosts; after a custom domain or a rebuilt REST API, redo the "return address" steps (Check it
  reports `redirect_wrong`).
