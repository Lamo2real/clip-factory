## ADR-12 Publishing through SQS, the 48-hour check through EventBridge Scheduler

**Replaced by [ADR-22](#adr-22-lambda-durable-functions-for-the-job-and-clip-workflows).** The queue, dead-letter queue,
publisher, scheduler and perf-check are removed.

- **Context.** Confirm should return at once; uploads to platforms are slow and fail sometimes; each post needs a check
  exactly 48 hours after it goes live.
- **Decision.** Confirm writes the posts and sends one message to SQS `cf-prod-publish`; the publisher Lambda (batch 1)
  posts and then creates a one-time EventBridge Scheduler schedule `perf-<postId>` at posted time + 48 h, which invokes
  the perf-check Lambda. Failed messages land in a dead-letter queue.
- **Alternatives.** A cron that scans for due posts (scans, and up to one interval late); Step Functions with a wait
  state (pays for nothing useful here).
- **Consequences.** Exact timing, retries for free, and nothing runs when nothing is due.
