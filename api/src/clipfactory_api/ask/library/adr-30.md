## ADR-30 One EventBridge rule and a due-queue for stats polling

- **Context.** Every posted post must be read on its own schedule (ADR-29) for 30 days, while the Refresh button can
  read any of them at once. §14 removed the watchdog's EventBridge rule and the per-post EventBridge Scheduler
  schedules in favour of durable waits (ADR-22). The clip flow's durable execution lasts at most 3 days.
- **Decision.** One EventBridge rule, `cf-prod-stats`, `rate(15 minutes)` (the smallest `minIntervalMinutes`, read from
  `config/platforms.json` by Terraform), targets a plain Lambda `cf-prod-stats`. The **due-queue** is a sparse DynamoDB
  index: a post carries `gsi2pk = "STATS"`, `gsi2sk = "{statsDueAt}#{postId}"` only while it is inside its 30-day
  window, so each tick is one Query for `gsi2sk <= now`. Each platform's limits are one `RATE#{platform}` item reserved
  with a conditional write before every request. The tick stops starting requests after 240 s; the rest stay due. The
  Refresh button claims the posts with a conditional write and invokes the same Lambda asynchronously (`InvocationType
  Event`, no retries). The clip flow's 48-hour `metrics` step calls the same `refresh_posts`.
- **Alternatives.** *A durable function per post with `wait` between reads* (about 700 waits per post over 30 days,
  longer than the 3-day clip flow; a manual refresh would need to wake a sleeping execution; many executions to
  watch). *EventBridge Scheduler, one schedule per post* (the pattern §14 removed: schedules to create, move and clean
  up for every post and every interval change). *A Step Functions loop* (a state machine per post or a long-running
  one; more moving parts and cost for the same thing). *Polling from the browser* (works only while the page is open
  and would put platform tokens near the browser). *A tick every minute* (four times the invocations for nothing: no
  platform interval is shorter than 15 minutes).
- **Consequences.** About 2,900 invocations a month, near zero cost, and nothing per post to create or clean up: a
  post joins the queue by getting `statsDueAt` and leaves it by losing `gsi2`. All callers share the budgets, so a tick
  and a button press together can never overspend. The rule is the system's only schedule (no EventBridge Scheduler, no
  other rule). If the intervals in `config/platforms.json` all become 30 minutes, the rule
  becomes `rate(30 minutes)` by itself. The stats Lambda has no async retries (the next tick is the retry) and never
  raises on expected errors; a bug raises and alarms.
