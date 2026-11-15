# The clip agent

The agent turns one long video into 5–10 short clips that are ready for review. It runs on Amazon Bedrock AgentCore
Runtime (`cf_prod_clip_agent`) and thinks with Claude Fable 5.1. The code is in `agent/`; the contract it follows is
[CONTRACTS.md §8](CONTRACTS.md#8-agent-agentcore-runtime-cf_prod_clip_agent).

## What it may and may not do

- It **may** read the job, the owner's settings, enabled skills and learnings; download the source; call Transcribe
  and Bedrock; run ffmpeg; write clips to S3 and Clip items to DynamoDB; update the job's status, steps and progress.
- It **never** publishes anything, never changes settings or skills, and never reads the YouTube cookies for anything
  but yt-dlp. Publishing happens only after the owner's Confirm, in a separate Lambda.

## How it is started

The API invokes the runtime with a new session per job (`runtimeSessionId = cfjob-<jobId>-<8 random chars>`):

| Payload | Answer | Effect |
|---|---|---|
| `{ "action": "process_job", "jobId", "userId" }` | `{ "accepted": true, "jobId" }` at once | The job runs in the background in that session. |
| `{ "action": "cancel", "jobId" }` | an acknowledgement | Stops downloads and ffmpeg, marks the job `canceled`. |
| `{ "action": "health" }` | `{ "ok": true }` | Smoke test after a deploy. |

While a job runs, `GET /ping` answers `HealthyBusy`, so AgentCore keeps the session alive; it answers `Healthy` when
idle. The agent writes `heartbeatAt` at least every 60 seconds; the watchdog fails a job whose heartbeat is older than
15 minutes.

## Pipeline

| # | Step (`key`) | What happens | Tools |
|---|---|---|---|
| 1 | Resolve (`resolve`) | Detects the platform; reads title, channel, duration and thumbnail (yt-dlp metadata), or checks the uploaded object in S3. Refuses private, deleted or unsupported sources with a plain reason. | yt-dlp, S3 |
| 2 | Download (`download`) | Links: audio only, cut at `maxSourceHours`. Uploads: extracts the audio from the file in S3. Writes `audio.m4a` (and `meta.json`). | yt-dlp, ffmpeg |
| 3 | Transcribe (`transcribe`) | Amazon Transcribe batch job, word timestamps, language detected automatically. Writes `transcript.json` and `words.json` (`[start, end, word]`). | Transcribe |
| 4 | Analyze (`analyze`) | Loudness per second (`loudness.json`) to find shouting and laughing spikes; splits the transcript into windows (about 30 minutes) with their spikes. | ffmpeg |
| 5 | Select (`select`) | Claude reads each window with the skills and learnings and proposes moments; a final pass ranks them, keeps `clipTarget.max` plus a few spares, and writes hooks. | Bedrock |
| 6 | Render (`render`) | Per moment: downloads only that section of video; Claude looks at one frame to find the facecam; ffmpeg builds 1080×1920 (facecam on top, gameplay below, or a blurred fill when there is no facecam), trims dead air, adds the hook and burned-in ASS captions, makes the cover from the peak frame. | yt-dlp, ffmpeg, Bedrock (vision) |
| 7 | Checklist (`checklist`) | Runs the pre-post checklist from the skills. Measured items (sound and motion in the first second, hook length, clip length, captions present) are computed; judgement items (makes sense with zero context, pays off) are asked of Claude. One fix pass; a clip that still fails is replaced by a spare. | ffmpeg, Bedrock |
| 8 | Captions (`captions`) | One caption per platform: YouTube title (under 60 characters) and description, Instagram, Facebook, TikTok, X. Required tags from the owner's notes are added by code, so they are never forgotten. | Bedrock |
| 9 | Finalize (`finalize`) | Job `ready`, `clipCount` set. Clips are in `review`. | DynamoDB |

A step that does not apply is marked `skipped` (for example `download` from a link when the source was cached by a
retry).

## Skills

Skills tell the agent what "good" looks like. They are plain `SKILL.md` files with YAML frontmatter (`name`,
`description`) and markdown instructions, the same format Claude uses everywhere.

- **Built-in skills** live in [`skills/`](../skills/short-form-video-playbook/SKILL.md) in the repository and are
  bundled into the agent image at `/app/skills`. Today there is one: `short-form-video-playbook` (clipping
  workflow, six moment types, hooks, editing, packaging, pre-post checklist).
- **Owner skills** are uploaded in Settings → Skills as a `.md` file or a `.zip` containing one `SKILL.md` (with any
  supporting files). They are stored at `skills/<userId>/<skillId>/` in the media bucket.
- **Enabled** skills only. The owner can turn any skill off, including built-in ones.

At the start of every job the agent writes every enabled skill to `<workdir>/.claude/skills/<name>/SKILL.md`
(zips are extracted next to it), so the Claude Agent SDK discovers them the normal way. Their text is also put into
the moment-selection prompt, because that step is where skills matter most. A skill added in Settings is used by the
very next job; nothing is redeployed.

If two skills disagree, the owner's own skills win over built-in ones, and the more specific instruction wins over
the general one. The agent says so in the clip's summary when it had to choose.

## Prompts and their intent

The prompts are part of the agent code in `agent/`. What each one is for:

| Prompt | Intent | Output |
|---|---|---|
| System | Who the agent is (a short-form editor for this owner), the rules it may never break (never publish; only clip what the source contains; plain English), and that skills and learnings come first. | – |
| Window scan | For one transcript window plus its loudness spikes: find every candidate moment that fits one of the six moment types and stands on its own. | Structured list: start, end, moment type, why, draft hook |
| Rank and pick | All candidates together: remove overlaps, prefer variety of moment types, pick between `clipTarget.min` and `max`, keep spares. | Ranked moments with a score 1–10 |
| Facecam | One frame: is there a facecam, and where (box)? | Box or "none" |
| Checklist judge | Given the measured values and the transcript of the clip, answer the judgement questions honestly and propose one concrete fix. | Pass/fail per item, fixes |
| Captions | One caption per platform in that platform's style and length, from the hook, summary and the owner's notes. | `Captions` object |
| Learning (perf-check Lambda) | From recent posts and their numbers: one short, specific learning ("Hot takes under 25 s got 3× the views of chaos clips"). | One sentence |

Structured outputs use Bedrock Converse with a JSON schema, so the code never parses free text.

## Learnings loop

1. 48 hours after a clip is posted, the perf-check Lambda stores its views, likes, comments and shares.
2. Claude compares recent posts and writes one short learning.
3. Every new job receives the owner's latest 10 learnings next to the skills.
4. The Insights screen shows the learnings and the numbers behind them.

Until social integrations exist (phase 2), there are no posts with numbers, so no learnings are created. The loop is
in place and starts working as soon as the first clip is posted.

## Limits and guarantees

- Between `clipTarget.min` and `clipTarget.max` clips (defaults 5 and 10). Fewer only when the source does not
  contain enough good moments; the job says so.
- Clips are 20–45 seconds unless an enabled skill says otherwise.
- The source is capped at `maxSourceHours`.
- The agent never invents content: hooks and captions describe what is in the clip.
- Only clip content the owner has the rights to, or is in an official campaign for (the playbook's rules).
