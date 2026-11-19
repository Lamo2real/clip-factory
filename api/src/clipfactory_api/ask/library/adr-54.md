## ADR-54 Resume, don't fail

Checkpointed jobs, an independent heartbeat thread, and deploys that drain the agent.

- **Context.** The owner's upload (26 min, AV1 1080p60) stopped at Cut the clips, 79 %, with "Making the clips
  stopped partway. Tap Try again." That sentence came only from the job flow's missed-heartbeat path: the agent went
  quiet for 15 minutes during Cut. The job started at about 16:08 UTC, right after the PR #48 deploy updated the
  runtime (16:04:59 to 16:08:37). Likely causes, from the code and local measurements: (A) the container ran out of
  memory during Cut (two clips at once, each decoding the full-size source twice, and the render's tease-first
  `concat` holding every body frame: 0.94 to 3.48 GB measured as the tease moves later); (B) the deploy ended or
  orphaned the session; (C) heartbeats lost (the last-beat time was set before the send, so a failed send waited a
  whole 5 minutes). Whatever the cause, nothing resumed the job and nothing it had cut was kept.
- **Cause confirmed (read-logs run of 2026-11-19, window 15:45-16:45 UTC).** The job ran in one session on the new
  version (its session's log starts 16:07:55, after the image build at 16:06:31; no second `runtime.started`), so the
  deploy did not end it (B ruled out). Heartbeats went out on time at 16:07:58, 16:12:59 and 16:17:59 with no failed
  send (C ruled out). The session's log then simply ends at 16:21:47, during Cut, with no error, no traceback, no
  job outcome and no shutdown line: the container died or froze hard, not a graceful stop and not a Python error. The
  flow's heartbeat timeout fired at 16:33:02, 15 minutes after the last beat. That fits cause A, memory, best; no memory
  was logged then, which is why every beat now logs `agent.mem`.
- **Options.** Pin the agent to a runtime endpoint moved only after a smoke test (protects deploys only, not memory or
  a frozen loop); drain deploys (protects deploys only); resume from checkpoints (covers all three causes, and any we
  have not thought of). Bigger containers do not fix a frozen loop or a deploy.
- **Decision.** (CONTRACTS §30) Resume, don't fail: the flow resumes a stopped job on a new session up to twice, from
  saved moments and clips; heartbeats come from a thread that beats only while the loop is alive, every 2 minutes,
  with a 6-minute timeout, and log memory; SIGTERM tells the flow at once; the Cut step's memory is bounded; deploys
  wait up to 45 minutes for running jobs when the agent changes. The pinned endpoint stays a later option, only if
  the logs keep showing deploy kills.
- **Consequences.** A stop costs minutes, not the job; the owner sees "stopped" only after two resumes, and even then
  Try again picks up. A resumed job may cut again a clip that was half done. The flow's first attempt keeps its
  operation names, so executions started before this change replay unchanged.
