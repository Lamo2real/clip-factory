## ADR-81 Auto-posting: an hourly EventBridge rule, a due check and Upload's own code

- **Context.** The owner asked for auto-posting (CONTRACTS §46): the oldest clips in Review go to every connected
  platform every X hours (1–24) and Y clips at a time (1–5), on EventBridge and serverless, with even gaps across
  midnight, changes live on save without a redeploy, and never a clip posted twice, even when a run is retried or two
  runs overlap. Until now nothing was published without his Upload (§0).
- **Options.** (1) EventBridge Scheduler with a `rate(X hours)` schedule the app updates on save; (2) an EventBridge rule
  whose `rate()` the app rewrites with `events:PutRule`; (3) one EventBridge rule every hour on the hour, with the
  Lambda running only when X hours have passed since the last run, and the posting itself done by Upload's code.
- **Decision.** Option 3. Option 1 needs `iam:PassRole`, which the cf-prod-* permissions boundary forbids (and the
  durable clip flow already replaced the old Scheduler group and role, §14.5). Neither 1 nor 2 can say when the next
  run is, and both drift against Terraform. With 3, the next run is simple arithmetic (`max(next full hour after onAt, lastRunAt +
  X)`), saves count from the next tick, and the gaps are exactly X hours. A run claims its slot and lists its clips in
  one transaction, so a retry or an overlap resumes the same plan. Each clip goes through the same conditional
  transaction and idempotent flow start as Upload, so it can be confirmed and started only once. TikTok never posts
  by itself (TikTok's rules want the creator's pick for each post). Campaign clips wait while Content Rewards can't
  take them from Clip Factory, and a clip with a failed important check waits. Retries stay Upload's (up to 3 on "did
  not answer", none where a retry could post twice). Run-now test actions run inline in cf-prod-api with Upload's
  existing grants, so cf-prod-api's infrastructure is unchanged.
- **Consequences.** One new Lambda, role, log group, rule and two alarms. 24 short invocations a day, almost all
  "not due". Auto-posting is off for every owner until he turns it on. Practice mode and a private test run let him test
  the whole flow with nothing public. Saving takes effect from the next full hour, not that same minute. Throw away
  holds a clip on the server the moment it is tapped (a 60 s `holdUntil` that runs skip and a run's write refuses;
  Undo lifts it), because the decline itself only goes when Undo's 8 s toast ends and a run could fall in that gap.
