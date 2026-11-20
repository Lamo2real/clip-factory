## 30. Jobs that never stop partway (owner request, 2026-11-19)

### 30.1 The owner's words and what they mean

"Why does this happen? ... It should not cut, like when they cut the clip, it should always work." An uploaded
26-minute video stopped at Cut the clips with "Making the clips stopped partway. Tap Try again." That sentence came
only from the job flow's timeout path (no heartbeat for 15 minutes): the agent's container went quiet during Cut, and
nothing resumed the job. The cause and the alternatives are in [ADR-54](DECISIONS.md#adr-54-resume-dont-fail).

### 30.2 Resume, don't fail (`api/src/clipfactory_api/flows/job_flow.py`)

* Resumes are limited by progress, not by count alone: `MAX_RESUMES = 6` in all, of which at most `MAX_STALLED = 2`
  may follow an attempt that made no progress. `start-agent-n` returns the job's `progress` when the attempt starts;
  `resume-n` compares it with the job's progress now (more than 0.001 higher: it moved forward) and returns
  `stalled`, the count so far. A third attempt in a row that does not move the job fails it, so a job that keeps
  cutting more clips between deaths is never failed for dying, only for being stuck. Resumable: a callback timeout, a missed heartbeat, and the agent's `AgentStopped` failure (it got
  SIGTERM: a stopped session or a retired runtime version). Never resumed: `JobFailed`, `Canceled`, `Superseded`, a job
  the owner canceled or retried meanwhile, or a job with under 20 minutes left of its 8 h (the execution timeout is
  8.5 h).
* Step `resume-n` (`begin_resume`) is one conditional UpdateItem on `status IN (queued, running) AND sessionId = :old`
  that sets `status: queued`, a new `sessionId`, `resumes: n`, `pickUp: true`, `note: "Picking up where it stopped…"`,
  `heartbeatAt`, `updatedAt`. It removes and resets nothing: steps, progress, clip count and saved files stay. The new
  `sessionId` is the fence (§13): the old container can no longer write. Then step `stop-old-n` stops the old session,
  and `agent-done-n` / `start-agent-n` invoke `DEFAULT`, the newest runtime version.
* The 8 h budget counts from `runStartedAt` (written by Try again) or else the first step's `startedAt`.
* After the last resume: `failed`, "Making the clips stopped. Tap Try again to pick up where it left off.", with
  `pickUp: true`.

### 30.3 Heartbeat thread (`agent/src/clipfactory_agent/heartbeat.py`)

* A daemon thread with its own boto3 Lambda client sends the heartbeat every **120 s**; a failed send is tried again
  after **20 s**; the time of the last beat is set only after a send went through. Flow side: heartbeat timeout
  **6 minutes**.
* It beats only while the event loop is alive: a task of its own (`keep_ticking`: no I/O, no lock, never the Job item
  write, which can wait minutes on a throttled table or a full thread pool) ticks a `Liveness` every 5 s; after
  **300 s** without a tick it logs `agent.loop_stalled` and stops beating, so the flow resumes the job.
* Every beat logs `agent.mem` (`current`, `max`, `oom_kills` from cgroup v2, `/proc/meminfo` as a fallback).
* SIGTERM: uvicorn runs the app's shutdown; every running job stops as `stopped` (not `canceled`: nothing is written)
  and sends `AgentStopped` with "Picking up where it stopped…"; the flow resumes it at once.

### 30.4 The Cut step uses bounded memory

* An upload is downloaded to the disk once per run (when its size plus 3 GiB fits) and cut locally; else from S3 with
  `-rw_timeout 60 s`. `cut.work_disk` logs the work folder's filesystem type (`/proc/mounts`) and free space; on a
  filesystem kept in memory (`tmpfs`, `ramfs`) the copy is made only when it takes at most a quarter of free memory.
* The section cut: `-vf scale='min(1920,iw)':-2:flags=bicubic,fps=30 -crf 18 -threads 2`.
* The payoff tease is its own input (`-ss t0 -t d -i section.mp4` as `[1:v]`/`[1:a]`; `anullsrc` moves to input 2),
  so `concat` never holds the body's frames while it waits for the tease. The render runs with
  `-filter_complex_threads 1` and `-threads 2`.
* `RENDER_CONCURRENCY = 2` is a ceiling: a second clip starts only for a source up to 1080p and with more than 3 GiB of
  free memory (from one source: the cgroup's `memory.max` minus `memory.current`, else `MemAvailable`). The height is
  the upload's own (`meta.sourceHeight`); a link's sections are 1080p at most.
* Picking up (`pickUp`): clips are cut one at a time. Before each cut, `render/NN/started.json` records the session
  and `runs`, the runs that were cutting this clip when they stopped (this one included; an ordinary failure writes
  0). A clip whose marker comes from another session with `runs: 1` is cut last, alone; with `runs: 2` or more
  (`MAX_CLIP_DEATHS`) it is left out ("could not be cut") and the rest of the job finishes.
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
| Checked clips | `checked.json` (`version: 1`, `chosen`: the chosen moments, per passed clip: `index`, `moment`, `items`, `fixes`), written by `checklist`; the clips it re-cut or brought in as spares in `checked/NN/` (same files as `render/NN/`) | with the moments picked last time, `render` brings every checked clip back ("Used the N clips cut and checked last time.") and `checklist` does not run again ("Used the checks from last time for N clips."); without `checked.json` (a run from before it existed) the same from `clips.json`, with the measured checks taken again from the file and Claude's review shown as passed on the run before; a clip whose file was never saved is cut once more from its saved moment |
| Clip ids and captions | `clips.json` (`version: 1`; per clip index: `id`, `moment`, `captions`), written by `captions` | each clip keeps the id the stopped run gave it; the captions are reused when every clip is the same moment |
| Earlier steps | as before (audio, words, picture, what was watched) | always |

* `finalize`, picking up, skips a clip whose Clip item already exists (`clip_statuses`): a clip the stopped run wrote
  is never written twice, and one the owner kept or declined is left alone. Its files stay when a newer run
  supersedes it, because that run uses the same ids.
* A resumed run keeps the steps already done (they reload quietly and stay done) and the progress; its `begin` writes
  no `clipCount: 0`. The agent removes `note` and `pickUp` when it writes `ready` or `failed`.
* **Try again** keeps the job id, so the saved files. After a stop (`pickUp: true` on a failed job) it keeps
  `pickUp`, the done and skipped steps (the stopped step and later ones go back to pending) and `progress`, and shows
  "Picking up where it stopped…". It picks up the same way (`api/jobs.picks_up`) when the run failed at Write the
  captions or Finish up (every clip was cut and checked: not the video's fault), and after Stop job once Cut the clips
  was done. After any other failure it removes `pickUp` and starts over as before. `runStartedAt` starts the run's 8 h budget. `pickUp`, `resumes` and `runStartedAt` are internal (not in the API's job JSON); `note` is.
* The checklist is saved once it is done (`checked.json`); a run that stops while checking checks again, from the
  reused clips.
* The fenced clip writes (§13) pass plain values to the table resource's client, which types them itself. Typed values
  (`{"S": ...}`) were typed a second time into maps, so DynamoDB refused the job check with `[ValidationError, None]`
  and Finish up could never write a clip (owner report 2026-11-20). A refused transaction logs `ddb.txn_failed` with
  each item's code and DynamoDB's message.

### 30.6a Long steps show they are alive, and always end (owner report 2026-11-20)

* Check each clip checks 3 clips at once (`CHECK_CONCURRENCY`); re-cuts and spares share the Cut step's RenderGate.
  The job page shows what the step is doing under it (`steps[].message` while running, replaced by the final
  message): "Checking 10 clips…", "Checking clip 4 of 10…", "Swapping 2 clips for better moments. Checked 6 of 10.",
  "Writing captions for 10 clips…", "Saving clip 3 of 10…", "Getting the 10 checked clips from last time…". The bar
  moves within a step (between finished checks, and while the captions are written) and stays below 100% until the
  job is ready.
* Time limits, far above a slow but healthy run: one Converse try 12 min (`bedrock.CALL_SECONDS`, then tried again,
  4 tries); one review 12 min (then the measured checks decide, "Claude could not review this clip; check it
  yourself."); one clip's whole check or one spare's cut 25 min (then it is swapped for a spare like any clip that
  could not be checked); the captions 15 min (then the plain template). When nothing passed only because nothing
  could be checked, the clips go on to the owner with one item "Checked: This clip could not be checked; look at it
  yourself before posting." and the job finishes.
* The step watchdog (`jobs.STALL_SECONDS`, per step: e.g. checklist 40 min, captions and finalize 30 min): a step with
  no sign of life (progress or a new note; the bar creeping on its own is none) for that long is ended with
  "<Step> stopped moving. Tap Try again to pick up where it left off." and `pickUp`, so the heartbeat can never keep a
  stuck job "working".
* A model Bedrock refuses as not turned on (`model_unavailable`) ends the job at once with "Claude is not turned on
  for your AWS account yet. In AWS, open Amazon Bedrock in Stockholm (eu-north-1), go to Model catalog, open Claude
  Opus 5.5 and Claude Opus 4.8, and turn on access. Then tap Try again." It is never tried again.
* Logs: `job.step_start`, `job.step_done` (seconds), `job.step_note`, `job.step_stalled`, `checklist.clip_checked`
  (index, outcome, seconds, fixes), `checklist.clip_timed_out`, `checklist.saved`, `checklist.reused`,
  `finalize.clip_saved`.

### 30.7 Deploys wait for running jobs

`deploy.yml` runs `scripts/wait-for-jobs.sh` between the delete gate and `terraform apply`. When nothing under
`module.agent` changes it goes on at once. Otherwise it counts jobs that are `queued`/`running` with a heartbeat newer
than 3 minutes (a projection-only Scan every 30 s, counts only in the log) and waits until there are none, at most 25
minutes (the step stops at 27 and may fail without stopping the deploy), so the apply keeps its whole 90-minute image
build inside the job's 120 minutes and is never killed partway. A Scan that fails is tried three times; then the drain
goes on without waiting. A job still running resumes on the new version (§30.2). It reads only; no IAM change.

### 30.8 Owner words

| Moment | Words |
|---|---|
| Resumed automatically, or Try again after a stop (note under the progress) | "Picking up where it stopped…" |
| One clip skipped | "Cut 9 clips; 1 could not be cut." |
| Gave up (stuck: two resumes without progress, or 6 in all) | "Making the clips stopped. Tap Try again to pick up where it left off." |
| Nothing could be cut | the agent's own sentence (unchanged) |

### 30.9 Tests

`agent/tests/test_heartbeat.py`, `test_proc.py`, `test_resume.py`, `test_callback.py`, `test_long_steps.py`,
`test_progress.py`, `test_session_fence.py`; `api/tests/test_flows.py`
(resume, never resuming the agent's own outcomes or a canceled job, time left, replay names), `test_jobs.py` (Try
again); `web/test/jobNote.test.tsx`; `scripts/test-wait-for-jobs.sh`, `scripts/test-deploy-workflow.sh`.
