## 45. Lamo Stories: a second, separate workspace (owner request, 2026-11-21)

The owner asked for **Lamo Stories**, a second content studio inside Clip Factory that makes short animated story
videos (no voice-over: characters, faces, body language, sound effects, music, optional captions) and posts them to
**different** social accounts. One app, one sign-in, one owner; two workspaces with their own screens, libraries,
production jobs, settings and social connections. The existing app is the **Lamo Clips** workspace and must stay
exactly as it is. Sections 42 to 44 are left for pull requests that were open on 2026-11-21. Decisions: ADR-70 to
ADR-75. The owner's full request is the brief of this section; §45.20 maps each of its points to where it is met.

### 45.1 The rule above every other rule: Lamo Clips does not change

* No existing table, index, item, attribute, S3 prefix, secret, Lambda, route, prompt, screen, style or test is
  renamed, moved, replaced or re-shaped. Lamo Clips' data is never migrated: it **is** the built-in workspace.
* Everything new is **additive**: new item key prefixes in partitions of their own (§45.3), a new S3 prefix (§45.4),
  a new Secrets Manager prefix (§45.13), new routes under `/v1/workspaces` (§45.5), one new durable Lambda
  (§45.15), new IAM statements, new web routes under `/stories` (§45.16), new agent actions (§45.11).
* Existing code is touched only where a new thing must be plugged in, each touch listed in §45.19 with the test that
  proves the old path is byte-identical. Nothing new is shown in the Lamo Clips screens except the workspace switcher
  (§45.16.1), which sits in space that is empty today and moves no existing control.
* Every deploy: `Plan: N to add, M to change, 0 to destroy`, and the Delete gate line exactly "Delete gate: the plan
  deletes or replaces nothing that holds the owner's data." (§45.18).
* Lamo Stories stays hidden behind one web switch, `STORIES_ON` in `web/src/stories/flag.ts` (default `false`),
  until every piece has merged and the final check passed; the last pull request turns it on (§45.21). Server
  routes may go live before that: no Lamo Clips screen calls them.

### 45.2 Words

| Word | Meaning |
|---|---|
| workspace | One content studio of the owner: its own content, jobs, library, settings and social connections. |
| Lamo Clips | The built-in workspace `workspaceId = "clips"`, `workspaceType = "clips"`: today's whole app and all its data, unchanged. It is never written as an item. |
| Lamo Stories | A workspace of type `stories`. The first one has `workspaceId = "stories"` and the name "Lamo Stories"; later ones (for example "Lamo Cars") get a ULID. |
| story | One animated video project (the spec's *Content*, `contentType = "animation"`). |
| production job | One run that makes or remakes (part of) a story's video (the spec's *ProductionJob*). |
| social account | One authorized account, channel or Page connected **to one workspace** (the spec's *SocialAccount*). |
| publishing job | Sending one approved story to one social account (the spec's *PublishingJob*). |
| cast | The characters of one story, copied (looks and all) into its script when it is made, so a later edit to a character never changes a finished video (§45.9). |

Workspace types live in one registry, `WORKSPACE_TYPES` (`api/src/clipfactory_api/workspaces/types.py`, mirrored in
`web/src/stories/api/types.ts`): `clips` (built-in, exactly one, the existing app) and `stories`. A future brand is
either a new `stories` workspace with its own name (no code) or a new type (one registry entry plus its screens).
Nothing here assumes exactly two workspaces; nothing is built for brands that do not exist yet.

### 45.3 DynamoDB (the same table `cf-prod-data`; new partitions only)

Lamo Clips' partition `USER#{userId}` gets **no new items**. Two new kinds of partition:

| Item | pk | sk | Attributes |
|---|---|---|---|
| Workspace | `USER#{userId}#WSREG` | `WS#{workspaceId}` | `type="workspace"`, `userId`, `workspaceId`, `workspaceName`, `workspaceType`, `configuration` (map, §45.6), `version`, `createdAt`, `updatedAt` |
| Idea | `USER#{userId}#WS#{workspaceId}` | `IDEA#{ideaId}` | `type="ws_idea"`, `userId`, `workspaceId`, Idea fields (§45.7) |
| Character | same | `CHAR#{characterId}` | `type="ws_character"`, Character fields (§45.8), `version` |
| Story | same | `STORY#{storyId}` | `type="ws_story"`, Story fields (§45.9), internal `scriptKey`, `videoKey`, `coverKey`, `version` |
| Production job | same | `PJOB#{jobId}` | `type="ws_pjob"`, ProductionJob fields (§45.10), internal `sessionId`, `heartbeatAt` |
| Asset | same | `ASSET#{assetId}` | `type="ws_asset"`, Asset fields (§45.12), internal `key` |
| Social account | same | `SOCIAL#{platform}` | `type="ws_social"`, SocialAccount fields (§45.13), internal `refreshLeaseUntil`, `pendingUntil` |
| Publishing job | same | `PUBJOB#{publishingJobId}` | `type="ws_pubjob"`, PublishingJob fields (§45.14), internal `publishHandle`, `flowRun`, `flowExecutionArn` |
| OAuth state | `OAUTH#{nonce}` | `STATE` | the existing item (§17.4) plus `workspaceId` and `socialAccountId` (§45.13) |

* **Ownership is in the key.** The API builds every key from the JWT's `sub` and the path's workspace id; it never
  reads a user id from a body. A workspace that is not in `USER#{userId}#WSREG` answers `404 not_found` ("We could
  not find that workspace."), whatever its id. Every item also carries `userId` and `workspaceId`, and every read
  checks both against the request (a second, independent check: `workspaces.guard.owned(item, user_id, ws_id)`).
* **Why these prefixes.** The live-update and notification streams forward only the sort-key prefixes `JOB#`,
  `CLIP#`, `POST#`, `LEARNING#`, `WEEK#`, `ACCOUNT#`, `SETUP#`, `FOLLOW#`, `JOBLIVE#`, `CAMPAIGN#`, `CRCONN`, `CRSUB#`,
  `CRMONEY` (`infra/modules/realtime/main.tf`, `notify/main.tf`). No new sort key starts with any of them, so no
  Lamo Stories item can ever reach a Lamo Clips screen, notification or the stats poller (`gsi2` is never set on a
  new item; `gsi1` is not used by them either). Lamo Stories screens poll (§45.16.4).
* `SOCIAL#{platform}`: one social account per platform per workspace (the owner's table: one separate account per
  platform). `socialAccountId` = `{workspaceId}.{platform}` (stable, so a reconnect keeps the id; §45.14 stops a
  publishing job whose destination changed).
* Ids are ULIDs, timestamps ISO-8601 UTC, numbers through `db.to_dynamo`. Lists use `db.query_page` with the
  existing cursor helpers. `db.strip_keys` hides `pk`, `sk`, `gsi*`, `type`, `userId`, `ttl` as today.

### 45.4 S3 (the same media bucket; one new prefix)

| Prefix | What | Lifecycle |
|---|---|---|
| `ws/{userId}/{workspaceId}/characters/{characterId}/refs/{assetId}.{png\|jpg\|webp}` | reference images the owner uploads (≤ 10 MB, presigned PUT 15 min) | kept |
| `ws/{userId}/{workspaceId}/characters/{characterId}/portrait/{assetId}.png` | an AI portrait (only when the image provider is on, §45.11.6) | kept |
| `ws/{userId}/{workspaceId}/stories/{storyId}/script/v{n}.json` | the story script (storyboard), one file per version | kept |
| `ws/{userId}/{workspaceId}/stories/{storyId}/scenes/{sceneId}/v{n}.mp4`, `still-v{n}.jpg` | each scene's animation and still | kept |
| `ws/{userId}/{workspaceId}/stories/{storyId}/audio/v{n}.m4a` | the sound effects, noises and music mix | kept |
| `ws/{userId}/{workspaceId}/stories/{storyId}/captions/v{n}.ass` | the on-screen captions and bubble text | kept |
| `ws/{userId}/{workspaceId}/stories/{storyId}/final/v{n}.mp4`, `cover-v{n}.jpg` | the finished 1080×1920 video and its cover | kept |
| `ws/{userId}/{workspaceId}/images/{assetId}.png` | other generated images (backgrounds) | kept |

No Lamo Clips prefix (`uploads/`, `jobs/`, `skills/`, `private/`, `ask/`, `campaigns/`) is read or written by Lamo
Stories code, and no Lamo Clips code reads `ws/`. The Library lists only `ASSET#` items of its workspace (§45.12),
never S3 listings. Presigned GETs last 1 hour; a download adds `ResponseContentDisposition: attachment;
filename="{slug}.mp4"`.

### 45.5 HTTP API (cf-prod-api, JWT on every route, §5 errors)

All under `/v1/workspaces`. `{ws}` is a workspace id (`^(clips|stories|[0-9A-HJKMNP-TV-Z]{26})$`, else 404). Routes
marked **S** need a `stories` workspace: on `clips` they answer `409 conflict` "That is a Lamo Stories page. Switch to
Lamo Stories first." Bodies are validated with `validate.py`; unknown keys are `400`.

| Method & path | Body | 2xx |
|---|---|---|
| GET `/v1/workspaces` | – | `{ "workspaces": Workspace[] }`: Lamo Clips first, then the owner's workspaces by `createdAt`. The first call creates `stories` ("Lamo Stories") with a conditional put (two calls at once make one). |
| POST `/v1/workspaces` | `{ "workspaceType": "stories", "workspaceName" }` (1–40 chars, unique per owner, at most 10 workspaces) | `201 { "workspace" }` (API only; no screen in this section) |
| GET `/v1/workspaces/{ws}` | – | `{ "workspace" }` |
| PATCH `/v1/workspaces/{ws}` **S** | `{ "workspaceName"?, "configuration"?: Partial<StoriesConfig>, "version" }` | `{ "workspace" }`; `409` on a stale `version` |
| GET `/v1/workspaces/{ws}/dashboard` **S** | – | `{ "dashboard": StoriesDashboard }` (§45.16.3) |
| GET `/v1/workspaces/{ws}/ideas` **S** | query `status?` (`saved` \| `used` \| `all`, default `all`) | `{ "ideas": Idea[] }` newest first |
| POST `/v1/workspaces/{ws}/ideas` **S** | `IdeaInput` | `201 { "idea" }` |
| PATCH `/v1/workspaces/{ws}/ideas/{ideaId}` **S** | `Partial<IdeaInput>` | `{ "idea" }` |
| DELETE `/v1/workspaces/{ws}/ideas/{ideaId}` **S** | – | `204` |
| POST `/v1/workspaces/{ws}/ideas/generate` **S** | `{ "topic"?: string (≤ 200), "category"?: IdeaCategory, "count"?: 1–6 (default 4) }` | `{ "drafts": IdeaInput[] }` (nothing saved; the owner taps Save) |
| POST `/v1/workspaces/{ws}/ideas/{ideaId}/expand` **S** | `{ "durationSec"?: 15–90 }` | `{ "idea" }` with `concept` filled |
| POST `/v1/workspaces/{ws}/ideas/{ideaId}/variations` **S** | `{ "count"?: 1–4 (default 3) }` | `{ "drafts": IdeaInput[] }` |
| GET `/v1/workspaces/{ws}/characters` **S** | – | `{ "characters": Character[] }` by name |
| POST `/v1/workspaces/{ws}/characters` **S** | `CharacterInput` | `201 { "character" }`; `409` on a duplicate name |
| GET `/v1/workspaces/{ws}/characters/{characterId}` **S** | – | `{ "character" }` (reference URLs presigned) |
| PUT `/v1/workspaces/{ws}/characters/{characterId}` **S** | `CharacterInput & { "version" }` | `{ "character" }`; `409` stale |
| DELETE `/v1/workspaces/{ws}/characters/{characterId}` **S** | – | `204`; `409` "{name} is in a story that is being made. Wait until it is done." while a running job's cast holds it |
| POST `/v1/workspaces/{ws}/characters/{characterId}/references` **S** | `{ "filename", "contentType": "image/png" \| "image/jpeg" \| "image/webp", "size" ≤ 10 MB }` | `{ "assetId", "uploadUrl", "headers" }` |
| POST `/v1/workspaces/{ws}/characters/{characterId}/references/{assetId}/complete` **S** | – | `{ "character" }` (HEAD checks size and type; at most 8 references) |
| DELETE `/v1/workspaces/{ws}/characters/{characterId}/references/{assetId}` **S** | – | `{ "character" }` |
| POST `/v1/workspaces/{ws}/characters/{characterId}/portrait` **S** | – | `202 { "job" }` (an AI portrait job, §45.11.6); `409` with the provider's activation sentence when off |
| GET `/v1/workspaces/{ws}/stories` **S** | query `status?` (a StoryStatus or `all`), `limit` ≤ 50, `cursor` | `{ "stories": Story[], "nextCursor" }` newest first |
| POST `/v1/workspaces/{ws}/stories` **S** | `StoryInput` | `201 { "story", "job" }` (starts production at `storyboard`) |
| GET `/v1/workspaces/{ws}/stories/{storyId}` **S** | – | `{ "story", "job": ProductionJob \| null, "script": StoryScript \| null }` (URLs presigned) |
| PATCH `/v1/workspaces/{ws}/stories/{storyId}` **S** | `{ "version", "title"?, "postCaptions"?: Partial<Captions>, "captions"?: CaptionCue[], "sfx"?: SfxCue[], "musicMood"?: MusicMood, "captionsOn"?: boolean, "scenes"?: SceneEdit[] }` (only in `review` or `changes_requested`) | `{ "story", "script" }`; a script edit writes `v{n+1}` and sets `story.stale` to the steps that must run again |
| DELETE `/v1/workspaces/{ws}/stories/{storyId}` **S** | – | `204` (stops a running job first; its assets and S3 files are deleted; publishing jobs and posts already on platforms stay) |
| POST `/v1/workspaces/{ws}/stories/{storyId}/produce` **S** | `{ "from"?: StepKey (default: the first stale step, else `storyboard`), "sceneIds"?: string[] (only with `from` ∈ `scenes`,`animation`), "note"?: string (≤ 500) }` | `202 { "story", "job" }`; `409` while a job runs |
| POST `/v1/workspaces/{ws}/stories/{storyId}/cancel` **S** | – | `{ "story", "job" }` |
| POST `/v1/workspaces/{ws}/stories/{storyId}/approve` **S** | `{ "version" }` | `{ "story" }` (only `review`; never while `safety.status = "problems"`) |
| POST `/v1/workspaces/{ws}/stories/{storyId}/reject` **S** | `{ "reason"?: string }` | `{ "story" }` |
| POST `/v1/workspaces/{ws}/stories/{storyId}/changes` **S** | `{ "note": string (1–500), "sceneIds"?: string[] }` | `202 { "story", "job" }` (rewrites those scenes, or the whole story, with the note, then remakes what changed) |
| GET `/v1/workspaces/{ws}/stories/{storyId}/download` **S** | – | `{ "url", "filename" }` (only `approved` or `published`) |
| GET `/v1/workspaces/{ws}/library` **S** | query `kind?` (an AssetKind or `all`), `storyId?`, `characterId?`, `limit` ≤ 100, `cursor` | `{ "items": LibraryItem[], "nextCursor" }` |
| GET `/v1/workspaces/{ws}/providers` **S** | – | `{ "providers": ProviderStatus[] }` (§45.11.6) |
| GET `/v1/workspaces/{ws}/guidance` **S** | – | `{ "topics": GuidanceTopic[], "checkedAt" }` (§45.11.5) |
| GET `/v1/workspaces/{ws}/social` **S** | – | `{ "accounts": SocialAccount[] /* 5, in PLATFORM order */, "clips": ClipsDestination[] }` |
| POST `/v1/workspaces/{ws}/social/{platform}/connect` **S** | – | `{ "authorizeUrl", "expiresAt" }` (§45.13.2); `409` "Lamo Clips has no {Platform} app keys yet. Set up {Platform} in Lamo Clips first (Settings › Posting › Set up posting, steps up to the keys)." |
| POST `/v1/workspaces/{ws}/social/{platform}/choose` **S** | `{ "choiceId" }` | `{ "account" }` |
| POST `/v1/workspaces/{ws}/social/{platform}/share` **S** | `{ "confirm": true }` | `{ "account" }` (the owner's explicit "use the same {place} as Lamo Clips", §45.13.4) |
| POST `/v1/workspaces/{ws}/social/{platform}/check` **S** | – | `{ "account" }` (a live profile call; `token_dead` → `needs_reconnect`) |
| DELETE `/v1/workspaces/{ws}/social/{platform}` **S** | – | `204` (revoke best effort, delete this workspace's secret, account `not_connected`; Lamo Clips' connection is never touched) |
| POST `/v1/workspaces/{ws}/stories/{storyId}/publish` **S** | `{ "targets": [{ "platform", "socialAccountId", "options"?: PublishOptions }] (1–5, each platform once) }` | `202 { "publishingJobs": PublishingJob[] }` (§45.14) |
| GET `/v1/workspaces/{ws}/publishing` **S** | query `storyId?` | `{ "publishingJobs": PublishingJob[] }` newest first |
| POST `/v1/workspaces/{ws}/publishing/{publishingJobId}/retry` **S** | `{ "options"?: PublishOptions }` | `202 { "publishingJob" }` (only `failed` or `needs_attention`) |

`/v1/accounts*`, `/v1/setup*`, `/v1/clips*`, `/v1/jobs*` and every other existing route are unchanged and never see
Lamo Stories data. Route modules: `routes/workspaces/core.py` (workspaces, dashboard, ideas, characters, stories,
library, providers, guidance) and `routes/workspaces/social.py` (social, publish, publishing), assembled in
`routes/workspaces/__init__.py` and appended once at the end of `ROUTES`.

### 45.6 Shapes (TypeScript notation; `web/src/stories/api/types.ts` is the copy the web compiles)

```ts
type WorkspaceType = "clips" | "stories";
interface Workspace { workspaceId: string; workspaceName: string; workspaceType: WorkspaceType; builtin: boolean;
  configuration: StoriesConfig | Record<string, never> /* clips: {} (its settings stay in Settings) */;
  version: number; createdAt?: string; updatedAt?: string }
interface StoriesConfig { defaultDurationSec: number /* 15..90, default 45 */; captionsOn: boolean /* default true */;
  musicOn: boolean /* default true */; storyModel: string /* a key of clipModels in config/models.json, default
  agentModel */; imageProvider: "builtin" | "nova-canvas" /* default builtin */; postPreset: boolean /* default true:
  the owner's "Use my settings" choices (§36) apply to Lamo Stories posts too */ }

type IdeaCategory = "driving_safety" | "everyday_skills" | "comedy" | "explainer";
interface IdeaInput { title: string /* 1..80 */; logline: string /* 1..280 */; category: IdeaCategory;
  characterIds?: string[] /* ≤ 3 */; concept?: VideoConcept; source?: "manual" | "ai" | "variation";
  parentIdeaId?: string }
interface Idea extends IdeaInput { ideaId: string; workspaceId: string; status: "saved" | "used";
  safetyTopicId: string | null /* a GuidanceTopic id when category is driving_safety and one matches */;
  needsGuidance: boolean /* a safety idea no checked guidance covers: it cannot be produced (§45.11.5) */;
  storyIds: string[]; createdAt: string; updatedAt: string }
interface VideoConcept { premise: string; beats: string[] /* 3..8 short lines */; lesson: string | null;
  ending: string; tone: "funny" | "calm" | "tense_then_relief" | "wholesome"; durationSec: number;
  onScreenText: string[] /* ≤ 6 short captions */ }

type Expression = "neutral" | "happy" | "laughing" | "surprised" | "shocked" | "scared" | "worried" | "angry"
  | "determined" | "thinking" | "sad" | "proud" | "dizzy" | "relieved";
type MovementStyle = "bouncy" | "calm" | "clumsy" | "zippy" | "heavy";
interface CharacterLook { body: "bean" | "round" | "tall" | "square"; skin: Hex; height: number /* 0.85..1.15 */;
  width: number /* 0.85..1.15 */; hair: { style: "none" | "short" | "spiky" | "curly" | "long" | "bun" | "cap";
  color: Hex }; eyes: { shape: "round" | "oval" | "sleepy"; color: Hex }; brows: "thin" | "thick";
  nose: "dot" | "button" | "long" | "none"; mouth: "small" | "wide"; outfit: { top: Hex; bottom: Hex; accent: Hex;
  pattern: "plain" | "stripes" | "dots" }; accessory: "none" | "glasses" | "scarf" | "bowtie" | "helmet"
  | "headphones"; outline: Hex }
type Hex = string; // "#rrggbb"
interface CharacterVoice { style: "babble" | "hum" | "none"; pitch: number /* 0.5..2 */;
  noises: NoiseId[] /* the non-verbal noises this character makes, ≤ 8 */; sfx: SfxId[] /* favourite effects, ≤ 8 */ }
interface CharacterInput { name: string /* 1..30, unique */; description: string /* ≤ 400 */;
  personality: string /* ≤ 400 */; traits: string[] /* ≤ 8 × ≤ 30 */; movementStyle: MovementStyle;
  expressions: Expression[] /* the faces it uses, ≥ 3, always includes neutral */; look: CharacterLook;
  voice: CharacterVoice }
interface Character extends CharacterInput { characterId: string; workspaceId: string;
  references: { assetId: string; url: string; contentType: string; createdAt: string }[];
  portrait: { assetId: string; url: string } | null; storyCount: number; version: number;
  createdAt: string; updatedAt: string }

type StoryStatus = "draft" | "producing" | "needs_check" | "review" | "changes_requested" | "approved"
  | "rejected" | "published" | "failed";
type MusicMood = "none" | "calm" | "playful" | "tense" | "triumphant" | "wonder" | "comedic";
interface StoryInput { ideaId?: string; concept?: VideoConcept /* when there is no idea */; title?: string;
  characterIds: string[] /* 1..3 */; durationSec?: number /* 15..90, default config */; captionsOn?: boolean;
  musicMood?: MusicMood }
interface Captions { youtubeTitle: string; youtubeDescription: string; instagram: string; facebook: string;
  tiktok: string; x: string }   // the same shape as Lamo Clips' (§5), so the platform publishers take it as is
interface Story { storyId: string; workspaceId: string; contentType: "animation"; title: string;
  status: StoryStatus; ideaId: string | null; characterIds: string[]; durationSec: number;
  actualDurationSec: number | null; captionsOn: boolean; musicMood: MusicMood; postCaptions: Captions;
  scenes: { sceneId: string; title: string; durationSec: number; stillUrl?: string }[];
  scriptVersion: number; videoUrl?: string; coverUrl?: string /* presigned, 1 h */;
  storageLocation: string /* "s3://<bucket>/ws/<userId>/<workspaceId>/stories/<storyId>/" */;
  stale: StepKey[] /* steps an edit made out of date */; safety: StorySafety | null;
  reviewNote: string | null; currentJobId: string | null; posted: { platform: Platform; url: string }[];
  version: number; createdAt: string; updatedAt: string; approvedAt?: string; publishedAt?: string }
interface StorySafety { topicId: string; status: "ok" | "problems"; problems: string[];
  citations: { publisher: string; title: string; url: string; section?: string }[] }
type StepKey = "storyboard" | "safety" | "scenes" | "animation" | "sound" | "captions" | "assemble" | "preview";
// Labels, in this order: "Write the story", "Check the facts", "Draw the scenes", "Animate", "Add sounds and music",
// "Add captions", "Put it together", "Ready to watch".
interface StoryStep { key: StepKey; label: string; status: "pending" | "running" | "done" | "failed" | "skipped";
  message?: string; startedAt?: string; finishedAt?: string; i?: number; n?: number /* scenes done of all */ }
interface ProductionJob { jobId: string; workspaceId: string; contentId: string /* = storyId */;
  jobType: "produce" | "changes" | "portrait"; status: "queued" | "running" | "ready" | "needs_check" | "failed"
  | "canceled"; steps: StoryStep[]; progress: number /* 0..1 */;
  configuration: { from: StepKey; sceneIds: string[] | null; note: string | null; characterId?: string };
  error?: string; createdAt: string; updatedAt: string }
interface SceneEdit { sceneId: string; caption?: string | null; durationSec?: number; sfx?: SfxCue[] }
interface CaptionCue { id: string; at: number; dur: number; text: string /* ≤ 60 */; guidanceRef?: string }
interface SfxCue { id: string; at: number /* s, whole video */; sfx: SfxId; volume: number /* 0..1 */ }

type AssetKind = "final_video" | "cover" | "storyboard" | "scene_clip" | "scene_still" | "character_ref"
  | "portrait" | "generated_image" | "audio" | "captions";
interface LibraryItem { assetId: string; kind: AssetKind; storyId: string | null; characterId: string | null;
  title: string; url: string /* presigned 1 h */; contentType: string; bytes: number; version: number | null;
  createdAt: string; meta: Record<string, string | number> }

type Platform = "youtube" | "instagram" | "facebook" | "tiktok" | "x";
interface SocialAccount { socialAccountId: string; workspaceId: string; platform: Platform;
  connectionStatus: "not_connected" | "connected" | "choose_account" | "needs_reconnect" | "same_as_clips";
  externalAccountId: string | null; accountName: string | null; handle: string | null; avatarUrl: string | null;
  sharedWithClips: boolean; connectedAt: string | null; missing: string[]; reason: string | null;
  choices: { id: string; name: string; avatarUrl?: string; usedByClips: boolean }[] | null;
  limits: string[] /* plain sentences: this platform's rules for a second account, §45.13.5 */ }
interface ClipsDestination { platform: Platform; connected: boolean; name: string | null }
  // Lamo Clips' own destination per platform, names only (to warn about the same place); never ids or tokens
interface PublishOptions { tiktok?: { privacyLevel: string; disableComment: boolean; disableDuet: boolean;
  disableStitch: boolean; brandContent: boolean; brandOrganic: boolean } /* §17.8 rules */;
  youtubePrivacy?: "public" | "unlisted" | "private" }
interface PublishingJob { publishingJobId: string; workspaceId: string; contentId: string; socialAccountId: string;
  platform: Platform; publishingStatus: "queued" | "publishing" | "posted" | "failed" | "needs_attention";
  accountName: string | null; url?: string; postedAt?: string; error?: string;
  metrics?: { views: number | null; likes: number | null; comments: number | null; shares: number | null;
  checkedAt: string }; createdAt: string; updatedAt: string }
```

### 45.7 Ideas

* **Manual**: the owner types a title, a line and a category (four big buttons).
* **AI ideas, Expand and Variations** run in `cf-prod-api` (answers in 5–15 s, inside API Gateway's 29 s) through
  `learn.converse_text(..., skills=...)` with the `helpModel` (Claude Haiku 5.5, EU profile, already granted to the
  API). Every call gets the owner's skills block first (§18.6, the owner's rule for every AI call; see ADR-74), then
  the Lamo Stories house brief: no voice-over, told through movement, faces, body language, sound and music, 9:16,
  15–90 s, recurring characters (the saved characters' names and personalities are passed), never made for children,
  and for `driving_safety`: only topics in the checked guidance list (§45.11.5), each draft tagged with the matching
  topic id or `needsGuidance: true`. Structured output (one tool, a JSON schema), validated by code; a bad answer is
  asked once more, then "The idea helper is busy. Try again in a minute." (503 `platform_down`). Time limit 22 s.
* Expand fills `concept` (premise, 3–8 beats, the lesson or `null`, the ending, the tone, the duration, on-screen
  text), keeping the title. Variations return new drafts with `source: "variation"` and `parentIdeaId`.
* An idea becomes `used` when a story is made from it (its `storyIds` grow); it can still make more stories.

### 45.8 Characters and keeping them the same

* A character is a **rig**, not a picture: `look` is a small set of choices (body, skin, hair, eyes, brows, nose,
  mouth, outfit colours and pattern, accessory, size, outline). The animation engine (§45.10) draws the same rig the
  same way every time, so a character looks identical in every video by construction. Expressions, movement style,
  noises and favourite sound effects are part of the character too.
* The writer (§45.11.2) only names characters by their cast id; it never describes or changes how they look. Each
  story copies the cast's `look`, `movementStyle` and `voice` into its script when production starts. A later edit
  to a character shows in new stories (and in a remake the owner starts), never silently in a finished one.
* Reference images (the owner's uploads, up to 8) are kept with the character and shown next to the rig; when the
  image provider is on (§45.11.6) an AI portrait can be made from the character's own description and look with a
  fixed seed. Neither changes the rig.
* The Characters page edits a character with a live preview (every face, the walk, the wave) drawn by the same
  engine in the browser.

### 45.9 Stories and the production workflow

The owner's ten steps (spec §5.D) map onto one story's life:

| Spec step | Where |
|---|---|
| 1. Pick an idea or type a concept | Production › New: an idea card or a short concept form |
| 2. Pick a character | Pick 1–3 saved characters (each shown with its rig) |
| 3. Storyboard | Job step `storyboard` (the writer, §45.11.2) and, for safety topics, `safety` (§45.11.5) |
| 4. Scenes | Step `scenes`: each scene's still, and the storyboard view with live engine previews |
| 5. Animation | Step `animation`: each scene rendered to 1080×1920 at 30 fps |
| 6. Sound effects and music | Step `sound`: the effects, the character noises and the music mood, mixed |
| 7. Captions (optional) | Step `captions`: the on-screen text (on or off per story) |
| 8. Assemble | Step `assemble`: one MP4 plus a cover |
| 9. Preview | Step `preview`: the story goes to `review`; the player shows it |
| 10. Approve or request changes | Review (§45.16.6): Approve, Reject, Ask for changes, remake a scene or all |

* Output: **9:16 vertical, 1080×1920, 30 fps, H.264 + AAC**, 15–90 s (default 45, `StoriesConfig.defaultDurationSec`);
  the writer aims for the length and code keeps the total within ±10%.
* Status: `draft` (made, no job yet) → `producing` → `review` (or `needs_check` when the fact check found problems;
  the owner edits the captions and taps Check again) → `approved` / `rejected` / `changes_requested` (→ `producing`)
  → `published` (at least one post up). `failed` when a job failed (Try again remakes from the failed step).
* A remake only redoes what changed: editing captions marks `captions`, `assemble` stale; editing a scene's effects
  marks `sound`, `assemble`; "Remake this scene" runs `scenes`, `animation` for that scene, then `sound`, `captions`,
  `assemble`; "Remake the whole video" runs from `storyboard` (a new script version).

### 45.10 The animation engine (one file, two places)

`web/src/stories/engine/engine.ts`: dependency-free TypeScript (no imports, no DOM, no `Date`, no randomness except
a seeded PRNG), so the **browser** draws it for live previews and the **agent** runs the very same file with Deno
(already in the agent image) for the final frames. One source of truth for how a character moves; the preview and the
video match.

```ts
export const ENGINE_VERSION: number;           // bumps when drawing changes; stored on each rendered scene
export const CATALOG: Catalog;                 // every id below with a plain label (the writer's vocabulary)
export function validateScript(s: unknown): { ok: true; script: StoryScript } | { ok: false; errors: string[] };
export function fitDuration(s: StoryScript, targetSec: number): StoryScript;  // scales scenes to within ±10%
export function frameCount(s: StoryScript): number;                           // round(durationSec × fps)
export function drawFrame(s: StoryScript, frame: number): Prim[];             // pure and deterministic
export function sceneFrames(s: StoryScript, sceneId: string): [number, number];
export function textTrack(s: StoryScript): TextEvent[];   // captions and bubble text with times and positions
export function audioTrack(s: StoryScript): AudioEvent[]; // every effect and noise with its absolute time
export function previewCharacter(look: CharacterLook, style: MovementStyle, expression: Expression,
  action: ActionId, t: number, size: number): Prim[];      // the Characters page
// Prims are in output pixels (0..1080 × 0..1920), painter's order, colours "#rrggbb", alpha a 0..1:
type Prim =
  | { k: "fill"; color: Hex }                                     // the whole frame
  | { k: "grad"; x0: number; y0: number; x1: number; y1: number; stops: [number, Hex][] } // whole frame, linear
  | { k: "rect"; x: number; y: number; w: number; h: number; r: number; color: Hex; a?: number }
  | { k: "circle"; x: number; y: number; r: number; color: Hex; a?: number }
  | { k: "ellipse"; x: number; y: number; rx: number; ry: number; rot: number; color: Hex; a?: number }
  | { k: "poly"; pts: number[]; color: Hex; a?: number }          // flattened curves, non-zero fill
  | { k: "line"; pts: number[]; w: number; color: Hex; a?: number } // round caps and joins
  | { k: "image"; asset: string; x: number; y: number; w: number; h: number; a?: number };
```

**The story script** (the storyboard; stored as `script/v{n}.json`):

```ts
interface StoryScript { engine: number; fps: 30; width: 1080; height: 1920; durationSec: number; title: string;
  seed: number; cast: Record<CastId, { characterId: string; name: string; look: CharacterLook;
  movementStyle: MovementStyle; voice: CharacterVoice }>; scenes: Scene[]; music: { mood: MusicMood;
  volume: number } | null; captionsOn: boolean; captions: CaptionCue[]; sfx: SfxCue[] /* owner-added effects */;
  safety: { topicId: string; citations: StorySafety["citations"] } | null }
interface Scene { sceneId: string; title: string /* ≤ 40 */; durationSec: number /* 2..15 */; set: SetId;
  view: "side" | "top" /* top: a road from above, for showing how a car moves */; camera: CameraId;
  actors: { castId: CastId; x: number; y: number /* 0..1 of the frame */; facing: "left" | "right";
  inCar?: string /* a prop id */ }[];
  props: { propId: string; kind: PropKind; x: number; y: number; scale: number; rot: number; color?: Hex;
  state?: string }[];
  beats: Beat[]; caption: string | null /* ≤ 60, on-screen teaching text */; note: string | null }
interface Beat { at: number; dur: number /* seconds inside the scene */; who: CastId | string /* prop id */;
  do: ActionId | PropAction; face?: Expression; to?: { x: number; y: number }; dir?: "left" | "right";
  bubble?: BubbleId; noise?: NoiseId; sfx?: SfxId }
```

**The vocabulary** (`CATALOG`; the writer may use nothing else, `validateScript` rejects unknown ids):
* actions: `idle`, `walk`, `run`, `jump`, `wave`, `point`, `shrug`, `facepalm`, `celebrate`, `cower`, `sit`,
  `drive`, `steer_left`, `steer_right`, `brake`, `brace`, `look_left`, `look_right`, `nod`, `shake_head`,
  `thumbs_up`, `slip`, `fall`, `get_up`, `dance`, `think`, `gesture`, `gasp`;
* prop actions: `move`, `skid`, `spin`, `stop`, `bump`, `tyre_burst`, `appear`, `vanish`, `wobble`, `flash`;
* sets: `studio`, `road_day`, `road_night`, `icy_road`, `snowy_road`, `rainy_road`, `foggy_road`, `highway`,
  `country_road`, `city_street`, `parking_lot`, `kitchen`, `living_room`, `office`, `park`;
* props: `car`, `truck`, `tyre`, `ice_patch`, `puddle`, `warning_triangle`, `phone`, `steering_wheel`, `stop_sign`,
  `ice_sign`, `tree`, `cone`, `deer`, `arrow`, `check`, `cross`, `exclamation`, `question`, `heart`, `sparkles`,
  `snow`, `rain`, `fog`, `dust`;
* cameras: `wide`, `medium`, `close`, `pan_left`, `pan_right`, `shake`, `push_in`;
* bubbles (no words: symbols only): `question`, `exclaim`, `idea`, `music`, `dots`, `heart`, `angry`, `sweat`, `zzz`;
* noises (non-verbal): `gasp`, `whoa`, `hmm`, `yay`, `oops`, `laugh`, `giggle`, `sigh`, `yelp`, `phew`, `babble`;
* effects: `whoosh`, `skid`, `screech`, `tyre_burst`, `thud`, `bump`, `honk`, `engine`, `brake_squeal`, `pop`,
  `boing`, `ding`, `tada`, `sad_trombone`, `footsteps`, `wind`, `rain`, `snow_crunch`, `click`, `beep`, `swoosh_up`,
  `heartbeat`, `tick`;
* music moods: as `MusicMood`.

Movement styles change the timing curves (bouncy overshoots, heavy settles slowly, clumsy wobbles, zippy is quick,
calm eases). `deno run --allow-read web/src/stories/engine/cli.ts <command> <script.json>` with `validate`
(prints `{ok, errors}`), `frames [from] [to]` (one JSON line per frame: `{"f":n,"p":Prim[]}`), `text`, `audio`
and `fit <seconds>`; it never reads the network and writes only to stdout.

### 45.11 The agent's part (AgentCore runtime `cf_prod_clip_agent`, new actions only)

#### 45.11.1 Actions

* `{ "action": "process_story", "userId", "workspaceId", "storyId", "jobId" }` → `{ "accepted": true, "jobId" }`
  at once; the job runs in the background like a clip job. `{ "action": "cancel_story", "jobId" }` stops it.
  The API invokes with `runtimeSessionId = "cfstory-" + jobId + "-" + 8 random chars` and stores it on the job.
* `server.py` gains these two actions and nothing else: `process_job`, `cancel` and `health` keep their exact
  validation and answers; `/ping` says `HealthyBusy` while a clip job **or** a story job runs. All story code lives in
  `agent/src/clipfactory_agent/stories/` and imports nothing from the clip pipeline modules except `bedrock.py`,
  `skills.py`, `util.py`, `proc.py`, `retry.py` and `store.py`'s table client.
* The job heartbeats `heartbeatAt` every ≤ 60 s; the API marks a `running` job whose heartbeat is older than 6 minutes
  `failed` ("Making the video stopped. Tap Try again.") when it is read. Writes are fenced on `sessionId` as clip
  jobs are. Every failure sentence names the button ("Tap Try again"), never raw tool output.

#### 45.11.2 The writer (`storyboard` step)

`Bedrock.structured(skills=block, tool="write_storyboard", schema=STORYBOARD_SCHEMA)` with the workspace's
`storyModel` (default the agent's model): the concept, the cast (names, personalities, traits, movement styles, the
faces and noises each has; never the look), the catalog (§45.10), the target length, the captions switch, for
safety stories the guidance topic (§45.11.5), and for changes the current script and the owner's note (only the named
scenes change). The answer becomes a `StoryScript` (code adds `engine`, `fps`, `seed`, `cast` with looks), passes
`validateScript` (through the engine CLI) and `fitDuration`; a failing answer is asked once more with the errors. It
also writes the six post captions (`Captions`): YouTube title ≤ 100 chars, the others within §17.6's limits, the
safety sources named in the descriptions.

#### 45.11.3 Drawing, animating and sound

* `scenes`: each scene's middle frame rasterized to `still-v{n}.jpg`.
* `animation`: per scene, `cli.ts frames` → `stories/raster.py` (numpy; anti-aliased coverage per primitive, the
  same painter's order and sRGB "source-over" blending as the browser canvas) → raw RGB frames piped into ffmpeg
  (`libx264`, `yuv420p`, 30 fps, CRF 20) → `scenes/{sceneId}/v{n}.mp4`. Scenes render 2 at a time.
* `sound` (`stories/audio.py`): every effect and noise of `audioTrack` synthesized with numpy (no audio files, no
  network): effects from noise, sweeps and envelopes; noises as short formant "voices" in the character's pitch;
  music as a seeded loop per mood (chords, bass, light drums). Mixed at 48 kHz stereo, the music ducked under effects,
  then `loudnorm` two-pass to -14 LUFS, ≤ -1 dBTP (as clips) → `audio/v{n}.m4a`.
* `captions`: `textTrack` → an ASS file (Inter, the platforms' safe area, bubble symbols at their positions);
  skipped (`skipped`) when `captionsOn` is false and no bubble has text.
* `assemble`: the scene files joined, the audio muxed, the ASS burned in (libass, as clips) → `final/v{n}.mp4`
  (`+faststart`) and `cover-v{n}.jpg`; `actualDurationSec` from ffprobe. Every file is an `ASSET#` (§45.12).
* `preview`: the story goes to `review` (or `needs_check`), the job `ready`.

#### 45.11.4 What it costs and how long

Writing takes about 30–90 s, drawing and animating about 2–4 minutes for 45 s of video, sound and assembly under a
minute. There is no cost ceiling (as for clips, ADR-40), but a runaway guard: at most 3 writer calls and 2 checker
calls per job.

#### 45.11.5 Safety stories only from checked guidance

* `config/stories-guidance.json` is the **checked guidance list**: one topic per situation (skidding on ice, driving on
  ice and snow, a tyre blowout, aquaplaning, brake failure, a stuck accelerator, wheels off the road edge, fog, an
  animal on the road, a motorway breakdown, an emergency stop, strong crosswinds), each with what to do in order, what
  not to do, the caveats (ABS or not, front or rear skid, left- or right-hand traffic), and 1–3 citations from road
  authorities or recognised safety bodies (UK Highway Code and DVSA, NHTSA, RoSPA, Trafikverket, AAA, and so on) with
  URL, section and a quote, checked on `checkedAt`. Bundled into the agent image (with `config/`) and into the API zip.
  Each step carries the sources that back it and `shown: true | false`: a step is shown in a video only when a road
  authority states it **and** no other cited source contradicts it (the research found real disagreements, for
  example whether to stay in the car after a motorway breakdown, whether to shift to neutral in a skid, braking with or
  without ABS). A contradicted or unsupported step is never put on screen; the video then says "Check your local road
  rules." The research, with every quote checked against the fetched page on 2026-11-21, is the source of the file;
  sites that refused the download (NHTSA, FMCSA, NSC, VicRoads) are not cited.
* A `driving_safety` idea or story must name one topic (`safetyTopicId`); with none it **cannot be produced**:
  "Lamo Stories only makes driving-safety videos from checked advice, and this one isn't in the list yet." plus the
  list. Other categories that turn out to teach a safety step (the writer flags `teachesSafety`) are held the same way.
* The writer gets the topic's steps and must take every on-screen instruction from them (`CaptionCue.guidanceRef`).
  Step `safety` then asks a second model call (a checker with its own prompt, `tool="check_facts"`) whether each
  caption and each beat that shows a driving action agrees with the topic and its caveats; disagreements are
  rewritten once; any left become `story.safety.problems`, the job ends `needs_check` and the story cannot be approved
  until a check passes. The end card says "Based on {publisher} advice. Check your local road rules." and the post
  descriptions name the sources.
* Nothing in Lamo Stories tells anyone to do something dangerous for fun: the writer's brief says so and the checker
  checks it for every category.

#### 45.11.6 Providers (who makes what)

A registry, `agent/src/clipfactory_agent/stories/providers.py` (mirrored by `GET …/providers`), with four kinds and
one interface each, so a new provider is one class and one registry line:

| Kind | Provider | State |
|---|---|---|
| writer | `bedrock-claude` (the clip models, `storyModel`) | on (already set up) |
| animation | `builtin-2d` (the engine + rasterizer) | on |
| audio | `builtin-synth` (numpy synthesis) | on |
| images | `builtin-rig` (the character drawn by the engine) | on |
| images | `nova-canvas` (Amazon Nova Canvas, Bedrock in `eu-west-1`, `amazon.nova-canvas-v1:0`) | off until switched on in Lamo Stories settings; needs the model to answer in that Region (the owner's account may have to accept the model there once). Used for AI portraits and painted backgrounds behind the rigs. |
| animation | `nova-reel` (Amazon Nova Reel, video from text) | not built further than its interface: Reel writes its output to an S3 bucket in its own Region (us-east-1), which this app does not have, and its realistic clips would need the platforms' AI labels that the shared publishers do not set. Reported plainly in Providers. |

`ProviderStatus = { kind, id, label, state: "on" | "off" | "needs_setup" | "unavailable", line: string /* the one
plain sentence of what it needs */, checkedAt?: string, lastError?: string }`. A provider shows `on` only after a real
call succeeded (`checkedAt`); nothing is shown as working because it was configured.

### 45.12 Library and assets

Every file a job or an upload makes is an `ASSET#` item (`assetId`, `kind`, `storyId`, `characterId`, `key`,
`contentType`, `bytes`, `version`, `meta`, `createdAt`) in its workspace's partition; the Library lists those items
(newest first, filter by kind, story or character) with presigned links. A remake keeps older versions as assets of
their own (marked `meta.current = 0`); deleting a story deletes its assets and files; deleting a character deletes its
references and portrait. Nothing of a Lamo Stories workspace can appear in Lamo Clips' Library: that Library reads
`CLIP#` items of `USER#{userId}` only.

### 45.13 Separate social connections

#### 45.13.1 What is shared and what is not

* **Shared, read-only:** the platform developer apps the owner already made for Lamo Clips (`cf-prod/platforms/
  {platform}/app`: client id, secret, Meta config id) and the redirect URIs registered with them. Lamo Stories never
  writes, rotates or deletes them, so nothing has to be set up again on any platform and Lamo Clips' keys stay as
  they are.
* **Separate:** every user token. Lamo Stories tokens live only at
  `cf-prod/workspaces/{workspaceId}/{platform}/token` (and `…/pending` for Meta's list of Pages, 30 minutes),
  JSON in Secrets Manager (encrypted with the account's Secrets Manager key), created at runtime with tags
  `app=cf-prod`, `workspace={workspaceId}`, `platform`. Never in DynamoDB, logs, responses, URLs or the browser.
  The `SOCIAL#{platform}` item holds only the public identity (external id, name, handle, avatar), the status and
  the scopes.
* IAM keeps them apart (§45.18): Lamo Clips' clip flow, stats and money functions can read only
  `cf-prod/platforms/*`; the new `cf-prod-story-flow` can read only `cf-prod/workspaces/*` and the `…/app` secrets,
  never a `cf-prod/platforms/*/token`. The API and the OAuth callback, which manage both, pick the secret name from
  the workspace in the request and the stored state only.

#### 45.13.2 Connect

`POST …/social/{platform}/connect` writes the existing state item (`OAUTH#{nonce}`/`STATE`, §17.4: same signing,
10 minutes) with `workspaceId` and `socialAccountId` added, and returns the platform's authorize URL with the same
client id and redirect URI as Lamo Clips, plus:
* youtube: `prompt=select_account consent` (Google always shows its account and channel picker, Brand Accounts
  included), the same scopes;
* tiktok: `disable_auto_auth=1` (as today, so TikTok asks which account);
* instagram, facebook: the same Login configuration; the page says before the tap "Facebook will ask which Pages
  Clip Factory may use. Keep your Lamo Clips Page ticked and also tick the Lamo Stories Page." (§45.13.5);
* x: as today; the page says "First sign in to your Lamo Stories account on x.com in this browser. X connects the
  account that is signed in."

#### 45.13.3 The callback (the same `GET /oauth/{platform}/callback`)

`oauth/callback.py` reads the consumed state item as today. **Only** when it carries `workspaceId` does it hand over
to `workspaces/social_callback.py`; every other state follows today's code untouched (a test sends the existing
callback cases through and compares every write and the redirect byte for byte). The workspace path:
1. exchanges the code with `providers.exchange` (the same code as Lamo Clips, read-only use);
2. lists the identities the token can post as: YouTube `channels?part=id,snippet&mine=true` (all of them, not only the
   first), Meta Pages (with their Instagram accounts), TikTok and X the one signed-in user;
3. writes the token to the workspace secret, then `SOCIAL#{platform}`: `connected` with `externalAccountId`,
   `accountName`, `handle`, `avatarUrl`; `choose_account` when there is more than one identity (YouTube channels,
   Pages), each choice marked `usedByClips` when it is Lamo Clips' destination; `same_as_clips` when the one identity
   is Lamo Clips' own destination (compared with `ACCOUNT#{platform}.accountId`, read-only);
4. redirects to `{APP_URL}/stories/connections?ws={workspaceId}&platform={platform}&result={code}` (the codes of
   §17.5 plus `same_as_clips`; nothing from the request is reflected).
It never writes `ACCOUNT#`, `SETUP#` or any `cf-prod/platforms/*` secret, and never releases Lamo Clips posts.

#### 45.13.4 Same place as Lamo Clips: only on purpose

A Lamo Stories account whose identity is Lamo Clips' own (same channel id, Page id, Instagram id, TikTok open id or X
user id) is `same_as_clips` and cannot be posted to. The Connections page says "This is the same {place} Lamo Clips
posts to." with **Pick another** (connect again) and **Use it for both** (the share route, after a second "Are you
sure?" step), which sets `sharedWithClips: true` and `connected`. Publishing checks it again every time (§45.14).

#### 45.13.5 What each platform allows (shown on the Connections page in plain words)

* **YouTube:** one Google sign-in can hold several channels (Brand Accounts). Google's picker chooses the channel;
  Lamo Stories shows the channel's name and id after connecting and offers **Pick another channel**. A second channel
  costs quota from the same Google project as Lamo Clips (10,000 units a day shared, about 6 uploads a day in all).
* **Instagram:** a separate professional (Business or Creator) account, linked to a Facebook Page. Meta asks which
  Pages and accounts the app may use **for your whole Facebook login**: unticking Lamo Clips' Page there would cut
  Lamo Clips off. After a Meta connect, Lamo Stories checks Lamo Clips' Meta connection still answers (read-only) and
  warns when it does not.
* **Facebook:** a separate Page managed by the same Facebook login; the same note on ticking both Pages.
* **TikTok:** while the TikTok app is in Sandbox (review pending since 2026-11-21) only accounts added as Sandbox
  target users can connect, and posts stay "Only me" until TikTok approves the app (as for Lamo Clips, §17). The
  Lamo Stories account has to be added as a target user in the TikTok developer portal first.
* **X:** a separate X account; X connects the account signed in on x.com, and posts use the same X app's credits.
Lamo Stories never creates an account anywhere, and never assumes an email address means an account.

### 45.14 Publishing, only to the workspace's own accounts

* `POST …/stories/{storyId}/publish` writes one `PUBJOB#` per target **after** `validate_destination` passes for each,
  then starts `cf-prod-story-flow` (alias `live`) once with `{ userId, workspaceId, storyId, publishingJobIds,
  run }`. Every publishing job records `workspaceId`, `contentId`, `socialAccountId`, `platform`, `externalAccountId`
  (the identity at the moment of the tap) and `publishingStatus`.
* `validate_destination(store, user_id, workspace_id, publishing_job | target)` (`workspaces/destinations.py`, one
  function used by the API and by the flow **before every platform call**):
  1. the workspace exists for this user and is a `stories` workspace;
  2. the story is in the same workspace partition, `contentId` matches, and it is `approved` or `published`, with a
     final video;
  3. the social account is in the same workspace partition, `socialAccountId` is `{workspaceId}.{platform}`, its
     platform is the job's, its status `connected`, and its `externalAccountId` equals the one the job recorded;
  4. its identity is not Lamo Clips' own destination, unless `sharedWithClips` is true;
  5. the credentials are read from `cf-prod/workspaces/{workspaceId}/{platform}/token` only, a name built from the
     validated ids, never from the item or the request; a missing secret is "not connected".
  Any failure stops that job with `needs_attention` and a plain sentence ("Lamo Stories' YouTube is not connected.
  Connect it in Lamo Stories › Connections, then tap Try again."). There is **no default account**: no target, no
  post; an ambiguous or missing destination never falls back to anything.
* The flow reuses the platform publishers unchanged (`platforms.publishers.publisher_for`, §17.6): it builds a
  `PublishJob` with the story's `postCaptions`, `durationSec`, the workspace credentials (`WorkspaceTokenProvider`:
  refresh and rotation like `SecretsTokenProvider`, but every write goes to the workspace secret and the `SOCIAL#`
  item, never `ACCOUNT#`), and `S3Video` on the story's `final/v{n}.mp4`. Step names: `validate-{platform}`,
  `publish-{platform}`, `wait-{platform}-{n}`, `check-{platform}-{n}`, `finish-{platform}`, then numbers:
  `wait-numbers-{k}` and `numbers-{k}` at 1 h, 24 h and 72 h after posting (views, likes, comments, shares through the
  platforms' stats adapters with the workspace credentials), stored on the publishing job.
* Posting settings follow the owner's posting preferences (§36): public, comments on, never "made for kids", the
  TikTok sheet's rules (privacy picked from the dropdown with no default, Comments/Duet/Stitch shown and starting off,
  "Use my settings" as the owner's tap). Lamo Stories' built-in videos are cartoons, so the publishers' existing
  "not AI-realistic" flags are correct; a story that used a realistic AI provider cannot be published (none exists in
  this section).
* Lamo Clips' `POST /v1/clips/{clipId}/confirm`, its posts, the clip flow and the release keep reading only
  `ACCOUNT#` and `cf-prod/platforms/*`: they cannot reach a Lamo Stories account.

### 45.15 Infra (Terraform, additive only)

* `infra/modules/flows`: one more entry in `local.functions`, `story-flow` (`clipfactory_api.flows.story_flow.handler`,
  durable, alias `live`, like `clip-flow`), with its own role: DynamoDB like `clip-flow` (no Delete, no Scan);
  S3 `GetObject` on `ws/*` only; Secrets `GetSecretValue` on `cf-prod/workspaces/*` and `cf-prod/platforms/*/app-*`,
  `PutSecretValue` on `cf-prod/workspaces/*/token-*`; no Bedrock. Env `TABLE_NAME`, `MEDIA_BUCKET`,
  `WS_SECRET_PREFIX=cf-prod/workspaces/`, `SECRET_PREFIX` (for the app keys only).
* `infra/modules/api`: new statements: S3 Get/Put/Delete on `ws/*`, ListBucket on prefix `ws/`; Secrets Create, Put,
  Get, Describe, Delete, Tag on `cf-prod/workspaces/*`; `lambda:InvokeFunction` on the story-flow alias; env
  `STORY_FLOW_ARN`, `WS_SECRET_PREFIX`. Nothing removed.
* `infra/modules/hooks`: Secrets Create, Put, Get, Describe, Tag, Delete on `cf-prod/workspaces/*`; env
  `WS_SECRET_PREFIX`. Its DynamoDB `USER#*` leading-key grants already cover `USER#{userId}#WS#…` and
  `USER#{userId}#WSREG`.
* `infra/modules/agent`: Bedrock `InvokeModel` on `arn:aws:bedrock:eu-west-1::foundation-model/amazon.nova-canvas-v1:0`
  (used only when the owner switches that provider on). Its S3 and DynamoDB grants already cover the new prefixes.
* The agent image copies `web/src/stories/engine/` to `/app/stories-engine/` (`agent/Dockerfile` and its dockerignore)
  and the image tag hash in `deploy.yml` includes that folder, so an engine change rebuilds the image.
* Monitoring: the story flow joins `durable_function_names` (its alarms like the clip flow's).
* The Terraform tests that list exact sets (`durable.tftest.hcl`, `envs/prod/tests/wiring.tftest.hcl`,
  `api/tests/api.tftest.hcl`, `hooks/tests/rest.tftest.hcl`, `agent` runtime test) gain the new members and new
  asserts: the story-flow role has no `cf-prod/platforms/*/token` access and no Bedrock; the clip-flow, stats and money
  roles have no `cf-prod/workspaces` access.

### 45.16 Web

#### 45.16.1 The workspace switcher

* A two-choice pick bar (`<Glide>`, the owner's sliding highlight) **Lamo Clips | Lamo Stories**, small, in empty
  space: on screens from 768 px at the bottom of the sidebar foot, above "Get the app" (folded sidebar: one round
  button that toggles, with its aria-label); on phones in the top bar between the brand and the live dot. It never uses
  `.sidebar__item` (tests pin the six items) and never adds a tab. It shows only when `STORIES_ON` is true.
* Lamo Stories lives under `/stories/…`; everything else is Lamo Clips, rendered by today's `Shell` unchanged.
  Switching to Lamo Stories goes to the last Lamo Stories page (else `/stories`); switching back goes to the last
  Lamo Clips page (else `/`), so Lamo Clips comes back exactly as it was left.
* The choice persists on the device (`localStorage` `cf.workspace`, `{ workspaceId, lastClipsPath, lastStoriesPath }`)
  and the URL carries it: a reload of a `/stories` page stays in Lamo Stories; opening the app at `/` when the last
  choice was Lamo Stories goes to the last Lamo Stories page. One sign-in: the same Cognito session, the same API.

#### 45.16.2 The Lamo Stories shell

`web/src/stories/StoriesApp.tsx`, its own navigation and look ("an animation studio"): Dashboard `/stories`, Ideas
`/stories/ideas`, Characters `/stories/characters` (`/stories/characters/new`, `/stories/characters/{id}`),
Production `/stories/production` (`/stories/production/new`, `/stories/production/{storyId}`), Review
`/stories/review` (`/stories/review/{storyId}`), Library `/stories/library`, Connections `/stories/connections`,
Settings `/stories/settings`. Lamo Clips' overlays (Ask, the setup to-do, the campaign banner) are not shown in Lamo
Stories; the Mac download host, the update bar, toasts and sounds stay global.

Look: its own tokens (`--st-*`, in `web/src/stories/styles/`, outside `web/src/styles` whose tests police Lamo Clips' palette; `test/storiesStyles.test.ts` holds the owner's rules there): a deep
night-indigo stage (`#1C1842`) with soft spotlight glows, warm cream words (`#FFF6E5`), sunshine (`#FFC94A`) for
every main action, coral (`#FF6F61`), mint (`#47D6A0`) and sky (`#62C6FF`) for status and characters, rounded type
(`ui-rounded`, then the system font), frosted panels, character-shaped empty states, storyboard filmstrips. The
owner's rules that hold everywhere still hold: arrow cursor only (no `cursor:` CSS), hover states, click and deny
sounds, `<Glide>` for every pick-one bar, eased progress, celebrations on success, no visible borders (shadows and
fills instead), AA contrast, no overflow from 320 px, kid-proof words, controls bottom right on phones.

#### 45.16.3 Dashboard

Tiles: animations made (stories with a final video), waiting for review, published, being made now (with each job's
step), connected accounts (n of 5 with the account names), performance (views, likes, comments, shares summed over
the publishing jobs' latest numbers; "no numbers yet" when none), and recent activity (the last 10 job and
publishing events of this workspace). `StoriesDashboard = { counts: { made, review, published, producing,
needsCheck }, producing: { storyId, title, step: StepKey, progress }[], accounts: { platform, connected: boolean,
accountName: string | null }[], performance: { views, likes, comments, shares, posts, checkedAt: string | null },
activity: { at, kind: "made" | "approved" | "rejected" | "changes" | "posted" | "failed", storyId, title,
platform?: Platform }[] }`.

#### 45.16.4 Live updates

Lamo Stories screens poll (`usePoll`): a running job every 2 s, the dashboard every 15 s, publishing every 10 s while
one is in flight. No WebSocket filter changes (§45.3).

#### 45.16.5 Ideas, Characters, Production

* Ideas: a board of idea cards (saved and used), **New idea** (manual), **Ask for ideas** (topic + category →
  drafts with Save), each card **Make it a full idea** (expand), **More like this** (variations), **Make the video**
  (→ Production › New with it), Delete with Undo. Safety ideas show their guidance source or "Needs checked advice".
* Characters: a cast gallery (each rig animated idle), **New character** (a stepper: looks, face, moves, sounds,
  name and personality), the live preview with every face and action button, reference uploads, Save.
* Production › New: idea or concept, cast (1–3), length (15–90 s slider, default 45), captions on/off, music mood,
  **Make the video**. Production list: every story being made or made, its step track (the eight steps) and progress.
  A story's production page: the storyboard as a filmstrip of scenes with the live engine preview of each and the
  finished stills, the step track, Cancel, Try again.

#### 45.16.6 Review

Its own queue (`status ∈ review, needs_check, changes_requested`), never Lamo Clips' Review: the player (the
final MP4), **Approve**, **Reject**, **Ask for changes** (a note, optionally for chosen scenes), per scene **Remake
this scene**, **Remake the whole video**, the captions editor (on-screen captions and the six post captions), the
sound effects editor (add, move, remove effects on the timeline), **Download** (approved), and after approval
**Post it** (the publish sheet: only this workspace's connected accounts, each with its name, the TikTok rules, "Use
my settings").

#### 45.16.7 Library, Connections, Settings

* Library: tabs by kind (Videos, Storyboards, Characters, Pictures, Sounds, Scenes), each item with its story or
  character and Download.
* Connections: five cards (YouTube, Instagram, Facebook, TikTok, X), each with status, account name and id, Connect /
  Pick another / Disconnect, the platform's limits (§45.13.5), and Lamo Clips' destination name for that platform
  so the owner sees they differ.
* Settings: default length, captions, music, the writer model, the image provider (with its state), posting preset.

#### 45.16.8 Mock mode

`web/src/stories/api/mock.ts` implements every route in memory (a production job walks its steps in about 10 s; the
"final video" is the engine's live preview in mock mode), so every screen runs under `npm run dev:mock` and in
Playwright.

### 45.17 Changes to existing files (each one small, each with its proof)

| File | Change | Proof that Lamo Clips is unchanged |
|---|---|---|
| `api/.../routes/__init__.py` | import `workspaces` and append `*workspaces.ROUTES` at the end | `test_http.py` lists every old route unchanged, plus the workspace list from `tests/ws_routes_*.py` |
| `api/.../oauth/callback.py` | one branch after the state is consumed: `workspaceId` → the workspace callback; `location()` maps a workspace result to `/stories/connections` | the old callback cases pass unchanged; a new test proves a non-workspace state never reaches the new code |
| `api/scripts/build_lambda.py` | the story-flow handler in `HANDLERS`; `config/stories-guidance.json` copied into the zip | build test |
| `agent/.../server.py` | two new actions and `busy` includes story jobs | the old server tests unchanged |
| `agent/Dockerfile`, its dockerignore | copy the engine folder | the image self-check runs `deno run …/cli.ts validate` on a sample |
| `.github/workflows/deploy.yml` | the engine folder in the agent tag hash | `scripts/test-deploy-workflow.sh` |
| `web/src/lib/router.ts` | `/stories…` routes (new names) | every old path parses to the same route |
| `web/src/app/App.tsx` | a `/stories` route renders `StoriesApp`; new TITLES entries | every old route renders the same `Shell` |
| `web/src/components/Nav.tsx` | the switcher in the sidebar foot and the phone top bar (hidden while `STORIES_ON` is false) | the nav tests unchanged; the before/after pixel check (§45.20) |
| `web/src/styles/glide.css` | the switcher's container in the Glide list | – |
| `web/areas.json` | `"web/src/stories": "Lamo Stories"` | `update.test.ts` |
| generated files | help corpus, the HELP_ASSISTANT routes table, Ask knowledge | their `--check` steps |
| Terraform | §45.15 | `terraform test`; the deploy's Plan line and Delete gate |

### 45.18 Deploys

Every Lamo Stories pull request that changes `infra/` is read before merging: `terraform plan` may only add resources
and change IAM policies, Lambda environments and the agent runtime in place. After each deploy the Plan line and the
Delete gate line are read and reported; `0 to destroy` is required. No owner data shape changes: no existing item gets
a new required attribute, nothing is renamed, the table, user pool, buckets, vectors and secrets are untouched.

### 45.19 Tests

* **api** (pytest, fakes only): workspace isolation (`test_ws_isolation.py`): another user's workspace id, a
  `clips` id on a **S** route, an item whose `workspaceId` attribute disagrees with its key, and a Lamo Stories item
  in Lamo Clips' lists (`GET /v1/clips`, `/v1/jobs`, `/v1/posts`, `/v1/accounts`, `/v1/setup`) all fail closed;
  every new item's `sk` matches none of the stream prefixes; publishing validation (`test_ws_destinations.py`): each
  rule of §45.14 alone fails a job with `needs_attention` and sends nothing; the destination changed after the tap
  stops; same-as-clips without `sharedWithClips` stops; the credentials name is always the workspace's; the token
  provider never writes `ACCOUNT#`; the callback: workspace states write only `SOCIAL#` and workspace secrets,
  non-workspace states are byte-identical to before (`test_oauth_callback.py` unchanged); `leaked()` over every new
  route; ideas and writer prompts carry the skills block (`test_skills_everywhere.py` unchanged and passing).
* **agent**: the story pipeline with a fake Bedrock and the real engine CLI (Deno) on a sample script; the rasterizer
  against golden frames; the audio synth's lengths, levels and determinism; `server.py`'s old tests unchanged plus the
  two new actions; the safety step's three outcomes; the scan test's allow-list gains only the Nova Canvas call.
* **web**: vitest for the engine (determinism, validation, every catalog id draws, `fitDuration`), the switcher store
  (persistence, last paths), the API client against the mock; Playwright (mock): switching both ways and after reload,
  every Lamo Stories screen (no overflow 320–1920, arrow cursor, AA contrast, no edges, targets ≥ 44 px), the full
  flow idea → character → production → review → approve → publish sheet, and Lamo Clips screens with the switcher
  hidden pixel-identical to `origin/main` (screenshots of `/`, `/jobs`, `/review`, `/library`, `/money`,
  `/settings` compared before and after at 390, 1000 and 1440 px; with `STORIES_ON` only the switcher's own box may
  differ).
* **infra**: `terraform test` with the asserts of §45.15.

### 45.20 The owner's request, point by point

| Spec | Met by |
|---|---|
| §1 two workspaces, same app and login | §45.2, §45.16 (one Cognito session, one API) |
| §2 protect existing functionality | §45.1, §45.17, §45.18, the pixel check in §45.19 |
| §3 switching, persistence, independence | §45.16.1, §45.3 partitions, §45.13 connections, §45.6 `StoriesConfig` |
| §4 content concept, no voice-over, verified safety | §45.10 vocabulary (no speech), §45.11.3 noises and music, §45.11.5 |
| §5.A–F Dashboard, Ideas, Characters, Production, Review, Library | §45.16.3–§45.16.7, §45.7–§45.12 |
| §6 separate social accounts and publishing isolation | §45.13, §45.14, IAM in §45.15 |
| §7 data architecture, ownership on both ends | §45.3 (keys), §45.5 (guards), web routes only call their workspace |
| §8 own design language | §45.16.2 |
| §9 more brands later | §45.2 registry, ULID workspaces, `POST /v1/workspaces` |
| §10 acceptance criteria | §45.19, reported one by one when the switch turns on |
| §11 phases | §45.21 |

### 45.21 Who builds what, and in which order

Phase 1 (this section, ADR-70 to ADR-75, and a scaffold: empty route modules, the web types and client interface,
a stub engine, the flag) merges first. Then seven builders work at the same time, each only in its own files:

| Builder | Branch | Owns |
|---|---|---|
| A api core | `feat/stories-api-core` | `api/.../workspaces/` (all but social, destinations, tokens), `routes/workspaces/core.py`, `tests/ws_routes_core.py`, `tests/test_ws_*.py` for its routes, `build_lambda.py` (guidance copy) |
| B social and publishing | `feat/stories-social` | `workspaces/social*.py`, `destinations.py`, `tokens.py`, `routes/workspaces/social.py`, `flows/story_flow.py`, the `oauth/callback.py` branch, `tests/ws_routes_social.py`, their tests |
| C infra | `infra/stories` | §45.15 Terraform and its tests, `deploy.yml` tag hash |
| D engine | `feat/stories-engine` | `web/src/stories/engine/` |
| E agent | `feat/stories-agent` | `agent/src/clipfactory_agent/stories/`, `server.py` hook, Dockerfile, `config/stories-guidance.json` |
| F web shell | `feat/stories-web-shell` | switcher, router, App, Nav, `StoriesApp`, Dashboard, Library, Connections, Settings, `api/http.ts`, `api/mock.ts`, styles, generated help files |
| G web studio | `feat/stories-web-studio` | Ideas, Characters, Production, Review screens |

Then one check of everything together against §45.20 and the ten-plus-four acceptance criteria, and the switch PR
(`STORIES_ON = true`).

### 45.22 What only the owner can do (none of it blocks building)

* Add the Lamo Stories TikTok account as a Sandbox target user (TikTok developer portal › Sandbox › Target users), or
  wait for TikTok's app review; until then TikTok posts are "Only me".
* Have the separate accounts ready: a Lamo Stories YouTube channel (a Brand Account under the same Google login is
  fine), a Facebook Page, an Instagram professional account linked to it, an X account. Lamo Stories never creates
  them.
* To use AI pictures: switch on Nova Canvas in Lamo Stories › Settings; if Bedrock answers that the model is not
  enabled, enable Amazon Nova Canvas in the Bedrock console, Region Europe (Ireland).
