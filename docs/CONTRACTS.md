# Clip Factory Cloud: contracts (the single source of truth)

Every component (web, api, agent, infra, CI/CD) follows this file. If code and this file disagree, this file wins
and the code is fixed. Change it first, in the same pull request, when a contract has to change.

## 0. Product in one paragraph

The owner pastes a **YouTube, Twitch or Kick link** (or uploads a video file). An agent on **Amazon Bedrock
AgentCore**, running **Claude Fable 5.1** with the owner's **skills** (SKILL.md files managed in Settings), downloads
the source, transcribes it, finds the most viral moments, and cuts **5–10 vertical clips** (1080×1920, hook text,
burned-in captions, cover image, pre-post checklist, a caption per platform). The clips appear in the app for review.
**Nothing is published without the owner's Confirm.** Confirmed clips are queued for publishing to the connected
social accounts (YouTube, Instagram, Facebook, TikTok, X; integrations arrive in a later phase). Once posted, each
clip's **numbers per platform are refreshed every 15–30 minutes** (each platform's safe limit) for 30 days and shown on
the clip's performance page (§16); **48 hours after a clip is posted** what worked is distilled into "learnings", and
every week the owner stars the **best clips of the week**, which teaches the agent how to cut the next jobs (§16).

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
config/platforms.json       per-platform stats refresh intervals, batch sizes and rate budgets (§16.4)
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
| GET `/v1/clips/{clipId}/performance` | – | `ClipPerformance` (§16.2; 404 if not the caller's or `review`/`declined`) |
| POST `/v1/clips/{clipId}/stats/refresh` | `{ "platforms"?: Platform[] }` (default: all) | `202 { "platforms": RefreshResult[] }` (§16.2; never bypasses a platform's limits) |
| GET `/v1/weeks/{week}` | `week` = `yyyy-Www` (ISO week); query `from`, `to` (ISO UTC instants of the owner's local Monday 00:00 and next Monday 00:00) | `{ "week": WeekView }` (§16.2) |
| PUT `/v1/weeks/{week}/best` | `{ "from", "to", "clipIds": string[] }` (0–10 ids of that week's clips) | `202 { "week": WeekView }` (starts the async `cf-prod-learn`, §16.6); `200` when the picks did not change |

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
                 score: number /* 1..10 */; createdAt: string; decidedAt?: string;
                 best?: boolean /* starred "Best this week" (§16) */; bestWeek?: string /* "yyyy-Www" */;
                 totalViews?: number /* sum of Post.metrics.views over posted posts; absent when none measured */ }
interface Skill { skillId: string; name: string; description: string; enabled: boolean; builtin: boolean;
                  format: "md" | "zip"; size: number; createdAt: string }
interface Settings { clipMin: number /* 1..10, default 5 */; clipMax: number /* clipMin..10, default 10 */;
                     maxSourceHours: number /* 1..12, default 6 */; soundEnabled: boolean /* default true */;
                     reduceMotion: boolean /* default false */; hasYoutubeCookies: boolean /* read-only */;
                     platforms: Platform[] /* default all five */;
                     clickSound: number /* 1..30, default 6 "Water drop" (§15) */;
                     errorSound: number /* 1..30, default 5 "Nope nope nope" (§15) */ }
type Platform = "youtube" | "instagram" | "facebook" | "tiktok" | "x";
interface Account { platform: Platform; status: "not_connected" | "connected" | "needs_reconnect"; handle?: string }
interface Post { postId: string; clipId: string; platform: Platform; status: "pending_integration" | "queued" | "posted" | "failed";
                 url?: string; postedAt?: string; perfCheckAt?: string;
                 metrics?: PostMetrics /* §16.3; views/likes/comments/shares may be null = "this platform does not say" */;
                 privacy?: "public" | "private" /* TikTok unaudited posts are private, §16.3 */;
                 refreshing?: boolean /* a stats refresh is running (refreshStartedAt < 5 min ago) */;
                 nextRefreshAt?: string /* earliest manual refresh, §16.5 */; error?: string }
interface Learning { learningId: string; text: string; createdAt: string; postIds: string[];
                     kind?: "post" | "week" /* absent = "post" */; week?: string; title?: string /* "Best of week 2026-W46" */;
                     clipIds?: string[] /* week learnings: the picked clips */ }
interface Performance { views: number; likes: number; comments: number; shares: number; posts: number; checkedAt: string }
interface SimilarClip { clipId: string; hook: string; title: string; momentType: MomentType;
                        similarity: number /* 0..1 = 1 - cosine distance, 2 decimals */; performance?: Performance;
                        coverUrl?: string /* presigned GET, 1 h */ }
// PostMetrics, ClipPerformance, PlatformPerformance, RefreshResult, WeekView, WeekClip: §16.2–§16.3.
```
`Performance` sums treat a `null` metric as 0. Ids are ULIDs (26 chars, time-sortable). Timestamps are ISO-8601 UTC strings.

## 6. DynamoDB (single table `cf-prod-data`, on-demand, PITR on, Streams `NEW_AND_OLD_IMAGES`)

Keys: `pk` (S), `sk` (S); GSI `gsi1` on `gsi1pk`/`gsi1sk` (projection ALL); sparse GSI `gsi2` on `gsi2pk`/`gsi2sk`
(S/S, projection ALL; only posts due for a stats poll carry these, §16.3); TTL attribute `ttl`.
`userId` is the Cognito `sub`. The stream feeds `cf-prod-broadcast` (§14.2).

| Item | pk | sk | gsi1pk / gsi1sk | Other attributes |
|---|---|---|---|---|
| Settings | `USER#{userId}` | `SETTINGS` | – | Settings fields |
| Job | `USER#{userId}` | `JOB#{jobId}` | – | Job fields + `type="job"`, `userId`, `sessionId` (AgentCore session), `heartbeatAt`, `flowRun`, `flowExecutionArn` (§14.4) |
| Clip | `USER#{userId}` | `CLIP#{clipId}` | `JOB#{jobId}` / `CLIP#{rank:03d}` | Clip fields (minus URLs, minus computed `totalViews`) + `type="clip"`, `userId`, `videoKey`, `coverKey`, `publishState`, `postsCreated`, `flowRun`, `flowExecutionArn` (§14.5), `best`, `bestWeek` (§16) |
| Connection | `USER#{userId}` | `CONN#{connectionId}` | `CONN#{connectionId}` / `CONN` | `type="conn"`, `userId`, `connectionId`, `connectedAt`, `ttl` (§14.2) |
| Hook event | `HOOK#{platform}` | `HOOK#{hookId}` | – | `type="hook"`, `platform`, `receivedAt`, `headers`, `body`, `bodyEncoding`, `signature`, `ttl` (§14.3) |
| Skill | `USER#{userId}` | `SKILL#{skillId}` | – | Skill fields + `key` (S3) |
| Post | `USER#{userId}` | `POST#{postId}` | `CLIP#{clipId}` / `POST#{platform}`; gsi2 `STATS` / `{statsDueAt}#{postId}` while polled | Post fields + internal `platformPostId`, `statsId`, `statsDueAt`, `insightsDueAt`, `refreshStartedAt`, `lastSnapshotAt` (§16.3) |
| Stat snapshot | `USER#{userId}` | `STAT#{postId}#{iso}` | – | `type="stat"`, `postId`, `clipId`, `platform`, `at`, `views`, `likes`, `comments`, `shares`, `final?`, `ttl` (90 days) (§16.3) |
| Week | `USER#{userId}` | `WEEK#{yyyy-Www}` | – | `type="week"`, WeekView fields without `clips` + `revision`, `unpickedClipIds` (§16.3) |
| Rate budget | `RATE#{platform}` | `BUDGET` | – | `type="rate"`, per-platform counters, `blockedUntil` (§16.4) |
| Learning | `USER#{userId}` | `LEARNING#{learningId}` | – | Learning fields (incl. `kind`, `week`, `title`, `clipIds`) |
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
  included in the moment-selection prompt. The agent also receives the owner's latest 4 "Best of week" learnings, the
  latest 10 other learnings and the top 8 similar past clips from S3 Vectors, the owner's best-of-week picks first
  ("What worked before", §14.6, §16.7).
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
| `cf-prod-api` | `clipfactory_api.http.handler` | HTTP API (all routes) | `TABLE_NAME`, `MEDIA_BUCKET`, `AGENT_RUNTIME_ARN`, `JOB_FLOW_ARN`, `CLIP_FLOW_ARN`, `VECTOR_BUCKET`, `VECTOR_INDEX`, `APP_URL`, `VERSION`, `STATS_FUNCTION_ARN`, `LEARN_FUNCTION_ARN` (§16) |
| `cf-prod-stats` | `clipfactory_api.stats.handler.handler` | EventBridge rule `cf-prod-stats` `rate(15 minutes)` + async Invoke by `cf-prod-api` (manual refresh) | `TABLE_NAME`, `STATS_TIME_BUDGET_SECONDS=240` (§16.5) |
| `cf-prod-learn` | `clipfactory_api.weekly.handler` | async Invoke by `cf-prod-api` on `PUT /v1/weeks/{week}/best` | `TABLE_NAME`, `MODEL_ID`, `EMBED_MODEL_ID`, `VECTOR_BUCKET`, `VECTOR_INDEX` (§16.6) |
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
  48 hours, reads metrics (through the shared stats refresh, §16.5), distils one short Learning and updates the clip's
  vector. Between and after those steps `cf-prod-stats` keeps every posted post's numbers fresh for 30 days (§16).
* A `running` job whose agent stops sending heartbeats for 15 minutes becomes `failed` ("The agent stopped
  responding. Press Retry.") through the job-flow callback heartbeat timeout (§14.4), not a scan.

## 10. Terraform outputs (read by deploy.yml)

`app_url`, `api_url`, `region`, `user_pool_id`, `user_pool_client_id`, `web_bucket`, `distribution_id`,
`media_bucket`, `table_name`, `agent_runtime_arn`, `ecr_repository_url`, and from §14: `ws_url`, `hooks_url`,
`vector_bucket`, `vector_index`, `job_flow_alias_arn`, `clip_flow_alias_arn`, and from §16: `stats_function_name`,
`learn_function_name`, `stats_rule_name`, `stats_tick_minutes`. `write-web-config.sh` requires `ws_url`.

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
* **Library** has two views: "All clips" (every kept clip, newest first, each card shows total views when measured)
  and "This week" (the week's clips sorted by views with a big "Best this week" star each, arrows for earlier weeks,
  §16.8). Tapping any clip in Library opens its performance page `/clips/{clipId}` (§16.8).
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
| EventBridge rule `cf-prod-watchdog` (rate 10 minutes), its target, permission and `event_invoke_config` | – (the only EventBridge rule since §16 is `cf-prod-stats`) |
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
  `pattern = jsonencode({ dynamodb = { Keys = { sk = { S = [{ prefix = "JOB#" }, { prefix = "CLIP#" }, { prefix = "POST#" }, { prefix = "LEARNING#" }, { prefix = "WEEK#" }] } } } })`.
  (So `CONN#`, `HOOK#`, `SETTINGS`, `SKILL#`, `STAT#` and `RATE#…/BUDGET` changes never reach it.)
* Per batch: keep only the last record per (`pk`, `sk`) (heartbeats coalesce); `userId` = `pk` minus `USER#`; `type`
  from the `sk` prefix (`JOB#`→`job`, `CLIP#`→`clip`, `POST#`→`post`, `LEARNING#`→`learning`, `WEEK#`→`week`); INSERT/MODIFY →
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
    | { type: "week"; op: "upsert"; id: string /* "yyyy-Www" */; item: WeekSummary /* §16.2 */ }
    | { type: "job" | "clip" | "post" | "learning" | "week"; op: "delete"; id: string }
    | { type: "job" | "clip" | "post" | "learning" | "week"; op: "upsert"; id: string; partial: true } // item too big: refetch
    | { type: "pong"; at: string } | { type: "error"; code: "bad_request" };
  ```
  `item` is built by the **same public-shape functions the HTTP API uses** (`jobs.public_job`, `clips.public_clip`
  without presigning, `posts.public_post`, the Learning shape, `weeks.public_week`), so internal fields (`sessionId`, `videoKey`,
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
     `perfCheckAt = postedAt + 48 h`, plus the stats fields of §16.3 (`platformPostId`, `statsId`, `privacy`,
     `statsDueAt = postedAt + minIntervalMinutes`, `gsi2pk = "STATS"`, `gsi2sk = "{statsDueAt}#{postId}"`; a private
     TikTok post without `statsId` gets no gsi2 attributes), written by `posts.mark_posted(...)`. Exhausted retries (`StepError`) → step `post-failed-{platform}` sets the post
     `failed` with a plain `error`.
  3. `settle-clip`: clip `posted` if ≥ 1 post is `posted`; `failed` if every queued post failed; `confirmed` if none
     was queued. If nothing was posted: step `upsert-vector` (status `confirmed`) and return outcome `not_posted` (today's
     path, while every platform is `pending_integration`).
  4. `context.wait(Duration.from_hours(48), name="wait-48h")`: no compute, no schedule.
  5. `metrics`: `stats.refresh.refresh_posts(deps, posted_posts, reason="flow", now)` (§16.5; the same code as the
     poller, so it respects every rate budget and writes `metrics` + a snapshot); a platform that is blocked or fails
     after 3 attempts keeps its latest stored `Post.metrics` (written by the poller), and only a post with no metrics
     at all is skipped.
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
  (`youtubeTitle`), `summary`, `performance` (JSON string of `Performance`, absent until measured); filterable `best`
  (boolean, §16.6: `true` while the owner has the clip starred "Best this week"; written `false` by agent finalize;
  every later metadata write merges and keeps it; a new filterable key needs no new index). Filterable metadata
  stays under 2 KB.
* **Who writes/reads:**

  | Who | When | Calls | IAM (index ARN unless noted) |
  |---|---|---|---|
  | agent | finalize: one `PutVectors` for all new clips, status `review` | Titan + `put_vectors` | `s3vectors:PutVectors`, `bedrock:InvokeModel` on the Titan ARN |
  | agent | before `select`: query text `f"{title}\n{channel}\n{notes}\n{transcript[:4000]}"` (one embedding), first `topK=4` with filter `{"$and": [{"userId": {"$eq": sub}}, {"best": {"$eq": true}}]}`, then `topK=8` with `{"$and": [{"userId": {"$eq": sub}}, {"status": {"$eq": "performed"}}]}`; merge (dedupe by key, best hits first), cap 8; fewer than 3 hits in total → again with `{"userId": {"$eq": sub}}` only; any error → skip, log `vectors.query_failed` (§16.7) | Titan + `query_vectors(returnMetadata=True, returnDistance=True)` | `s3vectors:QueryVectors`, `s3vectors:GetVectors` |
  | learn | `cf-prod-learn`: `best=true` on picked clips, `best=false` on unpicked ones (get, merge, put; missing vector → embed from the Clip item) | as clip-flow | `s3vectors:GetVectors`, `s3vectors:PutVectors`, Titan |
  | clip-flow | `upsert-vector`: `get_vectors(keys=[clipId], returnData=True, returnMetadata=True)`, merge metadata, `put_vectors`; vector missing → embed from the Clip item | as listed | `s3vectors:GetVectors`, `s3vectors:PutVectors`, Titan |
  | api | decline: `delete_vectors(keys=[clipId])` (errors logged, never fail the route) | | `s3vectors:DeleteVectors` |
  | api | `GET /v1/clips/{id}/similar` | see below | `s3vectors:GetVectors`, `s3vectors:QueryVectors` |

  The agent's prompt section is titled "What worked before" and lists per hit: moment type, hook, title, summary,
  performance (views, likes) and similarity, and "Owner's pick: best of the week" for `best` hits; it is advice, never
  a rule.
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
  data/       + stream_enabled, stream_view_type = NEW_AND_OLD_IMAGES; output stream_arn; + sparse GSI gsi2 (§16.3)
  stats/      NEW (§16.9): cf-prod-stats (+ EventBridge rule cf-prod-stats), cf-prod-learn, roles, log groups
  api/        only cf-prod-api + the HTTP API (queue, DLQ, scheduler, watchdog, publisher, perf-check removed);
              new inputs job_flow_arn_prefix, clip_flow_arn_prefix (function:NAME, for IAM ":*"), job_flow_alias_arn,
              clip_flow_alias_arn, vector_bucket, vector_index, vector_index_arn, stats_function_arn,
              learn_function_arn (§16.9); output function_names = { api = ... }
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
  `cf-prod-ws`, `cf-prod-broadcast`, `cf-prod-hooks`, `cf-prod-stats`, `cf-prod-learn` (§16.9). Not for `cf-prod-ws-authorizer`: rejecting a token raises by
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

The §16 split (clip performance, stats, weekly best) is in §16.10.

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
  has exactly one filter with the five prefixes (§16 adds `WEEK#`); the WebSocket authorizer sets no TTL/payload version; WS and REST logs
  contain no query/`requestOverride` and `data_trace_enabled = false`; index is float32/1024/cosine with the four
  non-filterable keys; no `aws_sqs_queue` or `aws_scheduler_*` remains, and the only `aws_cloudwatch_event_rule` is
  `cf-prod-stats` (§16.9); outputs of §10 exist.

## 15. Settings as a tree, and choosing your click sounds (owner request, 2026-11-16)

The owner's picture: *the field* is all of Settings, the *trees* are a few big groups, each tree has *branches*
(sections), each branch has *apples* (the settings you change) and *leaves* (short help text). Everything has a place.

### 15.1 The tree (routes are real URLs; deep links work; old `/settings#skills` style anchors redirect)

| Tree (route) | Branch (route) | Apples (settings) | Leaves (help, one short line each) |
|---|---|---|---|
| **Clip making** `/settings/clip-making` | **Clips** `/clips` | How many clips (Fewest / Most steppers → `clipMin`/`clipMax`), Longest video (`maxSourceHours`) | what each does |
| | **Skills** `/skills` | every skill: on/off, view, delete (Undo); Add a skill (.md or .zip) | what a skill is |
| | **YouTube help** `/youtube` | YouTube cookies: add / remove | when you need it |
| **Posting** `/settings/posting` | **Accounts** `/accounts` | YouTube, Instagram, Facebook, TikTok, X (Coming soon) | what connecting does |
| | **Where clips go** `/where` | platforms to post to (`settings.platforms`, at least one) | |
| **Look & feel** `/settings/look-and-feel` | **Sounds** `/sounds` | Sounds on/off (`soundEnabled`); **Click sound** (1 of 30, `clickSound`); **Error sound** (1 of 30, `errorSound`); Try it | sounds only play when you tap, never when you scroll |
| | **Motion** `/motion` | Reduce motion (`reduceMotion`) | |
| | **Background** `/background` | Background picture (this device only) | |
| **App & account** `/settings/app` | **Get the app** `/get-the-app` | the device-aware install card (§12.1) | |
| | **Updates** `/updates` | this version, Check for updates (§12.2) | |
| | **Account** `/account` | signed-in email, Sign out | |

Branch routes are nested: `/settings/look-and-feel/sounds`. `/get-app` keeps working (same card).

### 15.2 How it looks and moves (kid-proof, §12.4)
* `/settings` (the field): a short search box "Find a setting" that searches every apple and leaf by name and jumps
  straight to it (highlights it), then the four trees as big glass cards (icon, name, one line, how many apples).
* A tree page lists its branches as cards (icon, name, one line). A branch page shows its apples as rows grouped in
  glass panels, each with its leaf under it.
* Breadcrumb on every level: `Settings › Look & feel › Sounds` (each part a link) plus a big Back button on phones.
* ≥ 1024 px: a left "folder" panel inside Settings shows the whole tree (trees expand/collapse like folders, branches
  are links, the current one highlighted, state remembered), content on the right. < 1024 px: drill-down pages.
* One tomato CTA per screen at most; plain words; nothing overflows at any width from 320 px.

### 15.3 Sounds
* The 30 click sounds and 30 error sounds are the ones from the owner's sound picker page; their recipes live in
  `web/src/lib/soundCatalog.ts` as data (`{ id, name, feel, voices }`, oscillator voice
  `[wave, startHz, endHz, at, length, peak, lowpassHz]`, noise voice `["noise", filterType, filterHz, at, length, peak]`).
* Defaults (the owner's picks): **click sound 6 "Water drop"**, **error sound 5 "Nope nope nope"**.
* The Sounds branch is the picker the owner liked: two groups ("When it works" / "When it can't") of numbered glass
  cards (number, name, feel), tapping a card plays it and selects it (a "Pick" badge, `aria-pressed`), plus a
  "Try it: Sign in" button with a "Make it fail" switch (success plays the click sound with a sage toast "Signed in",
  fail plays the error sound with a small shake and a tomato toast "Wrong password. Try again."). Choices save
  instantly (optimistic, like `soundEnabled`) and follow the owner to every device.
* The sound engine plays the chosen recipes everywhere (click on enabled controls, error on disabled controls and error
  toasts, §11). Previewing a card always plays even when Sounds is off? **No**: when Sounds is off the cards show a
  note "Sounds are off" with a button to turn them on, and previews stay silent until then (kid-proof: no surprise).

### 15.4 API
* `Settings` gains `clickSound: number /* 1..30, default 6 */` and `errorSound: number /* 1..30, default 5 */`,
  validated in PUT `/v1/settings` (integers 1–30, else 400 with a plain message). Stored settings without them read
  as the defaults.

## 16. Clip performance, stats refresh and weekly best (owner request, 2026-11-16)

The owner's words: *"click on any video and see how they performed for each social media platform ... the video on
top ... lines that go, in a smooth manner, leading to each vertical stack of information ... YouTube, TikTok,
Instagram, X, Facebook ... select the ones that perform best during that week, so that it knows how to edit better
in the future ... the stats ... should be an API call where I can just refresh it ... every 15 or 30 minutes, or
whatever the lowest limit is for each API."* Where this section and an earlier one disagree, this one wins.

Platform order everywhere in this section (stacks, arrays, tests): **YouTube, TikTok, Instagram, Facebook, X**
(`["youtube", "tiktok", "instagram", "facebook", "x"]`, constant `STATS_ORDER`).

### 16.1 What the owner gets

* **Clip performance page** `/clips/{clipId}`: the 9:16 video on top, five smooth lines growing out of it into five
  platform stacks (views, likes, comments, ... whatever that platform really offers), a crown on the best platform, a
  "Best this week" star, one tomato **Refresh numbers** button. Numbers update live over the WebSocket.
* **Automatic refresh**: an EventBridge tick every 15 minutes; each platform is polled no faster than its own safe
  interval (YouTube, TikTok, X 15 min; Instagram, Facebook 30 min), slower as posts age, for 30 days, then one final
  snapshot.
* **Library › This week**: the week's clips sorted by views; the owner stars the best ones; Fable 5.1 writes one
  "Best of week" learning and the starred clips are preferred in the agent's "What worked before".

### 16.2 API (all JWT, §5 errors; file `api/src/clipfactory_api/routes/performance.py` and `routes/weeks.py`)

`HTTP API` keeps its single `ANY /v1/{proxy+}` route: no API Gateway change.

**GET `/v1/clips/{clipId}/performance`** → `200 ClipPerformance`. 404 `not_found` when the clip is not the caller's
or its status is `review`/`declined` ("This clip has no numbers yet. Keep it first."). Reads: the Clip, its Posts
(gsi1 `CLIP#{clipId}`), the Accounts, the STAT# snapshots of each post (Query `begins_with(sk, "STAT#{postId}#")`,
`ScanIndexForward = false`, `Limit 500`, re-sorted oldest first, then downsampled to ≤ 60 points evenly by time,
the last point always kept).

```ts
type PerfStatus = "posted" | "posted_private" | "waiting_for_connection" | "posting" | "failed" | "not_posted";
interface PlatformPerformance {
  platform: Platform; status: PerfStatus;
  account: "connected" | "not_connected" | "needs_reconnect";
  postId?: string; url?: string /* "Open on YouTube" */; postedAt?: string;
  metrics: PostMetrics | null;            // §16.3; null until the first successful read
  updatedAt?: string;                     // metrics.metricsUpdatedAt (fast counts)
  insightsUpdatedAt?: string;             // metrics.insightsUpdatedAt (slow insights)
  nextAllowedAt?: string;                 // earliest manual refresh for this post (§16.5); absent = now
  refreshing: boolean;                    // refreshStartedAt within the last 5 min
  final: boolean;                         // the day-30 final snapshot was taken (no more automatic polls)
  error?: string;                         // Post.error (failed posting) or the last stats error, plain sentence
}
interface ClipPerformance {
  clip: Clip;                             // with presigned videoUrl + coverUrl (1 h), best, bestWeek, totalViews
  posts: PlatformPerformance[];           // always exactly five, in STATS_ORDER
  series: Partial<Record<Platform, { at: string; views: number }[]>>;  // sparkline points; absent = no snapshots
  totals: { views: number; likes: number; comments: number; shares: number; platformsPosted: number;
            updatedAt?: string /* newest metricsUpdatedAt */ };       // null metrics count as 0
  bestPlatform: Platform | null;          // highest non-null metrics.views > 0; ties → earlier in STATS_ORDER
  bestThisWeek: boolean;                  // = clip.best === true
  week: string | null;                    // = clip.bestWeek when starred, else null (the web computes the anchor week)
  weekAnchorAt: string;                   // earliest postedAt of the clip's posts, else clip.decidedAt (§16.6)
}
```
Status mapping per platform (first match wins): no Post for the platform → `not_posted`; Post `pending_integration`
→ `waiting_for_connection`; `queued` → `posting`; `failed` → `failed`; `posted` with `privacy: "private"` →
`posted_private`; `posted` → `posted`.

**POST `/v1/clips/{clipId}/stats/refresh`** body `{ "platforms"?: Platform[] }` (unknown platform → 400). 404 as above.
For each requested platform in STATS_ORDER, build one `RefreshResult`:
```ts
interface RefreshResult {
  platform: Platform;
  status: "started" | "too_soon" | "blocked" | "not_posted" | "not_connected" | "private";
  nextAllowedAt?: string;   // when the next manual refresh is allowed (too_soon / blocked / started)
  note?: string;            // plain sentence, e.g. "Instagram numbers can take up to 2 days to settle."
}
```
* `not_posted`: no Post or Post not `posted`. `private`: `privacy: "private"` (TikTok; note "TikTok shows numbers
  after the app is approved."). `not_connected`: no connected Account (note "Connect {Platform} in Settings › Posting ›
  Accounts.").
* `blocked`: the platform's rate budget has `blockedUntil > now` (§16.4) → `nextAllowedAt = blockedUntil`.
* Otherwise claim the post with one conditional UpdateItem: `SET refreshStartedAt = :now, nextRefreshAt = :next`
  where `:next = now + manualCooldownMinutes`, condition `(attribute_not_exists(nextRefreshAt) OR nextRefreshAt <= :now)
  AND (attribute_not_exists(refreshStartedAt) OR refreshStartedAt < :nowMinus5m)`. Failed condition → `too_soon` with
  the stored `nextRefreshAt`. Success → `started` with `nextAllowedAt = :next`; the Instagram and Facebook results carry
  the note "Instagram numbers can take up to 2 days to settle." / "Facebook numbers can take up to 2 days to settle."
* If ≥ 1 is `started`: one `lambda.invoke(FunctionName=STATS_FUNCTION_ARN, InvocationType="Event", Payload=
  {"action": "refresh", "userId", "clipId", "postIds": [...started]})`. Invoke failure → clear `refreshStartedAt` and
  `nextRefreshAt` on those posts and still return `202`, with those entries as `blocked` and the note "Could not check
  right now. Try again in a minute." (`nextAllowedAt = now + 1 min`).
* Always `202 { "platforms": RefreshResult[] }`. The numbers arrive as `post` upserts on the WebSocket (§16.8).

**GET `/v1/weeks/{week}?from=&to=`**. `week` must match `^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$`; `from`/`to` are ISO UTC
instants with `to - from` between 167 h and 169 h (DST) and `from` within 14 h of the ISO Monday 00:00 UTC of `week`;
else 400 `bad_request` ("That week does not look right. Go back to This week."). A clip belongs to the week that
contains its **anchor** = earliest `postedAt` of its posts, else `decidedAt` (kept but not posted yet); statuses
`confirmed`, `publishing`, `posted`, `failed` only.
```ts
interface WeekClip { clip: Clip /* coverUrl presigned; no videoUrl */; anchorAt: string; posted: boolean;
                     totals: { views: number; likes: number; comments: number; shares: number };
                     views: Partial<Record<Platform, number | null>>; best: boolean }
// views: one entry per platform with a `posted` Post that is not private (null = numbers on the way)
interface WeekSummary { week: string; from: string; to: string; clipIds: string[] /* the picks */; savedAt?: string;
                        learnState: "none" | "learning" | "done" | "skipped" | "failed"; learningId?: string }
interface WeekView extends WeekSummary { clips: WeekClip[] /* sorted: views desc, then anchorAt desc */;
                                          learning?: Learning /* the week's "Best of week" learning */ }
```
No WEEK item yet → `clipIds: []`, `learnState: "none"`. Reads: Query all `POST#` and `CLIP#` items of the owner
(single owner, small), filter in code.

**PUT `/v1/weeks/{week}/best`** body `{ "from", "to", "clipIds" }` (same checks; `clipIds` unique, ≤ 10, each in that
week's `clips`, else 400 "Pick clips from this week only."). Same set as stored → `200 { week }`, nothing else happens.
Otherwise one TransactWriteItems (≤ 21 items): Put the WEEK item (`revision + 1`, `clipIds`, `unpickedClipIds = old −
new`, `savedAt = now`, `learnState = "learning"` when `clipIds` is non-empty, else `"skipped"`), Update each newly picked
Clip `best = true, bestWeek = week`, each unpicked Clip `best = false REMOVE bestWeek`. Then
`lambda.invoke(FunctionName=LEARN_FUNCTION_ARN, InvocationType="Event", Payload={"userId", "week", "revision"})`
(also for an empty set, to clear vectors and the old learning). Invoke failure → WEEK `learnState = "failed"`; the
route still answers. Response `202 { week: WeekView }`.
Stored picks whose clip has since left the week (its anchor moved, for example a clip kept on Sunday and posted on
Monday) are dropped quietly from the incoming `clipIds` before the checks; their `best` flag is cleared only while
`bestWeek` is still this week. GET returns `clipIds` filtered to clips still in the week, so the web can resend them.

Public shapes come from `performance.public_performance(...)` and `weeks.public_week(item)` (WeekSummary, used by the
broadcast too). Internal fields (`revision`, `unpickedClipIds`, `refreshStartedAt`, `statsDueAt`, `gsi2*`,
`platformPostId`, `statsId`, `lastSnapshotAt`, `insightsDueAt`) never leave the API.

### 16.3 DynamoDB items

**Post (additions).**
| Attribute | Meaning |
|---|---|
| `platformPostId` | the platform's id of the post (YouTube video id, TikTok publish id, IG media id, FB post id `{pageId}_{postId}`, X tweet id) |
| `statsId` | the id the stats API takes: YouTube video id; TikTok `publicaly_available_post_id` from `/v2/post/publish/status/fetch/` (absent while private); IG media id; FB **video id** of the Reel; X tweet id |
| `privacy` | `"public"`, or `"private"` for TikTok `SELF_ONLY` (unaudited app): no `statsId`, never polled |
| `metrics` | `PostMetrics` below (latest) |
| `statsDueAt` | ISO: next automatic poll; with `gsi2pk = "STATS"`, `gsi2sk = "{statsDueAt}#{postId}"` while the post is within the 30-day window; both gsi2 attributes REMOVEd after the final snapshot |
| `insightsDueAt` | ISO: next slow-insights read (YouTube Analytics only; §16.4 `insightsIntervalMinutes`) |
| `refreshStartedAt`, `nextRefreshAt` | manual refresh claim and cooldown (§16.2) |
| `lastSnapshotAt` | ISO of the last STAT# item |
| `statsError` | last stats error, plain sentence (cleared on success) |

```ts
interface PostMetrics {
  views: number | null; likes: number | null; comments: number | null; shares: number | null; // common four
  checkedAt: string;          // = metricsUpdatedAt (kept for §5/§14 readers and learn.distil)
  metricsUpdatedAt: string;   // fast counts read time
  insightsUpdatedAt?: string; // slow insights read time
  final?: true;               // day-30 final snapshot taken
  extra: YouTubeExtra | TikTokExtra | InstagramExtra | FacebookExtra | XExtra;  // keyed by Post.platform
}
// Every extra field is optional; a field the API did not return (removed, deprecated, not ready, empty set) is
// ABSENT, never 0. Times are converted to seconds (Meta returns milliseconds).
interface YouTubeExtra   { engagedViews?: number; watchMinutes?: number; avgViewSeconds?: number; avgViewPercent?: number;
                           subscribersGained?: number }                      // shares comes from Analytics into `shares`
interface TikTokExtra    {}                                                  // views/likes/comments/shares only
interface InstagramExtra { reach?: number; saved?: number; reposts?: number; totalInteractions?: number;
                           avgWatchSeconds?: number; totalWatchSeconds?: number; skipRatePercent?: number }
interface FacebookExtra  { initialPlays?: number; replays?: number; reactions?: Record<string, number>;
                           commentsAndShares?: number; avgWatchSeconds?: number; totalWatchSeconds?: number;
                           followsGained?: number; reachUnique?: number }
interface XExtra         { impressions?: number; reposts?: number; quotes?: number; bookmarks?: number;
                           linkClicks?: number; profileClicks?: number; engagements?: number;
                           playback0?: number; playback25?: number; playback50?: number; playback75?: number; playback100?: number }
```

**Field mapping (the adapters implement exactly this; tests use recorded fake responses, §16.11).**
| Platform | Request | → `views` | `likes` | `comments` | `shares` | `extra` |
|---|---|---|---|---|---|---|
| YouTube fast | `GET https://www.googleapis.com/youtube/v3/videos?part=statistics&id={≤50 ids}` (1 unit/call) | `statistics.viewCount` (Shorts count replays since 2025-03-31) | `likeCount` | `commentCount` | – (null until Analytics) | – (`favoriteCount` ignored; no dislikes) |
| YouTube slow | `GET https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate={earliest postedAt date}&endDate={today}&metrics=views,engagedViews,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained&dimensions=video&filters=video=={≤50 ids}` | (not used for views) | | | `shares` | `engagedViews`, `watchMinutes` = estimatedMinutesWatched, `avgViewSeconds` = averageViewDuration, `avgViewPercent` = averageViewPercentage, `subscribersGained` |
| TikTok | `POST https://open.tiktokapis.com/v2/video/query/?fields=id,share_url,view_count,like_count,comment_count,share_count` body `{"filters":{"video_ids":[≤20]}}` | `view_count` | `like_count` | `comment_count` | `share_count` | – |
| Instagram | `GET https://graph.facebook.com/{graphApiVersion}/{ig-user-id}/media?fields=id,permalink,media_product_type,timestamp,like_count,comments_count,insights.metric(views,reach,saved,shares,total_interactions,reposts,ig_reels_avg_watch_time,ig_reels_video_view_total_time,reels_skip_rate)&limit=50` (pages until all wanted ids found or `timestamp` older than 31 days) | insights `views` | `like_count` | `comments_count` | insights `shares` | `reach`, `saved`, `reposts`, `totalInteractions`, `avgWatchSeconds` = ig_reels_avg_watch_time/1000, `totalWatchSeconds` = ig_reels_video_view_total_time/1000, `skipRatePercent` = reels_skip_rate. Never `impressions`, `plays`, `ig_reels_aggregated_all_plays_count`. A metric error (code 100) drops that metric for the run and retries once without it |
| Facebook | `GET https://graph.facebook.com/{graphApiVersion}/?ids={≤50 video ids}&fields=video_insights.metric(blue_reels_play_count,fb_reels_total_plays,fb_reels_replay_count,post_video_avg_time_watched,post_video_view_time,post_video_followers,post_video_likes_by_reaction_type,post_video_social_actions)` (period lifetime); guarded reach: `GET /{graphApiVersion}/?ids={post ids}&fields=insights.metric(post_total_media_view_unique)` (error → `reachUnique` absent) | `fb_reels_total_plays` | sum of `post_video_likes_by_reaction_type` | null | null | `initialPlays` = blue_reels_play_count, `replays`, `reactions`, `commentsAndShares` = post_video_social_actions, `avgWatchSeconds`, `totalWatchSeconds`, `followsGained` = post_video_followers, `reachUnique`. Never `post_impressions_unique`, `total_video_impressions*`, `total_video_views_unique` |
| X | `GET https://api.x.com/2/tweets?ids={≤100}&tweet.fields=public_metrics,non_public_metrics,organic_metrics,created_at&expansions=attachments.media_keys&media.fields=public_metrics,non_public_metrics` (user context); posts ≥ 30 days old: same without `non_public_metrics`/`organic_metrics` (both fields) | attached video media `public_metrics.view_count` (never `impression_count`) | `like_count` | `reply_count` | `retweet_count` | `impressions` = public impression_count, `reposts` = retweet_count, `quotes`, `bookmarks`, `linkClicks` = url_link_clicks, `profileClicks` = user_profile_clicks, `engagements`, `playback0..100` = media non_public playback_{n}_count |

**STAT# snapshot** (`pk USER#{userId}`, `sk STAT#{postId}#{iso}`): `type "stat"`, `postId`, `clipId`, `platform`,
`at`, `views`, `likes`, `comments`, `shares` (nullable numbers), `final?: true`, `ttl = now + snapshotTtlDays (90) d`.
Written after a successful fast read when `lastSnapshotAt` is absent, or ≥ `snapshotEveryMinutes` (60) ago, or the
views changed by ≥ 1 % since the last snapshot and ≥ 15 min passed, or it is the final read. Totals survive the TTL on
`Post.metrics`.

**WEEK item** (`pk USER#{userId}`, `sk WEEK#{yyyy-Www}`): `type "week"`, `week`, `from`, `to`, `clipIds`, `savedAt`,
`learnState`, `learningId?`, `learnedAt?`, `revision` (number, starts 1), `unpickedClipIds`.

**Rate budget** (`pk RATE#{platform}`, `sk BUDGET`, app-wide; this is a single-owner app): `type "rate"`, `platform`,
`updatedAt`, `blockedUntil?` (ISO), `blockedReason?`, and per platform:
| Platform | Counters |
|---|---|
| youtube | `dayKey` (`YYYY-MM-DD` of `now − 8 h`, i.e. Pacific Standard; at most 1 h off in summer, covered by the reserve), `unitsUsed` |
| tiktok | `minuteKey` (`YYYY-MM-DDTHH:MM` UTC), `requestsThisMinute` |
| instagram, facebook | `buc` = parsed `X-Business-Use-Case-Usage` `{ callCount, totalCputime, totalTime, estimatedTimeToRegainAccess, at }` (highest entry of the header) |
| x | `windowKey` (15-min UTC bucket), `requestsThisWindow`, `resetAt` (from `x-rate-limit-reset`), `dayKey` (UTC), `dayPostIds` (string set: posts already read today, free re-reads), `monthKey` (`YYYY-MM` UTC), `monthUsd` (estimated spend) |

Reservation (`stats/budget.py`): `reserve(store, platform, cost, now) -> Reserved | Blocked(next_allowed_at)` is one
conditional `UpdateItem` (`ADD` the counter; condition: same key and counter ≤ limit − cost, or a new key which SETs
the counter; and `blockedUntil` absent or ≤ now). After the call `record(store, platform, response_meta, now)` stores
headers and sets `blockedUntil` per §16.4. Poller and manual refresh go through the same functions.

### 16.4 `config/platforms.json` (read by Terraform and by the code; copied into the zip)

`api/scripts/build_lambda.py` copies it to `clipfactory_api/config/platforms.json` inside the zip; code loads it with
`importlib.resources` (`stats.config.load()`), tests load the repo file. Terraform: `local.platforms =
jsondecode(file("${path.root}/../../../config/platforms.json"))`, `local.stats_tick =
min([for p in values(local.platforms.platforms) : p.minIntervalMinutes]...)` (= 15) → rule `rate(15 minutes)`.

```json
{
  "$comment": "Stats refresh limits per platform (docs/CONTRACTS.md §16.4). Change values here only.",
  "graphApiVersion": "v25.0",
  "pollWindowDays": 30,
  "snapshotTtlDays": 90,
  "snapshotEveryMinutes": 60,
  "ageTierHours": [48, 168, 720],
  "order": ["youtube", "tiktok", "instagram", "facebook", "x"],
  "platforms": {
    "youtube": {
      "label": "YouTube", "viewsField": "statistics.viewCount",
      "minIntervalMinutes": 15, "tierIntervalsMinutes": [15, 30, 120], "manualCooldownMinutes": 5,
      "insightsIntervalMinutes": 360, "slowNote": "Updates daily",
      "idsPerRequest": 50,
      "scopes": ["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/yt-analytics.readonly",
                 "https://www.googleapis.com/auth/youtube.upload"],
      "budget": { "kind": "daily_units", "dailyUnits": 10000, "reserveUnits": 3000, "unitsPerCall": 1,
                  "blockOn": ["quotaExceeded", "rateLimitExceeded"] }
    },
    "tiktok": {
      "label": "TikTok", "viewsField": "view_count",
      "minIntervalMinutes": 15, "tierIntervalsMinutes": [15, 30, 120], "manualCooldownMinutes": 5,
      "idsPerRequest": 20,
      "scopes": ["user.info.basic", "video.list", "video.publish"],
      "budget": { "kind": "per_minute", "requestsPerMinute": 600, "useAtMost": 300, "blockOn": ["rate_limit_exceeded"] }
    },
    "instagram": {
      "label": "Instagram", "viewsField": "views",
      "minIntervalMinutes": 30, "tierIntervalsMinutes": [30, 60, 360], "manualCooldownMinutes": 30,
      "slowNote": "Can take 2 days", "idsPerRequest": 50,
      "scopes": ["instagram_basic", "instagram_manage_insights", "instagram_content_publish", "pages_show_list"],
      "budget": { "kind": "meta_buc", "stopAtPercent": 75, "throttleCodes": [80002], "minBlockMinutes": 60 }
    },
    "facebook": {
      "label": "Facebook", "viewsField": "fb_reels_total_plays",
      "minIntervalMinutes": 30, "tierIntervalsMinutes": [30, 60, 360], "manualCooldownMinutes": 30,
      "slowNote": "Can take 2 days", "idsPerRequest": 50,
      "scopes": ["pages_show_list", "pages_read_engagement", "read_insights", "pages_manage_posts", "pages_manage_engagement"],
      "budget": { "kind": "meta_buc", "stopAtPercent": 75, "throttleCodes": [80001], "minBlockMinutes": 60 }
    },
    "x": {
      "label": "X", "viewsField": "media.public_metrics.view_count",
      "minIntervalMinutes": 15, "tierIntervalsMinutes": [15, 30, 120], "manualCooldownMinutes": 5,
      "idsPerRequest": 100, "nonPublicMaxAgeDays": 30,
      "scopes": ["tweet.read", "users.read", "tweet.write", "media.write", "offline.access"],
      "budget": { "kind": "x", "appRequestsPer15Min": 3500, "userRequestsPer15Min": 5000, "useAtMost": 1000,
                  "usdPerPostRead": 0.005, "monthlyUsd": 10 }
    }
  }
}
```
Rules:
* **Interval for a post** = `tierIntervalsMinutes[i]` where `i` = first tier with post age (now − postedAt) ≤
  `ageTierHours[i]` (≤ 48 h, ≤ 7 d, ≤ 30 d). Never below `minIntervalMinutes`. Next `statsDueAt = readAt + interval`.
* **Final**: the first read with age ≥ `pollWindowDays` writes `metrics.final = true`, a `final` STAT#, and REMOVEs
  `gsi2pk`/`gsi2sk`. Manual refresh still works afterwards (X then reads public metrics only).
* **Blocking** (`record`): youtube `403` with reason in `blockOn` → `blockedUntil` = next `dayKey` boundary (08:00 UTC);
  stop when `unitsUsed + cost > dailyUnits − reserveUnits` (uploads keep their 3,000-unit reserve). tiktok `429` /
  `rate_limit_exceeded` → now + 1 min; stop at `useAtMost` per minute. meta: after every response parse
  `X-Business-Use-Case-Usage`; any of call_count/total_cputime/total_time ≥ `stopAtPercent` → `blockedUntil = now +
  max(estimated_time_to_regain_access, 15) min`; error code in `throttleCodes` → `now + max(estimated_time_to_regain_access,
  minBlockMinutes) min`, and **no retry** (retries extend Meta's block). x: `429` → `blockedUntil = x-rate-limit-reset`;
  stop at `useAtMost` per 15-min window; before each request estimate cost = `usdPerPostRead` × ids not in `dayPostIds`;
  `monthUsd + cost > monthlyUsd` → `blockedUntil` = first day of next month, `blockedReason "monthly_cap"`.
* Every 5xx/network error: the step retries twice (1 s, 4 s) except Meta throttles; then `statsError` is set and
  `statsDueAt = now + interval` (no tight loop).

### 16.5 Poller and refresh: Lambda `cf-prod-stats`

Package `api/src/clipfactory_api/stats/`: `__init__.py`, `config.py` (load/validate platforms.json, `interval_for(...)`),
`budget.py` (§16.3), `refresh.py` (`refresh_posts(deps, posts, *, reason: "poll" | "manual" | "flow", now) ->
RefreshReport`, the one code path), `poll.py` (`run_tick(deps, now)`), `handler.py` (`handler(event, context)`).
Adapters: `platforms/{youtube,tiktok,instagram,facebook,x}.py` implement, beside `publish`/`metrics`:
```python
class StatsAdapter(Protocol):
    platform: str
    def fetch_stats(self, posts: list[Record], account: Record | None, *, now: datetime,
                    want_insights: bool, http: HttpClient) -> StatsBatch: ...
# StatsBatch(results: dict[postId, PostMetrics-dict], errors: dict[postId, str], meta: ResponseMeta(status, headers,
#            error_code, retry_after), requests: int, units: int)
# HttpClient = Callable[[HttpRequest], HttpResponse] (urllib in production, a recorder in tests); one request per
# idsPerRequest chunk; NotConnectedError when account is None.
```
`metrics(post, account)` of §14 stays and is implemented as `fetch_stats([post])` mapped to `Metrics`. Phase 1:
`platforms.adapter_for(platform)` returns the real adapter class, but `posts.connected_account` is always `None`, so
every call ends `not_connected` and nothing reaches the network. Tokens (phase 2) come from Secrets Manager; no token
ever lands in DynamoDB, logs or responses.

* **Handler events.** EventBridge scheduled event (`source == "aws.events"`) → `run_tick`. `{"action": "refresh",
  "userId", "clipId", "postIds"}` → `refresh_posts(reason="manual")` on those posts, then REMOVE `refreshStartedAt`
  (always, also on errors). Anything else → log `stats.bad_event`, return.
* **`run_tick`**: Query `gsi2` `gsi2pk = "STATS" AND gsi2sk <= "{nowIso}#~"` (paginate, ≤ 2,000 posts); group by
  platform in `order`; per platform skip all when `blockedUntil > now`; chunk by `idsPerRequest`; for each chunk
  `reserve` → `fetch_stats` → `record`; write results; YouTube posts with `insightsDueAt` absent or ≤ now are also sent
  with `want_insights=True` (separate Analytics request per ≤ 50 ids, `insightsDueAt = now + 360 min`). Stop starting
  new requests when `STATS_TIME_BUDGET_SECONDS` (240) have passed; the rest stays due for the next tick. Log one
  `stats.tick` line `{posts, requests, updated, blocked: [platforms], errors}`.
* **Writing a result** (per post, one UpdateItem): `metrics` (merge: fast fields + `metricsUpdatedAt`; slow fields +
  `insightsUpdatedAt` only when insights were read; previous slow values kept otherwise), `checkedAt`, `statsDueAt`,
  `gsi2sk` (or REMOVE gsi2 when final), REMOVE `statsError`; then the STAT# put when §16.3 says so (`lastSnapshotAt`).
  The Post change reaches the browser as a `post` upsert (broadcast filter `POST#`).
* **Skipped posts.** The token check runs before `budget.reserve`. A `not_connected` or `blocked` post is moved on
  without `statsError` (to `blockedUntil`, or by one interval); a `not_connected` post past `pollWindowDays` leaves gsi2.
* **YouTube cost.** `daily_units` is charged `unitsPerCall` per `videos.list` request only. The YouTube Analytics
  (insights) request has its own quota and is not charged to this budget.
* **Errors** never raise out of the handler (EventBridge would retry); a bug raises and alarms (§14.9).

### 16.6 Weekly best learning: Lambda `cf-prod-learn`

File `api/src/clipfactory_api/weekly.py`: `handler(event, context)` → `learn_week(deps, user_id, week, revision)`.
Input `{"userId", "week", "revision"}`.
1. GetItem the WEEK item; `revision` differs (a newer save) → return `superseded`, write nothing.
2. Vectors: for each `clipIds` → merge metadata `best = true`; each `unpickedClipIds` → `best = false` (§14.6; vector
   missing → embed from the Clip item and put it). Errors logged (`weekly.vector_failed`), never fatal.
3. `clipIds` empty → delete the week's Learning (`learningId` on the item) if any, set `learnState "skipped"`, done.
4. Build the prompt rows for **every** clip of that week (same week rule as §16.2, from the stored `from`/`to`):
   `picked` (bool), `hook`, `momentType`, `durationSec`, `layout`, `score`, `youtubeTitle`, the first 200 chars of the
   TikTok caption, per-platform `views/likes/comments/shares`, `totalViews`. Bedrock **Converse** `MODEL_ID`
   (`global.anthropic.claude-fable-5-1`), `maxTokens 4000`, `additionalModelRequestFields={"output_config": {"effort":
   "low"}}`, no temperature/topP/topK (as `learn.distil`). System prompt: compare the owner's picks with the rest of
   the week (hooks, moment types, length, captions, numbers) and answer with ONE plain-text learning of 1–3 short
   sentences (≤ 500 chars) the clip-picking agent should apply next time; the picks matter more than raw views.
5. `end_turn` with text → re-read the WEEK item, still the same `revision` → Put Learning `{learningId (reuse the
   item's learningId, else new ULID), kind: "week", week, title: "Best of week {week}", text, clipIds, postIds (the
   picked clips' posted post ids), createdAt}` and Update WEEK `learnState "done"`, `learningId`, `learnedAt`. Stop
   reasons `max_tokens`/`refusal`/`content_filtered`/empty → `learnState "failed"`, no Learning (§13). Bedrock errors
   retry twice, then `failed`.
Returns `{"week", "outcome": "learning" | "skipped" | "superseded" | "failed" | <stop reason>}`. The LEARNING# and
WEEK# changes reach the browser over the WebSocket. Shared pure functions live in `learn.py`
(`learn.week_rows(...)`, `learn.ask_week(...)`) so the clip-flow distil and this share the Converse helper.

### 16.7 Agent change (`agent/src/clipfactory_agent/vectors.py`, `learnings.py`)

* "What worked before" query: the two-query merge of §14.6 (best first, then performed, ≤ 8, fallback < 3 hits);
  `best` hits are labelled "Owner's pick: best of the week".
* Learnings brief: Query `begins_with(sk, "LEARNING#")`, newest first, ≤ 50 items; the latest **4** with `kind ==
  "week"` go first under the heading "The owner's best-of-week picks taught", then the latest **10** others under
  "Learnings". Both appear in the moment-selection prompt; empty groups are left out.
* Finalize writes `best: false` in each new vector's metadata.

### 16.8 Web

**Routes** (`web/src/lib/router.ts`): `/clips/{clipId}` → `{ name: "clip", clipId }` (nav section `library`);
`/library` → All clips; `/library?view=week` → This week (current ISO week); `/library?view=week&week=2026-W45` →
that week. Files: `screens/clip/ClipPerformance.tsx`, `components/PerfLines.tsx` (the SVG lines),
`components/PlatformStack.tsx`, `components/Sparkline.tsx`, `screens/library/WeekView.tsx`, `lib/week.ts` (ISO week
of a date in the browser's time zone, Monday start; `weekRange(week) -> {from, to}` as UTC ISO of local Monday 00:00
and next Monday 00:00; `weekLabel` "10–16 Nov"), `lib/metrics.ts` (compact numbers with `Intl.NumberFormat(…,
{notation: "compact"})`, "–" for null, durations "1:05"), API methods in `api/index.ts` + mock fixtures.

**Entry points**: tapping any Library card opens `/clips/{clipId}`; on Review, a kept clip's card shows "See how it
does" → `/clips/{clipId}`; Back returns to where the owner came from (else `/library`).

**Page layout (top to bottom)**
1. Header row: Back, the hook as the title (serif italic, wraps, never truncated off-screen).
2. Preview: `<video controls playsinline preload="metadata" poster={coverUrl} src={videoUrl}>`, `aspect-ratio: 9/16`,
   rounded glass frame, centred; width `min(180px, 56cqi)` in the trunk layout and `min(400px, 44vh) · 9/16`
   (≤ 225 px) in the rows and fan layouts, so the total and the first stacks stay on the first screen. No
   autoplay. No `videoUrl` → the cover image.
3. Stat block beside/under the preview: big total views (display serif) with "views across platforms" and a small
   "(each app counts views its own way)"; the **"Best this week" star** toggle (≥ 48 px, `aria-pressed`, sage glass,
   not tomato); the one tomato **Refresh numbers** button (icon + word, spinner while any `started` post is still
   `refreshing`; when every platform is `too_soon`/`blocked` it reads "Next check in 4 min" and a tap plays the deny
   sound with a toast saying when). "Updated 3 min ago" (newest `updatedAt`) under it.
4. The lines + five stacks (STATS_ORDER).

**Lines** (`PerfLines`, one `<svg aria-hidden="true">` absolutely positioned behind the stacks, recomputed with a
`ResizeObserver` on the page container; coordinates from `getBoundingClientRect` of the preview and each stack):
* Each line is one cubic bezier from the preview's bottom centre `(x0, y0)` to the top centre of its stack
  `(xi, yi)`: `M x0 y0 C x0 (y0 + 0.55·dy), xi (yi − 0.55·dy), xi yi` with `dy = yi − y0`. Stroke 2 px, round caps,
  sage `#9CAF88` at 70 % (ink at 35 % in dark mode); the best platform's line is tomato. A 6 px dot at each end.
* Draw-in: `pathLength="1"`, `stroke-dasharray: 1`, `stroke-dashoffset` 1 → 0 over 900 ms
  `cubic-bezier(0.22, 1, 0.36, 1)`, staggered 80 ms in STATS_ORDER, once per page load; the stacks fade/rise 12 px as
  their line arrives. `prefers-reduced-motion: reduce` or `settings.reduceMotion` → lines drawn at once, no fade.
* The three layouts follow the width the page content really has (the stage, a CSS container `perfstage`; the
  desktop sidebar takes part of the window), not the window width: **fan** from a 1060 px stage, **rows** from
  620 px, **trunk** below. The JS (`layoutFor`) compares the same unrounded width. The ranges below name them by
  their usual viewport widths.
* **≥ 1024 px**: five equal columns (`grid-template-columns: repeat(5, minmax(0, 1fr))`, gap 16 px), the lines fan
  out from the preview (≥ 96 px vertical space between preview and stacks).
* **600–1023 px**: a 6-track grid (`repeat(6, minmax(0, 1fr))`, column gap ≥ 24 px): YouTube/TikTok/Instagram span
  tracks 1–2/3–4/5–6 in row 1; Facebook spans 2–3 and X 4–5 in row 2, so their centres sit exactly at 1/3 and 2/3 of
  the width, in the gutters between the row-1 cards: their lines run straight down through those gutters, never over
  a card.
* **< 600 px (phones)**: stacks are full-width cards in one column with `padding-left: 44px` space; a trunk line
  runs from the preview's bottom centre, curves to `x = 20px` and runs down the left; each card gets a branch: from
  the trunk at the card's top + 28 px, a quarter-curve (`C` with 16 px handles) into the card's left edge at the
  platform mark. The trunk ends at the last branch. Cards stay full width minus the 16 px gutter; nothing overflows
  at 320 px.

**A stack** (`PlatformStack`, `<section aria-labelledby>`, glass card, same order as the DOM reads):
platform mark (`PlatformMark`) + name, a small crown icon with "Best" (visually hidden text) on `bestPlatform`; status
chip: Posted / Posted privately / Waiting for connection / Posting / Failed / Not posted; the big views number; metric
rows (icon, label, value; labels wrap, values never cut) showing **only** that platform's fields:
* YouTube: Views, Likes, Comments; slow group "Updates daily": Engaged views, Watch time, Average view, Average %
  watched, Shares, New subscribers.
* TikTok: Views, Likes, Comments, Shares.
* Instagram: Likes, Comments; slow group "Can take 2 days": Views (top number), Reach, Shares, Saves, Reposts, Average
  watch, Total watch, Skip rate.
* Facebook: slow group "Can take 2 days": Plays (top number), First plays, Replays, Reactions (emoji breakdown),
  Comments + shares, Average watch, Total watch, New followers, Reach (when present).
* X: Video views, Impressions, Likes, Reposts, Quotes, Replies, Bookmarks, Link clicks, Profile clicks, Watched to
  25/50/75/100 % (only while present).
Absent fields are not shown (no "0" rows). Then the sparkline (`Sparkline`, 120×32 SVG polyline of `series[platform]`,
≥ 2 points else hidden, `role="img"` `aria-label="Views went from 1.2K to 8.4K"`), "Updated 3 min ago" (fast) and,
for slow groups, "Insights from 2 days ago" (`insightsUpdatedAt`); "Open on {Platform}" link (`url`, new tab,
`rel="noopener noreferrer"`); "Next check in 12 min" when `nextAllowedAt` is in the future.
**Calm states** (no numbers, one plain line + one link button, never an error colour except Failed):
* Waiting for connection: "Connect {Platform} in Settings › Posting › Accounts." → `/settings/posting/accounts`.
* Not posted: "Not posted here. Turn on {Platform} in Settings › Posting › Where clips go." →
  `/settings/posting/where`.
* Posting: "Posting now…" with a small spinner.
* Posted privately (TikTok): "Posted privately. TikTok shows numbers after the app is approved."
* Posted, no metrics yet: "Numbers are on the way. Check back in a few minutes."
* Failed: "Posting failed: {error}. Go to Review and press Try again."

**Live**: `post` upserts for this clip's posts replace that stack's data (metrics, refreshing, nextRefreshAt) and add
a series point; `clip` upserts update the star; reconnect or `partial` → refetch `GET …/performance`. Polling fallback
while disconnected: every 60 s on this page.

**Library › This week** (`WeekView`): tabs "All clips | This week" (pills); header "This week · 10–16 Nov" (or "Week of
3–9 Nov") with ‹ › arrow buttons (› disabled on the current week, aria-labels "Earlier week"/"Later week"); list of
`WeekClip` cards sorted as served: rank number, cover, hook, total views (or "Not posted yet"), a row of five tiny
platform marks with views, and a big star toggle "Best this week" (≥ 48 px, `aria-pressed`). Toggling is optimistic
and saved by `PUT …/best` 800 ms after the last change (one request); a toast "Saved. Clip Factory will learn from your
picks." Under the header a status line from `learnState`: learning → "Learning from your picks…" (spinner); done →
the learning text in a glass quote with "Best of week" label; failed → "Could not learn this time. Change a pick to
try again."; none/skipped → "Star the clips that did best this week." Empty week: "No clips this week yet. Make clips
on Home." with a link. `week` events and `learning` upserts (kind `week`) update it live.

**Settings › Posting › Accounts** gets a leaf under X: "X charges a little for every number check. Clip Factory stops
at $10 a month." (value from a shared constant mirroring `platforms.json` `x.budget.monthlyUsd`, served in mock data).

### 16.9 Terraform (module `infra/modules/stats`, wired in `envs/prod`)

* **`cf-prod-stats`**: handler `clipfactory_api.stats.handler.handler`, python3.13, arm64, 256 MB, timeout 300 s,
  shared zip, X-Ray active, JSON logs `/aws/lambda/cf-prod-stats`, env `TABLE_NAME`, `STATS_TIME_BUDGET_SECONDS = 240`.
  No reserved concurrency (new accounts' limits forbid it; budgets are conditional writes).
  `aws_lambda_function_event_invoke_config`: `maximum_retry_attempts = 0`, `maximum_event_age_in_seconds = 900`.
  Role `cf-prod-fn-stats`: `dynamodb:GetItem`, `PutItem`, `UpdateItem`, `Query`, `BatchGetItem` on the table and
  `index/*`; logs; X-Ray. (Phase 2 adds `secretsmanager:GetSecretValue` on `cf-prod/platforms/*`.)
* **EventBridge**: `aws_cloudwatch_event_rule` `cf-prod-stats`, `schedule_expression = "rate(${local.stats_tick}
  minutes)"` (15, from platforms.json), `state = "ENABLED"`; `aws_cloudwatch_event_target` → the function (unqualified
  ARN); `aws_lambda_permission` for `events.amazonaws.com` with `source_arn` = the rule ARN.
* **`cf-prod-learn`**: handler `clipfactory_api.weekly.handler`, 512 MB, timeout 300 s, env `TABLE_NAME`, `MODEL_ID`,
  `EMBED_MODEL_ID`, `VECTOR_BUCKET`, `VECTOR_INDEX`; event invoke config `maximum_retry_attempts = 1`,
  `maximum_event_age_in_seconds = 3600`. Role `cf-prod-fn-learn`: `dynamodb:GetItem`, `PutItem`, `UpdateItem`,
  `DeleteItem`, `Query`, `BatchGetItem` on the table and `index/*`; `bedrock:InvokeModel` on `model_invoke_arns` and
  the Titan ARN; `s3vectors:GetVectors`, `s3vectors:PutVectors` on the index ARN; logs; X-Ray.
* **api module**: env `STATS_FUNCTION_ARN`, `LEARN_FUNCTION_ARN` (unqualified ARNs built from names); IAM
  `lambda:InvokeFunction` on both.
* **data module**: `global_secondary_index { name = "gsi2", hash_key = "gsi2pk", range_key = "gsi2sk",
  projection_type = "ALL" }` + attributes `gsi2pk`, `gsi2sk` (S). Online, no data migration.
* Module inputs: `name`, `region`, `account_id`, `lambda_zip_path`, `table_name/arn`, `model_id`, `model_invoke_arns`,
  `embed_model_id`, `embed_model_arn`, `vector_bucket`, `vector_index`, `vector_index_arn`, `platforms_config_path`,
  `log_retention_days`; outputs `stats_function_arn`, `learn_function_arn`, `stats_rule_name`, `stats_tick_minutes`,
  `function_names = { stats = "cf-prod-stats", learn = "cf-prod-learn" }` (merged into monitoring). Env outputs (§10):
  `stats_function_name`, `learn_function_name`, `stats_rule_name`, `stats_tick_minutes`.
* The broadcast ESM filter gains `WEEK#` (§14.2). `docs/ARCHITECTURE.md` and the drawio add EventBridge →
  `cf-prod-stats` → platform APIs, `cf-prod-api` → `cf-prod-stats`/`cf-prod-learn`, `cf-prod-learn` → Bedrock + S3 Vectors.

### 16.10 Who builds what (five parallel builders; each stays inside its files)

| Builder | Owns |
|---|---|
| infra | `infra/**` (`modules/stats` new, `data` gsi2, `api` env/IAM, `realtime` filter `WEEK#`, `monitoring` alarms, `envs/prod` wiring/outputs, tftests), `config/platforms.json` (exactly §16.4) |
| api-core | `routes/performance.py`, `routes/weeks.py`, `performance.py`, `weeks.py`, `weekly.py`, `learn.py` (week helpers), `posts.py` (`mark_posted`, public Post additions), `clips.py` (`best`, `bestWeek`, `totalViews`), `http.py`/`app.py` wiring, `realtime/broadcast.py` (`week` type), `api/scripts/build_lambda.py` (copy platforms.json), their tests |
| api-stats | `stats/**`, `platforms/{base,stub,youtube,tiktok,instagram,facebook,x}.py`, `flows/clip_flow.py` (publish stats fields, `metrics` step via `refresh_posts`), `tests/test_stats*.py`, `tests/fixtures/stats/**`, `tests/test_flows.py` updates |
| agent | `agent/**` (§16.7) |
| web + docs | `web/**` (§16.8, mock fixtures, unit + e2e tests, screenshots), `docs/**` except this file (ARCHITECTURE, drawio, UX_DESIGN_SYSTEM, TESTING, DEPLOYMENT: X credits note) |

Shared names: `stats.refresh.refresh_posts(deps, posts, *, reason, now) -> RefreshReport`,
`stats.config.load() -> PlatformsConfig`, `stats.config.interval_for(cfg, platform, posted_at, now) -> int`
(minutes), `stats.budget.reserve/record`, `performance.public_performance(clip, posts, accounts, snapshots, now)`,
`weeks.week_bounds_ok(week, from_, to)`, `weeks.week_clips(store, user_id, from_, to)`, `weeks.public_week(item)`,
`posts.mark_posted(store, post, published, now)`, `learn.ask_week(bedrock, model_id, rows) -> (stop_reason, text)`.

### 16.11 Tests (offline, fakes only)

* **api-core** (`pytest`): performance always returns five platforms in STATS_ORDER with the status mapping of §16.2,
  totals ignore nulls, `bestPlatform` tie → earlier platform, series downsampled to ≤ 60 with the last point kept,
  404 for review/declined/other owner, internal fields absent; refresh: `too_soon` honours `nextRefreshAt`, `blocked`
  honours `blockedUntil`, `private`/`not_connected`/`not_posted`, a single async invoke with only the started post ids,
  invoke failure rolls the claim back, Meta notes present; weeks: bad id / bad from-to → 400, anchor rule (postedAt
  else decidedAt), sort order, PUT ≤ 10 / foreign clip → 400, same set → 200 and no invoke, transaction sets
  `best`/`bestWeek` and clears unpicked, `revision` increments, invoke payload; `learn_week`: superseded writes nothing,
  vectors best true/false (and survives vector errors), empty picks delete the old learning, stop reasons → `failed`,
  learning id reused on re-save, Converse config (maxTokens 4000, effort low, no temperature); broadcast maps `WEEK#`
  → `week` with `public_week`; build zip contains `clipfactory_api/config/platforms.json`.
* **api-stats**: `config.load` validates the repo file (all five platforms, the §16.4 values); `interval_for` tiers at
  47 h / 49 h / 8 d / 31 d; each adapter builds the exact URLs/bodies of §16.3 with the batch size (51 YouTube ids → 2
  requests, 21 TikTok → 2, 101 X → 2), X drops non-public fields for posts ≥ 30 days, and maps recorded responses in
  `tests/fixtures/stats/{youtube_videos_list,youtube_analytics_report,tiktok_video_query,instagram_media,facebook_video_insights,facebook_post_views,x_tweets_lookup}.json`
  to `PostMetrics` (ms → s, missing → absent, never `impressions` for Meta, X views from media `view_count`); error
  fixtures: YouTube `quotaExceeded` → blocked till 08:00 UTC, TikTok 429 → +1 min, Instagram 80002 with
  `estimated_time_to_regain_access` → blocked and **no retry**, BUC header ≥ 75 % → blocked, X 429 → `x-rate-limit-reset`,
  X monthly cap; `reserve` is atomic (two concurrent reservations over the limit → one blocked); `run_tick` reads only
  due posts, respects `STATS_TIME_BUDGET_SECONDS`, writes metrics + `statsDueAt`/`gsi2sk`, snapshot rules (60 min / 1 % /
  final), final at 30 days removes gsi2; YouTube insights only every 360 min and slow values kept between reads;
  phase-1 adapters with no account → `not_connected`, zero HTTP calls; manual refresh clears `refreshStartedAt` even on
  errors; handler never raises on expected errors; clip-flow `metrics` step uses `refresh_posts` and falls back to
  stored metrics when blocked; publish writes the §14.5 stats fields (private TikTok: no gsi2).
* **agent**: best query first then performed, dedupe, cap 8, fallback < 3; "Owner's pick" label; learnings brief
  orders week learnings first (≤ 4) then ≤ 10 others; finalize writes `best: false`.
* **infra** (`terraform test`, mock providers): rule `cf-prod-stats` `rate(15 minutes)` derived from platforms.json
  (a test override with all intervals 30 → `rate(30 minutes)`), target + permission source ARN, stats retry 0 / age 900,
  learn retry 1, IAM statements exactly as §16.9 (no `s3vectors` or `bedrock` on stats), api env + invoke permission,
  gsi2 present with projection ALL, ESM filter has the five prefixes, alarms for both functions, §10 outputs.
* **web** (Vitest): `lib/week.ts` (ISO week of 2026-01-01 = 2026-W01, 2027-01-01 = 2026-W53, Monday start, DST weeks
  give 167/169 h ranges), bezier path builder for the three layouts (`PerfLines.paths(layout, rects)`), compact number
  formatting, status → copy mapping, live merge of `post`/`week` events. **Playwright (mock mode)**,
  `e2e/performance.spec.ts`: Library card → `/clips/{id}`; five stacks in STATS_ORDER with their own metric labels (no
  "Saves" on TikTok, no "Impressions" on Instagram/Facebook); crown on the mock best; Refresh → spinner → numbers
  change (mock pushes a `post` event) → "Next check in" shown; too-soon tap → deny toast; each calm state copy and
  link target; star toggle persists; lines: five `path`s exist and at 1440 px every line ends within 2 px of its stack's
  top centre, at 800 px row-2 lines do not intersect row-1 cards, at 375 px a trunk + five branches; reduced motion →
  no animation (`getAnimations()` empty). `e2e/week.spec.ts`: This week tab, sorted by views, ‹ to the previous week and
  › disabled on the current one, star → one PUT after the debounce, "Learning from your picks…" → learning text after
  the mock `learning` event, empty week copy. `overflow.spec.ts` gains `/clips/{id}`, `/library?view=week` at 320, 375,
  600, 768, 1024, 1440 px (no horizontal scroll, no element outside its box); `screenshots.spec.ts` adds both pages at
  375 and 1440 px, light and dark.
