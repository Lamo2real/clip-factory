## 24. Follow creators: names, live badges and noticing finished streams (owner request, 2026-11-18)

The owner asked to be "kind of just spectating": add YouTubers, Twitch and Kick streamers, see their names and
whether they are streaming and where, and once they finish a long stream, start the same process as a pasted link.
This section is **part 1**: following, names, platform marks, live badges, webhooks, the permission question and the
settings. Clip Factory **notices** finished streams and new uploads (WATCH items) but **never starts a job** here;
"making clips by itself" is part 2 (gated on real download tests from AWS). Decision record: DECISIONS.md ADR-44.

### 24.1 API (under the existing `ANY /v1/{proxy+}`, no Terraform)

| Method and path | Body | Answer |
|---|---|---|
| GET `/v1/follows` | – | `{ follows: Follow[], keys: FollowKeySlot[], kickWebhookUrl }` |
| POST `/v1/follows/lookup` | `{ text, platform? }` | `{ needsPlatform: true, name }` for a name alone, else `{ needsPlatform: false, creator: FollowCreator }` |
| POST `/v1/follows` | `{ platform, platformId, permission: true }` | 201 `{ follow }`. 400 without `permission: true`. Following again answers the existing follow. At most 100 follows |
| PATCH `/v1/follows/{platform}/{platformId}` | `{ autoClips }` | `{ follow }`; 404 when not followed |
| DELETE `/v1/follows/{platform}/{platformId}` | – | 204; only this owner's FOLLOW and FOLLOWED items go. WATCH items, the creator item and jobs stay |
| PUT `/v1/follows/keys/{twitch\|kick\|youtube-read}` | `{ clientId, clientSecret }` or `{ apiKey }` | the GET body (masked hints only) |
| DELETE `/v1/follows/keys/{platform}` | – | 204. The secret is overwritten with `{"removed": true}` (never deleted: its old version stays in the history) |
| POST `/v1/follows/keys/{platform}/check` | – | `{ check: { ok, code: ok\|no_keys\|keys_rejected\|platform_down, message, at }, ...GET body }` |

`text` is parsed only (`follow/parse.py`), never fetched: exact hosts `youtube.com`, `www.youtube.com`,
`m.youtube.com`, `youtu.be`, `twitch.tv`, `www.twitch.tv`, `m.twitch.tv`, `kick.com`, `www.kick.com`; http(s) only, no
user info, no port; ids `^UC[\w-]{22}$` (channel), `^@[\w.\-]{3,30}$` (handle), `^[\w-]{11}$` (video, its channel comes
from oEmbed), `^[A-Za-z0-9_]{4,25}$` (Twitch login), `^[A-Za-z0-9_-]{1,25}$` (Kick slug). Only fixed platform API hosts
are then called with the id URL-encoded. The follow is looked up again on POST: names never come from the web.

`Follow`: `followId` (`"twitch:somestreamer"`), `platform`, `platformId` (YouTube `UC…`, Twitch login, Kick slug; lower
case for Twitch and Kick), `handle`, `name` (plain text, at most 100), `avatarUrl` (only https on
`static-cdn.jtvnw.net`, `yt3.ggpht.com`, `yt3.googleusercontent.com`, `files.kick.com` or `*.kick.com`, else ""),
`url`, `autoClips` (default true), `permissionAt`, `followedAt`, `live?` `{ isLive, title?, viewers? (2 significant
figures), startedAt?, checkedAt? }`, `last?` `{ state: "noticed", text: "Stream ended" | "New video", at }`,
`resolved` (false: found by name before the Twitch or Kick keys). `FollowCreator` is the same without the owner
fields, plus `needsKeys`. `FollowKeySlot`: `platform`, `saved`, `needed` (a follow is on that platform), `optional`
(the YouTube read key), `savedAt?`, `hints?`, `check?`.

**Settings** (additive, DEFAULTS plus `_check_field`): `followPaused` (false), `followDailyMax` (0 = no limit, the
owner's default; 1 to 20 when "Limit how many a day" is on; the UI never shows 0), `followMinMinutes` (30, 10 to 240).
Stored now, used by part 2. Hidden constants for part 2: at most 2 automatic jobs at once and 2 per creator a day.

**Keys** live only in Secrets Manager, created at runtime under the existing prefix: `cf-prod/platforms/twitch/app`,
`…/kick/app` (`{clientId, clientSecret}`), `…/youtube/readkey` (`{apiKey}`, a **separate** Google Cloud project, never
the upload app), and `…/twitch/eventsub` (`{secret}`, 64 random hex characters made once when the Twitch keys are
first saved). No Terraform resource holds them.

### 24.2 DynamoDB items (`cf-prod-data`, additive, no new index)

| Item | pk | sk | Fields |
|---|---|---|---|
| Follow | `USER#{u}` | `FOLLOW#{platform}#{platformId}` | `type="follow"`, `followId`, the public fields above, `creatorKeys[]` (§16.12 keys: `<platform>:id:<platformId>` then name keys), `refreshedAt` |
| Reverse index | `FOLLOWED` | `{platform}#{platformId}#{u}` | `userId`, `platform`, `platformId`, `followedAt` |
| Creator | `CREATOR` | `{platform}#{platformId}` | `type="creator"`, `broadcasterId` (Twitch or Kick numeric id), `name`, `handle`, `avatarUrl`, `refreshedAt`, `live`, `liveSince`, `lastOfflineAt`, `wanted`, `subs` (subscription ids), `subsStatus` (`ok`, `repair`, `revoked`, `none`), `subsCheckedAt`, `feedNewest` (YouTube). One per creator, never per follower. One partition, so the tick reads every creator with one Query |
| Noticed video | `WATCH` | `{platform}#{videoKey}#{u}` | `kind` (`stream` or `upload`), `state="waiting"`, `autoMaking=false`, `attempts`, `noticedAt`, `endedAt`, `startedAt`, `publishedAt`, `title`, `durationSec`, `ttl` (14 days). `videoKey`: Twitch `stream:{id}`, YouTube the video id, Kick `{broadcasterId}:{start to the minute}`. Written once (if absent) |
| Follow keys | `USER#{u}` | `FOLLOWKEYS#{platform}` | `savedAt` or `removedAt`, `hints`, `check` |
| Tick lease | `FOLLOWTICK` | `LEASE` | `until`, `repairAt` |
| YouTube meter | `FOLLOWMETER` | `YT#{yyyy-mm-dd}` | `units` (at most 1,000 a day), `ttl` (3 days) |

Live push (§14.2): `FOLLOW#` items become `{ type: "follow", id: followId, item: Follow }` (deletes too). `FOLLOWKEYS#`,
`FOLLOWED`, `CREATOR` and `WATCH` are never pushed.

### 24.3 Detection (`cf-prod-follow-tick`, every 5 minutes, the source of truth)

1. Takes the lease (conditional write); a second run while one holds it does nothing.
2. Reads `FOLLOWED` and `CREATOR` with one Query each (key condition `pk = :pk` only: DynamoDB refuses an empty
   `begins_with` prefix). The time budget (`FOLLOW_TIME_BUDGET_SECONDS`, 90) is checked inside every per-creator
   loop, so a slow platform never runs past the 120 s timeout with the lease still held.
3. **Twitch** (only with keys; app token by client credentials, in memory): Helix `users` for creators without a
   numeric id or older than 7 days (name, picture, id copied to each follower's FOLLOW), `streams` by login (100 per
   call) for the badges, EventSub `stream.online` + `stream.offline` webhooks for creators someone follows (each id saved
   as soon as it exists; a 409 looks up the existing id, so none is leaked), unsubscribed when nobody follows any more;
   hourly, subscriptions that are not `enabled` (or whose id is unknown) are made again, and the app's stream
   subscriptions for broadcasters nobody follows are removed.
4. **Kick** (only with keys): `channels?slug=` (50 per call), `users?id=` for names and pictures,
   `livestream.status.updated` subscriptions, the same repair.
5. **YouTube**: the public `videos.xml` feed per creator (no quota, read with fixed regular expressions, not an XML
   parser). A video published after the follow is noticed (`kind: "upload"`, "New video"). With the read key, the 5
   newest videos are checked with `videos.list` (1 unit per 50) for a live stream, at most 1,000 units a day. A live or
   upcoming video is not noticed as an upload (its end notices it as a stream); `liveBroadcastContent` is stored on
   the WATCH item. A creator whose feed failed, or whose videos did not come back, is never marked offline.
6. **Live state** (`model.apply_live`): written only when live or not, the title or the rounded viewers changed. A
   live → offline change notices the stream (`kind: "stream"`, "Stream ended") for every follower. If the same video
   was already noticed as an `upload`, that WATCH item is moved on to `kind: "stream"` with `endedAt` (conditional, once).

Nothing here starts a job, invokes the job flow or writes `SEEN#`/`AUTODAY#` (part 2).

### 24.4 Hooks and signatures (`cf-prod-hooks`)

`HOOK_PLATFORMS = PLATFORMS + ("twitch", "kick")`; Twitch and Kick are never in `settings.PLATFORMS`, have no GET and
no OAuth callback (404). Every Twitch or Kick POST is checked first; anything unsigned, wrongly signed or more than
10 minutes old is a 401 and nothing is stored.

* **Twitch**: `Twitch-Eventsub-Message-Signature` = `sha256=` + hex HMAC-SHA256(EventSub secret, message id +
  timestamp + raw body), constant-time compare. No secret saved: 401. `webhook_callback_verification` answers 200 with
  the raw challenge as `text/plain`; `revocation` marks the creator `subsStatus: "revoked"` (the tick repairs it);
  `notification` `stream.online` (only `type: "live"`; ignored when it started before the creator's `lastOfflineAt`)
  and `stream.offline` change the live state.
* **Kick**: `Kick-Event-Signature` = base64 RSASSA-PKCS1-v1_5 SHA-256 over `{message id}.{timestamp}.{raw body}`,
  checked against `GET https://api.kick.com/public/v1/public-key` (cached; after a failed check fetched again at most
  once every 10 minutes per container). `livestream.status.updated` changes the live state.
* Stored as `HOOK#{platform}` / `HOOK#{message id}` with `done: false` (if absent, or if an earlier try never
  finished), then rewritten `done: true` after the live change. A repeat of a done message answers 2xx and does
  nothing; a retry after a failed live change (throttle, timeout) is handled again. PutItem only on HOOK#.
* `KEPT_HEADERS` gains the `twitch-eventsub-*` and `kick-event-*` ids, types, timestamps and versions (never the
  signature). YouTube POSTs are stored as before and never acted on.

### 24.5 Web

* Settings › Clip making › **Streamers I follow** (`/settings/clip-making/streamers`, apples `follow-streamer`,
  `streamers-followed`, `clips-by-itself`, `streamer-keys`). A link or a name, then **Find**; a name alone shows big
  **YouTube**, **Twitch** and **Kick** buttons. The card shows the picture (or initials), name, platform mark and LIVE
  badge, then "Did {name} say you can make clips of their videos?" with **Yes, they said I can** (needed before
  **Follow**) and **How do I ask?** (a message to copy). YouTube adds "YouTube does not allow downloading videos without
  permission."
* Each row: picture with a breathing vermilion ring when live, name (opens their page), mark and the platform's name
  written out, **LIVE · 1.2K watching** / **Offline** / **Needs a grown-up** (key icon; the same words as the key
  slot), the stream title, what was noticed, a calm **Clips by itself: coming soon** pill (no switch until part 2:
  `autoClips` is still stored and PATCHable) and **Remove** (Undo for 5 seconds; the delete is sent after). Live first.
* **Clips by itself**: "Coming soon" note, **Stop all automatic clips**, **Limit how many a day** (off = no limit; on
  shows a 1 to 20 stepper, starting at 3), **Shortest video** (10 min, 30 min, 1 hr, 2 hr), and "each video costs the
  same as one you paste".
* **Twitch and Kick keys**: a slot appears once someone on that platform is followed: "Ask a grown-up to finish Twitch
  setup", **I am the grown-up** opens the steps and the two boxes (Kick adds the webhook address as a Copy chip).
  Saved keys show masked hints, **Check it** and **Remove keys** (a sheet with **Hold to remove**). The YouTube read key
  is optional.
* Home: a **Your streamers** row, only when following someone, live first with a LIVE tag (top-left, never over the
  platform mark) and "Live on Twitch" under the name (the platform is always written); a tap opens the branch.
* Mock: `mock/follows.ts`; knobs `window.__cfMock.follows.{seed, setLive, endStream, newVideo}`. Twitch keys are
  "saved" in the mock, Kick keys are not.
* Update notice area label: "Follow creators".

### 24.6 Terraform (additive: 0 destroy, 0 replace)

* `stats` module: new `follow-tick` key in `local.functions` (`clipfactory_api.follow.tick.handler`, 256 MB, 120 s,
  env `TABLE_NAME`, `SECRET_PREFIX`, `HOOKS_URL`, `FOLLOW_TIME_BUDGET_SECONDS=90`, async retries 0), rule
  `cf-prod-follow-tick` at `rate(5 minutes)` with `retry_policy.maximum_retry_attempts = 0`, its permission; IAM
  GetItem/PutItem/UpdateItem/Query on the table (no DeleteItem, no Scan) and GetSecretValue on `…/twitch/*`,
  `…/kick/*`, `…/youtube/readkey*` only. No reserved concurrency (the account cannot reserve any): the lease stops
  overlaps. New variable `hooks_url` (default ""), wired from `module.hooks.hooks_url`. Monitoring picks the function and
  rule up through `function_names` and `schedule_rule_names` (two new alarms).
* `hooks` module: statement `FollowItems` (GetItem, PutItem, UpdateItem, Query on leading keys `FOLLOWED`, `CREATOR`,
  `WATCH`, `USER#*`) and `TwitchEventSubSecret` (GetSecretValue on `…/twitch/eventsub*`). The existing 10 rps / 20 burst
  stage throttling covers `/hooks/*`.
* `realtime`: `stream_filter` gains `{ prefix = "FOLLOW#" }` (in place on the event source mapping).
* `cf-prod-api` needs no change: it already creates and puts secrets under `cf-prod/platforms/*`.

### 24.7 Who builds what

Part 1 (this): everything above. Part 2: readiness rules per platform, `create_job` refactor writing `SEEN#` on every
job, the queue (2 at once), the per-creator cap, the daily limit from `followDailyMax`, review-only posting with a
credit line, the agent's creator key merge and `curl_cffi`, the cost notice metric, after the release-gate downloads.
Optional part 3: YouTube WebSub push.

### 24.8 Tests

`api/tests/test_follows.py` (parsing and SSRF, avatars, viewers, creator keys, Twitch HMAC good/bad/stale and the
verification echo, Kick RSA with a throwaway key and the refetch limit, webhook fan-out and noticing, revocation,
routes and keys, settings ranges, the tick for Twitch, YouTube and the lease, the YouTube meter, the live push);
`web/test/follows.test.ts`; `web/e2e/follow.spec.ts`; Terraform `stats.tftest.hcl` (follow tick), `rest.tftest.hcl`
(follow IAM), `websocket.tftest.hcl` (filter), `envs/prod/tests/wiring.tftest.hcl`. See TESTING.md.
