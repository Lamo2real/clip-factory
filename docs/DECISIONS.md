# Decisions

A short log of every significant decision, in Architecture Decision Record style: the context, what we chose, the
options we did not choose, and what follows from it. A decision changes only through a new entry that replaces the
old one (mark the old one "Replaced by ADR-xx").

All entries: status **Accepted**, November 2026, decided by the build under the owner's "you have full control" brief.

---

## ADR-01 Region: eu-north-1 (Stockholm)

- **Context.** The owner is in Europe and already runs production work in `eu-north-1`. Bedrock, AgentCore Runtime,
  Transcribe, Cognito, Lambda (arm64), DynamoDB, SQS and EventBridge Scheduler are all available there.
- **Decision.** Every regional resource lives in `eu-north-1` (Terraform variable `region`, GitHub variable `CF_REGION`).
  CloudFront is global.
- **Alternatives.** `us-east-1` (most features first, but further from the owner and from the existing state bucket);
  `eu-central-1` (fine, but no reason to split from the owner's other work).
- **Consequences.** Model calls may be served from another region through the global profile (ADR-02). Data at rest stays in Stockholm.

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

## ADR-06 Polling instead of WebSockets

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
