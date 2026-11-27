## ADR-50 MRR for a per-view creator: reported days ending on the newest reported day; pace is labelled; per-clip money only from same-report numbers

- **Context.** The owner (2026-11-19)
  asked for daily, weekly, monthly and yearly MRR filtered by app, Monthly first,
  and for how much each video earns. Only YouTube (and Facebook once its live check passes) reports money; days arrive
  2–3 days late and change at month end. TikTok, Instagram and X have no money API. ADR-47 forbids any guessed money.
  (ADR-49 is taken by an open change, so this is ADR-50.)
- **Decision.**
  - Periods are sums of stored `REVENUE#` days ending on the earliest newest-reported day across the counted apps,
    so every app covers the same days and nothing looks short because of the lag.
  - Daily MRR is the 30-day average over the days stored history covers (`coveredDays`, at most 30). Yearly MRR is
    Monthly × 12 (× 360 ÷ `coveredDays` while fewer than 30 days are covered), always called "at this pace", worked
    out only on the server, and never added to anything; "Last 365 days" is shown only once stored history covers it.
  - An app more than 6 days behind while another is current is left out and named (`behind`) rather than pulling
    every app's days back; the banner names only the apps whose check failed or that are behind.
  - Apps without a money API are left out with a visible note, never estimated. Currencies are never added together.
  - Per-clip period money comes from new YouTube `dimensions=video` reports over the same days, stored additively in
    `revenueWindows` with `SET` on the Post; only a window over the list's own days counts, and none while YouTube
    lacks the money permission. Per 1,000 views shows only when the money and the views come from one
    YouTube report and the views are at least 1,000.
  - The server works out every number; the web only formats them. The mock carries one copy of the rules, held to
    the server's by shared golden cases, and the CI guard blocks money arithmetic anywhere else in `web/src`.
  - Apps, period and sort are saved per device (`localStorage`, the address wins).
  - On phones and touch tablets the controls sit in a bottom-right dock above the tab bar, and Ask's home spot moves
    above the dock while that page is open. Wide screens get a sticky full-width glass band under the title with the
    controls at its right end (the page scrolls under the whole band, so it never covers content beside it).
- **Alternatives.** *The web fetching each app's days and adding them up*: five calls, money arithmetic in the
  browser and no single source of truth. *Ending periods on today*: every period would look 2–3 days short.
  *Estimating TikTok/Instagram/X money from views*: forbidden by ADR-47. *A chart library*: not needed for bars, and
  every one draws axes and gridlines by default.
- **Consequences.** YouTube is the only app counted on day one. History starts about 2–3 months before the first
  money run and grows from there, so comparisons and "Last 365 days" appear only once enough days are covered. The
  daily money run makes 3 more Analytics report sets. No infra changes; the Terraform plan is code updates only.
