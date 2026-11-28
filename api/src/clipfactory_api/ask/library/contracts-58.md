## 58. Can I earn yet? (owner request, 2026-11-28)

BR-39, ADR-115. The owner: *"can you add a feature that tells me (gives me a notification when i can become monitized
and for which platform that is) based on my views and statistics"*. Builds on §25 (the goals, the states and the
once-only celebrations stay as they are). Clip Factory's own accounts only; Clips Funded is not part of this.

- **R1. Thresholds.** Still only in `config/monetization.json`, each goal with its official page. Checked again on
  2026-11-28 (`asOf`). Changes: TikTok Creator Rewards adds Mexico (open in US, GB, DE, FR, MX, BR, JP, KR; **not
  Sweden**); YouTube's fan-money goals cite answer 13429240 (lists Sweden); the 2027 YouTube rule is for new channels;
  X's impressions goal is 500,000 Home impressions from verified people in 90 days (an official snippet; the page
  refuses automated reads). New optional per-platform fields: `sources[]` (official https pages, `creators.facebook.com`
  joins the allowed hosts) and `regionNote` (one line). A goal may carry `required: true`: a `number` goal (no bar)
  that must still be met, so the status stays "Can't see" (X's verified impressions).

  | Platform | Programme | Needs | Sweden |
  |---|---|---|---|
  | YouTube | Partner Program (ads) | 1,000 subscribers + 4,000 watch hours in 12 months or 10M Shorts views in 90 days | Open |
  | YouTube | Fan money (More) | 500 subscribers + 3 public videos in 90 days + 3,000 hours or 3M Shorts views | Open |
  | TikTok | Creator Rewards | 10,000 followers + 100,000 views in 30 days, 18+, videos over 1 min, personal account | **Not open** |
  | Instagram | Gifts | 500 followers, professional account, 18+ | Open |
  | Facebook | Content monetization | Invite only (in-stream ads: 5,000 followers + 60,000 minutes in 60 days) | Invite |
  | X | Original Content Rewards | Premium + 500 verified followers + 500,000 verified impressions in 90 days | Open |

- **R2. The one word.** `MoneyCard.ready` (connected platforms only, additive):
  `{ status, word, percent, next, nextUrl?, checked, sources[], regionNote? }`. `rules.readiness(goals)`: each
  requirement is a goal joined with its `or` partner (the best half counts). **Ready** = every requirement met;
  **Close** = every requirement visible and the slowest at 90% or more; **Not yet**; **Can't see** = a requirement
  can't be read (a `missing`, a `countingDaysLeft`, a `required` number). `percent` = the slowest visible requirement,
  rounded down. Also **Not here** (`pick` says `not_open`: "Creator Rewards isn't open in Sweden yet."), **Invite**
  (no published goals: Facebook) and **Joined** (`in_program` or `earning`). `next`: "Apply in {statusWhere}." for
  Ready, "Almost there: 92%. Keep posting!", "31% there. Keep posting!", or where to look.
- **R3. Real numbers only.** Read today: YouTube subscribers (rounded by YouTube), engaged Shorts views in 90 days,
  watch hours in 365 days (our count of long videos and lives), public uploads in 90 days; TikTok followers (needs
  `user.info.stats`) and 30-day views (our daily snapshot delta, after 30 snapshots); Instagram followers; X Premium
  and verified followers. Not visible: TikTok's own "qualified" views and age; X's verified-only impressions (ours is
  an upper guess, no bar); Facebook's invite. Nothing new is collected and **no reconnect** is needed.
- **R4. Milestones, once each.** The daily money run (`collect._milestone`) queues `{platform}:ready:{ruleId}`
  (kind `ready`, "You can join Instagram Gifts on Instagram! Apply in Professional dashboard › Monetization.") or
  `{platform}:close:{ruleId}` (kind `close`, "Instagram money is close: 92% there. Keep posting!") into the existing
  `pendingCelebrations` of `MONEYSTATE#{platform}`, only for a `not_in_program` rule in force in the owner's country.
  Ready wins: once ready is queued or seen, close never is. `MoneyCelebration.kind` adds `ready | close`.
- **R5. Where the owner sees it.** In the app: the Money screen's **Can I earn?** cards (title, one eased bar per
  requirement, the one word, one next line, one **Details** fold with the More goals, notes, region line, where to
  look, "Checked 28 Nov 2026" and the source links) and the celebration (toast and confetti, once, acknowledged by
  `POST /v1/money/seen`) on Money, Home and Settings › Posting › Money; the release's update bar says "Money ·
  Monetization". On the phone and desktop: `cf-prod-notify` watches `MONEYSTATE#` MODIFY records and sends each new
  `ready`/`close` key once (`NOTIFIED#earn#{key}`, 30 days) to the owner's devices, title "Clip Factory", the
  milestone's text, tag `earn-{platform}`, opening `/money`; under `notify.earn` (new, on by default, "Ready to
  earn" in Settings › Notifications). A platform's very first money state is a new item, so a milestone in that one
  write shows in the app only.
- **R6. Never on the owner's behalf.** Nothing applies, joins, accepts terms or changes an account. The app only says
  where to apply.
- **R7. Infra.** The notify filter gains the `MONEYSTATE#` prefix: an in-place change of the one event source mapping
  pattern (0 replace, 0 destroy). No new resource, role or permission.
- **R8. Tests.** `api/tests/test_money_ready.py` (readiness, the card, once-only milestones, region, push dedupe and
  `notify.earn`), `web/test/earnCards.test.tsx`, `infra/modules/notify/tests/notify.tftest.hcl`.
