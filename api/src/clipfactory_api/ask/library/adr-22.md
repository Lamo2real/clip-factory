## ADR-22 Lambda durable functions for the job and clip workflows

- **Context.** Two long-running workflows had grown out of loose parts. A job needed a watchdog Lambda on a 10-minute
  rule to notice a dead agent. A kept clip went through an SQS queue and dead-letter queue, a publisher Lambda, a
  one-time EventBridge Scheduler schedule per post and a perf-check Lambda 48 hours later. Each hand-off was another
  resource, role and failure mode. The owner asked for "Lambda, and durable functions in Lambda". Lambda durable
  functions became generally available on 2 December 2025 and reached `eu-north-1` on 18 December 2025 (`python3.13`).
- **Decision.** Two durable functions written in Python with `aws-durable-execution-sdk-python`, both invoked
  asynchronously on their `live` alias with a deterministic `DurableExecutionName`:
  - `cf-prod-job-flow` (`job-{jobId}-{run}`): creates a callback, starts the agent (step `start-agent`), waits for the
    agent's success or failure with an 8-hour timeout and a 15-minute heartbeat timeout, then `finish` or `fail` +
    `stop-session`. A missed heartbeat replaces the watchdog.
  - `cf-prod-clip-flow` (`clip-{clipId}-{run}`): `ensure-posts`, `publish-{platform}` (3 attempts with backoff),
    `settle-clip`, `wait-48h`, `metrics`, `distil`, `upsert-vector`.
  Execution timeouts 30 600 s and 259 200 s, retention 14 days, `publish = true`, alias `live`, alarms on
  `DurableExecutionFailed` and `DurableExecutionTimedOut`.
- **Alternatives.**
  - *Keep SQS + Scheduler + watchdog* (ADR-12, ADR-17): works, but six resources and three roles for two workflows,
    and stuck jobs were found by scanning, up to 25 minutes late.
  - *AWS Step Functions*: a mature fit with task tokens and wait states, but the workflow would live in Amazon States
    Language rather than Python next to the code it calls, every state transition is billed, and tests need a second
    toolchain. The owner asked for Python and for durable functions.
  - *A long Lambda polling the agent*: 15-minute limit, pays for waiting.
- **Consequences.** The workflow reads top to bottom as Python and is unit-tested with a fake durable context. Waiting
  (for the agent, for 48 hours) costs nothing. Retries and checkpoints come from the SDK, so steps must be idempotent
  (they are at-least-once): post creation is guarded by `postsCreated`, post updates by `status = queued`, and
  publishing uses `postId` as the idempotency key. Duplicate starts are harmless because the execution name and
  payload are deterministic. Durable functions support no Lambda destinations, and durable settings can only be set
  when a function is created. Running executions stay pinned to the version they started on, so deploys never change
  a flow in flight; old versions are kept. The agent role needs the three `lambda:SendDurableExecutionCallback*`
  permissions on `function:cf-prod-job-flow:*`.
