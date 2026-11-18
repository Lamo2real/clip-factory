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
owner's, the fallback and the IAM shape were decided by the build.

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
  | Facebook | `video_insights` (lifetime only) for up to 50 Reels a request | Pages BUC: **4,800 × engaged users** per 24 h; error `80001` | Up to 48 hours to settle; impressions and unique-views metrics retire with v26.0 |
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
- **Consequences.** At most about 16 secrets at $0.40 a month each. Only `cf-prod-api`, `cf-prod-hooks`,
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
  guides), English only, full of exact UI words (**Keep**, **Throw away**, **Click sound**), and it changes with every
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

