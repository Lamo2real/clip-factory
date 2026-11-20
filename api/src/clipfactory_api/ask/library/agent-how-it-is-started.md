## How it is started

The durable `cf-prod-job-flow` (step `start-agent`) invokes the runtime with the job's session
(`runtimeSessionId = cfjob-<jobId>-<8 random chars>`, chosen by the API); the API itself sends only `cancel`
([CONTRACTS.md §14.4](CONTRACTS.md#144-durable-function-cf-prod-job-flow-terraform-module-flows)):

| Payload | Answer | Effect |
|---|---|---|
| `{ "action": "process_job", "jobId", "userId", "callbackId" }` | `{ "accepted": true, "jobId" }` at once | The job runs in the background in that session. A second `process_job` for a job already running there is accepted and ignored (the step is at-least-once). |
| `{ "action": "cancel", "jobId" }` | an acknowledgement | Stops downloads and ffmpeg, marks the job `canceled`. |
| `{ "action": "health" }` | `{ "ok": true }` | Smoke test after a deploy. |

While a job runs, `GET /ping` answers `HealthyBusy`, so AgentCore keeps the session alive; it answers `Healthy` when
idle. The agent writes `heartbeatAt` at least every 60 seconds and, from the same loop, sends a callback heartbeat to the
job flow every 2 minutes from its own thread, only while the event loop is alive (CONTRACTS §30.3). If those stop for
6 minutes, or the container gets SIGTERM (it then sends `AgentStopped`), the job flow resumes the job on a new session
from what it saved, at most twice; only then is it failed ("Making the clips stopped. Tap Try again to pick up where it
left off."). When the job ends the agent sends the callback: **success** after `finalize` wrote the job
`ready`, or a **failure** with `JobFailed` (with the job's plain error), `Canceled` or `Superseded` (a retry started a
newer session). Callback errors are retried 3 times and never fail the job; without a `callbackId` (local runs, tests)
nothing is sent.
