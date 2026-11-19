## 21. Earnings: what each clip probably made, per platform (owner request, 2026-11-16)

> **Retired by §25 (2026-11-18).** The guesses below are no longer shown anywhere. `earningsRates` and `earningsPaid`
> stay in Settings (accepted, never read) so no stored value is lost. Read §25 for money.

The owner's words: *"based on how ... the social media platform that I'm uploading to gives me money ... give me
data, for each video, on how much I earn ... have a fixed amount per whatever amount of views ... for each platform
and for each video."* Every amount is a **best guess** (views ÷ 1,000 × an amount per 1,000 views), never a payment,
and the screens say so. Amounts are US dollars. Where this section and an earlier one disagree, this one wins.

### 21.1 `config/earnings.json` (the one source of truth)

Read by the web (`web/src/lib/earnings.ts` imports it; `vite.config.ts` lets the dev server read `../config`). The API
does not ship it: `settings.MAX_USD_PER_1000` mirrors `maxUsdPer1000` and a pytest keeps them equal.

```ts
interface EarningsConfig {
  asOf: string;                 // "2026-11-16": the day the rates were checked
  currency: "USD"; maxUsdPer1000: number /* 100 */; order: Platform[] /* STATS_ORDER */;
  platforms: Record<Platform, {
    label: string;              // "YouTube Shorts", … (config only; screens use the short names, see §21.4)
    paysPerView: boolean;       // default of "Do I get paid here?": true for YouTube, Facebook, X (§21.1 below)
    lowUsdPer1000: number; typicalUsdPer1000: number; highUsdPer1000: number;
    unit: string;               // what the platform counts as a paid view
    minClipSeconds: number;     // 0 = any length; TikTok 60, Facebook 10
    tooShortNote: string;       // plain reason when the clip is shorter ("TikTok only pays for videos 1 minute or longer.")
    kidNote: string;            // under the switch
    kidRules: string; kidCounts: string;  // "Who gets paid" / "What counts" in the sources panel, plain words
    eligibility: string; unit: string; notes: string;  // full details for maintainers; never shown
    confidence: "low" | "medium" | "high";
    sources: { url: string; title: string; date: string }[];
  }>;
}
```
Values (checked 2026-11-16, owner in Sweden):

| Platform | paysPerView | low / typical / high per 1,000 | minClipSeconds | Confidence |
|---|---|---|---|---|
| YouTube Shorts | true (counts only in the Partner Program; 10M Shorts views per 90 days from Feb 2027) | 0.02 / **0.05** / 0.10 | 0 | medium |
| TikTok | false (Sweden not eligible; under 60 s never paid) | 0.40 / **0.70** / 1.20 | 60 | medium |
| Instagram (Reels) | false (invite-only bonus) | 0.01 / **0.02** / 0.05 | 0 | medium |
| Facebook Reels | true (counts only once invited; Sweden can join) | 0.01 / **0.05** / 0.30 | 10 | medium |
| X (Twitter) | true (counts only with Premium and a passed review; cross-posts excluded) | 0.02 / **0.12** / 0.29 | 0 | low |

**YouTube, Facebook and X start on; TikTok and Instagram start off.** The owner asked to see how much each clip earns
per platform, so the three apps whose programs a Swedish owner can be in show a best guess from the first view. Each
pays only inside its program, so wherever an app that is on is explained (the clip page's "How is this worked out?"
box and Settings › Money) it says plainly "This only counts if you are in {App}'s paid program." followed by its
`kidRules` (`paidProgramNote(platform)`). TikTok stays off because Sweden is not eligible for Creator Rewards and the
clips are under 60 s; Instagram stays off because its bonus is invite-only. An app that is off shows $0 with "Turn
this on in Settings › Money if {App} pays you." Every amount stays labelled "Best guess", and the usual rate is used
until the owner types their own. The `$comment` in `config/earnings.json` states this rule.

The owner's guess of "$0.5 per 1,000" on YouTube is long-form RPM; Shorts pay about a tenth of that.

### 21.2 API: Settings (`api/src/clipfactory_api/settings.py`, PUT `/v1/settings`)

```ts
interface Settings { /* … */
  earningsRates: Partial<Record<Platform, number>>;   // the owner's own USD per 1,000 views; default {}
  earningsPaid: Partial<Record<Platform, boolean>>;   // "Do I get paid here?"; default {}
}
```
* A platform that is **absent** uses the config default (`typicalUsdPer1000`, `paysPerView`), so a config change
  reaches every owner who never touched it. Old stored settings without the fields read as `{}`.
* PUT replaces each map whole (send the full map; leave a platform out to go back to the default). Keys are kept in
  `PLATFORMS` order.
* Validation (400 `bad_request`, plain sentence): map must be an object ("Money settings must list each app by
  name."); unknown platform ("Unknown platform: myspace."); a rate must be a finite JSON number (not a string, bool,
  null, NaN or Infinity: "Type the youtube amount as a number, like 0.05."), ≥ 0, ≤ 100, at most 2 decimals ("Use at
  most 2 numbers after the dot for youtube, like 0.05."); `earningsPaid` values must be booleans. A bad stored map
  falls back to `{}`.
* The mock API (`web/src/api/mock/index.ts`) applies the same checks and ordering.

### 21.3 Formulas (`web/src/lib/earnings.ts`, pure)

* `rateFor(platform, settings)` → `{ rate, yours, paid }`: the owner's rate when it is a valid number 0..100, else
  `typicalUsdPer1000`; `paid` from `earningsPaid`, else `paysPerView`.
* `earningFor(platform, views, durationSec, settings)` → `{ usd, why, reason, usdIfOn, … }`, first match wins. A
  missing view count makes `usd` null in every case, so a clip with no numbers never adds up to "$0.00":
  1. not paid → `usd 0`, `why "off"`, reason "Turn this on in Settings › Money if {App} pays you." (switch never
     touched) or "{App} does not pay you for views right now." (switched off by the owner); `usdIfOn` = what it would
     be (null when too short or no views);
  2. `minClipSeconds > 0` and `durationSec < minClipSeconds` (60 s itself is paid) → `usd 0`, `why "too_short"`,
     reason `tooShortNote`;
  3. views missing / not a finite number ≥ 0 → `usd null`, `why "no_views"` (never shown as $0);
  4. else `usd = views / 1000 × rate`, `why "paid"`. No rounding until display.
* `clipEarnings(views, durationSec, settings)` → `{ usd, platforms, reason }`: per platform in `order` for the
  platforms present in `views`; total = `sumUsd` (null when every amount is null); `reason` = `zeroReason` when the
  total is exactly 0: "These apps are switched off in Settings › Money." / "This clip is too short for these apps to
  pay." / "These apps don't pay for this clip." (empty when a paying app just had 0 views). `postViews(posts)` builds
  `views` from Library posts: `posted`, not `private`, via `paidViews`; null while the numbers are on the way.
* **Which views** (`paidViews(platform, metrics)`): the count each rate is based on. YouTube `extra.engagedViews`
  (no replays), Facebook `extra.initialPlays` (no replays), X `extra.impressions` (the X rate is per impression),
  TikTok and Instagram `views`. When the better number is missing it falls back to `metrics.views`, which counts
  replays, so the guess can be a little high; the "How is this worked out?" box says so. This week reads
  `WeekClip.paidViews` (built the same way by `weeks.week_clip` and the mock), falling back to `views` on an older
  server. The clip page counts only stacks with status `posted` and metrics.

### 21.4 Words (`formatUsd`, `formatRate`, `rateRange`, `earnedLine`, `parseRate`)

* `formatUsd`: `Intl.NumberFormat("en-US", USD, 2 decimals)`: `$0.00`, `$5.00`, `$1,234.57`; above 0 and under
  `0.01` → **"less than 1¢"**; null → "–"; negatives clamp to `$0.00`.
* `rateRange` → "$0.02 to $0.10" (words, never a dash). `moneyWords(usd)` → `{ about, amount }`: "about " only for
  amounts of 1¢ or more. `moneyPhrase(lead, usd)` / `earnedLine` → "Earned about $1.23", "Earned less than 1¢",
  "Earned $0.00", "No money yet". `sourceDate` → "Checked 16 Nov 2026", "10 Aug 2026", "Aug 2026", "2026".
* Screens use the short names (`APP_NAME`: YouTube, TikTok, Instagram, Facebook, X), never the config `label`.
* `parseRate(text)`: trims, drops a leading `$`, takes a comma as the dot ("0,05"), digits and one dot only; refuses
  with "Type an amount, like 0.05." / "Type only a number, like 0.05." / "Use at most 2 numbers after the dot, like
  0.05." / "That is too much. The most is 100 dollars."

### 21.5 Web

* **Settings › Posting › Money** `/settings/posting/money` (branch `money`, icon `coin`), apples: `money-how` (how the
  money is worked out, "Best guess" pill, "checked on 16 Nov 2026"); `money-paid` "Do I get paid here?" (one switch
  per app, `aria-label` "Do I get paid on {App}?", Yes/No word, the kid note under it, and for an app that is on the
  line `paidProgramNote` (`data-money-rule="{platform}"`); toast "{App} is on/off…");
  `money-rate` "Money for 1,000 views" (per app: "Usually $0.05 ($0.02 to $0.10)", a `$` box labelled "Your amount
  for 1,000 views on {App}", **Save** (`act="save"`, Enter works), **Use the usual** (`act="undo"`) when the owner's
  amount is set, error under the box with `role="alert"` and `aria-invalid`; toast "Saved. YouTube now uses $2.50 for
  1,000 views."); `money-sources` "Where the numbers come from" (per app, a Show/Hide button with `aria-expanded`:
  "Who gets paid" (`kidRules`) and "What counts" (`kidCounts`) in plain words, source links in a new tab, each at
  least 44 px tall, with `sourceDate` on its own line). Each app's mark sits on a dark round tile (`.money__tile`).
* **Clip page** (§16.8): in the total card, under the winner, "This clip earned about **$Y**" with a "Best guess" tag
  only when the total is above $0 (`data-help="clip-earned"`); an exact $0 shows "This clip earned $0.00" and the
  `zeroReason`; "No money yet" shows no tag. A "How is this worked out?" text button (`aria-expanded`) opens what is
  counted (no replays on YouTube and Facebook, every time the post was seen on X, replays while the better number is
  missing) and the amount used per app ("YouTube: $0.05 for 1,000 views (usual)" / "(your amount)" / "TikTok: off, so
  $0" / "TikTok: clip too short, so $0"; `data-how="{platform}"`), each with its mark on the same dark round tile as
  Settings › Money (`.money__tile`, `aria-hidden`, so X reads "X:" once), and under every app that is on its
  `paidProgramNote`; then a link button "Change it in Settings › Money". Each stack with numbers
  shows "Earned about $X" (or "Earned $0.00" plus the plain reason and, when off, "If {App} paid you, this would be
  about $X.", or "No money yet") above its sparkline (`data-earned="{platform}"`). Calm states show no money line.
* **Library** card (`EarnedChip`): "Earned about $X" with a visible "Best guess" tag, "Earned $0.00" with the
  `zeroReason` under it, or "No money yet", under the status pill when the clip has posted posts. **This week**: each
  card the same, and beside the count "This week earned about $Y" with the tag (or $0.00 with the reason;
  `data-earned="week"`). The sort, ranks and Best this week stars are unchanged.
* No cursor CSS; hover states only. Everything wraps at 320 px.

### 21.6 Help (Ask Clip Factory, §19)

Guides `clip-earnings` ("How much did my clip earn?", `/library`, actions Open Library and Open Money →
`money-rate`) and `money-rates` ("Change how much each app pays", `/settings/posting/money#money-rate`). The four Money
apples become apple docs by themselves. Evals: "How much did my clip earn?", "how much money did I make from my
video" → `clip-earnings`; "Where do I change how much YouTube pays me?" → `money-rates`.

### 21.7 Edge cases

Unposted, private, failed or waiting platforms: no amount. Missing views: null (not $0), even for an app that is off
or a clip that is too short. A clip with no numbers at all: "No money yet". Duration unknown: counted (no minimum applied). Switched off wins over too short. Totals add
unrounded amounts, so a total may differ from the sum of the shown cents by a cent or two.

### 21.8 Tests

* pytest `api/tests/test_settings_and_system.py`: defaults `{}`, saved and ordered, map replaced, valid edges
  (0, 0.01, 100), every refusal above, non-finite numbers 400, bad stored maps fall back, `MAX_USD_PER_1000` and
  config ranges/sources sane, and the `paysPerView` defaults (YouTube, Facebook, X true; TikTok, Instagram false).
* Vitest `web/test/earnings.test.ts`: config shape and values (the on/off defaults), `rateFor`, `paidProgramNote`,
  `earningFor` (rounding, min length, disabled platform, custom rate, missing views, precedence), `clipEarnings`, `sumUsd`, `postViews`, every format and
  `parseRate` case, `perfEarnings` (clip page) and `weekMoney` (This week). `settingsTree.test.ts` lists the branch.
* Playwright `web/e2e/earnings.spec.ts`: the clip page by default and with every app off (per-app and total, sum
  check, info toggle with the paid-program lines and the round mark tiles, link to Money),
  the Settings edit flow (refusals, save, switch, sources, effect on the clip page, Use the usual), Find a setting,
  Library and This week (order unchanged), and no overflow at 320/375/768/1440/1920. Screenshots
  `clip-earnings*.png` and `settings-money*.png` (phone and desktop, light and dark) in `screenshots.spec.ts`.
