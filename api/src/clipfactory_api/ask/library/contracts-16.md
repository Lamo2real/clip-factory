## 16. Clip performance, stats refresh and weekly best (owner request, 2026-11-16)

The owner's words: *"click on any video and see how they performed for each social media platform ... the video on
top ... lines that go, in a smooth manner, leading to each vertical stack of information ... YouTube, TikTok,
Instagram, X, Facebook ... select the ones that perform best during that week, so that it knows how to edit better
in the future ... the stats ... should be an API call where I can just refresh it ... every 15 or 30 minutes, or
whatever the lowest limit is for each API."* Where this section and an earlier one disagree, this one wins.

Platform order everywhere in this section (stacks, arrays, tests): **YouTube, TikTok, Instagram, Facebook, X**
(`["youtube", "tiktok", "instagram", "facebook", "x"]`, constant `STATS_ORDER`). The web app uses this same order on
every screen that lists platforms: it is `PLATFORM_ORDER` in `web/src/lib/format.ts` (`STATS_ORDER` is the same
array), and the Library card rows (`byPlatformOrder`), the Review caption tabs and Settings › Posting › Where clips go
all follow it, never the API's row order.

### 16.1 What the owner gets

* **Clip performance page** `/clips/{clipId}`: the 9:16 video on top, five smooth lines growing out of it into five
  platform stacks (views, likes, comments, ... whatever that platform really offers), a crown on the best platform, a
  "Best this week" star, one vermilion **Refresh numbers** button. Numbers update live over the WebSocket.
* **Automatic refresh**: an EventBridge tick every 15 minutes; each platform is polled no faster than its own safe
  interval (YouTube, TikTok, X 15 min; Instagram, Facebook 30 min), slower as posts age, for 30 days, then one final
  snapshot.
* **Library › This week**: the week's clips sorted by views; the owner stars the best ones; Fable 5.1 writes one
  "Best of week" learning and the starred clips are preferred in the agent's "What worked before".

### 16.2 API (all JWT, §5 errors; file `api/src/clipfactory_api/routes/performance.py` and `routes/weeks.py`)

`HTTP API` keeps its single `ANY /v1/{proxy+}` route: no API Gateway change.

**GET `/v1/clips/{clipId}/performance`** → `200 ClipPerformance`. 404 `not_found` when the clip is not the caller's
or its status is `review`/`declined` ("This clip has no numbers yet. Keep it first."). Reads: the Clip, its Posts
(gsi1 `CLIP#{clipId}`), the Accounts, the STAT# snapshots of each post (Query `begins_with(sk, "STAT#{postId}#")`,
`ScanIndexForward = false`, `Limit 500`, re-sorted oldest first, then downsampled to ≤ 60 points evenly by time,
the last point always kept).

```ts
type PerfStatus = "posted" | "posted_private" | "waiting_for_connection" | "posting" | "failed" | "not_posted";
interface PlatformPerformance {
  platform: Platform; status: PerfStatus;
  account: "connected" | "not_connected" | "needs_reconnect";
  postId?: string; url?: string /* "Open on YouTube" */; postedAt?: string;
  metrics: PostMetrics | null;            // §16.3; null until the first successful read
  updatedAt?: string;                     // metrics.metricsUpdatedAt (fast counts)
  insightsUpdatedAt?: string;             // metrics.insightsUpdatedAt (slow insights)
  nextAllowedAt?: string;                 // earliest manual refresh for this post (§16.5); absent = now
  refreshing: boolean;                    // refreshStartedAt within the last 5 min
  final: boolean;                         // the day-30 final snapshot was taken (no more automatic polls)
  error?: string;                         // Post.error (failed posting) or the last stats error, plain sentence
}
interface ClipPerformance {
  clip: Clip;                             // with presigned videoUrl + coverUrl (1 h), best, bestWeek, totalViews
  posts: PlatformPerformance[];           // always exactly five, in STATS_ORDER
  series: Partial<Record<Platform, { at: string; views: number }[]>>;  // sparkline points; absent = no snapshots
  totals: { views: number; likes: number; comments: number; shares: number; platformsPosted: number;
            updatedAt?: string /* newest metricsUpdatedAt */ };       // null metrics count as 0
  bestPlatform: Platform | null;          // highest non-null metrics.views > 0; ties → earlier in STATS_ORDER
  bestThisWeek: boolean;                  // = clip.best === true
  week: string | null;                    // = clip.bestWeek when starred, else null (the web computes the anchor week)
  weekAnchorAt: string;                   // earliest postedAt of the clip's posts, else clip.decidedAt (§16.6)
}
```
Status mapping per platform (first match wins): no Post for the platform → `not_posted`; Post `pending_integration`
→ `waiting_for_connection`; `queued` → `posting`; `failed` → `failed`; `posted` with `privacy: "private"` →
`posted_private`; `posted` → `posted`.

**POST `/v1/clips/{clipId}/stats/refresh`** body `{ "platforms"?: Platform[] }` (unknown platform → 400). 404 as above.
For each requested platform in STATS_ORDER, build one `RefreshResult`:
```ts
interface RefreshResult {
  platform: Platform;
  status: "started" | "too_soon" | "blocked" | "not_posted" | "not_connected" | "private";
  nextAllowedAt?: string;   // when the next manual refresh is allowed (too_soon / blocked / started)
  note?: string;            // plain sentence, e.g. "Instagram numbers can take up to 2 days to settle."
}
```
* `not_posted`: no Post or Post not `posted`. `private`: `privacy: "private"` (TikTok; note "TikTok shows numbers
  after the app is approved."). `not_connected`: no connected Account (note "Connect {Platform} in Settings › Posting ›
  Accounts.").
* `blocked`: the platform's rate budget has `blockedUntil > now` (§16.4) → `nextAllowedAt = blockedUntil`.
* Otherwise claim the post with one conditional UpdateItem: `SET refreshStartedAt = :now, nextRefreshAt = :next`
  where `:next = now + manualCooldownMinutes`, condition `(attribute_not_exists(nextRefreshAt) OR nextRefreshAt <= :now)
  AND (attribute_not_exists(refreshStartedAt) OR refreshStartedAt < :nowMinus5m)`. Failed condition → `too_soon` with
  the stored `nextRefreshAt`. Success → `started` with `nextAllowedAt = :next`; the Instagram and Facebook results carry
  the note "Instagram numbers can take up to 2 days to settle." / "Facebook numbers can take up to 2 days to settle."
* If ≥ 1 is `started`: one `lambda.invoke(FunctionName=STATS_FUNCTION_ARN, InvocationType="Event", Payload=
  {"action": "refresh", "userId", "clipId", "postIds": [...started]})`. Invoke failure → clear `refreshStartedAt` and
  `nextRefreshAt` on those posts and still return `202`, with those entries as `blocked` and the note "Could not check
  right now. Try again in a minute." (`nextAllowedAt = now + 1 min`).
* Always `202 { "platforms": RefreshResult[] }`. The numbers arrive as `post` upserts on the WebSocket (§16.8).

**GET `/v1/weeks/{week}?from=&to=`**. `week` must match `^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$`; `from`/`to` are ISO UTC
instants with `to - from` between 167 h and 169 h (DST) and `from` within 14 h of the ISO Monday 00:00 UTC of `week`;
else 400 `bad_request` ("That week does not look right. Go back to This week."). A clip belongs to the week that
contains its **anchor** = earliest `postedAt` of its posts, else `decidedAt` (kept but not posted yet); statuses
`confirmed`, `publishing`, `posted`, `failed` only.
```ts
interface WeekClip { clip: Clip /* coverUrl presigned; no videoUrl */; anchorAt: string; posted: boolean;
                     totals: { views: number; likes: number; comments: number; shares: number };
                     views: Partial<Record<Platform, number | null>>;
                     paidViews?: Partial<Record<Platform, number | null>> /* §21.3, same keys as views */; best: boolean }
// views: one entry per platform with a `posted` Post that is not private (null = numbers on the way)
// paidViews: the count each money rate is based on (YouTube engagedViews, Facebook initialPlays, X impressions, else views)
interface WeekSummary { week: string; from: string; to: string; clipIds: string[] /* the picks */; savedAt?: string;
                        learnState: "none" | "learning" | "done" | "skipped" | "failed"; learningId?: string }
interface WeekView extends WeekSummary { clips: WeekClip[] /* sorted: views desc, then anchorAt desc */;
                                          learning?: Learning /* the week's "Best of week" learning */ }
```
No WEEK item yet → `clipIds: []`, `learnState: "none"`. Reads: Query all `POST#` and `CLIP#` items of the owner
(single owner, small), filter in code.

**PUT `/v1/weeks/{week}/best`** body `{ "from", "to", "clipIds" }` (same checks; `clipIds` unique, ≤ 10, each in that
week's `clips`, else 400 "Pick clips from this week only."). Same set as stored → `200 { week }`, nothing else happens.
Otherwise one TransactWriteItems (≤ 21 items): Put the WEEK item (`revision + 1`, `clipIds`, `unpickedClipIds = old −
new`, `savedAt = now`, `learnState = "learning"` when `clipIds` is non-empty, else `"skipped"`), Update each newly picked
Clip `best = true, bestWeek = week`, each unpicked Clip `best = false REMOVE bestWeek`. Then
`lambda.invoke(FunctionName=LEARN_FUNCTION_ARN, InvocationType="Event", Payload={"userId", "week", "revision"})`
(also for an empty set, to clear vectors and the old learning). Invoke failure → WEEK `learnState = "failed"`; the
route still answers. Response `202 { week: WeekView }`.
Stored picks whose clip has since left the week (its anchor moved, for example a clip kept on Sunday and posted on
Monday) are dropped quietly from the incoming `clipIds` before the checks; their `best` flag is cleared only while
`bestWeek` is still this week. GET returns `clipIds` filtered to clips still in the week, so the web can resend them.

Public shapes come from `performance.public_performance(...)` and `weeks.public_week(item)` (WeekSummary, used by the
broadcast too). Internal fields (`revision`, `unpickedClipIds`, `refreshStartedAt`, `statsDueAt`, `gsi2*`,
`platformPostId`, `statsId`, `lastSnapshotAt`, `insightsDueAt`) never leave the API.

### 16.3 DynamoDB items

**Post (additions).**
| Attribute | Meaning |
|---|---|
| `platformPostId` | the platform's id of the post (YouTube video id, TikTok publish id, IG media id, FB post id `{pageId}_{postId}`, X tweet id) |
| `statsId` | the id the stats API takes: YouTube video id; TikTok `publicaly_available_post_id` from `/v2/post/publish/status/fetch/` (absent while private); IG media id; FB **video id** of the Reel; X tweet id |
| `privacy` | `"public"`, or `"private"` for TikTok `SELF_ONLY` (unaudited app): no `statsId`, never polled |
| `metrics` | `PostMetrics` below (latest) |
| `statsDueAt` | ISO: next automatic poll; with `gsi2pk = "STATS"`, `gsi2sk = "{statsDueAt}#{postId}"` while the post is within the 30-day window; both gsi2 attributes REMOVEd after the final snapshot |
| `insightsDueAt` | ISO: next slow-insights read (YouTube Analytics only; §16.4 `insightsIntervalMinutes`) |
| `refreshStartedAt`, `nextRefreshAt` | manual refresh claim and cooldown (§16.2) |
| `lastSnapshotAt` | ISO of the last STAT# item |
| `day7`, `day7At`, `day7Source`, `day7State`, `day7CheckedAt` | the frozen day-7 number (§16.12): views, when they were read, `{statKey, viewsReadAt}`, `"frozen"` or `"missing"`, when it was decided. Never public |
| `day7Verdict` | the winner verdict, judged once (§16.12): `{scope: "creator" \| "all", winner, baseline, median?, judgedAt}`. Never public |
| `statsError` | last stats error, plain sentence (cleared on success) |

```ts
interface PostMetrics {
  views: number | null; likes: number | null; comments: number | null; shares: number | null; // common four
  checkedAt: string;          // = metricsUpdatedAt (kept for §5/§14 readers and learn.distil)
  metricsUpdatedAt: string;   // fast counts read time
  insightsUpdatedAt?: string; // slow insights read time
  final?: true;               // day-30 final snapshot taken
  extra: YouTubeExtra | TikTokExtra | InstagramExtra | FacebookExtra | XExtra;  // keyed by Post.platform
}
// Every extra field is optional; a field the API did not return (removed, deprecated, not ready, empty set) is
// ABSENT, never 0. Times are converted to seconds (Meta returns milliseconds).
interface YouTubeExtra   { engagedViews?: number; watchMinutes?: number; avgViewSeconds?: number; avgViewPercent?: number;
                           subscribersGained?: number }                      // shares comes from Analytics into `shares`
interface TikTokExtra    {}                                                  // views/likes/comments/shares only
interface InstagramExtra { reach?: number; saved?: number; reposts?: number; totalInteractions?: number;
                           avgWatchSeconds?: number; totalWatchSeconds?: number; skipRatePercent?: number }
interface FacebookExtra  { initialPlays?: number; replays?: number; reactions?: Record<string, number>;
                           commentsAndShares?: number; avgWatchSeconds?: number; totalWatchSeconds?: number;
                           followsGained?: number; reachUnique?: number }
interface XExtra         { impressions?: number; reposts?: number; quotes?: number; bookmarks?: number;
                           linkClicks?: number; profileClicks?: number; engagements?: number;
                           playback0?: number; playback25?: number; playback50?: number; playback75?: number; playback100?: number }
```

**Field mapping (the adapters implement exactly this; tests use recorded fake responses, §16.11).**
| Platform | Request | → `views` | `likes` | `comments` | `shares` | `extra` |
|---|---|---|---|---|---|---|
| YouTube fast | `GET [hidden] ids}` (1 unit/call) | `statistics.viewCount` (Shorts count replays since 2025-03-31) | `likeCount` | `commentCount` | – (null until Analytics) | – (`favoriteCount` ignored; no dislikes) |
| YouTube slow | `GET [hidden] postedAt date}&endDate={today}&metrics=views,engagedViews,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained&dimensions=video&filters=video=={≤50 ids}` | (not used for views) | | | `shares` | `engagedViews`, `watchMinutes` = estimatedMinutesWatched, `avgViewSeconds` = averageViewDuration, `avgViewPercent` = averageViewPercentage, `subscribersGained` |
| TikTok | `POST [hidden]` body `{"filters":{"video_ids":[≤20]}}` | `view_count` | `like_count` | `comment_count` | `share_count` | – |
| Instagram | `GET [hidden])&limit=50` (pages until all wanted ids found or `timestamp` older than 31 days) | insights `views` | `like_count` | `comments_count` | insights `shares` | `reach`, `saved`, `reposts`, `totalInteractions`, `avgWatchSeconds` = ig_reels_avg_watch_time/1000, `totalWatchSeconds` = ig_reels_video_view_total_time/1000, `skipRatePercent` = reels_skip_rate. Never `impressions`, `plays`, `ig_reels_aggregated_all_plays_count`. A metric error (code 100) drops that metric for the run and retries once without it |
| Facebook | `GET [hidden] video ids}&fields=video_insights.metric(blue_reels_play_count,fb_reels_total_plays,fb_reels_replay_count,post_video_avg_time_watched,post_video_view_time,post_video_followers,post_video_likes_by_reaction_type,post_video_social_actions)` (period lifetime); guarded reach: `GET /{graphApiVersion}/?ids={post ids}&fields=insights.metric(post_total_media_view_unique)` (error → `reachUnique` absent) | `fb_reels_total_plays` | sum of `post_video_likes_by_reaction_type` | null | null | `initialPlays` = blue_reels_play_count, `replays`, `reactions`, `commentsAndShares` = post_video_social_actions, `avgWatchSeconds`, `totalWatchSeconds`, `followsGained` = post_video_followers, `reachUnique`. Never `post_impressions_unique`, `total_video_impressions*`, `total_video_views_unique` |
| X | `GET [hidden]` (user context); posts ≥ 30 days old: same without `non_public_metrics`/`organic_metrics` (both fields) | attached video media `public_metrics.view_count` (never `impression_count`) | `like_count` | `reply_count` | `retweet_count` | `impressions` = public impression_count, `reposts` = retweet_count, `quotes`, `bookmarks`, `linkClicks` = url_link_clicks, `profileClicks` = user_profile_clicks, `engagements`, `playback0..100` = media non_public playback_{n}_count |

**STAT# snapshot** (`pk USER#{userId}`, `sk STAT#{postId}#{iso}`): `type "stat"`, `postId`, `clipId`, `platform`,
`at`, `views`, `likes`, `comments`, `shares` (nullable numbers), `final?: true`, `ttl = now + snapshotTtlDays (90) d`,
`viewsReadAt` (§16.12: `metrics.viewsUpdatedAt`, when the views in it were really read; snapshots written before it
existed, or from metrics stored before `viewsUpdatedAt` existed, have none). `PostMetrics.viewsUpdatedAt` (internal,
never public) is stamped by whichever part of a refresh carried the key `views`: the counts on YouTube, TikTok and X,
the slow insights on Instagram and Facebook; a refresh that did not read views keeps the old stamp.
Written after a successful fast read when `lastSnapshotAt` is absent, or ≥ `snapshotEveryMinutes` (60) ago, or the
views changed by ≥ 1 % since the last snapshot and ≥ 15 min passed, or it is the final read. Totals survive the TTL on
`Post.metrics`.

**WEEK item** (`pk USER#{userId}`, `sk WEEK#{yyyy-Www}`): `type "week"`, `week`, `from`, `to`, `clipIds`, `savedAt`,
`learnState`, `learningId?`, `learnedAt?`, `revision` (number, starts 1), `unpickedClipIds`.

**Rate budget** (`pk RATE#{platform}`, `sk BUDGET`, app-wide; this is a single-owner app): `type "rate"`, `platform`,
`updatedAt`, `blockedUntil?` (ISO), `blockedReason?`, and per platform:
| Platform | Counters |
|---|---|
| youtube | `dayKey` (`YYYY-MM-DD` of `now − 8 h`, i.e. Pacific Standard; at most 1 h off in summer, covered by the reserve), `unitsUsed` |
| tiktok | `minuteKey` (`YYYY-MM-DDTHH:MM` UTC), `requestsThisMinute` |
| instagram, facebook | `buc` = parsed `X-Business-Use-Case-Usage` `{ callCount, totalCputime, totalTime, estimatedTimeToRegainAccess, at }` (highest entry of the header) |
| x | `windowKey` (15-min UTC bucket), `requestsThisWindow`, `resetAt` (from `x-rate-limit-reset`), `dayKey` (UTC), `dayPostIds` (string set: posts already read today, free re-reads), `monthKey` (`YYYY-MM` UTC), `monthUsd` (estimated spend) |

Reservation (`stats/budget.py`): `reserve(store, platform, cost, now) -> Reserved | Blocked(next_allowed_at)` is one
conditional `UpdateItem` (`ADD` the counter; condition: same key and counter ≤ limit − cost, or a new key which SETs
the counter; and `blockedUntil` absent or ≤ now). After the call `record(store, platform, response_meta, now)` stores
headers and sets `blockedUntil` per §16.4. Poller and manual refresh go through the same functions.

### 16.4 `config/platforms.json` (read by Terraform and by the code; copied into the zip)

`api/scripts/build_lambda.py` copies it to `clipfactory_api/config/platforms.json` inside the zip; code loads it with
`importlib.resources` (`stats.config.load()`), tests load the repo file. Terraform: `local.platforms =
jsondecode(file("${path.root}/../../../config/platforms.json"))`, `local.stats_tick =
min([for p in values(local.platforms.platforms) : p.minIntervalMinutes]...)` (= 15) → rule `rate(15 minutes)`.

```json
{
  "$comment": "Stats refresh limits per platform (docs/CONTRACTS.md §16.4). Change values here only.",
  "graphApiVersion": "v25.0",
  "pollWindowDays": 30,
  "snapshotTtlDays": 90,
  "snapshotEveryMinutes": 60,
  "ageTierHours": [48, 168, 720],
  "order": ["youtube", "tiktok", "instagram", "facebook", "x"],
  "platforms": {
    "youtube": {
      "label": "YouTube", "viewsField": "statistics.viewCount",
      "minIntervalMinutes": 15, "tierIntervalsMinutes": [15, 30, 120], "manualCooldownMinutes": 5,
      "insightsIntervalMinutes": 360, "slowNote": "Updates daily",
      "idsPerRequest": 50,
      "scopes": ["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/yt-analytics.readonly",
                 "https://www.googleapis.com/auth/youtube.upload"],
      "budget": { "kind": "daily_units", "dailyUnits": 10000, "reserveUnits": 3000, "unitsPerCall": 1,
                  "blockOn": ["quotaExceeded", "rateLimitExceeded"] }
    },
    "tiktok": {
      "label": "TikTok", "viewsField": "view_count",
      "minIntervalMinutes": 15, "tierIntervalsMinutes": [15, 30, 120], "manualCooldownMinutes": 5,
      "idsPerRequest": 20,
      "scopes": ["user.info.basic", "video.publish", "video.list"],
      "budget": { "kind": "per_minute", "requestsPerMinute": 600, "useAtMost": 300, "blockOn": ["rate_limit_exceeded"] }
    },
    "instagram": {
      "label": "Instagram", "viewsField": "views",
      "minIntervalMinutes": 30, "tierIntervalsMinutes": [30, 60, 360], "manualCooldownMinutes": 30,
      "slowNote": "Can take 2 days", "idsPerRequest": 50,
      "scopes": ["instagram_basic", "instagram_manage_insights", "instagram_content_publish", "pages_show_list",
                 "pages_read_engagement"],
      "budget": { "kind": "meta_buc", "stopAtPercent": 75, "throttleCodes": [80002], "minBlockMinutes": 60 }
    },
    "facebook": {
      "label": "Facebook", "viewsField": "fb_reels_total_plays",
      "minIntervalMinutes": 30, "tierIntervalsMinutes": [30, 60, 360], "manualCooldownMinutes": 30,
      "slowNote": "Can take 2 days", "idsPerRequest": 50,
      "scopes": ["pages_show_list", "pages_read_engagement", "read_insights", "pages_manage_posts", "pages_manage_engagement"],
      "budget": { "kind": "meta_buc", "stopAtPercent": 75, "throttleCodes": [80001], "minBlockMinutes": 60 }
    },
    "x": {
      "label": "X", "viewsField": "media.public_metrics.view_count",
      "minIntervalMinutes": 15, "tierIntervalsMinutes": [15, 30, 120], "manualCooldownMinutes": 5,
      "idsPerRequest": 100, "nonPublicMaxAgeDays": 30,
      "scopes": ["tweet.read", "users.read", "tweet.write", "media.write", "offline.access"],
      "budget": { "kind": "x", "appRequestsPer15Min": 3500, "userRequestsPer15Min": 5000, "useAtMost": 1000,
                  "usdPerPostRead": 0.005, "monthlyUsd": 10 }
    }
  }
}
```
Rules:
* **Interval for a post** = `tierIntervalsMinutes[i]` where `i` = first tier with post age (now − postedAt) ≤
  `ageTierHours[i]` (≤ 48 h, ≤ 7 d, ≤ 30 d). Never below `minIntervalMinutes`. Next `statsDueAt = readAt + interval`.
* **Final**: the first read with age ≥ `pollWindowDays` writes `metrics.final = true`, a `final` STAT#, and REMOVEs
  `gsi2pk`/`gsi2sk`. Manual refresh still works afterwards (X then reads public metrics only).
* **Blocking** (`record`): youtube `403` with reason in `blockOn` → `blockedUntil` = next `dayKey` boundary (08:00 UTC);
  stop when `unitsUsed + cost > dailyUnits − reserveUnits` (uploads keep their 3,000-unit reserve). tiktok `429` /
  `rate_limit_exceeded` → now + 1 min; stop at `useAtMost` per minute. meta: after every response parse
  `X-Business-Use-Case-Usage`; any of call_count/total_cputime/total_time ≥ `stopAtPercent` → `blockedUntil = now +
  max(estimated_time_to_regain_access, 15) min`; error code in `throttleCodes` → `now + max(estimated_time_to_regain_access,
  minBlockMinutes) min`, and **no retry** (retries extend Meta's block). x: `429` → `blockedUntil = x-rate-limit-reset`;
  stop at `useAtMost` per 15-min window; before each request estimate cost = `usdPerPostRead` × ids not in `dayPostIds`;
  `monthUsd + cost > monthlyUsd` → `blockedUntil` = first day of next month, `blockedReason "monthly_cap"`.
* Every 5xx/network error: the step retries twice (1 s, 4 s) except Meta throttles; then `statsError` is set and
  `statsDueAt = now + interval` (no tight loop).

### 16.5 Poller and refresh: Lambda `cf-prod-stats`

Package `api/src/clipfactory_api/stats/`: `__init__.py`, `config.py` (load/validate platforms.json, `interval_for(...)`),
`budget.py` (§16.3), `refresh.py` (`refresh_posts(deps, posts, *, reason: "poll" | "manual" | "flow", now) ->
RefreshReport`, the one code path), `poll.py` (`run_tick(deps, now)`), `handler.py` (`handler(event, context)`).
Adapters: `platforms/{youtube,tiktok,instagram,facebook,x}.py` implement, beside `publish`/`metrics`:
```python
class StatsAdapter(Protocol):
    platform: str
    def fetch_stats(self, posts: list[Record], account: Record | None, *, now: datetime,
                    want_insights: bool, http: HttpClient) -> StatsBatch: ...
# StatsBatch(results: dict[postId, PostMetrics-dict], errors: dict[postId, str], meta: ResponseMeta(status, headers,
#            error_code, retry_after), requests: int, units: int)
# HttpClient = Callable[[HttpRequest], HttpResponse] (urllib in production, a recorder in tests); one request per
# idsPerRequest chunk; NotConnectedError when account is None.
```
`metrics(post, account)` of §14 stays and is implemented as `fetch_stats([post])` mapped to `Metrics`. Phase 1:
`platforms.adapter_for(platform)` returns the real adapter class, but `posts.connected_account` is always `None`, so
every call ends `not_connected` and nothing reaches the network. Tokens (phase 2) come from Secrets Manager; no token
ever lands in DynamoDB, logs or responses.

* **Handler events.** EventBridge scheduled event (`source == "aws.events"`) → `run_tick`. `{"action": "refresh",
  "userId", "clipId", "postIds"}` → `refresh_posts(reason="manual")` on those posts, then REMOVE `refreshStartedAt`
  (always, also on errors). Anything else → log `stats.bad_event`, return.
* **`run_tick`**: Query `gsi2` `gsi2pk = "STATS" AND gsi2sk <= "{nowIso}#~"` (paginate, ≤ 2,000 posts); group by
  platform in `order`; per platform skip all when `blockedUntil > now`; chunk by `idsPerRequest`; for each chunk
  `reserve` → `fetch_stats` → `record`; write results; YouTube posts with `insightsDueAt` absent or ≤ now are also sent
  with `want_insights=True` (separate Analytics request per ≤ 50 ids, `insightsDueAt = now + 360 min`). Stop starting
  new requests when `STATS_TIME_BUDGET_SECONDS` (240) have passed; the rest stays due for the next tick. Log one
  `stats.tick` line `{posts, requests, updated, blocked: [platforms], errors}`.
* **Writing a result** (per post, one UpdateItem): `metrics` (merge: fast fields + `metricsUpdatedAt`; slow fields +
  `insightsUpdatedAt` only when insights were read; previous slow values kept otherwise), `checkedAt`, `statsDueAt`,
  `gsi2sk` (or REMOVE gsi2 when final), REMOVE `statsError`; then the STAT# put when §16.3 says so (`lastSnapshotAt`).
  The Post change reaches the browser as a `post` upsert (broadcast filter `POST#`).
* **Skipped posts.** The token check runs before `budget.reserve`. A `not_connected` or `blocked` post is moved on
  without `statsError` (to `blockedUntil`, or by one interval); a `not_connected` post past `pollWindowDays` leaves gsi2.
* **YouTube cost.** `daily_units` is charged `unitsPerCall` per `videos.list` request only. The YouTube Analytics
  (insights) request has its own quota and is not charged to this budget.
* **Errors** never raise out of the handler (EventBridge would retry); a bug raises and alarms (§14.9).

### 16.6 Weekly best learning: Lambda `cf-prod-learn`

File `api/src/clipfactory_api/weekly.py`: `handler(event, context)` → `learn_week(deps, user_id, week, revision)`.
Input `{"userId", "week", "revision"}`.
1. GetItem the WEEK item; `revision` differs (a newer save) → return `superseded`, write nothing.
2. Vectors: for each `clipIds` → merge metadata `best = true`; each `unpickedClipIds` → `best = false` (§14.6; vector
   missing → embed from the Clip item and put it). Errors logged (`weekly.vector_failed`), never fatal.
3. `clipIds` empty → delete the week's Learning (`learningId` on the item) if any, set `learnState "skipped"`, done.
4. Build the prompt rows for **every** clip of that week (same week rule as §16.2, from the stored `from`/`to`):
   `picked` (bool), `hook`, `momentType`, `durationSec`, `layout`, `score`, `youtubeTitle`, the first 200 chars of the
   TikTok caption, per-platform `views/likes/comments/shares`, `totalViews`. Bedrock **Converse** `MODEL_ID`
   (`global.anthropic.claude-fable-5-1`), `maxTokens 4000`, `additionalModelRequestFields={"output_config": {"effort":
   "low"}}`, no temperature/topP/topK (as `learn.distil`). System prompt: compare the owner's picks with the rest of
   the week (hooks, moment types, length, captions, numbers) and answer with ONE plain-text learning of 1–3 short
   sentences (≤ 500 chars) the clip-picking agent should apply next time; the picks matter more than raw views.
5. `end_turn` with text → re-read the WEEK item, still the same `revision` → Put Learning `{learningId (reuse the
   item's learningId, else new ULID), kind: "week", week, title: "Best of week {week}", text, clipIds, postIds (the
   picked clips' posted post ids), createdAt}` and Update WEEK `learnState "done"`, `learningId`, `learnedAt`. Stop
   reasons `max_tokens`/`refusal`/`content_filtered`/empty → `learnState "failed"`, no Learning (§13). Bedrock errors
   retry twice, then `failed`.
Returns `{"week", "outcome": "learning" | "skipped" | "superseded" | "failed" | <stop reason>}`. The LEARNING# and
WEEK# changes reach the browser over the WebSocket. Shared pure functions live in `learn.py`
(`learn.week_rows(...)`, `learn.ask_week(...)`) so the clip-flow distil and this share the Converse helper.

### 16.7 Agent change (`agent/src/clipfactory_agent/vectors.py`, `learnings.py`)

* "What worked before" query: the two-query merge of §14.6 (best first, then performed, ≤ 8, fallback < 3 hits);
  `best` hits are labelled "Owner's pick: best of the week".
* Learnings brief: Query `begins_with(sk, "LEARNING#")`, newest first, ≤ 50 items; the latest **4** with `kind ==
  "week"` go under the heading "The owner's best-of-week picks taught" in the moment-selection prompt. Learnings
  without a kind (the retired 48-hour ones) are not sent (§16.12). "Prior learnings" come first: §16.12.
* Finalize writes `best: false` in each new vector's metadata.

### 16.8 Web

**Routes** (`web/src/lib/router.ts`): `/clips/{clipId}` → `{ name: "clip", clipId }` (nav section `library`);
`/library` → All clips; `/library?view=week` → This week (current ISO week); `/library?view=week&week=2026-W45` →
that week. Files: `screens/clip/ClipPerformance.tsx`, `components/PerfLines.tsx` (the SVG lines),
`components/PlatformStack.tsx`, `components/Sparkline.tsx`, `screens/library/WeekView.tsx`, `lib/week.ts` (ISO week
of a date in the browser's time zone, Monday start; `weekRange(week) -> {from, to}` as UTC ISO of local Monday 00:00
and next Monday 00:00; `weekLabel` "10–16 Nov"), `lib/metrics.ts` (compact numbers with `Intl.NumberFormat(…,
{notation: "compact"})`, "–" for null, durations "1:05"), API methods in `api/index.ts` + mock fixtures.

**Entry points**: tapping any Library card opens `/clips/{clipId}`; on Review, a kept clip's card shows "See how it
does" → `/clips/{clipId}`; Back returns to where the owner came from (else `/library`).

**Page layout (top to bottom)**
1. Header row: Back, the hook as the title (serif italic, wraps, never truncated off-screen).
2. Preview: `<video controls playsinline preload="metadata" poster={coverUrl} src={videoUrl}>`, `aspect-ratio: 9/16`,
   rounded glass frame, centred; width `min(180px, 56cqi)` in the trunk layout and `min(400px, 44vh) · 9/16`
   (≤ 225 px) in the rows and fan layouts, so the total and the first stacks stay on the first screen. No
   autoplay. No `videoUrl` → the cover image.
3. Stat block beside/under the preview: big total views (display serif) with "views across platforms" and a small
   "(each app counts views its own way)"; the **"Best this week" star** toggle (≥ 48 px, `aria-pressed`, green glass,
   not vermilion); the one vermilion **Refresh numbers** button (icon + word, spinner while any `started` post is still
   `refreshing`; when every platform is `too_soon`/`blocked` it reads "Next check in 4 min" and a tap plays the deny
   sound with a toast saying when). "Updated 3 min ago" (newest `updatedAt`) under it.
4. The lines + five stacks (STATS_ORDER).

**Lines** (`PerfLines`, one `<svg aria-hidden="true">` absolutely positioned behind the stacks, recomputed with a
`ResizeObserver` on the page container; coordinates from `getBoundingClientRect` of the preview and each stack):
* Each line is one cubic bezier from the preview's bottom centre `(x0, y0)` to the top centre of its stack
  `(xi, yi)`: `M x0 y0 C x0 (y0 + 0.55·dy), xi (yi − 0.55·dy), xi yi` with `dy = yi − y0`. Stroke 2 px, round caps,
  bone at 85 % (always: the app is dark-only); the best platform's line is vermilion, 3 px, cased in bone. A 6 px dot
  at each end.
* Draw-in: `pathLength="1"`, `stroke-dasharray: 1`, `stroke-dashoffset` 1 → 0 over 900 ms
  `cubic-bezier(0.22, 1, 0.36, 1)`, staggered 80 ms in STATS_ORDER, once per page load; the stacks fade/rise 12 px as
  their line arrives. `prefers-reduced-motion: reduce` or `settings.reduceMotion` → lines drawn at once, no fade.
* The three layouts follow the width the page content really has (the stage, a CSS container `perfstage`; the
  desktop sidebar takes part of the window), not the window width: **fan** from a 1060 px stage, **rows** from
  620 px, **trunk** below. The JS (`layoutFor`) compares the same unrounded width. The ranges below name them by
  their usual viewport widths.
* **≥ 1024 px**: five equal columns (`grid-template-columns: repeat(5, minmax(0, 1fr))`, gap 16 px), the lines fan
  out from the preview (≥ 96 px vertical space between preview and stacks).
* **600–1023 px**: a 6-track grid (`repeat(6, minmax(0, 1fr))`, column gap ≥ 24 px): YouTube/TikTok/Instagram span
  tracks 1–2/3–4/5–6 in row 1; Facebook spans 2–3 and X 4–5 in row 2, so their centres sit exactly at 1/3 and 2/3 of
  the width, in the gutters between the row-1 cards: their lines run straight down through those gutters, never over
  a card.
* **< 600 px (phones)**: stacks are full-width cards in one column with `padding-left: 44px` space; a trunk line
  runs from the preview's bottom centre, curves to `x = 20px` and runs down the left; each card gets a branch: from
  the trunk at the card's top + 28 px, a quarter-curve (`C` with 16 px handles) into the card's left edge at the
  platform mark. The trunk ends at the last branch. Cards stay full width minus the 16 px gutter; nothing overflows
  at 320 px.

**A stack** (`PlatformStack`, `<section aria-labelledby>`, glass card, same order as the DOM reads):
platform mark (`PlatformMark`) + name, a small crown icon with "Best" (visually hidden text) on `bestPlatform`; status
chip: Posted / Posted privately / Waiting for connection / Posting / Failed / Not posted; the big views number; metric
rows (icon, label, value; labels wrap, values never cut) showing **only** that platform's fields:
* YouTube: Views, Likes, Comments; slow group "Updates daily": Engaged views, Watch time, Average view, Average %
  watched, Shares, New subscribers.
* TikTok: Views, Likes, Comments, Shares.
* Instagram: Likes, Comments; slow group "Can take 2 days": Views (top number), Reach, Shares, Saves, Reposts, Average
  watch, Total watch, Skip rate.
* Facebook: slow group "Can take 2 days": Plays (top number), First plays, Replays, Reactions (emoji breakdown),
  Comments + shares, Average watch, Total watch, New followers, Reach (when present).
* X: Video views, Impressions, Likes, Reposts, Quotes, Replies, Bookmarks, Link clicks, Profile clicks, Watched to
  25/50/75/100 % (only while present).
Absent fields are not shown (no "0" rows). Then the sparkline (`Sparkline`, 120×32 SVG polyline of `series[platform]`,
≥ 2 points else hidden, `role="img"` `aria-label="Views went from 1.2K to 8.4K"`), "Updated 3 min ago" (fast) and,
for slow groups, "Insights from 2 days ago" (`insightsUpdatedAt`); "Open on {Platform}" link (`url`, new tab,
`rel="noopener noreferrer"`); "Next check in 12 min" when `nextAllowedAt` is in the future.
**Calm states** (no numbers, one plain line + one link button, never an error colour except Failed):
* Waiting for connection: "Connect {Platform} in Settings › Posting › Set up posting." →
  `/settings/posting/setup/{platform}` (§17).
* Not posted: "Not posted here. Turn on {Platform} in Settings › Posting › Where clips go." →
  `/settings/posting/where`.
* Posting: "Posting now…" with a small spinner.
* Posted privately (TikTok): "Posted privately. TikTok shows numbers after the app is approved."
* Posted, no metrics yet: "Numbers are on the way. Check back in a few minutes."
* Failed: "Posting failed: {error}. Go to Library and press Try again."

**Live**: `post` upserts for this clip's posts replace that stack's data (metrics, refreshing, nextRefreshAt) and add
a series point; `clip` upserts update the star; reconnect or `partial` → refetch `GET …/performance`. Polling fallback
while disconnected: every 60 s on this page.

**Library › This week** (`WeekView`): tabs "All clips | This week" (pills); header "This week · 10–16 Nov" (or "Week of
3–9 Nov") with ‹ › arrow buttons (› disabled on the current week, aria-labels "Earlier week"/"Later week"); list of
`WeekClip` cards sorted as served: rank number, cover, hook, total views (or "Not posted yet"), a row of five tiny
platform marks with views, and a big star toggle "Best this week" (≥ 48 px, `aria-pressed`; below 380 px it sits on
its own full-width row under the card so the hook keeps the width; below 360 px the header dates drop to their own
line and the "·" is visually hidden, still read by screen readers). Toggling is optimistic
and saved by `PUT …/best` 800 ms after the last change (one request); a toast "Saved. Clip Factory will learn from your
picks." Under the header a status line from `learnState`: learning → "Learning from your picks…" (spinner); done →
the learning text in a glass quote with "Best of week" label; failed → "Could not learn this time. Change a pick to
try again."; none/skipped → "Star the clips that did best this week." Empty week: "No clips this week yet. Make clips
on Home." with a link. `week` events and `learning` upserts (kind `week`) update it live. The browser tab title follows the
heading: "This week · Library · Clip Factory" for the current week, "Week of 28 Sep–4 Oct · Library · Clip Factory"
for any other (`weekTitle` in `WeekView.tsx`).

**Settings › Posting › Accounts** (now the X setup page, §17.2) gets a leaf under X: "X charges a little for every number check. Clip Factory stops
at $10 a month." (value from a shared constant mirroring `platforms.json` `x.budget.monthlyUsd`, served in mock data).

### 16.9 Terraform (module `infra/modules/stats`, wired in `envs/prod`)

* **`cf-prod-stats`**: handler `clipfactory_api.stats.handler.handler`, python3.13, arm64, 256 MB, timeout 300 s,
  shared zip, X-Ray active, JSON logs `/aws/lambda/cf-prod-stats`, env `TABLE_NAME`, `STATS_TIME_BUDGET_SECONDS = 240`.
  No reserved concurrency (new accounts' limits forbid it; budgets are conditional writes).
  `aws_lambda_function_event_invoke_config`: `maximum_retry_attempts = 0`, `maximum_event_age_in_seconds = 900`.
  Role `cf-prod-fn-stats`: `dynamodb:GetItem`, `PutItem`, `UpdateItem`, `Query`, `BatchGetItem` on the table and
  `index/*`; logs; X-Ray. (§17.9 adds `secretsmanager:GetSecretValue` on `cf-prod/platforms/*` and
  `PutSecretValue` on `cf-prod/platforms/*/token-*`.)
* **EventBridge**: `aws_cloudwatch_event_rule` `cf-prod-stats`, `schedule_expression = "rate(${local.stats_tick}
  minutes)"` (15, from platforms.json), `state = "ENABLED"`; `aws_cloudwatch_event_target` → the function (unqualified
  ARN); `aws_lambda_permission` for `events.amazonaws.com` with `source_arn` = the rule ARN.
* **`cf-prod-learn`**: handler `clipfactory_api.weekly.handler`, 512 MB, timeout 900 s (§16.12), also on the daily rule `cf-prod-learn-daily`, env `TABLE_NAME`, `MODEL_ID`,
  `EMBED_MODEL_ID`, `VECTOR_BUCKET`, `VECTOR_INDEX`; event invoke config `maximum_retry_attempts = 1`,
  `maximum_event_age_in_seconds = 3600`. Role `cf-prod-fn-learn`: `dynamodb:GetItem`, `PutItem`, `UpdateItem`,
  `DeleteItem`, `Query`, `BatchGetItem` on the table and `index/*`; `bedrock:InvokeModel` on `model_invoke_arns` and
  the Titan ARN; `s3vectors:GetVectors`, `s3vectors:PutVectors` on the index ARN; logs; X-Ray.
* **api module**: env `STATS_FUNCTION_ARN`, `LEARN_FUNCTION_ARN` (unqualified ARNs built from names); IAM
  `lambda:InvokeFunction` on both.
* **data module**: `global_secondary_index { name = "gsi2", hash_key = "gsi2pk", range_key = "gsi2sk",
  projection_type = "ALL" }` + attributes `gsi2pk`, `gsi2sk` (S). Online, no data migration.
* Module inputs: `name`, `region`, `account_id`, `lambda_zip_path`, `table_name/arn`, `model_id`, `model_invoke_arns`,
  `embed_model_id`, `embed_model_arn`, `vector_bucket`, `vector_index`, `vector_index_arn`, `platforms_config_path`,
  `log_retention_days`; outputs `stats_function_arn`, `learn_function_arn`, `stats_rule_name`, `stats_tick_minutes`,
  `function_names = { stats = "cf-prod-stats", learn = "cf-prod-learn" }` (merged into monitoring). Env outputs (§10):
  `stats_function_name`, `learn_function_name`, `stats_rule_name`, `stats_tick_minutes`.
* The broadcast ESM filter gains `WEEK#` (§14.2). `docs/ARCHITECTURE.md` and the drawio add EventBridge →
  `cf-prod-stats` → platform APIs, `cf-prod-api` → `cf-prod-stats`/`cf-prod-learn`, `cf-prod-learn` → Bedrock + S3 Vectors.

### 16.10 Who builds what (five parallel builders; each stays inside its files)

| Builder | Owns |
|---|---|
| infra | `infra/**` (`modules/stats` new, `data` gsi2, `api` env/IAM, `realtime` filter `WEEK#`, `monitoring` alarms, `envs/prod` wiring/outputs, tftests), `config/platforms.json` (exactly §16.4) |
| api-core | `routes/performance.py`, `routes/weeks.py`, `performance.py`, `weeks.py`, `weekly.py`, `learn.py` (week helpers), `posts.py` (`mark_posted`, public Post additions), `clips.py` (`best`, `bestWeek`, `totalViews`), `http.py`/`app.py` wiring, `realtime/broadcast.py` (`week` type), `api/scripts/build_lambda.py` (copy platforms.json), their tests |
| api-stats | `stats/**`, `platforms/{base,stub,youtube,tiktok,instagram,facebook,x}.py`, `flows/clip_flow.py` (publish stats fields, `metrics` step via `refresh_posts`), `tests/test_stats*.py`, `tests/fixtures/stats/**`, `tests/test_flows.py` updates |
| agent | `agent/**` (§16.7) |
| web + docs | `web/**` (§16.8, mock fixtures, unit + e2e tests, screenshots), `docs/**` except this file (ARCHITECTURE, drawio, UX_DESIGN_SYSTEM, TESTING, DEPLOYMENT: X credits note) |

Shared names: `stats.refresh.refresh_posts(deps, posts, *, reason, now) -> RefreshReport`,
`stats.config.load() -> PlatformsConfig`, `stats.config.interval_for(cfg, platform, posted_at, now) -> int`
(minutes), `stats.budget.reserve/record`, `performance.public_performance(clip, posts, accounts, snapshots, now)`,
`weeks.week_bounds_ok(week, from_, to)`, `weeks.week_clips(store, user_id, from_, to)`, `weeks.public_week(item)`,
`posts.mark_posted(store, post, published, now)`, `learn.ask_week(bedrock, model_id, rows) -> (stop_reason, text)`.

### 16.11 Tests (offline, fakes only)

* **api-core** (`pytest`): performance always returns five platforms in STATS_ORDER with the status mapping of §16.2,
  totals ignore nulls, `bestPlatform` tie → earlier platform, series downsampled to ≤ 60 with the last point kept,
  404 for review/declined/other owner, internal fields absent; refresh: `too_soon` honours `nextRefreshAt`, `blocked`
  honours `blockedUntil`, `private`/`not_connected`/`not_posted`, a single async invoke with only the started post ids,
  invoke failure rolls the claim back, Meta notes present; weeks: bad id / bad from-to → 400, anchor rule (postedAt
  else decidedAt), sort order, PUT ≤ 10 / foreign clip → 400, same set → 200 and no invoke, transaction sets
  `best`/`bestWeek` and clears unpicked, `revision` increments, invoke payload; `learn_week`: superseded writes nothing,
  vectors best true/false (and survives vector errors), empty picks delete the old learning, stop reasons → `failed`,
  learning id reused on re-save, Converse config (maxTokens 4000, effort low, no temperature); broadcast maps `WEEK#`
  → `week` with `public_week`; build zip contains `clipfactory_api/config/platforms.json`.
* **api-stats**: `config.load` validates the repo file (all five platforms, the §16.4 values); `interval_for` tiers at
  47 h / 49 h / 8 d / 31 d; each adapter builds the exact URLs/bodies of §16.3 with the batch size (51 YouTube ids → 2
  requests, 21 TikTok → 2, 101 X → 2), X drops non-public fields for posts ≥ 30 days, and maps recorded responses in
  `tests/fixtures/stats/{youtube_videos_list,youtube_analytics_report,tiktok_video_query,instagram_media,facebook_video_insights,facebook_post_views,x_tweets_lookup}.json`
  to `PostMetrics` (ms → s, missing → absent, never `impressions` for Meta, X views from media `view_count`); error
  fixtures: YouTube `quotaExceeded` → blocked till 08:00 UTC, TikTok 429 → +1 min, Instagram 80002 with
  `estimated_time_to_regain_access` → blocked and **no retry**, BUC header ≥ 75 % → blocked, X 429 → `x-rate-limit-reset`,
  X monthly cap; `reserve` is atomic (two concurrent reservations over the limit → one blocked); `run_tick` reads only
  due posts, respects `STATS_TIME_BUDGET_SECONDS`, writes metrics + `statsDueAt`/`gsi2sk`, snapshot rules (60 min / 1 % /
  final), final at 30 days removes gsi2; YouTube insights only every 360 min and slow values kept between reads;
  phase-1 adapters with no account → `not_connected`, zero HTTP calls; manual refresh clears `refreshStartedAt` even on
  errors; handler never raises on expected errors; clip-flow `metrics` step uses `refresh_posts` and falls back to
  stored metrics when blocked; publish writes the §14.5 stats fields (private TikTok: no gsi2).
* **agent**: best query first then performed, dedupe, cap 8, fallback < 3; "Owner's pick" label; learnings brief
  orders week learnings first (≤ 4) then ≤ 10 others; finalize writes `best: false`.
* **infra** (`terraform test`, mock providers): rule `cf-prod-stats` `rate(15 minutes)` derived from platforms.json
  (a test override with all intervals 30 → `rate(30 minutes)`), target + permission source ARN, stats retry 0 / age 900,
  learn retry 1, IAM statements exactly as §16.9 (no `s3vectors` or `bedrock` on stats), api env + invoke permission,
  gsi2 present with projection ALL, ESM filter has the five prefixes, alarms for both functions, §10 outputs.
* **web** (Vitest): `lib/week.ts` (ISO week of 2026-01-01 = 2026-W01, 2027-01-01 = 2026-W53, Monday start, DST weeks
  give 167/169 h ranges), bezier path builder for the three layouts (`PerfLines.paths(layout, rects)`), compact number
  formatting, status → copy mapping, live merge of `post`/`week` events. **Playwright (mock mode)**,
  `e2e/performance.spec.ts`: Library card → `/clips/{id}`; five stacks in STATS_ORDER with their own metric labels (no
  "Saves" on TikTok, no "Impressions" on Instagram/Facebook); crown on the mock best; Refresh → spinner → numbers
  change (mock pushes a `post` event) → "Next check in" shown; too-soon tap → deny toast; each calm state copy and
  link target; star toggle persists; lines: five `path`s exist and at 1440 px every line ends within 2 px of its stack's
  top centre, at 800 px row-2 lines do not intersect row-1 cards, at 375 px a trunk + five branches; reduced motion →
  no animation (`getAnimations()` empty). `e2e/week.spec.ts`: This week tab, sorted by views, ‹ to the previous week and
  › disabled on the current one, star → one PUT after the debounce, "Learning from your picks…" → learning text after
  the mock `learning` event, empty week copy. `overflow.spec.ts` gains `/clips/{id}`, `/library?view=week` at 320, 375,
  600, 768, 1024, 1440 px (no horizontal scroll, no element outside its box); `screenshots.spec.ts` adds both pages at
  375 and 1440 px, light and dark.

### 16.12 Learn from results: creator lessons from day-7 numbers (owner request, 2026-11-18)

The owner's words: "I want our stream-clipping app to learn from its own results." About 7 days after posting, some
clips do far better than normal; a daily run notices them, looks at them again, and turns what they share into short
lessons that reach the clip picker as **Prior learnings**. It learns per creator, never from a handful of clips or
from luck, and never makes up numbers. Every rule value lives in `api/src/clipfactory_api/learning_rules.py`
([ADR-41](DECISIONS.md#adr-41-learn-from-day-7-numbers-per-creator-and-per-platform)).

**Creator** (`creators.py`, the ONE place; the agent has a byte-for-byte copy its tests compare). The streamer whose
stream is clipped: `"{platform}:id:{channelId}"` when yt-dlp gave a channel id (`Source.channelId`, new), else
`"{platform}:name:{normalised channel}"`; uploads and links without a channel have none (learned only "all
creators", key `"*"`). Finalize writes `creatorKey`, `creatorKeys` (every key the source answers to) and `creatorName`
on each Clip and on the Job (additive). Older clips get theirs from their job's `source` at read time (nothing is
rewritten); a name key joins an id key once one newer clip of that channel carries both.

**Day 7** (`day7.py`). Each post's `day7` is the views of the reading closest to 7 days after `postedAt`, accepted only
when read between 6.5 and 8.5 days after posting, and only frozen once that window has closed. "Read" means
`viewsReadAt` on the STAT# snapshot (a refresh that did not read views keeps the old ones, §16.5); a snapshot from before
`viewsReadAt` existed counts (at its `at`) only when its views differ from the snapshot before it. No reading in the
window → `day7State "missing"` for good: never interpolated, stretched, copied or set to 0. `0` only when the platform
said 0. `day7Source {statKey, viewsReadAt}` traces every number. The poller reads posts every 30–360 minutes until day
30 and keeps snapshots 90 days (§16.4), so the window always has readings while a platform is connected.

**Winner test** (`winners.py`), per creator and per platform (platforms are never compared or added up):

| Constant | Value | Meaning |
|---|---|---|
| `BASELINE_DAYS` | 90 | baseline = that creator's posts on that platform with a day-7 number, posted in the last 90 days, the clip under test left out |
| `MIN_BASELINE` | 20 | fewer → the owner-wide baseline on that platform (scope `"all"`, also ≥ 20); fewer again → no winner, the status says how many more |
| `WINNER_RATIO` | 2.0 | day-7 views ≥ 2 × the baseline median … |
| `WINNER_Z` | 2.5 | … and a robust z-score ≥ 2.5 on log(1 + views): (x − median) / (1.4826 × max(MAD, floor)) |
| `MAD_FLOOR` | 0.2 | on the log scale; with it the z-test alone needs about 2.1 × the median, so an all-equal baseline names no winner |
| `WINNER_MIN_VIEWS` | 100 | a winner has at least 100 day-7 views … |
| `BASELINE_MIN_MEDIAN` | 10 | … and its baseline median is at least 10 (a baseline of zeros names no winner) |
| `POOL_MIN_CREATOR_POSTS` | 5 | owner-wide fallback: each post is divided by its own creator's median on that platform and scaled to the median creator, so a bigger channel's normal clips are not winners; a creator needs ≥ 5 other posts there to be in it |
| `JUDGE_WITHIN` | 7 days | each post is judged once, in the first run within 7 days of its day-7 number freezing, and the verdict is stored (`Post.day7Verdict`); a later shift of the 90-day baseline never makes an old post a new winner |

**Second look** (`traits.py`). Facts from what is stored only (a missing fact counts on neither side): moment type,
length, layout, hook word count, words per second (`wordCount` / length) and time to the first word (`firstWordSec`,
both new at finalize, with `spokenText`, the first 1,000 characters said), score, posting hour (UTC). Each fact gives
one trait bucket. A trait is a **candidate** when ≥ 3 winners share it, they come from ≥ 2 source videos (the job's
source link or upload: two jobs of one stream are one source), ≥ 10 other clips have the same kind of fact
(`TRAIT_MIN_OTHERS`; clips made before pacing was stored have none), and its rate among winners is ≥ 1.5 × its rate
among those other clips. An "all creators" trait also needs winners from ≥ 2 creators (`TRAIT_MIN_CREATORS_ALL`). Then ONE Converse call per creator and platform with new
winners (same model and helper as `learn.py`, the skills block first, JSON schema output): the candidate traits with
their counts, the winners' hooks, transcripts and facts, and up to 8 normal clips (closest to the median). No images
(the helper sends text only). It answers `{"lessons": [{"trait", "text", "clipIds"}]}`.

**No made-up numbers** (`lessons.check_lesson`). The text is 1–2 short sentences (≤ 240 characters), no ids or JSON;
every number in it (digits, also glued to letters as in "x10", and number words: units, teens, tens, compounds such as
"twenty-five", scales, multipliers such as "twice" or "quadruple", fractions such as "half" or "quarter", ordinals
from "third") must equal a number in the evidence the model was given; every cited clip
must be a winner. Otherwise one retry with the problems listed, then the lesson is dropped and logged
(`learn.lesson_dropped`). The evidence stored with a lesson is computed by code only.

**Lesson** (`LESSON#{lessonId}`, `lessonId` = the first 24 hex characters of sha256(`creatorKey|platform|trait`)):

```ts
interface Lesson { lessonId: string; kind: "creator"; creatorKey: string /* "*" = all creators */; creatorName?: string;
  scope: "creator" | "all"; platform: Platform; trait: string; traitLabel?: string; text: string;
  status: "trial" | "active" | "off" | "expired" /* "deleted" items are never listed */;
  evidence?: { baseline: "creator" | "all"; measured: number; winners: number; medianViews: number | null;
    winnerViews: { clipId: string; postId: string; views: number }[];
    trait: { winnersWith; winnersKnown; othersWith; othersKnown; winnerPercent; otherPercent; sources: number };
    computedAt: string };
  clipIds: string[]; clips: { clipId: string; hook: string }[] /* GET only: cited clips that still exist */;
  createdAt: string; confirmedAt?: string; expiresAt?: string; updatedAt?: string }
interface LessonCreator { creatorKey: string; creatorName: string;
  platforms: Partial<Record<Platform, { measured: number; needed: number; winners: number }>> }
```

| Status | When | Given to the picker |
|---|---|---|
| `trial` | just written ("Trying it") | no |
| `active` | a run ≥ 7 days after creation or the last confirmation finds ≥ 1 NEW winner with the same trait ("Using it"); expires 90 days after the last confirmation; at most 5 per creator (most supporting winners win, the rest go back to `trial`) | yes |
| `expired` | past `expiresAt` (also counted at read time) | no; may be learned again from new evidence |
| `off` | the owner turned it off (`statusBeforeOff` remembers trial or active; "on" restores it) | no |
| `deleted` | the owner deleted it: text and evidence removed, the tombstone blocks the same creator + platform + trait for good (no control brings it back, ADR-41) | no |

An expired lesson has no Turn off / Turn on (PATCH returns it unchanged); only Delete.

Disconnecting YouTube (`stats` action `forget`, §17.6) also removes `day7*` from its posts and deletes every lesson
learned from YouTube numbers (no tombstone) and its entries in `LEARNSTATE` (bumping its `version`). The daily run never
writes a number back over a disconnect: day 7 is written only while the post still has `metrics`, a verdict only while
`day7State` is `"frozen"`, a new lesson only when none with its id exists or the one there is expired (so an owner's
delete or off made during the run stands) and is taken back out when the clips it rests on lost their numbers, and
`LEARNSTATE` only when its `version` is still the one the run read.

**Daily run** (`daily.py`). EventBridge rule `cf-prod-learn-daily`, `cron(0 5 * * ? *)` → `cf-prod-learn` (the same
function as §16.6; `weekly.handle` sends `source == "aws.events"` here before the weekly checks). Owners come from the
poll index (gsi2 `STATS`, Query only; the role has no Scan). Per owner: freeze due posts → judge the posts not judged
yet and store the verdicts → expire → per group:
confirm its lessons; when it has winners not in `LEARNSTATE.seen`, ask for lessons for the candidate traits that are
not already a live, off or deleted lesson (none → no call) → cap → save `LEARNSTATE` only when it changed (`seen` keeps
only posts of the last 90 days). Only posts of the last 90 days are joined with their clips and jobs. Idempotent (the
automatic retry changes nothing); one creator's failure is logged and its winners stay unseen for tomorrow. Time:
freezing stops at `DAILY_BUDGET_SECONDS` (720); a model attempt (the first or the one retry) starts only with
`MODEL_CALL_SECONDS` (150) left; the daily run's own Bedrock client waits at most 60 s per read and tries twice
(`BEDROCK_READ_TIMEOUT`, `BEDROCK_MAX_ATTEMPTS`), so the run ends by about 870 s; the function timeout is 900 s. Returns `{"action": "daily", "owners", "frozen", "missing", "modelCalls", "lessonsWritten",
"confirmed", "expired", "capped", "failed", "deferred"}`.

**Delivery** (agent, `learnings.py`). A section headed exactly `Prior learnings`, a one-line note ("Patterns from
this creator's past clips … Advice, never a rule …"), then one plain pattern per line: active, unexpired lessons whose
`creatorKey` is one of the job's creator keys, then active `"*"` lessons (≤ 10, same text once). It goes right after
the skills block in the moment-picking prompt (SDK prompt file and the Converse fallback), the second look
(`verify.second_look`: it keeps, swaps or drops moments and can write a new hook), the checklist review (it can write a
new hook) and the captions; the two watchers, which only report what is seen, get none. No active lessons → no section. The owner's clipper skill (added in Settings)
reads this input; the 48-hour learnings are not sent any more.

**Routes** (`routes/lessons.py`): GET `/v1/lessons`, PATCH `/v1/lessons/{lessonId}` `{"status": "off" | "on"}`,
DELETE `/v1/lessons/{lessonId}`; a bad id is 404, any other body 400; 409 "That lesson just changed. Try again." when
the daily run changed the lesson twice while it was being turned off or on (every toggle write is conditional). Mock parity: `web/src/api/mock/lessons.ts`.

**Web**: Settings › Clip making › **What it learned** (`/settings/clip-making/learned`, apple `what-it-learned`,
between Skills and YouTube help). The top line: "Every day Clip Factory checks your clips 7 days after posting.
Lessons it is sure about go to your skills as Prior learnings." Grouped by creator ("All creators" last): each
lesson's text, a chip (Trying it, Using it, Turned off, Too old), the platform, "4 of 31 clips did much better than
normal" ("… clips from all your creators …" for the All creators group), Too old lessons say "Too old to use. New clips can teach it again." and have only Delete, the winner clips as links, Turn off / Turn on and Delete (with "Delete this lesson?"). A creator without
enough clips: "YouTube: Needs 12 more posted clips". Before the first run: "Nothing yet. …". Library's "What's working"
labels 48-hour learnings "Older note" and links here; it does not repeat the lessons. Help: guide `learn-from-clips`.
