## 47. Your Mac posts it on TikTok (owner request, 2026-11-22)

The owner (2026-11-22, verbatim): "can you create a automation for my mac so everytime the clip factory wants upload to
all platforms it saves the video to my downloads and then goes into tiktok and uploads it there for me, then deletes
the video from downloads", and "i should also be able to do that on demand by clicking upload on the red button that i
marked [Upload to 4], so that will essentially upload to all social media platforms and invoke the automation ...
upload to tiktok". Shown the risks first (TikTok's rules on automation, possible 0-view reach, CAPTCHAs, plan note
`tiktok-mac-automation-plan.md`), he answered "Full auto, 3-post trial", and for clips already waiting "Send them too"
(oldest first, one every 30 minutes, after the trial). That is his explicit new go that amends §46.1 rule 2.
Decision record: ADR-83.

The Mac helper (its own PR, `mac/tiktok-helper/`) drives TikTok Studio in a background Chrome profile on his Mac. This
section is Clip Factory's side only: a TikTok post that waits for the Mac, the routes the helper uses, and what the
owner sees. **No Terraform, table, index, secret or bucket change**: every route is under `ANY /v1/{proxy+}`, every
field is additive, and existing clips and posts read exactly as before. With the switch off, everything behaves
exactly as before. Nothing here calls TikTok's posting API.

### 47.1 Data

* **Settings** `tiktokMac: { on: boolean }`, default `{on: false}`, merged on PUT like `autoPost` (§46.3). Unknown
  keys → 400 "tiktokMac has a setting Clip Factory does not know." A stored value that no longer validates reads the
  default.
* **Helper item** `pk USER#{userId}`, `sk MACHELPER`, `type="machelper"`: `seenAt`, `state` (`ok` | `needs_you` |
  `paused`), `reason?` (a plain sentence, at most 200 characters), `version?`, `device`, `login?` (§47.8). Written by
  the ping and by a stop with `needsYou`; the owner's Try again and It's on TikTok on the stopped post turn
  `needs_you` back into `ok` (`tiktok_self.clear_needs_you`: `SET state = ok REMOVE reason, needsYouClipId`).
  Round 3 (2026-11-23) adds, every one additive:

  | Field | Type | Who writes it | Public in `MacHelper` |
  |---|---|---|---|
  | `needsYouClipId` | clip id | `tiktok_mac.stopped(..., needs_you=True)` (the same write that sets `needs_you`) | `needsYouClipId?` |
  | `backlogAt` | ISO | ping (`backlogAt`, the helper's `plan.backlogAt`: when the first backlog clip goes); a ping without it removes it | `backlogAt?` |
  | `holdBefore` | ISO | ping (`holdBefore`, the helper's `holdAutoBefore`); a ping without it removes it | `holdBefore?` |
  | `backfill` | `true` | ping (`backfill: true`); a ping without it (or `false`) removes it | `backfill?: true` |
  | `resumeRequestAt` | ISO | the owner's `POST /v1/tiktok/mac/request {action: "resume"}`; removed by a ping whose `resumeDone` equals it | `resumeRequest?: {at}` |
  | `letGoRequestAt` | ISO | the owner's `POST /v1/tiktok/mac/request {action: "let_go"}`; removed by a ping whose `letGoDone` equals it | `letGoRequest?: {at}` |

  `needsYouClipId` is also removed by any ping whose `state` is not `needs_you`.
* **Mac post**: the clip's one TikTok post (one per clip, as everywhere) with the new **`status: "mac"`** (added to
  `Post.status`). It is never `queued` or `pending_integration`, so no path that sends posts through TikTok's API ever
  touches it (§47.6). Internal attributes: `macState`, `macStep`, `macSince`, `macSource`, `macClaimedAt`,
  `macPressedAt`, `macStoppedAt`, `macReason`, `macBeatAt` (the job's own beat: the claim, every step and every
  re-sent step; public as `mac`, `beatAt` since round 3), and `macDevice`, `macAttempt` (claims so far),
  `macPressedBefore` (round 3: Try again re-waited a post whose Post was pressed, and its `macPressedAt` moved here),
  `macAgainAt` (round 3: when the owner's Try again re-waited a stopped or stuck post; both reach the helper only in
  `MacJob`, for its never-twice guard, §47.6), `beforeMac` (a Clip Factory TikTok post's fields before it was handed over, for Take it
  back), `madeForMac: true` (the post was created for the Mac, so Take it back deletes it). Its `postOptions` hold the
  TikTok sheet's shape (§17.8: `privacyLevel`, `disableComment`, `disableDuet`, `disableStitch`, …): what the Mac
  sets. **Every Mac post (upload, auto and sent) stores My settings' TikTok choices** (`tiktok_mac.preset_options`:
  `PUBLIC_TO_EVERYONE` with Comment, Duet and Stitch on, never Branded content), whatever Upload's TikTok sheet sent:
  before TikTok approves the app the sheet offers only Only me, and his Mac posts for everyone. A Mac post never
  carries `campaignId`: **no campaign clip ever gets one** (round 3, D1, §47.2).
* **Clip** `tiktokForMac` (internal): the id of a TikTok post Send these to my Mac created, next to §42's `tiktokByYou`.
* **After the Mac posts it**: the post becomes `posted`, `by: "you"`, with the public **`via: "mac"`**, through
  `tiktok_self.mark_posted`'s conditional write, and loses every `mac*` field and `beforeMac`/`madeForMac`. Its
  `privacy` follows the stored `privacyLevel` (`public` only for `PUBLIC_TO_EVERYONE`, which every Mac post holds;
  otherwise `private`, never joining the stats poller). Undo (`DELETE …/tiktok/posted`) of a `via: "mac"` post → 409 "Your Mac posted this one. To
  take it down, delete it in TikTok."

```ts
type MacStep = "video" | "opening" | "uploading" | "settings" | "pressing" | "finding";
interface PostMac { state: "waiting" | "working" | "stopped"; step?: MacStep; since: string;
                    source: "upload" | "auto" | "sent"; claimedAt?: string; pressedAt?: string; stoppedAt?: string;
                    reason?: string; beatAt?: string /* round 3: macBeatAt, for the stuck rule */ }
// Post.status adds "mac"; Post.mac?: PostMac (only while status is "mac"); Post.via?: "mac".
// PerfStatus adds "mac"; PlatformPerformance.mac?: PostMac and .via?: "mac" (§16.2). Settings.tiktokMac (above).
// AutoPostStatus.macPlaces: Platform[] (§46.9).
interface MacHelper { seenAt: string; state: "ok" | "needs_you" | "paused"; reason?: string; version?: string;
                      login?: "saved" | "none"; loginRequest?: { action: "change" | "forget"; at: string };
                      // round 3:
                      needsYouClipId?: string; backlogAt?: string; holdBefore?: string; backfill?: true;
                      resumeRequest?: { at: string }; letGoRequest?: { at: string } }
interface MacJob { clipId: string; postId: string; hook: string; caption: string /* captions.tiktok */;
                   fileName: string /* videoFileName(hook) */; privacy: string; comment: boolean; duet: boolean;
                   stitch: boolean; source: "upload" | "auto" | "sent"; since: string;
                   state: "waiting" | "working" | "stopped"; step?: MacStep; claimedAt?: string; pressedAt?: string;
                   attempt: number /* macAttempt: the claims so far */;
                   beatAt?: string; pressedBefore?: string; againAt?: string /* round 3 */ }
type MacRequestAction = "resume" | "let_go";
// AutoPostStatus.tiktokYourself[].mac?: true (his Mac's post, listed while the switch is off, §47.2; still served,
// unused by the web since ADR-86).
```

### 47.2 Where Mac posts come from

Upload and auto-posting write the Mac post in the same transaction as the clip's other posts
(`posts.create_for_clip`'s explicit `tiktok_mac` path, through `uploads.upload_review_clip`), never afterwards.

1. **Upload** (`routes/clips.confirm` → `uploads.upload_review_clip`): the TikTok post is written as a Mac post
   (`source: "upload"`, `madeForMac`) instead of `queued` when all hold: `"tiktok"` is among the chosen places;
   `settings.tiktokMac.on`; TikTok has not approved the app (`tiktok_mac.tiktok_audited`, the server twin of the web's
   `tiktokAudited`: `app_review` and `posting_audit` not both `ok`); the clip is not a campaign clip. **A campaign
   clip never gets a Mac post** (round 3, D1, ADR-86; `uploads._mac_source` returns None for it): the helper can't set
   TikTok's Branded content disclosure yet, and the Mac's done never reaches Content Rewards, so the post could not
   earn and would break TikTok's rules. Before TikTok approved the app Upload with TikTok refuses a campaign clip (400
   "Campaign clips skip TikTok for now: your Mac can't mark them as Branded content yet. Turn TikTok off, then tap
   Upload.", §38.14 `_place_refusal`); once approved its TikTok goes through TikTok's API as before (`queued`, the
   sheet's Branded content). All other campaign checks stay. The `tiktok` body stays required ("Pick who can see it on TikTok.") and is checked as before, but
   the post's `postOptions` are My settings' choices (§47.1); `uploadTo` names TikTok (he chose it). Upload's API TikTok rule (`queued`, the refusals) is
   otherwise unchanged, and exactly as before with the switch off or once TikTok approved the app.
2. **Auto-posting runs** (`autopost/run.py`, live mode only): with `tiktokMac.on`, a clip (never a campaign clip,
   round 3) also gets a TikTok Mac post (`source: "auto"`) through `upload_review_clip(..., tiktok_mac=True)`; its options are My
   settings' (§36: Everyone, Comment, Duet and Stitch on). TikTok is **not** added to the run's places (`uploadTo` never
   names it). Practice and Private test runs never make one ("Nothing gets sent"). `GET /v1/autopost`: `leftOut` drops
   TikTok while on, `macPlaces: ["tiktok"]` (else `[]`; also `[]`, with TikTok back in `leftOut`, when no other place is
   set up: such a run sends nothing, §46.6), and `tiktokYourself` drops clips whose TikTok post is a Mac post (any
   state) or was posted `via: "mac"`, except while **Your Mac posts TikTok is off**: then a clip whose Mac post waits or
   stopped (not working, Post never pressed) is listed again with `mac: true` (the web offered Post it yourself instead
   on it until ADR-86; it no longer shows the list). **Off switch** ("While it is off, nothing posts"): while
   `autoPost.on` is false, no Mac post with `source: "auto"` goes on before Post is pressed. It is left out of the queue
   (waiting, or working with no `macPressedAt`) and every claim of it is refused ("Auto-posting is off, so this one
   waits."). A step from a Mac that claimed it before auto-posting went off is refused the same way and puts it back to
   `waiting` (claim, device, step and heartbeat removed), so a sleeping or crashed Mac can never carry it on to Post.
   One whose Post was already pressed stays in the queue, so its Mac can still find the link. The app shows "Waiting for
   your Mac · auto-posting is off" with Turn on (§47.4); a stopped one's Try again (`now: true`) makes it `upload`, so
   it goes even then. In Recent (§46.2 item 8) a run's Mac post reads "TikTok (your Mac)" while it waits or works and
   "TikTok (your Mac stopped)" when stopped (`runs[].clips[].posts[].mac`: its `macState`).
3. **Send these to my Mac** and a row's **Post with my Mac** (`POST /v1/tiktok/mac/send {clipIds: string[] 1–25,
   now?: boolean}` → `{results: [{clipId, sent, reason?}]}`, in order, each id once; 409 `MAC_OFF` while the switch is
   off; `now` must be a boolean, else 400). A clip goes when it is not on TikTok yet (the web's `canSendToMac`):
   uploaded, its TikTok not out for everyone, not `by: "you"`, not `queued`, not a Mac post already; never a Private
   test and **never a campaign clip** (`routes/clips.campaign_clip(...)` is not None → `{sent: false, reason:
   "Campaign clips skip TikTok for now: your Mac can't mark them as Branded content yet."}`, `tiktok_mac.SEND_CAMPAIGN
   = CAMPAIGN_SKIPS`, checked right after "still starting", with and without `now`; nothing written). **`now`** (additive, ADR-86): Settings' bulk Send these to my Mac sends no `now`, so its
   posts are `source: "sent"`, the backlog (one after each auto-posting run, §47.8); a row's Post with my Mac sends
   `{clipIds: [clipId], now: true}`, so its post is `source: "upload"` and the Mac posts it at once and first, as after
   an Upload tap. The refusals and race guards are the same either way. A clip with no TikTok post gets a new Mac post (`madeForMac`, appended to
   `postIds`, its id in the clip's `tiktokForMac`), written only while the clip has neither `tiktokForMac` nor
   `tiktokByYou`: two sends, or a send and It's on TikTok, never make two posts (It's on TikTok's new-post write also
   needs `tiktokForMac` absent). A Clip Factory TikTok post that waits for setup, failed or went up privately is handed
   over in place: its fields (status, link, ids, stats and `gsi2` fields, what was learned, `postOptions`,
   `publishHandle`) go into `beforeMac`, so it also leaves the stats poller. `source: "sent"` (`"upload"` with `now`),
   My settings' options. The clip's status follows the clip flow's settle rule (a failed clip whose only failed post was TikTok's becomes
   `confirmed`). Reasons: "Upload this clip first.", "This clip is still starting to upload. Try again in a minute.",
   "This was a Private test, so it stays off TikTok.",
   "This clip is still uploading to TikTok. Wait until it is done, then try again.", "You already posted this one on
   TikTok.", "This clip is already on TikTok for everyone.", "Your Mac already has this clip.", "We could not find
   that clip.", "This clip just changed. Try again.", "Campaign clips skip TikTok for now: your Mac can't mark them as
   Branded content yet." (the server's words).
4. **Take it back** (`DELETE /v1/clips/{clipId}/tiktok/mac` → `{clip, posts}`): only while `mac.state` is `waiting` or
   `stopped` and the Mac never pressed Post. A `madeForMac` post is deleted and leaves `postIds` (and
   `tiktokForMac`); a handed-over post gets `beforeMac` back. The post and the clip (its settle rule) are **one
   transaction** (`db.delete_request` / `Store.transact(deletes=…)`), conditional on the post's state and
   `macPressedAt` absent; a clip that changed meanwhile is read again, at most 3 times. Working → 409 "Your Mac is
   posting it right now. Wait a minute."; `macPressedAt` set → 409 "Your Mac may have posted it already. Check your
   TikTok first." (the restored post could otherwise go out through TikTok's API and make two copies; his ways out
   are It's on TikTok, allowed while stopped, and Try again with `notOnTikTok` after the find window); not a Mac post → 409 "Your Mac isn't
   posting this clip." The route stays; the web called it from Post it yourself instead until ADR-86 and no longer
   calls it.

### 47.3 The helper's routes (JWT: the helper signs in as the owner)

| Method & path | Body | 2xx |
|---|---|---|
| GET `/v1/tiktok/mac` | – | `{ on, helper: MacHelper \| null, queue: MacJob[] }` |
| POST `/v1/tiktok/mac/ping` | `{ state: "ok" \| "needs_you" \| "paused", reason?, version?, device, login?: "saved" \| "none", loginDone?, backlogAt?, holdBefore?, backfill?, resumeDone?, letGoDone? }` | `{ on }` |
| POST `/v1/tiktok/mac/send` | `{ clipIds, now?: boolean }` | `{ results }` |
| POST `/v1/tiktok/mac/login` | `{ action: "change" \| "forget" }` | `{ helper }` (§47.8) |
| POST `/v1/tiktok/mac/request` | `{ action: "resume" \| "let_go" }` | `{ helper }` (the owner's Start my Mac again and Let them go, round 3) |
| POST `/v1/clips/{clipId}/tiktok/mac/claim` | `{ device }` | `{ job: MacJob }` |
| POST `/v1/clips/{clipId}/tiktok/mac/step` | `{ device, step, attempt? }` | `{ job: MacJob }` (a re-sent step is the beat) |
| POST `/v1/clips/{clipId}/tiktok/mac/done` | `{ device, link? }` | `{ clip, posts, note? }` |
| POST `/v1/clips/{clipId}/tiktok/mac/stopped` | `{ device, reason, needsYou?: boolean }` | `{ job: MacJob }` |
| POST `/v1/clips/{clipId}/tiktok/mac/retry` | `{ notOnTikTok?: true, now?: boolean }` | `{ clip, posts }` (the owner's Try again) |
| DELETE `/v1/clips/{clipId}/tiktok/mac` | – | `{ clip, posts }` (Take it back) |

Unknown body keys → 400 everywhere; `device` is required text (at most 100 characters); a clip that is not the
caller's → 404 "We could not find that clip." `MAC_OFF` is "Your Mac posting is off. Turn it on in Settings › Posting ›
Your Mac posts TikTok."

* **Queue:** empty while the switch is off. Else the Mac posts that are `waiting` plus the `working` ones (a restarted
  helper sees its own), minus `source: "auto"` ones whose Post was not pressed while `autoPost.on` is false (§47.2). Order: `source: "upload"` first,
  then the rest; oldest `since` first, then the oldest clip (`decidedAt`); at most 50. `caption` is the clip's stored
  TikTok caption, repaired as §5 says and in NFC; `fileName` is the web's `videoFileName(hook)`; `privacy` and the
  three switches come from the post's options.
* **Ping:** writes the helper item (`seenAt` now) and answers `on`. State other than the three → 400. Round 3 adds
  `backlogAt?` and `holdBefore?` (text of at most 40 characters that `clock.parse` reads, else 400 "backlogAt must be
  a time." / "holdBefore must be a time."), `backfill?` (`validate.boolean`, 400 "backfill must be true or false."),
  `resumeDone?` and `letGoDone?` (text, at most 40 characters, like `loginDone`). They are stored as §47.1 says: a key
  left out of the ping removes the stored value, a `state` other than `needs_you` removes `needsYouClipId`, and each
  `…Done` removes its own request only while it still equals the stored `at` (a conditional `REMOVE`: a newer request
  stays, and `resumeDone` never removes a let-go request). Unknown keys still 400. The helper sends them only on the
  first ping of a tick and falls back to the bare check-in on a 400 (an older server).
* **Request** (`POST /v1/tiktok/mac/request {action}` → `{helper}`, round 3, D5): the owner's **Start my Mac again**
  and **Let them go**; the helper reads `resumeRequest` / `letGoRequest` on its next tick (right after its `GET`),
  unpauses (and ends the trial pause) or clears its hold, and says so with `resumeDone` / `letGoDone`. One
  conditional write: unknown key → 400 (`validate.only_keys`); `action` not one of the two → 400 "Pick resume or
  let_go."; no helper item → 409 "Your Mac hasn't checked in yet. Set it up on your Mac."; `resume` while `state` is
  not `paused` → 409 "Your Mac isn't paused."; `let_go` while there is no `holdBefore` → 409 "Your Mac isn't holding
  any clips."; ok → `SET resumeRequestAt = now` or `SET letGoRequestAt = now`, logged `tiktok_mac.request` with the
  action. It never touches `needs_you` (only the owner's answer on the stopped clip clears that).
* **Claim:** one conditional write. It succeeds when `status = mac` and either `macState = waiting` with **no
  `macPressedAt`** (round 3), or `working` with no `macPressedAt` and `macBeatAt` older than 15 minutes
  (`STALE_CLAIM`: a crashed helper). It sets `working`, `macClaimedAt`,
  `macDevice`, `macBeatAt`, `macStep: "video"` and `macAttempt + 1` (the job's `attempt`). Anything else → 409 "Another try already has this
  clip."; not a Mac post → 409 "Your Mac isn't posting this clip."; switch off → 409 `MAC_OFF`. A post with
  `macPressedAt` is **never** claimed again by itself, whatever its state: never twice. A claim keeps
  `macPressedBefore` and `macAgainAt`; the job carries `beatAt`, `pressedBefore` and `againAt` when set.
* **The attempt:** `step`, `done` and `stopped` take an optional `attempt` (a whole number from 1). When sent it must
  equal `macAttempt`, else 409 "Another try already has this clip.", so an older attempt of the same device (which
  took back its own stale claim) is never taken for the new one; the writes are conditional on it too.
* **Step:** only from `macDevice` while `working` (409 "Another try already has this clip." otherwise; an unknown step
  → 400). It sets `macStep` and `macBeatAt`; `pressing` also sets `macPressedAt` (the first press is kept), the point
  of no return, and only that first press logs `tiktok_mac.pressing`. **The same step sent again is the job's beat**
  (round 3, D2): the helper re-sends the last step the server acknowledged every minute (`BEAT_EVERY_MS`) while it
  works on the job, and `finding` for each of its pressed jobs still in the find window (also while it looks for one
  of them, doFind, which beats only once its frame is up: review round 3); every refusal still holds
  (another device, the switch off before Post, auto-posting off before Post puts it back to waiting). While the switch is off a step before Post → 409 `MAC_OFF` (the owner's "Your Mac stops at once");
  after Post the helper may still look for the link. Each step reaches the web live: post item changes stream as post
  events (§14.2, `POST#` is in the broadcast filter) with the public `mac`.
* **Done:** from `macDevice`, while `working` or `stopped` (409 otherwise). It runs `tiktok_self.mark_posted` on the
  row (`mac=MacDone(device, attempt)`), so the one-post-per-clip rule and the `tiktokByYou` race guard stay as they are: the same write
  sets `via: "mac"` and removes the Mac fields, conditional on `macDevice` and the state. `link`: read by
  `tiktok_link.resolve`, as in It's on TikTok (§42.2, the same `note` for another account). No link: the §42 finder, with
  `since = macClaimedAt − 1 minute`; nothing found still saves it without its link with `NOT_FOUND_YET` (the Mac
  knows it posted; only the owner's Find it for me never saves without a link). A repeat call is answered as the first, adding the link when it brings one. The
  clip becomes `posted` by the settle rule (a `publishing` clip is left to its flow).
* **Stopped:** from `macDevice` (while `working` or `stopped`). Sets `stopped`, `macStoppedAt` and `macReason` (spaces
  collapsed, at most 200 characters). With `needsYou` the helper item also becomes `needs_you` with that reason and
  `needsYouClipId` = this clip (Settings and every row link to it, §47.4). Once `macPressedAt` is set, the stored reason
  is "Your Mac pressed Post but couldn't confirm it. Look on your TikTok: if it's there, tap It's on TikTok."
  (`tiktok_mac.PRESSED`, round 3) whatever was sent. Older rows keep their old sentence; the web never shows it after
  a press, and picks its own words by `pressedAt` (§47.4), never by matching the text.
* **The shared constants** (round 3, D2; one definition each, one line each in `tiktok_self.py`, read by the web's and
  the helper's pin tests with `^NAME = timedelta\(minutes=(\d+)\)$`): `MAC_BEAT_STALE = timedelta(minutes=5)` (web
  `MAC_BEAT_STALE_MS`), `MAC_CLAIM_MAX = timedelta(minutes=50)` (web `MAC_CLAIM_MAX_MS`: 12 minutes of upload wait, the
  post wait and the 30-minute find window), `MAC_FIND_WINDOW = timedelta(minutes=30)` (web `MAC_FIND_WINDOW_MS`, the
  helper's `FIND_FOR_MS`). The old 15-minute `MAC_STUCK` (and the web's `MAC_STUCK_MS`) are gone; `STALE_CLAIM` (15
  minutes, another device may take a crashed unpressed claim) and the web's 30-minute `MAC_STALE_MS` stay.
* **Stuck** (`tiktok_self.mac_stuck(row, now, *, beats)`, the web's `macStuck`, the same rule): `status = mac`,
  `macState = working`, and either `now − (macBeatAt ?? macClaimedAt) ≥ MAC_BEAT_STALE` (the Mac stopped beating the
  job: it crashed, slept or lost its ledger) or `now − macClaimedAt ≥ MAC_CLAIM_MAX`, whichever comes first. While the
  Mac beats the job it is never stuck before the cap, so no Try again or "Not sure it posted" is offered while it is
  still posting or looking. **The beat counts only for a helper that beats** (`beats`, `tiktok_self.helper_beats(item)`,
  the web's `macHelperBeats(helper)`, review round 3): yes unless the helper item says a `version` older than
  `MAC_BEATS_FROM = "1.1.0"` (web `MAC_BEATS_FROM`; the helper's `VERSION`, pinned by web and helper tests). A helper
  before 1.1.0 sends no beat during its 12-minute upload wait, its link checks after Post or its finding, so for its
  jobs only the 50-minute claim counts (`tiktok_self.working_stuck` reads the helper item for Retry and It's on TikTok).
  **Window over** (`window_over`): no `macPressedAt`, or `now − macPressedAt ≥ MAC_FIND_WINDOW`. **Beat fresh**
  (`beat_fresh`): `now − (macBeatAt ?? macClaimedAt) < MAC_BEAT_STALE`.
* **Retry** (the owner's Try again, `tiktok_mac.retry(store, clip, *, not_on_tiktok, at, now)`, `at` required, the
  route passes `app.clock()`), in order: (1) `working` and not stuck → 409 "Your Mac is posting it right now. Wait a
  minute." (2) `waiting` → answered as it is (`now` makes it `upload` in place). (3) `stopped`, or `working` and stuck,
  with `macPressedAt`: without `notOnTikTok` → 409 "Your Mac may have posted it already. Check your TikTok first.";
  inside the find window → 409 "Your Mac pressed Post less than 30 minutes ago. Look on your TikTok first, then try
  again later." (`tiktok_mac.MAC_STILL_LOOKING`). (4) The re-wait: `macState = waiting`, `macAgainAt = at`, keeping
  `since` (its place in line); with `macPressedAt` it moves to `macPressedBefore` (and `macPressedAt` is removed);
  `macStep`, `macClaimedAt`, `macStoppedAt`, `macReason` go, and a stuck one's `macDevice` and `macBeatAt` too, so the
  Mac claims it afresh. One conditional write: a stopped one needs `macState = stopped` (and the same `macPressedAt`
  when it had one); a stuck one `macState = working`, the same `macClaimedAt`, and the same `macBeatAt` and
  `macPressedAt` when present (a new claim or a beat meanwhile → 409 "This clip just changed. Try again."). Then the
  helper item goes back to `ok` when it was `needs_you` (`clear_needs_you`, which also removes `needsYouClipId`). **`now: true`** (additive, ADR-86; the web's row Try again always sends it) also sets
  `macSource: "upload"` in the same conditional write, so the Mac posts it at once and first. That holds for an
  auto-posting run's post (`auto`) too, also while auto-posting is off: he tapped it himself, so §47.2's off switch
  (which holds back what auto-posting picked) no longer applies to it. `now` must be a boolean (400 otherwise);
  without it a retry is exactly as before.
* **It's on TikTok** (§42.2, `tiktok_self.mark_posted`) on a Mac post: allowed while `waiting` or `stopped`, or
  `working` once stuck (the write then needs that same `macClaimedAt`, and the same `macBeatAt` and `macPressedAt`
  when present); it becomes his own post; its Mac fields go into `beforeYou`, so his Undo puts the Mac post back as it
  was. Refused while `working` and not stuck with "Your Mac is posting it right now. Wait a minute.", and **without a
  link** (`noLink`, D3) on any `working` job the Mac has not pressed Post for: while the Mac still beats it
  (`beat_fresh`, even past `MAC_CLAIM_MAX`) with that same `MAC_WORKING`, else (review round 3) 409 "Your Mac stopped
  before it pressed Post, so it isn't on TikTok. Tap Try again." (`tiktok_self.MAC_NOT_PRESSED`): saved as posted it
  would never reach TikTok (the Mac's next step gets a 409, and Send these refuses it from then on). Find it for me answers the same `MAC_WORKING` before the finder asks
  TikTok anything. Marking a stopped or stuck Mac post also turns the helper item back to `ok` when it was
  `needs_you` (`tiktok_self.clear_needs_you`, as Retry does): the helper echoes `needs_you` for as long as the server
  says it, so nothing else would let the Mac go on. The Mac's late done on it is refused (409).

### 47.4 What the owner sees (web)

Rewritten 2026-11-22 for [ADR-86](DECISIONS.md#adr-86-no-manual-tiktok-sheet-the-mac-is-the-only-way-to-tiktok-until-tiktok-approves-the-app):
there is no manual TikTok sheet, so every TikTok row says only what the Mac is doing, with at most one button.

* Every place that reads `Post.status` handles `"mac"`: the types, `metrics.calmCopy`, Library's TikTok row, the clip
  page's stack (`PlatformPerformance` carries the same `mac` and `via`) and Review's "Uploaded just now". The helpers
  are in `web/src/lib/tiktokMac.ts`.
* **The TikTok row** (`tiktokRow(facts, ctx)`), the same on Library's card, the clip page (its TikTok stack, and the one
  button in `perf__actions`) and Review's "Uploaded just now" line ("TikTok: {words}"). `facts`: the clip's TikTok post
  (`status`, `by`, `via`, `url`, `privacy`, `mac`, `postedAt`), the clip's id (its place in the Mac's queue), whether
  it is not on TikTok yet (`canPostYourself`), whether it is a Private test, and (round 3) whether it is a campaign
  clip (`campaign: !!clip.campaignId`). `ctx`: the switch (`settings.tiktokMac.on`), the Mac's check-in, its plan and
  queue (`GET /v1/tiktok/mac` through `useTikTokMac`: on open, on focus, every 60 s, after post news and within a second
  of the owner's Start my Mac again or Let them go; read whenever a row may need it, a Mac post or a clip the Mac
  could take) and auto-posting's switch. No row reads `GET /v1/autopost` any more (round 3: the helper's ping says
  `backlogAt`, so the web never guesses). Round 3 (D2, D4, D5) order, `tiktokRow(facts, ctx)` in
  `web/src/lib/tiktokMac.ts`:

  1. Posted `via: "mac"` → unchanged (row 1 below). 2. `by: "you"` → unchanged (row 2). 3. A Mac post → `macRow`
  (below). 4. TikTok approved the app, or nothing to offer → no Mac row. 5. A Private test → unchanged. 6. **A campaign
  clip** → "Campaign clips skip TikTok for now: your Mac can't mark them as Branded content yet." (`MAC_ROW_CAMPAIGN`,
  no button: nothing to do, and no dead end). 7. Otherwise the not-yet rows (`notReady`) or "Not on TikTok yet" /
  "Only you can see it on TikTok" with **Post with my Mac**.

  `macRow` (round 3):
  * **stopped with `pressedAt`**: "Not sure it posted · look on your TikTok" with **It's on TikTok**, **Try again**
    beside it only once the find window is over (`macWindowOver`), and **It's on TikTok, no link** offered. Inside the
    window the words end with " · Try again from {pressedAt + 30 minutes}" (`againFromWords`, review round 3), so a
    post that isn't there never waits without a time (a needs-you stop there holds the Mac until he answers it).
  * **stopped**: the not-yet rows first (switch off, never seen, not seen for 30 minutes); else "Didn't work: {short
    reason}" (+ " · look at your Mac first" while `needs_you`) with **Try again**.
  * **working, not stuck** (`macStuck`, the API's rule): switch off → the Turn on row; else "Posting…" with the
    spinner. Never "Not sure it posted" and never Try again here (D2).
  * **working, stuck, with `pressedAt`**: **It's on TikTok** with **It's on TikTok, no link** (Try again beside it once
    the window is over, " · Try again from {time}" until then); words "Your Mac hasn't checked in since {time}" when
    the Mac has not checked in for 10 minutes or more (`MAC_OFFLINE_MS`, D5), else "Not sure it posted · look on your
    TikTok".
  * **working, stuck, no `pressedAt`** (review round 3): it can't be on TikTok, so **Try again** only (no question:
    nothing was posted); words "Your Mac hasn't checked in since {time}" (10 minutes, as above), "Your Mac isn't set up
    yet" (never checked in), else "Your Mac stopped before it pressed Post" (`MAC_ROW_STOPPED_EARLY`). The chip says
    "Didn't work".
  * **waiting**: the not-yet rows; else auto-posting off with `source` `sent`/`auto` → "Waiting for your Mac ·
    auto-posting is off" with **Post with my Mac**; else **held** (`source: "auto"`, made before the helper's
    `holdBefore`) → "Held on your Mac: made before {time}" with **Post with my Mac**; else the queue words below.

  The not-yet rows (`notReady`): switch off → "Your Mac posts TikTok is off" with **Turn on**; never checked in →
  "Your Mac isn't set up yet" with **Open Your Mac posts TikTok** (the setup steps are there); not seen for 30 minutes → "Your Mac hasn't checked in since {time}"
  with **Open Your Mac posts TikTok** (the switch is already on); (not a stopped row) `needs_you` → "Your Mac needs
  you: {short reason} · look at your Mac" with **Open the stopped clip** (→ `/clips/{needsYouClipId}`; Open Your Mac
  posts TikTok when there is none or it is this clip); paused → the paused words with **Start my Mac again** (a
  helper before 1.1.0, `macHelperBeats` false, never reads it: **Open Your Mac posts TikTok** instead, and Settings
  shows no Start my Mac again)
  (`POST /v1/tiktok/mac/request {action: "resume"}`), or, once asked, "{why} · starting again within a minute".

  **The Mac's queue** (`macPlace`, D4): the jobs before this one the way the helper picks (one per tick, Upload first,
  then auto, then the backlog): every `working` job that is not stuck, plus every other `waiting` job that is not held
  whose rank (`upload` 0, `auto` 1, `sent` 2) is lower, or equal and earlier in the server's order. After "Waiting for
  your Mac · ": `upload`/`auto` → "next" or "in line (N before it)"; `sent` → "in line (N before it)", "in line" during
  a backfill, else from the helper's `backlogAt`: "next" once it has passed, "goes at about {time}" before; unknown
  (no queue, not in it, no `backlogAt`): "Waiting for your Mac" alone.

  The same rows as a table (round 3):

  | # | When | The row says | Its one button |
  |---|---|---|---|
  | 1 | Posted `via: "mac"` | "Posted by your Mac · Everyone" ("Posted by your Mac · Only you" when private), with **Open** and its numbers | none; with no link it adds " · add the link" and the inline **Add link** (§42.1) |
  | 2 | `by: "you"`, no `via` (§42) | "Posted by you · Everyone", with **Open** | none; with no link " · add the link" and **Add link** |
  | 3 | `mac.state` `working` | "Posting…", with a spinner (the steps arrive as live post events), while the Mac beats it; once stuck (`macStuck`: no beat for 5 minutes, or claimed 50 minutes ago; a helper before 1.1.0 only the claim): after Post "Not sure it posted · look on your TikTok" (" · Try again from {time}" inside the find window), before Post "Your Mac stopped before it pressed Post", or "Your Mac hasn't checked in since {time}" when the Mac has not checked in for 10 minutes | none; stuck after Post: **It's on TikTok**, and **Try again** once the find window is over; stuck before Post: **Try again** |
  | 4 | The Mac can't post (waiting, stopped and not-yet rows) | "Your Mac posts TikTok is off" (the switch); "Your Mac isn't set up yet" (it never checked in); "Your Mac hasn't checked in since 14:03" (not seen for 30 minutes or more, `MAC_STALE_MS`) | **Turn on** → `/settings/posting/tiktok-mac`; not seen: **Open Your Mac posts TikTok** |
  | 5 | It needs him, or is paused (waiting and not-yet rows) | "Your Mac needs you: {the reason's first sentence} · look at your Mac"; paused: "Paused after the 3 trial posts · your Mac goes on once their views are checked" (the trial pause) or "Paused on your Mac · your clips wait until it's started again" (any other); once Start my Mac again was tapped: "{why} · starting again within a minute" | needs you: **Open the stopped clip**; paused: **Start my Mac again** |
  | 6 | `mac.state` `waiting` | "Waiting for your Mac · next", "… · in line (2 before it)", "… · in line" (a backfill) or "… · goes at about 20:30" (the helper's `backlogAt`), counted the way the helper picks; held: "Held on your Mac: made before {time}"; not known: "Waiting for your Mac" alone | none; held: **Post with my Mac** |
  | 7 | Waiting, `source` `sent` or `auto`, auto-posting off | "Waiting for your Mac · auto-posting is off" | **Turn on** → `/settings/posting/auto` |
  | 8 | `mac.state` `stopped` | "Didn't work: {the reason's first sentence, without its full stop}"; once `pressedAt` is set, "Not sure it posted · look on your TikTok" (chosen by `pressedAt`, never by the stored sentence; shown even while the Mac can't post), with " · Try again from {time}" inside the find window | **Try again**; pressed: **It's on TikTok** (the inline Add link with **Find it for me**, and **It's on TikTok, no link**) and, once the 30-minute find window is over, a quieter **Try again** (no fill, its words underlined) that asks "Post it again? Only if it's not on your TikTok." with **Yes, post it again** and **Not now** |
  | 9 | Not on TikTok yet (`canSendToMac`: no TikTok post, or one waiting for setup, failed, failed for the public account, or private; never a campaign clip) | "Not on TikTok yet"; a campaign clip: "Campaign clips skip TikTok for now: your Mac can't mark them as Branded content yet." | **Post with my Mac**; a campaign clip: none |
  | 10 | A Private test's clip | "Private test · stays off TikTok" | none |

  Rows 9 and 10 are only shown while TikTok has not approved the app (`tiktokAudited`); afterwards a clip without a Mac
  post keeps the API rows of §17 and §33 as before. Clip Factory's own TikTok posts (uploading, public) keep their rows.
  A row refused for the public account (§42.1) never shows the big Try again.
* **When it goes** (round 3, D4): only from the Mac's own queue and plan (`macPlace`, `backlogAt`, `backfill`,
  `holdBefore`, above); "it takes it in about a minute" and "goes after the next auto-posting run" are gone. The
  helper's `backlogAt` follows its `plan.js`: 30 minutes after the last live run when that run's backlog slot is
  unused, otherwise 30 minutes after the next run; at once when that time has passed; none during a backfill.
* **The buttons**, each the app's own `Button` or `LinkButton` (their hover state; the arrow is the only cursor):
  * **Try again**: `POST /v1/clips/{clipId}/tiktok/mac/retry {now: true}`. Beside **It's on TikTok** (not sure it
    posted: pressed, or stuck) only once the find window is over (`row.again`, round 3), as the second choice: quieter (`.post__again`: no fill or lift of its own, only a
    panel's tint on the window look, its words underlined), and it asks first, in the row, "Post it again? Only if it's
    not on your TikTok." (`MAC_AGAIN_CONFIRM`) with **Yes, post it again** (the focus goes there) and **Not now**; Yes
    sends `{notOnTikTok: true, now: true}`. 409 while the Mac works on it: a toast. The question starts at the same
    left edge as the row's words (D7).
  * **It's on TikTok**: opens the inline Add link in the row (`aria-expanded`), the box taking the focus.
  * **Post with my Mac**: `POST /v1/tiktok/mac/send {clipIds: [clipId], now: true}` (`source: "upload"`, so the Mac
    posts it at once), then the clip's posts and the clip are read again (or the live post event comes first).
    `sent: false`: a toast with its reason. `MAC_OFF` can't happen: with the switch off the row shows Turn on.
  * **Turn on**: a link; the switch there saves `PUT /v1/settings {tiktokMac: {on: true}}`.
  * **Add link**: the inline field of §42.1: the link box with **Find it for me** right beside it on one line (no link:
    `POST …/tiktok/posted {since}`, Clip Factory's finder), then **Paste** and **Save the link**. Round 3 (D3): a 409
    from Find it for me shows the server's words in the row's problem line ("Not found yet. Try again in a minute, or
    paste the link." or "Clip Factory can't look on your TikTok until TikTok is connected. Paste the link instead.")
    and saves nothing; found → toast "Found it on your TikTok! Clip Factory will count its views."; Save the link with
    an empty box → "Paste the link first, or tap Find it for me." (no request). From a not-sure row (`row.noLink`) a
    quiet **It's on TikTok, no link** asks "Save it as on TikTok without its link? Its views show once you add the
    link." with **Yes, it's on TikTok** / **Not now** → `{noLink: true}` → toast "Saved. Add its link later to see its
    views."
  * **Start my Mac again** (`Button variant="glass" icon="monitor"`, round 3): `POST /v1/tiktok/mac/request {action:
    "resume"}` → toast "Your Mac starts again within a minute."; a 409 → a toast with the server's words.
  * **Open the stopped clip** (round 3): a `LinkButton` to `/clips/{needsYouClipId}`, where Try again and It's on
    TikTok are.
* **Layout:** on a narrow card (Library's `.posts` container under 440 px: a phone, or three cards side by side at
  1440) the row's button goes under its words, on the right of the row's full width, and the Open icon stays beside
  the words; a wider card keeps it right of the words. It's on TikTok with Try again, Try again's question and the
  Add link are always on a line of their own under the words, on the right. On the clip page they line up with the
  other actions: centred while those are centred (a phone), from the left once they start there.
* **The clip page:** `calmCopy` says the row's words in the TikTok stack with no link, because the button is on the
  page (no "Go to Library and tap Post it yourself", and a stopped Mac post has no Go to Library link). The chip says
  "Waiting for your Mac", "Posting…", "Didn't work" (also a job stuck before Post), or "Not sure it posted" (pressed,
  or its row says so: stuck after Post); then the stack's line says "Look on your TikTok" (`MAC_CLIP_PAGE_LOOK`, round
  3), with the row's " · Try again from {time}" inside the find window, so the page never says "Not sure it posted"
  twice. Any other words of that row ("Your Mac hasn't checked in since {time}") stay as the row says them (review
  round 3).
* **Review:** with `tiktokMac.on` and TikTok not approved, the hint above Upload reads `MAC_HINT`, "TikTok: your Mac
  posts it for everyone." (`MAC_WHERE_LINE` when My settings isn't Everyone, and none on a campaign clip, §47.9), and
  while the switch is off `TIKTOK_PUBLIC_HINT`, "TikTok: turn on Your Mac posts TikTok so
  it posts for everyone." (§42.1). "Uploaded just now" shows, for each kept clip, the words first (its hook, then
  "TikTok: {the row's words}"), then See how it does and the row's one button, in that order on screen and for
  reading; on a phone the buttons go under the words, on the right. A campaign clip's row shows its words alone (no
  "TikTok: " prefix), and Review never ticks or offers TikTok for a campaign clip while TikTok has not approved the app
  (round 3, D1: `campaignPlaces`, with the line "Campaign clips skip TikTok for now: your Mac can't mark them as
  Branded content yet."). Nothing opens by itself after Upload. Upload's own rules and buttons are
  unchanged: with the switch on it writes the Mac post as `source: "upload"`, which the helper posts at once. With the
  switch on, the card starts TikTok on My settings with no tap (§47.9).
* **Settings › Posting › Your Mac posts TikTok** (`/settings/posting/tiktok-mac`, `TikTokMacBranch.tsx`, in the tree
  after Auto-posting): the switch **My Mac posts my TikTok clips** (off: "Off. Your Mac doesn't post your TikTok
  clips."; on: "On. Upload and auto-posting hand TikTok to your Mac."); the status line "Your Mac checked in {Sun
  14:03}.", "Your Mac hasn't checked in yet. Set it up on your Mac.", "Your Mac needs you: {reason}", or paused with
  what comes next ("Paused after the 3 trial posts. Your Mac goes on once their views are checked.", else "Paused on
  your Mac. Your clips wait until it's started again."); while the Mac has never checked in, the three setup steps of
  `mac/tiktok-helper/README.md` (`MAC_SETUP_STEPS`); while on, "{n} waiting for your Mac" and **Send these to my Mac** for the clips that aren't on TikTok yet
  ("3 clips aren't on TikTok yet."; with clips already waiting `sendableLine` says "2 clips already wait for your
  Mac."; its confirm line: "They go one at a time, oldest first.", plus "They wait until your Mac checks in." while it
  never has), sent without `now`, so
  one goes after each auto-posting run (§47.8), never a campaign clip (`canSendToMac`); and one quiet line: "To stop
  it, turn the switch off. Your Mac stops at once." Round 3 (D5), inside the status panel under the status line:
  paused → **Start my Mac again** (once asked: "Your Mac starts again the next time it checks in, within a minute.");
  `needs_you` with `needsYouClipId` → **Open the stopped clip**; `holdBefore` → "Your Mac holds auto-posting clips made
  before {time}." with **Let them go** (`POST /v1/tiktok/mac/request {action: "let_go"}` → toast "Your Mac lets them go
  within a minute."; once asked: "Your Mac lets them go the next time it checks in, within a minute.").
* **Auto-posting page** (§46.2): "Where they go" says "TikTok: your Mac posts it." while on, and "TikTok: turn on Your
  Mac posts TikTok to post there." with **Turn on** while off. It has no TikTok list of its own any more (§46.2 item 7).
* **Gone from the web (ADR-86):** Post it yourself, Post it yourself instead (Take it back, then the §42 sheet), I
  posted it, "It's not on TikTok, try again", the step words while the Mac works ("Getting the video" … "Finding the
  link"), and Auto-posting's Post these on TikTok yourself. Their routes stay (§42.2, §47.2 item 4).
* Mock mode (`web/src/api/mock/tiktokMac.ts`) follows these rules, `now`, stuck claims and `needs_you` included, and
  since round 3 the stuck rule from `beatAt`/`claimedAt`, the window, the re-wait's `pressedBefore`/`againAt`, the
  claim's pressed guard, the campaign refusals, Find it for me (the first Find on a clip → 409 `FIND_NONE`, the next
  one finds it), `noLink`, the request route and the ping's plan keys, with the lib's own constants; the helper's
  routes are test knobs (`window.__cfMock.mac`: ping (with `backlogAt`, `backfill`, `holdBefore`, `resumeDone`,
  `letGoDone`), seen, claim (with how long ago), beat, step, done, stopped, queue, post), and
  `window.__cfMock.posting.campaignClip()` makes a kept clip a campaign clip.

### 47.5 Tests (offline, fakes only)

* `api/tests/test_tiktok_mac.py`: the setting; Upload with the switch on (a Mac post in the same transaction), off,
  once TikTok approved the app, without the TikTok choices, without TikTok; **a campaign clip never goes to the Mac**
  (round 3: Upload with TikTok refused with `CAMPAIGN_SKIPS` while not approved, nothing written; once approved it goes
  through TikTok's API, `queued` with Branded content, never a Mac post); a run never gives a campaign clip a Mac post
  and never a Private test; It's on TikTok on a stopped post turns `needs_you` back to `ok` (pressed or not; not for a
  post that only waits; never makes a helper item); **the stuck rule** (beat 4:59 not stuck, 5:00 stuck; a claim
  49:59 old with fresh beats not stuck, 50:00 stuck; Try again and It's on TikTok refused while not stuck; a stuck
  claim taken back, a new claim or a beat meanwhile wins, the Mac's late done refused); **the find window** (Try
  again after Post needs `notOnTikTok`, is refused inside the window with `MAC_STILL_LOOKING`, and after it moves
  `macPressedAt` to `macPressedBefore` and sets `macAgainAt`; the job shows `beatAt`, `pressedBefore`, `againAt`);
  the claim refuses a waiting post that still has `macPressedAt`; a re-sent step is the beat (the step kept, every
  refusal kept, the first press never moved and logged once); It's on TikTok without a link (refused while the Mac
  beats a job it never pressed Post for, even past 50 minutes; allowed once the beat is stale, or after Post); Find it
  for me on a working post answers `MAC_WORKING` before the finder; the ping's plan keys stored and removed, their
  400s, `resumeDone`/`letGoDone` removing only their own request; the request route (each refusal, each write);
  `needsYouClipId` set by a needs-you stop and cleared by Try again, It's on TikTok and an ok ping; Send these to my
  Mac and Post with my Mac refuse a campaign clip with `SEND_CAMPAIGN` (with and without `now`, also one whose campaign
  lives on its posts); the words (one source for `CAMPAIGN_SKIPS`: `fit.TIKTOK_WAITS`, `_places_note` and the start of
  both `_place_refusal` sentences; `PRESSED`, `MAC_STILL_LOOKING`, `NOT_UPLOADED`, `TIKTOK_PRIVATE_ONLY`; no string
  constant in `tiktok_self.py`, `tiktok_mac.py`, `routes/tiktok_mac.py` or `platforms/errors.py` says "post it
  yourself" or "I posted it"; the three constants one line each); never TikTok's API: the clip flow's publish loop and
  `ensure-posts`, `release.release_waiting`, Try again and Post now (`_try_again`, `release.restart`, a failed clip's
  Try again), settle-clip (posted with the other posts done; a TikTok-only Upload stays `confirmed` until the Mac is
  done) and `tiktok_self._clip_status`; the queue (off, order and jobs, the auto-posting off switch, at most 50); ping;
  claim races, a stale claim, `pressedAt` never claimed again, the switch off; steps from the claiming Mac only, live,
  the switch off before Post; stops and needs you, the pressed reason; done through `mark_posted` with a link, with the
  finder's `since`, repeat-safe, only from the claiming Mac, after a stop, never undone, never a second post with It's
  on TikTok; It's on TikTok vs the Mac (refused while working; waiting or stopped, and its Undo); Try again with and
  without `notOnTikTok`; Take it back (deleted, restored, refused while working,
  refused after Post was pressed with nothing then sent through the API, one transaction that rolls back whole, a clip
  that just settled); an Upload that picked Only me still asks for Everyone and done marks it public; done's privacy
  follows the stored choice; the switch off lists waiting and stopped Mac posts in `tiktokYourself`; the job's
  `attempt` and an older attempt refused; Send these to my Mac (the switch, 1–25
  ids, a new post once, the race guard both ways, each hand-over and its Take it back, every refusal, the queue order);
  `now` (ADR-86): a send with `now` makes `macSource: "upload"` and the queue puts it first, one without stays `sent`,
  a retry with `now` turns `sent` and `auto` into `upload`, `now` must be a boolean (400), unknown keys still 400, and
  the switch off still 409 `MAC_OFF`; the clip page; another owner.
* `api/tests/test_tiktok_yourself.py` (§42.4, round 3): Find it for me saves nothing when nothing is found (then finds
  it a minute later), when TikTok is down, or when TikTok is not connected (`FIND_CANT`, also without an OAuth
  client); a post already his with a link is answered unchanged; `noLink` saves without the finder; a link with
  `noLink` → 400; `noLink` must be a boolean; every refusal is the same for `noLink` and Find it for me, before TikTok
  is asked. `api/tests/test_campaign_posting.py`: TikTok refused until both gates are `ok` (the posting audit alone is
  not enough), its Upload and Try again sentences; campaign tests that send TikTok set `app_review` live.
* `test_autopost_run.py`: `test_tiktok_is_never_a_place_even_when_ready` (unchanged, the switch off) and beside it the
  switch-on case (five posts in one transaction, TikTok's for the Mac, `uploadTo` without TikTok); Practice and a
  Private test never make one; a campaign clip from a run never gets one (round 3). `test_autopost_routes.py`:
  `leftOut`/`macPlaces`, the `tiktokYourself` filter. `test_http.py`: every §47 route (round 3 adds
  `POST /v1/tiktok/mac/request`).
* Web: `web/test/tiktokMac.test.ts` (`tiktokRow`'s states and words in order, the 30-minute stale rule, the waiting
  words for `upload`, `auto` and `sent` (only the first backlog clip in the queue with the run's time, the rest in
  line, never a time without the queue), the short reason, the pressed and stuck words (Not sure it posted), the
  paused words, a campaign clip like any other, who may be sent, the chip, the Settings lines and the mock's rules:
  It's on TikTok clears `needs_you`, a stuck claim taken back, a campaign clip sent for Everyone); `web/test/tiktokMacNow.test.ts` (the mock's `now` rules and the HTTP
  bodies: `{clipIds, now: true}`, `{notOnTikTok?: true, now?: true}`, each key only when true);
  `web/test/metrics.test.ts` (`calmCopy` for a waiting, working and stopped Mac post and the public-account failure);
  `web/e2e/tiktok-mac.spec.ts` (Library's row through waiting, Posting…, Didn't work with Try again, not sure it
  posted with It's on TikTok, the quieter Try again and its question, Find it for me beside the box, a stuck claim,
  the backlog's first and later rows, a campaign clip, paused and trial words, posted, Not on TikTok yet with Post
  with my Mac, the switch off with Turn on, a Mac not seen for 30 minutes with Turn on, the button under the words on
  a narrow card at 1440 and 375; the clip page's chip and its choices lined up with the actions at both sizes; Review's
  lines, word order and hint; the Settings branch switch and Send these);
  `web/e2e/tiktok-yourself.spec.ts` (§42.4); `web/e2e/autopost.spec.ts` (Where they go with the switch off, its Turn
  on, and on). The tests of Post it yourself instead, I posted it after Post was pressed and the sheet are gone
  with them. Round 3 adds: `tiktokMac.test.ts` (every row of the round-3 order, `macPlace`, `macStuck`,
  `macWindowOver`, the pin test that reads `tiktok_self.py` and asserts its three minutes equal the web's constants,
  the campaign row, held, paused and its pending line, the needs-you link, a working post whose Mac is offline, Open
  Your Mac posts TikTok when stale); `tiktokMacNow.test.ts` (`{noLink: true}` only when true, `{action}`);
  `metrics.test.ts` (the clip page's line); the words tests; e2e for Find it for me saving nothing, the no-link
  confirm, Try again only after the window, Start my Mac again, Let them go, Open the stopped clip and Review's
  campaign clip without TikTok, with the D7 screenshots (real hover and stuck shots).
* Helper (`mac/tiktok-helper/test`, round 3): `plan.test.js` (`backlogAt` each branch and that `nextAction`'s backlog
  `until` equals it; never twice: `pressedAt` never posted, `pressedBefore` without or with an early `againAt`
  skipped, with a late `againAt` posted); `constants.test.js` (`FIND_FOR_MS` equals `MAC_FIND_WINDOW`, `3 ×
  BEAT_EVERY_MS ≤ MAC_BEAT_STALE`, read from `tiktok_self.py`, and `VERSION` at least `MAC_BEATS_FROM`); the beat
  targets, also doFind's (every pressed job of this Mac, review round 3); `applyRequests` (resume, let go); a grep
  that no `src/` string says "post it yourself" or "I posted it".

### 47.6 Never twice, never TikTok's API

* A Mac post is never `queued` or `pending_integration`: the clip flow publishes only `queued` posts, the release only
  `pending_integration` ones, Try again only failed and waiting ones, and Post now's carried posts are `queued` ones.
* One TikTok post per clip: Upload writes it with the clip's `postsCreated` condition; a send needs neither
  `tiktokForMac` nor `tiktokByYou`, It's on TikTok's new post neither; the Mac's done and It's on TikTok are the same
  conditional write on the one row.
* One Mac, one try at a time: the claim is conditional; a post whose helper pressed Post is never claimed again by
  itself, whatever its state (round 3: also a `waiting` one), and never taken back (it could then go out through
  TikTok's API as well); only the owner's Try again on that row (`notOnTikTok`, once the row told him to look on his
  TikTok first, and only once the 30-minute find window is over) moves the press to `macPressedBefore` and sets
  `macAgainAt`. The helper's own guard (`plan.js nextAction`) never posts or resumes a job with `pressedAt`, and posts
  a job with `pressedBefore` only when `againAt ≥ pressedBefore + FIND_FOR_MS` (else it skips it, `never_twice.skip`),
  so a lost press can never turn into a second copy. While the Mac beats a job (every minute) no row offers Try again
  or "Not sure it posted" (§47.3 stuck rule). The server lets It's on TikTok make such a post his (§47.3).
* **Never a campaign clip** (round 3, D1): no path (Upload, an auto-posting run, Send these to my Mac, Post with my
  Mac) makes a campaign Mac post, so a paid promotion never goes up without TikTok's Branded content disclosure, and
  nothing posted outside Content Rewards' reach is counted as a campaign post.

### 47.8 The TikTok login on the Mac (owner request, 2026-11-22)

The owner, asked "Should the helper keep your TikTok password in the Mac's Keychain, so it can log back in by
itself?": "Yes, use Keychain". Also: "i want you to have full unrestricted access to my computer to download videos and
then log into tiktok and upload them then delete the video you downloaded after you uploaded it to tiktok successfully".

* **The login never reaches Clip Factory.** The helper (`mac/tiktok-helper`, `src/login.js`) asks for it once in two Mac
  dialogs (the password one hidden), with the yellow frame, and keeps it only in the login Keychain under the service
  "Clip Factory TikTok helper" (accounts `tiktok-username`, `tiktok-password`): from the dialog's answer (a pipe) into
  `security`'s stdin, never a file or a command line. Its log lines, events and notifications are scrubbed, and its API
  client refuses any request whose path or body holds the password. The server only learns whether one is kept.
* **Logging back in:** when TikTok logs the helper out, it logs in with the saved login under the red frame, at most
  twice in 24 hours and never again after TikTok refused it (wrong login, "Maximum number of attempts"), until it is
  changed. A code, a puzzle or a new-device check is the owner's turn: the yellow frame, a pop-up, and the helper's own
  window comes forward as it is. The post waits (still this Mac's) and goes on after the login; after 20 minutes
  without one it stops with TikTok's login sentence (`needsYou`).
* **The video in Downloads:** the helper deletes only the file it saved itself for that post (in Downloads, named
  `clip-factory-….mp4`, recorded in its ledger), and only once the post's link is found in TikTok Studio › Posts. A
  failed try keeps it for the retry; a clip that got onto TikTok another way has its kept file removed. Nothing else
  in Downloads is touched.
* **Nothing on the owner's screen** (the owner: "i want that process to upload to tiktok to be done behind the scenes, it
  should not appear on my screen it should allow me to work like normal in parallel"; this replaced his earlier
  red-frame rule): a normal run starts Chrome headless (new headless mode, the helper's own profile and TikTok login),
  spawned directly, so there is no window on screen, no Dock icon, no Cmd-Tab entry and no focus; it tells TikTok
  what the visible Chrome would (user agent and client hints without HeadlessChrome, the Mac's screen, pixel ratio 2),
  with Chrome's notifications off. No frame, no notification, no sound: results go to the clip's row and the helper's
  events log. Only his own turn (a TikTok code, a puzzle, a login the Keychain can't do, the Clip Factory sign-in)
  shows the yellow frame and one pop-up, with a visible login window. All input is CDP (no OS mouse or keyboard).
* **When the Mac posts** (the owner: "if auto posting is set to every 6 hours then it should also run the tiktok upload
  every time thats run so its dependent on that automation" and "or if i hit upload on a video it should be invoked as
  well"): a clip he uploads (`source: "upload"`, also a row's Post with my Mac or Try again, which send `now: true`,
  §47.2) goes at once, ahead of everything; an auto-posting run's own clips
  (`source: "auto"`, its "Clips each time") go at once, a minute apart; and at most one backlog clip (`source:
  "sent"`, Send these to my Mac, oldest first) goes about 30 minutes after each live scheduled run, read from `GET
  /v1/autopost` (`runs`, `nextRunAt`), until the backlog is empty. Round 3: its ping says when the first one goes
  (`backlogAt`, the same `plan.backlogAt` its `nextAction` uses), whether a backfill runs (`backfill`) and its hold
  (`holdBefore`), so the rows show the Mac's own times (§47.4). With auto-posting off the backlog waits. Settings ›
  Posting › Your Mac posts TikTok says it: "Posts with auto-posting · next Sun 22:00 · 14 waiting", or "Posts when you
  tap Upload · 14 waiting" while auto-posting is off.
* **API (additive, the `MACHELPER` item):** ping takes `login?: "saved" | "none"` and `loginDone?: ISO` (the `at` of the
  request it handled; a newer request stays). `POST /v1/tiktok/mac/login {action: "change" | "forget"}` → `{helper}`
  sets `loginRequestAction`/`loginRequestAt` (409 "Set up your Mac first. Then it can keep your TikTok login." when no
  Mac ever checked in; 400 "Pick change or forget."). `MacHelper` gains `login?` and `loginRequest?: {action, at}`.
  The helper does a pending request between posts, never in the middle of one, and still checks in without the new
  fields to a server from before them.
* **Web:** Settings › Posting › Your Mac posts TikTok › **TikTok login on your Mac** (`tiktok-mac-login`, shown once a Mac
  checked in): "Your TikTok login is kept in your Mac's Keychain, so your Mac logs back in to TikTok by itself." or "No
  TikTok login is kept on your Mac. If TikTok logs your Mac out, you log in again on the Mac.", **Change TikTok login**
  (glass) and **Forget TikTok login** (only while one is kept; asks "Forget it? Then your Mac can't log back in to
  TikTok by itself." with Yes, forget it / Not now). After a tap: "Your Mac asks for the new login the next time it
  checks in, within a minute." / "Your Mac forgets the login the next time it checks in, within a minute."
* **Tests:** `api/tests/test_tiktok_mac.py` (the login state, Change and Forget waiting for the Mac, an older done never
  clears a newer request, unknown keys refused, no login fields stored); `web/test/tiktokMac.test.ts` and
  `web/e2e/tiktok-mac.spec.ts` (the lines, the buttons, Forget's question); `mac/tiktok-helper/test/login.test.js` (at most
  twice a day, never after a refusal, a code or a puzzle is the owner's turn, never in a log, an event or a request),
  `files.test.js` (only its own videos), `frame.test.js` (a normal run never touches the frame).

### 47.9 Review starts on My settings while the Mac posts TikTok (owner request, 2026-11-23)

The owner (2026-11-23, verbatim): "the auto upload feature uploads publicly to all social media platforms except X,
but when that happens it invokes a tiktok automation for uploading there. the same process happens when i manually
click upload, and also the default settings should be that it publishes publicly to all platforms". Auto-posting
already posts with My settings (§46.6) and every Mac post already stores My settings' TikTok choices (§47.1); this
makes the Review card (§36) match, so Upload and auto-posting both post TikTok through his Mac on his settings. It
amends §36's TikTok tap (items 3 and 5 of the card, and "never before" in its web part) only while the Mac posts
TikTok. No API, table or infrastructure change.

1. **Your Mac posts TikTok on** (`macOn(settings)`, `settings.tiktokMac.on === true`) and TikTok has not approved the
   app (`tiktokAudited`, as §47.2 item 1): a Review card with TikTok ticked starts on My settings exactly like the
   other places. TikTok's row starts with Who can see it from the preset's `privacy` (Everyone by default), Comments,
   Duet and Stitch as saved (on by default), and Commercial content off. A campaign clip keeps its own path (Everyone
   with Branded content, §17.8; the Mac never takes one, §47.2).
   * No tap before Upload: the button reads **Your settings are on** from the start (`settingsOn` true), the line under
     it reads "Every place uses your settings. Tap a place below to change it for this clip.", and TikTok's row line
     says "Who can see it: Everyone · …", never "not picked yet". Upload is never held with "Tap Use my settings
     first. TikTok needs your tap."
   * **TikTok's row is read-only for what the Mac uses** (decided for this release, 2026-11-23). The server asks the
     Mac for My settings whatever the card sends (§47.1, `uploads.py` sets every Mac post's `tiktok` to
     `tiktok_mac.preset_options`, `brandContent` always false), and the helper has no Branded content step. So the open
     row shows, in place of Who can see it and the Comments, Duet and Stitch switches, one fixed line built from the
     preset's real values (`macPostsLine`): "Your Mac posts it with My settings: Everyone · Comments on · Duet on ·
     Stitch on", and a small **Change My settings** button to Settings › Posting › My settings
     (`/settings/posting/my-settings`). There is no per-clip privacy or switch change in this mode, so the card never
     says "Only me" while the Mac posts for Everyone. "Posting as {name}" shows once TikTok's API named the account;
     with no name yet (not asked, slow, failed) the line is left out in this mode only.
   * **Commercial content stays visible and is this clip's own.** Ticking **Your brand** or **Branded content** (with
     Commercial content on) holds Upload for TikTok (`macTikTokHeld`): Upload's line and an alert in the row say
     `MAC_LABEL_HELD`, "Your Mac can't add TikTok's Branded content label yet. Untick it, or untick TikTok, then post
     this clip in the TikTok app with its label, not with your Mac." With Commercial content on and nothing
     ticked it is held too, with `MAC_COMMERCIAL_HELD`, "Your Mac can't add TikTok's Branded content label yet. Turn
     off Commercial content, or untick TikTok, then post this clip in the TikTok app with its label, not with
     your Mac." (TikTok's own
     `PICK_WHOSE` line would send him round in a circle: either pick holds the Mac too; Upload's hover text is left
     empty). TikTokCommercial leaves out its hint line in this mode ("Your video will be labeled as …" would be untrue;
     "Pick Your brand, Branded content, or both." is the circle again). With TikTok unticked the other places upload as
     usual. So Upload never hands a clip with a label ticked to the Mac. But nothing on the clip records Commercial
     content (it lives only in the card's state), so once that clip is uploaded without TikTok it is like any other
     kept clip: Post with my Mac (Library, the clip page) and Settings › Your Mac posts TikTok › Send these to my Mac
     would hand it to the Mac, which posts it with `preset_options` (`brandContent` false), without the label TikTok's
     Branded Content Policy requires. So the hold's words above, My settings (item 3) and Ask tell him to post that clip
     himself in the TikTok app with the label, never with Post with my Mac or Send these to my Mac; and Review's
     "Uploaded just now" row of a clip uploaded from a card with Commercial content on (`commercialRow`, this visit
     only) reads "TikTok: Commercial content: post it in the TikTok app, with its label" (`MAC_ROW_COMMERCIAL`)
     with the inline Add link, never Post with my Mac. A flag on the clip that keeps every Mac path off it is the later
     step's (below).
   * **The line above Upload** (§47.4) is built for this clip: `MAC_HINT`, "TikTok: your Mac posts it for everyone.",
     only while the Mac posts this clip's TikTok and My settings' Who can see it is Everyone; with Followers, Friends or
     Only me it is `MAC_WHERE_LINE`, "TikTok: your Mac posts it." (the row says who). A campaign clip with the switch on
     has no line there, as the Mac never takes one.
   * TikTok's creator info (`GET /v1/accounts/tiktok/creator-info`, TikTok API data) is still asked, in the background
     as soon as TikTok is ticked, only for the account's name and the longest video it takes (`macCreator`). In this
     mode only, one ask serves every card for 60 seconds (`macCreatorInfo` in `Review.tsx`; a failed ask is not kept).
     Upload never waits for it: while it is slow or after it failed, the card uploads with the preset's choices and no
     creator (opening the TikTok row asks again), and the too-long check uses the creator's longest video once known.
   * The confirm body still carries `tiktok`, as the server requires ("Pick who can see it on TikTok.", §47.2 item 1),
     and it is always valid: `macTikTokChoices` is the preset's privacy (Everyone when unset) with the preset's
     Comments, Duet and Stitch, and Commercial content as ticked (Upload is held while a label is ticked, so
     `brandContent` and `brandOrganic` go false). The Mac job gets the same (`privacy: "PUBLIC_TO_EVERYONE"`, the
     saved privacy, with the saved Comment, Duet and Stitch).
   * **Later step, not in this release:** per-clip TikTok choices and Branded content through the Mac. Both need the
     helper's Branded content step (TikTok Studio's content disclosure) and the server honouring the card's own
     `tiktok` choices for a Mac post instead of `preset_options`, and a flag on the clip (its label) that Post with my
     Mac and Send these to my Mac honour. Until they ship, the row stays read-only, a ticked label holds
     Upload for TikTok, and the words tell him to post a paid partnership in the TikTok app himself.
2. **Your Mac posts TikTok off, or TikTok approved the app** (TikTok's API path; the app is still in review), and every
   campaign clip: exactly as §36. Who can see it starts unpicked, Comments, Duet and Stitch start off, creator info is
   asked only on Use my settings or when the TikTok row opens, and Upload waits for his tap ("Tap Use my settings
   first. TikTok needs your tap."). That is TikTok's rule for API apps (§17.8): no default, the creator's own action.
   Every creator-info ask on this path is the card's own (never the Mac mode's shared 60-second answer), and "Posting
   as" always shows. A card that moves from item 1's mode to this path while open drops the Mac mode's answer, so Use
   my settings (or the open row) asks TikTok again.
   TikTok's demo video for its app review (`TIKTOK_DEMO_SHOTS`, §17) shows this path, so it is recorded with Your Mac
   posts TikTok off.
3. **Words elsewhere:** Settings › Posting › My settings (`MySettingsBranch.tsx`) reads "Every clip on Review starts
   on these, TikTok too, except campaign clips." at the top, and under TikTok "Commercial content is off. Your Mac
   posts TikTok with these. Paid partnerships can't go through your Mac yet: untick TikTok for that clip, then post it
   in the TikTok app with its label, not with Post with my Mac or Send these to my Mac." in item
   1's mode; otherwise both keep today's words ("Tap Use my settings on a clip to put these on.", "Commercial content
   is off. For a paid partnership, tick Branded content in the TikTok row of that clip. TikTok wants your own tap on
   each clip, so tap Use my settings there."). The TikTok part's leaf (`settingsTree.ts`, `my-settings-tiktok`) reads
   "Everyone can see it; comments, Duet and Stitch on. Every clip starts on these while your Mac posts TikTok." in
   both modes. Ask's "Use my settings" guide (`helpKb.json`, `review-use-my-settings`, titled "Use my settings: your
   saved choices on every place", true in both modes) says every ticked place, TikTok included, starts on his settings
   while his Mac posts TikTok, so he just taps Upload, that the Mac always posts with them (change them in My
   settings), and that paid partnerships can't go through the Mac yet, so he unticks TikTok for that clip and posts it
   himself in the TikTok app with the label, never with Post with my Mac or Send these to my Mac;
   `review-place-rows` says the same after its Branded content step; `review-upload-to` says to tap Use my settings
   only when the card does not already say Your settings are on. None of them tells him to tick Branded content for
   the Mac. docs/SETUP_POSTING.md says the same, and its demo step (`public-demo`, also in `tiktok.ts`) says to record
   with Your Mac posts TikTok off.
4. **Tests:** the Review tests (`web/test/reviewMac.test.tsx`) pin both modes: with the Mac on, TikTok starts on My
   settings and Upload is not held, also while creator info is slow or failed; the row is read-only (the Mac line,
   Change My settings, no Who can see it, no Comments, Duet or Stitch switch) and the Mac job gets the preset's privacy;
   Your brand or Branded content holds Upload for TikTok with `MAC_LABEL_HELD` (Commercial content alone with
   `MAC_COMMERCIAL_HELD`) and unticking TikTok lets the rest go, and that clip's "Uploaded just now" row says
   `MAC_ROW_COMMERCIAL` with Add link and no Post with my Mac; the line above Upload says `MAC_WHERE_LINE` with
   Followers saved; the shared creator-info answer is used in Mac mode
   only, and a card that switches to the API path asks again on Use my settings. With it off: today's unpicked start and
   held Upload, a fresh ask per card, and "Posting as" shown even with an empty nickname.
   `web/test/mySettingsTikTok.test.tsx` pins My settings' words in both modes; `helpEvals.json` has "Does TikTok need my
   tap each time?" → `review-use-my-settings`.

### 47.7 Not verified live

The helper itself (its own PR); that TikTok Studio keeps accepting a background Chrome's uploads, and the reach of
script-posted videos (the 3-post trial compares 24-hour views with his phone posts, plan note §3); that `video/list`
sees a post the Mac made (as §42.5).
