# The clip agent

The agent turns one long video into 5–10 short clips that are ready for review. It runs on Amazon Bedrock AgentCore
Runtime (`cf_prod_clip_agent`) and thinks with Claude Fable 5.1. The code is in `agent/`; the contract it follows is
[CONTRACTS.md §8](CONTRACTS.md#8-agent-agentcore-runtime-cf_prod_clip_agent).

## What it may and may not do

- It **may** read the job, the owner's settings, every skill and learnings (including the "Best of week" ones); query and write clip vectors in
  S3 Vectors; download the source; call Transcribe and Bedrock (Claude Fable 5.1, Titan Text Embeddings V2); run
  ffmpeg; write clips to S3 and Clip items to DynamoDB; update the job's status, steps and progress; and send its job
  flow callback (heartbeat, success, failure).
- It **never** publishes anything, never changes settings or skills, and never reads the YouTube cookies for anything
  but yt-dlp. Publishing happens only after the owner's Confirm, in the durable `cf-prod-clip-flow`.

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
job flow at most every 5 minutes. If those stop for 15 minutes the job flow marks the job failed ("The agent stopped
responding. Press Retry."). When the job ends the agent sends the callback: **success** after `finalize` wrote the job
`ready`, or a **failure** with `JobFailed` (with the job's plain error), `Canceled` or `Superseded` (a retry started a
newer session). Callback errors are retried 3 times and never fail the job; without a `callbackId` (local runs, tests)
nothing is sent.

## Pipeline

| # | Step (`key`) | What happens | Tools |
|---|---|---|---|
| 1 | Resolve (`resolve`) | Detects the platform; reads title, channel, duration and thumbnail (yt-dlp metadata), or checks the uploaded object in S3. Refuses private, deleted or unsupported sources with a plain reason. | yt-dlp, S3 |
| 2 | Download (`download`) | Links: audio only, cut at `maxSourceHours`. Uploads: extracts the audio from the file in S3. Writes `audio.m4a` (and `meta.json`). | yt-dlp, ffmpeg |
| 3 | Transcribe (`transcribe`) | Amazon Transcribe batch job, word timestamps, language detected automatically. Writes `transcript.json` and `words.json` (`[start, end, word]`). | Transcribe |
| 4 | Analyze (`analyze`) | Loudness per second (`loudness.json`) to find shouting and laughing spikes; splits the transcript into windows (about 30 minutes) with their spikes. | ffmpeg |
| 5 | Select (`select`) | First, "What worked before": the source's title, channel, notes and transcript start are embedded with Titan and up to 8 similar clips of this owner are read from S3 Vectors: the owner's `best` (best-of-the-week) clips first, then `performed` ones (fewer than 3 → any of the owner's clips; an error → skipped). Then Claude reads each window with the skills block, learnings and those examples and proposes moments; a final pass ranks them, keeps `clipTarget.max` plus a few spares, and writes hooks. | Bedrock |
| 6 | Render (`render`) | Per moment: downloads only that section of video; Claude looks at one frame to find the facecam; ffmpeg builds 1080×1920 (facecam on top, gameplay below, or a blurred fill when there is no facecam), trims dead air, adds the hook and burned-in ASS captions, makes the cover from the peak frame. | yt-dlp, ffmpeg, Bedrock (vision) |
| 7 | Checklist (`checklist`) | Runs the pre-post checklist from the skills. Measured items (sound and motion in the first second, hook length, clip length, captions present) are computed; judgement items (makes sense with zero context, pays off) are asked of Claude. One fix pass; a clip that still fails is replaced by a spare. | ffmpeg, Bedrock |
| 8 | Captions (`captions`) | One caption per platform: YouTube title (under 60 characters) and description, Instagram, Facebook, TikTok, X. Required tags from the owner's notes are added by code, so they are never forgotten. | Bedrock |
| 9 | Finalize (`finalize`) | One vector per new clip (`PutVectors`, status `review`), then job `ready`, `clipCount` set, then the success callback. Clips are in `review`. | Titan, S3 Vectors, DynamoDB, Lambda callback |

A step that does not apply is marked `skipped` (for example `download` from a link when the source was cached by a
retry).

## Skills

Skills tell the agent what "good" looks like. They are plain `SKILL.md` files with YAML frontmatter (`name`,
`description`) and markdown instructions, the same format Claude uses everywhere. The owner's rule: **every skill is
used by every AI call, always**
([CONTRACTS.md §18](CONTRACTS.md#18-skills-full-create-read-update-delete-every-ai-call-uses-every-skill-owner-request-2026-11-16),
[ADR-32](DECISIONS.md#adr-32-every-ai-call-gets-every-skill-through-one-shared-skills-block)).

- **Built-in skills** live in [`skills/`](../skills/short-form-video-playbook/SKILL.md) in the repository and are
  bundled into the agent image at `/app/skills`. Today there is one: `short-form-video-playbook` (clipping
  workflow, six moment types, hooks, editing, packaging, pre-post checklist). The owner can read them in the app but
  not change or delete them.
- **Owner skills** are made in Settings › Clip making › Skills: written in the app by answering three questions (the
  API turns the answers into a `SKILL.md`), or uploaded as a `.md` file or a `.zip` containing one `SKILL.md` (with
  any supporting files). The owner can read, change and delete them. Every save is a new file at
  `skills/<userId>/<skillId>/<revisionId>/` in the media bucket, so a job that already started never sees a
  half-written skill.
- **All of them, always.** There is no on/off switch. The agent uses every built-in skill and every skill the owner
  has, whatever an old `enabled` value says.

### How the skills reach every call

At `analyze` the agent loads the skills once for the job (`prepare_skills`): built-ins by name first, then the
owner's by name. It writes each to `<workdir>/.claude/skills/<name>/SKILL.md` (zips are extracted next to it), so the
Claude Agent SDK also discovers them the normal way, and it builds one **skills block**: every skill's `SKILL.md`
text inside `<owner_skills>`, the same text for the whole job. The `analyze` step says how many skills it uses
("using 4 skills; 1 could not be read").

The block is the **first** part of the system prompt of every model call the agent makes:

| Call | How |
|---|---|
| Moment picking (Claude Agent SDK on AgentCore) | the SDK's system prompt file starts with the block |
| Moment picking fallback (Bedrock Converse) | `Bedrock.structured(..., skills=block)` |
| Facecam check (Bedrock Converse, one frame) | `Bedrock.detect_layout(..., skills=block)` |
| Checklist judgement, including the hook check and the new hook it may write | `Bedrock.structured(..., skills=block)` |
| Captions for every platform | `Bedrock.structured(..., skills=block)` |

Hooks have no call of their own: they come from moment picking and the checklist, both above. `skills` is a required
argument of `Bedrock.structured` with no default, so a call without it does not type-check, and
`agent/tests/test_skills_everywhere.py` reads the whole package and fails if any model call goes around these helpers.
The only model call without the block is the Titan embedding in `vectors.py` (turning text into numbers is not
writing or reading).

**Size.** Each skill goes in up to 40,000 characters and all of them together up to 120,000. A skill that does not
fit is shortened (marked "…(shortened)") when at least 2,000 characters are left, otherwise left out and named in the
block and the logs (`skills.block`). Built-ins come first, so they are never the ones left out. A block of 8,000
characters or more gets a Bedrock prompt-cache point, so the job's many calls reuse it; if Bedrock refuses the cache
point, it is turned off and the call retried without it.

**When reading fails.** A skill file that cannot be read is retried 3 times, then skipped and counted in the
`analyze` message. If the list of skills itself cannot be read, the step fails and retries, so a job never runs
without the owner's skills.

A skill added or changed in Settings is used by the very next job; nothing is redeployed. The API's own Claude calls
(the 48-hour learning and the weekly best learning) get the same block, built the same way
([below](#learnings-loop)).

If two skills disagree, the owner's own skills win over built-in ones, and the more specific instruction wins over
the general one. The agent says so in the clip's summary when it had to choose.

## Prompts and their intent

The prompts are part of the agent code in `agent/`. What each one is for:

| Prompt | Intent | Output |
|---|---|---|
| System | Who the agent is (a short-form editor for this owner), the rules it may never break (never publish; only clip what the source contains; plain English), and that skills and learnings come first. Every system prompt, in the agent and in the API, starts with the skills block ([above](#how-the-skills-reach-every-call)). | – |
| What worked before | Per similar past clip: moment type, hook, title, summary, views and likes, similarity; the owner's starred clips first, labelled "Owner's pick: best of the week". Advice, never a rule. | (part of the select prompt) |
| Learnings brief | The latest 4 "Best of week" learnings under "The owner's best-of-week picks taught", then the latest 10 other learnings under "Learnings"; empty groups left out. | (part of the select prompt) |
| Window scan | For one transcript window plus its loudness spikes: find every candidate moment that fits one of the six moment types and stands on its own. | Structured list: start, end, moment type, why, draft hook |
| Rank and pick | All candidates together: remove overlaps, prefer variety of moment types, pick between `clipTarget.min` and `max`, keep spares. | Ranked moments with a score 1–10 |
| Facecam | One frame: is there a facecam, and where (box)? | Box or "none" |
| Checklist judge | Given the measured values and the transcript of the clip, answer the judgement questions honestly and propose one concrete fix. | Pass/fail per item, fixes |
| Captions | One caption per platform in that platform's style and length, from the hook, summary and the owner's notes. | `Captions` object |
| Learning (clip flow, step `distil`) | From recent posts and their numbers: one short, specific learning ("Hot takes under 25 s got 3× the views of chaos clips"). | One sentence |
| Best of week (`cf-prod-learn`) | Compare the owner's picks with the rest of that week (hooks, moment types, length, captions, numbers) and say what the clip picker should repeat; the picks matter more than raw views. | 1–3 short sentences, at most 500 characters |

Structured outputs use Bedrock Converse with a JSON schema, so the code never parses free text.

## Learnings loop

1. 48 hours after a clip is posted, the clip flow (after its `wait-48h`) stores the views, likes, comments and shares
   of each post (step `metrics`).
2. Claude compares recent posts and writes one short learning (step `distil`), with the owner's skills block first
   in its instructions, like every other call.
3. The clip's vector is marked `performed` with its numbers (step `upsert-vector`).
4. Every new job receives the owner's latest 4 "Best of week" learnings and latest 10 other learnings next to the
   skills, and the 8 most similar clips as "What worked before", the owner's best-of-week picks first
   ([below](#best-of-the-week)).
5. The Insights screen shows the learnings and the numbers behind them; Review and Library show "Like clips that did
   well".

Until social integrations exist (phase 2), there are no posts with numbers, so no learnings are created and no
vector reaches `performed`. The loop is
in place and starts working as soon as the first clip is posted.

## Best of the week

The owner's words: "Each week, I will select the ones that perform best during that week, so that it knows how to edit
better in the future." Raw views are a weak teacher (each app counts views differently, YouTube Shorts count replays,
Meta numbers settle over two days), so the owner's own stars are the strongest signal the agent gets
([ADR-31](DECISIONS.md#adr-31-the-weekly-best-is-an-explicit-owner-signal),
[CONTRACTS.md §16.6–16.7](CONTRACTS.md#166-weekly-best-learning-lambda-cf-prod-learn)).

1. **The owner stars clips** in Library › This week (or with the star on a clip's performance page): up to 10 a week,
   sorted by views to help. Saving starts the Lambda `cf-prod-learn` (not the agent runtime).
2. **The memory is marked.** Each starred clip's vector gets `best = true`, each unstarred one `best = false`. New
   vectors start with `best = false` (finalize).
3. **One learning per week.** Claude Fable 5.1, with the owner's skills block first in its instructions, reads every
   clip of that week as a row (picked or not, hook, moment
   type, length, layout, score, YouTube title, the start of the TikTok caption, views, likes, comments and shares per
   platform, total views) and writes one plain learning of 1–3 short sentences, for example "Your picks open on the
   loudest second and stay under 25 s; skip slow build-ups even when they got views." It is stored as a Learning with
   `kind "week"` and the title "Best of week 2026-W46"; saving new picks for that week replaces it, and unstarring
   every clip removes it.
4. **The next job uses it.** Before choosing moments the agent reads:
   - the latest 4 week learnings first, under "The owner's best-of-week picks taught", then the latest 10 other
     learnings under "Learnings";
   - "What worked before" in two queries merged: clips marked `best` first, then other measured (`performed`) clips,
     up to 8 without duplicates (fewer than 3 hits tops up with any of the owner's clips). A `best` clip is labelled
     "Owner's pick: best of the week".
5. **It shows.** The week's learning appears in This week under the header, and on the Insights screen with the others.

What the picks change: which moments are chosen, how they are ranked, and how hooks and captions are written. They
never override the owner's skills or the rules above (never publish, only clip what is in the source), and they are
advice to the agent, not a rule. If the vectors or the learning cannot be read, the job carries on without them.

## Limits and guarantees

- Between `clipTarget.min` and `clipTarget.max` clips (defaults 5 and 10). Fewer only when the source does not
  contain enough good moments; the job says so.
- Clips are 20–45 seconds unless a skill says otherwise.
- The source is capped at `maxSourceHours`.
- The agent never invents content: hooks and captions describe what is in the clip.
- Only clip content the owner has the rights to, or is in an official campaign for (the playbook's rules).
