## 25. Real earnings: paid-programme progress and platform-reported money (owner request, 2026-11-18)

The owner's words: *"it should be completely for real, real data, nothing that I should add in myself ... a tracking
system ... for all these platforms ... how and when I get monetized for each YouTube, Instagram, TikTok ... and once I
get monetized ... track the actual revenue that I get from each platform and not some fake data."* Decision record:
DECISIONS.md ADR-47. **This section replaces every money part of §21**: the per-1,000-view guesses, `config/earnings.json`
and the money screens are gone. Where this section and an earlier one disagree, this one wins.

**The rule.** Clip Factory shows only money a platform's API reported about the owner's account. It never calculates,
guesses, converts or accepts typed-in money. Every API number is the platform's own estimate (YouTube's
`estimatedRevenue`, Meta's earnings metrics), so every money figure carries the tag "YouTube's estimate" or "Meta's
estimate"; the words "paid", "received" and "actual" never sit next to one. No API reports paid-out money: the app links
to each platform's payout page instead. Every stored money row has `platform`, `source` (the metric), `unit`,
`currency` and `fetchedAt`.

### 25.1 States (never down by themselves)

| State | Pill (fixed text) | Set when |
|---|---|---|
| `earning` | Earning | A platform reported money above 0 (YouTube; Facebook once `moneyVerified`) |
| `in_program` | In the program | YouTube's monetary report answered 200 |
| `goal_reached` | Goal reached | Every published goal is reached. Always with "[Platform] also checks things we can't see." |
| `not_yet` | Not yet | YouTube's monetary report answered 403 `forbidden` while the scope is granted and the non-money report works |
| `counting` | Counting | TikTok's 30-day views need 30 daily snapshots first |
| `unknown` | Can't tell | Facebook: "Meta doesn't tell apps if you've joined." Never "not monetized" |
| `needs_permission` | Needs your OK | The money scope (YouTube) or `user.info.stats` (TikTok) is not granted yet |
| `not_available` | Not shared | Instagram, TikTok and X: no API reports programme status or money |
| `not_connected` | Not connected | The platform is not connected (Settings › Posting › Set up posting) |
| `error` | Couldn't check | Anything else, with one plain fix sentence |

`in_program` and `earning` are permanent: a later 403 or outage only sets `lastError` and shows "Couldn't check today".
`detectedAt` (first seen in the programme) and `earningSince` are written once (conditional `attribute_not_exists`).
YouTube 403 reasons other than `forbidden` (`accessNotConfigured`, `quotaExceeded`, `insufficientPermissions`, …) are
`error` with a fix sentence ("Ask a grown-up: turn on YouTube Analytics API. The steps are in Settings › Posting › Set up posting › YouTube."), never a false "Not yet".

### 25.2 `config/monetization.json`

`asOf`, `countries[{code, name}]` (a one-time pick, `other` = somewhere else) and per platform: `programme`,
`statusWhere`/`paidWhere` `{label, url?}`, `moneyLabel`, `moneyNote`, Facebook `moneyVerified` (false until one live
call is checked against Meta Business Suite), TikTok `warning`, and `rules[]`:
`{id, for: not_in_program|in_program, effectiveFrom, countries: "*"|[codes], goals[], more[]?, upcoming?}`. A goal:
`{key, metric, goal, label, kind: bar|tick|number, approx?, or?, windowDays?, note?, help?, source, verifiedHow}`.
`source` must be https on the platform's own help host and `verifiedHow` `official-page` or `official-snippet`
(`money/rules.py` refuses anything else, and the build copies the validated file into the zip next to
`platforms.json`). No rates, no third-party numbers.

| Platform | Goals shown | Read from |
|---|---|---|
| YouTube | 1,000 subscribers; 4,000 watch hours in 12 months **or** 10M Shorts views in 90 days. From 2027-02-01: 8,000 hours or 20M Shorts views (still 1,000 subscribers); a channel already in the programme sees "Keep 10M Shorts views in 90 days". Under More: the fan-money tier (500 subscribers, 3 public videos in 90 days, 3,000 hours or 3M Shorts views) | `channels.list part=statistics,contentDetails` (rounded subscribers); Analytics `engagedViews` with `creatorContentType==SHORTS` over 90 days; `estimatedMinutesWatched / 60` of `VIDEO_ON_DEMAND` + `LIVE_STREAM` over 365 days (labelled about); `playlistItems part=status,contentDetails` newest first, stopping at the first item older than 90 days |
| Facebook | None (Meta publishes none). Followers, minutes watched in 60 days ("our count"), views that can earn, and "Meta invites creators" | Page `followers_count`; one `page_video_view_time` + `creator_monetization_qualified_views` insights call over 60 days |
| Instagram | 500 followers for Gifts, with "Instagram also checks age, country and rules" | `followers_count` |
| TikTok | Per country: 10,000 followers (50,000 in JP and KR) and 100,000 views in 30 days; "Videos 1 min or longer: n of last 20"; "Don't switch to a Business account" | `user/info` `follower_count` (needs `user.info.stats`); the daily sum of public `view_count` from `video/list`, 30-day delta clamped at 0 ("deleted or private videos aren't counted"); "Counting… N days to go" until 30 snapshots exist |
| X | Premium (tick), 500 verified followers, impressions in 90 days as a number with no bar ("upper guess") | `users/me` `subscription_type`, `verified_followers_count`; impressions from Clip Factory's own post stats (no extra reads) |

### 25.3 Money

* **YouTube.** Daily `estimatedRevenue` and `estimatedAdRevenue` (`dimensions=day`, USD as YouTube reports it), for the
  current and the previous two calendar months, re-read every day (month-end adjustments land later): a changed
  amount sets `revisedAt`. "Ads are on" shows when ad revenue is above 0. Per clip: `dimensions=video` filtered to
  Clip Factory's own posts (≤ 50 ids a call) from the earliest post's day to the last processed day, written to the
  Post as `revenue{amountMicros, currency, through, source, fetchedAt}` with `UpdateItem SET revenue` only (never
  through `merge_metrics`). The Shorts/long split (`creatorContentType` with revenue) is tried once a run and hidden
  when the API answers 400 [unverified]. Label: "YouTube's estimate · Can change at month end · 2–3 days behind".
  Link: "AdSense for YouTube › Payments".
* **Facebook.** Behind `moneyVerified`. Until it is true the card says "Facebook money: coming soon" and the run keeps
  only a stripped copy of the raw answer (≤ 8 KB, no `access_token`, no `paging`) on the state item, never shown. After
  that: daily `content_monetization_earnings` with unit and currency stored as received, and
  `monetization_approximate_earnings` as its own `source` with "doesn't include bonuses". A metric that errors is "not
  available"; there is no silent fallback. Label: "Meta's estimate · Final may differ".
* **Instagram, TikTok, X.** "[Platform] doesn't share earnings with apps." with where to look in the app.
* **Money this month** adds up only `earning` platforms, one line per currency, never converted.
* **First money** is celebrated only after an amount above 0 survived a later re-read at least 3 days on.

### 25.4 "Allow money reading" (one button, merged into the existing connection)

* `config/platforms.json` `scopes` stay exactly as before (Connect never changes); new `moneyScopes`: YouTube
  `yt-analytics-monetary.readonly`, TikTok `user.info.stats` (TikTok's Connect list now also comes from config, same
  values). Meta and X: none, and Meta OAuth is untouched.
* `POST /v1/accounts/{platform}/connect` with `{ "grant": "money" }` (YouTube and TikTok only; 409 when the platform is
  not connected): the authorize URL asks for the Connect scopes plus the money scopes (YouTube with
  `include_granted_scopes=true`, `access_type=offline`, `prompt=consent`). The `OAUTH#` state item carries
  `grant: "money"`.
* The callback for a money grant runs `save_money_grant()`, never `save()`: (1) a failed exchange, a missing Connect
  scope, a missing money scope or **another account** (a different channel or TikTok user) writes nothing, so the old
  token and Account stay; (2) the token secret is written; (3) `mark_account(scopes = old ∪ new, remove
  moneyScopesMissing)`, an UpdateItem that keeps every other Account field. It never calls `put_account`,
  `setup.record(gates)`, `_disconnect` or the keys route.
* It then redirects to `/settings/posting/money?result={code}&platform={platform}` with a code from
  `money_allowed | money_denied | money_missing | money_not_connected | money_wrong_account |
  money_error`; the page starts a "Check now". A bad, expired or reused state carries no grant, so it ends as the
  plain Setup `expired` result (nothing is written either way).
* Setup text on the card, for a grown-up: "Use the same Google Cloud project. Don't make new keys." · add the monetary
  permission (Copy) · set Publishing status to In production · press **Allow money reading** (Google's "unverified
  app" screen is expected: Advanced › Continue). TikTok: add `user.info.stats` and send for review, then press
  **Allow follower reading**; on any TikTok error nothing changes and the card says "TikTok hasn't approved this yet".

### 25.5 API (under the existing `ANY /v1/{proxy+}`)

| Method and path | Body | Answer |
|---|---|---|
| GET `/v1/money` | – | `MoneyView` |
| GET `/v1/money/{platform}/days?from&to` | – | `{ days: { date, amountMicros, currency, unit, source, revisedAt? }[] }` (at most 400 days) |
| POST `/v1/money/refresh` | – | 202 `{ started: true, nextAllowedAt }`, or 200 `{ started: false, nextAllowedAt }` within the hour (one conditional write on `MONEYPREFS.lastManualAt`) |
| POST `/v1/money/seen` | `{ key }` | `MoneyView`; 404 unless `key` is pending |
| PUT `/v1/money/country` | `{ country }` | `MoneyView`; 400 for a code not in `countries` |

```ts
interface MoneyView {
  platforms: MoneyCard[]; country: string | null; countries: { code: string; name: string }[];
  thisMonth: { currency: string; amountMicros: number; platforms: Platform[] }[]; // earning platforms only
  celebrations: { key: string; platform: Platform; kind: "goal" | "in_program" | "first_money"; text: string }[];
  nextCheckAllowedAt?: string; asOf: string;
}
interface MoneyCard {
  platform: Platform; state: MoneyState; pill: string; line: string; programme: string;
  checkedAt?: string; detectedAt?: string; lagNote?: string; lastError?: string;
  goals: MoneyGoal[]; more: MoneyGoal[]; extras: string[]; // "Ads are on", the TikTok warning, the 2027 rules
  revenue?: { currency: string; unit: string; source: string; tag: string; note: string; month: string;
              thisMonthMicros: number; last30: { date: string; amountMicros: number }[];
              months: { month: string; amountMicros: number }[] };
  notShared?: string; comingSoon?: string; statusWhere: Where; paidWhere: Where;
  needsPermission?: { button: string; what: "money" | "followers"; steps: string[]; copy?: { label: string; value: string }[] };
}
interface MoneyGoal { key: string; label: string; kind: "bar" | "tick" | "number"; current: number | null;
  goal: number | null; reached: boolean; approx: boolean; windowDays?: number; note?: string; help?: string;
  or?: string; missing?: string; countingDaysLeft?: number; sourceUrl: string }
```

No response carries a token, a raw platform body or a paging URL; the only scope URL is the one the owner copies into Google Cloud (`needsPermission.copy`), as Set up posting already does. Existing routes: `GET
/v1/clips/{id}/performance` adds `revenue` per platform row only when a platform reported one (YouTube now; Facebook
once `moneyVerified`); `GET /v1/weeks/{week}` adds `revenueByPlatform` `{ [platform]: { currency, amountMicros, source,
tag } }` summed from that week's `REVENUE#` days. `paidViews` stays in the weeks answer and is no longer read.

### 25.6 Items, schedule and Terraform (additive: 0 destroy, 0 replace)

Items as listed in `money/__init__.py`: `ACCTSTAT#{platform}#{day}` (`ttl` epoch seconds, 800 days),
`MONEYSTATE#{platform}`, `REVENUE#{platform}#{day}`, `MONEYPREFS`, `MONEYOWNERS`/`USER#{id}` (written when the owner
opens Money, refreshes or allows money reading). The Account gains `moneyScopesMissing` (set and removed with
`mark_account` only). `earningsRates` and `earningsPaid` stay in Settings with their validation and stored values,
accepted and never read.

`infra/modules/money`: Lambda `cf-prod-money` (`clipfactory_api.money.handler.handler`, 256 MB, 300 s), its log group,
a role with DynamoDB GetItem/PutItem/UpdateItem/Query (no DeleteItem), `GetSecretValue` on `platform_secrets_arn` and
`PutSecretValue` on `platform_token_secrets_arn` only (same validation regexes as `stats`), EventBridge
`cron(0 6 * * ? *)` with no retries, and `function_names`/`schedule_rule_names` merged into monitoring (error and
failed-invocation alarms). `cf-prod-api` gets `MONEY_FUNCTION_ARN` and `lambda:InvokeFunction` on it for Check now.
Tokens come only through `oauth.tokens.SecretsTokenProvider` (the lease keeps X and TikTok rotations single).
Each platform runs on its own: one failing never stops the others, and nothing here can block posting.

Daily calls: YouTube `channels.list` (1 unit), `playlistItems` (1–2 units), about 6 Analytics queries; Facebook 2–3,
Instagram 1, TikTok `user/info` + `ceil(videos/20)` `video/list` pages, X one `users/me` a day booked against `RATE#x`
at the post-read price (`usdPerPostRead`, about $0.15 a month, inside the $10 cap).

`forget` (explicit YouTube Disconnect only, run by `cf-prod-stats`) also deletes the YouTube `ACCTSTAT#`, `REVENUE#`
and `MONEYSTATE#` items and the Posts' `revenue`. Nothing deletes on token expiry or `invalid_grant`.

### 25.7 Web

Settings › Posting › Money: one apple per platform (`money-youtube`, `money-tiktok`, `money-instagram`,
`money-facebook`, `money-x`) plus `money-country` and `money-payouts`; the old `money-how`, `money-paid`, `money-rate`,
`money-sources` anchors go to the branch. Each card: one state pill, at most 3 eased bars ("812 / 1,000
subscribers"), the rest under **More**, explanations behind a small "?", "This month $12.40 · YouTube's estimate" with
a 30-day sparkline, a grey "2–3 days behind · checked 2 h ago" line and at most one vermilion button. Home: a Money
tile (estimate lines per currency, or "No money yet. Here's how close you are" with the nearest bar). Clip page:
"YouTube's estimate for this clip: $0.42" only when reported. This week: the reported total only. Celebrations are
once each, acknowledged on the server ("You hit 1,000 subscribers!", "You're in YouTube's Partner Program!", "Your
first money from YouTube!"). The release label is "Real earnings".

### 25.8 Not verified live (each failure becomes a "not available" label, never a number)

YouTube: `creatorContentType` with revenue metrics; the Analytics quota; whether `yt-analytics-monetary.readonly` is a
sensitive scope; how long the YouTube API policy lets this data be stored (no automatic delete until confirmed);
whether the expanded (fan-money) tier answers 200. Meta: whether both earnings metrics still answer after the
2026-06-15 deprecations, their unit and the permission they need. TikTok: `user.info.stats` review time, whether that
review pauses the live app, rate limits, and the official rewards page. Instagram: thresholds other than Gifts and the
Gifts page. X: `verified_followers_count` as a user field, and the revenue sharing details beyond the help page.

### 25.9 Tests

`api/tests/test_money_rules.py` (official sources, rule switch, country rules), `api/tests/test_money.py` (the YouTube
state matrix with each 403 reason, no downgrade, write-once `detectedAt`, the 92-day re-read and `revisedAt`, the
Shorts split hidden on 400, Facebook hidden while unverified, TikTok counting/pagination/clamp, X budget, celebrations,
routes, the hourly refresh claim, `forget`), `api/tests/test_money_grant.py` (`save_money_grant` keeps every Account
field and every other item, refuses other accounts, writes nothing on failure; Connect scopes unchanged; the lease
under two refreshes), `web/test/money.test.ts`, `web/test/noGuesses.test.ts` (the CI guard), `web/e2e/money.spec.ts`,
`infra/modules/money/tests/money.tftest.hcl` and `envs/prod/tests/wiring.tftest.hcl`.
