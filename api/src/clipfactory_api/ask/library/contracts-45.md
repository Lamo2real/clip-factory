## 45. Lamo Stories: a second, separate workspace (owner request, 2026-11-21)

**Planned: not in the app until the switch pull request turns it on (§45.21).** Until then nothing of Lamo Stories
shows in Clip Factory, and Ask should say it is being built.

The owner asked for **Lamo Stories**, a second content studio inside Clip Factory that makes short animated story
videos (no voice-over: characters, faces, body language, sound effects, music, optional captions) and posts them to
**different** social accounts. One app, one sign-in, one owner; two workspaces with their own screens, libraries,
production jobs, settings and social connections. The existing app is the **Lamo Clips** workspace and must stay
exactly as it is. Sections 41 to 44 are left for pull requests that were open on 2026-11-21. Decisions: ADR-70 to
ADR-75. The owner's full request is the brief of this section; §45.20 maps each of its points to where it is met and
§45.23 lists the evidence for each acceptance criterion.

### 45.1 The rule above every other rule: Lamo Clips does not change

* No existing table, index, item, attribute, S3 prefix, secret, Lambda, route, prompt, screen, style or test is
  renamed, moved, replaced or re-shaped. Lamo Clips' data is never migrated: it **is** the built-in workspace.
* Everything new is **additive**: new partitions (§45.3), a new S3 prefix (§45.4), a new Secrets Manager prefix
  (§45.13), new routes under `/v1/workspaces` (§45.5), one new durable Lambda (§45.15), new IAM statements, new web
  routes under `/stories` (§45.16), new agent actions (§45.11). Lamo Stories never revokes, rewrites or deletes a Lamo
  Clips token, key, account or setup item, on any path (§45.13.6).
* Existing code is touched only where a new thing must be plugged in; §45.17 lists every such touch with the test that
  proves the old path is unchanged. Nothing new is shown in the Lamo Clips screens except the workspace switcher
  (§45.16.1), which sits in space that is empty today and moves no existing control.
* Every deploy: the Delete gate line reads exactly "Delete gate: the plan deletes or replaces nothing that holds the
  owner's data." and the only resource the plan may replace is `module.agent.terraform_data.image`, the image build
  trigger that is replaced whenever the agent image tag changes (it holds no data; it was so before Lamo Stories, for
  example in PR #84). Everything else is add or update in place (§45.18).
* Lamo Stories stays hidden behind one web switch, `STORIES_ON` in `web/src/stories/flag.ts` (default `false`),
  until every piece has merged and the final check passed; the last pull request turns it on (§45.21). Server
  routes may go live before that: no Lamo Clips screen calls them. While it is off, the update bar labels Lamo Stories
  folders "Behind the scenes" (`web/areas.json`); the switch pull request renames them "Lamo Stories".

### 45.2 Words

| Word | Meaning |
|---|---|
| workspace | One content studio of the owner: its own content, jobs, library, settings and social connections. |
| Lamo Clips | The built-in workspace `workspaceId = "clips"`, `workspaceType = "clips"`: today's whole app and all its data, unchanged. It is never written as an item. |
| Lamo Stories | A workspace of type `stories`. The first one has `workspaceId = "stories"` and the name "Lamo Stories"; later ones (for example "Lamo Cars") get a ULID. |
| story | One animated video project (the spec's *Content*, `contentType = "animation"`). |
| production job | One run that makes or remakes (part of) a story's video, or a character's portrait (the spec's *ProductionJob*). |
| social account | One authorized account, channel or Page connected **to one workspace** (the spec's *SocialAccount*). |
| publishing job | Sending one approved story to one social account (the spec's *PublishingJob*). |
| cast | The characters of one story, copied (looks and all) into its script when it is written, so a later edit to a character never changes a finished video (§45.8). |

Workspace types live in one registry, `WORKSPACE_TYPES` (`api/src/clipfactory_api/workspaces/types.py`, mirrored in
`web/src/stories/api/types.ts`): `clips` (built-in, exactly one, the existing app) and `stories`. A future brand is
either a new `stories` workspace with its own name (no code: `POST /v1/workspaces`, and the switcher lists every
workspace the API returns) or a new type (one registry entry plus its screens). Nothing here assumes exactly two
workspaces; nothing is built for brands that do not exist yet.

### 45.3 DynamoDB (the same table `cf-prod-data`; new partitions only)

Lamo Clips' partition `USER#{userId}` gets **no new items**. Two new kinds of partition:

| Item | pk | sk | Attributes |
|---|---|---|---|
| Workspace | `USER#{userId}#WSREG` | `WS#{workspaceId}` | `type="workspace"`, `userId`, `workspaceId`, `workspaceName`, `workspaceType`, `configuration` (map, §45.6), `version`, `createdAt`, `updatedAt` |
| Idea | `USER#{userId}#WS#{workspaceId}` | `IDEA#{ideaId}` | `type="ws_idea"`, `userId`, `workspaceId`, Idea fields (§45.7) |
| Character | same | `CHAR#{characterId}` | `type="ws_character"`, Character fields (§45.8), `version` |
| Story | same | `STORY#{storyId}` | `type="ws_story"`, Story fields (§45.9), internal `scriptKey`, `videoKey`, `coverKey`, `stillKeys` (map sceneId → key), `statusBefore`, `run` (publishing run number), `version` |
| Production job | same | `PJOB#{jobId}` | `type="ws_pjob"`, ProductionJob fields (§45.10), internal `sessionId`, `heartbeatAt` |
| Asset | same | `ASSET#{assetId}` | `type="ws_asset"`, Asset fields (§45.12), internal `key` |
| Social account | same | `SOCIAL#{platform}` | `type="ws_social"`, SocialAccount fields (§45.13), internal `refreshLeaseUntil`, `appClientId`, `sharedExternalAccountId`, `choicesExpireAt`, `lastResult` |
| Publishing job | same | `PUBJOB#{publishingJobId}` | `type="ws_pubjob"`, PublishingJob fields (§45.14), internal `externalAccountId`, `publishHandle`, `flowRun`, `postOptions`, `platformPostId`, `statsId`, `numbersAt` (list) |
| Activity | same | `ACT#{at}#{id}` | `type="ws_activity"`, `at`, `kind`, `storyId`, `title`, `platform?`, `ttl` (90 days) (§45.16.3) |
| Provider state | same | `PROVIDER#{kind}#{providerId}` | `type="ws_provider"`, `state`, `checkedAt`, `lastError` (written only by the agent after a real call, §45.11.6) |
| OAuth state | `OAUTH#{nonce}` | `STATE` | the existing item (§17.4) plus `workspaceId` and `socialAccountId`, written only for a `w1.` state (§45.13.2) |

* **Ownership is in the key.** The API builds every key from the JWT's `sub` and the path's workspace id; it never
  reads a user id from a body. A workspace that is not in `USER#{userId}#WSREG` answers `404 not_found` ("We could
  not find that workspace."), whatever its id; the one exception is the first Lamo Stories workspace, `stories`,
  which `require_workspace` creates on first use with a conditional put (two calls at once make one). Every item also
  carries `userId` and `workspaceId`, and every read checks both against the request (a second, independent check:
  `workspaces.guard.owned(item, user_id, ws_id)`).
* **Why these prefixes.** The live-update and notification streams forward only the sort-key prefixes `JOB#`,
  `CLIP#`, `POST#`, `LEARNING#`, `WEEK#`, `ACCOUNT#`, `SETUP#`, `FOLLOW#`, `JOBLIVE#`, `CAMPAIGN#`, `CRCONN`, `CRSUB#`,
  `CRMONEY` (`infra/modules/realtime/main.tf`, `notify/main.tf`). No new sort key starts with any of them
  (`api/tests/test_ws_keys.py` reads them from Terraform), so no Lamo Stories item can ever reach a Lamo Clips screen,
  notification or the stats poller (`gsi1` and `gsi2` are never set on a new item). Lamo Stories screens poll
  (§45.16.4). Item `type` values never reuse a Lamo Clips one.
* `SOCIAL#{platform}`: one social account per platform per workspace (the owner's table: one separate account per
  platform). `socialAccountId` = `{workspaceId}.{platform}` (stable, so a reconnect keeps the id; §45.14 stops a
  publishing job whose destination changed).
* **One write rule for every writer.** Every write to `STORY#` or `PJOB#` (the API, the agent, the story flow) is an
  update expression that sets only its own attributes (§45.9.1), adds 1 to `version` on `STORY#`, sets `updatedAt`,
  and is never a whole-item put after creation.
* Ids are ULIDs, timestamps ISO-8601 UTC (`2026-11-21T18:00:00.000Z`, the same form as clip jobs: the deploy drain
  compares strings), numbers through `db.to_dynamo`. Lists use `db.query_page` with the existing cursor helpers.
  `db.strip_keys` hides `pk`, `sk`, `gsi*`, `type`, `userId`, `ttl` as today; every other internal attribute above is
  left out by each shape's public function.

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

No Lamo Clips prefix (`uploads/`, `jobs/`, `skills/`, `private/`, `ask/`, `campaigns/`) is read or written by Lamo
Stories code, and no Lamo Clips code reads `ws/`. The media bucket's lifecycle rules name Lamo Clips prefixes only, so
`ws/` files are kept. The Library lists only `ASSET#` items of its workspace (§45.12), never S3 listings. Presigned
GETs last 1 hour; a download adds `ResponseContentDisposition: attachment; filename="{slug}.mp4"`.

### 45.5 HTTP API (cf-prod-api, JWT on every route, §5 errors)

All under `/v1/workspaces`. `{ws}` is a workspace id (`^(clips|stories|[0-9A-HJKMNP-TV-Z]{26})$`, else 404). Routes
marked **S** need a `stories` workspace: on `clips` they answer `409 conflict` "That is a Lamo Stories page. Switch to
Lamo Stories first." Bodies are validated with `validate.py`; unknown keys are `400`.

| Method & path | Body | 2xx |
|---|---|---|
| GET `/v1/workspaces` | – | `{ "workspaces": Workspace[] }`: Lamo Clips first, then the owner's workspaces by `createdAt`; creates `stories` ("Lamo Stories") on first use |
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
| POST `/v1/workspaces/{ws}/characters/{characterId}/portrait` **S** | – | `202 { "job" }` (a portrait job, §45.11.6); `409` "AI pictures are off. Turn them on in Lamo Stories › Settings." while `providers.images` is `builtin-rig` |
| GET `/v1/workspaces/{ws}/stories` **S** | query `status?` (a StoryStatus or `all`), `limit` ≤ 50, `cursor` | `{ "stories": Story[], "nextCursor" }` newest first |
| POST `/v1/workspaces/{ws}/stories` **S** | `StoryInput` | `201 { "story", "job" }` (starts production) |
| GET `/v1/workspaces/{ws}/stories/{storyId}` **S** | – | `{ "story", "job": ProductionJob \| null, "script": StoryScript \| null }` (URLs presigned) |
| GET `/v1/workspaces/{ws}/stories/{storyId}/jobs` **S** | – | `{ "jobs": ProductionJob[] }` newest first (production metadata, §45.12) |
| PATCH `/v1/workspaces/{ws}/stories/{storyId}` **S** | `StoryPatch` (§45.6; only in `review`, `needs_check` or `failed`, never while a job runs) | `{ "story", "script" }`; a script edit writes `v{n+1}` and adds the steps it makes out of date to `stale` (§45.9) |
| DELETE `/v1/workspaces/{ws}/stories/{storyId}` **S** | – | `204` (stops a running job first; its assets and S3 files under the story's prefix are deleted; publishing jobs and posts already on platforms stay) |
| POST `/v1/workspaces/{ws}/stories/{storyId}/produce` **S** | `{ "from"?: StepKey, "sceneIds"?: string[] (with `from` ∈ `scenes`, `animation`) }` | `202 { "story", "job" }`; no `from`: runs exactly the `stale` steps ("Try again", "Check again", "Remake"); `409` while a job runs |
| POST `/v1/workspaces/{ws}/stories/{storyId}/cancel` **S** | – | `{ "story", "job" }` |
| POST `/v1/workspaces/{ws}/stories/{storyId}/approve` **S** | `{ "version" }` | `{ "story" }`; `409` unless §45.9's approve rule holds |
| POST `/v1/workspaces/{ws}/stories/{storyId}/reject` **S** | `{ "reason"?: string (≤ 500) }` | `{ "story" }` |
| POST `/v1/workspaces/{ws}/stories/{storyId}/changes` **S** | `{ "note"?: string (0–500), "sceneIds"?: string[] }` (at least one of the two) | `202 { "story", "job" }`: the writer rewrites the named scenes (a new take when there is no note: "Remake this scene") or the whole story with the note, then everything that changed is remade |
| GET `/v1/workspaces/{ws}/stories/{storyId}/download` **S** | – | `{ "url", "filename" }` (only `approved` or `published`) |
| GET `/v1/workspaces/{ws}/library` **S** | query `kind?` (an AssetKind or `all`), `storyId?`, `characterId?`, `limit` ≤ 100, `cursor` | `{ "items": LibraryItem[], "nextCursor" }` |
| GET `/v1/workspaces/{ws}/providers` **S** | – | `{ "providers": ProviderStatus[] }` (§45.11.6) |
| GET `/v1/workspaces/{ws}/guidance` **S** | – | `{ "topics": GuidanceTopic[], "checkedAt" }` (§45.11.5) |
| GET `/v1/workspaces/{ws}/social` **S** | – | `{ "accounts": SocialAccount[] /* 5, in STORIES_PLATFORMS order */, "clips": ClipsDestination[] }` |
| POST `/v1/workspaces/{ws}/social/{platform}/connect` **S** | – | `{ "authorizeUrl", "expiresAt" }` (§45.13.2); `409` "Lamo Clips has no {Platform} app keys yet. Set up {Platform} in Lamo Clips first (Settings › Posting › Set up posting, up to the keys step)." |
| POST `/v1/workspaces/{ws}/social/{platform}/choose` **S** | `{ "choiceId" }` (instagram and facebook only; other platforms `400`) | `{ "account" }` |
| POST `/v1/workspaces/{ws}/social/{platform}/share` **S** | `{ "confirm": true }` | `{ "account" }` (the owner's explicit "use the same {place} as Lamo Clips", §45.13.4) |
| POST `/v1/workspaces/{ws}/social/{platform}/check` **S** | – | `{ "account" }` (a live profile call; `token_dead` → `needs_reconnect`) |
| GET `/v1/workspaces/{ws}/social/tiktok/creator-info` **S** | – | `{ "creator": TikTokCreator }` (the §17.4 shape, with the workspace token only); `409` "Lamo Stories' TikTok is not connected. Connect it in Lamo Stories › Connections." |
| DELETE `/v1/workspaces/{ws}/social/{platform}` **S** | – | `204`: deletes only this workspace's token and pending secrets and sets the account `not_connected`; **no platform revoke call** (§45.13.6) |
| POST `/v1/workspaces/{ws}/stories/{storyId}/publish` **S** | `{ "targets": PublishTarget[] (1–5, each platform once) }` | `202 { "publishingJobs": PublishingJob[] }` (§45.14) |
| GET `/v1/workspaces/{ws}/publishing` **S** | query `storyId?` | `{ "publishingJobs": PublishingJob[] }` newest first |
| POST `/v1/workspaces/{ws}/publishing/{publishingJobId}/retry` **S** | `{ "options"?: PublishOptions, "confirmAccount"?: string /* the new externalAccountId the owner saw */ }` | `202 { "publishingJob" }` (only `failed` or `needs_attention`; `409` naming the new account when the destination changed and `confirmAccount` does not match it) |

`/v1/accounts*`, `/v1/setup*`, `/v1/clips*`, `/v1/jobs*` and every other existing route are unchanged and never see
Lamo Stories data. Route modules: `routes/workspaces/core.py` (workspaces, dashboard, ideas, characters, stories,
library, providers, guidance) and `routes/workspaces/social.py` (social, creator info, publish, publishing),
assembled in `routes/workspaces/__init__.py` and appended once at the end of `ROUTES`.

Dependencies reach the routes through `workspaces/deps.py` (`deps.of(app)`: built once per `App` from the environment
on first use, `STORY_FLOW_ARN`, `WS_SECRET_PREFIX`, the agent runtime ARN, the media bucket; tests install fakes with
`deps.install(app, …)`), so `app.py` does not change. Story-only AWS calls live in new files that use only the public
helpers of `agent_client.py` and `flow_client.py`: `workspaces/agent.py` (`start_story`, `start_portrait`,
`cancel_story`, `stop_session`; sessions `"cfstory-" + jobId + "-" + 8 random chars`, at least 33 characters; two
attempts on a retryable error, 20 s read timeout) and `workspaces/flow.py` (the story flow start). `agent_client.py`
and `flow_client.py` stay byte-identical.

### 45.6 Shapes (TypeScript notation; `web/src/stories/api/types.ts` and `web/src/stories/engine/types.ts` are the copies the web compiles, changed only through this section)

```ts
type WorkspaceType = "clips" | "stories";
interface Workspace { workspaceId: string; workspaceName: string; workspaceType: WorkspaceType; builtin: boolean;
  configuration: StoriesConfig | Record<string, never> /* clips: {} (its settings stay in Settings) */;
  version: number; createdAt?: string; updatedAt?: string }
interface StoriesConfig { defaultDurationSec: number /* 15..90, default 45; 30..60 suggested */;
  captionsOn: boolean /* default true */; musicOn: boolean /* default true */;
  storyModel: string /* a key of clipModels in config/models.json, default agentModel */;
  providers: { images: "builtin-rig" | "nova-canvas"; animation: "builtin-2d"; audio: "builtin-synth" };
  youtubeCategory: "1" | "2" | "23" | "24" | "27" /* Film & Animation, Autos & Vehicles, Comedy, Entertainment,
     Education; default "27"; Lamo Clips' own category list and default are not used */;
  youtubePrivacy: "public" | "unlisted" | "private" /* default "public" */ }

type IdeaCategory = "driving_safety" | "everyday_skills" | "comedy" | "explainer";
interface IdeaInput { title: string /* 1..80 */; logline: string /* 1..280 */; category: IdeaCategory;
  characterIds?: string[] /* ≤ 3 */; concept?: VideoConcept; source?: "manual" | "ai" | "variation";
  parentIdeaId?: string }
interface Idea extends IdeaInput { ideaId: string; workspaceId: string; status: "saved" | "used";
  safetyTopicId: string | null /* a GuidanceTopic id, set by the API's keyword match (§45.11.5) */;
  needsGuidance: boolean /* a safety idea no checked guidance covers: it cannot be produced */;
  storyIds: string[]; createdAt: string; updatedAt: string }
interface VideoConcept { premise: string; beats: string[] /* 3..8 short lines */; lesson: string | null;
  ending: string; tone: "funny" | "calm" | "tense_then_relief" | "wholesome"; durationSec: number;
  onScreenText: string[] /* ≤ 6 short captions */ }

// Engine types (CharacterLook, CharacterVoice, Expression, MovementStyle, StoryScript, Scene, Beat, SfxCue, CaptionCue,
// Prim, TextEvent, AudioEvent, Catalog): web/src/stories/engine/types.ts, §45.10.
interface CharacterInput { name: string /* 1..30, unique */; description: string /* ≤ 400 */;
  personality: string /* ≤ 400 */; traits: string[] /* ≤ 8 × ≤ 30 */; movementStyle: MovementStyle;
  expressions: Expression[] /* the faces it uses, ≥ 3, always includes neutral */; look: CharacterLook;
  voice: CharacterVoice }
interface Character extends CharacterInput { characterId: string; workspaceId: string;
  references: { assetId: string; url: string; contentType: string; createdAt: string }[];
  portrait: { assetId: string; url: string } | null; storyCount: number; version: number;
  createdAt: string; updatedAt: string }

type StoryStatus = "draft" | "producing" | "needs_check" | "review" | "approved" | "rejected" | "published" | "failed";
type StepKey = "storyboard" | "safety" | "scenes" | "animation" | "sound" | "captions" | "assemble" | "preview";
// Labels: "Write the story", "Check the facts", "Draw the scenes", "Animate", "Add sounds and music", "Add captions",
// "Put it together", "Ready to watch". A portrait job has one step of its own: { key: "portrait", label: "Draw the picture" }.
interface StoryInput { ideaId?: string; brief?: { title: string; logline: string; category: IdeaCategory } /* "type a
  concept": a short form; the writer expands it */; title?: string; characterIds: string[] /* 1..3 */;
  durationSec?: number /* 15..90 */; captionsOn?: boolean; musicMood?: MusicMood }
interface Captions { youtubeTitle: string; youtubeDescription: string; instagram: string; facebook: string;
  tiktok: string; x: string }   // the same shape as Lamo Clips' (§5), so the platform publishers take it as is
interface Story { storyId: string; workspaceId: string; contentType: "animation"; title: string;
  status: StoryStatus; category: IdeaCategory; ideaId: string | null; characterIds: string[]; durationSec: number;
  actualDurationSec: number | null; captionsOn: boolean; musicMood: MusicMood; postCaptions: Captions;
  scenes: { sceneId: string; title: string; durationSec: number; stillUrl?: string }[];
  scriptVersion: number; videoUrl?: string; coverUrl?: string /* presigned, 1 h */;
  storageLocation: string /* "s3://<bucket>/ws/<userId>/<workspaceId>/stories/<storyId>/" */;
  stale: StepKey[] /* steps an edit or a failure made out of date; a produce without `from` runs exactly these */;
  safetyTopicId: string | null; safety: StorySafety | null; reviewNote: string | null; currentJobId: string | null;
  posted: { platform: Platform; url: string }[]; version: number; createdAt: string; updatedAt: string;
  approvedAt?: string; publishedAt?: string }
interface StorySafety { topicId: string | null /* null: no driving advice, only the "nothing dangerous" check */;
  status: "pending" | "ok" | "problems"; problems: string[]; checkedScriptVersion: number | null;
  citations: { publisher: string; title: string; url: string; section?: string }[] }
interface StoryStep { key: StepKey | "portrait"; label: string; status: "pending" | "running" | "done" | "failed"
  | "skipped"; message?: string; startedAt?: string; finishedAt?: string; i?: number; n?: number }
interface ProductionJob { jobId: string; workspaceId: string; contentType: "animation" | "character";
  contentId: string /* storyId, or characterId for a portrait */; jobType: "produce" | "changes" | "portrait";
  status: "queued" | "running" | "ready" | "needs_check" | "failed" | "canceled"; steps: StoryStep[];
  progress: number /* 0..1 */; configuration: { run: (StepKey | "portrait")[] /* the steps this job runs */;
  from: StepKey | null; sceneIds: string[] | null; note: string | null };
  meta: { writerModel: string | null; engineVersion: number | null; seed: number | null; scriptVersion: number | null;
  targetSec: number | null; actualSec: number | null; safetyTopicId: string | null; providers: Record<string, string> };
  error?: string; createdAt: string; updatedAt: string }
interface SceneEdit { sceneId: string; caption?: string | null; durationSec?: number /* 2..15 */;
  sfx?: SfxCue[] /* replaces that scene's whole effects list: add, move, remove */ }
interface StoryPatch { version: number; title?: string; postCaptions?: Partial<Captions>; captions?: CaptionCue[];
  musicMood?: MusicMood; captionsOn?: boolean; scenes?: SceneEdit[] }

type AssetKind = "final_video" | "cover" | "storyboard" | "scene_clip" | "scene_still" | "character_ref"
  | "portrait" | "audio" | "captions";
interface LibraryItem { assetId: string; kind: AssetKind; storyId: string | null; characterId: string | null;
  title: string /* the story's or character's current title, filled by the route */; url: string /* presigned 1 h */;
  contentType: string; bytes: number; version: number | null; createdAt: string;
  meta: Record<string, string | number> /* sceneId on scene stills and clips; current: 0 | 1 */ }
interface ProviderStatus { kind: "writer" | "images" | "animation" | "audio"; id: string; label: string;
  state: "on" | "off" | "needs_setup" | "unavailable"; line: string /* one plain sentence: what it needs */;
  checkedAt?: string; lastError?: string }
interface GuidanceTopic { id: string; title: string; steps: { id: string; text: string; shown: boolean;
  why?: string }[]; donts: { id: string; text: string; shown: boolean; why?: string }[]; caveats: string[];
  citations: { publisher: string; title: string; url: string; section?: string }[] }

type Platform = "youtube" | "instagram" | "facebook" | "tiktok" | "x";
interface SocialAccount { socialAccountId: string; workspaceId: string; platform: Platform;
  connectionStatus: "not_connected" | "connected" | "choose_account" | "needs_reconnect" | "same_as_clips";
  externalAccountId: string | null; accountName: string | null; handle: string | null; avatarUrl: string | null;
  sharedWithClips: boolean; connectedAt: string | null; missing: string[]; reason: string | null;
  reconnectBy: string | null; choices: { id: string; name: string; avatarUrl?: string; usedByClips: boolean }[] | null;
  limits: string[] /* plain sentences: this platform's rules for a second account, §45.13.5 */;
  warning: string | null /* e.g. the Meta check of §45.13.5 */ }
interface ClipsDestination { platform: Platform; connected: boolean; name: string | null }
  // Lamo Clips' own destination per platform, names only (to warn about the same place); never ids or tokens
interface TikTokCreator { nickname: string; username: string; avatarUrl: string | null; privacyOptions: string[];
  commentDisabled: boolean; duetDisabled: boolean; stitchDisabled: boolean; maxDurationSec: number }
type PublishOptions =   // flat, the keys the platform publishers read (§17.6, §17.8); each route allow-lists them
  | { privacy?: "public" | "unlisted" | "private"; category?: string; notifySubscribers?: boolean } // youtube
  | { privacyLevel: string; disableComment: boolean; disableDuet: boolean; disableStitch: boolean;
      brandContent: boolean; brandOrganic: boolean }                                             // tiktok
  | { shareToFeed?: boolean }                                                                   // instagram
  | Record<string, never>;                                                                      // facebook, x
interface PublishTarget { platform: Platform; socialAccountId: string; options?: PublishOptions }
interface PublishingJob { publishingJobId: string; workspaceId: string; contentId: string; socialAccountId: string;
  platform: Platform; publishingStatus: "queued" | "publishing" | "posted" | "failed" | "needs_attention";
  accountName: string | null; url?: string; postedAt?: string; error?: string;
  metrics?: { views: number | null; likes: number | null; comments: number | null; shares: number | null;
  checkedAt: string }; createdAt: string; updatedAt: string }
interface StoriesDashboard { counts: { made: number; review: number; published: number; producing: number;
  needsCheck: number; needsYou: number }; needsYou: { publishingJobId: string | null; storyId: string | null;
  title: string; platform: Platform | null; sentence: string; href: string }[];
  producing: { storyId: string; title: string; step: StepKey; progress: number }[];
  accounts: { platform: Platform; status: SocialAccount["connectionStatus"]; accountName: string | null }[];
  performance: { views: number; likes: number; comments: number; shares: number; posts: number;
  checkedAt: string | null; lastAt: string | null /* "numbers until 7 days after each post" */ };
  activity: { at: string; kind: "made" | "approved" | "rejected" | "changes" | "posted" | "failed";
  storyId: string; title: string; platform?: Platform }[] }
```

### 45.7 Ideas

* **Manual**: the owner types a title, a line and a category (four big buttons).
* **AI ideas, Expand and Variations** run in `cf-prod-api` (answers in 5–15 s, inside API Gateway's 29 s) through
  `learn.converse_text(..., skills=...)` with the `helpModel` (Claude Haiku 5.5, EU profile, already granted to the
  API). Every call gets the owner's skills block first (§18.6, the owner's rule for every AI call; ADR-74), then the
  Lamo Stories house brief: no voice-over, told through movement, faces, body language, sound and music, 9:16, 30–60 s
  suggested (15–90 allowed), recurring characters (the saved characters' names and personalities are passed), never
  made for children, nothing dangerous for fun, and for `driving_safety` only topics in the checked guidance list
  (§45.11.5). Structured output (one tool, a JSON schema), validated by code; a bad answer is asked once more, then
  "The idea helper is busy. Try again in a minute." (503 `platform_down`). Time limit 22 s.
* **Topic matching happens once, in the API**: an idea or story of category `driving_safety` gets `safetyTopicId`
  from the guidance topics' `keywords` (and the model's pick, checked against the list), else `needsGuidance: true`.
  The agent trusts `safetyTopicId` (§45.11.5).
* Expand fills `concept` (premise, 3–8 beats, the lesson or `null`, the ending, the tone, the duration, on-screen
  text), keeping the title. Variations return new drafts with `source: "variation"` and `parentIdeaId`.
* An idea becomes `used` when a story is made from it (its `storyIds` grow); it can still make more stories.

### 45.8 Characters and keeping them the same

* A character is a **rig**, not a picture: `look` is a small set of choices (body, skin, hair, eyes, brows, nose,
  mouth, outfit colours and pattern, accessory, size, outline). The animation engine (§45.10) draws the same rig the
  same way every time, so a character looks identical in every video by construction. Expressions, movement style,
  noises and favourite sound effects are part of the character too.
* The writer (§45.11.2) only names characters by their cast id; it never describes or changes how they look. Each
  story copies the cast's `look`, `movementStyle` and `voice` into its script when the storyboard is written. A later
  edit to a character shows in new stories and in a "Remake the whole video", never silently in a finished one.
* Reference images (the owner's uploads, up to 8) are kept with the character and shown next to the rig as the look
  the owner is aiming for; they never change the rig. When the image provider is on (§45.11.6) an AI portrait can be
  made from the character's description and look with a fixed seed, shown in the app and the Library only.
* The Characters page edits a character with a live preview (every face, the walk, the wave) drawn by the same
  engine in the browser.

### 45.9 Stories and the production workflow

The owner's ten steps (spec §5.D) map onto one story's life:

| Spec step | Where |
|---|---|
| 1. Pick an idea or type a concept | Production › New: an idea card, or a short form (title, one line, category) the writer expands |
| 2. Pick a character | Pick 1–3 saved characters (each shown with its rig) |
| 3. Storyboard | Job step `storyboard` (the writer, §45.11.2), then `safety` (§45.11.5) |
| 4. Scenes | Step `scenes`: each scene's still, and the storyboard view with live engine previews |
| 5. Animation | Step `animation`: each scene rendered to 1080×1920 at 30 fps |
| 6. Sound effects and music | Step `sound`: the effects, the character noises and the music mood, mixed |
| 7. Captions (optional) | Step `captions`: the on-screen text (on or off per story) |
| 8. Assemble | Step `assemble`: one MP4 plus a cover |
| 9. Preview | Step `preview`: the story goes to `review` (or `needs_check`); the player shows it |
| 10. Approve or request changes | Review (§45.16.6): Approve, Reject, Ask for changes, Remake this scene, Remake the whole video |

* Output: **9:16 vertical, 1080×1920, 30 fps, H.264 + AAC**, 15–90 s (default 45, 30–60 suggested on the slider and in
  every brief); `fitDuration` keeps the total within ±10% of the target and never above **89.5 s** (Facebook Reels'
  90 s limit, with room for the audio tail).
* **Statuses** (who moves them in §45.9.1):

| From | Event | To |
|---|---|---|
| – | create | `producing` (the job starts at once; `draft` only while the first job is being written) |
| `producing` | job ends, no safety problems | `review` |
| `producing` | job ends, safety problems left | `needs_check` (the video is made to the end and plays) |
| `producing` | job fails | `failed`, the failed step and every later one added to `stale` |
| `producing` | cancel | the status before the job (`statusBefore`; `draft` for a first run), `stale` as it was |
| `review`, `needs_check`, `failed` | PATCH | the same status, `stale` grows (below) |
| `review`, `needs_check`, `failed` | produce, changes | `producing` |
| `review` | approve (rule below) | `approved` |
| `review`, `needs_check` | reject | `rejected` |
| `approved`, `published` | the first publishing job posted | `published` |

* **What an edit makes stale.** Captions (`captions`, a scene's `caption`, `captionsOn`): `captions`, `assemble`,
  `preview`, and `safety` when the story has `safety` (every story has the "nothing dangerous" check, so always).
  A scene's effects or the music: `sound`, `assemble`, `preview`. A scene's length: `animation` for that scene,
  `sound`, `captions`, `assemble`, `preview`. Post captions: `safety` only (no video change). A produce without `from`
  runs exactly the `stale` steps in step order and nothing else; "Check again" is that call. An explicit `from` runs
  from that step to the end.
* **Approve** needs `status = review`, `stale = []`, and `safety` either null or `status = "ok"` with
  `checkedScriptVersion = scriptVersion`; otherwise `409` "Your changes aren't in the video yet. Tap Remake first."
  (or, with problems, "Fix the facts first: …").
* **Remakes.** "Remake this scene" is `changes { sceneIds: [id] }` with no note: the writer writes a new take of only
  that scene (same cast, same place in the story, same length, different action and staging, a new per-scene `seed`),
  and the job runs `storyboard` (that scene only), `safety`, `scenes` and `animation` for that scene, then `sound`,
  `captions`, `assemble`, `preview`. "Ask for changes" is `changes { note, sceneIds? }`. "Remake the whole video" is
  `produce { from: "storyboard" }`: a new script version with the characters' current looks. `produce { from:
  "scenes" | "animation", sceneIds }` only re-renders after a scene edit or an engine change.

#### 45.9.1 Who writes what

| Item | The API (builder A) | The agent (builder E) | The story flow (builder B) |
|---|---|---|---|
| `STORY#` | the item on create; `title`, PATCH edits (script `v{n+1}`, `scriptVersion`, `stale`), `currentJobId`, `statusBefore`, `status` → `producing`, `approved`, `rejected`, `failed` (by `settle`), `approvedAt`, `reviewNote`, `safety.status = "pending"` on an edit | after `storyboard`: `scriptVersion`, `scriptKey`, `postCaptions`, `scenes[]`, `safetyTopicId` only if it was null and the writer flagged `teachesSafety` (with `needs_check`); after `scenes`: `stillKeys`; after `safety`: `safety`; after `assemble`: `videoKey`, `coverKey`, `actualDurationSec`; removes each finished step from `stale`; at the end `status` → `review`, `needs_check` or `failed` and clears `currentJobId` (fenced on the job's `sessionId`) | on a `posted` job: `posted` (append), `publishedAt` (if absent), `status` → `published` (only from `approved` or `published`) |
| `PJOB#` | the item: all steps (`run` ones `pending`, the others `done` or `skipped`), `configuration`, `sessionId`, `heartbeatAt = createdAt`, `status = queued`; `settle` (below); cancel | each step's `status`, `message`, `startedAt`, `finishedAt`, `i`, `n`; `progress`, `heartbeatAt`, `status`, `error`, `meta` | – |
| `ASSET#` | reference images | every file it makes (`meta.sceneId` on scene files, `meta.current`) | – |
| `PROVIDER#` | – | after a real call | – |
| `ACT#` | approve, reject, changes | made, failed | posted, failed |
| `PUBJOB#` | create, retry | – | status, `url`, `postedAt`, `error`, `publishHandle`, `platformPostId`, `statsId`, `metrics`, `numbersAt` |
| `SOCIAL#` | – (builder B's routes) | – | `connectionStatus`/`reason`/`reconnectBy` through the token provider only |

`progress` = (done and skipped steps + the running step's `i/n`) ÷ the number of steps. **The stale-heartbeat fence**
(`workspaces/jobs.py: settle`, called by every read that returns or checks a job: GET story, the stories list, the
dashboard, produce's 409 check, character delete, cancel): a job `queued` with `heartbeatAt` older than 3 minutes,
or `running` older than 6, is failed in one transaction (PJOB: `status = failed`, the running step `failed`, `error =
"Making the video stopped. Tap Try again."`, a new `sessionId`, conditional on the `status`, `sessionId` and
`heartbeatAt` read; STORY: `status = failed`, its steps into `stale`, conditional on `currentJobId`), then the old
session is stopped (best effort). A refused condition means re-read and return what is stored. A failed start is
`failed` with "Making the video did not start. Tap Try again." (conditional on `status = queued`).

### 45.10 The animation engine (one folder, two places)

`web/src/stories/engine/`: TypeScript with only relative `./*.ts` imports inside the folder (no npm, DOM, network,
`Date`, `performance`, `Math.random`; `Deno` only in `cli.ts`; a vitest scan holds this), so the **browser** draws it
for live previews and the **agent** runs the very same files with Deno (already in the agent image) for the final
frames. One source of truth for how a character moves; the preview and the video use the same draw lists.

```ts
export const ENGINE_VERSION: number;           // bumps when drawing changes; stored on each job's meta
export const CATALOG: Catalog;                 // every id below with a plain label (the writer's vocabulary)
export function validateScript(s: unknown): { ok: true; script: StoryScript } | { ok: false; errors: string[] };
export function normalizeScript(s: StoryScript): StoryScript; // moves Beat.sfx into the scene's sfx list (ids
                                                              // "{sceneId}.fx{k}"), fills scene seeds, sorts
export function fitDuration(s: StoryScript, targetSec: number): StoryScript;  // ±10%, ≤ 89.5 s, scenes 2..15 s,
                                                                             // beat and effect times scaled too
export function frameCount(s: StoryScript): number;                           // round(durationSec × fps)
export function drawFrame(s: StoryScript, frame: number): Prim[];             // pure and deterministic
export function sceneFrames(s: StoryScript, sceneId: string): [number, number];
export function textTrack(s: StoryScript): TextEvent[];   // captions, bubble symbols, the safety end card
export function audioTrack(s: StoryScript): AudioEvent[]; // every effect (from the scenes' lists) and noise, absolute
export function previewCharacter(look: CharacterLook, style: MovementStyle, expression: Expression,
  action: ActionId, t: number, size: number): Prim[];      // the Characters page
type Prim =
  | { k: "fill"; color: Hex }
  | { k: "grad"; x0: number; y0: number; x1: number; y1: number; stops: [number, Hex][] }
  | { k: "rect"; x: number; y: number; w: number; h: number; r: number; color: Hex; a?: number }
  | { k: "circle"; x: number; y: number; r: number; color: Hex; a?: number }
  | { k: "ellipse"; x: number; y: number; rx: number; ry: number; rot: number /* degrees */; color: Hex; a?: number }
  | { k: "poly"; pts: number[]; color: Hex; a?: number }          // flattened curves, non-zero fill
  | { k: "line"; pts: number[]; w: number; color: Hex; a?: number } // round caps and joins
  | { k: "image"; asset: string; x: number; y: number; w: number; h: number; a?: number };
// Output pixels 0..1080 × 0..1920, painter's order, source-over in sRGB, colours "#rrggbb", alpha a 0..1 (default 1).
// The web draws them with preview/draw.ts; the agent with stories/raster.py; engine/README.md is the one description.
```

**The story script** (the storyboard, stored as `script/v{n}.json`): `StoryScript { engine, fps: 30, width: 1080,
height: 1920, durationSec, title, seed, cast: Record<CastId, {characterId, name, look, movementStyle, voice}>, scenes:
Scene[], music: {mood, volume} | null, captionsOn, captions: CaptionCue[] /* times in the whole video */, safety:
{topicId, citations} | null }`; `Scene { sceneId, title (≤ 40), durationSec (2..15), seed?, set, view: "side" | "top"
(a road from above, to show how a car moves), camera, actors: {castId, x, y (0..1), facing, inCar?}[], props:
{propId, kind, x, y, scale, rot, color?, state?}[], beats: Beat[], sfx: SfxCue[] /* this scene's editable effects,
times from the scene's start */, caption: string | null (≤ 60), note: string | null }`; `Beat { at, dur (seconds in
the scene), who: CastId | propId, do: ActionId | PropAction, face?, to?, dir?, bubble?, noise?, sfx? /* only in the
writer's raw answer: normalizeScript moves it into Scene.sfx */ }`; `SfxCue { id, at, sfx, volume }`; `CaptionCue {
id, at, dur, text (≤ 60), guidanceRef? }`. The exact definitions are `web/src/stories/engine/types.ts`.

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
* music moods: `none`, `calm`, `playful`, `tense`, `triumphant`, `wonder`, `comedic`.

Movement styles change the timing curves (bouncy overshoots, heavy settles slowly, clumsy wobbles, zippy is quick,
calm eases). **The command line** (`web/src/stories/engine/cli.ts`, run as `deno run --allow-read cli.ts …`; it
never reads the network and writes only to stdout, errors to stderr with exit code 2):

```
validate <script.json>            → {"ok": true} | {"ok": false, "errors": [...]}
normalize <script.json>           → the normalized script
fit <seconds> <script.json>       → the fitted script
frames <script.json> [from] [to]  → one JSON line per frame: {"f": n, "p": Prim[]}
scenes <script.json>              → [{"sceneId", "from", "to", "mid"}] (frame numbers)
text <script.json>                → TextEvent[]
audio <script.json>               → AudioEvent[]
catalog                           → {"engine": n, "catalog": CATALOG}
version                           → {"engine": n}
```

`web/src/stories/engine/fixtures/sample-script.json` is part of the contract: it always validates, the agent's
pipeline test and the image self-check use it.

### 45.11 The agent's part (AgentCore runtime `cf_prod_clip_agent`, new actions only)

#### 45.11.1 Actions, fencing, shutdown

* `{ "action": "process_story", "userId", "workspaceId", "storyId", "jobId" }` and `{ "action":
  "process_portrait", "userId", "workspaceId", "characterId", "jobId" }` → `{ "accepted": true, "jobId" }` at once;
  the job runs in the background like a clip job. `{ "action": "cancel_story", "jobId" }` stops it. The API invokes
  them through `workspaces/agent.py` (§45.5) and stores the session id on the job.
* `server.py` gains these three actions and nothing else: `process_job`, `cancel` and `health` keep their exact
  validation and answers (the existing server tests unchanged); `/ping` says `HealthyBusy` while a clip job **or** a
  story job runs; the lifespan shutdown cancels story tasks too, so they stop cleanly (a stopped job is `failed` by the
  API's fence and "Try again" resumes from its first unfinished step, because every finished step's files stay).
  All story code lives in `agent/src/clipfactory_agent/stories/` and imports nothing from the clip pipeline modules
  except `bedrock.py`, `skills.py`, `util.py`, `proc.py`, `retry.py`, `config.py` and `store.py`'s table client.
* The job heartbeats `heartbeatAt` every ≤ 60 s from the event loop; heavy work (rasterizing, ffmpeg, synthesis) runs
  off the loop (threads or processes), so the heartbeat stays honest. Every `PJOB#` write is conditional on
  `sessionId = :sid AND status <> canceled`; every `STORY#` and `ASSET#` write is a transaction with a
  ConditionCheck on the job's `sessionId` (as `store._fenced_write` does for clips). A refused write ends the run.
  Failure sentences name the button ("Tap Try again"), never raw tool output; presigned URLs are redacted in logs.
* The deploy drain (`scripts/wait-for-jobs.sh`) waits for running story jobs too (`PJOB#` with a fresh
  `heartbeatAt`), like clip jobs.

#### 45.11.2 The writer (`storyboard` step)

`Bedrock.structured(skills=block, tool="write_storyboard", schema=STORYBOARD_SCHEMA)` with the workspace's
`storyModel` (default the agent's model): the brief or concept, the cast (names, personalities, traits, movement
styles, the faces and noises each has; never the look), the catalog (from `cli.ts catalog`), the target length, the
captions switch, for safety stories the guidance topic's **shown** steps and donts (§45.11.5), and for changes the
current script, the owner's note and the scene ids (only those scenes change; with no note, "write a new take of only
these scenes: keep the cast, the story beat, the scene's place and length; make the action and staging different").
The answer becomes a `StoryScript` (code adds `engine`, `fps`, `seed`, per-scene seeds and `cast` with looks), goes
through `cli.ts normalize`, `validate` and `fit`; a failing answer is asked once more with the errors. It also writes
the six post captions (`Captions`): YouTube title ≤ 100 chars, the others within §17.6's limits, the safety sources
named in the descriptions.

#### 45.11.3 Drawing, animating and sound (the built-in providers)

* `scenes`: each scene's middle frame (`cli.ts scenes`) rasterized to `still-v{n}.jpg`.
* `animation`: per scene, `cli.ts frames` streamed line by line → `stories/raster.py` (numpy; anti-aliased coverage
  per primitive, the semantics of `engine/README.md`) → raw RGB piped into ffmpeg (`libx264`, `yuv420p`, 30 fps,
  CRF 20) → `scenes/{sceneId}/v{n}.mp4`. Scenes render 2 at a time.
* `sound` (`stories/audio.py`): every effect and noise of `audioTrack` synthesized with numpy (no audio files, no
  network): effects from noise, sweeps and envelopes; noises as short formant "voices" in the character's pitch;
  music as a seeded loop per mood (chords, bass, light drums). Mixed at 48 kHz stereo, the music ducked under effects,
  then `loudnorm` two-pass to -14 LUFS, ≤ -1 dBTP (as clips) → `audio/v{n}.m4a`.
* `captions`: `textTrack` → an ASS file (Inter, the platforms' safe area, bubble symbols at their positions, the
  safety end card); `skipped` when `captionsOn` is false and there is no bubble or end card.
* `assemble`: the scene files joined, the audio muxed, the ASS burned in (libass, as clips) → `final/v{n}.mp4`
  (`+faststart`) and `cover-v{n}.jpg`; `actualDurationSec` from ffprobe (≤ 89.5). Every file is an `ASSET#` (§45.12).
* `preview`: the story goes to `review` (or `needs_check`), the job `ready` (or `needs_check`).

Writing takes about 30–90 s, drawing and animating a few minutes for 45 s of video, sound and assembly under a
minute (measured on the fixture and reported by builder E). There is no cost ceiling (as for clips, ADR-40), but a
runaway guard: at most 3 writer calls and 2 checker calls per job.

#### 45.11.4 Agent configuration

`config/models.json` gains a top-level `imageModel: { label, modelId: "amazon.nova-canvas-v1:0", region:
"eu-west-1" }`, shaped like `embeddingModel` and outside `models` and `clipModels` (never prefixed with a profile).
Terraform builds its ARN and passes `CF_IMAGE_MODEL_ID` and `CF_IMAGE_REGION` to the runtime; `Config` reads them.

#### 45.11.5 Safety stories only from checked guidance

* `config/stories-guidance.json` is the **checked guidance list**: 12 driving situations (skidding, ice and snow, a
  tyre blowout, aquaplaning, brake failure, a stuck accelerator, wheels off the road edge, fog, an animal on the road,
  a motorway breakdown, an emergency stop with ABS, strong crosswinds), each with the steps in order, the donts, the
  caveats and the countries' differences, and 38 sources: the UK Highway Code (GOV.UK), National Highways, RoSPA, the
  New York and California DMV driver manuals, the Ontario Ministry of Transportation, Transport Canada, Transport for
  NSW, Trafikverket and the Swedish National Wildlife Accident Council, each with its URL, section and a verbatim
  quote, fetched and checked on 2026-11-21. NHTSA, FMCSA, the National Safety Council and VicRoads refused the
  download and are not cited. A new source needs a fetched, quote-checked page. Bundled into the agent image (with
  `config/`) and into the API zip.
* Each step and dont carries its sources and `shown`: a step is shown in a video only when a road authority states
  it **and** no other cited source contradicts it (the research found real disagreements: stay in the car or get out
  after a motorway breakdown, shifting to neutral in a skid, releasing the brake in a skid, warning triangles on
  motorways). A hidden step is never put on screen; the video then says "Check your local road rules."
* `GET …/guidance` returns every topic with every step and dont and its `shown` flag, the caveats, and the citations
  resolved from `sources`.
* A `driving_safety` story must have a `safetyTopicId` (the API's match, §45.7); with none it **cannot be produced**:
  "Lamo Stories only makes driving-safety videos from checked advice, and this one isn't in the list yet." plus the
  list. A story of another category that the writer flags `teachesSafety` is held in `needs_check` until the owner
  picks a topic or removes the advice.
* The writer gets only the topic's shown steps and donts and must take every on-screen instruction from them
  (`CaptionCue.guidanceRef`). Step `safety` then asks a second model call (a checker with its own prompt,
  `tool="check_facts"`) whether each caption, each scene caption and each beat that shows a driving action agrees with
  the topic and its caveats, and, for every story, that nothing shows a dangerous act as something to copy. The
  writer's own text is rewritten once on a disagreement; an owner's edited text is never rewritten (its problems are
  shown to him). Problems left become `story.safety.problems`; the job ends `needs_check` with the video made, and the
  story cannot be approved until a check passes (`checkedScriptVersion`). The end card says "Based on {publisher}
  advice. Check your local road rules." and the post descriptions name the sources.

#### 45.11.6 Providers (who makes what)

A registry, `agent/src/clipfactory_agent/stories/providers.py`, with four kinds and one Protocol each; the pipeline
calls only `REGISTRY[kind][config.providers[kind]]` (the writer: `storyModel`), so a new provider is one class and
one registry line:

* `Writer.write(brief: dict) -> dict` (a raw script; it always goes through normalize, validate and fit);
* `ImageProvider.image(prompt: str, width: int, height: int, seed: int, refs: list[Path]) -> bytes` (PNG);
* `AnimationProvider.render_scene(script: dict, scene_id: str, assets: dict[str, Path], out: Path) -> SceneClip(path,
  still, duration_sec)` (per scene, an MP4: a text-to-video model would fit the same seam);
* `AudioProvider.mix(script: dict, out: Path) -> Path` (an m4a at 48 kHz, -14 LUFS);
* each also has `check() -> ProviderStatus`.

| Kind | Provider | State |
|---|---|---|
| writer | `bedrock-claude` (the clip models, `storyModel`) | on (already set up) |
| animation | `builtin-2d` (the engine + rasterizer) | on |
| audio | `builtin-synth` (numpy synthesis) | on |
| images | `builtin-rig` (the character drawn by the engine) | on |
| images | `nova-canvas` (Amazon Nova Canvas, Bedrock in `eu-west-1`, `imageModel` in `config/models.json`) | off until the owner picks it in Lamo Stories › Settings; then `needs_setup` until the first portrait job's real call answers (`on`, with `checkedAt`) or fails (`needs_setup` with `lastError`, e.g. "Bedrock says Nova Canvas is not enabled for this account in Europe (Ireland)."). Used for character portraits shown in the app and the Library only, never inside a posted video (the shared publishers mark posts as not AI-generated, §45.14). |
| animation | `nova-reel` (Amazon Nova Reel) | `unavailable`, interface only: Reel writes its output to an S3 bucket in us-east-1, which this app does not have, and its realistic clips would need the platforms' AI labels, which the shared publishers do not set. |

`GET …/providers` is served by the API from a static mirror of the registry (`workspaces/providers.py`, a test
compares the two) merged with the stored `PROVIDER#` items. A provider shows `on` only after a real call succeeded;
nothing is shown as working because it was configured.

### 45.12 Library and assets

Every file a job or an upload makes is an `ASSET#` item (`assetId`, `kind`, `storyId`, `characterId`, `key`,
`contentType`, `bytes`, `version`, `meta`, `createdAt`) in its workspace's partition; the Library lists those items
(newest first, filter by kind, story or character) with presigned links. **Projects** (the first Library tab) are the
stories themselves (`GET …/stories?status=all`): cover, title, status, cast, length, script version, date; a project
opens its files grouped by kind and a Details panel with its **production metadata** (`GET …/stories/{id}/jobs`:
each job's steps with times, writer model, engine version, seed, target and actual length, safety topic, providers).
A remake keeps older versions as assets (`meta.current = 0`); deleting a story deletes its assets and files; deleting
a character deletes its references and portrait. Nothing of a Lamo Stories workspace can appear in Lamo Clips'
Library: that Library reads `CLIP#` items of `USER#{userId}` only.

### 45.13 Separate social connections

#### 45.13.1 What is shared and what is not

* **Shared, read-only:** the platform developer apps the owner already made for Lamo Clips (`cf-prod/platforms/
  {platform}/app`: client id, secret, Meta config id) and the redirect URIs registered with them. Lamo Stories never
  writes, rotates or deletes them, so nothing has to be set up again on any platform and Lamo Clips' keys stay as
  they are. The client id used at connect is stored on the account (`appClientId`); when Lamo Clips' keys change
  later (for example TikTok's Production keys replacing the Sandbox ones), the Lamo Stories account shows
  `needs_reconnect` ("The {Platform} app keys changed in Lamo Clips. Connect again.") instead of failing on upload.
* **Separate:** every user token. Lamo Stories tokens live only at `cf-prod/workspaces/{workspaceId}/{platform}/token`
  (and `…/pending` for Meta's list of Pages, 30 minutes), JSON in Secrets Manager (encrypted with the account's
  Secrets Manager key), created by `workspaces/secrets.py` with tags `app=cf-prod`, `workspace={workspaceId}`,
  `platform` (values through `oauth.secrets.Secrets` with the workspace prefix). Never in DynamoDB, logs, responses,
  URLs or the browser. The `SOCIAL#{platform}` item holds only the public identity (external id, name, handle,
  avatar), the status and the scopes.
* IAM keeps them apart (§45.15): Lamo Clips' clip flow, stats and money functions can read only
  `cf-prod/platforms/*`; the new `cf-prod-story-flow` can read only `cf-prod/workspaces/*` and the five `…/app`
  secrets, never a `cf-prod/platforms/*/token`. The API and the OAuth callback, which manage both, pick the secret
  name from the validated workspace id and the stored state only.

#### 45.13.2 Connect

`POST …/social/{platform}/connect` makes a **workspace state**, `w1.{workspaceId}.{nonce}.{exp}.{sig}` with `sig =
b64url(HMAC_SHA256(stateKey, "w1|" + platform + "|" + workspaceId + "|" + nonce + "|" + exp))` (the same key and
10 minutes as §17.4; well under the 200-character state limit; PKCE derives from the nonce as today), and the state
item `OAUTH#{nonce}`/`STATE` with `workspaceId` and `socialAccountId` added. Today's `v1.` format and `state.verify`
are unchanged and reject `w1.` states. It returns the platform's authorize URL, built in `workspaces/social.py` from
the same app keys and redirect URI as Lamo Clips (a test compares it with `providers` except for the parameters
below; `providers.py` is not changed), plus:
* youtube: `prompt=select_account consent` (Google always shows its account and channel picker, Brand Accounts
  included);
* tiktok: `disable_auto_auth=1` (as today: TikTok always shows its consent page, for the account signed in on
  tiktok.com); the page says first "Sign in to your Lamo Stories account on tiktok.com in this browser. TikTok
  connects the account that is signed in.";
* instagram, facebook: the same Login configuration; the page says before the tap "Facebook will ask which Pages
  Clip Factory may use. Keep your Lamo Clips Page ticked and also tick the Lamo Stories Page." (§45.13.5);
* x: as today; the page says "First sign in to your Lamo Stories account on x.com in this browser. X connects the
  account that is signed in."

#### 45.13.3 The callback (the same `GET /oauth/{platform}/callback`)

The landing page is decided from the state's prefix before anything is verified: in `hooks.py`'s `_oauth_callback`
(before its `try`, so its `except` also lands right) and `oauth/callback.py`:
* A `v1.` state goes through today's code unchanged; if its consumed item carries `workspaceId` it is refused
  (nothing written, landing `/stories/connections?platform={p}&result=error`).
* A `w1.` state always lands on `{APP_URL}/stories/connections?platform={p}&result={code}`, whatever happens (a bad
  signature, expired, already used, an exception, a missing or different `workspaceId` on the item), with `&ws={id}`
  added only after its signature checks out. Codes come from a fixed `WS_RESULTS` list (§17.5's codes plus
  `same_as_clips` and `clips_meta_check`); nothing else from the request is reflected.
The workspace path (`workspaces/social_callback.py`, wrapped whole in try/except → `error`):
1. exchanges the code with `providers.exchange` (the same code as Lamo Clips, read-only use);
2. finds the identity: **YouTube** is one channel per token (`channels?part=id,snippet&mine=true`: none →
   `no_channel`; one → that channel; more than one → `error`, nothing written: there is no way to post to another);
   **Meta** lists Pages (with their Instagram accounts) → `choose_account` when there are several, each choice marked
   `usedByClips` when it is Lamo Clips' destination; **TikTok** and **X** the one signed-in user;
3. writes the token to the workspace secret, then `SOCIAL#{platform}`: `connected` with `externalAccountId`,
   `accountName`, `handle`, `avatarUrl`, `appClientId`, clearing `sharedWithClips`; or `choose_account`; or
   `same_as_clips` when the identity is Lamo Clips' own (compared with `ACCOUNT#{platform}.accountId`, read-only);
4. after a Meta connect, a read-only check that Lamo Clips' Meta connection still answers: Lamo Clips' `ACCOUNT#` and
   token are read (no refresh, no write), `GET /{igUserId|pageId}?fields=id` with `appsecret_proof` must answer 200
   with the same id; anything else sets the result `clips_meta_check` and the account's `warning` "Lamo Clips may have
   lost {Instagram|Facebook}. Connect it again in Lamo Clips, keeping its Page ticked." (it never changes Lamo Clips'
   items).
It never writes `ACCOUNT#`, `SETUP#` or any `cf-prod/platforms/*` secret, and never releases Lamo Clips posts. An
expired state whose item cannot be read at all still lands on `/stories/connections` (the `w1.` prefix says so), and
the Connections page shows "That took too long. Tap Connect again.".

#### 45.13.4 Same place as Lamo Clips: only on purpose

A Lamo Stories account whose identity is Lamo Clips' own (same channel id, Page id, Instagram id, TikTok open id or X
user id) is `same_as_clips` and cannot be posted to. The Connections page says "This is the same {place} Lamo Clips
posts to." with **Pick another** (connect again) and **Use it for both** (the share route, after a second "Are you
sure?" step), which sets `sharedWithClips: true`, `sharedExternalAccountId` = that identity and `connected`. Every
connect or choose clears both; publishing accepts a shared account only while `sharedExternalAccountId` equals the
current identity (§45.14).

#### 45.13.5 What each platform allows (shown on the Connections page in plain words, `limits`)

* **YouTube:** one Google sign-in can hold several channels (Brand Accounts). A connection posts to exactly one
  channel: the one picked in Google's picker. Lamo Stories shows its name and id after connecting; **Pick another
  channel** connects again ("Google will ask which channel. Pick your Lamo Stories channel."). Both channels share the
  same Google project's daily units (about 6 uploads a day in all, counted together, §45.14).
* **Instagram:** a separate professional (Business or Creator) account, linked to a Facebook Page. Meta asks which
  Pages and accounts the app may use **for your whole Facebook login**: unticking Lamo Clips' Page there would cut
  Lamo Clips off, so Lamo Stories checks Lamo Clips afterwards (§45.13.3) and warns.
* **Facebook:** a separate Page managed by the same Facebook login; the same note on ticking both Pages.
* **TikTok:** while the TikTok app is in Sandbox (review pending since 2026-11-21) only accounts added as Sandbox
  target users can connect, and until TikTok approves the app the account must be **private** and posts stay "Only
  me" (as for Lamo Clips, §17). So the Lamo Stories account has to be a Sandbox target user and private. When the
  app goes live with new keys, Lamo Stories asks to connect again.
* **X:** a separate X account; X connects the account signed in on x.com, and posts use the same X app's credits and
  the owner's one monthly X limit (shared with Lamo Clips, §45.14).
Lamo Stories never creates an account anywhere, and never assumes an email address means an account.

#### 45.13.6 Disconnect never revokes

`DELETE …/social/{platform}` deletes only `cf-prod/workspaces/{ws}/{platform}/token` and `…/pending` and sets
`SOCIAL#{platform}` to `not_connected`. It never calls a platform's revoke endpoint: the apps are Lamo Clips' (ADR-72),
and Google's and TikTok's revoke end the app's whole grant for that account (one Google sign-in can hold both
channels), which would cut Lamo Clips off, as §40 found for AdSense. A reconnect never revokes the token it replaces.
After Disconnect the page says once: "To remove Clip Factory from this account completely, remove the app in the
account's own settings. Only do that if Lamo Clips does not use the same account." The workspace disconnect is its
own code, never `routes/setup.py`'s.

### 45.14 Publishing, only to the workspace's own accounts

* `POST …/stories/{storyId}/publish` writes one `PUBJOB#` per target **after** `validate_destination` passes for each,
  then starts `cf-prod-story-flow` (alias `live`) once with `{ userId, workspaceId, storyId, publishingJobIds, run }`
  (`DurableExecutionName = "story-{storyId}-{run}"`, `run` raised on the story with a conditional update; "already
  started" is a no-op, as for clips). Every publishing job records `workspaceId`, `contentId`, `socialAccountId`,
  `platform`, the identity at the moment of the tap (`externalAccountId`) and `publishingStatus`. Retry raises `run`,
  re-runs the check at the tap and, when the account's identity changed, answers `409` naming the new account until the
  owner confirms it (`confirmAccount`); only then is the new identity recorded.
* `validate_destination(store, secrets, user_id, workspace_id, job_or_target)` (`workspaces/destinations.py`, one
  function, run by the API at the tap and by the flow **inside the body of every step that calls a platform**:
  publish, check, finish, numbers; a separate early `validate-{platform}` step only stops sooner):
  1. the workspace exists for this user and is a `stories` workspace;
  2. the story is in the same workspace partition, `contentId` matches, and it is `approved` or `published`, with a
     final video and `actualDurationSec`;
  3. the social account is in the same workspace partition, `socialAccountId` is `{workspaceId}.{platform}`, its
     platform is the job's, its status `connected`, its `appClientId` equals the client id in `cf-prod/platforms/
     {platform}/app`, and its `externalAccountId` equals the one the job recorded;
  4. the credentials are read from `cf-prod/workspaces/{workspaceId}/{platform}/token` only (a name built from the
     validated ids by `workspaces.types.secret_name`, never from the item or the request); the identity **inside the
     secret** (youtube `channelId`, tiktok `openId`, instagram `igUserId`, facebook `pageId`, x `xUserId`) must equal
     the job's and the account's `externalAccountId`; a missing secret or field is "not connected";
  5. that identity is not Lamo Clips' own destination (`ACCOUNT#{platform}.accountId`, read-only), unless
     `sharedWithClips` is true and `sharedExternalAccountId` equals it.
  Any failure stops that job with `needs_attention` and a plain sentence, nothing is sent, and the dashboard's **Needs
  you** list and bar show it (§45.16.3). There is **no default account**: no target, no post; an ambiguous or missing
  destination never falls back to anything.
* **The PublishJob.** The flow reuses the platform publishers unchanged (`platforms.publishers.publisher_for`,
  §17.6): `post` = the PUBJOB item (its `publishHandle` saved after each creating call), `clip` = `{ captions:
  story.postCaptions, durationSec: story.actualDurationSec, hook: story.title }`, `account` = `{ accountId: the
  checked identity }`, `creds` from `WorkspaceTokenProvider`, `video` = `S3Video` on the story's `final/v{n}.mp4`,
  `options` = the target's flat options (allow-listed per platform; `campaign` and any unknown key refused;
  `madeForKids` never accepted, always false), YouTube `category` and `privacy` defaulting to `StoriesConfig`,
  `settings` = `{}` (Lamo Clips' settings and preset never apply to Lamo Stories posts).
* **WorkspaceTokenProvider** (`workspaces/tokens.py`, its own class, not a subclass of `SecretsTokenProvider`): app
  keys read-only from `cf-prod/platforms/{p}/app`; the token from the workspace secret only; refresh and rotation with
  `providers.refresh`, the lease on `SOCIAL#{p}` (`take_lease`/`clear_lease`), the new token written put-only
  (`create=False`; a missing secret is "not connected"); a dead token sets `SOCIAL#{p}` `needs_reconnect`; the TikTok
  watch sets `reason: expires_soon` and `reconnectBy` on `SOCIAL#tiktok`. It never imports `oauth.tokens.
  SecretsTokenProvider`, `oauth.setup.mark_account` or `stats.refresh`, and never writes `ACCOUNT#` or `SETUP#`.
* **Shared limits** (one X bill, one Google project): before the first X start (no handle yet) the flow calls
  `stats.budget.charge_post` exactly as the clip flow does; when it says no, the job is `needs_attention` with "Lamo
  Stories stopped X: this month's X limit is used up (it is shared with Lamo Clips)." and nothing goes to X (Lamo
  Clips' setup gates are not written). Every numbers read checks `budget.blocked_until`, reserves with
  `budget.reserve` (the cost as `stats.refresh` computes it; X ids so its per-read price is counted) and records with
  `budget.record`; a blocked read waits for the next checkpoint. YouTube uploads use the same daily units as Lamo Clips.
* **Steps**: `validate-{platform}`, `publish-{platform}`, `wait-{platform}-{n}`, `check-{platform}-{n}`,
  `finish-{platform}`, `posted-{platform}`, then `wait-numbers-{k}` and `numbers-{k}` at 1 h, 24 h, 72 h and 7 days
  after that platform's `postedAt` (views, likes, comments, shares through the platforms' stats adapters with the
  workspace credentials), stored on the publishing job. The flow's execution timeout covers 7 days and the longest
  publish loop (§45.15).
* **Sentences** (`workspaces/sentences.py`, `story_sentence(platform, kind, account_name)`): the flow never stores a
  publisher's or token helper's sentence that names Lamo Clips' Settings; every `Problem.kind` (reconnect, credits,
  rate, daily, file, banned, private, down, duplicate, other, not_connected, token_dead) maps to a Lamo Stories
  sentence, for example "Lamo Stories' YouTube (Lamo Stories Channel) needs connecting again. Open Lamo Stories ›
  Connections, then tap Try again." and "Make the Lamo Stories TikTok account private until TikTok approves the app,
  then tap Try again.".
* Posting settings follow the owner's posting preferences: public, comments, duets and stitches on, never "made for
  kids" (the TikTok sheet's rules: privacy picked from the dropdown with no default, Comments/Duet/Stitch shown and
  starting off, "Use my settings" as the owner's tap; the TikTok sheet reads `GET …/social/tiktok/creator-info`).
  Lamo Stories' built-in videos are cartoons, so the publishers' existing "not AI-realistic" flags are correct.
* Lamo Clips' `POST /v1/clips/{clipId}/confirm`, its posts, the clip flow and the release keep reading only
  `ACCOUNT#` and `cf-prod/platforms/*`: they cannot reach a Lamo Stories account.

### 45.15 Infra (Terraform, additive only)

* `infra/modules/flows`: one more entry, `story-flow` (`clipfactory_api.flows.story_flow.handler`, durable, alias
  `live`, `memory = 1024`, `timeout = 900`, `execution_timeout = 777600` (9 days: the 7-day numbers and the publish
  loops), with its own role, **not** clip-flow's statements:
  DynamoDB on the table only (no index): writes (PutItem, UpdateItem, TransactWriteItems, ConditionCheckItem) with
  `ForAllValues:StringLike dynamodb:LeadingKeys = ["USER#*#WS#*", "RATE#*"]`, reads (GetItem, Query, BatchGetItem)
  on `USER#*` and `RATE#*`; no Delete, no Scan. S3 `GetObject` on `ws/*` only. Secrets `GetSecretValue` on
  `cf-prod/workspaces/*` and on the five app secrets `cf-prod/platforms/{youtube,tiktok,instagram,facebook,x}/app-*`,
  `PutSecretValue` on `cf-prod/workspaces/*/token-*`; no Bedrock. Env `TABLE_NAME`, `MEDIA_BUCKET`,
  `WS_SECRET_PREFIX=cf-prod/workspaces/`, `SECRET_PREFIX` (for the app keys only). Its alarms join
  `durable_function_names`.
* `infra/modules/api`: new statements: S3 Get/Put/Delete on `ws/*`, ListBucket on prefix `ws/`; Secrets Create, Put,
  Get, Describe, Delete, Tag on `cf-prod/workspaces/*`; `lambda:InvokeFunction` on the story-flow alias; env
  `STORY_FLOW_ARN`, `WS_SECRET_PREFIX`. Nothing removed.
* `infra/modules/hooks`: Secrets on `cf-prod/workspaces/*/token*` Create, Put, Get, Describe, Tag, and on
  `cf-prod/workspaces/*/pending*` the same plus Delete (the split Lamo Clips' secrets have); env `WS_SECRET_PREFIX`.
  Its DynamoDB `USER#*` leading-key grants already cover `USER#{userId}#WS#…` and `USER#{userId}#WSREG` (a test
  asserts it).
* `infra/modules/agent`: Bedrock `InvokeModel` on the Nova Canvas ARN from `imageModel` (used only when the owner
  switches that provider on); env `CF_IMAGE_MODEL_ID`, `CF_IMAGE_REGION`. Its S3 and DynamoDB grants already cover
  the new prefixes.
* `scripts/wait-for-jobs.sh`: the drain's filter also counts `PJOB#` items `queued` or `running` with a fresh
  heartbeat (its test records the filter and checks both prefixes).
* The agent image copies `web/src/stories/engine/` to `/app/stories-engine/` (`agent/Dockerfile`, its dockerignore)
  and the image tag hash in `deploy.yml` includes that folder, both in the same pull request (builder E), so every
  engine change rebuilds the image.
* The Terraform tests that list exact sets gain the new members and new asserts, written as glob matches against
  sample ARNs: `…:secret:cf-prod/platforms/youtube/token-AbC123` and `…/pending-AbC123` match no story-flow
  resource; `…:secret:cf-prod/workspaces/stories/youtube/token-AbC123` matches no clip-flow, stats or money resource;
  the story flow has no Bedrock action and writes only under `USER#*#WS#*` and `RATE#*`; its execution timeout is
  longer than 7 days.

### 45.16 Web

#### 45.16.1 The workspace switcher

* A pick bar (`<Glide>`, the owner's sliding highlight) with one choice per workspace that `GET /v1/workspaces`
  returns (today **Lamo Clips | Lamo Stories**), shown only when `storiesEnabled()`. In Lamo Clips: on screens from
  768 px as the first child of the sidebar foot, so the bottom-anchored foot grows into empty space and the live dot,
  Get the app and the jobs status stay where they are; when the window is too short for it (the free space is
  measured, about 640 px tall and up), a compact round toggle in a place that moves nothing; folded sidebar: one round
  toggle with its aria-label; on phones a compact control in the top bar between the brand and the live dot, icon
  only below 360 px. It never uses `.sidebar__item` (tests pin the six items), never adds a tab, never overlaps or
  pushes anything (e2e at 320, 390, 1000×600, 1000×650, 1000×720 and 1440×900, sidebar open and folded). In Lamo
  Stories the same switcher sits in its own navigation.
* Lamo Stories lives under `/stories/…`; everything else is Lamo Clips, rendered by today's `Shell` unchanged.
  Switching to Lamo Stories goes to the last Lamo Stories page (else `/stories`); switching back goes to the last
  Lamo Clips page (else `/`), so Lamo Clips comes back exactly as it was left.
* The choice persists on the device (`localStorage` `cf.workspace`: `{ workspaceId, lastStoriesWorkspaceId,
  lastClipsPath, lastStoriesPath }`) and the URL carries it: a reload of a `/stories` page stays in Lamo Stories;
  opening the app at `/` when the last choice was Lamo Stories goes to the last Lamo Stories page. One sign-in: the
  same Cognito session, the same API.

#### 45.16.2 The Lamo Stories shell

`web/src/stories/StoriesApp.tsx`, its own navigation and look ("an animation studio"): Dashboard `/stories`, Ideas
`/stories/ideas`, Characters `/stories/characters` (`/stories/characters/new`, `/stories/characters/{id}`),
Production `/stories/production` (`/stories/production/new`, `/stories/production/{storyId}`), Review
`/stories/review` (`/stories/review/{storyId}`), Library `/stories/library` (`?kind=`, `?story=`), Connections
`/stories/connections`, Settings `/stories/settings`.

* **Workspace check in the web.** Before the first screen, StoriesApp calls `listWorkspaces()` (which also creates
  `stories` on first use). The current workspace is `lastStoriesWorkspaceId` if it is in the list with type
  `stories`, else the first stories workspace. The callback's `?ws=` is used only when it is one of those ids. Screens
  get only that checked id; a `404` "We could not find that workspace." reloads the list once and falls back.
* Lamo Clips' Ask and setup to-do are not shown in Lamo Stories. The Mac app's "send this now" banner (`CrSendNow`,
  §38.6) is also rendered at the top of Lamo Stories' main area, unchanged, because it is the Mac app's only reminder
  for a time-limited Content Rewards send; the Mac download host, the app badge, the update bar, toasts and sounds
  stay global. A **Needs you** bar on every Lamo Stories page shows the first item of the dashboard's `needsYou`.
* Look: its own tokens (`--st-*`, in `web/src/stories/styles/`, outside `web/src/styles` whose tests police Lamo
  Clips' palette; `test/storiesStyles.test.ts` holds the owner's rules there): a deep night-indigo stage (`#1C1842`)
  with soft spotlight glows, warm cream words (`#FFF6E5`), sunshine (`#FFC94A`) for every main action, coral
  (`#FF6F61`), mint (`#47D6A0`) and sky (`#62C6FF`) for status and characters, rounded type (`ui-rounded`, then the
  system font), frosted panels, character-shaped empty states, storyboard filmstrips. Every Lamo Stories selector sits
  under `.stories-app` (or starts `st-`); no `:root`, `html` or `body` rule; StoriesApp restores the page title and
  theme colour when it unmounts. The owner's rules that hold everywhere still hold: arrow cursor only (no `cursor:`
  CSS), hover states, click and deny sounds, `<Glide>` for every pick-one bar, eased progress, celebrations on
  success, no visible borders (shadows and fills instead), AA contrast, no overflow from 320 px, kid-proof words,
  controls bottom right on phones.

#### 45.16.3 Dashboard

Tiles, in this order: **Needs you** (publishing jobs `needs_attention` or `failed` with no later `posted` job for the
same story and platform, accounts `needs_reconnect` or with a `warning`, stories `needs_check`; each with its sentence
and a link), animations made (stories with a final video), waiting for review, published, being made now (with each
job's step), connected accounts (n of 5 with the account names and statuses), performance (views, likes, comments,
shares summed over the publishing jobs' latest numbers; "No numbers yet" when none; "Numbers until 7 days after each
post"), and recent activity (the last 10 `ACT#` items). The shape is `StoriesDashboard` (§45.6).

#### 45.16.4 Live updates

Lamo Stories screens poll (`usePoll`): a running job every 2 s, the dashboard and the Needs you bar every 15 s,
publishing every 10 s while one is in flight. No WebSocket filter changes (§45.3).

#### 45.16.5 Ideas, Characters, Production

* Ideas: a board of idea cards (saved and used), **New idea** (manual), **Ask for ideas** (topic + category →
  drafts with Save), each card **Make it a full idea** (expand), **More like this** (variations), **Make the video**
  (→ Production › New with it), Delete with Undo. Safety ideas show their guidance source or "Needs checked advice".
* Characters: a cast gallery (each rig animated idle), **New character** (a stepper: looks, face, moves, sounds,
  name and personality), the live preview with every face and action button, reference uploads, a portrait button
  when AI pictures are on, Save.
* Production › New: an idea or the short concept form, cast (1–3), length (15–90 s slider, default 45, 30–60 marked),
  captions on/off, music mood, **Make the video**. Production list: every story being made or made, its step track
  (the eight steps) and progress. A story's production page: the storyboard as a filmstrip of scenes with the live
  engine preview of each and the finished stills, the step track, Cancel, Try again.

#### 45.16.6 Review

Its own queue (`status ∈ review, needs_check`), never Lamo Clips' Review: the player (the final MP4, else the live
preview), **Approve** (rule of §45.9; the facts problems and the citations shown), **Reject**, **Ask for changes** (a
note, optionally for chosen scenes), per scene **Remake this scene**, **Remake the whole video**, the captions editor
(on-screen captions and the six post captions), the sound effects editor (every effect of every scene on a timeline:
add, move, remove), **Remake** when anything is stale, **Check again** after fixing facts, **Download** (approved),
after approval **Post it** (the publish sheet: only this workspace's connected accounts, each with its name; nothing
chosen without a tap; the TikTok rules; "Use my settings"), and a **Posts** panel on approved and published stories:
each publishing job's status, account, link, numbers, its sentence and **Try again**.

#### 45.16.7 Library, Connections, Settings

* Library: tabs Projects (§45.12), Videos, Storyboards, Characters, Pictures, Sounds, Scenes, each item with its story
  or character and Download.
* Connections: five cards (YouTube, Instagram, Facebook, TikTok, X), each with status, account name and id, Connect /
  Pick another / Disconnect / Use it for both (with its "Are you sure?" step), the platform's limits (§45.13.5), the
  sign-in and Pages notes before Connect, the result of `?result=`, the account's warning, and Lamo Clips' destination
  name for that platform so the owner sees they differ.
* Settings: default length, captions, music, the writer model, AI pictures (with the provider's state and its
  sentence), YouTube category and privacy.

#### 45.16.8 Mock mode

`web/src/stories/api/mock/` implements every route in memory (`index.ts` joins the parts, `store.ts` holds the shared
seed; a production job walks its steps in about 10 s; the "final video" is the engine's live preview in mock mode), so
every screen runs under `npm run dev:mock` and in Playwright.

### 45.17 Changes to existing files (each one small, each with its proof)

| File | Change | Owner | Proof that Lamo Clips is unchanged |
|---|---|---|---|
| `api/.../routes/__init__.py` | import `workspaces`, append `*workspaces.ROUTES` at the end | Phase 1 | `test_http.py` keeps Lamo Clips' list; the workspace lists live in `tests/ws_routes_*.py` |
| `api/tests/test_http.py` | the final count adds the workspace lists | Phase 1 | – |
| `api/.../oauth/callback.py` | the prefix routing of §45.13.3 (`v1.` unchanged, `w1.` to the workspace path), `WS_RESULTS`, a `landing()` beside `location()` | B | `test_oauth_callback.py` unchanged; every old case replayed with the new code writes the same items, secrets and redirect |
| `api/.../hooks.py` | `_oauth_callback` picks the landing from the state's prefix before its `try` | B | `test_hooks.py` unchanged |
| `api/scripts/build_lambda.py` | the story-flow handler in `HANDLERS` (Phase 1); `config/stories-guidance.json` into the zip (A) | Phase 1, A | its build test |
| `api/tests/test_skills_everywhere.py`, `agent/tests/test_skills_everywhere.py` | unchanged: every Lamo Stories text call goes through the helpers with `skills=`; the agent's allow-list gains only the one Nova Canvas `invoke_model` (like Titan's) | E | the scan's bypass tests |
| `agent/.../server.py`, the app builder | three new actions, `busy` and shutdown include story jobs | E | the old server tests unchanged |
| `agent/Dockerfile`, its dockerignore, `.github/workflows/deploy.yml` (tag hash), `scripts/test-deploy-workflow.sh` | copy the engine folder; the self-check validates the sample with Deno; the hash includes the folder | E | the image builds in CI; the deploy-workflow test |
| `.github/workflows/ci.yml` | one step in the agent job installs ffmpeg for the render tests | E | – |
| `config/models.json` | the top-level `imageModel` | C | the models tests |
| `scripts/wait-for-jobs.sh`, its test | the drain also counts `PJOB#` | C | the old drain cases |
| `web/src/lib/router.ts` | one route name `stories` (page from `web/src/stories/routes.ts`) for `/stories…`, only when `storiesEnabled()` | Phase 1, then F | every old path parses to the same route |
| `web/src/app/App.tsx` | the `stories` route renders `StoriesApp`; its TITLES entry | Phase 1, then F | every old route renders the same `Shell` |
| `web/src/components/Nav.tsx` | the switcher in the sidebar foot and the phone top bar (hidden while off) | F | the nav specs unchanged; the before/after pixel check (§45.19) |
| `web/src/styles/glide.css` | the switcher's container in the Glide list | F | – |
| `web/areas.json` | `web/src/stories` and the other Lamo Stories folders → "Behind the scenes" (Phase 1), renamed "Lamo Stories" by the switch PR | Phase 1 | `update.test.ts` |
| generated files | help corpus, the HELP_ASSISTANT routes table, Ask knowledge | every PR that changes docs, the router, Nav or App | their `--check` steps |
| Terraform | §45.15 | C | `terraform test`; the deploy's Plan and Delete gate lines |

Open pull requests that touch the same files on 2026-11-21 (whoever merges second keeps both sides; generated files
are never merged by hand: take main's and rerun `node web/scripts/help-corpus.mjs --write-docs` then `node
web/scripts/ask-knowledge.mjs`): #98 (CONTRACTS, DECISIONS, routes/__init__.py, test_http.py, the generated files),
#73 and #71 (routes/__init__.py, test_http.py; #71 also areas.json), #100, #101 and later docs PRs (CONTRACTS and the
generated files). Their sessions were told on 2026-11-21.

### 45.18 Deploys

Every Lamo Stories pull request that changes `infra/` is read before merging: `terraform plan` may only add resources,
change IAM policies, Lambda settings and the agent runtime in place, and replace `module.agent.terraform_data.image`
(the image build trigger, whenever the agent image changes). After each deploy the Plan line and the Delete gate line
are read and reported, and `terraform show -json` is checked: every resource whose actions include `delete` must be
`module.agent.terraform_data.image`. No owner data shape changes: no existing item gets a new required attribute,
nothing is renamed, the table, user pool, buckets, vectors and secrets are untouched.

### 45.19 Tests

* **api** (pytest, fakes only): workspace isolation (`test_ws_isolation.py`): another user's workspace id, a
  `clips` id on a **S** route, an item whose `workspaceId` attribute disagrees with its key, and a Lamo Stories item
  in Lamo Clips' lists (`GET /v1/clips`, `/v1/jobs`, `/v1/posts`, `/v1/accounts`, `/v1/setup`, `/v1/me`) all fail
  closed; every new item's `sk` matches none of the stream prefixes; the status table, the stale rules and the approve
  rule of §45.9 (a caption edit on a story re-runs `safety`; approve with `stale` not empty is `409`; a PATCH in
  `needs_check` then produce runs only `safety`, `captions`, `assemble`, `preview`); the heartbeat fence; publishing
  validation (`test_ws_destinations.py`): each rule of §45.14 alone fails a job with `needs_attention` and sends
  nothing (the fake HTTP records zero platform calls); the destination changed after the tap stops; the secret's own
  identity differing stops; same-as-clips without a matching share stops; the credentials name is always the
  workspace's and the flow never reads `cf-prod/platforms/*/token` or `pending` (the fake Secrets Manager's access
  log); the token provider's refresh, rotation, dead token, TikTok watch and lease contention write only under
  `USER#{u}#WS#{ws}` and `cf-prod/workspaces/{ws}/`, with a seeded `ACCOUNT#tiktok` byte-identical after; Disconnect
  makes no revoke call in any state; the callback: `w1.` states write only `SOCIAL#` and workspace secrets, land on
  `/stories/connections` when expired, replayed, failing or missing their workspace, a `v1.` state with a workspace
  item writes nothing, and every old case is byte-identical; a YouTube token with two channels writes nothing; the X
  post cap is shared; `leaked()` over every new route; ideas and the writer carry the skills block.
* **agent**: the story pipeline with a fake Bedrock on `web/src/stories/engine/fixtures/sample-script.json` and the
  real engine CLI (Deno) and ffmpeg, asserting only contract invariants (validate ok, frame lines = `frameCount`,
  every primitive matches §45.10, the MP4's length and frame count); the rasterizer against committed draw-list
  fixtures (`agent/tests/fixtures/stories/prims-*.jsonl`) and golden PNGs within a small tolerance; the audio synth's
  lengths, levels and determinism; `server.py`'s old tests unchanged plus the new actions; the safety step's outcomes
  (ok, rewritten ok, `needs_check`, an owner's text never rewritten) and the no-topic block; fake providers registered
  for animation and audio are the only ones called; the fence (a superseded session writes nothing).
* **web**: vitest for the engine (determinism, validation, every catalog id draws, `normalizeScript`, `fitDuration`
  bounds, the import scan), the switcher store (persistence, last paths), the web workspace check, the styles test;
  Playwright (mock): switching both ways and after reload, every Lamo Stories screen (no overflow 320–1920, arrow
  cursor, AA contrast, no edges, targets ≥ 44 px, 48 on phones), the switcher's placement at every size of §45.16.1,
  and the whole flow idea → character → production → review → approve → publish sheet (`e2e/stories-flow.spec.ts`,
  in the final check).
* **Lamo Clips unchanged, pixel for pixel**: `web/scripts/clips-unchanged.sh` builds the mock of the merge base and
  of the branch on one machine and screenshots `/`, `/jobs`, `/review`, `/library`, `/money`, `/settings` at 390×844,
  1000×600, 1000×720 and 1440×900 (sidebar open and folded) with a fixed clock, fixed mock data and no motion; with
  `STORIES_ON` false every pixel must match; with it on, every pixel outside the switcher's box. Run by the lead on the
  switch PR and in the final check (Mac and CI fonts differ, so both shots come from the same machine).
* **infra**: `terraform test` with the asserts of §45.15.

### 45.20 The owner's request, point by point

| Spec | Met by |
|---|---|
| §1 two workspaces, same app and login | §45.2, §45.16 (one Cognito session, one API) |
| §2 protect existing functionality | §45.1, §45.13.6, §45.17, §45.18, the pixel check in §45.19 |
| §3 switching, persistence, independence | §45.16.1, §45.3 partitions, §45.13 connections, §45.6 `StoriesConfig` |
| §4 content concept, no voice-over, verified safety | §45.10 vocabulary (no speech, symbol bubbles), §45.11.3 noises and music, §45.11.5 |
| §5.A Dashboard | §45.16.3 (every tile, plus Needs you) |
| §5.B Ideas | §45.7, §45.16.5 |
| §5.C Characters (every field) | §45.6 `CharacterInput`, §45.8, §45.16.5 |
| §5.D Production (the ten steps, 9:16, 30–60 s configurable, providers) | §45.9, §45.11, §45.11.6 |
| §5.E Review (every action) | §45.16.6, §45.9 remakes |
| §5.F Library (projects, videos, storyboards, references, images, audio, scenes, metadata) | §45.12, §45.16.7 |
| §6 separate social accounts, the eight connection requirements, each platform, publishing isolation | §45.13, §45.14, IAM in §45.15 |
| §7 data architecture, ownership on both ends, tokens never in the browser | §45.3 (keys), §45.5 (guards), §45.16.2 (the web check), §45.13.1 |
| §8 own design language | §45.16.2 |
| §9 more brands later | §45.2 registry, ULID workspaces, `POST /v1/workspaces`, the switcher lists every workspace |
| §10 acceptance criteria | §45.19 and §45.23 |
| §11 phases | §45.21 |

The spec's conceptual fields map as: Workspace → `workspaceId`, `userId`, `workspaceName`, `workspaceType`,
`configuration`; SocialAccount → `socialAccountId`, `workspaceId`, `platform`, `externalAccountId`, `accountName`,
the encrypted credentials in Secrets Manager (never on the item), `connectionStatus`; Content → `Story`
(`storyId` = content id, `workspaceId`, `contentType`, `title`, `status`, `storageLocation`); ProductionJob →
`jobId`, `workspaceId`, `contentId`, `jobType`, `status`, `configuration`; PublishingJob → `publishingJobId`,
`workspaceId`, `contentId`, `socialAccountId`, `platform`, `publishingStatus`.

### 45.21 Who builds what, and in which order

Phase 1 (this section, ADR-70 to ADR-75, and the scaffold: `workspaces/types.py`, `guard.py`, `deps.py`, empty route
modules, the story-flow stub, the web types and client interface, the split mock folder with rejecting stubs, the
engine's types, catalog, stub engine and command line, the preview components, a thin `StoriesApp` behind
`storiesEnabled()` with the router and App branch, placeholder screens, the flag, the checked guidance list and the
`areas.json` lines) merges first. Then seven builders work at the same time, each only in its own files:

| Builder | Branch | Owns |
|---|---|---|
| A api core | `feat/stories-api-core` | `api/.../workspaces/` (all but the social, destinations, tokens, sentences, secrets and publish modules), `workspaces/agent.py`, `routes/workspaces/core.py`, `tests/ws_routes_core.py`, `tests/ws_support.py`, `tests/test_ws_*.py` for its routes, the guidance copy in `build_lambda.py` |
| B social and publishing | `feat/stories-social` | `workspaces/social.py`, `social_callback.py`, `destinations.py`, `tokens.py`, `sentences.py`, `secrets.py`, `publish.py`, `flow.py`, `routes/workspaces/social.py`, `flows/story_flow.py`, the `oauth/callback.py` and `hooks.py` changes, `tests/ws_routes_social.py`, their tests |
| C infra | `infra/stories` | §45.15 Terraform and its tests, `config/models.json` `imageModel`, `scripts/wait-for-jobs.sh` and its test |
| D engine | `feat/stories-engine` | `web/src/stories/engine/` (not `types.ts`), `web/src/stories/preview/`, `web/test/storiesEngine*.test.ts` |
| E agent | `feat/stories-agent` | `agent/src/clipfactory_agent/stories/`, the `server.py` hook, `Dockerfile` and dockerignore, the `deploy.yml` hash and its test, the ci.yml ffmpeg step, `agent/tests/test_stories_*.py` and fixtures, the agent scan allow-list line |
| F web shell | `feat/stories-web-shell` | switcher, router, App, Nav, `glide.css`, `StoriesApp`, `workspace.ts`, Dashboard, Library, Connections, Settings, `api/http.ts`, the mock's `index.ts`, `store.ts`, `workspace.ts`, `dashboard.ts`, `library.ts`, `social.ts`, `publishing.ts`, `ui.tsx`, `styles/stories.css`, `e2e/stories-shell.spec.ts`, `scripts/clips-unchanged.sh`, its tests |
| G web studio | `feat/stories-web-studio` | Ideas, Characters, Production, Review screens, `web/src/stories/studio/`, `styles/studio.css`, the mock's `ideas.ts`, `characters.ts`, `stories.ts`, `e2e/stories-studio.spec.ts`, its tests |

`web/src/stories/api/types.ts`, `web/src/stories/engine/types.ts` and `api/.../workspaces/types.py` change only
through this section (a builder asks the lead). D ships before E's final rebase and before G's e2e; F before G's e2e.
Then one check of everything together against §45.20 and §45.23, and the switch PR (`STORIES_ON = true`, the
`areas.json` labels).

### 45.22 What only the owner can do (none of it blocks building)

* TikTok: add the Lamo Stories TikTok account as a Sandbox target user (TikTok developer portal › Sandbox › Target
  users) and make it private (TikTok app › Profile › Settings and privacy › Privacy › Private account) until TikTok
  approves the app; until then TikTok posts are "Only me".
* Have the separate accounts ready: a Lamo Stories YouTube channel (a Brand Account under the same Google login is
  fine), a Facebook Page, an Instagram professional account linked to it, an X account. Lamo Stories never creates
  them. When Facebook asks which Pages, keep Lamo Clips' Page ticked too.
* To use AI portraits: pick Nova Canvas in Lamo Stories › Settings and make one portrait; if Bedrock says the model is
  not enabled, enable Amazon Nova Canvas in the Bedrock console, Region Europe (Ireland).

### 45.23 Acceptance evidence, and what is only verified live

| # | Criterion | In CI | Live, after the switch PR |
|---|---|---|---|
| 1 | Clip Factory opens and works as before | every old test; the pixel check | sign in on the live app and open `/`, `/jobs`, `/review`, `/library`, `/money`, `/settings` |
| 2 | Existing jobs and uploaded videos stay reachable | the isolation tests | `GET /v1/jobs`, `/v1/clips`, `/v1/posts` saved before the first Lamo Stories deploy and after (ids and statuses only) are equal; one old job opens and one clip plays |
| 3 | Clipping is unaffected | the agent's old tests; the image build | one real clip job on the new agent image |
| 4 | Publishing destinations unchanged | the callback and Disconnect tests | `GET /v1/accounts` (platform, account id, name, status) before and after, and after each Meta connect |
| 5 | Workspace switching works | the switcher e2e | switch both ways, reload, open the Mac app |
| 6 | Its own interface | the shell e2e | the screens |
| 7 | Its own production workflow | the pipeline tests | one real story made end to end on the live agent |
| 8 | Assets isolated | the isolation and key tests | the Lamo Clips Library unchanged after a story is made |
| 9 | Accounts connect independently | the callback tests | each platform the owner connects (his taps) |
| 10 | The right YouTube channel | the one-channel rule and its tests | the owner connects the Lamo Stories channel and sees its name and id |
| 11 | No cross-workspace credentials | the destination, token and IAM tests | – |
| 12 | Credentials stored securely | `leaked()`, the secrets tests, IAM | – |
| 13 | Isolation enforced on the backend | the isolation tests | – |
| 14 | Regression tests pass | every required check green on every PR | – |

Not verified live until the owner connects: each platform's real consent screens with a second account, Google's
channel picker with his Brand Accounts, Meta's Page picker keeping both Pages, TikTok's Sandbox target-user rule for
a second account, Nova Canvas in eu-west-1 for his account.
