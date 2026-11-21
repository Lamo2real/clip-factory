## ADR-64 Get paid: payout records count as "sent to your bank", statuses say how they are known, the bank waits for the owner

- **Context.** The owner asked (2026-11-21) whether Clip Factory shows exactly what he earns on YouTube, TikTok,
  Instagram, Facebook, X and Content Rewards; for a step-by-step payout setup per place, "the same system" as Set up
  posting; for a status per place that tells him money can reach him, or that it can't although he is allowed to
  earn; and for the exact total that reached his bank accounts, per place. He lives in Sweden. Research (273 claims,
  skeptic-checked) found: YouTube's AdSense Management API (`adsense.readonly`) reports the account state, holds and
  every payment Google sent, but nothing about the bank, tax, ID or PIN; Whop's API, with a user sign-in, reports
  payout methods, the ID check and payouts Whop sent; Meta, TikTok and X report no payout status or payouts at all
  (X pays through Stripe Express, which only X can read); TikTok's Creator Rewards isn't open in Sweden; X's Original
  Content Rewards excludes automated and reuploaded posts; Meta's earnings metrics are undocumented in unit and
  currency. Only a booked bank credit proves arrival, and the only free self-serve bank route for a private person in
  Sweden (Enable Banking, restricted mode) has a grey area in its terms. ADR-47 says "payouts are only on the
  platform's payout page" and forbids "paid" wording and typed-in money.
- **Options.** Payouts: (a) keep ADR-47 as it is, links only; (b) show the payments AdSense and Whop report, worded
  as what they are, "Sent to your bank by Google/Whop"; (c) also work out "sent" as paid minus balance (a
  calculation, refused). The places with no API: (i) let him type his earnings and payouts, labelled "You typed
  this"; (ii) keep "Not available from X" with where to look, and let the bank show what really arrived. Statuses: (x)
  ticks only; (y) signals only (four places would say nothing); (z) signals where they exist, his ticks elsewhere,
  each labelled with who said it, signals beating ticks. Where: inside Set up posting (it would change the five-row
  to-do list and the "n of 5" ring) or its own Get paid area plus a card on Money. Storing ticks: `SETUP#.stepsDone`
  (it would move the to-do rows) or a new `GETPAID` item. The bank: Enable Banking, a monthly bank file, payout emails,
  or nothing new.
- **Decision.** (CONTRACTS §40) (b): AdSense `payments` and Whop `completed` payouts are shown as "Sent to your bank
  by Google" / "by Whop", tagged "YouTube says" / "Whop says", with when they should arrive; "Reached your bank" is
  kept for bank-booked credits only; ADR-47's ban on "paid", "received" and "actual" next to an amount stays. (ii):
  no typed-in money anywhere; Instagram, TikTok, X and Facebook say "Not available" with where to look; Facebook's
  estimate stays "coming soon". (z): one pure status function on the server over stored items, eight statuses
  (on hold, not allowed yet, can get paid ✓, not set up, can get paid (you said it's done), checking, not connected,
  not started), never "Live" without a signal or a tick, a hold first, YouTube's own "not in the Partner Program"
  above his ticks. A Get paid branch in Settings › Posting with one card and one step page per place, in the setup
  cards' look, and a status-only card on Money; Content Rewards reuses §38.7's steps and ticks; Get paid never joins
  the setup ring or the to-do list; ticks live on a new `GETPAID` item. Two new, separate, optional read-only
  connections: "Allow payment reading" for AdSense (its own token, because the AdSense Google account can be another
  one; never merged into the YouTube connection) and "Connect Whop" through the owner's own Whop app (a public PKCE
  client; rotating refresh tokens under a lease as Content Rewards' are; behind `whop_connect_enabled`, default off).
  Both are read by `cf-prod-money`'s daily run and Check now; tokens in Secrets Manager under `cf-prod/platforms/*`,
  made at runtime; no IAM, table or Lambda change. The bank part is defined but not built: a source-agnostic deposit
  shape, matching by payout records, learned payer names and his taps (never a typed number), least data, and the
  consent states, waiting for the owner to choose Enable Banking or a bank file (or nothing). Facts fixed in
  `config/monetization.json`: X's programme is Original Content Rewards in Creator Studio, Creator Rewards is not open
  in Sweden, YouTube's 2027 rules cite answer 12843009.
- **Consequences.** YouTube can show "Can get paid ✓ (YouTube says)" only after Google's first payment, and a hold the
  day AdSense reports it; before that, and on every other platform, the status rests on his "I did this" and says so.
  "Sent to your bank" can differ from what his bank books (fees, conversion, returns, days in transit), and Whop's
  total covers all his Whop money, not only Content Rewards; the words say both. X's card warns that clips Clip
  Factory posts probably won't earn there. Whop's part depends on Whop letting a personal user make an app and read
  payouts (not live-tested); until the switch is on, Content Rewards' "sent" stays "not available". "Reached your
  bank" stays unknown until the owner picks a bank source. Additive only: new sort keys `GETPAID`, `PAYCONN#`,
  `PAYSTATE#`, `PAYOUT#`, new attributes, two stream filters updated in place, one api env var; nothing that holds his
  connections or saved data changes.
