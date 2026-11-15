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
| Region | `eu-north-1` (Stockholm), variable `region`. CloudFront is global. |
| Model | Claude **Fable 5.1**, Bedrock model id `anthropic.claude-fable-5-1`, called through the **global** cross-region inference profile `global.anthropic.claude-fable-5-1`. Only `config/models.json` holds model ids. |
| Terraform state | S3 bucket `vars.CF_STATE_BUCKET` (default `lamo-labs-state-bucket`), key `clip-factory/prod/terraform.tfstate`, `use_lockfile = true`. |
| GitHub settings | variable `CF_DEPLOY_ROLE_ARN` (OIDC role, provided by the owner later), secret `CF_OWNER_EMAIL` (the only login), optional variables `CF_REGION`, `CF_STATE_BUCKET`. |
| Web origin | The CloudFront default domain (`https://dxxxx.cloudfront.net`), output `app_url`. No custom domain yet. |

`config/models.json`:
```json
{ "profilePrefix": "global", "agentModel": "fable-5-1",
  "models": { "fable-5-1": { "label": "Claude Fable 5.1", "modelId": "anthropic.claude-fable-5-1" } } }
```

## 2. Repository layout

```
/                           GitHub Pages legal site (do not move) + README.md
config/models.json          the only place model ids live
skills/<name>/SKILL.md      built-in skills, bundled into the agent image and seeded for the owner
docs/                       BUSINESS_REQUIREMENTS, ARCHITECTURE, CONTRACTS (this), AGENT, UX_DESIGN_SYSTEM,
                            DEPLOYMENT, SECURITY, TESTING, DECISIONS, ROADMAP; docs/architecture/aws-architecture.drawio
web/                        React 19 + Vite + TypeScript PWA (own package.json)
api/                        Python 3.13 Lambdas, standard library + boto3 only (uv project "clipfactory-api")
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

## 4. Web runtime config

CloudFront serves `/config.json` (written by `scripts/write-web-config.sh` from Terraform outputs at deploy time,
`Cache-Control: no-store`):
```json
{ "region": "eu-north-1", "userPoolId": "eu-north-1_xxx", "userPoolClientId": "xxx",
  "apiUrl": "https://xxxx.execute-api.eu-north-1.amazonaws.com", "version": "<git sha>" }
```
Local development: `web/public/config.json` is absent; `VITE_MOCK=1` (`npm run dev:mock`) runs the whole UI on an
in-memory mock API (fixtures + fake latency) with a fake signed-in owner. Playwright tests run in mock mode.

## 5. HTTP API (API Gateway HTTP API v2 → Lambda `cf-prod-api`)

Base: `${apiUrl}/v1`. JSON in and out, camelCase. Every route requires the JWT except `GET /v1/health`.
CORS: allow origins `app_url` and `http://localhost:5173`, methods GET/POST/PUT/PATCH/DELETE/OPTIONS, headers
`authorization, content-type`.
Errors: HTTP 4xx/5xx with body `{ "error": { "code": "snake_case_code", "message": "Plain sentence for the owner." } }`.
Codes: `bad_request`, `unauthorized`, `not_found`, `conflict`, `too_large`, `not_implemented`, `internal`.

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
| POST `/v1/clips/{clipId}/confirm` | `{ "captions"?: Partial<Captions> }` | `{ "clip": Clip, "posts": Post[] }` |
| POST `/v1/clips/{clipId}/decline` | – | `{ "clip": Clip }` (video files deleted) |
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
```
Ids are ULIDs (26 chars, time-sortable). Timestamps are ISO-8601 UTC strings.

## 6. DynamoDB (single table `cf-prod-data`, on-demand, PITR on)

Keys: `pk` (S), `sk` (S); GSI `gsi1` on `gsi1pk`/`gsi1sk` (projection ALL); TTL attribute `ttl`.
`userId` is the Cognito `sub`.

| Item | pk | sk | gsi1pk / gsi1sk | Other attributes |
|---|---|---|---|---|
| Settings | `USER#{userId}` | `SETTINGS` | – | Settings fields |
| Job | `USER#{userId}` | `JOB#{jobId}` | – | Job fields + `type="job"`, `userId`, `sessionId` (AgentCore session), `heartbeatAt` |
| Clip | `USER#{userId}` | `CLIP#{clipId}` | `JOB#{jobId}` / `CLIP#{rank:03d}` | Clip fields (minus URLs) + `type="clip"`, `userId`, `videoKey`, `coverKey` |
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
* Invocation payload (from the API Lambda via `bedrock-agentcore:InvokeAgentRuntime`, `runtimeSessionId =
  "cfjob-" + jobId + "-" + 8 random chars`, ≥ 33 chars):
  `{ "action": "process_job", "jobId": "...", "userId": "..." }` → immediate `{ "accepted": true, "jobId": "..." }`;
  the job runs in the background. `{ "action": "cancel", "jobId" }` stops it. `{ "action": "health" }` → `{ "ok": true }`.
* The agent owns the job's `status`, `steps`, `progress`, `heartbeatAt` (every ≤ 60 s while running) and creates the Clip
  items (status `review`). It never publishes anything.
* Model: environment `CF_MODEL_ID = global.anthropic.claude-fable-5-1`; Claude Agent SDK with
  `CLAUDE_CODE_USE_BEDROCK=1`, `ANTHROPIC_MODEL=$CF_MODEL_ID`. Direct Bedrock Converse calls (vision for facecam,
  structured outputs) use the same model id.
* Skills: built-in skills from `/app/skills` plus the owner's **enabled** skills from S3 are written to
  `<workdir>/.claude/skills/<name>/SKILL.md` (zips extracted) so the Claude Agent SDK loads them; their text is also
  included in the moment-selection prompt. The agent also receives the owner's latest 10 learnings.
* Pipeline steps (keys in §5): resolve (yt-dlp metadata / S3 head) → download (audio only for links; capped at
  `maxSourceHours`) → transcribe (Amazon Transcribe, word timestamps, language auto) → analyze (loudness spikes, chat
  of transcript windows) → select (Claude: 5–10 moments within `clipTarget`, six moment types, hooks) → render (ffmpeg:
  section download, facecam detection via Claude vision, 1080×1920, hook, ASS captions, cover) → checklist (skill
  section D, measured + Claude judgement, one fix pass, spares replace failures) → captions (per platform, required
  tags from the owner's notes) → finalize (job `ready`, `clipCount`).

### Agent environment variables
`CF_REGION`, `CF_TABLE`, `CF_MEDIA_BUCKET`, `CF_MODEL_ID`, `CF_SKILLS_DIR=/app/skills`, `CLAUDE_CODE_USE_BEDROCK=1`,
`ANTHROPIC_MODEL`, `AWS_REGION`.

## 9. Lambdas (one zip `api/dist/lambda.zip`, Python 3.13, arm64, package `clipfactory_api`)

| Function | Handler | Trigger | Environment |
|---|---|---|---|
| `cf-prod-api` | `clipfactory_api.http.handler` | HTTP API (all routes) | `TABLE_NAME`, `MEDIA_BUCKET`, `AGENT_RUNTIME_ARN`, `PUBLISH_QUEUE_URL`, `APP_URL`, `VERSION` |
| `cf-prod-publisher` | `clipfactory_api.publisher.handler` | SQS `cf-prod-publish` (batch 1) | `TABLE_NAME`, `MEDIA_BUCKET`, `PERF_CHECK_FUNCTION_ARN`, `SCHEDULER_ROLE_ARN`, `SCHEDULE_GROUP` |
| `cf-prod-perf-check` | `clipfactory_api.perf_check.handler` | EventBridge Scheduler one-time schedule `perf-{postId}` at `postedAt + 48h` | `TABLE_NAME`, `MODEL_ID` |
| `cf-prod-watchdog` | `clipfactory_api.watchdog.handler` | EventBridge rate(10 minutes) | `TABLE_NAME` |

* Confirm → API writes one `Post` per enabled platform (`pending_integration` while no account is connected for that
  platform, `queued` when connected) and sends `{ "userId", "clipId" }` to the publish queue.
* Publisher: posts `queued` ones through the platform adapter (adapters arrive in phase 2; today every platform is
  `pending_integration`), sets `postedAt`, and creates the 48-hour schedule.
* Perf check: reads metrics through the adapter (phase 2), stores them on the Post, and asks Claude to distil one
  short Learning from the owner's recent posts.
* Watchdog: a `running` job whose `heartbeatAt` is older than 15 minutes becomes `failed` ("The agent stopped
  responding. Press Retry.").

## 10. Terraform outputs (read by deploy.yml)

`app_url`, `api_url`, `region`, `user_pool_id`, `user_pool_client_id`, `web_bucket`, `distribution_id`,
`media_bucket`, `table_name`, `agent_runtime_arn`, `ecr_repository_url`.

Terraform input variables (envs/prod): `region`, `owner_email`, `agent_image_tag`, `lambda_zip_path`
(default `../../../api/dist/lambda.zip`), `alarm_email` (optional), `web_dev_origin` (default `http://localhost:5173`).

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

* **Confirm is safe to repeat.** `POST /v1/clips/{id}/confirm` on a clip that is already `confirmed` but whose publishing
  never got queued returns 200 `{clip, posts}` once 60 s have passed since the first confirm; otherwise 409. The web
  shows "Try again" for such clips. Internal clip fields `publishState` and `publishClaimAt` are never returned by the API.
* **Watchdog** also re-queues confirms that never reached the publish queue (env `PUBLISH_QUEUE_URL`).
* **One run per job.** Every agent write to a Job is conditional on `sessionId` = the session it was invoked with; a
  retry gives the job a new `sessionId` and the old run stops quietly at its next write.
* **Long sources.** Audio longer than 3 h 50 min is split for Transcribe into `jobs/{jobId}/source/audio.part{i}.m4a`
  and `transcript.part{i}*.json` (temporary, tagged `cf-retention=temporary`, 14-day lifecycle like the rest of `source/`).
* **perf-check outcomes** include `max_tokens`, `refusal` and `content_filtered` (logged; no Learning written).
* **TLS.** With the default `*.cloudfront.net` certificate CloudFront's protocol floor cannot be raised; TLS 1.2+ is
  enforced once a custom domain with an ACM certificate is attached (roadmap).
* **Words in the UI** (§12.4): "Keep" (was Confirm), "Throw away" (was Decline/Delete), "Try again" (was Retry).
