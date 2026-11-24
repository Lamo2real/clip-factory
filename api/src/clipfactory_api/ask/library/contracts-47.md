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

**Both workspaces.** Since helper 1.2.0 the same Mac also posts Clips Funded's TikTok jobs, to Clips Funded's own
TikTok only, through Clips Funded's own routes and partition (§47.10, ADR-89). §47.1 to §47.9 are Clip Factory's and
stay as they are; the helper's handle check before every post (§47.10.5) applies to both.

### 47.1 Data

* **Settings** `tiktokMac: { on: boolean }`, default `{on: false}`, merged on PUT like `autoPost` (§46.3). Unknown
  keys → 400 "tiktokMac has a setting Clip Factory does not know." A stored value that no longer validates reads the
  default.
* **Helper item** `pk USER#{userId}`, `sk MACHELPER`, `type="machelper"`: `seenAt`, `state` (`ok` | `needs_you` |
  `paused`), `reason?` (a plain sentence, at most 200 characters), `version?`, `device`, `login?` (§47.8). Written by
  the ping and by a stop with `needsYou`; the owner's Try again and It's on TikTok on the stopped post turn
  `needs_you` back into `ok` (`tiktok_self.clear_needs_you`: `SET state = ok REMOVE reason, needsYouClipId,
  needsYouCode, needsYouDevice`), or the helper's logged-in (§47.11). Only a stop starts a hold: a `needs_you` ping on
  an item that isn't `needs_you` checks in as `ok` (§47.11, review 24 Nov).
  Round 3 (2026-11-23) adds, every one additive:

  | Field | Type | Who writes it | Public in `MacHelper` |
  |---|---|---|---|
  | `needsYouClipId` | clip id | `tiktok_mac.stopped(..., needs_you=True)` (the same write that sets `needs_you`) | `needsYouClipId?` |
  | `backlogAt` | ISO | ping (`backlogAt`, the helper's `plan.backlogAt`: when the first backlog clip goes); a ping without it removes it | `backlogAt?` |
  | `holdBefore` | ISO | ping (`holdBefore`, the helper's `holdAutoBefore`); a ping without it removes it | `holdBefore?` |
  | `backfill` | `true` | ping (`backfill: true`); a ping without it (or `false`) removes it | `backfill?: true` |
  | `resumeRequestAt` | ISO | the owner's `POST /v1/tiktok/mac/request {action: "resume"}`; removed by a ping whose `resumeDone` equals it | `resumeRequest?: {at}` |
  | `letGoRequestAt` | ISO | the owner's `POST /v1/tiktok/mac/request {action: "let_go"}`; removed by a ping whose `letGoDone` equals it | `letGoRequest?: {at}` |
  | `needsYouCode` | `"login"` | §47.11: the same write as `needsYouClipId`, from a stop with `code` (a needs-you stop without one removes it) | `needsYouCode?: "login"`, only while `needs_you` |
  | `needsYouDevice` | device id | §47.11: the same write as `needsYouClipId`, the Mac that stopped (no ping overwrites it; every ping rewrites `device`) | never |

  `needsYouClipId` (and `needsYouCode` and `needsYouDevice`, §47.11) is also removed by any ping whose `state` is not
  `needs_you`.
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
                      resumeRequest?: { at: string }; letGoRequest?: { at: string };
                      needsYouCode?: "login" /* §47.11, only while needs_you */ }
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
   `tiktokAudited`: `app_review` and `posting_audit` not both `ok`); a campaign clip too, since 2026-11-24 (§47.12,
   ADR-96: Everyone with Branded content, after all of Upload's campaign checks; until then round 3's D1 kept campaign
   clips off the Mac). With the switch off a campaign clip's TikTok is refused before the approval ("Campaign clips go
   on TikTok from your Mac. Turn it on in Settings › Posting › Your Mac posts TikTok. Or turn TikTok off, then tap
   Upload.", §38.14 `_place_refusal`); once approved its TikTok goes through TikTok's API as before (`queued`, the
   sheet's Branded content). The `tiktok` body stays required ("Pick who can see it on TikTok.") and is checked as before, but
   the post's `postOptions` are My settings' choices (§47.1), or the card's own with `tiktokMac: true` (§47.12); `uploadTo` names TikTok (he chose it). Upload's API TikTok rule (`queued`, the refusals) is
   otherwise unchanged, and exactly as before with the switch off or once TikTok approved the app.
2. **Auto-posting runs** (`autopost/run.py`, live mode only): with `tiktokMac.on`, a clip (a campaign clip only when TikTok is one of its places and it fits with TikTok, §47.12)
   also gets a TikTok Mac post (`source: "auto"`) through `upload_review_clip(..., tiktok_mac=True)`; its options are My
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
   test. A campaign clip goes with Everyone and Branded content once Upload's campaign checks pass for TikTok
   (`routes/clips.mac_campaign_refusal`; else its own `{sent: false, reason}` and nothing written), and a paid clip
   with its label (`tiktok_mac.send_options`, §47.12). **`now`** (additive, ADR-86): Settings' bulk Send these to my Mac sends no `now`, so its
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
   that clip.", "This clip just changed. Try again.", and a campaign clip's campaign refusals (§47.12; the server's words).
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
| POST `/v1/clips/{clipId}/tiktok/mac/claim` | `{ device, version? }` | `{ job: MacJob }` (§47.12) |
| POST `/v1/clips/{clipId}/tiktok/mac/step` | `{ device, step, attempt? }` | `{ job: MacJob }` (a re-sent step is the beat) |
| POST `/v1/clips/{clipId}/tiktok/mac/done` | `{ device, link? }` | `{ clip, posts, note? }` |
| POST `/v1/clips/{clipId}/tiktok/mac/stopped` | `{ device, reason, needsYou?: boolean, attempt?, code?: "login" }` | `{ job: MacJob }` (`code` §47.11) |
| POST `/v1/clips/{clipId}/tiktok/mac/logged-in` | `{ device }` | `{ helper: MacHelper \| null, outcome }` (the helper only, §47.11) |
| POST `/v1/clips/{clipId}/tiktok/mac/retry` | `{ notOnTikTok?: true, now?: boolean }` | `{ clip, posts }` (the owner's Try again) |
| DELETE `/v1/clips/{clipId}/tiktok/mac` | – | `{ clip, posts }` (Take it back) |

Unknown body keys → 400 everywhere; `device` is required text (at most 100 characters); a clip that is not the
caller's → 404 "We could not find that clip." `MAC_OFF` is "Your Mac posting is off. Turn it on in Settings › Posting ›
Your Mac posts TikTok."

* **The token** (helper 1.2.1): never one access token (15 minutes) for a whole tick; `auth.js tokenSource` renews it
  2 minutes early and once on a 401, one refresh at a time, so a stop after a 20-minute login wait still lands.
* **Queue:** empty while the switch is off. Else the Mac posts that are `waiting` plus the `working` ones (a restarted
  helper sees its own), minus `source: "auto"` ones whose Post was not pressed while `autoPost.on` is false (§47.2). Order: `source: "upload"` first,
  then the rest; oldest `since` first, then the oldest clip (`decidedAt`); at most 50. `caption` is the clip's stored
  TikTok caption, repaired as §5 says and in NFC; `fileName` is the web's `videoFileName(hook)`; `privacy` and the
  three switches come from the post's options, and so do `brandContent` and `brandOrganic` (TikTok's label, always
  there, false unless the options say true; a campaign post's `caption` is its campaign caption, §47.12).
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
  action. It never touches `needs_you` (only the owner's answer on the stopped clip clears that, or the helper's
  logged-in, §47.11).
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
  `needsYouClipId` = this clip (Settings and every row link to it, §47.4), and `needsYouCode` = its `code` (§47.11:
  only `"login"`, else 400 "code must be login."; a needs-you stop without a code removes it). Once `macPressedAt` is set, the stored reason
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
  (below). 4. TikTok approved the app, or nothing to offer → no Mac row. 5. A Private test → unchanged. 6. *Removed
  2026-11-24 (§47.12): a campaign clip now has the rows below, with " · Paid partnership label".* 7. Otherwise the not-yet rows (`notReady`) or "Not on TikTok yet" /
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
  | 9 | Not on TikTok yet (`canSendToMac`: no TikTok post, or one waiting for setup, failed, failed for the public account, or private; a campaign clip too, §47.12) | "Not on TikTok yet" (a paid clip: " · Paid partnership label" or " · Promotional content label") | **Post with my Mac** |
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
  reading; on a phone the buttons go under the words, on the right. Review offers TikTok for a campaign clip while TikTok
  approved the app or the Mac posts TikTok (`campaignPlaces(…, tiktokGoes)`, §47.12), else the line "Campaign clips go
  on TikTok from your Mac. Turn it on in Settings › Posting › Your Mac posts TikTok.". Nothing opens by itself after Upload. Upload's own rules and buttons are
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
  `needs_you` with `needsYouClipId` → **Open the stopped clip**; `needsYouCode: "login"` → one quiet line under the
  status line (§47.11); `holdBefore` → "Your Mac holds auto-posting clips made
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
  once TikTok approved the app, without the TikTok choices, without TikTok; a campaign clip's Mac post (§47.12: Everyone with Branded content after
  the campaign checks; refused with `CAMPAIGN_MAC_OFF` while the switch is off and TikTok not approved, nothing
  written; once approved it goes through TikTok's API, `queued` with Branded content); a run gives a campaign clip a
  Mac post only when TikTok passes its checks, and never a Private test; It's on TikTok on a stopped post turns `needs_you` back to `ok` (pressed or not; not for a
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
  Mac and Post with my Mac send a campaign clip with its label once its checks pass and refuse it with their words
  otherwise (§47.12); the words (one source for `CAMPAIGN_MAC_OFF`: `fit.TIKTOK_MAC_OFF`, `gates.TIKTOK_MAC_OFF` and
  the start of the Mac-off `_place_refusal` sentences; `PRESSED`, `MAC_STILL_LOOKING`, `NOT_UPLOADED`, `TIKTOK_PRIVATE_ONLY`; no string
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
  or "Not sure it posted" (§47.3 stuck rule). The server lets It's on TikTok make such a post his (§47.3). The
  helper's logged-in (§47.11) re-waits only a stopped post with no `macPressedAt` and never moves a press.
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
  without one it stops with TikTok's login sentence (`needsYou`, `code: "login"`: that hold ends by itself once the
  Mac is logged in to the right TikTok again, §47.11; since 1.2.2 the window stays 3 seconds after the session shows).
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
     it reads "Tap a place below to change it for this clip.", and TikTok's row line
     says "Who can see it: Everyone · …", never "not picked yet". Upload is never held with "Tap Use my settings
     first. TikTok needs your tap."
   * **TikTok's row is the clip's own** (since 2026-11-24, §47.12; from 2026-11-23 until then it was read-only, with
     `macPostsLine` and Change My settings, and a ticked label held Upload: `macTikTokHeld`, `MAC_LABEL_HELD`,
     `MAC_COMMERCIAL_HELD`, `commercialRow`, `MAC_ROW_COMMERCIAL`, all gone). The open row has Who can see it with
     TikTok Studio's three choices (`MAC_PRIVACY_OPTIONS`: Everyone, Friends, Only me; a saved Followers starts on
     Everyone, as Studio has none), the Comments, Duet and Stitch switches, and Commercial content (Your brand,
     Branded content; Branded content can't be Only me, TikTok's rule, shown as on the API path). All start on My
     settings with no tap; changing one makes the card's button "Use my settings" again, which puts them back. Nothing
     holds Upload for a label: the Mac adds TikTok's label (§47.12). "Posting as {name}" shows once TikTok's API named
     the account; with no name yet (not asked, slow, failed) the line is left out in this mode only.
   * **A campaign clip** in this mode has TikTok among its places (`campaignPlaces(…, tiktokGoes)`), starting on
     Everyone with Branded content (`campaignTikTokChoices`); the campaign checks hold Upload if he changes either.
     The card reads its campaign and fit again whenever the Mac switch changes, so an open Review never keeps a fit
     without TikTok.
   * **The line above Upload** (§47.4) is built for this clip: `MAC_HINT`, "TikTok: your Mac posts it for everyone.",
     only while the Mac posts this clip's TikTok and the card's own Who can see it is Everyone; with Friends or Only
     me it is `MAC_WHERE_LINE`, "TikTok: your Mac posts it." (the row says who). With a label it ends
     `macAddsLabel`: "TikTok: your Mac posts it for everyone and adds TikTok's Paid partnership label." (Promotional
     content for Your brand alone), a campaign clip's too.
   * TikTok's creator info (`GET /v1/accounts/tiktok/creator-info`, TikTok API data) is still asked, in the background
     as soon as TikTok is ticked, only for the account's name and the longest video it takes (`macCreator`). In this
     mode only, one ask serves every card for 60 seconds (`macCreatorInfo` in `Review.tsx`; a failed ask is not kept).
     Upload never waits for it: while it is slow or after it failed, the card uploads with the preset's choices and no
     creator (opening the TikTok row asks again), and the too-long check uses the creator's longest video once known.
   * The confirm body carries `tiktok`, as the server requires ("Pick who can see it on TikTok.", §47.2 item 1), and
     **`tiktokMac: true`**: `tiktok` is the card's own row (`macTikTokChoices`: the preset's privacy, Everyone when
     unset or Followers, with the preset's Comments, Duet and Stitch, then his changes and Commercial content as
     ticked), and the server hands exactly that to the Mac (§47.12). A normal clip with a label ticked and TikTok
     unticked still sends them, so the clip keeps its label (`Clip.tiktokLabel`) for a later Post with my Mac.
   * **Later step, shipped 2026-11-24 (§47.12, ADR-96):** per-clip TikTok choices and TikTok's label through the Mac
     (the helper's Branded content step, 1.3.0), the server honouring the card's own `tiktok` for a Mac post, the
     clip's label for Post with my Mac and Send these to my Mac, and campaign clips through the Mac with Content
     Rewards told.
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
   on these, TikTok too, except campaign clips." at the top, and under TikTok "Commercial content: off. Your Mac posts
   TikTok with these." in item 1's mode, with a shut "Paid partnership?" fold: "Tick Branded content in that clip's
   TikTok row.", "Your Mac adds TikTok's Paid partnership label when it posts it.", "Campaign clips have it ticked
   already." (§47.12); otherwise "Tap Use my settings on a clip to put these on." at the top, and "Commercial content: off. TikTok
   wants your own tap, so tap Use my settings on each clip." with the fold's one line "Tick Branded content in that
   clip's TikTok row.". The TikTok part's leaf (`settingsTree.ts`, `my-settings-tiktok`) reads
   "Everyone can see it; comments, Duet and Stitch on. Every clip starts on these while your Mac posts TikTok." in
   both modes. Ask's "Use my settings" guide (`helpKb.json`, `review-use-my-settings`, titled "Use my settings: your
   saved choices on every place", true in both modes) says every ticked place, TikTok included, starts on his settings
   while his Mac posts TikTok, so he just taps Upload, that he can change a clip's TikTok row (or My settings), and that a
   paid partnership gets Branded content ticked on that clip's TikTok row, which the Mac adds as TikTok's label;
   `review-place-rows` says the same after its Branded content step; `cr-tiktok` ("Campaign clips on TikTok") says
   campaign clips go through his Mac with the Paid partnership label; `review-upload-to` says to tap Use my settings
   only when the card does not already say Your settings are on. None of them tells him to post a clip himself in the TikTok
   app. docs/SETUP_POSTING.md says the same, and its demo step (`public-demo`, also in `tiktok.ts`) says to record
   with Your Mac posts TikTok off.
4. **Tests:** the Review tests (`web/test/reviewMac.test.tsx`) pin both modes: with the Mac on, TikTok starts on My
   settings and Upload is not held, also while creator info is slow or failed; the row is the clip's own (Who can see it with
   Studio's three choices, the switches, Commercial content) and Upload sends it with `tiktokMac: true`; Branded content
   ticked uploads with no hold and the label in the body, also with TikTok unticked; the line above Upload says
   `MAC_WHERE_LINE` with Friends picked and names the label when one is ticked; the shared creator-info answer is used in Mac mode
   only, and a card that switches to the API path asks again on Use my settings. With it off: today's unpicked start and
   held Upload, a fresh ask per card, and "Posting as" shown even with an empty nickname.
   `web/test/mySettingsTikTok.test.tsx` pins My settings' words in both modes; `helpEvals.json` has "Does TikTok need my
   tap each time?" → `review-use-my-settings`.

### 47.7 Not verified live

The helper itself (its own PR); that TikTok Studio keeps accepting a background Chrome's uploads, and the reach of
script-posted videos (the 3-post trial compares 24-hour views with his phone posts, plan note §3); that `video/list`
sees a post the Mac made (as §42.5).

### 47.10 Clips Funded posts TikTok through the same Mac (owner request, 2026-11-23)

The owner (2026-11-23, with a screenshot of Clips Funded › Social accounts › TikTok connected as @clips.funded through
Clip Factory's shared TikTok app, still in Sandbox, so API posts can only be private): "btw i want the same way we
upload to tiktok in clip factory for clips funded". Decision record: ADR-89.

Clips Funded's TikTok posts use the same Mac helper as Clip Factory (helper **1.2.0**). They post in hidden headless
Chrome, publicly, with the same claim, beats, never-twice rule, 30-minute find window, row states and "your Mac needs
you" flows. Three things are new: a separate TikTok login per account, a check of the signed-in handle before every
post (both workspaces), and TikTok's AI label on every Clips Funded post. Clip Factory's routes, server code and web
(§47.1 to §47.9) are unchanged; its only change is in the helper (the handle check, the profile proof, setup holding
run.lock). **No Terraform change**: every new route is under the existing `ANY /v1/workspaces/{proxy+}` on
cf-prod-stories-api (the shared JWT authorizer, so the helper's Cognito token works there), and every key is in
`USER#{u}#WS#{ws}` or `USER#{u}#WSREG`. No table, index, secret, bucket, stream prefix, env key or role changes.

#### 47.10.1 Rules

* **D1. Two lanes in one helper.** The *clips* lane (Clip Factory, @lamo.clips) is 1.1.0's code path, byte for byte on
  the wire. A *ws:{workspaceId}* lane (one per Clips Funded workspace whose id matches `^[a-z0-9][a-z0-9-]{0,39}$` or
  the server's generated `^[0-9A-HJKMNP-TV-Z]{26}$`) uses the new workspace routes. Each lane has its own Chrome profile, CDP port, ledger, pacing, needs-you and login.
  The lanes share only the Cognito sign-in, `device`, `settings.paused` and run.lock.
* **D2. Clip Factory first.** Each tick the clips lane decides and checks in first, exactly as 1.1.0. A ws lane posts,
  looks or logs in only in a tick where the clips lane has nothing to post, resume or find. A ws error is caught,
  logged (`ws.error`) and never reaches the clips lane. A ws post makes a Clip Factory job wait one tick at most
  (usually 2–3 minutes; at worst about 40, when the ws post meets a logout: the owner's login window, up to 20
  minutes, then the upload and the look for the link); Clip Factory's four auto-posting runs a day still post. While
  the clips lane posts, resumes or looks, the ws lanes' pressed posts still get their "finding" beat (`wsBeats`), so
  their rows don't go stuck meanwhile.
* **D3. Never another account.** Each workspace's jobs go only to that workspace's TikTok. The helper reads the
  signed-in handle in its own headless Chrome and refuses unless it equals the lane's target (the job's
  `account.handle` for Clips Funded; `GET /v1/accounts`' TikTok handle for Clip Factory, also while its token needs
  renewing, else the cached one, else the one account of the helper's own Clip Factory posts in `state.posted`, so a
  1.1.0 Mac goes on as it did). Both ways, each lane also refuses every other lane's account by handle and uid
  (`lanes.js otherAccounts`): a Clips Funded job never goes to Clip Factory's account, and a Clip Factory clip never
  goes to a Clips Funded account (the account its workspace connected, `state.ws[id].connected`, and the one its
  profile was set up as; never one a profile was only seen logged in to). Server side, the claim re-checks the open_id
  and the stored handle, and done refuses a link on another account. A ws lane is never set up as Clip Factory's
  handle or uid.
* **D4. AI label.** Every Clips Funded job carries `aiLabel: true`; the ws lane always turns on TikTok Studio's
  "AI-generated content" switch and reads it back, and stops before Post if it can't. Clips Funded posts are never
  branded: "Disclose post content" stays off (read back), `brandContent`/`brandOrganic` are false, and
  `publish.NEVER` still refuses `campaign`. Clip Factory's lane never touches either switch.
* **D5. Version gate 1.2.0.** `workspaces/mac.py` holds the exact line `MAC_WS_FROM = "1.2.0"` (the helper and web
  tests read it with `^MAC_WS_FROM = "(\d+\.\d+\.\d+)"$`). The ws queue is empty for `?version=` below it and a claim must
  carry a `version` at or above it. Helper 1.1.0 never calls `/v1/workspaces`. Clips Funded jobs never enter Clip
  Factory's `/v1/tiktok/mac` queue (another partition).
* **D6. Login: no password anywhere.** One visible sign-in, the owner's turn, in the ws lane's own profile (§47.10.5).
  Clips Funded has no Keychain TikTok login, so a later logout is his turn again.
* **D7. Fixed public defaults.** A Clips Funded Mac post is always Everyone, Comments on, Duet and Stitch on (Reuse of
  content), Audience control off, Disclose post content off and the AI label on, whatever the sheet sent. There is no
  per-post choice, so the Post it sheet shows one read-only line.
* **D8. The switch** `StoriesConfig.tiktokMac: {on: boolean}` (missing reads as off; no data reset), saved with the
  existing `PATCH /v1/workspaces/{ws}`, shown in Clips Funded › Social accounts › TikTok as **My Mac posts TikTok**.
  Clips Funded can't read Clip Factory's TikTok audit, so the Mac path is used while the switch is on.
* **D9. No infra change** (above).
* **D10. No Clip Factory web change.** Clips Funded's Mac status lives only in its own TikTok card; Clip Factory's
  Settings › Posting › Your Mac posts TikTok is unchanged.

The only ways to post in Clips Funded are Review › **Post it** and **Try again** (it has no auto-posting or scheduled
posting), so every Clips Funded Mac job is `source: "upload"` and goes at once, after any Clip Factory job.

#### 47.10.2 Data (Clips Funded's partitions only)

* **The switch:** `USER#{u}#WSREG` / `WS#{ws}` › `configuration.tiktokMac = {on}`. `stories/config/workspace-
  defaults.json` has `"tiktokMac": {"on": false}`. `_config_patch` takes `{on: boolean}` merged onto the current value
  (`{}` keeps it); any other inner key is a 400 "tiktokMac has a setting Clips Funded does not know.".
* **The Mac job is the story's TikTok `PUBJOB#`** with `publishingStatus: "mac"`. "mac" is in `publish.STATUSES` but
  not in `IN_FLIGHT` or `RETRYABLE`, so the story flow, `settle_stuck` and the API retry never touch it, and the flow's
  `load_jobs` skips it as a safety net.

  | Field | Value |
  |---|---|
  | `postOptions` | always `MAC_OPTIONS = {privacyLevel: "PUBLIC_TO_EVERYONE", disableComment: false, disableDuet: false, disableStitch: false, brandContent: false, brandOrganic: false}` |
  | `aiLabel` | always `true` |
  | `handle` | the recorded `@username` (`MAC_HANDLE = ^@[A-Za-z0-9._]{2,30}$`, else publish answers 409 and writes nothing) |
  | `externalAccountId` | the recorded open_id |
  | `macState` `macStep` `macSince` `macSource` (`"upload"`) `macClaimedAt` `macPressedAt` `macStoppedAt` `macReason` `macBeatAt` `macDevice` `macAttempt` `macPressedBefore` `macAgainAt` | the same names and meanings as Clip Factory's (§47.1); all removed once posted |
  | `beforeMac` | only after a hand-over in place: the Only me job's earlier fields |
  | `via: "mac"` / `by: "you"` | once the Mac's done / the owner's It's on TikTok saved it |

* **The workspace's helper item** `USER#{u}#WS#{ws}` / `MACHELPER` (`ws.MACHELPER_SK`, in `ITEM_PREFIXES`; type
  `ws_machelper`; `userId` and `workspaceId` for `guard.owned`): `seenAt`, `state` (`ok` | `needs_you` | `paused`),
  `reason?` (≤ 200 characters), `version`, `device`, `setUp` (the lane's profile is logged in to the target),
  `handle?`, `needsYouJobId`/`needsYouStoryId` (a stop with `needsYou`; removed by any ping that isn't `needs_you` and
  by the owner's Try again or It's on TikTok on that job, or the helper's logged-in, §47.11), `needsYouCode` (`"login"`,
  §47.11: the same write, removed with them), `needsYouDevice` (§47.11: the Mac that stopped, the same write, removed
  with them, never public; a `needs_you` ping never starts a hold: on an item that isn't `needs_you` it checks in as
  `ok`), `loginRequestAt` (the owner's Log in on my Mac; removed by a
  ping whose `loginDone` equals it, a conditional REMOVE), `resumeRequestAt` (the owner's Start my Mac again; removed
  by a ping whose `resumeDone` equals it). It is never Clip Factory's `USER#{u}`/`MACHELPER`, so a
  Clips Funded problem never pauses Clip Factory's posts and the other way round. `PUBJOB#` and `MACHELPER` are not
  stream prefixes (`test_ws_keys` pins it), so the web polls.
* **Timing:** `MAC_BEAT_STALE`, `MAC_CLAIM_MAX` and `MAC_FIND_WINDOW` are imported from `tiktok_self` (not edited);
  `STALE_CLAIM` (15 minutes) is a one-line copy pinned equal to `tiktok_mac.STALE_CLAIM` by a test, because
  `workspaces/mac.py` never imports `tiktok_mac` or `clipfactory_api.routes.*`.
* **Story posted:** the story's posted list, `publishedAt`, `status: published` and the `ACT#` "posted" item are written
  by `workspaces/story_posted.py` (`story_write`, `activity`), which both the flow and `workspaces/mac.py` use (the API
  never imports the flow module). A Mac job handed over from Only me (`beforeMac.url`) replaces that private link in
  the story's posted list (`story_write(..., replace=)`), so the story keeps one TikTok link.

#### 47.10.3 Publishing with the switch on (`workspaces/publish.py`)

1. **Post it, TikTok target:** every check runs as today (`clean_options` on the sheet's full options, `_check` with
   `validate_destination`, the confirmAccount 409s and G8, then `_clash`). The job is then written as a Mac job
   (`MAC_OPTIONS`, `aiLabel`, `macState "waiting"`, `macSince` now, `macSource "upload"`, `macAttempt 0`). No `@handle`
   on the destination → 409 "Connect TikTok again in Social accounts, so your Mac knows the account." and nothing is
   written. `starter.ready` is needed only when the body has a non-Mac target, and the flow starts only for those.
2. **`_clash`:** "mac" counts as being posted ("This story is already being posted to TikTok."). One exception: a
   TikTok job the API posted Only me (`postOptions.privacyLevel == "SELF_ONLY"`) is **handed over in place** in the
   same transaction, conditional on `posted` and its `flowRun`: its fields go into `beforeMac`, `url`, `postedAt`,
   `privacy`, `platformPostId`, `statsId`, `metrics`, `numbersAt` and `error` go, and it becomes the Mac job. The story
   keeps one TikTok row.
3. **API retry** of a `failed` or `needs_attention` TikTok job while the switch is on: the job becomes a Mac job in
   place, conditional on its status and `flowRun`; no flow starts. Retry of a `mac` job → 409 "Your Mac posts this
   one. Tap Try again on its row."
4. **`PublishingJob`** gains `mac` (`PubJobMac`, only while the status is `mac`), `via`, `by`, and `onlyMe: true` on a
   TikTok job posted Only me (the row's Post with my Mac).
5. **Dashboard:** a stopped Mac job joins Needs you with its stored reason, `href` `/stories/review/{storyId}`,
   `publishingStatus: "mac"` and `mac`.

#### 47.10.4 Routes (JWT, all under `/v1/workspaces/{ws}`, stories workspaces only)

Unknown body keys are a 400, Clip Factory's workspace id a 409, another owner's job a 404 "We could not find that
post.". The logic and every conditional write live in `workspaces/mac.py`; the routes in `workspaces/routes/mac.py`.

| Method and path | Body | 2xx |
|---|---|---|
| GET `/tiktok/mac` (`?version=` optional) | – | `WsMacStatus` |
| POST `/tiktok/mac/ping` | `{state, reason?, version, device, setUp, handle?, loginDone?, resumeDone?}` | `{on}` |
| POST `/tiktok/mac/login` | `{action: "sign_in"}` | `{helper}` |
| POST `/tiktok/mac/request` | `{action: "resume"}` | `{helper}` (the owner's Start my Mac again) |
| POST `/publishing/{id}/mac/claim` | `{device, version}` | `{job: WsMacJob}` |
| POST `/publishing/{id}/mac/step` | `{device, step, attempt?}` | `{job: WsMacJob}` (a re-sent step is the beat) |
| POST `/publishing/{id}/mac/done` | `{device, link, attempt?}` | `{job: PublishingJob}` |
| POST `/publishing/{id}/mac/stopped` | `{device, reason, needsYou?, attempt?, code?: "login"}` | `{job: WsMacJob}` (`code` §47.11) |
| POST `/publishing/{id}/mac/logged-in` | `{device}` | `{helper: WsMacHelper \| null, outcome}` (the helper only, §47.11) |
| POST `/publishing/{id}/mac/retry` | `{notOnTikTok?, confirmAccount?}` | `{job: PublishingJob}` (the owner's Try again) |
| POST `/publishing/{id}/mac/posted` | `{link}` or `{noLink: true}` | `{job: PublishingJob}` (the owner's It's on TikTok) |

The helper downloads with the existing `GET …/stories/{storyId}/download` → `{url}` (saved as `job.fileName`) and tidies
with the existing `GET …/publishing`.

* **GET /tiktok/mac:** `on` = `configuration.tiktokMac.on === true`; `account` = SOCIAL#tiktok's `{handle,
  accountName, status}` or null; `queue` = the Mac jobs `waiting` or `working`, oldest `macSince` first, at most 50;
  `[]` while the switch is off or when `?version=` is below `MAC_WS_FROM` or not a version. The web calls it without
  `version`.
* **Ping:** `state` one of the three; `device` required (≤ 100); `version` required (≤ 20); `setUp` a boolean
  (required); `handle` `^@[A-Za-z0-9._]{1,30}$`; `loginDone` and `resumeDone` ≤ 40. A missing reason or handle
  removes it.
* **Login:** no helper item, or a version below `MAC_WS_FROM` → 409 "Update the helper on your Mac first."; another
  action → 400 "Pick sign_in.". Otherwise `loginRequestAt = now`.
* **Request** (Start my Mac again): the same 409 for no or an old helper; another action → 400 "Pick resume."; a helper
  that isn't `paused` → 409 "Your Mac isn't paused." (one conditional write). Otherwise `resumeRequestAt = now`. The
  helper ends this Mac's pause (`settings.paused`, the same one Clip Factory's Start my Mac again ends: every lane's)
  and sends `resumeDone`.
* **Claim**, in order: not a Mac job → 409 "Your Mac isn't posting this one."; switch off → 409 "My Mac posts TikTok
  is off in Clips Funded."; version too old → 409 code `mac_old` "Update the helper on your Mac."; not claimable as read
  (another device still holds it) → 409 "Another try already has this post." (never stopped); then
  `validate_destination(..., at_tap=False)` and the stored handle equal to the job's (case-insensitive). A failure
  stops the job in one conditional write and answers 409 with the reason: "Clips Funded's TikTok is a different
  account now. Tap Try again.", "The video is gone. Make it again, then tap Try again.", "Connect TikTok again in Social
  accounts. Then tap Try again.", or Clips Funded's own G8 / can't-tell-apart sentence. The claim's write is §47.3's:
  waiting with no `macPressedAt`, or working with no `macPressedAt` and a beat older than `STALE_CLAIM`; it sets
  working, `macClaimedAt`, `macDevice`, `macBeatAt`, step `video` and `macAttempt + 1`.
* **Step, Stopped, Retry, It's on TikTok:** §47.3's rules with `source: "upload"`. The attempt is fenced and only
  `macDevice` may step; the first `pressing` sets `macPressedAt`; the switch off before the press → 409, after it steps
  go on; after a press the stopped reason is always PRESSED ("Your Mac pressed Post but couldn't confirm it. Look on
  your TikTok: if it's there, tap It's on TikTok."); `needsYou` sets the **workspace** helper item to `needs_you`.
  Retry: working and not stuck → 409 "Your Mac is posting it right now. Wait a minute."; pressed without
  `notOnTikTok` → 409 "Your Mac may have posted it already. Check your TikTok first."; inside the find window → 409
  "Your Mac pressed Post less than 30 minutes ago. …"; it runs the at-tap check (`publish._check`): a changed account
  answers 409 with `error.account` until `confirmAccount` names it, and for the same open_id it refreshes `handle` and
  `accountName`. On success the job waits again (keeping `macSince`), `macAgainAt` set and a press moved to
  `macPressedBefore`; a stopped job keeps `macDevice`/`macBeatAt`, a stuck one loses them. It's on TikTok: allowed
  while waiting or stopped, or working once stuck; without a link never on a working job that never pressed (409 "Your
  Mac is posting it right now. Wait a minute." while its beat is fresh, else "Your Mac stopped before it pressed Post,
  so it isn't on TikTok. Tap Try again."); with no link the story's posted entry has url "".
* **Done** (and It's on TikTok with a link): a link that is not `^https://(www\.)?tiktok\.com/@name/video/{8–25
  digits}` is a 400 "Paste the video's full TikTok link: tiktok.com/@name/video/…"; a link whose `@name` is not the
  job's `handle` (case-insensitive) is a 409 code `wrong_account` "That post is on another TikTok account." with nothing
  written. On success one transaction makes the job `posted` (`via "mac"`, or `by "you"`), the canonical url,
  `postedAt`, `privacy: "public"`, the mac* fields gone, plus the STORY# update and the ACT#. A repeat is answered as
  the first. No finder and no TikTok call: the stories Lambda can't use Clip Factory's token, and must not.
* **Stuck:** no beat for 5 minutes, or a claim 50 minutes old (every 1.2.0 helper beats).

```ts
type MacStep = "video" | "opening" | "uploading" | "settings" | "pressing" | "finding";
interface WsMacJob {
  workspaceId: string; publishingJobId: string; storyId: string;
  hook: string;                 // the story's title
  caption: string;              // postCaptions.tiktok, else the title; mojibake-repaired, NFC
  fileName: string;             // "clips-funded-{slug}.mp4"
  account: { handle: string; openId: string };   // the ONLY account it may go to
  aiLabel: true; privacy: "PUBLIC_TO_EVERYONE"; comment: true; duet: true; stitch: true;
  source: "upload"; since: string; state: "waiting" | "working" | "stopped"; step?: MacStep;
  claimedAt?: string; pressedAt?: string; beatAt?: string; attempt: number; pressedBefore?: string; againAt?: string;
}
interface WsMacHelper {
  seenAt: string; state: "ok" | "needs_you" | "paused"; reason?: string; version?: string; setUp: boolean;
  handle?: string; needsYouJobId?: string; needsYouStoryId?: string; loginRequest?: { at: string };
  resumeRequest?: { at: string };  // never the device
}
interface WsMacStatus {
  on: boolean; helper: WsMacHelper | null;
  account: { handle: string | null; accountName: string | null; status: string } | null; queue: WsMacJob[];
}
interface PubJobMac { state: "waiting" | "working" | "stopped"; step?: MacStep; since: string; claimedAt?: string;
  pressedAt?: string; stoppedAt?: string; reason?: string; beatAt?: string; pressedBefore?: string; againAt?: string }
// PublishingJob: publishingStatus adds "mac"; mac?: PubJobMac; via?: "mac"; by?: "you"; onlyMe?: true.
// StoriesApi: macStatus(ws), macLogin(ws), macResume(ws), macRetry(ws, id, {notOnTikTok?, confirmAccount?}),
//   macPosted(ws, id, {link} | {noLink: true}). The web never calls the helper's own routes.
```

#### 47.10.5 The helper, 1.2.0 (`mac/tiktok-helper/**`)

* `VERSION = "1.2.3"` in paths.js, package.json and package-lock.json (1.2.1: §47.3's token rule, in every lane and
  CLI command; 1.2.2: a login hold ends by itself, §47.11; 1.2.3: §47.11's re-review fixes, a pause during a look or
  since a lane decided wins and only the Mac that stopped looks). Clip Factory's ping says it (≥ `MAC_BEATS_FROM`, so
  beats keep counting) with the same keys as 1.1.0.
* **Lanes** (`src/lanes.js`): `clipsLane` is 1.1.0's (profile `chrome/`, port 9339, Keychain items `tiktok-username`/
  `tiktok-password`, the top-level ledger, pacing, trial and backfill). `wsLane` has profile `chrome-ws-{id}/`, the
  lowest free port of 9340–9349 (kept in state.json), its own store `state.ws[id] = {port, ledger, posted,
  lastPressedAt, connected (the workspace's TikTok @name, from its status), account: {handle, uid?, setUpAt?,
  checkedAt}}` and no Keychain (`keychain: null`, so `readLogin` never
  falls back to Clip Factory's items). A ws job is normalised to `clipId = publishingJobId` with the fixed public
  options and the AI label, so plan.js, beats.js and the ledger run unchanged; that id only ever goes to
  `wsClient`, which never builds a `/clips/` path. `client()` gains two reads: `GET /v1/accounts` and
  `GET /v1/workspaces` (items with `workspaceType: "stories"`).
* **Tick:** lock → settings, state, sign-in (a sign-in problem stops both lanes, as today) → **A** the clips lane as
  1.1.0, plus its target (`GET /v1/accounts`' TikTok `@handle`, connected or needing renewal, cached in
  `state.clipsAccount`; else the cache; else `postedHandle`: the one @name of the clips lane's own posted links, never a
  Clips Funded account; with none of these a post, resume or find becomes wait and the ping says `paused` with "Your
  Mac can't tell which TikTok is Clip Factory's. Connect TikTok in Settings › Posting.", never a silent stall) → **B**
  one `GET /v1/workspaces`, then for each stories workspace its queue (`?version=1.2.0`), its `connected` account
  kept, the owner's Start my Mac again (`helper.resumeRequest`: `settings.paused` false, `resumeDone` in the ping),
  `wsAction` (`nextAction` on the lane's own view, with trial, backfill and hold cleared and its own needs-you; a new
  post waits, "Not logged in to TikTok on this Mac yet.", until the lane is set up) and its ping → **C** one thing:
  Clip Factory's post, resume or find (with `wsBeats` for the ws lanes' pressed posts); else the first ws
  lane's find, then resume, then post; else a pending ws login request; else tidy (Clip Factory's, plus kept ws files
  whose job `GET …/publishing` shows posted). A lane held only for a TikTok login first looks whether it is logged in
  again (§47.11, A and B). Pacing (`lastBacklogAt`, `lastRunPressAt`, `backfillPosts`, the trial
  count) and `haltOnStop` are the clips lane's only. `settings.paused` pauses every lane. Before C's find, resume or
  post is claimed or driven, `pausedSince` reads `settings.json` once more (1.2.3): each lane decided before the
  later lanes' looks and check-ins, and `cli.js off` takes no lock, so a pause since then makes the work wait
  (`paused.before_work` in the log; Clip Factory's tick answers `paused`) and the next tick pings `paused`.
* **Chrome** (`chrome.js`, `src/cdp.js`): per-lane `--user-data-dir` and `--remote-debugging-port`, still headless=new
  and spawned directly (no window, no Dock icon, no focus). One helper Chrome at a time: other lanes' Chromes (9339 and
  the ports in `state.ws`) close first. A Chrome already on the lane's port is reused only when
  `<profile>/DevToolsActivePort` proves it (line 1 the port, line 2 the path of `/json/version`'s
  `webSocketDebuggerUrl`); otherwise it is closed and a fresh one spawned. `cdp.js` speaks only to the browser target
  (`Storage.getCookies`, `Storage.clearCookies`, `Browser.close`).
* **Which account** (`src/whoami.js`, used in tiktok.js). Sources, each a pure parser: (1) the in-page
  `/passport/web/account/info/?aid=1988` → `username`, `user_id_str`; (2) the `/@name/video/` links of Studio › Posts
  (only on Studio: on www.tiktok.com's feed those links are other people's and are not read); (3)
  `__UNIVERSAL_DATA_FOR_REHYDRATION__` › `webapp.app-context.user`. `sameAccount`: handles compared in lower case
  without "@"; every readable handle must be the target and a readable uid the pinned one (and never another lane's
  uid), else `wrong`; nothing readable → `unknown`; the account's own data (sources 1 and 3, `seen.own`) on the target
  with a Studio row's link on another @name → `unknown` (no post, and no needs-you for a login that is right). Where it runs, in both lanes: after Studio opens and before Posts is read (falling back to
  www.tiktok.com when Studio shows no handle); right before Post (the session cookie's hash, kept in memory only, is
  unchanged, or source 1 positively reads the target); in `find()` before reading; and on the link in `finished()` (its
  `@name` must be the target, or done is never sent). Wrong → a needs-you stop; unreadable with a TikTok session →
  retried on later ticks (3 tries, then "Your Mac couldn't see which TikTok it's logged in to. …"); unreadable with no
  session at all → the lane's logged-out flow; in a ws lane, nothing readable at all three times (a cookie but no
  account: TikTok ended the session on its side) → the lane is no longer set up and stops with "Your Mac couldn't see
  which TikTok it's logged in to. Nothing was posted. Tap Log in on my Mac.". A ws lane never runs caption matching
  against older posts (`findExisting`): `find()` always uses the baseline saved at pressing. One exception: a job with
  `pressedBefore` (the owner's Try again after a press) first looks, in `post()`, for a row with its caption that is
  new since that first press (`ledger.earlier`, the Studio ids from before every earlier press, kept by a fresh
  claim); if one is there, that link is done and nothing is posted again.
* **Login window** (`login.js loginWindow`, for setup, Log in on my Mac, and a ws post that finds TikTok logged out):
  every helper Chrome closes; the yellow frame and one pop-up, "Log in to TikTok as {target} in the window. Scan the
  code with the TikTok app."; first the lane's cookies are cleared (`forget`: a session TikTok ended on its side,
  its cookie still in the profile, would read as a login at once and the window would close by itself); then a
  **visible** Chrome on the lane's profile and port at TikTok's QR-code login page
  (`https://www.tiktok.com/login/qrcode`, in English) that Playwright never attaches to (no `--enable-automation`, no
  page attached). Before it opens, its profile's Preferences turn off password saving, auto sign-in, autofill and
  Chrome sign-in (`chrome.js hardenProfile`), and it runs with `--disable-sync`, so nothing he does there keeps a
  password. Every 3 seconds `Storage.getCookies` looks for a `.tiktok.com` `sessionid` (never its value); 3 seconds
  after it shows, the window closes and the headless Chrome reads the handle. The target (and not Clip Factory's
  handle or uid) → any google/youtube cookies leave the profile, the account is pinned (`setUpAt`), the ping says
  `setUp: true` and `handle`, and a login-type needs-you clears. Another account → that profile's cookies are cleared, the pop-up says
  "That's {seen}. Log in as {target}." and the window opens once more. After 20 minutes the window closes; inside a post
  the job stops with "TikTok logged your Mac out. Tap Log in on my Mac." and needs-you; after a request `loginDone` is
  still sent. When the profile already reads the target nothing opens. Setup and every login window hold run.lock.
  Logged in as the target while held for a TikTok login, the job's logged-in route ends the hold first (§47.11).
* **AI label** (`tiktok.js`, ws lanes only, forced by the lane kind): the switch named "AI-generated content" or
  "AI-generated" (under Show more) is set on and read back, and read again right before Post; absent, or locked off →
  "Your Mac couldn't turn on TikTok's AI label, so it didn't post. Tap Try again."; locked on (TikTok's own label) is
  fine. A dialog whose text matches /AI-generated/i may be confirmed with /^(turn on|confirm|ok|got it)$/i; any other
  dialog still stops. "Disclose post content" is kept off and read back.
* **Files, events, CLI:** `ownFile` also accepts `clips-funded-*.mp4` directly in Downloads. Every event carries
  `account` (`"clips"` | `"ws:{id}"`); new kinds `wrong_account` and `login_window` `{account, outcome}`. CLI:
  `setup --workspace <id>`, `whoami [--workspace <id>]` (handles, target and whether they match; never a cookie),
  `probe --workspace <id> --story <storyId>` (up to Post, AI label included, saves `probe-ws-<id>.png`, posts nothing),
  `status` (every lane). `install.sh` is unchanged (one launchd job serves every lane); `uninstall.sh --all` also
  deletes the `tiktok-username`/`tiktok-password` Keychain items.
* **Words** (ws lanes; Clip Factory's REASONS stay word for word): "TikTok logged your Mac out. Tap Log in on my Mac.";
  "TikTok's upload page looks different. Your Mac's helper needs a fix. Then tap Try again."; "TikTok says it's
  posting too much right now. The rest wait."; both lanes: "Your Mac is logged in to TikTok as {seen}, not {target}.
  Nothing was posted." (needs you), "Your Mac couldn't see which TikTok it's logged in to. Nothing was posted. Tap Try
  again.", "The post showed up on {seen}, not {target}. Look on your TikTok."; Clip Factory's lane: "That TikTok account
  is your other workspace's. Nothing was posted. Connect TikTok again in Settings › Posting." (needs you); ws only:
  "That TikTok account is your other workspace's. Nothing was posted. Connect TikTok again in Social accounts.", "Your
  Mac couldn't see which TikTok it's logged in to. Nothing was posted. Tap Log in on my Mac.", the AI label sentence,
  and "The video is gone. Make it again, then tap Try again." (download 404/409). A login reason (the card's Log in on
  my Mac) is exactly the logged-out sentence, the nothing-readable sentence, or starts with "Your Mac is logged in to
  TikTok as " (helper `loginReason`, web `loginReason`, pinned to each other).

#### 47.10.6 What the owner sees (web, `web/src/stories/**` only)

* **The TikTok card** (`studio/TikTokMac.tsx`, id `tiktok-mac`, in Social accounts › TikTok outside the setup steps,
  once Clips Funded's TikTok is connected or while the switch is on; `GET …/tiktok/mac` every 60 s while on, every
  10 s while a login or a start request waits):

  | When | Says | Button |
  |---|---|---|
  | off | **My Mac posts TikTok** · "Off. Your Mac doesn't post TikTok." | the switch |
  | on | "On. Post it hands TikTok to your Mac. It posts for everyone, with the AI label." | the switch |
  | no 1.2.0 check-in | "Your Mac isn't set up yet." and the steps "1. Ask for the helper update on your Mac. 2. Tap Log in on my Mac. 3. In the TikTok app, switch to {handle}, then scan the code." | – |
  | 1.2.0, not set up | "Your Mac isn't logged in to {handle} yet." and steps 2–3 | **Log in on my Mac** |
  | asked | "Look at your Mac. A TikTok window opens within a minute." | – |
  | set up | "Your Mac checked in {time} · logged in as {handle}." | **Log in on my Mac** (quiet) |
  | needs you | "Your Mac needs you: {reason}" (with `needsYouCode: "login"` one quiet line under it, §47.11) | **Log in on my Mac** for a login reason, else **Open the stopped post** |
  | paused | "Paused on your Mac · your posts wait until it's started again." | **Start my Mac again** (`macResume`) |
  | asked to start | "Your Mac starts again within a minute." | – |
  | not seen for 30 minutes | "Your Mac hasn't checked in since {time}." | – |
  | always while on | "To stop it, turn the switch off. Your Mac stops at once." | – |

* **Post it** (`PublishSheet`, Mac mode while `config.tiktokMac?.on`): TikTok's part is read-only, "Your Mac posts it
  for everyone, with the AI label." and "Comments, Duet and Stitch on."; no Who can see it and no Commercial content;
  Upload never waits for creator info (still read for Posting as and the length limit); it sends `MAC_TIKTOK_OPTIONS`
  plus confirmAccount. Not set up: "Your Mac isn't set up yet. It posts once it is." with **Set it up**.
* **The TikTok row** (`studio/macRow.ts`, timing from `web/src/lib/tiktokMac.ts`, imported only):

  | # | State | Chip | Row says | Button |
  |---|---|---|---|---|
  | 1 | posted, `via: "mac"` | Posted | "Posted by your Mac · Everyone" | **Open** |
  | 2 | posted, `by: "you"` | Posted | "On your TikTok" (" · no link") | **Open** with a link |
  | 3 | waiting, switch off | Waiting for your Mac | "My Mac posts TikTok is off" | **Turn on** |
  | 4 | waiting, no 1.2.0 helper or not set up | Waiting for your Mac | "Your Mac isn't set up yet" | **Set it up** |
  | 5 | waiting, not seen 30 minutes | Waiting for your Mac | "Your Mac hasn't checked in since {time}" | – |
  | 6 | waiting, needs you on another post | Waiting for your Mac | "Your Mac needs you · look at your Mac" | **Open the stopped post** |
  | 7 | waiting, paused | Waiting for your Mac | "Paused on your Mac" (" · starting again within a minute" once asked) | **Start my Mac again** (until asked) |
  | 8 | waiting | Waiting for your Mac | "Waiting for your Mac · next" / "… · in line (N before it)" | – |
  | 9 | working, not stuck | Posting… | "Posting…" with the spinner | – |
  | 10 | working, stuck, no press | Didn't work | "Your Mac stopped before it pressed Post" | **Try again** |
  | 11 | pressed (stuck or stopped) | Not sure it posted | "Not sure it posted · look on your TikTok" (" · Try again from {time}" inside the window) | **It's on TikTok** (link box, "It's on TikTok, no link"); after the window a quiet **Try again** that asks "Post it again? Only if it's not on your TikTok." and sends `notOnTikTok` |
  | 12 | stopped | Didn't work | "Didn't work: {the reason's first sentence}" | **Try again** (and Open Social accounts when the reason names it, §45.36 E9; **Set it up**, to the card's Log in on my Mac, for a login reason) |
  | 13 | posted `onlyMe`, switch on | Posted | "Only you can see it on TikTok" | **Post with my Mac** (Post it with only TikTok ticked) |

  `PUBLISH_LABEL.mac` "Your Mac", tone sky. Review polls every 10 s while a Mac job waits or works and reads the Mac
  every 60 s while one is shown; Try again calls `macRetry`, It's on TikTok `macPosted`. Dashboard's Try again on a Mac
  item calls `macRetry`; a pressed one has only **Open**.
* **Mock** (`api/mock/mac.ts`): the same rules with knobs `macOn`, `macHelper`, `macConnected` and
  `window.__cfStoriesMock.mac` (`ping`, `claim`, `beat`, `step`, `done`, `stopped`, `age`, `helper`, and §47.11's
  `loggedIn`); a bad link is the API's 400, another account's link its 409.

#### 47.10.7 Clip Factory stays exactly as it is

No edits to `api/src/clipfactory_api/{tiktok_mac.py, tiktok_self.py, posts.py, uploads.py, settings.py, routes/**,
autopost/**}`, Clip Factory's web or `infra/**`. `/v1/tiktok/mac*` and `/v1/clips/{id}/tiktok/mac/*` carry the same
bodies; the ping keeps its keys (`backlogAt`, `holdBefore`, `backfill`). The clips lane keeps its profile, port,
Keychain items, ledger, pacing, trial, backlog slot, backfill, tidy and `deleteVideo`, and goes first every tick; it
gains the handle check (and refuses a Clips Funded account), the profile proof and setup holding run.lock. **Go-live
gate:** `whoami` must print @lamo.clips before 1.2.0 is started. If Clip Factory's stored TikTok handle is a nickname
without a username, the clips lane takes the account of its own earlier posts (`state.posted`, all on @lamo.clips),
so it goes on as 1.1.0 did; with neither, its ping says paused and why.

#### 47.10.8 The owner's one-time step (after merge and deploy; every Mac step only on his command)

1. A session runs, from a main checkout, `cd mac/tiktok-helper && ./install.sh --no-start`, then
   `node "$HOME/Library/Application Support/Clip Factory TikTok/app/src/cli.js" whoami`. It must print @lamo.clips
   and `"matches": true`; if not, nothing is started and 1.1.0 is reinstalled from the previous main commit. Then
   `./install.sh`.
2. In Clips Funded › Social accounts › TikTok he turns on **My Mac posts TikTok**, then taps **Log in on my Mac**.
3. A TikTok window opens on the Mac with a code (yellow frame). On the phone: TikTok app → switch to @clips.funded
   (add it once with Continue with Google, his Google account, if it isn't there yet) → scan the code → Log in. The
   window closes by itself and the card says "logged in as @clips.funded". The code, not Google in the window: then
   nothing is typed on the Mac.
4. Optional, posts nothing: `node ".../cli.js" probe --workspace stories --story <an approved story>`.
5. He is told: TikTok may link two automated accounts on one Mac and network, so an automation flag could hit both.

No password goes into chat, logs, files or the server at any step: the QR code leaves only TikTok's session cookie in
the `chrome-ws-stories/` profile. Should he use Google in the window anyway, that profile can't save a password
(`hardenProfile`), and its Google cookies are deleted once TikTok's login is in.

#### 47.10.9 Tests (targeted; CI is the full run)

* **API:** `tests/test_ws_tiktok_mac.py` (publish to a Mac job with no flow, mixed targets, the missing handle, clash,
  the Only me hand-over and `onlyMe`, the API retry in place and its 409 on a Mac job, the flow never sending a Mac job,
  the queue off / old version / no version, ping and login, every claim refusal and the conditional rules, steps and
  beats, needs-you only on the workspace item, the dashboard item, done and It's on TikTok with their link rules,
  retry's window and confirmAccount, 400 on unknown keys and 404 for another owner on every route, no Clip Factory
  partition write, Start my Mac again and its `resumeDone`, the handed-over post's one TikTok link on the story);
  `ws_routes_mac.py` in `test_ws_http`'s union; `test_ws_separation`'s sweep; `test_ws_keys`
  (`MACHELPER_SK`); `test_story_flow` (Mac jobs skipped, `story_posted` the same); `test_tiktok_mac.py` unchanged.
* **Helper** (`node --test`): lanes, whoami (the parsers, `sameAccount`, links ignored off Studio), chrome (the
  DevToolsActivePort proof, per-lane flags), plan (`wsAction`, `pickWork`, Clip Factory first), tick (whole ticks
  against a fake server and Keychain: Clip Factory's check-in keys and order are 1.1.0's, a ws failure never stops
  Clip Factory's claim, no @name in Settings → the account of its own posts, none at all → a paused ping with why,
  Start my Mac again in Clips Funded, the ws pressed post's beat during Clip Factory's post), lanes (`otherAccounts`,
  `refusedTarget` both ways, the generated id), api (wsClient paths, `version` on claim and queue, never `/clips/`),
  files, constants (`MAC_WS_FROM` read from the API file), words, chrome (`hardenProfile`) and login (old cookies
  cleared before the window, Google cookies after it); the 1.1.0 tests unchanged.
* **Web:** `test/storiesTikTokMac.test.tsx` (every card state and row, the sheet's Mac mode, Review and Dashboard,
  the mock's rules, `MAC_WS_FROM` and the logged-out words pinned to the API and helper files, no reversed name);
  `e2e/stories-tiktok-mac.spec.ts` (turn on → Post it → Waiting → Posting… → Posted by your Mac · Everyone; stopped →
  Try again; pressed and stopped → It's on TikTok with its link).

#### 47.10.10 Not verified live (each one fails closed)

Which handle sources TikTok really serves (none readable → nothing posts; `whoami` is the gate); the AI switch's name,
place and dialog in Studio (`probe` checks it); the QR page in an unattached window, and that Chrome keeps the
hardened Preferences; DevToolsActivePort in headless=new (missing → a fresh Chrome); that the
`com.clipfactory.no-test-windows` guard leaves the helper's login window alone. The API path still labels only
realistic makers. Follow-ups, to match Clip Factory fully: view numbers on Mac-posted Clips Funded videos (the video id
from the link, read with the workspace token), Find it for me (It's on TikTok is paste-only), a "post these with my
Mac" for stories already on @clips.funded as Only me (today one by one), and a line telling him the Only me copy of a
handed-over story stays on TikTok (the story itself keeps one link).

### 47.11 A TikTok login hold ends by itself once the Mac is logged in again (owner request, 2026-11-24)

The owner, asked "Shall I make the helper clear that message by itself once you have logged in?": "Yes, fix it". On
24 Nov TikTok logged the helper's Chrome out after a Chrome update; he logged it back in (`cli.js setup`, `whoami`
said @lamo.clips), but Settings kept "Your Mac needs you: TikTok logged your Mac out. …" and every tick logged
`tick action:"paused"` until he tapped Try again on the stopped clip: only the owner's answer cleared the hold, and
the helper repeated `needs_you` in every ping.

**The rule.** When a lane's stop is only a TikTok login problem (logged out, a login needed, or the saved login
refused) and the helper later sees that lane's Chrome profile logged in to exactly that lane's target account, the
hold ends and the stopped clip waits for the Mac again, as after Try again. The web then shows the normal state
("Your Mac checked in …", the clip waiting, posting, posted) with no tap. **Never** for any other hold (a puzzle or a
code, a limit or a warning, "three times", the owner's pause or switch, a Clip Factory sign-in), never on another
account (@clips.funded in Clip Factory's lane is refused and the hold stays, saying so), never twice (the ledger's
`pressedAt` and finding, and the server's press rules, are unchanged), and nothing more on his screen (no window, no
frame, no Apple Events).

* **D1, the code.** `POST …/tiktok/mac/stopped` (both apps) takes `code?`; only `"login"` (`HOLD_CODES = ("login",)`
  in `tiktok_mac.py` and `workspaces/mac.py`, one line each, read by the helper's `constants.test.js`), else 400 "code
  must be login.". A stop with `needsYou` and the code sets `needsYouCode = login` in the same `update_expr` that sets
  `needs_you` and `needsYouClipId` / `needsYouJobId`; a needs-you stop without it removes it, so a puzzle after a login
  never inherits "login"; a code without `needsYou` holds nothing and isn't stored. The same write sets
  `needsYouDevice` = the stopping device (never public; review, 24 Nov: every ping rewrites `device`, and a second Mac
  pings `needs_you` every minute, so `device` can't say which Mac stopped; a hold written before this field has none,
  D2). `needsYouCode` and `needsYouDevice` also
  go with any ping whose state isn't `needs_you` and with `clear_needs_you` (Try again, It's on TikTok, in both apps);
  a `needs_you` ping keeps them. Public: `MacHelper.needsYouCode?` / `WsMacHelper.needsYouCode?`, only while `needs_you`.
  The helper sends it only where `isLogin(e)` (`e instanceof Stop && e.reason === REASONS.login`: it reads the Stop,
  never the words): doPost's and doFind's relogin-failed branch, and their plain `Stop` branch when that Stop is the
  login one (a logout right after a login, or after Post was pressed). A puzzle or code while logged in, the limit,
  "Something went wrong", a popup, the wrong account, the other workspace's account, a link on another account, "three
  times", the AI label, the video gone, who-unknown and Clips Funded's `nobody` never carry it. Pauses
  (`settings.paused`, the trial, a batch's `haltOnStop`) are `paused`, the switch is off, and a sign-in problem never
  reaches the server, so none of them is a hold. Older holds (helper 1.2.1, no code) never end by themselves.
* **D2, the route** (the helper only; the web never calls it; additive, under `ANY /v1/{proxy+}` and
  `ANY /v1/workspaces/{proxy+}`, no Terraform, table or index change):

  | Method & path | Body | 2xx |
  |---|---|---|
  | POST `/v1/clips/{clipId}/tiktok/mac/logged-in` | `{device}` | `{helper: MacHelper \| null, outcome: "resumed" \| "pressed" \| "cleared"}` |
  | POST `/v1/workspaces/{ws}/publishing/{id}/mac/logged-in` | `{device}` | `{helper: WsMacHelper \| null, outcome: "resumed" \| "pressed" \| "cleared"}` |

  Not the owner's Try again: that is his answer (it can't refuse a puzzle hold), refuses a pressed post without
  `notOnTikTok`, runs Clips Funded's at-tap account confirm, writes `macAgainAt`, and the row's `now: true` makes it an
  Upload tap's. `tiktok_mac.logged_in(store, user_id, clip_id, device)` / `ws_mac.logged_in(store, user_id, ws, id,
  device, now)`: (1) the caller's own helper item must be `needs_you` with `needsYouCode = login`, `needsYouClipId` /
  `needsYouJobId` the path's id and `needsYouDevice` the body's `device` (the Mac that stopped, which another Mac's
  ping never rewrites; on a hold with no `needsYouDevice`, one a stop wrote before the server kept it and still open
  when it deployed, `device`: with one Mac that is the Mac that stopped, re-review 24 Nov, `_stopper`), else 409
  "Your Mac isn't waiting for a TikTok login on this one." (`NOT_LOGIN_HOLD`) and nothing written; (2) the post,
  read consistently: a Mac post whose `macDevice` is another device → the same 409; `macPressedAt` set → left
  exactly as it is (`pressed`: its row keeps "Not sure it posted · look on your TikTok", the owner's question); a
  stopped Mac post of this device → it waits again (`resumed`); anything else, the clip or job gone too (no 404) →
  `cleared`; (3) one transaction: the re-wait
  (`resumed` only: SET `macState = waiting` (Clips Funded also `updatedAt`), REMOVE `macStep`, `macClaimedAt`,
  `macStoppedAt`, `macReason`; keeps `since`, `source`, `attempt`, `macDevice`, `macPressedBefore`, `macAgainAt`;
  expects status `mac`, `macState = stopped`, `macDevice` = device and no `macPressedAt`) and the clear (SET `state =
  ok`, REMOVE `reason`, `needsYouClipId` / `needsYouJobId` and `needsYouStoryId`, `needsYouCode` and `needsYouDevice`;
  expects the hold as read: `state`, `needsYouCode`, the id and `needsYouDevice`; on a hold without it `device` and
  still no `needsYouDevice`, so a stop meanwhile, another Mac's, is a change); either changed meanwhile → 409
  `CHANGED` in each app's words, nothing written; (4) logged
  `tiktok_mac.logged_in` / `ws_mac.logged_in` with the id and the outcome. Only `{device}` (unknown keys 400, `device`
  required, at most 100 characters). The Clips Funded route is S as every §47.10.4 route and never writes Clip
  Factory's `USER#{u}` item; it skips Try again's account confirm (the claim's `validate_destination` and handle check
  stop a changed account without posting).
* **D3, the look** (helper 1.2.2). `lookLogin(lane)` (run.js): the lane's own profile, headless; no TikTok
  `sessionid` cookie → `logged_out` with no TikTok page loaded; else Studio › Posts through `goto`, as a post opens it:
  TikTok's login there → `logged_out` even when the profile's own account data still names the account (a post would
  stop on that login again: review, 24 Nov); a puzzle, a code, any other stop or a page that didn't load → `unknown`;
  only then `identify` as `lookHeadless`; Chrome quits. `loginBack(lane, hold, d)` (`src/hold.js`, fakes in tests):
  (1) `MAX_LOGIN_BACKS = 2` holds ended by the lane's own looks in a row (the lane's `loginBacks`: `state.loginBacks`,
  `state.ws[id].loginBacks`; every clip counted, no clock) → `too_many`, no Chrome, and only the owner ends it (Try
  again, setup, Log in on my Mac); a post on TikTok (`finished`) and his own login (`afterLogin`, `setup --workspace`,
  Log in on my Mac) start the count again; (2) no target → `no_account`, a target
  that is another lane's account → `wrong` in that refusal's words, no Chrome; (3) the look (`logged_out`); (4)
  `sameAccount(seen, target, pinnedUid, {notUid: others.uids})` and `lane.onWho` (Clip Factory pins its uid on its first
  same; a Clips Funded lane is set up on same, not on wrong); (5) same → `loginBacks` += now (before the call, taken
  off again unless the hold ended), then the route: its `outcome`, a 409 → `refused`, a 404 or any other failure →
  `failed` (the hold stays); (6) wrong →
  `wrong` (+ `wrong_account`), else `unknown`. Words (`heldWords`) only for wrong ("Your Mac is logged in to TikTok as
  {seen}, not {target}. Nothing was posted.") and logged_out (the lane's logged-out sentence). It clears no cookie,
  types no saved login, leaves `loginTries` / `loginRefused` alone, and shows nothing. Targets: Clip Factory's
  `clipsTarget`, `state.clipsAccount.uid`, `otherAccounts(state, "clips")`; Clips Funded's status `account.handle`, the
  lane's pinned uid, `otherAccounts(root, lane.id)` after `clipsTarget`. **When** (`plan.js`): `loginHold(helper,
  kind)` → `{id}` only for `needs_you` + code login + an id; `LOGIN_CHECK_EVERY_MS = 5 minutes`; `loginCheckDue` with
  no stamp, a stamp 5 minutes old or more, or one in the future; the stamp (`state.loginCheckAt`,
  `state.ws[id].loginCheckAt`) is written before the look; never while the lane's switch is off or the Mac is paused;
  only on the Mac that tried the held clip or job (`triedHere(ledger, hold)`: the lane's ledger has its id, written at
  the claim before anything can stop; a second Mac, whose pings only repeat the hold, never opens a Chrome for it);
  at most one look per tick in all lanes (B never looks in a tick where A looked: `wsLanes({looked})`).
  **A** (Clip Factory): right after `applyRequests`; after every look, whatever it said, `settings.json` (review, 24
  Nov: `cli.js off` takes no lock, so a pause written while the look ran makes the clip the look resumed wait, and the
  ping says `paused`) and `GET /v1/tiktok/mac` again, and the tick decides and pings on those reads (the resumed clip
  may go in the same tick, and the owner's Try again during the look wins); if that read fails, the tick ends with no ping (a stale `needs_you` ping would put back a hold
  with no clip and no code); `wrong` / `logged_out` → the needs-you ping carries the words only while that read still
  holds the same login hold (the code stays, so the right login still ends it). **B** (Clips Funded): per lane before
  its `wsAction` and ping, only when A's action isn't post, resume or find and A didn't look, at most one lane per
  tick; after every look `settings.json` and that lane's queue are read again, the same way (a failed read skips the
  lane's ping; the later lanes decide on the fresh settings too). **C** (1.2.3): an earlier lane decided before a
  later lane's look (two or more Clips Funded workspaces; re-review, 24 Nov), so the find, resume or post C picks
  reads `settings.json` once more before anything is claimed or driven (`pausedSince`, §47.10.5). **C.3** (Log in on my
  Mac): reading the target while held for a login calls the job's route (not capped) before the existing
  `clearLogin` ping, which then never says `needs_you`. **After `cli.js setup`** (under run.lock, TikTok logged in and
  Clip Factory signed in): `afterLogin` reads `GET /v1/tiktok/mac` and runs `loginBack` at once (not capped), prints
  "Your Mac carries on with the stopped clip now." / "Your Mac goes on. The clip it stopped on may already be on
  TikTok: check it in Clip Factory." / "Your Mac goes on." / "{the wrong words} Log in as {target}." (exit 1) /
  "TikTok isn't logged in yet.", and deletes `state.loginCheckAt`. **After `setup --workspace`**: when the window says
  ok and the status shows a login hold, the job's route straight away (no second look), the same lines in Clips
  Funded's words ("the stopped post", "check it in Clips Funded"), and the lane's `loginCheckAt` goes.
* **D4, what the helper sends.** `stopped(lane, job, reason, needsYou, {code})`; `client().stopped` /
  `wsClient().stopped` add `code` only when given; a 400 on a stop with a code is sent once more without it (an older
  server never loses the stop). `loggedIn(clipId, device)` / `loggedIn(id, device)` (never a `/clips/` path for a ws
  lane). Events (events.log, nothing on screen): `login_back {account, clipId | publishingJobId, outcome}` with
  `resumed`, `pressed`, `cleared`, `wrong` (`seen`, plus `wrong_account`), `logged_out`, `unknown`, `no_account`,
  `refused`, `failed` or `too_many`; `stopped` carries `code`. `VERSION = "1.2.3"` (1.2.2 had D1-D6 without
  `triedHere`, the second `settings.json` read and `pausedSince`).
* **D5, the web** (it never calls the route). Settings › Your Mac posts TikTok keeps "Your Mac needs you: {reason}" and
  **Open the stopped clip**; with `needsYouCode: "login"` one quiet line under the status line, `MAC_LOGIN_BACK_LINE`
  "Once you log in to your TikTok again, your Mac carries on by itself." (`data-mac="login-back"`, `MacLoginBack`), for
  no other hold: his own login is never capped, so it stays true after `too_many`. Clips Funded's card keeps its words
  and **Log in on my Mac**; `CardState.note` = `loginBackWords(handle)` "Once you log in to {handle} again, your Mac
  carries on by itself." (never "Clip Factory"). After the helper's route,
  the next read (every 60 s, on focus, and on the re-waited post's live event) shows the normal state; a pressed clip
  shows "Not sure it posted · look on your TikTok" with It's on TikTok; a wrong account shows its sentence with the
  same line. Mocks: Clip Factory's `stopped(clipId, reason, needsYou, device, code?)` and `loggedIn(clipId, device?)`;
  Clips Funded's `stopped(reason, needsYou, id, code?)` and `loggedIn(id)`, with the route's rules.
* **D6, the relogin window waits 3 seconds.** At 08:28:36 he logged in in Clip Factory's relogin window and 7 seconds
  later the headless Chrome read the profile logged out: `relogin` quit the window the moment `sessionid` showed,
  while `loginWindow` waits 3 seconds. Now `relogin` waits `SESSION_SETTLE_MS = 3000` too, then closes the pop-up and
  carries on (no new window), and so does `cli.js setup` when TikTok's login happened in its window (`afterLogin`
  looks right after). If the session is lost anyway, the second try's login stop carries the code, so the hold ends as
  soon as the profile reads the account.
* **D7, only a stop starts a hold** (review, 24 Nov; both apps' ping, not only §47.11's look). The tick pings what it
  read, and the owner can answer after that read: during the autopost read, `clipsTarget`, the Change TikTok login
  dialogs and `hasLogin` (Clip Factory), or the Log in on my Mac window (Clips Funded, up to 20 minutes). The stale
  `needs_you` ping then wrote back a hold with no clip and no code, which nothing ended (every tick re-pinged it, with
  no code there was no look, and the clip waited but never went). Now `tiktok_mac.ping` / `ws_mac.ping` never turn an
  item that isn't `needs_you` (or no item) into `needs_you`: such a ping checks in as `ok` without its reason. The
  write expects `state = needs_you`; when the hold ended between the read and the write, it is written again as `ok`,
  expecting no hold there (`state` ok or paused; re-review, 24 Nov): when a stop, another Mac's, started a new hold
  meanwhile, that hold stays exactly as its stop wrote it and this check-in is dropped (the next comes a minute
  later). A stale `needs_you` ping from a Mac that is also paused on the Mac checks in as `ok` for up to one tick.
  A `needs_you` ping on a hold a stop started keeps it, its id, `needsYouCode` and `needsYouDevice`. The helper only
  ever pings `needs_you` when its read said so (every version since 1.0), so no helper loses a hold. The web mocks
  keep their ping as before (tests use it to show a hold); Clip Factory's mock keeps `needsYouDevice` as the API.
* **How each never holds.** Another hold: only a login Stop sends the code, a later needs-you stop without one removes
  it, the helper looks only for `loginHold`, and the route refuses unless the code is on this clip from this device.
  Another account: only `same` calls the route; a target that is another lane's is refused before any Chrome; every
  post still checks the account before Studio is read and right before Post. Twice: the route re-waits only a stopped
  post with no `macPressedAt`, in one conditional transaction, never moves `macPressedAt`, `macPressedBefore` or
  `macAgainAt` and never sets `now`; the claim still refuses a pressed post, and `neverTwice`, the ledger and
  `findExisting` are unchanged. The screen: headless only, under the tick's run.lock, only while the switch is on and
  the Mac isn't paused; TikTok's login on Studio is `logged_out`, and the cap (twice in a row per lane, then only the
  owner) bounds any other mismatch between the look and the post.
* **Edge cases.** Two Macs: the hold names the Mac that stopped (`needsYouDevice`), so that Mac's look still ends it
  while the other Mac pings `needs_you` every minute; the other Mac never looks (`triedHere`) and the route refuses
  it. A login hold still open when this server deploys has no `needsYouDevice`: the Mac that last checked in counts
  as the Mac that stopped (D2), so with one Mac it ends by itself (with two, the other Mac's ping may have rewritten
  `device`, and he taps Try again). A reinstalled helper (a new device id and ledger): no look, the route would refuse,
  he taps Try again. A renamed
  account: Clips Funded's claim stops it with `ACCOUNT_CHANGED`; Clip Factory's target follows `GET /v1/accounts`. He
  answered first: no hold, no look. A clip deleted while held: `cleared`. A batch's `haltOnStop` paused the Mac: no
  look until he starts it. Clips Funded's "nobody" stop isn't a hold (follow-up).
* **Tests** (targeted; CI is the full run): helper `plan.test.js` (`loginHold`, `loginCheckDue`), `hold.test.js`
  (every outcome, the cap, no ask/frame/login/cookie), `tick-token.test.js` (whole ticks: logged out, @lamo.clips
  resumed and claimed in the same tick, @clips.funded refused, no ping after a failed second read, no look for a
  puzzle/limit/old hold/switch off/paused, Clips Funded only while Clip Factory is idle, the code in both stop
  branches and never on a puzzle, the 400 fallback, D6; and from the review: account data naming the account while
  Studio shows TikTok's login, in both lanes, over days → no resume, no window, no cookie cleared; a puzzle during the
  look; the owner's Try again during the look → no stale `needs_you`; and from the re-review: `cli.js off` during a
  look in either lane → no claim, a `paused` ping; both lanes held → one look per tick; a second Mac → no look; and
  from the second re-review: `cli.js off` after either lane decided to post → nothing claimed or driven),
  `plan.test.js` (`triedHere`), `api.test.js`, `constants.test.js`, `words.test.js`; API `test_tiktok_mac.py`,
  `test_ws_tiktok_mac.py` (a second Mac's `needs_you` ping never takes the hold from the Mac that stopped; a stale
  `needs_you` ping after Try again, also between the read and the write, checks in as `ok`; from the second
  re-review: a login hold with no `needsYouDevice` still ends by itself, for the Mac that checked in only, and loses
  to a stop meanwhile; a stale `needs_you` ping never drops a hold another Mac's stop started meanwhile; plus
  `test_http`, `ws_routes_mac.py`, `test_ws_separation`); web `tiktokMac.test.ts`, `storiesTikTokMac.test.tsx`,
  `tiktokMacNow.test.ts` (the mock's two Macs).
* **Rollout.** One PR (API, web, helper); every field and route is additive and an older helper sends no code, so
  nothing changes until 1.2.2 runs. 1.2.2 is installed from main only on the owner's command (`install.sh`, then
  `whoami` printing @lamo.clips). Against an older server 1.2.2 still stops (the 400 fallback) and keeps the hold (the
  404 is `failed`). D7 (the ping) and `needsYouDevice` apply to every helper as soon as the API deploys: an older
  helper pings `needs_you` only after reading it too, so it only loses a stale ping. A login hold open at that deploy
  (written without `needsYouDevice`) still ends by itself (D2). 1.2.3 (the re-review's fixes) reaches the owner's Mac
  after merge, again only on his command (`install.sh` from main); 1.2.2 works against the new server meanwhile. No
  Terraform change, no owner data touched.

### 47.12 Campaign clips and paid clips go through the Mac with TikTok's label (owner request, 2026-11-24)

The owner's Content Rewards campaign clips are paid partnerships, and he wants every clip on TikTok through his Mac
("its always the automation that covers it"). Until now a campaign clip never got a Mac post (round 3, D1, ADR-86)
and a card with Your brand or Branded content ticked held Upload for TikTok (§47.9 item 1), because the helper could
not set TikTok's commercial content disclosure and the Mac's done never reached Content Rewards. Both now work
([ADR-96](DECISIONS.md#adr-96-campaign-and-paid-clips-post-tiktok-through-the-mac-with-tiktoks-label)). This
replaces §47.2's "a campaign clip never gets a Mac post", §47.9 item 1's read-only row and its label holds, and every
"Campaign clips skip TikTok for now…" sentence (`CAMPAIGN_SKIPS`, `SEND_CAMPAIGN`, `fit.TIKTOK_WAITS` and their
copies are gone). No table, index, route or Terraform change: every field and body key is additive.

**A label** is TikTok's commercial content disclosure: `brandContent` (Branded content: the "Paid partnership" label,
promoting someone else, on every campaign clip) and `brandOrganic` (Your brand: "Promotional content"). TikTok's rule:
Branded content is only for Everyone or Friends (`tiktok_mac.BRANDED_PRIVACY`).

#### 47.12.1 Data and API

* **Upload** (`POST /v1/clips/{clipId}/confirm`): optional body key **`tiktokMac: true`** (boolean; anything else is
  400). It says the card is in Mac mode, so `tiktok` is the card's own TikTok row (privacy, Comment, Duet, Stitch, Your
  brand, Branded content; validated by `tiktok_options` as before). When Upload makes the TikTok post a Mac post
  (§47.2 item 1) the post's `postOptions.tiktok` is that `tiktok` (`uploads._mac_options`); without the key (an older
  web) it is `tiktok_mac.preset_options` as before. A campaign clip with the key must send Everyone with Branded content
  (`_require_campaign_tiktok`: "Campaign clips must be public. Pick Everyone." / "Turn on Branded content on TikTok for
  campaign clips."); without it My settings get Everyone and Branded content (`tiktok_mac.campaign_tiktok`).
* **The clip's label** (`Clip.tiktokLabel: {brandContent, brandOrganic}`, public, additive): written in the Upload
  write whenever the confirm's `tiktok` has either one true, TikTok chosen or not, in any mode. It is how a paid clip
  uploaded without TikTok keeps its label for a later Post with my Mac or Send these to my Mac.
* **Where a Mac post's label comes from:** Upload (above); an auto-posting run: My settings, a campaign clip with
  Everyone and Branded content; **Send these to my Mac** and a row's **Post with my Mac** (`tiktok_mac.send_options`):
  a campaign clip → Everyone with Branded content; else the clip's `tiktokLabel`; else a handed-over Clip Factory
  post's own `postOptions` label (the API sheet's); else My settings. A label with Branded content and another
  privacy (Only me, Followers) goes Everyone (`with_label`). A new Mac post for a campaign clip carries `campaignId` and
  `postOptions.campaign` like Upload's posts; a handed-over one keeps its own.
* **MacJob** (§47.3) always has `brandContent` and `brandOrganic` (booleans, false when the post's choices don't say
  true). A campaign post's job `caption` is the campaign caption (`campaign_caption("tiktok", …)`: the disclosure
  first, every required tag, inside TikTok's limit), as TikTok's publisher would send it.
* **`Post.mac`** also says `brandContent: true` / `brandOrganic: true` (only when true), so rows can show the label.
* **Claim** (`POST …/tiktok/mac/claim`): body `{device, version?}` (`version`: text, at most 40 characters). A Mac
  post with a label is only claimed with a `version` of `tiktok_self.MAC_BRAND_FROM` = "1.3.0" or newer
  (`helper_brands`; none, "dev" or older → 409 `MAC_NEEDS_UPDATE`, "Your Mac needs an update to add TikTok's label to
  this clip. Set up your Mac again.", nothing written): an older helper would post it without its label. A campaign
  clip whose campaign takes no clips now (`_require_campaign_open`'s words: ended, paused, held, not in it) is
  written `stopped` with those words under the claim's own condition (`_stop_closed`), so it leaves the queue and its
  row says why, and the claim answers 409 with them. Never posted for a closed campaign. That check runs before the
  version check.

#### 47.12.2 The campaign checks for the Mac's TikTok (all of Upload's)

* `_place_refusal` for TikTok before TikTok approved the app: allowed while **Your Mac posts TikTok** is on (`mac_on`;
  `_require_campaign_places` reads Settings when not given). With it off: `CAMPAIGN_MAC_OFF`, "Campaign clips go on
  TikTok from your Mac. Turn it on in Settings › Posting › Your Mac posts TikTok." plus " Or turn TikTok off, then tap
  Upload." (Upload) or " Tap Try again on another place." (Try again, send). Try again of a campaign clip's TikTok
  through TikTok's API before the approval while the Mac is on (`api=True`): `CAMPAIGN_MAC_POSTS`, "Your Mac posts
  campaign clips on TikTok. Tap Post with my Mac." (TikTok's API would post it privately; private posts can't earn).
* Content Rewards' copies follow: `gates.TIKTOK_MAC_OFF` and `fit.TIKTOK_MAC_OFF` (a test pins them to
  `CAMPAIGN_MAC_OFF`); the fit's TikTok note now has the fix **Turn on your Mac** → `/settings/posting/tiktok-mac`
  while the Mac is off; the fit's `uploadPlaces` keep TikTok while the Mac is on. `gates.TIKTOK_ONLY` ("This campaign
  only pays for TikTok. {CAMPAIGN_MAC_OFF} Or pick a campaign that pays for YouTube, Instagram, X or Facebook.") stops
  a TikTok-only campaign only while TikTok isn't one of its places (the Mac off and TikTok not approved).
* **Upload** with TikTok: `_require_campaign_open`, the paid places with TikTok, YouTube public and never made for
  kids, TikTok's choices (the Mac's) for Everyone with Branded content, and `_require_fit` with TikTok.
* **Send these to my Mac / Post with my Mac** (`routes/clips.mac_campaign_refusal`): the campaign takes clips, TikTok
  is one of its places, the fit with the Mac's choices; a refusal is that clip's `{sent: false, reason}` and nothing
  is written. The refusals that are not about the campaign come first (§47.2 item 3).
* **Try again** of a campaign clip's Mac post (`routes/tiktok_mac._campaign_retry`): `_require_campaign_open` and the
  fit with the post's own choices first (409 with their words).
* **Auto-posting runs** (`uploads._auto_mac_refusal`): a campaign clip gets its Mac post only when TikTok passes
  `_place_refusal` and the fit with TikTok among its places; otherwise no Mac post, and its other places go as before
  (`clip.campaign_mac_skipped` in the log). A campaign that pays only for TikTok is not taken by a run (§46.7).

#### 47.12.3 The Mac's done reaches Content Rewards

After the Mac's done (`POST …/tiktok/mac/done`) and after the owner's Add link / It's on TikTok with a link
(`POST …/tiktok/posted`), `routes/clips.send_to_cr` sends the clip's TikTok post to Content Rewards when it is posted
by the Mac (`via: "mac"`), public, for a campaign (`campaignId`), with its `url`, while Content Rewards is on, and only
once (no `CRSUB#{postId}` yet): `contentrewards.submit.send` creates `CRSUB#{postId}` (idempotent, its 30-minute
window, `deadline` and `sendBy` from `postedAt`, which the done writes) with `SUBMIT_TIMEOUT_API`. A send that CR asks
to try later goes to `send_by_hand` (the owner's Send on Campaigns), as the Send route leaves it, since nothing else
retries outside the clip flow. A done without a link sends nothing; the later link sends it. It never breaks the
answer it follows (`clip.mac_cr_failed` in the log). The clip flow's CR step finds the Mac post not `posted` yet and
leaves it (`not_posted`), so a submission is never made twice.

#### 47.12.4 The helper, 1.3.0 (`mac/tiktok-helper/**`)

* **TikTok Studio** (read by the headless probe on 24 Nov 2026, nothing posted; side note
  `tiktok-mac-label-probe.md`): under **Show more**, the switch **Disclose post content** ("Let others know this post
  promotes a brand, product or service."). On, it shows two checkboxes, **Your brand** and **Branded content**;
  Branded content adds "Paid partnership" and the line "By posting, you agree to our Branded Content Policy and Music
  Usage Confirmation.", with no dialog. With Branded content ticked, Who can see it greys out Only you ("Private");
  with Only you picked, Branded content is greyed out. On with nothing ticked, Post still works, so the helper never
  leaves it so. Studio draws a checkbox anew on every change (a new element and id) and takes over 600 ms, so every
  read finds it again by its text and a click waits up to 3 s (`studioForm`). Who can see it offers Everyone,
  "Friends Followers you follow back" and Only you; options are picked by their first word.
* **Clip Factory's lane** (`setInteractions`): after Who can see it and the switches, `applyLabel` opens Show more,
  sets Disclose post content on for a label (then Your brand and Branded content each as the job says) or off without
  one (TikTok may carry the last post's over), reads it back, and checks Who can see it again. Right before Post
  `checkLabel` and `checkPrivacy` read both back once more. Anything that doesn't stick stops before Post with
  `REASONS.label`, "Your Mac couldn't set TikTok's Branded content label the way this clip needs, so it didn't post.
  Tap Try again." Clips Funded's lane is unchanged (AI label on, Disclose post content off).
* **The claim** says `{device, version}`; against a server from before this (400) once more with `{device}`.
* **The kept video** leaves Downloads once the clip's TikTok post is `posted` for everyone or with the privacy the
  job set (`tidyGoes`; the job's privacy is kept in the ledger at the claim; an entry from before 1.3.0 means
  Everyone), not only `public`.
* **Check run:** `cli.js probe <clipId> --branded | --your-brand [--privacy …] [--caption <text>] --quiet` (no frame,
  nothing on screen) prints `label` as TikTok reads it back and `paidPartnership`. 24 Nov, all ok: Branded content →
  `{disclose: true, organic: false, branded: true, paidPartnership: true}`; Your brand → `{true, true, false}`; both
  with Friends → `{true, true, true}`, Friends kept; none after those → `{disclose: false}`; Only you kept.

#### 47.12.5 What the owner sees (web)

* **Review** (§47.9 item 1, rewritten): TikTok's row is the clip's own in Mac mode, starting on My settings with no
  tap; a ticked label never holds Upload; Upload sends `tiktokMac: true` and `tiktok` (also with TikTok unticked when
  a label is ticked, for a normal clip). A campaign clip has TikTok among its places while the Mac is on
  (`campaignPlaces(…, tiktokGoes)`), on Everyone with Branded content. The line above Upload names the label
  (`macAddsLabel`).
* **Rows** (Library, the clip page, Review's "Uploaded just now", §47.4): a paid clip (a campaign clip, or
  `Clip.tiktokLabel`; a Mac post's own `mac.brandContent` / `brandOrganic` win) ends its not-yet, waiting and posting
  rows with " · Paid partnership label" or " · Promotional content label" (`labelWords`, `macLabel`, `clipLabel`;
  Branded content wins). Post with my Mac's toast names it (`postWithMacToast`: "Sent to your Mac! It posts it in a
  minute, with TikTok's Paid partnership label."). Campaign clips are sendable (`canSendToMac`); the server's refusal
  shows as before. A labelled Mac post that waits while the helper says a version older than `MAC_BRAND_FROM`
  (`macHelperBrands`) reads `MAC_ROW_BRAND_UPDATE`, "Waiting for your Mac · it needs an update to add TikTok's label".
* **Settings › Posting › Your Mac posts TikTok › Send these to my Mac** adds `sendLabelLines`, e.g. "1 clip goes with
  TikTok's Paid partnership label."
* **Content Rewards:** the campaign page says `CAMPAIGN_TIKTOK_MAC` while the Mac is on, else `TIKTOK_NOT_YET`
  ("TikTok: not yet. " + `CAMPAIGN_MAC_OFF`); `placesLines` uses `CAMPAIGN_MAC_OFF`; Connect's accounts step says
  `CR_TIKTOK_ADD`, "Add TikTok the same way too, for the campaign clips your Mac posts there."; the fit's TikTok note
  has **Turn on your Mac**. Removed: `CAMPAIGN_TIKTOK_SKIPS`, `MAC_ROW_CAMPAIGN`, `CR_TIKTOK_WAITS`, the row kinds
  "campaign" and "commercial".
* **My settings** (§47.9 item 3) and **Ask** (`helpKb.json`: `review-use-my-settings`, `review-place-rows`,
  `tiktok-mac`, `cr-tiktok` "Campaign clips on TikTok" with **Turn on your Mac**; `helpEvals.json` "Do campaign clips
  go to TikTok?" → `cr-tiktok`) say the Mac adds TikTok's label; nothing tells him to post a clip in the TikTok app
  himself. docs/SETUP_POSTING.md says the same.
* **The mock API** (`web/src/api/mock/`) follows: `tiktokMac`, `tiktokLabel`, the job's and `mac`'s label, the version
  gate (its helper pings 1.3.0 by default; a ping or the claim knob can say an older one), the campaign refusals of
  send and Try again (gone, held, paused, ended), and `posting.lastConfirm()` for tests.

#### 47.12.6 Tests (offline, fakes only; CI is the full run)

* **Helper** (`node --test`, 191): `label.test.js` (a fake Studio with the probe's rules: a campaign job ticks
  Branded content under Show more; Your brand; both; a carried-over box unticked; no label turns the switch off; no
  switch, a greyed-out Branded content with Only you, or a box TikTok doesn't keep stops before Post with
  `REASONS.label`; the read back right before Post; `tidyGoes`), `api.test.js` (the claim's `version` and its 400
  fallback, a 409 sent once), `tick.test.js` (the claim body), `constants.test.js` (`VERSION` 1.3.0 equals
  `MAC_BRAND_FROM`).
* **API** (`pytest`): `test_tiktok_mac.py` (Upload with and without `tiktokMac`; `tiktokLabel`; a campaign clip's
  Upload, auto run and send with Everyone and Branded content and `campaignId`; a closed campaign's send refused with
  nothing written and its claim stopped; send of a labelled clip; MacJob and `Post.mac` labels; the claim's version
  gate; the done's `CRSUB#` with a link and none without; Add link's), `test_campaign_posting.py`, `test_cr_gates.py`,
  `test_cr_fit.py` (with `fixtures/cr_fit_cases.json` regenerated), plus the existing CR and auto-posting suites.
* **Web** (vitest): `reviewMac.test.tsx`, `tiktokMac.test.ts` (`MAC_BRAND_FROM` pinned to the API's and the helper's),
  `tiktokMacNow.test.ts`, `mySettingsTikTok.test.tsx`, `crWords.test.ts`, `finderPage.test.tsx`; e2e (chromium):
  `tiktok-mac.spec.ts`, `review-card.spec.ts` (a campaign clip in Mac mode uploads with TikTok, Everyone and Branded
  content and `tiktokMac: true`; a normal clip with Branded content ticked uploads with the label; Post with my Mac on
  a paid clip shows it), `content-rewards.spec.ts`, `tiktok-mac-screenshots.spec.ts` (with `CF_TT_SHOTS_DIR`).

#### 47.12.7 Rollout and not verified live

* One PR (API, web, helper). The API deploys first; the helper on the Mac (1.2.3) sends no `version`, so it never
  claims a labelled post (409, nothing written) until 1.3.0 is installed from main (`install.sh`, keeping settings,
  state, the profile and the Keychain; only with no `run.lock`; then `whoami` must print @lamo.clips). Meanwhile a
  labelled post waits, and the row says the Mac needs its update. Unlabelled posts go on as before.
* Not verified live: what TikTok shows after Post is pressed on a branded post (the probe never presses Post; the
  press loop still clicks only "Post now", and a post it can't confirm is looked for and asked about after 30
  minutes, §47.6), and Content Rewards' answer to a Mac-posted TikTok link (the same `create_my_submission` as every
  other campaign post). The first labelled post is watched in `events.log`.
