## ADR-29 Stats refresh intervals per platform

- **Context.** The owner wants each clip's numbers per platform, refreshed "every 15 minutes or 30 minutes. Or
  whatever the lowest limit is for each API", plus a Refresh button. The five APIs limit and bill very differently,
  and their numbers settle at different speeds (checked against each platform's documentation, November 2026):

  | Platform | Read used | Limit or cost | How fresh the numbers are |
  |---|---|---|---|
  | YouTube | `videos.list?part=statistics` (up to 50 ids, **1 quota unit a call**); YouTube Analytics `reports` for watch time, engaged views, shares | 10,000 units a day per project, reset at midnight Pacific; uploads need units too | `viewCount` is near real time but cached (minutes behind Studio); Shorts count every play and replay since 31 March 2025; Analytics lags **48–72 hours** |
  | TikTok | `POST /v2/video/query/` (up to 20 ids) | **600 requests a minute** per endpoint, sliding window; `429 rate_limit_exceeded` | Live counts; only views, likes, comments, shares. Unaudited apps post privately and get **no** numbers |
  | Instagram | media insights via field expansion on `/{ig-user-id}/media` (50 reels a request) | Business Use Case: **4,800 × the account's impressions** per 24 h; error `80002`; retries extend the block | Meta: data "can be delayed up to 48 hours"; `views`, `reach` and skip rate are estimates or "in development" |
  | Facebook | `video_insights` (lifetime only), one Reel a request (Graph v26.0 removed the `?ids=` batch read; each id counted against the budget anyway) | Pages BUC: **4,800 × engaged users** per 24 h; error `80001` | Up to 48 hours to settle; impressions and unique-views metrics retire with v26.0 |
  | X | `GET /2/tweets?ids=` (up to 100) with public, non-public and media metrics | 3,500 requests / 15 min per app; **pay per use**, about $0.005 per post read, the same post again on the same UTC day free | Live; non-public metrics only for posts under 30 days old |

- **Decision.** A **safe floor per platform**, not the hard limit, kept in one file, `config/platforms.json`, which
  Terraform and the code both read:
  - **15 minutes** for YouTube, TikTok and X, **30 minutes** for Instagram and Facebook, for the first 48 hours; then
    30 / 60 minutes up to 7 days and 2 h / 6 h up to 30 days; then one final reading and the post leaves the queue.
  - YouTube Analytics at most every **6 hours**: it only moves once a day.
  - **Budgets below the limits**: YouTube stops at 7,000 units a day (3,000 kept for uploads); TikTok uses at most 300
    of 600 requests a minute; Meta stops at 75 % of any `X-Business-Use-Case-Usage` counter and never retries a
    throttle; X uses at most 1,000 of 3,500 requests per 15 minutes and stops at an estimated **$10 a month**.
  - **Refresh numbers** goes through the same budgets with a per-post cooldown: 5 minutes for YouTube, TikTok and X,
    30 minutes for Instagram and Facebook. It never bypasses a limit; when it must wait, it says until when.
  - Largest batch per request everywhere (50, 20, 50, 50, 100 ids), so cost grows with the number of batches, not posts.
- **Why these numbers.** At 15 minutes, 50 YouTube posts cost 96 units a day: under 1 % of the quota, so the floor is set
  by how often the number really changes, not by the quota. TikTok's 600 a minute is never close. Instagram and
  Facebook budgets scale with the account's own reach, so a new account has a small one, and their numbers settle over
  two days; reading every 15 minutes would spend budget on numbers that have not moved yet. X is the only one that
  costs money, and its 24-hour de-duplication means 15 minutes costs the same as once a day (about $0.15 per post over
  30 days), so freshness is free there until the monthly cap. Slowing down with age matches how clips behave: most
  views come in the first two days.
- **Alternatives.** *The hard limits* (YouTube could poll every few seconds by quota alone; Meta's limit depends on
  reach and can shrink overnight; going up to the edge leaves nothing for uploads and the button). *One interval for
  all* (30 minutes everywhere wastes YouTube's and TikTok's freshness; 15 everywhere spends Meta budget on unsettled
  numbers). *Webhooks instead of polling* (none of the five platforms pushes view counts to a webhook). *Polling forever* (X's private numbers end at 30 days, and old clips barely move; the final
  snapshot keeps the totals).
- **Consequences.** Numbers on the page are at most 15–30 minutes old in the first two days and say how old they are.
  Changing an interval, a batch size, a budget or the Graph API version is a one-line change in `config/platforms.json`
  and a push. The X cap needs the owner's credits (DEPLOYMENT.md, "X API credits for clip numbers"). TikTok numbers
  wait for TikTok's app audit.
