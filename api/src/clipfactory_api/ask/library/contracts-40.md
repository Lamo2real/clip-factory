## 40. Get paid: set up payouts, see if you can get paid, and what reached your bank (owner request, 2026-11-21)

The owner's words: *"Does the application of Clip Factory show me exactly how much I get after or how much I earn in
real money based on content rewards based on the actual add sense in U2 and you know all of the other stuff for Meta
and Facebook and an Instagram and also if I connect it then how much X and also on TikTok does it show me that? Also,
can I have like a step just like we how we connected the platform social media platforms to Clip Factory can I have a
step where all these platforms? Also if they are enable if I've set them up that I can add my details on just so I can
get paid so for each of those platforms, I want the same system that we had for setting them up. I want that for
setting the payment up so I can get paid for each platform that goes for content rewards as well so I just want to be
a status check on factory where I can know that's OK it's live if I have connected to my card with my whatever payment
I'd like you or whatever payment that's the plat offers to pay me through on Clip Factory if I'm not connected anything
so I can't get paid even though I'm allowed to get paid then it should say disconnected or something like that but I
still after I've connected I want to know exactly how much I earn per platform and that includes content rewards, and
then I wanna know a total of my exact number that I've gotten into my bank account or accounts, but in total for each
of those platforms meaning content rewards meaning U2 TikTok, Instagram, Facebook and X, all of them"*. Decision
record: ADR-64.

**The honest answer to his question** (checked 21 Nov 2026 for an owner in Sweden; his bank part, §40.5, is option A,
Enable Banking, which he chose on 22 Nov 2026):

| Place | What he earned (§40.3) | Can money reach him? (§40.2) | Sent to his bank (§40.4) |
|---|---|---|---|
| YouTube | YouTube's estimate, as today (§25.3) | "YouTube says": AdSense for YouTube's account state, holds and payments (fresh reads only, §40.2), plus his ticks | Yes: every payment Google sent (AdSense `payments`) |
| TikTok | Not available from TikTok | his ticks only; Creator Rewards is not open in Sweden | Not available from TikTok |
| Instagram | Not available from Instagram | his ticks, plus Instagram's follower count | Not available from Instagram |
| Facebook | Coming soon (Meta's estimate waits for one live check, §40.3) | his ticks, plus Facebook's follower count | Not available from Meta |
| X | Not available from X | his ticks, plus X's Premium and verified-follower signals | Not available from X |
| Content Rewards | Content Rewards' numbers, as today (§39.2) | "Whop says" once Connect Whop works (ID check, payout method), plus his ticks | Whop's completed payouts once Connect Whop works (all his Whop money, Content Rewards too), else not available |

"Reached your bank" (money his bank booked) can only come from his bank. That part is §40.5 (Enable Banking, his
choice A, ADR-82), behind the switch `BANK_READING`; while it is off, every screen says "Clip Factory can't see your
bank. Look in your bank's app to see what arrived." Once it is on, every place can show what reached his bank, per currency
and in total: YouTube's and Content Rewards' deposits are matched to Google's and Whop's own payment records, and the
others once he taps to confirm who paid (once per payer; Stripe, PayPal and Payoneer each time, because they carry
money from more than one place).

**What this section adds, and what it leaves alone.** A **Get paid** area: one card per place (YouTube, TikTok,
Instagram, Facebook, X in `STATS_ORDER`, then Content Rewards while `CONTENT_REWARDS=on`), each with numbered step
cards that walk him to that place's own payout setup in time order, the way Set up posting walks him to each
platform's keys (§17.1); an honest status per place that says how it is known; "Sent to your bank" money where a
platform reports it; and the shape of the bank part. It is **not** part of Set up posting: the five setup cards, the
"**2 of 5 ready**" ring and the floating to-do list (§17.13: still exactly five rows) are unchanged, and no Get paid
tick is written to `SETUP#`. §25's rule stays: Clip Factory shows only money a platform, Content Rewards or Whop
reported (later: his bank), never calculated, guessed, converted or typed in; "Not available from X" instead of $0.
Clip Factory never asks for or stores bank details, card numbers or tax numbers: every payout is set up on the
platform's own pages (the bank part of §40.5 reads only booked credits, through BankID on his bank's own page). §38.7's Content Rewards money steps keep their words (plus two hints, §40.8 change 14) and their ticks (`CRCONN.stepsDone`); the
Content Rewards Get paid page shows them. The §38.1 screen rules apply to every new screen: kid-proof words (§12.4,
a 6–8-year-old), one vermilion button per screen, no `cursor:` rule, no edges, `<Glide>` for pick-one bars, reduced
motion, WCAG AA, phone controls at the bottom right. Data is additive only (§40.7); new tokens live in Secrets Manager
under `cf-prod/platforms/*`, created at runtime. Where this section and an earlier one disagree about payouts, this
one wins; each change to earlier words is listed in §40.8 as "§x: old → new".

**Facts it rests on** (official pages, checked 21 Nov 2026; `docs/SETUP_POSTING.md` "## Get paid" lists every source):

| Place | Who can earn, in Sweden | Where payouts are set up | What an app can read |
|---|---|---|---|
| YouTube | Partner Program, open in Sweden: 1,000 subscribers and 4,000 watch hours in 12 months or 10M Shorts views in 90 days; from 1 Feb 2027 new channels need 8,000 hours or 20M (support.google.com/youtube/answer/72851, /12843009). Non-original Shorts (others' content with nothing added) don't share revenue (/12504220) | YouTube Studio › **Earn** creates AdSense for YouTube (never the AdSense website); then in AdSense for YouTube › **Payments**: US tax info, ID check (about $10), PIN letter (3–4 weeks), bank (EFT in kronor from kr 70, test deposit), paid on the 21st–26th from kr 700 (/14727140, /14728151, /14728152, /7568896, /14727844) | AdSense Management API v2, scope `adsense.readonly`: account `state` (`READY`, `NEEDS_ATTENTION`, `CLOSED`), `alerts` (type `payment-hold`), `payments` (`youtube-unpaid`, `youtube-yyyy-MM-dd` = sent). No payment method, tax, ID or PIN endpoint (developers.google.com/adsense/management/reference/rest) |
| TikTok | Creator Rewards: **not** open in Sweden (US, UK, DE, JP, KR, FR, MX, BR only: tiktok.com/creator-academy/en/article/creator-rewards-program). LIVE Gifts and Video Gifts show in TikTok's Swedish help (an inference). TikTok Shop is not in Sweden | TikTok app › **Profile** › ☰ › **Balance**; Sweden: PayPal, bank or Payoneer (TikTok's "Payment limits and transaction fees" table); W-8BEN under the wallet's tax information | No scope for earnings, balance or payouts (developers.tiktok.com/doc/tiktok-api-scopes); `user.info.stats` gives follower counts |
| Instagram | Gifts (500 followers, 18+, professional account), Subscriptions (10,000), Bonuses (invite only), Badges; Sweden listed (facebook.com/help/instagram/738469380549477, /478012211024479) | One Meta payout account (shared with Facebook), only after $25 earned outside the US; bank sign-in, manual bank, PayPal or debit card, then tax info; lost after 6 months without one; paid around the 21st from $25, in USD (facebook.com/business/help/487364569891814, /194187525195870) | No money metric in Instagram insights; `followers_count` |
| Facebook | Content Monetization is invite only (Sweden listed); Stars (500 followers for 30 days); Subscriptions (5,000). In the EU a profile on no-ads or less-personalised ads can't earn from Content Monetization (/1049081556813520, /300444652164185, /1563729837497242) | The same Meta payout account; Meta Business Suite › **Monetization** | Page insights `content_monetization_earnings` and `monetization_approximate_earnings` (Meta's estimates, "in development", unit and currency not documented); no payout-account or payout-history endpoint; `followers_count` |
| X | Creator Revenue Sharing ended (Sep 2026). Original Content Rewards: a paid plan (Premium or higher; Basic doesn't count), 500 verified followers, 500,000 verified Home impressions in 90 days, an application; Sweden listed. **It excludes content "created or posted using automated means" and reuploaded or minimally modified clips** (help.x.com/en/using-x/original-content-rewards, archive copy of 19 Oct 2026) | Creator Studio (`https://x.com/i/jf/creators/studio`): connect a Stripe payout account and pass Stripe's ID check; paid every two weeks from $30 | No earnings or payout endpoint (api.x.com/2/openapi.json v2.175); `users/me`: `subscription_type`, `verified_followers_count` |
| Content Rewards | Yes (Sweden is a Whop payout country: docs.whop.com set-up-payouts) | Content Rewards **Earnings** › **Withdraw** to Whop (from $1, free) › Whop **Balances** › **Withdraw** › payout method; Whop checks ID and a selfie once (§38.7) | CR's MCP tools: balance and payouts (§38.9), no withdrawals. Whop's API with a user sign-in (OAuth 2.1 + PKCE, public client): `GET /payouts/methods`, `GET /users/me` (balance, ID check), `GET /payouts` (status `completed` = sent by Whop) (api.whop.com/api/v1/openapi.json). Not live-tested |

### 40.1 What the owner sees

**One name for each thing** (screens, help, docs, notifications; tests read this list):

| Thing | Words |
|---|---|
| The area | "Get paid" (Settings › Posting › Get paid; the card on Money) |
| A place that can pay him, by a signal | "Can get paid ✓ (YouTube says)" ("Whop says" for Content Rewards) |
| A place that can pay him, by his ticks | "Can get paid (you said it's done)" |
| A signal says a payout part is missing | "Not set up (YouTube says)" / "Not set up (Whop says)" (red) |
| He can earn, and his payout steps aren't ticked | "Not set up yet" (warn tone, not red) with the line "You can earn here. Do the payout steps so money can reach you." |
| The place isn't connected and nothing is ticked | "Clip Factory can't check" |
| Platform money Google or Whop sent | "Sent to your bank by Google" / "Sent to your bank by Whop" |
| Money his bank booked (§40.5) | "Reached your bank" |
| Clip Factory reading YouTube payments | "Allow payment reading" (button) / "Stop payment reading"; the chip "Clip Factory can see payments: on" / "off" |
| Clip Factory reading Whop payouts | "Connect Whop" (button) / "Stop reading Whop"; the paste box "Whop key" |
| His answer on a step Clip Factory can't see | "I did this", or the step's own words ("I'm in", "I turned it on", "I joined", "X said yes", "I have Premium") |
| Google's payout site | always "AdSense for YouTube" (first YouTube fact: "AdSense for YouTube is Google's page that pays you.") |

Never on a Get paid screen: "Live", "Active", "Verified ✓" or "Connected" for a payout (Clip Factory can't tell);
"Not connected" or "disconnected" (the owner uses "disconnected" for "can't get paid": say "Clip Factory can't check"
or "Not set up"); "KYC" (say "ID check"), "EFT" (say "bank transfer"), "OAuth", "token", "scope", "API", "Client ID"
as Clip Factory's own label (say "Whop key"), "tax treaty", "VAT" except inside Whop's own words, "payout account"
except inside Meta's own bold words, and "AdSense" alone (say "AdSense for YouTube"; the one button "Turn on AdSense
reading" and "the AdSense website" are the exceptions). Platform labels stay bold and word for word (**LIVE Gifts**,
**Payouts**); words from a help page nobody saw on screen are never bold.

**Where.**
1. **Settings › Posting › Get paid** `/settings/posting/getpaid`: a new branch of the Posting tree right after Set up
   posting (slug `getpaid`, name "Get paid", line "Set up how each app pays you. See if money can reach you.", icon
   `coin`; apple `getpaid` "Get paid", leaf "One card per place. Do the steps once so money can reach you.", words
   "get paid", "payout", "payouts", "bank", "bank account", "paypal", "stripe", "adsense", "whop", "tax", "money on
   hold", "withdraw", "cash out"). The page (`screens/getpaid/GetPaidList.tsx`, `data-help="getpaid-list"`): header
   "Get paid", the server's `summary` line, then six big glass cards (fewer while Content Rewards is off): mark, name,
   a progress ring over that place's numbered `earn` and `payout` steps (§40.2 `ring`), the status pill (§40.2) and
   one line; X's card adds its `warning`. No vermilion button on the list: each card is one big tap to its page.
   Under the cards, the glass card **Your bank**: while `BANK_READING` is off, the words "Clip Factory can't see your
   bank. Look in your bank's app to see what arrived." and no button; on, one big tap to the bank page (§40.5.2).
2. **A place page** `/settings/posting/getpaid/{place}` (route `{ name: "getpaid", place }`, matched like the setup
   pages; `place` is `youtube`, `tiktok`, `instagram`, `facebook`, `x` or `contentrewards`, the last only while Content
   Rewards answers; anything else is `not_found`). Top to bottom (`screens/getpaid/GetPaidPage.tsx`,
   `data-help="getpaid-place"`): the header (mark, name, ring, "About 15 minutes · Free" from the guide's `minutes` and
   `cost`, "Steps checked on 21 Nov 2026"); the **status block** (`data-help="getpaid-status"`: the pill, the line,
   `missing` and `holds` lines, the reading chip (`readingChip`, YouTube and, while `WHOP_CONNECT` is on, Content
   Rewards), X's `warning`, and `next` as below); **Can you earn here?** (the guide's facts for his country from
   `GET /v1/money`'s `country`, each short; one glass "Read YouTube's rules" per different official page; with no
   country picked: "Pick your country in Money settings to see its rules." with a glass "Pick my country"
   (→ `/settings/posting/money#money-country`) and the facts that hold everywhere); the **step cards** in time order;
   **What Clip Factory can see** (the server's `seen` lines); **Sent to your bank** (`data-help="getpaid-sent"`: the
   rows of §40.4); **When it's done** (glass "Check now" = `POST /v1/money/refresh` on YouTube and Content Rewards, the
   connection's own buttons of §40.6, and with `?back=` the back button).

   **The page's only vermilion is `next`** (§40.2). When `next.stepId` names a step, the vermilion is that step card's
   main action (its first Open, or its `action`), and on phones it is pinned at the bottom right from the moment the
   page opens (not only while its card is on screen); the status block then says `next.text` ("Next: step 3, Add
   your bank.") once, as words with no button. Only when `next.stepId` is `null` (a hold's fix or a reconnect, §40.2) does
   the status block hold the vermilion itself. When `next.vermilion` is `false` (X's `x-premium`, which costs money)
   or `next` is `null`, the page has no vermilion. Every other button on the page is glass: the Opens of steps that
   aren't next, done steps, §38.7's money steps ("Move your money to Whop" too) and the Whop card's "Save key" /
   "Connect Whop" (the vermilion only when `next` is `null` and Whop isn't connected). §38.7's own vermilion rules
   apply on `/money` only.
3. **Money** `/money`: a glass card **Get paid** (`screens/money/GetPaidCard.tsx`, `data-help="getpaid-card"`) right
   after All your money, before the Apps band: title "Get paid", line "Can money reach you from each place?", one row
   per place (mark, name, the pill), one glass button per row at its right end, each → the place page with
   `?back=/money`: "See steps" for `not_set_up`, `on_hold`, `not_started` and `not_connected`; "See why" for
   `not_allowed` and `checking`; "See more" for `can_get_paid` and `you_said_done`. No vermilion: the
   Content Rewards money part keeps its own (§38.7). All your money gains the "Sent to your bank" lines (§40.4).
4. Each platform's setup page (§17.1) gains, under its "When it's done" buttons, a glass "Get paid" link
   (→ `/settings/posting/getpaid/{platform}?back=/settings/posting/setup/{platform}`); Content Rewards' existing "Get
   paid" link goes to `/settings/posting/getpaid/contentrewards` (§40.8 change 9). Settings › Posting › Money's
   `money-payouts` apple links to the Get paid branch.
5. Never on the floating to-do list, never in "n of 5 ready", never a sixth platform.

**Getting there**: Settings › Posting › Get paid › a card: 4 taps; Money › a row's button: 2 taps (Money tab, the
button); a setup page's "Get paid" link: 1; Ask "how do I get paid on youtube": N's guide `getpaid-setup` and its
page action: 2.

**Step cards** are the §17.1 and §38.1 cards: number in a circle, an `Icon`, a title of six words or fewer, 1–4 short
lines (≤ 26 words each, one action per sentence), then only what the step needs: Open buttons (exact https page, new
tab / system browser, `rel="noopener noreferrer"`), Copy chips, "If you see X, do Y" hints, and the green answer
(≥ 48 px). Bold = the other site's exact label from the research of 21 Nov 2026. Where nobody saw the screen (Google's
tax form, TikTok's **LIVE rewards** screen, X's Stripe button, Whop's developer page) the step adds "{Site} may show
this a little differently. Look for the same words." **A step Clip Factory can see ticks itself and says how ("YouTube
says you're in"). A step it can't see shows the green answer; a signal that says otherwise beats the tick (§40.2).**
A `phone` step done in a phone app: on a computer it says "Do this in the TikTok app on your phone." and has **no**
Open button (the website doesn't have those screens); on a phone its Open keeps the https address
(`https://www.tiktok.com/`, `https://www.instagram.com/`), which opens the app. A step that waits for the platform has
a `when` line ("YouTube asks for this once you've earned about $10."). The first step not done is open and scrolled
into view; done steps fold to a green tick row that says who said so ("You said it's done" or "YouTube says"). The
`reading` step has "Optional" in its circle instead of a number, sits right after step 1, never counts in the ring
and is never `next` (except a reconnect, §40.2). Each-time steps ("Each time you get money") sit unnumbered under the
numbered ones.

```ts
// web/src/getpaid/types.ts (new; SetupGuide and CrGuide are unchanged)
export type GetPaidPlace = Platform | "contentrewards";
export type GetPaidRole = "earn" | "reading" | "payout" | "each_time";
export type GetPaidAuto = "in_program" | "payment_reading" | "sent" | "premium";
export interface GetPaidStep {
  id: string;                  // ^[a-z0-9-]{1,40}$, exactly the ids below (the server has the same list, §40.2)
  role: GetPaidRole;           // earn: he can earn there · payout: money can reach him · reading: Clip Factory can see
  icon: IconName; title: string; say: string[]; lead?: string; when?: string;
  open?: { label: string; url: string }; copy?: { label: string; value: string }[];
  ifYouSee?: { see: string; do: string }[];
  auto?: GetPaidAuto;          // also ticks itself (the server's steps[].by "auto")
  manual?: boolean;            // default true: the green answer (PATCH /v1/getpaid/steps)
  doneLabel?: string;          // the green answer's words; default "I did this"
  phone?: boolean;             // on a computer: "Do this in the {app} app on your phone." and no Open
  paid?: boolean;              // costs money (x-premium): never the vermilion, even when next
  action?: "allow_payment_reading";   // the step's main button is Clip Factory's own, not an Open
  shared?: "meta";             // meta-payout: one tick for Instagram and Facebook
}
export interface GetPaidFact { text: string; source: string /* https, the platform's own help host */;
  countries?: string[] /* default: every country */ }
export interface GetPaidGuide { place: Platform; name: string; checkedOn: "2026-11-21"; minutes: number;
  cost: "Free" | "X Premium costs money"; facts: GetPaidFact[]; steps: GetPaidStep[] }
```

A fact marked (SE) below has `countries: ["SE"]`; (EU) lists the EU and EEA codes of the country picker; the rest hold
everywhere.

Data files `web/src/getpaid/{youtube,tiktok,instagram,facebook,x}.ts` and `index.ts` (`GETPAID_GUIDES`,
`GETPAID_ORDER`), plain data like §17.2. Content Rewards has no new guide: its page shows `CR_GUIDE`'s parts `move`
and `bank` through `moneySteps()` (§38.7, words and ticks unchanged), plus the optional Whop card of §40.6.

**YouTube** (about 30 minutes over a few weeks, Free; the Mac for the optional reading step). Facts: "AdSense for
YouTube is Google's page that pays you." · "YouTube pays creators in Sweden through its Partner Program." · "To join:
1,000 subscribers, and 4,000 watch hours in 12 months or 10 million Shorts views in 90 days." · "From 1 Feb 2027, new
channels need 8,000 hours or 20 million Shorts views." · "YouTube doesn't pay for Shorts that only reuse other
people's videos." · "A Short over 1 minute with claimed content (often music) can't earn." · (SE) "YouTube pays in
kronor, straight to your bank. Not PayPal." · (SE) "It pays between the 21st and 26th once you have kr 700. Your bank
gets it up to 7 workdays later."

The payout steps follow YouTube's own money levels for Sweden (research Y14): the bank opens at kr 70, before the ID
and address checks at about $10, so the bank and its test payment come first and the PIN letter last.

| # | id | role | title | essentials |
|---|---|---|---|---|
| 1 | `yt-join` | earn | Join the Partner Program | `auto: in_program` ("YouTube says you're in", from `MONEYSTATE#youtube` `in_program`/`earning`); `doneLabel` "I'm in". Open "Open YouTube Studio" → `https://studio.youtube.com/channel/UC/monetization`. "Tap **Apply Now**, then **Start**." "Read the terms and tap **Accept**." "Tap **Start** on the AdSense card. Pick your Google account. Type your name and address." "YouTube checks your channel. It takes about a month." If you see: the Dashboard instead → "Tap **Earn** on the left."; **Get notified** → "You're not there yet. Tap it. YouTube emails you when you are."; **In Progress** → "Nothing to do. YouTube is checking."; not approved → "You can appeal within 21 days, or try again after 30 days."; the AdSense website asks you to sign up → "Go back. Make it from YouTube Studio, not the AdSense website." |
| Optional | `yt-reading` | reading | Let Clip Factory see payments | `auto: payment_reading`, `manual: false`, `action: allow_payment_reading`. `lead` "A grown-up does this once on the Mac. Then Clip Factory sees holds and payments." `when` "Do this after step 1 made your AdSense for YouTube." Open "Turn on AdSense reading" → `https://console.cloud.google.com/apis/library/adsense.googleapis.com`: "Check **Clip Factory** is picked at the top. Tap **Enable**." Open "Open Google's permissions page" → `https://console.cloud.google.com/auth/scopes`: "Tap **Add or remove scopes**." "Paste this in **Manually add scopes**:" Copy chip "Permission" `https://www.googleapis.com/auth/adsense.readonly`. "Tap **Add to table**, **Update**, then **Save**." Then "Tap Allow payment reading. Pick the Google account you use for AdSense for YouTube. It can be a different one." If you see: **Manage** instead of **Enable** → "It's on already."; **Google hasn't verified this app** → "Tap **Advanced**, then **Go to …**. It's your own app."; "That Google account has no AdSense for YouTube" → "Tap Allow payment reading again. Pick the Google account that has AdSense for YouTube. Still no luck? Skip this step. Your ticks still work." |
| 2 | `yt-tax` | payout | Add your US tax info | `auto: sent`. Open "Open AdSense for YouTube" → `https://adsense.google.com/`. "Tap **Payments**, then **Payments info**, then **Manage settings**." "Next to **United States tax info**, tap edit, then **Manage tax info**." "Fill in the form for people outside the US." "Without it, Google may keep up to 24% of your money." (Google may show this a little differently.) If you see: two payments accounts → "In **Payments account**, pick the one for YouTube."; a question about Sweden and US tax → "Pick Sweden. YouTube's help calls this money Other Copyright Royalties." |
| 3 | `yt-bank` | payout | Add your bank | `auto: sent`. `when` "YouTube lets you once you've earned kr 70." Open "Open AdSense for YouTube". "Tap **Payments**, then **Payments info**, then **Add payment method**." "Pick bank transfer. Type your bank details." "Tick **Set as primary payment method**. Tap **Save**." "Pick Swedish kronor. You can't change it later." If you see: PayPal → "Not offered in Sweden. Use your bank."; it's after the 20th → "Fine. Your first money may come a month later." |
| 4 | `yt-test` | payout | Confirm the tiny test payment | `auto: sent`. `when` "A tiny payment from Google arrives in 1 to 5 workdays." "Look in your bank's app for a tiny payment, a few kronor, from GOOGLE." Open "Open AdSense for YouTube". "Tap **Payments**, then **Payments info**, then **Manage payment methods**." "Tap **Verify now**. Type the amount. Tap **Verify**." If you see: nothing after 10 workdays → "Your bank details may be wrong. Fix them in **Payments info**."; a third try → "After 3 wrong tries you must ask AdSense for YouTube's help team." |
| 5 | `yt-id` | payout | Check your ID | `auto: sent`. `when` "YouTube asks once you've earned about $10." Open "Open AdSense for YouTube". "Tap **Payments**, then **Verification check**." "Send a photo of your passport, ID card or driving licence." "YouTube checks it in up to 2 days." If you see: "45 days" → "Send it in time, or YouTube stops your ads."; can't send it → "Sign in with the Google account that made AdSense for YouTube." |
| 6 | `yt-pin` | payout | Type the PIN from the letter | `auto: sent`. `when` "A letter comes by post 3 to 4 weeks after your ID check." Open "Open AdSense for YouTube". "Tap **Payments**, then **Verification check**." "Type the 6 numbers from the letter. Tap **Submit**." If you see: no letter after 4 weeks → "Ask for a new PIN on the same page."; a wrong-PIN warning → "Type it slowly. After 3 wrong tries YouTube stops your ads." |

Each time: nothing to do ("Google sends your money by itself. Clip Factory tells you when it does.").

**TikTok** (about 15 minutes, Free; phone). Facts: (SE) "Creator Rewards isn't open in Sweden. TikTok lists only the
US, UK, Germany, Japan, South Korea, France, Mexico and Brazil." · "Video Gifts and LIVE Gifts may work in Sweden.
Look in TikTok Studio." · "Gifts need you to be 18 or older and a Personal account, not Business." · "LIVE needs 1,000
followers." · "TikTok counts in dollars. Each payout costs a small fee." · (SE) "TikTok pays to PayPal, your bank or
Payoneer." · "TikTok may ask for a US tax form the first time you take money out. Without it, TikTok may keep up to
30% of US money." · (SE) "TikTok Shop isn't in Sweden."

| # | id | role | title | essentials |
|---|---|---|---|---|
| 1 | `tt-gifts` | earn | Turn on Gifts | `phone`, `doneLabel` "I turned it on". Open "Open TikTok" → `https://www.tiktok.com/`. "Tap **Profile**, then the menu ☰, then **TikTok Studio**." "Tap **Video Gifts**, then **Turn on Gifts**." "For LIVE: in the LIVE screen tap **Settings** and turn on **LIVE Gifts**." If you see: no **Video Gifts** → "Gifts aren't open for you yet. Look again in a month."; a Business account → "Switch back to Personal. Business accounts can't get Gifts." |
| 2 | `tt-payout` | payout | Add where TikTok pays you | `phone`. Open "Open TikTok". "Tap **Profile**, the menu ☰, then **Balance**." "Tap **LIVE rewards**. Set up how you get paid." "Pick PayPal, your bank or Payoneer. PayPal takes 1.5%. A bank costs $3 each time." (TikTok may show this a little differently.) If you see: "not available in your region" → "TikTok doesn't pay out there yet."; "linked in more than 2 countries" → "Keep your payment ways in one country." |
| – | `tt-withdraw` | each_time | Move money to your bank | `phone`. "Tap **Profile**, ☰, **Balance**, then **LIVE rewards**." "Withdraw to your PayPal, bank or Payoneer." "See what went out: **Balance**, then **Transactions**, then **Withdrawal**." If you see: TikTok asks for a tax form → "Tap **Tax information**. Fill in the form for people outside the US (W-8BEN)." |

There is no numbered tax step: TikTok shows **Tax information** only at the first withdrawal, so a numbered step
could not be done when it is asked for.

**Instagram** (about 15 minutes, Free; phone). Facts: "Gifts: 500 followers, 18 or older, a professional account." ·
"Subscriptions: 10,000 followers." · "Bonuses: only when Instagram invites you." · "Meta pays around the 21st once you
have $25. It pays in dollars. Your bank changes it to kronor." · "Until you tell Meta where to pay you, you can earn
up to $500 per money tool. Wait more than 6 months and the money is lost."

| # | id | role | title | essentials |
|---|---|---|---|---|
| 1 | `ig-gifts` | earn | Turn on Gifts | `phone`, `doneLabel` "I turned it on". Open "Open Instagram" → `https://www.instagram.com/`. "Tap **Profile**, then **Professional dashboard**." "Under **Your tools**, tap **Gifts**." "Tap **Get started** and accept." If you see: no **Professional dashboard** → "Switch to a professional account first: **Settings**, **Account type and tools**."; no **Gifts** → "You need 500 followers and a professional account." |
| 2 | `meta-payout` | payout | Tell Meta where to pay you | `phone`, `shared: meta`. `lead` "Did this on Facebook already? It's the same one. Tap I did this." `when` "Meta lets you once you've earned $25." Open "Open Instagram". "Tap **Profile**, **Professional dashboard**, then **Payouts**." "Tap **Get Started**. Type your legal name, birthday and country. Tap **Next**." "For business type pick **Individual**. Tap **Next**." "Tap **Sign into your bank** and use BankID. Or pick another way." "Tap **Link payout method**." "Tap **Add tax info**, sign, tap **Submit form**, then **Done**." "Meta may show this a little differently. Look for the same words." If you see: **Get Started** right after you accept Gifts → "Do it there. It's this step."; "minimum earnings" → "Come back when you have $25."; **Add later** → "Fine, but don't wait 6 months, or Meta keeps the money."; changing it later → "Meta holds your money for 5 days after a change." |

Each time: nothing to do ("Meta sends your money around the 21st by itself.").

**Facebook** (about 15 minutes, Free; a computer is easiest). Facts: "Content Monetization: only when Meta invites you.
Sweden is on its list." · "Stars: 500 followers for 30 days in a row." · "Subscriptions: 5,000 followers." · (EU)
"Paying for no ads, or picking less personal ads, stops a profile from earning with Content Monetization." · "Meta
pays around the 21st once you have $25, in dollars."

| # | id | role | title | essentials |
|---|---|---|---|---|
| 1 | `fb-join` | earn | Join a Facebook money tool | `doneLabel` "I joined". Open "Open Meta Business Suite" → `https://business.facebook.com/latest/monetization`. "Tap **Monetization**, then **Status**, then **View Page eligibility**." "A **Set up** button means you can join. Tap it and accept." "Invited to Content Monetization? Tap **Content monetization**, then **Sign up**." On a phone: "Creator Dashboard, then **Monetization**. It says **Ready to set up** or **Not yet eligible**." If you see: no **Monetization** → "Tap **All tools**, then **Monetization**."; **Not yet eligible** → "Meta invites creators. Tell Meta you'd like it:" + Open "Open Meta's form" → `https://creators.facebook.com/content-monetization-interest-form`. |
| 2 | `meta-payout` | payout | Tell Meta where to pay you | the same step as Instagram's (one tick for both, not `phone` here); Open "Open Meta Business Suite" → `https://business.facebook.com/`: "Tap **All tools**, then **Payouts**." then the same lines from **Get Started** and the same "Meta may show this a little differently." line; "In Content Monetization's sign-up this is **Payout details**, then **Complete setup**." |

**X** (about 15 minutes; X's paid plan costs money). Facts: "X's rules leave out posts made or posted by automated
means, and reuploaded or barely changed clips." · "Creator Revenue Sharing ended in September 2026." · "Original Content Rewards needs a paid plan (not Basic), 500 verified followers and 500,000 views
from verified people in 90 days." · "Then X reviews you." · "X pays every two weeks once you have $30, through
Stripe."

X's `warning` ("X doesn't pay for posts an app made or posted, or clips copied from other sites. Your Clip Factory
clips probably won't earn on X.") shows in the status block, above the steps.

| # | id | role | title | essentials |
|---|---|---|---|---|
| 1 | `x-premium` | earn | Get X Premium | `auto: premium` ("X says you have Premium", from `MONEYSTATE#x.numbers.premium`); `doneLabel` "I have Premium"; `paid: true` (never the vermilion). First line: "X probably won't pay for Clip Factory clips. Only buy Premium if you also post your own videos." Open "Open X" → `https://x.com/`. "Tap **Premium** in the menu." "Pick any paid plan except **Basic**." |
| 2 | `x-apply` | earn | Apply for Original Content Rewards | `doneLabel` "X said yes". Open "Open Creator Studio" → `https://x.com/i/jf/creators/studio`. "Tap **Original Content Rewards**." "Apply. X checks your account." "Tap X said yes when X lets you in." If you see: not accepted → "You can ask once more. Or apply again after 42 days."; money paused for a past rule break → "Accounts that are paused can't join." |
| 3 | `x-stripe` | payout | Connect Stripe for payouts | Open "Open Creator Studio". "Connect Stripe so X can pay you." "Stripe checks your ID once. Have it ready." "Add your bank in Stripe." (X may show this a little differently. Look for **Stripe**.) If you see: you did this for Revenue Sharing → "You don't need to do it again. Tap I did this." |

Each time: nothing to do ("X's help says Stripe sends money to your bank in 3 to 5 workdays. It can take longer.");
"See what Stripe sent:" Open "Open Stripe" → `https://connect.stripe.com/express_login`.

**Content Rewards** (§38.7's steps; their only change is two "If you see" hints on `bank-setup`, §40.8 change 14):
the Finance question first ("Do you see **Finance** in the Content Rewards menu?", the `<Glide>` bar), then the
numbered once steps for his answer: "No" → 1 `move-whop` Link your Whop account, 2 `bank-setup` Add your bank on
Whop; "Yes" → 1 `fin-setup` Set up payouts. Each time (unnumbered): `move-withdraw` Move money to Whop, then
`bank-cashout` or `fin-bank`. Ticks and autos stay on `CRCONN` (`PATCH /v1/contentrewards/connection`). On this page
all of §38.7's buttons are glass unless one is `next` (§40.1 item 2). Facts: "Content Rewards sends your money to
Whop. Whop sends it to your bank." · "Moving to Whop is free from $1." · "Whop checks your ID and a selfie once." ·
"Whop to your bank takes up to 5 workdays." The two new `bank-setup` hints: "You see **Set up Whop Payments**?" →
"Tap it. Pick Sweden."; "Whop asks about tax for a business (VAT)?" → "Tap **Settings**, then **Tax**, then **No, my
business is not registered**. Don't type your personal number." (Whop may pause payouts from 1 Dec 2026 until this is
answered.) Then the optional card **See your Whop payouts here** (`id: whop`, `data-help="getpaid-whop"`, §40.6).

**Taps** (one-time, from the place page, counted like §39.1; a typed field is not a tap; "about" = a form whose fields
vary; CF = Clip Factory's own taps):

| Place | Steps and taps | Total (CF) |
|---|---|---|
| YouTube | 1 Open YouTube Studio · **Apply Now** · **Start** · **Accept** · **Start** · Google account · **Submit** · back = 8 (CF 1; it ticks itself once YouTube says you're in, else "I'm in" +1) · Optional: Open "Turn on AdSense reading" · **Enable** · Open the permissions page · **Add or remove scopes** · Copy chip · paste · **Add to table** · **Update** · **Save** · back · "Allow payment reading" · Google account · **Advanced** · **Go to …** · tick · **Continue** = 16 (CF 4; it comes back by itself) · 2 Open · **Payments** · **Payments info** · **Manage settings** · edit · **Manage tax info** · the tax form (about 8) · **Submit** · back · "I did this" = 17 (CF 2) · 3 Open · **Payments** · **Payments info** · **Add payment method** · bank transfer · **Set as primary payment method** · Swedish kronor · **Save** · back · "I did this" = 10 (CF 2) · 4 Open · **Payments** · **Payments info** · **Manage payment methods** · **Verify now** · **Verify** · back · "I did this" = 8 (CF 2) · 5 Open · **Payments** · **Verification check** · the ID photo (2) · send · back · "I did this" = 8 (CF 2) · 6 Open · **Payments** · **Verification check** · **Submit** · back · "I did this" = 6 (CF 2) | **73** (CF 15) over about 5 sittings (apply; once AdSense for YouTube lets you add a bank: the reading step, tax and bank; the test payment 1–5 workdays later; the ID check at about $10; the PIN 3–4 weeks after that). The five "I did this" are optional: Google's first payment ticks steps 2–6 → 68 (CF 10). Without the optional reading step: −16 (CF −4). Already in the Partner Program: −8 (CF −1) |
| TikTok | 1 Open TikTok · **Profile** · ☰ · **TikTok Studio** · **Video Gifts** · **Turn on Gifts** · back · "I turned it on" = 8 (CF 2) · 2 Open · **Profile** · ☰ · **Balance** · **LIVE rewards** · set up · PayPal · PayPal sign-in (2) · back · "I did this" = 11 (CF 2) | **19** (CF 4); each withdrawal 7; the first one about 7 more if TikTok asks for the tax form (**Tax information** · the form (about 5) · **Submit**) |
| Instagram | 1 Open Instagram · **Profile** · **Professional dashboard** · **Gifts** · **Get started** · accept · back · "I turned it on" = 8 (CF 2) · 2 Open · **Profile** · **Professional dashboard** · **Payouts** · **Get Started** · **Next** · **Individual** · **Next** · **Sign into your bank** · bank and BankID (3) · **Link payout method** · **Add tax info** · **Submit form** · **Done** · back · "I did this" = 18 (CF 2) | **26** (CF 4) |
| Facebook | 1 Open Meta Business Suite · **Monetization** · **Status** · **View Page eligibility** · **Set up** · accept · back · "I joined" = 8 (CF 2) · 2 Open · **All tools** · **Payouts** · **Get Started** … **Done** as Instagram (12) · back · "I did this" = 17 (CF 2); 0 when done on Instagram | **25** (CF 4); **8** (CF 2) after Instagram |
| X | 1 Open X · **Premium** · a paid plan · pay (about 3) · back = 7 (CF 1; ticks itself when X says Premium) · 2 Open Creator Studio · **Original Content Rewards** · apply · confirm · back · "X said yes" = 6 (CF 2) · 3 Open Creator Studio · Stripe · email and code (2) · the ID check (about 3) · bank · back · "I did this" = 10 (CF 2) | **23** (CF 5) |
| Content Rewards | "No" on the Finance bar (CF 1) · 1 Open Content Rewards settings · **Open Whop** · sign in · allow · back · "I did this" = 6 (CF 2) · 2 Open Whop · **Dashboard** · **Balances** · **Payout methods** · **Add payout method** · confirm · ID and selfie (about 3) · back · "I did this" = 11 (CF 2). With **Finance**: "Yes" (CF 1) · Open Content Rewards · **Finance** · the four tasks (about 9) · **Continue on Whop** · back · "I did this" = 14 (CF 2) | **18** (CF 5); **15** (CF 3) with Finance; about 5 more only if Whop asks (**Set up Whop Payments** · Sweden; **Settings** · **Tax** · **No, my business is not registered**); each payout 12 (§38.2) |
| Connect Whop (optional, Content Rewards page) | Open Whop's developer page · **Create app** · Copy chip "Clip Factory" · paste · **OAuth** · Copy chip (redirect) · paste · the four ticks (4) · **Save** · copy the **Client ID** · back · paste in "Whop key" · "Save key" · "Connect Whop" · Whop's allow (comes back by itself) | **18** (CF 6: Open, two Copy chips, the paste, "Save key", "Connect Whop"); about 2 more if Whop asks for a company first |

Each tap above is the move to the next screen, a fact only he knows, or the platform's own button; the only ones Clip
Factory could save are the "I did this" answers, and only YouTube's (Google's first payment proves them). The fewest
for a case like the owner's (YouTube already in the Partner Program, with the reading step; Instagram, then Facebook;
Content Rewards without Finance; no TikTok, because Creator Rewards isn't open in Sweden, and no X, because X probably
won't pay for Clip Factory clips): 65 + 26 + 8 + 18 = **117** taps, 25 of them Clip Factory's, spread over weeks
because each platform makes him wait (review, letter, test payment, the first $25). With TikTok's Gifts and X too:
117 + 19 + 23 = **159** (CF 34); Connect Whop adds 18 (CF 6).

### 40.2 The status per place: honest, and how it is known

**Fresh or not.** `getpaid/status.py` uses a `PAYSTATE#{place}` (account state, holds, saved methods, ID check) only
when all three are true: `PAYCONN#{source}.status` is `connected`, `firstReadDone` is set, and `lastCheckedAt` is
within 48 hours. Otherwise the `PAYSTATE#` is ignored (after "Stop payment reading", after a dead token, or when reads
keep failing): no hold, no "no hold", no account state and no Whop status come from it. Sent `PAYOUT#` rows still
tick the YouTube payout steps, labelled with the date ("Google sent you money on 23 Oct"), because they are records of
real money, not of today's state. "YouTube says there's no hold" is only ever said from a fresh `PAYSTATE#`.

**Statuses** (`GetPaidStatus`; pill words fixed; never colour alone: each pill has its icon and words; tones are
`success`, `neutral`, `warn` and `error` at AA contrast, never the vermilion of a button):

| `status` | Pill (tone) | Line (server-made) | When |
|---|---|---|---|
| `on_hold` | "Payment on hold (YouTube says)" / "(Whop says)" (error) | YouTube: "Google is holding your money. Tap Open AdSense for YouTube to see why." (Google's own words, plain text ≤ 300 characters, under **Show more**); Whop: "Whop says your ID check didn't pass." · "Whop says your bank details don't work." · "Whop says your last payout didn't go through." | a hold signal in a fresh `PAYSTATE#` (below). Beats every other status |
| `not_allowed` | "Not allowed yet (YouTube says)" / "(Instagram's rules)" / "(X's rules)" (neutral) | YouTube, from §25's goals: "YouTube needs 1,000 subscribers. YouTube says you have 812. Clip Factory tells you when you get there."; every goal reached: "You reached YouTube's goals. Apply in YouTube Studio. YouTube checks it." · Instagram: "Gifts needs 500 followers. Instagram says you have 312. Clip Factory tells you when you get there." · X: "Original Content Rewards needs 500 verified followers. X says you have 120. Clip Factory tells you when you get there." | YouTube's own `not_yet` (beats his ticks, `knownBy "youtube"`); or a stored count below a published rule and no tick on the step that rule gates (`ig-gifts`, `x-apply`; `knownBy "rules"`, `known` "Instagram's rules" / "X's rules") |
| `can_get_paid` | "Can get paid ✓ (YouTube says)" / "(Whop says)" (success) | YouTube: "YouTube says there's no hold. Google sent you money on 23 Oct." · Whop: "Whop says your ID check is done and a bank is saved." | YouTube: a fresh `PAYSTATE#youtube` with every account `READY`, no hold, and a sent payment. Content Rewards: a fresh `PAYSTATE#contentrewards` with the ID check `approved`, a saved method `created` or `active` whose `bank_verification_state` is not `pending` or `failed`, and Content Rewards linked to Whop (`move-whop` ticked or `whop_linked`, or `fin-setup` ticked); not linked → `not_set_up` from ticks, Next "Link your Whop account" |
| `not_set_up` (from a signal) | "Not set up (YouTube says)" / "(Whop says)" (error) | AdSense `NEEDS_ATTENTION`: "YouTube says your AdSense for YouTube needs you. Open it and do what it asks." · `CLOSED`: "YouTube says your AdSense for YouTube is closed. Make a new one from YouTube Studio." · Whop, no saved method: "Whop says it has nowhere to send your money. Next: Add your bank on Whop." · Whop, ID check `not_started`: "Whop says your ID check isn't started. Next: Add your bank on Whop." | a fresh signal says a payout part is missing |
| `checking` | "Checking…" / "Checking… (Whop says)" (neutral) | "Checking YouTube payments… This can take until tomorrow." / "Checking your Whop payouts… This can take until tomorrow." · Whop's ID check `pending`: "Whop is checking your ID. Nothing to do. It can take a day or two." | a payment-reading connection is `connected`, its first read hasn't finished, `connectedAt` is under 26 hours ago and there is no `lastError`; or a fresh Whop ID check is `pending` (`knownBy "whop"`) |
| `not_set_up` (from ticks) | "Not set up yet" (warn, not red) | "You can earn here. Do the payout steps so money can reach you. Next: {the step's title}." then that step's `when` line when it has one ("Meta lets you once you've earned $25.") | he can earn (a signal, or every numbered `earn` step done) and a numbered `payout` step isn't done; `knownBy "you"`, `known` "Your steps" |
| `you_said_done` | "Can get paid (you said it's done)" (success, outline icon, no ✓) | "You said every step is done. {Platform} doesn't tell Clip Factory, so it can't check." · YouTube with a fresh read and no hold: "You said every step is done. YouTube says there's no hold. Clip Factory knows for sure after Google's first payment." · YouTube when a sent payment ticked the payout steps but the read isn't fresh: pill "Can get paid (Google sent money on 23 Oct)", line "Google sent you money on 23 Oct. Clip Factory last checked YouTube payments on 3 Dec." (or "… can't see YouTube payments now." with no `lastCheckedAt`) | every numbered `earn` **and** `payout` step done (ticks or autos) and no fresh signal against it |
| `not_connected` | "Clip Factory can't check" (neutral) | "Clip Factory can't check anything for TikTok. You can still do the steps." | the place isn't connected to Clip Factory (its Account; Content Rewards: `CRCONN`), has no tick and no payment-reading connection |
| `not_started` | "Not started" (neutral) | "Do the steps so {Platform} can pay you. Already did them? Tap I did this on each step." · only `payout` steps done: "You said {Platform} knows where to pay you. Next: {the first `earn` step's title}." (Meta places: "You said Meta knows where to pay you. Next: Turn on Gifts." / "… Next: Join a Facebook money tool.") · TikTok in a `not_open` country with `tt-gifts` not ticked: "Creator Rewards isn't open in Sweden. Gifts might be. Next: Turn on Gifts." (`knownBy "rules"`, `known` "TikTok's rules for Sweden") | anything else |

The first row that applies wins, in the table's order: on hold › not allowed yet › can get paid ✓ › not set up (from a
signal) › checking › not set up yet (from ticks) › can get paid (you said it's done) › Clip Factory can't check › not
started. "Live" is never shown: with no signal and no tick the place is `not_started`, `not_connected` or `checking`.
A tick is step state, never money (§38.1), and is always labelled "you said". A signal always beats a tick. One
shared `meta-payout` tick never makes a Meta place `you_said_done` on its own: that place's `earn` step must be done
too. After 26 hours without a first read, or with a `lastError`, the place is no longer `checking`: its status comes
from his ticks and `seen` says "Clip Factory couldn't check YouTube payments yet. It tries again tomorrow." (Whop: "…
your Whop payouts …").

**`next`, the one next step** (`GetPaidCard.next`; on the place page it is the only vermilion, §40.1 item 2):
1. `on_hold` or `not_set_up` from a signal: the hold's fix, `HOLD_FIX` below.
2. `not_allowed` with a goal not reached: `null` (no vermilion; the line ends "Clip Factory tells you when you get
   there.", and §25's goal celebration tells him). Every goal reached: `yt-join`.
3. Otherwise the first numbered step not done (`earn` steps, then `payout` steps, in the guide's order).
4. Otherwise, when a payment-reading connection is `needs_reconnect`: `{stepId: null, label: "Allow payment reading"}`
   (YouTube) or `"Connect Whop"` (Content Rewards).
5. Otherwise `null`.

`next.text` is the words for the next step ("Next: step 3, Add your bank."; a `null` step id has none). Every "Next:
{title}" in a line above is written exactly as `next.text`, with the step's number, so the list card and the Money
card say it too; the status block shows `next.text` under the line only when the line doesn't already end with it.
`next.hint` carries `HOLD_FIX`'s text. `next.vermilion` is `false` for a `paid` step (`x-premium`). `yt-reading` is never `next` except as the reconnect of item 4.

**`HOLD_FIX`** (`getpaid/status.py`; each a `next` with `stepId: null` and one Open, unless it names a step):

| Case | `next` |
|---|---|
| YouTube `payment-hold` or `NEEDS_ATTENTION` | the first `payout` step not done; if none, Open "Open AdSense for YouTube" → `https://adsense.google.com/`, text "Look for the red message on **Payments**. Do what it says." |
| YouTube `CLOSED` | Open "Open YouTube Studio" → `https://studio.youtube.com/`, text "Make a new AdSense for YouTube from **Earn**." |
| Whop ID check `rejected` | Open "Open Whop" → `https://whop.com/`, text "Tap **Balances**. Do the ID check again." |
| Whop every method `broken`, or the last payout didn't go through | `bank-setup`'s Open (`fin-setup`'s with Finance), text "Check your bank on **Payout methods**." |
| Whop no saved method, or ID check `not_started` | the step `bank-setup` (`fin-setup` with Finance) |

**What each place really gives** (the signals; everything else is his ticks):

| Place | Signals Clip Factory reads (stored items only; §40.7 says who writes them) | Hold | Can get paid (signal) | Can earn (signal) | Not allowed (signal or rule) |
|---|---|---|---|---|---|
| YouTube | `MONEYSTATE#youtube` (§25: `in_program`, `earning`, `not_yet` and its goals); after Allow payment reading, `PAYSTATE#youtube` (AdSense account `state` and `pendingTasks`, `alerts`, `youtube-unpaid`), used only when fresh, and `PAYOUT#youtube#…` (each `youtube-yyyy-MM-dd` payment) | a fresh alert of type `payment-hold` | fresh, every account `READY`, no hold, and a sent payment | `in_program` or `earning` | `not_yet` (403 `forbidden`, §25.1): YouTube's own answer, beats his ticks |
| TikTok | the Account; `MONEYSTATE#tiktok.numbers.followers` (with `user.info.stats`); `MONEYPREFS.country` with `config/monetization.json`'s `tiktok-rewards` countries | – | – | – | never: a `not_open` country gives `not_started` with the Creator Rewards line (Gifts might be open) |
| Instagram | the Account; `MONEYSTATE#instagram.numbers.followers` | – | – | – | followers < 500 and `ig-gifts` isn't ticked ("Instagram's rules") |
| Facebook | the Account; `MONEYSTATE#facebook.numbers.followers` (shown in `seen` only: Meta invites, so no rule says no) | – | – | – | never |
| X | the Account; `MONEYSTATE#x.numbers` `premium` (true for `Premium`, `PremiumPlus` and `PremiumBusiness`; `None` and the newer plans X's field doesn't know become "X didn't share this.", §40.8 change 13, so the field never says no) and `verifiedFollowers` | – | – | – | verified followers < 500 and `x-apply` isn't ticked ("X's rules") |
| Content Rewards | `CRCONN` (status, `stepsDone`, `finance`), `CRMONEY` (§38.7); after Connect Whop, `PAYSTATE#contentrewards` (ID check from `GET /users/me` `verification.individual`, saved methods from `GET /payouts/methods`), used only when fresh, and `PAYOUT#contentrewards#…` | ID check `rejected`; every saved method `broken`; or the newest payout `failed`, `denied` or `reversed` within 30 days with no newer `completed` (a `canceled` one is often his own and is never a hold) | ID check `approved`, a saved method `created` or `active` not `pending`/`failed` in `bank_verification_state`, and Content Rewards linked to Whop | CR reported money: paid so far, ready to move, still earning or on its way above 0 | never |

**Steps and autos the server knows** (`getpaid/status.py` `STEPS`, the same ids and roles as §40.1; K writes them to
`api/tests/fixtures/getpaid_steps.json`, M's test reads it when present):

| Place | `earn` | `reading` | `payout` | Autos |
|---|---|---|---|---|
| YouTube | `yt-join` | `yt-reading` | `yt-tax`, `yt-bank`, `yt-test`, `yt-id`, `yt-pin` | `yt-join` ← `in_program`/`earning`; `yt-reading` ← `PAYCONN#adsense` connected; the five payout steps ← any sent payment ("Google sent you money on 23 Oct, so this is done") |
| TikTok | `tt-gifts` | – | `tt-payout` | – |
| Instagram | `ig-gifts` | – | `meta-payout` | – |
| Facebook | `fb-join` | – | `meta-payout` | – |
| X | `x-premium`, `x-apply` (he can earn once both are done) | – | `x-stripe` | `x-premium` ← `premium` true |
| Content Rewards | CR money above 0 (no step) | – | Finance "no": `move-whop`, `bank-setup`; "yes": `fin-setup`; no answer yet: not done (next: "Answer: do you see Finance?") | §38.3's (`whop_linked` ticks `move-whop`) |

`tt-withdraw` and §38.7's each-time steps are `each_time`: never counted in a ring or a status. **The ring counts only
the numbered `earn` and `payout` steps** done (ticks or autos) over all of them; `yt-reading` is shown as the status
block's chip `readingChip` ("Clip Factory can see payments: on" / "off"; Content Rewards while `WHOP_CONNECT` is on:
"Clip Factory can see Whop payouts: on" / "off"), never in the ring.

**What Clip Factory can see** (`seen`, server-made, at most 6 lines, shown on the place page):
* YouTube (fresh lines only from a fresh `PAYSTATE#youtube`): "YouTube says you're in the Partner Program." / "… you're
  not in the Partner Program yet." · "YouTube says your AdSense for YouTube is ready." / "… needs you. Open AdSense for
  YouTube." / "… is closed." · "YouTube says there's no hold on your money." · "Waiting to be paid: SEK 512.30
  (YouTube says). Google pays when it's kr 700 or more." (the second sentence only when the unpaid amount's currency
  was read; otherwise the (SE) fact "It pays between the 21st and 26th once you have kr 700.") · "Last money sent:
  kr 1 234,56 SEK on 23 Oct (YouTube says)." · not fresh: "Clip Factory last checked YouTube payments on 3 Dec." ·
  no first read after 26 hours, or `lastError`: "Clip Factory couldn't check YouTube payments yet. It tries again
  tomorrow." · with no payment reading: "Clip Factory can't see YouTube payments yet. Tap Allow payment reading." ·
  always: "YouTube doesn't tell apps about your bank, tax or ID. Tap I did this when they're done."
* TikTok: "TikTok says you have 2,310 followers." · "TikTok doesn't tell apps about Gifts or payouts."
* Instagram: "Instagram says you have 312 followers." · "Meta doesn't tell apps how it pays you."
* Facebook: "Facebook says your Page has 1,040 followers." · "Meta doesn't tell apps if you joined or how it pays
  you."
* X: "X says you have Premium." (only when true) · "X says you have 120 verified followers." · "X doesn't tell apps if
  you're in Original Content Rewards or set up Stripe."
* Content Rewards: "Content Rewards says $18.25 is ready to move to Whop." · fresh only: "Whop says your ID check is
  done." / "… is waiting." / "… didn't pass." / "… isn't started." · "Whop says a bank is saved." / "… your bank
  details don't work." · "You have a business on Whop. Clip Factory reads only your own Whop money, not the
  business's." (when `GET /users/me` lists owned businesses) · not fresh: "Clip Factory last checked Whop on 3 Dec."
  · without Whop: "Clip Factory can't see Whop. Connect Whop to see your payouts here."

The followers and Premium lines come from the §25 daily reads already stored; Get paid makes no platform call of its
own for them.

**Summary** (`GetPaid.summary`, ≤ 30 words, sentences in this order, each only when it has names; names joined "A, B
and C" in the places' order):
1. One sentence per `can_get_paid` place, naming who said it: "YouTube says it can pay you." / "Whop says Content
   Rewards can pay you."
2. "You said {names} {is/are} done." for `you_said_done` (a YouTube card whose payout steps were ticked by a sent
   payment: "Google paid you before.").
3. "{names} need(s) you." for `not_set_up` and `on_hold`.
4. With none of 1–3: "Nothing is set up yet. Start with {the first `not_started` place}."; with no `not_started`
   place either: "Nothing to do here yet. Clip Factory tells you when a place opens."

Example: "YouTube says it can pay you. You said TikTok is done. Instagram needs you."

### 40.3 What he earned, per place (§39.2, unchanged numbers; additive fields only)

* **YouTube**: YouTube's estimate (`estimatedRevenue`, §25.3), as today.
* **Facebook**: stays `coming_soon` ("Clip Factory can't show Facebook money yet."). The research found the metrics are
  still marked "in development", their unit and currency are not documented, and they cover Pages only, not
  professional-mode profiles, so `moneyVerified` stays `false`. The one live check that would flip it (a grown-up, not
  built here): read one day of `monetization_approximate_earnings` (period `day`) for his Page and compare it with Meta
  Business Suite › Insights › Earnings for the same day; if they match, a one-line PR sets `moneyVerified: true` and
  records the unit in §25.3.
* **Instagram, TikTok, X**: `not_available`, "Not available from {Platform}" with the where line. X's where line
  follows the config fix below: "Look in X, then Creator Studio (paid through Stripe)." + "Open X"
  (→ `https://x.com/i/jf/creators/studio`).
* **Content Rewards**: Content Rewards' numbers, as today.
* **No typed-in money**, for any place, ever: ADR-64 keeps §25's rule. Instagram, TikTok, X and Facebook show "Not
  available" with where to look; what really reached his bank comes from the bank part (§40.5).

**Config facts fixed** (K, `config/monetization.json`, `asOf` → `2026-11-21`; the goals keep their ids, so stored
celebrations stay):
1. X `programme` "Creator Revenue Sharing" → "Original Content Rewards"; `statusWhere` {"X › Monetization",
   `https://x.com/settings/monetization`} → {"X › Creator Studio", `https://x.com/i/jf/creators/studio`}; `paidWhere`
   {"X › Monetization (paid through Stripe)", same old url} → {"X › Creator Studio (paid through Stripe)",
   `https://x.com/i/jf/creators/studio`}; the three X goals' `source` →
   `https://help.x.com/en/using-x/original-content-rewards`.
2. TikTok `tiktok-rewards` `countries` `["US","GB","DE","FR","ES","IT","NL","SE","IE","BR"]` → `["US","GB","DE","FR",
   "BR"]` (TikTok's list; JP and KR keep their own rule; MX is not in the picker), so for Sweden the TikTok money card
   says "Creator Rewards is not open in your country. Check its rules in the TikTok app." (`not_open`, §25.2);
   `statusWhere` "Creator tools › Creator Rewards" → "TikTok Studio › Monetization"; goal sources →
   `https://www.tiktok.com/creator-academy/en/article/creator-rewards-program`.
3. YouTube's 2027 rule (`ypp-2027` goals and "Keep 10M Shorts views in 90 days") `source` →
   `https://support.google.com/youtube/answer/12843009` (the numbers are on that page, not on 72851).

### 40.4 Money sent toward his bank, per place and in total

**The words.** A payment a platform reports as sent is "Sent to your bank by Google" or "Sent to your bank by
Whop", tagged "YouTube says" or "Whop says". It is never "Reached your bank", "received" or "in your bank": Google's
`payments` date is "the date that the payment was credited" on Google's side, and Whop's `completed` means "Funds sent
by Whop, awaiting bank processing". "Reached your bank" is only ever a bank-booked credit (§40.5). Every line says
when it should arrive: Google "Your bank gets it up to 7 workdays after Google sends it."; Whop "Whop says it should
arrive by {estimated_arrival}." (or "within 5 workdays" without one).

**YouTube** (rows `PAYOUT#youtube#{yyyy-mm-dd}#{the last 4 of the publisher id}`, written by L from AdSense
`payments.list`; the suffix keeps two AdSense accounts that pay on the same day apart):
* Each `accounts/{a}/payments/youtube-yyyy-MM-dd` is one sent payment, keyed by that date and account;
  `youtube-unpaid` is the current balance (`PAYSTATE#youtube.unpaid`, shown "Waiting to be paid", never in a total); the plain `unpaid` and
  `yyyy-MM-dd` ones are AdSense website money and are ignored.
* `Payment.amount` is a formatted string with its currency ("¥1,235 JPY", "$1,234.57", "£87.65"). L stores it as Google
  wrote it (`amountText`); K's `getpaid/sent.py` `parse_amount(text) -> (micros | None, currency | None)` reads it on
  every view: the currency is a 3-letter ISO code in the text, else only the unambiguous symbols € EUR, £ GBP, ₹ INR;
  "kr", "$", "¥" alone are ambiguous (SEK, NOK, DKK; USD, CAD, AUD; JPY, CNY) and are **not guessed**; the number takes
  spaces, no-break spaces, apostrophes, "." and "," as separators: with both "." and ",", the last one is the decimal
  mark; with one kind, it is the decimal mark only when exactly 1 or 2 digits follow it at the end. Golden cases
  (`getpaid_sent_cases.json`): "kr 1 234,56 SEK", "SEK 1,234.56", "1 234,56 kr" (unread), "$1,234.57" (unread),
  "€87.65", "£87.65", "¥1,235 JPY", "1.234,56 €". A row whose amount or currency can't be read is shown as Google wrote
  it, never added up: "1 payment isn't added up: Clip Factory couldn't tell its money type." When **every** sent row
  is unread, the line is still `state: "number"` with `amounts: []` and `notAdded` "Google sent 3 payments. Clip
  Factory couldn't tell their money type, so they aren't added up." plus a glass "See them"
  (→ `/settings/posting/getpaid/youtube`); never "Nothing sent to your bank yet."
* A changed amount sets `revisedAt` (the new amount counts). A payment Google no longer lists keeps its row with
  `goneAt` ("Google no longer lists this payment.") and stops counting. A returned EFT (a closed bank account) is
  credited back by Google (§40.8 Not verified live: whether it leaves the list).
* The YouTube page adds: "Google pays between the 21st and 26th." and, from the threshold table, "… when you have kr
  700 or more." (SEK kr 700, EUR €70, USD $100; only when the unpaid balance's currency was read and is one of these;
  otherwise the threshold sentence is dropped and the (SE) fact shows instead).

**Content Rewards** (rows `PAYOUT#contentrewards#{created yyyy-mm-dd}#{payoutId}`, written by L from Whop
`GET /payouts?user_id=…`, only while Connect Whop is connected):
* Whop's status → `state`: `completed` → `sent` (counted); `requested`, `in_review`, `processing` → `on_its_way`
  ("On its way: $40.00 (Whop says)", not counted); `failed`, `canceled`, `denied` → `didnt_go_through` ("Didn't go
  through. Whop puts it back in your balance.", not counted); `reversed` → `came_back` ("Came back from the bank.",
  stops counting).
* The amount is Whop's own: `destination_amount` in `destination_currency` when both are there (what Whop sent to the
  bank, after Whop's fees and any conversion Whop made), else `net_amount` in `currency`; decimals become micros on
  write (× 1,000,000 by `Decimal`, a unit change); currencies upper-cased. `traceCode` is kept for §40.5 and never
  shown or sent to the web.
* Always: "Whop counts all your Whop money, not only Content Rewards." (Whop pays out his whole balance; Clip Factory
  can't tell which part came from Content Rewards.)
* Without Connect Whop: "Sent to your bank: not available from Content Rewards. Look on Whop: **Balances**." (§39.2's
  words) and, while `WHOP_CONNECT` is on, the glass "Connect Whop" (→ `/settings/posting/getpaid/contentrewards#whop`).

**The other places** (`not_available`, no amount, never $0):
* TikTok: "Not available from TikTok. Look in TikTok: Profile, then Balance, then Transactions, then Withdrawal."
* Instagram: "Not available from Instagram. Look in Instagram: Professional dashboard, then Payouts. Meta also emails
  you each month."
* Facebook: "Not available from Meta. Look in Meta Business Suite: All tools, then Payouts. Meta also emails you each
  month."
* X: "Not available from X. Look in Stripe: Payouts." + glass "Open Stripe" (→
  `https://connect.stripe.com/express_login`).
* YouTube without payment reading: "Clip Factory can't see YouTube payments yet." + glass "Allow payment reading"
  (→ `/settings/posting/getpaid/youtube#yt-reading`).

**Where it shows.**
* **All your money** (§39.2): under each row, in any state, one small grey line from the row's `sent` ("Sent to your
  bank by Google: kr 2 468,00 so far · YouTube says" or the place's not-available line); Content Rewards' "Paid out to
  your bank" line is replaced by it. Under the 30-day total, a block **"Sent to your bank, so far"**: one line per
  currency, in the places' order (the order of the first place in each line; amounts in different currencies are
  never ranked against each other), each with the server's `names` ("kr 2 468,00 · YouTube", "$210.00 · Whop (all
  your Whop money, Content Rewards too)"), the tag "Google and Whop say they sent it.", "Different money, like dollars
  and kronor, is never added together.", the block's `notAdded` when some rows couldn't be read ("Google sent 3
  payments. Clip Factory couldn't tell their money type, so they aren't added up."), "Not in this: TikTok, Instagram,
  Facebook and X (not available)." and the bank line "Clip Factory can't see your bank. Look in your bank's app to see
  what arrived."; only with no sent rows at all: "Nothing sent to your bank yet." and no total. It is never added to
  the 30-day total (a different thing over a different time).
* **The place page**: the rows, newest first (at most 36): date, amount (formatted by the web, or Google's own text),
  state words, "by Google"/"by Whop", the arrive line on the newest.
* **Not on the Money Get paid card**, which shows status only (one job per card).

All sums are on the server, per currency, never across currencies, never converted; the web only formats (`noGuesses`,
§27.9).

### 40.5 Your bank: what really reached it, read through Enable Banking (owner's choice A, 2026-11-22)

The owner chose **A** on 22 Nov 2026 ("A: bank connection") from the four options this sub-section used to list (A
Enable Banking, B his bank's file, C payout emails, D nothing new). Decision record: ADR-82. It answers the last part of
his ask: *"a total of my exact number that I've gotten into my bank account or accounts, but in total for each of
those platforms"*. Everything here sits behind the api switch `BANK_READING` (Terraform `bank_reading_enabled`,
**default `false`**). While it is off, every screen keeps today's words, "Clip Factory can't see your bank. Look in
your bank's app to see what arrived." (`BANK_TEXT`), and nothing below runs. A deposit keeps its `source`, so a bank
file (B) could later fill the same rows with no change to matching, totals or screens.

**Rulings.** The old placeholder and the owner's least-data rule disagreed in seven places. His rule wins, and these
replace the placeholder's words:
1. No payer name is ever stored, not even on a matched row. A row keeps `hint` (Clip Factory's own word for the
   platform named in the bank's text, from a fixed list) and, while it can still teach Clip Factory something,
   `payerKey` (a keyed hash of the payer's text). `BANKPAYERS` maps keyed hashes to places, never names.
2. No account number is stored, not even its last 4. A row keeps `linkId` (Clip Factory's own id for one bank link).
   Screens name the bank by Enable Banking's name for it ("Swedbank").
3. Stored amounts are in minor units: `amountMinor` with its `exponent` (kr 1 234,56 is `123456`, exponent 2).
   Every public shape keeps `amountMicros` like §40.4 (`amountMinor × 10^(6 − exponent)`). That is a change of unit,
   never a conversion.
4. `depositId` is a keyed HMAC (§40.5.7), not a plain sha256 of the fields: a plain hash of a date and an amount can
   be guessed back.
5. The setup lives in one `BANKCONN` item, and each bank gets its own `BANKLINK#{linkId}`: each bank is its own BankID
   link with its own end date. There is no single `BANKCONN` with an `accounts` list.
6. The placeholder's "one new section (§41)" no longer applies (§41 is the campaign finder). The bank part lives here.
7. "Forget my bank" stays. It is only ever his own tap, with the 8 s Undo.

#### 40.5.1 Enable Banking's terms: three conditions and one risk

Checked on 22 Nov 2026 against Enable Banking's docs, API spec, Control Panel text, Terms of Service (last updated
2026-01-09) and end-user Privacy Notice (2025-03-07). `docs/SETUP_POSTING.md` "## Your bank" lists every source.
* **Restricted mode is free.** "Use of the API in the Production Environment is limited to Linked Accounts and is
  available solely for evaluation purposes or for the personal use of private individuals." There is no contract
  and no billing. Three conditions come with it, and Clip Factory's design keeps all three:
  1. **The Control Panel account and the app are his own.** He signs up himself. Clip Factory never makes or shares
     one, and no step uses the Control Panel's **Share**.
  2. **Only his own personal accounts.** He links them with **Usage type** **personal**, and every `POST /auth` sends
     `psu_type: "personal"`. The callback drops any account Enable Banking marks `usage: "ORGA"` (a business account)
     before it is ever read. Payoneer (business only in Sweden) and enskild firma accounts stay out ("If you see"
     hints).
  3. **Nobody else is ever offered it.** Clip Factory has one owner (§19). The first signed-in user who makes a bank
     key is written to `BANKOWNER`, and any other user gets 403 `forbidden` "Your bank is only for the owner of this
     Clip Factory." The steps tell him never to press **Request activation** or **Request unrestriction** (the paid
     path for companies).
* **The risk.** The Terms also say "These Terms do not grant any right or license to use the API for any business or
  professional purpose, including … using the API for any commercial purpose whatsoever"; the docs say "individual
  non-commercial use"; and the Terms forbid access "through the use of bots … or other automated devices or
  mechanisms" and automating "in an abusive manner". Creator income on a personal account, read by a daily job, is a
  grey area. A breach "shall result in termination of access", and the user's liability for it is not capped. So:
  * the bank page starts with an **optional** step, **Ask Enable Banking first**, holding a ready email (Copy and
    Open email) that asks exactly this question, daily read included. Sending it is his call, and nothing waits for
    the answer;
  * Clip Factory reads as little as it can: one read a day per bank plus his own Check now (§40.5.6), never more than
    three reads a day without him, and a 6-hour pause when a bank says it has had too many;
  * if Enable Banking says no, or sends written notice that the app will be deactivated, one line,
    `bank_reading_enabled = false`, puts every screen back to `BANK_TEXT` at once. Stored deposits, learned payers and
    links stay (they are his records), until he taps "Forget my bank".
* **What Enable Banking keeps** (its Privacy Notice): account data "a maximum of 60 seconds", session data "up to 180
  days", IP address and user agent 30 days, all in the EEA (Google Cloud Dublin, AWS Luxembourg). It is a registered
  AISP supervised by the FIN-FSA. BankID happens on Enable Banking's page and his bank's own page. **Clip Factory
  never asks for, sees or stores a bank login.**

#### 40.5.2 What he sees

**Words** (added to §40.1's list; tests read them):

| Thing | Words |
|---|---|
| The card, the page, the Money block's area name | "Your bank" |
| Money his bank booked, matched to an app | "Reached your bank" (never "received", "paid", "earned" or "income") |
| Who says so | "Your bank says" (a row: "Your bank says · Swedbank · …"; a PayPal row: "PayPal says · …") |
| Clip Factory's own buttons | "Make my bank key", "Save", "Connect your bank", "Connect another bank", "Reconnect Swedbank", "Check now" |
| Stopping one bank (the Disconnect) | "Stop reading Swedbank" (toast "Stopping Swedbank… Undo"). Never "Disconnect", "Not connected" or "disconnected" (§40.1) |
| Removing everything Clip Factory kept | "Forget my bank" (toast "Forgetting your bank… Undo") |
| His question cards | "Is this money from YouTube?" / "Where is this money from?" / "Did you move this from your PayPal?" |
| Enable Banking | always "Enable Banking"; its own labels bold and word for word (**Activate by linking accounts**) |
| The key | "bank key". Never "certificate", "RSA", "JWT" or "PEM", except the file's own ".pem" ending and Enable Banking's bold label **Public certificate in PEM format** |
| The app's ID | "app ID" |

Never on these screens: an account number or IBAN (Clip Factory never has one); "consent" (say "bank link");
"session"; "ASPSP", except inside Enable Banking's bold label **ASPSP**; "PSD2", "AISP", "API", "token".

**Where.**
1. **Settings › Posting › Get paid**: the **Your bank** card under the place cards (`data-help="getpaid-bank-card"`).
   Off: today's card (`BANK_TEXT`, no tap). On: one big glass tap to the bank page, with the mark (Icon `card`), "Your
   bank", the pill and line (§40.5.9) and a ring. While he is setting up, the ring shows the setup steps; once a bank
   is connected, it shows the days left of the link that ends first, out of 180. Once something matched, the card adds
   "Reached your bank: kr 4 102,10 so far" (one line per currency, at most 2), and "2 payments need you" when there
   are questions.
2. **The bank page** `/settings/posting/getpaid/bank` (route `{ name: "getpaid-bank" }`, matched before
   `getpaid/{place}`; `screens/getpaid/bank/BankPage.tsx`, `data-help="getpaid-bank"`). Top to bottom:
   * the header: Icon `card`, "Your bank", ring, "About 20 minutes · Free", "Steps checked on 22 Nov 2026";
   * the **status block** (`data-help="bank-status"`): pill, line, `next.text`;
   * the **step cards** (`data-help="bank-steps"`). Once a bank was connected, they fold to one green row, "Set up ✓
     (Enable Banking knows your app)";
   * **Your banks** (`data-help="bank-links"`);
   * **Is this from an app?** (`id="bank-asks"`, `data-help="bank-asks"`), only when there are questions;
   * **Money from apps** (`data-help="bank-reached"`);
   * **What Clip Factory keeps** (`data-help="bank-keeps"`);
   * **When it's done**: glass "Check now", glass "Connect another bank" (while there are fewer than 4 banks), quiet
     "Forget my bank", and with `?back=` the back button.
3. **Each place page** (§40.1 item 2): under **Sent to your bank**, one "Reached your bank" line for that place
   (§40.5.9). Each "Sent to your bank by Google/Whop" row that a deposit paired with also says "Reached your bank on 28
   Oct (Your bank says)".
4. **Money** `/money`: in All your money, under "Sent to your bank, so far", the block **Reached your bank, so far**
   (`data-help="money-reached"`, §40.5.9). While that block shows, `BankView.moneyLine` ("What reached your bank is
   below.") replaces the bank line (`BANK_TEXT`) under "Sent to your bank, so far".
5. Never in Set up posting's ring or to-do list, and never a row on Money's status-only Get paid card (unchanged).

**The page's only vermilion is `next`** (§40.5.9), with §40.1 item 2's rules: a step's main action (its Open, or Clip
Factory's own button), pinned bottom right on phones from the moment the page opens. Once every step is done,
"Reconnect Swedbank" in the status block is the vermilion when a link ended or ends within 14 days. Otherwise the page
has none, and "Check now" is glass. The green answers ("I did this", "Yes, it's YouTube") stay green, never vermilion
(§17.1).

**Step cards** are the §40.1 cards: a number in a circle, an Icon, a title of 6 words or fewer, 1–4 lines of 26 words
or fewer, then Opens, Copy chips, paste and upload boxes, "If you see" hints and the green answer. Bold means Enable
Banking's own label as its Control Panel showed it on 22 Nov 2026. Nobody saw the sign-in page's button (FirebaseUI
draws it) or the banks' pages, so those steps add "Enable Banking may show this a little differently. Look for the
same words." Data file: `web/src/getpaid/bank.ts` (`BANK_GUIDE`). It uses §40.1's `GetPaidStep` shape inside its own
`BankGuide` type, plus `paste`, `upload` and the actions `make_bank_key`, `save_app_id`, `check_app` and
`connect_bank`. The server's `bank/__init__.py` `STEPS` has the same ids, roles and autos.

| # | id | title | essentials |
|---|---|---|---|
| Optional | `bank-ask` | Ask Enable Banking first | `doneLabel` "I asked". `lead` "Enable Banking is free for your own private use. Ask them if your app money counts. It's your choice." Open "Open email" → a `mailto:` address built from `values.ask` (to, subject, body, percent-encoded; the one Open that isn't https). Copy chips "Their email" (`[hidden]`) and "The email" (the body), for webmail. If you see: they say yes → "Great. Do step 1."; they say no → "Don't do the next steps. Your bank's app still shows what arrived."; no answer → "It's your choice. You can wait, or go on." Never counts in the ring, and is never `next` |
| 1 | `bank-account` | Make an Enable Banking account | `doneLabel` "I'm in" (also ticks itself once the app ID works). Open "Open Enable Banking" → `https://enablebanking.com/sign-in/`. "Type your email. Tap the button under it." "Open the email from Enable Banking. Tap its link." "Enable Banking may show this a little differently. Look for the same words." If you see: **Sign up →** or **Get started** → "Tap it. It's the same page."; **Authenticator app** → "You can skip it. Once it's on, it can never be turned off." |
| 2 | `bank-key` | Make your bank key | `manual: false`, `action: make_bank_key` (the button "Make my bank key"); ticks itself ("Clip Factory made your bank key"). "Tap Make my bank key." "Clip Factory makes a secret key and keeps it locked away. Only Clip Factory can use it." "You copy its public part in the next step. That part is safe to share." |
| 3 | `bank-app` | Add Clip Factory on Enable Banking | `doneLabel` "I did this" (also ticks itself once the app ID works). Open "Open API applications" → `https://enablebanking.com/cp/applications`. "Under **Add a new application**, tap **Production**." "Pick **Generate outside the browser and import public certificate**." "Paste your bank key in **Public certificate in PEM format**:" Copy chip "Bank key" (`key.publicKeyPem`: the chip shows the first line and "…", and copies the whole key). If you see: **Sandbox** still picked → "Tap **Production**. A Sandbox app can't read real banks, and it can't be changed later."; **Generate in the browser (using SubtleCrypto) and export private key** was picked and your computer saved a .pem file → "That works too. Add that file in step 5."; Enable Banking says the certificate is wrong → "Copy this one instead:" Copy chip "Bank certificate" (`key.certificatePem`) |
| 4 | `bank-details` | Fill in the app's details | `doneLabel` "I did this" (also ticks itself once the app ID works). "Paste each one in its box:" Copy chips **Application name** "Clip Factory", **Allowed redirect URLs (one per line)** `values.redirectUri`, **Application description** `values.description`, **Privacy URL of the application** `values.privacyUrl`, **Terms URL of the application** `values.termsUrl`. "Type your own email in **Email for data protection matters**." "Tap **Register**." If you see: **New application … has been added.** → "Done. The long code in it is your app ID. Copy it."; a link that looks wrong → "Enable Banking doesn't check them for your own use. Go on." No Open (the page is already open), so `next.vermilion` is `false` here |
| 5 | `bank-appid` | Give Clip Factory the app ID | `manual: false`; ticks itself when the check knows the app ("Enable Banking knows your app"). Paste box "App ID" (`^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$`, checked as he types; friendly line "Your app ID has 36 letters and numbers with dashes. Copy it again from Enable Banking.") and the button "Save" (`action: save_app_id`). Folded under it, "Have a .pem file instead?": the upload box "Add the .pem file" (drop or pick, like the TikTok file box of §17.4) and, under "Can't pick the file?", the paste box "What's inside the .pem file" with the App ID box. After a .pem is saved: "Saved. Clip Factory keeps it locked away. You can delete the .pem file from Downloads now." The check's sentence (§40.5.4) shows on this card. If you see: "Enable Banking doesn't know this key" → "Do step 3 again on a new app. Or add the .pem file here." |
| 6 | `bank-link` | Link your bank accounts | `manual: false`. Its green answer "I linked them" runs the check (`action: check_app`, `POST /v1/getpaid/bank/app/check`), and the step ticks itself when Enable Banking says the app is active ("Enable Banking says your app is active"), or once any bank was connected. Open "Open API applications". "On your new app, tap **Activate by linking accounts**." "Pick **Country**, then your bank in **ASPSP**, then **personal** in **Usage type**. Tap **Link**." "Use BankID at your bank. Link every account your app money lands in." "Use PayPal too? Tap **Link accounts** and add it the same way." If you see: **Request activation** or **Request unrestriction** → "Don't tap it. That one is for companies, and it costs money."; **Unable to link accounts** or **Unable to start accounts linking** → "Tap **Activate by linking accounts** again. Pick **personal**."; your account only shows as business → "Skip it. Enable Banking's free use is for private accounts only."; Payoneer → "Payoneer can't be linked for private use. Clip Factory can't see it."; no Avanza or Nordnet → "Enable Banking doesn't have them. Pick another account." |
| 7 | `bank-connect` | Connect your bank | `manual: false`, `action: connect_bank` ("Connect your bank"); ticks itself once a bank is connected ("Clip Factory can see Swedbank"). "Tap Connect your bank. Pick your bank." "Use BankID again. Yes, again: this time it lets Clip Factory read it." "You come back here by yourself." If you see: Enable Banking's own page first → "Read it and go on. It's Enable Banking's page, not your bank's."; a QR code on a computer → "Open the BankID app on your phone. Scan the code."; "Enable Banking didn't share an account" → "Link that account in step 6 first. Then tap Connect your bank again." |

Each time (unnumbered, never in the ring): "Clip Factory looks at your bank once a day by itself. When a payment may
be from an app, it asks you here." · "Every 180 days your bank asks for BankID again. Clip Factory tells you 7 days
before."

**Connect your bank** (the flow):
1. He taps "Connect your bank" (or "Connect another bank"). The sheet **Pick your bank** opens
   (`data-help="bank-picker"`, filled from `GET /v1/getpaid/bank/banks`): a search box "Find your bank" (typing only
   filters), then one big row per bank. The banks most used in Sweden come first (Swedbank, Handelsbanken, SEB,
   Nordea, Danske Bank, Länsförsäkringar Bank, ICA Banken, SBAB Bank, Skandiabanken, Revolut, PayPal, Wise), then A to
   Z. A bank he already has says "Already here: tap to reconnect".
2. A row's tap sends `POST /v1/getpaid/bank/connect {bank}` and opens Enable Banking's page in this tab. In the Mac
   app it opens in the system browser, and this page waits the way Connect does (§17.1 `useConnecting`).
3. Enable Banking's page, then his bank's page, then BankID.
4. He comes back on `/settings/posting/getpaid/bank?result=…`; the query is removed with `history.replaceState`.
   `bank_connected` gives confetti (none with reduced motion), the success sound, a card with the result sentence,
   then "Checking your bank… This can take a few minutes." while the first read runs (§40.5.6). Any other result gives
   the error sound and a calm card with its sentence (§40.5.5).

**Your banks**: one glass card per `BankLink`, newest first. Each has Icon `card`, the bank's name, "2 accounts", the
pill and line (§40.5.9), "Checked {how long ago, from `checkedAt`}" and a small ring of the days left out of 180 ("143
days left" inside; warn tone at 14 days or less, red once ended). Then its buttons:
* "Reconnect Swedbank", when the link ended, was stopped outside Clip Factory, or has 14 days or less left. It is
  vermilion only when it is `next`, else glass;
* glass "Check now";
* quiet "Stop reading Swedbank": the 8 s toast "Stopping Swedbank… Undo", and `DELETE
  /v1/getpaid/bank/links/{linkId}` is sent only when the toast ends.

A stopped link stays as a quiet row, "You stopped reading Swedbank on 3 Dec. The money it found stays here.", with a
glass "Connect Swedbank again".

**Is this from an app?**: one glass card per `BankAsk`, newest first, at most 20, then "and 3 more". Each shows the
amount large (formatted by the web), the day and bank ("28 Oct · Swedbank") and the server's `title` and `line`. Then:
* with a suggested place: green `yesLabel` ("Yes, it's YouTube"), glass "No, another app", and quiet "Not money from
  an app". "No, another app" opens the sheet **Where is it from?**: big rows YouTube, TikTok, Instagram, Facebook,
  "Instagram and Facebook together", X, "Content Rewards (Whop)" (only while Content Rewards is on) and "Not sure";
* with no suggestion (PayPal, Payoneer): the sheet's rows right on the card, then quiet "Not money from an app";
* `own_move`: green "Yes, I moved it", and glass "No, it's new money" (opens the sheet).

Each answer is one PATCH (§40.5.10), then a toast with Undo: "Saved for YouTube. Undo" (Undo sends `not_this`), or
"Saved. Undo" for the other answers. "Not sure" folds the card into "Not sure yet (2)" at the bottom (tap to open),
and it is never counted. **He never types an amount.** Every answer is a tap, and no answer changes an amount.

**Money from apps** (`reached` and `rows`, §40.5.9): each place's amounts per currency, "In total" per currency, the
tag, then the rows, newest first (at most 36). A row shows amount, day, place, bank and `howText`, plus a quiet "Not
from YouTube?" that sends `not_this` and brings the question back. Before anything matched: "Nothing from an app
reached your bank yet." with `since`.

**What Clip Factory keeps** (fixed words, no buttons): "Only money from apps: the day, the amount and which app." ·
"Never your account number, your name or any other payment." · "Your bank login stays at your bank. Clip Factory
never sees it." · "Enable Banking forgets your bank's answer within a minute." · "Forget my bank removes every payment
and bank link Clip Factory kept."

#### 40.5.3 Taps

Counted like §40.1: a typed field is not a tap, "about" means a page that can vary, and CF means Clip Factory's own
taps. The optional "I did this" on steps 1, 3 and 4 is not counted, because step 5's check ticks them.

| Step | Taps | Total (CF) |
|---|---|---|
| Optional: Ask Enable Banking first | Open email · Send · back · "I asked" | 4 (CF 2) |
| 1 Make an Enable Banking account | Open Enable Banking · (type the email) · the button · open the email · its link · back | 5 (CF 1) |
| 2 Make your bank key | "Make my bank key" | 1 (CF 1) |
| 3 Add Clip Factory on Enable Banking | Open API applications · **Production** · **Generate outside the browser and import public certificate** · Copy chip "Bank key" · paste | 5 (CF 2) |
| 4 Fill in the app's details | 5 × (Copy chip · paste) · (type the email) · **Register** · copy the app ID (about 2) | 13 (CF 5) |
| 5 Give Clip Factory the app ID | Paste · "Save" | 2 (CF 2) |
| 6 Link your bank accounts | Open API applications · **Activate by linking accounts** · **Country** · Sweden · **ASPSP** · his bank · **Usage type** · **personal** · **Link** · go on at Enable Banking · BankID (about 3) · back · "I linked them" | 15 (CF 2) |
| 7 Connect your bank | "Connect your bank" · his bank in the list · go on at Enable Banking · BankID (about 3); he comes back by himself | 6 (CF 2) |

**One bank: 51 taps (CF 17)** with the optional email, **47 (CF 15)** without it, over one sitting of about 20
minutes. PayPal too: step 6 +10 (**Link accounts** · **Country** · Sweden · **ASPSP** · PayPal · **Usage type** ·
**personal** · **Link** · PayPal sign-in (about 2)) and step 7 +5 ("Connect another bank" · PayPal · go on · PayPal
sign-in (about 2)), so 66 (CF 19). The .pem path (he left Enable Banking's default) is about 4 taps fewer (CF 2
fewer): step 3 is only Open · **Production**, step 4 needs no copy of the app ID (the file's name holds it), and step 5
is the upload box · the file · open instead of Paste · "Save". The main path stays the server-made key anyway,
because then the private key never passes through his browser or his Downloads folder. BankID happens twice
at setup, as Enable Banking requires: linking an account in its Control Panel "won't handle authorization on behalf
of the app" (step 6, then step 7).

Afterwards: a question card is 1 tap ("Yes, it's YouTube") or 2 ("No, another app" · the place). Each payer is asked
about once, then learned; Stripe, PayPal and Payoneer are asked about every time. "Check now" is 1. A reconnect every
180 days is 5 (CF 1: "Reconnect Swedbank" · go on · BankID (about 3)). "Stop reading Swedbank" is 1.

Ways in: Settings › Posting › Get paid › Your bank, 4 taps; Money › "Check them" in Reached your bank, 2; Ask "how much
reached my bank?" with its page action, 2.

#### 40.5.4 The key, the app ID and the check (`bank/keys.py`, `bank/eb.py`; builder BA)

* **Make my bank key** (`POST /v1/getpaid/bank/key`):
  * First it claims `BANKOWNER` with a conditional put (another user → 403, §40.5.1).
  * It makes an RSA-4096 key pair (`cryptography`, public exponent 65537), a self-signed X.509 certificate for it (CN
    "Clip Factory", 10 years, SHA-256) and, only the first time, a 32-byte `hashKey` (`secrets.token_bytes`).
  * It creates the secret `cf-prod/platforms/bank/app` (tags `app=cf-prod`, `platform=bank`): `{privateKeyPem
    (PKCS#8), publicKeyPem (SPKI, "-----BEGIN PUBLIC KEY-----"), certificatePem, hashKey (base64), appId: null,
    source: "clipfactory", keyMadeAt}`, and one UpdateItem on `BANKCONN`: `app.status "key_made"`, `app.source`,
    `app.keyMadeAt`.
  * With a key already there it changes nothing. `{"again": true}` makes a new pair, keeps `hashKey` (so `depositId`s
    never change), clears `appId` and sets `app.status "key_made"`. While a link is connected, `again` gets 409 "Stop
    reading every bank first."
  * The private key and `hashKey` never leave Secrets Manager and the memory of `cf-prod-api`, `cf-prod-hooks` and
    `cf-prod-money`. `BankView.key` carries only the public key and the certificate.
* **Save** (`PUT /v1/getpaid/bank/app`):
  * `{"appId"}`: a UUID, stored lower-cased; anything else gets 400 "Your app ID has 36 letters and numbers with
    dashes."; with no key yet, 409 "Tap Make my bank key first."
  * `{"pem", "fileName"}` (the .pem path): `fileName` matching `^([0-9a-fA-F-]{36})(?: \(\d+\))?\.pem$` gives the app
    ID; otherwise the body must also carry `appId` (400 "Paste the app ID too."). `pem` must be at most 8 KB, a PKCS#8
    private key (its first line is the words BEGIN PRIVATE KEY between five dashes on each side; else 400 "That isn't
    Enable Banking's key file. It ends in .pem and starts with BEGIN PRIVATE KEY.") and an RSA key of 2048 bits or
    more. It replaces Clip Factory's key (`source: "file"`, a new
    `publicKeyPem` and `certificatePem` made from it); `hashKey` stays, or is made. The key is never logged, never
    echoed and never stored outside the secret.
  * Then the check runs (below), and the answer is `{view, check}`; `BANKCONN.app` gets `status "saved"`, `savedAt`,
    `appIdHint` (the first 8 characters and "…").
* **The check** (`POST /v1/getpaid/bank/app/check`; Save and the green "I linked them" run it too): sign a JWT, call
  `GET https://api.enablebanking.com/application`, and write `BANKCONN.app.check {code, at}`, `app.active` and
  `app.environment`. The codes and their exact sentences (the web shows them on step 5 or 6; BW's tests check them):

| `code` | When | Sentence |
|---|---|---|
| `ok` | 200, `environment` `PRODUCTION`, `active` true, and `redirect_urls` holds `values.redirectUri` exactly | "Enable Banking knows Clip Factory, and your app is active." |
| `not_active` | the same, but `active` false | "Saved. Next: link your bank accounts (step 6)." |
| `redirect_missing` | `redirect_urls` doesn't hold it | "Paste the return address in **Allowed redirect URLs (one per line)**. On your app tap ⋮, then **Edit**, then **Save**." |
| `sandbox` | `environment` `SANDBOX` | "That's a Sandbox app. Make a new one, and tap **Production** first." |
| `key_wrong` | 401, or `UNAUTHORIZED_ACCESS` | "Enable Banking doesn't know this key. Do step 3 again on a new app, or add the .pem file." |
| `not_found` | 403 or 404, or an error that names the app | "Enable Banking doesn't know that app ID. Copy it again." |
| `down` | 5xx, 429, network | "Enable Banking didn't answer. Try again in a few minutes." |

* **The JWT** (a shared contract: BA in `bank/eb.py`, BR in `bankread/client.py`). Header `{"typ": "JWT", "alg":
  "RS256", "kid": appId}`; body `{"iss": "enablebanking.com", "aud": "api.enablebanking.com", "iat": now, "exp": now +
  3600}`; base64url without padding (never the quick-start's `.replace('=', '')`); signed RSASSA-PKCS1-v1_5 with
  SHA-256 (`cryptography`). A new token for each route call or run, never kept, never logged, never sent anywhere but
  `https://api.enablebanking.com` (the deprecated `api.tilisy.com` is never used). Every call sends `Authorization:
  Bearer …` and `Accept: application/json`, with a 10 s timeout (20 s for the callback's `POST /sessions`).

#### 40.5.5 Connect and the callback (`bank/grants.py`, `hooks.py`, `oauth/callback.py`; builder BA)

* `GET /v1/getpaid/bank/banks`: calls `GET /aspsps?country={c}&psu_type=personal&service=AIS`, where `c` is
  `MONEYPREFS.country` when `GET /application`'s `countries` holds it. Otherwise: 409 "Pick your country in Money
  settings first.", and the sheet shows a glass "Pick my country" (→ `/settings/posting/money#money-country`). The
  list is cached per country in memory for a day. Answer: `{country, banks: [{name, maxDays (maximum_consent_validity
  ÷ 86400, rounded down), beta}]}`, only banks whose `psu_types` hold `personal`. Enable Banking has no bank id, only
  the name and country, and names can change, so every connect reads the list again.
* `POST /v1/getpaid/bank/connect`, with `{bank}` or, for a reconnect, `{linkId}` (that link's bank and country):
  * Refusals: without a saved app ID, 409 "Do the steps above first."; when the last check isn't `ok`, it runs the
    check again and answers 409 with the check's sentence unless the new code is `ok`; for a fifth bank, 409 "You can
    add up to 4 banks."; for a name not in the list, 400 "Pick a bank from the list."
  * The state is §17.4's (`OAUTH#{nonce}` / `STATE`, `platform: "bank"`, signed with `oauth/state.py`,
    `STATE_SECONDS`). It carries `linkId` (12 random hex for a new link; the link's own for a reconnect), `bank`,
    `country`, `maxDays`, `psuHeaders` (the bank's `required_psu_headers`, names only) and `history` (true for a new
    link, or when the link's `readThrough` is more than 80 days old).
  * `POST https://api.enablebanking.com/auth` with `{access: {valid_until: now + min(maxDays, 180) days − 10 min
    (RFC 3339 with offset), balances: false, transactions_extended_history: history}, aspsp: {name, country}, state,
    redirect_url: values.redirectUri, psu_type: "personal"}`. It never sends `credentials` or `auth_method`.
  * The answer is `{authorizeUrl: url, expiresAt}`. The web opens only an `https://` address.
* **The return address** is `{HOOKS_URL}/oauth/bank/callback` (= `{oauthCallbackBase}/bank/callback`): the same REST
  route as §14.3, whose access logs never carry the query. `bank` joins `CALLBACK_ONLY`, so `/hooks/bank` stays 404.
  The callback never depends on a cookie, because BankID can bring him back in another browser. Only the server-side
  state counts.
* `GET /oauth/bank/callback?code&state` (or `?error&error_description&state`) → `bank.grants.save_bank_grant()`:
  1. Verify and consume the state (§17.5 step 1). A bad, old or reused state → `bank_expired`.
  2. `error=access_denied` → `bank_denied`; any other `error` → `bank_error`.
  3. Read `cf-prod/platforms/bank/app`, sign, and call `POST /sessions {code}` (20 s): `EXPIRED_AUTHORIZATION_CODE`,
     `WRONG_AUTHORIZATION_CODE` or `ALREADY_AUTHORIZED` → `bank_expired`; 401 or `UNAUTHORIZED_ACCESS` →
     `bank_key_wrong`; `NO_ACCOUNTS_ADDED` → `bank_no_accounts`; 5xx, a timeout or network → `bank_error`.
  4. **In memory only**: from `accounts[]`, keep the `uid` and `identification_hash` of each account whose `usage`
     isn't `ORGA`, and drop everything else at once (holder name, `account_id` and IBAN, `all_account_ids`, address,
     product, details). If nothing is kept: `DELETE /sessions/{id}` (best effort), then `bank_business_only` when any
     account was `ORGA`, else `bank_no_accounts`. Nothing is written.
  5. Create or put the secret `cf-prod/platforms/bank/token-{linkId}` (tags `app=cf-prod`, `platform=bank`):
     `{sessionId, accounts: [{uid, idHash}], validUntil (access.valid_until), bank, country, createdAt}`.
  6. For a reconnect whose old secret held another `sessionId`: `DELETE /sessions/{old}` (best effort), after the new
     secret is written.
  7. One UpdateItem on `BANKLINK#{linkId}`: SET `type "banklink"`, `linkId`, `bank`, `country`, `status
     "connected"`, `consentUntil` (= `validUntil`), `connectedAt`, `firstConnectedAt` (`if_not_exists`),
     `accountCount`, `psuHeaders`, `historyWanted` (= `history`), `firstReadDone` (`if_not_exists`, false),
     `updatedAt`; REMOVE `reason`, `lastError`, `endedAt`, `stoppedAt`, `warnedFor`, `limitUntil`, `resume`,
     `firstReadStartedAt`.
  8. `302 {APP_URL}/settings/posting/getpaid/bank?result={code}`, with `Cache-Control: no-store` and
     `Referrer-Policy: no-referrer`. Never logged: the code, the state, the session id, uids, hashes, the query.

  The result sentences (exact; the web shows them, BW's tests check them):

  | `result` | Sentence |
  |---|---|
  | `bank_connected` | "Clip Factory can see money coming into {bank} now. It looks once a day." (`{bank}`: the link connected most recently) |
  | `bank_denied` | "You stopped at the bank. Tap Connect your bank to try again." |
  | `bank_no_accounts` | "Enable Banking didn't share an account. Link it in step 6 first. Then tap Connect your bank again." |
  | `bank_business_only` | "That bank only shared a business account. Clip Factory reads private accounts only." |
  | `bank_expired` | "That took too long. Tap Connect your bank again." |
  | `bank_key_wrong` | "Enable Banking didn't know your bank key. Do step 5 again." |
  | `bank_error` | "Something went wrong. Tap Connect your bank again in a few minutes." |
* **The first read starts at once.** It is sent by the landing page on `bank_connected`, or by any open bank page that
  gets the live `bank` event for a link with `firstReadDone` false and `connectedAt` under an hour ago: `POST
  /v1/getpaid/bank/check {"first": true}`, once. The API lets only one through per link (a conditional
  `firstReadStartedAt`). If no screen sends it (he came back in a browser that isn't signed in), the next daily run
  reads the link instead, and by then the bank may give only 90 days of history (§40.5.6).
* **Stop reading Swedbank** (`DELETE /v1/getpaid/bank/links/{linkId}`): `DELETE /sessions/{id}` at Enable Banking
  (best effort; it closes "the bank consent … if possible"), delete `cf-prod/platforms/bank/token-{linkId}`, and set
  the `BANKLINK#`'s `status "stopped"` and `stoppedAt`. Every `DEPOSIT#` stays. An unknown link gets 404.
* **Forget my bank** (`DELETE /v1/getpaid/bank`): stops every link as above, then deletes every `DEPOSIT#`,
  `BANKLINK#` and `BANKPAYERS` item, and sets `BANKCONN.forgottenAt`. The app key, the app ID and `BANKCONN.app` stay,
  so "Connect your bank" works again without the Enable Banking steps. He can remove the Enable Banking app itself on
  its own page.

#### 40.5.6 Reading (`bankread/`, run by `cf-prod-money`; builder BR)

**When.**
* **Once a day**, in `cf-prod-money`'s 06:00 UTC run: `money/collect.run_user` calls `bankread.collect.run(deps,
  user_id, now, psu=None, remaining=…)` after the payout reads, so the day's new `PAYOUT#` rows are there to match.
  It runs in its own try, and is skipped when less than 20 s of the time budget is left. It is unattended: no PSU
  headers.
* **Check now** (`POST /v1/getpaid/bank/check`):
  * at most once every 15 minutes and 12 times a UTC day per owner (conditional on `BANKCONN.lastManualAt` and
    `manual {day, n}`). Over that: 429 `rate_limited` "Clip Factory checked a moment ago." with `retryAt`, which the
    web shows as "Try again at 14:15.". `{"first": true}` for a link whose first read hasn't started passes anyway;
  * the API invokes `cf-prod-money` asynchronously (a permission it already has) with `{"action": "bank", "userId",
    "first": bool, "psu": {"ip": requestContext.http.sourceIp, "ua": the User-Agent header, at most 512
    characters}}`, and answers 202 with the view. The money handler runs only `bankread.collect.run(…, psu=…)` for
    that owner (240 s budget);
  * the IP address and user agent go to Enable Banking for that one read only. They are **never stored, never
    logged**, and never in a response.
* **The 4-a-day rule** (PSD2 RTS Art. 36(5)(b): "no more than four times in a 24-hour period" when he isn't there):
  * a read is **attended** when `psu` is given and every one of the bank's `psuHeaders` can be filled from it
    (`psu-ip-address` ← ip, `psu-user-agent` ← ua). It is all of them or none: a partial set gets 422
    `PSU_HEADER_NOT_PROVIDED`. Every other read is **unattended**, and a bank with an empty `psuHeaders` list always
    counts as unattended;
  * Clip Factory makes at most **3** unattended reads per link per UTC day (`BANKLINK#.reads {day, unattended,
    attended}`), so one is always left over. Past that, a Check now says "Clip Factory looked at Swedbank 3 times
    today. It looks again tomorrow.";
  * `ASPSP_RATE_LIMIT_EXCEEDED` (429): `limitUntil = now + 6 h`, Enable Banking's own advice, with no read before
    then. Enable Banking's own 429: `limitUntil = now + max(Retry-After, 1 h)`.

**What.** For each `BANKLINK#` with `status "connected"` and no `limitUntil` still ahead:
* read `cf-prod/platforms/bank/token-{linkId}` and `…/bank/app`, then `GET /sessions/{sessionId}`. A `status` other
  than `AUTHORIZED` ends the link (table below);
* for each account in both the session's `accounts` and the secret's list: `GET
  /accounts/{uid}/transactions?transaction_status=BOOK&date_from=…&strategy=…[&continuation_key=…]`. Every page uses
  the same parameters, until `continuation_key` is null (an empty page with a key still goes on):
  * first read (`firstReadDone` false), or a reconnect with `historyWanted` within an hour of `connectedAt`:
    `strategy=longest`, with `date_from` = today − 400 days (first read) or `readThrough` − 10 days (reconnect).
    Full history is often there only in the first hour after BankID; after that many banks give 90 days. Afterwards,
    REMOVE `historyWanted`;
  * every other read: `strategy=default`, `date_from` = the later of `readThrough` − 10 days and today − 89 days,
    `date_to` = today (UTC). The 10-day overlap catches bookings with an earlier date, and `depositId` makes them
    count once;
  * when less than 20 s is left, the read stops after a whole page and keeps `resume {account index, strategy,
    dateFrom, continuationKey}` on the link (internal, never returned) for the next run. `WRONG_CONTINUATION_KEY` on
    a resume restarts that account with `strategy=default` from today − 89 days, and `historyFrom` says so;
  * `historyFrom` (first read only) is the oldest booking date the bank returned on that link, over any row (read in
    memory, and only this one date is kept), or `date_from` when nothing came back. Screens say "Counted from 3 Aug
    2026, as far back as your bank shows."
* then update the `BANKLINK#`: `lastReadAt`, `readThrough` (today), `firstReadDone`, `historyFrom`, `reads`; REMOVE
  `lastError`, `reason` and `resume` when the read finished.

**Ends and errors**, decided by Enable Banking's `error` code, never by the HTTP status alone:

| Answer | Then |
|---|---|
| session `EXPIRED`, or `EXPIRED_SESSION` | `status "ended"`, `endedAt`, `reason` `consent_over` (within a day of `consentUntil`) or `ended_early` |
| session `REVOKED`, or `REVOKED_SESSION` | `status "stopped_at_bank"`, `endedAt` |
| session `CLOSED`, `CANCELLED` or `INVALID`; `CLOSED_SESSION`, `SESSION_DOES_NOT_EXIST` | `status "ended"`, `reason "ended_early"` |
| `ASPSP_PSU_ACTION_REQUIRED` | stays connected, `reason "psu_action"` (the line in §40.5.9) |
| `ASPSP_RATE_LIMIT_EXCEEDED` | `limitUntil` + 6 h; `lastError` "Swedbank asked Clip Factory to wait. It looks again later." |
| `PSU_HEADER_NOT_PROVIDED`, `PSU_HEADER_INVALID` | one more try unattended, when the 3 aren't used up; else `lastError` |
| `ACCOUNT_DOES_NOT_EXIST`, `ASPSP_ACCOUNT_NOT_ACCESSIBLE` | that account is skipped this run; `lastError` "Swedbank didn't share one of your accounts today." |
| `WRONG_TRANSACTIONS_PERIOD`, `DATE_FROM_IN_FUTURE`, `WRONG_DATE_INTERVAL` | one more try with `strategy=default` from today − 89 days |
| `UNAUTHORIZED_ACCESS`, `AUTHORIZATION_NOT_PROVIDED` (the key) | `BANKCONN.app.check` becomes `key_wrong`; links keep their status; `lastError` "Enable Banking didn't know your bank key. Do step 5 again." |
| `ASPSP_ERROR`, `ASPSP_TIMEOUT`, 5xx, network, `UNAUTHORIZED_IP` | `lastError` "Swedbank didn't answer. Clip Factory tries again tomorrow."; nothing else changes |

Every write a read makes to a `BANKLINK#` is conditional on `status = "connected"` and on the `connectedAt` it started
with, so a Stop or a reconnect during a read wins. A read never deletes anything (`cf-prod-money` has no DeleteItem).

**Expiry.** On each run, every connected link with 7 days or less to `consentUntil` and `warnedFor` ≠ `consentUntil`
goes into the run's notice (§40.5.11) and gets SET `warnedFor = consentUntil`. A link that ended in this run (either
kind) goes into the notice too. An end never deletes a deposit.

#### 40.5.7 Least data (BR filters; BA and BR store)

**In memory, per transaction** (`bankread/filter.py`, pure). Only `credit_debit_indicator`, `status`,
`transaction_amount {amount, currency}`, `booking_date` (else `value_date`, else `transaction_date`),
`entry_reference`, `debtor.name` and `remittance_information[]` are looked at; no other field is read. A transaction
goes on only when **all** of these hold:
* `credit_debit_indicator` is `CRDT` and `status` is `BOOK` (checked again here: filtering on the bank's side doesn't
  always work);
* the amount matches `^\d{1,15}(\.\d{1,6})?$` and is above 0 (a negative "credit" is dropped);
* the currency is 3 capital letters and not a fund or metal code (`XAU`, `XAG`, `XPT`, `XPD`, `XDR`, `XTS`, `XXX`,
  `XBA`–`XBD`, `XSU`, `XUA`);
* the amount fits the currency's minor unit, read with `Decimal`, never a float: exponent 0 for BIF, CLP, DJF, GNF,
  ISK, JPY, KMF, KRW, PYG, RWF, UGX, VND, VUV, XAF, XOF, XPF; 3 for BHD, IQD, JOD, KWD, LYD, OMR, TND; 2 for every
  other. So `"1234.567"` SEK is dropped;
* the booking date is a real `YYYY-MM-DD`, no later than tomorrow.

Then, still in memory:
* `text` = `norm(debtor.name) + " " + norm(remittance lines)`, where `norm` is: NFKD, accents dropped, capitals, every
  character that isn't A–Z or 0–9 → a space, spaces collapsed;
* `hint` = the first of these whole-word matches in `text`, in this order (specific first): `whop` (WHOP, CONTENT
  REWARDS), `tiktok` (TIKTOK, BYTEDANCE), `instagram` (INSTAGRAM), `facebook` (FACEBOOK), `meta` (META), `youtube`
  (GOOGLE, ADSENSE, YOUTUBE), `x` (X CORP, TWITTER, X COM), `stripe` (STRIPE), `payoneer` (PAYONEER), `paypal`
  (PAYPAL). `shared` is true when `text` holds STRIPE, PAYPAL or PAYONEER (money that can come from more than one
  place);
* `payerKey` = the first 32 hex of HMAC-SHA256(`hashKey`, `"payer|" +` the letters of `norm(debtor.name)`), or of the
  first remittance line when the debtor name has fewer than 3 letters. Letters only, so a payment number in the text
  never splits one payer in two;
* `depositId` = the first 32 hex of HMAC-SHA256(`hashKey`, `"dep|" + idHash + "|" + entry_reference`). When the row
  has no `entry_reference`, or two rows of the same account in one read share it with a different date or amount
  (some banks repeat them), the input is `"dep|" + idHash + "|" + date + "|" + amount + "|" + currency + "|" +` the
  letters of `text` `+ "|" + n`, where n = 1, 2, … among identical rows of that account in that read, in the bank's
  order. `identification_hash` stays the same across sessions, so a reconnect (new uids) gives the same `depositId`s;
* `traceText` (only for Whop's trace code): the letters and digits of the remittance lines.

The rest of the row, and every row matching drops (§40.5.8), is gone once the page is done: never stored, logged,
cached or sent. Logs carry counts only (`bank.read`: link, pages, seen, kept, asked, matched, dropped) and Enable
Banking's error code. They never carry an amount, a name, a text, an IBAN, a uid, a session id, a hash, the IP or the
user agent.

**Stored** (every attribute there is; nothing else):

| What | Where | Kept |
|---|---|---|
| A payment matched to an app | `DEPOSIT#`, `state "matched"`: `depositId`, `date`, `amountMinor`, `exponent`, `currency`, `place`, `how`, `payoutRef` and `payoutDate` (payout matches), `payerKey` and `shared` (`payer` and `you` matches, so he can undo one), `notPayout`, `linkId`, `source "enable_banking"`, `fetchedAt`, `confirmedAt`, `quiet` | until Forget my bank (his records) |
| A payment waiting for his answer | `DEPOSIT#`, `state "needs_you"`: the same without `place` and `how`, plus `suggested`, `kind`, `hint`, `shared`, `notSure`, `ttl` | until he answers; `ttl` = booking date + 180 days |
| "Not money from an app" | `DEPOSIT#`, `state "not_income"`: only `depositId`, `date`, `linkId`, `why` (`you`, `own_move`), `ttl`. The amount and every other field are removed | `ttl` = booking date + 400 days, so a later read never asks again |
| Payers he confirmed | `BANKPAYERS`: `rules {payerKey: {place, learnedAt}}` (at most 50), `notIncome` (a string set of payerKeys, at most 100) | until Forget my bank |
| Each bank link | `BANKLINK#` (§40.5.11) | until Forget my bank |
| The key, the app ID, `hashKey` | the secret `cf-prod/platforms/bank/app` | the key and app ID until he makes a new key; `hashKey` for good (so ids never change) |
| A bank link's session | the secret `cf-prod/platforms/bank/token-{linkId}`: `sessionId`, `accounts [{uid, idHash}]`, `validUntil`, `bank`, `country`, `createdAt` | until Stop reading, Forget my bank, or the next reconnect replaces it |
| Everything else the bank sends | the Lambda's memory | that page only |
| His IP address and browser name | the request, the money event, the call to Enable Banking | that one read only |

#### 40.5.8 Matching (`bankread/match.py`, pure; builder BR)

**Inputs**: the in-memory candidates of one read, oldest first; the owner's `PAYOUT#youtube#…` rows (`state "sent"`,
amount and currency from `getpaid.sent.parse_amount(amountText)`; unread ones never match by amount) and
`PAYOUT#contentrewards#…` rows (`state "sent"`: `amountMicros`, `currency`, `traceCode`); the `payoutRef`s already
paired; `BANKPAYERS`; and whether a PayPal link is connected (a link whose `bank` is "PayPal"). The first rule that
applies wins:

1. **Kept already.** A `DEPOSIT#` with this `depositId` exists → nothing (a `needs_you` row is looked at again in
   rule 9).
2. **He said it isn't app money.** `payerKey` is in `notIncome`, and the row isn't `shared` → dropped.
3. **Google's tiny test payment.** `hint` is `youtube`, no payout record matches, and the amount is at most its
   currency's test ceiling (SEK 20.00, NOK 20.00, DKK 15.00, EUR 2.00, USD 2.00, GBP 2.00, CHF 2.00; other currencies
   have none, so they are asked about) → dropped: never stored, never asked. Google's test deposits are 0.15–1.10 EUR
   in the local money, while a real YouTube payment is at least kr 700 (kr 70 when an account closes). The ceilings
   are Clip Factory's own number for each currency, never a conversion.
4. **A payout record** (`how "payout"`). Same currency and exactly the same amount (`amountMinor × 10^(6 −
   exponent)` equals the payout's micros) as a `PAYOUT#` row that isn't paired yet and isn't in this row's
   `notPayout`, booked from the payout's date to 10 workdays (Monday to Friday) after it → `matched`, with `place`
   the payout's, `payoutRef` its sort key and `payoutDate` its date. With several candidates for one payout, the
   earliest booking wins (then the smaller `depositId`). A payout pairs with one deposit only.
5. **Whop's trace code** (`how "payout"`). A Content Rewards payout's `traceCode` (at least 6 letters and digits)
   inside the candidate's `traceText`, booked from the payout's date to 15 workdays after it, with any amount or
   currency (Whop or the bank may have changed the money) → `matched`, `contentrewards`.
6. **A payer he confirmed** (`how "payer"`). Not `shared`, and `payerKey` is in `BANKPAYERS.rules` → `matched`, with
   that place.
7. **Money moved from his own PayPal.** `hint` is `paypal`, a PayPal link is connected, and the candidate is in
   another link → `needs_you`, `kind "own_move"`.
8. **Ask him.** Any `hint` → `needs_you`, `kind "place"`, with `suggested` from the hint: `youtube` → YouTube,
   `instagram` → Instagram, `facebook` → Facebook, `meta` → `meta` ("Instagram and Facebook together"), `tiktok` →
   TikTok, `x` and `stripe` → X, `whop` → Content Rewards (only while Content Rewards is on; else none), `paypal` and
   `payoneer` → none.
9. **Again each run.** Every stored `needs_you` row (`notSure` or not) is matched again with rules 4 and 6 (the trace
   text is gone by then). A match updates it to `matched`, on the condition `state = "needs_you"`, so an answer he gave
   meanwhile wins.
10. **Everything else** (no hint: his salary, a Swish, a refund) → dropped in memory.

Rows written during a link's first read, and rows matched later from them, carry `quiet: true`: no notification for
old money.

**His answers** (`bank/answers.py`, builder BA; `PATCH /v1/getpaid/bank/deposits/{depositId}`):

| `answer` | On | Then |
|---|---|---|
| `yes` | `needs_you` with `suggested` | `matched`, `how "you"`, `place` = `suggested`, `confirmedAt`. Unless the row is `shared`, it learns `payerKey → place`, and every other `needs_you` row with the same `payerKey` becomes `matched`, `how "payer"`, at once |
| `place`, with `place` | `needs_you` | as `yes`, with that place (`meta` = "Instagram and Facebook together") |
| `own_move` | `needs_you`, `kind "own_move"` | `not_income`, `why "own_move"`; learns nothing |
| `not_sure` | `needs_you` | `notSure: true`; never counted |
| `not_income` | `needs_you` | `not_income`, `why "you"`; `payerKey` joins `notIncome` unless the row is `shared`. Other `needs_you` rows with that `payerKey` stay (he answers each one) |
| `not_this` | `matched` | back to `needs_you` (`suggested` null, `kind "place"`). A payout match adds its `payoutRef` to `notPayout` and frees the payout; a `payer` or `you` match removes that `payerKey` from `rules` (rows it matched before stay) |

Refusals: 400 "That answer isn't known." or "Pick a place from the list." (`contentrewards` while Content Rewards is
off too); 404 for an unknown id; 409 "That one is answered already." when the row's state doesn't fit. An answer never
changes `amountMinor`, `currency` or `date`.

#### 40.5.9 The numbers and words on screen (`bank/view.py`; builder BA; pure parts golden)

**Reached your bank** is, for each place, the sum of its `matched` rows per currency. `totals` is per currency over
every place. Nothing is added across currencies or converted, and a place with nothing is never shown as $0: it is
named in `notYet` instead. Places come in this order: YouTube, TikTok, Instagram, Facebook, `meta` ("Instagram and
Facebook (Meta pays them together)"), X, "Content Rewards (Whop)". `needs_you`, `notSure` and `not_income` rows are
never counted.

**Status** (`BankView.status`, `pill`, `tone`, `line`; server-made, exact). Setup comes first; after it, the worst
link wins: ended › stopped outside › needs you › ends soon › checking › can see; when every link is stopped, stopped.

| `status` | Pill (tone) | Line |
|---|---|---|
| `not_started` | "Not started" (neutral) | "See which app money reached your bank. Set it up once with BankID." |
| `setting_up` | "Not set up yet" (warn) | `next.text` ("Next: step 5, Give Clip Factory the app ID."), or the check's sentence when it isn't `ok` or `not_active` |
| `checking` | "Checking…" (neutral) | "Clip Factory is reading Swedbank for the first time. This can take a few minutes." After 26 hours with no first read: "Clip Factory couldn't read Swedbank yet. It tries again tomorrow." |
| `can_see` | "Clip Factory can see it (Your bank says)" (success) | "Clip Factory looks at Swedbank once a day. The link ends in 143 days." (two banks: "Clip Factory looks at Swedbank and PayPal once a day. The first link ends in 98 days.") |
| `ending_soon` | "Link ends in 9 days" (warn) | "Your Swedbank link ends on Fri 20 May. Tap Reconnect Swedbank and use BankID." |
| `needs_you` | "Swedbank needs you" (warn) | "Swedbank wants you to do something in its app or website first. Then tap Check now." |
| `ended` | "Link ended" (error) | `consent_over`: "Your Swedbank link ended on 20 May. Clip Factory can't see new money until you reconnect." · `ended_early`: "Swedbank ended the link early. Banks sometimes do. Tap Reconnect Swedbank and use BankID." |
| `stopped_at_bank` | "Stopped outside Clip Factory" (error) | "The Swedbank link was stopped at Enable Banking or at your bank. Tap Reconnect Swedbank to start it again." |
| `stopped` | "Stopped" (neutral) | "You stopped reading Swedbank on 3 Dec. The money it found stays here." |

Each `BankLink` gets the same pill and line for itself. `daysLeft` is the number of whole days to `consentUntil`,
rounded up. A link's `lastError` shows under its line.

**`next`** (the page's one vermilion):
* the first numbered step not done. Its `label`: step 1 "Open Enable Banking", 2 "Make my bank key", 3 "Open API
  applications", 4 none (`vermilion: false`), 5 "Save", 6 "Open API applications", 7 "Connect your bank". Its `text`:
  "Next: step 4, Fill in the app's details.";
* with every step done: the first link that is `ended`, `stopped_at_bank` or `ending_soon` (ended first, then the
  soonest end) → `{stepId: null, label: "Reconnect Swedbank", linkId, vermilion: true}`;
* otherwise `null`.

**Steps and autos** (from stored items only, never a secret):
* `bank-key` is done when `BANKCONN.app.status` is `key_made` or `saved`;
* `bank-appid` is done when the check is `ok` or `not_active`;
* `bank-account`, `bank-app` and `bank-details` tick themselves ("Enable Banking knows your app") once the check is
  `ok` or `not_active`, or once any link exists;
* `bank-link` is done when the check is `ok`, or once any link exists;
* `bank-connect` is done once any link exists;
* `bank-ask` shows "Optional" and never counts. The ring counts the seven numbered steps.

**`howText`**: `payout` "matches Google's payment of 21 Oct" / "matches Whop's payout of 21 Oct"; `payer` "from a payer
you said is YouTube"; `you` "you said it's from TikTok".

**`BankAsk`** `title` / `line` / `yesLabel`:
* a suggested place: "Is this money from YouTube?" / "Your bank's text looks like Google." / "Yes, it's YouTube".
  `meta`: "Is this money from Instagram and Facebook?" / "Your bank's text looks like Meta." / "Yes, it's Meta".
  `stripe` → X: "Is this money from X?" / "Your bank's text says Stripe. X pays through Stripe, but others can too." /
  "Yes, it's X";
* no suggestion: "Where is this money from?" / "Your bank's text mentions PayPal." (or Payoneer);
* `own_move`: "Did you move this from your PayPal?" / "Clip Factory reads your PayPal too, so this money may already
  be counted there." / "Yes, I moved it".

The hint words are Google, Meta, Instagram, Facebook, TikTok, X, Stripe, Whop, PayPal and Payoneer: Clip Factory's own
names, never the bank's text.

**`reached`**:
* `tag` "Your bank says. Clip Factory matched each one to an app.";
* `twoMonies` (more than one currency) "Different money, like dollars and kronor, is never added together.";
* `notYet` "Not in this yet: TikTok and X." (places with no matched row; Instagram and Facebook count as in when
  `meta` has rows);
* `since` "Counted from 3 Aug 2026, as far back as your bank shows." (the oldest `historyFrom`);
* `empty` (no matched rows) "Nothing from an app reached your bank yet.";
* `needYou` "2 bank payments need you.";
* each place's `note`: Content Rewards "Whop sends all your Whop money, Content Rewards too."; `meta` "Meta pays
  Instagram and Facebook in one payment, so Clip Factory can't split it."

**`places[place]`** (each place page's line):
* with rows: headline "Reached your bank", `amounts`, `note` "Your bank says. Last on 28 Oct.". Instagram's and
  Facebook's lines also carry `meta`'s amounts in `metaAmounts`, under "And from Meta, for Instagram and Facebook
  together:";
* none yet: headline "Nothing from YouTube reached your bank yet.", `note` "Your bank says. Clip Factory looked on 3
  Dec.";
* no link yet: headline "Clip Factory can't see your bank yet.", `button` {label "Set up Your bank", href
  `/settings/posting/getpaid/bank`}.

**`pairs`**: each `matched` row with `how "payout"` → `{place, payoutDate, amountMicros, currency, reachedOn}`. The
place page puts "Reached your bank on 28 Oct (Your bank says)" under the `PayoutRow` with the same place, date, amount
and currency.

**`moneyLine`**: "What reached your bank is below.", once any link was ever connected. Before that it is absent, and
`BANK_TEXT` stays.

**The Money block** (builder BW): the title "Reached your bank, so far"; one line per place (its name, then its amounts
per currency joined with " · "); "In total:" with one line per currency; then `tag`, `twoMonies`, `notYet`, `since`,
and `needYou` with a glass "Check them" (→ `/settings/posting/getpaid/bank#bank-asks`). With no matched rows: `empty`.
It is never added to the 30-day total or to "Sent to your bank, so far", which is a different thing (what a platform
sent, not what the bank booked).

#### 40.5.10 API routes and shapes (`routes/bank.py`; builder BA)

All JWT, §5 errors, registered before `GET /v1/getpaid/{place}`. While `BANK_READING` is off, `GET
/v1/getpaid/bank` answers `{"on": false}` and every other route 503 `unavailable` "Coming soon.". Without §17.4's
OAuth env they answer 503 "Posting setup is not switched on for this app yet.". A user who isn't `BANKOWNER` gets 403
(§40.5.1).

| Method & path | Body | 2xx response |
|---|---|---|
| GET `/v1/getpaid/bank` | – | `BankView` (also registers the owner in `MONEYOWNERS`, like `GET /v1/getpaid`) |
| POST `/v1/getpaid/bank/key` | `{}` or `{"again": true}` | `BankView` |
| PUT `/v1/getpaid/bank/app` | `{"appId"}`, `{"pem", "fileName"}` or `{"pem", "appId"}` | `{ "view": BankView, "check": BankAppCheck }` |
| POST `/v1/getpaid/bank/app/check` | – | `{ "view", "check" }` |
| PATCH `/v1/getpaid/bank/steps` | `{"step", "done"}` (`bank-ask`, `bank-account`, `bank-app`, `bank-details` only; others 400 "Clip Factory ticks that one itself.") | `BankView` |
| GET `/v1/getpaid/bank/banks` | – | `{ "country", "banks": BankChoice[] }` |
| POST `/v1/getpaid/bank/connect` | `{"bank"}` or `{"linkId"}` | `{ "authorizeUrl", "expiresAt" }` |
| POST `/v1/getpaid/bank/check` | `{}` or `{"first": true}` | `202 BankView`; 429 `rate_limited` with `retryAt` |
| PATCH `/v1/getpaid/bank/deposits/{depositId}` | `{"answer", "place"?}` (§40.5.8) | `BankView` |
| DELETE `/v1/getpaid/bank/links/{linkId}` | – | `204` |
| DELETE `/v1/getpaid/bank` | – | `204` (Forget my bank) |

Only these routes reach outside stored items: key (makes a key, no network), app and app/check (`GET /application`),
banks (`GET /aspsps`, cached), connect (`POST /auth`), the two deletes (`DELETE /sessions`) and check (the async invoke).
No answer ever carries a private key, `hashKey`, a session id, a uid, an `identification_hash`, a `payerKey`, the bank's
own text, an IP address, a user agent or a JWT.

```ts
// web/src/api/types.ts (builder BW adds these; BA's routes answer exactly them)
type BankPlace = GetPaidPlace | "meta";          // "meta": Instagram and Facebook together (Meta pays both at once)
type BankStatus = "not_started" | "setting_up" | "checking" | "can_see" | "ending_soon" | "needs_you" | "ended"
  | "stopped_at_bank" | "stopped";
type BankStepId = "bank-ask" | "bank-account" | "bank-key" | "bank-app" | "bank-details" | "bank-appid" | "bank-link"
  | "bank-connect";
type BankAppCode = "ok" | "not_active" | "redirect_missing" | "sandbox" | "key_wrong" | "not_found" | "down";
type BankResult = "bank_connected" | "bank_denied" | "bank_no_accounts" | "bank_business_only" | "bank_expired"
  | "bank_key_wrong" | "bank_error";
type Tone = "success" | "neutral" | "warn" | "error";
interface Amount { currency: string; amountMicros: number }   // never converted, never added across currencies
interface BankAppCheck { code: BankAppCode; text: string; at: string }
interface BankView {
  on: boolean;                     // false while BANK_READING is off: then only `on` is sent, and screens keep BANK_TEXT
  status: BankStatus; pill: string; tone: Tone; line: string;
  next: { stepId: BankStepId | null; label: string; text?: string; linkId?: string; vermilion: boolean } | null;
  steps: { id: BankStepId; done: boolean; by: "you" | "auto" | null; auto?: string }[];
  ring: { done: number; total: 7 };
  key: { made: boolean; source?: "clipfactory" | "file"; publicKeyPem?: string; certificatePem?: string;
         appIdHint?: string; check?: BankAppCheck };
  values: { redirectUri: string; appName: "Clip Factory"; description: string; privacyUrl: string; termsUrl: string;
            ask: { to: string; subject: string; body: string } };
  links: BankLink[];               // newest first, at most 4 not stopped
  asks: BankAsk[];                 // needs_you, newest first, at most 20 (notSure ones last)
  asksMore?: number;
  reached: BankReached;
  rows: BankRow[];                 // matched, newest first, at most 36
  pairs: { place: GetPaidPlace; payoutDate: string; amountMicros: number; currency: string; reachedOn: string }[];
  places: Partial<Record<GetPaidPlace, BankPlaceLine>>;
  moneyLine?: string;
  canAddBank: boolean; checkedAt?: string; nextCheckAllowedAt?: string; country: string | null; asOf: string;
}
interface BankLink { linkId: string; bank: string; status: Exclude<BankStatus, "not_started" | "setting_up">;
  pill: string; tone: Tone; line: string; lastError?: string; accounts: number; daysLeft?: number;
  consentUntil?: string; checkedAt?: string; historyFrom?: string; limitUntil?: string;
  reconnect: boolean; canStop: boolean }
interface BankAsk { depositId: string; date: string; amountMicros: number; currency: string; bank: string;
  kind: "place" | "own_move"; suggested: BankPlace | null; title: string; line: string; yesLabel?: string;
  notSure: boolean }
interface BankRow { depositId: string; date: string; amountMicros: number; currency: string; bank: string;
  place: BankPlace; name: string; how: "payout" | "payer" | "you"; howText: string }
interface BankReached { state: "none_yet" | "number" | "checking" | "no_link";
  places: { place: BankPlace; name: string; amounts: Amount[]; note?: string }[];
  totals: Amount[]; tag: string; twoMonies?: string; notYet?: string; since?: string; empty?: string;
  needYou?: string }
interface BankPlaceLine { headline: string; amounts: Amount[]; metaAmounts?: Amount[]; note?: string;
  button?: { label: string; href: string } }
interface BankChoice { name: string; maxDays: number; beta: boolean }
// LiveEvent gains { type: "bank", op: "upsert", id: "bank", partial: true }
```

`values.description` is "Shows me which of my app payouts reached my own bank account.". `values.ask` is `{to:
"[hidden]", subject: "Personal use: my own creator income on my own account", body}` with this
body (no name or detail of his; he signs it himself):

> Hello,
>
> I'm a private person in Sweden. I made a restricted Production application in your Control Panel, linked only to my
> own personal accounts.
>
> I post short videos. YouTube, TikTok, Meta, X and Whop sometimes pay small amounts into my personal bank account or
> PayPal. I want my own app to read my booked incoming payments once a day, keep only the ones from those platforms,
> and show me the totals. Nobody else uses it, and I don't share, sell or offer it to anyone.
>
> Does this count as personal use of private individuals under your Terms? Is one automatic read a day, plus a read
> when I tap a button, fine?
>
> Thank you!

`bank/view.py` `view(items, now, *, cr_on, values) -> BankView` is pure (golden cases); `bank/view.py` `load(store,
user_id, now, …)` reads `BANKCONN`, `BANKLINK#`, `DEPOSIT#` and `MONEYPREFS` only. Dates in server sentences are UTC
days written "28 Oct" or "Fri 20 May"; times are formatted by the web.

#### 40.5.11 Data, secrets, live, notifications, infra, the switch and mock mode

**Data** (additive only: new sort keys and one new registry partition; every write an UpdateItem or a conditional
PutItem; no table, index, bucket, Lambda, role or Terraform-made secret):

| Item | Attributes | Written by |
|---|---|---|
| `BANKOWNER` (pk and sk `BANKOWNER`) | `type "bankowner"`, `userId`, `claimedAt` | api (the first key, conditional) |
| `BANKCONN` | `type "bankconn"`, `stepsDone` (string set, at most 10), `app {status ("key_made", "saved"), source, keyMadeAt, savedAt, appIdHint, active, environment, check {code, at}}`, `lastManualAt`, `manual {day, n}`, `forgottenAt`, `updatedAt`; and `lastNotice`, `lastRunAt` | api; money (`lastNotice`, `lastRunAt` only) |
| `BANKLINK#{linkId}` | `type "banklink"`, `linkId`, `bank` (Enable Banking's name, at most 60 characters), `country`, `status` (`connected`, `ended`, `stopped_at_bank`, `stopped`), `reason` (`consent_over`, `ended_early`, `psu_action`), `consentUntil`, `connectedAt`, `firstConnectedAt`, `accountCount`, `psuHeaders` (names only), `historyWanted`, `firstReadDone`, `firstReadStartedAt`, `historyFrom`, `readThrough`, `lastReadAt`, `lastError`, `limitUntil`, `reads {day, unattended, attended}`, `resume` (internal), `warnedFor`, `endedAt`, `stoppedAt`, `updatedAt` | hooks (connect), api (stop, the first-read claim), money (read state, ends) |
| `DEPOSIT#{yyyy-mm-dd}#{depositId}` | the table of §40.5.7, plus `type "deposit"` | money (new rows, matches again), api (answers, forget) |
| `BANKPAYERS` | `type "bankpayers"`, `rules`, `notIncome`, `updatedAt` | api (his answers only) |
| api env | `BANK_READING` from `bank_reading_enabled` (default `false`): an in-place env change | Terraform |

**Secrets** (Secrets Manager only, made at runtime with tags `app=cf-prod`, `platform=bank`; never in DynamoDB, logs,
responses, URLs or the browser; never in Terraform, so a deploy can't touch them):

| Secret | Written by | Read by | Today's IAM |
|---|---|---|---|
| `cf-prod/platforms/bank/app` | `cf-prod-api` (key, .pem) | `cf-prod-api`, `cf-prod-hooks` (callback), `cf-prod-money` (reads) | api `…/platforms/*`; hooks Get `…/platforms/*/app*`; money Get `…/platforms/*` |
| `cf-prod/platforms/bank/token-{linkId}` | `cf-prod-hooks` (callback: create or put) | `cf-prod-money`, `cf-prod-api` (stop, forget) | hooks `…/platforms/*/token*`; money Get `…/platforms/*`; api `…/platforms/*` (delete) |

No IAM change. `cf-prod-money` never writes a bank secret, so its `…/token-*` write grant is unused here.
`docs/SECURITY.md` lists both secrets (builder BD).

**Live**: `cf-prod-broadcast`'s `TYPES` gain `BANKCONN`, `BANKLINK#`, `DEPOSIT#` and `BANKPAYERS`, each → `{type: "bank",
op: "upsert", id: "bank", partial: true}` (no item rides along; the existing folding merges a run's many `DEPOSIT#`
records into one). The realtime stream filter gains the four prefixes, in place. The web's `lib/bank.ts` reads `GET
/v1/getpaid/bank` again (debounced 1 s) on `bank` events, on the window coming back into focus while a connect is
waiting, and after each of his own changes.

**Notifications** (§32; `cf-prod-notify`; under `notify.getPaid`, default on, so Settings gets no new switch). At the
end of a run that found something to tell, the reader sets `BANKCONN.lastNotice` = `{key (the run's time), reached:
[{depositId, place, amountMinor, exponent, currency}] (at most 3, only rows that aren't `quiet`), reachedMore (n), asks
(n new `needs_you` rows that aren't `quiet`), expiring: [{linkId, bank, days, consentUntil}], ended: [{linkId, bank,
endedAt}]}`. The notify stream filter gains `BANKCONN` (MODIFY only, in place); `push/notify.py` sends each event below
once, when `lastNotice.key` changed (a conditional put on `NOTIFIED#getpaid#bank:{key}`, 30-day `ttl`). Title "Clip
Factory". Never a link, a secret, an account number or the bank's text in a message; amounts are written by
`money_words`, like Whop's ("412.00 SEK").

| Event key | When | Body | `url` |
|---|---|---|---|
| `reached:{depositId}` | `reached` has one row | "Money reached your bank from YouTube: 1,234.56 SEK." (`meta`: "from Meta (Instagram and Facebook)") | `/money` |
| `reached:{first depositId}` | more than one | "Money reached your bank from YouTube and X. Tap to see how much." | `/money` |
| `ask:{yyyy-mm-dd}` | `asks` > 0 (once a day at most) | "Your bank got money that may be from an app. Tap to say where it's from." | `/settings/posting/getpaid/bank` |
| `expiring:{linkId}:{consentUntil}` | each `expiring` | "Reconnect your bank in 7 days. Tap here, then use BankID." ("in 1 day" when 1) | `/settings/posting/getpaid/bank` |
| `ended:{linkId}:{endedAt}` | each `ended` | "Your bank link ended. Tap here to reconnect with BankID." | `/settings/posting/getpaid/bank` |

**Infra** (builder BR; additive, in place): `infra/modules/realtime/main.tf` (+4 prefixes), `infra/modules/notify/main.tf`
(+`BANKCONN`), and `bank_reading_enabled` (bool, default `false`) through `infra/modules/api` and `infra/envs/prod` to
`BANK_READING = "on" | "off"` on `cf-prod-api`. No new Lambda, table, index, bucket, route, role, IAM statement or
Terraform secret. The prod plan: 0 to destroy, 0 to replace.

**The switch.** `bank_reading_enabled` stays `false` until BA, BR, BW and BD have all merged. Then one PR, "Get paid:
switch on Your bank" (`feature/bank-switch-on`), sets its default to `true` in `infra/envs/prod/variables.tf` (with
its description) and updates `infra/envs/prod/tests/wiring.tftest.hcl`. Turning it off again is the same one line, and
every stored item and secret stays.

**Mock mode** (`VITE_MOCK=1`, `web/src/api/mock/bank.ts`, builder BW): `on: true`, nothing set up. "Make my bank key"
gives a short fake public key (`-----BEGIN PUBLIC KEY-----` / `MOCK…`). Any UUID saves with `not_active`; "I linked
them" gives `ok`. The bank list has 12 Swedish bank names. A connect goes to a pretend page ("This is a pretend bank
page. Tap Allow.") and back with `?result=bank_connected`. The first read then gives one link (Swedbank, 143 days)
and four rows: a YouTube payout match (kr 1 234,56 on 28 Oct, matching 21 Oct), a `needs_you` Google kr 85,00, a
`needs_you` Stripe kr 321,70 suggesting X, and a Meta payer match kr 912,40. `?mockBank=ending` (9 days),
`?mockBank=ended`, `?mockBank=stopped_at_bank`, `?mockBank=none_yet` and `?mockBank=off` set the other states. Answers
change the mock in memory.

#### 40.5.12 Changes to earlier sections, and who builds what

**Changes to earlier sections** (each "old → new"; the builder named carries it out):
1. §40 and §40.1 words (this PR): "the owner's choice of bank source, §40.5, is still open" and "That part waits for
   his choice (§40.5)" → the bank part is §40.5 (option A), behind `BANK_READING`; the names list's "Money his bank
   booked (§40.5 only)" → "(§40.5)"; the Your bank card's "no button until the owner chooses a bank source" → "no
   button while `BANK_READING` is off; on, one big tap to the bank page (§40.5.2)".
2. §40.1 item 1 (BW): the Your bank card's states (§40.5.2 item 1).
3. §40.1 item 2 and §40.4 (BW): the place page's "Reached your bank" line and the pairs on `PayoutRow`s.
4. §40.4 "Where it shows" (BW): under "Sent to your bank, so far", `moneyLine` replaces `BANK_TEXT` while the Reached
   your bank block shows. The server's `sent.bankText` keeps `BANK_TEXT` (§40.7's golden files don't change).
5. §14.2 / §40.7 Live (BR): + the `bank` event and its four prefixes.
6. §17.5 (BA): the callback also serves `bank` (`CALLBACK_ONLY`), to the bank page.
7. §25.6 (BR): `cf-prod-money` gains the event `{"action": "bank", …}`, and `run_user` reads the bank after the payouts.
8. §32 / §40.7 notifications (BR): + the bank events under `notify.getPaid`; the notify filter + `BANKCONN`.
9. §15 Settings search (BW): the Get paid branch gains the apple `getpaid-bank` "Your bank", leaf "See which app money
   reached your bank.", words "bankid", "enable banking", "reached your bank", "reconnect bank", "bank link".
10. §40.8 "Not verified live", Bank (this PR) → §40.5.14.

| Builder | Branch | Owns |
|---|---|---|
| **BA** api | `feature/bank-api` | `api/src/clipfactory_api/bank/{__init__.py (sort keys, STEPS, words, places), keys.py, eb.py, grants.py, view.py, answers.py}` (new), `routes/bank.py` (new), `routes/__init__.py` (its rows, before `/v1/getpaid/{place}`), `hooks.py` (`bank` in `CALLBACK_ONLY`), `oauth/callback.py` (the `bank` hand-off), `app.py` (`BANK_READING` → `App.bank_reading`); tests `api/tests/{test_bank_keys.py, test_bank_eb.py, test_bank_grants.py, test_bank_view.py, test_bank_answers.py, test_bank_routes.py}` (new), `api/tests/bank_cases.py` writing `api/tests/fixtures/{bank_view_cases.json, bank_items.json, bank_steps.json}` (new), and its updates to `test_hooks.py` and `test_oauth_callback.py` |
| **BR** reader, live, notify, infra | `feature/bank-read` | `api/src/clipfactory_api/bankread/{__init__.py (the item keys and shapes of §40.5.11, written from this contract and checked against `bank_items.json` when present), client.py, filter.py, match.py, collect.py}` (new), `money/collect.py` (one call at the end of `run_user`, in its own try), `money/handler.py` (the `bank` action), `realtime/broadcast.py` (the four prefixes), `push/notify.py` (the `BANKCONN.lastNotice` events); `infra/modules/realtime/{main.tf, tests/websocket.tftest.hcl}`, `infra/modules/notify/{main.tf, tests/notify.tftest.hcl}`, `infra/modules/api/{main.tf, variables.tf, tests/api.tftest.hcl}`, `infra/envs/prod/{main.tf, variables.tf, tests/wiring.tftest.hcl}` (`bank_reading_enabled` only); tests `api/tests/{test_bankread_filter.py, test_bankread_match.py, test_bankread_client.py, test_bankread_collect.py, test_notify_bank.py}` (new), `api/tests/bankread_cases.py` writing `api/tests/fixtures/bank_match_cases.json` (new), and its updates to `test_realtime.py` and `test_money.py` (the `bank` handler action, the call in `run_user`); and, last of all, the switch PR |
| **BW** web and help | `feature/bank-web` | `web/src/getpaid/bank.ts` (new), `web/src/screens/getpaid/bank/{BankPage.tsx, BankSteps.tsx, BankKeyBox.tsx, BankPicker.tsx, BankLinks.tsx, BankAsks.tsx, BankMoney.tsx}` (new), `screens/getpaid/{GetPaidList.tsx (the Your bank card), SentRows.tsx (the place line and pairs)}`, `screens/money/AllMoney.tsx` (the block and `moneyLine`), `screens/settings/Settings.tsx` (the bank page in the Get paid branch), `app/App.tsx` (the route and title), `lib/{router.ts, backLink.ts ("Back to Get paid"), settingsTree.ts (the apple), bank.ts (new: the store, live refetch, the first-read call)}`, `api/{types.ts (every shape of §40.5.10), http.ts (the calls)}`, `api/mock/{bank.ts (new), index.ts}`, `styles/bank.css` (new); help `web/src/features/help/{helpKb.json, helpEvals.json}`: guides `bank-setup` "How do I see what reached my bank?", `bank-reached` "How much reached my bank?", `bank-ask` "Is this money from an app?", `bank-reconnect` "Why does my bank link end?", `bank-keeps` "What does Clip Factory keep from my bank?", `bank-enablebanking` "Is Enable Banking free for me?", one eval question each, highlighting only its own anchors (`getpaid-bank-card`, `getpaid-bank`, `bank-status`, `bank-steps`, `bank-links`, `bank-asks`, `bank-reached`, `bank-keeps`, `bank-picker`, `money-reached`); tests `web/test/{bank.test.tsx, bankGuide.test.ts}` (new) and updates to `getpaid.test.tsx`, `allMoney.test.tsx` (the drawing cases only), `backLink.test.ts`, `noGuesses.test.ts`, `settingsTree.test.ts`; `web/e2e/bank.spec.ts` (new) and updates to `screenshots.spec.ts` (`getpaid-bank`, `getpaid-bank-connected`, `getpaid-bank-asks`, `money-reached` at 375 and 1440); the generated files |
| **BD** docs | `docs/bank-docs` | `docs/SECURITY.md` (the two secrets, least data, the PSU headers, the terms conditions), `docs/SETUP_POSTING.md` (a "## Your bank" section: the steps in words and every source of 22 Nov 2026), `docs/ARCHITECTURE.md` (the connect and read flow), `docs/TESTING.md` (the bank tests and golden files), `docs/BUSINESS_REQUIREMENTS.md` (his ask and his choice of A), `web/public/legal/privacy.html` (what Clip Factory keeps from his bank, and that Enable Banking reads it); the generated files |

* **Shared contracts nobody changes alone**: this sub-section's words and sentences; the step ids, roles and autos;
  the statuses, pills, tones and `next`; the check codes and result codes; the JWT claims; the secret names and JSON
  shapes; the items and their attributes; the `depositId` and `payerKey` inputs; the hint list; the test ceilings; the
  matching rules and their order; the answers; the routes and `BankView`; the live event; the notice and the
  notification words; `BANK_READING`; the anchors (BW adds them); the golden files (BA writes `bank_view_cases.json`,
  `bank_items.json` and `bank_steps.json`; BR writes `bank_match_cases.json`; each reads the other's when present).
* **Merge order: BA, BR, BW and BD in any order, then the switch.** All four start at once from this contract, and
  each PR passes CI alone on top of main:
  * **BA without BR**: links are made, but nothing reads them. They stay `checking`, with "Clip Factory couldn't read
    Swedbank yet. It tries again tomorrow." after 26 hours, never a number. Prod never gets there, because the switch
    is off.
  * **BR without BA**: the reader finds no `BANKLINK#` and does nothing. The broadcast mapping and notify events wait
    for items nobody writes yet; the api env var is read by nobody.
  * BA and BR meet only through items, secrets and the golden files, never through each other's code. That is why
    the Enable Banking calls are split by side (`bank/eb.py` for setup and connect, `bankread/client.py` for reading),
    each signing the JWT of §40.5.4, as §40's K and L each called Whop.
  * **BW without BA**: the prod API answers 404, and every screen keeps today's words (`BANK_TEXT`); CI runs against
    the mock. BW owns the web types, so nothing waits for BA.
  * **BD** touches words only.
  * Generated files: BW and BD run `node scripts/help-corpus.mjs --write-docs` and `node scripts/ask-knowledge.mjs`
    from `web/`. On a conflict, take main's copy and run both again.
* Commits end with the paragraph "Area: Get paid".

#### 40.5.13 Tests (offline, fakes only: no AWS, no Enable Banking, no bank, no network)

* **api (BA)**, pytest:
  * keys: the key pair, the certificate, the 10-year expiry, `hashKey` made once and kept on `again`, `again`
    refused while a link is connected, the .pem file name and content rules, a 1024-bit key refused, `BANKOWNER` and
    the 403;
  * eb: the JWT's header and body, base64url, and a signature that verifies with the public key; the
    `api.enablebanking.com` host only; every check code;
  * grants: the state carries `platform "bank"`; `POST /auth` holds `psu_type "personal"`, `balances: false`, the
    capped `valid_until`, `transactions_extended_history` from `history`, and no `credentials` or `auth_method`; a
    reused state writes nothing; every result code; **ORGA accounts dropped**; names, IBANs and addresses in the
    fake's answer appear in no item, secret, log line or redirect; a reconnect deletes the old session after the new
    secret is written; `/hooks/bank` is 404;
  * `bank_view_cases.json`: totals per place per currency, never across; `meta` shown on its own and counted in
    Instagram's and Facebook's `metaAmounts`; `needs_you`, `notSure` and `not_income` never counted; `notYet`, `since`,
    `empty`, `needYou`; never $0; every status, pill and line; the worst-link order; `daysLeft` and `ending_soon` at
    14 days; `next` for every step (step 4's `vermilion: false`) and for a reconnect; the autos; the ring of 7;
    `pairs`; `places` in all three states;
  * answers: every row of §40.5.8's answers table, learning, the shared hints never learned, the same `payerKey`
    matched at once, `not_this` freeing the payout into `notPayout`, the 409s, no amount ever changed;
  * routes: the 503s while off and `{on: false}`; the 403; the Check now limits (15 minutes, 12 a day, the `first`
    pass once per link); the async payload with `psu` that is never stored or logged; Stop and Forget (the secret
    deleted, deposits kept on Stop, the app key kept on Forget); no secret, session id, uid, hash, `payerKey` or IP in
    any answer.
* **api (BR)**, pytest:
  * client: the JWT; the PSU headers all or none; a bank with no `psuHeaders` counted unattended; at most 3 unattended
    reads a day; the 6-hour `limitUntil`; every error row of §40.5.6;
  * filter: CRDT/BOOK only, re-checked; negative and zero amounts, bad currencies, too many decimals and floats
    refused; `norm`, the hints and their order, `shared`, `payerKey` with digits ignored; `depositId` from
    `entry_reference`, the fallback for missing and repeated references, and the same ids after a reconnect with new
    uids;
  * **`bank_match_cases.json`** (golden): a YouTube SEK payout matched within 10 workdays, and the same amount on day
    11 asked about; the Google test deposit (SEK 4.12) dropped and not stored; a Google SEK 85.00 with no record asked
    about; Whop USD 40.00 → SEK 412.30 with WHOP asked about; a Whop trace code matched at any amount; a learned Meta
    payer matched; STRIPE asked about every time, suggesting X; PayPal in the bank with a PayPal link → `own_move`; a
    debit, a PDNG, a negative CRDT and a salary dropped; one payout, two candidates (the first by date wins); `notPayout`
    respected; a `notIncome` payer dropped; `XXX` and `1234.567` dropped; a stored `needs_you` matched on a later run
    once its payout appears; his answer during a run wins; the first read is `quiet`;
  * collect: `longest` from today − 400 days on the first read; `default` with the 10-day overlap afterwards; a
    reconnect after a gap uses `longest` within the hour; continuation pages with the same parameters; an empty page
    with a key; the time budget's `resume` and `WRONG_CONTINUATION_KEY`; every end (`ended`, `stopped_at_bank`,
    `consent_over` and `ended_early`); writes conditional on `connected`; nothing ever deleted; the 7-day `warnedFor`;
    `lastNotice` built only from rows that aren't quiet; **a leak test**: a fake page full of names, IBANs, texts and
    other people's payments leaves only §40.5.7's attributes in every item, and nothing of it in any log line;
    `bankread.collect.run` raising never stops `run_user`; the `bank` handler action; no `BANKLINK#` → no call at all;
  * notify: each event once, none for quiet rows, none with `getPaid` off, the exact bodies; realtime: the four
    prefixes → `bank`, partial;
  * `terraform test`: the filters change in place; `bank_reading_enabled` defaults to `false` → `BANK_READING =
    "off"`, and `true` → `"on"`; nothing replaced.
* **web (BW)**, Vitest:
  * the guide's ids, roles and autos equal `bank_steps.json` (when present); every title 6 words or fewer, every line
    26 words or fewer; https Opens (the one `mailto:` aside); bold only for Enable Banking's labels;
  * every pill's words, tone and icon (never colour alone); none says "Live", "Connected", "Not connected" or
    "disconnected";
  * **one vermilion per screen**: step 4 has none; a reconnect's is in the status block; question cards' answers are
    green or glass; the list card and Money's block have none;
  * the key box: the App ID format check, the .pem upload and paste, nothing kept in state after a send; the check's
    sentences and the result sentences word for word;
  * the picker's order and search; Stop with the 8 s Undo sending nothing until the toast ends; Forget the same;
  * question cards: suggested, none and `own_move` layouts, the place sheet, "Not sure yet", Undo sending `not_this`;
  * the Money block: per place, per currency, totals, `notYet`, `empty`, never $0, never added to the 30-day total,
    `moneyLine` replacing `BANK_TEXT` only with a link; the place lines and pairs;
  * `on: false` and a 404 both keep today's words exactly; `lib/bank.ts` refetches on `bank` events; the first-read
    call is sent once; `noGuesses` over the new files (amounts only formatted); `backLink`; the settings apple.
* **web (BW)**, Playwright (mock mode, 375×812 and 1440×900, the `tap()` counter of `web/e2e/flows.ts`): Clip
  Factory's own taps per step equal §40.5.3's CF counts (15 without the email, 17 with it); the ways in (4 from
  Settings, 2 from Money); Connect and every result; reconnect at 9 days; a question answered with 1 tap and with 2.
  Every new screen: no sideways scroll at 320–1920, no edges, targets of 44 px or more (48 on phones), the arrow
  cursor only, axe contrast in light and dark, reduced motion, phone controls bottom right, Ask never over the main
  button.
* **docs (BD)**: `help-corpus.mjs --check` and `ask-knowledge.mjs --check`.

#### 40.5.14 Not verified live (each is checked at his first connect; a failure becomes a plain sentence, never a number)

* Whether Enable Banking calls creator income on a personal account "personal use", and whether it minds a daily
  automated read (the optional email asks).
* Which bank and accounts get his payouts; whether PayPal is one; whether any of them is a business account (it would
  be dropped).
* Redirect address rules (exact match, query strings): the check compares the exact string, and `redirect_missing`
  says what to fix.
* Whether **Public certificate in PEM format** takes the bare public key (Enable Banking's own browser path uploads
  one) or wants the certificate (the second Copy chip); whether an expired certificate stops tokens working (Clip
  Factory's lasts 10 years).
* Which errors a wrong app ID and a wrong key give (`not_found` vs `key_wrong`).
* Whether Control Panel links ever expire, or need linking again after an account number changes; the real limit of
  linked accounts per app.
* The payer names and texts his bank shows for AdSense for YouTube, Meta, TikTok (or PayPal), Stripe (X) and Whop
  payouts: the hint list is a first guess, and a payout whose text names no platform is never seen. If that happens,
  the place line keeps "Nothing from Instagram reached your bank yet.", and the fix is a new hint word in a later PR.
  Enable Banking's Data Insights (his login) shows how often each field is filled.
* What PayPal gives through Enable Banking: the payer's name, a currency per row, `XXX` for its account currency.
* How Google writes a SEK `Payment.amount` (§40.4), on which the exact payout match depends; whether Google's payment
  date is the day it sends.
* Whether Whop's `traceCode` shows in the bank's text.
* The authorization code's lifetime; whether his bank allows more than one session per person (another app reading
  the same bank could end Clip Factory's link early).
* Whether `transactions_extended_history: true` adds a second BankID on a new link at his bank.
* The sign-in page's button words and Enable Banking's own page before the bank (never seen, so no bold).

### 40.6 New permissions and connections

**YouTube: "Allow payment reading"** (`yt-reading`, K for the grant, L for the reads).
* Scope `https://www.googleapis.com/auth/adsense.readonly` ("View your AdSense data"). It is not a restricted scope; the
  owner's External, "In production", unverified Google Cloud app shows Google's unverified-app screen, as Allow money
  reading does (§25.4). `config/platforms.json` youtube gains `"paymentScopes":
  ["https://www.googleapis.com/auth/adsense.readonly"]`; `scopes` (Connect) and `moneyScopes` are unchanged, so Connect
  never asks for it.
* The grant must come from the Google account that owns AdSense for YouTube, which can be another Google account than
  the YouTube one. So it is its **own connection** (`PAYCONN#adsense`, its own token), never merged into the YouTube
  connection: it never touches `ACCOUNT#youtube`, the YouTube token, `SETUP#youtube` or `MONEYSTATE#youtube`, and
  Clip Factory never compares the two Google accounts.
* `POST /v1/accounts/youtube/connect {"grant": "payments"}` (409 "Paste your YouTube keys first. Tap Set up YouTube."
  without saved YouTube keys, and the page adds a glass "Set up YouTube" → `/settings/posting/setup/youtube?back=
  /settings/posting/getpaid/youtube`; YouTube need not be connected): the authorize URL of §17.4 for YouTube with
  `scope=https://www.googleapis.com/auth/adsense.readonly`, `access_type=offline`, `prompt=consent select_account`,
  PKCE as §17.4, and **no** `include_granted_scopes` (the token carries the AdSense scope only, even for the same
  Google account). The `OAUTH#` state item carries `grant: "payments"`. Same YouTube keys and redirect URI: nothing new
  in Google Cloud except the API and the scope of the reading step.
* The callback (`oauth/callback.py`) hands a `payments` grant to `getpaid.grants.save_payments_grant()`, never
  `save()` or `save_money_grant()`: (1) `getpaid/grants.py` exchanges the code itself, posting to `GOOGLE_TOKEN`
  (`code`, `client_id`, `client_secret`, `redirect_uri`, `grant_type=authorization_code`, `code_verifier` from
  `state.pkce`), **never through `providers.exchange()`** (its `_youtube()` demands the Connect scopes and reads
  `channels?mine=true`, which an AdSense-only token always fails); a refused, failed or reused code writes nothing
  (`payments_denied`, `payments_error`); (2) only `adsense.readonly` is checked in the answer's `scope`: missing →
  `payments_missing`, nothing written; (3) `GET https://adsense.googleapis.com/v2/accounts` with the new token: 403
  with `accessNotConfigured` **or** `details[].reason` `SERVICE_DISABLED` → `payments_api_off`; 200 with no
  `accounts`, or any other 403 → `payments_no_account`; nothing written in either; (4) the secret
  `cf-prod/platforms/adsense/token` is written (create or put): `{accessToken, expiresAt, refreshToken, scope,
  clientId, accounts: ["accounts/pub-…"]}` (`clientId` = the YouTube app key it was made with); (5) one UpdateItem on
  `PAYCONN#adsense`: `type "payconn"`,
  `source "adsense"`, `status "connected"`, `accounts [{name, displayName}]` (at most 5), `connectedAt`
  (`if_not_exists`), `scopes`, `lastResult`, `updatedAt`, REMOVE `reason`. Then the redirect
  `/settings/posting/getpaid/youtube?result={payments_allowed | payments_denied | payments_missing |
  payments_no_account | payments_api_off | payments_error}`; the page shows the sentence, removes the query and starts
  a Check now. The sentences (exact; M's tests check them):

  | `result` | Sentence |
  |---|---|
  | `payments_allowed` | "Clip Factory can see your YouTube payments now. It checks once a day." |
  | `payments_denied` | "You didn't allow it. Tap Allow payment reading to try again." |
  | `payments_missing` | "Tick **View your AdSense data** on Google's page. Then tap Allow payment reading again." |
  | `payments_no_account` | "That Google account has no AdSense for YouTube. Tap Allow payment reading again and pick the Google account that has it. Still no luck? Skip this step. Your ticks still work." |
  | `payments_api_off` | "Tap Turn on AdSense reading, then **Enable**. Then tap Allow payment reading again." |
  | `payments_error` | "Something went wrong. Tap Allow payment reading again." |
* Refresh (L, `cf-prod-money`): Google's refresh token doesn't rotate, so no lease; with the YouTube app keys, when the
  access token is due; the new access token is written back put-only. Before refreshing, L compares the secret's
  `clientId` with `cf-prod/platforms/youtube/app`; a different one, or Google's `invalid_client` /
  `unauthorized_client`, → `PAYCONN#adsense` `needs_reconnect` `reason "keys_changed"`; `invalid_grant` (revoked, or
  unused for 6 months) → `reason "token_dead"`. Nothing is deleted; the card and the YouTube page say "Clip Factory
  can't see YouTube payments anymore. Tap Allow payment reading again." (the button is `next` only when nothing else
  is next, §40.2; otherwise glass).
* "Stop payment reading" (glass, 8 s toast "Stopping payment reading… Undo"; `DELETE /v1/getpaid/connections/adsense`
  when the toast ends): delete `cf-prod/platforms/adsense/token` and set `PAYCONN#adsense` `not_connected`. **No call
  to Google's revoke endpoint**: Google's revoke ends every scope the user gave the app, so when the AdSense Google
  account is the YouTube one it would also end the YouTube posting and money connection. `PAYSTATE#youtube` and every
  `PAYOUT#youtube#…` stay: they are records of real money ("Clip Factory stopped reading on 3 Dec."); after a stop the
  `PAYSTATE#` is no longer fresh, so nothing on screen is built from it. YouTube's Disconnect (§25.6) revokes at
  Google as today: when it is the same Google account, payment reading then gets `invalid_grant` → `needs_reconnect`
  `token_dead`, and nothing is deleted. YouTube's `forget` never touches `PAYSTATE#` or `PAYOUT#`.

**Content Rewards: "Connect Whop"** (optional; the card **See your Whop payouts here** on the Content Rewards Get paid
page; behind the api switch `WHOP_CONNECT`, from Terraform `whop_connect_enabled`, **default `false`**: while off the
card says "Coming soon: your Whop payouts here." with no button, `connections.whop` is `null` and the Whop routes
answer 503 `unavailable` "Coming soon.").
* Whop's sign-in is OAuth 2.1 + PKCE (S256) with public clients (`token_endpoint_auth_method` `none`) at
  `https://api.whop.com/oauth/`, and an app needs a `client_id` made in Whop's Developer Dashboard with exact redirect
  URIs. So, like every platform of §17, the owner makes his own Whop app once (no secret: a public client):
  * step `whop-key` "Make your Whop key" (inside the card, not numbered; ticks itself when the key is saved): Open
    "Open Whop's developer page" → `https://whop.com/dashboard/developer`. "Tap **Create app**. Name it:" Copy chip
    "Clip Factory". "Find **OAuth**. Paste this in **Redirect URIs**:" Copy chip `GetPaid.connections.whop.redirectUri`
    (`{HOOKS_URL}/oauth/whop/callback`). "Tick **user:balance:read**, **payout:withdrawal:read**,
    **payout:destination:read** and **identity:read**." "Tap **Save**. Copy the **Client ID**. It starts with app_."
    Paste box "Whop key" (`^app_[A-Za-z0-9]{4,64}$`, friendly 400 "Your Whop key starts with app_."), "Save key".
    "Whop may show this a little differently. Look for the same words." If you see: Whop asks for a company first →
    "Make one. Any name is fine. It's free."
  * then the card's "Connect Whop" (glass, except when the page's `next` is `null`, §40.1 item 2).
* `PUT /v1/getpaid/whop/key {"clientId"}` → secret `cf-prod/platforms/whop/app` `{clientId, userId, savedAt}`;
  `PAYCONN#whop` `status "keys_saved"`, `keyHint` (first 6 + "…" + last 4). A different `clientId` while connected
  deletes the token secret (it belongs to the old app) and sets `keys_saved`, `reason "keys_changed"`.
* `POST /v1/getpaid/whop/connect` (409 "Save your Whop key first."): the authorize URL from Whop's OIDC metadata
  (`https://api.whop.com/.well-known/openid-configuration`, read by the API and cached for a day; the browser never
  calls Whop): `{authorization_endpoint}?response_type=code&client_id&redirect_uri={HOOKS_URL}/oauth/whop/callback&
  scope=openid user:balance:read payout:withdrawal:read payout:destination:read identity:read&state&code_challenge&
  code_challenge_method=S256`; the state and PKCE verifier as §17.4 (`OAUTH#{nonce}`, `platform: "whop"`). Clip
  Factory never asks for `payout:withdraw_funds`, `admin` or any write scope: it never moves money.
* `GET /oauth/whop/callback` (hooks; `whop` joins `HOOK_PLATFORMS` for this resource only, never `/hooks/{platform}`)
  → `getpaid.grants.save_whop_grant()`: the token exchange (public client: `client_id`, `code_verifier`, no secret);
  a scope missing → `whop_missing`, nothing written; `GET https://api.whop.com/api/v1/users/me` (the `user_` id and
  username); the secret `cf-prod/platforms/whop/token` `{accessToken, expiresAt, refreshToken, scope, whopUserId}`;
  one UpdateItem on `PAYCONN#whop` (`status "connected"`, `accountId`, `accountName` "@name", `connectedAt`,
  `scopes`, `tokenVersionId`, `lastResult`); redirect `/settings/posting/getpaid/contentrewards?result={whop_connected |
  whop_denied | whop_missing | whop_expired | whop_error}#whop`. The sentences (exact; never "Connected"):

  | `result` | Sentence |
  |---|---|
  | `whop_connected` | "Clip Factory can see your Whop payouts now (@name)." |
  | `whop_denied` | "You didn't allow it. Tap Connect Whop to try again." |
  | `whop_missing` | "Tick all four boxes in your Whop app. Then tap Connect Whop." |
  | `whop_expired` | "That took too long. Tap Connect Whop again." |
  | `whop_error` | "Whop didn't answer. Tap Connect Whop again in a few minutes." |
* Every call to Whop's API (L's reads and K's `users/me`) sends `Api-Version-Date: 2026-11-20` (Whop's payout
  statuses `in_review` and `denied` need 2026-08-21 or later); the Whop fakes refuse a call without it.
* Tokens: access tokens last 1 hour and the refresh token rotates on every use, so L's `payouts/whoptokens.py` keeps
  §38.9's `CrTokens` rules: one lease on `PAYCONN#whop` (`refreshLeaseUntil`), a put-only write checked against
  `tokenVersionId`, the same refresh token once more after a network error or 5xx, `Retry-After` on 429; `invalid_grant`
  → `needs_reconnect` `reason "token_dead"` ("Sign in to Whop again to see your payouts." + "Connect Whop"), never a
  delete. Which balance Content Rewards pays (his personal `user_` balance or a `biz_` business) is not known: L reads
  his own (`user_id`) and only notes owned businesses (§40.2 `seen`).
* "Stop reading Whop" (glass, 8 s Undo; `DELETE /v1/getpaid/connections/whop`): revoke at the metadata's
  `revocation_endpoint` when there is one (best effort), delete the token secret, keep the app key, `keys_saved`.
  Every `PAYOUT#contentrewards#…` stays.

**Where every new secret lives** (Secrets Manager only; never DynamoDB, logs, responses, URLs or the browser; created at
runtime with `CreateSecret` and tags `app=cf-prod`, `platform`; never in Terraform, so a deploy can't touch them):

| Secret | Written by | Read by | Covered by today's IAM |
|---|---|---|---|
| `cf-prod/platforms/adsense/token` | `cf-prod-hooks` (callback; create or put), `cf-prod-money` (refresh, put) | `cf-prod-money` | hooks `…/platforms/*/token*`; money Get `…/platforms/*`, Put `…/platforms/*/token-*`; api (delete) `…/platforms/*` |
| `cf-prod/platforms/whop/app` | `cf-prod-api` (key) | `cf-prod-hooks` (callback), `cf-prod-api` (connect), `cf-prod-money` | api `…/platforms/*`; hooks Get `…/platforms/*/app*`; money Get `…/platforms/*` |
| `cf-prod/platforms/whop/token` | `cf-prod-hooks` (callback), `cf-prod-money` (rotation, put) | `cf-prod-money` | as the AdSense token |

No IAM change, no new secret in Terraform. `docs/SECURITY.md` lists the three (N).

### 40.7 API, data, checking, live and notifications

**Routes** (all JWT, §5 errors, under `ANY /v1/{proxy+}`; `routes/getpaid.py`, package `clipfactory_api/getpaid/`):

| Method & path | Body | 2xx response |
|---|---|---|
| GET `/v1/getpaid` | – | `GetPaid` (also registers the owner in `MONEYOWNERS`, like `GET /v1/money`) |
| GET `/v1/getpaid/{place}` | – | `{ "card": GetPaidCard, "payouts": PayoutRow[] }` (newest first, ≤ 36); 404 for another place, or `contentrewards` while Content Rewards is off |
| PATCH `/v1/getpaid/steps` | `{ "step": id, "done": bool }` | `GetPaid`. 400 for an id not in `STEPS`, and for a `manual: false` step (`yt-reading`: "Tap Allow payment reading instead."); Content Rewards' ids → 400 "Tick Content Rewards steps on its own card."; at most 80 ticks; `meta-payout` is one tick for both Meta places |
| POST `/v1/accounts/youtube/connect` | `{ "grant": "payments" }` | `{ "authorizeUrl", "expiresAt" }` (§40.6) |
| DELETE `/v1/getpaid/connections/adsense` | – | `204` |
| PUT `/v1/getpaid/whop/key` | `{ "clientId" }` | `GetPaid` (503 while `WHOP_CONNECT` is off) |
| POST `/v1/getpaid/whop/connect` | – | `{ "authorizeUrl", "expiresAt" }` (409 without a key; 503 while off) |
| DELETE `/v1/getpaid/connections/whop` | – | `204` (503 while off) |
| POST `/v1/money/refresh` | – | unchanged (§25.5): "Check now" also reads AdSense and Whop |
| GET `/v1/money/everywhere` | – | `MoneyEverywhere` with the additive `places[].sent` and `sent` (§40.4) |

Every route reads stored items only (no platform, Whop or Google call), except the two connect routes (Whop's metadata)
and the deletes (revoke). No response carries a token, a client secret, a raw platform answer, a trace code or an
AdSense publisher id beyond its last 4.

```ts
type GetPaidPlace = Platform | "contentrewards";
type GetPaidStatus = "on_hold" | "not_allowed" | "can_get_paid" | "not_set_up" | "you_said_done" | "checking"
  | "not_connected" | "not_started";
type KnownBy = "youtube" | "whop" | "contentrewards" | "instagram" | "facebook" | "tiktok" | "x" | "rules" | "you"
  | "clipfactory";
interface GetPaid {
  places: GetPaidCard[];             // YouTube, TikTok, Instagram, Facebook, X, then Content Rewards while it is on
  summary: string; country: string | null;
  connections: { adsense: PayConn; whop: PayConn | null };   // whop: null while WHOP_CONNECT is off
  stepsDone: string[];               // GETPAID ticks (Content Rewards' stay on CRCONN)
  nextCheckAllowedAt?: string; asOf: string;
}
interface GetPaidCard {
  place: GetPaidPlace; name: string;
  status: GetPaidStatus; pill: string /* "Can get paid ✓ (YouTube says)" */;
  tone: "success" | "neutral" | "warn" | "error";
  knownBy: KnownBy; known: string /* "YouTube says" | "You said it's done" | "Your steps" | "Instagram's rules" */;
  line: string; missing: string[]; holds: string[]; warning?: string /* X only */;
  readingChip?: string;              // "Clip Factory can see payments: on" | "… off" (YouTube; Content Rewards while WHOP_CONNECT is on)
  next: { stepId: string | null; label: string; href: string; external: boolean;
          text?: string /* "Next: step 3, Add your bank" */; hint?: string /* HOLD_FIX's line */;
          vermilion: boolean /* false for a paid step */ } | null;
  steps: { id: string; done: boolean; by: "you" | "auto" | null; auto?: string /* "YouTube says you're in" */ }[];
  ring: { done: number; total: number };
  seen: string[];                    // "What Clip Factory can see", ≤ 6
  sent: SentLine;
  unpaid?: { text: string /* Google's own words */; note: string };   // YouTube only
  checkedAt?: string; lastError?: string;
}
interface SentLine {
  state: "number" | "none_yet" | "not_available" | "needs_reading" | "checking" | "error";
  headline: string;                  // "Sent to your bank by Google" | "Not available from TikTok" | …
  amounts: { currency: string; amountMicros: number }[];   // "number" only; never converted
  tag?: string /* "YouTube says" */; why?: string; notAdded?: string; arrive?: string; note?: string;
  last?: { date: string; amountMicros: number | null; currency: string | null; text?: string };
  where?: { text: string; button?: { label: string; url: string } };
  button?: { label: string; href: string; external: boolean };
}
interface PayoutRow {
  date: string; by: "Google" | "Whop";
  state: "sent" | "on_its_way" | "didnt_go_through" | "came_back" | "gone";
  amountMicros: number | null; currency: string | null;
  text?: string;                     // Google's own words when Clip Factory couldn't read the money type
  arriveBy?: string;                 // Whop's estimated_arrival
}
interface PayConn {
  source: "adsense" | "whop"; status: "not_connected" | "keys_saved" | "connected" | "needs_reconnect";
  accountName?: string /* "Main AdSense (…1234)" | "@name" */; connectedAt?: string;
  reason?: "token_dead" | "keys_changed"; keyHint?: string; redirectUri?: string /* whop only */; lastResult?: string;
}
// MoneyEverywhere (§39.2), additive:
interface MoneyPlace { /* … */ sent?: SentLine }
interface MoneyEverywhere { /* … */ sent?: { totals: { currency: string; amountMicros: number; places: MoneyPlaceId[];
    names: string /* "YouTube" | "Whop (all your Whop money, Content Rewards too)" */ }[];
  tag: string; notAdded?: string; notCountedText?: string; bankText: string; empty?: string /* only with no sent rows */ } }
```

`getpaid/status.py` `card(place, inputs, now) -> GetPaidCard` and `getpaid/sent.py` `sent_line(place, rows, conn,
state)`, `sent_totals(lines)`, `parse_amount(text)` are pure (golden cases); `getpaid/view.py` `load(store, user_id,
now, *, cr_on, whop_on)` reads the items below plus `ACCOUNT#`, `MONEYSTATE#`, `MONEYPREFS`, `CRCONN`, `CRMONEY`,
and `money/everywhere.py` calls `sent.sent_line` for each place.

**Data** (additive only: new sort keys under the owner's partition and new attributes; no table, index, bucket,
Lambda or Terraform-made secret; every write an UpdateItem or a conditional PutItem):

| Item | Attributes | Written by |
|---|---|---|
| `GETPAID` | `type "getpaid"`, `stepsDone` (string set, ≤ 80), `updatedAt` | api (PATCH) |
| `PAYCONN#adsense`, `PAYCONN#whop` | `type "payconn"`, `source`, `status`, `accounts`/`accountId`, `accountName`, `connectedAt`, `scopes`, `lastResult`, `reason`, `keyHint` (whop), `tokenVersionId` and `refreshLeaseUntil` (internal), `updatedAt` | hooks (grants), api (key, stop), money (lease, `needs_reconnect`) |
| `PAYSTATE#youtube` | `type "paystate"`, `place`, `source "adsense"`, `accounts [{name, displayName, state, pendingTasks}]`, `holds [{type, severity, text, since}]`, `alerts` (≤ 10 others, plain text ≤ 300), `unpaid {text}`, `lastSent {sk, date, text}`, `holdSince`, `firstReadDone`, `lastCheckedAt`, `lastError` | money |
| `PAYSTATE#contentrewards` | `source "whop"`, `kyc` (`not_started`, `pending`, `approved`, `rejected`, `unknown`), `methods {created, active, broken, ready, currencies}` (`ready`: `created` or `active` with `bank_verification_state` not `pending`/`failed`), `lastPaidOutAt`, `businesses` (bool), `hold {kind, since}`, `lastSent {sk, date, amountMicros, currency}`, `payoutsMark` (internal), `firstReadDone`, `lastCheckedAt`, `lastError` | money |
| `PAYOUT#youtube#{yyyy-mm-dd}#{last 4 of the publisher id}` | `type "payout"`, `place`, `by "google"`, `source "adsense.payments"`, `account` (last 4), `date`, `amountText`, `state` (`sent`/`gone`), `fetchedAt`, `revisedAt`, `goneAt` | money |
| `PAYOUT#contentrewards#{yyyy-mm-dd}#{payoutId}` | `by "whop"`, `source "whop.payouts"`, `payoutId`, `status` (Whop's), `state`, `date`, `amountMicros`, `currency`, `estimatedArrival`, `traceCode` (internal), `fetchedAt`, `updatedAt` | money |
| Settings | `notify.getPaid` (bool, default `true`) | api |
| api env | `WHOP_CONNECT` from `whop_connect_enabled` (default `false`): an in-place env change | Terraform |

Nothing deletes a `PAYOUT#` or `PAYSTATE#` item (the money role has no DeleteItem); a stopped connection keeps them.

**Checking** (L; no new schedule, Lambda or role): `cf-prod-money`'s daily run (06:00 UTC) and "Check now" (§25.6, at
most once an hour) call `payouts.collect.run(deps, user_id, now)` after the five platforms, inside its own try so it
can never stop the money run, and skipped when less than 20 s of the time budget is left. AdSense (when
`PAYCONN#adsense` is connected): `accounts.list` (1), then per account (≤ 2) `alerts.list?languageCode=en` (1) and
`payments.list` (1): at most 5 calls a run (quota 10,000 a day, 100 a minute). Whop (when `PAYCONN#whop` is
connected): `GET /users/me` (1), `GET /payouts/methods?user_id=` (1), `GET /payouts?user_id=&created_after=` (from
`payoutsMark` minus 30 days, so status changes are seen; at most 5 pages a run). Each source on its own: an error sets
that `PAYSTATE#`'s `lastError` and keeps everything; 429 and 5xx wait for the next run. The first read after a grant
fills the old payments quietly and sets `firstReadDone` at its end (no notification for old money). Alert messages
(localised, may hold HTML) are stored as plain text ≤ 300 characters.

**Live**: `cf-prod-broadcast`'s `TYPES` gain `GETPAID`, `PAYCONN#`, `PAYSTATE#` and `PAYOUT#`, each →
`{ type: "getpaid", op: "upsert", id: "getpaid", partial: true }` (no item rides along; `LiveEvent` gains it). The
web's `lib/getPaid.ts` refetches `GET /v1/getpaid` (debounced 1 s) on `getpaid`, `setup` and `contentrewards` events
(a status also depends on `ACCOUNT#`, `CRCONN` and `CRMONEY`) and after any Content Rewards step PATCH (which answers
with the Content Rewards connection, not `GetPaid`); on Money it also refetches `GET /v1/money/everywhere`. The
realtime stream filter gains the four prefixes (the mapping's filter is updated in place).

**Notifications** (§32; `cf-prod-notify`, whose stream filter gains `PAYSTATE#`, MODIFY only, in place; choice
`notify.getPaid`, default on; Settings › App & account › Notifications gains the switch "Money on hold or sent to your
bank"). M shows that switch, and sends `getPaid` in the Settings PATCH, only when `me.settings.notify.getPaid` is a
boolean (the §38.19 rule: an older API refuses keys it doesn't know with 400). Once each (a conditional put on
`NOTIFIED#getpaid#{key}`, 30-day `ttl`), only when the old image had `firstReadDone`:

| Event | When | Body | `url` |
|---|---|---|---|
| `hold:youtube:{since}` | `PAYSTATE#youtube.holds` went from empty to not empty | "Your YouTube money is on hold. Tap to see why." | `/settings/posting/getpaid/youtube` |
| `hold:whop:{kind}:{since}` | `PAYSTATE#contentrewards.hold` appeared | "Whop can't send your money. Tap to see why." | `/settings/posting/getpaid/contentrewards` |
| `sent:{place}:{lastSent.sk}` | `lastSent` changed to a newer row | YouTube: "Money sent to your bank: Google sent kr 1 234,56 SEK. It arrives in up to 7 workdays." (Google's own text) · Whop: "Money sent to your bank: Whop sent $40.00." (Whop's amount; another currency is written with its code, "412.00 SEK") | `/money` |

Title "Clip Factory"; no link, secret or account number in a message.

**Infra** (L; additive, in place): `infra/modules/realtime/main.tf` (+4 prefixes), `infra/modules/notify/main.tf`
(+`PAYSTATE#`), `whop_connect_enabled` (bool, default `false`) through `infra/modules/api` and `infra/envs/prod` to
`WHOP_CONNECT = "on" | "off"`. No new Lambda, table, index, bucket, route, role or Terraform secret; IAM unchanged
(§40.6). The prod plan: 0 to destroy, 0 to replace; nothing that holds the owner's data or connections changes.

### 40.8 Changes to earlier sections, who builds what, tests, not verified live

**Changes to earlier sections** (each "old → new"; the builder named carries it out):
1. §25 the rule (K): "No API reports paid-out money: the app links to each platform's payout page instead." → "Two
   APIs report money sent toward the bank: AdSense `payments` (YouTube) and Whop `payouts` (Content Rewards' money
   after Whop). They show as "Sent to your bank by Google/Whop", tagged "YouTube says"/"Whop says" (§40.4); "paid",
   "received" and "actual" still never sit next to an amount; the other places link to their payout pages."
2. §25.2 `config/monetization.json` (K): the three fixes of §40.3.
3. §25.4 (K): `{ "grant": "money" }` only → `"money"` (YouTube, TikTok) or `"payments"` (YouTube, §40.6); the 400 says
   "grant can be "money" or "payments"."
4. §25.7 (M): the apple `money-payouts` "Getting your money out", leaf "Each app pays you itself. Add your bank or
   PayPal inside each app." → leaf "Each app pays you itself. Get paid shows the steps for each one.", href
   `/settings/posting/getpaid`; `PAYOUTS` (`lib/money.ts`) X "Connect Stripe in X › Monetization. X pays through
   Stripe." → "Connect Stripe in X › Creator Studio. X pays through Stripe." and its `where` "X › Monetization" → "X ›
   Creator Studio"; the mock money cards (`api/mock/money.ts`) follow §40.3's config fixes (X programme, status and
   paid where; TikTok status where).
5. §39.2 (K words, M screen): X's where line "Look in X, then Monetization (paid through Stripe)." → "Look in X, then
   Creator Studio (paid through Stripe)." (its "Open X" → `https://x.com/i/jf/creators/studio`); Content Rewards'
   small line "Paid out to your bank: not available from Content Rewards. Look on Whop: **Balances**." → the row's
   `sent` line "Sent to your bank: not available from Content Rewards. Look on Whop: **Balances**." (the words change:
   "Paid out to your bank" becomes "Sent to your bank"); All your money gains each row's `sent` line and the "Sent to
   your bank, so far" block (§40.4).
6. §27.4 / §39.2 the Money page (M): header, All your money, Apps band, Monthly … → header, All your money, **Get
   paid** (§40.1), Apps band, Monthly … (nothing removed).
7. §15 the Settings tree (M): Posting's branches "Set up posting, Where clips go, My settings, Money" → "Set up posting,
   **Get paid**, Where clips go, My settings, Money".
8. §17.1 a platform page's "When it's done" (M): + the glass "Get paid" link (§40.1 item 4).
9. §38.3 "When it's done" (M): "Get paid" (→ `/money#content-rewards`) → (→ `/settings/posting/getpaid/contentrewards`).
10. §32.3 (K): `notify` gains `getPaid: true`; the 400 sentence adds "money on hold or sent". §32.5 (L): the filter
    gains `PAYSTATE#`.
11. §14.2 / §17.4 Live (K types, L filter): + the `getpaid` event and its four prefixes.
12. §17.5 (K): the callback also serves `whop` and the YouTube `payments` grant.
13. §25 X's Premium signal (K, `money/sources.py`): `NOT_PREMIUM_TYPES` `{"None", "Basic"}` → `{"Basic"}`, so
    `subscription_type` `"None"` (which X also sends for the newer plans its field doesn't know) becomes `missing`
    "X didn't share this." instead of "no Premium"; `PREMIUM_TYPES` stays `Premium`, `PremiumPlus`, `PremiumBusiness`.
14. §38.7 `bank-setup` (M, `web/src/setup/contentrewards.ts`): + the two "If you see" hints of §40.1 (**Set up Whop
    Payments**; the business tax question). No other word or tick of §38.7 changes.

| Builder | Owns |
|---|---|
| K api (`feature/getpaid-api`) | `api/src/clipfactory_api/getpaid/{__init__.py, status.py, sent.py, view.py, grants.py}` (new), `routes/getpaid.py` (new), `routes/__init__.py` (its rows), `routes/setup.py` (grant `payments`), `oauth/{__init__.py (PAYMENTS_GRANT, payment_scopes_from_config), providers.py (the payments authorize URL only; the exchange is in `grants.py`), callback.py (the payments grant and the Whop hand-off)}`, `hooks.py` (`whop` on `/oauth/{platform}/callback` only), `app.py` (`WHOP_CONNECT` into the App), `stats/config.py` (parse `paymentScopes`, never overlapping `scopes` or `moneyScopes`), `money/everywhere.py` (`sent`), `money/sources.py` (change 13), `realtime/broadcast.py` (the four prefixes), `settings.py` (`notify.getPaid`), `config/monetization.json` (§40.3), `config/platforms.json` (`paymentScopes`); tests `api/tests/{test_getpaid_status.py, test_getpaid_sent.py, test_getpaid_routes.py, test_getpaid_grants.py}` (new), `api/tests/getpaid_cases.py` writing `api/tests/fixtures/{getpaid_status_cases.json, getpaid_sent_cases.json, getpaid_steps.json, getpaid_items.json}`, `api/tests/cr_fit_cases.py` (it writes `money_everywhere_cases.json`), `api/tests/money_cases.py` (`WHERE["x"]`, and so `money_summary_cases.json`), its updates to `test_money_everywhere.py`, `money_everywhere_cases.json`, `money_summary_cases.json`, `test_money_rules.py`, `test_money.py` (also X's `"None"` → `missing`), `test_money_grant.py`, `test_oauth_callback.py`, `test_hooks.py`, `test_setup_routes.py`, `test_settings_and_system.py` and `test_realtime.py`. **And the web mirror of what it changes**, because `web/test/allMoney.test.tsx` compares the web mock with `money_everywhere_cases.json` exactly and CI runs every test on every PR: `web/src/api/mock/moneyEverywhere.ts` (`PAID_WHERE.x` → `{label: "X › Creator Studio (paid through Stripe)", url: "https://x.com/i/jf/creators/studio"}`, and a line-for-line copy of `sent_line` / `sent_totals`), `web/src/api/types.ts` (every §40 API shape of §40.7: `GetPaid`, `GetPaidCard`, `SentLine`, `PayoutRow`, `PayConn`, `LiveEvent`'s `getpaid`, and the additive `MoneyPlace.sent?` / `MoneyEverywhere.sent?`), `web/e2e/all-money.spec.ts` (only the X href on line 63) |
| L collector and infra (`feature/getpaid-collect`) | `api/src/clipfactory_api/payouts/{__init__.py, adsense.py, whop.py, whoptokens.py, collect.py}` (new; the item keys and shapes of §40.7 written from this contract, checked against `getpaid_items.json` when present), `money/collect.py` (one call at the end of `run_user`, in a try), `push/notify.py` (the `PAYSTATE#` events; reads `notify.getPaid` with default `true`), `infra/modules/realtime/{main.tf, tests}`, `infra/modules/notify/{main.tf, tests}`, `infra/modules/api/{main.tf, variables.tf, tests/api.tftest.hcl}` and `infra/envs/prod/{main.tf, variables.tf, tests/wiring.tftest.hcl}` (`whop_connect_enabled` only); tests `api/tests/{test_payouts_adsense.py, test_payouts_whop.py, test_payouts_collect.py, test_notify_getpaid.py}` (new); and, last, the one-line PR `whop_connect_enabled = true` once K, L and M have merged |
| M web (`feature/getpaid-web`) | `web/src/getpaid/{types.ts, index.ts, youtube.ts, tiktok.ts, instagram.ts, facebook.ts, x.ts}` (new; the guide types only, the API shapes come from K's `api/types.ts`), `web/src/screens/getpaid/{GetPaidList.tsx, GetPaidPage.tsx, StatusPill.tsx, GetPaidStep.tsx, WhopCard.tsx, SentRows.tsx}` (new), `screens/money/{GetPaidCard.tsx (new), AllMoney.tsx, MoneyDashboard.tsx, CrMoneyPart.tsx (only exporting its step list for reuse)}`, `screens/settings/{Settings.tsx ("posting/getpaid"), MoneyBranch.tsx, NotifyBranch.tsx}`, `screens/settings/setup/{SetupPlatform.tsx, CrSetup.tsx}` (only the "Get paid" links), `web/src/setup/contentrewards.ts` (change 14 only), `app/App.tsx` (the `getpaid` route), `lib/{settingsTree.ts, router.ts, backLink.ts (+ `/settings/posting/getpaid` and `/settings/posting/getpaid/{place}` → "Back to Get paid"), money.ts (`PAYOUTS`, change 4), getPaid.ts (new: the hook, live refetch)}`, `api/index.ts` (the Get paid calls), `api/mock/{getpaid.ts (new), money.ts (change 4), index.ts}`, `styles/getpaid.css` (new); tests `web/test/{getpaid.test.tsx, getpaidGuides.test.ts}` (new), updates to `allMoney.test.tsx` (the drawing cases; the golden comparison stays K's), `backLink.test.ts`, `noGuesses.test.ts`, `money.test.tsx`, `settingsTree.test.ts` (Posting → `["setup", "getpaid", "where", "my-settings", "money"]`); `web/e2e/getpaid.spec.ts` (new), updates to `all-money.spec.ts` (the sent lines), `money-dashboard.spec.ts`, `screenshots.spec.ts` (`getpaid-list`, `getpaid-youtube`, `getpaid-contentrewards`, `money-getpaid` at 375 and 1440); the generated files |
| N docs and help (`docs/getpaid-help`) | `web/src/features/help/{helpKb.json, helpEvals.json}`: guides `getpaid-setup` "How do I set up getting paid?", `getpaid-status` "What does Can get paid mean?", `getpaid-sent` "How much was sent to my bank?", `getpaid-youtube` "Get paid by YouTube", `getpaid-tiktok-sweden` "Can I earn on TikTok in Sweden?", `getpaid-x-clips` "Why won't X pay for my clips?", `getpaid-whop` "See my Whop payouts", one eval question each, highlighting only M's anchors (`getpaid-list`, `getpaid-place`, `getpaid-status`, `getpaid-sent`, `getpaid-card`, `getpaid-whop`); `docs/SETUP_POSTING.md` (a "## Get paid" section: the steps in words and every research source of 21 Nov 2026), `docs/{SECURITY.md, ARCHITECTURE.md, TESTING.md, UX_DESIGN_SYSTEM.md, BUSINESS_REQUIREMENTS.md}`; the generated files |

* **Shared contracts nobody changes alone**: the names list (§40.1); the step ids and roles (§40.1–§40.2); the statuses,
  pills, tones and `known` words; `next` and `HOLD_FIX`; the freshness rule; the routes, `GetPaid`, `GetPaidCard`,
  `SentLine`, `PayoutRow`, `PayConn` and the additive `MoneyEverywhere` fields; the items and their attributes
  (§40.7); the secret names and JSON shapes (§40.6); the result codes and their sentences; `paymentScopes`;
  `WHOP_CONNECT`; `notify.getPaid`; the anchors (M adds them); the golden files (K writes them; L's and M's tests read
  them when present).
* **Merge order: K and L in any order; M after K; N after M.** All four start at once from this contract. Each PR
  passes CI alone on top of what it follows:
  * **K ↔ L, any order.** Before L, K finds no `PAYSTATE#` or `PAYOUT#`, so YouTube's status comes from
    `MONEYSTATE#youtube` and his ticks; a connected AdSense is `checking` only for its first 26 hours (`connectedAt`),
    then §40.2's "Clip Factory couldn't check YouTube payments yet. It tries again tomorrow." in `seen` and a status
    from his ticks, never a days-long "This can take until tomorrow". Before K,
    L's collector finds no `PAYCONN#` and does nothing. K and L meet only through items, secrets and the golden files.
  * **M after K.** The All your money mock mirrors the server, so K changes it together with the golden file (the
    golden test would fail in K's PR otherwise, and in M's PR against main's golden file if M did it); K also adds
    the §40 API shapes to `web/src/api/types.ts`, which M's screens import. M branches from main at once, builds
    against this contract, and rebases onto main once K has merged. M sends `notify.getPaid` only when the API
    returns it (§40.7), so an API without K never gets a 400.
  * **N after M.** `help-corpus.mjs --check` (in CI) fails on a highlight of an anchor that doesn't exist and on a
    route that isn't a page, so N branches from (or rebases onto) main after M has merged. If N must open earlier,
    its guides use no `highlight` and their `to` is `/settings/posting/money` until M is in.
  * Whop stays "Coming soon" until L's last one-line PR.
  * Generated files: a PR that changes their sources runs `node web/scripts/help-corpus.mjs --write-docs` and `node
    web/scripts/ask-knowledge.mjs`; on a conflict take main's copy and run both again.
* Commits end with the paragraph "Area: Get paid".

**Tests** (offline, fakes only; no AWS, Google, Whop, platform or network):
* **api (K)**, pytest: `getpaid_status_cases.json`: every place × every status and both `not_set_up` kinds, and the
  order: a fresh hold beats all; YouTube's `not_yet` beats his ticks, and with every goal reached its line is "You
  reached YouTube's goals…" with `next` `yt-join`; a `not_allowed` with a goal not reached has `next: null`; TikTok in
  Sweden is `not_started` with the Creator Rewards line (never `not_allowed`); Instagram's and X's `not_allowed` are
  `knownBy "rules"` with "Instagram says you have 312." / "X says you have 120."; X's `premium` never says no and
  `x-premium` as `next` has `vermilion: false`; a fresh Whop "no method" beats his ticks; Whop's ID check `pending` is
  `checking` (`knownBy "whop"`); Whop `can_get_paid` needs a `ready` method and Content Rewards linked to Whop
  (otherwise `not_set_up` from ticks, Next "Link your Whop account"); Content Rewards money with no bank step is
  `not_set_up` from ticks (warn, "Not set up yet"); YouTube `in_program` with no payout tick and no payment reading is
  "Not set up yet", never red; `NEEDS_ATTENTION` / `CLOSED` are red "Not set up (YouTube says)" with their `HOLD_FIX`;
  every `HOLD_FIX` row; **freshness**: just connected with every step ticked is `checking`, never "YouTube says
  there's no hold"; after "Stop payment reading", after `needs_reconnect`, and with `lastCheckedAt` over 48 h old, no
  status, hold or "no hold" comes from `PAYSTATE#` while sent rows still tick the payout steps ("Can get paid (Google
  sent money on 23 Oct)"); `checking` ends after 26 h or on `lastError` with the "couldn't check" line; **one
  `meta-payout` tick** alone makes Facebook and Instagram `not_started` with "You said Meta knows where to pay you.
  Next: …", never `you_said_done`; `you_said_done` needs every numbered `earn` and `payout` step; nothing at all is
  `not_started` or `not_connected` ("Clip Factory can't check"), never a "Live"; the ring never counts `yt-reading`;
  the summary's sentences (signal places name who said it; "Nothing to do here yet…" with no place to start); the
  autos (in the program, payment reading, a sent payment ticks the five YouTube steps, Premium).
  `getpaid_sent_cases.json`: the amount parser's golden texts, unread amounts never summed, only-unread rows give
  `notAdded` and never "Nothing sent to your bank yet.", totals per currency (never across) in the places' order with
  `names`, Whop's statuses and `destination_amount` over `net_amount`, a `reversed` row stops counting, `gone` rows,
  two AdSense accounts paying on the same day stay two rows, never $0. Routes: PATCH ids, `yt-reading` refused,
  Content Rewards' ids refused, 80 ticks, the 503s while `WHOP_CONNECT` is off, no secret or trace code in any
  answer. Grants: `save_payments_grant` posts the code to `GOOGLE_TOKEN` itself (a fake `providers.exchange` that
  raises is never called), checks only `adsense.readonly`, writes nothing on deny, missing scope, no AdSense (200 with
  no `accounts`, or another 403) or API off (`accessNotConfigured` and `SERVICE_DISABLED`), stores `clientId`, and
  never touches `ACCOUNT#youtube`, the YouTube token, `SETUP#` or `MONEYSTATE#`; the authorize URL has the AdSense
  scope only and no `include_granted_scopes`; `DELETE /v1/getpaid/connections/adsense` deletes the secret and makes
  **no** HTTP call to Google's revoke URL; the Whop grant's PKCE, public-client exchange, `Api-Version-Date` header and
  refusal of missing scopes; a reused state writes nothing; `whop` is refused on `/hooks/{platform}`.
  `money_everywhere_cases.json` and `money_summary_cases.json` updated: X's new where line, the `sent` lines and
  block. `test_money_rules.py`: the three config fixes and their official hosts. `test_money.py`: X's `"None"` →
  `missing`. `test_realtime.py`: the four prefixes → `getpaid`, partial. Settings: `getPaid` defaults to true. The web
  golden comparison (`allMoney.test.tsx`) passes in K's PR with K's mock mirror.
* **api (L)**, pytest: AdSense fakes (accounts, alerts with HTML, payments with `youtube-` and plain names, two
  accounts) → the items of §40.7 with the publisher suffix; a changed amount sets `revisedAt`; a vanished payment sets
  `goneAt`; 429/5xx → `lastError`, rows kept; `invalid_grant` → `needs_reconnect` `token_dead`; a changed `clientId`,
  `invalid_client` or `unauthorized_client` → `keys_changed`; nothing deleted; the first read is quiet. Whop fakes
  (each refuses a call without `Api-Version-Date: 2026-11-20`): `users/me`, methods with `bank_verification_state`,
  payouts paging with the watermark, a `completed` → `reversed` change, a `canceled` payout is never a hold, the
  rotating refresh under the lease (two runs at once refresh once), `invalid_grant`. `collect.run` raising never stops
  `run_user` or another source; the time budget skip. Notify: each event once, none on the first read, none with
  `getPaid` off, the message words. `terraform test`: the filters (in place), `whop_connect_enabled` default `false`
  → `WHOP_CONNECT = "off"`, `true` → `"on"`, nothing replaced.
* **web (M)**, Vitest: each guide's ids and roles equal `getpaid_steps.json` (when present); every step ≤ 6-word title,
  ≤ 26-word lines, https Opens, bold only for other sites' labels; the YouTube Copy chip equals `platforms.json`
  `paymentScopes` (when present; else `https://www.googleapis.com/auth/adsense.readonly`); the status pill words,
  tones and icons for every status (never colour alone; "Not set up yet" is never red); no pill, line or summary says
  "Live", "Not connected" or "disconnected" (the bold platform labels **LIVE Gifts** and **LIVE rewards** are the only
  "LIVE"); **one vermilion per screen, per status**: the list none; Money's card none; the place page exactly one when
  `next` names a step (that step's main action; the status block shows `next.text` and no button; on a phone it is
  pinned bottom right at page open), exactly one in the status block when `next.stepId` is `null`, none when `next` is
  `null` or `vermilion` is `false`; §38.7's money steps and "Connect Whop" glass on the place page; the ring excludes
  `yt-reading` and shows the reading chip; `phone` steps on a computer have no Open; ticks send the PATCH and fold
  with "You said it's done"; autos show who said so; the Money card's row buttons per status; the result sentences of
  §40.6 word for word; All your money's sent lines, the block per currency, `notAdded`, "Nothing sent to your bank
  yet." only with no sent rows, never $0; `notify.getPaid` absent from the API → no switch and no `getPaid` in the
  PATCH body; `lib/getPaid.ts` refetches on `getpaid`, `setup` and `contentrewards` events and after a Content
  Rewards step PATCH; `noGuesses` over the new files (amounts only formatted); `backLink` shapes; the setup to-do list
  still has exactly five rows and the setup ring still says "of 5" with every Get paid tick set. Playwright (mock
  mode, 375×812 and 1440×900, the `tap()` counter of `web/e2e/flows.ts`): Clip Factory's taps per place equal §40.1's
  CF counts (YouTube 15, TikTok 4, Instagram 4, Facebook 4 (2 after Instagram), X 5, Content Rewards 5 or 3, Connect
  Whop 6), the ways in (4 from Settings, 2 from Money), Allow payment reading's result sentences, Connect Whop (on and
  off), the Whop key paste; every new screen: no sideways scroll at 320–1920, no edges, targets ≥ 44 px (48 on
  phones), the arrow cursor only, axe contrast light and dark, reduced motion, phone controls bottom right, Ask never
  over the main button.
* **docs (N)**: `help-corpus.mjs --check` (every highlight is a real anchor) and `ask-knowledge.mjs --check`.

**Not verified live** (each is checked at the owner's first use; a failure becomes a plain "not available" or "can't
check", never a number):
* AdSense: whether `accounts.list` returns an account that only has AdSense for YouTube (made in Studio); which alert
  types appear for each hold (only `payment-hold` is documented); how `Payment.amount` is written for SEK; whether
  `Payment.date` is Google's send day; whether a returned EFT stays in the list; whether the owner's AdSense Google
  account is the YouTube one; that `adsense.readonly` adds no review; that `/channel/UC/monetization` opens Earn;
  which error shape a switched-off API gives (`accessNotConfigured` or `SERVICE_DISABLED`, both handled); that the
  bank opens before the ID and address checks in Sweden (from the money levels, Y14; the `when` lines still hold if
  not); where the hold message shows on **Payments** (`HOLD_FIX`'s "red message").
* Google's tax form steps and the "Other Copyright Royalties" treaty wording (from help pages not opened); the 24%
  withholding figure.
* Meta: the payout steps' exact words in Sweden (bank sign-in offered?), the Payouts path (All tools › Payouts), the
  Meta Business Suite addresses (every `business.facebook.com/latest/*` page redirects to sign-in, so none was
  checked), the metric unit of `monetization_approximate_earnings` (§40.3).
* TikTok: whether Video Gifts and LIVE Gifts are open in Sweden (an inference from its help centre); the buttons after
  **Balance** › **LIVE rewards**; whether withdrawals are manual; the tax form's place.
* X: the Creator Studio Stripe button's words; whether Creator Studio shows paid-out history; the payout currency in
  Sweden; whether X treats posts made through its API as "automated means" (the card says "probably").
* Whop: whether a personal user can make an OAuth app (and whether Whop asks for a company first) and grant
  `payout:withdrawal:read`, `payout:destination:read`, `user:balance:read` and `identity:read` without review; whether
  `GET /users/me` and `GET /payouts` accept a user token (the spec lists no credential for them); whether Content
  Rewards pays into his personal (`user_`) or a business (`biz_`) balance; the refresh token's lifetime; the developer
  page address; the VAT/GST pause for a clipper; whether a Developer Dashboard app can do the public-client exchange
  with no secret; the units of `destination_amount` / `net_amount` (taken as decimal dollars, not cents); the values
  of `bank_verification_state` beyond `pending` and `failed`; that `Api-Version-Date: 2026-11-20` is accepted.
* Bank: see §40.5.14.
