# Clip Factory Cloud: contracts (the single source of truth)

Every component (web, api, agent, infra, CI/CD) follows this file. If code and this file disagree, this file wins
and the code is fixed. Change it first, in the same pull request, when a contract has to change.

## 0. Product in one paragraph

The owner pastes a **YouTube, Twitch or Kick link** (or uploads a video file). An agent on **Amazon Bedrock
AgentCore**, running **Claude Fable 5.1** with the owner's **skills** (SKILL.md files managed in Settings), downloads
the source, transcribes it, finds the most viral moments, and cuts **5–10 vertical clips** (1080×1920, hook text,
burned-in captions, cover image, pre-post checklist, a caption per platform). The clips appear in the app for review.
**Nothing is published without the owner's Confirm.** Confirmed clips are queued for publishing to the connected
social accounts (YouTube, Instagram, Facebook, TikTok, X; integrations arrive in a later phase). **48 hours after a
clip is posted** its performance is checked, and what worked is distilled into "learnings" the agent uses on the next
jobs.

## 1. Names, region, accounts

| Thing | Value |
|---|---|
| Repository | `Lamo2real/clip-factory-legal` (public). The legal pages at the repo root (`index.html`, `privacy.html`, `terms.html`, `style.css`, `.nojekyll`) are served by GitHub Pages and **must stay where they are**. |
| Resource name prefix | `cf-prod` (`local.name` in Terraform) |
| Region | `eu-north-1` (Stockholm), variable `region`. CloudFront is global. Unchanged by §14: Lambda durable functions (since 2025-12-18, python3.13), S3 Vectors, Titan Text Embeddings V2 (in-Region), AgentCore Runtime and batch Transcribe are all available here. |
| Model | Claude **Fable 5.1**, Bedrock model id `anthropic.claude-fable-5-1`, called through the **global** cross-region inference profile `global.anthropic.claude-fable-5-1` (the only way to reach it from eu-north-1: no in-Region model, no EU geo profile, so prompts may be processed outside the EU; the account must be opted in to data retention mode `aws_review`, a one-time owner step in docs/DEPLOYMENT.md). Embeddings: **Amazon Titan Text Embeddings V2** `amazon.titan-embed-text-v2:0`, in-Region, no profile (§14.6). Only `config/models.json` holds model ids. |
| Terraform state | S3 bucket `vars.CF_STATE_BUCKET` (default `lamo-labs-state-bucket`), key `clip-factory/prod/terraform.tfstate`, `use_lockfile = true`. |
| GitHub settings | variable `CF_DEPLOY_ROLE_ARN` (OIDC role, provided by the owner later), secret `CF_OWNER_EMAIL` (the only login), optional variables `CF_REGION`, `CF_STATE_BUCKET`. |
| Web origin | The CloudFront default domain (`https://dxxxx.cloudfront.net`), output `app_url`. No custom domain yet. |

`config/models.json`:
```json
{ "profilePrefix": "global", "agentModel": "fable-5-1",
  "models": { "fable-5-1": { "label": "Claude Fable 5.1", "modelId": "anthropic.claude-fable-5-1" } },
  "embeddingModel": { "label": "Amazon Titan Text Embeddings V2", "modelId": "amazon.titan-embed-text-v2:0",
                      "dimensions": 1024 } }
```
`embeddingModel.modelId` is used as is (in-Region, never prefixed with `profilePrefix`). Terraform reads it into
`local.embed_model_id`, `local.embed_dimensions` and `local.embed_model_arn =
"arn:aws:bedrock:${var.region}::foundation-model/${local.embed_model_id}"`.

## 2. Repository layout

```
/                           GitHub Pages legal site (do not move) + README.md
config/models.json          the only place model ids live
skills/<name>/SKILL.md      built-in skills, bundled into the agent image and seeded for the owner
docs/                       BUSINESS_REQUIREMENTS, ARCHITECTURE, CONTRACTS (this), AGENT, UX_DESIGN_SYSTEM,
                            DEPLOYMENT, SECURITY, TESTING, DECISIONS, ROADMAP; docs/architecture/aws-architecture.drawio
web/                        React 19 + Vite + TypeScript PWA (own package.json)
api/                        Python 3.13 Lambdas, standard library + vendored boto3 + vendored
                            aws-durable-execution-sdk-python only (uv project "clipfactory-api"; §14.10)
agent/                      Python 3.13 AgentCore runtime + its Dockerfile (uv project "clipfactory-agent")
infra/                      Terraform: envs/prod + modules/*
scripts/                    ensure-state-bucket.sh, push-image.sh, write-web-config.sh, build helpers
.github/workflows/          ci.yml (every push and PR), deploy.yml (push to main)
```

## 3. Authentication (Cognito)

* One user pool `cf-prod-users`, **admin-create only** (no sign-up). Terraform creates the owner from `owner_email`
  (Cognito emails a temporary password; first sign-in sets a new one).
* App client `cf-prod-web`: public (no secret), `ALLOW_USER_SRP_AUTH` only, `access_token_validity = 15`,
  `id_token_validity = 15` (minutes), `refresh_token_validity = 30` (days), **refresh token rotation ENABLED**
  (`retry_grace_period_seconds = 10`), token revocation on, `prevent_user_existence_errors = ENABLED`.
  Rotation means every refresh issues a new 30-day refresh token: an owner who uses the app stays signed in
  indefinitely; one month of inactivity requires a new sign-in.
* The web app uses **AWS Amplify v6** (`aws-amplify/auth`: `signIn`, `confirmSignIn` for NEW_PASSWORD_REQUIRED,
  `fetchAuthSession`, `signOut`). Amplify refreshes tokens itself. Its own glassy sign-in screen, no hosted UI.
* API: API Gateway HTTP API **JWT authorizer** (issuer `https://cognito-idp.<region>.amazonaws.com/<poolId>`,
  audience = app client id). The web sends `Authorization: Bearer <accessToken>`. Lambdas read the user id from
  `requestContext.authorizer.jwt.claims.sub`; never from the body.
* WebSocket API: the same access token in the `$connect` query string (`?token=`), checked by the Lambda REQUEST
  authorizer `cf-prod-ws-authorizer` (§14.2). The REST API (§14.3) is public (platform webhooks), no Cognito.

## 4. Web runtime config

CloudFront serves `/config.json` (written by `scripts/write-web-config.sh` from Terraform outputs at deploy time,
`Cache-Control: no-store`):
```json
{ "region": "eu-north-1", "userPoolId": "eu-north-1_xxx", "userPoolClientId": "xxx",
  "apiUrl": "https://xxxx.execute-api.eu-north-1.amazonaws.com",
  "wsUrl": "wss://yyyy.execute-api.eu-north-1.amazonaws.com/live", "version": "<git sha>" }
```
`wsUrl` comes from the Terraform output `ws_url` and is required in production. The web treats it as optional
(absent in mock mode and in old configs → polling only, §14.2).
Local development: `web/public/config.json` is absent; `VITE_MOCK=1` (`npm run dev:mock`) runs the whole UI on an
in-memory mock API (fixtures + fake latency) with a fake signed-in owner. Playwright tests run in mock mode.

## 5. HTTP API (API Gateway HTTP API v2 → Lambda `cf-prod-api`)

Base: `${apiUrl}/v1`. JSON in and out, camelCase. Every route requires the JWT except `GET /v1/health`.
CORS: allow origins `app_url` and `http://localhost:5173`, methods GET/POST/PUT/PATCH/DELETE/OPTIONS, headers
`authorization, content-type`.
Errors: HTTP 4xx/5xx with body `{ "error": { "code": "snake_case_code", "message": "Plain sentence for the owner." } }`.
Codes: `bad_request`, `unauthorized`, `forbidden` (REST hooks API only, §14.3), `not_found`, `conflict`, `too_large`,
`not_implemented`, `internal`.

| Method & path | Body | 2xx response |
|---|---|---|
| GET `/v1/health` | – | `{ "ok": true, "version": "..." }` |
| GET `/v1/me` | – | `{ "user": { "id", "email" }, "settings": Settings, "counts": { "review": n, "running": n, "posted": n } }` |
| POST `/v1/uploads` | `{ "filename", "contentType", "size" }` (video/*, ≤ 5 GB) | `{ "uploadId", "key", "uploadUrl", "headers": {"Content-Type": "..."} }` (presigned PUT, 1 h) |
| POST `/v1/jobs` | `{ "source": { "type": "link", "url" } \| { "type": "upload", "key", "filename" }, "clipTarget": { "min": 5, "max": 10 }, "notes"?: string }` | `201 { "job": Job }` |
| GET `/v1/jobs` | query `limit` (≤50), `cursor` | `{ "jobs": Job[], "nextCursor": string\|null }` newest first |
| GET `/v1/jobs/{jobId}` | – | `{ "job": Job, "clips": Clip[] }` |
| POST `/v1/jobs/{jobId}/cancel` | – | `{ "job": Job }` (only queued/running) |
| POST `/v1/jobs/{jobId}/retry` | – | `{ "job": Job }` (only failed/canceled; restarts from the beginning, cached source reused) |
| GET `/v1/clips` | query `status` (`review`\|`confirmed`\|`posted`\|`declined`\|`all`, default `review`), `jobId?` | `{ "clips": Clip[] }` |
| GET `/v1/clips/{clipId}` | – | `{ "clip": Clip }` |
| PATCH `/v1/clips/{clipId}` | `{ "captions": Partial<Captions> }` (only while `review`) | `{ "clip": Clip }` |
| GET `/v1/clips/{clipId}/similar` | – | `{ "clips": SimilarClip[] }` (≤ 5 of the owner's measured clips most like this one, §14.6; `[]` when none) |
| POST `/v1/clips/{clipId}/confirm` | `{ "captions"?: Partial<Captions> }` | `{ "clip": Clip, "posts": Post[] }` (writes the posts, starts the durable `cf-prod-clip-flow`, §14.5) |
| POST `/v1/clips/{clipId}/decline` | – | `{ "clip": Clip }` (video files and the clip's vector deleted) |
| GET `/v1/skills` | – | `{ "skills": Skill[] }` |
| POST `/v1/skills/uploads` | `{ "filename" }` (`.md` ≤ 1 MB or `.zip` ≤ 20 MB) | `{ "skillId", "key", "uploadUrl", "headers" }` |
| POST `/v1/skills` | `{ "skillId", "key" }` (after the PUT) | `201 { "skill": Skill }` (frontmatter `name`/`description` parsed; zip must contain one `SKILL.md`) |
| PATCH `/v1/skills/{skillId}` | `{ "enabled": bool }` | `{ "skill": Skill }` |
| DELETE `/v1/skills/{skillId}` | – | `204` (built-in skills can only be disabled) |
| GET `/v1/skills/{skillId}/content` | – | `{ "content": "<SKILL.md text>" }` |
| GET `/v1/settings` | – | `{ "settings": Settings }` |
| PUT `/v1/settings` | `Partial<Settings>` (validated) | `{ "settings": Settings }` |
| POST `/v1/settings/cookies` | `{ "filename" }` | presigned PUT for an optional YouTube `cookies.txt` (helps when YouTube blocks cloud IPs) |
| DELETE `/v1/settings/cookies` | – | `204` |
| GET `/v1/accounts` | – | `{ "accounts": Account[] }` (one entry per platform; `status: "not_connected"` until integrations exist) |
| POST `/v1/accounts/{platform}/connect` | – | `501 not_implemented` ("Connecting accounts arrives in the next phase.") |
| GET `/v1/posts` | query `clipId?` | `{ "posts": Post[] }` |
| GET `/v1/insights` | – | `{ "learnings": Learning[], "posts": Post[] }` (posts with metrics) |

### Shapes (TypeScript notation; the Python side uses the same keys)

```ts
type JobStatus = "queued" | "running" | "ready" | "failed" | "canceled";
type StepKey = "resolve" | "download" | "transcribe" | "analyze" | "select" | "render" | "checklist" | "captions" | "finalize";
type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";
interface Step { key: StepKey; label: string; status: StepStatus; message?: string; startedAt?: string; finishedAt?: string }
interface Source { type: "link" | "upload"; platform: "youtube" | "twitch" | "kick" | "upload"; url?: string;
                   key?: string; filename?: string; title?: string; channel?: string; durationSec?: number; thumbnailUrl?: string }
interface Job { jobId: string; status: JobStatus; source: Source; clipTarget: { min: number; max: number };
                steps: Step[]; progress: number /* 0..1 */; clipCount: number; notes?: string;
                error?: string; createdAt: string; updatedAt: string }
type ClipStatus = "review" | "confirmed" | "declined" | "publishing" | "posted" | "failed";
type MomentType = "rage" | "chaos" | "interaction" | "no_way" | "first_reaction" | "hot_take";
interface Captions { youtubeTitle: string; youtubeDescription: string; instagram: string; facebook: string; tiktok: string; x: string }
interface ChecklistItem { key: string; label: string; pass: boolean; note?: string }
interface Clip { clipId: string; jobId: string; rank: number; status: ClipStatus; momentType: MomentType;
                 hook: string; summary: string; durationSec: number; sourceStart: number; sourceEnd: number;
                 sourceUrlAt?: string; layout: "facecam_top" | "blur_fill";
                 videoUrl?: string; coverUrl?: string;      // presigned GET, 1 h, added by the API
                 captions: Captions; checklist: { items: ChecklistItem[]; fixes: string[] };
                 score: number /* 1..10 */; createdAt: string; decidedAt?: string }
interface Skill { skillId: string; name: string; description: string; enabled: boolean; builtin: boolean;
                  format: "md" | "zip"; size: number; createdAt: string }
interface Settings { clipMin: number /* 1..10, default 5 */; clipMax: number /* clipMin..10, default 10 */;
                     maxSourceHours: number /* 1..12, default 6 */; soundEnabled: boolean /* default true */;
                     reduceMotion: boolean /* default false */; hasYoutubeCookies: boolean /* read-only */;
                     platforms: Platform[] /* default all five */ }
type Platform = "youtube" | "instagram" | "facebook" | "tiktok" | "x";
interface Account { platform: Platform; status: "not_connected" | "connected" | "needs_reconnect"; handle?: string }
interface Post { postId: string; clipId: string; platform: Platform; status: "pending_integration" | "queued" | "posted" | "failed";
                 url?: string; postedAt?: string; perfCheckAt?: string;
                 metrics?: { views: number; likes: number; comments: number; shares: number; checkedAt: string }; error?: string }
interface Learning { learningId: string; text: string; createdAt: string; postIds: string[] }
interface Performance { views: number; likes: number; comments: number; shares: number; posts: number; checkedAt: string }
interface SimilarClip { clipId: string; hook: string; title: string; momentType: MomentType;
                        similarity: number /* 0..1 = 1 - cosine distance, 2 decimals */; performance?: Performance;
                        coverUrl?: string /* presigned GET, 1 h */ }
```
Ids are ULIDs (26 chars, time-sortable). Timestamps are ISO-8601 UTC strings.

## 6. DynamoDB (single table `cf-prod-data`, on-demand, PITR on, Streams `NEW_AND_OLD_IMAGES`)

Keys: `pk` (S), `sk` (S); GSI `gsi1` on `gsi1pk`/`gsi1sk` (projection ALL); TTL attribute `ttl`.
`userId` is the Cognito `sub`. The stream feeds `cf-prod-broadcast` (§14.2).

| Item | pk | sk | gsi1pk / gsi1sk | Other attributes |
|---|---|---|---|---|
| Settings | `USER#{userId}` | `SETTINGS` | – | Settings fields |
| Job | `USER#{userId}` | `JOB#{jobId}` | – | Job fields + `type="job"`, `userId`, `sessionId` (AgentCore session), `heartbeatAt`, `flowRun`, `flowExecutionArn` (§14.4) |
| Clip | `USER#{userId}` | `CLIP#{clipId}` | `JOB#{jobId}` / `CLIP#{rank:03d}` | Clip fields (minus URLs) + `type="clip"`, `userId`, `videoKey`, `coverKey`, `publishState`, `postsCreated`, `flowRun`, `flowExecutionArn` (§14.5) |
| Connection | `USER#{userId}` | `CONN#{connectionId}` | `CONN#{connectionId}` / `CONN` | `type="conn"`, `userId`, `connectionId`, `connectedAt`, `ttl` (§14.2) |
| Hook event | `HOOK#{platform}` | `HOOK#{hookId}` | – | `type="hook"`, `platform`, `receivedAt`, `headers`, `body`, `bodyEncoding`, `signature`, `ttl` (§14.3) |
| Skill | `USER#{userId}` | `SKILL#{skillId}` | – | Skill fields + `key` (S3) |
| Post | `USER#{userId}` | `POST#{postId}` | `CLIP#{clipId}` / `POST#{platform}` | Post fields |
| Learning | `USER#{userId}` | `LEARNING#{learningId}` | – | Learning fields |
| Account (later) | `USER#{userId}` | `ACCOUNT#{platform}#{id}` | – | handle, status (tokens never here; Secrets Manager later) |

Built-in skills are not items: the API lists `skills/*/SKILL.md` bundled in its package as `builtin: true` and stores
only the owner's enable/disable choice as `SKILL#builtin-<name>` items.

## 7. S3 media bucket `cf-prod-media-<accountId>` (private, SSE-S3, CORS for PUT from app origins)

| Prefix | What | Lifecycle |
|---|---|---|
| `uploads/{userId}/{uploadId}/{safeFilename}` | uploaded source videos | expire after 14 days |
| `jobs/{jobId}/source/` | `audio.m4a`, `video.mp4` (uploads only), `transcript.json` (Transcribe output), `words.json` (`[[start, end, word], …]`), `loudness.json` (dB per second), `meta.json` | expire after 14 days |
| `jobs/{jobId}/clips/{clipId}/` | `clip.mp4`, `cover.jpg` | kept |
| `skills/{userId}/{skillId}/` | `SKILL.md` or `skill.zip` | kept |
| `private/{userId}/youtube-cookies.txt` | optional cookies for yt-dlp | kept, never returned by the API |

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
* Skills: built-in skills from `/app/skills` plus the owner's **enabled** skills from S3 are written to
  `<workdir>/.claude/skills/<name>/SKILL.md` (zips extracted) so the Claude Agent SDK loads them; their text is also
  included in the moment-selection prompt. The agent also receives the owner's latest 10 learnings and the top 8
  similar past clips from S3 Vectors ("What worked before", §14.6).
* Pipeline steps (keys in §5): resolve (yt-dlp metadata / S3 head) → download (audio only for links; capped at
  `maxSourceHours`) → transcribe (Amazon Transcribe, word timestamps, language auto) → analyze (loudness spikes, chat
  of transcript windows) → select (Claude: 5–10 moments within `clipTarget`, six moment types, hooks) → render (ffmpeg:
  section download, facecam detection via Claude vision, 1080×1920, hook, ASS captions, cover) → checklist (skill
  section D, measured + Claude judgement, one fix pass, spares replace failures) → captions (per platform, required
  tags from the owner's notes) → finalize (job `ready`, `clipCount`).

### Agent environment variables
`CF_REGION`, `CF_TABLE`, `CF_MEDIA_BUCKET`, `CF_MODEL_ID`, `CF_SKILLS_DIR=/app/skills`, `CLAUDE_CODE_USE_BEDROCK=1`,
`ANTHROPIC_MODEL`, `AWS_REGION`, `CF_VECTOR_BUCKET`, `CF_VECTOR_INDEX=clips`,
`CF_EMBED_MODEL_ID=amazon.titan-embed-text-v2:0` (§14.6).

## 9. Lambdas (one zip `api/dist/lambda.zip`, Python 3.13, arm64, package `clipfactory_api`)

| Function | Handler | Trigger | Environment |
|---|---|---|---|
| `cf-prod-api` | `clipfactory_api.http.handler` | HTTP API (all routes) | `TABLE_NAME`, `MEDIA_BUCKET`, `AGENT_RUNTIME_ARN`, `JOB_FLOW_ARN`, `CLIP_FLOW_ARN`, `VECTOR_BUCKET`, `VECTOR_INDEX`, `APP_URL`, `VERSION` |
| `cf-prod-job-flow` (durable, alias `live`) | `clipfactory_api.flows.job_flow.handler` | async Invoke by `cf-prod-api` on the alias | `TABLE_NAME`, `AGENT_RUNTIME_ARN` |
| `cf-prod-clip-flow` (durable, alias `live`) | `clipfactory_api.flows.clip_flow.handler` | async Invoke by `cf-prod-api` on the alias | `TABLE_NAME`, `MEDIA_BUCKET`, `MODEL_ID`, `EMBED_MODEL_ID`, `VECTOR_BUCKET`, `VECTOR_INDEX` |
| `cf-prod-ws-authorizer` | `clipfactory_api.realtime.authorizer.handler` | WebSocket `$connect` REQUEST authorizer | `USER_POOL_ID`, `USER_POOL_CLIENT_ID` |
| `cf-prod-ws` | `clipfactory_api.realtime.ws.handler` | WebSocket routes `$connect`, `$disconnect`, `$default` | `TABLE_NAME`, `WS_ENDPOINT`, `CONN_TTL_SECONDS=7200` |
| `cf-prod-broadcast` | `clipfactory_api.realtime.broadcast.handler` | DynamoDB Streams on `cf-prod-data` (filtered) | `TABLE_NAME`, `WS_ENDPOINT` |
| `cf-prod-hooks` | `clipfactory_api.hooks.handler` | REST API `cf-prod-hooks` (all routes) | `TABLE_NAME`, `APP_URL`, `VERIFY_TOKEN_PARAM=/cf-prod/hooks/verify-token` |

Details of every new function, and what replaced `cf-prod-publisher`, `cf-prod-perf-check`, `cf-prod-watchdog`,
the SQS publish queue and the EventBridge resources: §14.

* Confirm → API writes one `Post` per enabled platform (`pending_integration` while no account is connected for that
  platform, `queued` when connected) and starts the durable `cf-prod-clip-flow` (§14.5), which publishes the `queued`
  ones through the platform adapter (adapters arrive in phase 2; today every platform is `pending_integration`), waits
  48 hours, reads metrics, distils one short Learning and updates the clip's vector.
* A `running` job whose agent stops sending heartbeats for 15 minutes becomes `failed` ("The agent stopped
  responding. Press Retry.") through the job-flow callback heartbeat timeout (§14.4), not a scan.

## 10. Terraform outputs (read by deploy.yml)

`app_url`, `api_url`, `region`, `user_pool_id`, `user_pool_client_id`, `web_bucket`, `distribution_id`,
`media_bucket`, `table_name`, `agent_runtime_arn`, `ecr_repository_url`, and from §14: `ws_url`, `hooks_url`,
`vector_bucket`, `vector_index`, `job_flow_alias_arn`, `clip_flow_alias_arn`. `write-web-config.sh` requires `ws_url`.

Terraform input variables (envs/prod): `region`, `owner_email`, `agent_image_tag`, `lambda_zip_path`
(default `../../../api/dist/lambda.zip`), `alarm_email` (optional), `web_dev_origin` (default `http://localhost:5173`),
`manage_api_gateway_account` (bool, default `true`, §14.3).

## 11. Design system (summary; details in docs/UX_DESIGN_SYSTEM.md)

* Colours: **Sage `#9CAF88`**, **Off-white `#F7F5EF`**, **Tomato `#E8412C` (every primary CTA)**, ink `#1E2A1B`.
  Every surface is **liquid glass**: translucent tints of these colours over a soft animated sage/off-white/tomato
  backdrop (or the owner's own background image), `backdrop-filter: blur() saturate()`, refractive highlight edges.
* Type: **Times New Roman** (fallback Tinos, then serif) for display headlines, often italic with a tomato underline
  swash; **Inter** for everything else.
* Layout inspiration: the "Sorrel" restaurant site: big serif italic headline on a sage hero card, pill buttons, cards
  in a row, a rating-style stat block.
* Navigation: phones (< 768 px): bottom glass tab bar, **icons only** (aria-labels). Larger screens: left glass sidebar,
  collapsible with a hamburger (collapsed = icons only).
* Sounds (Web Audio, no files): one **tap** sound on clicks of enabled interactive elements; a different **deny**
  sound on clicks of disabled ones and on errors. Driven only by the `click` event, so scrolling never makes a sound.
  Off switch in Settings.
* Nothing may overflow its box at any width from 320 px up (enforced by Playwright tests).
* Installable PWA (manifest + service worker) on phone and desktop.

## 12. Get the app, updates, and kid-proof UX (added by the owner after the first build)

### 12.1 "Get the app" (sidebar item; on phones a card in Settings plus a one-time banner on Home)
* Detect the device from `navigator.userAgentData` / user agent: `mac`, `windows`, `linux`, `ios`, `android`, `chromeos`.
* Offer what fits that device, one big button, plain words:
  * **Mac:** "Download for Mac" → `/downloads/Clip-Factory.dmg` (desktop wrapper, see 12.3). Secondary link:
    "or install from this browser" (PWA prompt where `beforeinstallprompt` exists).
  * **Windows:** "Download for Windows" → `/downloads/Clip-Factory-Setup.exe`. Secondary: browser install.
  * **Linux / ChromeOS:** browser install (PWA); Linux also `/downloads/Clip-Factory.AppImage` if listed.
  * **Android:** "Install app" via `beforeinstallprompt`; fallback picture steps (menu ⋮ → Install app).
  * **iPhone / iPad:** Apple allows no direct download: show 3 picture steps (Share icon → "Add to Home Screen" → Add),
    with the real Share icon drawn inline. In non-Safari iOS browsers, say "Open this page in Safari first".
* Which desktop files exist comes from `/downloads/manifest.json`
  `{version, files:{mac?:{path,size}, windows?:{path,size}, linux?:{path,size}}}` (no-cache). Missing file → fall back to
  browser install for that OS, never a dead link.
* **Never show "Get the app" when already installed:** hide when `matchMedia('(display-mode: standalone)')` or
  `(display-mode: window-controls-overlay)` matches, `navigator.standalone === true` (iOS), the desktop wrapper is
  detected (`window.__CF_DESKTOP__ === true` or user agent contains `ClipFactoryDesktop`), or after the `appinstalled`
  event (remembered in localStorage `cf.installed=1`). A "Not now" closes the Home banner for 30 days.

### 12.2 Update banner ("What's new" + Reload)
* Each deploy writes `/version.json` (no-cache): `{"version":"<git sha short>","builtAt":"<ISO>","areas":["Settings","Profile picture"]}`.
  The web build embeds its own version as `import.meta.env.VITE_APP_VERSION`.
* `areas` = at most 3 labels of 1–3 words, no sentences. Source, in order: commit trailers `Area: <label>` in the commits
  since the last deployed version; else changed files mapped through `web/areas.json` (`{"web/src/routes/settings": "Settings", ...}`,
  longest prefix wins); else `["Improvements"]`. Built by `scripts/release-areas.sh <prev-sha> <new-sha>` in deploy.yml
  (prev-sha read from the live `/version.json` in the web bucket; first deploy → `["First release"]`).
* The app checks `/version.json` on load, every 5 minutes, on `visibilitychange` to visible, and when the service
  worker finds a waiting worker. If `version` differs from its own: a glass bar slides up at the bottom (above the phone
  tab bar), showing a sparkle icon, the area labels as small pills (e.g. `Settings · Profile picture`), and a tomato
  **Reload** button. Visible in the browser and in installed apps. Dismissable ("Later") until the next check.
* Reload: a progress bar inside the bar animates with an ease-in-out curve: quick to ~75 % in ~0.8 s (slow start,
  fast middle, slow end), holds/creeps while the new service worker installs and activates (`skipWaiting` via
  postMessage) and fresh assets are fetched, then eases to 100 %, a small sparkle/confetti, then `location.reload()`.
  Cap at 10 s, then reload anyway. Reduced motion → simple fill.

### 12.3 Desktop wrapper (`desktop/`, Tauri v2)
* A thin native window that loads `app_url` (no bundled UI), window title "Clip Factory", the app icon, minimum size
  380×600, remembers size/position, external links open in the system browser, user agent suffix `ClipFactoryDesktop`,
  injects `window.__CF_DESKTOP__ = true`. Updates come from the website itself (the update banner), so the wrapper rarely changes.
* Built in deploy.yml after the web deploy (job `desktop`, matrix `macos-latest` → universal `.dmg`,
  `windows-latest` → NSIS `.exe`), app URL from terraform output, uploaded to the web bucket as
  `downloads/Clip-Factory.dmg` and `downloads/Clip-Factory-Setup.exe`, then `downloads/manifest.json` rewritten.
  Builds are unsigned (no Apple/Microsoft certificates yet): the Get-the-app card shows a one-line hint for the first
  open (Mac: System Settings → Privacy & Security → Open Anyway; Windows: More info → Run anyway). Signing is a roadmap item.
* Only rebuilt when `desktop/**` or the app icon changes, or when no file exists yet in the bucket.

### 12.4 Kid-proof UX (a 6–8-year-old must manage it)
* One obvious next step per screen (one tomato CTA), big targets (≥ 48 px on phones), icon + word on buttons
  (except the phone tab bar), short plain words (no jargon: "Make clips", "Keep", "Throw away"), friendly empty states
  that say exactly what to tap, no dead ends, every error says what to do next, destructive actions undoable for 8 s
  (toast with Undo) instead of scary dialogs, forms that can't be submitted wrong (paste button, auto-detect link,
  inline hints), progress always visible, celebrations on success.

## 13. Notes added after the final review

* **Confirm is safe to repeat** (rules in §14.5): starting `cf-prod-clip-flow` is idempotent on its durable execution
  name, so a repeat confirm restarts nothing. The web shows "Try again" for clips with `status: "failed"`. Internal
  clip fields `publishState`, `postsCreated`, `flowRun` and `flowExecutionArn` are never returned by the API
  (`publishClaimAt` is gone).
* **No watchdog.** The watchdog and its re-queue of stuck confirms are removed (§14.1); a confirm whose flow did not
  start is retried by the next confirm.
* **One run per job.** Every agent write to a Job is conditional on `sessionId` = the session it was invoked with; a
  retry gives the job a new `sessionId` and the old run stops quietly at its next write.
* **Long sources.** Audio longer than 3 h 50 min is split for Transcribe into `jobs/{jobId}/source/audio.part{i}.m4a`
  and `transcript.part{i}*.json` (temporary, tagged `cf-retention=temporary`, 14-day lifecycle like the rest of `source/`).
* **Distil outcomes** (the clip-flow `distil` step, formerly perf-check) include `max_tokens`, `refusal` and
  `content_filtered` (logged; no Learning written).
* **TLS.** With the default `*.cloudfront.net` certificate CloudFront's protocol floor cannot be raised; TLS 1.2+ is
  enforced once a custom domain with an ACM certificate is attached (roadmap).
* **Words in the UI** (§12.4): "Keep" (was Confirm), "Throw away" (was Decline/Delete), "Try again" (was Retry).

## 14. Serverless expansion: WebSocket API, REST API, durable functions, S3 Vectors

Everything stays serverless and in `eu-north-1`: CloudFront + S3 (web), S3 (media), S3 Vectors, DynamoDB, three API
Gateway APIs (HTTP for the app, WebSocket for live updates, REST for platform webhooks), Lambda (plain and durable),
AgentCore Runtime, Transcribe, Bedrock. Backend code is Python 3.13 (`api/`, `agent/`); infrastructure is Terraform
(`infra/`). No server, container service or VPC is added. Where this section and an earlier one disagree, this one wins.

### 14.1 What is removed (delete it from Terraform, code, tests and docs; nothing may still reference it)

| Removed | Replaced by |
|---|---|
| Lambda `cf-prod-publisher`, file `api/src/clipfactory_api/publisher.py` | `cf-prod-clip-flow` steps `ensure-posts` / `publish-{platform}` (§14.5) |
| Lambda `cf-prod-perf-check`, file `api/src/clipfactory_api/perf_check.py` | `cf-prod-clip-flow` wait + `metrics` / `distil` steps; the distil logic moves to `api/src/clipfactory_api/learn.py` |
| Lambda `cf-prod-watchdog`, file `api/src/clipfactory_api/watchdog.py` | `cf-prod-job-flow` callback heartbeat timeout (§14.4) |
| SQS `cf-prod-publish`, DLQ `cf-prod-publish-dlq`, their policies and the event source mapping | durable execution (no queue) |
| EventBridge Scheduler group `cf-prod`, role `cf-prod-scheduler`, one-time schedules `perf-{postId}` | `context.wait(48 h)` in `cf-prod-clip-flow` |
| EventBridge rule `cf-prod-watchdog` (rate 10 minutes), its target, permission and `event_invoke_config` | – |
| Env vars `PUBLISH_QUEUE_URL`, `PERF_CHECK_FUNCTION_ARN`, `SCHEDULER_ROLE_ARN`, `SCHEDULE_GROUP` | `JOB_FLOW_ARN`, `CLIP_FLOW_ARN` on `cf-prod-api` |
| Clip field `publishClaimAt`; clip `publishState` value `enqueued` | `publishState: "pending" \| "started"` (§14.5) |
| `api` module output `publish_dlq_name`; monitoring variable `dlq_name` and alarm `cf-prod-publish-dlq-not-empty` | durable-execution alarms (§14.9) |
| `infra/modules/api/tests/watchdog.tftest.hcl`; publisher/perf-check/watchdog cases in `api/tests/test_workers.py` | `infra/modules/flows/tests/*.tftest.hcl`, `api/tests/test_flows.py` (§14.12) |
| The API calling `InvokeAgentRuntime` with `process_job` | `cf-prod-job-flow` step `start-agent` (the API still sends `cancel`) |

Removing the old Lambdas, queue and schedules is a plain Terraform destroy on the next apply; no data migration is
needed (today every post is `pending_integration`, so no schedule or message is in flight).

### 14.2 Live updates: WebSocket API (Terraform module `realtime`)

**Resources.** `aws_apigatewayv2_api` `cf-prod-ws` (`protocol_type = "WEBSOCKET"`, `route_selection_expression =
"$request.body.action"`), stage `live` (`auto_deploy = true`), routes `$connect` (authorization `CUSTOM`, authorizer
below), `$disconnect`, `$default`, all `AWS_PROXY` integrations on `cf-prod-ws`. Authorizer `cf-prod-ws-token`:
`authorizer_type = "REQUEST"`, `identity_sources = ["route.request.querystring.token"]`, `authorizer_uri` = invoke ARN
of `cf-prod-ws-authorizer`. Do **not** set `authorizer_result_ttl_in_seconds`, `authorizer_payload_format_version` or
`enable_simple_responses` (HTTP-only; WebSocket authorizer results are never cached by API Gateway). Lambda
permissions for `apigateway.amazonaws.com` with source ARNs `${execution_arn}/*` (routes) and
`${execution_arn}/authorizers/*` (authorizer).

`ws_url` = `wss://{api-id}.execute-api.{region}.amazonaws.com/live`. `WS_ENDPOINT` (management API, used by
`cf-prod-ws` and `cf-prod-broadcast`) = `https://{api-id}.execute-api.{region}.amazonaws.com/live`, used as
`boto3.client("apigatewaymanagementapi", endpoint_url=WS_ENDPOINT)`.

**Logging (the token is in the query string, so it must never be logged).** Stage access log group
`/aws/apigateway/cf-prod-ws` (same retention as the others), JSON format with exactly: `requestId`, `connectionId`,
`eventType`, `routeKey`, `status`, `requestTime`, `integrationError`, `authorizerError`. No `$context.requestOverride.*`,
no query, no headers. `default_route_settings`: `logging_level = "ERROR"`, `data_trace_enabled = false`,
`throttling_rate_limit = 50`, `throttling_burst_limit = 100`. Execution logging relies on the account-level API Gateway
CloudWatch role (§14.3). The authorizer and handlers never log the token or the raw query string.

**`cf-prod-ws-authorizer`** (`clipfactory_api/realtime/authorizer.py`, 128 MB, 10 s). Pure standard-library RS256 check
of the Cognito **access** token: JWKS from `https://cognito-idp.{AWS_REGION}.amazonaws.com/{USER_POOL_ID}/.well-known/jwks.json`
(fetched with `urllib`, cached per container for 1 h; a `kid` not in the cache triggers one refetch), header `alg ==
"RS256"`, signature verified as PKCS#1 v1.5 with the SHA-256 DigestInfo prefix via `pow(sig, e, n)`, then claims
`iss == https://cognito-idp.{region}.amazonaws.com/{poolId}`, `token_use == "access"`, `client_id ==
USER_POOL_CLIENT_ID`, `exp > now` (no leeway), `sub` present. Valid tokens are cached per container by SHA-256 of the
token until `exp`. Result: `{ "principalId": sub, "policyDocument": { "Version": "2012-10-17", "Statement": [{
"Action": "execute-api:Invoke", "Effect": "Allow", "Resource": event["methodArn"] }] }, "context": { "sub": sub } }`.
Missing/invalid token: `raise Exception("Unauthorized")` (API Gateway answers 401). No AWS permissions beyond logs.

**`cf-prod-ws`** (`clipfactory_api/realtime/ws.py`, 128 MB, 10 s), dispatch on `requestContext.routeKey`:
* `$connect`: `sub = requestContext.authorizer.sub`; PutItem Connection `{pk: USER#{sub}, sk: CONN#{connectionId},
  gsi1pk: CONN#{connectionId}, gsi1sk: "CONN", type: "conn", userId, connectionId, connectedAt, ttl: now + 7200}`;
  return `{"statusCode": 200}`.
* `$disconnect`: `sub` from `requestContext.authorizer.sub` if present, else Query `gsi1` on `CONN#{connectionId}`;
  DeleteItem; always 200.
* `$default`: body `{"action": "ping"}` → PostToConnection `{"type": "pong", "at": "<ISO>"}`; anything else →
  `{"type": "error", "code": "bad_request"}`; always 200.
* IAM: `dynamodb:PutItem`, `dynamodb:DeleteItem`, `dynamodb:Query` on the table and `index/*`;
  `execute-api:ManageConnections` on `arn:aws:execute-api:{region}:{acct}:{wsApiId}/live/POST/@connections/*`.

**`cf-prod-broadcast`** (`clipfactory_api/realtime/broadcast.py`, 256 MB, 60 s).
* Table `cf-prod-data` gets `stream_enabled = true`, `stream_view_type = "NEW_AND_OLD_IMAGES"` (module `data`, output
  `stream_arn`).
* `aws_lambda_event_source_mapping`: `starting_position = "LATEST"`, `batch_size = 100`,
  `maximum_batching_window_in_seconds = 1`, `maximum_retry_attempts = 2`, `maximum_record_age_in_seconds = 600`,
  `bisect_batch_on_function_error = true`, `function_response_types = ["ReportBatchItemFailures"]`, and exactly one filter:
  `pattern = jsonencode({ dynamodb = { Keys = { sk = { S = [{ prefix = "JOB#" }, { prefix = "CLIP#" }, { prefix = "POST#" }, { prefix = "LEARNING#" }] } } } })`.
  (So `CONN#`, `HOOK#`, `SETTINGS`, `SKILL#` changes never reach it.)
* Per batch: keep only the last record per (`pk`, `sk`) (heartbeats coalesce); `userId` = `pk` minus `USER#`; `type`
  from the `sk` prefix (`JOB#`→`job`, `CLIP#`→`clip`, `POST#`→`post`, `LEARNING#`→`learning`); INSERT/MODIFY →
  `op: "upsert"` from `NewImage`, REMOVE → `op: "delete"` from `OldImage`. Query the owner's connections
  (`pk = USER#{userId}`, `begins_with(sk, "CONN#")`) and PostToConnection to each. `GoneException` (410) → DeleteItem the
  Connection. Other post errors are logged and skipped (the web refetches on reconnect). Only a failed DynamoDB query
  reports the record as a batch item failure.
* Event (UTF-8 JSON, one message per changed item):
  ```ts
  type LiveEvent =
    | { type: "job"; op: "upsert"; id: string; item: Job }
    | { type: "clip"; op: "upsert"; id: string; item: Clip /* without videoUrl/coverUrl */ }
    | { type: "post"; op: "upsert"; id: string; item: Post }
    | { type: "learning"; op: "upsert"; id: string; item: Learning }
    | { type: "job" | "clip" | "post" | "learning"; op: "delete"; id: string }
    | { type: "job" | "clip" | "post" | "learning"; op: "upsert"; id: string; partial: true } // item too big: refetch
    | { type: "pong"; at: string } | { type: "error"; code: "bad_request" };
  ```
  `item` is built by the **same public-shape functions the HTTP API uses** (`jobs.public_job`, `clips.public_clip`
  without presigning, `posts.public_post`, the Learning shape), so internal fields (`sessionId`, `videoKey`,
  `publishState`, `flowExecutionArn`, …) never leave. If the serialized event exceeds 24 KB (frame limit 32 KB) send
  the `partial: true` form instead.
* IAM: `dynamodb:Query`, `dynamodb:DeleteItem` on the table; `dynamodb:DescribeStream`, `GetRecords`,
  `GetShardIterator`, `ListStreams` on the stream ARN; `execute-api:ManageConnections` as for `cf-prod-ws`.

**Web.** `web/src/lib/live.ts` (one shared connection for the signed-in app):
* Connect to `${wsUrl}?token=${encodeURIComponent(accessToken)}` with a fresh token from `fetchAuthSession()` on every
  attempt. Reconnect on any close with backoff 1, 2, 4, 8, 16, 30 s (cap 30 s, ±20 % jitter), reset after 60 s connected.
  Send `{"action":"ping"}` every 5 minutes (idle timeout is 10 min). Reconnect proactively after 110 minutes (2-hour
  connection cap). Close on sign-out; pause while `document.hidden` for > 5 minutes and resume on visible.
* Events update the screen caches in place (job list and detail, clip lists, Review, Library, posts, Insights); a
  `clip` upsert keeps the cached `videoUrl`/`coverUrl` (or refetches the clip when it has none); `partial: true` and
  each reconnect trigger a refetch of what is on screen.
* Polling stays as the fallback: the existing polls (e.g. `screens/jobs/Jobs.tsx`) run at their current intervals
  **only while disconnected**, and slow to every 30 s while live. No `wsUrl` (mock mode) → polling only.
* CSP (`infra/modules/frontend`): `connect-src` adds `wss://*.execute-api.${var.region}.amazonaws.com`.
* No visible UI beyond an optional small "Live" dot; never an error toast for a dropped socket.

### 14.3 Platform webhooks: REST API (Terraform module `hooks`)

**Resources.** `aws_api_gateway_rest_api` `cf-prod-hooks` (`endpoint_configuration { types = ["REGIONAL"] }`),
resources `/hooks/{platform}` and `/oauth/{platform}/callback`, methods `GET /hooks/{platform}`, `POST /hooks/{platform}`,
`GET /oauth/{platform}/callback`, `authorization = "NONE"`, `request_parameters = { "method.request.path.platform" =
true }`, request validator `cf-prod-hooks-params` (`validate_request_parameters = true`, `validate_request_body =
false`; webhook bodies vary per platform), `AWS_PROXY` integrations on `cf-prod-hooks`. `aws_api_gateway_deployment`
(with `triggers` = sha of the resources/methods/integrations) and stage `v1`: `xray_tracing_enabled = true`, access
log group `/aws/apigateway/cf-prod-hooks` with a JSON format of `requestId`, `ip`, `httpMethod`, `resourcePath`, `status`,
`responseLength`, `requestTime`, `integrationLatency` (**no query string**: OAuth callbacks carry `code`/`state`).
`aws_api_gateway_method_settings` `*/*`: `metrics_enabled = true`, `logging_level = "ERROR"`, `data_trace_enabled =
false`, `throttling_rate_limit = 10`, `throttling_burst_limit = 20`. `aws_api_gateway_usage_plan` `cf-prod-hooks` on
stage `v1` (throttle 10 rps / burst 20, quota 100 000 per month); no API key is required (platforms cannot send one), so
the per-method throttle is the effective limit and the usage plan is the ceiling for keyed clients later.

`hooks_url` = the stage invoke URL, `https://{id}.execute-api.{region}.amazonaws.com/v1`. Platform consoles get
`{hooks_url}/hooks/{platform}` and `{hooks_url}/oauth/{platform}/callback` (phase 2).

**Account-level logging role (per account and Region singleton).** `aws_iam_role` `cf-prod-apigw-cloudwatch` (trusted
by `apigateway.amazonaws.com`, managed policy `AmazonAPIGatewayPushToCloudWatchLogs`) and `aws_api_gateway_account {
cloudwatch_role_arn }`, both behind `var.manage_api_gateway_account` (default `true`; set `false` when the account's
setting is managed elsewhere, then that role must already exist). Needed by REST execution/access logs and WebSocket
logs. Serialize deployments (CreateDeployment is limited to 1 per 5 s per account): in `envs/prod`,
`module "realtime"` has `depends_on = [module.hooks]`.

**SSM.** `aws_ssm_parameter` `/cf-prod/hooks/verify-token`, `type = "SecureString"` (AWS managed key `aws/ssm`), value
from `ephemeral "random_password"` (length 40, `special = false`) written with `value_wo` / `value_wo_version = 1` so it
never enters the state. Adds provider `hashicorp/random` `>= 3.7.0, < 4.0.0` to `envs/prod` and the `hooks` module. The
owner reads it from the console when registering Meta webhooks.

**`cf-prod-hooks`** (`clipfactory_api/hooks.py`, 256 MB, 10 s). `platform` must be one of `youtube`, `instagram`,
`facebook`, `tiktok`, `x`, else 404 `not_found`. JSON errors use the §5 shape.
* `GET /hooks/{platform}` (verification):
  * `instagram`, `facebook` (Meta): `hub.mode == "subscribe"` and `hub.verify_token` equal (constant-time compare) to the
    SSM value (`GetParameter WithDecryption`, cached per container 5 min) → `200 text/plain` body = `hub.challenge`;
    wrong/missing → `403 forbidden`.
  * `youtube` (PubSubHubbub): `hub.mode` in `subscribe`/`unsubscribe`, `hub.topic` starting with
    `https://www.youtube.com/xml/feeds/videos.xml`, `hub.challenge` present → `200 text/plain` = `hub.challenge`; else
    `400 bad_request`.
  * `tiktok`, `x` → `501 not_implemented` until phase 2.
* `POST /hooks/{platform}`: body > 256 KB → `413 too_large`. `verify_signature(platform, headers, raw_body)` returns
  `"valid" | "unverified" | "invalid"`; phase 1 stub returns `"unverified"` for every platform (no app secrets yet);
  `"invalid"` → `401 unauthorized`. Otherwise PutItem Hook event `{pk: HOOK#{platform}, sk: HOOK#{hookId(ULID)}, type:
  "hook", platform, receivedAt, headers: {content-type, user-agent, x-hub-signature-256, x-hub-signature, x-tiktok-signature,
  x-twitter-webhooks-signature (only those present)}, body (raw text, or base64 when API Gateway flagged it),
  bodyEncoding: "text"|"base64", signature, ttl: now + 14 days}` and return `200 {"ok": true}`. Nothing else runs inline.
* `GET /oauth/{platform}/callback`: `302 Location: {APP_URL}/settings?account={platform}&status=coming_soon` (query
  parameters ignored and never logged) until phase 2. The web Settings screen shows "Connecting {Platform} arrives
  soon." for that query.
* IAM: `dynamodb:PutItem` on the table; `ssm:GetParameter` on
  `arn:aws:ssm:{region}:{acct}:parameter/cf-prod/hooks/verify-token` (the `aws/ssm` key needs no IAM statement).

### 14.4 Durable function `cf-prod-job-flow` (Terraform module `flows`)

Replaces the watchdog. Python SDK `aws-durable-execution-sdk-python` (synchronous API). File
`clipfactory_api/flows/job_flow.py`: `@durable_execution def handler(event, context: DurableContext)` is a thin
wrapper around `run_job_flow(ctx, event, deps)` so tests drive it with a fake context.

* **Start (by `cf-prod-api`).** On `POST /v1/jobs` and `POST /v1/jobs/{id}/retry` the API writes the Job (`queued`, new
  `sessionId`, `flowRun` = 1 on create, previous + 1 on retry) and then calls
  `lambda.invoke(FunctionName=JOB_FLOW_ARN, InvocationType="Event", DurableExecutionName=f"job-{jobId}-{flowRun}",
  Payload=json.dumps({"jobId", "userId", "sessionId", "run": flowRun}, sort_keys=True))`. `JOB_FLOW_ARN` is the
  **alias ARN** `arn:aws:lambda:{region}:{acct}:function:cf-prod-job-flow:live` (never unqualified, never `$LATEST`).
  The payload has no timestamps so a repeated start is identical. `DurableExecutionAlreadyStartedException` = already
  started (no-op). The `DurableExecutionArn` response header, when present, is stored as `flowExecutionArn`. If the
  invoke fails the job becomes `failed` with "Could not start. Press Try again." and the route still returns 201/200.
* **Steps** (names are contract; all DynamoDB writes are conditional on `sessionId = :sessionId`, so a superseded run
  never overwrites a newer one, and on the job not already being in the target state):
  1. `cb = context.create_callback(name="agent-done", config=CallbackConfig(timeout=Duration.from_hours(8),
     heartbeat_timeout=Duration.from_minutes(15)))`.
  2. Step `start-agent` (retry: 3 attempts, exponential backoff, retryable on throttling/5xx/connection errors):
     GetItem the Job. Missing, another `sessionId`, or a terminal status (canceled or retried meanwhile) → return
     `{"skipped": true}` and the flow ends with outcome `superseded` without waiting. Already `running` with this
     `sessionId` → an earlier attempt of this step reached the agent: do not invoke again, go on to wait for the
     callback. Still `queued` → `InvokeAgentRuntime`
     (`runtimeSessionId = sessionId`, payload `{"action": "process_job", "jobId", "userId", "callbackId": cb.callback_id}`).
     The agent ignores a duplicate `process_job` (at-least-once step).
  3. `result = cb.result()` (no compute while waiting). Success → step `finish`: if the Job is not `ready`, set
     `ready` and `clipCount` from the result. Outcome `ready`.
  4. `CallbackError` → step `fail`: if the Job is `queued`/`running` with this `sessionId`, set `failed` with `error` =
     the agent's `ErrorMessage` when `ErrorType == "JobFailed"`, else "The agent stopped responding. Press Retry."
     (timeout or missed heartbeat); then step `stop-session` (`StopRuntimeSession`, errors ignored). `ErrorType`
     `Canceled` / `Superseded` → no write (the API or the newer run already set the state). Outcome `failed` /
     `canceled` / `superseded`.
  The handler returns `{"jobId", "outcome"}` and never raises for these expected outcomes, so `DurableExecutionFailed`
  means a bug.
* **Agent side of the callback** (`agent/src/clipfactory_agent/callback.py`, boto3 `lambda` client in `CF_REGION`):
  * Heartbeat: `send_durable_execution_callback_heartbeat(CallbackId=...)` from the existing job heartbeat loop, at most
    once per 5 minutes (timeout is 15). Failures are logged, never fatal.
  * Success after `finalize` wrote the Job `ready`: `send_durable_execution_callback_success(CallbackId=...,
    Result=json.dumps({"jobId", "clipCount"}).encode())`.
  * Failure: `send_durable_execution_callback_failure(CallbackId=..., Error={"ErrorType": "JobFailed" | "Canceled" |
    "Superseded", "ErrorMessage": <the Job's plain-sentence error, ≤ 256 chars>})`, `JobFailed` after the agent wrote
    the Job `failed`, `Canceled` after a cancel, `Superseded` when the session fence (§13 "One run per job") stops it.
  * Each send retries 3 times on throttling/5xx; "callback already closed / not found / timed out" errors are ignored.
  * IAM on the AgentCore runtime role: `lambda:SendDurableExecutionCallbackSuccess`,
    `lambda:SendDurableExecutionCallbackFailure`, `lambda:SendDurableExecutionCallbackHeartbeat` on
    `arn:aws:lambda:{region}:{acct}:function:cf-prod-job-flow:*` (built from the name in the `agent` module, no module
    reference, to avoid a cycle).
* **Cancel** is unchanged in the API (Job `canceled`, agent `cancel`, `StopRuntimeSession`); the agent sends `Canceled`,
  or, if the container is already gone, the heartbeat timeout ends the flow and step `fail` writes nothing.
* **Terraform:** `publish = true`, `aws_lambda_alias` `live` (`function_version = aws_lambda_function.job_flow.version`),
  `durable_config { execution_timeout = 30600, retention_period = 14 }`, `timeouts { delete = "60m" }`, runtime
  `python3.13`, arm64, 256 MB, function timeout 120 s, X-Ray active, JSON logs to `/aws/lambda/cf-prod-job-flow`. No
  Lambda destinations (unsupported for durable functions). Durable config can only be set at creation, so these are
  new functions. Old versions are kept (running executions stay pinned to the version they started on).
* **IAM (role `cf-prod-fn-job-flow`):** managed policy `AWSLambdaBasicDurableExecutionRolePolicy`
  (`lambda:CheckpointDurableExecution`, `lambda:GetDurableExecutionState` on `function:cf-prod-job-flow:*` + logs);
  `dynamodb:GetItem`, `dynamodb:UpdateItem` on the table; `bedrock-agentcore:InvokeAgentRuntime`,
  `bedrock-agentcore:StopRuntimeSession` on the runtime ARN and `/*`; X-Ray.
* **API IAM:** `lambda:InvokeFunction` on `arn:aws:lambda:{region}:{acct}:function:cf-prod-job-flow:*` and
  `...:function:cf-prod-clip-flow:*`. The API loses `sqs:SendMessage`.

### 14.5 Durable function `cf-prod-clip-flow` (Terraform module `flows`)

Replaces the publish queue, DLQ, publisher, Scheduler group/role and perf-check. File
`clipfactory_api/flows/clip_flow.py` (`handler` + `run_clip_flow(ctx, event, deps)`). Shared logic lives in
`clipfactory_api/posts.py` (post creation), `platforms/` (adapters), `learn.py` (distil) and `vectors.py` (§14.6).

* **Confirm rules** (`POST /v1/clips/{id}/confirm`):
  * `review` → one TransactWriteItems: the Clip becomes `confirmed` (`decidedAt`, `publishState: "pending"`,
    `postsCreated: true`, `flowRun: 1`, captions applied) **and** one Post per enabled platform, conditional on the
    clip still being `review` and `attribute_not_exists(postsCreated)`. Then start the flow; on success set
    `publishState: "started"` (+ `flowExecutionArn`). Response `{clip, posts}`.
  * `confirmed`/`publishing` with `publishState: "pending"` → start the flow again at once (same name and payload, so it
    is idempotent), 200. With `publishState: "started"` or status `posted` → 200 no-op with the current `{clip, posts}`.
  * `failed` (clip-flow ended with every queued post failed) → "Try again": `flowRun + 1`, failed posts back to
    `queued`, status `confirmed`, `publishState: "pending"`, start `clip-{clipId}-{flowRun}`, 200.
  * `declined` → 409 `conflict`.
* **Start:** `lambda.invoke(FunctionName=CLIP_FLOW_ARN /* alias ...:function:cf-prod-clip-flow:live */,
  InvocationType="Event", DurableExecutionName=f"clip-{clipId}-{flowRun}", Payload=json.dumps({"clipId", "userId",
  "run": flowRun}, sort_keys=True))`; `DurableExecutionAlreadyStartedException` = no-op. Names stay ≤ 64 chars of
  `[A-Za-z0-9-_]` (ULIDs qualify).
* **Steps** (names are contract; every step is idempotent because steps are at-least-once):
  1. `ensure-posts`: `posts.create_for_clip` (no-op when `postsCreated`; the same function the API uses), then if any
     post is `queued` set the clip `publishing`. Returns `[{postId, platform, status}]`.
  2. `publish-{platform}` for each `queued` post only (`pending_integration` posts are skipped, no step): adapter
     `publish(post, idempotency_key=postId)`; retry 3 attempts, exponential backoff, `retryable_error_types =
     [RetryablePublishError]`, `StepSemantics.AT_LEAST_ONCE_PER_RETRY` (an adapter whose platform has no idempotency
     key uses `AT_MOST_ONCE_PER_RETRY`). Post update conditional on `status = queued`: `posted`, `url`, `postedAt`,
     `perfCheckAt = postedAt + 48 h`. Exhausted retries (`StepError`) → step `post-failed-{platform}` sets the post
     `failed` with a plain `error`.
  3. `settle-clip`: clip `posted` if ≥ 1 post is `posted`; `failed` if every queued post failed; `confirmed` if none
     was queued. If nothing was posted: step `upsert-vector` (status `confirmed`) and return outcome `not_posted` (today's
     path, while every platform is `pending_integration`).
  4. `context.wait(Duration.from_hours(48), name="wait-48h")`: no compute, no schedule.
  5. `metrics`: for each posted post, adapter metrics → `metrics` (`checkedAt`) on the Post; a platform that fails
     after 3 attempts is skipped.
  6. `distil`: `learn.distil(user_id)`: Bedrock **Converse** with `MODEL_ID` (`global.anthropic.claude-fable-5-1`),
     `inferenceConfig={"maxTokens": 4000}` (room for adaptive thinking + one sentence), no `temperature`/`topP`/`topK`,
     `additionalModelRequestFields={"output_config": {"effort": "low"}}` (as perf-check did). Writes one Learning; outcomes
     `max_tokens`, `refusal`, `content_filtered`, `no_learning` write nothing (§13).
  7. `upsert-vector`: §14.6, status `performed`, `performance` = sums over the measured posts.
  Returns `{"clipId", "outcome": "done" | "not_posted", "learningId"?}`.
* **Terraform:** like job-flow, with `durable_config { execution_timeout = 259200, retention_period = 14 }` (48 h wait +
  publish/metrics/distil, 3 days), 512 MB, function timeout 900 s, log group `/aws/lambda/cf-prod-clip-flow`.
* **IAM (role `cf-prod-fn-clip-flow`):** `AWSLambdaBasicDurableExecutionRolePolicy`; the table read/write set the API uses
  (`GetItem`, `PutItem`, `UpdateItem`, `Query`, `BatchGetItem`, `TransactWriteItems`, `ConditionCheckItem`) on the table
  and `index/*`; `s3:GetObject` on `${media_bucket_arn}/jobs/*` (phase-2 uploads); `bedrock:InvokeModel` on `model_invoke_arns` (Fable
  profile + `foundation-model/anthropic.claude-fable-5-1` in any Region) and on the Titan ARN; `s3vectors:GetVectors`,
  `s3vectors:PutVectors` on the index ARN; X-Ray.

### 14.6 S3 Vectors: "what worked before" (Terraform module `vectors`)

* **Resources:** `aws_s3vectors_vector_bucket` `cf-prod-vectors-{accountId}` (default SSE-S3, `force_destroy = false`);
  `aws_s3vectors_index` `clips`: `data_type = "float32"`, `dimension = 1024`, `distance_metric = "cosine"`,
  `metadata_configuration { non_filterable_metadata_keys = ["hook", "title", "summary", "performance"] }`. Every argument
  forces replacement, so these values are frozen (a new key needs a new index). Outputs `vector_bucket`,
  `vector_bucket_arn`, `vector_index` (`clips`), `vector_index_arn`.
* **Embeddings:** Titan Text Embeddings V2 via `bedrock-runtime` **InvokeModel** (not Converse), body
  `{"inputText": text, "dimensions": 1024, "normalize": true}`, read `embedding`; sent to S3 Vectors as
  `{"float32": [...]}`. **Clip text (identical in `api` and `agent`, both test it against the same fixture):**
  `f"{momentType}\n{hook}\n{captions['youtubeTitle']}\n{summary}"[:8000]`.
* **Vector:** `key = clipId`; filterable metadata `userId` (string), `momentType` (string), `platforms` (list of
  strings: the enabled platforms at finalize, the posted ones after the check), `status` (`"review" | "confirmed" |
  "performed"`), `scoreBucket` (`"low"` score ≤ 4, `"mid"` 5–7, `"high"` ≥ 8); non-filterable `hook`, `title`
  (`youtubeTitle`), `summary`, `performance` (JSON string of `Performance`, absent until measured). Filterable metadata
  stays under 2 KB.
* **Who writes/reads:**

  | Who | When | Calls | IAM (index ARN unless noted) |
  |---|---|---|---|
  | agent | finalize: one `PutVectors` for all new clips, status `review` | Titan + `put_vectors` | `s3vectors:PutVectors`, `bedrock:InvokeModel` on the Titan ARN |
  | agent | before `select`: query text `f"{title}\n{channel}\n{notes}\n{transcript[:4000]}"`, `topK=8`, filter `{"$and": [{"userId": {"$eq": sub}}, {"status": {"$eq": "performed"}}]}`; fewer than 3 hits → again with `{"userId": {"$eq": sub}}` only; any error → skip, log `vectors.query_failed` | Titan + `query_vectors(returnMetadata=True, returnDistance=True)` | `s3vectors:QueryVectors`, `s3vectors:GetVectors` |
  | clip-flow | `upsert-vector`: `get_vectors(keys=[clipId], returnData=True, returnMetadata=True)`, merge metadata, `put_vectors`; vector missing → embed from the Clip item | as listed | `s3vectors:GetVectors`, `s3vectors:PutVectors`, Titan |
  | api | decline: `delete_vectors(keys=[clipId])` (errors logged, never fail the route) | | `s3vectors:DeleteVectors` |
  | api | `GET /v1/clips/{id}/similar` | see below | `s3vectors:GetVectors`, `s3vectors:QueryVectors` |

  The agent's prompt section is titled "What worked before" and lists per hit: moment type, hook, title, summary,
  performance (views, likes) and similarity; it is advice, never a rule.
* **`GET /v1/clips/{clipId}/similar`** (`routes/clips.py`, `vectors.py`): 404 if the clip is not the caller's;
  `get_vectors(keys=[clipId], returnData=True)` (none → `{"clips": []}`); `query_vectors(topK=6, filter={"$and":
  [{"userId": {"$eq": sub}}, {"status": {"$eq": "performed"}}]}, returnMetadata=True, returnDistance=True)`; drop the clip
  itself; `similarity = round(1 - distance, 2)`; BatchGetItem the hits' Clip items (drop missing/declined) to add a
  presigned `coverUrl`; return at most 5 as `SimilarClip[]` sorted by similarity. Vector errors → `{"clips": []}` + log.
* **Web:** Review and Library show a "Like clips that did well" strip (cover, hook, views) under the clip, hidden when
  empty; mock mode has fixtures.

### 14.7 Decision: OpenSearch is not deployed

OpenSearch Serverless bills a standing minimum of OCUs whenever a collection exists, while S3 Vectors already gives
per-request-priced vector search with metadata filters for this single-owner app. If keyword or hybrid search is
needed later, S3 Vectors can be exported to OpenSearch Serverless (a **preview** integration through OpenSearch
Ingestion, not GA). The architecture diagram shows OpenSearch Serverless as a dashed "not deployed (option)" box.
Recorded as an ADR in `docs/DECISIONS.md`.

### 14.8 Terraform layout, wiring, outputs

```
infra/modules/
  data/       + stream_enabled, stream_view_type = NEW_AND_OLD_IMAGES; output stream_arn
  api/        only cf-prod-api + the HTTP API (queue, DLQ, scheduler, watchdog, publisher, perf-check removed);
              new inputs job_flow_arn_prefix, clip_flow_arn_prefix (function:NAME, for IAM ":*"), job_flow_alias_arn,
              clip_flow_alias_arn, vector_bucket, vector_index, vector_index_arn; output function_names = { api = ... }
  flows/      NEW: cf-prod-job-flow, cf-prod-clip-flow (+ roles, log groups, alias live, durable_config)
              inputs: name, region, account_id, lambda_zip_path, table_name/arn, media_bucket/_arn, agent_runtime_arn,
              model_id, model_invoke_arns, embed_model_id, embed_model_arn, vector_bucket, vector_index, vector_index_arn,
              log_retention_days; outputs job_flow_alias_arn, clip_flow_alias_arn, function_names, durable_function_names
  realtime/   NEW: cf-prod-ws API + stage live, authorizer, cf-prod-ws-authorizer, cf-prod-ws, cf-prod-broadcast, ESM
              inputs: name, region, account_id, lambda_zip_path, table_name/arn, stream_arn, user_pool_id,
              user_pool_client_id, log_retention_days; outputs ws_url, ws_api_id, ws_endpoint, function_names
  hooks/      NEW: cf-prod-hooks REST API + stage v1 + usage plan, cf-prod-hooks Lambda, SSM verify token,
              API Gateway account CloudWatch role (var.manage_api_gateway_account)
              inputs: name, region, account_id, lambda_zip_path, table_name/arn, app_url, log_retention_days,
              manage_api_gateway_account; outputs hooks_url, hooks_api_id, verify_token_parameter, function_names
  vectors/    NEW: vector bucket + index clips; outputs vector_bucket, vector_bucket_arn, vector_index, vector_index_arn
  agent/      + env CF_VECTOR_BUCKET, CF_VECTOR_INDEX, CF_EMBED_MODEL_ID; + IAM: callbacks (§14.4), S3 Vectors and
              Titan (§14.6); new inputs vector_bucket, vector_index, vector_index_arn, embed_model_id, embed_model_arn
  monitoring/ − dlq alarm/var; + durable alarms, broadcast iterator-age alarm (§14.9);
              inputs function_names (merged map of every module's function_names), durable_function_names
  frontend/   CSP connect-src + wss://*.execute-api.<region>.amazonaws.com
```
All Lambdas share one zip (`var.lambda_zip_path`), python3.13, arm64, JSON logs, X-Ray active, log retention as today.
Function ARNs used in another module's IAM are built from names (`arn:aws:lambda:{region}:{acct}:function:{name}`), as
the existing code does, so modules never form a cycle. `envs/prod` wiring: `flows` uses `agent`, `data`, `storage`,
`vectors`; `api` uses `flows` and `vectors`; `realtime` uses `data`, `auth` and `depends_on = [module.hooks]`;
`hooks` uses `data`, `frontend`. New env outputs (§10): `ws_url = module.realtime.ws_url`, `hooks_url =
module.hooks.hooks_url`, `vector_bucket`, `vector_index`, `job_flow_alias_arn`, `clip_flow_alias_arn`.

### 14.9 Monitoring (SNS topic `cf-prod-alarms` as today)

* `Errors > 0` (5 min, Sum, alarm `{fn}-errors` as today) for `cf-prod-api`, `cf-prod-job-flow`, `cf-prod-clip-flow`,
  `cf-prod-ws`, `cf-prod-broadcast`, `cf-prod-hooks`. Not for `cf-prod-ws-authorizer`: rejecting a token raises by
  design, so its `realtime` `function_names` output leaves it out.
* `AWS/Lambda` `DurableExecutionFailed > 0` and `DurableExecutionTimedOut > 0` (dimension `FunctionName`, 5 min, Sum,
  `notBreaching`) for `cf-prod-job-flow` and `cf-prod-clip-flow`: names `{fn}-durable-failed`, `{fn}-durable-timed-out`.
* `cf-prod-broadcast-iterator-age`: `IteratorAge` Maximum > 300 000 ms for 3 × 5 min.
* `cf-prod-hooks-5xx`: `AWS/ApiGateway` `5XXError` Sum > 0 on `ApiName = cf-prod-hooks`, stage `v1`.

### 14.10 Packaging, CI/CD, deploy role

* `api/pyproject.toml` dependencies: `boto3>=1.43` (must expose `invoke(..., DurableExecutionName=...)`,
  `send_durable_execution_callback_*` and the `s3vectors` client; a unit test asserts these exist in the vendored copy)
  and `aws-durable-execution-sdk-python` pinned to its current major version (`>=X,<X+1`, exact version in `uv.lock`).
  `api/scripts/build_lambda.py` vendors both into `api/dist/lambda.zip`; the HTTP/realtime/hooks handlers never import
  the durable SDK (cold starts). The agent image's boto3 must meet the same floor.
* `scripts/write-web-config.sh` writes `wsUrl` from `ws_url` (required). `deploy.yml` needs no new job: the zip and
  `terraform apply` cover the new functions.
* `docs/DEPLOYMENT.md` lists the extra permissions the OIDC deploy role (`CF_DEPLOY_ROLE_ARN`) needs: `s3vectors:*` on
  `bucket/cf-prod-vectors-*`; `apigateway:*` on `/restapis*`, `/apis*`, `/account`, `/usageplans*`; `ssm:PutParameter`,
  `GetParameter(s)`, `DeleteParameter`, `AddTagsToResource`, `ListTagsForResource`, `DescribeParameters` on
  `parameter/cf-prod/*`; `lambda:*` on `function:cf-prod-*` (including `PublishVersion`, alias and durable-execution
  actions, `ListDurableExecutionsByFunction`, `StopDurableExecution` used during destroy); `iam:PassRole` for
  `cf-prod-apigw-cloudwatch`; `dynamodb:DescribeStream`/`ListStreams`. The Bedrock `aws_review` data-retention opt-in for
  Fable 5.1 is a one-time owner step there too.
* `docs/architecture/aws-architecture.drawio` and `docs/ARCHITECTURE.md` show: CloudFront+S3 web, Cognito, HTTP API →
  `cf-prod-api`, WebSocket API → authorizer / `cf-prod-ws`, DynamoDB stream → `cf-prod-broadcast` → WebSocket, REST API →
  `cf-prod-hooks` (+ SSM), `cf-prod-job-flow` ↔ AgentCore (callback), `cf-prod-clip-flow` (48 h wait) → Bedrock (Fable,
  Titan) and S3 Vectors, Transcribe, ECR, media bucket, CloudWatch/SNS, GitHub OIDC, and OpenSearch Serverless dashed
  "not deployed".

### 14.11 Who builds what (parallel builders; each stays inside its files)

| Builder | Owns |
|---|---|
| infra | `infra/**` (all modules above, tftests), `config/models.json` |
| api-core | `api/src/clipfactory_api/{http,app,clips,jobs,posts,learn,vectors}.py`, `routes/*`, `platforms/*`, `api/scripts/build_lambda.py`, `api/pyproject.toml`, `uv.lock`, related tests; deletes publisher/perf_check/watchdog |
| api-flows | `api/src/clipfactory_api/flows/{__init__,job_flow,clip_flow}.py`, `tests/test_flows.py`, the fake durable context in `tests/fakes.py` |
| api-edge | `api/src/clipfactory_api/realtime/{__init__,authorizer,ws,broadcast}.py`, `hooks.py`, their tests |
| agent | `agent/**` (callback, vectors, "What worked before", duplicate `process_job`) |
| web + ci/docs | `web/**` (live.ts, polling fallback, similar strip, Settings `coming_soon`), `scripts/write-web-config.sh`, `.github/**`, `docs/**` except this file |

Shared function names across builders: `posts.create_for_clip(store, user_id, clip, settings, now) -> list[Post]`,
`learn.distil(store, bedrock, model_id, user_id) -> str` (outcome), `vectors.embed_text(clip) -> str`,
`vectors.upsert_clip(...)`, `vectors.delete_clip(user_id, clip_id)`, `vectors.similar(user_id, clip_id, k=5)`,
`jobs.public_job`, `clips.public_clip(item, with_urls: bool)`, `posts.public_post`.

### 14.12 Test expectations (all run offline in CI: no AWS calls, fakes only)

* **api** (`pytest`): job create/retry invokes the **alias** ARN with `InvocationType="Event"`, the exact
  `DurableExecutionName` and a deterministic payload; `DurableExecutionAlreadyStartedException` is a no-op; confirm
  rules of §14.5 (review, pending, started, failed → `-2` name, declined 409); decline deletes the vector and survives a
  vector error; `/similar` drops self, filters by user and `performed`, returns ≤ 5, `[]` on errors; the vendored boto3
  exposes the durable and `s3vectors` APIs; `vectors.embed_text` matches the shared fixture.
* **flows** (`tests/test_flows.py` with `FakeDurableContext`: `step` runs immediately and records names, `wait` records
  the duration, `create_callback` returns a callback whose `result()` returns or raises a preset `CallbackError`): job-flow
  success → `finish`; timeout/heartbeat → `fail` with the plain message; `Canceled`/`Superseded` → no write; skipped start
  when the job is missing, has another sessionId or is terminal (no re-invoke when already running with this sessionId); sessionId fence on every write. clip-flow: pending-only posts → `not_posted`, no
  wait; queued post published once even when the step is replayed; exhausted retries → post `failed`; 48 h wait name and
  duration; distil outcomes; vector upsert with `performed` and performance JSON.
* **realtime/hooks**: authorizer accepts a token signed with the fixed test RSA key in `tests/fixtures/jwks.json` and
  rejects wrong `iss`/`client_id`/`token_use`/expired/bad signature/unknown `kid`, and never logs the token;
  `$connect`/`$disconnect`/`ping`; broadcast coalescing, type mapping, delete from `OldImage`, `GoneException` cleanup,
  24 KB → `partial`, internal fields absent; hooks: Meta challenge ok/403, YouTube challenge, tiktok/x 501, POST stores
  a HOOK item with 14-day `ttl`, 413 over 256 KB, OAuth 302 to `/settings?account=…&status=coming_soon`, unknown
  platform 404, query string never logged.
* **agent**: `callbackId` → heartbeat ≤ every 5 min, success after `ready`, `JobFailed`/`Canceled`/`Superseded`
  failures, closed-callback errors ignored, no callback without `callbackId`; duplicate `process_job` ignored; finalize
  puts vectors with the §14.6 metadata; query fallback (< 3 performed hits) and skip on error.
* **web** (Vitest + Playwright mock mode): backoff sequence and fresh token per attempt, cache merge of each event
  type, `partial` refetch, polling only while disconnected (30 s while live), no `wsUrl` → polling; "Like clips that did
  well" strip hidden when empty; no overflow from 320 px.
* **infra** (`terraform test` with mock providers, `terraform validate`, `fmt -check`): flows have `publish = true`,
  alias `live`, `durable_config` 30600 / 259200 s and retention 14, `timeouts.delete = "60m"`, no destinations; the ESM
  has exactly one filter with the four prefixes; the WebSocket authorizer sets no TTL/payload version; WS and REST logs
  contain no query/`requestOverride` and `data_trace_enabled = false`; index is float32/1024/cosine with the four
  non-filterable keys; no `aws_sqs_queue`, `aws_scheduler_*` or `aws_cloudwatch_event_rule` remains; outputs of §10 exist.
