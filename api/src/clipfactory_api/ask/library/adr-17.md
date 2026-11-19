## ADR-17 A watchdog Lambda instead of an orchestrator

**Replaced by [ADR-22](#adr-22-lambda-durable-functions-for-the-job-and-clip-workflows).** The watchdog and its
10-minute rule are removed; the job flow's callback heartbeat timeout does the job.

- **Context.** If the agent container dies, nothing else would mark the job as failed.
- **Decision.** The agent writes `heartbeatAt` at least every 60 seconds. An EventBridge rule runs `cf-prod-watchdog`
  every 10 minutes; any running job with a heartbeat older than 15 minutes is marked failed with a Retry hint.
- **Alternatives.** Step Functions around the agent (adds a second state machine for one long step).
- **Consequences.** A stuck job is visible within about 25 minutes and the owner can retry it with one tap.
