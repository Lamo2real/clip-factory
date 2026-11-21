## 45. Lamo Stories: a second, separate workspace (owner request, 2026-11-21)

**Planned: not in the app until the switch pull request turns it on (§45.21).** Until then nothing of Lamo Stories
shows in Clip Factory, and Ask should say it is being built.

The owner asked for **Lamo Stories**, a second content studio inside Clip Factory that makes short animated story
videos (no voice-over: characters, faces, body language, sound effects, music, optional captions) and posts them to
**different** social accounts. One app, one sign-in, one owner; two workspaces with their own screens, libraries,
production jobs, settings and social connections. The existing app is the **Lamo Clips** workspace and must stay
exactly as it is. The same evening the owner added a second request: Lamo Stories is **its own application** inside
the Clip Factory shell, with its own AgentCore runtime, agents, skills, models and reasoning effort he controls, a
creative chat with memory, reference-video analysis, its own setup and onboarding, and its own OAuth credentials
(§45.24–§45.32; where they differ from the subsections before them, they win). "Clip Factory" in the second request
and "Lamo Clips" in the first are the same thing: today's app. Sections 42 to 44 are left for pull requests that were
open on 2026-11-21. Decisions: ADR-70 to ADR-80. §45.20 and §45.32 map each point of the two requests to where it is
met; §45.23 and §45.32 list the evidence for each acceptance criterion.

### 45.1 The rule above every other rule: Lamo Clips does not change

* No existing table, index, item, attribute, S3 prefix, secret, Lambda, route, prompt, screen, style or test is
  renamed, moved, replaced or re-shaped. Lamo Clips' data is never migrated: it **is** the built-in workspace.
* Everything new is **additive** and lives in Lamo Stories' own pieces (§45.24): new partitions (§45.3), a new S3
  prefix (§45.4), a new Secrets Manager prefix (§45.13), its own API Lambda behind new routes under `/v1/workspaces`
  (§45.5), its own AgentCore runtime and image (§45.11), one new durable Lambda (§45.15), new IAM roles, new web
  routes under `/stories` (§45.16). Clip Factory's `cf-prod-api`, its route table, its agent runtime and image, and
  their roles do not change. Lamo Stories never revokes, rewrites or deletes a Lamo
  Clips token, key, account or setup item, on any path (§45.13.6).
* Existing code is touched only where a new thing must be plugged in; §45.17 lists every such touch with the test that
  proves the old path is unchanged. Nothing new is shown in the Lamo Clips screens except the workspace switcher
  (§45.16.1), which sits in space that is empty today and moves no existing control.
* Every deploy: the Delete gate line reads exactly "Delete gate: the plan deletes or replaces nothing that holds the
  owner's data." and the only resources the plan may replace are the image build triggers
  `module.agent.terraform_data.image` (only if Clip Factory's agent image changes, which Lamo Stories never causes) and
  `module.stories_agent.terraform_data.image` (whenever Lamo Stories' agent image changes); they hold no data (it was
  so before Lamo Stories, for example in PR #84). Everything else is add or update in place (§45.18).
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
| agent | One of Lamo Stories' five AI roles (creative director, video analysis, storyboard, character, quality assurance), each with its own instructions, model, effort and skills (§45.26). |
| task | One kind of AI work (chat, brainstorm, storyboard, …) that an agent does; models and effort can be set per task (§45.25). |
| skill | A Lamo Stories `SKILL.md` assigned to agents (§45.26); Clip Factory's skills are separate and never used. |
| reference video | A video the owner uploads so the video analysis agent can study its structure and timing (§45.28). |

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
| Agent | same | `AGENT#{agentId}` | `type="ws_agent"`, Agent fields (§45.26), `version` |
| Skill | same | `SKILL#{skillId}` | `type="ws_skill"`, Skill fields (§45.26), internal `key`, `revisions` |
| AI task | same | `TASK#{taskId}` | `type="ws_task"`, AiTask fields (§45.6: ideas, expand, variations, character design, captions, check models), internal `sessionId`, `heartbeatAt`, `override`, `ttl` 30 days |
| Conversation | same | `CONV#{convId}` | `type="ws_conv"`, Conversation fields (§45.27), internal `summary`, `summaryUpToMsgId` |
| Message | same | `MSG#{convId}#{msgId}` | `type="ws_msg"`, Message fields (§45.27); assistant messages also internal `sessionId`, `heartbeatAt`, `requested` |
| Memory | same | `MEM#{memId}` | `type="ws_mem"`, MemoryItem fields (§45.27) |
| Reference video | same | `REFVID#{refId}` | `type="ws_refvid"`, ReferenceVideo fields (§45.28), internal `key`, `analysisKey` |
| Model status | same | `MODELSTATUS#{modelKey}` | `type="ws_modelstatus"`, `status`, `line`, `checkedAt` (§45.25; written only by the agent) |
| Usage | same | `USAGE#{day}#{id}` | `type="ws_usage"`, `kind: "model" \| "provider"`, §45.25's usage fields (providers: `providerId`, `modelId`, `images` / `videoSec` / `renderSec`), `ttl` 400 days |
| Onboarding | same | `ONBOARD` | `type="ws_onboard"`, `stepsDone`, `skipped`, `finishedAt` (§45.29) |
| AI configuration | same | `AICONFIG` | `type="ws_aiconfig"`, `defaultModel`, `defaultEffort`, `tasks`, `prices`, `version`, `updatedAt` (§45.25; made on the first PUT with a conditional put; updates conditional on `version`) |
| Provider key | same | `PROVCRED#{providerId}` | `type="ws_provcred"`, `savedAt`, `hint` (the key itself only in Secrets Manager, §45.31) |
| Own rate counters | `RATE#WS#{workspaceId}#{platform}` | `BUDGET` | only with Lamo Stories' own developer app (§45.30) |
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
| `ws/{userId}/{workspaceId}/stories/{storyId}/final/v{n}.mp4`, `cover-v{n}.jpg` | the finished 1080×1920 video and its cover | kept (old versions per the retention setting, §45.29) |
| `ws/{userId}/{workspaceId}/references/{refId}/source.{mp4\|mov}`, `analysis.json`, `frames/` | reference videos and their analysis (§45.28) | kept until deleted |
| `ws/{userId}/{workspaceId}/skills/{skillId}/{revisionId}/` | Lamo Stories skills (§45.26) | the last 10 revisions kept |
| `ws/{userId}/{workspaceId}/chat/{convId}/{fileId}.{ext}` | pictures attached in the chat | kept with the conversation |

No Lamo Clips prefix (`uploads/`, `jobs/`, `skills/`, `private/`, `ask/`, `campaigns/`) is read or written by Lamo
Stories code, and no Lamo Clips code reads `ws/`. The media bucket's lifecycle rules name Lamo Clips prefixes only, so
`ws/` files are kept. The Library lists only `ASSET#` items of its workspace (§45.12), never S3 listings. Presigned
GETs last 1 hour; a download adds `ResponseContentDisposition: attachment; filename="{slug}.mp4"`.

### 45.5 HTTP API (`cf-prod-stories-api`, JWT on every route, §5 errors)

All under `/v1/workspaces`, served by Lamo Stories' own Lambda `cf-prod-stories-api` (§45.24; API Gateway routes
`ANY /v1/workspaces` and `ANY /v1/workspaces/{proxy+}` to it; every other path still goes to `cf-prod-api`, unchanged).
`{ws}` is a workspace id (`^(clips|stories|[0-9A-HJKMNP-TV-Z]{26})$`, else 404). Routes
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
| POST `/v1/workspaces/{ws}/ideas/generate` **S** | `{ "topic"?: string (≤ 200), "category"?: IdeaCategory, "count"?: 1–6 (default 4), "override"?: ModelOverride }` | `202 { "task": AiTask }`; the finished task's `result.drafts` (nothing saved; the owner taps Save) |
| POST `/v1/workspaces/{ws}/ideas/{ideaId}/expand` **S** | `{ "durationSec"?: 15–90, "override"?: ModelOverride }` | `202 { "task" }`; the finished task writes `concept` on the idea and returns it in `result.idea` |
| POST `/v1/workspaces/{ws}/ideas/{ideaId}/variations` **S** | `{ "count"?: 1–4 (default 3), "override"?: ModelOverride }` | `202 { "task" }`; `result.drafts` |
| GET `/v1/workspaces/{ws}/tasks/{taskId}` **S** | – | `{ "task": AiTask }` (poll every second while `queued` or `running`) |
| GET `/v1/workspaces/{ws}/characters` **S** | – | `{ "characters": Character[] }` by name |
| POST `/v1/workspaces/{ws}/characters` **S** | `CharacterInput` | `201 { "character" }`; `409` on a duplicate name |
| GET `/v1/workspaces/{ws}/characters/{characterId}` **S** | – | `{ "character" }` (reference URLs presigned) |
| PUT `/v1/workspaces/{ws}/characters/{characterId}` **S** | `CharacterInput & { "version" }` | `{ "character" }`; `409` stale |
| DELETE `/v1/workspaces/{ws}/characters/{characterId}` **S** | – | `204`; `409` "{name} is in a story that is being made. Wait until it is done." while a running job's cast holds it |
| POST `/v1/workspaces/{ws}/characters/{characterId}/references` **S** | `{ "filename", "contentType": "image/png" \| "image/jpeg" \| "image/webp", "size" ≤ 10 MB }` | `{ "assetId", "uploadUrl", "headers" }` |
| POST `/v1/workspaces/{ws}/characters/{characterId}/references/{assetId}/complete` **S** | – | `{ "character" }` (HEAD checks size and type; at most 8 references) |
| DELETE `/v1/workspaces/{ws}/characters/{characterId}/references/{assetId}` **S** | – | `{ "character" }` |
| POST `/v1/workspaces/{ws}/characters/design/uploads` **S** | `{ "filename", "contentType": "image/png" \| "image/jpeg" \| "image/webp", "size" ≤ 10 MB }` | `{ "assetId", "uploadUrl", "headers" }` (`ws/{u}/{ws}/design/{assetId}.{ext}`, an `ASSET#` of kind `design_ref`) |
| POST `/v1/workspaces/{ws}/characters/design` **S** | `{ "description"?: string (≤ 600), "referenceAssetId"?: string (a `design_ref` or `character_ref` asset of this workspace, else 404), "override"?: ModelOverride }` | `202 { "task" }`: the character agent's suggested `CharacterInput` in `result.character` (a draft; nothing saved) |
| POST `/v1/workspaces/{ws}/characters/{characterId}/portrait` **S** | – | `202 { "job" }` (a portrait job, §45.11.6); `409` "AI pictures are off. Turn them on in Lamo Stories › Settings." while `providers.images` is `builtin-rig` |
| GET `/v1/workspaces/{ws}/stories` **S** | query `status?` (a StoryStatus or `all`), `limit` ≤ 50, `cursor` | `{ "stories": Story[], "nextCursor" }` newest first |
| POST `/v1/workspaces/{ws}/stories` **S** | `StoryInput` (may carry `override`: ModelOverride for this video's jobs, and `referenceIds`) | `201 { "story", "job" }` (starts production) |
| GET `/v1/workspaces/{ws}/stories/{storyId}` **S** | – | `{ "story", "job": ProductionJob \| null, "script": StoryScript \| null }` (URLs presigned) |
| GET `/v1/workspaces/{ws}/stories/{storyId}/jobs` **S** | – | `{ "jobs": ProductionJob[] }` newest first (production metadata, §45.12) |
| PATCH `/v1/workspaces/{ws}/stories/{storyId}` **S** | `StoryPatch` (§45.6; only in `review`, `needs_check` or `failed`, never while a job runs) | `{ "story", "script" }`; a script edit writes `v{n+1}` and adds the steps it makes out of date to `stale` (§45.9) |
| DELETE `/v1/workspaces/{ws}/stories/{storyId}` **S** | – | `204` (stops a running job first; its assets and S3 files under the story's prefix are deleted; publishing jobs and posts already on platforms stay) |
| POST `/v1/workspaces/{ws}/stories/{storyId}/produce` **S** | `{ "from"?: StepKey, "sceneIds"?: string[] (with `from` ∈ `scenes`, `animation`), "override"?: ModelOverride (this job only) }` | `202 { "story", "job" }`; no `from`: runs exactly the `stale` steps ("Try again", "Check again", "Remake"); `409` while a job runs |
| POST `/v1/workspaces/{ws}/stories/{storyId}/cancel` **S** | – | `{ "story", "job" }` |
| POST `/v1/workspaces/{ws}/stories/{storyId}/approve` **S** | `{ "version" }` | `{ "story" }`; `409` unless §45.9's approve rule holds |
| POST `/v1/workspaces/{ws}/stories/{storyId}/reject` **S** | `{ "reason"?: string (≤ 500) }` | `{ "story" }` |
| POST `/v1/workspaces/{ws}/stories/{storyId}/changes` **S** | `{ "note"?: string (0–500), "sceneIds"?: string[], "override"?: ModelOverride }` (a note or scene ids at least) | `202 { "story", "job" }`: the writer rewrites the named scenes (a new take when there is no note: "Remake this scene") or the whole story with the note, then everything that changed is remade |
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
| PUT `/v1/workspaces/{ws}/social/{platform}/app` **S** | `{ "choice": "own", "clientId", "clientSecret", "configId"? }` or `{ "choice": "clips" }` | `{ "account" }` (§45.30; keys masked like §17.4; a change of app disconnects the account first) |
| POST `/v1/workspaces/{ws}/social/{platform}/app/check` **S** | – | `{ "check": KeyCheck }` (Lamo Stories' own app keys, §17.4's checks) |
| DELETE `/v1/workspaces/{ws}/social/{platform}/app` **S** | – | `204` (only Lamo Stories' own app keys; disconnects first) |
| GET `/v1/workspaces/{ws}/ai` **S** | – | `{ "ai": StoriesAiConfig, "models": ModelInfo[], "agents": Agent[], "tasks": TaskInfo[] }` |
| PUT `/v1/workspaces/{ws}/ai` **S** | `StoriesAiConfig & { "version" }` | `{ "ai" }` (unknown model keys, efforts a model does not offer, unknown tasks → 400 with the sentence) |
| POST `/v1/workspaces/{ws}/ai/check-models` **S** | `{ "models"?: string[] }` | `202 { "task" }` (one tiny real call per model, §45.25) |
| PUT `/v1/workspaces/{ws}/ai/prices/{modelKey}` **S** | `{ "inputPer1M", "outputPer1M", "currency" }` or `{}` to clear | `{ "model": ModelInfo }` |
| GET `/v1/workspaces/{ws}/usage` **S** | query `days` ≤ 30 | `{ "usage": UsageSummary }` |
| GET `/v1/workspaces/{ws}/agents/{agentId}` **S** | – | `{ "agent" }` |
| PATCH `/v1/workspaces/{ws}/agents/{agentId}` **S** | `{ "version", "instructions"?, "active"?, "model"?: string \| null, "effort"?: Effort \| null, "skillIds"? }` or `{ "reset": true }` | `{ "agent" }` |
| GET `/v1/workspaces/{ws}/skills` **S** | – | `{ "skills": Skill[] }` (built-ins first) |
| POST `/v1/workspaces/{ws}/skills/uploads` **S** | `{ "filename", "skillId"? }` (`.md` ≤ 1 MB, `.zip` ≤ 20 MB) | `{ "skillId", "key", "uploadUrl", "headers" }` |
| POST `/v1/workspaces/{ws}/skills` **S** | `{ "skillId", "key" }` or `{ "title", "description", "instructions" }` | `201 { "skill" }` |
| GET / PUT / DELETE `/v1/workspaces/{ws}/skills/{skillId}` **S** | PUT: `{ "version", "title"?, "description"?, "instructions"?, "key"?, "enabled"? }` | `{ "skill" }` / `{ "skill" }` / `204` (built-ins: `409` on delete and edit; enable and disable allowed) |
| POST `/v1/workspaces/{ws}/skills/{skillId}/restore` **S** | `{ "revisionId" }` | `{ "skill" }` |
| GET `/v1/workspaces/{ws}/chat` **S** | – | `{ "conversations": Conversation[] }` newest first |
| POST `/v1/workspaces/{ws}/chat` **S** | `{ "title"?, "projectRef"?: ProjectRef, "model"?: string \| null, "effort"?: Effort \| null }` | `201 { "conversation" }` |
| GET / PATCH / DELETE `/v1/workspaces/{ws}/chat/{convId}` **S** | PATCH: `{ "title"?, "model"?, "effort"?, "projectRef"? }` | `{ "conversation", "messages": Message[] }` (GET, query `after` = a message id) / `{ "conversation" }` / `204` |
| POST `/v1/workspaces/{ws}/chat/{convId}/messages` **S** | `{ "text" (1–8000), "attachments"?: { "assetId" }[] (≤ 4), "override"?: ModelOverride }` | `202 { "user": Message, "assistant": Message }` (the assistant message `pending`) |
| POST `/v1/workspaces/{ws}/chat/{convId}/attachments` **S** | `{ "filename", "contentType": "image/png" \| "image/jpeg" \| "image/webp", "size" ≤ 5 MB }` | `{ "assetId", "uploadUrl", "headers" }` |
| POST `/v1/workspaces/{ws}/chat/{convId}/messages/{msgId}/stop` **S** | – | `{ "message" }` |
| GET / POST `/v1/workspaces/{ws}/memory` **S** | POST: `{ "text" (1–300) }` | `{ "memory": MemoryItem[] }` / `201 { "item" }` |
| PATCH / DELETE `/v1/workspaces/{ws}/memory/{memId}` **S** | PATCH: `{ "text" }` | `{ "item" }` / `204` |
| GET `/v1/workspaces/{ws}/references` **S** | – | `{ "references": ReferenceVideo[] }` |
| POST `/v1/workspaces/{ws}/references` **S** | `{ "filename", "contentType": "video/mp4" \| "video/quicktime", "size" ≤ 2 GB, "title" }` | `201 { "reference", "upload": { "uploadId", "parts": { "partNumber", "url" }[] } }` (multipart, 100 MB parts) |
| POST `/v1/workspaces/{ws}/references/{refId}/complete` **S** | `{ "parts": { "partNumber", "etag" }[] }` | `{ "reference" }` (ffprobe-checked by the agent on analyze; ≤ 10 minutes) |
| POST `/v1/workspaces/{ws}/references/{refId}/analyze` **S** | `{ "override"?: ModelOverride }` | `202 { "reference", "job" }` |
| GET / PATCH / DELETE `/v1/workspaces/{ws}/references/{refId}` **S** | PATCH: `{ "title" }` | `{ "reference", "analysis": ReferenceAnalysis \| null }` / `{ "reference" }` / `204` |
| GET / PATCH `/v1/workspaces/{ws}/onboarding` **S** | PATCH: `{ "step": OnboardStep, "done"?: boolean, "skipped"?: boolean }` or `{ "finish": true }` | `{ "onboarding": Onboarding }` |
| PUT / DELETE `/v1/workspaces/{ws}/providers/{providerId}/key` **S** | PUT: `{ "key" }` (≤ 4 KB) | `{ "provider": ProviderStatus }` (never returns the key) / `204` |
| GET `/v1/workspaces/{ws}/storage` **S** | – | `{ "storage": StorageSummary }` |
| POST `/v1/workspaces/{ws}/stories/{storyId}/publish` **S** | `{ "targets": PublishTarget[] (1–5, each platform once) }` | `202 { "publishingJobs": PublishingJob[] }` (§45.14) |
| GET `/v1/workspaces/{ws}/publishing` **S** | query `storyId?` | `{ "publishingJobs": PublishingJob[] }` newest first |
| POST `/v1/workspaces/{ws}/publishing/{publishingJobId}/retry` **S** | `{ "options"?: PublishOptions, "confirmAccount"?: string /* the new externalAccountId the owner saw */ }` | `202 { "publishingJob" }` (only `failed` or `needs_attention`; `409` naming the new account when the destination changed and `confirmAccount` does not match it) |

`/v1/accounts*`, `/v1/setup*`, `/v1/clips*`, `/v1/jobs*` and every other existing route are unchanged, served by
`cf-prod-api` as before, and never see Lamo Stories data. Lamo Stories' route modules live **outside** Clip Factory's `routes` package:
`workspaces/routes/core.py` (workspaces, dashboard, ideas, characters, stories, library, providers, guidance, tasks),
`workspaces/routes/ai.py` (AI configuration, agents, skills, chat, memory, references, onboarding, usage, provider
keys, storage) and `workspaces/routes/social.py` (social, developer apps, creator info, the Lamo Stories OAuth
callback, publish, publishing), assembled in `workspaces/routes/__init__.py`; `workspaces/http.py` is the Lambda
handler that dispatches only these (the shared `http.dispatch` and JWT claims code, imported read-only); a test
imports it in a fresh interpreter and checks `clipfactory_api.routes` is not loaded; `routes/__init__.py` (Clip
Factory's table) does not include them.

Dependencies reach the routes through `workspaces/deps.py` (`deps.of(app)`: built once per `App` from the
environment on first use: `STORIES_AGENT_RUNTIME_ARN` (Lamo Stories' own runtime), `STORY_FLOW_ARN`,
`WS_SECRET_PREFIX`, the media bucket; tests install fakes with `deps.install(app, …)`); `app.py` does not change.
Story-only AWS calls live in new files: `workspaces/agent.py` (invokes **Lamo Stories' runtime** only:
`start_story`, `start_portrait`, `start_task`, `start_chat_turn`, `start_reference`, `cancel`, `stop_session`;
sessions `"cfstory-" + id + "-" + 8 random chars`, at least 33 characters; two attempts on a retryable error, 20 s
read timeout) and `workspaces/flow.py` (the story flow start). `agent_client.py` and `flow_client.py` stay
byte-identical; neither Lamo Stories file ever invokes `cf_prod_clip_agent`.

### 45.6 Shapes (TypeScript notation; `web/src/stories/api/types.ts` and `web/src/stories/engine/types.ts` are the copies the web compiles, changed only through this section)

```ts
type WorkspaceType = "clips" | "stories";
interface Workspace { workspaceId: string; workspaceName: string; workspaceType: WorkspaceType; builtin: boolean;
  configuration: StoriesConfig | Record<string, never> /* clips: {} (its settings stay in Settings) */;
  version: number; createdAt?: string; updatedAt?: string }
interface StoriesConfig { defaultDurationSec: number /* 15..90, default 45; 30..60 suggested */;
  captionsOn: boolean /* default true */; musicOn: boolean /* default true */;
  providers: { images: "builtin-rig" | "nova-canvas"; video: "builtin-2d" | "nova-reel"; audio: "builtin-synth" };
  video: { resolution: "1080x1920"; aspect: "9:16"; quality: "standard" | "high" | "best" /* default high: ffmpeg
    CRF 23 / 20 / 17 */; fps: 30 /* the built-in animator's only rate */ };
  production: { burnCaptions: boolean /* default true */; scenesAtOnce: 1 | 2 | 3 /* default 2 */;
    keepVersions: "all" | number /* 1..10, default "all" */ };
  youtubeCategory: "1" | "2" | "23" | "24" | "27" /* Film & Animation, Autos & Vehicles, Comedy, Entertainment,
     Education; default "27"; Lamo Clips' own category list and default are not used */;
  youtubePrivacy: "public" | "unlisted" | "private" /* default "public" */;
  xMonthlyLimitUsd: number | null /* only with Lamo Stories' own X app (§45.30) */ }
// The AI configuration lives beside it (GET/PUT …/ai), not in StoriesConfig:
type Effort = "low" | "medium" | "high" | "xhigh" | "max";
type TaskKind = "chat" | "brainstorm" | "expand_idea" | "variations" | "storyboard" | "scene_rewrite"
  | "character_design" | "reference_analysis" | "fact_check" | "final_review" | "captions";
interface StoriesAiConfig { defaultModel: string /* a key of stories/config/models.json, default "opus-5-5" */;
  defaultEffort: Effort /* default "high" */; tasks: Partial<Record<TaskKind, { model?: string; effort?: Effort }>>;
  prices: Record<string, Price> /* the owner's, by model key or provider id */; version: number }
interface Price { inputPer1M: number; outputPer1M: number; cacheReadPer1M: number | null;
  cacheWritePer1M: number | null; longContext: { aboveInputTokens: number; inputPer1M: number; outputPer1M: number }
  | null; currency: string; source: "anthropic_list" | "aws_price_list" | "owner"; note: string }
interface ModelOverride { model?: string; effort?: Effort }   // just for this request; never saved
interface ModelInfo { key: string; label: string; provider: string; modelId: string; efforts: Effort[];
  defaultEffort: Effort | null; vision: boolean; status: "ok" | "not_checked" | "denied" | "not_found" | "error";
  statusLine: string; checkedAt: string | null; price: Price | null }
interface Effective { model: string; effort: Effort | null; effortApplied: boolean;
  from: "request" | "conversation" | "project" | "task" | "agent" | "default" }
interface TaskInfo { kind: TaskKind; label: string; agentId: string; suggestedEffort: Effort; effective: Effective }
interface Agent { agentId: "creative_director" | "video_analysis" | "storyboard" | "character" | "quality_assurance";
  name: string; tasks: TaskKind[]; instructions: string; defaultInstructions: string; active: boolean;
  model: string | null; effort: Effort | null; skillIds: string[]; version: number; updatedAt: string }
interface Skill { skillId: string; title: string; description: string; builtin: boolean; source: "builtin" | "written"
  | "upload"; format: "md" | "zip"; enabled: boolean; agentIds: string[]; revisions: { revisionId: string;
  savedAt: string; size: number }[]; version: number; createdAt: string; updatedAt: string }
interface AiTask { taskId: string; kind: TaskKind | "check_models"; status: "queued" | "running" | "done" | "failed";
  model: string | null; effort: Effort | null; effortApplied: boolean | null; result: Record<string, unknown> | null;
  error?: string; createdAt: string; updatedAt: string }
type ProjectRef = { kind: "idea" | "story" | "character" | "reference"; id: string };
interface Conversation { convId: string; title: string; model: string | null; effort: Effort | null;
  effective: Effective /* what the next message will use, computed by the API */; projectRef: ProjectRef | null;
  lastMessageAt: string | null; createdAt: string; updatedAt: string }
interface Message { msgId: string; convId: string; role: "user" | "assistant"; text: string;
  attachments: { assetId: string; url: string; contentType: string }[];
  status: "pending" | "streaming" | "done" | "failed" | "stopped"; model: string | null; effort: Effort | null;
  effortApplied: boolean | null; usage: { input: number; output: number } | null;
  actions: { kind: "make_video" | "remake_scene" | "analyze_reference" | "save_character" | "save_idea" | "open";
    label: string; payload: Record<string, unknown> }[]; error?: string; createdAt: string }
interface MemoryItem { memId: string; text: string; source: "chat" | "owner"; createdAt: string; updatedAt: string }
interface ReferenceVideo { refId: string; title: string; status: "uploading" | "ready" | "analyzing" | "analyzed"
  | "failed"; durationSec: number | null; bytes: number; url?: string; currentJobId: string | null;
  ai: { model: string | null; effort: Effort | null } /* this reference's own setting, §45.25 level 2 */;
  analyzedWith: { model: string; effort: Effort | null } | null; createdAt: string; updatedAt: string }
interface ReferenceAnalysis { summary: string; hook: { atSec: number; what: string }; pacing: { cutsPer10s: number;
  notes: string }; shots: { start: number; end: number; what: string; acting: string; sound: string }[];
  gags: string[]; sound: string; captions: string; borrow: string[]; avoid: string[] }
type OnboardStep = "ai" | "model" | "effort" | "video" | "agents" | "instagram" | "tiktok" | "youtube" | "facebook"
  | "x" | "done";
interface Onboarding { steps: { step: OnboardStep; label: string; state: "done" | "skipped" | "todo" }[];
  done: number; total: 11; finishedAt: string | null }
interface UsageSummary { days: { day: string; byModel: { model: string; input: number; output: number;
  cost: number | null; currency: string | null }[] }[]; totals: { model: string; input: number; output: number;
  cost: number | null; currency: string | null }[]; renderMinutes: number }
interface StorageSummary { bytes: { videos: number; scenes: number; audio: number; references: number; skills: number;
  other: number }; files: number }

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
  durationSec?: number /* 15..90 */; captionsOn?: boolean; musicMood?: MusicMood;
  referenceIds?: string[] /* ≤ 3, §45.28 */; ai?: { model: string | null; effort: Effort | null } /* this video's own
  setting, kept (§45.25 level 2) */ }
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
  ai: { model: string | null; effort: Effort | null }; referenceIds: string[];
  posted: { platform: Platform; url: string }[]; version: number; createdAt: string; updatedAt: string;
  approvedAt?: string; publishedAt?: string }
interface StorySafety { topicId: string | null /* null: no driving advice, only the "nothing dangerous" check */;
  status: "pending" | "ok" | "problems" | "skipped" /* skipped: the quality agent is off; never for driving safety */; problems: string[]; checkedScriptVersion: number | null;
  citations: { publisher: string; title: string; url: string; section?: string }[] }
interface StoryStep { key: StepKey | "portrait"; label: string; status: "pending" | "running" | "done" | "failed"
  | "skipped"; message?: string; startedAt?: string; finishedAt?: string; i?: number; n?: number }
interface ProductionJob { jobId: string; workspaceId: string; contentType: "animation" | "character" | "reference";
  contentId: string /* storyId, characterId (portrait) or refId (reference analysis) */;
  jobType: "produce" | "changes" | "portrait" | "reference_analysis";
  status: "queued" | "running" | "ready" | "needs_check" | "failed" | "canceled"; steps: StoryStep[];
  progress: number /* 0..1 */; configuration: { run: (StepKey | "portrait")[] /* the steps this job runs */;
  from: StepKey | null; sceneIds: string[] | null; note: string | null };
  meta: { writerModel: string | null; engineVersion: number | null; seed: number | null; scriptVersion: number | null;
  targetSec: number | null; actualSec: number | null; safetyTopicId: string | null; providers: Record<string, string>;
  models: { step: string; agentId: string; model: string; effort: Effort | null; effortApplied: boolean }[] };
  error?: string; createdAt: string; updatedAt: string }
interface SceneEdit { sceneId: string; caption?: string | null; durationSec?: number /* 2..15 */;
  sfx?: SfxCue[] /* replaces that scene's whole effects list: add, move, remove */ }
interface StoryPatch { version: number; title?: string; postCaptions?: Partial<Captions>; captions?: CaptionCue[];
  musicMood?: MusicMood; captionsOn?: boolean; scenes?: SceneEdit[];
  ai?: { model: string | null; effort: Effort | null }; referenceIds?: string[] }

type AssetKind = "final_video" | "cover" | "storyboard" | "scene_clip" | "scene_still" | "character_ref"
  | "portrait" | "audio" | "captions" | "design_ref" /* a picture for "Design with AI"; the Library hides it */;
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
  app: { choice: "own" | "clips" | null; saved: boolean; hints?: Record<string, string>; check?: KeyCheck };
  lastCheckedAt: string | null;
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
* **AI ideas, Expand and Variations** are tasks of the `creative_director` agent in **Lamo Stories' own runtime**
  (§45.24): the API writes a `TASK#` and invokes the agent (`start_task`), the web polls `GET …/tasks/{taskId}` and
  shows the drafts when it is `done` (usually 10–60 s, longer on the bigger models). The model and effort are the
  owner's (§45.25: the task's or the agent's or the workspace default, or the per-request override from the button's
  menu). The prompt is the agent's instructions, its enabled Lamo Stories skills, the workspace memory, then the
  Lamo Stories house brief: no voice-over, told through movement, faces, body language, sound and music, 9:16, 30–60 s
  suggested (15–90 allowed), recurring characters (the saved characters' names and personalities), never made for
  children, nothing dangerous for fun, and for `driving_safety` only topics in the checked guidance list (§45.11.5).
  Structured output (a JSON schema), validated by code; a bad answer is asked once more, then the task fails with
  "The idea helper could not finish. Tap Try again." Clip Factory's models and skills are never used.
* **Topic matching happens once, in the API**: when a draft is saved as an idea, or a story is created, of category
  `driving_safety`, the API sets `safetyTopicId` from the guidance topics' `keywords` (and the agent's pick, checked
  against the list), else `needsGuidance: true`. The agent trusts `safetyTopicId` (§45.11.5).
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
`failed` with "Making the video did not start. Tap Try again." (conditional on `status = queued`). **Tasks and chat
turns are fenced the same way**: `TASK#` and assistant `MSG#` carry `sessionId` and `heartbeatAt` (set by the API at
creation); the agent heartbeats every ≤ 30 s (the chat's text writes carry it) and every agent write is conditional
on `sessionId` and `status IN (queued, running)` (tasks) or `(pending, streaming)` (messages); `settle` also fails a
task `queued` > 3 min or `running` > 6 min ("The helper stopped. Tap Try again.") and a message `pending` > 3 min or
`streaming` > 3 min without a heartbeat ("The answer stopped. Tap Try again."); Stop sets `stopped` and the next
agent write is refused. A second message while the conversation's last answer is `pending` or `streaming` is `409`
"Wait for the answer, or tap Stop.". The deploy drain also waits for running tasks and streaming messages.

### 45.10 The animation engine (one folder, two places)

`web/src/stories/engine/`: TypeScript with only relative `./*.ts` imports inside the folder (no npm, DOM, network,
`Date`, `performance`, `Math.random`; `Deno` only in `cli.ts`; a vitest scan holds this), so the **browser** draws it
for live previews and **Lamo Stories' agent** runs the very same files with Deno (from its PyPI wheel, in its own image) for the final
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

### 45.11 Lamo Stories' agent (its own AgentCore runtime `cf_prod_story_agent`)

#### 45.11.1 The runtime, its actions, fencing, shutdown

* **Its own project and image**: `stories/agent/` (uv project `lamostories-agent`, package `lamostories_agent`,
  Python 3.13, its own `Dockerfile`: python 3.13 slim, ffmpeg (Debian's, with libass), Inter, numpy, the Deno binary
  from its PyPI wheel, the engine folder copied to `/app/stories-engine/`, `stories/config/` and `stories/skills/`
  copied in; no yt-dlp). It imports nothing from `clipfactory_agent` and runs in its own AgentCore runtime
  `cf_prod_story_agent` with its own role (§45.15). Clip Factory's `agent/` folder, image, runtime and server do not
  change.
* Actions (`POST /invocations`, each answered `{ "accepted": true, "id" }` at once, the work runs in the background):
  `process_story { userId, workspaceId, storyId, jobId }`, `process_portrait { userId, workspaceId, characterId,
  jobId }`, `process_reference { userId, workspaceId, refId, jobId }`, `run_task { userId, workspaceId, taskId }`,
  `chat_turn { userId, workspaceId, convId, msgId }`, `check_models { userId, workspaceId, taskId }`, `cancel { id }`,
  `health`. `/ping` says `HealthyBusy` while anything runs; the lifespan shutdown cancels running work cleanly (a
  stopped job is `failed` by the API's fence and "Try again" resumes from its first unfinished step).
* The job heartbeats `heartbeatAt` every ≤ 60 s from the event loop; heavy work (rasterizing, ffmpeg, synthesis) runs
  off the loop (threads or processes), so the heartbeat stays honest. Every `PJOB#` write is conditional on
  `sessionId = :sid AND status <> canceled`; every `STORY#` and `ASSET#` write is a transaction with a
  ConditionCheck on the job's `sessionId`. A refused write ends the run. Tasks and chat turns are fenced the same way
  on their own item. Failure sentences name the button ("Tap Try again"), never raw tool output; presigned URLs are
  redacted in logs.
* The deploy drain (`scripts/wait-for-jobs.sh`) waits for running Lamo Stories jobs (`PJOB#` with a fresh
  `heartbeatAt`) when Lamo Stories' runtime changes, and for clip jobs only when Clip Factory's does, as today.

#### 45.11.2 The writer (`storyboard` step)

The `storyboard` agent through `models.complete(task="storyboard" | "scene_rewrite", schema=STORYBOARD_SCHEMA)`
(§45.25: the owner's model and effort for that task, the agent's instructions and skills, the workspace memory), with:
the brief or concept, the analyses of the story's reference videos (§45.28), the cast (names, personalities, traits, movement
styles, the faces and noises each has; never the look), the catalog (from `cli.ts catalog`), the target length, the
captions switch, for safety stories the guidance topic's **shown** steps and donts (§45.11.5), and for changes the
current script, the owner's note and the scene ids (only those scenes change; with no note, "write a new take of only
these scenes: keep the cast, the story beat, the scene's place and length; make the action and staging different").
The answer becomes a `StoryScript` (code adds `engine`, `fps`, `seed`, per-scene seeds and `cast` with looks), goes
through `cli.ts normalize`, `validate` and `fit`; a failing answer is asked once more with the errors. Then, still in
the `storyboard` step, a second call `task="captions"` (the storyboard agent) writes the six post captions
(`Captions`) from the final script: YouTube title ≤ 100 chars, the others within §17.6's limits, the safety sources
named in the descriptions. Review's **Write them again** is a `captions` AiTask whose draft is saved through
StoryPatch.

#### 45.11.3 Drawing, animating and sound (the built-in providers)

* `scenes`: each scene's middle frame (`cli.ts scenes`) rasterized to `still-v{n}.jpg`.
* `animation`: per scene, `cli.ts frames` streamed line by line → `stories/raster.py` (numpy; anti-aliased coverage
  per primitive, the semantics of `engine/README.md`) → raw RGB piped into ffmpeg (`libx264`, `yuv420p`, 30 fps,
  CRF from `video.quality`: standard 23, high 20, best 17) → `scenes/{sceneId}/v{n}.mp4`. Scenes render
  `production.scenesAtOnce` at a time.
* `sound` (`stories/audio.py`): every effect and noise of `audioTrack` synthesized with numpy (no audio files, no
  network): effects from noise, sweeps and envelopes; noises as short formant "voices" in the character's pitch;
  music as a seeded loop per mood (chords, bass, light drums). Mixed at 48 kHz stereo, the music ducked under effects,
  then `loudnorm` two-pass to -14 LUFS, ≤ -1 dBTP (as clips) → `audio/v{n}.m4a`.
* `captions`: `textTrack` → an ASS file (Inter, the platforms' safe area, bubble symbols at their positions, the
  safety end card); `skipped` when `captionsOn` is false and there is no bubble or end card; burned in only when
  `production.burnCaptions` is on (otherwise kept as a sidecar asset).
* `assemble`: the scene files joined, the audio muxed, the ASS burned in (libass, as clips) → `final/v{n}.mp4`
  (`+faststart`) and `cover-v{n}.jpg`; `actualDurationSec` from ffprobe (≤ 89.5). Every file is an `ASSET#` (§45.12).
* `preview`: the `quality_assurance` agent's **final review** (`task="final_review"`: the script and 8 frames sampled
  from the final video, prepared by the picture helper of §45.33) adds any problems to `story.safety.problems`; then
  the story goes to `review` (or `needs_check`), the job `ready` (or `needs_check`). Old versions beyond
  `production.keepVersions` are deleted after a new version is made.

Writing takes about 30–90 s, drawing and animating a few minutes for 45 s of video, sound and assembly under a
minute (measured on the fixture and reported by builder E). There is no cost ceiling (as for clips, ADR-40), but a
runaway guard: at most 3 writer calls and 2 checker calls per job.

#### 45.11.4 Agent configuration

`stories/config/models.json` (§45.25) lists the reasoning models and, beside them, `imageModel` (`{ label, modelId:
"amazon.nova-canvas-v1:0", region: "eu-west-1" }`) and `videoModel` (`{ label, modelId: "amazon.nova-reel-v1:1",
region: "us-east-1" }`), never prefixed with a profile. `stories/config/agents.json` holds the five agents' default
instructions, tasks and skills. Terraform builds the runtime's model grants from these files and passes
`CF_STORIES_TABLE`, `CF_MEDIA_BUCKET`, `CF_REGION`, `CF_IMAGE_MODEL_ID`, `CF_IMAGE_REGION`, `CF_VIDEO_BUCKET` (empty
while the us-east-1 bucket is off) to the runtime. Clip Factory's `config/models.json` is not read by Lamo Stories.

#### 45.11.5 Safety stories only from checked guidance

* `stories/config/guidance.json` is the **checked guidance list**: 12 driving situations (skidding, ice and snow, a
  tyre blowout, aquaplaning, brake failure, a stuck accelerator, wheels off the road edge, fog, an animal on the road,
  a motorway breakdown, an emergency stop with ABS, strong crosswinds), each with the steps in order, the donts, the
  caveats and the countries' differences, and 38 sources: the UK Highway Code (GOV.UK), National Highways, RoSPA, the
  New York and California DMV driver manuals, the Ontario Ministry of Transportation, Transport Canada, Transport for
  NSW, Trafikverket and the Swedish National Wildlife Accident Council, each with its URL, section and a verbatim
  quote, fetched and checked on 2026-11-21. NHTSA, FMCSA, the National Safety Council and VicRoads refused the
  download and are not cited. A new source needs a fetched, quote-checked page. Bundled into Lamo Stories' agent image
  and into the API zip (it is not under `config/`, so Clip Factory's agent image never changes because of it).
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
  `quality_assurance` agent, `task="fact_check"`) whether each caption, each scene caption and each beat that shows a driving action agrees with
  the topic and its caveats, and, for every story, that nothing shows a dangerous act as something to copy. The
  writer's own text is rewritten once on a disagreement; an owner's edited text is never rewritten (its problems are
  shown to him). Problems left become `story.safety.problems`; the job ends `needs_check` with the video made, and the
  story cannot be approved until a check passes (`checkedScriptVersion`). The end card says "Based on {publisher}
  advice. Check your local road rules." and the post descriptions name the sources.

#### 45.11.6 Providers (who makes what)

A registry, `stories/agent/src/lamostories_agent/providers.py`, with four kinds and one Protocol each; the pipeline
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
| writer | `bedrock-claude` (the models of `stories/config/models.json`, picked per §45.25) | `on` per model only after **Check models** or a real call answered |
| animation | `builtin-2d` (the engine + rasterizer) | on |
| audio | `builtin-synth` (numpy synthesis) | on |
| images | `builtin-rig` (the character drawn by the engine) | on |
| images | `nova-canvas` (Amazon Nova Canvas, Bedrock in `eu-west-1`, `imageModel` in `stories/config/models.json`) | off until the owner picks it in Lamo Stories › Settings; then `needs_setup` until the first portrait job's real call answers (`on`, with `checkedAt`) or fails (`needs_setup` with `lastError`, e.g. "Bedrock says Nova Canvas is not enabled for this account in Europe (Ireland)."). Used for character portraits shown in the app and the Library only, never inside a posted video (the shared publishers mark posts as not AI-generated, §45.14). |
| animation | `nova-reel` (Amazon Nova Reel) | built but `needs_setup` until the us-east-1 bucket is switched on (§45.31); a story using it is posted only with AI labels |

Video, image and audio providers, their settings and credentials: §45.31. `GET …/providers` is served by the API
from a static mirror of the registry (`workspaces/providers.py`, a test
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

* **The developer app, per platform, by the owner's choice** (§45.30): Lamo Stories' **own** app (keys in
  `cf-prod/workspaces/{ws}/{platform}/app`; always for Facebook and Instagram), or, on purpose and only for YouTube,
  TikTok and X, Clip Factory's (`cf-prod/platforms/{platform}/app`, read only: Lamo Stories never writes, rotates or
  deletes them). Nothing of Clip Factory's registered apps or setup changes. The client id used at connect is stored on the account (`appClientId`); when the chosen app's keys change
  later (for example TikTok's Production keys replacing the Sandbox ones in Clip Factory, or new own keys), the Lamo
  Stories account shows `needs_reconnect` ("The {Platform} app keys changed. Connect again.") instead of failing on
  upload.
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
item `OAUTH#ws.{nonce}`/`STATE` (its own key prefix, so Lamo Stories' roles never reach Clip Factory's `OAUTH#{nonce}`
items) with `userId`, `workspaceId`, `socialAccountId`, `appChoice` and `redirectUri`. Today's `v1.` format and
`state.verify` are unchanged and reject `w1.` states. It returns the platform's authorize URL, built in
`workspaces/social.py` from the keys `app_keys` picks and the redirect URI of that choice (a test compares it with
`providers` except for the parameters below; `providers.py` is not changed), plus:
* youtube: `prompt=select_account consent` (Google always shows its account and channel picker, Brand Accounts
  included);
* tiktok: `disable_auto_auth=1` (as today: TikTok always shows its consent page, for the account signed in on
  tiktok.com); the page says first "Sign in to your Lamo Stories account on tiktok.com in this browser. TikTok
  connects the account that is signed in.";
* instagram, facebook: Lamo Stories' own Meta app and its Login configuration; the page says before the tap "Facebook
  will ask which Pages this app may use. Tick only your Lamo Stories Page.";
* x: as today; the page says "First sign in to your Lamo Stories account on x.com in this browser. X connects the
  account that is signed in."

#### 45.13.3 The callback: Clip Factory's callback only forwards; Lamo Stories' own Lambda does the rest

* **Lamo Stories' own callback route** on `cf-prod-stories-api`: public `GET /v1/stories-oauth/{platform}/callback`
  (authorization NONE, its own low route throttle), `storiesCallbackBase` = `{apiUrl}/v1/stories-oauth`. Own developer
  apps register this URI. It checks the `w1.` HMAC (constant time) and expiry before anything else, consumes the state
  item `OAUTH#ws.{nonce}` once, and exchanges the code with the `redirectUri` stored on the state (the authorize
  request's own).
* **Clip Factory's callback** (`cf-prod-hooks`, `GET /oauth/{platform}/callback`, the URI registered with Clip
  Factory's apps) gains only a prefix check, before its `try`: a state starting `w1.` is answered `302` to the fixed
  `{STORIES_OAUTH_CALLBACK}/{platform}/callback` with the query passed byte for byte (`Cache-Control: no-store`,
  `Referrer-Policy: no-referrer`; the target comes from configuration, never from the request); every other state runs
  today's code unchanged, including refusing a consumed `v1.` item that carries `workspaceId`. Hooks gains no workspace
  code, no Lamo Stories secret access and no new IAM.
* Every outcome lands on `{APP_URL}/stories/connections?platform={p}&result={code}` (`&ws={id}` only after the
  signature checks out), codes from a fixed `WS_RESULTS` list (§17.5's codes plus `same_as_clips`); nothing else from
  the request is reflected; an unreadable or expired state lands there too ("That took too long. Tap Connect again.").
The workspace path (`workspaces/social_callback.py`, wrapped whole in try/except → `error`):
1. exchanges the code with `providers.exchange` (the same code as Clip Factory, read-only use) and the keys `app_keys`
   picks;
2. finds the identity: **YouTube** is one channel per token (`channels?part=id,snippet&mine=true`: none →
   `no_channel`; one → that channel; more than one → `error`, nothing written: there is no way to post to another);
   **Meta** lists Pages (with their Instagram accounts) → `choose_account` when there are several, each choice marked
   `usedByClips` when it is Clip Factory's destination; **TikTok** and **X** the one signed-in user;
3. writes the token to the workspace secret, then `SOCIAL#{platform}`: `connected` with `externalAccountId`,
   `accountName`, `handle`, `avatarUrl`, `appClientId`, `lastCheckedAt`, clearing `sharedWithClips`; or
   `choose_account`; or `same_as_clips` when the identity is Clip Factory's own (compared with
   `ACCOUNT#{platform}.accountId`, read-only).
It never writes `ACCOUNT#`, `SETUP#` or any `cf-prod/platforms/*` secret, and never releases Clip Factory posts.

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
* **Instagram:** a separate professional (Business or Creator) account, linked to a Facebook Page, through Lamo
  Stories' own Meta app (§45.30), so Clip Factory's Meta grant is never touched. Tick only the Lamo Stories Page.
* **Facebook:** a separate Page managed by the same Facebook login, through the same own Meta app.
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
* **Shared limits** (only with Clip Factory's developer app, §45.30: one X bill, one Google project; with Lamo
  Stories' own app the same rules use its own counters `RATE#WS#{ws}#{platform}` and `xMonthlyLimitUsd`): before the first X start (no handle yet) the flow calls
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
  Lamo Stories' built-in videos are cartoons, so the publishers' existing "not AI-realistic" flags are correct. A story
  whose job used a realistic generator (`nova-reel`) is posted only through Lamo Stories' own thin publisher wrappers
  that set YouTube's `containsSyntheticMedia: true` and TikTok's `is_aigc: true` (subclasses in `workspaces/`, the
  shared publisher code unchanged); a platform where no label can be set refuses it with a plain sentence.
* Lamo Clips' `POST /v1/clips/{clipId}/confirm`, its posts, the clip flow and the release keep reading only
  `ACCOUNT#` and `cf-prod/platforms/*`: they cannot reach a Lamo Stories account.

### 45.15 Infra (Terraform, additive only)

* **`infra/modules/stories_agent`** (new): ECR repository `cf-prod-stories-agent` (immutable tags, last 15 kept), the
  image build trigger `terraform_data.image` (pushes `stories/agent/Dockerfile` with `scripts/push-image.sh`), AgentCore
  runtime `cf_prod_story_agent` (public network, 15-minute idle, 8-hour maximum, like the clip runtime), its log group
  (30 days), and its role: DynamoDB on the table only, writes (Put, Update, Delete, TransactWrite, ConditionCheck) and
  reads with `dynamodb:LeadingKeys` `USER#*#WS#*` and `USER#*#WSREG`; S3 Get, Put, Delete, multipart on `ws/*` and
  ListBucket on prefix `ws/`; Bedrock `InvokeModel` and `InvokeModelWithResponseStream` on the models of
  `stories/config/models.json` (profiles and foundation models, as the clip agent's grants are built), Nova Canvas in
  eu-west-1, and `StartAsyncInvoke`/`GetAsyncInvoke` on Nova Reel in us-east-1 only when the bucket switch is on;
  Secrets `GetSecretValue` on `cf-prod/workspaces/*/providers/*` only; logs and tracing like the clip runtime; no
  Transcribe, no Secrets beyond that, no Clip Factory prefix. Variable `stories_video_us_bucket` (bool, default
  false) adds an S3 bucket `cf-prod-stories-video-<acct>-us` in us-east-1 (an aliased provider; private, TLS only,
  14-day expiry) and its grants.
* **`infra/modules/stories_api`** (new): Lambda `cf-prod-stories-api` (the same zip, handler
  `clipfactory_api.workspaces.http.handler`, Python 3.13 arm64, 1024 MB, 29 s), its log group, alarms, and its role:
  DynamoDB with `LeadingKeys` `USER#*#WS#*`, `USER#*#WSREG`, `OAUTH#ws.*` (writes and reads); and one read-only
  statement for Clip Factory's `ACCOUNT#` items: GetItem on `USER#*` with `ForAllValues:StringEquals
  dynamodb:Attributes = [pk, sk, platform, status, accountId]` and `dynamodb:ReturnValues = NONE` (only what "same as
  Clip Factory" compares); S3 on `ws/*`; Secrets Create, Put, Get, Describe, Delete, Tag on `cf-prod/workspaces/*`, Get
  on `cf-prod/platforms/{youtube,tiktok,x}/app*` (the shared-app choice; never Meta's) and the OAuth state key;
  `bedrock-agentcore:InvokeAgentRuntime` and `StopRuntimeSession` on `cf_prod_story_agent` only;
  `lambda:InvokeFunction` on the story-flow alias. Env `TABLE_NAME`, `MEDIA_BUCKET`, `STORIES_AGENT_RUNTIME_ARN`,
  `STORY_FLOW_ARN`, `WS_SECRET_PREFIX`, `SECRET_PREFIX`, `OAUTH_STATE_SECRET`, `HOOKS_URL`, `APP_URL`, `VERSION`. In
  `infra/modules/api`: routes `ANY /v1/workspaces` and `ANY /v1/workspaces/{proxy+}` with the same JWT authorizer,
  public `GET /v1/stories-oauth/{platform}/callback` (§45.13.3, route throttle 5 per second, burst 10), and public
  `OPTIONS /v1/workspaces` and `OPTIONS /v1/workspaces/{proxy+}` (the more specific paths would otherwise
  catch the browser's token-less preflight, the §5 CORS lesson), all integrated with `cf-prod-stories-api`; every
  other path still reaches `cf-prod-api`; the permission for API Gateway to invoke it; the deploy's smoke job also
  checks a preflight on `/v1/workspaces`. `cf-prod-api`'s function, role and environment
  are not touched.
* `infra/modules/flows`: `story-flow` (durable, alias `live`, 1024 MB, 900 s, execution timeout 9 days, its own role:
  DynamoDB writes limited to `USER#*#WS#*` and `RATE#*`, reads on `USER#*#WS#*`, `USER#*#WSREG` and `RATE#*`, plus the
  same attribute-limited GetItem on `USER#*` as the API (ACCOUNT#'s `pk, sk, platform, status, accountId`); S3 Get on
  `ws/*`; Secrets Get on `cf-prod/workspaces/*` and `cf-prod/platforms/{youtube,tiktok,x}/app*`, Put on
  `cf-prod/workspaces/*/token*`; no Bedrock). `RATE#{platform}` (Clip Factory's shared counters) is written only for
  the shared-app choice, on purpose (§45.14).
* `infra/modules/hooks`: one env var, `STORIES_OAUTH_CALLBACK` (Lamo Stories' callback base), and nothing else: no new
  IAM, no workspace secrets (the `w1.` forward of §45.13.3). The first round's hooks IAM additions are removed.
* Not changed: `infra/modules/agent` (Clip Factory's runtime, role, image), `infra/modules/api`'s Lambda and role.
* `scripts/wait-for-jobs.sh`: also counts `PJOB#` items when `module.stories_agent.` changes. `deploy.yml`: a second
  image tag `stories-agent-` + 16 characters of `hashFiles('stories/**', 'web/src/stories/engine/**')`, passed as
  `stories_agent_image_tag`; Clip Factory's agent tag hash stays `agent/**`, `skills/**`, `config/**` (unchanged).
* The Terraform tests that list exact sets gain the new members and new asserts, written as glob matches against
  sample ARNs: no Lamo Stories role matches `…:secret:cf-prod/platforms/youtube/token-AbC123` or `…/pending-AbC123`;
  no Clip Factory role matches `…:secret:cf-prod/workspaces/stories/youtube/token-AbC123`; the Lamo Stories roles
  write DynamoDB only under their leading keys and touch S3 only under `ws/`.
* **A scripted plan check** after `check-plan-deletes.sh` (`scripts/check-plan-clips-unchanged.sh`, jq over
  `plan.json`): nothing under `module.agent.` changes unless Clip Factory's agent tag changed; `cf-prod-api`'s role
  and policy are no-op; the function may change only in `source_code_hash`, `last_modified`, `version`,
  `qualified_arn`, `qualified_invoke_arn` and `environment.variables.VERSION` (the shared zip and the release sha, as
  on every deploy today), never its handler, runtime, memory, timeout, role or other environment keys; every existing
  route and integration of the HTTP API is no-op. Its test feeds it sample plans.
* The deploy's smoke job also sends a preflight to `/v1/workspaces/stories/dashboard` and checks the CORS answer.
* The runtime's log group follows the clip runtime's pattern (`terraform_data` that creates it if missing, then sets
  30 days), tagged `stories_agent`.

### 45.16 Web

#### 45.16.1 The workspace switcher

* A pick bar (`<Glide>`, the owner's sliding highlight) with one choice per workspace that `GET /v1/workspaces`
  returns (today **Clip Factory | Lamo Stories**: Lamo Clips' choice is labelled with the app's own name, as the owner's
second request names it), shown only when `storiesEnabled()`; one click switches. In Lamo Clips: on screens from
  768 px as the first child of the sidebar foot, so the bottom-anchored foot grows into empty space and the live dot,
  Get the app and the jobs status stay where they are; when the window is too short for it (the free space is
  measured, about 640 px tall and up), a compact round toggle in a place that moves nothing; folded sidebar: one round
  toggle with its aria-label; on phones a compact control in the top bar between the brand and the live dot, icon
  only below 360 px. It never uses `.sidebar__item` (tests pin the six items), never adds a tab, never overlaps or
  pushes anything (e2e at 320, 390, 1000×600, 1000×650, 1000×720 and 1440×900, sidebar open and folded). In Lamo
  Stories the same switcher sits in its own navigation.
* Lamo Stories lives under `/stories/…`; everything else is Lamo Clips, rendered by today's `Shell` unchanged.
  Switching to Lamo Stories goes to the last Lamo Stories page (else `/stories`); switching back goes to the last
  Clip Factory page (else `/`) at its scroll position (kept in sessionStorage), with Ask's open conversation, its
  answer still streaming in, and the panel open or closed as it was: Ask's conversation state moves into an
  `AskMemoryProvider` mounted once above the Clip Factory / Lamo Stories branch (its look and behaviour unchanged;
  sign-out still forgets it and revokes its object URLs). Not kept across a switch: unsaved form drafts and open
  sheets on the Clip Factory page (they are not kept across any page change today either).
* The choice persists on the device (`localStorage` `cf.workspace`: `{ workspaceId, lastStoriesWorkspaceId,
  lastClipsPath, lastStoriesPath, lastConversationId, lastProject }`; Lamo Stories' own device preferences in
  `cf.stories.prefs`, never in Clip Factory's `cf.prefs`) and the URL carries it: a reload of a `/stories` page stays in Lamo Stories;
  opening the app at `/` when the last choice was Lamo Stories goes to the last Lamo Stories page. One sign-in: the
  same Cognito session, the same API.

#### 45.16.2 The Lamo Stories shell

`web/src/stories/StoriesApp.tsx`, its own navigation and look ("an animation studio"): Dashboard `/stories`, Ideas
`/stories/ideas`, Characters `/stories/characters` (`/stories/characters/new`, `/stories/characters/{id}`),
Production `/stories/production` (`/stories/production/new`, `/stories/production/{storyId}`), Review
`/stories/review` (`/stories/review/{storyId}`), Chat `/stories/chat` (`/stories/chat/{convId}`), References
`/stories/references` (`/stories/references/{refId}`), Library `/stories/library` (`?kind=`, `?story=`), Social
accounts `/stories/connections`, Settings `/stories/settings/{section}` (`ai`, `agents`, `skills`, `memory`,
`video`, `storage`), and the onboarding `/stories/setup` (shown by itself the first time).

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
* Social accounts (the Connections page) also shows, per platform: the developer-app choice (§45.30) with its key
  form and **Check it**, the authorization status, **last checked** (`lastCheckedAt`, with **Check now**), Connect,
  Reconnect and Disconnect; the publish sheet shows the exact account each video goes to, with **Check now**, before
  **Upload**.
* Settings: §45.29's sections (AI, Agents, Skills, Memory, Social accounts, Video, Storage and production), plus
  YouTube category and privacy and captions and music defaults.
* Chat: §45.27 (conversation list, messages, the model and effort line above the box, "Just for this message",
  attachments, action buttons, Stop); References: §45.28 (upload with progress, Analyze with the model and effort
  shown, the analysis, "Use in a video").

#### 45.16.8 Mock mode

`web/src/stories/api/mock/` implements every route in memory (`index.ts` joins the parts, `store.ts` holds the shared
seed; a production job walks its steps in about 10 s; the "final video" is the engine's live preview in mock mode), so
every screen runs under `npm run dev:mock` and in Playwright.

### 45.17 Changes to existing files (each one small, each with its proof)

| File | Change | Owner | Proof that Clip Factory is unchanged |
|---|---|---|---|
| `api/.../routes/__init__.py`, `api/tests/test_http.py` | **none** (Lamo Stories' routes live in their own Lambda; the Phase 1 scaffold's edits are reverted) | – | both byte-identical to main |
| `api/.../routes/help.py` | `"stories"` in `PAGES` (the web router has a `stories` route name; Ask is never shown there) | Phase 1 | `test_help_pages.py` |
| `api/.../oauth/callback.py` | refuses a consumed `v1.` item that carries `workspaceId` (writes nothing) | B | `test_oauth_callback.py` unchanged; every old case replayed writes the same items, secrets and redirect |
| `api/.../hooks.py` | `_oauth_callback`: a `w1.` state is forwarded (`302` to `STORIES_OAUTH_CALLBACK`, query byte for byte) before its `try`; nothing else | B | `test_hooks.py` unchanged |
| `web/src/features/help/*` (Ask) | its conversation state moves into an `AskMemoryProvider` mounted above the Clip Factory / Lamo Stories branch; look and behaviour unchanged | F | the Ask and help e2e and unit tests unchanged; a new e2e: ask, switch to Lamo Stories while it streams, switch back, the answer is there |
| `api/scripts/build_lambda.py` | the story-flow and stories-API handlers in `HANDLERS`; `stories/config/` and `stories/skills/` into the zip | Phase 1, A | its build test |
| `infra/modules/api` | the `/v1/workspaces` routes, the public Lamo Stories callback route, their integration and permission only | C | `api.tftest.hcl`; the deploy's scripted plan check (§45.15) |
| `infra/modules/hooks`, `infra/modules/flows`, `infra/envs/prod` | §45.15 | C | `terraform test`; the deploy's Plan and Delete gate lines |
| `.github/workflows/deploy.yml`, `ci.yml`, `scripts/wait-for-jobs.sh` | the Lamo Stories agent image tag and push, the scripted plan check, a deeper preflight in the smoke job; a `stories-agent` CI job (lint, types, tests, image build) and a web bundle check; the drain for `PJOB#`, running `TASK#` and streaming `MSG#` | C (deploy, drain), E (stories-agent job), F (bundle check) | `scripts/test-deploy-workflow.sh`, the drain's test; Clip Factory's agent tag and its CI job unchanged |
| `web/src/lib/router.ts` | one route name `stories` (page from `web/src/stories/routes.ts`) for `/stories…`, only when `storiesEnabled()` | Phase 1, then F | every old path parses to the same route |
| `web/src/app/App.tsx` | the lazy `StoriesApp` for the `stories` route; its TITLES entry; the `AskMemoryProvider` mount | Phase 1, then F | every old route renders the same `Shell`; the main chunk gains only `flag.ts`, `routes.ts` and the lazy stub, no `.stories-app` or `--st-` rule in the main CSS, no StoriesApp or engine code in the main JS (a CI grep over `web/dist`) |
| `web/src/components/Nav.tsx` | the switcher in the sidebar foot and the phone top bar (hidden while off) | F | the nav specs unchanged; the before/after pixel check (§45.19) |
| `web/src/styles/glide.css` | the switcher's container in the Glide list | F | – |
| `web/areas.json` | Lamo Stories folders → "Behind the scenes" (Phase 1), "Lamo Stories" by the switch PR | Phase 1 | `update.test.ts` |
| generated files | help corpus, the HELP_ASSISTANT routes table, Ask knowledge | every PR that changes docs, the router, Nav or App | their `--check` steps |

Not touched at all: `agent/**` (Clip Factory's agent: code, Dockerfile, dockerignore, tests, scan allow-list),
`config/**` (`config/stories-guidance.json` moves to `stories/config/guidance.json`), `app.py`, `agent_client.py`,
`flow_client.py`, `platforms/**`, `oauth/tokens.py`, `oauth/providers.py`, `oauth/secrets.py`, Clip Factory's
screens and styles.

Open pull requests that touch the same files on 2026-11-21 (whoever merges second keeps both sides; generated files
are never merged by hand: take main's and rerun `node web/scripts/help-corpus.mjs --write-docs` then `node
web/scripts/ask-knowledge.mjs`): #98 (CONTRACTS, DECISIONS, the generated files), #106–#108 and later docs PRs
(CONTRACTS and the generated files), #71 (areas.json). Their sessions were told on 2026-11-21.

### 45.18 Deploys

Every Lamo Stories pull request that changes `infra/` is read before merging: `terraform plan` may only add resources,
change IAM policies and Lambda settings in place, and replace `module.stories_agent.terraform_data.image` (Lamo
Stories' image build trigger, whenever its image changes); `module.agent.` (Clip Factory's agent) must show no change
at all. After each deploy the Plan line and the Delete gate line
are read and reported, and `terraform show -json` is checked: every resource whose actions include `delete` must be
an image build trigger (`module.stories_agent.terraform_data.image`, or `module.agent.terraform_data.image` only when
another session changed Clip Factory's agent in the same deploy). No owner data shape changes: no existing item gets a new required attribute,
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
* **stories agent** (`stories/agent/tests`): the story pipeline with a fake Bedrock on `web/src/stories/engine/fixtures/sample-script.json` and the
  real engine CLI (Deno) and ffmpeg, asserting only contract invariants (validate ok, frame lines = `frameCount`,
  every primitive matches §45.10, the MP4's length and frame count); the rasterizer against committed draw-list
  fixtures (`stories/agent/tests/fixtures/prims-*.jsonl`) and golden PNGs within a small tolerance; the audio synth's
  lengths, levels and determinism; the `stories/agent` server's action table and its tests (Clip Factory's `agent/`
  tests run unchanged and byte-identical to main); the safety step's outcomes
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
* **The second request** (§45.24–§45.31): api: the AI configuration's validation (unknown models, efforts a model does
  not offer, precedence), agents (edit, reset, switch off), skills (versions, restore, enable, assign), chat (send,
  poll, stop, override never saved), memory, references (multipart, analyze), onboarding, provider keys never
  returned, developer-app choice (own keys stored only under the workspace prefix; a missing choice blocks Connect),
  and a **separation test** that runs every Lamo Stories route and records every DynamoDB key, S3 key and secret name
  it touches: none outside `USER#{u}#WS#…`, `USER#{u}#WSREG`, `OAUTH#…`, `ws/{u}/…`, `cf-prod/workspaces/…`, and no
  Clip Factory item or secret written. stories agent (`stories/agent/tests`): the effective model and effort of each
  task and agent, the request body really carrying `output_config.effort` (and not when the model has none), no
  silent substitution (a denied model fails the task with its sentence and never calls another model), usage items,
  each agent getting only its enabled skills and the memory, the chat tool loop (each tool, actions returned, nothing
  done without the owner's tap), the reference analysis on a short fixture video, an import scan (nothing from
  `clipfactory_agent`); web: the model and effort line in the chat, "Just for this message", every settings section,
  the onboarding (skip, resume, the ring), the Social accounts page details.

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
| The second request (§1–§10 of it) | §45.24–§45.32 |

The spec's conceptual fields map as: Workspace → `workspaceId`, `userId`, `workspaceName`, `workspaceType`,
`configuration`; SocialAccount → `socialAccountId`, `workspaceId`, `platform`, `externalAccountId`, `accountName`,
the encrypted credentials in Secrets Manager (never on the item), `connectionStatus`; Content → `Story`
(`storyId` = content id, `workspaceId`, `contentType`, `title`, `status`, `storageLocation`); ProductionJob →
`jobId`, `workspaceId`, `contentId`, `jobType`, `status`, `configuration`; PublishingJob → `publishingJobId`,
`workspaceId`, `contentId`, `socialAccountId`, `platform`, `publishingStatus`.

### 45.21 Who builds what, and in which order

Phase 1 (this section, ADR-70 to ADR-80, and the scaffold: `workspaces/types.py`, `guard.py`, `deps.py`, `http.py`,
empty route modules, the story-flow stub, `stories/config/` (models, agents, guidance), `stories/skills/` (built-in
Lamo Stories skills), the `stories/agent/` project skeleton (pyproject, package, the model-client and registry
interfaces, a server with an empty action table), the web types and client interface, the split mock folder with
rejecting stubs, the engine's types, catalog, stub engine and command line, the preview components, a thin
`StoriesApp` behind `storiesEnabled()` with the router and App branch, placeholder screens, the flag and the
`areas.json` lines) merges first. Then the builders work at the same time, each only in its own files, each
continuing from its own branch where it has one (the first round's work stays):

| Builder | Branch | Owns |
|---|---|---|
| A api core | `feat/stories-api-core` | **removes** the first round's model path (`learn.converse_text`, the skills block, `help.model`/`app.help` use, `FakeModel`/`HelpDeps` in `tests/ws_support.py`, the skills-block idea tests); moves its routes to `workspaces/routes/core.py`; then the core routes and their modules (workspaces, dashboard, ideas (now tasks), characters (+ design task), stories, library, providers, guidance, tasks), `workspaces/agent.py` (Lamo Stories' runtime only), `workspaces/jobs.py`, `tests/ws_routes_core.py`, `tests/ws_support.py`, its tests, the guidance and skills copy in `build_lambda.py` |
| A2 api AI | `feat/stories-api-ai` | `routes/workspaces/ai.py` and its modules (AI configuration, models and prices, agents, skills, chat, memory, references, onboarding, usage, provider keys, storage), `tests/ws_routes_ai.py`, its tests |
| B social and publishing | `feat/stories-social` | moves its routes to `workspaces/routes/social.py`; **removes** its first-round workspace path from `oauth/callback.py` and `hooks.py` (only the forward and the `v1.` refusal stay) and the hooks IAM it needed; adds the Lamo Stories callback route; as before otherwise, plus `workspaces/apps.py`, the developer-app choice and own keys (§45.30), own rate counters and X limit, `lastCheckedAt`, Reconnect, AI-label wrappers (§45.14) |
| C infra | `infra/stories` | §45.15: the new `stories_agent` and `stories_api` modules, the API routes, the story flow, hooks, `deploy.yml`'s Lamo Stories tag, the drain, their tests; **removes** the first round's changes to `infra/modules/agent`, `infra/modules/api`'s role and environment, and `config/models.json` |
| D engine | `feat/stories-engine` | `web/src/stories/engine/` (not `types.ts`), `web/src/stories/preview/`, its tests |
| E agent core | `feat/stories-agent` | **resets** `agent/**`, `.github/workflows/deploy.yml`'s agent tag line, the agent job's ffmpeg step in `ci.yml` and its check in `scripts/test-deploy-workflow.sh` to main (`git checkout origin/main -- agent …`) before adding the `stories-agent` job; then `stories/agent/` (the runtime: server, runner, fencing, `models.py` (model and effort resolution, the Bedrock client, refusals, usage), agents and skills plumbing, the production pipeline moved here from the first round's `agent/src/clipfactory_agent/stories/`, rasterizer, audio, assembly, providers incl. Nova Canvas and Nova Reel), its `Dockerfile`, the `stories-agent` CI job, `stories/agent/tests`; **removes** the first round's changes to `agent/**` |
| E2 agent creative | `feat/stories-agent-creative` | `stories/agent/src/lamostories_agent/{chat,memory,reference,tasks}/` (each with a `register(actions, runner)` the scaffold's `build_app` already calls: the chat turn and its tools, memory, reference analysis, idea, expand, variations, captions-again, character design and check-models tasks), their tests |
| F web shell | `feat/stories-web-shell` | **removes** its first-round `screens/Settings.tsx` body (the placeholder stays for F2), `storyModel` and every import of Clip Factory's `web/src/lib/models.ts`; the `AskMemoryProvider` (§45.16.1) and its tests; the CI bundle check; as before otherwise, plus the onboarding (`/stories/setup`), the Social accounts page details, the mock's `onboarding.ts` |
| F2 web settings | `feat/stories-web-settings` | `web/src/stories/settings/` (AI, Agents, Skills, Memory, Video, Storage and production), the Settings screen, the mock's `ai.ts`, `skills.ts`, `memory.ts`, its tests |
| G web studio | `feat/stories-web-studio` | **removes** `CLIP_MODELS`, `storyModel` and `DEFAULT_CLIP_MODEL` uses; as before otherwise, plus ideas and character design as tasks (the mock's `getTask`, `designCharacter`), references in Production (picked from H's list), per-video model and effort override |
| H web chat | `feat/stories-web-chat` | `web/src/stories/chat/` and `screens/Chat.tsx`, `screens/References.tsx` (upload, analyze, the analysis), the mock's `chat.ts` and `references.ts`, its tests |

`web/src/stories/api/types.ts`, `web/src/stories/engine/types.ts`, `api/.../workspaces/types.py` and the
`stories/agent` interfaces change only through this section (a builder asks the lead). Ship order: D before E and G;
E before E2's final rebase; F before G, F2 and H; A before A2. Then one check of everything together against §45.20,
§45.23 and §45.32, and the switch PR (`STORIES_ON = true`, the `areas.json` labels).

### 45.22 What only the owner can do (none of it blocks building)

* TikTok: add the Lamo Stories TikTok account as a Sandbox target user (TikTok developer portal › Sandbox › Target
  users) and make it private (TikTok app › Profile › Settings and privacy › Privacy › Private account) until TikTok
  approves the app; until then TikTok posts are "Only me".
* Have the separate accounts ready: a Lamo Stories YouTube channel (a Brand Account under the same Google login is
  fine), a Facebook Page, an Instagram professional account linked to it, an X account. Lamo Stories never creates
  them. When Facebook asks which Pages, keep Lamo Clips' Page ticked too.
* To use AI portraits: pick Nova Canvas in Lamo Stories › Settings and make one portrait; if Bedrock says the model is
  not enabled, enable Amazon Nova Canvas in the Bedrock console, Region Europe (Ireland).
* Run **Check models** once (Settings › AI): a model Bedrock refuses shows why (for example the Fable models'
  data-retention opt-in, a one-time account step in docs/DEPLOYMENT.md).
* For fully separate apps (§45.30): make the second developer app per platform and paste its keys; TikTok and Meta
  then review the new app, which can take days to weeks.
* Nova Reel: say if Lamo Stories may keep its generated shots in a US (N. Virginia) bucket; until then it stays off.

### 45.23 Acceptance evidence, and what is only verified live

| # | Criterion | In CI | Live, after the switch PR |
|---|---|---|---|
| 1 | Clip Factory opens and works as before | every old test; the pixel check | sign in on the live app and open `/`, `/jobs`, `/review`, `/library`, `/money`, `/settings` |
| 2 | Existing jobs and uploaded videos stay reachable | the isolation tests | `GET /v1/jobs`, `/v1/clips`, `/v1/posts` saved before the first Lamo Stories deploy and after (ids and statuses only) are equal; one old job opens and one clip plays |
| 3 | Clipping is unaffected | Clip Factory's agent tests unchanged; Clip Factory's `agent-` image tag computed on every Lamo Stories branch equals main's | the deploy summary shows the same `agent-…` tag; one real clip job afterwards |
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

### 45.24 Lamo Stories is its own application (the owner's second request, 2026-11-21 evening)

The owner's words: "Lamo Stories must be treated as an independent application within the existing Clip Factory
application shell … The only shared element should be the application shell responsible for navigating between them."
Everything earlier in §45 stays; this subsection and §45.25–§45.32 add to it, and where they differ, they win.

**What each application owns.** Clip Factory (Lamo Clips) keeps everything it has: its interface, AgentCore runtime
`cf_prod_clip_agent`, agents, uploaded skills, models (`config/models.json`), conversations (Ask), pipeline, social
integrations, accounts, credentials, data and settings, byte for byte. Lamo Stories has its own:

| Part | Lamo Stories' own | Never shared with Clip Factory |
|---|---|---|
| Frontend and navigation | `web/src/stories/**`, lazy-loaded, `/stories/…` | Clip Factory's screens, nav, Ask, setup to-do |
| HTTP API | Lambda **`cf-prod-stories-api`** (same zip, handler `clipfactory_api.workspaces.http.handler`) behind `ANY /v1/workspaces` and `ANY /v1/workspaces/{proxy+}` on the same HTTP API and JWT authorizer | `cf-prod-api`, its route table, role and environment stay unchanged |
| AgentCore environment | runtime **`cf_prod_story_agent`**, its own image (`stories/agent/`), ECR repository, role, log group and sessions (`cfstory-…`) | `cf_prod_clip_agent`, its image, role and sessions |
| AI agents | five built-in Lamo Stories agents (§45.26), owner-editable | Clip Factory's clip agent and Ask |
| Skills | Lamo Stories skills (`SKILL#` in the workspace partition, built-ins in `stories/skills/`) | Clip Factory's skills: never read, never sent |
| Models and effort | `stories/config/models.json` plus the workspace's AI configuration (§45.25) | `config/models.json` and Clip Factory's `clipModel` setting |
| Chat, history, memory | `CONV#`, `MSG#`, `MEM#` (§45.27) | Ask's conversations |
| Production | `STORY#`, `PJOB#`, the engine, reference-video analysis (§45.28) | clip jobs |
| Library, analytics | `ASSET#`, publishing numbers, model usage and cost (§45.25) | Clip Factory's Library, Money, stats |
| Settings and setup | the workspace configuration, onboarding (§45.29) | Clip Factory's Settings |
| Social connections and OAuth | `SOCIAL#`, `cf-prod/workspaces/{ws}/…` tokens, and, if the owner picks it, its own developer apps (§45.30) | Clip Factory's `ACCOUNT#`, `SETUP#` and tokens |
| Publishing | `cf-prod-story-flow` | the clip flow |
| Storage | `ws/{userId}/{workspaceId}/` in the media bucket, behind IAM that names only that prefix | Clip Factory's prefixes |

**What is shared, and why** (the owner allows shared infrastructure "where appropriate" with "strict authorization and
data boundaries"): the app shell and the one sign-in (Cognito); the AWS account, the HTTP API (a separate route and
Lambda), the DynamoDB table (separate partitions and leading-key IAM), the media bucket (a separate prefix) and Secrets
Manager (a separate name prefix); Clip Factory's OAuth callback only to **forward** a `w1.` state to Lamo Stories'
own callback (Clip Factory's registered apps are not edited, so their redirect URI stays the hooks one; §45.13.3);
the platform publisher library code (read-only, called with Lamo Stories' own credentials); and, only when the owner
picks it for YouTube, TikTok or X, Clip Factory's developer app (§45.30). Nothing of Lamo Stories runs inside a Clip Factory Lambda or runtime, and no Lamo Stories
setting is read by Clip Factory code.

**The boundaries, in IAM** (§45.15): `cf-prod-stories-api` and the `cf_prod_story_agent` role can write DynamoDB
only under `USER#*#WS#*` and `USER#*#WSREG` (and the API also `OAUTH#ws.*`, its own connect states); the API and the
story flow may read only five attributes of Clip Factory's `ACCOUNT#` items (an attribute-limited GetItem: IAM limits
partitions, not sort keys, so the code and this attribute list are what keep them to `ACCOUNT#`); they read Clip
Factory's app keys only for YouTube, TikTok and X (the shared-app choice); the agent reads none of these; S3 only
under `ws/`; secrets only `cf-prod/workspaces/*`; none can read a Clip Factory token. Clip Factory's roles gain
nothing.

### 45.25 AI models and reasoning effort (owner-controlled)

* **Which models.** `stories/config/models.json` lists the reasoning models Lamo Stories may use (separate from
  `config/models.json`): Claude Fable 5.2, Claude Fable 5.1, Claude Opus 5.5, Claude Sonnet 5.5, Claude Haiku 5.5 on
  Amazon Bedrock (the owner's "Sable 5.2 / Sable 5.1" are Fable 5.2 / 5.1, the models of that name in this account).
  Each entry: `key`, `label`, `provider` ("Amazon Bedrock"), `modelId`, `profile` (the inference profile used, e.g.
  `global.anthropic.claude-fable-5-2`), `regions` (for IAM), `efforts` (the levels the model accepts, e.g. `["low",
  "medium", "high", "xhigh", "max"]`), `defaultEffort` (the model's own default: Opus 5.5 and Haiku 5.5 `medium`, the
  others `high`), `vision` (bool), `pricing` (input and output price per million tokens and where it came from, or
  `null` when not known). A new model or provider is one entry (plus its IAM grant from the same file) and, for a new
  provider, one client class in the agent (§45.25 "Calls"). Terraform builds the agent's `bedrock:InvokeModel` grants
  from this file.
* **Availability.** `ModelInfo.status` records what happened, it never blocks a call: every call's outcome updates
  `MODELSTATUS#{key}` (`ok` on any answer, `denied` / `not_found` on the matching Bedrock refusal, `error` otherwise,
  with the plain line and `checkedAt`); `not_checked` until the first call. **Check models** (Settings › AI) makes one
  tiny real call per model through the agent. The status is shown next to every model in the pickers and above the
  chat box, so the owner sees it before sending. Nothing is shown as available because it is listed.
* **Effort.** `Effort = "low" | "medium" | "high" | "xhigh" | "max"`; each model shows only the levels in its
  `efforts`. **The transport is Bedrock Converse** (`bedrock-runtime` `converse`, and `converse_stream` for the chat),
  on each model's `profile`: the effort is sent as `additionalModelRequestFields = {"output_config": {"effort":
  e}}` and left out when the model's `efforts` is empty (then `effortApplied: false`: "This model has no effort
  setting; it runs at its own level."); thinking stays adaptive (these models reject a thinking budget; it is never
  sent); a schema answer uses Converse's `outputConfig.textFormat` (JSON schema) or a tool with automatic tool choice
  (forced tool choice is refused by these models); usage comes from Converse's `usage` (input, output,
  `cacheReadInputTokens`, `cacheWriteInputTokens`). Converse is authorized by `bedrock:InvokeModel`, ConverseStream by
  `bedrock:InvokeModelWithResponseStream`. A test records the request and checks the effort field is there exactly
  when the model offers it. An effort the model does not offer is **refused, never swapped**: when saved ("Claude
  Haiku 5.5 does not offer Maximum. Pick another level.") and, should one reach a call (for example after the model
  was changed), the call stops with the same sentence.
* **Configuration levels** (precedence from strongest; model and effort are merged **separately**, so a level that
  sets only the effort takes the model from the levels below): (1) a per-request override (a chat message, "Make it a
  full idea", Analyze, a remake; carried on the stored item: `PJOB#.configuration.override`, `TASK#.override`, the
  pending assistant `MSG#.requested`; never saved as a setting); (2) the **conversation's** setting (chat turns) or
  the **project's** (`Story.ai`, `ReferenceVideo.ai`: kept with the video or reference, for its jobs); (3) the task's
  (`tasks[kind]`); (4) the agent's own `model` / `effort`; (5) the workspace default (`defaultModel`,
  `defaultEffort`). The AI configuration is the item `AICONFIG` (§45.3); without it the defaults come from
  `stories/config/models.json`. **One resolver**: the agent's `lamostories_agent.models.resolve` and the API's
  `workspaces/ai_resolve.py` implement the same rules and run the same shared cases (`stories/config/resolve-cases.json`);
  the API returns the effective values (`effective: {model, effort, effortApplied, from}`) on the chat conversation,
  the tasks table and the story, and the web only shows them.
* **Tasks** (`TaskKind`): `chat`, `brainstorm`, `expand_idea`, `variations`, `storyboard`, `scene_rewrite`,
  `character_design`, `reference_analysis`, `fact_check`, `final_review`, `captions`. Each belongs to one agent
  (§45.26). Suggested efforts are shown, never forced: brainstorm medium, reference analysis high, storyboard high,
  scene rewrite high, captions low, fact check and final review high.
* **No silent substitution.** The effective model is the one the levels above name. If its call is refused for
  access, Region, model id or quota, the task or job stops with "Claude Fable 5.2 isn't available right
  now: {reason}. Pick another model in Lamo Stories › Settings › AI, or try again." and an action that opens that
  setting; it never runs on another model. (Ask's refusal fallback model is Clip Factory's and is not used here.)
* **Recorded on every job and message.** Each `PJOB#` (`meta.models`: per step, the model key, effort, `effortApplied`)
  and each assistant `MSG#` stores the effective model and effort, so a job can be reproduced and audited.
* **Usage and cost.** Every model call writes `USAGE#{day}#{id}` (model, task, agent, jobId or conversation, input,
  output, cache-read and cache-write tokens, effort, `effortApplied`, a cost estimate when the model's price is known:
  from `pricing`, or a price the owner typed in Settings › AI, marked as his). Settings › AI shows tokens and cost per
  model and per day for 30 days; a model with no known price shows tokens only ("No price set.").
* **Calls.** One client in the agent (`lamostories_agent/models.py`), `complete(task, messages, tools?, schema?,
  override?)`, resolves the effective model and effort, adds the agent's instructions, the workspace memory (§45.27)
  and **the agent's enabled skills** (Lamo Stories skills only, §45.26) as the first system blocks, sends the request,
  handles `refusal` stop reasons plainly (no automatic fallback model: that would be a silent substitution; the owner
  is told and picks), and writes the usage item.

### 45.26 Agents and skills (Lamo Stories' own)

* **Agents** (`AGENT#{agentId}`; built-ins from `stories/config/agents.json`, created on first use, never deleted):

| Agent | Tasks | Does |
|---|---|---|
| `creative_director` | chat, brainstorm, expand_idea, variations | the creative chat; ideas and concepts |
| `video_analysis` | reference_analysis | watches reference videos (§45.28) |
| `storyboard` | storyboard, scene_rewrite, captions | writes and rewrites story scripts and post captions |
| `character` | character_design | suggests a character's rig, faces and moves from words or a reference picture |
| `quality_assurance` | fact_check, final_review | the safety check (§45.11.5) and a last look at every finished video |

  Each has: `name`, `instructions` (the default from the file, editable; **Reset** restores it), `active` (an inactive
  agent's tasks stop with "{Agent} is switched off. Switch it on in Lamo Stories › Settings › Agents."; the quality
  agent's fact check cannot be switched off for driving-safety stories), `model` and `effort` (or "Workspace
  default"), `skillIds` (its skills, in order), `version`.
* **Skills** (`SKILL#{skillId}`, files in `ws/{u}/{ws}/skills/{skillId}/{revisionId}/SKILL.md|skill.zip`): upload a
  `SKILL.md` (≤ 1 MB) or `.zip` (≤ 20 MB), or write one in the app (title, when to use it, instructions); every save is
  a new **version** (the last 10 kept, any can be restored); **enable / disable**; **assign** to agents. Built-in
  Lamo Stories skills ship in `stories/skills/` (`nonverbal-storytelling`, `driving-safety-teaching`,
  `vertical-short-hooks`), read-only but can be disabled or unassigned. An agent's prompt gets exactly its enabled,
  assigned skills, in its order; Clip Factory's skills never.

### 45.27 Creative chat, conversation history and memory

* **Chat** (`/stories/chat`, and from every page's chat button): conversations (`CONV#{convId}`: title, model and
  effort for this conversation or "default", the project it is about: an idea, story, character or reference video,
  `updatedAt`) and their messages (`MSG#{convId}#{msgId}`: role, text, attachments (pictures ≤ 5 MB, under
  `ws/…/chat/{convId}/`), the effective model and effort, `effortApplied`, usage, status `pending | streaming | done |
  failed`, and `actions`). Above the box the chat always shows **Model: Claude Opus 5.5 · Effort: High** (the
  effective values); tapping either changes the conversation's setting; **Just for this message** sends an override
  that is not saved.
* **Sending** (`POST …/chat/{convId}/messages`) writes the user message and an assistant message `pending`, then asks
  the Lamo Stories agent (`chat_turn`) to answer; the agent writes the text into the assistant message as it streams
  (at most every 0.5 s) and the web polls every second while one is `streaming`. The creative director runs a tool
  loop with Lamo Stories tools only: list and read ideas, characters, stories and reference analyses; create or update
  an idea; propose a character (a draft the owner saves); propose a storyboard change; `remember` (§ memory); and
  **actions** it cannot do itself, returned as buttons the owner taps (Make the video, Remake this scene, Analyze this
  reference video, Save this character): each button calls the normal route, so nothing happens without the owner's
  tap.
* **History** stays with each conversation (rename, delete); long conversations are compacted by the agent (summary
  kept as a system note) and the full messages stay readable.
* **Memory** (`MEM#{memId}`: text ≤ 300 chars, source `chat | owner`, `createdAt`): facts and preferences the creative
  director saves with `remember` ("Lamo likes slapstick endings") and the owner adds, edits or deletes in Settings ›
  Memory; every Lamo Stories agent gets the memory list (≤ 50 items, newest first) after its skills. Clip Factory has
  no access to it.

### 45.28 Reference videos

`REFVID#{refId}`: the owner uploads a video (MP4 or MOV, ≤ 2 GB, ≤ 10 minutes; presigned multipart PUT to
`ws/…/references/{refId}/source.{ext}`), names it, and taps **Analyze**. The `video_analysis` agent (a job of type
`reference_analysis`, its own step track: Look at it, Listen, Write it up) extracts frames (2 per second, up to 600)
and loudness with ffmpeg, sends them in batches with their times to its model (vision), and writes `analysis`: what
happens shot by shot, the hook and its timing, pacing (cuts per 10 s), the gags and how the characters act without
words, sound design (effects, music, silence), caption style, what to borrow and what not to copy (no characters,
logos or footage are copied; only ideas of structure and timing). Stored in S3 (`analysis.json`) and shown on the
reference's page; an idea or story can **use** references (`referenceIds`, ≤ 3), whose analyses the storyboard agent
reads. Links to other people's videos are not downloaded in this section (Lamo Stories' agent has no downloader);
the page says "Upload the video file."

### 45.29 Setup, onboarding and settings (Lamo Stories' own)

* **Onboarding** (`ONBOARD` item: `stepsDone`, `skipped`, `finishedAt`): shown the first time Lamo Stories opens,
  and from the dashboard until finished; every step can be skipped and done later; a ring shows "4 of 11 done" and the
  list of what is left. Steps: 1 Set up the AI (what Lamo Stories uses and why), 2 Pick your default model (with
  **Check models**), 3 Pick your default effort, 4 Pick how videos are made (the video provider, §45.31), 5 Meet your
  agents and skills, 6 Connect Instagram, 7 TikTok, 8 YouTube, 9 Facebook, 10 X (each through Social Accounts, §45.13
  and §45.30), 11 Done (confetti). Making videos never waits for the social steps.
* **Settings sections** (`/stories/settings/{section}`):
  * **AI**: default model and effort; each agent's and each task's model and effort; providers and their state; API
    keys for providers that need one (§45.31; stored in Secrets Manager, shown only as "saved · ends 4f2a"); **Check
    models**; usage and cost for 30 days; prices the owner types for models with no known price.
  * **Agents**: each agent's instructions (edit, Reset), on/off, model, effort, skills (assign, order).
  * **Skills**: list, upload, write, versions (restore), enable/disable, which agents use each.
  * **Memory**: the memory list (add, edit, delete).
  * **Social accounts**: §45.16.7's Connections page.
  * **Video**: the video provider and its model; resolution `1080×1920` (the built-in animator's only size); aspect
    ratio `9:16` (1:1 and 16:9 are listed as "not with the built-in animator yet"); default length (15–90 s, 30–60
    suggested); quality (`standard` CRF 23, `high` CRF 20, `best` CRF 17); frame rate "30 fps (the built-in
    animator's only rate)"; provider keys; usage (render minutes per day, provider cost where known).
  * **Storage and production**: storage used (videos, scenes, audio, references, skills; from the `ASSET#` and
    `REFVID#` sizes), output format (MP4, H.264 and AAC, `+faststart`), captions burned in or not, scenes rendered at
    a time (1–3), keep old versions (all, or the last 1–10 per story: older files are deleted when a new version is
    made).
* Everything above belongs to the Lamo Stories workspace; none of it is read by Clip Factory.

### 45.30 Developer apps: Lamo Stories' own, or Clip Factory's on purpose

For each platform the Social Accounts page asks once, **before the first Connect**, which developer app (OAuth client)
Lamo Stories uses, and shows the choice on the card:

* **Use a separate app for Lamo Stories (fully separate)**: the owner makes a second developer app on the platform
  (the same steps as Clip Factory's guide, linked, with the differences listed: its own name and Lamo Stories' own
  redirect URI `{storiesCallbackBase}/{platform}/callback`, shown with a Copy button), pastes its keys in Lamo Stories (`PUT …/social/{platform}/app`, stored
  in `cf-prod/workspaces/{ws}/{platform}/app`, the same formats and **Check it** as §17.4). Quotas, credits and app
  reviews are then separate too (TikTok's and Meta's reviews take days to weeks for a new app; X needs its own
  credits).
* **Use Clip Factory's app (quicker)**, offered for **YouTube, TikTok and X only**: no new app; Lamo Stories still
  gets its **own authorization and tokens** (never Clip Factory's), for a different platform identity, so Clip
  Factory's grant is not touched; it shares that app's quotas, credits and review state. **Facebook and Instagram
  always use Lamo Stories' own Meta app**: Meta's page picker belongs to one login and one app, so authorizing Clip
  Factory's Meta app again would change Clip Factory's existing grant (the second request forbids that). `PUT
  …/social/{instagram|facebook}/app {choice:"clips"}` is `400`; one own Meta app's keys serve both Instagram and
  Facebook (entered once). A new Meta app in Development mode lets its admin (the owner) connect his own Pages and
  Instagram account; going Live needs Meta's App Review.
* Never a silent default and never a fallback: with neither chosen, Connect asks; a chosen app whose keys are missing
  stops with "Paste your Lamo Stories {Platform} app keys first." **One helper picks the keys**:
  `workspaces/apps.py: app_keys(store, secrets, user_id, ws, platform)` reads `SOCIAL#{platform}.app.choice`: `own` →
  `cf-prod/workspaces/{ws}/{platform}/app`; `clips` → `cf-prod/platforms/{platform}/app` (read only; not for Meta);
  none or a missing secret → "not set up", never a fallback. Connect, the callback's exchange, the token refresh,
  Check, creator info and `validate_destination` use only this helper (`appClientId` on `SOCIAL#` records the client
  id used at connect). The redirect URI follows the choice: Clip Factory's app keeps its registered
  `{oauthCallbackBase}/{platform}/callback`; Lamo Stories' own app registers Lamo Stories' own callback
  `{storiesCallbackBase}/{platform}/callback` (§45.13.3). The `limits` sentences are built per choice.
* The shared limits of §45.14 (the X monthly limit, YouTube units) apply only with Clip Factory's app; with its own
  app Lamo Stories keeps its own counters (`RATE#WS#{ws}#{platform}`) and its own X limit setting.

### 45.31 Video generation (separate from the reasoning models)

Four provider kinds, each picked separately in Settings: **reasoning** (§45.25), **images**, **video**, **audio**.

| Kind | Provider | State |
|---|---|---|
| video | `builtin-2d`: the engine and rasterizer (§45.10–§45.11) | on |
| video | `nova-reel`: Amazon Nova Reel 1.1 on Bedrock, text or image to 6-second shots, used as scene backgrounds or cut-aways | built; needs an S3 bucket in us-east-1 (Nova Reel writes only there), a Terraform switch `stories_video_us_bucket` (off), and the model enabled for the account. Realistic AI footage: a story that uses it is posted only with the platforms' AI labels (§45.14) |
| images | `builtin-rig`, `nova-canvas` | as §45.11.6 |
| audio | `builtin-synth` | on |
| any | a provider with an API key (structure only: `PROVCRED#{providerId}` metadata, the key in `cf-prod/workspaces/{ws}/providers/{providerId}`) | the registry and the key form are built; no external provider is called until one is added in code and checked live |

An LLM is never asked to "make the video": the reasoning models write scripts and prompts; only a video provider makes
pixels. Each job records which providers made it (`PJOB#.meta.providers`).

### 45.32 The second request, point by point, and its acceptance evidence

| Request | Met by |
|---|---|
| 1 independent application, own everything | §45.24 (table), §45.15 (separate Lambda, runtime, IAM) |
| 2 one-click switching, each app remembers its state | §45.16.1 (Clip Factory and Lamo Stories keep their last page; Lamo Stories also its open conversation and project), the server keeps jobs and conversations |
| 3 model selection (view, select, switch, default, per agent, per task, active shown, provider, status) | §45.25, §45.29 AI, the chat header |
| 4 reasoning effort (default, agent, task, chat), only where supported, really sent | §45.25 |
| 5 model and effort in the chat, per-request override, stored with jobs | §45.27, §45.25 "Recorded" |
| 6 setup sections A–F | §45.29 |
| 7 social account setup and isolation | §45.13, §45.14, §45.30 |
| 8 onboarding, skippable, completion indicator | §45.29 |
| 9 separate namespaces and credentials | §45.24, §45.15 |

| # | Criterion | In CI | Live |
|---|---|---|---|
| 1 | Clip Factory unchanged | every old test, the pixel check, `cf-prod-api` and `cf_prod_clip_agent` untouched in the plan | §45.23 #1–#4 |
| 2 | Lamo Stories independent | IAM tests (§45.15), import scans (the stories agent imports nothing of `clipfactory_agent`; the stories API modules import no Clip Factory route module) | – |
| 3 | One-click navigation | switcher e2e | the Mac app |
| 4–7 | AI configuration, model choice, default, per agent | API and web tests of the config; the agent test that the effective model is the one sent | Check models on the live account |
| 8–10 | Effort, really sent, per request | the agent test reads the request body (`output_config.effort`), `effortApplied` false where not sent | one live call per model (usage item shows the effort) |
| 11 | Video models separate | config and registry tests | – |
| 12 | Its own setup | onboarding e2e | – |
| 13–17 | Connect each platform independently | callback tests per platform | the owner's taps |
| 18 | The right accounts shown | callback tests (name, handle, id) | the owner sees @lamo.stories etc. |
| 19 | Publishing isolated | destination tests, IAM | – |
| 20 | No Lamo Stories setting changes Clip Factory | the IAM tests; a test that runs every Lamo Stories route and job and compares every Clip Factory item and secret before and after | – |
| 21 | Regression | every required check | – |

### 45.33 Details settled by the second review (they win over anything above)

* **Pictures to a model** (`lamostories_agent/images.py: to_model_image(path)`): every picture (chat attachments,
  design references, reference-video frames, final-review frames, portraits) is scaled so its long edge is at most
  1568 px, re-encoded to JPEG about q85 (which also drops EXIF and GPS), stepped down until ≤ 3.5 MB; a picture ffmpeg
  cannot open fails the turn with "I can't open that picture. Try a screenshot or a photo.".
* **Reference analysis steps** (§45.28): (a) one ffmpeg pass at about 360 px wide with scene detection
  (`select='gt(scene,0.3)'`) gives the cut times; code computes `shots[]` and `cutsPer10s`, the model never guesses
  them; (b) frames ≤ 512 px: each shot's start and middle plus a steady `min(2, 600/durationSec)` per second, at most
  600; (c) batches of at most 20 pictures per call (lowered when Bedrock refuses for size), each with its times; (d) a
  final call merges the batches' notes into one `ReferenceAnalysis`; (e) sound notes come from the measured loudness
  and silences only (the model cannot hear; the analysis says so).
* **ModelClient contract** (`lamostories_agent/models.py`): `complete(ctx: CallContext, *, task, messages,
  override=None, schema=None, tools=None, max_tokens=16000, on_text=None) -> Reply`; `CallContext` holds `user_id`,
  `workspace_id`, `agent_id`, the item it works for (`job_id`, `task_id` or `conv_id` + `msg_id`) and the fencing
  `session_id`. `complete` itself resolves the model and effort, builds the system blocks (instructions, skills,
  memory), sends the request, writes `MODELSTATUS#` and `USAGE#`; callers never pass a model or a system prompt.
  `Reply` also carries the raw assistant `content` blocks (for tool loops). It is called from a worker thread, never
  on the event loop.
* **Runner contract** (`lamostories_agent/server.py`): `Runner.spawn(id, session_id, coro)`, `cancel(id)`, `busy()`,
  `shutdown()`; builder E implements it; each of `chat/`, `tasks/`, `reference/` has `register(actions, runner)`,
  called by `build_app` from a fixed list, so builder E2 never edits E's files.
* **Prices**: `stories/config/models.json` carries Anthropic's own list prices for reference (`source:
  "anthropic_list"`, `note: "Anthropic's own price. Amazon Bedrock bills its own price, which can differ."`), with
  cache read prices and Haiku 5.5's long-context price; the owner can replace any with Bedrock's (`source: "owner"`).
  Provider usage (Nova Canvas images, Nova Reel seconds, built-in render seconds) is recorded the same way, priced
  only when a price is known.
* **The quality agent switched off**: the toggle explains "Driving-safety videos are always checked." For other
  stories its checks record `safety.status = "skipped"` ("Quality check is off"), which Approve accepts; a
  driving-safety story still runs the fact check whatever the toggle says.
* **Onboarding done-states** come from real state where they can: a saved AI configuration (steps 1–3), a provider
  picked (4), each platform's `SOCIAL#` connected (6–10); only 5 and 11 are ticked by hand.
* **The character agent's vocabulary**: the engine's `CATALOG` gains the look and voice choices (`looks`: body, hair
  styles, eyes, brows, nose, mouth, patterns, accessories, voice styles), so `cli.ts catalog` gives the character
  agent its schema and `validateScript`/a character check validate its answer.
* **Workspace defaults** live in one file, `stories/config/workspace-defaults.json` (StoriesConfig's defaults), read by
  the API's guard and checked by a web test against `StoriesConfig`.
* **The separation test's allowed exceptions** (§45.19): reads of five `ACCOUNT#` attributes, the YouTube, TikTok and X
  app-key secrets and the OAuth state key; `RATE#{platform}` writes only for the shared-app choice. Nothing else of
  Clip Factory is read or written. §45.32 #20 counts the shared-app choice's shared budget as the owner's own choice.
* **Social accounts page**: each card shows the platform's logo mark (the same marks Clip Factory's setup uses).
