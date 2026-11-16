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
([CONTRACTS.md §18](CONTRACTS.md#18-skills-full-create-read-update-delete-every-ai-call-uses-every-skill-owner-request-2026-11-16)):
the owner asked for skills to be created, read, changed and deleted in Settings and for "the whole AI system" to use
all of them "no matter what"; how that is enforced was decided by the build.

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
- **Consequences.** About $0.024 per minute of audio. No model to maintain. Transcription runs while the agent waits,
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
