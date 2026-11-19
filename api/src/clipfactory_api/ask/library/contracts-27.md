## 27. Money dashboard: MRR by app and money per clip (owner request, 2026-11-19)

### 27.1 The owner's words

"Daily MRR, monthly MRR, and weekly MRR, and yearly MRR. And that should all be based on whatever I filter by. So if
it's TikTok, YouTube, or if I want to select some of them, or if I want all of them, which is default. … the most
important ones, which are my KPIs, is … first of all, monthly MRR." Then: "And when I say revenue, I mean how much I'm
earning per video or per whatever, but it's from these social media platforms, how much money I'm getting." He also
asked for it to work on every screen he uses, and for buttons on phones to sit where the thumb rests (bottom right),
never top left. The release label is "Money dashboard".

### 27.2 The numbers

The owner is paid per view, not by subscription, so "MRR" here is **the money the apps reported over a recent stretch
of days**, built only from stored `REVENUE#{platform}#{day}` rows (§25). The screen keeps the MRR names with a plain
line under each, and a "?" says: "MRR usually means subscriptions. Here it means the money YouTube (and other apps that
share it) reported for your videos over that many days."

* **`through`** (the end day): the newest stored row date of each counted app (`throughBy`, a $0 day counts as
  reported), and the **earliest** of those across the counted apps, so every app covers the same days. Every period
  ends on `through`, inclusive; the page says "Up to Sat 16 Nov" and, with YouTube counted, "· YouTube is 2–3 days
  behind". Dates are the platform's own calendar days, formatted on the web as plain dates, never through a time zone.
* **Monthly MRR** (the main card, biggest number): the sum over `[through−29, through]`, compared with
  `[through−59, through−30]`. **Weekly MRR**: `[through−6, through]` against the 7 days before. **Daily MRR**: Monthly
  ÷ `coveredDays` in whole micros (half away from zero), plus "Latest day: Sat 16 Nov · $1.12". `coveredDays` is the
  number of the last 30 days that stored history covers (from the earliest counted app's `historyFrom`, at most 30),
  so 10 days of $1.00 read $1.00 a day, not $0.33. **Yearly MRR**: Monthly × 12 once 30 days are covered, Monthly ×
  360 ÷ `coveredDays` before that (`paceMicros`), always "At this pace for a year", never added to anything, worked out
  only on the server; "Last 365 days: $X" shows only when stored history covers every day of `[through−364, through]`
  for every counted app. Under 30 covered days the sub-lines say so ("only 10 days so far", "average of 10 days",
  "from 10 days so far").
* A day between an app's first stored row (`historyFrom`) and `through` with no row counts as $0; a day before it is
  not covered. A comparison shows only when every counted app covers the whole previous period; otherwise the card
  says "Not enough days to compare yet".
* The chip: `changePct = round((cur − prev) × 100 ÷ |prev|)` (whole %, half away from zero, integers only) with
  `direction` `up | down | same | new | none`. "Up 12%" (success tone, up arrow), "Down 8%" (neutral, down arrow),
  "Same", "New" when the previous period was $0 and this one is not, nothing when both are $0. Over 999 % reads
  "Up 999%+". Never vermilion, never colour alone.
* Currencies are never converted or added: one `currencies` entry per currency, biggest Monthly first.

### 27.3 Honesty states

| Situation | What the dashboard does |
|---|---|
| TikTok, Instagram or X in the filter | Left out of the totals. Under the cards: "Not counted: TikTok, Instagram and X don't share money with apps." with a "Not shared" chip per app linking to its `paidWhere` when it has a link. Never a number. |
| Facebook while `moneyVerified` is false | Left out: "Facebook money: coming soon." |
| App not connected | Left out: "Connect {App} in Settings › Posting › Set up posting." |
| YouTube without the monetary scope | Left out: "YouTube needs your OK first." with one vermilion **Allow money reading** link to `/settings/posting/money#money-youtube`. |
| Counted app with no rows yet | Left out: "No money from YouTube yet." |
| `lastError` and no rows yet | Left out with reason `error`: "Couldn't check YouTube today." and listed in `errors`, so the banner says so (a broken check never reads as "you earned nothing"). |
| `lastError` on a counted app | Kept in with the rows it has; banner "Couldn't check YouTube today. Showing money up to Thu 14 Nov." (warn tone), naming only the apps in `errors`. |
| One counted app's newest day older than today − 6 while another is up to date | That app is left out with reason `behind` ("Facebook hasn't sent money since Tue 27 Oct. Not counted for now.") and listed in `behind`, so it cannot pull every app's days back; the others keep current numbers. |
| Every counted app older than today − 6 | They stay in; `stale: true`; the banner names the apps in `errors` ("Couldn't check …") and the other `behind` apps ("… hasn't sent new money lately."), then "Showing money up to …". |
| Revised days in the 60 days shown | Grey line "YouTube changed 2 days after rechecking them." |
| Two or more currencies | Each card stacks one line per currency; a Segmented currency picker (with Glide) above the chart; "Different money types are never added together." |
| Nothing can be counted | "No money yet." with the nearest goal bar (`nearestGoal`, as on Home) and **See how close you are** (Settings › Posting › Money). No zeros, no chart. |
| Only apps that never share | One card: "{App} doesn't share money with apps. Look in {paidWhere}." The clip list still shows views. |

Every amount carries its tag ("YouTube's estimate", "Meta's estimate", "Apps' estimates" for a mix). "Paid",
"received" and "actual" never sit next to an amount.

### 27.4 The screen

* **Route** `/money` (`{ name: "money" }`, section `money`, title "Money · Clip Factory"). Apps, period and sort are
  not part of the Route: the page reads `?apps=youtube,facebook&period=30&sort=views` itself and keeps the address up
  to date with `history.replaceState` (no focus move, no scroll). Saved per device in `localStorage["cf-money-dash"]`
  (every read and write in try/catch, bad values fall back to the defaults); the address wins over storage.
* **Navigation**: "Money" (icon `coin`) between Library and Settings in the sidebar and the phone tab bar (6 tabs;
  under 360 px the bar's side padding shrinks so each tab keeps 48 px). Home's **See money** opens `/money`. The
  dashboard header links "How close am I to getting paid?" to Settings › Posting › Money, which keeps programme
  progress, Allow money reading, Check now and payouts, and now starts with a **Money dashboard** apple
  (`money-dashboard`, `href: "/money"`, found by "revenue", "mrr", "money per video").
* **Controls**: an **Apps** group of toggle chips (`<button aria-pressed>`, 44 × 44, a 20 px PlatformMark each, then
  **All** at the right end). Tapping an app while All is on picks only it; turning the last one off is All; all five is
  All; All clears the rest. **Period** (Segmented with Glide): 7 days, 30 days, 90 days, Year (default 30). **Sort
  clips** (Segmented): Most money, Most views. The cards always use their fixed days; the period changes the chart and
  the clip list ("Cards use fixed days. The picker changes the chart and the clip list.").
* **Phones and touch tablets** (`(max-width: 767px), (pointer: coarse) and (max-width: 1194px)`): the controls sit in
  a glass **dock** (110 px, two rows, right-aligned) above the tab bar at the bottom right: the app chips on top, the
  period nearest the thumb. Nothing tappable in the top-left third of the page. Ask's home spot moves above the dock
  (§19.8) and the page's bottom padding grows so the last clip scrolls clear. On touch tablets the dock hugs the right
  edge. On a short phone (height 640 px or less) the header and the Monthly card tighten so the Monthly number is above
  the dock on first load, and the "?" stays clear of Ask's home spot. **Wide screens with a mouse**: a full-width glass
  band under the title that stays at the top (sticky) while the page scrolls; the controls sit at its right end (two
  short rows, one row once the band is 900 px or wider). The page scrolls under the whole band, so it never floats
  over the sort bar, a clip's money or the chart. On both layouts the controls come right after the title in reading
  and tab order (CSS keeps them where they show).
* **Loading a new filter**: the last filter's numbers and clips stay in place dimmed (`aria-busy`) until the new ones
  arrive; when the new load fails, they go and the error with Try again shows instead, and Show more appears only for
  the list on screen. With no money per video for the chosen apps the clip list hides its Sort bar (the note says
  "Sorted by views.").
* **Cards**: Monthly (main card, display-size number that counts up once, 700 ms) then Weekly | Daily side by side,
  then Yearly. When the card area is 880 px or wider: Monthly on the left over two rows, Weekly and Daily on the
  right with Yearly under them. A card narrower than 150 px drops its number one step (container query).
* **Chart** (hand-drawn SVG, no library): money per day (7, 30, 90) or per week (Year, weeks ending on `through`, the
  oldest marked partial), split by app only when two or more apps have money (YouTube bone, Facebook leaf; never
  vermilion). No gridlines, axis lines or borders: one soft baseline band, the highest value on top, the first and
  last dates under it. 180 px tall on phones, 240 px from 768 px, 280 px from 1280 px. A tap, pointer or the arrow
  keys show "Sat 16 Nov · $1.12 · YouTube's estimate" in a small tip, mirrored in a polite live line; "Show as a list"
  lists every value. "Money history starts 1 Sep." when the period reaches back before the first stored day. Bars
  grow once (520 ms, staggered up to 240 ms); nothing moves under reduced motion.
* **Money per clip**: "From {from}, up to {to}. YouTube's estimate." Each row is a whole-row link to `/clips/{id}`:
  the 9:16 cover, the title (two lines), YouTube's amount (or "None yet"), the apps that don't share on one line with
  "Not shared", "12.3K views so far", and "$4.10 per 1,000 views · YouTube's numbers" when the server sent it; the
  row's total at the right. When the list is 900 px or wider each app gets its own column with its views. 20 a page,
  **Show more**, skeletons while loading, an error panel with Try again. Year shows each clip's lifetime money.
* **Ask anchors**: `money-dash`, `money-dash-monthly`, `money-dash-filter`, `money-dash-period`, `money-dash-clips`;
  help guides `real-money` (now opens `/money`) and `money-mrr`; `money` is a help page name (§19.6).

### 27.5 API (additive, under `ANY /v1/{proxy+}`)

`GET /v1/money/summary?platforms=youtube,facebook&chart=30`: `platforms` any of the five (missing = all; unknown → 400
"Pick apps from the list."; duplicates folded; STATS_ORDER), `chart` 7 | 30 | 90 | 365 (default 30, else 400).
Registers the owner like `GET /v1/money`. Reads `MONEYSTATE#` and `REVENUE#{p}#` only for the chosen apps that
`money_shown()` allows (`money/summary.py`).

```ts
interface MoneySummary {
  platforms: Platform[]; included: Platform[];
  excluded: { platform: Platform; reason: "not_shared" | "coming_soon" | "not_connected" | "needs_permission" | "no_money_yet" | "behind" | "error"; text: string; where?: MoneyWhere }[];
  through: string | null; throughBy: Partial<Record<Platform, string>>; historyFrom: Partial<Record<Platform, string>>;
  lagNote?: string; currencies: MoneyCurrencySummary[]; revised: { days: number; platforms: Platform[] };
  errors: { platform: Platform; text: string; checkedAt?: string }[]; behind: Platform[]; stale: boolean; asOf: string;
}
interface MoneyChange { previousPeriodMicros: number | null; changePct: number | null; direction: "up" | "down" | "same" | "new" | "none" }
interface MoneyCurrencySummary {
  currency: string; tag: string; platforms: Platform[]; coveredDays: number;   // 1–30
  monthly: { amountMicros: number; from: string; to: string } & MoneyChange;
  weekly:  { amountMicros: number; from: string; to: string } & MoneyChange;
  daily:   { averageMicros: number; from: string; to: string; latest: { date: string; amountMicros: number } | null } & MoneyChange;
  yearly:  { paceMicros: number; last365Micros: number | null };
  chart:   { period: 7 | 30 | 90 | 365; bucket: "day" | "week"; from: string; to: string;
             points: { start: string; end: string; amountMicros: number; byPlatform: Partial<Record<Platform, number>>; partial?: true }[] };
}
```

The comparison's previous amount is `previousPeriodMicros` (not `previousMicros`, which stays the stored revision field
and never leaves the server, with `breakdown`, tokens and raw bodies).

`GET /v1/money/clips?platforms=&period=30&sort=money&cursor=&limit=20`: `period` 7 | 30 | 90 | all, `sort` money |
views, `limit` 1–50. One Query of `POST#`, grouped by clip and sorted here (most money: total, then views, then
newest; most views: views, then newest; when no chosen app shares money, by views with `note` "{TikTok} doesn't share
money per video. Sorted by views."), then one BatchGetItem of the page's `CLIP#` items and 1-hour cover links for the
page only. Clips with a posted Post on a chosen app, posted on or before `to`. The cursor is opaque (an offset and a
hash of the apps, period, sort and `to`); one that no longer fits → 400 "This list changed. Load it again."

```ts
interface MoneyClips {
  period: 7 | 30 | 90 | "all"; from: string | null; to: string | null; sort: "money" | "views"; sortedBy: "money" | "views"; note?: string;
  clips: { clipId: string; title: string; coverUrl?: string; firstPostedAt: string; views: number | null;
    totals: { currency: string; amountMicros: number }[];
    platforms: { platform: Platform; postId: string; url?: string; postedAt: string; views: number | null;
      money: { amountMicros: number; currency: string; from: string | null; to: string; tag: string; source: string } | null;
      per1000Views: { amountMicros: number; currency: string; views: number; tag: "YouTube's numbers" } | null;
      moneyState: "reported" | "not_shared" | "coming_soon" | "not_reported_yet" | "needs_permission" | "not_connected" }[] }[];
  nextCursor?: string;
}
```

Money per clip: `all` reads the Post's `revenue`; 7, 30 and 90 read `revenueWindows[period]`, and only a window over
the list's own days (`from` and `to` equal to the list's, `to` being YouTube's newest window) counts: one left from an
older run is `not_reported_yet` with `money: null`, never ranked beside fresh ones. Only YouTube reports money per
video (Facebook's is per Page, so a verified Facebook alone is still sorted by views with the note), and only while
it is connected with the monetary scope, as in the summary: otherwise its lines are `needs_permission` ("YouTube needs
your OK first. Sorted by views.") or `not_connected` ("Connect YouTube to see money per video. Sorted by views.") with
no money counted. `per1000Views =
round(amountMicros × 1000 ÷ views)` only when the money and the views come from the same stored YouTube report and
those views are at least 1,000. Views per app are the post's lifetime views ("so far").

### 27.6 Collector and storage (additive)

* The lifetime per-video read (§25.3) asks `metrics=estimatedRevenue,views` and also keeps `revenue.views`.
* After the day report, `throughYT` is its newest row date. For N in 7, 30, 90: `startDate = throughYT − (N−1)`,
  `endDate = throughYT`, `dimensions=video`, `metrics=estimatedRevenue,views`, the same 50-id chunks, only for videos
  posted on or before `throughYT`. A video YouTube leaves out of a successful report had no money and no views in those
  days and is stored as 0. Each period is written with `UpdateItem SET revenueWindows.#n = :w` (the map is made with a
  conditional `SET revenueWindows = :m` first when missing, never on a Post that is gone): `{amountMicros, views, from,
  to, currency: "USD", source: "youtube.estimatedRevenue", fetchedAt}`. A period whose report fails keeps its old value
  (logged as `money.windows_failed`). Cost: 3 more report sets per daily run, `ceil(videos ÷ 50)` each.
* `forget` (explicit YouTube Disconnect, `cf-prod-stats`) also removes `revenueWindows`. Nothing else deletes it.
* No table, index, bucket, Lambda, role or route-infra change: the Terraform plan shows code updates only
  (`cf-prod-api`, `cf-prod-money`, `cf-prod-stats`).

### 27.7 Mock scenarios

Added to `MONEY_SCENARIOS` (`window.__cfMock.money.setScenario`): `dash_many` (YouTube 400 days with a weekly wave,
Facebook verified USD 120 days, TikTok/Instagram/X not shared, 26 clips with 18 earning, 2 revised days),
`dash_youtube_only` (75 days, so the 90-day and Year charts show the history note), `dash_nothing` (no rows; views
only), `dash_two_currencies` (YouTube USD, Facebook EUR), `dash_short_history` (20 days: no comparisons) and
`dash_error` (`lastError`, newest row today − 9; the clip list's second page answers 500). Every older scenario
renders the dashboard's own states. Dates count from `Date.now()`; tests fix the clock at 2026-11-19 12:00 UTC.
`web/src/api/mock/moneySummary.ts` is the mock's copy of the server's rules, checked against the shared golden cases;
it is the only web file allowed to do money arithmetic.

### 27.8 Not verified live

That YouTube returns rows for $0 days in the day report; that Analytics `views` with `dimensions=video` match for
Shorts; the Analytics quota for the 3 more report sets a day; that a video missing from a successful `dimensions=video`
report earned nothing in those days.

### 27.9 Tests

`api/tests/fixtures/money_summary_cases.json` (26 shared golden cases, written by `api/tests/money_cases.py`, read by
pytest and vitest); `api/tests/test_money_summary.py` (the golden cases, the end day, missing days and coverage,
rounding and the 999 cap, daily and pace, last 365, currencies, revised, every excluded reason, errors and stale, week
buckets, parameters, no internal keys); `api/tests/test_money_clips.py` (grouping, filter, both sorts, the views
fallback with its note, per 1,000 views only from the same report, all vs periods, cursor and the changed list, page
only presigns, no internal fields); `api/tests/test_money.py` additions (periods anchored on YouTube's newest day with
the same report's views, `SET revenueWindows.#n` only, a failed period keeps its value, a deleted Post stays deleted,
`forget`). `web/test/moneyDash.test.ts` (filter rules, address over storage, throwing storage, plain dates in three
time zones, chip words, chart shape, the font step, the mock against every golden case); `web/test/noGuesses.test.ts`
(no `amountMicros` times or divided outside the mock copy and the Settings sparkline's drawing, no × 12 near money,
no views turned into money, `per1000Views` only formatted); `web/test/money.test.tsx` (See money opens `/money`);
`web/e2e/money-dashboard.spec.ts` (13 sizes incl. 768 and 1024 with and without touch and the desktop app's
1200 × 820 and 380 × 600: no sideways scroll, no edges, axe contrast light and dark, 44 px targets, the arrow cursor;
the thumb zone, the toolbar staying in view, and every flow); `web/e2e/navigation.spec.ts` (6 tabs).
