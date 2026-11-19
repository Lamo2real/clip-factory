## 30. Jobs that never stop partway (owner request, 2026-11-19)

### 30.1 The owner's words and what they mean

"Why does this happen? ... It should not cut, like when they cut the clip, it should always work." An uploaded
26-minute video stopped at Cut the clips with "Making the clips stopped partway. Tap Try again." That sentence came
only from the job flow's timeout path (no heartbeat for 15 minutes): the agent's container went quiet during Cut, and
nothing resumed the job. The cause and the alternatives are in [ADR-54](DECISIONS.md#adr-54-resume-dont-fail).

### 30.2 Resume, don't fail (`api/src/clipfactory_api/flows/job_flow.py`)

* `MAX_RESUMES = 2`. Resumable: a callback timeout, a missed heartbeat, and the agent's `AgentStopped` failure (it got
  SIGTERM: a stopped session or a retired runtime version). Never resumed: `JobFailed`, `Canceled`, `Superseded`, a job
  the owner canceled or retried meanwhile, or a job with under 20 minutes left of its 8 h (the execution timeout is
  8.5 h).
* Step `resume-n` (`begin_resume`) is one conditional UpdateItem on `status IN (queued, running) AND sessionId = :old`
  that sets `status: queued`, a new `sessionId`, `resumes: n`, `pickUp: true`, `note: "Picking up where it stopped…"`,
  `heartbeatAt`, `updatedAt`. It removes and resets nothing: steps, progress, clip count and saved files stay. The new
  `sessionId` is the fence (§13): the old container can no longer write. Then step `stop-old-n` stops the old session,
  and `agent-done-n` / `start-agent-n` invoke `DEFAULT`, the newest runtime version.
* After the last resume: `failed`, "Making the clips stopped. Tap Try again to pick up where it left off.", with
  `pickUp: true`.

### 30.3 Heartbeat thread (`agent/src/clipfactory_agent/heartbeat.py`)

* A daemon thread with its own boto3 Lambda client sends the heartbeat every **120 s**; a failed send is tried again
  after **20 s**; the time of the last beat is set only after a send went through. Flow side: heartbeat timeout
  **6 minutes**.
* It beats only while the event loop is alive: the loop ticks a `Liveness` every 5 s (the Tracker's loop); after
  **300 s** without a tick it logs `agent.loop_stalled` and stops beating, so the flow resumes the job.
* Every beat logs `agent.mem` (`current`, `max`, `oom_kills` from cgroup v2, `/proc/meminfo` as a fallback).
* SIGTERM: uvicorn runs the app's shutdown; every running job stops as `stopped` (not `canceled`: nothing is written)
  and sends `AgentStopped` with "Picking up where it stopped…"; the flow resumes it at once.

### 30.4 The Cut step uses bounded memory

* An upload is downloaded to the disk once per run (when its size plus 3 GiB fits) and cut locally; else from S3 with
  `-rw_timeout 60 s`.
* The section cut: `-vf scale='min(1920,iw)':-2:flags=bicubic,fps=30 -crf 18 -threads 2`.
* The payoff tease is its own input (`-ss t0 -t d -i section.mp4` as `[1:v]`/`[1:a]`; `anullsrc` moves to input 2),
  so `concat` never holds the body's frames while it waits for the tease. The render runs with
  `-filter_complex_threads 1` and `-threads 2`.
* `RENDER_CONCURRENCY = 2` is a ceiling: a second clip starts only for a source up to 1080p and with more than 3 GiB of
  free memory.
* `proc.run`: every child runs in its own process group and gets `oom_score_adj 1000` (Linux); a timeout, a cancel, a
  stall (`stall_limit`, opt-in) or any error kills the whole group (SIGTERM, SIGKILL 5 s later). Every call site passes
  `time_limit` (a test checks).
* A clip whose ffmpeg the kernel killed (SIGKILL) is tried once more with nothing cut alongside, then skipped; one bad
  clip is skipped as before ("Cut 9 clips; 1 could not be cut.").

### 30.5 YouTube machinery only for YouTube

The PO token sidecar starts the first time a YouTube call needs it, never at app start. `_save_info`, `_ensure_full`
(`full_lock`) and `_cut_full` raise for an upload.

### 30.6 Checkpoints and Try again

| Saved | Key under `jobs/{jobId}/source/` | Reused when the job has `pickUp` |
|---|---|---|
| Chosen moments | `moments.json` (`version: 1`, `settings`: hash of notes, clip target and model) | `select` returns "Used the N moments picked last time." without a model call, when `settings` match |
| Each finished clip | `render/NN/clip.mp4`, `cover.jpg`, `done.json` (written right after the clip, `done.json` last) | `render` downloads it back instead of cutting it, when its moment matches |
| Earlier steps | as before (audio, words, picture, what was watched) | always |

* A resumed run keeps the steps already done (they reload quietly and stay done) and the progress; its `begin` writes
  no `clipCount: 0`. The agent removes `note` and `pickUp` when it writes `ready` or `failed`.
* **Try again** keeps the job id, so the saved files. After a stop (`pickUp: true` on a failed job) it keeps
  `pickUp` and shows "Picking up where it stopped…"; after a real failure it removes `pickUp` and starts over as
  before. `pickUp` and `resumes` are internal (not in the API's job JSON); `note` is.
* Not checkpointed: the checklist and the captions (they re-run, from the reused clips).

### 30.7 Deploys wait for running jobs

`deploy.yml` runs `scripts/wait-for-jobs.sh` between the delete gate and `terraform apply`. When nothing under
`module.agent` changes it goes on at once. Otherwise it counts jobs that are `queued`/`running` with a heartbeat newer
than 3 minutes (a projection-only Scan every 30 s, counts only in the log) and waits until there are none, at most 45
minutes; then it goes on, and a job still running resumes on the new version (§30.2). It reads only; no IAM change.

### 30.8 Owner words

| Moment | Words |
|---|---|
| Resumed automatically, or Try again after a stop (note under the progress) | "Picking up where it stopped…" |
| One clip skipped | "Cut 9 clips; 1 could not be cut." |
| Gave up after 2 resumes | "Making the clips stopped. Tap Try again to pick up where it left off." |
| Nothing could be cut | the agent's own sentence (unchanged) |

### 30.9 Tests

`agent/tests/test_heartbeat.py`, `test_proc.py`, `test_resume.py`, `test_callback.py`; `api/tests/test_flows.py`
(resume, never resuming the agent's own outcomes or a canceled job, time left, replay names), `test_jobs.py` (Try
again); `web/test/jobNote.test.tsx`; `scripts/test-wait-for-jobs.sh`, `scripts/test-deploy-workflow.sh`.
