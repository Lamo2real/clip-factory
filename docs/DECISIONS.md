# Decisions

A short log of every significant decision, in Architecture Decision Record style: the context, what we chose, the
options we did not choose, and what follows from it. A decision changes only through a new entry that replaces the
old one (mark the old one "Replaced by ADR-xx").

All entries: status **Accepted**, November 2026, decided by the build under the owner's "you have full control" brief,
unless marked **Replaced**. ADR-22 to ADR-26 come from the serverless expansion
([CONTRACTS.md §14](CONTRACTS.md#14-serverless-expansion-websocket-api-rest-api-durable-functions-s3-vectors)).
ADR-27 and ADR-28 come from the owner's Settings tree and sound picker request
([CONTRACTS.md §15](CONTRACTS.md#15-settings-as-a-tree-and-choosing-your-click-sounds-owner-request-2026-11-16)); the
sound choices in ADR-28 were made by the owner. ADR-29 to ADR-31 come from the owner's clip performance request
([CONTRACTS.md §16](CONTRACTS.md#16-clip-performance-stats-refresh-and-weekly-best-owner-request-2026-11-16)): the
owner asked for "every 15 minutes or 30 minutes, or whatever the lowest limit is", for a refresh button, and to pick
the best clips each week; the exact intervals and mechanisms were decided by the build from the platforms' published
limits. ADR-32 comes from the owner's skills request
([CONTRACTS.md §18](CONTRACTS.md#18-skills-full-create-read-update-delete-every-ai-call-uses-every-skill-owner-request-2026-11-16)),
where the owner asked for skills to be created, read, changed and deleted in Settings and for "the whole AI system" to
use all of them "no matter what", and ADR-33 to ADR-37 come from the owner's posting setup request
([CONTRACTS.md §17](CONTRACTS.md#17-posting-setup-a-setup-list-per-platform-real-connect-real-posting-owner-request-2026-11-16)),
where the owner asked for one setup per platform that "an 8-year-old should be able to do", with no code, up to date
with what each platform requires today; how the skills rule is enforced and the posting mechanisms were decided by the
build, the latter from the platforms' docs as of 2026-11-16. ADR-38 and ADR-39 come from the owner's request for an in-app help assistant
([CONTRACTS.md §19](CONTRACTS.md#19-ask-clip-factory-grounded-in-app-help-assistant-owner-request-2026-11-16)), built on
the in-app assistant pattern the owner supplied; the owner asked that every AI call use the skills. ADR-41 comes
from the owner's "learn from its own results" request
([CONTRACTS.md §16.12](CONTRACTS.md#1612-learn-from-results-creator-lessons-from-day-7-numbers-owner-request-2026-11-18)),
whose plan the owner approved on 2026-11-18; the statistics and the lesson life were decided by the build. ADR-42
comes from the owner's request to pick the AI model for clip jobs in Settings
([CONTRACTS.md §23](CONTRACTS.md#23-ai-model-choice-for-clip-jobs-owner-request-2026-11-18)); the list of five was the
owner's, the fallback and the IAM shape were decided by the build. ADR-70 to ADR-80 come from the owner's Clips Funded requests
([CONTRACTS.md §45](CONTRACTS.md#45-clips-funded-a-second-separate-workspace-owner-request-2026-11-21)), whose spec the
owner wrote; the mechanisms were decided by the build. ADR-82 comes from the owner's choice of option A for "Reached
your bank" on 2026-11-22 ([CONTRACTS.md §40.5](CONTRACTS.md#405-your-bank-what-really-reached-it-read-through-enable-banking-owners-choice-a-2026-11-22));
the choice of bank source was the owner's, the mechanisms were decided by the build. ADR-85 records the owner's
choice of the name Clips Funded on 2026-11-23. ADR-86 comes from the owner's
request to remove the "Post it yourself" pop-up because his Mac's automation covers it
([CONTRACTS.md §42.1](CONTRACTS.md#421-what-the-owner-sees), [§47.4](CONTRACTS.md#474-what-the-owner-sees-web)); the
removal was his, the row states and the `now` key were decided by the build. ADR-87 comes from the owner's logic of
light request on 2026-11-23 ([CONTRACTS.md §22.7](CONTRACTS.md#227-the-logic-of-light-owner-request-2026-11-23-adr-87));
the rule (the top layer brighter, a colourless glass Reload) was his, the steps and the green that pays for them were
decided by the build.

---

## ADR-01 Region: eu-north-1 (Stockholm)

- **Context.** The owner is in Europe and already runs production work in `eu-north-1`. Bedrock, AgentCore Runtime,
  Transcribe, Cognito, Lambda (arm64), DynamoDB, SQS and EventBridge Scheduler are all available there.
- **Decision.** Every regional resource lives in `eu-north-1` (Terraform variable `region`, GitHub variable `CF_REGION`).
  CloudFront is global.
- **Alternatives.** `us-east-1` (most features first, but further from the owner and from the existing state bucket);
  `eu-central-1` (fine, but no reason to split from the owner's other work).
- **Consequences.** Model calls may be served from another region through the global profile (ADR-02). Data at rest stays in Stockholm.
- **Re-checked for the serverless expansion (unchanged).** Everything the expansion adds is available in
  `eu-north-1`: Lambda durable functions (since 18 December 2025, `python3.13`), S3 Vectors, Titan Text Embeddings V2
  (in-Region), API Gateway WebSocket and REST APIs, AgentCore Runtime and batch Transcribe. SQS and EventBridge
  Scheduler are no longer used (ADR-22). Claude Fable 5.1 is reachable from here only through the global profile, which
  also needs the account's `aws_review` data-retention opt-in ([DEPLOYMENT.md](DEPLOYMENT.md#4-bedrock-model-access-and-data-retention)).

## ADR-02 Claude Fable 5.1 through the global cross-region inference profile

- **Context.** The owner asked for Claude Fable 5.1. In-region capacity for a new model can be limited.
- **Decision.** Call `global.anthropic.claude-fable-5-1` (model `anthropic.claude-fable-5-1`) for the agent, vision,
  structured outputs and learnings. The id lives only in `config/models.json`; Terraform and the agent image read it from there.
- **Alternatives.** The in-region model id (lower throughput, more throttling); an EU geographic profile (fewer
  routing options, no benefit for this data, which is the owner's own public video).
- **Consequences.** Requests can be processed in any commercial region. IAM grants the profile and the underlying
  model in every region it may route to. Changing model is a one-line change in `config/models.json`.

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

## ADR-04 Amazon Transcribe instead of local Whisper

- **Context.** The local app used Whisper on the Mac. In the cloud, Whisper would need a large CPU container or a GPU.
- **Decision.** Amazon Transcribe batch jobs with word timestamps and automatic language detection, reading
  `audio.m4a` from the media bucket and writing `transcript.json` back.
- **Alternatives.** Whisper in the agent container (slow on CPU, a heavy image); a SageMaker endpoint (always-on cost).
- **Consequences.** About $0.006 per minute of audio ($0.0001 per second in the AWS price list for eu-north-1, checked
  2026-11-17; the $0.024 this record carried before was a stale figure). No model to maintain. Transcription runs while the agent waits,
  so long streams finish faster than on a laptop.

## ADR-05 One DynamoDB table (single-table design)

- **Context.** One owner, a handful of entity types (settings, jobs, clips, skills, posts, learnings), simple access paths.
- **Decision.** Table `cf-prod-data` with `pk = USER#<sub>`, typed sort keys, one GSI (`gsi1`) for clips by job and
  posts by clip, a TTL attribute, on-demand capacity and point-in-time recovery.
- **Alternatives.** One table per entity (more IAM, more Terraform, no benefit); Aurora Serverless (minimum cost, a
  VPC, migrations).
- **Consequences.** Every query is a key lookup or a range on one partition. Adding a second user later needs no change.
- **Extended by the serverless expansion.** WebSocket connections (`CONN#`) and webhook events (`HOOK#`) live in the
  same table with a TTL, and the table's stream (`NEW_AND_OLD_IMAGES`) feeds the live updates (ADR-23). A stream filter
  on the sort-key prefix keeps connection, hook, settings and skill changes away from the broadcaster.

## ADR-06 Polling instead of WebSockets

**Replaced by [ADR-23](#adr-23-live-updates-over-a-websocket-api-polling-only-as-the-fallback).** Polling remains only as the fallback.

- **Context.** The app shows job progress and new clips. Updates happen every few seconds at most.
- **Decision.** The web app polls `GET /v1/jobs/{jobId}` every few seconds while a job is open and running, and the
  list screens refresh on focus. Polling stops when the tab is hidden.
- **Alternatives.** API Gateway WebSocket API + a broadcaster Lambda + a connections table; AppSync subscriptions.
- **Consequences.** Fewer moving parts and nothing to keep connected on a phone. Progress can lag a few seconds,
  which is fine for jobs that take many minutes.

## ADR-07 The app's own sign-in screen with Amplify (SRP), no hosted UI

- **Context.** The owner wants a cohesive, glassy experience everywhere, including sign-in.
- **Decision.** A Cognito user pool with a public app client that allows only `ALLOW_USER_SRP_AUTH`. The web app uses
  AWS Amplify v6 (`signIn`, `confirmSignIn` for the first new password, `fetchAuthSession`, `signOut`) on its own screen.
  Sign-up is off; Terraform creates the one owner.
- **Alternatives.** Cognito hosted UI / managed login (a redirect to a page we cannot fully style); a custom auth Lambda.
- **Consequences.** The password never leaves the browser in clear text (SRP). No redirect URLs to manage.

## ADR-08 Token lifetimes: 15 minutes, 30 days, rotating refresh tokens

- **Context.** "The access token is refreshed every 15 minutes, but the refresh token should be refreshed every month
  ... I should be able to do it just once a month, unless I use the application actively."
- **Decision.** Access and ID tokens 15 minutes, refresh token 30 days, refresh-token rotation on (every refresh
  returns a new 30-day refresh token), 10-second grace period, revocation on.
- **Consequences.** An active owner never signs in again; after a month away, one sign-in. Details in [SECURITY.md](SECURITY.md).

## ADR-09 Repository layout keeps the GitHub Pages legal site at the root

- **Context.** `Lamo2real/clip-factory-legal` already serves `index.html`, `privacy.html` and `terms.html` from its root
  through GitHub Pages, and platform developer apps link to those URLs.
- **Decision.** The legal files stay at the root, untouched. The app lives in `web/`, `api/`, `agent/`, `infra/`,
  with `README.md` at the root.
- **Alternatives.** A new repository (the owner asked to use this one); moving Pages to `docs/` (would break the
  published URLs and collide with our documentation folder).
- **Consequences.** Pages keeps working. Changes to the legal pages or documentation do not need an AWS deploy.

## ADR-10 Feature branches, automatic merge after green CI, branches deleted

- **Context.** "Create them in separate feature branches, but when you merge them, which you're going to do
  automatically without my approval ... delete the feature branches afterwards."
- **Decision.** Every change goes through a `feat/`, `fix/`, `docs/` or `chore/` branch and a pull request, which merges
  (squash) automatically when CI is green. The branch is deleted after the merge. `main` deploys. See [GIT_WORKFLOW.md](GIT_WORKFLOW.md).
- **Consequences.** No human gate before production; CI is the gate, so it must stay strict.

## ADR-11 Installable PWA for phone and desktop

- **Context.** "Mobile supported ... browser supported, and also I should be able to download it to my desktop."
- **Decision.** One React app that is also a Progressive Web App (manifest, service worker, icons). It installs on
  iPhone and Android home screens and from Chrome, Edge and Safari on desktop.
- **Alternatives.** Electron or Tauri desktop app plus native phone apps (three builds, signing, stores).
- **Consequences.** One codebase, instant updates on every deploy. The service worker never caches API responses or `config.json`.
- **Amended by [ADR-18](#adr-18-a-thin-tauri-desktop-wrapper-not-electron).** The PWA stays the app everywhere; Mac
  and Windows now also get a downloadable desktop window around it.

## ADR-12 Publishing through SQS, the 48-hour check through EventBridge Scheduler

**Replaced by [ADR-22](#adr-22-lambda-durable-functions-for-the-job-and-clip-workflows).** The queue, dead-letter queue,
publisher, scheduler and perf-check are removed.

- **Context.** Confirm should return at once; uploads to platforms are slow and fail sometimes; each post needs a check
  exactly 48 hours after it goes live.
- **Decision.** Confirm writes the posts and sends one message to SQS `cf-prod-publish`; the publisher Lambda (batch 1)
  posts and then creates a one-time EventBridge Scheduler schedule `perf-<postId>` at posted time + 48 h, which invokes
  the perf-check Lambda. Failed messages land in a dead-letter queue.
- **Alternatives.** A cron that scans for due posts (scans, and up to one interval late); Step Functions with a wait
  state (pays for nothing useful here).
- **Consequences.** Exact timing, retries for free, and nothing runs when nothing is due.

## ADR-13 Download audio first, then only the clip sections

- **Context.** Streams can be 10 hours long; downloading full video in the cloud is slow and costly.
- **Decision.** For links, the agent downloads audio only, finds the moments, then downloads just the few seconds of
  video per clip (yt-dlp section download). Uploaded files are already in S3 and are read directly.
- **Consequences.** Jobs are faster and cheaper. The source is capped at `maxSourceHours` (default 6).
- **Amended by [ADR-40](#adr-40-watch-the-whole-video-before-picking) (2026-11-17).** The audio-only half no longer
  holds: after the audio, the agent also downloads a small copy of the whole picture (up to 480p, no sound) so the
  moments can be picked with the picture. The clip sections are still downloaded on their own, at full quality.
- **Amended by [ADR-52](#adr-52-youtube-from-the-cloud-po-tokens-one-extraction-per-cut-a-full-download-only-as-fallback-a-file-upload-always-one-tap-away)
  (2026-11-19).** For YouTube the sections share one saved extraction, and when they keep failing the whole video is
  downloaded once (up to 1080p, within the disk budget) and cut locally.

## ADR-14 Sounds with the Web Audio API, on `click` only

- **Context.** Two sounds (tap and deny) and none when scrolling on a phone.
- **Decision.** Sounds are synthesised with Web Audio (no audio files) and triggered only from `click` events,
  which browsers never fire for scrolls or swipes. Disabled controls are wrapped so their click plays "deny".
- **Consequences.** No sound on scroll by construction; no extra downloads; one switch in Settings turns them off.
- **Amended by [ADR-28](#adr-28-owner-chosen-default-sounds-from-a-3030-catalog-kept-as-data).** The rules above
  stand; which two sounds play is now the owner's choice from a catalog.

## ADR-15 Uploads go straight to S3 with presigned URLs

- **Context.** Source videos can be gigabytes; API Gateway payloads are limited to 10 MB.
- **Decision.** The API returns a presigned PUT (1 hour) and the browser uploads directly to the media bucket. The
  same pattern serves skills and `cookies.txt`. Clips play from presigned GET URLs.
- **Consequences.** No large payload passes through Lambda. The media bucket stays private.

## ADR-16 CloudFront default domain for now

- **Context.** No domain was mentioned.
- **Decision.** The app is served at the distribution's `*.cloudfront.net` address (output `app_url`).
- **Consequences.** HTTPS for free; a custom domain is a roadmap item.

## ADR-17 A watchdog Lambda instead of an orchestrator

**Replaced by [ADR-22](#adr-22-lambda-durable-functions-for-the-job-and-clip-workflows).** The watchdog and its
10-minute rule are removed; the job flow's callback heartbeat timeout does the job.

- **Context.** If the agent container dies, nothing else would mark the job as failed.
- **Decision.** The agent writes `heartbeatAt` at least every 60 seconds. An EventBridge rule runs `cf-prod-watchdog`
  every 10 minutes; any running job with a heartbeat older than 15 minutes is marked failed with a Retry hint.
- **Alternatives.** Step Functions around the agent (adds a second state machine for one long step).
- **Consequences.** A stuck job is visible within about 25 minutes and the owner can retry it with one tap.

## ADR-18 A thin Tauri desktop wrapper, not Electron

- **Context.** After the first build the owner asked for a real download: "if it's a Mac, then it should be a DMG
  file ... if it's on Windows operating system, then it should be an exe file". A PWA installs from the browser but
  produces no file to download. The web app must stay the single source of the screens and update the moment it deploys.
- **Decision.** A Tauri v2 app in `desktop/` that opens `app_url` in the operating system's own web view (WebKit on
  macOS, WebView2 on Windows). It bundles no screens; it adds the window title, icon, minimum size, remembered
  position, outside links in the normal browser, and the markers (`ClipFactoryDesktop` in the user agent,
  `window.__CF_DESKTOP__`) that hide Get the app inside it. GitHub's macOS and Windows runners build a universal `.dmg`
  and an NSIS `.exe` in `deploy.yml`.
- **Alternatives.** Electron (ships a whole Chromium: about 100 MB per download against about 10 MB, more memory, and
  a Chromium to keep patched; nothing in this app needs Node in the desktop); a native Swift/WinUI app (two codebases);
  only the PWA (no `.dmg`/`.exe`, which the owner explicitly asked for).
- **Consequences.** Small downloads, nothing extra to keep in step with the web app. The web view differs per system
  (Safari's engine on Mac, Edge's on Windows), so the web app must keep working in both, which it already must for
  browsers. Rust and the Tauri CLI are needed only on the CI runners.

## ADR-19 Unsigned desktop builds for now

- **Context.** Signing needs an Apple Developer Program membership (yearly fee, plus notarization) and a Windows
  code-signing certificate or Azure Trusted Signing account. The owner has neither yet, and the app has one user.
- **Decision.** Ship the `.dmg` and `.exe` unsigned. The Get the app card shows a one-line first-open hint (Mac:
  right-click → Open, or Open Anyway in Privacy & Security on macOS 15 and later; Windows: More info → Run anyway).
- **Alternatives.** Sign now (cost and setup before anyone needs it); offer only the PWA on desktop (the owner asked for
  files).
- **Consequences.** One extra click the first time on each computer. Some company-managed computers block unsigned apps
  outright; the browser install remains on the same card. Signing and notarization are a [roadmap](ROADMAP.md#later)
  item and need only secrets in GitHub and a few lines in the `desktop` job.

## ADR-20 Update labels from "Area:" commit lines, then a folder map

- **Context.** The update bar should name what changed in a word or three: "'settings profile picture' or just
  'profile picture'. That's it." Labels must cost nothing to write and never be a sentence.
- **Decision.** `scripts/release-areas.sh` reads `Area: <label>` lines in the commits since the deployed version. If
  there are none, it maps the changed files through `web/areas.json` (longest prefix wins). If that finds nothing, the
  label is "Improvements"; the first deploy says "First release". At most three labels, 1–3 words each.
- **Alternatives.** Hand-written release notes (forgotten, too long); asking Claude to summarise the diff at deploy
  time (needs a model call in CI, can be wordy or wrong, and costs on every deploy); conventional-commit scopes
  (`feat(settings):` are developer words, not what the owner sees on screen).
- **Consequences.** Whoever commits (a person or an agent) decides the words; the folder map keeps labels sensible when
  they forget. Because pull requests are squash-merged, the `Area:` lines must reach the squashed commit
  ([GIT_WORKFLOW.md](GIT_WORKFLOW.md#area-lines-what-the-update-bar-says)).

## ADR-21 iPhone and iPad get Add to Home Screen steps, not a download

- **Context.** "If it's on the iPhone, I'm not sure." iOS installs apps only from the App Store, from TestFlight, or,
  in the EU, from approved alternative marketplaces and Web Distribution, all of which need an Apple Developer
  Program membership, Apple's review or notarization, and a native app.
- **Decision.** On iPhone and iPad, Get the app shows three picture steps to add the PWA to the Home Screen (Share →
  Add to Home Screen → Add), with the real Share icon drawn inline. In other iOS browsers it first says "Open this
  page in Safari first".
- **Alternatives.** An App Store app wrapping the site (Apple rejects thin web wrappers, and it needs the membership and
  review); TestFlight (builds expire after 90 days).
- **Consequences.** No file and no store; the installed PWA runs full-screen and gets the same update bar. Push
  notifications for the PWA remain possible later (iOS 16.4+ supports Web Push for Home Screen apps).

## ADR-22 Lambda durable functions for the job and clip workflows

- **Context.** Two long-running workflows had grown out of loose parts. A job needed a watchdog Lambda on a 10-minute
  rule to notice a dead agent. A kept clip went through an SQS queue and dead-letter queue, a publisher Lambda, a
  one-time EventBridge Scheduler schedule per post and a perf-check Lambda 48 hours later. Each hand-off was another
  resource, role and failure mode. The owner asked for "Lambda, and durable functions in Lambda". Lambda durable
  functions became generally available on 2 December 2025 and reached `eu-north-1` on 18 December 2025 (`python3.13`).
- **Decision.** Two durable functions written in Python with `aws-durable-execution-sdk-python`, both invoked
  asynchronously on their `live` alias with a deterministic `DurableExecutionName`:
  - `cf-prod-job-flow` (`job-{jobId}-{run}`): creates a callback, starts the agent (step `start-agent`), waits for the
    agent's success or failure with an 8-hour timeout and a 15-minute heartbeat timeout, then `finish` or `fail` +
    `stop-session`. A missed heartbeat replaces the watchdog.
  - `cf-prod-clip-flow` (`clip-{clipId}-{run}`): `ensure-posts`, `publish-{platform}` (3 attempts with backoff),
    `settle-clip`, `wait-48h`, `metrics`, `distil`, `upsert-vector`.
  Execution timeouts 30 600 s and 259 200 s, retention 14 days, `publish = true`, alias `live`, alarms on
  `DurableExecutionFailed` and `DurableExecutionTimedOut`.
- **Alternatives.**
  - *Keep SQS + Scheduler + watchdog* (ADR-12, ADR-17): works, but six resources and three roles for two workflows,
    and stuck jobs were found by scanning, up to 25 minutes late.
  - *AWS Step Functions*: a mature fit with task tokens and wait states, but the workflow would live in Amazon States
    Language rather than Python next to the code it calls, every state transition is billed, and tests need a second
    toolchain. The owner asked for Python and for durable functions.
  - *A long Lambda polling the agent*: 15-minute limit, pays for waiting.
- **Consequences.** The workflow reads top to bottom as Python and is unit-tested with a fake durable context. Waiting
  (for the agent, for 48 hours) costs nothing. Retries and checkpoints come from the SDK, so steps must be idempotent
  (they are at-least-once): post creation is guarded by `postsCreated`, post updates by `status = queued`, and
  publishing uses `postId` as the idempotency key. Duplicate starts are harmless because the execution name and
  payload are deterministic. Durable functions support no Lambda destinations, and durable settings can only be set
  when a function is created. Running executions stay pinned to the version they started on, so deploys never change
  a flow in flight; old versions are kept. The agent role needs the three `lambda:SendDurableExecutionCallback*`
  permissions on `function:cf-prod-job-flow:*`.

## ADR-23 Live updates over a WebSocket API, polling only as the fallback

- **Context.** With polling (ADR-06) progress lagged by several seconds, and every open screen polled even when nothing
  changed. The owner asked for "API gateway, WebSockets". Everything the app shows (jobs, clips, posts, learnings)
  is written to one DynamoDB table.
- **Decision.** An API Gateway WebSocket API `cf-prod-ws` (stage `live`). The Cognito access token goes in the
  `$connect` query string (browsers cannot set headers on a WebSocket) and is checked by a Lambda REQUEST authorizer
  using only the Python standard library (RS256 against the pool's JWKS, issuer, `token_use`, `client_id`, expiry).
  Connections are items in the main table with a 2-hour TTL. The table's stream, filtered to `JOB#`, `CLIP#`, `POST#`
  and `LEARNING#` sort keys, triggers `cf-prod-broadcast`, which sends each change, in the same public shape as the HTTP
  API, to the owner's connections. The web app keeps one shared connection, reconnects with backoff, pings every 5
  minutes and reconnects before the 2-hour cap. Polling runs only while disconnected (and every 30 s while live).
- **Alternatives.** *Keep polling* (simplest, but laggy and chatty). *AWS AppSync Events* (managed pub/sub, but a
  second API style and auth setup for one feature). *AWS IoT Core MQTT over WebSockets* (powerful, but Cognito identity
  pools and IoT policies for one owner). *Server-sent events* (need a long-lived HTTP response, which API Gateway and
  Lambda do not hold open).
- **Consequences.** Changes appear within about a second. Writers (agent, API, flows) need no change: anything they
  write is broadcast. The token is in a URL, so access logs use a fixed field list without the query, data tracing is
  off and no Lambda logs it. API Gateway does not cache WebSocket authorizer results, so the authorizer caches the JWKS
  and valid tokens per container. A dropped socket is never an error for the owner: the app falls back to polling.

## ADR-24 A separate REST API for public platform webhooks

- **Context.** Phase 2 needs public endpoints that YouTube, Meta, TikTok and X can call: webhook verification, webhook
  events and OAuth callbacks. They cannot carry the owner's Cognito token. The owner asked for "HTTP, REST API on those
  API gateways".
- **Decision.** A Regional API Gateway REST API `cf-prod-hooks` (stage `v1`) with `/hooks/{platform}` (GET, POST) and
  `/oauth/{platform}/callback` (GET), no authorization, a required `platform` path parameter, per-method throttling
  (10 requests a second, burst 20), a usage plan as a ceiling, X-Ray, and access logs without the query string. One
  Lambda, `cf-prod-hooks`, answers challenges (the Meta verify token is an SSM SecureString generated as a write-only
  value), stores events as `HOOK#` items with a 14-day TTL, and redirects OAuth callbacks to Settings until phase 2.
- **Alternatives.** *More routes on the HTTP API* (cheaper per request, but it would mix unauthenticated public routes
  into the JWT-protected app API, and HTTP APIs have no usage plans, request validators or per-method throttling).
  *Lambda function URLs* (no throttling or validation in front of the code).
- **Consequences.** The app API stays JWT-only; the public surface is small, throttled and separately logged and
  alarmed (`cf-prod-hooks-5xx`). REST API logging needs the account-level API Gateway CloudWatch role, which Terraform
  manages behind `manage_api_gateway_account` ([DEPLOYMENT.md](DEPLOYMENT.md#5-api-gateway-logging-role-one-per-account-and-region)).
  CreateDeployment is limited to one call every 5 seconds per account, so the WebSocket module deploys after the REST
  module. Signature checks are a stub (`unverified`) until the platforms' app secrets exist in phase 2.

## ADR-25 S3 Vectors for the learning memory, OpenSearch not deployed

- **Context.** Learnings (one sentence each) say what works in general. The agent and the owner also benefit from
  seeing specific past clips that resemble the current one, with their real numbers. That needs vector search over a
  few hundred to a few thousand clips for one owner, with filters by owner and status. The owner listed "OpenSearch if
  we're using that, S3 vectors".
- **Decision.** One S3 Vectors bucket `cf-prod-vectors-<accountId>` and index `clips` (float32, 1024 dimensions,
  cosine; `hook`, `title`, `summary`, `performance` non-filterable). Embeddings from Amazon Titan Text Embeddings V2,
  which runs in `eu-north-1` itself. The agent writes vectors at finalize and reads the top 8 `performed` clips before
  moment selection ("What worked before"); the clip flow marks a vector `performed` with its numbers after the 48-hour
  check; the API serves "Like clips that did well" and deletes a vector on Throw away. OpenSearch Serverless is **not
  deployed**; the diagram shows it dashed as an option.
- **Alternatives.** *Amazon OpenSearch Serverless*: full keyword, hybrid and vector search, but a collection bills a
  standing minimum of OCUs (with or without redundancy) even when idle, far more than this app's whole bill. Exporting
  S3 Vectors into OpenSearch Serverless through OpenSearch Ingestion is still a preview feature. *Bedrock Knowledge
  Bases* (built for documents and chunking, not for one record per clip with custom metadata). *Vectors in DynamoDB
  with brute-force search in Lambda* (fine at this size, but code to maintain and slower as clips grow). *Nova
  Multimodal Embeddings* (not offered in `eu-north-1`).
- **Consequences.** Pay per request and per stored vector, nothing standing. Every index argument forces replacement,
  so the dimension, metric and non-filterable keys are frozen; a change means a new index and a backfill. Queries with a
  filter or metadata also need `s3vectors:GetVectors`. Vector errors never break a job or a route; the feature simply
  hides. If keyword or hybrid search is ever needed, OpenSearch Serverless can be added next to it.

## ADR-26 Python for every backend, Terraform for every resource, serverless only

- **Context.** The owner: "I guess you are using Python for backend, and you are using Terraform for the infrastructure
  as code language ... the entire infrastructure should be serverless."
- **Decision.** All backend code is Python 3.13: the Lambdas in `api/` (standard library plus vendored `boto3` and
  `aws-durable-execution-sdk-python`, one zip) and the agent in `agent/`. Every AWS resource is Terraform in `infra/`
  (AWS provider `>= 6.68, < 7`), including the optional bootstrap of the deploy role. Only managed, pay-per-use
  services: CloudFront, S3, S3 Vectors, DynamoDB, API Gateway (HTTP, WebSocket, REST), Lambda (plain and durable),
  AgentCore Runtime, Bedrock, Transcribe, Cognito, SSM, CloudWatch, SNS, ECR. No EC2, no ECS, no VPC. The web app and
  the desktop wrapper are front-end code (TypeScript, Rust), not backend.
- **Alternatives.** CloudFormation, CDK or SAM (the owner chose Terraform); TypeScript Lambdas (the owner chose Python).
- **Consequences.** One language for the backend and its tests (pytest, ruff, mypy), one tool for infrastructure and
  its tests (`terraform test` with mock providers). Durable functions run on `python3.13`, which the Lambda runtime
  supports.

## ADR-27 Settings as a navigable tree with real routes

- **Context.** Settings grew one flat page at a time: clip range, skills, cookies, accounts, platforms, sound, motion,
  background, Get the app, updates, sign out, and now 60 sounds. The owner asked for it to be organised "like a
  folder structure": a field (all of Settings), trees, branches, apples (the settings) and leaves (their help), "so
  that it is all organized". It must stay kid-proof (UX-13).
- **Decision.** Settings is a fixed tree of four trees and eleven branches
  ([CONTRACTS.md §15.1](CONTRACTS.md#15-settings-as-a-tree-and-choosing-your-click-sounds-owner-request-2026-11-16)),
  described once as data in the web app (each node: id, name, icon, one line, its apples and leaves, extra search
  words) and drawn from that data by the field page, the tree and branch pages, the breadcrumb, the folder panel and
  search. Every tree and branch is a **real route** (`/settings/{tree}/{branch}`), not a tab, an accordion or a hash.
  Below 1024 px you drill down one level at a time with a breadcrumb and a Back button; from 1024 px a folder panel
  shows the whole tree beside the content. Old addresses redirect.
- **Alternatives.** *One long page with headings and anchors* (the old way: hard to scan, search scrolls a long page,
  and a 60-card picker would bury everything below it). *Tabs* (four tabs fit, but branches inside tabs need a second
  tab row; no deep links without extra work). *Accordions on one page* (state lives in the page, not the address;
  Back does not close them; deep levels are fiddly on a phone). *A modal or a sheet* (no address, nothing to bookmark).
- **Consequences.** Links, reloads, bookmarks, browser Back and the OAuth return (`/settings?account=…`) all land on
  the right place, and Playwright can open any branch directly. Adding a setting means adding an apple to the data
  under the right branch; the rule "never loose on the field or a tree page" keeps the tree tidy. Search, the panel
  and the breadcrumb cannot drift apart because they read the same data. The cost is a few more routes and a redirect
  table for the old anchors, which must stay.

## ADR-28 Owner-chosen default sounds from a 30+30 catalog kept as data

- **Context.** The first build had two fixed synthesised sounds (tap and deny, ADR-14). The owner tried a picker page
  with 30 click sounds and 30 error sounds, liked its look and feel, asked for it inside Settings so anyone using the
  app can pick, and chose "Tap sound: 6 Water drop. Error sound: 5 Nope nope nope."
- **Decision.** The 60 sounds live as data in `web/src/lib/soundCatalog.ts` (`{ id, name, feel, voices }`; tone voices
  `[wave, startHz, endHz, at, length, peak, lowpassHz]`, noise voices `["noise", filterType, filterHz, at, length,
  peak]`), played by one Web Audio player. The picks are two account settings, `clickSound` and `errorSound` (whole
  numbers 1–30), validated by `PUT /v1/settings`, defaulting to the owner's choices **6 "Water drop"** and **5 "Nope
  nope nope"** for everyone, including settings stored before the fields existed. Ids are frozen: a sound can be
  retuned but never renumbered or removed. The Sounds branch is the owner's picker page, restyled in the app's glass.
  With Sounds off, previews stay silent.
- **Alternatives.** *Audio files* (60 downloads to cache, a heavier app, and nothing to retune without new files).
  *Sounds as code, one function each* (60 functions that are hard to review and easy to break; data is a table anyone
  can read and test). *Keep the picks on the device* (the owner wants Settings to follow them across devices, like the
  Sound switch). *Store the sound's name instead of its number* (names may be reworded; numbers are what the owner
  sees and said). *Let previews play even with Sounds off* (a surprise noise breaks the "no surprise" kid-proof rule).
- **Consequences.** No new downloads; the catalog can be unit-tested (60 entries, ids 1–30 per group, every voice
  well formed, peaks at most 0.5, every sound under half a second). The first build's sounds stay as click 1 "Glass
  tick" and error 1 "Double thud", so nothing is lost. Removing a sound later would need a mapping for saved picks,
  which the frozen-ids rule avoids.

## ADR-29 Stats refresh intervals per platform

- **Context.** The owner wants each clip's numbers per platform, refreshed "every 15 minutes or 30 minutes. Or
  whatever the lowest limit is for each API", plus a Refresh button. The five APIs limit and bill very differently,
  and their numbers settle at different speeds (checked against each platform's documentation, November 2026):

  | Platform | Read used | Limit or cost | How fresh the numbers are |
  |---|---|---|---|
  | YouTube | `videos.list?part=statistics` (up to 50 ids, **1 quota unit a call**); YouTube Analytics `reports` for watch time, engaged views, shares | 10,000 units a day per project, reset at midnight Pacific; uploads need units too | `viewCount` is near real time but cached (minutes behind Studio); Shorts count every play and replay since 31 March 2025; Analytics lags **48–72 hours** |
  | TikTok | `POST /v2/video/query/` (up to 20 ids) | **600 requests a minute** per endpoint, sliding window; `429 rate_limit_exceeded` | Live counts; only views, likes, comments, shares. Unaudited apps post privately and get **no** numbers |
  | Instagram | media insights via field expansion on `/{ig-user-id}/media` (50 reels a request) | Business Use Case: **4,800 × the account's impressions** per 24 h; error `80002`; retries extend the block | Meta: data "can be delayed up to 48 hours"; `views`, `reach` and skip rate are estimates or "in development" |
  | Facebook | `video_insights` (lifetime only), one Reel a request (Graph v26.0 removed the `?ids=` batch read; each id counted against the budget anyway) | Pages BUC: **4,800 × engaged users** per 24 h; error `80001` | Up to 48 hours to settle; impressions and unique-views metrics retire with v26.0 |
  | X | `GET /2/tweets?ids=` (up to 100) with public, non-public and media metrics | 3,500 requests / 15 min per app; **pay per use**, about $0.005 per post read, the same post again on the same UTC day free | Live; non-public metrics only for posts under 30 days old |

- **Decision.** A **safe floor per platform**, not the hard limit, kept in one file, `config/platforms.json`, which
  Terraform and the code both read:
  - **15 minutes** for YouTube, TikTok and X, **30 minutes** for Instagram and Facebook, for the first 48 hours; then
    30 / 60 minutes up to 7 days and 2 h / 6 h up to 30 days; then one final reading and the post leaves the queue.
  - YouTube Analytics at most every **6 hours**: it only moves once a day.
  - **Budgets below the limits**: YouTube stops at 7,000 units a day (3,000 kept for uploads); TikTok uses at most 300
    of 600 requests a minute; Meta stops at 75 % of any `X-Business-Use-Case-Usage` counter and never retries a
    throttle; X uses at most 1,000 of 3,500 requests per 15 minutes and stops at an estimated **$10 a month**.
  - **Refresh numbers** goes through the same budgets with a per-post cooldown: 5 minutes for YouTube, TikTok and X,
    30 minutes for Instagram and Facebook. It never bypasses a limit; when it must wait, it says until when.
  - Largest batch per request everywhere (50, 20, 50, 50, 100 ids), so cost grows with the number of batches, not posts.
- **Why these numbers.** At 15 minutes, 50 YouTube posts cost 96 units a day: under 1 % of the quota, so the floor is set
  by how often the number really changes, not by the quota. TikTok's 600 a minute is never close. Instagram and
  Facebook budgets scale with the account's own reach, so a new account has a small one, and their numbers settle over
  two days; reading every 15 minutes would spend budget on numbers that have not moved yet. X is the only one that
  costs money, and its 24-hour de-duplication means 15 minutes costs the same as once a day (about $0.15 per post over
  30 days), so freshness is free there until the monthly cap. Slowing down with age matches how clips behave: most
  views come in the first two days.
- **Alternatives.** *The hard limits* (YouTube could poll every few seconds by quota alone; Meta's limit depends on
  reach and can shrink overnight; going up to the edge leaves nothing for uploads and the button). *One interval for
  all* (30 minutes everywhere wastes YouTube's and TikTok's freshness; 15 everywhere spends Meta budget on unsettled
  numbers). *Webhooks instead of polling* (none of the five platforms pushes view counts to a webhook). *Polling forever* (X's private numbers end at 30 days, and old clips barely move; the final
  snapshot keeps the totals).
- **Consequences.** Numbers on the page are at most 15–30 minutes old in the first two days and say how old they are.
  Changing an interval, a batch size, a budget or the Graph API version is a one-line change in `config/platforms.json`
  and a push. The X cap needs the owner's credits (DEPLOYMENT.md, "X API credits for clip numbers"). TikTok numbers
  wait for TikTok's app audit.

## ADR-30 One EventBridge rule and a due-queue for stats polling

- **Context.** Every posted post must be read on its own schedule (ADR-29) for 30 days, while the Refresh button can
  read any of them at once. §14 removed the watchdog's EventBridge rule and the per-post EventBridge Scheduler
  schedules in favour of durable waits (ADR-22). The clip flow's durable execution lasts at most 3 days.
- **Decision.** One EventBridge rule, `cf-prod-stats`, `rate(15 minutes)` (the smallest `minIntervalMinutes`, read from
  `config/platforms.json` by Terraform), targets a plain Lambda `cf-prod-stats`. The **due-queue** is a sparse DynamoDB
  index: a post carries `gsi2pk = "STATS"`, `gsi2sk = "{statsDueAt}#{postId}"` only while it is inside its 30-day
  window, so each tick is one Query for `gsi2sk <= now`. Each platform's limits are one `RATE#{platform}` item reserved
  with a conditional write before every request. The tick stops starting requests after 240 s; the rest stay due. The
  Refresh button claims the posts with a conditional write and invokes the same Lambda asynchronously (`InvocationType
  Event`, no retries). The clip flow's 48-hour `metrics` step calls the same `refresh_posts`.
- **Alternatives.** *A durable function per post with `wait` between reads* (about 700 waits per post over 30 days,
  longer than the 3-day clip flow; a manual refresh would need to wake a sleeping execution; many executions to
  watch). *EventBridge Scheduler, one schedule per post* (the pattern §14 removed: schedules to create, move and clean
  up for every post and every interval change). *A Step Functions loop* (a state machine per post or a long-running
  one; more moving parts and cost for the same thing). *Polling from the browser* (works only while the page is open
  and would put platform tokens near the browser). *A tick every minute* (four times the invocations for nothing: no
  platform interval is shorter than 15 minutes).
- **Consequences.** About 2,900 invocations a month, near zero cost, and nothing per post to create or clean up: a
  post joins the queue by getting `statsDueAt` and leaves it by losing `gsi2`. All callers share the budgets, so a tick
  and a button press together can never overspend. The rule is the system's only schedule (no EventBridge Scheduler, no
  other rule). If the intervals in `config/platforms.json` all become 30 minutes, the rule
  becomes `rate(30 minutes)` by itself. The stats Lambda has no async retries (the next tick is the retry) and never
  raises on expected errors; a bug raises and alarms.

## ADR-31 The weekly best is an explicit owner signal

- **Context.** The owner: "Each week, I will select the ones that perform best during that week, so that it knows how
  to edit better in the future." The app already learns automatically from numbers (the clip flow's `distil`, the
  `performed` vectors), but numbers across platforms are not comparable: YouTube Shorts count replays, Meta's views are
  estimates that settle over two days, X's video views differ from impressions, TikTok shows none while unaudited.
- **Decision.** The owner **stars** up to 10 clips a week in Library › This week (sorted by views to help) or on a
  clip's page. A week is an ISO week in the owner's own time zone; a clip belongs to the week of its first post (else
  the day it was kept). Saving (`PUT /v1/weeks/{week}/best`) writes the picks in one transaction with a `revision` and
  starts `cf-prod-learn`, which marks the vectors `best = true / false` and asks Claude Fable 5.1 for **one** "Best of
  week" learning comparing the picks with the rest of the week. The agent reads the latest 4 week learnings before the
  other 10 learnings, and `best` clips come first in "What worked before".
- **Alternatives.** *Pick the top clips by views automatically* (the owner asked to choose; views are not comparable
  across apps and miss what the owner likes; automatic learning from numbers already exists). *A thumbs up / down on
  every clip* (more taps, weaker signal than "the best of this week"). *Rank all clips of the week* (heavier for a
  child to use; a star is one tap). *A learning per picked clip* (many near-duplicate sentences crowding the prompt;
  one per week compares picks with non-picks). *Learning on a weekly schedule* (the owner may pick late or change
  picks; learning on save is simpler and immediate).
- **Consequences.** The owner's taste outranks raw numbers in what the agent sees. Re-saving replaces the week's
  learning (same `learningId`), unstarring everything removes it, and the `revision` check means a slow older run
  never overwrites a newer save. The picks shape which moments are chosen and how they are hooked and captioned; they
  do not change the editing rules in the skills. The week's boundaries come from the browser, so a week always matches
  the owner's calendar, including the weeks the clocks change (167 or 169 hours).

## ADR-32 Every AI call gets every skill through one shared skills block

- **Context.** The owner: *"The whole AI system should use all of these skills by default, no matter what, as long as
  I add them: whatever AI service we use (Bedrock, AgentCore, whatever), when it is generating stuff or reading
  stuff."* Before this, only the agent's moment picking read the skills; the facecam check, the checklist, the
  captions and the API's two learnings (the 48-hour `distil` and the weekly best) did not, and each skill had an on/off
  switch. The owner also wants to write, read, change and delete skills in Settings, following the trees, branches,
  apples and leaves.
- **Decision.**
  1. **No switch.** Every built-in skill and every skill the owner adds is always used. `enabled` is gone from the
     API, the agent and the app; old values are ignored and cleaned up.
  2. **One skills block, first in every system prompt.** Both Python packages have the same builder
     (`skills_block`), checked byte for byte against one shared reference file. It holds every skill's `SKILL.md`
     text, built-ins first, then the owner's by name, at most 40,000 characters per skill and 120,000 in total;
     a skill that does not fit is shortened or left out and named, and built-ins are never the ones left out.
     `compose_system` puts it before the task's own prompt, with a Bedrock prompt-cache point once it reaches 8,000
     characters. It covers every Claude call: the Agent SDK on AgentCore and every Bedrock Converse call, in the agent
     (moment picking and its fallback, facecam, checklist with the hook rewrite, captions) and in the Lambdas
     (`distil` and the weekly best). Titan embeddings are not text generation and get none.
  3. **Enforced by the type checker and by tests.** `skills` is a required argument (no default) of the helpers that
     call the model, and a test in each package reads its own source and fails if any model call goes around them.
  4. **Full CRUD in Settings.** Writing a skill is three plain questions (the API builds a valid `SKILL.md`); uploads
     work as before; each skill has its own page and edit page under the Skills branch; saves check a `version`, and
     every save is a new S3 object, so a running job never sees a half-written skill and files can be cached by key.
     Deleting asks once in a small glass sheet and then shows the usual 8-second Undo.
- **Alternatives.** *Keep the per-skill switch* (the owner said "no matter what": a skill that is quietly off is what
  the owner asked not to happen). *Skills only for moment picking* (the old behaviour; hooks, captions, facecam and
  learnings would ignore the owner's rules). *Ask the model to fetch skills with a tool when it wants* (the model could
  decide not to; Converse calls with forced tool choice cannot also call a skills tool; more round trips). *Pick the
  relevant skills per call by their description, or by embedding search* (cheaper prompts, but "all of them, no matter
  what" would become "the ones a classifier picked"; can be revisited if the skills grow very large). *A Bedrock
  AgentCore or Bedrock Agents feature for instructions* (Converse calls and the Lambdas would not get it; ties the rule
  to one service when the owner said "whatever AI service we use"). *Put the block last in the prompt* (the task's own
  rules and answer format would be the stable prefix instead, and the block could not be cached across calls with
  different tasks). *Delete with the Undo toast only, no sheet* (what §12.4 prefers, but a skill can hold a lot of
  typing, so a small sheet plus Undo is the one deliberate exception in Settings).
- **Consequences.** Every call costs more input tokens (up to about 120,000 characters of skills); the cache point
  makes the repeats within a job much cheaper, and the size caps keep any call within the model's limits. The owner's
  skills apply to things they may not have been written for (for example the facecam check); the block tells the model
  to follow them only as far as the task's own rules and answer format allow. A new model call anywhere in the code has
  to pass the block, or the build fails. The Lambdas `cf-prod-clip-flow` and `cf-prod-learn` gain read access to
  `skills/*` (no list), and `cf-prod-learn` gains `MEDIA_BUCKET`. A change to a skill counts from the next call that
  loads skills (for a clip job, the next job).

## ADR-33 Posting setup: bring your own keys, with a guided list per platform

- **Context.** The owner: "Facebook, Instagram, YouTube, TikTok and X should each be a step to connect to … the user
  should not have to write code … an 8-year-old should be able to do it." Every platform requires a registered
  developer app (OAuth client) before anyone can post through its API. A single shared Clip Factory app would need
  Google verification and a security assessment for `youtube.upload`, TikTok's audit, Meta's App Review and Business
  Verification, and a paid X plan, all in the name of one legal entity, before the first post.
- **Decision.** **Bring your own keys.** The owner creates one developer app per platform by following a step list in
  **Settings › Posting › Set up posting** (four parts: Get ready, Make your key, Connect, Go public). Every step is
  data (`web/src/setup/{platform}.ts`) with Open buttons to the exact page, Copy buttons for every value, paste boxes
  that check the key format, "If you see…" hints for anything uncertain, and the date the steps were checked
  (2026-11-16). The same list is [docs/SETUP_POSTING.md](SETUP_POSTING.md), and a web test keeps the two in step.
  Clip Factory keeps the owner's app in a state that needs no platform review where the platform allows it
  (Google: published but unverified, which only shows a warning to its own user; Instagram: Development mode with the
  owner's own accounts).
- **Alternatives.** *One shared Clip Factory app per platform* (months of reviews and audits, a company behind it, and
  a single point of failure; not possible for one private owner on TikTok and X today). *A third-party posting
  service* (another account, monthly fee, and the owner's tokens held by someone else). *Browser automation of the
  platforms' upload pages* (against every platform's terms, breaks often, needs the owner's passwords). *Written
  instructions only* (no Copy buttons, no format checks, no progress: not kid-proof).
- **Consequences.** About 2 hours of one-time clicking across five sites, guided. Some limits stay with the owner's
  app: TikTok posts stay "Only me" until TikTok approves the app and its audit, which it may refuse for a tool one
  person uses; Facebook Reels may stay visible only to the owner if Meta wants App Review before Live; X costs about
  $0.015 per post. The setup says each of these plainly. When a platform renames a button, only the data file and
  [SETUP_POSTING.md](SETUP_POSTING.md) change.

## ADR-34 OAuth with a signed single-use state, tokens only in Secrets Manager

- **Context.** Connect sends the owner to the platform and back to the public REST API (`GET
  /oauth/{platform}/callback`). That endpoint cannot see the owner's Cognito token, must not be usable as an open
  redirect, and must not let a replayed or forged callback attach someone else's account. The owner's app keys and the
  account tokens are the most sensitive data the system has.
- **Decision.** `POST /v1/accounts/{platform}/connect` (JWT) builds the authorize URL with `state = v1.{nonce}.{exp}.{HMAC}`
  (HMAC-SHA256 with the key in `cf-prod/oauth/state-key`, 10 minutes, bound to the platform) and stores
  `OAUTH#{nonce}`; the callback checks the signature in constant time and consumes the item with a conditional delete,
  so a state works once. PKCE (S256) is added where the platform supports it for web clients (YouTube, X); its
  verifier is derived from the nonce with the same key, so it is never stored. The callback exchanges the code server
  side with the exact stored redirect URI and always answers `302` to one fixed app path with a code from a fixed list.
  App keys and tokens live **only** in AWS Secrets Manager (`cf-prod/platforms/{platform}/{app,token,pending}`),
  created at runtime by the API and the hooks Lambda; DynamoDB keeps masked hints, the public client id and the
  account's name and picture. TikTok and X refresh tokens rotate, so refreshes take a short DynamoDB lease and write
  the new secret before the access token is used.
- **Alternatives.** *Keys and tokens in DynamoDB with KMS* (encrypted, but one table read away from every Lambda that
  reads posts; harder to audit). *SSM Parameter Store SecureStrings* (cheaper, but no `CreateSecret`-style lifecycle,
  lower throughput limits, and 4 KB values). *State in a cookie* (the callback is on another domain than the app).
  *An unsigned random state only in DynamoDB* (works, but a signature lets the callback reject junk without a read).
- **Consequences.** At most about 22 secrets in all at $0.40 a month each, about $9 (about 16 when this was decided):
  two made by Terraform (the state key and the push key `cf-prod/notify/vapid`); 19 made at runtime by the app (an
  app and a token secret for each of the five platforms, the short-lived pending choice of Instagram and Facebook,
  Content Rewards' app and token, the four badge keys `cf-prod/platforms/{twitch/app, kick/app, youtube/readkey,
  twitch/eventsub}` and Ask's search key); and the optional YouTube proxy the owner may add by hand. Only
  `cf-prod-api`, `cf-prod-hooks`,
  `cf-prod-clip-flow` and `cf-prod-stats` may touch the `cf-prod/platforms/*` prefix, and the last two may write only
  the token secrets (`cf-prod/platforms/*/token-*`) ([SECURITY.md](SECURITY.md#platform-keys-and-tokens)). A lost race on a rotating refresh token cannot strand the
  account. Rotating the state key ends Connects that are in flight, nothing else.

## ADR-35 Every upload is sent as a file, and posting waits inside the clip flow

- **Context.** Platforms take a video either as a file sent by the app or as a URL they fetch. TikTok's URL pull needs
  a verified media domain, Instagram and Facebook fetch URLs from Meta's servers, and every platform processes the
  video for seconds to minutes before it is live. The clip flow is a durable function (ADR-22).
- **Decision.** Clip Factory always **sends the file** (YouTube resumable upload, TikTok `FILE_UPLOAD` in chunks,
  Instagram and Facebook `rupload.facebook.com`, X chunked media upload), read from S3 in 8 MB ranges. A presigned S3
  URL is only a configured fallback for Instagram and Facebook (`publish.source` in `config/platforms.json`). Each
  platform is a `start → check → finish` publisher; the clip flow runs `publish-{platform}`, then durable
  `wait-{platform}-{n}` and `check-{platform}-{n}` steps, then `finish-{platform}`. Every platform call that creates
  something writes a `publishHandle` first, so a replayed step resumes instead of posting twice.
- **Alternatives.** *URL pull everywhere* (TikTok media-domain verification and another public bucket path; Meta
  fetches from outside AWS). *Polling inside one long step* (Lambda time spent waiting, and a retry repeats the
  upload). *A separate publish queue and worker* (the pattern §14 removed).
- **Consequences.** No media host to verify and no public media. Waiting costs nothing. The clip flow needs 1024 MB
  memory for the chunked reads. Steps that cannot be made idempotent on the platform side (TikTok init, Instagram
  publish, X post) are marked at-most-once and, if interrupted, ask the owner to look on the platform before **Try
  again**.

## ADR-36 Instagram and Facebook get two separate Meta apps

- **Context.** Meta's new app dashboard groups permissions into **use cases**, and some use cases cannot be combined
  or removed once added. Instagram publishing uses "Manage messaging & content on Instagram" (Instagram API with
  Facebook Login, a Facebook Login for Business configuration with a user access token and the Page linked to the
  Instagram account; system-user tokens are for Tech Providers only); Facebook Page Reels use "Manage everything on
  your Page" (Facebook Login for Business, Page tokens).
- **Decision.** Two Meta apps: "Clip Factory" for Instagram and "Clip Factory Pages" for Facebook, each with one use
  case and its own keys and login configuration.
- **Alternatives.** *One app with both use cases* (some combinations are refused or need App Review; a wrong tick
  cannot be undone, which is not kid-proof).
- **Consequences.** A few repeated steps (developer account, Basic settings) and two key sets. Each platform can be
  disconnected or re-keyed alone.

## ADR-37 About, Privacy and Terms on the app's own domain

- **Context.** TikTok verifies the website by a file at a URL prefix, and Google lists every domain an OAuth app
  uses; both expect the privacy and terms pages on that domain. The GitHub Pages legal site (ADR-09) is on another
  domain and must not change.
- **Decision.** The web app serves static `about.html`, `legal/privacy.html` (with a `#delete` section) and
  `legal/terms.html` from CloudFront, with the YouTube API Services wording. TikTok's verification file is uploaded in
  the setup and written to the web bucket root; `upload-web.sh` never deletes `tiktok*.txt`.
- **Alternatives.** *Point the platforms at GitHub Pages* (a second domain to verify, and TikTok's file cannot be
  placed there from the app). *A custom domain* (on the roadmap; needs DNS and a certificate).
- **Consequences.** Every value the platforms ask for comes from `GET /v1/setup` and is one Copy button. If the app
  moves to a custom domain, every platform's redirect URI and website must be updated (the setup's **Check it** finds
  a mismatch).

## ADR-38 BM25 over vectors for help, and the model is optional

- **Context.** The owner wants a helper that answers "how do I…" and "where is…" in steps a child can follow and then
  shows the button. The knowledge is small (a few hundred short docs generated from the app's own code plus about 40
  guides), English only, full of exact UI words (**Upload**, **Throw away**, **Click sound**), and it changes with every
  UI change. A wrong answer ("press Publish", a page that does not exist) is worse than "I don't know".
- **Decision.** Retrieval is an in-memory **BM25** ranker (k1 1.2, b 0.75; title and keywords weighted highest; shared
  synonyms, a light stemmer and one-edit typo matching), implemented twice with the same rules (Python in the API,
  TypeScript in the browser) and checked against one shared eval file of at least 44 Clip Factory questions. A match
  must pass a minimum score, cover half the content words and hit a title or keyword, else the answer is a fixed "I
  don't know that one yet.". A composer turns the best match into the full answer. **The model is optional**: Claude
  Haiku only rewrites that answer, and any model output that names a button, path or number not found in the matches
  is replaced by the composed answer.
- **Alternatives.** *Embeddings in S3 Vectors* (already deployed for the learning memory, ADR-25) or *a Bedrock
  Knowledge Base*: an embedding call per question and per corpus change, a vector index to keep in sync with every
  deploy, fuzzy similarity that blurs exact button names ("Keep" vs "Keep going"), harder to test offline and to
  explain when it is wrong; a Knowledge Base also bills a standing vector store. *Let the model answer from the whole
  corpus* (bigger prompts, invented steps, nothing to fall back on when it fails). *A static FAQ page* (no navigation,
  no spotlight, goes stale). *Model required* (every Bedrock hiccup, Marketplace subscription gap or cap would break
  help).
- **Consequences.** Help works with the model off, capped, slow or broken, and in the browser when the API is down. It
  costs nothing per question without the model, is deterministic and testable offline, and an unknown or refused
  question never costs a model call. Synonyms and keywords have to be curated for wording BM25 cannot bridge ("make it
  calmer" → Reduce motion); the eval file is the guard. The two retrievers must stay identical, which the shared eval
  file checks in both CI jobs.

## ADR-39 Help runs in cf-prod-api with Claude Haiku 5.5 through the EU profile

- **Context.** The pattern puts help in its own Lambda. Clip Factory has one owner, one HTTP API with a single
  `ANY /v1/{proxy+}` route and the Cognito JWT authorizer, and a few questions a day. The agent uses Claude Fable 5.1
  through the global profile (ADR-02). The help prompt holds the owner's question and the owner's skills.
- **Decision.** Two routes, `GET /v1/help` and `POST /v1/help/answers`, in the existing `cf-prod-api`; the help package
  is imported only on those routes, so other routes pay no cold-start cost. The model is **Claude Haiku 5.5** (the
  newest Haiku on Bedrock, checked 2026-11-16) through the **EU** inference profile `eu.anthropic.claude-haiku-5-5`, set
  as `helpModel` in `config/models.json` with a per-model `profilePrefix: "eu"` (Fable keeps the top-level `global`).
  Cost is capped in code: 6 questions a minute, 60 an hour and 2,000 model answers per 30 days, all as conditional
  DynamoDB writes on the existing table. A deploy flag (`HELP_ENABLED`) and a kill-switch item switch it off without a
  deploy.
- **Alternatives.** *A separate `cf-prod-help` Lambda* (a second deploy unit, role and log group for a few requests a
  day, with no isolation benefit for one owner). *The global profile* (questions and skills could be processed outside
  the EU for no gain at this volume). *Fable 5.1* (slower and dearer than needed to reword a few sentences, and
  `aws_review` retention). *A separate request-guard table* (one more table; the single-table design, ADR-05, covers it).
- **Consequences.** IAM grows by one statement: `bedrock:InvokeModel` on the EU profile and its six destination
  foundation models only. A new structured-output schema can take Bedrock up to about 90 s to compile once; that first
  call times out and falls back to the plain answer. Haiku 5.5 is billed through AWS Marketplace, so on an account that
  has never used it the first call may fail until the model has been opened once; help stays on plain answers until
  then. Like every model call (ADR-32), the help call goes through the shared `learn.converse_text`, so the owner's
  skills block comes first and the help rules after it; when the skills cannot be read, help answers without the model.

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

## ADR-41 Learn from day-7 numbers, per creator and per platform

- **Context.** The owner wants Clip Factory to learn from its own results: about 7 days after posting some clips do
  far better than normal, and new clips should lean toward what those clips share. It must learn per creator (the
  streamer whose stream is clipped), never over-learn from a handful of clips or from luck, never make up numbers, run
  on its own and cheaply, and the owner must be able to read and undo every lesson. The one-sentence 48-hour learning
  (clip flow `distil`) did the opposite: one model sentence after each clip, from whatever few posts were measured,
  fed straight to the picker.
- **Decision.**
  - *One number per post, frozen at day 7.* The reading closest to 7 days after posting, read between 6.5 and 8.5
    days, chosen by when the views were really read (`viewsReadAt`), never interpolated. Missing stays missing.
  - *Per platform.* Each app counts views its own way (Shorts count replays, Meta settles over two days, X counts
    plays of the video), so a post is only ever compared with posts on its own platform, and platforms are never added.
  - *Median and MAD on log(1 + views).* View counts are heavy-tailed: one viral clip moves a mean and a standard
    deviation so much that nothing else stands out. The median and the median absolute deviation ignore a few
    outliers, and the log scale makes "twice as many" the same step for small and big creators. A winner needs both
    2 × the median and a robust z ≥ 2.5; the MAD is floored at 0.2 so a very even baseline does not turn a small bump
    into a winner, and tiny numbers never count (at least 100 views against a median of at least 10). At least 20
    baseline posts, else the owner-wide baseline, else no winners. In the owner-wide baseline every post is first
    divided by its own creator's median, so a bigger channel's normal clips are never winners just for being bigger.
    Each post is judged once, when its day-7 number freezes, and the verdict is stored: a later shift of the 90-day
    baseline never turns an old post into new evidence.
  - *Code finds the pattern, the model only words it.* A trait must be shared by ≥ 3 winners from ≥ 2 source videos (two
    jobs of one stream are one video), be compared with ≥ 10 other clips that have the same kind of fact, and be ≥ 1.5 ×
    as common among winners; an "all creators" trait needs winners from ≥ 2 creators. One Claude call per creator with new winners writes the lesson; every number in
    it must be one from the evidence and every cited clip a real winner, else one retry, then it is dropped.
  - *Trial, then active.* A new lesson is only tried (not given to the picker) until a run at least 7 days later
    finds a new winner with the same trait, so one lucky week cannot steer the picker. Active lessons expire 90 days
    after their last confirmation, at most 5 per creator.
  - *Where lessons go.* Active lessons for the job's creator, then active "all creators" ones, go under the exact
    heading "Prior learnings" right after the skills block into every call that picks moments or writes hooks: the
    finder (Agent SDK and fallback), the second look against the picture
    ([ADR-40](#adr-40-watch-the-whole-video-before-picking): it keeps, swaps or drops moments and can write a new
    hook), the checklist review and the captions. The watchers that only report what is seen get none. No active
    lesson, no section.
  - *The 48-hour learning left the picker.* It is no longer written or sent (the clip flow keeps its step name for
    replays, its metrics and its vector marking); older ones stay readable on Insights as "Older note". The owner's
    best-of-week learnings stay: they are an explicit owner signal (ADR-31).
  - *A deleted lesson stays deleted.* The design allowed "unless the owner turns learning back on for it", but there
    is no such control: a delete is final for that creator, platform and trait, and the delete question says so
    ("Clip Factory will stop using it and will not learn it again"). The owner can ask for an "unblock" later; until
    then this is the rule.
  - *Cheap.* One daily EventBridge rule on the existing `cf-prod-learn` (no new function, no new table, no Scan); no
    new winners means no model call.
- **Alternatives.** *Comparing against all platforms together or summing views* (mixes incomparable counts). *Mean and
  standard deviation* (one viral clip hides every other winner). *A fixed views threshold* (wrong for every creator
  but one). *Letting the model read all clips and say what works* (it finds patterns in noise and invents numbers).
  *Keeping the 48-hour learning next to the lessons* (two voices, one of them over-learning). *A new Lambda or a Step
  Functions workflow* (more to deploy for a few seconds of work a day).
- **Consequences.** A creator needs about 21 measured posts on a platform before its own baseline is used, and a
  lesson needs at least two daily runs a week apart before it reaches the picker, so learning is slow on purpose.
  "Creator" is defined in one place (`creators.py`); uploads are learned only owner-wide. Disconnecting YouTube deletes
  its day-7 numbers and the lessons built on them. The `cf-prod-learn` timeout rose from 300 to 900 seconds (changed
  in place).

## ADR-42 The owner picks the AI model for clip jobs

- **Context.** The owner asked (2026-11-18) to "make the clips … with the AI agent core in Bedrock allow me to select
  whatever model I want. If I want Opus 5.5 … Fable 5.1 … Fable 5.2 … just by selecting them in the settings". One
  model, Claude Fable 5.1, was fixed in `config/models.json` (`agentModel`) and in the agent's environment.
- **Decision.**
  - *A short list in config, a pick in Settings.* `config/models.json` gains `clipModels` (Fable 5.2, Fable 5.1, Opus
    5.5, Sonnet 5.5, Haiku 5.5, in that order) with a label and one plain line each; the owner's pick is the new
    setting `clipModel` (Settings › Clip making › Clips › AI model). `agentModel` (Fable 5.1) stays the default, so
    nothing changes until the owner picks. The setting is additive; an unknown stored key reads as the default.
  - *Per job, not per deploy.* The pick travels with the owner's settings, which the agent already reads at the start
    of each job; no environment variable changes and no redeploy is needed to switch. Every Claude step of the job uses
    the picked model (finder, Claude watcher, second look, layout, review, captions); one Bedrock client per model id
    is cached in the container.
  - *Fall back rather than fail.* Whether a model is enabled on the account cannot be checked offline, and Fable 5.2,
    Opus 5.5 and Sonnet 5.5 may not be. A picked model's first call is small; if Bedrock refuses it as unavailable,
    the default makes the job, `model.fallback` is logged and the job records `model` and `modelWanted`, so the page
    can say so. Busy or failing calls do not count: those keep the pick.
  - *IAM for the list, in place.* The agent role's existing `InvokeFable` and `ReadProfile` statements gain every
    clip model's profile and foundation model ARNs (global profiles: any region; Haiku's EU profile: its six EU
    regions). Same Sids, so the policy changes in place.
  - *Requests every model takes.* No thinking budget, no `thinking: disabled`, no sampling settings; forced tool choice
    and cache points keep their switch-off-on-refusal fallbacks.
- **Alternatives.** *Any Bedrock model id typed by the owner* (not kid-proof, cannot be granted in IAM ahead of time,
  and a model that does not support tools or the skills block would fail jobs). *A deploy-time variable* (a redeploy
  per change; not "just by selecting"). *Letting the API check availability* (the API has no Bedrock access for these
  models and the answer can change; the agent finds out on the first call anyway).
- **Consequences.** Haiku keeps prompts in the EU; the global profiles may process them outside the EU, as Fable 5.1
  already did. A picked model costs what it costs: Bedrock bills each model at its own rate. A model's first call per
  container adds one small request. The API's list is a mirror of `clipModels` kept equal by a test, because the API
  Lambdas do not ship `config/models.json`.

## ADR-43 Bottle-green glass, bone words, vermilion actions

- **Context.** The owner asked (2026-11-18) to "refactor the entire application ... every single UI thing we have is
  going to be tailored towards these colors. It's still going to be liquid glassy ... the CTA should be still orange,
  and all CTAs should be orange. The font style could be the same, but the colors should change." The new colours are
  Bottle Green `#0F372B`, Bone `#EFE7DA` and Vermilion `#E8392B`, used like a dance-theatre reference page: a deep
  green field, bone serif headings and small bone navigation, bone hairlines, a bone outlined circle-arrow button, and
  vermilion as the one loud colour. They replace Sage `#9CAF88`, Off-white `#F7F5EF`, Tomato `#E8412C` and ink
  `#1E2A1B` (the design summary in CONTRACTS.md §11). The full design record is
  [theme-bottle-green.md](theme-bottle-green.md).
- **Decision.**
  - *Green is the surface, bone is the words and the lines, vermilion is the action.* Every glass tint, veil and scrim
    is bottle green; every text colour is light (`--ink` is bone); hairlines and rings are bone. The glass recipe
    (blur, saturation, lit rim, refraction), `<Glide>`, motion, celebrations, sounds and fonts are unchanged.
  - *Every action is the vermilion CTA.* `.btn--primary` (the screen's one main action) and the new `.btn--action`
    (every other action: the setup step's "I did this", Copy, Paste, "Use the example", the Ask panel's actions and
    Send) wear the same fill. The fill is vermilion a shade deeper (`rgb(206 48 36)` → `rgb(184 38 28)` at 0.97) so
    the white label reaches 4.96–6.03:1; white, bone and green on raw `#E8392B` are 4.16, 3.39 and 3.15:1. The "one
    main action per screen" rule stays for `.btn--primary`. Secondary buttons are bone-outlined glass; the selected
    item of every pick-one bar is a bone pill with green words.
  - *The contrast maths changes direction.* With light words the hardest backdrop is the lightest, so
    `lib/background.ts` plans for white behind every native glass (`glassCeiling`) and keeps the floor as a second
    check. Window look panels: Clear 0.73, Frosted 0.88 over a 0.30 frost. Picture: a 0.35 green veil and 0.65 panels.
    Colours: the lightest colour decides (the default needs 0.74). The Clip Factory colours become a dark green mesh,
    so panels there stay at 0.45. Fills under words are never lighter than their panel; every vermilion dot on glass
    has a bone ring.
  - *The desktop tint follows, the theme does not.* `GLASS_TINT` becomes `Color(15, 55, 43, 140)`. Readability does
    not depend on it (a tint can only darken a white ceiling), so no new measurement is needed; `Theme::Light` stays
    because the light material is the one that was measured.
  - *Owner data: read-time only.* The default background colours become `["#0f372b", "#efe7da", "#e8392b"]`. A stored
    value that is exactly the old default trio, in order, reads as the new default (the web's cached `cf.prefs` copy
    too); there is no migration job, the mapped value is written only when the owner next saves settings, as every
    default is, and every other choice (a reordering or subset too) is kept. The swatches add Bottle green, Bone and Vermilion and
    keep Sage and Cream, so an old pick keeps its name. Nothing in `infra/` changes.
  - *Icons follow.* The app icon becomes a bone italic "C" with the vermilion dot on bottle-green glass; the PWA
    theme colour and background are `#0F372B` and the page asks for `color-scheme: dark`.
- **Alternatives.** *Bone glass with green words* (the reference inverted): the window panels could stay thinner, but
  the app would read cream, not green, against the owner's "tailored towards these colors". *A green halo around the
  words* instead of a heavier panel: neither axe nor the rendered-contrast scan credits a text shadow, so it could not
  be held to the AA bar. *Only `.btn--primary` vermilion*: the owner asked for every CTA.
- **Consequences.** In the window look Clear panels carry 0.73 green (27% of the desktop shows through panels; the
  gaps still show all of it), heavier than the 0.44 of the light look, because a white desktop is now the hard case.
  Every colour test was rewritten for the new direction. The owner may want to re-upload the new 1024 px icon as the
  TikTok and Facebook developer-app icon; that is optional.

## ADR-44 Follow creators: webhooks for speed, a 5-minute tick as the source of truth, YouTube feed first

- **Context.** The owner asked (2026-11-18) to follow YouTubers, Twitch and Kick streamers, see their names and who is
  live, and later have a finished long stream go through the same process as a pasted link. A review of the first plan
  found holes in webhook handling, dedupe, cost and YouTube's rules. Other people's videos are involved, so permission
  matters.
- **Decision.**
  - *Two parts.* Part 1 (CONTRACTS §24) follows, shows names and live badges and notices finished streams and new
    uploads as `WATCH` items with `autoMaking: false`. It starts no job and has no permission to. Part 2 makes clips
    by itself only after real downloads from AWS work per platform.
  - *Webhooks for speed, the tick for truth.* Twitch EventSub and Kick webhooks change badges at once; a 5-minute
    tick confirms everything with batched calls. A webhook stored as seen whose processing then failed is fine: the
    tick sees the same change. Every Twitch and Kick delivery must be signed (HMAC, RSA) and fresh, or it is a 401.
  - *Once per creator.* Subscriptions belong to the creator item, never to a follower, so two owners following the
    same streamer never fight over Twitch's duplicate rule. The tick unsubscribes a creator nobody follows.
  - *Follow before keys.* Twitch logins and Kick slugs are the item keys, so a child can follow before a grown-up
    pastes the keys (which need 2FA and a developer console). A rename is caught by the tick through the numeric id
    for badges; webhooks for a renamed login fall back to the tick.
  - *YouTube feed first, never the upload project.* The public feed needs no quota or key. Live status uses an
    optional read key from a separate Google Cloud project, at most 1,000 units a day; the upload OAuth app is never
    used, so a policy audit of following can never touch posting.
  - *Permission and never auto-posting.* Following needs "Yes, they said I can". Part 2's clips wait in Review with a
    credit line.
  - *No GSI, no Terraform secrets.* Reverse lookups use the `FOLLOWED` and `CREATOR` partitions (one Query each). Keys
    are runtime secrets under `cf-prod/platforms/`; removing them overwrites the value, never deletes the secret.
  - *No reserved concurrency.* The account cannot reserve any; a conditional DynamoDB lease and an EventBridge target
    with no retries keep runs from overlapping.
  - *No cost ceiling by default* (the owner's choice): "Limit how many a day" is off (stored 0). Part 2 keeps a queue
    of 2 running automatic jobs and 2 per creator a day as throughput and dedupe safety, not cost caps.
- **Consequences.** Badges for Twitch and Kick need the owner's app keys; until then rows say "Needs a grown-up". Kick's
  recording lookup (part 2) uses an unofficial endpoint and may be blocked from AWS; YouTube downloads may need cookies
  and are against YouTube's terms without permission. The tick adds about 8,640 small runs a month.

## ADR-45 See-through glass over an app-owned backdrop

*Amended by
[ADR-87](#adr-87-the-logic-of-light-the-top-layer-is-brighter-every-lift-is-paid-for-reload-is-a-colourless-lens):
"no bone sheen" became "bone lifts paid for with green", and nested glass carries the relative raise. The no-edges rule
stands.*

- **Context.** The owner (2026-11-18): the app read as flat green, with no liquid, see-through glass: "make the
  entire application liquid glassy see-through, as I wanted before. You still should use these colors with the CTA and
  the green and the bone whites", and "for any edge in the application, wherever there might be, even the edge around
  a box ... make that transparent. No matter where it is, how many they are." The root cause was ADR-43's white
  ceiling: every panel was tinted for the worst backdrop anywhere (a white desktop), and the page added a 0.15 green
  veil and a frost on top, so on the web and on phones only 47 % of a near-flat green mesh showed through a panel, and
  the Colours look drew a 0.74 green veil over the whole screen.
- **Decision.**
  - *Veils are worked out against the backdrop the page really has.* Where the page draws its own backdrop (web,
    PWA, phones; see-through without native glass, and Picture before a picture), it is a known living mesh (deep teal,
    two vermilion glows, leaf, a breath of bone, two soft lenses, a darker field), and the panel tint is the least that
    keeps AA over its lightest corner: every blob subset × both field ends × every `saturate()` in the CSS. That is
    0.30, the new `PANEL_VEIL_FLOOR` (a pane reads as glass by its blur and shadow, not its tint). No page veil, no
    Clear frost. Colours split their need between the panels (up to 0.60) and the page. Picture: no page veil, 0.73
    panels.
  - *What content scrolls under still plans for white*: floating layers 0.73, the tab bar 0.59 (icons, 3:1), the
    question sheet 0.86. The window look (real desktop glass) keeps 0.73 until measured (Phase 2).
  - *One text set*, bone and lighter, in every look. Nested glass carries no tint. A green halo is comfort only.
  - *No edges anywhere.* Every border, outline, rim, inset line, hairline and ring is gone; controls read by their
    fill and chosen things by a soft glow. Allowed: the focus ring while `:focus-visible`, the found highlight and
    Ask's spotlight, progress bars and rings, the switch track, spinners, action blinks and text underlines. A unit
    test and an e2e scan of every screen enforce it.
- **Alternatives.** *A glyph rim (`-webkit-text-stroke`) as the AA mechanism*: WCAG does not treat a stroke as the
  text's background, it changes every word and breaks on emoji. *A stronger native tint*: squeezes the wallpaper's
  range. *A bone sheen in panels*: 4.48:1 over the worst panel, under AA. *Bounding the mesh by all blobs stacked*:
  wrong, because `saturate()` lifts a green-only subset more than a stack with vermilion, and sRGB mixing means the
  lightest corner is not always the one that needs the most green; the maths takes the largest veil over every corner.
  *Keeping 3:1 field boundaries for inputs by a lighter fill*: impossible with bone words at AA on a dark panel, so
  fields are told by a deeper well, their label and placeholder, and the focus ring.
- **Review follow-up (same release).** The grain over the living backdrop (bone noise in overlay, 0.1 × 0.55 at its
  peak) is in the maths now, so the panel tint there is 0.33, not 0.30. Tracks and the control fill carry panel + 0.15
  (was + 0.10): held over every spot, not only the lightest, a brown corner of the mesh and some owner colours needed
  more. Controls that sit straight on the page (the Library tabs) wear the control fill; the Ask launcher wears the
  floating layers' tint (it can rest on a white thumbnail); the Ask suggestions have a resting fill; refracting glass
  blurs before it bends (Chromium left the backdrop sharp the other way round); a text field tapped or clicked into
  shows a deeper well and a soft glow, the ring only after Tab; reduced transparency also raises the tab bar and the
  floating layers to 0.92; dark green words on bone never carry the halo.
- **Consequences.** About 67 % of the backdrop shows through every panel on the web and phones (47 % before), 100 %
  between panels (85 %); the default Colours look goes from a 0.74 page veil to 0 / 0.30. Supersedes the 0.45 floor
  of ADR-43. The Mac needs a measurement of the real bottle-green Liquid Glass before the window look's veils can
  change (CONTRACTS §22.2, Phase 2); nothing is stored differently, everything is worked out at read time.


## ADR-46 The desktop app updates itself (signed bundles from our own CloudFront)

- **Context.** The owner (2026-11-18) saw "This computer can't show see-through" on macOS 27 with Liquid Glass. The
  installed Mac app was a copy from 2026-11-16 00:03, from before the see-through window. The pages update by
  themselves (the update banner, §12.2), the native window did not: nothing told the owner a new app existed, and
  "Get the app" is hidden inside the app. The owner wants it never to happen again, with no questions a 6-8 year old
  could not answer.
- **Decision.**
  - *The app updates itself* with Tauri's updater plugin (Rust side only; the page still gets no IPC). It reads
    `downloads/latest.json` on our own CloudFront 5 s after start and every 6 hours, downloads a newer version in the
    background, and asks once: "Clip Factory updated", "Restart to use the newest version.", Restart now / Later.
    Later applies at the next start. Failures are silent (stderr). Only https on our host; never a downgrade.
  - *Signed with our own minisign key*, `requireSignedVersion` on, so a bundle is bound to the version it was signed
    for. The private key lives only in two GitHub Actions secrets, read only by the build step of the job that has no
    OIDC token; a backup stays off the repository with the owner.
  - *Every desktop build is `1.<deploy run number>.0`*, all targets rebuilt together, so `latest.json` has one version
    for every platform. Bundles go under `downloads/updates/<version>/` (immutable), a pointer per target follows,
    and `latest.json` is written from the pointers after every upload.
  - *Copies that cannot update themselves name no version* (`__CF_DESKTOP_VERSION__`), see-through or not; the
    Background page and the update bar offer them the new app with one big button. The oldest also never set
    `__CF_GLASS__`, which tells them apart from computers that cannot show glass. The link uses the
    same host with a trailing dot, which the old app treats as another site and hands to the system browser (the old
    window cannot save a download; plain http is upgraded back to https by the CSP and HSTS).
- **Alternatives.** *GitHub Releases as the update source*: a second place to publish, and the repository is public
  while the app address is not advertised; our CloudFront already serves the installers. *A web-only "new app"
  banner keyed on the app version*: still a manual download and install every time, not kid-proof. *Updating in the
  page through IPC*: would give the remote page native commands, which the empty capability exists to prevent.
  *Silent restart without asking*: could close the app mid-review. *Date-based versions*: NSIS refuses version parts
  above 65535. *`tauri-plugin-process` for the restart*: `AppHandle::restart` in Tauri itself does the same from
  Rust, so the plugin would add a dependency and nothing else.
- **Consequences.** Copies installed from this release on keep themselves current; copies from before it need one
  manual install (the page now says so). If the signing key is lost, installed apps can no longer be updated
  automatically: a build with a new public key must be installed by hand once (desktop/README.md). If deploy.yml is
  renamed or recreated its run number restarts and versions would go down, which the updater refuses: the version
  rule must be moved past the last release then. The installers stay unsigned by Apple and Microsoft (§12.3); the
  updater replaces the app in place, so the first-open warning shows only for a manual install.

## ADR-47 Only platform-reported money; the estimates are removed

- **Context.** The owner asked (2026-11-18) for earnings that are "completely for real, real data, nothing that I should
  add in myself": when each platform starts paying, and then what it pays. §21 guessed money from views times a
  per-1,000-view rate the owner could type in, which is the opposite. Research showed only YouTube (Analytics
  `estimatedRevenue`, scope `yt-analytics-monetary.readonly`) and possibly Facebook (`content_monetization_earnings`)
  report money to an app at all; Instagram, TikTok and X report neither money nor programme status. An adversarial
  review then found that a re-consent through the normal callback would replace the Account item, that a second
  refresher could break rotating tokens, and that "every 403 means not monetized" would show false answers.
- **Decision.**
  - *Only reported money.* A figure appears only when a platform's API reported it about the owner's account, tagged
    as that platform's estimate (every API figure is one). No calculation, conversion or typed-in money anywhere, and
    no "paid" or "actual" wording: payouts are only on the platform's payout page, which we link.
  - *Real progress where money is not shared.* Goals come from `config/monetization.json`, each with an official
    source (CI refuses others), by date (YouTube's 2027-02-01 rules), by programme state and by the owner's country.
    "Goal reached" always adds that the platform checks things we can't see.
  - *States never go down by themselves.* `in_program` (YouTube 200) and `earning` (money above 0) are permanent; only
    `forbidden` with a working non-money report counts as "Not yet"; other errors say how to fix them.
  - *One button, merged consent.* "Allow money reading" asks for the Connect scopes plus the money scopes and goes
    through `save_money_grant()`: token secret, then an UpdateItem on the Account. Normal Connect scopes do not change
    for any platform, Meta OAuth is untouched, and a failed or different-account grant writes nothing.
  - *A separate collector, the shared token manager.* `cf-prod-money` runs once a day (and on an hourly-limited Check
    now) and gets every token through `SecretsTokenProvider`, whose lease keeps X and TikTok rotations single. Its role
    copies `cf-prod-stats`' secret access and has no DeleteItem.
  - *Additive storage.* New sort keys under the owner's partition, a `MONEYOWNERS` registry partition, a new module and
    new routes. No table, index, user pool, secret or bucket changes. `earningsRates`/`earningsPaid` stay stored and
    unread.
  - *Facebook money waits for one live check* (`moneyVerified`), because its unit comes only from a third-party
    document and the metrics may have been removed in June 2026.
- **Consequences.** YouTube is the only platform with money on day one, 2–3 days behind and revised at month end.
  Facebook shows "coming soon" until a grown-up compares one live call with Meta Business Suite. TikTok follower
  counts need a TikTok review of `user.info.stats`; 30-day views need 30 days of snapshots. Google shows an
  "unverified app" screen for the monetary scope. The YouTube API policy's storage limits are not yet confirmed, so
  nothing is deleted automatically except on an explicit YouTube Disconnect (§25.6, §25.8).
- **Amended by [ADR-64](#adr-64-get-paid-payout-records-count-as-sent-to-your-bank-statuses-say-how-they-are-known-the-bank-waits-for-the-owner)
  (2026-11-21).** Two APIs do report money sent toward the bank: AdSense `payments` (YouTube) and Whop `payouts`
  (Content Rewards' money after Whop). They show as "Sent to your bank by Google/Whop", never "received" or "in your
  bank"; the other places still link to their payout pages, and typed-in money stays forbidden.

## ADR-48 Ask pictures go inline, are read once into words, and are never stored

- **Context.** The owner (2026-11-19) wants to show Ask a picture of the screen instead of explaining in words where
  they are. Ask's model only rewords a help answer that search found (§19.5), and search runs on words, so a picture
  helps only if it changes what search finds. A 6 to 8 year old must manage it.
- **Decision.**
  - *Inline*: up to 4 pictures go as base64 JPEG inside `POST /v1/help/answers`, each at most 600 KB after the
    browser re-encodes it to at most 1568 px (about 3.2 MB at most, under the Lambda's 6 MB and the HTTP API's 10 MB).
  - *Read once into words*: one "look" Converse call with image blocks returns `{page, words, seen}`; search runs on
    the question plus `words` and the page; the existing text-only rewrite follows with `picture` as data. Grounding is
    unchanged: a picture can change which help doc is found, never add a page, button, link or number.
  - *Never stored or logged*: the server forgets the pictures after the request; later turns carry only `seen` (one
    sentence), so follow-ups cost nothing more and send nothing again.
  - *Metadata stripped twice*: the browser re-encodes through a canvas and drops APPn segments; the API drops
    APP1..APP15 and COM before Bedrock, for direct API calls.
  - *No "show Ask this screen" button.*
- **Alternatives.** *Presigned S3 upload*: two more round trips, a new prefix with a lifecycle rule, `s3:GetObject`
  for the API role, and pictures stored somewhere, while chats live only in memory so "delete with the chat" is
  impossible; it pays off only above about 5 MB, which this design never reaches. *Re-sending the pictures every
  turn*: up to 8 000 more input tokens and seconds of upload per follow-up. *Capturing the page in the browser*
  (html2canvas or html-to-image, 40 to 200 KB): renders `backdrop-filter`, the SVG glass and `blob:` video wrong,
  cross-origin thumbnails taint the canvas, and `foreignObject` is unreliable in WebKit. *`getDisplayMedia`*: missing
  in the Mac app (WKWebView) and on iOS, and in Chromium it opens a screen picker a child cannot manage.
- **Consequences.** A follow-up about a detail that is not in `seen` needs the picture again (the owner re-attaches
  it). A picture question uses two units of the 30-day model cap and takes about 2 to 4 s longer. A daily picture
  limit (40) and a `pictures` kill-switch attribute bound the cost. Whether Claude Haiku 5.5 on the EU profile takes
  images with JSON-schema output must be confirmed after deploy; until it works every look is `error` and Ask answers
  in words with "I couldn't look at your picture this time." (`HELP_LOOK_MODEL_ID` is the additive way out). The Mac
  app's native drop handler is off, so the page decides what a drop does: only Ask takes one.

## ADR-49 Still page changes, a compositor-only glide, and one top line under an overlay title bar

- **Context.** The owner (2026-11-19, the Mac app, macOS 27.2, see-through Liquid Glass): the menu highlight was smooth
  for two thirds of its slide and laggy for the last third; every page change made the whole window blink white and
  twitch; and the top was ragged: a white native title bar strip, then the menu, the setup card, the settings folders
  and the title plate starting 14, 18, 28 and 34 px down. The Mac app draws with WebKit (WKWebView); the earlier
  smoothness tests ran in Chromium only. Measured in headless WebKit and Chromium with the wrapper simulated: the page
  cross-fade (View Transitions) thinned every glass panel to 32 to 53 % for 100 ms and ended with a 35 to 118 ms stall
  at about 400 ms; the `page-in` fade left the new page transparent for 300 ms; the 460 ms spring reached the item at
  170 ms, overshot to 110 % and crept back; the glide also animated width and height and a separate `scale`.
- **Decision.**
  - *A page change is an instant swap* (CONTRACTS §20.16): no View Transition, no `page-in`, no panel fading in.
  - *The glide is FLIP on the compositor* (§20.13): new place and size at once, one Web Animation on `transform` from the
    old box, a 360 ms non-overshooting ease-out `cubic-bezier(0.22, 1, 0.36, 1)` with the stretch folded in.
  - *One top line* (§11.1): `--titlebar-h`, `--top-safe` and `--top-line` in tokens.css, read by every column. The
    folded setup list's pill shares the line from 940 px: the page starts on it and its first row leaves the pill room
    (`--todo-room`), the settings folders stick on it over the strip's bar.
  - *No see-through loading state* (§20.16): `useLoad` remembers each page's last result for the session, and first-visit
    skeletons carry the panel tint (in the cloud app a page's data takes a full round trip, which showed as a white
    sheet under the title on every page change).
  - *An overlay title bar on macOS* (§12.3): `TitleBarStyle::Overlay` + `hidden_title(true)`, `__CF_TITLEBAR__ = 28`, a
    transparent `data-tauri-drag-region` strip exactly over the 28 px band, and one runtime capability for the app's own origin:
    `core:window:allow-start-dragging` and `core:window:allow-internal-toggle-maximize`.
  - *WebKit* for the three specs that hold this (`nav-smooth`, `page-still`, `top-line`): the `webkit` Playwright
    project; CI runs it in the five `web-e2e (WebKit N/5)` shards, split by each test's saved time, on every pull
    request that touches the web and every night (docs/TESTING.md, "Which browser tests run when"; the B3 trim leaves
    out only the screenshots and part of the contrast matrix, never these). `nav-smooth`'s WebKit run is macOS only: on
    the Linux runners WebKit (GTK/WPE, not the Mac's engine) never started the glide's animation at all.
- **Alternatives.** *Keep the cross-fade but shorter*: still blends two pictures of the whole window and still ends with
  WebKit rebuilding the glass. *A transform-only page entrance*: the owner asked for the window to stay still. *Defer the
  slide until the new page has painted*: measured, it moved the late frames rather than removing them, and added a
  delay to every tap. *`traffic_light_position`*: depends on tao's inset maths; the system place is fine with a 28 px band.
  *The page one pill strip below the menu in pill mode*: the first build did this, and at the app's default window
  (1200 x 820, pill mode) the page sat 72 px below the menu, which is what the owner asked to fix. *A drag strip as
  tall as the top line (42 px)*: invisible, so a control that scrolled up into its lower 14 px moved the window
  instead. *Animating width for every glide*: needs the main thread; kept for the in-page bars with uneven options
  only, where a scaled pill squashed its round ends.
- **Consequences.** Page changes cost no animation at all. In headless WebKit the slide's last third has no frame over
  34 ms (was 35 to 118 ms); a new page's own layout can still give the main thread an odd 25 to 80 ms frame in the
  slide's first half, which a compositor animation does not show. The title bar change reaches the owner only with a
  new desktop build; until then the web part already lines every column up (the band is 0 without the new wrapper).
  Not measured on the real Mac window: the title bar height on macOS 27, and the slide's smoothness in WKWebView.


## ADR-50 MRR for a per-view creator: reported days ending on the newest reported day; pace is labelled; per-clip money only from same-report numbers

- **Context.** The owner (2026-11-19) asked for daily, weekly, monthly and yearly MRR filtered by app, Monthly first,
  and for how much each video earns. Only YouTube (and Facebook once its live check passes) reports money; days arrive
  2–3 days late and change at month end. TikTok, Instagram and X have no money API. ADR-47 forbids any guessed money.
  (ADR-49 is taken by an open change, so this is ADR-50.)
- **Decision.**
  - Periods are sums of stored `REVENUE#` days ending on the earliest newest-reported day across the counted apps,
    so every app covers the same days and nothing looks short because of the lag.
  - Daily MRR is the 30-day average over the days stored history covers (`coveredDays`, at most 30). Yearly MRR is
    Monthly × 12 (× 360 ÷ `coveredDays` while fewer than 30 days are covered), always called "at this pace", worked
    out only on the server, and never added to anything; "Last 365 days" is shown only once stored history covers it.
  - An app more than 6 days behind while another is current is left out and named (`behind`) rather than pulling
    every app's days back; the banner names only the apps whose check failed or that are behind.
  - Apps without a money API are left out with a visible note, never estimated. Currencies are never added together.
  - Per-clip period money comes from new YouTube `dimensions=video` reports over the same days, stored additively in
    `revenueWindows` with `SET` on the Post; only a window over the list's own days counts, and none while YouTube
    lacks the money permission. Per 1,000 views shows only when the money and the views come from one
    YouTube report and the views are at least 1,000.
  - The server works out every number; the web only formats them. The mock carries one copy of the rules, held to
    the server's by shared golden cases, and the CI guard blocks money arithmetic anywhere else in `web/src`.
  - Apps, period and sort are saved per device (`localStorage`, the address wins).
  - On phones and touch tablets the controls sit in a bottom-right dock above the tab bar, and Ask's home spot moves
    above the dock while that page is open. Wide screens get a sticky full-width glass band under the title with the
    controls at its right end (the page scrolls under the whole band, so it never covers content beside it).
- **Alternatives.** *The web fetching each app's days and adding them up*: five calls, money arithmetic in the
  browser and no single source of truth. *Ending periods on today*: every period would look 2–3 days short.
  *Estimating TikTok/Instagram/X money from views*: forbidden by ADR-47. *A chart library*: not needed for bars, and
  every one draws axes and gridlines by default.
- **Consequences.** YouTube is the only app counted on day one. History starts about 2–3 months before the first
  money run and grows from there, so comparisons and "Last 365 days" appear only once enough days are covered. The
  daily money run makes 3 more Analytics report sets. No infra changes; the Terraform plan is code updates only.

## ADR-51 Ask becomes a full assistant on Bedrock Mantle

- **Context.** The owner (2026-11-19) wants Ask to answer any question, on any topic, while always knowing his app and
  his own setup, to check today's platform steps on the web, and to take files (drop, paste, attach) and pictures he
  can mark in red. §19's "only reword a help answer" cannot do that, and the 29 s API limit cannot hold a model that
  searches and reads.
- **Decision.**
  - *Model*: Claude Opus 5.5 on Claude in Amazon Bedrock (the `bedrock-mantle` Messages API) **in-Region in
    eu-north-1**, through the official Anthropic SDK (`AnthropicBedrockMantle`), adaptive thinking at effort medium,
    streamed. Refusals retry on Opus 4.8 through the SDK middleware (Bedrock has no server-side fallbacks).
  - *Knowledge*: a generated, committed, secrets-filtered pack (the help corpus as an app map, the owner manual and a
    library index) behind the skills block, cached for an hour; the owner's live state after his question as a
    mid-conversation system message; read-only tools for library sections, his own data and app buttons.
  - *Web*: Bedrock has no server web search or fetch, so both are client tools in the worker: Brave Search API (key
    in Secrets Manager, saved by the owner in Settings) and a fetch that only opens URLs from this answer's results or
    his own words, behind an SSRF guard.
  - *Transport*: `POST /v1/help/asks` returns 202 and starts `cf-prod-ask` asynchronously; the answer streams back as
    `ask.*` events over the existing WebSocket (its id learned with `whoami`). The §19 path stays as the fallback.
  - *Files*: uploaded with presigned PUTs to `ask/{sub}/`, read once by the worker and deleted as soon as they are in
    memory (again in its `finally`); the API and the panel delete them when a question does not start; a 1-day
    lifecycle rule is the safety net.
  - *Review of 2026-11-19*: APP STATE (system weight) holds only enums, numbers, ids and Clip Factory's own words;
    outside words go through a tool as data. The typed-question refusal is narrowed to asking for his own stored
    values, and answers pass a narrow filter (high-confidence key shapes and his stored key) so general and Terraform
    answers stay intact; the wide filter stays on the pack, APP STATE and files. Each fetch has one deadline inside the
    answer's budget, tools run in parallel, a heartbeat keeps the panel's silence timer from firing, and the output
    budget ends with a tool-free last round instead of a cut.
  - *Markup*: a client-only editor that saves one flattened JPEG in place of the picture; the original never leaves
    the device.
- **Alternatives considered.** *Claude Fable 5.2*: not on Mantle, twice the price, long turns. *Converse with native
  docx/xlsx documents*: a second model API off the SDK path. *A Lambda Function URL with response streaming*: Python
  has no native response streaming (a custom runtime) and the CSP would need a new origin. *WebSocket only*: 32 KB
  frames cannot carry a question with history and files. *Inline base64 files*: the 6 MB Lambda payload and the
  WebSocket frame limit. *Claude Platform on AWS with server web search*: not EU in-Region, a new billing account and
  console. *Reserved concurrency 3*: this account cannot reserve any (the deploy would fail); the per-owner rate limit
  bounds concurrency instead.
- **Consequences.** One owner step for web search (a free Brave key) and possibly one for Bedrock model access in
  Stockholm. Cost is bounded per answer (time, rounds, tokens) and watched by a daily token alarm instead of a monthly
  cap. The Lambda zip now carries the Anthropic SDK and two compiled wheels for arm64. Bedrock support for some
  request features (eager tool input, document blocks in tool results, the fallback credit header) is unconfirmed until
  the first deploy; each has a switch or an automatic way out.

## ADR-52 YouTube from the cloud: PO tokens, one extraction per cut, a full download only as fallback, a file upload always one tap away

- **Context.** Two owner screenshots of a 1 h 41 min YouTube job: first "YouTube is blocking downloads from the cloud
  and your cookies did not help" at Find the video, then a failure at Cut the clips. YouTube flags datacenter
  addresses ("Sign in to confirm you're not a bot"); yt-dlp 2026.10.26 skips its `web` client without a PO token
  when cookies are given; cookies exported from a normal window are rotated by YouTube; our `--no-warnings` hid the
  warning that says so. Each clip's section ran a full extraction from the flagged address (10 to 30 calls for 10
  clips), and section downloads gave a 403 now and then even from a home connection.
- **Decision.** (CONTRACTS §29)
  - The bgutil PO token server runs in the agent container (loopback, supervised), with the plugin's script mode as
    backup; every YouTube call uses `player_client=default,mweb` and keeps yt-dlp's warnings.
  - Rotated cookies are detected and told plainly; Settings shows a private-window guide and checks the file before
    upload.
  - Cut the clips makes one extraction and reads every section from it; a 403-type failure refreshes it once; then
    one full download per job (1080 → 720 → 480 within the disk budget) and local cuts. Partial success is kept.
  - "Use a video file" on every failed link job opens New job with the file picker (the existing upload flow).
  - An optional proxy secret in Secrets Manager, read if it exists; never required, never created by Terraform.
- **Alternatives.**
  - *The Mac downloads it* (desktop app runs yt-dlp at home and uploads): yt-dlp, ffmpeg and Deno in the signed,
    notarized bundle (about 150 MB), and every YouTube change would need a signed desktop release. The file button
    gives the same home-connection result with no desktop release.
  - *A full download up front*: a multi-hour stream at 1080p is 10 to 25 GB and does not fit; sections are tens of MB.
  - *A required proxy*: the most reliable fix, but a cost and an account for the owner; kept optional.
  - *Script mode only*: a new Deno process per token; the server keeps tokens warm. *mweb only*: 360p.
- **Consequences.** The image grows by about 175 MB and runs a ~200 MB process. A job that falls back takes some
  minutes longer and needs disk for the full file. A token and fresh cookies raise the odds but do not guarantee
  passing the bot check from AWS; the file button and the proxy are the sure ways. Amends ADR-13.

## ADR-53 Ask answers the picture: screenshot rules, the setup guide as a tool, keyless official pages, no canned fallback, a model smoke check on deploy

- **Context.** On 19 Nov 2026 the owner sent Ask a phone screenshot of Facebook's **Edit profile › Manage connection**
  sheet and asked "What do I do now?". He got "Jobs working right now: 0 … Open Jobs". The assistant never ran: iOS had
  dropped the WebSocket while he was in Facebook, the panel waited 4 s, fell back to the §19 keyword help *without the
  picture*, and BM25 matched the one content word "now" to "Is anything running right now". Even with the model, the
  prompt had no picture rules, treated a guide checked on 16 Nov as the truth about Meta's screens, and could not read
  official pages without a Brave key. Some guide steps were also out of date (Facebook "full control", "Go live", the
  Instagram business portfolio, no hint for **Manage connection**).
- **Decision.**
  - *No fake answers.* A question with files never goes to the keyword help. Without files, the short help answers
    only a real match; open questions ("What do I do now?", "I'm stuck") are unknown in both retrievers. Otherwise
    the panel says plainly that Ask could not answer, keeps the picture and words, and shows **Try again**.
  - *Reach the model more often.* The panel wakes a dropped socket and waits 10 s more. Model errors before any words
    (access not enabled, throttling, 5xx, timeouts) retry once on Opus 4.8; the owner then reads a plain reason and
    the log says which.
  - *Pictures first.* New rules 12 and 13: name the screen, find the step with the new `read_setup_guide` tool (the
    picture wins over his ticks), say if it looks done, give the next taps and a `setup-step:{platform}:{stepId}`
    button that opens and lights that step. Picture and setup questions run at effort `high`.
  - *The guide can be wrong about other sites.* Rule 2 keeps KNOWLEDGE as the truth for Clip Factory's own pages only;
    for Meta, TikTok, Google and X, his picture and the official page win, and Ask says "Our guide is out of date
    here." with the source.
  - *The web without a key.* Anthropic's server web tools are still not on Bedrock (only the Claude API and Claude
    Platform on AWS, ruled out in ADR-51), so `web_fetch` now opens a fixed list of official documentation pages
    (exact host plus path prefix, never posts, Pages, forums or link shims; query dropped; every redirect hop stays
    official or on the same host; 3 per answer) and every page a setup step opens, with no key and no link in the
    chat, behind the same SSRF guard. The kill switch's `web: false` stops all of it except links he typed. Open search of
    any site still uses the owner's Brave key, mentioned at most once, at the end.
  - *Proof on every deploy.* `cf-prod-ask` takes `{"smoke": "ask"}`: the deployed model must say "red" for a tiny red
    PNG sent as an image block. deploy.yml's smoke job invokes it with the deploy role (which already has `lambda:*`)
    and fails the deploy otherwise. Only the main model counts. Until the owner's one-time Bedrock step, an access
    or model-id-not-found error only warns, so unrelated merges stay green.
  - *Guides re-checked on 19 Nov 2026* for Instagram, Facebook, YouTube and X (docs/SETUP_POSTING.md lists the
    changes and sources).
- **Alternatives considered.** *Moving Ask to Claude Platform on AWS for server web search and fetch*: still not EU
  in-Region and a second billing account (ADR-51). *Scraping a search engine's result pages without a key*: brittle
  and against most terms. *An AgentCore browser tool*: new infrastructure, availability in eu-north-1 unverified; left
  for later. *Adding `ads_management`/`ads_read` to Instagram's scopes*: only needed when the Page sits in a business
  portfolio with a Business Manager role; making the portfolio optional avoids that path without a scope change.
  *Switching Instagram to "Instagram API with Instagram Login"* (no Facebook Page): simpler for the owner, but a new
  OAuth flow and publisher; a later ADR.
- **Consequences.** The deploy warns when Bedrock has not let Clip Factory use Opus 5.5 in eu-north-1 yet (an owner
  step in the Bedrock console: Model catalog, use-case form, one playground message) and fails when the model cannot
  see pictures. Picture and setup answers cost more (effort
  high). Ask can be wrong about a Meta page that only draws with script; it then says it could not read it and
  works from the picture and the guide.

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
- **Decision.** (CONTRACTS §30) Resume, don't fail: the flow resumes a stopped job on a new session from saved moments
  and clips, as long as each attempt moves it forward (up to 6 resumes; 2 without progress end it); heartbeats come from a thread that beats only while the loop is alive, every 2 minutes,
  with a 6-minute timeout, and log memory; SIGTERM tells the flow at once; the Cut step's memory is bounded; deploys
  wait up to 25 minutes for running jobs when the agent changes. The pinned endpoint stays a later option, only if
  the logs keep showing deploy kills.
- **Consequences.** A stop costs minutes, not the job; the owner sees "stopped" only when the job is stuck, and even then
  Try again picks up. A resumed job may cut again a clip that was half done; a clip that was being cut when two runs
  died is left out so the rest finish. Clip ids are kept across runs, so no clip is posted twice. The flow's first attempt keeps its
  operation names, so executions started before this change replay unchanged.

## ADR-55 The live status line: a small item of its own, from fixed templates

- **Context.** The owner wants the line under a job's progress bar to show, in real time and in one line, what the job
  is running right now, "commands or whatever it might be" (CONTRACTS §31). Until now the line was the job's `note`
  (§30), set only when a job was picked up again, and the step messages changed a few times per step.
- **Options.** (1) Write the line into the job item: every second would rewrite several KB (the `steps` array) and send
  that over every socket, 3 to 5 times the write units. (2) Show the real command lines: they hold paths, signed
  links and cookie files, and mean nothing to the owner. (3) A small `JOBLIVE#` item per job, filled only from fixed
  templates with number slots, throttled to one write a second when the words change.
- **Decision.** Option 3. The agent's `LiveStatus` fills templates from yt-dlp and ffmpeg progress, part counts and
  model calls, scrubs every value once more, and writes at most once a second plus a 30-second refresh, best effort.
  The broadcast carries it as `jobLive` with an allow-list of fields and a hash of the session (`run`) so the web can
  drop a line of an older run. Page loads get it attached to working jobs. The "commands" are a tiny monospace line
  such as `ffmpeg · 1080×1920 · 30 fps` or `Claude Fable 5.1 · thinking`, never a real command.
- **Consequences.** The line moves about once a second while a job runs, for well under a cent per job-hour. Nothing
  new polls. The stream filter gains one prefix in place (no replacement), and the item expires on its own by TTL, so
  no data of the owner's is touched. A screen reader hears only step and clip changes. The same line can later feed
  phone notifications without new agent work.


## ADR-56 Notifications through the Home Screen web app, not an App Store app

Web Push, the app icon badge and one replaceable notification per video instead of a native Lock Screen widget.

- **Context.** The owner wants notifications on his iPhone and to see from the Lock Screen what a video is doing (the
  step and the clip). A Lock Screen widget or Live Activity needs a native app with WidgetKit or ActivityKit, an Apple
  Developer account and TestFlight. The owner said no to an App Store app: he adds Clip Factory to his Home Screen from
  Safari and wants it to stay that simple.
- **Options.** (1) A native SwiftUI shell with a widget extension and APNs: real Live Activities, but a paid developer
  account, signing, TestFlight and a second app to keep up. (2) Web Push to the Home Screen web app (iOS 16.4+), the
  Badging API, and one notification per job replaced by tag. (3) Nothing outside the app.
- **Decision.** (CONTRACTS §32) Option 2. The VAPID key is generated by Terraform as an ephemeral value and written
  write-only to Secrets Manager (never printed, never in state, never destroyed). `cf-prod-notify` reads job changes
  from the stream and sends ready, stopped and picked-up notifications by default; step cards ("Cutting the clips ·
  step 7 of 10 · clip 3 of 10") only when the owner turns on Every step, at most every 2 minutes, all with the job's
  tag so they replace each other. The app icon shows how many videos are working. Settings says plainly that Lock
  Screen widgets only come with App Store apps.
- **Consequences.** Works on iPhone only from the Home Screen app, after a tap on Turn on. Each step card is a real
  notification (iPhone has no silent push); if a real iPhone shows that the same tag does not replace the card, Every
  step stays off by default and the important three still arrive. The Mac app needs a notification plugin in a later
  signed release; Mac Safari and Chrome work now. Push services see only encrypted payloads.

## ADR-57 Upload replaces Keep; the owner picks places per clip; no dropdowns, no extra options

**Corrected by ADR-60.** The "no preset, no options, button bar for TikTok" part below was a misreading: the owner asked
for a one-tap preset of his own settings and options per platform, and TikTok's rules ask for a dropdown. The Upload,
`platforms` and per-place Try again parts stand.

Upload to many places at once, nothing else to pick, inside each platform's rules.

- **Context.** The owner read the caption tab strip as a pick-one platform picker, saw X offered though X was not set
  up, and asked for "Upload" instead of "Keep", for any number of places per clip, and never "made for kids" (he
  swears in some clips). He also said no dropdown, and that goes for YouTube, TikTok, Instagram, Facebook and X. A first
  build added a "Use my settings" button, a "More details" panel with a category dropdown and switches, a "Who can
  reply" dropdown and a My settings page; a review showed that is the opposite of what he asked, and that a stored
  preset made YouTube ignore his saved privacy.
- **Options.** (1) Keep posting to Where clips go and only rename the button; (2) a per-clip destination list sent
  with Upload and nothing else; (3) (2) plus a stored preset and per-clip options.
- **Decision.** (CONTRACTS §33) Option 2: `platforms` on Confirm (additive; older clients work as before), `uploadTo` on
  the clip, Try again per place. No preset, no `options`: every place keeps its saved setup, so YouTube still follows
  `youtubePrivacy`, and YouTube's made-for-kids flag stays false. TikTok's Content Sharing Guidelines (updated 4 Aug
  2026) still require the creator to pick the privacy with no default from `privacy_level_options` (only "Only me"
  until TikTok audits the app), and to see Comments, Duet and Stitch off by default; so the TikTok sheet shows that as
  one bar of buttons (not a dropdown, the owner's word) with nothing picked, and stays visible on every TikTok upload.
- **Consequences.** One tap more for TikTok than the owner wanted, and Everyone cannot be picked at all until TikTok
  approves the app; everything else is one tap. Whether TikTok accepts a button bar in place of its "dropdown" is to be
  confirmed at app review. No table or infrastructure change; existing clips and posts are untouched.
## ADR-59 Mac fetches it: the owner's desktop app downloads what YouTube refuses the cloud

The desktop app gets the YouTube video on the owner's home connection and sends it to the job, up front for jobs
made in the app and as a fallback for every other blocked YouTube job.

- **Context.** YouTube blocks AWS addresses: "Sign in to confirm you're not a bot", cookies that run out, 403s while
  cutting (§29). The PO token and cookies help only sometimes, and the owner wants no technical steps. His Mac is on a
  home connection YouTube does not block, and he usually has the app open when he starts jobs.
- **Options.** (1) A paid residential proxy: monthly cost, still blockable. (2) Ask for a video file every time:
  works, but it is the manual step he wants gone. (3) The desktop app downloads the video and uploads it to the job.
  For (3), the tools could be bundled as sidecars (about 200 MB more per installer, a full signed release and a
  "Restart now" for every yt-dlp bump, and not notarized anyway) or downloaded at first use from our own signed
  manifest.
- **Decision.** (CONTRACTS §35) Option 3, up front and as fallback, sharing one path: the job waits (status running,
  no compute) on a 24 h durable callback; the desktop window's page claims it, the app downloads at the best rung that
  fits the disk and PUTs 64 MB parts straight to signed S3 addresses; the API completes the upload and the callback,
  and the job goes on as an upload. The tools are pinned in `desktop/tools/tools.lock.json`, checked in CI against
  upstream's sums and the lock, published to our CloudFront, and the manifest is signed with a new ed25519 key whose
  private half lives only in the GitHub secret `CF_TOOLS_SIGNING_KEY`; the app checks it with the built-in public key.
  The page gets four commands for its own origin only, never a shell or the file system.
- **Consequences.** No extra running cost and no cookies. A job started on a phone with the Mac closed waits up to 24
  hours (the owner is told after 2 minutes) instead of failing at once; Use a video file stays one tap away when it
  fails. A whole video at up to 1080p goes over the owner's upload link, where the cloud fetched only the clips'
  sections. Tool bumps ship without an app release; the app shell change needs one "Restart now". The job flow's
  execution timeout grows to 41.5 h.


## ADR-58 Deleting a job: a hard delete behind a client-side Undo, posted clips never touched

- **Context.** The owner wants to delete jobs (failed ones, finished ones). A job owns working files (gigabytes of
  audio, picture parts and checkpoints) and clips, some of them posted on five platforms with numbers the learning
  relies on. A running job has an agent container and a durable flow that keep writing to it.
- **Options.** (1) A server-side soft delete (`deletedAt`, hidden from every read, a TTL purge later): Undo works on
  every device, but every read must filter it, list pages come back short, and the purge needs a scheduled job or a
  stream consumer with S3 rights (new infrastructure). (2) A hard delete sent after the 8-second Undo the app already
  uses for Stop job and Throw away (§16.8, §12.3). (3) A hard delete with only a confirm.
- **Decision.** (CONTRACTS §34) Option 2, behind one question that says exactly what happens. The server delete is
  ordered so it is safe to repeat: fence the job with a new `sessionId` (the agent and the flow already condition every
  write on theirs), stop the run outright, delete thrown-away clips and, only when the owner turns it on (off by
  default), the clips still in Review, then the files except the kept clips' folders, then the job. Kept and posted
  clips, their posts and numbers are never deleted: deleting a job is housekeeping, not taking anything down. The
  Review-clips switch is off by default because those clips have not been looked at yet; Undo covers a slip, the
  switch covers intent.
- **Consequences.** No infrastructure change. The Undo lives on the device that deleted (another device sees the job go
  when the delete is sent, 8 seconds later); a tab closed inside the window still sends it (`pagehide`, `keepalive`),
  and if that request is lost the job simply stays, never half-deleted. A clip whose job is gone keeps working and its
  "See the job" link says the job is gone. Select's Pick all failed picks the failed jobs loaded on screen, not older
  pages.


## ADR-60 One simple Review card: Use my settings, one row per place, TikTok's dropdown

Two taps for a standard upload; each platform's options in its own row; TikTok's privacy from a dropdown.

- **Context.** After ADR-57 the owner saw two platform bars on one card (the Upload to chips and the caption tab bar)
  and asked what the difference was. What he wants: tick the places, one button for his settings, a dropdown per
  platform (TikTok paid partnership, for example), one button to upload. ADR-57 had also removed the preset he asked
  for and replaced TikTok's privacy dropdown with a button bar, while TikTok's Content Sharing Guidelines ask for the
  privacy "from a dropdown" with no default.
- **Options.** (1) Keep the tab bar and add a preset button; (2) one collapsed row per ticked place holding its words
  and options, a server-side preset applied by one tap, and TikTok's controls in its row; (3) auto-apply everything,
  TikTok included, with no tap.
- **Decision.** (CONTRACTS §36) Option 2. `settings.postPreset` (additive, per owner, defaults: the most reach, never
  made for kids; the preset can never say made for kids) edited in Settings › Posting › My settings; confirm gains
  optional per-clip `options` for YouTube, Instagram and X, stored as post options and read by the publishers before
  the preset. YouTube, Instagram, Facebook and X use the preset from the start; TikTok's choices go on only with the
  owner's tap on Use my settings (his own action, as TikTok requires), so option 3 is out. TikTok's "Who can see it" is
  the app's own dropdown with no default, Everyone first. The caption tab bar is gone. The Ask launcher fades whenever
  it touches Upload or Use my settings.
- **Consequences.** A standard upload is Use my settings, then Upload to 4. The TikTok sheet stays for Library's Try
  again only. No table or infrastructure change: the preset is one more attribute on the settings item, written only
  when the owner saves; existing settings, clips and posts are untouched, and older clients post exactly as before.

## ADR-61 Chat hype from replay where it is public, from the picture where it is not; never a reason to fail

- **Context.** The owner asked that a streamer's chat scrolling very fast, or flooding with one word, count as a sign
  of a viral moment. Chat is the crowd's loudness spike, but it lags the moment by a few seconds and is noisy (raids,
  giveaways, sub trains, bots, chat-only memes).
- **Options.** (1) Twitch Helix: has no VOD chat. (2) Paid third-party scrapers: cost, and chatter data leaves our
  control. (3) Twitch comments by cursor: needs a `Client-Integrity` token; we will not make or replay one. (4) OCR of
  on-screen chat: too costly for a speed signal. (5) Fold chat into `Signals`: it would bring the picture rules into
  the prompt when only chat exists. (6) Public replays where they exist (YouTube live chat via yt-dlp, Twitch comments
  by time offset, one Kick probe) plus a cheap chat box speed meter on the picture we already decode.
- **Decision.** (CONTRACTS §37) Option 6. Chat is its own optional field (`Brief.chat`, `chat.json`), shifted back by
  a lag learned from the loudness spikes, with code-level flags for raids, giveaways, subs and bots, and a skill block
  for what code cannot see (memes unrelated to the screen). Twitch GraphQL is undocumented and a terms grey zone: read
  only, low rate, offset paging only, stops for good on any integrity check, with a kill switch.
- **Consequences.** Twitch chat goes quiet if Twitch extends integrity checks to offset paging; Kick from AWS is
  nearly always blocked, so Kick and uploads mostly rely on the chat box; Mac-fetched or blocked YouTube jobs get no
  replay. The chat box finder can miss odd overlays (then there is no chat, which is safe). Bedrock cost under $0.05
  a job; the image grows by numpy. No infrastructure or owner data change.

## ADR-62 Content Rewards: the official sign-in through the desktop app's loopback door, sending from the cloud, a reminder when it can't

- **Context.** The owner joins paid clipping campaigns on Content Rewards (CR) and wants Clip Factory to follow each
  campaign's rules and send every clip so it can earn, in 3 steps per campaign (5 at most), kid-proof from setup to
  getting paid. A post earns only if it is sent within 30 minutes of going live, from an account linked inside CR,
  and only once, to one campaign. The local app tried this with browser automation in a signed-in Chrome: 9 Shorts
  posted on an $8,500 campaign, 0 of 7 links sent (a declined application it could not read, a pop-up over the page,
  TikTok drafts with no public link). Whop's terms ban scrapers and CR's older clipper terms banned automated
  posting. Since October 2026 CR has an official MCP server with a person's OAuth sign-in (a pilot) whose
  `create_my_submission` sends your own post "the same as the creators app", but its OAuth server only takes
  `http://localhost` / `127.0.0.1` redirects (no https), its refresh token is single use and rotates (a reuse more
  than a few seconds later ends the connection), it lasts 30 days unused and 90 days at most, and any request with an
  `Origin` header gets 403.
- **Options.** (1) Browser automation of contentrewards.com (the local app's way): breaks on the first pop-up, can't
  tell a declined application, against Whop's terms. (2) The undocumented public JSON for everything: read only, no
  way to submit, robots.txt disallows `/api/` for crawlers. (3) CR's REST API: brand and agency keys only, not for a
  clipper. (4) The official MCP sign-in, with the redirect landing on a one-shot `127.0.0.1` listener in the owner's
  desktop app, the code exchanged and every token kept by the cloud, and every MCP call made by Lambda. (5) The same
  sign-in run entirely on the Mac (tokens and calls in the desktop app): phone uploads could not send while the Mac
  sleeps, and the 30-minute window would depend on the Mac being on. (6) No sign-in: after each post, remind the
  owner to paste the link himself.
- **Decision.** (CONTRACTS §38) Option 4 with option 6 as the fallback. Clip Factory registers itself with CR (RFC
  7591, `client_name` "Clip Factory", five fixed loopback redirects `http://127.0.0.1:47811–47815/`, no secret); the
  Mac app's narrow `cr_connect_*` commands (app origin only; macOS only, Windows answers `unsupported`) open the door
  for at most 5 minutes, open CR's sign-in in the system browser, take only `?code&state` (+ `iss`; the state must
  match the URL it opened), show "Done, go back to Clip Factory" and hand the code to its own page, which posts it to
  the API at once (the code lives 60 s). The API exchanges it with PKCE S256 (the verifier derived from the signed
  state, never stored) and keeps the token only in Secrets Manager (`cf-prod/platforms/contentrewards/token`, created
  at runtime under the existing prefix and grants). Exactly one process ever uses a refresh token: the §17.6 lease
  on `CRCONN`, taken only with 20 s of Lambda left, an immediate single retry of the same token when an answer is
  lost, the secret read by the `VersionId` recorded on `CRCONN` (never a stale copy), put-only writes (a refresh can
  never re-create a disconnected secret), and Connect and Disconnect under the same lease. The clip flow sends each
  campaign post right after it is live and public (`idempotency_key` = the post id, frozen with the URL and campaign
  id on the first try), retries every minute until 25 minutes after posting, then stops; these steps never fail the
  clip flow. `cf-prod-stats` follows membership, reviews, views, proof reminders and money on its 15-minute tick
  (money paged to the end with a watermark, so a total is always CR's whole number). When sending is not possible (no
  sign-in, the pilot refused the write scope, an older campaign closed to apps, an error that isn't the owner's, or
  the 25 minutes ran out) the owner gets a notification "Send this to Content Rewards now (N min left)" that opens the
  clip with one "Copy and open" button. No browser automation anywhere; the public campaign JSON is read only when
  the owner acts (add, Check now, opening a stale card, a job's start), never on a schedule, rate-limited and cached.
  Claude turns the brief into rules (the local app's RULES_SCHEMA, ported) in `cf-prod-campaigns`, a Lambda with no
  secret access; code checks every field (verbatim from the brief for anything that reaches a caption, the screen or
  a link; fixed disclosure words; caps on tags; CR's own toggles can only add stops). Pay, budget, status and
  platforms come only from CR's own fields; pure-code gates (the local `ruleCheck.js`) decide the stops. Campaign
  clips go up public, never made for kids, with paid partnership on where the platform's API has it, the disclosure
  ("#Ad") first in the caption, the required tags, "Paid partnership" on screen for 3 seconds and the logo in the
  band above the picture. CR is a separate connection, never a sixth `Platform`, and money from CR is shown only as CR
  reports it (§25 extended; "paid" is allowed only next to CR's paid payouts). The whole feature ships switched off
  (`content_rewards_enabled = false`) and is turned on by one line once every part has merged (done: the switch PR
  #88, 21 Nov 2026, so it is on).
- **Consequences.** The owner signs in on the Mac once and again at least every 90 days (a week's warning); after
  that everything runs in the cloud, so a phone upload is sent too. CR's pilot may refuse the write scope at first:
  then Clip Factory reads campaigns and money and reminds him after each post (and every 3 days to try Connect
  again), and the setup card offers the ready email to CR support; if CR refuses apps entirely he says "It says
  Submit clip" and pastes the rules once per campaign. The alpha API can change: the client tolerates unknown fields
  and values, a daily keep-alive refresh shows breakage early, and unexpected errors go to CR through
  `send_feedback`. Previews of not-yet-joined campaigns can be up to an owner action old (the card says "as of").
  TikTok campaign clips wait for TikTok's audit (private posts can't earn). Instagram and Facebook carry the
  disclosure in the caption and on the video only. The existing platform-secret grants are wider than CR needs
  (`cf-prod-money` and `cf-prod-hooks` can reach the CR token; written down in SECURITY.md). Additive only: new sort
  keys (`CRCONN`, `CRSTATE#`, `CAMPAIGN#`, `CRSUB#`, `CRMONEY`, `CROWNERS`), new attributes, a new media prefix
  `campaigns/`, runtime secrets, one new Lambda `cf-prod-campaigns`, two widened stream filters; nothing that holds
  the owner's data is replaced. One signed desktop release ("Restart now").

## ADR-63 Content Rewards follow-ups: one fit check, a new copy, one 30-day total

- **Context.** After approving §38 the owner asked (2026-11-21) for three things: the Connect steps checked so they are
  very simple and in time order, with a pleasant choice between campaign clips and the normal clips he makes today;
  all his money from every place, Content Rewards included, in one place; and to know before uploading whether a clip
  can earn on a campaign he joined, so he never sends one that can't. Content Rewards (CR) checks a post when it is
  sent: from an account added inside CR, never sent before, live for less than 30 minutes; a post belongs to one
  campaign forever; rejections rest on the written brief; the same final clip in two campaigns is rejected as a
  reused edit; CR's disclosure page wants "#Ad" first and a text on the video at the start. The brief is free text
  that Claude reads into `CampaignRules`, with an `uncertain` list. Of the five platforms only YouTube (and Facebook,
  once checked) report money to apps; TikTok, Instagram and X report none; CR reports its balance and payouts but not
  what left the balance for Whop.
- **Options.** Where the fit runs: (1) in the web (fast, but Confirm could not trust it, and the rules would live in two
  languages); (2) in the agent at render time (it knows the video, but not later changes: membership, budget, places,
  posts); (3) one pure function in the API over stored items, computed on every read, used by the Review card, Confirm,
  Try again and the copy route, with the web re-checking only what changes while he types or taps; (4) results stored
  on the clip (stale the moment a campaign or a connection changes). A normal clip that could earn: (a) turn it into a
  campaign clip in place (posts with #Ad and the paid switch), which misses "Paid partnership" on the video and the
  logo that briefs and CR's disclosure page ask for, so it would be rejected; (b) a new campaign clip of the same moment,
  re-rendered with the campaign's rules, the original left as it is; (c) only "Make new clips for this campaign" (new
  moments). A video from a channel whose name doesn't match the campaign's: (x) block it (the match is by name and can
  be wrong, and §38.13 lets the owner decide); (y) "I couldn't check", with "no" only for exact facts (a link outside
  the campaign's own videos, a ruled-out site). Money: (i) add CR's numbers into the MRR cards (they are platform
  estimates by day; CR's are payouts in rounds); (ii) keep CR only in its own part (§38.7: two places to look); (iii)
  one "All your money" card with one 30-day period: each platform's reported rows in those days and CR's paid payouts
  dated in those days, one total per currency, and plain "Not available from …" rows.
- **Decision.** (CONTRACTS §39) Option 3: `contentrewards/fit.py`, pure, from stored items only (never CR, the public
  JSON or the network), each rule an item with a state (`ok`, `fix`, `remake`, `todo`, `no`, `check`, `note`), a verdict
  (`fits`, `fixable`, `wait`, `doesnt_fit`, `cant_tell`) and `canUpload`/`canRemake`; uncertain rules are "I couldn't
  check", never a pass; a held, paused or re-read campaign is "Wait a little", not "can't earn"; Confirm and Try again
  refuse a campaign clip with a `no`, `remake` or `todo` item, with the item's words, and a campaign post waiting for a
  reconnect is not released by itself (it waits for Post now and the same check). Option (y) for the channel. Option
  (b) with (c) as its fallback: `POST …/campaigns/{id}/remake` reserves the copy on the original clip first (a double
  tap makes one), then makes a one-clip campaign job from the same source and moment (A's campaign checks, rules
  snapshot and logo copy), cut from the original's kept video when it is there; the agent skips finding moments for
  it, and a moment can earn on one campaign only; the copy waits behind `cr_remake_enabled` (default off) until the
  agent's part has merged (done: its switch PR #93 turned it on). Option (iii): `GET /v1/money/everywhere`, pure on the server, CR's paid payouts kept by day
  (`CRMONEY.paidByDay`, filled once for older owners by a day scan that never changes the paid total); the card is the
  first on the Money page with the biggest number, and the MRR cards stay platform-only and say so. The normal way is
  frozen: Home's form at `/` and the Review card of a clip with no campaign keep origin/main's controls and taps (5 to
  upload), enforced by click-count tests; the campaign way always starts from a campaign and is named "Make campaign
  clips". The Connect steps keep their order (account, accounts added inside CR, Connect), each with its answer button
  right under its Open button, a "Yes" shortcut for someone already set up, and a way back to the page he came from.
- **Consequences.** The owner sees on every Review card whether a campaign clip can earn and fixes what Clip Factory can
  fix in one tap (tags and #Ad are put back by the upload anyway); a clip that can't earn can't go up the campaign way.
  A normal clip that could earn gets one quiet offer and a new copy in about 3 minutes, right below it on Review; he is
  told to upload the copy (both on one channel could look like reused content, §39.6). Language and source checks are
  only as good as the stored source fields (`sourceLanguage`, `channelKeys`); unknown or unmatched is "I couldn't
  check", so a clip from a wrong channel can still be sent and turned down. "All your money" adds an estimate
  (YouTube) and paid money (CR) over the same days, tagged as such, never across currencies; what left CR for Whop
  stays "not available". A brief that asks for its own overlay becomes a hard stop (`overlay_needed`). Additive only:
  new attributes on `JOB#`, `CLIP#` and `CRMONEY`, one api env var; no table, index, bucket, secret or Lambda changes.

## ADR-64 Get paid: payout records count as "sent to your bank", statuses say how they are known, the bank waits for the owner

- **Context.** The owner asked (2026-11-21) whether Clip Factory shows exactly what he earns on YouTube, TikTok,
  Instagram, Facebook, X and Content Rewards; for a step-by-step payout setup per place, "the same system" as Set up
  posting; for a status per place that tells him money can reach him, or that it can't although he is allowed to
  earn; and for the exact total that reached his bank accounts, per place. He lives in Sweden. Research (273 claims,
  skeptic-checked) found: YouTube's AdSense Management API (`adsense.readonly`) reports the account state, holds and
  every payment Google sent, but nothing about the bank, tax, ID or PIN; Whop's API, with a user sign-in, reports
  payout methods, the ID check and payouts Whop sent; Meta, TikTok and X report no payout status or payouts at all
  (X pays through Stripe Express, which only X can read); TikTok's Creator Rewards isn't open in Sweden; X's Original
  Content Rewards excludes automated and reuploaded posts; Meta's earnings metrics are undocumented in unit and
  currency. Only a booked bank credit proves arrival, and the only free self-serve bank route for a private person in
  Sweden (Enable Banking, restricted mode) has a grey area in its terms. ADR-47 says "payouts are only on the
  platform's payout page" and forbids "paid" wording and typed-in money.
- **Options.** Payouts: (a) keep ADR-47 as it is, links only; (b) show the payments AdSense and Whop report, worded
  as what they are, "Sent to your bank by Google/Whop"; (c) also work out "sent" as paid minus balance (a
  calculation, refused). The places with no API: (i) let him type his earnings and payouts, labelled "You typed
  this"; (ii) keep "Not available from X" with where to look, and let the bank show what really arrived. Statuses: (x)
  ticks only; (y) signals only (four places would say nothing); (z) signals where they exist, his ticks elsewhere,
  each labelled with who said it, signals beating ticks. Where: inside Set up posting (it would change the five-row
  to-do list and the "n of 5" ring) or its own Get paid area plus a card on Money. Storing ticks: `SETUP#.stepsDone`
  (it would move the to-do rows) or a new `GETPAID` item. The bank: Enable Banking, a monthly bank file, payout emails,
  or nothing new.
- **Decision.** (CONTRACTS §40) (b): AdSense `payments` and Whop `completed` payouts are shown as "Sent to your bank
  by Google" / "by Whop", tagged "YouTube says" / "Whop says", with when they should arrive; "Reached your bank" is
  kept for bank-booked credits only; ADR-47's ban on "paid", "received" and "actual" next to an amount stays. (ii):
  no typed-in money anywhere; Instagram, TikTok, X and Facebook say "Not available" with where to look; Facebook's
  estimate stays "coming soon". (z): one pure status function on the server over stored items, eight statuses
  (on hold, not allowed yet, can get paid ✓, not set up, checking, can get paid (you said it's done), Clip Factory
  can't check, not started), never "Live" without a signal or a tick, a hold first, YouTube's own "not in the Partner
  Program" above his ticks. "Not set up" is red only when a signal says a payout part is missing ("Not set up
  (YouTube says)"); a missing tick gives the calmer "Not set up yet", because a creator who is already paid but hasn't
  ticked must not be told money can't reach him. A payout reading counts only when it is fresh (connected, first read
  done, checked within 48 hours), so a stopped or failing reading never keeps saying "YouTube says". The place page's
  only vermilion is the one next step, and a step that costs money (X Premium) is never it. A Get paid branch in Settings › Posting with one card and one step page per place, in the setup
  cards' look, and a status-only card on Money; Content Rewards reuses §38.7's steps and ticks; Get paid never joins
  the setup ring or the to-do list; ticks live on a new `GETPAID` item. Two new, separate, optional read-only
  connections: "Allow payment reading" for AdSense (its own token, because the AdSense Google account can be another
  one; never merged into the YouTube connection) and "Connect Whop" through the owner's own Whop app (a public PKCE
  client; rotating refresh tokens under a lease as Content Rewards' are; behind `whop_connect_enabled`, default off).
  Both are read by `cf-prod-money`'s daily run and Check now; tokens in Secrets Manager under `cf-prod/platforms/*`,
  made at runtime; no IAM, table or Lambda change. "Stop payment reading" deletes Clip Factory's AdSense token and
  never calls Google's revoke, because Google's revoke ends every scope the user gave the app and would also end the
  YouTube connection when it is the same Google account. The bank part is defined but not built: a source-agnostic deposit
  shape, matching by payout records, learned payer names and his taps (never a typed number), least data, and the
  consent states, waiting for the owner to choose Enable Banking or a bank file (or nothing). Facts fixed in
  `config/monetization.json`: X's programme is Original Content Rewards in Creator Studio, Creator Rewards is not open
  in Sweden, YouTube's 2027 rules cite answer 12843009; and X's `subscription_type` "None" now means "X didn't share
  this", not "no Premium" (X's field doesn't know its newer plans).
- **Consequences.** YouTube can show "Can get paid ✓ (YouTube says)" only after Google's first payment, and a hold the
  day AdSense reports it; before that, and on every other platform, the status rests on his "I did this" and says so.
  "Sent to your bank" can differ from what his bank books (fees, conversion, returns, days in transit), and Whop's
  total covers all his Whop money, not only Content Rewards; the words say both. X's card warns that clips Clip
  Factory posts probably won't earn there. Whop's part depends on Whop letting a personal user make an app and read
  payouts (not live-tested); until the switch is on, Content Rewards' "sent" stays "not available". "Reached your
  bank" stays unknown until the owner picks a bank source. Additive only: new sort keys `GETPAID`, `PAYCONN#`,
  `PAYSTATE#`, `PAYOUT#`, new attributes, two stream filters updated in place, one api env var; nothing that holds his
  connections or saved data changes.
- **Amended by [ADR-82](#adr-82-your-bank-enable-banking-restricted-mode-read-once-a-day-keep-only-matched-app-money)
  (2026-11-22).** The owner chose the bank source: Enable Banking, restricted mode (option A). The bank part is no
  longer "defined but not built"; the placeholder's payer name, account `{bank, last4}` and plain-hash id are replaced
  by keyed hashes and minor units (CONTRACTS §40.5).

## ADR-65 Campaign finder: Content Rewards' public pages read politely, joining stays the owner's own tap

- **Context.** The owner asked (2026-11-21) whether he can find campaigns and join them by requirements he sets, once
  Content Rewards (CR) lets Clip Factory sign in. CR's official MCP server (23 tools, API version `2026-10-01`) lists
  the campaigns he joined, sends his posts and reads his money, but has **no tool to browse Discover and none to join or
  apply**; its REST API is for brands. Joining also accepts that campaign's terms, a choice only he can make. CR's
  robots.txt allows crawlers everywhere except `/api/…` and a few account pages, and names a `sitemap.xml` that lists
  every public campaign page with a `lastmod` (which is only the date the campaign was first listed: it never moves on
  edits or status changes); each campaign page is server-rendered and carries the same campaign object as the
  undocumented `/api/campaign/campaigns/{uuid}` JSON. The full Discover list comes only from
  `/api/campaign/campaigns/discover` in the browser. CR's Terms say nothing on reading public pages; Whop's Terms forbid
  automated access to Whop's own service, creators agree to Whop's terms through CR's (Creator Terms 3.2), and Whop's
  guidelines can hold back the payouts of accounts that use bots, scrapers or crawlers; ADR-62 already rules out browser
  automation and reading `/api/…` on a schedule.
- **Options.** (1) Drive CR's site with a robot to search and join: against Whop's no-bots terms, it breaks on the first
  pop-up, and it would accept a brand's terms for him. (2) Wait for an official search-and-join tool: nothing for him
  today. (3) Read the `/api/…` Discover listing on a schedule: one request gives 50 campaigns, but robots.txt asks
  crawlers not to, and ADR-62 says no. (4) Read only what robots.txt allows (the sitemap, then each campaign page), a
  few times a day, one page at a time, capped, cached and backed off, from a Lambda with no secret; match his
  requirements in pure code; he joins on CR with his own tap; Clip Factory adds the campaign in one tap, or by itself
  once its sign-in sees the join in `list_my_campaigns`. (5) Only a link to CR's filtered Discover page: no match on his
  places, money left or what Clip Factory can make, and nothing to tell him when a new one appears.
- **Decision.** (CONTRACTS §41) Option 4, with option 5 kept as "Look on Content Rewards yourself" and option 2 asked
  for: a signed-in owner can send CR one fixed feature request through MCP `send_feedback` with one tap. The finder
  reads `robots.txt` once a day and honours it on every request, `sitemap.xml` once a look and at most 40 campaign pages
  a look (at least 1 s apart, 100 s at most), every 6 hours plus a rate-limited "Look again now", never more than 6
  reading looks a day (counted when a look starts, so a crash can't cause extra looks), with a 429/503/403 backoff and a
  `blocked` state; it re-reads live campaigns every 2 days and the rest every 14 (the sitemap's `lastmod` can't say what
  changed); it never reads `/api/…`, Discover, group, invite or Whop pages, images or other creators' data. Every read
  is anonymous and can't be linked to his CR or Whop account: only from AWS, never his Mac, the desktop app or his
  browser, a shared cache, `User-Agent: ClipFactory/1`, no cookies, no account id; if CR or Whop asks Clip Factory to
  stop, the switch goes off the same day. It runs as a new action of `cf-prod-campaigns` (no secret, no CR API call),
  started by the existing `cf-prod-stats` tick: no new Lambda, schedule, secret or grant. One pure function decides each
  match from CR's public fields only (pay per 1,000 views with geo rates, places, money left, open or apply, category,
  language) and refuses only what the public page shows (drafts first, its own sound, including a description that says
  a sound must be used, its own overlay, slideshows, almost no money left); a brand that counts only some countries'
  viewers gets a watch-out line; whatever the page can't tell is said as "I can't tell…", never as a pass. Its defaults
  are chosen for him: at least $1.00 per 1,000 views, the places he set up, "Some left" of the money (at least 25% of
  it: a percent, so big campaigns with thousands of dollars left stay in), only campaigns anyone can join. Rates and
  money left are CR's own numbers, tagged so; nothing estimates what a clip would earn. At most one notification a day, and never right after he asked.
  Joining stays his tap on **Join Campaign**, and the page says so plainly ("You join each campaign yourself on Content
  Rewards."); "I joined: add it" uses §38's add with the link it already has, and while Clip Factory can't read an open
  campaign's rules the same step takes his pasted rules; once signed in, a listed campaign he opened from the finder in
  the last 48 hours is added by itself (never one he removed) and its "You're in!" comes as for any campaign. Every
  match keeps its "Open on Content Rewards" button; only the open one is vermilion. It ships behind `cr_finder_enabled`
  (default off) and is turned on by one line once every part has merged (done: its switch PR #136 turned it on on
  22 Nov 2026).
- **Consequences.** From the Find page to making clips: 2 taps of his own once signed in (open it, then "Make clips for
  this campaign" after the rules are read by themselves) plus CR's **Join Campaign**; 4 today, before CR's pilot yes
  (open it, paste the rules he copied on CR, "I joined: add it", "Make clips for this campaign") plus **Join Campaign**
  and the copy on CR; no search and no copied link. Open campaigns still hide their rules until he joins, so a match can
  later meet a §38.4 stop; Clip Factory reads the rules right after the join and the fit check (§39.3) guards every
  upload. The first full look takes 3 to 5 days (all 766 campaign pages at 40 a look, newest listings first); money left
  can be up to 12 hours old ("as of" shown). The finder depends on CR's page format and on CR keeping these pages open
  to crawlers: a format change shows "I can't read Content Rewards' campaign pages right now", a robots.txt change or a
  block stops it by itself, and "Look on Content Rewards yourself" always works. Additive only: the owner item `CRFIND`,
  the shared cache under pk `CRPUBLIC` (with TTL), one env var on three Lambdas and one stream-filter prefix; nothing
  that holds the owner's data is replaced or destroyed.

## ADR-66 TikTok for everyone: the owner posts it in TikTok himself, Clip Factory hands it over and counts it

**Context.** TikTok's API keeps an unaudited app's posts "Only me" on a private account, and its review and Direct Post
rules turn down personal tools ("Apps must not be for private or personal use"; "Not acceptable: A utility tool to help
upload contents to the account(s) you or your team manages"). The owner wants public TikTok posts now. The TikTok API
for Business would need a Business account, which Creator Rewards does not pay.

**Decision.** A manual hand-off (§42): the share menu on a phone, the file and TikTok's own upload page on a computer,
the caption copied on the same tap. The owner posts in TikTok, picking Everyone, then marks the clip posted, with the
post's link when he has it; the link's video id puts the post on the normal stats poller. Review, Use my settings and
TikTok's API row stay as they are, so the API path is ready if TikTok ever approves.

**Consequences.** No TikTok rule is touched: TikTok's posting API is not used for these posts, and the owner posts with
TikTok's own app. Everyone needs a public account, on which Clip Factory's own TikTok upload is refused until the audit,
so that row fails with a sentence that points to Post it yourself (no "make it private", no Try again) and offers the
button there. Numbers come from the post found on the connected account (`video/list`) or a pasted link, then
`video/query` as for any public post.

- **Amended by [ADR-86](#adr-86-no-manual-tiktok-sheet-the-mac-is-the-only-way-to-tiktok-until-tiktok-approves-the-app) (2026-11-22).** The hand-off sheet is gone from the web: his Mac
  posts TikTok (ADR-83). The routes (`…/tiktok/posted`, `…/file`) and every stored field stay; the only owner-facing
  part left is the inline Add link on a post he or his Mac made without its link.

## ADR-67 New built-in skill parts are offered to the owner's copy, never written into it

- **Context.** §37 added a Chat block to the built-in `viral-clip-editing`. An owner who had made his own copy of that
  skill does not get it, and his rule is that his own edited text never changes without his say.
- **Options.** (1) Do nothing: his copy never learns chat. (2) Rewrite his copy on deploy: changes his words. (3) A
  three-way merge of his copy with the new built-in: heavy, and still edits text he did not see. (4) Version each
  later part of a built-in, spot a copy that lacks one, offer it with a preview, add only that part on his tap, with
  an exact Undo, and meanwhile give every model call the built-in's part as a separate note.
- **Decision.** (CONTRACTS §44) Option 4. One pure module, the same file in the API and the agent, finds copies by
  shared lines and places the part before "Skip these"; the item remembers what was added (for Undo) and Not now.
- **Consequences.** Chat hype works before he taps Add. A heavily rewritten copy (under 30% of the built-in's lines)
  is not seen as a copy and gets no offer or note; the built-in itself is always in the block anyway (§18.1). Each
  future built-in part needs a `SECTIONS` entry. Additive item fields only; no infrastructure change.

## ADR-70 Workspaces: Lamo Clips is the built-in workspace, new workspaces live in partitions of their own

- **Context.** The owner asked (2026-11-21) for a second studio, Clips Funded, inside the same app and sign-in, with
  its own screens, content, jobs, settings and social accounts, and made protecting the existing app the highest
  priority: no renamed tables, attributes or resources, no change to how Lamo Clips looks or works. Every Lamo Clips
  item sits under `USER#{userId}`; the live-update and notification streams forward items by sort-key prefix; the
  stats poller follows `gsi2`; `posts.account_items` reads every `ACCOUNT#` under the user.
- **Options.** (1) Add a `workspaceId` attribute to every existing item and back-fill Lamo Clips' data (a migration of
  owner data, and every existing query would need a filter); (2) store Clips Funded items under `USER#{userId}` with new
  sort-key prefixes (no migration, but every existing whole-partition read and the `ACCOUNT#` readers would see them,
  and an unlucky prefix would reach the streams); (3) Lamo Clips is the built-in workspace `clips`, never written, its
  data where it is; each other workspace gets a registry item in `USER#{userId}#WSREG` and its own partition
  `USER#{userId}#WS#{workspaceId}`, with sort-key prefixes no stream forwards; (4) a second table (new infrastructure
  the owner asked not to add without need).
- **Decision.** (CONTRACTS §45.3) Option 3. Ownership is in the key (built from the JWT's `sub`), checked again on
  every item's `userId` and `workspaceId`. The workspace registry holds `workspaceType` (`clips` built in, `stories`),
  so a later brand is a new workspace or one new type. In the web, `/stories/…` is Clips Funded and every other path is
  today's shell; the choice persists on the device and in the URL. A web switch, `STORIES_ON`, kept it hidden until
  all of it had merged and the final check passed; it was turned on on 2026-11-22 (CONTRACTS §45.36).
- **Consequences.** No Lamo Clips item, query, stream, index or screen changes; nothing is migrated. Clips Funded
  screens poll instead of using the WebSocket (no stream filter change). A user's data now spans more than one
  partition, so a future "delete everything" must walk the registry too (none exists today).

## ADR-71 One animation engine in TypeScript, drawn by the browser and by the agent

- **Context.** Clips Funded needs 30–60 s vertical cartoons without voice-over, with recurring characters that must
  look and move the same in every video, previews in the app, and a pipeline that works today. No image or video
  generation model is set up in the account; Amazon Nova Canvas and Nova Reel are not offered in eu-north-1 (Ireland,
  N. Virginia and Tokyo only), Reel writes to a bucket in its own Region, and generated frames or clips do not keep a
  character the same from one shot to the next. ffmpeg, numpy and Deno are already in the agent image; Lambdas have
  no ffmpeg.
- **Options.** (1) AI video for every shot (not in-Region, inconsistent characters, realistic clips need AI labels);
  (2) AI images per scene plus pan and zoom (inconsistent, slideshow-like); (3) a 2D rig engine in Python only, with
  previews rendered by the agent (a cold start for every preview, and the browser could not animate the Characters
  page); (4) the engine in the browser only, exporting the video there (the app would have to stay open, and Safari and
  Chrome encode differently); (5) one dependency-free TypeScript engine that turns a story script into draw lists:
  the browser draws them on a canvas for instant previews, the agent runs the same file with Deno and rasterizes the
  lists with numpy into frames for ffmpeg.
- **Decision.** (CONTRACTS §45.10, §45.11.3) Option 5. Characters are rigs (a few looks choices), copied into each
  story's script, so consistency is by construction; the writer (Claude) only picks from the engine's catalog and names
  characters by cast id; effects, character noises and music are synthesized with numpy, so there are no audio files
  and no licences. AI images (Nova Canvas) can be added later behind the rigs (ADR-75).
- **Consequences.** Previews and videos use the same draw lists (shared code; the rasterizer is tested on fixed draw
  lists). The look is clean flat-shaded 2D, not painted or realistic; new actions, props or sets are code in one
  folder. The engine folder is copied into Clips Funded's own agent image (ADR-76), so that image's tag hash includes
  it, and an engine change rebuilds only that image; Clip Factory's agent image never changes because of Clips
  Funded. Rendering 45 s
  takes a few minutes on the agent.

## ADR-72 Separate social connections: own tokens, one callback, the owner's choice of developer app

- **Context.** The owner wants different accounts for Clips Funded on every platform and no accidental posting to
  Lamo Clips' destinations. He set up one developer app per platform (13 manual steps for YouTube) and asked never to
  have to redo it. Each app has one registered redirect URI, `…/oauth/{platform}/callback`. Lamo Clips' tokens are
  `cf-prod/platforms/{platform}/token`, one per platform, read by the clip flow, stats and money functions.
- **Options.** (1) A second developer app per platform for Clips Funded (hours of manual setup and platform reviews
  again); (2) the same apps and the same callback, with the stored OAuth state telling the callback which workspace it
  serves, tokens under a second Secrets Manager prefix; (3) nest Clips Funded tokens under `cf-prod/platforms/` (no IAM
  change, but every Lamo Clips function could read them).
- **Decision.** (CONTRACTS §45.13) Option 2 for the callback and the tokens; which developer app each platform uses is
  the owner's explicit choice, his own or Clip Factory's (ADR-79). A Clips Funded connect uses its own state format
  (`w1.` with the workspace id inside the signature) and its own state items (`OAUTH#ws.{nonce}`). Clip Factory's
  callback only forwards a `w1.` state to Clips Funded's own callback route on `cf-prod-stories-api` (Clip Factory's
  registered apps are not edited, so their redirect URI stays the hooks one); `v1.` states run today's code
  unchanged. Only Clips Funded's Lambda writes `cf-prod/workspaces/{workspaceId}/{platform}/token` and `SOCIAL#`. One account per platform per
  workspace. YouTube connects the one channel picked in Google's picker (`prompt=select_account consent`): a token
  posts to exactly one channel, so there is no channel list to choose from; Meta lists Pages. An identity equal to
  Lamo Clips' own is held as `same_as_clips` until the owner says "Use it for both". Disconnect never calls a
  platform's revoke endpoint (Google's and TikTok's revoke end the app's whole grant for that account, which can be
  Lamo Clips' too, as §40 found for AdSense).
- **Consequences.** With Clip Factory's app (YouTube, TikTok, X), quotas, credits and the owner's monthly X limit are
  shared (and counted together), and TikTok's Sandbox, private-account and review limits apply to both; a later key
  change asks Clips Funded to connect again. Meta always needs Clips Funded's own app, so Clip Factory's Meta grant is
  never touched.
  A Disconnect leaves the grant at the platform; the page says where to remove it by hand. `hooks.py` gains one
  forward, proven not to change the old path, and no IAM.
- **Amended by ADR-84 (2026-11-22).** "Use it for both" is gone: an account that is Clip Factory's own is never
  posted to, by any stable identity, at connect and before every upload, and the match is remembered (§45.37 G8).

## ADR-73 Publishing isolation: checked before every call, no default account, IAM as the last wall

- **Context.** "A video created in Clips Funded must only be published to Clips Funded-connected accounts", every
  publishing job must reference workspace, content, social account, platform and status, the relationships must be
  validated before every operation, and a missing or ambiguous destination must stop and ask. The platform publishers
  (§17.6) take their credentials and video in a `PublishJob` and touch no store.
- **Options.** (1) Teach the clip flow about workspaces (changes Lamo Clips' most delicate code); (2) a new durable
  function for Clips Funded that reuses the publishers unchanged, with one validation function run by the API at the
  tap and by the flow before each platform call, and its own IAM role.
- **Decision.** (CONTRACTS §45.14, §45.15) Option 2: `cf-prod-story-flow`. A publishing job records the account's
  identity at the tap; the flow re-checks the workspace, the story, the account (same partition, same platform,
  connected, same identity, not Lamo Clips' own unless shared on purpose) and builds the secret name from the checked
  ids only, and checks the identity inside the secret itself. Its role can read `cf-prod/workspaces/*` and the five
  `…/app` secrets and nothing else, and can write DynamoDB only under `USER#*#WS#*` and the shared `RATE#*` budgets;
  the Lamo Clips roles cannot read `cf-prod/workspaces/*`.
- **Consequences.** A code mistake in either flow cannot reach the other workspace's tokens or Lamo Clips' items
  (Terraform tests hold the policies). A reconnect to a different account stops queued jobs instead of sending them
  somewhere new. Clips Funded numbers are read by the flow at 1 h, 24 h, 72 h and 7 days, through the same rate
  budgets as Lamo Clips, not by the 15-minute stats poller; the flow runs up to 9 days.

## ADR-74 Safety videos only from checked guidance

- **Context.** The owner: "Safety-related educational content must be based on verified guidance. Do not generate
  potentially dangerous driving instructions without appropriate validation." Research on 2026-11-21 fetched road
  authorities' pages (UK Highway Code, National Highways, RoSPA, NY, California and Ontario driver handbooks, Transport
  Canada, Transport for NSW, Trafikverket) and found real disagreements (stay in the car or get out after a breakdown,
  neutral in a skid, braking with or without ABS).
- **Options.** (1) Trust the model; (2) a model check only; (3) a checked guidance list bundled with the app, the
  writer allowed only its uncontradicted steps, then a separate checker (the quality agent), and stories with problems
  held for the owner.
- **Decision.** (CONTRACTS §45.11.5) Option 3, and a safety topic with no guidance cannot be produced. (This ADR first
  also kept Clip Factory's skills block on Clips Funded's calls; the owner's second request settled that the other way:
  ADR-78.)
- **Consequences.** Only 12 driving situations can be taught at first; adding one means adding checked sources. Some
  advice differs by country, so contradicted steps are left out and the video points to local rules.

## ADR-75 Providers behind a registry: built-in today, AI images off until a real call works

- **Context.** The owner wants room for more image, video, animation and audio providers "without rebuilding", and no
  integration shown as working when it is not. Only Claude (writing) is set up today; Nova Canvas needs a call to
  eu-west-1; Nova Reel needs a bucket in us-east-1 and AI-realism labels the shared publishers do not set.
- **Options.** (1) Hard-wire the built-in engine; (2) a registry per kind (writer, images, animation, audio) with
  one interface each, the built-in providers on, Nova Canvas built and off, Nova Reel interface only.
- **Decision.** (CONTRACTS §45.11.6) Option 2. A provider is `on` only after a real call answered (its state is
  stored by the agent); the Providers list says in one sentence what each missing one needs. Nova Canvas makes
  character portraits shown in the app only, never part of a posted video, because the shared publishers mark posts
  as not AI-generated.
- **Consequences.** The videos are fully built-in. Switching on Nova Canvas adds AI portraits; AI backgrounds in videos
  and Nova Reel stay out until the posting labels are added (and, for Reel, a US bucket).

## ADR-76 Clips Funded is its own application: its own API Lambda, AgentCore runtime and IAM roles

- **Context.** The owner's second request (2026-11-21): "Lamo Stories must be treated as an independent application
  within the existing Clip Factory application shell … The only shared element should be the application shell",
  with its own AgentCore environment, agents, skills, models, chat, memory, settings, OAuth credentials and data, "two
  separate applications accessible through one desktop application", while shared AWS infrastructure is fine "where
  appropriate" with "strict authorization and data boundaries". The first plan ran Clips Funded's routes in
  `cf-prod-api` and its videos as new actions of Clip Factory's agent runtime.
- **Options.** (1) Keep the first plan (one API Lambda and one agent runtime, separated in code only); (2) separate
  route modules in `cf-prod-api` but Clips Funded's own runtime; (3) Clips Funded's own Lambda (`cf-prod-stories-api`,
  the same zip and HTTP API, its own routes and role) and its own AgentCore runtime (`cf_prod_story_agent`, its own
  image from `stories/agent/`, role and sessions), each role allowed only Clips Funded's keys, prefix and secrets;
  (4) a second AWS account or a second app (duplicated sign-in and infrastructure, which the first request ruled out).
- **Decision.** (CONTRACTS §45.24, §45.15) Option 3. Shared on purpose: the shell and Cognito sign-in, the HTTP API
  (separate routes), the table, bucket and Secrets Manager (separate namespaces, enforced by IAM leading keys and
  prefixes), Clip Factory's OAuth callback only as a forward of `w1.` states (its registered apps are not edited),
  and the platform publisher library code.
- **Consequences.** Clip Factory's API Lambda, its route table, its agent runtime, image and roles do not change at
  all, and a Clips Funded change never redeploys or drains them. Clips Funded has its own image to build and its own
  CI job. Code shared as a library (the publishers, `db`, `http.dispatch`) is used read-only; a change there is a
  Clip Factory change and is reviewed as one.

## ADR-77 Models and reasoning effort are the owner's, per workspace, agent, task and request, never substituted

- **Context.** The owner wants complete control over which model powers Clips Funded (examples "Sable 5.2, Sable 5.1,
  Opus 5.5": the account's Claude Fable 5.2 / 5.1 and Opus 5.5), with a default, per-agent and per-task choices, a
  per-request override from the chat, the active model visible, no silent substitution, and the reasoning effort set
  separately and really sent where the model supports it. Fable 5.x, Opus 5.5, Sonnet 5.5 and Haiku 5.5 take
  `output_config.effort` (low to max) with adaptive thinking; their default efforts differ (Opus 5.5 and Haiku 5.5
  `medium`); they reject a thinking budget.
- **Options.** (1) One model setting; (2) a model per agent only; (3) four levels (request, task, agent, workspace)
  over a model list kept apart from Clip Factory's, each model listing the efforts it accepts, an availability check by
  a real call, and the effective choice recorded on every job and message.
- **Decision.** (CONTRACTS §45.25) Option 3, with `stories/config/models.json` as the list (IAM grants built from it),
  no automatic fallback model (a refused or unavailable model stops the task with its reason and a way to pick
  another), and usage and cost recorded per call, cost only where a price is known or the owner typed one.
- **Consequences.** The owner can mix models per task; jobs are reproducible; a model the account cannot reach is
  visible as such. A refusal is shown rather than retried on another model, so an occasional task needs the owner's
  tap to continue.
- **Later (2026-11-22, CONTRACTS §45.34–§45.35).** The owner asked that new models and providers can be added without
  rebuilding the app. `stories/config/models.json` is now only the bundled starting list: the owner adds Bedrock-hosted
  models (any maker) as `MODELDEF#` items, each saying how it is called (effort field, tools, prompt cache), merged per
  call by the API and the agent. The runtime role's model grant became a wildcard over the account's Bedrock models
  and inference profiles, so an added model works after Check models with no deploy. A maker outside Bedrock still
  needs code (a new client), which the `host` field on every model makes visible.

## ADR-78 Clips Funded's own agents, skills, chat and memory live in its runtime; actions wait for the owner's tap

- **Context.** The second request asks for its own agents and agent configuration, skills (upload, versions,
  enable/disable, assign to agents), a creative chat with history and memory, and reference-video analysis; Clip
  Factory's standing rule that every AI call gets all its skills belongs to Clip Factory.
- **Options.** Memory: AgentCore Memory (a managed service resource) or items in the workspace partition the owner
  can see and edit. Chat: an agent that acts on its own, or one that proposes and the owner taps. Skills: shared with
  Clip Factory, or Clips Funded's own.
- **Decision.** (CONTRACTS §45.26–§45.28) Five built-in agents with editable instructions, models, efforts and
  skills; Clips Funded's own skills only (Clip Factory's are never read); memory as `MEM#` items; the creative
  director's tools read and draft, and anything that costs a render or changes a video is a button the owner taps;
  reference videos are uploaded files analyzed from frames and sound.
- **Consequences.** The owner sees and edits everything the agents remember; nothing is published or rendered
  without his tap; Clip Factory's skills rule is untouched. Reference links to other people's videos are not
  downloaded (upload the file). *Amended by ADR-88 (2026-11-23): a pasted link to one video on seven allowed sites
  is fetched by Clips Funded's own runtime, behind its egress guard, for study only.*

## ADR-79 Developer apps: the owner picks Clips Funded's own or Clip Factory's, per platform, never silently

- **Context.** The second request: Clips Funded's "own OAuth credentials", "Do not reuse Clip Factory OAuth tokens. Do
  not modify existing OAuth authorizations." The tokens are already separate (ADR-72). A separate developer app means
  new setup and, for TikTok and Meta, a new app review that takes days to weeks; Meta's page picker is per login and
  per app, so re-authorizing Clip Factory's Meta app for a second Page can change Clip Factory's grant.
- **Options.** (1) Always Clip Factory's apps; (2) always new apps; (3) the owner's explicit choice per platform,
  shown on the card, with the trade-offs in plain words, and a recommendation of a separate app for Meta.
- **Decision.** (CONTRACTS §45.30) Option 3 for YouTube, TikTok and X; **Facebook and Instagram always use Clips
  Funded's own Meta app** (re-authorizing Clip Factory's Meta app would change its existing grant). No default, no
  fallback; own keys in `cf-prod/workspaces/{ws}/{p}/app`; one helper picks the keys everywhere; quotas, credits and
  limits follow the app chosen.
- **Consequences.** Fully separate apps keep every Clip Factory authorization untouched and cost the owner the
  platforms' setup and reviews once; the quick choice shares quotas and review state and carries the Meta warning.
- **Amended by ADR-84 (2026-11-22).** The shared choice reads "Share Clip Factory's app" and is protected: Clips
  Funded counts in its own counter and uses only what Clip Factory's reserve leaves; a post with no room waits
  (§45.37 G6). It never means sharing an account (G8).

## ADR-80 Video generation is configured apart from the reasoning models; the built-in animator first

- **Context.** The second request separates reasoning models from image, video and audio generation and says an LLM
  cannot make a video by itself. Only Amazon Bedrock is set up; Nova Reel writes to a bucket in us-east-1 and makes
  realistic footage, which the platforms want labelled.
- **Options.** (1) The built-in 2D animator only; (2) add Nova Reel now, its US bucket always on; (3) a provider
  registry per kind, the built-in animator on, Nova Reel built behind a Terraform switch for its US bucket (off until
  the owner allows US storage), AI labels set by Clips Funded's own publisher wrappers, and a generic key store for
  providers added later.
- **Decision.** (CONTRACTS §45.31) Option 3.
- **Consequences.** Videos are made today with the built-in animator; AI footage arrives when the owner allows the US
  bucket and enables the model; no external provider is claimed as working until one is added and checked live.
- **Amended by ADR-84 (2026-11-22).** Amazon ended Nova Reel and Nova Canvas on 2026-09-30: they read ended, and
  Luma AI Ray2 (us-west-2, behind `stories_video_west_bucket`) and Stability AI are the AI makers (§45.37 G7).

## ADR-81 Auto-posting: an hourly EventBridge rule, a due check and Upload's own code

- **Context.** The owner asked for auto-posting (CONTRACTS §46): the oldest clips in Review go to every connected
  platform every X hours (1–24) and Y clips at a time (1–5), on EventBridge and serverless, with even gaps across
  midnight, changes live on save without a redeploy, and never a clip posted twice, even when a run is retried or two
  runs overlap. Until now nothing was published without his Upload (§0).
- **Options.** (1) EventBridge Scheduler with a `rate(X hours)` schedule the app updates on save; (2) an EventBridge rule
  whose `rate()` the app rewrites with `events:PutRule`; (3) one EventBridge rule every hour on the hour, with the
  Lambda running only when X hours have passed since the last run, and the posting itself done by Upload's code.
- **Decision.** Option 3. Option 1 needs `iam:PassRole`, which the cf-prod-* permissions boundary forbids (and the
  durable clip flow already replaced the old Scheduler group and role, §14.5). Neither 1 nor 2 can say when the next
  run is, and both drift against Terraform. With 3, the next run is simple arithmetic (`max(next full hour after onAt, lastRunAt +
  X)`), saves count from the next tick, and the gaps are exactly X hours. A run claims its slot and lists its clips in
  one transaction, so a retry or an overlap resumes the same plan. Each clip goes through the same conditional
  transaction and idempotent flow start as Upload, so it can be confirmed and started only once. TikTok never posts
  by itself (TikTok's rules want the creator's pick for each post). Campaign clips wait while Content Rewards can't
  take them from Clip Factory, and a clip with a failed important check waits. Retries stay Upload's (up to 3 on "did
  not answer", none where a retry could post twice). Run-now test actions run inline in cf-prod-api with Upload's
  existing grants, so cf-prod-api's infrastructure is unchanged.
- **Consequences.** One new Lambda, role, log group, rule and two alarms. 24 short invocations a day, almost all
  "not due". Auto-posting is off for every owner until he turns it on. Practice mode and a private test run let him test
  the whole flow with nothing public. Saving takes effect from the next full hour, not that same minute. Throw away
  holds a clip on the server the moment it is tapped (a 24 h `holdUntil` that runs skip and a run's write refuses;
  Undo lifts it), because the decline itself only goes when Undo's 8 s toast ends and a run could fall in that gap;
  a day, because a phone locked during the toast stops its timer, so that decline can come hours late.
- **Note (2026-11-22, ADR-83).** "TikTok never posts by itself" was the owner's own answer (§46.1 rule 2). On
  2026-11-22 he gave a new, explicit go ("Full auto, 3-post trial", relayed by the coordinator after he saw the risks):
  while Your Mac posts TikTok is on, a live run's normal clip also gets a TikTok post that his own Mac posts (CONTRACTS
  §47). TikTok is still never one of a run's places and never goes through TikTok's API; Practice, Private test runs
  and campaign clips never get one; and auto-posted Mac posts that wait are held while auto-posting is off.

## ADR-82 Your bank: Enable Banking restricted mode, read once a day, keep only matched app money

- **Context.** The owner asked (2026-11-21) for "a total of my exact number that I've gotten into my bank account or
  accounts, but in total for each of those platforms", Content Rewards, YouTube, TikTok, Instagram, Facebook and X
  included. ADR-64 showed what Google and Whop report as sent, but only his bank can say what arrived, and Meta,
  TikTok and X report nothing at all. He was offered four sources: A Enable Banking (restricted mode: free, BankID,
  his own accounts), B uploading his bank's CSV or xlsx file each month, C payout emails, D nothing new. He chose A on
  2026-11-22. He lives in Sweden. Research checked on 2026-11-22 (Enable Banking's docs, API spec, Control Panel text,
  Terms of Service of 2026-01-09 and end-user Privacy Notice of 2025-03-07) found:
  * restricted mode is free for production use on linked accounts "for the personal use of private individuals",
    with BankID and 180-day links at every major Swedish bank and PayPal;
  * the app signs with its own RSA key, and the Control Panel can take a public key made elsewhere, so the private
    key need never touch his browser;
  * the account answer carries his name, IBAN and address;
  * many banks allow 4 reads a day while he isn't there (PSD2 RTS Art. 36(5));
  * the Terms ban "any commercial purpose whatsoever", other people's accounts, business accounts, giving anyone else
    access, and abusive automated access; a breach "shall result in termination", with the user's liability uncapped;
  * no platform's payer name on a Swedish statement is documented, except Google's test deposits, Stripe's default
    "STRIPE" and Whop's "Whop";
  * Tink, Salt Edge, Plaid and Mastercard need a company contract, and GoCardless has closed sign-ups.
- **Options.** The source: A, B, C or D (his choice: A). The key: Enable Banking's default, a key made in his browser
  and saved as a .pem in Downloads, then uploaded; or a key made by Clip Factory's Lambda straight into Secrets
  Manager, with him pasting only the public part. What to keep: the transactions; every credit; or only the credits
  matched to an app. How to recognise a platform: store the payer's name and learn it; or keep only a keyed hash of
  it, plus Clip Factory's own platform word. Matching: let him type or pick amounts; or match by Google's and Whop's
  payment records, by payers he confirmed, and by asking him with one tap. Where reads run: a new Lambda; or
  `cf-prod-money`'s daily run, which already reads Google's and Whop's payouts. The terms risk: wait for Enable
  Banking's written answer before building; or build behind a switch that is off by default, offer him a ready email,
  read as little as possible, and make the switch the way back.
- **Decision.** (CONTRACTS §40.5)
  * **Enable Banking restricted mode, on his own Control Panel account and his own app, linking only his own personal
    accounts.** Every authorisation asks for `psu_type: "personal"`, business (`ORGA`) accounts are dropped before
    they are read, and a `BANKOWNER` claim keeps it to Clip Factory's one owner. The steps tell him never to press
    "Request activation", "Request unrestriction" or "Share".
  * **The key is made by Clip Factory** (RSA-4096 and a 10-year self-signed certificate in `cf-prod-api`), and the
    private key goes straight into `cf-prod/platforms/bank/app`. He copies only the public part into "Generate outside
    the browser and import public certificate". **One exception, kept for his OK:** the task asked for an upload or
    paste box like the TikTok file box, so if he already followed Enable Banking's default, that box takes the .pem
    once, over HTTPS, straight into the same secret. It is the one place the private key passes through his browser
    (and his Downloads folder), against the rule that it never does. So the screen first says "Better: make a new app
    with Generate outside the browser…", the paste box has no autocomplete or spellcheck and is emptied after the
    send, nothing is logged, and a line stays until he taps "I deleted it" to remove the file from Downloads. Removing
    the box is a one-file change in BW if he says no.
  * **Each bank link's session** is its own runtime secret, `cf-prod/platforms/bank/token_{linkId}` (an underscore,
    so the `*/token-*` write grant that money, clip-flow and stats hold for rotated platform tokens never matches it).
    Both names fit today's Allow statements. Two in-place Deny statements keep `cf-prod-clip-flow` and `cf-prod-stats`,
    which can read `cf-prod/platforms/*`, from reading `…/bank/*`. Every bank secret is read with the cache off, so a
    reconnect or a new key is seen at once, and a read acts only on the session whose `connectedAt` matches its link.
  * **Least data.** Only booked credits are looked at, in memory, and only `CRDT` + `BOOK` rows with a platform word
    in the payer's text or a match to a payout record go on. Stored are only matched rows (day, amount in minor units,
    currency, place, how it was matched, a keyed-HMAC id built from the bank's entry reference, day, amount and
    currency, never from the account) and the rows waiting for his answer, which expire 180 days after the later of
    their booking and the read. A "not app money" answer leaves only its id and day, for 400 days. Never stored: a
    name (not even the payer's: a keyed hash of the payer's name and Clip Factory's own word instead), an account
    number or its last 4, an IBAN, a balance, a debit, another transaction, the bank's text, his IP address or user
    agent (passed to Enable Banking for an attended read only). Logs carry counts, and bank errors are typed so no
    answer body reaches a log.
  * **Matching** is one pure function, in this order: the exact amount and currency of a Google or Whop payout within
    10 workdays (a candidate whose platform word fits wins a tie); Whop's trace code (10 or more characters, as whole
    words); Google's tiny test deposit, dropped by per-currency ceilings that are Clip Factory's own numbers, never
    conversions; his "not app money" payers; a payer he confirmed; otherwise a question card. The payout records come
    first, so a "not app money" answer can never hide a real payout. Only a platform word in the bank's payer name is
    ever learned: anyone can write "YOUTUBE" in a transfer's message, so a word found only there is asked about every
    time. PayPal, Stripe and Payoneer carry money from several places, so they are asked about every time, and money
    moved from his own linked PayPal is asked about as a move so it isn't counted twice. Meta pays Instagram and
    Facebook in one payment, so it may be counted as "Instagram and Facebook together". He only ever taps; nothing is
    typed, converted or estimated.
  * **Reading** happens in `cf-prod-money`'s 06:00 UTC run after the payout reads, and on his own bank Check now (an
    async invoke carrying his IP and user agent for that read only, dropped if the event waited more than 120 s);
    Money's own Check now never reads the bank. His first read uses `strategy=longest` within the hour after BankID;
    a first read without him uses 89 days. At most 3 reads in any rolling 24 hours happen without him, a bank's "too
    many" pauses reads for 6 hours, and a lease keeps two reads (or a read and Forget) from meeting.
  * **The way back from BankID** is a public page, `/bank-done`, that needs no sign-in and holds no data, so the Mac
    app's system browser or another browser never lands on a sign-in page; the callback also writes the result on
    `BANKCONN`, so the waiting bank page always learns it.
  * **"Reached your bank"** is shown per place and per currency, plus a total per currency, tagged "Your bank says",
    on the Get paid Your bank card, the bank page, each place page and Money. It is never added to "Sent to your bank"
    or the 30-day total.
  * **The terms risk** is handled by building behind `bank_reading_enabled` (default `false`, switched on by one PR
    after the four builders merge: done, the switch PR #172 turned it on on 22 Nov 2026, on both `cf-prod-api` and
    `cf-prod-money`), an optional first step with a ready email for him to send, and the switch as the way back. B's file upload stays possible later through the deposit's `source`.
- **Consequences.** Setup takes about 64 taps in one sitting of about 25 minutes (18 of them Clip Factory's; 68 and
  20 with the optional email), counting every switch between Clip Factory and Enable Banking, with BankID twice,
  because Enable Banking's Control Panel link doesn't authorise the app; after that, BankID every 90 to 180 days, as
  his bank sets (a notice 7 days before), and one tap per new payer. A payout whose bank text names no platform is never seen, and the place says
  "Nothing … reached your bank yet" rather than a number; the first deposits teach the hint list, and a missing word
  is a one-line PR. Totals start at the oldest day his bank shows (often 90 days, more within the first hour). If
  Enable Banking says creator income isn't personal use, or deactivates the app, setting the switch to `false` takes
  every screen back to "Clip Factory can't see your bank", and his stored records stay until he taps Forget my bank.
  Additive only: new sort keys `BANKCONN`, `BANKLINK#`, `DEPOSIT#`, `BANKPAYERS`, the `BANKOWNER` registry item, two
  runtime secrets, two stream filters, two Deny statements and one api env var changed in place; no new Lambda,
  table, index, role or Allow statement, and nothing that holds his data or connections is replaced.

## ADR-83 Your Mac posts it on TikTok: a post that waits for the owner's Mac, claimed once, finished by I posted it's write

- **Context.** TikTok keeps an unaudited app's posts "Only me" on a private account, his account is public on purpose,
  and approval is unlikely for a one-person tool (ADR-66, CONTRACTS §42), so every TikTok post has been his own Post
  it yourself. On 2026-11-22 he asked for "an automation for my mac" that saves the video, uploads it in TikTok and
  deletes the file, every time Clip Factory uploads to all platforms and on demand from "Upload to 4". Shown the risks
  first (TikTok's Terms and Community Guidelines on automation, reports of 0 views for script-posted web uploads,
  CAPTCHAs and login expiry; plan note `tiktok-mac-automation-plan.md`), he chose "Full auto, 3-post trial", and for
  clips already waiting "Send them too". The auto-posting session's nine constraints had to hold (rule 2 changes only
  on his go; the post is written with the other posts; never `queued`; done through the same conditional write as I
  posted it; never Practice, Private tests or campaign clips; the off switch; `tiktokYourself`; the kept test).
- **Options.** (1) The Mac polls clips and posts and records with I posted it: no claim, so two Macs or a crash could
  post twice, and the app can't show progress. (2) Reuse `queued` and teach the clip flow to skip TikTok: every API
  path (the flow, the release, Try again, Post now) would need a new exception, and one missed would send the post to
  TikTok's API. (3) A new post status `mac`, outside every API path by construction, with a server queue, a conditional
  claim, steps, a stop and a done, as §35's "Mac fetches it" works for sources.
- **Decision.** Option 3. Upload (with TikTok chosen, the switch on and TikTok not approved) and live auto-posting
  runs write the TikTok post as a Mac post in the clip's own Upload transaction (`create_for_clip`'s explicit
  `tiktok_mac` path); Send these to my Mac makes one, or hands a failed, waiting or private Clip Factory post over in
  place (kept in `beforeMac` for Take it back). The helper claims a post with one conditional write; once it says
  "pressing" (`macPressedAt`) the post is never claimed again by itself, and only the owner's "It's not on TikTok, try
  again" clears it. Its done runs `tiktok_self.mark_posted`, so the Mac and I posted it share one write and one post
  per clip (`tiktokByYou`, and the new `tiktokForMac` for sends). Undo never takes back what the Mac posted (it is on
  TikTok), and Take it back is refused once the Mac pressed Post (the restored post could go out through TikTok's API
  as a second copy); it deletes or restores the post and updates the clip in one transaction. Every Mac post asks
  for My settings' choices (Everyone, Comment, Duet and Stitch on), whatever Upload's TikTok sheet said (before the
  audit it offers only Only me), and done writes the privacy that was asked for. The job carries the claim's
  `attempt`, which the helper may send back, so an older attempt of the same Mac is never taken for the new one.
  While the switch is off, waiting and stopped Mac posts are offered again as Post it yourself instead. Campaign clips keep their own path (Branded content, the first 30 minutes). Everything is under `ANY
  /v1/{proxy+}`, additive, and with the switch off nothing changes.
- **Consequences.** No Terraform, table, index, secret or bucket change. The owner sees each step live (post events
  already stream). The risks stay his choice: TikTok may remove posts, cut reach or ban the account; the 3-post trial
  compares 24-hour views with his phone posts before night runs post by themselves for long. The switch stops it at
  once: no claim, and no step before Post, while it is off. The helper (Chrome profile, LaunchAgent, notifications) is
  its own PR.
- **Amended by [ADR-86](#adr-86-no-manual-tiktok-sheet-the-mac-is-the-only-way-to-tiktok-until-tiktok-approves-the-app) (2026-11-22).** Post it yourself instead, I posted it and "It's not
  on TikTok, try again" are gone from the web: a stopped row has only Try again, which sends `now: true` (and
  `notOnTikTok` once Post was pressed, after the row told him to look on his TikTok first). Take it back stays in the
  API, unused by the web.

## ADR-84 Stories makers are lists of checked models; no account is shared

- **Context.** The owner asked to pick picture, video and sound models independently and to add models and providers
  without a rebuild, gave suggested efforts for small text edits (Low) and animation planning (High), kept the shared
  developer app on condition that Clip Factory is protected ("Keep it, protect CF"), and then made a hard rule that
  Clips Funded never posts to Clip Factory's accounts. Research on AWS's own model cards found Nova Canvas and Nova
  Reel ended on 2026-09-30, Stability AI's pictures and Luma AI Ray2 only in us-west-2, and no Bedrock sound or music
  model.
- **Options.** (1) One model per maker in the release file, as before; (2) lists of checked models per maker in
  `stories/config/models.json` plus the owner's own `MAKERDEF#` models, each called on Bedrock or a keyed host with
  the owner's key; (3) the same, plus a generic "any URL, any key" bridge for every kind. For sound: (a) Bedrock (none
  exists), (b) ElevenLabs on the owner's key for effects and instrumental music, with Amazon Polly as an opt-in spoken
  voice, (c) a text-to-speech narrator by default. For the shared app: (i) drop it, (ii) keep it with counters shared
  with Clip Factory, (iii) keep it with Clips Funded's own counters inside what Clip Factory's reserve leaves.
- **Decision.** (CONTRACTS §45.37) Option 2 with (b) and (iii). Ended models read ended with a one-tap replacement and
  are never called; Stability AI and Luma AI Ray2 are makers that are never the default (Luma behind the off-by-default
  `stories_video_west_bucket`); an added model is saved only when the agent can call it, and the access check costs
  nothing. Keys live in the existing provider-keys store; an OpenAI-compatible key is bound to one origin and the agent
  never sends it elsewhere. `text_edit` and `animation_plan` are tasks with Low and High. One shared-app counter for
  all of Clips Funded reserves Clip Factory's schedule plus headroom; a post with no room waits and goes out by itself.
  "Use it for both" is removed: an account that matches Clip Factory's by any stable identity is refused at connect
  and before every upload, and the match is remembered.
- **Consequences.** Every maker starts on the built-ins, with no voice; a real sound maker needs only the owner's
  ElevenLabs key and his pick; Luma AI Ray2 needs the Oregon bucket switched on and model access, then Try it. IAM
  changes are additive and in place (the agent's model checks, Polly, the Oregon bucket's grants; the story flow's
  Denys on provider keys and on Clip Factory's rate counters; one more attribute in each `ACCOUNT#` read). Clip
  Factory's own posting path and items are unchanged. If Clip Factory posts far more on X than its schedule, the
  month can pass the X limit by what Clips Funded spent; the card says so.

## ADR-85 The second app is called Clips Funded on screen; every internal name stays

- **Context.** The second app was built as Lamo Stories and renamed Clip Factory Stories on 2026-11-22. The same day
  the owner chose another name: "actually i like the name clip factory for the streamers clipping, and id actually
  like to use the name clip stories for the other application that we wanted to name clip factory stories". On
  2026-11-23 they chose the final one: "i'd like to change the name of the new app finally to funded clips".
- **Options.** (1) Rename what people see only; (2) also rename the internal names (workspace type, keys, routes,
  resources), which would move or orphan the owner's stored data and replace live AWS resources.
- **Decision.** (CONTRACTS §45) Option 1. Every visible name (screens, page titles, labels, API and agent sentences,
  prompts, skills, config labels, help and docs) reads "Clips Funded"; the streamer-clipping app stays "Clip Factory".
  A workspace stored with an old default name ("Lamo Stories", "Clip Factory Stories", "Clip Stories" or "Funded
  Clips") shows as "Clips Funded" (API `shown_workspace_name`, web `shownWorkspaceName` as a fallback); the stored
  record is never rewritten, and a new workspace gets "Clips Funded". Internal names stay as before: the workspace
  type and id `stories`, the `/stories` and `/v1/workspaces` routes, storage and setting keys (`cf.storiesPreview`,
  `cf.stories.*`), DynamoDB keys, S3 and Secrets Manager paths, CSS classes, test ids, Terraform
  (`module.stories_agent`, `cf-prod-*`) and the package `lamostories_agent`. One code move: the logo is the shell's
  (`web/src/components/WorkspaceMark.tsx`, `web/src/styles/ws-mark.css`, `.ws-mark*`, CONTRACTS §45.38), so it stays
  out of Clips Funded's own code.
- **Consequences.** No data or resource change; the deploy replaces nothing. Terraform changes one text in place: the
  email text (`alarm_description`) of Clips Funded's agent alarm, `cf-prod-stories-agent-errors`. The deploy's Clip
  Factory check counts a commit that names "Clips Funded", "Funded Clips", "Clip Stories", "Clip Factory Stories" or
  "Lamo Stories" (whole words, any case) as Clips Funded work. An agent whose stored text is a former default still
  counts as not edited (`formerInstructions` keeps every earlier default text: Lamo Stories, Clip Factory Stories,
  Clip Stories and Funded Clips). Old code comments may still say Lamo Stories; they are not shown to anyone.
- **Amended (2026-11-23).** The same day the owner renamed it "Clips Funded" to match its YouTube channel: "my youtube
  channel is already called clips funded so i need to rewrite the app name to Clips Funded". Every visible name reads
  "Clips Funded" (the switch "Clip Factory | Clips Funded", the wordmark Clips *Funded*); "Funded Clips" joins the old
  defaults above. Nothing stored and no internal name changes; Terraform changes texts in place only (the agent
  alarm's email text and the agent runtime's description).

## ADR-86 No manual TikTok sheet: the Mac is the only way to TikTok until TikTok approves the app

- **Context.** Since ADR-83 his Mac posts each TikTok clip for everyone, out of sight, at auto-posting runs and on
  Upload taps. The §42 sheet (ADR-66) was still offered everywhere: Post it yourself on Library, the clip page and
  Review, Post it yourself instead and I posted it on Mac posts, Auto-posting's Post these on TikTok yourself, and the
  sheet that opened by itself after Upload. Shown it (Save the video, Open TikTok, Send to my iPhone (AirDrop), the
  caption, the TikTok link, Not now, I posted it), the owner said on 2026-11-22: "i dont think these options are
  necessary becasue they are not gonna be used, the automation will cover it, so might wannna remove this popup".
  A one-tap post from a row also had to go at once: a `send` made `source: "sent"`, which the helper treats as backlog
  (one after each auto-posting run, never while it is off).
- **Options.** (1) Hide the sheet behind a setting: two ways to TikTok, and a button he said he won't use. (2) Remove
  it and every button that opens it, and let each TikTok row say what the Mac is doing with at most one button
  (Try again, Post with my Mac, Turn on, or the inline Add link); new routes for "at once". (3) The same as 2, with
  an optional, additive `now: true` on the two existing routes (`send`, `retry`) that makes the post
  `macSource: "upload"`, the source an Upload tap already gives and the helper already posts first and at once.
- **Decision.** (CONTRACTS §42.1, §46.2 item 7, §47.2 to §47.4) Option 3. The web loses `PostYourself.tsx`, every
  Post it yourself, Post it yourself instead and I posted it, the auto-open after Upload and Auto-posting's TikTok
  list; Where they go says "TikTok: turn on Your Mac posts TikTok to post there." with Turn on while the switch is
  off. `tiktokRow` gives one row per TikTok post: posted by the Mac or by him (with the inline Add link when it has
  no link), Posting…, the Mac can't post (off, never set up, not seen for 30 minutes: Turn on), waiting with its next
  time, Didn't work with Try again, Not on TikTok yet with Post with my Mac, a campaign clip, a Private test. Row taps
  send `now: true`; Settings' bulk Send these to my Mac does not, so it stays the backlog he chose ("Send them too").
  Every API route stays: `POST`/`DELETE …/tiktok/posted`, `GET …/file`, `DELETE …/tiktok/mac` and the
  `tiktokYourself` field of `GET /v1/autopost` are kept, the last three unused by the web. `TIKTOK_PRIVATE_ONLY` and
  the stored pressed reason stay word for word, because stored errors are matched against them; the web shows its own
  words for them. Once TikTok approves the app, a clip without a Mac post keeps the old API rows.
- **Consequences.** No route, table, index, stored field, Terraform or helper change; old apps keep working. A
  campaign clip can't go to the Mac (Branded content, its first 30 minutes): its row says "Campaign clip: post it in
  the TikTok app" with only the inline Add link, so posting it is in TikTok's own app. After the Mac pressed Post and
  could not confirm it, Try again sends `notOnTikTok`: if the clip did go up, that makes a second copy, so the row's
  words tell him to look on his TikTok first. A backlog clip's next time is an estimate (the web can't see when the
  helper last took one). The two server sentences that could reach a row now name what is there: the short-link
  error says "Clear the box and tap Save the link", and the campaign refusal says "Post it in the TikTok app, then
  add the link." The stored pressed reason keeps its old words (posts already hold it), and the web never shows it:
  it picks its own words by `pressedAt`.
- **Amended 2026-11-23.** The owner: "its always the automation that covers it weather its invoked by be clicking
  upload or if its the schedule". He never posts by hand, so a campaign clip goes to the Mac like any other (Upload,
  an auto-posting run, Post with my Mac, Send these to my Mac), on his own TikTok and always for Everyone
  (`tiktok_mac.options_for`, the campaign's rule; Upload's own campaign checks are unchanged). The refusal "Campaign
  clips go on TikTok by hand…" and the row "Campaign clip: post it in the TikTok app" are gone. A post still `working`
  15 minutes after its claim, with a Mac that checks in and is fine, reads "Not sure it posted" like a pressed one;
  the server takes It's on TikTok and Try again on it (`tiktok_self.mac_stuck`, in one write conditional on that same
  claim). It's on TikTok on a stopped (or stuck) Mac post also turns the helper's `needs_you` back to `ok`, as Try
  again does. Paused has no Start again (nothing asks the helper to go on), so the row says what comes next.
- **Amended 2026-11-23 (round 3).** It replaces the amendment above in its campaign and 15-minute parts (D1 to D6, after
  a skeptical review of that amendment; CONTRACTS §42.2, §46, §47.1 to §47.6, §38):
  - **D1, campaign clips skip TikTok for now.** *Replaced by [ADR-96](#adr-96-campaign-and-paid-clips-post-tiktok-through-the-mac-with-tiktoks-label)
    (2026-11-24): the helper sets TikTok's label and the Mac's done reaches Content Rewards, so campaign clips go
    through the Mac.* No path (Upload with TikTok ticked, an auto-posting run, Post with my
    Mac, Send these to my Mac) makes a campaign Mac post again. Reasons: the helper can't set TikTok's Branded content
    disclosure yet (a paid promotion without it breaks TikTok's rules and risks the account), and the Mac's done never
    sends the post to Content Rewards (only the clip flow's publish loop makes a submission), so it could not earn.
    Upload and Try again refuse TikTok on a campaign clip until TikTok approved the app (`app_review` **and**
    `posting_audit` ok), and `send` refuses it with the same one sentence, `tiktok_mac.CAMPAIGN_SKIPS`: "Campaign
    clips skip TikTok for now: your Mac can't mark them as Branded content yet." Review leaves TikTok unticked for a
    campaign clip and its row says those words, with no dead end. Once TikTok approves the app a campaign clip's
    TikTok goes through TikTok's API as before. The stale "TikTok posts are private" campaign words are gone. Every
    other campaign check stays.
  - **D2, never twice.** A job is stuck only when its own beat (`macBeatAt`, which the helper now re-sends every
    minute while it works on the job) is 5 minutes old (`MAC_BEAT_STALE`), or its claim 50 minutes old
    (`MAC_CLAIM_MAX`: 12 minutes of upload wait, the post wait and the 30-minute find window), whichever comes
    first; server and web use the same rule from one constant each, pinned equal by a test. The 15-minute rule
    offered Try again while a healthy Mac was still uploading or looking for the link, and its re-wait could make a
    second copy. After Post was pressed, Try again ("Yes, post it again", with its confirm) is taken only once the
    30-minute find window is over (`MAC_STILL_LOOKING` before), moves the press to `macPressedBefore` and sets
    `macAgainAt`; the claim refuses any post that still has `macPressedAt`, and the helper never posts a job with
    `pressedBefore` unless `againAt` came after that window.
  - **D3, Find it for me never commits.** Nothing found → 409 "Not found yet. Try again in a minute, or paste the
    link." and nothing saved (TikTok not connected → "Clip Factory can't look on your TikTok until TikTok is
    connected. Paste the link instead."). Saving without a link needs the explicit "It's on TikTok, no link" confirm
    (`noLink: true`), which the server refuses while the Mac has not pressed Post and still beats the job: a clip
    marked posted while it was still uploading never reached TikTok and could not be sent again.
  - **D4, honest times.** Rows count the Mac's queue the way its plan picks (one per tick, Upload first, then auto,
    then the backlog: "next", "in line (N before it)"); the first backlog clip's time is the helper's own
    `backlogAt` (its ping), and a backfill says "in line" with no time. The web never guesses from `GET /v1/autopost`.
  - **D5, no dead ends.** Paused gets **Start my Mac again**, a hold gets **Let them go** (`POST /v1/tiktok/mac/request`,
    flags the helper reads on its next tick and acknowledges in its ping), needs you links straight to the stopped
    clip (`needsYouClipId`), and a working post whose Mac stopped checking in offers It's on TikTok and Try again.
  - **D6, the words.** No helper reason, server reason or `tiktok_self.py` sentence says "post it yourself" or "I
    posted it" (buttons he no longer has); the reason codes stay, only the words changed (`PRESSED`, `NOT_UPLOADED`,
    `TIKTOK_PRIVATE_ONLY`). Stored rows keep their old words; the web matches both.

## ADR-87 The logic of light: the top layer is brighter, every lift is paid for, Reload is a colourless lens

Amends ADR-45.

- **Context.** The owner (2026-11-23, with a screenshot of Library): "can you use the logic of light on the ui,
  meaning the top layer is always brighter than the bottom, and it grows gradually in between ... and make it more
  liquid glassy while you are at it"; then: "can you make sure the reload button when a new feature is released is
  without color and only a liquid glassy style". Under ADR-45 every fill under words was deep green, so a row was
  darker than its card and a mark darker than its row (darker the deeper it nested), almost every hover went darker,
  the most important panel (the hero, `.glass--green`) was the dimmest, and the 140° to 160° tints made each pane's
  top-left denser, so darker over a light backdrop. Bone words cap whatever they sit on at luminance 0.140 (4.5:1):
  a bone sheen with no more green under it is 4.48:1 over the worst panel, the reason ADR-45 had none. The update
  bar's Reload was a second vermilion CTA.
- **Decision.** (CONTRACTS §22.7, §20.17, §11, §12.2)
  1. *Two lights.* Every level is brighter than the level under it, nested levels included; inside every pane the
     top is brighter than the bottom, a bone light from above that eases out and is gone by 65 % of the height.
  2. *Every bone lift is paid for* with a step more green under it (`--light-pay`), and the pay leaves room for the
     ladder (below): `lightPay` works out for each look the least green at which it holds over everything the look
     can show, and lib/look.ts sets it on `<html>`: 0.39 over the app's own backdrop (`LIGHT_PAY_OWN`), 0.16 in the
     window's Clear and in Picture (`LIGHT_PAY_WHITE`), 0 in Frosted, 0 to 0.42 in Colours, 0.04 under reduced
     transparency. The see-through veils, `GLASS_TINT` and the measured floors are unchanged.
  3. *A raised thing is one relative step brighter than its parent at any depth*: green 0.22 and bone 0.09 inside a
     lit surface (its fixed point is under the AA ceiling, so AA holds however deep things nest); straight on the
     page the pick-one track's recipe (panel + 0.22, bone 0.08).
  3a. *The ladder, with no tolerance* (review, 2026-11-23). From a pane up, every nested level reads at least +0.015
     OKLab L brighter than its parent (`LADDER_STEP`) in every look: a row on a pane, a mark, chip or button on the
     row, the lead panel over a plain one, an option over its own track; no level above them ever steps back. Page
     to pane is the one exception, said plainly in CONTRACTS §22.7: bone words need the pane darker than a white
     desktop or photo, a bright spot of the mesh or a light colour, so page to pane may go darker there. Ghost
     buttons are at least +0.03 over what they sit on; Reload's face at least +0.03 over Later's.
  4. *Context through inheritance.* `tokens.css` declares the page values of `--light-raise-*` and the fills built
     from them; every lit surface declares them again (a custom property resolves `var()` where it is declared). One
     name, `--fill`, is right on the page and inside a pane; no per-screen recipes.
  5. *The light is soft, never a line.* A blurred top glow (negative spread, top edge only), a static catch light at
     the top centre 8 px deep (inside the smallest top padding above words; 14 px was first drawn, but the line
     plates and compact rows start their words 8 to 12 px down), a soft shade at the foot and a drop that grows with
     the level. No
     `inset 0 1px 0` hairline, no `::before` rim: the no-edges rule stays.
  6. *One key light above*: every tint and light runs at 180° or is flat.
  7. *Liquid refraction on at most three surfaces a screen*: the existing hero surfaces only (the review took the
     page title plate's bend and its own blur away, and Money's band blurs without bending, so Money stays at
     three; `e2e/refract.spec.ts` counts them at 1440 and 390); nothing new on cards, buttons, toasts, the stat tile
     or the update bar. Nested glass and controls inside a
     blurred surface draw no blur of their own.
  8. *Hover adds light, press takes it away*; no hover is darker than its rest. Only `background-color`,
     `box-shadow`, `transform`, `opacity` or registered numbers transition; never `backdrop-filter`.
  9. *The Reload button is a colourless lens* (`.btn--lens`): clear glass with no tint at all (a near-transparent
     white face, a catch light on its top edge, a clear rim, a soft inner glow, the drop of a raised thing), bone
     words, no vermilion, no shine sweep, no glow and no backdrop-filter of its own (inside the blurred bar a second
     blur laid the bar's tint again and made it darker than Later over a white thumbnail); it reads as the primary
     choice beside Later (a ghost, still a pill with a soft rim of light) by light alone. The desktop
     app's Update stays vermilion: the owner did not ask, and it is a download.
  10. *Tinted chips* lay bottle green 0.35 under their colour (`CHIP_UNDER`, was deep green) and a little bone
      between the two (`CHIP_TINTS`: leaf 0.04, vermilion 0.13, amber 0.02), so a chip is a step of light over its
      row in every look. The danger button lays its vermilion over the raise's own fill for the same reason.
  11. *The lead panel is the brightest pane*, not the dimmest: the panel's green under a 0.075 light, a whole step
      over a plain panel.
- **Alternatives.** *A 1 px white rim* (the refractive-glass recipe's lit edge): a drawn edge, which the owner banned
  in ADR-45. *Raising the base veils to 0.82 or more* so the light needs no pay: the owner said 86 % solid did not
  feel see-through. *Lifts without pay*: under AA. *Displacement on every card*: the Windows WebView2 hover lag of
  PR #159. *A pay of 0.06*: a panel exactly at 4.50, no margin. *A raise of 0.12 / 0.06*: E3 at 4.44 in Colours. *A
  lens of 0.42 / 0.14*: darker than Later over white. *A floating hover with + 0.10 green*: darker over white.
- **Consequences.** The see-through cost of the ladder: about 28 % of the app's own backdrop shows through a panel
  (67 % before ADR-87) and 11 % of a white desktop or photo (27 %); between panels nothing changes. To relax it, change
  one constant (`LADDER_STEP` or `LADDER_DEPTH`) and every look's pay recomputes. Over a white desktop or photo a pane
  sits darker than the page, and every level above it is a visible step brighter. Floating layers
  plan for a white thumbnail under them, so they can read dimmer than a small bright mark right under them; their
  elevation is the largest shadow. `test/background.test.ts` recomputes every contrast and brightness step over every
  look (the margins are 4.51 to 4.65 at the tight spots), `e2e/light.spec.ts` measures the steps in the render. The
  owner judges the real see-through window.

## ADR-88 Reference videos from a link: Clips Funded's own pinned fetcher behind an egress guard, and one drop hook

Amends ADR-78 (its "Reference links to other people's videos are not downloaded").

- **Context.** The owner (2026-11-23, with a screenshot of Clips Funded › References, whose card had only "Upload a
  video" and "Found one online? Save it to your device first, then upload the video file."): "i should be able to
  upload with drag and drop (which there isnt currently so fix that" and "and i also want a feature to just paste a
  link instead of uploading a video directly". Clips Funded's runtime had no downloader on purpose, and its drop was
  one card's handlers: invisible, flickering on every child, refused everywhere else, and missing the window guard
  when the app opened straight into Clips Funded. A fetch from a link the owner pastes is a server-side request to an
  address someone else chose (SSRF): the runtime can reach the instance metadata service (169.254.169.254, the
  container credentials at 169.254.170.2) and AWS's own addresses.
- **Options.** Where to fetch: the API Lambda (29 s, no ffmpeg), Clip Factory's runtime and its job flow (its
  cookies, proxy and PO tokens are already wired in), or Clips Funded's own runtime with its own pinned copy. How to
  hold the fetch to the public internet: trust yt-dlp's own checks, an egress rule in the VPC (the runtime is on
  AgentCore's public network: no security group to tighten without new infra), or a local proxy that every byte goes
  through. Which links: any https link, or an allowlist of sites and URL shapes. Drag and drop: patch each upload
  site, or one shared hook.
- **Decision.** (CONTRACTS §45.40, §45.11.1, §12.5)
  1. *Clips Funded's own fetcher.* The action `fetch_reference` on `cf_prod_story_agent`, a `reference_fetch` job
     with one step ("Get the video"); its own pinned `yt-dlp[default]==2026.10.26` (Clip Factory's pin). Code shapes
     are copied from Clip Factory (`sources.py`, `contentrewards/fetch.py`, `logo.py`), never imported (ADR-76).
     Nothing of Clip Factory's cookies, PO tokens, proxy secret, Mac fetch, TikTok helper or social tokens is used;
     IAM already keeps the stories role out of `private/` and Clip Factory's secrets. No Terraform change. YouTube
     gets Clips Funded's own PO-token sidecar from the start (ADR-52's way: bgutil's server built into this image
     from upstream, pinned by sha256, `player_client=default,mweb`, its calls through the fetch's guard; `pot.py` is a
     copy of Clip Factory's, never an import), because ADR-52 and ADR-59 found YouTube blocks AWS addresses.
  2. *One allowlist, three copies, one fixture.* Seven sites (YouTube, TikTok, Instagram, Facebook, X, Google Drive,
     Dropbox), exact hosts and URL shapes, https or no scheme only, no user info, port 443 or none, ≤ 2048
     characters, only the kept query keys, the same hand parser in the API, the agent and the web, all three tested
     against `stories/agent/tests/fixtures/reference_links.json`. The API refuses anything else with a sentence before
     any job exists; the agent checks the link again before it fetches.
  3. *The egress guard (SSRF rules).* `netguard.Guard`, a CONNECT-only proxy on 127.0.0.1 started for one fetch,
     carries every byte of it (yt-dlp gets `--proxy` and the proxy variables; Drive and Dropbox go through
     `set_tunnel`): only `CONNECT host:443` (anything else, plain http included, is 405); the host must pass
     `safe_host`; every resolved address must be public (no loopback, private, link-local 169.254.0.0/16,
     `fd00:ec2::/32`, multicast, reserved or unspecified), and the tunnel connects to the checked address itself, so
     DNS rebinding cannot reach a private one; every redirect and CDN hop is a new CONNECT, checked again; all
     incoming bytes count against one cap (`min(2 GiB, (free − 512 MiB) / 2)`) and every tunnel closes past it; 60 s
     idle, at most 16 tunnels; logs hold host names and counts only.
  4. *yt-dlp held to the allowlist.* Argument lists only (no shell), `--ignore-config`, `--no-playlist`,
     `--playlist-items 1`, `--no-cache-dir`, `--use-extractors` with exactly the seven platform extractors and never
     `generic`, `--` before the URL, never `--cookies`, `--exec`, `--load-info-json` or a user-supplied `-o`; a test
     checks offline that every platform shape in the fixture has an allowed extractor. A link shape only `generic`
     takes and nothing leads from is out of the table. Facebook's own Share › Copy link (`/share/r/`, `/share/v/`)
     and `fb.watch` are opened first through the guard (at most 3 redirects on Facebook's own hosts, or the page's
     `og:url`), and only the Facebook video link they lead to, checked again with `clean_link`, goes to yt-dlp.
     Live, over 10 minutes and over the cap are refused from `-J` before anything is downloaded; the download is
     capped again (`--max-filesize`, the guard) and the file is probed (a video of ≤ 600.5 s, ≤ 2 GiB) before it is
     stored.
  5. *For study only, kept private.* The file becomes the reference's own `ws/…/references/{refId}/source.mp4`,
     analyzed like an upload; the keep settings apply; nothing is published. The final write is fenced on
     `currentJobId`, and a refused write deletes the uploaded file.
  6. *The plain fallback.* Every failure says why in kid words ("upload it", the same on a phone) and keeps "Upload a
     video" and the page drop; "Try again" asks once more (`POST …/references/{refId}/fetch`) and is the main button
     only when asking again can work. A link added on the list that does not arrive opens its own page, like one that
     arrives; the same link pasted again says where its Try again is.
  7. *One drop hook.* `useFileDrop` (element or page zones, a counted highlight, text into text boxes untouched,
     Ask's own drops never taken), `DropOverlay` (one glass layer and pill in each app's own glass, a shaking coral
     refusal, an sr-only status line) and a window guard installed once in `main.tsx`; Clip Factory's new-job card
     keeps its own drop code.
- **Consequences.** A pasted link works without the owner saving the file first, and every upload site takes drops.
  The runtime image gains yt-dlp (its build check runs it, and the self-check confirms the extractors without
  `generic`). YouTube's, TikTok's, Meta's and X's terms forbid downloading or automated collection: the fetch uses no
  login, is for study only and keeps the files private; the owner decides whether to keep it on. Many platforms block
  downloads from cloud addresses, so some links will still fail and say so (the PO token raises YouTube's odds but
  does not guarantee them; Instagram may want a login, and no cookies are used). The image grows by about 175 MB for
  the PO-token server. Follow-ups: "Get it again" for a link reference whose file a keep setting cleared; Vimeo or
  other sites as rows of the table; one public link per site tried on the live app after the deploy.

## ADR-89 Clips Funded posts TikTok through the same Mac: one helper, two lanes, the right account checked every time

- **Context.** Since ADR-83 and ADR-86 the owner's Mac posts Clip Factory's TikTok clips for everyone, out of sight.
  Clips Funded posts TikTok through Clip Factory's shared TikTok app, still in Sandbox, so its API posts can only be
  Only me. On 2026-11-23, with a screenshot of Clips Funded › Social accounts › TikTok connected as @clips.funded, the
  owner said: "btw i want the same way we upload to tiktok in clip factory for clips funded". Hard rules: never cross
  accounts (Clips Funded never touches Clip Factory's, and the other way round); every Clips Funded post carries
  TikTok's AI label and is never branded; Clip Factory's flow (four auto-posting runs a day) stays exactly as it is;
  an older helper never picks a Clips Funded job; no password in chat, logs, files or the server; no Terraform change.
- **Options.** (1) A second helper install with its own launchd job: two Chromes racing for one Mac, two sign-ins,
  and nothing to keep Clip Factory first. (2) Clips Funded jobs in Clip Factory's `/v1/tiktok/mac` queue: one queue,
  but Clips Funded data in Clip Factory's partition and Clip Factory's Lambda reading Clips Funded's accounts, which
  §45 forbids. (3) One helper with two lanes: Clip Factory's lane unchanged on the wire, and one lane per Clips Funded
  workspace on new routes in Clips Funded's own Lambda and partition, each lane with its own Chrome profile, port,
  ledger, needs-you and login. For the @clips.funded login (it signs in with Google): (a) a TikTok password for
  @clips.funded in the Keychain, which he would have to make and type; (b) an email-code login, which still needs his
  inbox and his turn each time; (c) one visible sign-in in the lane's own Chrome profile with the TikTok app's QR code,
  the helper never attached to that window (Continue with Google there would type his Google password on the Mac, so
  the code is the documented way, and the window's profile is hardened so it can't save a password either).
- **Decision.** (CONTRACTS §47.10, §45.14) Option 3 with login (c). Helper 1.2.0 runs Clip Factory's lane first every
  tick, exactly as 1.1.0, and a Clips Funded lane only when Clip Factory's has nothing to post, resume or find; a ws
  error never reaches Clip Factory's lane. Before Studio › Posts is read, right before Post, before every look for a
  link and on the link itself, the helper reads the signed-in handle (the passport answer, Studio's own post links,
  the page's rehydration data) and refuses unless it is the lane's target: the job's recorded `@handle` for Clips
  Funded, `GET /v1/accounts`' TikTok handle for Clip Factory (else the one account of the helper's own Clip Factory
  posts, so a 1.1.0 Mac goes on as it did). Each lane also refuses every other lane's account by handle and uid, both
  ways. The server's claim re-checks the open_id and the stored handle, and done refuses a link on another account. Clips Funded's Mac posts are always Everyone with Comments, Duet
  and Stitch on, Disclose post content off and TikTok's "AI-generated content" switch on and read back (no switch, no
  post). `MAC_WS_FROM = "1.2.0"` gates the queue and the claim. The switch is `StoriesConfig.tiktokMac`, shown as **My
  Mac posts TikTok** in Clips Funded's TikTok card, which also shows the Mac's state and **Log in on my Mac**. The web
  rows follow Clip Factory's Mac rows in Clips Funded's own words; a post the API made Only me (`onlyMe`) offers **Post
  with my Mac** and is handed over in place, so a story keeps one TikTok row.
- **Alternatives.** *Reuse Clip Factory's routes with a workspace field*: Clip Factory's Lambda would read Clips
  Funded's partition. *Caption matching for Clips Funded's lost posts* (as Clip Factory's `findExisting`): an older
  story's post with a similar caption could be taken as done, so a ws lane relies on the server's never-twice rule and
  the baseline saved at pressing. *A Keychain password for @clips.funded*: a password he never had to make, in one
  more place. *Reading the handle from www.tiktok.com's feed links*: those are other people's videos, so off Studio
  only the account's own data counts.
- **Consequences.** No Clip Factory route, server file, web file or Terraform changes; Clip Factory's ping keeps its
  keys and now says 1.2.0 (and `paused`, with why, when it can't tell which TikTok is Clip Factory's). A Clips Funded
  post can make one Clip Factory job wait one tick at most (about 40 minutes at worst, when it meets a logout). A later
  TikTok logout of @clips.funded is the owner's turn again (no saved login): the row says so with **Set it up** and the
  card has Log in on my Mac, which clears the profile's old cookies first. A paused Mac has **Start my Mac again** in
  Clips Funded too (the same pause as Clip Factory's). If no handle source is readable, nothing posts in either lane
  (`whoami` before 1.2.0 starts is the go-live gate). TikTok may link two
  automated accounts on one Mac and network, so an automation flag could hit both; the owner accepted the automation
  risk for @lamo.clips on 22 Nov. Mac-posted Clips Funded videos get no view numbers yet, and It's on TikTok is
  paste-only (no Find it for me); both are follow-ups.

## ADR-90 The sound samples are rendered ahead of time from the renderer's own synth

- **Context.** The owner (2026-11-23), on a character's Sounds tab: "id like everything here to be in samples so i can
  here what each sounds like". The videos' sounds come from one numpy synth in the stories agent
  (`stories/agent/.../audio.py`, CONTRACTS §45.11.3), with no audio files; the web had nothing to play.
- **Options.** (1) A TypeScript copy of the synth in the browser (Web Audio): two synths to keep equal, and what he
  hears drifts from the videos. (2) An API route that renders on demand: new infra, a wait on every tap, and Lambda
  time. (3) Render every sample ahead of time with the agent's own synth into small files the web serves.
- **Decision.** (CONTRACTS §45.41) Option 3. `python -m lamostories_agent.samples` renders each effect and each noise
  (both voices at all 31 pitch stops) as one event through `audio.mix`, the videos' chain without the final loudnorm,
  then mono, the end silence trimmed, one library gain (2.28, the loudest at -1 dBFS, so the files keep the videos'
  levels against each other) and a 64 kbps MP3: 705 files, 4.07 MB, under `web/public/sounds/stories/<recipe>/`.
  `recipe` hashes the tokens of audio.py and samples.py (comments do not count; `ast.dump` was not used because its
  text changes between Python versions) and the settings, so a changed synth is a new folder name that also gets past
  the 1-hour browser cache. The web plays them with Web Audio, one at a time, from a play button beside each chip;
  tapping a chip still only picks it.
- **Consequences.** No infra and no API. The repo holds 4 MB of MP3s; the service worker never precaches
  `public/sounds/`, so neither app's install grows. `test_sound_samples.py` fails while the files are stale (the
  recipe, the file list, and PCM spot renders against the manifest), and ci.yml runs it when the files or
  `samplesRoot.ts` change: after a change to audio.py, run the generator (it needs ffmpeg) and commit its output. The
  samples are the built-in synth's; when the workspace picks another effects maker the part says "Effects may sound a
  bit different in videos."

## ADR-91 A car of the cast is a car prop with a castId, kept in its own `cars` map

- **Context.** The owner (2026-11-23) wants a character that is a car, made in cartoon style from real photos, picked
  among several generated cars, for a series "where its a guy buying a car and then driving it for the first time",
  with the main character. The built-in animator had people only (`cast`), and cars only as plain props.
- **Options.** (1) Make a car an actor in `cast`: every people part (geometry, motion, faces, bubbles, noises) would
  branch on the kind. (2) Keep `cast` people only and put the cast's cars in a separate `script.cars` map; a car prop
  with `castId` is drawn as that car, with its own `CarLook`. Also: (a) one model call per option, or (b) one call
  that makes 3 options, so the photos are sent once.
- **Decision.** (CONTRACTS §45.42, §45.43) Option 2, with (b). Two kinds: person and car ("an animal" and "a thing"
  need rigs of their own and are follow-ups). A car is drawn by `engine/car.ts` in the side and top views (8 bodies,
  paint patterns, windows with riders behind the glass, wheels, lights, optional eyes on the windscreen or in the
  headlights, off by default) and moves by prop actions (the new speed_up, bounce, honk, blink and stall). Plates are
  plain and badges never drawn: the engine has no text shapes, the prompt forbids makes and models, and the checker
  strips a brand that gets through. A cast is 1 to 3, at most one car and someone to drive it.
- **Consequences.** People code and old scripts are unchanged; the shape goldens keep every prim (only
  `ENGINE_VERSION` goes 5 to 6). The writer and the idea agent get the car as a cast entry with words, never a look.
  `CHAR#` gains `kind` and `car` (a missing kind is a person). A car design costs one call for 3 options, a person
  design what it cost before. Cars have their own place in the rail, Cars, right under Characters (the owner asked
  for it twice), and Characters shows the cars too, each with a Car tag. The rail's 12 pages keep 48, 44 or 40 px rows,
  never lower than 40 (the first build's shared rows went down to 32 px); in a window too short for twelve 40 px rows
  the rail's list scrolls.

## ADR-92 A series' memory is data kept per series, written by a recap task after each approval

- **Context.** The owner (2026-11-23): "Can you create a folder for each series i create so it is organized and if
  you think it good maybe it could save context from previous videos if they are in the same folder".
- **Options.** (1) Keep it in the workspace memory (MEM#): it would mix series, grow without a bound and fill the
  owner's own memory. (2) Rebuild it from every earlier script for each new idea or video: large prompts and cost
  that grows with each episode. (3) A `SERIES#` item per series with a short story so far and one summary per
  episode, written by a task after each approval, and a bounded slice of it sent to the idea agent and the writer.
- **Decision.** (CONTRACTS §45.44) Option 3. A series is a folder (a name, a line, a cast and a cover) and a place in
  the rail, with an "All ▾" switch on Ideas, Production, Review and Library whose choice lives in the address
  (`?series=`), never in a hidden filter. After an approval, a `series_recap` task (the creative director, routed as
  `text_edit`) writes the episode's summary (≤ 400) and the story so far (≤ 1500, in Who, Places, Running jokes and
  Where things stand), under a version condition; the owner can read and edit it. `series_context` sends the story so
  far, the newest 5 summaries, up to 20 earlier titles and the cast, at most 8000 bytes.
- **Consequences.** An approval never fails because of the recap (it is best effort, and the folder offers "Write it
  again"). Episodes and their numbers are worked out on each read. Deleting a series never deletes a video: its
  videos and ideas move to "No series". No infra: the same table partition, and API Gateway already proxies the
  routes. The series memory never goes into MEM#.

## ADR-93 Night drive is a drawing style in the one engine: an `art` field, cuts between shots, surface drawing only

- **Context.** The owner (2026-11-24) sent a reference video of a cartoon drive at night and asked for their videos
  in that style, "a little bit more detailed", keeping every feature: "its just a simple design style change". The
  look needs soft lines, cel shading, a muted night palette with sodium lamps and glow, and film-like shots inside a
  car (the driver's eyes through the windscreen, the face, the mirror, the speed dial, the pedals). Every old story,
  golden and preview had to stay as it was, and the preview and the final video had to stay the same picture.
- **Options.** (1) Replace the drawing outright: every old story and golden would change, and there would be no way
  back to the bright look. (2) An AI video model or an ffmpeg filter for the look: the preview could not match the
  final video, and a filter cannot add shots. (3) A drawing style in the same engine: `StoryScript.art`
  (`"night_drive"` or `"classic"`, a missing field is classic), surface drawing behind `nightDrive()` with the
  geometry unchanged, and `Scene.cuts` for shots inside a scene, all as the prims both drawers already paint.
- **Decision.** (CONTRACTS §45.45) Option 3. New videos are made in Night drive (the workspace's `video.art`
  default, which the owner can set back to Bright in Settings › Video or per video in Production › New); the engine
  itself never reads a missing `art` as Night drive. Own colours (skin, paint, a place's palette) are lit by the
  place's light (`grade`); palette tokens are final. One new place (`highway_night`) and eight shots (`shots.ts`,
  `perspective.ts`, `carView.ts`); cuts are hard, the action and sound go on across them, and the writer cuts every 2
  to 4 seconds. A vignette of prims, no film grain (it would need a new prim kind in both drawers). `ENGINE_VERSION`
  is 7. No preset copies the reference's characters, and the reference is never copied into the repo or a prompt.
- **Consequences.** Bright draws byte for byte as before (the shapes golden changed only its engine field), and a
  night goldens file pins the new look prim by prim; `raster.py` is checked against the same frames. Night frames have
  more shapes, so the writer's estimate reads measured counts per place, prop and shot. Rasterizing a night shot is
  about 1.7 to 2.3 times the Bright highway's time a frame (a faster polygon fill is a follow-up). The look reaches
  final videos only through the PR and the agent image's CI deploy; no infra changes and no data is reset (older
  workspaces get `video.art` filled in on read).

## ADR-94 A skipped platform is hidden everywhere but Settings and Social accounts

Supersedes §17.13's skipped rows on the floating setup list, §45.36 E15 for platform steps and §45.36 E18's card
columns on Clips Funded's Social accounts. The contract is CONTRACTS §48.

- **Context.** The owner (2026-11-24, with a screenshot of Clips Funded's Dashboard showing "Finish setting up: 1 left
  · Connect X · Open setup" and "Connected accounts 4 of 5" after X was skipped): "if i skip on a platform setup then
  i dont want to see it anywhere except in settings or social accounts tab". In the same message, with a screenshot
  of Clip Factory's Set up posting: "can you make the social account page to look organized like this".
- **Decision.**
  1. *One rule in both apps (rule S).* A platform the owner confirmed as skipped, and that is not ready (Clip Factory)
     or not connected (Clips Funded), is left out of every reminder, count, "N left" list, nudge, "connect X" link and
     Ask suggestion. It shows only in Clip Factory › Settings › Posting › Set up posting and Clips Funded › Social
     accounts (and Clips Funded's setup, which its nav counts as Settings), each with Un-skip. Counts are "N of M"
     over the platforms not skipped. Ready or connected wins over a skip, and the skip is then dropped, so a platform
     that later needs the owner comes back.
  2. *Clips Funded keeps its existing store.* Platform skips are the platform keys of `ONBOARD.skipped`, written by
     the existing `PATCH …/onboarding {step, skipped}`. The API marks `SocialAccount.skipped`, gives
     `Onboarding.total` as 11 minus the platform steps skipped, and leaves skipped platforms out of the dashboard's
     accounts and Needs you. A read that finds a skipped platform connected drops the skip with one conditional put.
  3. *Social accounts becomes a list and pages.* The list page has a header card, a progress card ("N of M ready" with
     a ring) and a 2-column grid of rows (icon tile, name, one status word, one line, a check or an empty circle, a
     chevron). Each row has its Skip (asked first) or Un-skip and opens `/stories/connections/<p>`, which holds the
     platform's card as it was. The OAuth return lands on that page.
- **Alternatives.** *A new SKIPS item or route*: a migration and a Terraform change, for what `ONBOARD.skipped`
  already stores (the owner's X skip was in it). *Hiding a skipped platform from Social accounts too*: no way back,
  against "except in settings or social accounts tab". *Keeping skipped rows on the floating list with Un-skip*: the
  list is a reminder, which the owner said he does not want. *Keeping the masonry cards with rows above them*: two
  ways to do one thing on one page.
- **Consequences.** The owner's stored X skip takes effect on deploy, with no data rewritten. A skip never turns a
  posting switch off: in Clip Factory, "Your Mac posts TikTok" keeps posting if TikTok is skipped while it is on, and
  the clip page's stack for a skipped X with no post says only "Not posted here." (no Set up or Where clips go link).
  Whether a TikTok skip should also pause the Mac is left to the owner. Each app's skips stay its own.

## ADR-95 An owner's script is staged, never written: a faithful adapter, a code check and a report-only fact check

- **Context.** The owner (2026-11-24), about Clips Funded: "i also want the option to write my own script ... of
  what happens". Until now the AI wrote every story (an idea, then Write the story). The owner wants a clear option to
  write what happens and to get a video made from their script: their events in their order, their characters and
  cars from the cast, their words on screen as written (the videos have captions and no voices), and the series'
  memory. The AI may only fill what the engine needs. The AI path stays as it is, and stays the default. ADR-74
  (safety videos only from checked guidance) still holds, and an 8 year old must be able to use it.
- **Options.** (1) Send the owner's text to the writer as a brief: the writer would rewrite it, which is exactly what
  the owner does not want, and nothing would prove it kept the script. (2) A new "stage" task kind and model setting:
  new config, API, web and resolve cases for what the existing "Plan the animation" task already is. (3) A structured
  script (2 to 12 scenes of "What happens" and an optional caption, with who and where) staged by a faithful adapter
  on `animation_plan` whose schema has no words on screen; code puts the owner's captions in as `w_sN` cues and a
  code check proves the order, the cast, the place, the words and that every piece of each scene is tied to something
  drawn, with nothing added beyond small fillers; the fact check reports and never rewrites.
- **Decision.** (CONTRACTS §45.46) Option 3. Production › New's idea Pick gets a third choice, **Write it myself**
  ("Use an idea" stays the default): a scene list with counters, ↑ ↓ ✕, Paste a script, who and where read from the
  words, one plain question for an unknown name ("Who is Max?"), and a "Your video" strip. `ownScript` is an optional
  field on POST and PATCH stories and on the `STORY#` item; the API gives the scene ids, refuses a value over its
  limit with a kid sentence and never cuts it. The agent's adapter gets one more try when the check fails; then the
  job stops with an honest sentence naming the scene, and nothing is saved. Check the facts still runs (a topic
  matched from the owner's words for every kind, so a script that teaches safety is always checked): the owner's
  events, captions and beats are only reported ("Your scene 2 …"), only the AI's post captions are fixed, and the
  video cannot be approved until the check passes; Fix the words opens Change my script at that scene. Review's Ask
  for changes becomes Change my script, with no note box. A caption-only change re-runs only the caption steps.
- **Consequences.** With no `ownScript` every path is byte for byte as before. No new route, task kind, table,
  index or Terraform change, so no owner data is touched; old stories have no `ownScript` and read as before. The
  engine now counts a caption's and a title's length in letters (code points, as the API does), so a 60-letter
  caption with emoji is never refused; ASCII text counts the same, so no old script changes. Code cannot prove that a
  beat really "shows" its piece of the text (a report-only final look over the owner's scenes is a follow-up), and
  any change to what happens stages every scene again.
- **Review round (2026-11-24).** Three reviews and 18 attack cases showed the code check trusted the adapter's own
  answer about which beats show which piece. It now also proves: who does each event (a piece's beats are by who it
  names, or their car or its rider); the order of the events inside a scene; that no event action, event sound or
  event prop is drawn unless the words say it (at most one drawn a bit differently per piece, told in the note);
  that a piece shown only by idle beats, the place or the camera says how; that a left-out name never hides the rest
  of a piece; that a scene with no Who has exactly the cast its words name; and that every name nobody gave, and
  anyone the cast lost, stops the video before a model is asked. A name the owner answered (another name for someone
  in Who, or the new "Not a name") is kept as the scene's optional `known` (additive). Remake this scene stages the
  whole script once the script has changed. In the fact check a problem only with the AI's staging sets that scene
  up again once (a staging fix, never a rewrite), the owner's words are data and never instructions, and the
  owner's driving words always guard the check. Captions refuse `{`, `}` and `\` (the burned-in words would change
  them) and the agent image draws emoji (Symbola). The web says "Type an idea" for the AI path, asks nothing about
  everyday words, and says "Your script" once on the video's page. A name at a sentence start is still asked about:
  skipping it would let the AI give Max's part to someone in the cast.
- **Re-review (2026-11-24).** 30 more attacks (24 got through) showed the check still trusted the adapter's pieces
  and only policed added events. Options: (a) ask a model to judge faithfulness (it can be fooled the same way, and
  costs a call); (b) read the owner's own words in code. Chosen: (b), in a new pure module `own_words.py` (§45.46.10):
  the events the words say are owed, by who does them, in their order, as many times as they say; what the words say
  does not happen is never drawn; a face never shows the other feeling; someone the words say is away is not drawn;
  the caption no longer allows an event (the adapter never reads it, so only an unfaithful staging could use it, and a
  caption-only change can then never leave a stale event); the note names every event drawn differently and is never
  cut there; a zero-width space and decomposed letters change nothing. The fact check never sets a scene up again
  for a beat that draws the owner's own event ("very fast"): it is reported. A pronoun two people could be is the one
  case code cannot settle without knowing who is a he or a she: it is settled by a character's description or the
  script's own "his"/"her", else either may be drawn and the note says who. Strict word lists on purpose: an owed
  event the words only seem to say would stop a kid's video, so idioms ("falls asleep") are excluded and a thing's
  event ("the snow falls") is never a cast member's. The web puts the cast's one car in every scene whose words say
  car or drive, carries Who (and Where, for a scene that names nobody) from the scene before, asks fewer silly
  questions, and an owner's script of another kind gets a checked topic only when its words are about driving.
- **Round 1 of the re-review (2026-11-24, PR #201).** 80 more attacks (77 got through) showed the code reader owed
  events the words only mention ("afraid of falling", "If Lamo falls", 'shouts "Jump!"', "Lamo's ice cream falls"),
  so the retry was told to draw them and the faithful staging was lost with no note; that a character's own he or she
  could be unlearnt by the words; and that a hug's feeling went to the one hugged. Options: (a) keep owing every event
  word and let the note explain (the retry still changes the story); (b) owe only what the words say happens, and let
  a mention be drawn or not. Chosen: (b) (§45.46.11): an event after a fear, a wish, an "if", a future, a warning, "to"
  or in quotes may be drawn and is never owed; who does what is the names right before the event (each of "Lamo and
  Rosa"), an owner's thing is not its owner, a car's event is its owner's car; a description's he or she always wins;
  counts are exact and an event said again is owed again; a car's stop, getting in and out of a car and a cast car's
  tricks are events too. The web never puts an answer ("seen", "out") in the cast, makes a friend's character in place
  ("Make Zara", the usual look: the draft is never lost to a page change), lets one who joined by themselves leave
  again, and carries Where with the same people. Still open, on purpose: genders the descriptions do not give leave a
  pronoun open (either may be drawn, the note says who); "alone" with an open pronoun keeps everyone wanted.

## ADR-96 Campaign and paid clips post TikTok through the Mac with TikTok's label

- **Context.** Since ADR-86 round 3 (D1) a campaign clip never got a Mac post and a Review card with Your brand or
  Branded content ticked held Upload for TikTok (CONTRACTS §47.9): the helper could not set TikTok's commercial content
  disclosure, and the Mac's done never reached Content Rewards, so a campaign clip on TikTok could neither earn nor
  keep to TikTok's Branded Content Policy. The owner treats Content Rewards campaigns as paid partnerships and wants
  every clip on TikTok through his Mac ("its always the automation that covers it"), at most reach, never made for
  kids, with nothing on his screen while the helper runs.
- **Options.** (1) Keep skipping TikTok for campaign clips until TikTok approves the app: the campaigns that pay for
  TikTok earn nothing there meanwhile. (2) Post campaign clips through the Mac without the label: breaks TikTok's
  Branded Content Policy and risks the account. (3) Give the helper a disclosure step, read back like privacy, let the
  server hand the card's own TikTok choices (and a campaign's Everyone with Branded content) to the Mac, gate labelled
  posts on a helper that sets the label, and send the Mac's posted link to Content Rewards.
- **Decision.** (CONTRACTS §47.12) Option 3. Helper 1.3.0 opens Show more, sets Disclose post content with Your brand
  and Branded content from the job and reads them back (again right before Post), or stops before Post. The server
  takes the card's own TikTok row for a Mac post (`tiktokMac: true` on Upload), keeps a paid clip's label on the clip
  (`tiktokLabel`) for Post with my Mac and Send these to my Mac, gives every campaign clip Everyone with Branded
  content after all of Upload's campaign checks, stops a closed campaign's Mac post at its claim, never lets a helper
  older than `MAC_BRAND_FROM` claim a labelled post, and sends the Mac's posted campaign link to Content Rewards
  (`contentrewards.submit.send`, its 30-minute window). The Review card's Mac-mode TikTok row is the clip's own again
  (who can see it, the switches, Commercial content), starting on My settings with no tap.
- **Consequences.** Every field and body key is additive and nothing changes for an older web (My settings, as
  before). The helper on the Mac must be reinstalled from main before a labelled post goes; until then such a post
  waits and says so, and nothing is posted without its label. TikTok Studio's controls can change: the step finds
  them by their own words and fails closed. What TikTok shows after Post on a branded post is not verified live (the
  probe never posts); the first one is watched. Amends
  [ADR-86](#adr-86-no-manual-tiktok-sheet-the-mac-is-the-only-way-to-tiktok-until-tiktok-approves-the-app) (D1).

## ADR-97 Video drafts are their own item; vehicles are car bodies shown as Vehicles; roles are additive fields

- **Context.** The owner wants to save Make a new video before making it, a main character and a villain per video,
  and vehicles (plural, "it could even be a plane") made from outside and inside photos, with the Cars tab called
  Vehicles (CONTRACTS §45.47). Hard rules 2 and 4 forbid renaming stored names or replacing live data.
- **Options.** (1) Save a draft as a STORY# with status `draft`: that status already means "Not made yet", Make it
  would start production with nothing stale, and the idea would be marked used too early. (2) A new `VDRAFT#` item.
  For vehicles: (a) a new `kind: "vehicle"` and renamed fields (`script.vehicles`), which breaks every saved car and
  script; (b) keep `kind: "car"` and add bodies grouped into families worked out from `body`.
- **Decision.** Drafts are option 2: `VDRAFT#{draftId}`, `type="ws_video_draft"`, at most 50 of 32 KB, checked
  loosely, kept on the server and deleted in the same transaction that makes the video. Vehicles are option (b):
  bodies `bus`, `motorbike`, `plane`, `boat`, `VEHICLE_OF` for the family, an optional `CarLook.interior` from the
  inside photos, a `side` per reference, and the sets `sky` and `sea`. Only the visible name changes to Vehicles
  (`/stories/vehicles…`; `/stories/cars…` and the route names stay). Roles are a new optional `roles` on StoryInput
  and Story (`mainId` is the first person; `villainId` another person); a story's cast grows to 4 (3 people, 2
  vehicles); series and idea casts stay at 3.
- **Consequences.** Every change is an added field or item, so old cars, stories and scripts read as before and no
  migration is needed. A plane or boat is still a cartoon drawn by the car rig; cockpit, handlebar and helm shots and
  photo-real vehicles are follow-ups. Amends
  [ADR-85](#adr-85-the-second-app-is-called-clips-funded-on-screen-every-internal-name-stays) only by adding another
  visible-only rename (Cars to Vehicles).

## ADR-98 A vehicle's likeness is a measured outline plus named parts in one optional `detail` object

- **Context.** The owner wants the cartoon vehicle to be recognisable as the real model in the photos, "overboard
  with the realistic part", still cartoon and animated (CONTRACTS §45.48). Saved vehicles must not change, and the repo
  forbids any make, badge or logo.
- **Options.** (1) A library of about 45 model-like rows with a morph: strong near a row, 45 rows to hand-tune.
  (2) A free traced outline of about 20 points: closest in a picture, but self-crossing traces, side view only, parts
  float. (3) 35 whole-number landmarks (nose, windscreen, roof, deck, tail, axles, belt) plus named parts.
- **Decision.** Option 3, in one optional `CarLook.detail` object with a master switch: absent draws byte for byte as
  before; present uses a second drawer. One rules table in `carDetail.ts` is the source (the API reads a generated JSON
  copy, the agent reads the engine's catalog), `fitProfile` makes any in-range numbers drawable, presets are frozen
  under `v` 1, the options of a design are the same vehicle at different cartoon levels, and the budget is measured.
  `ENGINE_VERSION` stays 7.
- **Consequences.** About 2,500 new lines beside the classic drawer, which never gains detail. The AI's numbers from a
  photo can be off by a few points, so presets, a `study` step, four example profiles and the clamp carry the risk.
  Motorbike, plane and boat outlines and the second look are follow-ups. Amends
  [ADR-97](#adr-97-video-drafts-are-their-own-item-vehicles-are-car-bodies-shown-as-vehicles-roles-are-additive-fields)
  only for how a vehicle is drawn.

## ADR-99 Night drive's people are chunky

- **Context.** More shape for the owner's character, still cartoon (CONTRACTS §45.49). Poses, the camera and every
  saved character hang on `geometry()` and the stored `CharacterLook`, and a night person is at most 92 prims.
- **Options.** Three looks drawn from the real engine: Soft (same build, shaped parts), Tall (new proportions, a neck)
  and Chunky (bold toy-like shapes, joints unchanged). Reviewers scored appeal, phone readability and animation safety.
- **Decision.** Chunky, picked by the owner. Only night drive's drawing changes; `geometry()`, `motion.ts`, `scene.ts`,
  `shots.ts` and `CharacterLook` stay; joined same-colour shapes pay for the detail inside the same budgets.
- **Consequences.** The owner then asked for the old dot eyes only (version 9). `ENGINE_VERSION` 8 and new goldens; Bright and old scripts without `art` are unchanged; the bust
  body and wheel hands are partly today's drawing (§45.49). Amends
  [ADR-93](#adr-93-night-drive-is-a-drawing-style-in-the-one-engine-an-art-field-cuts-between-shots-surface-drawing-only)
  only for how a person is drawn.

## ADR-100 Real glass is a lit bevel everywhere and a bending rim on the big cards, never a new colour

**Context.** The owner wanted all of Clips Funded to look like real glass, same colours. Only three hero cards bent.

**Decision.** A painted bevel in every sheen token; shade-only silk folds on the stage (so `look.ts`'s lights stay the
worst case); the lens code gives the bending rim to every big card with room for it, `LENS_BUDGET` 6, by document order.

**Why.** The bevel is free everywhere, shade-only silk keeps every contrast measure true, six rims stay within
WebView2's budget. Nothing stored changes.

## ADR-101 Vehicle designs are drafts

- **Context.** §45.51. The design ran as a task, but nothing stored remembered it.
- **Options.** (1) The task id in the browser: lost on another device. (2) A new queue or worker: new AWS resources.
  (3) A stored `VDESIGN#` item that claims the task and mirrors its state.
- **Decision.** Option 3, in the same table. The draft is settled on every read from the existing task (heartbeat,
  15 minute limit, missing task), so a state is right with no screen open. The web polls (2 s while designing, else
  20 s) because Clips Funded has no WebSocket. A finished design is never saved by itself: the owner checks it, then
  Save makes the vehicle and deletes the draft. One design per draft is a conditional write that claims the task id
  first; there are at most 3 designing and 20 drafts.
- **Consequences.** No new AWS resource; the agent and Terraform do not change; old vehicles and the saved-vehicle
  redesign read as before. The 3-at-once check is not atomic, so two creates in one moment could briefly make 4. Counts use a strongly consistent read, and deleting a designing draft still counts against the 3 (its task keeps running): both are known soft limits.
  Amends [ADR-97](#adr-97-video-drafts-are-their-own-item-vehicles-are-car-bodies-shown-as-vehicles-roles-are-additive-fields)
  only for where a vehicle design waits.

## ADR-102 Library's sort is a quiet dropdown on the shared Dropdown, kept in the address

**Decision.** `Dropdown` gets `variant="sort"` (a caption line, not a button, and a list that unfolds and folds on one
`--ease-unfold` curve); the other dropdowns are unchanged. The sort is `?sort=` beside `?show=`. "Most popular" is
likes, comments and shares; views are their own two choices.

**Why.** TikTok's dropdown rules and Clips Funded's uses stay byte for byte; the address keeps Back and reload right.

## ADR-103 A job counts its own AI usage; dollars come from one price list in config/models.json

- **Context.** §51. The owner wants the exact AI cost of every finished job, per model, in tokens and dollars.
- **Options.** (1) Read the AWS bill or Cost Explorer: delayed, per account, not per job. (2) Count in each Lambda and
  the agent from the model's own answer, and store it on the job. (3) The Agent SDK's `total_cost_usd`: its price
  table does not know every Bedrock model.
- **Decision.** Option 2. One meter per job run (a context variable, so the shared model clients need no job id)
  records each answer's reported usage and Transcribe's audio seconds. Dollars are tokens times the price in
  `config/models.json` `pricing`, which holds the source and date of every price; an unconfirmed price is never
  invented and shows as "about". The result is the additive field `Job.aiCost`, written with the job's own writes so a
  failed job keeps what it spent and a retry adds to it.
- **Consequences.** No new AWS resource and no extra model call. The agent image carries the price list already
  (`/app/config`). Prices change only by editing that file from the provider's own page. Work done by the API
  Lambdas outside a job (Ask, weekly learning, lessons, rules, distil) is not in a job's cost.

## ADR-104 Notes attachments go straight to S3 under uploads/, are added as optional fields, and reach the agent as bounded context

- **Context.** §52. The owner wants to attach, paste, drop and delete files and images in the notes box.
- **Options.** (1) Send the files through the API Lambda: size limits and cost. (2) A new bucket or prefix with its own
  lifecycle: new infrastructure. (3) The existing presigned PUT under `uploads/`, marked `purpose: "attachment"`.
- **Decision.** Option 3. The 14-day `uploads/` lifecycle already cleans up, so there is no infra change and no
  deletion code; removing a chip only forgets the upload. Both API changes are additive optional fields (`purpose`,
  `attachments`), so old clients, old jobs and retries behave as before. The server re-checks every key, size and type at
  job create, because the browser's word is not enough. The agent reads attachments inside the prompts that already carry
  the notes: no new model calls, with named character, page and block limits per prompt, and images and PDFs on two calls
  only, so their cost does not grow with the video (the text repeats in each prompt with the notes). A bad file is
  skipped, never fatal. In the app each file is a chip that uploads at once and has an Undo toast instead of a
  "Are you sure?" question, so a slip costs one tap and nothing is lost.
- **Consequences.** Attachments vanish after 14 days with the upload. Word, Excel and similar files are saved but not
  read. Their text, image and PDF tokens appear in the job's AI cost (§51) like any other input.

## ADR-105 Campaign logo and text are drawn after the clip, in Review, by the agent

- **Context.** §53. Campaigns want a logo and words on screen for the whole clip. The owner let us pick: before
  clipping or after.
- **Options.** (1) Before: put the overlay in the clip job's render. It would re-cut every clip of a job, cost a new
  job per change, and a wrong placement needs a whole re-run (the §39 copy already works this way, at that price).
  (2) After, on the finished clip, in Review. (3) After, in the browser, by canvas recording: unreliable, slow on
  phones, no audio guarantee.
- **Decision.** Option 2. The agent runtime already has ffmpeg and bucket access; the API asks it for one small
  `overlay` action and the agent draws on the original file, which is kept (`origVideoKey`) so Reset is instant. The
  result replaces `videoKey`, so every posting path (flows, the Mac helper, download, auto-posting) works unchanged
  and no clipping code changes. The logo library is a new bucket prefix `logos/` (no expiry, unlike `uploads/`) plus
  `LOGO#` items; fields are added only. Auto-posting only skips a clip while its edit is still being made.
- **Consequences.** An edit costs one re-encode (seconds to a minute). The quality is one more generation of the
  video, so the render uses the same encoder settings as clipping. One API role policy grows by a prefix (in place).
  No table, pool, secret or bucket is touched.

## ADR-106 Upload to starts with every set-up place; no pick is remembered between clips

- **Context.** The owner's Review card showed only Facebook ticked with four places set up: the device pick saved after an earlier Upload (or Where clips go) beat the most-reach default.
- **Decision.** `defaultUploadTo(ready)` returns every ready place (a campaign clip: the places it pays for). Taps change that one card only. `cf-upload-to` is neither read nor written. Where clips go stays in Settings and for the server, unchanged; auto-posting is untouched (§46).
- **Consequences.** No stored data changes; an old `cf-upload-to` value is simply ignored.

## ADR-107 CR clip pictures: layer list

- **Context.** §54: several pictures on a clip; §53 stored one `overlay.logo`.
- **Decision.** Add `logos`, keep `logo` readable (no migration); soft cap 4. §54 L6: the sheet is a bounded box that scrolls inside itself, with a plain-block preview (a sticky one hid fields).

## ADR-108 No schema unions

- **Decision.** No `anyOf`, no `thinking: disabled`.

## ADR-109 Campaign tags fill the caption boxes

- **Decision.** Review runs fit-captions once per clip and campaign.

## ADR-110 Entertainment default

- **Decision.** `"24"`.

## ADR-111 Engagement is the plain rate by views; the watch graph uses only real curves

- **Context.** §55: a pro engagement number and a start-to-end watch graph per clip, across platforms.
- **Decision.** (likes + comments + shares + saves) ÷ views, unweighted, view-weighted for All: benchmarks (Dash
  Social, Metricool, Statista) publish this plain sum, so a weighted score could not be compared. Curves only from
  YouTube Analytics and Facebook's retention graph; Instagram, TikTok and X give markers, never a made-up curve.
- **Consequences.** One extra YouTube Analytics call per video per insights read, one guarded Graph call per Reel. Each
  app counts views its own way, so per-platform rates differ in meaning.
