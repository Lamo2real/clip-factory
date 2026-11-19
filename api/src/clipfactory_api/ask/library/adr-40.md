## ADR-40 Watch the whole video before picking

- **Context.** The owner asked (2026-11-17): "transcribe the videos in the links I paste and the MP4s I upload, put it
  into text so it can find the most viral parts with text AND with the videos … processing them with Transcribe and
  many other AWS services before we actually create the 5 to 10 videos". Until now the moments were picked from the
  words and the loudness alone; the picture was only looked at after a moment was picked (one frame, to find the
  facecam). A crash, a stunt, a glitch or a chase with nobody talking could not be found. The owner also said: "I don't
  want a cost ceiling for a job. It should be unlimited. Cost is not a problem right now."
- **Decision.** A tenth pipeline step, **Watch the video** (`watch`, after `analyze`), and three smaller additions:
  1. **The picture is prepared in the background** while the words are written down. For links the agent downloads the
     whole picture in a small rendition (the tallest H.264 up to 480p and 30 fps that leaves 3 GB of disk free,
     video-only before one with sound at the same height; Twitch and Kick only have renditions with sound, so they get
     their 480p one); uploads are read in place. One ffmpeg pass cuts it into 2 fps parts of 300 seconds (768×432) and
     scores how much the picture changes every second. A tall (over 720p), long (over 45 minutes) upload is decoded
     at every frame when a 60-second timed probe shows two CPUs can do it in time, else at its keyframes only
     (`meta.deep.decode` says which).
  2. **Two models watch all of it.** Claude Fable 5.1 (the existing global profile) gets every 150 seconds as frames,
     one per 2 seconds plus every frame around the loudest and fastest seconds, with that chunk's words. Amazon Nova 2
     Lite (EU profile `eu.amazon.nova-2-lite-v1:0`) gets each 300-second part as real video: a second, independent
     opinion that fills the gaps where Fable refuses or is throttled. Both answer with the same strict schema of
     events (kind, what, strength 1–10, nobody talking, face, text on screen), with the owner's skills block first
     (ADR-32).
  3. **Everything is merged** (`signals.py`): the two watchers' events, the picture-change score, the loudness, the
     most-replayed peaks and Transcribe's speaker labels become hot spots. The finder reads the picture notes between
     the transcript lines and may pick a moment with no talking.
  4. **A second look.** Each picked moment and spare is shown to Claude frame by frame (two per second) before
     anything is cut. It may move the timing by at most 5 seconds, fix a hook that does not match what is seen, or
     say the moment does not hold up, in which case a spare that does takes its place.
  5. **The owner sees it.** The job shows ten steps in kid-proof words ("Watch the video"), and each clip can say
     why it was picked in a few plain words built by code, not by a model ("Loud laugh + Fast action").
- **No cost ceiling.** Nothing caps spending and nothing is sampled away to save money: the whole source is watched,
  and a longer source gets more chunks and more time. The limits are technical only: the container's disk (measured
  before the download), its 2 vCPU and 8 GB, request sizes, time (deadlines that grow with the source) and a
  **runaway guard**: the number of chunks, parts and moments is fixed before the first call, each track may make
  about three times that many calls (a call the service throttled is not counted), and passing the bound stops that
  track with what it has (`deep.guard_tripped`). That guard is a safety bound against a bug, not a budget.
- **Request sizes are learned, not assumed.** AWS's documents disagree on how many images one request may carry: the
  Converse API reference says "up to 20 images" per message, while the Bedrock user guide's API restrictions page says
  Bedrock sets no image count of its own and the model's limits apply (Anthropic's vision page: up to 600 images, a
  32 MB request). So a chunk (75–108 frames) is sent whole first; if Bedrock refuses it for its images or size, it is
  split into smaller requests, again and again if needed (each covering its own stretch of time with its own words),
  and the number that was accepted (`Bedrock.image_limit`, read from the error when it names one) is kept for every
  later chunk and for the second look, whose frames are thinned evenly to it. Nothing is dropped: at 20 images a
  chunk is four to six requests. The call bound grows with the number of requests a chunk needs.
- **A busy service is waited out, not given up on.** A chunk or part the service turned away after `retry.py`'s own
  tries is tried again after a growing pause (5, 10, 20, 40, 60 seconds, six tries in all) while the deadline allows,
  and each track's calls in flight are halved on a throttle (never below one) and grow back one at a time as calls
  succeed, so an account with a small quota is met with fewer calls at once instead of lost chunks. A Try again
  watches once more when Fable lost chunks to a busy service or the deadline (even if Nova covered them); saved
  chunks and parts are reused, so only the missing ones are sent.
- **Never worse than before.** Every new signal is optional at run time. If the picture cannot be fetched, ffmpeg
  fails, or a model is throttled, refuses, is not allowed or times out, it is logged, nothing is marked failed, and
  the job picks from the signals it has. With no picture data the finder's prompts are byte for byte what they were
  (tested). `CF_DEEP=off` switches the whole thing off without a code change.

### Services considered (availability checked against AWS documentation on 2026-11-17)

| Service | Verdict | Why |
|---|---|---|
| Bedrock, Claude Fable 5.1 on frames | **Used** | Already callable (global profile), no new IAM. Reads a facecam face, a death screen and on-screen text in context, with the owner's skills. The main watcher, and the second look. |
| Bedrock, Amazon Nova 2 Lite on video | **Used** | Callable from eu-north-1 through the EU profile (not In-Region), Converse and tool calling supported. Takes real video (1 frame a second, 25 MB inline). Cheap, independent of Fable's quotas and refusals. New IAM statement `InvokeWatchModel`. |
| ffmpeg motion and scene scores | **Used** | Local and free, from the same decode that cuts the parts. The picture signal that survives when Bedrock is down. |
| Amazon Transcribe speaker labels | **Used** | Same three actions, no extra charge, works with automatic language. Shows who is talking and a back-and-forth. |
| Amazon Rekognition (video segments and labels, faces and emotions, text; image APIs on frames) | Rejected for now | **No endpoint in eu-north-1** (the EU ones are Frankfurt, Ireland, London and Spain). It would need a second bucket and a copy of the video in another Region. Its labels are trained on real-world footage, not games, and a small facecam in a 480p copy is near its face-size floor. Fable and Nova already read faces in context. The first thing to add if real jobs miss face reactions (phase 2). |
| Amazon Comprehend (sentiment, key phrases) | Rejected | **No endpoint in eu-north-1**, and sentence sentiment adds nothing over Claude reading the same lines with the skills. |
| Transcribe toxicity detection | Rejected | US English only and batch only: it would break automatic language. Swearing is not what makes a clip. |
| Transcribe language identification | Already used | Since ADR-04. |
| Cohere Embed v4 with a visual S3 Vectors index ("frames like past winners") | Rejected for now | Callable through the EU profile, but AWS Marketplace access needs a manual account step, the index starts empty (dark for weeks), and its "unusual frame" half duplicates the ffmpeg score. Phase 2. |
| Titan Multimodal Embeddings, Nova Multimodal Embeddings, TwelveLabs Marengo | Rejected | Not callable from eu-north-1; frames would go to the US or Ireland. |
| TwelveLabs Pegasus 1.2 / 1.5 | Rejected | InvokeModel only with no system field, so it cannot carry the skills block (ADR-32, `test_skills_everywhere`); global or US profile only. |
| AWS Elemental MediaConvert (frame capture, proxies) | Rejected | It cannot read YouTube, Twitch or Kick, and one ffmpeg decode already makes the parts and the scores. |
| Step Functions, AWS Batch, Lambda fan-out | Rejected | The fan-out is model calls, which asyncio handles inside the one container. A second orchestrator would split cancel, the session fence and the heartbeats (ADR-03, ADR-22). |

### What a job is expected to cost and how long it takes

For the owner's information only; nothing enforces these numbers. Prices from the AWS price list (the
`pricing.us-east-1.amazonaws.com` offer files for AmazonBedrock, transcribe and AmazonBedrockAgentCore in eu-north-1)
on 2026-11-17: Nova 2 Lite $0.000363 per 1,000 input tokens and $0.002992 per 1,000 output tokens; Transcribe
$0.0001 per second; AgentCore $0.1276 per vCPU-hour and $0.0169 per GB-hour. Claude Fable 5.1 is not in the AWS
price list file, so Anthropic's list price is assumed for Bedrock: $10 per million input tokens, $50 per million
output tokens, $0.25 per million cached input tokens.

Assumptions, recomputed from the code: a Fable chunk sends 75–108 frames of 768×432 (448 tokens each) plus about
2,500 tokens of words and tool, so 36,000–51,000 input tokens ($0.36–0.51), and answers with 1,500 to at most 8,000
output tokens (Fable always thinks, and thinking is billed as output: $0.08–0.40), so $0.44–0.91 a chunk, about
$0.65 in the middle. A second look shows 52–102 frames for the default 20–45 second clips ($0.27–0.67; a 180-second
clip allowed by the owner's notes is about 372 frames, $1.70 or more). A Nova part is 300 frames of 288 tokens plus
the uncached skills block, about $0.04.

| Added per job (mid estimate, then the range) | 30 minutes | 2 hours | 4 hours |
|---|---|---|---|
| Fable watching (12 / 48 / 96 chunks) | about $8 ($5–11) | about $31 ($21–44) | about $62 ($42–87) |
| The second look (about 8 / 13 / 13 moments) | about $4.5 ($2–5.5) | about $7 ($3.5–9) | about $7 ($3.5–9) |
| Nova 2 Lite (6 / 24 / 48 parts) | $0.25 | $1 | $2 |
| Longer prompts when picking | about $0.5 | about $2 | about $4 |
| Extra container time (about $0.31 per hour) | under $0.05 | under $0.10 | under $0.20 |
| Speaker labels | $0 | $0 | $0 |
| **Total added** | **about $14 ($8–17)** | **about $41 ($28–56)** | **about $75 ($52–102)** |
| If Bedrock holds Fable to 20 images a request (see above) | about $12–20 | about $45–72 | about $90–142 |
| Transcribe, already there, for comparison | $0.18 | $0.72 | $1.44 |
| **Minutes added** | **about 5 to 6** | **about 11 to 14** | **about 20 to 25** |

With 20 images a request a chunk is four to six requests: the image tokens are the same, but each request repeats
the words and the tool and gets its own answer, so the output roughly triples (the second look gets cheaper: its
frames are thinned to 20). Not in the table, and possible on any job: an answer that does not fit the schema is asked
again up to twice with every image resent (up to three times a request's cost); a request lost to a time-out is paid
again when it is retried; a Try again pays for every second look again (they are not saved). The Fable price is
Anthropic's list price and is **not confirmed for Bedrock** (Fable is not in the AWS price list file).

The minutes assume the account's Fable and Nova quotas let eight and four calls run at once. With a smaller quota the
watchers slow down rather than skip, up to the watch deadline (25 minutes, or a fifth of the source's length when
that is longer: 25 / 25 / 48 minutes) plus the wait for the picture (a third of the source's length, at least 20
minutes). Preparing the picture overlaps the transcription. If the source site is slow, or for a long 1080p upload on
two CPUs, add up to 5, 10 or 15 minutes. All of these are estimates until the first real jobs: every model answer
logs its token counts (`bedrock.usage`), and this table is to be corrected from those logs.

- **Data residency.** Frames of the whole source now go through the global Fable profile (any commercial Region),
  under the same `aws_review` retention as before. This is the same class of data as today's transcript and facecam
  frame, but far more of it. Nova's video parts stay in the EU (the profile routes only to eu-central-1, eu-north-1,
  eu-south-1, eu-south-2, eu-west-1 and eu-west-3, and IAM names exactly those). No new bucket and no new Region for
  data at rest ([SECURITY.md](SECURITY.md#what-is-protected-and-how)).
- **Alternatives.** *Watch only the candidate windows* (cheaper, but a silent moment outside the candidates stays
  invisible, which is the very thing to fix, and the owner set no cost ceiling). *Sparse frames from section
  downloads* (hundreds of small yt-dlp calls, each a chance of the bot check). *The full video at source quality* (a
  4-hour 1080p60 stream is tens of GB: it does not fit the container's disk). *One watcher only* (Fable's refusals
  are a normal response path and its quotas are shared with picking; a second model on another quota keeps coverage).
  *A larger container* (`resourceConfigurations` is not exposed by the Terraform resource in the locked provider, so
  the design fits 2 vCPU and 8 GB).
- **Consequences.** A job costs roughly ten to forty times more than before and takes some minutes longer; both
  scale with the source's length. IAM grows by one statement (`bedrock:InvokeModel` on the Nova profile and its six EU
  foundation models). The agent role still has no Rekognition, Comprehend, MediaConvert, Step Functions or Batch
  action (tested). Speaker labels are per Transcribe job, so on a source split in parts `S1` in one part is not `S1`
  in the next; they are only used as line prefixes, and every prompt that shows them says so. `CF_DEEP=off` also
  stops asking for speaker labels, so the finder's prompts are then exactly the ones before this decision. A clip
  with no word inside it is not pause-trimmed when cut (its quiet stretches are the moment). Amends the audio-only half of
  [ADR-13](#adr-13-download-audio-first-then-only-the-clip-sections).
- **Phase 2 (not built).** Rekognition face detection on sampled frames in eu-west-1 if real jobs miss face reactions
  (needs a cross-Region copy and its own residency note). Cohere Embed v4 with a visual index, once enough kept clips
  exist to compare against.
- **To confirm on the first deployed jobs** (none of this can be tested without AWS): how many images Bedrock lets one
  Fable request carry (the log line `bedrock.image_limit` appears when it refuses a chunk; the table's 20-image row
  applies then); Fable's tokens-per-minute and requests-per-minute quotas for this account (`deep.slow_down` and
  `fable.try_again` lines show when they bite); Nova's limit of 25 MB counting the raw or the base64-encoded video
  (parts are kept to 18 MB, which fits either way); Nova 2 Lite accepting a forced tool choice together with a video block (a refusal falls back to
  `auto`, as for Fable) and its quotas; ffmpeg's speed on the 2 vCPU ARM container and the container's real disk
  size; the Fable price on Bedrock; how often YouTube's bot check stops the second, larger download.
