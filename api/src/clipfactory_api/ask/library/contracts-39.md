## 39. Content Rewards: the two ways, all your money, and does this clip fit (owner request, 2026-11-21)

The owner's words, the day §38 was approved: *"please double check that the steps to conect to contentrewards is
extremely easy and simple and set up in. a chronological and structured manner so the UX is better and the user has a
better and pleasant experience on the app using eaither the content rewards way of videos or normal way we have done so
far, i also need to track how much i earn from all platforms including contentrewards. btw i would like to know if the
content i upload is compati ble with the content rewards campaigns so i can get paid instead of me selecting the content
rewards way of uploading but arent compatible, so please make sure thats in place as well"*. Still binding from §38:
paste a campaign link and Clip Factory follows its rules, connected like the platforms, 3 steps per campaign (5 at
most), every step idiot-proof for an 8-year-old (§38.1). Decision record: ADR-63.

What this section changes, and what it leaves alone. It builds on §38 as builders A (`feature/cr-api`) and D
(`feature/cr-web`) built it; where the two disagree, this one wins, and every change to §38's words or order is listed
as "§38.x: old → new" (§39.1, **Changes to §38**). **The normal way is frozen**: Home's form at `/`, the Review card
of a clip with no campaign and their taps stay exactly as on origin/main (`4fca538`); the one addition anywhere on the
normal way is the optional "could earn" line of §39.3 when a joined campaign fits, which never blocks, never adds a
needed tap and is not there when he has no campaign. §25's rule stays: only money a platform or Content Rewards
reported, never calculated, guessed, converted or typed in. The §27 MRR cards keep their numbers and never include
Content Rewards. Data is additive only (§39.3, **Data**). The §38.1 screen rules apply to every new screen: kid-proof
words, one vermilion button per screen, no `cursor:` rule, no edges, `<Glide>` for pick-one bars, reduced motion, WCAG
AA, phone controls at the bottom right, never made for kids, paid partnership on campaign clips, TikTok's own rules
(§17.8).

### 39.1 Connect in time order, and the two ways

**One name for each thing** (screens, help guides, docs, notifications; tests read this list):

| Thing | Words | Where |
|---|---|---|
| The normal way | "Make clips" (Home's main button, as today). Its clips carry no label. Only where both ways are named side by side: "normal clips" ("Make normal clips instead") | Home `/`, Review, Library |
| The campaign way | "Make clips for this campaign" (the campaign card's vermilion, §38.4); on Home's campaigns row the chip's line "Make clips" | campaign card, Home row, campaign video rows |
| Clips made the campaign way | "campaign clips", one "campaign clip" | Home strip "Campaign clips · FaZe Clips", job page strip, Review and clip page "Campaign clip · FaZe Clips", Library chip "Campaign" |
| A normal clip that could earn | "This clip could earn money on FaZe Clips." and the button "Make it for FaZe Clips" | Review, clip page |
| The fit | "Can earn on FaZe Clips" · "Almost ready for FaZe Clips" · "FaZe Clips needs a new copy of this clip" · "One thing first for FaZe Clips" · "This clip can't earn on FaZe Clips" · "Probably OK for FaZe Clips" | §39.3 |
| The site | "Content Rewards" (never "CR" on a screen) | everywhere |

Never on a screen: "the Content Rewards way", "mode", "type", "normal mode", "compatible".

**Connect Content Rewards: the steps in time order.** Setup stays three numbered steps on one page,
`/settings/posting/setup/contentrewards` (§38.3), the only place Connect happens, like each platform's setup page. Each
step is something only the owner can do or knows: CR's API has no tool that tells Clip Factory he has an account or
which accounts he added inside Content Rewards (`get_me` returns only his `cre_` id and brand memberships,
`mcp-tools.json` 2026-10-01), so steps 1 and 2 are one green tap each; step 3 ticks steps 1 and 3 by itself. Ways in:

| Way in | Taps to reach the page |
|---|---|
| A pasted campaign link (the owner's own way, §38.4): Home's box, Paste, "Add campaign", then the card's next step "Connect Content Rewards" | 3 |
| Money: the Content Rewards row of All your money (§39.2), "Set up Content Rewards" | 2 (Money tab, the button) |
| Ask: "connect content rewards" opens the `setup-step:contentrewards` action (§38.17) | 2 |
| Settings, Posting, Set up posting, the Content Rewards card | 4 |

From zero (no Content Rewards account; the Mac app; YouTube only), from a pasted link:

| # | Screen | What he does | Taps |
|---|---|---|---|
| – | Clip Factory: Home | tap Paste, tap "Add campaign" | 2 |
| – | Clip Factory: the campaign card (next step `connect`: "Connect Content Rewards so I can see if you're in.") | tap "Connect Content Rewards" (opens the page with `?back=/campaigns/{uuid}`) | 1 |
| 1 | Clip Factory: setup page, step 1 open | tap "Open Content Rewards" | 1 |
| 1 | Content Rewards: **Create your account** | type the email, tap **Send code** | 1 |
| 1 | the email (mail app or phone notice) | read the 6 numbers | 0 |
| 1 | Content Rewards: the code box | type them, tap **Verify** | 1 |
| 1 | Content Rewards: its first questions, only when it asks | answer, continue | 0–3 |
| 1 | Clip Factory: setup page | tap "I have an account" (step 1 ticks, step 2 opens) | 1 |
| 2 | Clip Factory: step 2 | tap "Open Content Rewards settings" | 1 |
| 2 | Content Rewards: Settings | tap **Accounts**, **Connect account**, YouTube | 3 |
| 2 | Google | pick the account, tap Allow or Continue | 2 |
| 2 | Clip Factory: setup page | tap "I added them" (step 2 ticks, step 3 opens) | 1 |
| 3 | Clip Factory: step 3 | tap "Connect Content Rewards" | 1 |
| 3 | Content Rewards: the allow page (already signed in from step 1; asked to sign in: +2, the email code) | tap the allow button | 1 |
| 3 | the door's page "Done! Go back to Clip Factory." | nothing: the app comes to the front | 0 |
| 3 | Clip Factory: setup page, confetti, "Content Rewards is connected!" | tap "Back to FaZe Clips" | 1 |
| – | Clip Factory: the campaign card, "You're in!" when he joined (checked at once, §38.12) | nothing | 0 |

**17 taps** (20 with Content Rewards' questions) on 10 screens: Clip Factory 3 (Home, campaign card, setup page), the
browser 6 (Content Rewards' sign-up, code, settings and allow pages, Google's, the door's Done page), mail 1. Each
more place inside Content Rewards is optional: Instagram +4, X +3, Facebook +10 (the Reel code, §38.3). **The owner's
own case** (he has an account with YouTube added, the link copied): Paste, "Add campaign", "Connect Content Rewards"
(card), "I have an account", "I added them", "Connect Content Rewards" (step 3), allow, "Back to FaZe Clips": **8 taps
on 5 screens** (Home, campaign card, setup page, the allow page, the Done page). That is the fewest: each tap is the
move to the next screen, a fact only he knows, or Content Rewards' own allow. Extras, only when they apply: an older
Mac app +1 ("Restart now", §38.15); Content Rewards says no to apps +2 ("Open email", Send) and +1 optional "I sent
it"; on a phone steps 1 and 2 work the same and step 3 says "Do this step on your Mac." with no button (on the Mac the
campaign card's "Connect Content Rewards" goes straight to step 3: 1 tap). Then each campaign (§38.4, unchanged): on
Content Rewards open it, **Join Campaign** (**Hold to confirm** when asked), share icon, **Copy campaign link**; in
Clip Factory Paste, "Add campaign": 6–7 taps, "You're in!" by itself.

**The two ways: how he picks.** Home at `/` is the normal way; for a video link or file it stays exactly origin/main's
form (Source bar "Paste a link" / "Pick a video", the link box with Paste and Clear, How many clips, Notes, "Make
clips", "Nothing gets posted until you tap Upload."). The campaign way always starts **from a campaign**, never from a
field on the normal form: the campaign card's vermilion "Make clips for this campaign"; Home's "Your campaigns" row,
whose chip for a campaign ready for clips says "Make clips" and opens `/?campaign={uuid}` in one tap; a campaign video
row's "Make clips from this" (§38.4 item 6); the fit's "Make new clips for this campaign"; or, for a clip already
made, the "could earn" line's "Make it for FaZe Clips" (§39.3). Home opened at `/?campaign={uuid}` shows, above the
link box, the strip "Campaign clips · **FaZe Clips**", the line "Clip Factory follows its 9 rules on every clip." and
at the strip's right end a quiet "Make normal clips instead" (→ `/`); the pick-one `<Glide>` bar "Which campaign" only
when two or more campaigns can make clips (no "None": leaving is "Make normal clips instead"); the "Videos from the
campaign" and channel chips (§38.5). The main button still reads "Make clips". A pasted Content Rewards link on `/`
still turns the button into "Add campaign" (§38.4): that is a campaign link, not a video.

| Way | Screen | Taps |
|---|---|---|
| **Normal** (origin/main today = after §39) | Home: Paste (or Command+V in the box) · "Make clips" · (the job runs) · "Go to Review" (or the notification) · Review: "Use my settings" · "Upload to N" | **5** |
| **Campaign** | Home row chip "FaZe Clips · Make clips" (or the card's "Make clips for this campaign") · a "Videos from the campaign" chip or Paste · "Make clips" · "Go to Review" · Review (the fit says "Can earn on FaZe Clips"): "Use my settings" · "Upload to 2" · (Clip Factory sends it to Content Rewards) | **6** (+1 "Fix it for me" only when the fit finds something Clip Factory can fix) |
| **A normal clip that could earn** | Review: "Make it for FaZe Clips" · (about 3 minutes; the copy appears on Review by itself) · "Use my settings" · "Upload to 2" | **3** from the card; the original keeps its own 2 taps |

The normal way gains 0 taps, 0 fields and 0 warnings: the tests of §39.5 fail if it gains one.

**Changes to §38** (each is a change of words or order; builders H and J carry them out, §39.4):

1. §38.1 (new rule): no names list → the names list above is the only wording for the two ways.
2. §38.2 journey A: "1 make a CR account · 2 connect the same accounts inside CR · 3 in the Mac app, tap "Connect
   Content Rewards", sign in, allow" → "1 make a Content Rewards account (or tap "I have an account") · 2 add the same
   accounts inside Content Rewards · 3 in the Mac app, tap "Connect Content Rewards" and allow (8 taps when 1 and 2
   are already done, §39.1)".
3. §38.2 journey C, each clip: "**2**: "Use my settings" · "Upload to N"" → "**2** (+1 "Fix it for me" only when the fit
   check finds something Clip Factory can fix, §39.3)".
4. §38.3 step 1 `ready-account`: green "I did this" → "I have an account" (the same `PATCH {step, done: true}`).
5. §38.3 step 2 `ready-socials`: title "Connect your accounts there" → "Add your accounts there" (one "Connect" on the
   page: the step 3 button); green "I did this" → "I added them"; "Do the same for Instagram, X and Facebook." → "Add
   Instagram, X and Facebook the same way, if you post there."; the `crLinked: false` line "… Connect it here, then tap
   I did this." → "… Add it here, then tap I added them.".
6. §38.3 the page: no return → the page reads `?back=` (only `/campaigns/{uuid}`, any other value ignored); after a
   `connected` or `read_only` result the "When it's done" vermilion is "Back to {campaign name}" (→ that page)
   instead of "Add a campaign", and the result card adds the line "Next: back to FaZe Clips.".
7. §38.4 membership `unknown`, vermilion "Connect Content Rewards" → `/settings/posting/setup/contentrewards` → the same
   with `?back=/campaigns/{uuid}`.
8. §38.4 Home's "Campaigns" row: "one chip per campaign with its state, tapping opens it" → "… a chip whose next step
   is `make_clips` shows "Make clips" and opens `/?campaign={uuid}`; every other chip opens the card. The row's line
   says "Tap a campaign to make clips for it." while any chip says Make clips".
9. §38.5 New job: "The form shows a pick-one `<Glide>` bar "For a campaign" (None + every campaign the owner is `in` or
   `manual`)" → "Only the campaign way (`/?campaign={uuid}`) shows campaign things: the strip, "Make normal clips
   instead", the bar "Which campaign" only with two or more campaigns (no None), the video and channel chips. Home at
   `/` shows no campaign field, bar, chip or line, whatever campaigns exist" (D's "For a campaign" bar on `/` goes).
10. §38.5 Job page: "A strip "For FaZe Clips on Content Rewards" with the rules count ("Following 9 rules")" →
    ""Campaign clips · FaZe Clips · Following 9 rules"".
11. §38.5 Review: "A strip … "For **FaZe Clips** · Content Rewards" with three ticks "Paid partnership", "#Ad at the
    start", "Logo on"" → "the fit block of §39.3 titled "Campaign clip · **FaZe Clips**": a tick only for a check that
    passed" (until `GET /v1/contentrewards/fit` answers, an API before G, D's strip stays as built).
12. §38.5 captions: "the row shows "I put #Ad and the campaign's tags back when it uploads." (no block)" → the same, and
    the fit block's "Fix it for me" puts them back on the card at once.
13. §38.5 and §38.14 refusals: "The API refuses what the card cannot send (…)" → "… and a campaign clip whose fit has a
    `no`, `remake` or `todo` item (§39.3)".
14. §38.7: "CR money is never added into the Money dashboard's MRR totals (§27) …; it has its own part." → "CR money is
    never added into the MRR cards (§27). It is added in one place: the total of "All your money" (§39.2), the same 30
    days, with its own tag."
15. §38.7 Money page: "a part `#content-rewards` after the cards" → "a part `#content-rewards` at the end of the page,
    after the clip list (as D built it); the page's first card is "All your money", whose Content Rewards row links to
    the part".

### 39.2 All your money in one place

**The screen.** `/money` (§27.4) gains one card first on the page, above the Monthly card: **All your money**
(`screens/money/AllMoney.tsx`, `data-help="money-everywhere"`, a glass card with no vermilion button; Monthly keeps
its place as the main MRR card with the biggest number). Title "All your money", then "Every place · 30 days up to Sat
16 Nov" (+ "· YouTube is 2–3 days behind" when YouTube is in it). The page's Apps chips and period picker don't change
it (the toolbar's note gains "All your money always shows every place."). One row per place, in STATS_ORDER (YouTube,
TikTok, Instagram, Facebook, X), then Content Rewards (only while `GET /v1/contentrewards` answers 200; on 404 or 503
the row is not there). A row: the place's mark (Content Rewards: the coin mark), its name, its words by state (below),
and at most one glass button at the row's right end (so on phones nothing tappable sits in the top-left third, §27.4).
Under the rows the **total**: "Total: $24.80" (display-3; it never counts up), "YouTube + Content Rewards · 30 days up
to Sat 16 Nov", the tag line "YouTube's estimate + Content Rewards' numbers"; two currencies give one line each and
"Different money types are never added together."; then "Not in the total: TikTok, Instagram and X (not available) ·
Facebook (coming soon)." With nothing to add: "Nothing to add up yet." and no total (never $0). While the card is on
the page, the dashboard's Notes card (§27.3) leaves out its "Not counted: … don't share money with apps" line (the
rows say it); its other lines stay.

| State | When | The row says |
|---|---|---|
| `number` | the place has a reported row in the period (YouTube; Facebook once `moneyVerified`; a reported $0 day counts as reported, §27.2), or Content Rewards' paid payouts by day were read to the end | "YouTube says" · "$12.40" · "YouTube's estimate" (Facebook: "Meta says" · "Meta's estimate"; Content Rewards: "Content Rewards says" · "$8.00" · "reached your balance in these 30 days · Content Rewards' numbers"). With `lastError`: + "Couldn't check today. Showing money up to Thu 14 Nov." |
| `not_available` | Instagram, TikTok and X, always (connected or not) | "Not available from TikTok" · "TikTok doesn't tell apps what you earn." · "Look in TikTok: Profile, then Balance." Instagram: "… Look in Instagram: Professional dashboard, then Payouts." X: "… Look on X: Monetization." + glass "Open X" (→ `https://x.com/settings/monetization`). Never a number, never $0 |
| `coming_soon` | Facebook while `moneyVerified` is `false` | "Coming soon" · "Clip Factory checks Facebook's numbers once before it shows them." · "Look in Meta Business Suite: Monetization." + glass "Open Meta Business Suite" (→ `https://business.facebook.com/latest/monetization`) |
| `not_set_up` | YouTube (or a verified Facebook) not connected; Content Rewards `not_connected` | "Not set up yet" · "Connect YouTube to see its money." + glass "Set up YouTube" (→ `/settings/posting/setup/youtube`); Content Rewards: "Connect Content Rewards to see its money." + glass "Set up Content Rewards" (→ `/settings/posting/setup/contentrewards`) |
| `needs_ok` | YouTube connected without the money scope | "YouTube needs your OK" · "Tap Allow money reading so YouTube shares your money with Clip Factory." + glass "Allow money reading" (→ `/settings/posting/money#money-youtube`) |
| `waiting` | connected and allowed, nothing reported in the period yet; a place `behind` (§27.3); Content Rewards `checking` or `none_yet` | "Waiting for the first numbers" · YouTube `not_yet`: "YouTube says you're not in its Partner Program yet." + glass "How close am I?" (→ `/settings/posting/money`); `in_program`/`earning`: "YouTube shows money 2–3 days after it's made."; `behind`: §27.3's sentence ("Facebook hasn't sent money since Tue 27 Oct."); Content Rewards `checking`: "Checking Content Rewards…"; `none_yet`: "No campaign money yet. It shows here when the brand approves your clips." |
| `error` | nothing stored for the period and the last check failed; Content Rewards `error` | "Couldn't check today" · "Clip Factory tries again tomorrow." (Content Rewards: "Content Rewards didn't answer. Try again in a few minutes.") |
| `sign_in` | Content Rewards `needs_reconnect` | "Sign in again" · "Sign in to Content Rewards again to see your money." + glass "Sign in again" (→ the setup page) |

Under a Content Rewards row in any state but `not_set_up`: one small line of §38.7's own numbers, each only when CR
reported it ("Still earning $4.20 · Ready to move $18.25 · On its way $0.00"), then "Content Rewards paid you $62.40
so far" ("Checking…" until the list was read to its end), then "Moved to Whop or your bank: not available from Content
Rewards. Look on Whop: Balances.", and the glass "See it all" (→ `#content-rewards`). None of these is in the total.
The owner's four words map to CR's: "earned so far" = the `paid` payouts ("The amount reached your balance", net of
all fees: §38.7's "paid you … so far"), "on its way" = `withdrawal_pending`, "ready to move" = `available`; "paid out"
(money that left the balance for Whop or the bank) is not in CR's API (no tool lists withdrawals), so it is "not
available", never worked out as paid minus balance.

**The period and the total.** One period for the whole card: the 30 days `[to − 29, to]` where `to` is the Monthly
card's `through` (§27.2) over every money place with no filter (YouTube, and Facebook once verified), so the YouTube row
equals the Monthly number when YouTube is the only money place; with no platform money stored, `to` is today (UTC) and
the line says "the last 30 days". Platform rows sum their `REVENUE#{platform}#{day}` rows in the period (as §27.2 does),
Content Rewards sums its paid payouts whose `paid_at` (UTC date; `created_at` when absent) falls in the period. The
total adds only `number` rows, **per currency** (CR reports `usd`; its cents become micros on the server, × 10,000, a
unit change, never a currency conversion), biggest first, and names the places in it. All arithmetic is on the server;
the web only formats (`noGuesses`, §27.9).

**Where each number comes from** (what each place's API gives an app about the owner's own money; checked 21 Nov 2026):

| Place | What its API gives | Shown as | Official source |
|---|---|---|---|
| YouTube | Analytics `estimatedRevenue` per day (USD by default; adjusted at month end), with the scope `yt-analytics-monetary.readonly` (§25.4) | `number`, "YouTube says", "YouTube's estimate" | https://developers.google.com/youtube/analytics/metrics (Revenue metrics); §25.3 |
| Facebook | Page insights `content_monetization_earnings` (§25.3), shown only once `config/monetization.json` `facebook.moneyVerified` is `true` (it is `false`) | `coming_soon`, later `number` "Meta says", "Meta's estimate" | https://developers.facebook.com/docs/graph-api/reference/insights; ADR-47 |
| Instagram | no money metric: user insights are reach, views, likes, comments, shares, saves, follows and audience only | `not_available`; where: `paidWhere` "Professional dashboard › Payouts" | https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights |
| TikTok | `GET /v2/user/info/` has follower, following, like and video counts (`user.info.stats`) and profile fields; no earnings, balance or Creator Rewards field | `not_available`; where: `paidWhere` "Profile › Balance" | https://developers.tiktok.com/doc/tiktok-api-v2-get-user-info |
| X | `GET /2/users/me` has no money field (`subscription_type`, `verified_followers_count`, … only). X's reference also lists a `MediaRevenue` object on media for the uploader (scope `media.library.read`) that Clip Factory doesn't read (§39.6) | `not_available`; where: `paidWhere` "X › Monetization" with its link | https://docs.x.com/x-api/users/get-my-user |
| Content Rewards | `get_my_balance` (`available`, `withdrawal_pending`, `as_of`) and `list_my_payouts` (`paid` net of all fees, `pending`, `reversed`; `paid_at`; integer cents, `usd`) through the owner's sign-in (§38.9); no tool lists withdrawals | `number` "Content Rewards says", "Content Rewards' numbers" | https://docs.contentrewards.com (`mcp-tools.json`, API version 2026-10-01) |

The where-to-look words come from `config/monetization.json` `paidWhere` (§25.2), never typed into code twice.

**API** (additive; `GET /v1/money` and `GET /v1/contentrewards/money` don't give per-place sums over one period, so one
small route): `GET /v1/money/everywhere` → `MoneyEverywhere`. Registers the owner like `GET /v1/money`; reads
`MONEYSTATE#`, `REVENUE#{p}#` (YouTube, Facebook), the Accounts, the config and, when `CONTENT_REWARDS=on`, `CRCONN` and
`CRMONEY`; never calls a platform or CR. `money/everywhere.py` `everywhere(cfg, accounts, states, rows, crconn, crmoney,
cr_on, today) -> MoneyEverywhere` is pure. Registered before `GET /v1/money/{platform}/days`.

```ts
type MoneyPlaceId = Platform | "contentrewards";
interface MoneyEverywhere {
  from: string; to: string; periodText: string /* "30 days up to Sat 16 Nov" */; lagNote?: string;
  places: MoneyPlace[];                                    // STATS_ORDER, then contentrewards when switched on
  totals: { currency: string; amountMicros: number; places: MoneyPlaceId[]; tag: string }[];  // biggest first
  notCounted: { place: MoneyPlaceId; state: MoneyPlace["state"] }[]; notCountedText?: string;
  asOf: string;
}
interface MoneyPlace {
  place: MoneyPlaceId; name: string;
  state: "number" | "not_available" | "coming_soon" | "not_set_up" | "needs_ok" | "waiting" | "error" | "sign_in";
  headline: string /* "YouTube says", "Not available from TikTok", … */; amounts: { currency: string; amountMicros: number }[];
  tag?: string; why?: string; note?: string; where?: { label: string; url?: string };
  button?: { label: string; href: string; external: boolean }; checkedAt?: string;
  cr?: { stillEarningCents: number | null; onItsWayCents: number | null; readyToMoveCents: number | null;
         paidSoFarCents: number | null; lastPaidAt?: string; asOf?: string; movedOut: "not_available" };
}
```

`amounts` is `[]` in every state but `number`. No response carries a token, a raw body or an internal field.

**Content Rewards paid by day** (G, in `contentrewards/money.py`, additive attributes on `CRMONEY`): each new paid row
the watermark read adds (§38.12 step 4) also adds its amount to `paidByDay["YYYY-MM-DD"]` (its `paid_at` UTC date).
Owners whose first read finished before this (`firstReadDone` and no `paidByDayDone`) get one day scan on the money
tick: `list_my_payouts {status: ["paid"]}` newest first to the end, at most 8 pages a tick, the cursor and the partial
`days` kept in `dayScan {status, cursor, mark, days, at}` (`mark` = `paidMark` when it began; rows newer than `mark`
are skipped, the watermark read counts those), written once at the end as `paidByDay` (merged with the rows added
since) and `paidByDayDone: true`. It never touches `paidTotalCents`, `paidByCampaign` or `payoutsSeen`. Until
`paidByDayDone` the Content Rewards row is `waiting` "Checking Content Rewards…". One entry per day with money (a year
of weekly rounds is about 52).

### 39.3 Does this clip fit the campaign? (the fit check)

**Where it runs** (ADR-63). One pure function in the API, `contentrewards/fit.py` (G), computed every time it is
asked, from stored items only (never CR, the public JSON or the network): `fit(clip, job, campaign, *, stops, places,
conn, posts, crsubs, others, source_kept, remake_on, now, captions=None, tiktok=None) -> CampaignFit`. Inputs: the
`CLIP#` item (duration, captions, checklist, `campaignId`, `remakes`, `remakeOf`), its `JOB#` (`source` with `url`,
`platform`, `channel`, `channelId`; `campaignId`; `campaign`; `sourceLanguage`), the `CAMPAIGN#` item (`rules`,
`uncertain`, `logo`, `platformsPaid`, state, membership), `stops` and `places` from A's `gates.stops` and
`gates.upload_places` (and `tiktok_waits`), `CRCONN` (`crLinked`, `stepsDone`, `canSubmit`, status), the clip's `POST#`
items and their `CRSUB#`, `others` (the campaigns of the clip's original and its other copies, for one campaign per
moment), `source_kept` (the remake can fetch the video), `remake_on` (`CR_REMAKE`), the time, and, at Confirm and in the
captions route, the request's captions and TikTok choices. `fit.for_clip(deps, user_id, clip_id, now) -> ClipFit` loads
them. The same function answers the Review card and clip page, refuses Confirm and Try again, and guards the remake
route. The web never decides a fit; it re-checks only the four items that change on the card while he types or taps
(`tags`, `ad`, `paid_switch`, `places`), with `lib/crFit.ts`, a port checked against G's golden cases.

**Which campaigns.** A campaign clip (`clip.campaignId ?? job.campaignId`, B's `campaign_clip`) is checked against its
own campaign only (one clip, one campaign). A normal clip is checked against every campaign he is in (`in` or
`manual`), newest `inSince` first, at most 10.

**The rules checked** (items in this order; `rule` keys and states are contract; the words are the server's):

| `rule` | How | States and words |
|---|---|---|
| `campaign` | the hard stops of `stops` (§38.4) except `deadline`, `logo_missing`, `no_place`, `tiktok_only` (own rows below) | `no` with the stop's text; fix `open` "Find another campaign" for the stops that send him elsewhere (`ended`, `budget_gone`, `drafts_first`, `sound_needed`, `cap_reached`, `not_accepted`), none for `waiting`, `held`, `paused` (they pass by themselves; the fit refreshes live). `todo` for what he can do: `not_checked` ("Connect Content Rewards" → setup page `?back=`), `not_joined`, `left` ("Open campaign"), `apply_first` ("Yes, I applied" on the card), `rules_failed` (→ the card's paste box). `check` for `rules_reading` "Reading the rules… Look again in a minute." |
| `soft` | soft stops (`budget_half`, `low_rate`, `face_needed`, `audience`, `not_connected`) | `note` with the stop's text (never asks for "Make clips anyway" here) |
| `deadline` | `rules.clipUntil` against today (UTC, like A's gates) | `ok` "Takes clips until 23 Nov." · `note` "Today is the last day FaZe Clips takes clips." · `no` "FaZe Clips stopped taking clips on 23 Nov." fix `open` "Find another campaign" |
| `length` | `clip.durationSec` against `lengthMinSec`/`lengthMaxSec` (a minimum learned from a `too_short` answer counts, §38.9) | `ok` "42 seconds. FaZe Clips takes 15 to 60." · `no` "This clip is 72 seconds. FaZe Clips takes 15 to 60 seconds." fix `new_clips`. No length rule: not listed |
| `places` | `places` (paid ∩ ready ∩ not `crLinked: false`, TikTok after its audit) | `ok` "Goes to YouTube and Instagram. FaZe Clips pays for both." · `todo` (no place yet, one can be set up) "Set up YouTube first. FaZe Clips pays for YouTube." fix `open` "Set up YouTube" · `no` for `tiktok_only` (its stop text) · `note` per paid place left out: "Instagram pays too. Set it up to earn there as well." (fix `open`), TikTok before its audit: §38.5's TikTok line |
| `place_link` | per place in `places`: `crLinked` absent and `ready-socials` not in `stepsDone`; per paid place left out as `crLinked: false` | `check` "I couldn't check that Content Rewards knows your YouTube account. Look under **Accounts** there." fix `open` "Open Content Rewards settings" · `note` "Content Rewards doesn't know your Instagram account. Add it there, then tap I linked it." (the "I linked it" of §38.5). Absent and the step done, or `true`: not listed |
| `tags` | every caption of every place in `places` (GET: `clip.captions`; the card: its text; Confirm: the request's) has each item of B's `campaign_caption.required_items(rules)` by B's own match (a whole `#`/`@` token, case-insensitive; a phrase with spaces folded; `_has`, made public as `has_item`) | `ok` "Every caption has #FaZe and @FaZeClan." · `fix` "The X words are missing #FaZe. I'll put it back." fix `captions` |
| `ad` | every caption passes B's disclosure-first rule (`_ad_first`, made public as `ad_first`: an `#ad`-like tag, or the brand's own one, in the first `DISCLOSURE_WINDOW` characters; YouTube: the description) | `ok` "#Ad is at the start of every caption." · `fix` "#Ad isn't at the start of the Instagram words." fix `captions` |
| `paid_switch` | per place: YouTube and X are turned on by the publisher (§38.14); TikTok needs Branded content in the card's TikTok choices (Confirm: `tiktok.brandContent`) | `ok` "Paid promotion goes on for YouTube and X." · `fix` "Branded content is off on TikTok." fix `tiktok_branded` · `note` Instagram and Facebook: "Instagram doesn't let apps turn on Paid partnership. #Ad and the words on the video tell viewers." |
| `logo` | `campaign.logo.needed`: the clip's checklist item `logo` passes | `ok` "The FaZe logo is on the whole clip." · `todo` (no ready logo on the campaign) "Add the FaZe logo on the campaign page first." fix `open` → the card · `remake` "The FaZe logo isn't on this clip." fix `remake` |
| `on_screen` | every campaign clip: the checklist item `disclosure` passes (a normal clip never has it) | `ok` "“Paid partnership” shows for the first 3 seconds." · `remake` "“Paid partnership” isn't on the video." fix `remake` |
| `source` | `job.source` against `rules.sourceVideos` and `allowedSources`: campaign footage by `links.normalize_post_url`; channels by the agent's own rule (`sources.from_allowed_channel`, ported to `fit.channel_matches` over `source.channel`/`channelId`, the same golden cases); the `youtube`/`twitch`/`kick` flags against `source.platform` when any is set | `ok` "From FaZe's YouTube." / "From a FaZe Clips video." · `no` "This video is from xQc. FaZe Clips only pays for clips from FaZe's channels." / "FaZe Clips only pays for clips of its own videos." fix `new_clips` · `check` (a video file, no channel known, or `allowedSources.notes`) "I couldn't check where this video is from. FaZe Clips wants clips from FaZe's channels. Look yourself." No source rule: `ok` "Any video is fine for FaZe Clips." |
| `language` | `rules.language` against `job.sourceLanguage` (BCP 47 from Transcribe, written by I) through one fixed table: English en, Spanish es, Portuguese pt, French fr, German de, Italian it, Japanese ja, Korean ko, Hindi hi, Arabic ar, Turkish tr, Russian ru | `ok` "In English." · `no` "This clip is in Spanish. FaZe Clips wants English." fix `new_clips` · `check` (no `sourceLanguage`, or a language not in the table) "I couldn't check the language. FaZe Clips wants English." |
| `banned` | `rules.bannedContent` not empty: a campaign clip's checklist item `campaign_rules` (the agent judged it against the rules, §38.13); a normal clip was never judged | `ok` "No swearing or gambling. Checked." · `no` the item's own note ("Shows gambling at 0:12.") fix `new_clips` · `check` (a normal clip, or the review never came back) "I couldn't check: no swearing or gambling. Look yourself." |
| `spoken` | `disclosure.spoken` | `note` §38.13's sentence |
| `uncertain` | each `campaign.uncertain` line (at most 5, then "and 3 more on the campaign page") | `check` "I couldn't check: {line}. Look yourself." Never shown as a pass |
| `brief_only` | `overlayRequired`, `coverImageRequired`, `layoutNotes`: rules Clip Factory doesn't carry out | `check` "I couldn't check: the brand's overlay. Clip Factory adds only the logo." / "I couldn't check: the brand's cover picture." / "I couldn't check: {layoutNotes}." |
| `posted` | a `posted` or `posting` Post of this clip with no `campaignId` (a normal clip already up) | `remake` "This clip is already up on YouTube. Content Rewards only takes a post sent in its first 30 minutes." fix `remake` (the copy is a new post) |
| `one_campaign` | another campaign owns this clip or its moment: `clip.campaignId`/`job.campaignId`, a Post or `CRSUB#` of the clip, `clip.remakes`, or (for a copy) its original's other copies name another campaign | `no` "This clip is for Valorant Clips. One clip can earn on one campaign only." fix `new_clips` |
| `send` | `CRCONN` connected with `canSubmit`, membership `in`, `idMatch` not `ambiguous` | `note` "After it posts, Clip Factory sends it to Content Rewards by itself." · else "After it posts, send its link to Content Rewards within 30 minutes. I'll remind you." |

A `remake` item becomes `no` "This video is gone from Clip Factory. Make new clips for this campaign." (fix `new_clips`)
when the source can't be fetched again (an upload past its 14 days, §7), and "Clip Factory can't add the logo to this
clip yet. Make new clips for this campaign." while `CR_REMAKE` is off.

**Verdict, upload and remake.** Any `no` → `doesnt_fit`; else any `remake`, `todo` or `fix` → `fixable`; else any
`check` → `cant_tell`; else `fits` (`note` and `ok` never change it). `canUpload` (the campaign way may go up now): no
`no`, `remake` or `todo`, and no `paid_switch` `fix` (TikTok must have Branded content; B refuses it otherwise); `tags`
and `ad` `fix` items may stay (the publisher repairs them, §38.14). `canRemake`: `CR_REMAKE` on, the source can be
fetched, and no `no` or `todo` among the items a copy can't change (`campaign`, `deadline`, `length`, `places`,
`source`, `language`, `one_campaign`, and `logo` while the campaign has no ready logo); a copy re-does `tags`, `ad`,
`logo`, `on_screen`, `banned` and `posted`.

| Verdict | Headline | Then | The screen's one vermilion |
|---|---|---|---|
| `fits` | "Can earn on FaZe Clips" (green, a check mark, never colour alone) | the `send` note; the `ok` items folded under "See what's right (7)" | Upload |
| `fixable`, only `fix` | "Almost ready for FaZe Clips" | the `fix` items, green "Fix it for me" | Upload (while Upload is off for TikTok's Branded content: "Fix it for me") |
| `fixable` with `remake` | "FaZe Clips needs a new copy of this clip" | the items | "Make it again for FaZe Clips" (Upload is off: "Make a copy for FaZe Clips first.") |
| `fixable` with `todo` | "One thing first for FaZe Clips" | the first `todo` item | its button (Upload is off, with the item's words) |
| `doesnt_fit` | "This clip can't earn on FaZe Clips" | the `no` items | "Make new clips for this campaign" (or the item's own "Find another campaign"); Upload is off: "This clip can't earn on FaZe Clips."; "Throw away" stays glass |
| `cant_tell` | "Probably OK for FaZe Clips" | "I couldn't check these. Look yourself:" and the `check` items | Upload |

Items show problems first (`no`, `todo`, `remake`, `fix`, `check`, `note`), then the `ok` ones folded. Each line is at
most one short sentence (§38.1); brand text in an item is plain escaped text (§38.1).

**The fixes** (one "Fix it for me" does every automatic one at once; an 8 s toast "Fixed: #Ad and #FaZe are back."
with Undo restores the card as it was):

| `fix.kind` | What happens | Who |
|---|---|---|
| `captions` | the web sends the card's current captions to `POST /v1/contentrewards/fit/captions`; the API runs B's `campaign_caption(platform, text, campaign_options(rules))` per platform (the disclosure first, every required item, inside each limit) and returns them; the card's caption text becomes that. The publisher does the same again at upload (§38.14) | automatic, one tap |
| `tiktok_branded` | the card applies D's `campaignTikTokChoices` (Everyone, Commercial content on, Branded content ticked); this tap is the owner's own action (§17.8) | automatic, one tap |
| places | the Upload to chips of a campaign clip only offer `uploadPlaces` (§38.5): a place the campaign doesn't pay for is never ticked, nothing to tap | automatic, no tap |
| `remake` | `POST /v1/contentrewards/campaigns/{campaignId}/remake {clipId}`: a new campaign clip of the same moment with the logo, "Paid partnership" on screen, #Ad and the tags; the card says "Making it for FaZe Clips… It shows here in about 3 minutes." and the copy arrives on Review by itself; the clip it came from stays as it is | automatic, one tap |
| `new_clips` | opens the campaign way, `/?campaign={uuid}&link={job.source.url}` for a link job (`/?campaign={uuid}` for a video file) | one tap, then "Make clips" |
| `open` | the item's page: the campaign card, a setup page, Content Rewards settings (new tab, `rel="noopener noreferrer"`) | the owner |

Length, source, language, banned content, the deadline and another campaign are never fixed on this clip: their fix is
`new_clips` (or "Find another campaign").

**Review card and clip page, campaign clips** (H, `screens/review/CampaignFit.tsx`, `data-help="cr-review-strip"`, also
`cr-fit`): the block replaces D's strip at the top of the card: "Campaign clip · **FaZe Clips**" (the name links to the
card), the verdict headline and its lines, the buttons of the table above. Upload follows `canUpload` after the web's
four live items; the screen keeps one vermilion. The clip page (`ClipPerformance.tsx`, `ClipFit.tsx`) shows the same
block while the clip waits in Review; after it posts, the §38.6 post lines take over.

**Normal clips: the "could earn" line** (H, `screens/review/FitSuggestion.tsx`, `data-help="cr-review-strip"`, also
`cr-fit-suggest`). `ClipFit.suggestion` is the first campaign whose fit has `canRemake` true and a `source` item `ok`
(the same creator or an allowed source, not just "can't tell"); null otherwise. Only then, and only while the clip
waits in Review, one quiet glass line sits under Checks before posting: "This clip could earn money on FaZe Clips." ·
"I'd make a copy with its logo, “Paid partnership” and #Ad. This one stays as it is." · glass "Make it for FaZe Clips"
· quiet "Not now" (hides it for that clip on this device: `localStorage["cf-cr-not-now"]`, at most 200 clip ids, every
read and write in try/catch). Upload stays the vermilion and the 2-tap upload is untouched. After the tap: "Making it
for FaZe Clips… It shows here in about 3 minutes."; when the copy is in Review: "The FaZe Clips copy is ready. Upload
one of the two." The clip page also has, closed by default and only when he is in a campaign, "Can it earn on your
campaigns?" with one line per campaign (its headline and first reason). With no campaign, CR switched off (503) or an
API before G (404), nothing shows: the card is origin/main's.

**Server side.** (1) **Confirm** (`POST /v1/clips/{clipId}/confirm`, B's `routes/clips.py`) for a campaign clip, after
B's §38.14 checks and only when `CONTENT_REWARDS=on`: the fit with the request's captions, places and TikTok choices;
any `no`, `remake` or `todo` → 409 `conflict` "This clip can't earn on FaZe Clips: {the first such item's words}"; the
same in `_try_again` (Try again, Post now). A clip without a campaign never calls the fit (Confirm unchanged). (2) The
**remake route** refuses with 409 and the first blocking item's words when `canRemake` is false, so the campaign way
can't be chosen for a clip that would not get paid. (3) `POST /v1/jobs` keeps A's §38.5 checks.

**The copy (remake).** `POST /v1/contentrewards/campaigns/{campaignId}/remake {clipId}` (G): 503 `unavailable` "Coming
soon." while `CR_REMAKE` is off; 404 for an unknown clip or campaign; 409 when `canRemake` is false; `200 { job }` when
`clip.remakes[campaignId]` already names a job that is not failed or deleted; else `202 { job }`: a new job made the way
`POST /v1/jobs` makes one (`routes/jobs.py` `start_job`, a pure refactor shared with `create`) with the original job's
`source` (a link: the same URL and `macFetch` as the original had, §35; a video file: the same upload while it is kept),
its `notes`, `clipTarget {min: 1, max: 1}`, `campaignId` (A's `contentrewards.jobs.prepare` runs: stops, the rules
snapshot, the logo copy), public `remakeOf {clipId, jobId}` and internal `remake {clipId, jobId, sourceStart,
sourceEnd, layout, momentType, hook, pickedFor}`; then `SET remakes.#c = {jobId, at}` on the original clip (the map
made first with a conditional `SET remakes = :m` when missing). Nothing else on the original changes. The agent (I),
for a job with `remake`: resolve as today (the channel check, the campaign logo), the words from
`jobs/{remake.jobId}/source/words.json` while they are kept (else transcribe as today), no analyze, watch or select:
one moment from `remake`, then cut, render with the campaign band, logo and disclosure (§38.13), captions with the
campaign's tags and #Ad, the full checklist (`campaign_rules` judged), and one Clip with `campaignId` and
`remakeOf: remake.clipId`. A job without `remake` is byte for byte today's. Every job also gets `sourceLanguage` (the
Transcribe `LanguageCode`, written once at transcribe; public).

**API** (G; under `/v1/contentrewards`, so §38.8's 404/503 rule hides everything on an older or switched-off API):

| Method & path | Body | 2xx response |
|---|---|---|
| GET `/v1/contentrewards/fit` | query `clipId`, or `clipIds` (≤ 20, comma-separated) | `ClipFit`, or `{ "clips": ClipFit[] }` (items only; `Cache-Control: no-store`) |
| POST `/v1/contentrewards/fit/captions` | `{ "clipId", "campaignId", "captions": Captions }` | `{ "captions": Captions }` (400 for a clip that isn't a campaign clip of that campaign or isn't in Review) |
| POST `/v1/contentrewards/campaigns/{campaignId}/remake` | `{ "clipId" }` | `202 { "job": Job }` new, `200 { "job" }` already made (above) |

```ts
type FitVerdict = "fits" | "fixable" | "doesnt_fit" | "cant_tell";
type FitState = "ok" | "fix" | "remake" | "todo" | "no" | "check" | "note";
type FitRule = "campaign" | "soft" | "deadline" | "length" | "places" | "place_link" | "tags" | "ad" | "paid_switch"
  | "logo" | "on_screen" | "source" | "language" | "banned" | "spoken" | "uncertain" | "brief_only" | "posted"
  | "one_campaign" | "send";
interface FitFix { kind: "captions" | "tiktok_branded" | "remake" | "new_clips" | "open"; label: string;
  href?: string; external?: boolean }
interface FitItem { rule: FitRule; state: FitState; text: string; fix: FitFix | null; platform?: Platform }
interface CampaignFit {
  campaignId: string; campaignName: string; verdict: FitVerdict; headline: string;
  canUpload: boolean; canRemake: boolean; items: FitItem[];            // problems first, then ok
  required: { disclosure: string; tokens: string[]; phrase: string | null };   // for the card's live check
  uploadPlaces: Platform[]; checkedAt: string;
}
interface ClipFit {
  clipId: string; mode: "campaign" | "normal"; fits: CampaignFit[];   // campaign: exactly one
  suggestion: { campaignId: string; name: string } | null;
  remakes: Record<string, { jobId: string; at: string }>;
}
```

`Job` gains public `remakeOf?: { clipId: string; jobId: string }` and `sourceLanguage?: string`; `Clip` gains public
`remakes?` (as above) and `remakeOf?: string`. `remake` on the job is internal (never returned).

**Live refresh.** No new live type. The web fetches the fit again (debounced 1 s) on any `contentrewards` event, a
`clip` event of this clip or of a clip whose `remakeOf` is it, a `post` event of this clip, and a `setup` event; caption
edits and TikTok taps re-run only the four live items locally.

**Data** (additive only: no new sort key, index, table, bucket, secret or Lambda; every write an UpdateItem of new
attributes):

| Item | New attributes |
|---|---|
| `JOB#{jobId}` | `remakeOf` (public, G), `remake` (internal, G), `sourceLanguage` (public, I) |
| `CLIP#{clipId}` | `remakes` (public map `campaignId → {jobId, at}`, G), `remakeOf` (public, I) |
| `CRMONEY` | `paidByDay` (map day → cents), `paidByDayDone`, `dayScan` (internal) (G) |
| api env | `CR_REMAKE` from Terraform `cr_remake_enabled` (bool, **default `false`**), an in-place env change; the plan replaces and deletes nothing that holds the owner's data |

### 39.4 Who builds what (after A `feature/cr-api` and D `feature/cr-web` have merged)

| Builder | Owns |
|---|---|
| G api | `api/src/clipfactory_api/contentrewards/fit.py` and `remake.py` (new), `contentrewards/money.py` (`paidByDay`, the day scan), `platforms/campaign_caption.py` (`has_item` and `ad_first`: public names for `_has` and `_ad_first`, behaviour unchanged), `routes/contentrewards.py` (the three §39.3 routes), `routes/__init__.py` (their rows and `GET /v1/money/everywhere`), `routes/clips.py` (the fit gate in `confirm` and `_try_again`), `routes/jobs.py` (`start_job`, a pure refactor), `jobs.py` (`remake` internal, `remakeOf` public), `clips.py` (`remakes` public), `money/everywhere.py` (new), `routes/money.py` (the route), `infra/modules/api/{main.tf, variables.tf, tests/api.tftest.hcl}` and `infra/envs/prod/{main.tf, variables.tf, tests/wiring.tftest.hcl}` (`cr_remake_enabled` only); tests `api/tests/test_cr_fit.py`, `test_cr_remake.py`, `test_money_everywhere.py` (new), `api/tests/cr_fit_cases.py` writing `api/tests/fixtures/{cr_fit_cases.json, cr_fit_live_cases.json, money_everywhere_cases.json}`, its updates to `test_cr_poll.py`, `test_campaign_posting.py`, `test_jobs.py`; and, last, the one-line PR `cr_remake_enabled = true` once G, H and I have merged |
| H web | `web/src/screens/home/{NewJobForm.tsx, CampaignsRow.tsx}`, `screens/review/{Review.tsx, CampaignStrip.tsx, CampaignFit.tsx (new), FitSuggestion.tsx (new)}`, `screens/clip/{ClipPerformance.tsx, ClipFit.tsx (new)}`, `screens/money/{AllMoney.tsx (new), MoneyDashboard.tsx}`, `screens/settings/setup/CrSetup.tsx`, `screens/campaigns/NextStep.tsx`, `setup/{contentrewards.ts, types.ts}` (the §39.1 words; `CrStep.doneLabel?`), `lib/{crFit.ts (new), contentRewards.ts}`, `api/{index.ts, types.ts}`, `api/mock/{fit.ts (new), moneyEverywhere.ts (new), contentrewards.ts, index.ts}`, `styles/contentrewards.css`, `docs/SETUP_POSTING.md` (only the words of its "## Content Rewards" section that name `CR_GUIDE` steps and buttons, so `setup-docs.test.ts` passes alone); tests `web/test/{crFit.test.ts, allMoney.test.tsx, twoWays.test.ts}` (new), `web/e2e/{two-ways.spec.ts, cr-fit.spec.ts, all-money.spec.ts}` (new), updates to `content-rewards.spec.ts`, `money-dashboard.spec.ts`, `review-card.spec.ts`, `screenshots.spec.ts` (`review-fit`, `money-all` at 375 and 1440), `noGuesses.test.ts`; the generated files (its `CR_GUIDE` words reach Ask's knowledge) |
| I agent | `agent/src/clipfactory_agent/pipeline.py` (the `remake` path, `sourceLanguage`), `store.py` (`remakeOf` on the clip, `sourceLanguage` on the job), `remake.py` (new: the one moment from `job.remake`); tests `agent/tests/test_remake.py` (new) and the byte-identical cases in `test_agent.py` |
| J docs and help | `web/src/features/help/{helpKb.json, helpEvals.json}`: new guides `cr-two-ways` "Normal clips or campaign clips?", `cr-fit` "Can this clip earn on my campaign?", `cr-fix-it` "What does Fix it for me do?", `cr-make-it-for` "Make a clip into a campaign clip", `money-everywhere` "How much did I earn everywhere?", `money-not-available` "Why does it say Not available from TikTok?", and the §39.1 words in `cr-setup` and `cr-make-clips`, one eval question each, highlighting only anchors already on main (`cr-review-strip`, `money-dash`, `cr-money`, `cr-setup-card`, `cr-connect`, `cr-make-clips`, `make-clips`, `use-my-settings`); `docs/{UX_DESIGN_SYSTEM.md, TESTING.md, AGENT.md, ARCHITECTURE.md, BUSINESS_REQUIREMENTS.md}`; the generated files. Merge it after H (its words describe H's buttons); its CI passes alone |

* **Shared contracts nobody changes alone**: the names list (§39.1); the three routes, `GET /v1/money/everywhere` and
  every type of §39.2–§39.3; the `rule` keys, states, verdicts and `fix.kind` values; the server-made words (H's mock
  copies them); `job.remake`, `remakeOf`, `remakes`, `sourceLanguage`, `paidByDay`; `CR_REMAKE`; the anchors
  `money-everywhere`, `cr-fit`, `cr-fit-suggest` (H adds them; the fit block and the line also keep
  `cr-review-strip`); the `?back=` rule; the golden case files (G writes them; H's vitest reads them when present).
* **Any order**: H hides the fit block (D's strip stays), the line and All your money while their routes answer 404
  (before G) and keeps every §38.8 404/503 rule. G's `remake` answers 503 and `canRemake` is false until the switch,
  which waits for I. Before I, `sourceLanguage` is absent and `language` says "I couldn't check"; before G, I's `remake`
  path is never used. Generated files: a PR that changes their sources runs `node web/scripts/help-corpus.mjs
  --write-docs` and `node web/scripts/ask-knowledge.mjs`; on a conflict take main's copy and run both again.
* No builder imports another's new code: H reads the API by its shapes, I reads `job.remake` from the job item, G reads
  `sourceLanguage` from the job item. A's and B's code (merged) may be imported by G.
* Commits end with the paragraph "Area: Content Rewards".

### 39.5 Tests (offline, fakes only; no AWS, no CR, no network)

* **Click counts (H, Playwright, mock mode, `web/e2e/two-ways.spec.ts`)**, at 375×812 and 1440×900, through one
  counting helper `tap()` (every click and key press that acts goes through it; a test fails as soon as the count is
  over):
  * **Normal way, frozen.** With the CR API absent (404), switched off (503) and on with two joined campaigns: Home at
    `/` has exactly the labelled controls of origin/main (`NORMAL_HOME_CONTROLS` in `web/e2e/flows.ts`: the Source
    bar's two options, the link box, Paste, Clear when it holds text, How many clips' two options, Number of clips
    only for an exact count, Notes, Make clips) and, inside the form, no element with a `cr-` anchor or class and no
    word "campaign" outside Notes' placeholder (D's campaigns row under the form is not part of it); Paste → "Make
    clips" → "Go to Review" → "Use my settings" → "Upload to N" uploads in exactly **5** taps, "Make clips" is enabled
    right after Paste and Upload right after Use my settings. The Review card of a normal clip with no fitting
    campaign has exactly origin/main's controls (`NORMAL_REVIEW_CONTROLS`); with a fitting campaign it has exactly two
    more optional controls ("Make it for FaZe Clips", "Not now") and the same 5 taps still upload without touching
    them.
  * **Campaign way**: 6 taps from the row chip (7 with "Fix it for me" for a clip with a missing tag).
  * **Connect**: from a pasted link with steps 1 and 2 already true for him, 8 taps (`asMacWindow({ crConnect: true })`,
    the pretend allow page counts 1); from zero, the Clip Factory taps of §39.1 (10) plus the pretend allow (1).
  * `web/test/twoWays.test.ts`: `NORMAL_WAY_TAPS = 5`, `CAMPAIGN_WAY_TAPS = 6`, `CONNECT_TAPS_DONE = 8`, the names list
    (no text in the help corpus's screen strings says "Content Rewards way", "normal mode" or "compatible").
* **web (H)**, Vitest: `lib/crFit.ts` against `cr_fit_live_cases.json` when present; every verdict's headline, lines and
  single vermilion; Upload on and off by `canUpload`; "Fix it for me" (the captions POST, Branded content, the Undo
  toast); the line only for `suggestion`, "Not now" with throwing storage; `AllMoney` for every state of every place,
  one total per currency, no amount on a `not_available` row, "Nothing to add up yet." with no total, the Notes card
  without its not-shared line; `noGuesses` over the new files (amounts only formatted). Playwright: the campaign way
  (strip, bar only with two campaigns, "Make normal clips instead" → `/`), the row chip, the setup words ("I have an
  account", "Add your accounts there", "I added them") and `?back=` → "Back to FaZe Clips", the fit block for each
  verdict, the copy arriving by a live event, the clip page fold, All your money; every new screen: no sideways scroll
  at 320–1920, no edges, targets ≥ 44 px (48 on phones), the arrow cursor only, axe contrast light and dark, reduced
  motion, phone controls bottom right, Ask never over the main button.
* **api (G)**, pytest: `cr_fit_cases.json` (each rule × state, the verdict, `canUpload`, `canRemake`), the channel match
  against the agent's cases, the normal-clip campaign list (in/manual, newest first, 10) and the suggestion (needs
  `source` `ok`), `GET fit` makes no CR, public or network call (its fakes have none), the captions route uses
  `campaign_caption`; Confirm and `_try_again`: each blocking state → 409 with its words, `tags`/`ad` `fix` allowed, a
  clip without a campaign never calls the fit and gets byte-identical posts; remake: 503 off, refusals, the job body
  (source, `macFetch`, notes, one clip, the snapshot and logo copy, `remake` never in `public_job`), `remakes` set by a
  conditional map write, the second call 200; `money_everywhere_cases.json` (each state per place, the period equal to
  the Monthly card's, totals per currency, CR cents → micros, never a $0 for not available); `paidByDay` from the
  watermark read and the one-time day scan (skips rows newer than its mark, writes once at the end, never changes
  `paidTotalCents`); `terraform test`: `cr_remake_enabled` default `false` → `CR_REMAKE = "off"`, `true` → `"on"`,
  nothing replaced.
* **agent (I)**: a `remake` job calls no analyze, watch or select, makes one moment from `remake`, reuses the kept words
  (and transcribes when they are gone), renders with the campaign marks, writes captions, the checklist and
  `remakeOf`; a job without `remake` keeps today's prompts and files byte for byte; `sourceLanguage` from Transcribe's
  `LanguageCode`.
* **docs (J)**: `help-corpus.mjs --check` (every highlight is a real anchor) and `ask-knowledge.mjs --check`.

### 39.6 Not verified live

That CR's API has no way to list the accounts added inside Content Rewards or to tell that an account exists (from
`mcp-tools.json` 2026-10-01; if a later version adds one, steps 1 and 2 tick themselves); whether signing in at
`id.contentrewards.com` with a new email makes an account (then step 1 could fold into step 3); how many questions
Content Rewards asks after sign-up; that `paid_at` is on every paid payout and is UTC; X's `MediaRevenue` on media (if
it answers for the owner, X could move from "not available" to a number in a later section); that Meta's earnings
metrics still answer (§25.8); whether a brand treats a re-made copy of a moment as a reused edit (Clip Factory allows a
moment on one campaign only, so this can only happen with a clip first posted normally), and whether YouTube treats the
copy and an earlier normal post of the same moment on one channel as reused content; the channel-name match (the
agent's rule can say "not from FaZe's channels" for an oddly named channel); the language table's coverage; that the
agent's `campaign_rules` judgment of banned content is right (a `no` blocks the campaign upload); the 3-minute copy
time.
