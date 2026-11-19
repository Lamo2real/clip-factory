## ADR-03 Amazon Bedrock AgentCore Runtime + Claude Agent SDK for the agent

- **Context.** A job runs 20–60 minutes, uses ffmpeg and yt-dlp, needs a writable disk and loads skills. Lambda stops
  at 15 minutes.
- **Decision.** One AgentCore Runtime (`cf_prod_clip_agent`), an ARM64 container that answers `/ping` and
  `/invocations`. Each job gets its own session (`cfjob-<jobId>-<random>`). Inside it the Claude Agent SDK runs with
  `CLAUDE_CODE_USE_BEDROCK=1`, so skills in `.claude/skills/` load natively. The container reports `HealthyBusy` while
  a job runs so AgentCore keeps the session alive.
- **Alternatives.** Step Functions + Lambda (15-minute limit per step and no shared disk for ffmpeg); ECS Fargate
  (works, but means managing tasks, networking and scaling ourselves); AWS Batch (same).
- **Consequences.** Serverless and pay-per-use. A session ends after its idle or maximum lifetime; very long sources
  are capped by `maxSourceHours`. The API only starts and cancels; the agent owns the job's progress.
