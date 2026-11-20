## 8. Agent (AgentCore Runtime `cf_prod_clip_agent`)

* Container: ARM64, plain HTTP on port 8080, `GET /ping` → `{"status": "Healthy" | "HealthyBusy"}` (HealthyBusy while
  a job runs, so AgentCore keeps the session), `POST /invocations`.
* Invocation payload (`process_job` from the durable Lambda `cf-prod-job-flow`, §14.4; `cancel` from the API Lambda;
  both via `bedrock-agentcore:InvokeAgentRuntime`, `runtimeSessionId = "cfjob-" + jobId + "-" + 8 random chars`,
  ≥ 33 chars, chosen by the API and stored on the Job as `sessionId`):
  `{ "action": "process_job", "jobId": "...", "userId": "...", "callbackId": "..." }` → immediate
  `{ "accepted": true, "jobId": "..." }`; the job runs in the background and ends by sending the durable callback
  (§14.4). A second `process_job` for a job already running in this container is answered `accepted` and ignored.
  `callbackId` is optional only for local runs and tests (no callback sent). `{ "action": "cancel", "jobId" }` stops it.
  `{ "action": "health" }` → `{ "ok": true }`.
* The agent owns the job's `status`, `steps`, `progress`, `heartbeatAt` (every ≤ 60 s while running) and creates the Clip
  items (status `review`) and their vectors (§14.6). It never publishes anything.
* Model: environment `CF_MODEL_ID = global.anthropic.claude-fable-5-1`; Claude Agent SDK with
  `CLAUDE_CODE_USE_BEDROCK=1`, `ANTHROPIC_MODEL=$CF_MODEL_ID`. Direct Bedrock Converse calls (vision for facecam,
  structured outputs) use the same model id.
* Skills (superseded by §18.6): built-in skills from `/app/skills` plus **every** skill the owner added (no on/off
  filter) are written to `<workdir>/.claude/skills/<name>/SKILL.md` (zips extracted) so the Claude Agent SDK loads
  them; the shared skills block (§18.6) is the first part of the system prompt of **every** model call the agent makes. Right after it, the moment-picking
  prompt, the second look and every hook-writing call get "Prior learnings" (the active creator lessons, §16.12) when
  there are any. The moment-picking prompt also gets the owner's latest 4 "Best of week" learnings and the top 8
  similar past clips from S3 Vectors, the owner's best-of-week picks first ("What worked before", §14.6, §16.7). The
  retired 48-hour learnings are never sent.
* Pipeline steps (keys in §5; ten since ADR-40): resolve (yt-dlp metadata / S3 head; picks the small picture
  rendition, `meta.picture`) → download (audio only for links, capped at `maxSourceHours`; then starts the picture
  preparation in the background) → transcribe (Amazon Transcribe, word timestamps, language auto, speaker labels unless `CF_DEEP=off`; a job that
  ends FAILED with speaker labels is started once more without them, named `…-p`) →
  analyze (loudness spikes, skills, learnings, similar clips) → **watch** (Fable on frames and Nova 2 Lite on video
  watch the whole picture; merged into `visual_log.json` and `signals.json`; rules below) → select (Claude: 5–10
  moments within `clipTarget`, six moment types, hooks, reading words and picture notes; then the second look at each
  picked moment; `pickedFor` built by code) → render (ffmpeg:
  section download, facecam detection via Claude vision, 1080×1920, hook and ASS captions inside the platforms'
  safe area, a punch-in on the face at the peak, two-pass loudnorm to -14 LUFS and ≤ -1 dBTP, cover) → checklist (skill
  section D, measured + Claude judgement, one fix pass, spares replace failures) → captions (per platform, required
  tags from the owner's notes) → finalize (job `ready`, `clipCount`).
* Select coverage: after the Claude Agent SDK run ends, whatever its outcome (error, time limit, or a normal
  `success` result), every transcript window it read less than 90% of goes through the Converse fallback
  (`agent.find_with_converse`); the whole video goes through Converse when that still leaves fewer than
  `clipTarget.min` moments. In the fallback a window whose call fails for any reason (bad answer, `max_tokens`,
  throttling after retries) only loses that window's moments (`moments.window_failed` is logged), and a cancel stops
  the other windows at once (`util.gather_all`). Only when every window of a pass fails with a service error (not a
  bad answer: the model is down, not the video) is the error raised: with moments already in hand they still make clips (`agent.converse_failed`), with
  none the step retries and then fails with "A service was busy…", never "No clip-worthy moments".
* **Watch (deep analysis, ADR-40).** Everything here is optional at run time: a failure is logged, never marks the
  job failed, and the job picks from the signals it has. With no picture data the finder's prompts (`hints`,
  `transcript.lines`, `system_prompt`, the Converse gate) and the "Almost no speech…" text are byte-identical to the
  pipeline before ADR-40 (`agent/tests/test_agent.py`).
  * *Picture choice* (`sources.picture_format(info, seconds, free_bytes)`, links): every H.264 rendition of at most
    480p and 30 fps, tallest first, a video-only one before one with sound at the same height (Twitch and Kick only
    have renditions with sound, so they get their 480p one), then the smallest rendition with a picture. Size
    estimate: `filesize`, else `filesize_approx`, else `tbr × seconds / 8`, else 0.8 Mbit/s. The first whose estimate
    is at most `free disk − 3 GB` wins; none → `meta.picture = null` and no watching. Uploads:
    `{upload: true, height, fps}`.
  * *Preparation* (`Pipeline._picture_prep`, a background task started by `download` after the audio succeeded; not
    started when `CF_DEEP=off`, when `meta.picture` is null, or when a saved `visual_log.json` covers ≥ 95% of the
    source). Links: `sources.download_picture` (yt-dlp's own downloader, `--concurrent-fragments 8`, `--max-filesize`
    1.5 × the estimate, 2 h limit, `--download-sections *0-cap` only when the source is capped). Uploads: ffmpeg reads
    the presigned `video.mp4`, no copy. Failed, timed-out or canceled preparation deletes `source/picture.*` and the
    local parts. One ffmpeg decode (`picture.prepare`) with two outputs: the parts
    (`fps=2,scale=768:432` padded, libx264 veryfast crf 28, `-g 2`, no audio, 300-second segments) and the scores
    (`fps=4,scale=320:180`, `scene` score printed per frame; per second `motion` = mean, `scene` = max). An upload
    taller than 720 and longer than 45 minutes is first timed on 60 s (`picture.decode_speed`); it is decoded at
    every frame when the whole decode is expected to take at most 70% of the time limit, else at keyframes only
    (`decode: "keyframes"`; `meta.deep.decode = {status: "ok", mode}`). Time limit `picture.time_limit` =
    `max(20 min, seconds / 3)`. A part over 18 MB is encoded once more at 640×360 crf 34 (Nova's 25 MB counts either
    the raw or the base64 bytes; 18 MB fits both). The downloaded source is
    deleted; `picture.json` is written last. It never raises (but for a cancel); `Pipeline.close(st)` cancels it and
    `server.make_run` calls that in its `finally`.
  * *The step* (`Pipeline.watch`): never raises anything but `JobCanceled` / `JobSuperseded`. (1) A saved
    `visual_log.json` covering ≥ 95% with no Fable chunk lost to `busy` or `deadline` → "Used what it saw last time."
    (2) Waits for the preparation up to `picture.time_limit(seconds)` from its start; no parts → skipped. (3) Two tracks together under
    `max(25 min, 0.2 × seconds)`: **Fable** (`watch.py`), chunks of 150 s with a 6 s lead-in, 8 at a time, one frame
    per 2 s plus every frame within 3 s of up to 5 loudness or motion spikes (at most 30 extra), each image after a
    `[h:mm:ss] N s` text block, then the chunk's words (with speakers) and spikes, one
    `structured(system=WATCH_SYSTEM, skills=block, tool="report_scenes", schema=SCENES_SCHEMA, max_tokens=8000)`;
    **Nova** (`nova.py`), one call per 300 s part, 4 at a time, on a second `Bedrock` client (`CF_WATCH_MODEL_ID`,
    no cache point), content `{"video": {"format": "mp4", "source": {"bytes"}}}` plus the part's start time, same
    tool and schema, times relative to the part (code adds the offset); skipped entirely when no watch model is set,
    and stopped at the first `AccessDeniedException` / `ResourceNotFoundException`. Each answer is saved at once
    (`watch/chunk-NNNN.json`, `watch/nova-NNNN.json`) and reused by a retried job. A unit the service turned
    away as busy (after `retry.py`) is tried again after a growing pause (`RETRY_BASE` 5 s doubling to 60 s,
    `MAX_TRIES` 6 in all) while the deadline allows; each track's `Pacer` halves its calls in flight on a throttle
    (floor 1) and adds one back after as many successes in a row, and a throttled call does not count against the
    budget. A `ModelError` (refusal, bad shape) is not tried again. A `ValidationException` naming images or request
    size splits the request into near-equal groups of frames, each over its own stretch of time with its own words,
    recursively until accepted; the accepted count (named in the error, else half) is kept as `Bedrock.image_limit`
    and later chunks are sent split from the start. Every piece is tried even when another fails; a busy piece sends
    the unit round again (answered pieces are kept). (4) Both are merged into `visual_log.json` (the same kind of event within 3 s becomes one, keeping the higher intensity
    and both sources), then `signals.build` writes `signals.json`. (5) Step message: "Watched all 2:03:10. Saw 41 big
    things." (every chunk watched by at least one of the two) / "Watched most of the video (44 of 48 parts)." ("part
    of the video" under half) / "Saw where the picture moves fast. Picking with that, the words and the sound." /
    skipped with "Could not watch the video this time. Picking from the words and the sound."
  * `SCENES_SCHEMA` (strict): `{scene: string, events: [≤ 12 × {start, end: number; kind: "crash" | "explosion" |
    "chase" | "stunt" | "fight" | "fail" | "win" | "glitch" | "jump_scare" | "death_screen" | "funny_visual" |
    "face_reaction" | "on_screen_text" | "menu_or_loading" | "calm" | "other"; what: string (≤ 25 words); intensity:
    1–10; silent: boolean; face: "none" | "calm" | "laughing" | "shocked" | "angry" | "scared"; text_on_screen:
    string}]}`. Code clamps times to the chunk and drops `calm` and `menu_or_loading` events below intensity 4.
  * *Hot spots* (`signals.py`): Fable event `intensity/10 × 3`; Nova event `intensity/10 × 2`; loudness spike
    `min(jump/7, 2)`; motion spike (at least 2.5 × the median of the 150 s either side) `min(lift/2.5, 2)`;
    most-replayed peak 1. Sources within 4 s add up (each source's strongest point); two or more independent sources
    add 1; hot spots within 8 s merge; `silent` = no word within 5 s; a hot spot needs a score of at least 1.
  * *What select reads*: `transcript.lines(words, start, end, speakers)` (with speakers a line breaks on a speaker
    change and starts `S1:`); `signals.timeline` interleaves the transcript lines with picture lines
    (`[1:02:11] (seen) crash 9/10, nobody talking: car flips off the bridge | face: shocked`), the strongest 120 events
    per window, the rest counted; `hints` keeps its two lines and appends `Fast picture: …` and `Hot spots: …` (25
    per window) only when signals exist; `system_prompt` gains one picture paragraph and "never open on a still, quiet
    picture" only then, and one speaker paragraph (`SPEAKER_NOTE`: what `S1:` means, that numbers restart in long
    videos and are not names) only when speakers exist (`WATCH_SYSTEM` and `VERIFY_SYSTEM` say the same in one line); `brief_json` adds `picture: {watched, coveragePercent}`; the Converse gate reads a window
    when `len(text) ≥ 400` or it has a picture event of intensity ≥ 6 or a silent hot spot. `MOMENT_SCHEMA` is
    unchanged but for the `first_words` description; `SDK_TIMEOUT_PER_WINDOW` is 8 minutes.
  * *Few words*: `transcribe` no longer fails on fewer than 20 words; it sets `meta.fewWords`. `select` raises the
    same "Almost no speech…" sentence only when there is also no picture event of intensity ≥ 6.
  * *Second look* (`verify.py`, in `select` after the pick, for chosen moments and spares): one
    `structured(skills=block, tool="check_moment")` each with every 2 fps frame from 3 s before to 3 s after the
    moment (evenly thinned to `Bedrock.image_limit` when one is known or the request is refused for its images) and
    its words; 4 at a time, 15-minute deadline. Answer `{keep, start, end, payoff_at, peak_at, hook_ok,
    new_hook | null, picture_score 1–10, seen}`. Time moves are accepted only within 5 s of the original and the
    result goes through `moments.validate` again. `keep = false` swaps the moment for the best spare that passed its
    own look, never taking the count below `clipTarget.min`. Any failure keeps the moment as picked.
  * `pickedFor` (`signals.picked_for`, §5): the two strongest pieces of evidence inside the clip, joined with " + ":
    crash → "Big crash", explosion → "Big boom", chase → "Wild chase", stunt → "Cool stunt", fight → "Big fight",
    fail or death screen → "Big fail", win → "Big win", glitch → "Weird glitch", jump scare → "Jump scare", a face
    reaction or any face that is not calm → "Big reaction", a loudness spike with a laughing face → "Loud laugh", a
    loudness spike alone → "Loud moment", a motion spike → "Fast action", a most-replayed peak → "People rewatch
    this", two speakers trading lines → "Back and forth", a chat spike whose moment is inside the clip and that
    nothing flags → "Chat went wild" (§37). Left out when nothing matches.
  * *Other steps*: `render` cuts no pauses out of a moment that has no words inside it; the checklist review prompt
    gains a "Seen:" block (picture events inside the clip) when there are any; the measured `captions` item passes
    with "No speech to caption." when no source word lies inside the clip.
  * *Files* (`jobs/{jobId}/source/`, §7; all reused by Try again):
    ```
    meta.json    += picture: {formatId, height, fps, estBytes} | {upload: true, height, fps} | null,
                    fewWords: boolean,
                    deep: {prep, decode, fable, nova, speakers, secondLook}   // each {status: "ok" | "partial" | "skipped", reason?}
                                                                             // decode also has mode: "all" | "keyframes"
    picture.json   {version: 1, seconds, fps: 2, width: 768, height: 432, decode: "all" | "keyframes", partSeconds: 300,
                    parts: [{i, start, end, key, bytes}], motion: number[] /* per second */, scene: number[]}
    speakers.json  [[start, end, "S1"], …]          // labels are per Transcribe part: used only as line prefixes
    visual_log.json {version: 1, coverage: [[s, e], …], fable: [[s, e], …], nova: [[s, e], …],
                    failed: [{start, end, src, reason}],
                    events: [{t0, t1, kind, what, intensity, silent, face, text, src: ("fable" | "nova")[]}]}
    signals.json   {version: 1, coverage: {picture, fable, nova, motion, speakers},   // 0..1 of the source
                    hotspots: [{t, score, silent, sources: [], reasons: []}]}  // sources may include "chat" (§37)
    chat.json      §37.4: the chat hype signal (replay or chat box), no names or messages
    moments.json   {chosen: […], spares: […], secondLook: […]}                        // for debugging a job
    ```
  * *Limits* (technical only; there is no cost ceiling, ADR-40): `CHUNK_SECONDS` 150, `CHUNK_OVERLAP` 6,
    `PART_SECONDS` 300, `WATCH_CONCURRENCY` 8, `NOVA_CONCURRENCY` 4, `VERIFY_CONCURRENCY` 4, `GRAB_CONCURRENCY` 2,
    `MAX_CHUNKS` 400, `DISK_RESERVE` 3 GB, `PART_MAX_BYTES` 18 MB, `MAX_TRIES` 6. Model calls run in their own 16-thread pool
    (`bedrock.py`), so heartbeats never wait behind them. **Runaway guard** (`guard.py`): the plan is computed before
    the first call; call budgets are Fable `3 × chunks + 8` (raised to `3 × chunks × ceil(108 / image_limit) + 8` once a limit is
    learned), Nova `3 × parts + 8`, second look `3 × candidates + 4`; a throttled call is refunded;
    passing one raises `GuardTripped` (not transient), the track stops, keeps what it has and logs
    `deep.guard_tripped` at error. `Bedrock.structured` logs `bedrock.usage` (model, tool, input, output, cache-read
    and cache-write tokens) for every answer.
* Failure text: `Job.error` is one plain sentence that says what to do next and names the job page's button exactly
  ("Tap Try again", §12.4; never "Retry" or "the agent"). Raw tool output (yt-dlp stderr, Amazon Transcribe's
  `FailureReason`, model errors) is logged and never put in `Job.error`; platform names keep their brand spelling
  (YouTube, TikTok). Every agent log line and every `CommandError` has the values of `X-Amz-*` query parameters
  replaced by `<redacted>` (`util.redact_urls`), so a presigned S3 URL that ffmpeg/ffprobe prints never reaches
  CloudWatch with its credential, signature or session token.

### Agent environment variables
`CF_REGION`, `CF_TABLE`, `CF_MEDIA_BUCKET`, `CF_MODEL_ID`, `CF_SKILLS_DIR=/app/skills`, `CLAUDE_CODE_USE_BEDROCK=1`,
`ANTHROPIC_MODEL`, `AWS_REGION`, `CF_VECTOR_BUCKET`, `CF_VECTOR_INDEX=clips`,
`CF_EMBED_MODEL_ID=amazon.titan-embed-text-v2:0` (§14.6), `CF_WATCH_MODEL_ID=eu.amazon.nova-2-lite-v1:0` (the second
watcher, `watchModel` in `config/models.json`; unset and absent from the file → that track is skipped) and
`CF_DEEP=on|off` (default on; `off` → no picture download and the watch step is skipped; Terraform variable
`deep_analysis_enabled`).
