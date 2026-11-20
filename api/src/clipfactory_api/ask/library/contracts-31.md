## 31. The live status line (owner request, 2026-11-20)

### 31.1 The owner's words and what they mean

On the job page of a resumed job the owner circled the line under the progress bar ("Picking up where it stopped…")
and asked: "Make that line like a status: show everything in real time, what it's running right now, commands or
whatever it might be, in one line." So the line under the bar now says what the job is doing at this moment, and moves
on its own while the job runs, on the job page, in the Jobs list and in Home's "Working now". The decision and the
options are in [ADR-55](DECISIONS.md#adr-55-the-live-status-line-a-small-item-of-its-own-from-fixed-templates).

### 31.2 What the owner sees

One line under the bar: a big plain sentence, a small grey detail and a tiny "what is running" line in monospace.

| Step | Sentence | Detail | What is running |
|---|---|---|---|
| download | Getting the video | 412 MB of 1.2 GB · 34% | yt-dlp · 4 MB/s |
| transcribe | Writing down the words | 3 of 8 parts done | Amazon Transcribe |
| watch | Watching the video with Claude | 2 of 5 parts done · 0:48 | Claude Fable 5.1 · thinking |
| select | Picking the best moments with Claude | 0:21 | Claude Fable 5.1 · thinking |
| render | Cutting clip 3 of 10 (or Getting the full video, while the one big download runs) | 0:41 of 0:58 | ffmpeg · 1080×1920 · 30 fps |
| checklist | Checking clip 4 of 10 | 1:12 | Claude Fable 5.1 · thinking |
| captions, finalize | the step's own note (§30.6a), e.g. "Saving clip 2 of 10" | | |
| resumed | Picking up where it stopped | 6 steps already done | |

* "Commands", made safe: the tiny line comes only from fixed templates with number slots. A real command line, path,
  link, cookie or token never reaches it.
* During a model call the agent writes once, with `since` (when the call started); the web counts the seconds itself.
* Until the first live line arrives the job's own note shows as before (§30, `JobNote`); the first line replaces it.
  Once the job ends the line goes away and the step's final message shows in the timeline.
* Jobs list and Home: a compact form, one line with an ellipsis (`clamp-1`): "Cutting clip 3 of 10 · 0:41 of 0:58 ·
  60%". No "what is running" line there.

### 31.3 The item and how it travels

* `JOBLIVE#{jobId}` (§6 table) is its own small item (< 1 KB), replaced whole on every write, so the big job item
  (with its `steps`) is not rewritten every second. `ttl` is 7 days after each write. `lastChange` is when the words last really changed.
* Agent (`agent/src/clipfactory_agent/livestatus.py`): `LiveStatus.emit(kind, **numbers)`. Kinds are a fixed list
  (`step`, `note`, `resume`, `download`, `transcribe_part`, `watch_part`, `bedrock`, `bedrock_done`, `cut`,
  `cut_progress`, `cut_done`, `check`, `captions`, `save`); an unknown kind and any extra field are ignored. Every value passes
  `scrub` (`util.redact_urls`, then links, paths and key-like strings removed; one line; sentence ≤ 80 characters,
  detail and tech ≤ 60).
* The render step cuts clips several at a time: each ffmpeg reports with its own clip number (`cut_progress` carries
  `i`, and the render size `w`, `h`, `fps`, so the tiny line is never typed by hand), `cut_done` ends a clip, and the
  line follows the lowest clip still being cut with that clip's own numbers. The one big YouTube download of the Cut
  step and the Watch step's picture download report like the audio (`download`, `full` for the big one); the small
  per-clip section downloads do not (they run in parallel and are short).
* Writes go one at a time under a lock (the newest words are written last), and a failed write is tried again after
  the throttle gap, not lost until the next refresh. The transcribe and watch parts are "i of n parts done" (the parts
  run at the same time). A run that has just been taken over can still write for up to a heartbeat; the web drops its
  lines by `run`, and the line may flicker back to the note for that moment (accepted: the put is not fenced).
* Throttle: at most one write a second, only when step, sentence, detail, tech or `since` changed, plus a refresh
  every 30 s while nothing changes. A new step writes at once. Writes are best effort: a failed write is logged
  (`job.live_write_failed`) and never fails the job. After the job ends or a newer run owns it, nothing more is written.
* `emit` reaches the running job's line through a context variable set by `Tracker.begin`, so yt-dlp, ffmpeg and model
  calls deep inside a step report without being handed the tracker. Outside a job it does nothing.
* An `emit` from the event loop is a sign of life for the step watchdog (§30.6a). `Tracker.say` keeps writing
  `steps[].message` as before and also feeds the line (`note`).
* Where the numbers come from: yt-dlp's `--newline` progress (`[download] 34.2% of ~1.20GiB at 4.10MiB/s`); ffmpeg's
  `-progress pipe:1 -nostats` (`out_time_us`, read line by line by `proc.run(on_out_line=…)` and not kept) divided by
  the clip length; the transcribe and watch parts counted; `Bedrock._call` wrapped in `livestatus.thinking`.
* Broadcast (§14.2): the stream filter adds the `JOBLIVE#` prefix (`JOB#` never matches it), and `broadcast.py` sends
  `{type: "jobLive", op: "upsert", id: jobId, item}` built by `jobs.public_live`: only `jobId`, `step`, `text`,
  `detail`, `tech`, `since`, `i`, `n`, `pct`, `at`, `lastChange`, and `run` in place of `sessionId`. Per batch the last record of an
  item wins, as for heartbeats.
* `run` is a 10-character hash of the job's `sessionId` (which never leaves the server). `public_job` now also carries
  `run`; the web drops a line whose `run` is not the job's, so a line from an older run never shows.
* `GET /v1/jobs` attaches `live` to each job that is `queued` or `running`, from one `begins_with(JOBLIVE#)` query, and
  only when some job on the page is working. `GET /v1/jobs/{id}` reads the one item while the job works.
* Web: `web/src/lib/jobLive.ts` holds the newest line per job for the whole app (one listener on the shared
  connection); `pickJobLive` shows the newer of the pushed and the fetched line, only while the job is queued or
  running and only for its run. `LiveLine.tsx` draws it. Nothing new polls: with the socket down, the 30-second poll
  brings `live` along with the jobs.

### 31.4 When updates stop

* No new line for 60 s (the agent writes one at least every 30 s, so it is not answering), or lines keep coming but
  `lastChange` (when the words last really changed; `at` also moves with the refresh) is 5 minutes old: "Still working:
  <step label>" with "last update 2 min ago", and the dot turns grey. Ages are the difference of the agent's own times
  plus the time since this device received the line, never the device clock against the agent's, so a wrong phone
  clock changes nothing. The counted seconds of a model call work the same way and never go below 0.
* Ending a stuck step stays the step watchdog's job (§30.6a); the line adds nothing to it.
* Socket down: the Live dot shows it; the line keeps its last words and their age.

### 31.5 Accessibility and motion

* The visible words are not a live region. On the job page a visually hidden `role="status"` (`aria-live="polite"`)
  is the one place that says the step: only the sentence, only when the step or the clip number changes, never the
  seconds or MB (the progress panel's hidden text says only the percent). In the compact form the line is
  `aria-live="off"` and does not remount its text (Home's list is a live region), and the detail is `aria-hidden`.
* No edges, no `cursor:`; the detail and tech colors are the theme's `--ink-2`/`--ink-3` (AA on glass, both themes).
* The sentence fades in over 150 ms when it changes; with reduced motion (system or the app's setting) it changes at once.

### 31.6 Cost

About one 1 KB write a second only while a job runs and its words change: roughly 3,600 writes and WebSocket messages
per job-hour, well under 0.01 USD each on demand.

### 31.7 Tests

`agent/tests/test_livestatus.py` (templates, unknown kinds, throttle, 30 s refresh, scrub of links, paths and keys,
sessionId, a failed write, sign of life, resume), `test_proc.py` (stdout lines for `-progress`);
`api/tests/test_job_live.py` (allowed fields, `run`, broadcast type and coalescing, `live` only while working and only
for the job's run); `infra/modules/realtime/tests/websocket.tftest.hcl` (the filter has `JOBLIVE#`);
`web/test/liveLine.test.tsx` (words, live updates, other runs, the note fallback, counted seconds, stale, aria-live,
compact); `web/e2e/live.spec.ts` (the line moves over the mock socket on the job page, the Jobs list and Home, no polls,
nothing runs out of its box at any width).
