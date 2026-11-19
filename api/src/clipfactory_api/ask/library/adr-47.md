## ADR-47 Only platform-reported money; the estimates are removed

- **Context.** The owner asked (2026-11-18) for earnings that are "completely for real, real data, nothing that I should
  add in myself": when each platform starts paying, and then what it pays. §21 guessed money from views times a
  per-1,000-view rate the owner could type in, which is the opposite. Research showed only YouTube (Analytics
  `estimatedRevenue`, scope `yt-analytics-monetary.readonly`) and possibly Facebook (`content_monetization_earnings`)
  report money to an app at all; Instagram, TikTok and X report neither money nor programme status. An adversarial
  review then found that a re-consent through the normal callback would replace the Account item, that a second
  refresher could break rotating tokens, and that "every 403 means not monetized" would show false answers.
- **Decision.**
  - *Only reported money.* A figure appears only when a platform's API reported it about the owner's account, tagged
    as that platform's estimate (every API figure is one). No calculation, conversion or typed-in money anywhere, and
    no "paid" or "actual" wording: payouts are only on the platform's payout page, which we link.
  - *Real progress where money is not shared.* Goals come from `config/monetization.json`, each with an official
    source (CI refuses others), by date (YouTube's 2027-02-01 rules), by programme state and by the owner's country.
    "Goal reached" always adds that the platform checks things we can't see.
  - *States never go down by themselves.* `in_program` (YouTube 200) and `earning` (money above 0) are permanent; only
    `forbidden` with a working non-money report counts as "Not yet"; other errors say how to fix them.
  - *One button, merged consent.* "Allow money reading" asks for the Connect scopes plus the money scopes and goes
    through `save_money_grant()`: token secret, then an UpdateItem on the Account. Normal Connect scopes do not change
    for any platform, Meta OAuth is untouched, and a failed or different-account grant writes nothing.
  - *A separate collector, the shared token manager.* `cf-prod-money` runs once a day (and on an hourly-limited Check
    now) and gets every token through `SecretsTokenProvider`, whose lease keeps X and TikTok rotations single. Its role
    copies `cf-prod-stats`' secret access and has no DeleteItem.
  - *Additive storage.* New sort keys under the owner's partition, a `MONEYOWNERS` registry partition, a new module and
    new routes. No table, index, user pool, secret or bucket changes. `earningsRates`/`earningsPaid` stay stored and
    unread.
  - *Facebook money waits for one live check* (`moneyVerified`), because its unit comes only from a third-party
    document and the metrics may have been removed in June 2026.
- **Consequences.** YouTube is the only platform with money on day one, 2–3 days behind and revised at month end.
  Facebook shows "coming soon" until a grown-up compares one live call with Meta Business Suite. TikTok follower
  counts need a TikTok review of `user.info.stats`; 30-day views need 30 days of snapshots. Google shows an
  "unverified app" screen for the monetary scope. The YouTube API policy's storage limits are not yet confirmed, so
  nothing is deleted automatically except on an explicit YouTube Disconnect (§25.6, §25.8).
