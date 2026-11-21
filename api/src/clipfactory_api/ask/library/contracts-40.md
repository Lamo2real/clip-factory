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

**The honest answer to his question** (checked 21 Nov 2026 for an owner in Sweden; the owner's choice of bank source,
§40.5, is still open):

| Place | What he earned (§40.3) | Can money reach him? (§40.2) | Sent to his bank (§40.4) |
|---|---|---|---|
| YouTube | YouTube's estimate, as today (§25.3) | "YouTube says": AdSense's account state, holds and payments, plus his ticks | Yes: every payment Google sent (AdSense `payments`) |
| TikTok | Not available from TikTok | his ticks only; Creator Rewards is not open in Sweden | Not available from TikTok |
| Instagram | Not available from Instagram | his ticks, plus Instagram's follower count | Not available from Instagram |
| Facebook | Coming soon (Meta's estimate waits for one live check, §40.3) | his ticks, plus Facebook's follower count | Not available from Meta |
| X | Not available from X | his ticks, plus X's Premium and verified-follower signals | Not available from X |
| Content Rewards | Content Rewards' numbers, as today (§39.2) | "Whop says" once Connect Whop works (ID check, payout method), plus his ticks | Whop's completed payouts once Connect Whop works, else not available |

"Reached your bank" (money his bank booked) can only come from his bank. That part waits for his choice (§40.5); until
then every screen says "Clip Factory can't see your bank. Look in your bank's app to see what arrived."

**What this section adds, and what it leaves alone.** A **Get paid** area: one card per place (YouTube, TikTok,
Instagram, Facebook, X in `STATS_ORDER`, then Content Rewards while `CONTENT_REWARDS=on`), each with numbered step
cards that walk him to that place's own payout setup in time order, the way Set up posting walks him to each
platform's keys (§17.1); an honest status per place that says how it is known; "Sent to your bank" money where a
platform reports it; and the shape of the bank part. It is **not** part of Set up posting: the five setup cards, the
"**2 of 5 ready**" ring and the floating to-do list (§17.13: still exactly five rows) are unchanged, and no Get paid
tick is written to `SETUP#`. §25's rule stays: Clip Factory shows only money a platform, Content Rewards or Whop
reported (later: his bank), never calculated, guessed, converted or typed in; "Not available from X" instead of $0.
Clip Factory never asks for or stores bank details, card numbers or tax numbers: every payout is set up on the
platform's own pages (the bank part of §40.5, once chosen, reads only booked credits). §38.7's Content Rewards money steps keep their words and their ticks (`CRCONN.stepsDone`); the
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
| Earning but no payout set up | "Not set up" with the line "You can earn, but money can't reach you." |
| Platform money Google or Whop sent | "Sent to your bank by Google" / "Sent to your bank by Whop" |
| Money his bank booked (§40.5 only) | "Reached your bank" |
| Clip Factory reading YouTube payments | "Allow payment reading" (button) / "Stop payment reading" |
| Clip Factory reading Whop payouts | "Connect Whop" (button) / "Stop reading Whop" |
| His answer on a step Clip Factory can't see | "I did this", or the step's own words ("I'm in", "I turned it on", "I joined", "X said yes", "I have Premium") |

Never on a Get paid screen: "Live", "Active", "Verified ✓" or "Connected" for a payout (Clip Factory can't tell);
"KYC" (say "ID check"), "EFT" (say "bank transfer"), "OAuth", "token", "scope", "API", "payout account" except
inside Meta's own bold words. Platform labels stay bold and word for word (**LIVE Gifts**, **Payouts**).

**Where.**
1. **Settings › Posting › Get paid** `/settings/posting/getpaid`: a new branch of the Posting tree right after Set up
   posting (slug `getpaid`, name "Get paid", line "Set up how each app pays you. See if money can reach you.", icon
   `coin`; apple `getpaid` "Get paid", leaf "One card per place. Do the steps once so money can reach you.", words
   "get paid", "payout", "payouts", "bank", "bank account", "paypal", "stripe", "adsense", "whop", "tax", "money on
   hold", "withdraw", "cash out"). The page (`screens/getpaid/GetPaidList.tsx`, `data-help="getpaid-list"`): header
   "Get paid", the server's `summary` line, then six big glass cards (fewer while Content Rewards is off): mark, name,
   a progress ring over that place's numbered steps, the status pill (§40.2) and one line; X's card adds its
   `warning`. No vermilion button on the list: each card is one big tap to its page. Under the cards, the glass card
   **Your bank** with the words of §40.5 D ("Clip Factory can't see your bank. Look in your bank's app to see what
   arrived.") and no button until the owner chooses a bank source.
2. **A place page** `/settings/posting/getpaid/{place}` (route `{ name: "getpaid", place }`, matched like the setup
   pages; `place` is `youtube`, `tiktok`, `instagram`, `facebook`, `x` or `contentrewards`, the last only while Content
   Rewards answers; anything else is `not_found`). Top to bottom (`screens/getpaid/GetPaidPage.tsx`,
   `data-help="getpaid-place"`): the header (mark, name, ring, "About 15 minutes · Free" from the guide's `minutes` and
   `cost`, "Steps checked on 21 Nov 2026"); the **status block** (`data-help="getpaid-status"`: the pill, the line,
   `missing` and `holds` lines, and the one next step's button, which is the screen's vermilion); **Can you earn here?**
   (the guide's facts for his country from `GET /v1/money`'s `country`, each short; one glass "Read YouTube's rules" per
   different official page; with no country picked: "Pick your country in Money settings to see its rules." and the
   facts that hold everywhere); the numbered **step cards** in time order; **What Clip Factory can see** (the server's
   `seen` lines); **Sent to your bank** (`data-help="getpaid-sent"`: the rows of §40.4); **When it's done** (glass
   "Check now" = `POST /v1/money/refresh` on YouTube and Content Rewards, the connection's own buttons of §40.6, and
   with `?back=` the back button).
3. **Money** `/money`: a glass card **Get paid** (`screens/money/GetPaidCard.tsx`, `data-help="getpaid-card"`) right
   after All your money, before the Apps band: title "Get paid", line "Can money reach you from each place?", one row
   per place (mark, name, the pill), at most one glass button per row at its right end ("See steps" → the place page
   with `?back=/money`, only for `not_set_up`, `on_hold`, `not_started` and `not_connected`). No vermilion: the
   Content Rewards money part keeps its own (§38.7). All your money gains the "Sent to your bank" lines (§40.4).
4. Each platform's setup page (§17.1) gains, under its "When it's done" buttons, a glass "Get paid" link
   (→ `/settings/posting/getpaid/{platform}?back=/settings/posting/setup/{platform}`); Content Rewards' existing "Get
   paid" link goes to `/settings/posting/getpaid/contentrewards` (§40.8 change 9). Settings › Posting › Money's
   `money-payouts` apple links to the Get paid branch.
5. Never on the floating to-do list, never in "n of 5 ready", never a sixth platform.

**Getting there**: Settings › Posting › Get paid › a card: 4 taps; Money › a "See steps" button: 2 taps (Money tab,
the button); a setup page's "Get paid" link: 1; Ask "how do I get paid on youtube": N's guide `getpaid-setup` and its
page action: 2.

**Step cards** are the §17.1 and §38.1 cards: number in a circle, an `Icon`, a title of six words or fewer, 1–4 short
lines (≤ 26 words each, one action per sentence), then only what the step needs: Open buttons (exact https page, new
tab / system browser, `rel="noopener noreferrer"`), Copy chips, "If you see X, do Y" hints, and the green answer
(≥ 48 px). Bold = the other site's exact label from the research of 21 Nov 2026. Where nobody saw the screen (Google's
tax form, TikTok's **LIVE rewards** screen, X's Stripe button, Whop's developer page) the step adds "{Site} may show
this a little differently. Look for the same words." **A step Clip Factory can see ticks itself and says how ("YouTube
says you're in"). A step it can't see shows the green answer; a signal that says otherwise beats the tick (§40.2).**
A step done in a phone app says "Do this in the TikTok app on your phone." (its Open still opens the website). A step
that waits for the platform has a `when` line ("YouTube asks for this once you've earned about $10."). The first step
not done is open and scrolled into view; done steps fold to a green tick row that says who said so ("You said it's
done" or "YouTube says"). Each-time steps ("Each time you get money") sit unnumbered under the numbered ones.

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
  phone?: boolean;             // "Do this in the {app} app on your phone."
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

**YouTube** (about 30 minutes over a few weeks, Free; the Mac for step 2). Facts: "YouTube pays creators in Sweden
through its Partner Program." · "To join: 1,000 subscribers, and 4,000 watch hours in 12 months or 10 million Shorts
views in 90 days." · "From 1 Feb 2027, new channels need 8,000 hours or 20 million Shorts views." · "YouTube doesn't
pay for Shorts that only reuse other people's videos." · "A Short over 1 minute with music someone claimed can't
earn." · (SE) "YouTube pays in kronor, straight to your bank. Not PayPal." · (SE) "It pays between the 21st and 26th
once you have kr 700. Your bank gets it up to 7 workdays later."

| # | id | role | title | essentials |
|---|---|---|---|---|
| 1 | `yt-join` | earn | Join the Partner Program | `auto: in_program` ("YouTube says you're in", from `MONEYSTATE#youtube` `in_program`/`earning`); `doneLabel` "I'm in". Open "Open YouTube Studio" → `https://studio.youtube.com/channel/UC/monetization`. "Tap **Apply Now**, then **Start**." "Read the terms and tap **Accept**." "Tap **Start** on the AdSense card. Pick your Google account. Type your name and address." "YouTube checks your channel. It takes about a month." If you see: the Dashboard instead → "Tap **Earn** on the left."; **Get notified** → "You're not there yet. Tap it. YouTube emails you when you are."; **In Progress** → "Nothing to do. YouTube is checking."; not approved → "You can appeal within 21 days, or try again after 30 days."; the AdSense website asks you to sign up → "Go back. Make it from YouTube Studio, not the AdSense website." |
| 2 | `yt-reading` | reading | Let Clip Factory see payments | `auto: payment_reading`, `manual: false`, `action: allow_payment_reading`. `lead` "A grown-up does this once on the Mac. Then Clip Factory sees holds and payments." `when` "Do this after step 1 made your AdSense." Open "Turn on the AdSense API" → `https://console.cloud.google.com/apis/library/adsense.googleapis.com`: "Check **Clip Factory** is picked at the top. Tap **Enable**." Open "Open Google's permissions page" → `https://console.cloud.google.com/auth/scopes`: "Tap **Add or remove scopes**." "Paste this in **Manually add scopes**:" Copy chip "Permission" `https://www.googleapis.com/auth/adsense.readonly`. "Tap **Add to table**, **Update**, then **Save**." Then the vermilion "Allow payment reading": "Pick the Google account you use for AdSense for YouTube. It can be a different one." If you see: **Manage** instead of **Enable** → "It's on already."; **Google hasn't verified this app** → "Tap **Advanced**, then **Go to …**. It's your own app."; the result "no AdSense" → "Tap Allow payment reading again. Pick the Google account that has AdSense." |
| 3 | `yt-tax` | payout | Add your US tax info | `auto: sent`. Open "Open AdSense for YouTube" → `https://adsense.google.com/`. "Tap **Payments**, then **Payments info**, then **Manage settings**." "Next to **United States tax info**, tap edit, then **Manage tax info**." "Fill in the form for people outside the US." "Without it, Google may keep up to 24% of your money." (Google may show this a little differently.) If you see: two payments accounts → "In **Payments account**, pick the one for YouTube."; a question about a tax treaty → "Pick Sweden. YouTube's help calls this money **Other Copyright Royalties**." |
| 4 | `yt-id` | payout | Check your ID | `auto: sent`. `when` "YouTube asks once you've earned about $10." Open "Open AdSense for YouTube". "Tap **Payments**, then **Verification check**." "Send a photo of your passport, ID card or driving licence." "YouTube checks it in up to 2 days." If you see: "45 days" → "Send it in time, or YouTube stops your ads."; can't send it → "Sign in with the Google account that made AdSense." |
| 5 | `yt-pin` | payout | Type the PIN from the letter | `auto: sent`. `when` "A letter comes by post 3 to 4 weeks after your ID check." Open "Open AdSense for YouTube". "Tap **Payments**, then **Verification check**." "Type the 6 numbers from the letter. Tap **Submit**." If you see: no letter after 4 weeks → "Ask for a new PIN on the same page."; a wrong-PIN warning → "Type it slowly. After 3 wrong tries YouTube stops your ads." |
| 6 | `yt-bank` | payout | Add your bank | `auto: sent`. `when` "YouTube lets you once you've earned kr 70." Open "Open AdSense for YouTube". "Tap **Payments**, then **Payments info**, then **Add payment method**." "Pick bank transfer. Type your bank details." "Tick **Set as primary payment method**. Tap **Save**." "Pick Swedish kronor. You can't change it later." If you see: PayPal → "Not offered in Sweden. Use your bank."; it's after the 20th → "Fine. Your first money may come a month later." |
| 7 | `yt-test` | payout | Confirm the tiny test payment | `auto: sent`. `when` "A tiny payment from Google arrives in 1 to 5 workdays." "Look in your bank's app for a tiny payment, a few kronor, from GOOGLE." Open "Open AdSense for YouTube". "Tap **Payments**, then **Payments info**, then **Manage payment methods**." "Tap **Verify now**. Type the amount. Tap **Verify**." If you see: nothing after 10 workdays → "Your bank details may be wrong. Fix them in **Payments info**."; a third try → "After 3 wrong tries you must ask AdSense support." |

Each time: nothing to do ("Google sends your money by itself. Clip Factory tells you when it does.").

**TikTok** (about 15 minutes, Free; phone). Facts: (SE) "Creator Rewards isn't open in Sweden. TikTok lists only the
US, UK, Germany, Japan, South Korea, France, Mexico and Brazil." · "Video Gifts and LIVE Gifts may work in Sweden.
Look in TikTok Studio." · "Gifts need you to be 18 or older and a Personal account, not Business." · "LIVE needs 1,000
followers." · "TikTok counts in dollars. Each payout costs a small fee." · (SE) "TikTok pays to PayPal, your bank or
Payoneer." · (SE) "TikTok Shop isn't in Sweden."

| # | id | role | title | essentials |
|---|---|---|---|---|
| 1 | `tt-gifts` | earn | Turn on Gifts | `phone`, `doneLabel` "I turned it on". Open "Open TikTok" → `https://www.tiktok.com/`. "Tap **Profile**, then the menu ☰, then **TikTok Studio**." "Tap **Video Gifts**, then **Turn on Gifts**." "For LIVE: in the LIVE screen tap **Settings** and turn on **LIVE Gifts**." If you see: no **Video Gifts** → "Gifts aren't open for you yet. Look again in a month."; a Business account → "Switch back to Personal. Business accounts can't get Gifts." |
| 2 | `tt-payout` | payout | Add where TikTok pays you | `phone`. Open "Open TikTok". "Tap **Profile**, the menu ☰, then **Balance**." "Tap **LIVE rewards**. Set up how you get paid." "Pick PayPal, your bank or Payoneer. PayPal takes 1.5%. A bank costs $3 each time." (TikTok may show this a little differently.) If you see: "not available in your region" → "TikTok doesn't pay out there yet."; "linked in more than 2 countries" → "Keep your payment ways in one country." |
| 3 | `tt-tax` | payout | Add your tax form | `phone`. Open "Open TikTok". "In **Balance**, tap **Tax information**." "Fill in the form for people outside the US (W-8BEN)." "Without it, TikTok may keep up to 30% of US money." If you see: no **Tax information** → "It shows the first time you withdraw." |
| – | `tt-withdraw` | each_time | Move money to your bank | `phone`. "Tap **Profile**, ☰, **Balance**, then **LIVE rewards**." "Withdraw to your PayPal, bank or Payoneer." "See what went out: **Balance**, then **Transactions**, then **Withdrawal**." |

**Instagram** (about 15 minutes, Free; phone). Facts: "Gifts: 500 followers, 18 or older, a professional account." ·
"Subscriptions: 10,000 followers." · "Bonuses: only when Instagram invites you." · "Meta pays around the 21st once you
have $25. It pays in dollars. Your bank changes it to kronor." · "Without a payout account you can earn up to $500 per
tool. After 6 months without one, the money is lost."

| # | id | role | title | essentials |
|---|---|---|---|---|
| 1 | `ig-gifts` | earn | Turn on Gifts | `phone`, `doneLabel` "I turned it on". Open "Open Instagram" → `https://www.instagram.com/`. "Tap **Profile**, then **Professional dashboard**." "Under **Your tools**, tap **Gifts**." "Tap **Get started** and accept." If you see: no **Professional dashboard** → "Switch to a professional account first: **Settings**, **Account type and tools**."; no **Gifts** → "You need 500 followers and a professional account." |
| 2 | `meta-payout` | payout | Make your Meta payout account | `phone`, `shared: meta`. `lead` "Made it on Facebook already? It's the same one. Tap I did this." `when` "Meta lets you once you've earned $25." Open "Open Instagram". "Tap **Profile**, **Professional dashboard**, then **Payouts**." "Tap **Get Started**. Type your legal name, birthday and country. Tap **Next**." "For business type pick **Individual**. Tap **Next**." "Tap **Sign into your bank** and use BankID. Or pick another way." "Tap **Link payout method**." "Tap **Add tax info**, sign, tap **Submit form**, then **Done**." If you see: "minimum earnings" → "Come back when you have $25."; **Add later** → "Fine, but don't wait 6 months, or Meta keeps the money."; changing it later → "Meta holds your money for 5 days after a change." |

Each time: nothing to do ("Meta sends your money around the 21st by itself.").

**Facebook** (about 15 minutes, Free; a computer is easiest). Facts: "Content Monetization: only when Meta invites you.
Sweden is on its list." · "Stars: 500 followers for 30 days in a row." · "Subscriptions: 5,000 followers." · (EU)
"Paying for no ads, or picking less personal ads, stops a profile from earning with Content Monetization." · "Meta
pays around the 21st once you have $25, in dollars."

| # | id | role | title | essentials |
|---|---|---|---|---|
| 1 | `fb-join` | earn | Join a Facebook money tool | `doneLabel` "I joined". Open "Open Meta Business Suite" → `https://business.facebook.com/latest/monetization`. "Tap **Monetization**, then **Status**, then **View Page eligibility**." "A **Set up** button means you can join. Tap it and accept." "Invited to Content Monetization? Tap **Content monetization**, then **Sign up**." On a phone: "Creator Dashboard, then **Monetization**. It says **Ready to set up** or **Not yet eligible**." If you see: no **Monetization** → "Tap **All tools**, then **Monetization**."; **Not yet eligible** → "Meta invites creators. Tell Meta you'd like it:" + Open "Open Meta's form" → `https://creators.facebook.com/content-monetization-interest-form`. |
| 2 | `meta-payout` | payout | Make your Meta payout account | the same step as Instagram's (one tick for both); Open "Open Meta Business Suite" → `https://business.facebook.com/`: "Tap **All tools**, then **Payouts**." then the same lines from **Get Started**; "In Content Monetization's sign-up this is **Payout details**, then **Complete setup**." |

**X** (about 15 minutes; X's paid plan costs money). Facts: "**X doesn't pay for posts an app made or posted, or clips
copied from other sites.** Your Clip Factory clips probably won't earn on X." · "Creator Revenue Sharing ended in
September 2026." · "Original Content Rewards needs Premium or higher, 500 verified followers and 500,000 views from
verified people in 90 days." · "Then X reviews you." · "X pays every two weeks once you have $30, through Stripe."

| # | id | role | title | essentials |
|---|---|---|---|---|
| 1 | `x-premium` | earn | Get X Premium | `auto: premium` ("X says you have Premium", from `MONEYSTATE#x.numbers.premium`); `doneLabel` "I have Premium". Open "Open X" → `https://x.com/`. "Tap **Premium** in the menu." "Pick **Premium** or higher. **Basic** doesn't count." |
| 2 | `x-apply` | earn | Apply for Original Content Rewards | `doneLabel` "X said yes". Open "Open Creator Studio" → `https://x.com/i/jf/creators/studio`. "Tap **Original Content Rewards**." "Apply. X checks your account." "Tap X said yes when X lets you in." If you see: not accepted → "You can ask once more. Or apply again after 42 days."; money paused for a past rule break → "Accounts that are paused can't join." |
| 3 | `x-stripe` | payout | Connect Stripe for payouts | Open "Open Creator Studio". "Connect a Stripe payout account." "Stripe checks your ID once. Have it ready." "Add your bank in Stripe." (X may show this a little differently. Look for **Stripe**.) If you see: you did this for Revenue Sharing → "You don't need to do it again. Tap I did this." |

Each time: nothing to do ("Stripe sends X's money to your bank in 3 to 5 workdays, sometimes 10."); "See what Stripe
sent:" Open "Open Stripe" → `https://connect.stripe.com/express_login`.

**Content Rewards** (§38.7's steps, unchanged): the Finance question first ("Do you see **Finance** in the Content
Rewards menu?", the `<Glide>` bar), then the numbered once steps for his answer: "No" → 1 `move-whop` Link your Whop
account, 2 `bank-setup` Add your bank on Whop; "Yes" → 1 `fin-setup` Set up payouts. Each time (unnumbered):
`move-withdraw` Move money to Whop, then `bank-cashout` or `fin-bank`. Ticks and autos stay on `CRCONN`
(`PATCH /v1/contentrewards/connection`). Facts: "Content Rewards sends your money to Whop. Whop sends it to your bank."
· "Moving to Whop is free from $1." · "Whop checks your ID and a selfie once." · "Whop to your bank takes up to 5
workdays." · "Whop may pause payouts from 1 Dec 2026 until you answer its VAT question in **Settings**, **Tax**. Not a
registered business? Tap **No, my business is not registered**. Don't type your personnummer there." Then the optional
card **See your Whop payouts here** (`id: whop`, `data-help="getpaid-whop"`, §40.6).

**Taps** (one-time, from the place page, counted like §39.1; a typed field is not a tap; "about" = a form whose fields
vary; CF = Clip Factory's own taps):

| Place | Steps and taps | Total (CF) |
|---|---|---|
| YouTube | 1 Open YouTube Studio · **Apply Now** · **Start** · **Accept** · **Start** · Google account · **Submit** · back = 8 (CF 1; it ticks itself once YouTube says you're in, else "I'm in" +1) · 2 Open "Turn on the AdSense API" · **Enable** · Open the permissions page · **Add or remove scopes** · Copy chip · paste · **Add to table** · **Update** · **Save** · back · "Allow payment reading" · Google account · **Advanced** · **Go to …** · tick · **Continue** = 16 (CF 4; it comes back by itself) · 3 Open · **Payments** · **Payments info** · **Manage settings** · edit · **Manage tax info** · the tax form (about 8) · **Submit** · back · "I did this" = 17 (CF 2) · 4 Open · **Payments** · **Verification check** · the ID photo (2) · send · back · "I did this" = 8 (CF 2) · 5 Open · **Payments** · **Verification check** · **Submit** · back · "I did this" = 6 (CF 2) · 6 Open · **Payments** · **Payments info** · **Add payment method** · bank transfer · **Set as primary payment method** · **Save** · back · "I did this" = 9 (CF 2) · 7 Open · **Payments** · **Payments info** · **Manage payment methods** · **Verify now** · **Verify** · back · "I did this" = 8 (CF 2) | **72** (CF 15) over 4 sittings (apply; about a month later steps 2–4; the PIN 3–4 weeks later; the bank and the test payment). The five "I did this" are optional: Google's first payment ticks steps 3–7 → 67 (CF 10). Already in the Partner Program: −8 |
| TikTok | 1 Open TikTok · **Profile** · ☰ · **TikTok Studio** · **Video Gifts** · **Turn on Gifts** · back · "I turned it on" = 8 (CF 2) · 2 Open · **Profile** · ☰ · **Balance** · **LIVE rewards** · set up · PayPal · PayPal sign-in (2) · back · "I did this" = 11 (CF 2) · 3 Open · **Profile** · ☰ · **Balance** · **Tax information** · the form (about 5) · **Submit** · back · "I did this" = 13 (CF 2) | **32** (CF 6); each withdrawal 7 |
| Instagram | 1 Open Instagram · **Profile** · **Professional dashboard** · **Gifts** · **Get started** · accept · back · "I turned it on" = 8 (CF 2) · 2 Open · **Profile** · **Professional dashboard** · **Payouts** · **Get Started** · **Next** · **Individual** · **Next** · **Sign into your bank** · bank and BankID (3) · **Link payout method** · **Add tax info** · **Submit form** · **Done** · back · "I did this" = 18 (CF 2) | **26** (CF 4) |
| Facebook | 1 Open Meta Business Suite · **Monetization** · **Status** · **View Page eligibility** · **Set up** · accept · back · "I joined" = 8 (CF 2) · 2 Open · **All tools** · **Payouts** · **Get Started** … **Done** as Instagram (12) · back · "I did this" = 17 (CF 2); 0 when made on Instagram | **25** (CF 4); **8** (CF 2) after Instagram |
| X | 1 Open X · **Premium** · **Premium** · pay (about 3) · back = 7 (CF 1; ticks itself when X says Premium) · 2 Open Creator Studio · **Original Content Rewards** · apply · confirm · back · "X said yes" = 6 (CF 2) · 3 Open Creator Studio · Stripe · email and code (2) · the ID check (about 3) · bank · back · "I did this" = 10 (CF 2) | **23** (CF 5) |
| Content Rewards | "No" on the Finance bar (CF 1) · 1 Open Content Rewards settings · **Open Whop** · sign in · allow · back · "I did this" = 6 (CF 2) · 2 Open Whop · **Dashboard** · **Balances** · **Payout methods** · **Add payout method** · confirm · ID and selfie (about 3) · back · "I did this" = 11 (CF 2). With **Finance**: "Yes" (CF 1) · Open Content Rewards · **Finance** · the four tasks (about 9) · **Continue on Whop** · back · "I did this" = 14 (CF 2) | **18** (CF 5); **15** (CF 3) with Finance; each payout 12 (§38.2); optional Connect Whop +17 (CF 6, §40.6) |

Each tap above is the move to the next screen, a fact only he knows, or the platform's own button; the only ones Clip
Factory could save are the "I did this" answers, and only YouTube's (Google's first payment proves them). The fewest
for a case like the owner's (YouTube already in the Partner Program; Instagram, then Facebook; Content Rewards without
Finance): 64 + 26 + 8 + 18 = **116** taps, 25 of them Clip Factory's, spread over weeks because each platform makes
him wait (review, letter, test payment, the first $25).

### 40.2 The status per place: honest, and how it is known

**Statuses** (`GetPaidStatus`; pill words fixed; never colour alone: each pill has its icon and words; red is the
error tone at AA contrast, never the vermilion of a button):

| `status` | Pill | Line (server-made) | When |
|---|---|---|---|
| `on_hold` | "Payment on hold (YouTube says)" / "(Whop says)" | the platform's own words, plain text, ≤ 300 characters ("YouTube says: …"); Whop: "Whop says your ID check didn't pass." · "Whop says your bank details don't work." · "Whop says your last payout didn't go through." | a hold signal (below). Beats every other status |
| `not_allowed` | "Not allowed yet (YouTube says)" / "(X says)" / "(Instagram says)" / "(TikTok's rules for Sweden)" | what's missing: "1,000 subscribers: you have 812." · "Creator Rewards isn't open in Sweden. Gifts might be." · "500 verified followers: you have 120." · "Gifts needs 500 followers: you have 312." | a signal or a published country rule says he can't earn there yet, and (except YouTube's own answer) no tick says he can |
| `can_get_paid` | "Can get paid ✓ (YouTube says)" / "(Whop says)" | YouTube: "Google sent you money on 23 Oct." · Whop: "Whop says your ID check is done and your bank is set." | a signal that money can reach him (below) |
| `not_set_up` | "Not set up" (red) | "You can earn, but money can't reach you. Next: {the step's title}." | he can earn (a signal, or his tick on the place's `earn` step) and a `payout` step is not done, or a signal says a payout part is missing (AdSense `NEEDS_ATTENTION` or `CLOSED`: "YouTube says your AdSense needs you."; Whop: no saved method, or the ID check not `approved`) |
| `you_said_done` | "Can get paid (you said it's done)" | "You said every step is done. {Platform} doesn't tell Clip Factory, so it can't check." (YouTube with payment reading: "… YouTube says there's no hold.") | every `payout` step done, by his ticks or autos, and no signal against it |
| `checking` | "Checking…" | "Checking YouTube payments… This can take until tomorrow." | a payment-reading connection is connected and its first read hasn't finished |
| `not_connected` | "Not connected to Clip Factory" | "Clip Factory can't check anything for TikTok. You can still do the steps." | the place isn't connected to Clip Factory (its Account; Content Rewards: `CRCONN`) and has no tick and no payment-reading connection |
| `not_started` | "Not started" | "Do the steps so {Platform} can pay you." | anything else |

The first row that applies wins, in the table's order. "Live" is never shown: with no signal and no tick the place is
`not_started`, `not_connected` or `checking`. A tick is step state, never money (§38.1), and is always labelled "you
said". Every card has `next`, the one next step: the hold's fix, else the first step not done (`missing` and the
status decide which), else none; on the place page it is the vermilion button.

**What each place really gives** (the signals; everything else is his ticks):

| Place | Signals Clip Factory reads (stored items only; §40.7 says who writes them) | Hold | Can get paid (signal) | Can earn (signal) | Not allowed (signal or rule) |
|---|---|---|---|---|---|
| YouTube | `MONEYSTATE#youtube` (§25: `in_program`, `earning`, `not_yet` and its goals); after Allow payment reading, `PAYSTATE#youtube` (AdSense account `state` and `pendingTasks`, `alerts`, `youtube-unpaid`) and `PAYOUT#youtube#…` (each `youtube-yyyy-MM-dd` payment) | an alert of type `payment-hold` | a sent payment exists and the account is `READY` | `in_program` or `earning` | `not_yet` (403 `forbidden`, §25.1): YouTube's own answer, beats his ticks |
| TikTok | the Account; `MONEYSTATE#tiktok.numbers.followers` (with `user.info.stats`); `MONEYPREFS.country` with `config/monetization.json`'s `tiktok-rewards` countries | – | – | – | `rules.pick` says `not_open` for his country and `tt-gifts` isn't ticked |
| Instagram | the Account; `MONEYSTATE#instagram.numbers.followers` | – | – | – | followers < 500 and `ig-gifts` isn't ticked |
| Facebook | the Account; `MONEYSTATE#facebook.numbers.followers` (shown in `seen` only: Meta invites, so no rule says no) | – | – | – | never |
| X | the Account; `MONEYSTATE#x.numbers` `premium` (true only for `Premium`/`PremiumPlus`; X's field doesn't know the newer plans, so false never says no) and `verifiedFollowers` | – | – | – | verified followers < 500 and `x-apply` isn't ticked |
| Content Rewards | `CRCONN` (status, `stepsDone`, `finance`), `CRMONEY` (§38.7); after Connect Whop, `PAYSTATE#contentrewards` (ID check from `GET /users/me` `verification.individual`, saved methods from `GET /payouts/methods`) and `PAYOUT#contentrewards#…` | ID check `rejected`; every saved method `broken`; or the newest payout `failed`, `denied`, `canceled` or `reversed` within 30 days with no newer `completed` | ID check `approved` and a saved method `created` or `active` | CR reported money: paid so far, ready to move, still earning or on its way above 0 | never |

**Steps and autos the server knows** (`getpaid/status.py` `STEPS`, the same ids and roles as §40.1; K writes them to
`api/tests/fixtures/getpaid_steps.json`, M's test reads it when present):

| Place | `earn` | `reading` | `payout` | Autos |
|---|---|---|---|---|
| YouTube | `yt-join` | `yt-reading` | `yt-tax`, `yt-id`, `yt-pin`, `yt-bank`, `yt-test` | `yt-join` ← `in_program`/`earning`; `yt-reading` ← `PAYCONN#adsense` connected; the five payout steps ← any sent payment ("Google sent you money, so this is done") |
| TikTok | `tt-gifts` | – | `tt-payout`, `tt-tax` | – |
| Instagram | `ig-gifts` | – | `meta-payout` | – |
| Facebook | `fb-join` | – | `meta-payout` | – |
| X | `x-premium`, `x-apply` (he can earn once `x-apply` is done) | – | `x-stripe` | `x-premium` ← `premium` true |
| Content Rewards | CR money above 0 (no step) | – | Finance "no": `move-whop`, `bank-setup`; "yes": `fin-setup`; no answer yet: not done (next: "Answer: do you see Finance?") | §38.3's (`whop_linked` ticks `move-whop`) |

`tt-withdraw` and §38.7's each-time steps are `each_time`: never counted in a ring or a status. The ring of a card
counts its numbered steps done (ticks or autos) over all of them.

**What Clip Factory can see** (`seen`, server-made, at most 6 lines, shown on the place page):
* YouTube: "YouTube says you're in the Partner Program." / "… you're not in the Partner Program yet." · "YouTube says
  your AdSense is ready." / "… needs you. Open AdSense." / "… is closed." · "YouTube says there's no hold on your
  money." · "Waiting to be paid: kr 512,30 (YouTube says). Google pays when it's kr 700 or more." · "Last money sent:
  kr 1 234,56 on 23 Oct (YouTube says)." · with no payment reading: "Clip Factory can't see YouTube payments yet. Tap
  Allow payment reading." · always: "YouTube doesn't tell apps about your bank, tax or ID. Tap I did this when they're
  done."
* TikTok: "TikTok says you have 2,310 followers." · "TikTok doesn't tell apps about Gifts or payouts."
* Instagram: "Instagram says you have 312 followers." · "Meta doesn't tell apps about payout accounts."
* Facebook: "Facebook says your Page has 1,040 followers." · "Meta doesn't tell apps if you joined or set up payouts."
* X: "X says you have Premium." (only when true) · "X says you have 120 verified followers." · "X doesn't tell apps if
  you're in Original Content Rewards or set up Stripe."
* Content Rewards: "Content Rewards says $18.25 is ready to move to Whop." · "Whop says your ID check is done." /
  "… is waiting." / "… didn't pass." / "… isn't started." · "Whop says you have a bank to send to." / "… your bank
  details don't work." · "Some of your Whop money is in a business on Whop. Clip Factory reads only your own balance."
  (when `GET /users/me` lists owned businesses) · without Whop: "Clip Factory can't see Whop. Connect Whop to see your
  payouts here."

The followers and Premium lines come from the §25 daily reads already stored; Get paid makes no platform call of its
own for them.

**Summary** (`GetPaid.summary`, one line ≤ 26 words): "{names} can pay you." for `can_get_paid` and `you_said_done`,
then "{names} need(s) you." for `not_set_up` and `on_hold` ("YouTube and Content Rewards can pay you. TikTok needs
you."); none of either: "Nothing is set up yet. Start with {the first place that is `not_started`}."

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
  available" with where to look; what really reached his bank comes from the bank part (§40.5) once he chooses.

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

**YouTube** (rows `PAYOUT#youtube#{yyyy-mm-dd}`, written by L from AdSense `payments.list`):
* Each `accounts/{a}/payments/youtube-yyyy-MM-dd` is one sent payment, keyed by that date; `youtube-unpaid` is the
  current balance (`PAYSTATE#youtube.unpaid`, shown "Waiting to be paid", never in a total); the plain `unpaid` and
  `yyyy-MM-dd` ones are AdSense website money and are ignored.
* `Payment.amount` is a formatted string with its currency ("¥1,235 JPY", "$1,234.57", "£87.65"). L stores it as Google
  wrote it (`amountText`); K's `getpaid/sent.py` `parse_amount(text) -> (micros | None, currency | None)` reads it on
  every view: the currency is a 3-letter ISO code in the text, else only the unambiguous symbols € EUR, £ GBP, ₹ INR;
  "kr", "$", "¥" alone are ambiguous (SEK, NOK, DKK; USD, CAD, AUD; JPY, CNY) and are **not guessed**; the number takes
  spaces, no-break spaces, apostrophes, "." and "," as separators: with both "." and ",", the last one is the decimal
  mark; with one kind, it is the decimal mark only when exactly 1 or 2 digits follow it at the end. Golden cases
  (`getpaid_sent_cases.json`): "kr 1 234,56 SEK", "SEK 1,234.56", "1 234,56 kr" (unread), "$1,234.57" (unread),
  "€87.65", "£87.65", "¥1,235 JPY", "1.234,56 €". A row whose amount or currency can't be read is shown as Google wrote
  it, never added up: "1 payment isn't added up: Clip Factory couldn't tell its money type."
* A changed amount sets `revisedAt` (the new amount counts). A payment Google no longer lists keeps its row with
  `goneAt` ("Google no longer lists this payment.") and stops counting. A returned EFT (a closed bank account) is
  credited back by Google (§40.8 Not verified live: whether it leaves the list).
* The YouTube page adds: "Google pays between the 21st and 26th." and, from the threshold table, "… when you have kr
  700 or more." (SEK kr 700, EUR €70, USD $100; only when the unpaid balance's currency is one of these).

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
  currency, biggest first, naming the places ("kr 2 468,00 · YouTube", "$210.00 · Content Rewards, through Whop"),
  the tag "Google and Whop say they sent it.", "Different money, like dollars and kronor, is never added together.",
  "Not in this: TikTok, Instagram, Facebook and X (not available)." and the bank line "Clip Factory can't see your
  bank. Look in your bank's app to see what arrived."; with nothing sent: "Nothing sent to your bank yet." and no
  total. It is never added to the 30-day total (a different thing over a different time).
* **The place page**: the rows, newest first (at most 36): date, amount (formatted by the web, or Google's own text),
  state words, "by Google"/"by Whop", the arrive line on the newest.
* **Not on the Money Get paid card**, which shows status only (one job per card).

All sums are on the server, per currency, never across currencies, never converted; the web only formats (`noGuesses`,
§27.9).

### 40.5 Your bank (waits for the owner's choice)

**NOT TO BUILD until the owner chooses.** The owner picks one of: **A** Enable Banking (restricted mode) · **B** upload
his bank's CSV/xlsx file · **C** payout emails from Gmail · **D** nothing new. Until then the only bank words anywhere
are D's: "Clip Factory can't see your bank. Look in your bank's app to see what arrived." (the Get paid list's **Your
bank** card and the "Sent to your bank, so far" block). No builder of §40.8 writes bank code, items, routes, secrets or
infra. This sub-section fixes the shape so A or B plugs in later through one new section (§41) and one ADR, without
changing §40.1–§40.4.

**The deposit** (one per booked bank credit Clip Factory keeps; the same shape whichever source A or B fills it):

```ts
interface BankDeposit {
  depositId: string;        // sha256(source | accountKey | the bank's transaction id or entry reference | date | amount | currency), 32 hex
  date: string;             // the booking date, as the bank booked it (YYYY-MM-DD)
  amountMicros: number;     // the credit as the bank booked it (a unit change only)
  currency: string;         // the account's currency, as the bank says it ("SEK")
  place: GetPaidPlace | null;              // the place it came from, once matched
  match: "payout" | "payer" | "you" | "none";   // how it was matched (below)
  payoutRef?: string;       // the PAYOUT# sort key it pairs with (match "payout")
  payer?: string;           // the payer name as the bank showed it, ≤ 60 characters, kept only on a matched row
  state: "matched" | "needs_you" | "not_income";
  source: "enable_banking" | "bank_file";
  account: { bank: string; last4: string };     // never the full account number or IBAN
  confirmedAt?: string; fetchedAt: string;
}
```

Item `DEPOSIT#{yyyy-mm-dd}#{depositId}` (new sort key, permanent); learned payer names `BANKPAYERS` (`names`: map of a
normalized payer name → place, each with `learnedAt`; written only by his taps); the connection `BANKCONN` (below).
The public shape drops `payer` from rows that are `not_income`.

**Matching** (one pure function, from stored items only; the owner never types a number, only taps):
1. Only booked credits are candidates (Enable Banking: credit indicator `CRDT` and status `BOOK`; a file: a row with a
   positive amount). Debits, pending rows and balances are never read into storage.
2. **A payout record** (`match: "payout"`): a credit in the same currency with exactly the amount of a `PAYOUT#` row,
   booked from that row's date to 10 workdays after it (YouTube: Google's payment; Content Rewards: a `completed`
   Whop payout's `destination_amount` and `destination_currency`, or its `traceCode` in the payment text). The first
   match by date wins; a row pairs with one deposit only.
3. **A learned payer** (`match: "payer"`): a credit whose normalized payer name is in `BANKPAYERS` (for Meta, TikTok,
   Stripe/X and PayPal, which have no payout record).
4. **Ask him** (`state: "needs_you"`): a credit whose payer name holds a platform hint (GOOGLE, META, FACEBOOK,
   INSTAGRAM, TIKTOK, STRIPE, X CORP, WHOP, PAYPAL, PAYONEER) and matched nothing above. A card: "Is this money from
   YouTube? kr 1 234,56 on 28 Oct from GOOGLE IRELAND LTD" (the guessed place from the hint), green "Yes, it's YouTube",
   a pick-one `<Glide>` "It's from: YouTube · TikTok · Instagram · Facebook · X · Content Rewards" and quiet "Not
   money from an app". "Yes" or a pick sets `match: "you"`, `confirmedAt`, and learns the payer name for that place;
   "Not money from an app" sets `not_income` and learns nothing. A tap never changes an amount.
5. **Google's test payment**: a Google credit with no YouTube payout record and an amount below the account currency's
   YouTube payment threshold (SEK kr 700, EUR €70, USD $100: YouTube's own published table, so nothing is converted)
   is `not_income` by itself ("Google's test payment").
6. Everything else is dropped in memory: never stored, never logged, never sent to the web.

**"Reached your bank"** = the sum of `matched` deposits per currency per place, tagged "Your bank says", in its own
block under "Sent to your bank, so far"; each "Sent to your bank by Google" row shows "Reached your bank on 28 Oct"
once a deposit pairs with it. Never converted, never added across currencies, never $0 for a place with nothing.

**Least data**: the deposit fields above only; no balance, no debits, no other people's names, no payment text (only a
matched payer name), no full account numbers; the source's raw answer is never stored; a file (B) is deleted right
after it is read. Tokens, keys and session ids only in Secrets Manager (`cf-prod/platforms/bank/…`, created at
runtime). "Forget my bank" deletes `DEPOSIT#`, `BANKPAYERS` and `BANKCONN` (his own explicit tap, with the 8 s Undo).

**Connection states** (`BANKCONN.status`): `not_chosen` · `connecting` · `connected` (`consentUntil`, `accounts [{bank,
last4}]`, `lastReadAt`) · `expiring` (14 days or less to `consentUntil`: the calm card "Your bank link ends on Fri 20
May. Tap Reconnect and use BankID.") · `expired` (also when the bank ends it early: the bank may ask again before 180
days, RTS Art. 10a(3)) · `revoked` (he stopped it, or the bank did) · `error`. Expiry never deletes a deposit.

**A. Enable Banking, restricted mode** (NOT TO BUILD until chosen). Free; its terms allow production use on linked
accounts "for the personal use of private individuals"; Swedish banks (Swedbank, SEB, Handelsbanken, Nordea, Danske,
Länsförsäkringar, ICA Banken, Revolut, Wise, PayPal…) with 180-day consent through BankID. The owner makes his own
Enable Banking app and links his own accounts (its key pair: the private key in `cf-prod/platforms/bank/app`). Flow:
"Connect your bank" → his bank's BankID → back to Clip Factory; a daily read of new booked credits in
`cf-prod-money` (first read with the "longest" history strategy; older history may need B once). Stop: Enable
Banking's `DELETE /sessions/{id}` closes the consent. Before building: the owner emails Enable Banking to ask whether
tracking creator income on a personal account is "personal use" (its docs say "individual non-commercial use"), and
says which bank and whether any creator money lands in a business account (business accounts are excluded).

**B. Upload the bank's file** (NOT TO BUILD until chosen). Monthly, by hand: "Add your bank's file" → pick the CSV or
xlsx his internet bank exports (≤ 5 MB) → the API reads it once (the first time he taps which column is the date, the
amount and the payer: taps, no typing), keeps only matched or "needs you" credits, and deletes the file. No third
party and no expiry; also fills in older history.

**C** (only labels deposits from X/Stripe and Meta, never proof of arrival; needs Google Personal mode from the
Gmail account that gets the emails) and **D** (today's words) need no shape of their own.

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
* `POST /v1/accounts/youtube/connect {"grant": "payments"}` (409 "Paste your YouTube keys first." without saved
  YouTube keys; YouTube need not be connected): the authorize URL of §17.4 for YouTube with
  `scope=https://www.googleapis.com/auth/adsense.readonly`, `access_type=offline`, `prompt=consent select_account`,
  PKCE as §17.4, and **no** `include_granted_scopes` (the token carries the AdSense scope only, even for the same
  Google account). The `OAUTH#` state item carries `grant: "payments"`. Same YouTube keys and redirect URI: nothing new
  in Google Cloud except the API and the scope of step 2.
* The callback (`oauth/callback.py`) hands a `payments` grant to `getpaid.grants.save_payments_grant()`, never
  `save()` or `save_money_grant()`: (1) a refused, failed or reused code writes nothing (`payments_denied`,
  `payments_error`); (2) the scope not granted → `payments_missing`, nothing written; (3) `GET
  https://adsense.googleapis.com/v2/accounts` with the new token: none → `payments_no_account` ("That Google account
  has no AdSense for YouTube. Tap Allow payment reading again and pick the Google account that has it."), 403
  `accessNotConfigured` → `payments_api_off` ("Turn on the AdSense API first. It's in step 2."), nothing written;
  (4) the secret `cf-prod/platforms/adsense/token` is written (create or put): `{accessToken, expiresAt,
  refreshToken, scope, accounts: ["accounts/pub-…"]}`; (5) one UpdateItem on `PAYCONN#adsense`: `type "payconn"`,
  `source "adsense"`, `status "connected"`, `accounts [{name, displayName}]` (at most 5), `connectedAt`
  (`if_not_exists`), `scopes`, `lastResult`, `updatedAt`, REMOVE `reason`. Then the redirect
  `/settings/posting/getpaid/youtube?result={payments_allowed | payments_denied | payments_missing |
  payments_no_account | payments_api_off | payments_error}`; the page shows the sentence, removes the query and starts
  a Check now.
* Refresh (L, `cf-prod-money`): Google's refresh token doesn't rotate, so no lease; with the YouTube app keys, when the
  access token is due; the new access token is written back put-only. `invalid_grant` (revoked, or unused for 6
  months) or changed YouTube keys → `PAYCONN#adsense` `needs_reconnect` with `reason` `token_dead` or `keys_changed`;
  nothing is deleted; the card and the YouTube page say "Clip Factory can't see YouTube payments anymore. Tap Allow
  payment reading again." (glass, the vermilion only on the YouTube page while nothing else is next).
* "Stop payment reading" (glass, 8 s toast "Stopping payment reading… Undo"; `DELETE /v1/getpaid/connections/adsense`
  when the toast ends): revoke at `https://oauth2.googleapis.com/revoke` (best effort), delete the token secret,
  `PAYCONN#adsense` `not_connected`. `PAYSTATE#youtube` and every `PAYOUT#youtube#…` stay: they are records of real
  money ("Clip Factory stopped reading on 3 Dec."). YouTube's Disconnect and its `forget` (§25.6) never touch them.

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
    Paste box "Client ID" (`^app_[A-Za-z0-9]{4,64}$`, friendly 400 "Your Client ID starts with app_."), "Save key".
    "Whop may show this a little differently. Look for the same words." If you see: Whop asks for a company first →
    "Make one. Any name is fine. It's free."
  * then the card's vermilion "Connect Whop" (glass while the page has another next step).
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
  whop_denied | whop_missing | whop_expired | whop_error}#whop`.
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
| PATCH `/v1/getpaid/steps` | `{ "step": id, "done": bool }` | `GetPaid`. 400 for an id not in `STEPS`; Content Rewards' ids → 400 "Tick Content Rewards steps on its own card."; at most 80 ticks; `meta-payout` is one tick for both Meta places |
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
  knownBy: KnownBy; known: string /* "YouTube says" | "You said it's done" | "TikTok's rules for Sweden" */;
  line: string; missing: string[]; holds: string[]; warning?: string /* X only */;
  next: { stepId: string | null; label: string; href: string; external: boolean } | null;
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
interface MoneyEverywhere { /* … */ sent?: { totals: { currency: string; amountMicros: number; places: MoneyPlaceId[] }[];
  tag: string; notCountedText?: string; bankText: string; empty?: string } }
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
| `PAYSTATE#contentrewards` | `source "whop"`, `kyc` (`not_started`, `pending`, `approved`, `rejected`, `unknown`), `methods {created, active, broken, currencies}`, `lastPaidOutAt`, `businesses` (bool), `hold {kind, since}`, `lastSent {sk, date, amountMicros, currency}`, `payoutsMark` (internal), `firstReadDone`, `lastCheckedAt`, `lastError` | money |
| `PAYOUT#youtube#{yyyy-mm-dd}` | `type "payout"`, `place`, `by "google"`, `source "adsense.payments"`, `date`, `amountText`, `state` (`sent`/`gone`), `fetchedAt`, `revisedAt`, `goneAt` | money |
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
`{ type: "getpaid", op: "upsert", id: "getpaid", partial: true }` (no item rides along; `LiveEvent` gains it); the web
refetches `GET /v1/getpaid` (debounced 1 s) and, on Money, `GET /v1/money/everywhere`. The realtime stream filter gains
the four prefixes (the mapping's filter is updated in place).

**Notifications** (§32; `cf-prod-notify`, whose stream filter gains `PAYSTATE#`, MODIFY only, in place; choice
`notify.getPaid`, default on; Settings › App & account › Notifications gains the switch "Money on hold or sent to your
bank"). Once each (a conditional put on `NOTIFIED#getpaid#{key}`, 30-day `ttl`), only when the old image had
`firstReadDone`:

| Event | When | Body | `url` |
|---|---|---|---|
| `hold:youtube:{since}` | `PAYSTATE#youtube.holds` went from empty to not empty | "Your YouTube money is on hold. Tap to see why." | `/settings/posting/getpaid/youtube` |
| `hold:whop:{kind}:{since}` | `PAYSTATE#contentrewards.hold` appeared | "Whop can't send your money. Tap to see why." | `/settings/posting/getpaid/contentrewards` |
| `sent:{place}:{lastSent.sk}` | `lastSent` changed to a newer row | YouTube: "Money sent to your bank: Google sent kr 1 234,56. It arrives in up to 7 workdays." (Google's own text) · Whop: "Money sent to your bank: Whop sent $40.00." (Whop's amount; another currency is written with its code, "412.00 SEK") | `/money` |

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
   Stripe." → "Connect Stripe in X › Creator Studio. X pays through Stripe."
5. §39.2 (K words, M screen): X's where line "Look in X, then Monetization (paid through Stripe)." → "Look in X, then
   Creator Studio (paid through Stripe)." (its "Open X" → `https://x.com/i/jf/creators/studio`); Content Rewards'
   small line "Paid out to your bank: not available from Content Rewards. Look on Whop: **Balances**." → the row's
   `sent` line (the same words while Whop isn't connected); All your money gains each row's `sent` line and the
   "Sent to your bank, so far" block (§40.4).
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

| Builder | Owns |
|---|---|
| K api (`feature/getpaid-api`) | `api/src/clipfactory_api/getpaid/{__init__.py, status.py, sent.py, view.py, grants.py}` (new), `routes/getpaid.py` (new), `routes/__init__.py` (its rows), `routes/setup.py` (grant `payments`), `oauth/{__init__.py (PAYMENTS_GRANT, payment_scopes_from_config), providers.py (the payments authorize URL), callback.py (the payments grant and the Whop hand-off)}`, `hooks.py` (`whop` on `/oauth/{platform}/callback` only), `money/everywhere.py` (`sent`), `realtime/broadcast.py` (the four prefixes), `settings.py` (`notify.getPaid`), `config/monetization.json` (§40.3), `config/platforms.json` (`paymentScopes`); tests `api/tests/{test_getpaid_status.py, test_getpaid_sent.py, test_getpaid_routes.py, test_getpaid_grants.py}` (new), `api/tests/getpaid_cases.py` writing `api/tests/fixtures/{getpaid_status_cases.json, getpaid_sent_cases.json, getpaid_steps.json, getpaid_items.json}`, its updates to `test_money_everywhere.py` and `money_everywhere_cases.json`, `test_money_rules.py`, `test_money.py`, `test_money_grant.py`, `test_oauth_callback.py`, `test_hooks.py`, `test_setup_routes.py`, `test_settings_and_system.py` and `test_realtime.py` |
| L collector and infra (`feature/getpaid-collect`) | `api/src/clipfactory_api/payouts/{__init__.py, adsense.py, whop.py, whoptokens.py, collect.py}` (new; the item keys and shapes of §40.7 written from this contract, checked against `getpaid_items.json` when present), `money/collect.py` (one call at the end of `run_user`, in a try), `push/notify.py` (the `PAYSTATE#` events; reads `notify.getPaid` with default `true`), `infra/modules/realtime/{main.tf, tests}`, `infra/modules/notify/{main.tf, tests}`, `infra/modules/api/{main.tf, variables.tf, tests/api.tftest.hcl}` and `infra/envs/prod/{main.tf, variables.tf, tests/wiring.tftest.hcl}` (`whop_connect_enabled` only); tests `api/tests/{test_payouts_adsense.py, test_payouts_whop.py, test_payouts_collect.py, test_notify_getpaid.py}` (new); and, last, the one-line PR `whop_connect_enabled = true` once K, L and M have merged |
| M web (`feature/getpaid-web`) | `web/src/getpaid/{types.ts, index.ts, youtube.ts, tiktok.ts, instagram.ts, facebook.ts, x.ts}` (new), `web/src/screens/getpaid/{GetPaidList.tsx, GetPaidPage.tsx, StatusPill.tsx, GetPaidStep.tsx, WhopCard.tsx, SentRows.tsx}` (new), `screens/money/{GetPaidCard.tsx (new), AllMoney.tsx, MoneyDashboard.tsx, CrMoneyPart.tsx (only exporting its step list for reuse)}`, `screens/settings/{Settings.tsx ("posting/getpaid"), MoneyBranch.tsx, NotifyBranch.tsx}`, `screens/settings/setup/{SetupPlatform.tsx, CrSetup.tsx}` (only the "Get paid" links), `app/App.tsx` (the `getpaid` route), `lib/{settingsTree.ts, router.ts, backLink.ts (+ `/settings/posting/getpaid` and `/settings/posting/getpaid/{place}` → "Back to Get paid"), money.ts (`PAYOUTS`), getPaid.ts (new: the hook, live refetch)}`, `api/{index.ts, types.ts}`, `api/mock/{getpaid.ts (new), moneyEverywhere.ts, index.ts}`, `styles/getpaid.css` (new); tests `web/test/{getpaid.test.tsx, getpaidGuides.test.ts}` (new), updates to `allMoney.test.tsx`, `backLink.test.ts`, `noGuesses.test.ts`, `money.test.tsx`; `web/e2e/getpaid.spec.ts` (new), updates to `all-money.spec.ts`, `money-dashboard.spec.ts`, `screenshots.spec.ts` (`getpaid-list`, `getpaid-youtube`, `getpaid-contentrewards`, `money-getpaid` at 375 and 1440); the generated files |
| N docs and help (`docs/getpaid-help`) | `web/src/features/help/{helpKb.json, helpEvals.json}`: guides `getpaid-setup` "How do I set up getting paid?", `getpaid-status` "What does Can get paid mean?", `getpaid-sent` "How much was sent to my bank?", `getpaid-youtube` "Get paid by YouTube", `getpaid-tiktok-sweden` "Can I earn on TikTok in Sweden?", `getpaid-x-clips` "Why won't X pay for my clips?", `getpaid-whop` "See my Whop payouts", one eval question each, highlighting only M's anchors (`getpaid-list`, `getpaid-place`, `getpaid-status`, `getpaid-sent`, `getpaid-card`, `getpaid-whop`); `docs/SETUP_POSTING.md` (a "## Get paid" section: the steps in words and every research source of 21 Nov 2026), `docs/{SECURITY.md, ARCHITECTURE.md, TESTING.md, UX_DESIGN_SYSTEM.md, BUSINESS_REQUIREMENTS.md}`; the generated files. Merge after M (its words describe M's buttons); its CI passes alone |

* **Shared contracts nobody changes alone**: the names list (§40.1); the step ids and roles (§40.1–§40.2); the statuses,
  pills and `known` words; the routes, `GetPaid`, `GetPaidCard`, `SentLine`, `PayoutRow`, `PayConn` and the additive
  `MoneyEverywhere` fields; the items and their attributes (§40.7); the secret names and JSON shapes (§40.6); the
  result codes; `paymentScopes`; `WHOP_CONNECT`; `notify.getPaid`; the anchors (M adds them); the golden files (K
  writes them; L's and M's tests read them when present).
* **Any order** (each PR passes CI alone): before K, M's routes answer 404, so the Get paid branch says "Coming soon."
  and the Money card and All your money's sent lines are not there; before L, K finds no `PAYSTATE#` or `PAYOUT#`, so
  YouTube's status comes from `MONEYSTATE#youtube` and his ticks, and a connected AdSense stays `checking` with its
  "until tomorrow" line; before K, L's collector finds no `PAYCONN#` and does nothing; Whop stays "Coming soon" until
  the last one-line PR. No builder imports another's new code: K and L meet only through items, secrets and the
  golden files; M reads the API by its shapes. Generated files: a PR that changes their sources runs `node
  web/scripts/help-corpus.mjs --write-docs` and `node web/scripts/ask-knowledge.mjs`; on a conflict take main's copy
  and run both again.
* Commits end with the paragraph "Area: Get paid".

**Tests** (offline, fakes only; no AWS, Google, Whop, platform or network):
* **api (K)**, pytest: `getpaid_status_cases.json`: every place × every status, and the order: a hold beats all;
  YouTube's `not_yet` beats his ticks; a TikTok tick on `tt-gifts` lifts the Sweden rule; X's `premium: false` never
  says no; a Whop "no method" beats his ticks; Content Rewards money with no bank step is `not_set_up`; nothing at
  all is `not_started` or `not_connected`, never a "Live"; `meta-payout` ticks both Meta places; the autos (in the
  program, payment reading, a sent payment ticks the five YouTube steps, Premium). `getpaid_sent_cases.json`: the
  amount parser's golden texts, unread amounts never summed, totals per currency (never across), Whop's statuses and
  `destination_amount` over `net_amount`, a `reversed` row stops counting, `gone` rows, never $0. Routes: PATCH ids,
  Content Rewards' ids refused, 80 ticks, the 503s while `WHOP_CONNECT` is off, no secret or trace code in any
  answer. Grants: `save_payments_grant` writes nothing on deny, missing scope, no AdSense or API off, and never touches
  `ACCOUNT#youtube`, the YouTube token, `SETUP#` or `MONEYSTATE#`; the authorize URL has the AdSense scope only and no
  `include_granted_scopes`; the Whop grant's PKCE, public-client exchange and refusal of missing scopes; a reused
  state writes nothing; `whop` is refused on `/hooks/{platform}`. `money_everywhere_cases.json` updated: X's new where
  line, the `sent` lines and block. `test_money_rules.py`: the three config fixes and their official hosts.
  `test_realtime.py`: the four prefixes → `getpaid`, partial. Settings: `getPaid` defaults to true.
* **api (L)**, pytest: AdSense fakes (accounts, alerts with HTML, payments with `youtube-` and plain names) → the items
  of §40.7; a changed amount sets `revisedAt`; a vanished payment sets `goneAt`; 429/5xx → `lastError`, rows kept;
  `invalid_grant` → `needs_reconnect`, nothing deleted; the first read is quiet. Whop fakes: `users/me`, methods,
  payouts paging with the watermark, a `completed` → `reversed` change, the rotating refresh under the lease (two runs
  at once refresh once), `invalid_grant`. `collect.run` raising never stops `run_user` or another source; the time
  budget skip. Notify: each event once, none on the first read, none with `getPaid` off, the message words.
  `terraform test`: the filters (in place), `whop_connect_enabled` default `false` → `WHOP_CONNECT = "off"`, `true` →
  `"on"`, nothing replaced.
* **web (M)**, Vitest: each guide's ids and roles equal `getpaid_steps.json` (when present); every step ≤ 6-word title,
  ≤ 26-word lines, https Opens, bold only for other sites' labels; the YouTube Copy chip equals `platforms.json`
  `paymentScopes`; the status pill words and icons for every status (never colour alone); no pill, line or summary
  says "Live" (the bold platform labels **LIVE Gifts** and **LIVE rewards** are the only "LIVE"); one vermilion per
  screen (the list: none; the place page: `next`; Money's card: none); ticks send the PATCH and fold with "You said
  it's done"; autos show who said so; All your money's sent lines, the block per currency, "Nothing sent to your bank
  yet." with no total, never $0; `noGuesses` over the new files (amounts only formatted); `backLink` shapes; the
  setup to-do list still has exactly five rows and the setup ring still says "of 5" with every Get paid tick set.
  Playwright (mock mode, 375×812 and 1440×900, the `tap()` counter of `web/e2e/flows.ts`): Clip Factory's taps per
  place equal §40.1's CF counts (YouTube 15, TikTok 6, Instagram 4, Facebook 4 (2 after Instagram), X 5, Content
  Rewards 5 or 3), the ways in (4 from Settings, 2 from Money), Allow payment reading's result sentences, Connect
  Whop (on and off), the Whop key paste; every new screen: no sideways scroll at 320–1920, no edges, targets ≥ 44 px
  (48 on phones), the arrow cursor only, axe contrast light and dark, reduced motion, phone controls bottom right,
  Ask never over the main button.
* **docs (N)**: `help-corpus.mjs --check` (every highlight is a real anchor) and `ask-knowledge.mjs --check`.

**Not verified live** (each is checked at the owner's first use; a failure becomes a plain "not available" or "can't
check", never a number):
* AdSense: whether `accounts.list` returns an account that only has AdSense for YouTube (made in Studio); which alert
  types appear for each hold (only `payment-hold` is documented); how `Payment.amount` is written for SEK; whether
  `Payment.date` is Google's send day; whether a returned EFT stays in the list; whether the owner's AdSense Google
  account is the YouTube one; that `adsense.readonly` adds no review; that `/channel/UC/monetization` opens Earn.
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
  page address; the VAT/GST pause for a clipper.
* Bank (§40.5, not built): Enable Banking's view of creator income on a personal account; which payer names Swedish
  banks show for Google, Meta, TikTok, Stripe/X and Whop.
