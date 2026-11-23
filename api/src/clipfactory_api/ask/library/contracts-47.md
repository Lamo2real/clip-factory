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
  `paused`), `reason?` (a plain sentence, at most 200 characters), `version?`, `device`. Written by the ping (a whole
  put) and by a stop with `needsYou`; the owner's Try again turns `needs_you` back into `ok`.
* **Mac post**: the clip's one TikTok post (one per clip, as everywhere) with the new **`status: "mac"`** (added to
  `Post.status`). It is never `queued` or `pending_integration`, so no path that sends posts through TikTok's API ever
  touches it (§47.6). Internal attributes: `macState`, `macStep`, `macSince`, `macSource`, `macClaimedAt`,
  `macPressedAt`, `macStoppedAt`, `macReason` (public as `mac`), and `macDevice`, `macBeatAt` (the heartbeat),
  `macAttempt` (claims so far), `beforeMac` (a Clip Factory TikTok post's fields before it was handed over, for Take it
  back), `madeForMac: true` (the post was created for the Mac, so Take it back deletes it). Its `postOptions` hold the
  TikTok sheet's shape (§17.8: `privacyLevel`, `disableComment`, `disableDuet`, `disableStitch`, …): what the Mac
  sets. **Every Mac post (upload, auto and sent) stores My settings' TikTok choices** (`tiktok_mac.preset_options`:
  `PUBLIC_TO_EVERYONE` with Comment, Duet and Stitch on), whatever Upload's TikTok sheet sent: before TikTok approves
  the app the sheet offers only Only me, and his Mac posts for everyone.
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
                    reason?: string }
// Post.status adds "mac"; Post.mac?: PostMac (only while status is "mac"); Post.via?: "mac".
// PerfStatus adds "mac"; PlatformPerformance.mac?: PostMac and .via?: "mac" (§16.2). Settings.tiktokMac (above).
// AutoPostStatus.macPlaces: Platform[] (§46.9).
interface MacHelper { seenAt: string; state: "ok" | "needs_you" | "paused"; reason?: string; version?: string }
interface MacJob { clipId: string; postId: string; hook: string; caption: string /* captions.tiktok */;
                   fileName: string /* videoFileName(hook) */; privacy: string; comment: boolean; duet: boolean;
                   stitch: boolean; source: "upload" | "auto" | "sent"; since: string;
                   state: "waiting" | "working" | "stopped"; step?: MacStep; claimedAt?: string; pressedAt?: string;
                   attempt: number /* macAttempt: the claims so far */ }
// AutoPostStatus.tiktokYourself[].mac?: true (his Mac's post, listed while the switch is off, §47.2; still served,
// unused by the web since ADR-85).
```

### 47.2 Where Mac posts come from

Upload and auto-posting write the Mac post in the same transaction as the clip's other posts
(`posts.create_for_clip`'s explicit `tiktok_mac` path, through `uploads.upload_review_clip`), never afterwards.

1. **Upload** (`routes/clips.confirm` → `uploads.upload_review_clip`): the TikTok post is written as a Mac post
   (`source: "upload"`, `madeForMac`) instead of `queued` when all hold: `"tiktok"` is among the chosen places;
   `settings.tiktokMac.on`; TikTok has not approved the app (`tiktok_mac.tiktok_audited`, the server twin of the web's
   `tiktokAudited`: `app_review` and `posting_audit` not both `ok`). A campaign clip goes the same way (since
   2026-11-23: the owner never posts by hand); Upload's own campaign checks still hold (its places, "Campaign clips must
   be public. Pick Everyone.", Branded content), and its Mac post's options always say `PUBLIC_TO_EVERYONE`
   (`tiktok_mac.options_for`), whatever My settings say. The `tiktok` body stays required ("Pick who can see it on TikTok.") and is checked as before, but
   the post's `postOptions` are My settings' choices (§47.1); `uploadTo` names TikTok (he chose it). Upload's API TikTok rule (`queued`, the refusals) is
   otherwise unchanged, and exactly as before with the switch off or once TikTok approved the app.
2. **Auto-posting runs** (`autopost/run.py`, live mode only): with `tiktokMac.on`, a clip (a campaign clip too, for
   Everyone) also gets a TikTok Mac post (`source: "auto"`) through `upload_review_clip(..., tiktok_mac=True)`; its options are My
   settings' (§36: Everyone, Comment, Duet and Stitch on). TikTok is **not** added to the run's places (`uploadTo` never
   names it). Practice and Private test runs never make one ("Nothing gets sent"). `GET /v1/autopost`: `leftOut` drops
   TikTok while on, `macPlaces: ["tiktok"]` (else `[]`; also `[]`, with TikTok back in `leftOut`, when no other place is
   set up: such a run sends nothing, §46.6), and `tiktokYourself` drops clips whose TikTok post is a Mac post (any
   state) or was posted `via: "mac"`, except while **Your Mac posts TikTok is off**: then a clip whose Mac post waits or
   stopped (not working, Post never pressed) is listed again with `mac: true` (the web offered Post it yourself instead
   on it until ADR-85; it no longer shows the list). **Off switch** ("While it is off, nothing posts"): while
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
   test. A campaign clip goes too, for Everyone (`options_for`), and a new post for it carries its `campaignId`. **`now`** (additive, ADR-85): Settings' bulk Send these to my Mac sends no `now`, so its
   posts are `source: "sent"`, the backlog (one after each auto-posting run, §47.8); a row's Post with my Mac sends
   `{clipIds: [clipId], now: true}`, so its post is `source: "upload"` and the Mac posts it at once and first, as after
   an Upload tap. The refusals and race guards are the same either way. A clip with no TikTok post gets a new Mac post (`madeForMac`, appended to
   `postIds`, its id in the clip's `tiktokForMac`), written only while the clip has neither `tiktokForMac` nor
   `tiktokByYou`: two sends, or a send and I posted it, never make two posts (I posted it's new-post write now also
   needs `tiktokForMac` absent). A Clip Factory TikTok post that waits for setup, failed or went up privately is handed
   over in place: its fields (status, link, ids, stats and `gsi2` fields, what was learned, `postOptions`,
   `publishHandle`) go into `beforeMac`, so it also leaves the stats poller. `source: "sent"` (`"upload"` with `now`),
   My settings' options. The clip's status follows the clip flow's settle rule (a failed clip whose only failed post was TikTok's becomes
   `confirmed`). Reasons: "Upload this clip first.", "This clip is still starting to upload. Try again in a minute.",
   "This was a Private test, so it stays off TikTok.",
   "This clip is still uploading to TikTok. Wait until it is done, then try again.", "You already posted this one on
   TikTok.", "This clip is already on TikTok for everyone.", "Your Mac already has this clip.", "We could not find
   that clip.", "This clip just changed. Try again." (the server's words). The campaign refusal ("Campaign clips go on
   TikTok by hand…") is gone since 2026-11-23.
4. **Take it back** (`DELETE /v1/clips/{clipId}/tiktok/mac` → `{clip, posts}`): only while `mac.state` is `waiting` or
   `stopped` and the Mac never pressed Post. A `madeForMac` post is deleted and leaves `postIds` (and
   `tiktokForMac`); a handed-over post gets `beforeMac` back. The post and the clip (its settle rule) are **one
   transaction** (`db.delete_request` / `Store.transact(deletes=…)`), conditional on the post's state and
   `macPressedAt` absent; a clip that changed meanwhile is read again, at most 3 times. Working → 409 "Your Mac is
   posting it right now. Wait a minute."; `macPressedAt` set → 409 "Your Mac may have posted it already. Check your
   TikTok first." (the restored post could otherwise go out through TikTok's API and make two copies; his ways out
   are I posted it, allowed while stopped, and Try again with `notOnTikTok`); not a Mac post → 409 "Your Mac isn't
   posting this clip." The route stays; the web called it from Post it yourself instead until ADR-85 and no longer
   calls it.

### 47.3 The helper's routes (JWT: the helper signs in as the owner)

| Method & path | Body | 2xx |
|---|---|---|
| GET `/v1/tiktok/mac` | – | `{ on, helper: MacHelper \| null, queue: MacJob[] }` |
| POST `/v1/tiktok/mac/ping` | `{ state: "ok" \| "needs_you" \| "paused", reason?, version?, device, login?: "saved" \| "none", loginDone? }` | `{ on }` |
| POST `/v1/tiktok/mac/send` | `{ clipIds, now?: boolean }` | `{ results }` |
| POST `/v1/tiktok/mac/login` | `{ action: "change" \| "forget" }` | `{ helper }` (§47.8) |
| POST `/v1/clips/{clipId}/tiktok/mac/claim` | `{ device }` | `{ job: MacJob }` |
| POST `/v1/clips/{clipId}/tiktok/mac/step` | `{ device, step }` | `{ job: MacJob }` |
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
* **Ping:** puts the helper item (`seenAt` now) and answers `on`. State other than the three → 400.
* **Claim:** one conditional write. It succeeds when `status = mac` and either `macState = waiting`, or `working` with
  no `macPressedAt` and `macBeatAt` older than 15 minutes (a crashed helper). It sets `working`, `macClaimedAt`,
  `macDevice`, `macBeatAt`, `macStep: "video"` and `macAttempt + 1` (the job's `attempt`). Anything else → 409 "Another try already has this
  clip."; not a Mac post → 409 "Your Mac isn't posting this clip."; switch off → 409 `MAC_OFF`. A post with
  `macPressedAt` is **never** claimed again by itself: never twice.
* **The attempt:** `step`, `done` and `stopped` take an optional `attempt` (a whole number from 1). When sent it must
  equal `macAttempt`, else 409 "Another try already has this clip.", so an older attempt of the same device (which
  took back its own stale claim) is never taken for the new one; the writes are conditional on it too.
* **Step:** only from `macDevice` while `working` (409 "Another try already has this clip." otherwise; an unknown step
  → 400). It sets `macStep` and `macBeatAt`; `pressing` also sets `macPressedAt` (the first press is kept), the point
  of no return. While the switch is off a step before Post → 409 `MAC_OFF` (the owner's "Your Mac stops at once");
  after Post the helper may still look for the link. Each step reaches the web live: post item changes stream as post
  events (§14.2, `POST#` is in the broadcast filter) with the public `mac`.
* **Done:** from `macDevice`, while `working` or `stopped` (409 otherwise). It runs `tiktok_self.mark_posted` on the
  row (`mac=MacDone(device, attempt)`), so the one-post-per-clip rule and the `tiktokByYou` race guard stay as they are: the same write
  sets `via: "mac"` and removes the Mac fields, conditional on `macDevice` and the state. `link`: read by
  `tiktok_link.resolve`, as in I posted it (§42.2, the same `note` for another account). No link: the §42 finder, with
  `since = macClaimedAt − 1 minute`. A repeat call is answered as the first, adding the link when it brings one. The
  clip becomes `posted` by the settle rule (a `publishing` clip is left to its flow).
* **Stopped:** from `macDevice` (while `working` or `stopped`). Sets `stopped`, `macStoppedAt` and `macReason` (spaces
  collapsed, at most 200 characters). With `needsYou` the helper item also becomes `needs_you` with that reason. Once
  `macPressedAt` is set, the stored reason is "Your Mac pressed Post but couldn't confirm it. Check your TikTok: if
  it's there, tap I posted it." whatever was sent. That stored sentence stays as it is; the web never shows it, and
  picks its own words by `pressedAt` (§47.4), never by matching the text.
* **Stuck** (`tiktok_self.mac_stuck`, `MAC_STUCK` 15 minutes): a Mac post still `working` whose `macClaimedAt` is 15
  minutes old or more, whatever its heartbeat or `macPressedAt` (the helper crashed after Post, or lost its ledger).
  The web shows it as "Not sure it posted" (§47.4); Retry and I posted it take it as below.
* **Retry** (the owner's Try again): `stopped` → `waiting`, keeping `since` (its place in line) and clearing `macStep`,
  `macClaimedAt`, `macStoppedAt`, `macReason`. A stuck post goes back to `waiting` the same way (also clearing
  `macDevice` and `macBeatAt`), in one write conditional on `macState = working` and that same `macClaimedAt` (a new
  claim meanwhile → 409 "This clip just changed. Try again."), so the Mac claims it afresh. With `macPressedAt` it needs `notOnTikTok: true`, which clears it;
  without → 409 "Your Mac may have posted it already. Check your TikTok first." Working and not stuck → 409 "Your Mac
  is posting it right now. Wait a minute." A post already waiting is answered as it is. It also turns the helper item back to `ok`
  when it was `needs_you`. **`now: true`** (additive, ADR-85; the web's row Try again always sends it) also sets
  `macSource: "upload"` in the same conditional write, so the Mac posts it at once and first. That holds for an
  auto-posting run's post (`auto`) too, also while auto-posting is off: he tapped it himself, so §47.2's off switch
  (which holds back what auto-posting picked) no longer applies to it. `now` must be a boolean (400 otherwise);
  without it a retry is exactly as before.
* **I posted it** (§42) on a Mac post: allowed while `waiting` or `stopped`, or `working` once stuck (the write then
  needs that same `macClaimedAt`); it becomes his own post; its Mac fields go into `beforeYou`, so his Undo puts the
  Mac post back as it was. Refused while `working` and not stuck with "Your Mac is posting it right now. Wait a
  minute." Marking a stopped or stuck Mac post (the row's **It's on TikTok**) also turns the helper item back to `ok`
  when it was `needs_you` (`tiktok_self.clear_needs_you`, as Retry does): the helper echoes `needs_you` for as long as
  the server says it, so nothing else would let the Mac go on. The Mac's late done on it is refused (409).

### 47.4 What the owner sees (web)

Rewritten 2026-11-22 for [ADR-85](DECISIONS.md#adr-85-no-manual-tiktok-sheet-the-mac-is-the-only-way-to-tiktok-until-tiktok-approves-the-app):
there is no manual TikTok sheet, so every TikTok row says only what the Mac is doing, with at most one button.

* Every place that reads `Post.status` handles `"mac"`: the types, `metrics.calmCopy`, Library's TikTok row, the clip
  page's stack (`PlatformPerformance` carries the same `mac` and `via`) and Review's "Uploaded just now". The helpers
  are in `web/src/lib/tiktokMac.ts`.
* **The TikTok row** (`tiktokRow(facts, ctx)`), the same on Library's card, the clip page (its TikTok stack, and the one
  button in `perf__actions`) and Review's "Uploaded just now" line ("TikTok: {words}"). `facts`: the clip's TikTok post
  (`status`, `by`, `via`, `url`, `privacy`, `mac`, `postedAt`), the clip's id (its place in the Mac's queue), whether
  it is not on TikTok yet (`canPostYourself`) and whether it is a Private test (a campaign clip is a clip like any
  other since 2026-11-23). `ctx`: the switch (`settings.tiktokMac.on`), the Mac's check-in and queue (`GET
  /v1/tiktok/mac` through `useTikTokMac`: on open, on focus, every 60 s and after post news; read whenever a row may need
  it, a Mac post or a clip the Mac could take), auto-posting's switch, and only while a backlog clip waits with
  auto-posting on, `GET /v1/autopost`'s `nextRunAt` and its newest scheduled live run. Checked in this order:

  | # | When | The row says | Its one button |
  |---|---|---|---|
  | 1 | Posted `via: "mac"` | "Posted by your Mac · Everyone" ("Posted by your Mac · Only you" when private), with **Open** and its numbers | none; with no link it adds " · add the link" and the inline **Add link** (§42.1) |
  | 2 | `by: "you"`, no `via` (§42) | "Posted by you · Everyone", with **Open** | none; with no link " · add the link" and **Add link** |
  | 3 | `mac.state` `working` | "Posting…", with a spinner (the steps arrive as live post events); once its `claimedAt` is 15 minutes old (`MAC_STUCK_MS`, the API's `mac_stuck`) while the Mac checks in and is `ok`: "Not sure it posted · look on your TikTok", as row 8's pressed one | none; stuck: **It's on TikTok** and **Try again**, as row 8 |
  | 4 | The Mac can't post (waiting, stopped and not-yet rows) | "Your Mac posts TikTok is off" (the switch); "Your Mac isn't set up yet" (it never checked in); "Your Mac hasn't checked in since 14:03" (not seen for 30 minutes or more, `MAC_STALE_MS`) | **Turn on** → `/settings/posting/tiktok-mac` |
  | 5 | It needs him, or is paused (waiting, working and not-yet rows) | "Your Mac needs you: {the reason's first sentence} · look at your Mac"; paused: the reason's first sentence and what comes next, "Paused after the 3 trial posts · your Mac goes on once their views are checked" (the helper's trial pause) or "Paused on your Mac · your clips wait until it's started again" (any other) | **Open Your Mac posts TikTok** (a stopped row keeps Try again, and a pressed one It's on TikTok, which both turn `needs_you` back to `ok`, §47.3). There is no Start again: no route asks the helper to go on, so the words say what happens and when |
  | 6 | `mac.state` `waiting` | "Waiting for your Mac · it takes it in about a minute" (`source: "upload"`, with a Mac that checked in and is `ok`); the first backlog clip (`sent`) waiting in the Mac's queue: "Waiting for your Mac · goes after the next auto-posting run (20:30)"; a later one: "Waiting for your Mac · in line (2 before it)" (the jobs before it in the queue); not known (no queue, past its 50, no run time): "Waiting for your Mac" alone, never a time that may be wrong | none |
  | 7 | Waiting, `source` `sent` or `auto`, auto-posting off | "Waiting for your Mac · auto-posting is off" | **Turn on** → `/settings/posting/auto` |
  | 8 | `mac.state` `stopped` | "Didn't work: {the reason's first sentence, without its full stop}"; once `pressedAt` is set, "Not sure it posted · look on your TikTok" (chosen by `pressedAt`, never by the stored sentence; shown even while the Mac can't post) | **Try again**; pressed: **It's on TikTok** (the inline Add link with **Find it for me**, from a minute before the claim) and a quieter **Try again** (no fill, its words underlined) that asks "Post it again? Only if it's not on your TikTok." with **Yes, post it again** and **Not now** |
  | 9 | Not on TikTok yet (`canSendToMac`: no TikTok post, or one waiting for setup, failed, failed for the public account, or private) | "Not on TikTok yet" (a campaign clip too) | **Post with my Mac** |
  | 10 | A Private test's clip | "Private test · stays off TikTok" | none |

  Rows 9 and 10 are only shown while TikTok has not approved the app (`tiktokAudited`); afterwards a clip without a Mac
  post keeps the API rows of §17 and §33 as before. Clip Factory's own TikTok posts (uploading, public) keep their rows.
  A row refused for the public account (§42.1) never shows the big Try again.
* **When it goes** (row 6), only what the web knows for sure (`macWaitWords`): `source: "upload"` with a Mac that
  checked in within 30 minutes and is `ok`: "it takes it in about a minute" (its launchd `StartInterval` is 60), never
  a minute of its own (the Mac takes them one at a time). `source: "sent"` (the backlog, one after each auto-posting
  run, §47.8) while auto-posting is on: only the first `sent` job still `waiting` in the Mac's queue (the server's
  order) says the run's time, the owner's local "20:30" (with the weekday when it is not today, as §46.2's times); a
  later one says how many jobs are before it in the queue. `source: "auto"`: no time (the Mac may hold it, which the
  web can't see). Not known (no queue or run time yet, or a clip past the queue's 50): "Waiting for your Mac" alone.
* **The buttons**, each the app's own `Button` or `LinkButton` (their hover state; the arrow is the only cursor):
  * **Try again**: `POST /v1/clips/{clipId}/tiktok/mac/retry {now: true}`. Beside **It's on TikTok** (not sure it
    posted: pressed, or stuck) it is the second choice: quieter (`.post__again`: no fill or lift of its own, only a
    panel's tint on the window look, its words underlined), and it asks first, in the row, "Post it again? Only if it's
    not on your TikTok." (`MAC_AGAIN_CONFIRM`) with **Yes, post it again** (the focus goes there) and **Not now**; Yes
    sends `{notOnTikTok: true, now: true}`. 409 while the Mac works on it: a toast.
  * **It's on TikTok**: opens the inline Add link in the row (`aria-expanded`), the box taking the focus.
  * **Post with my Mac**: `POST /v1/tiktok/mac/send {clipIds: [clipId], now: true}` (`source: "upload"`, so the Mac
    posts it at once), then the clip's posts and the clip are read again (or the live post event comes first).
    `sent: false`: a toast with its reason. `MAC_OFF` can't happen: with the switch off the row shows Turn on.
  * **Turn on**: a link; the switch there saves `PUT /v1/settings {tiktokMac: {on: true}}`.
  * **Add link**: the inline field of §42.1: the link box with **Find it for me** right beside it on one line (no link:
    `POST …/tiktok/posted {since}`, Clip Factory's finder), then **Paste** and **Save the link**.
* **Layout:** on a narrow card (Library's `.posts` container under 440 px: a phone, or three cards side by side at
  1440) the row's button goes under its words, on the right of the row's full width, and the Open icon stays beside
  the words; a wider card keeps it right of the words. It's on TikTok with Try again, Try again's question and the
  Add link are always on a line of their own under the words, on the right. On the clip page they line up with the
  other actions: centred while those are centred (a phone), from the left once they start there.
* **The clip page:** `calmCopy` says the row's words in the TikTok stack with no link, because the button is on the
  page (no "Go to Library and tap Post it yourself", and a stopped Mac post has no Go to Library link). The chip says
  "Waiting for your Mac", "Posting…", "Didn't work", or "Not sure it posted" (pressed, or its row says so: stuck).
* **Review:** with `tiktokMac.on` and TikTok not approved, the hint above Upload reads `MAC_HINT`, "TikTok: your Mac
  posts it for everyone.", and while the switch is off `TIKTOK_PUBLIC_HINT`, "TikTok: turn on Your Mac posts TikTok so
  it posts for everyone." (§42.1). "Uploaded just now" shows, for each kept clip, the words first (its hook, then
  "TikTok: {the row's words}"), then See how it does and the row's one button, in that order on screen and for
  reading; on a phone the buttons go under the words, on the right. Nothing opens by itself after Upload. Upload's own rules and buttons are
  unchanged: with the switch on it writes the Mac post as `source: "upload"`, which the helper posts at once.
* **Settings › Posting › Your Mac posts TikTok** (`/settings/posting/tiktok-mac`, `TikTokMacBranch.tsx`, in the tree
  after Auto-posting): the switch **My Mac posts my TikTok clips** (off: "Off. Your Mac doesn't post your TikTok
  clips."; on: "On. Upload and auto-posting hand TikTok to your Mac."); the status line "Your Mac checked in {Sun
  14:03}.", "Your Mac hasn't checked in yet. Set it up on your Mac.", "Your Mac needs you: {reason}", or paused with
  what comes next ("Paused after the 3 trial posts. Your Mac goes on once their views are checked.", else "Paused on
  your Mac. Your clips wait until it's started again."); while on, "{n} waiting for your Mac" and **Send these to my Mac** for the clips that aren't on TikTok yet
  ("3 clips aren't on TikTok yet."; its confirm line: "They go one at a time, oldest first."), sent without `now`, so
  one goes after each auto-posting run (§47.8); and one quiet line: "To stop it, turn the switch off. Your Mac stops at
  once."
* **Auto-posting page** (§46.2): "Where they go" says "TikTok: your Mac posts it." while on, and "TikTok: turn on Your
  Mac posts TikTok to post there." with **Turn on** while off. It has no TikTok list of its own any more (§46.2 item 7).
* **Gone from the web (ADR-85):** Post it yourself, Post it yourself instead (Take it back, then the §42 sheet), I
  posted it, "It's not on TikTok, try again", the step words while the Mac works ("Getting the video" … "Finding the
  link"), and Auto-posting's Post these on TikTok yourself. Their routes stay (§42.2, §47.2 item 4).
* Mock mode (`web/src/api/mock/tiktokMac.ts`) follows these rules, `now`, stuck claims and `needs_you` included; the
  helper's routes are test knobs (`window.__cfMock.mac`: ping, seen, claim (with how long ago), step, done, stopped,
  queue, post), and `window.__cfMock.posting.campaignClip()` makes a kept clip a campaign clip.

### 47.5 Tests (offline, fakes only)

* `api/tests/test_tiktok_mac.py`: the setting; Upload with the switch on (a Mac post in the same transaction), off,
  once TikTok approved the app, without the TikTok choices, without TikTok, and a campaign clip (to the Mac, always for
  Everyone, Upload's campaign checks kept); a run hands a campaign clip to the Mac for Everyone and never a Private
  test; It's on TikTok on a stopped post turns `needs_you` back to `ok` (pressed or not; not for a post that only
  waits; never makes a helper item); a stuck claim (Try again and It's on TikTok from 15 minutes, `notOnTikTok` still
  needed after Post, a new claim meanwhile wins, the Mac's late done refused); Send these to my Mac takes a campaign
  clip for Everyone; never TikTok's API: the clip flow's publish loop and
  `ensure-posts`, `release.release_waiting`, Try again and Post now (`_try_again`, `release.restart`, a failed clip's
  Try again), settle-clip (posted with the other posts done; a TikTok-only Upload stays `confirmed` until the Mac is
  done) and `tiktok_self._clip_status`; the queue (off, order and jobs, the auto-posting off switch, at most 50); ping;
  claim races, a stale claim, `pressedAt` never claimed again, the switch off; steps from the claiming Mac only, live,
  the switch off before Post; stops and needs you, the pressed reason; done through `mark_posted` with a link, with the
  finder's `since`, repeat-safe, only from the claiming Mac, after a stop, never undone, never a second post with I
  posted it; I posted it vs the Mac (refused while working; waiting or stopped, and its Undo); Try again with and
  without `notOnTikTok`; Take it back (deleted, restored, refused while working,
  refused after Post was pressed with nothing then sent through the API, one transaction that rolls back whole, a clip
  that just settled); an Upload that picked Only me still asks for Everyone and done marks it public; done's privacy
  follows the stored choice; the switch off lists waiting and stopped Mac posts in `tiktokYourself`; the job's
  `attempt` and an older attempt refused; Send these to my Mac (the switch, 1–25
  ids, a new post once, the race guard both ways, each hand-over and its Take it back, every refusal, the queue order);
  `now` (ADR-85): a send with `now` makes `macSource: "upload"` and the queue puts it first, one without stays `sent`,
  a retry with `now` turns `sent` and `auto` into `upload`, `now` must be a boolean (400), unknown keys still 400, and
  the switch off still 409 `MAC_OFF`; the clip page; another owner.
* `test_autopost_run.py`: `test_tiktok_is_never_a_place_even_when_ready` (unchanged, the switch off) and beside it the
  switch-on case (five posts in one transaction, TikTok's for the Mac, `uploadTo` without TikTok); Practice and a
  Private test never make one; a campaign clip from a run gets one, for Everyone. `test_autopost_routes.py`: `leftOut`/`macPlaces`, the
  `tiktokYourself` filter. `test_http.py`: the nine routes.
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
  with them.

### 47.6 Never twice, never TikTok's API

* A Mac post is never `queued` or `pending_integration`: the clip flow publishes only `queued` posts, the release only
  `pending_integration` ones, Try again only failed and waiting ones, and Post now's carried posts are `queued` ones.
* One TikTok post per clip: Upload writes it with the clip's `postsCreated` condition; a send needs neither
  `tiktokForMac` nor `tiktokByYou`, I posted it's new post neither; the Mac's done and I posted it are the same
  conditional write on the one row.
* One Mac, one try at a time: the claim is conditional; a post whose helper pressed Post is never claimed again by
  itself, and never taken back (it could then go out through TikTok's API as well); only the owner's Try again on that
  row (`notOnTikTok`, once the row told him to look on his TikTok first) clears that. The server still lets I posted
  it make such a post his (§47.3); the web no longer offers it there (ADR-85).

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
  /v1/autopost` (`runs`, `nextRunAt`), until the backlog is empty. With auto-posting off the backlog waits. Settings ›
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

### 47.7 Not verified live

The helper itself (its own PR); that TikTok Studio keeps accepting a background Chrome's uploads, and the reach of
script-posted videos (the 3-post trial compares 24-hour views with his phone posts, plan note §3); that `video/list`
sees a post the Mac made (as §42.5).
