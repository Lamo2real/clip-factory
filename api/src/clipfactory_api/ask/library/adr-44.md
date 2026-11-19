## ADR-44 Follow creators: webhooks for speed, a 5-minute tick as the source of truth, YouTube feed first

- **Context.** The owner asked (2026-11-18) to follow YouTubers, Twitch and Kick streamers, see their names and who is
  live, and later have a finished long stream go through the same process as a pasted link. A review of the first plan
  found holes in webhook handling, dedupe, cost and YouTube's rules. Other people's videos are involved, so permission
  matters.
- **Decision.**
  - *Two parts.* Part 1 (CONTRACTS §24) follows, shows names and live badges and notices finished streams and new
    uploads as `WATCH` items with `autoMaking: false`. It starts no job and has no permission to. Part 2 makes clips
    by itself only after real downloads from AWS work per platform.
  - *Webhooks for speed, the tick for truth.* Twitch EventSub and Kick webhooks change badges at once; a 5-minute
    tick confirms everything with batched calls. A webhook stored as seen whose processing then failed is fine: the
    tick sees the same change. Every Twitch and Kick delivery must be signed (HMAC, RSA) and fresh, or it is a 401.
  - *Once per creator.* Subscriptions belong to the creator item, never to a follower, so two owners following the
    same streamer never fight over Twitch's duplicate rule. The tick unsubscribes a creator nobody follows.
  - *Follow before keys.* Twitch logins and Kick slugs are the item keys, so a child can follow before a grown-up
    pastes the keys (which need 2FA and a developer console). A rename is caught by the tick through the numeric id
    for badges; webhooks for a renamed login fall back to the tick.
  - *YouTube feed first, never the upload project.* The public feed needs no quota or key. Live status uses an
    optional read key from a separate Google Cloud project, at most 1,000 units a day; the upload OAuth app is never
    used, so a policy audit of following can never touch posting.
  - *Permission and never auto-posting.* Following needs "Yes, they said I can". Part 2's clips wait in Review with a
    credit line.
  - *No GSI, no Terraform secrets.* Reverse lookups use the `FOLLOWED` and `CREATOR` partitions (one Query each). Keys
    are runtime secrets under `cf-prod/platforms/`; removing them overwrites the value, never deletes the secret.
  - *No reserved concurrency.* The account cannot reserve any; a conditional DynamoDB lease and an EventBridge target
    with no retries keep runs from overlapping.
  - *No cost ceiling by default* (the owner's choice): "Limit how many a day" is off (stored 0). Part 2 keeps a queue
    of 2 running automatic jobs and 2 per creator a day as throughput and dedupe safety, not cost caps.
- **Consequences.** Badges for Twitch and Kick need the owner's app keys; until then rows say "Needs a grown-up". Kick's
  recording lookup (part 2) uses an unofficial endpoint and may be blocked from AWS; YouTube downloads may need cookies
  and are against YouTube's terms without permission. The tick adds about 8,640 small runs a month.
