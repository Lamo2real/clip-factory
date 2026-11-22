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
  sets.
* **Clip** `tiktokForMac` (internal): the id of a TikTok post Send these to my Mac created, next to §42's `tiktokByYou`.
* **After the Mac posts it**: the post becomes `posted`, `by: "you"`, `privacy: "public"`, with the public
  **`via: "mac"`**, through `tiktok_self.mark_posted`'s conditional write, and loses every `mac*` field and
  `beforeMac`/`madeForMac`. Undo (`DELETE …/tiktok/posted`) of a `via: "mac"` post → 409 "Your Mac posted this one. To
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
                   state: "waiting" | "working" | "stopped"; step?: MacStep; claimedAt?: string; pressedAt?: string }
```

### 47.2 Where Mac posts come from

Upload and auto-posting write the Mac post in the same transaction as the clip's other posts
(`posts.create_for_clip`'s explicit `tiktok_mac` path, through `uploads.upload_review_clip`), never afterwards.

1. **Upload** (`routes/clips.confirm` → `uploads.upload_review_clip`): the TikTok post is written as a Mac post
   (`source: "upload"`, `madeForMac`) instead of `queued` when all hold: `"tiktok"` is among the chosen places;
   `settings.tiktokMac.on`; TikTok has not approved the app (`tiktok_mac.tiktok_audited`, the server twin of the web's
   `tiktokAudited`: `app_review` and `posting_audit` not both `ok`); the clip is not a campaign clip (they keep
   today's path). The `tiktok` body stays required ("Pick who can see it on TikTok.") and becomes the post's
   `postOptions`; `uploadTo` names TikTok (he chose it). Upload's API TikTok rule (`queued`, the refusals) is
   otherwise unchanged, and exactly as before with the switch off or once TikTok approved the app.
2. **Auto-posting runs** (`autopost/run.py`, live mode only): with `tiktokMac.on`, a normal (non-campaign) clip also
   gets a TikTok Mac post (`source: "auto"`) through `upload_review_clip(..., tiktok_mac=True)`; its options are My
   settings' (§36: Everyone, Comment, Duet and Stitch on). TikTok is **not** added to the run's places (`uploadTo`
   never names it). Practice and Private test runs never make one ("Nothing gets sent"). `GET /v1/autopost`:
   `leftOut` drops TikTok while on, `macPlaces: ["tiktok"]` (else `[]`), and `tiktokYourself` drops clips whose TikTok
   post is a Mac post (any state) or was posted `via: "mac"`. **Off switch:** while `autoPost.on` is false, Mac posts
   with `source: "auto"` that are still `waiting` are left out of the queue and refused to a claim ("Auto-posting is
   off, so this one waits."); the app shows "Waiting for your Mac · auto-posting is off".
3. **Send these to my Mac** (`POST /v1/tiktok/mac/send {clipIds: string[] 1–25}` → `{results: [{clipId, sent,
   reason?}]}`, in order, each id once; 409 `MAC_OFF` while the switch is off). A clip goes when Post it yourself would
   show (§42.1): uploaded, its TikTok not out for everyone, not `by: "you"`, not `queued`, not a Mac post already; never
   a campaign clip or a Private test. A clip with no TikTok post gets a new Mac post (`madeForMac`, appended to
   `postIds`, its id in the clip's `tiktokForMac`), written only while the clip has neither `tiktokForMac` nor
   `tiktokByYou`: two sends, or a send and I posted it, never make two posts (I posted it's new-post write now also
   needs `tiktokForMac` absent). A Clip Factory TikTok post that waits for setup, failed or went up privately is handed
   over in place: its fields (status, link, ids, stats and `gsi2` fields, what was learned, `postOptions`,
   `publishHandle`) go into `beforeMac`, so it also leaves the stats poller. `source: "sent"`, My settings' options. The
   clip's status follows the clip flow's settle rule (a failed clip whose only failed post was TikTok's becomes
   `confirmed`). Reasons: "Upload this clip first.", "This clip is still starting to upload. Try again in a minute.",
   "Campaign clips go on TikTok by hand. Tap Post it yourself.", "This was a Private test, so it stays off TikTok.",
   "This clip is still uploading to TikTok. Wait until it is done, then try again.", "You already posted this one on
   TikTok.", "This clip is already on TikTok for everyone.", "Your Mac already has this clip.", "We could not find
   that clip.", "This clip just changed. Try again."
4. **Take it back** (`DELETE /v1/clips/{clipId}/tiktok/mac` → `{clip, posts}`): only while `mac.state` is `waiting` or
   `stopped` (conditional). A `madeForMac` post is deleted (on that condition) and leaves `postIds` (and
   `tiktokForMac`); a handed-over post gets `beforeMac` back. The clip's status follows the settle rule. Working → 409
   "Your Mac is posting it right now. Wait a minute."; not a Mac post → 409 "Your Mac isn't posting this clip." The
   app calls it from **Post it yourself instead**, then opens the §42 sheet.

### 47.3 The helper's routes (JWT: the helper signs in as the owner)

| Method & path | Body | 2xx |
|---|---|---|
| GET `/v1/tiktok/mac` | – | `{ on, helper: MacHelper \| null, queue: MacJob[] }` |
| POST `/v1/tiktok/mac/ping` | `{ state: "ok" \| "needs_you" \| "paused", reason?, version?, device }` | `{ on }` |
| POST `/v1/tiktok/mac/send` | `{ clipIds }` | `{ results }` |
| POST `/v1/clips/{clipId}/tiktok/mac/claim` | `{ device }` | `{ job: MacJob }` |
| POST `/v1/clips/{clipId}/tiktok/mac/step` | `{ device, step }` | `{ job: MacJob }` |
| POST `/v1/clips/{clipId}/tiktok/mac/done` | `{ device, link? }` | `{ clip, posts, note? }` |
| POST `/v1/clips/{clipId}/tiktok/mac/stopped` | `{ device, reason, needsYou?: boolean }` | `{ job: MacJob }` |
| POST `/v1/clips/{clipId}/tiktok/mac/retry` | `{ notOnTikTok?: true }` | `{ clip, posts }` (the owner's Try again) |
| DELETE `/v1/clips/{clipId}/tiktok/mac` | – | `{ clip, posts }` (Take it back) |

Unknown body keys → 400 everywhere; `device` is required text (at most 100 characters); a clip that is not the
caller's → 404 "We could not find that clip." `MAC_OFF` is "Your Mac posting is off. Turn it on in Settings › Posting ›
Your Mac posts TikTok."

* **Queue:** empty while the switch is off. Else the Mac posts that are `waiting` (minus `source: "auto"` while
  `autoPost.on` is false) plus the `working` ones (a restarted helper sees its own). Order: `source: "upload"` first,
  then the rest; oldest `since` first, then the oldest clip (`decidedAt`); at most 50. `caption` is the clip's stored
  TikTok caption, repaired as §5 says and in NFC; `fileName` is the web's `videoFileName(hook)`; `privacy` and the
  three switches come from the post's options.
* **Ping:** puts the helper item (`seenAt` now) and answers `on`. State other than the three → 400.
* **Claim:** one conditional write. It succeeds when `status = mac` and either `macState = waiting`, or `working` with
  no `macPressedAt` and `macBeatAt` older than 15 minutes (a crashed helper). It sets `working`, `macClaimedAt`,
  `macDevice`, `macBeatAt`, `macStep: "video"` and `macAttempt + 1`. Anything else → 409 "Another try already has this
  clip."; not a Mac post → 409 "Your Mac isn't posting this clip."; switch off → 409 `MAC_OFF`. A post with
  `macPressedAt` is **never** claimed again by itself: never twice.
* **Step:** only from `macDevice` while `working` (409 "Another try already has this clip." otherwise; an unknown step
  → 400). It sets `macStep` and `macBeatAt`; `pressing` also sets `macPressedAt` (the first press is kept), the point
  of no return. While the switch is off a step before Post → 409 `MAC_OFF` (the owner's "Your Mac stops at once");
  after Post the helper may still look for the link. Each step reaches the web live: post item changes stream as post
  events (§14.2, `POST#` is in the broadcast filter) with the public `mac`.
* **Done:** from `macDevice`, while `working` or `stopped` (409 otherwise). It runs `tiktok_self.mark_posted` on the
  row (`mac_device`), so the one-post-per-clip rule and the `tiktokByYou` race guard stay as they are: the same write
  sets `via: "mac"` and removes the Mac fields, conditional on `macDevice` and the state. `link`: read by
  `tiktok_link.resolve`, as in I posted it (§42.2, the same `note` for another account). No link: the §42 finder, with
  `since = macClaimedAt − 1 minute`. A repeat call is answered as the first, adding the link when it brings one. The
  clip becomes `posted` by the settle rule (a `publishing` clip is left to its flow).
* **Stopped:** from `macDevice` (while `working` or `stopped`). Sets `stopped`, `macStoppedAt` and `macReason` (spaces
  collapsed, at most 200 characters). With `needsYou` the helper item also becomes `needs_you` with that reason. Once
  `macPressedAt` is set, the stored reason is "Your Mac pressed Post but couldn't confirm it. Check your TikTok: if
  it's there, tap I posted it." whatever was sent.
* **Retry** (the owner's Try again): `stopped` → `waiting`, keeping `since` (its place in line) and clearing `macStep`,
  `macClaimedAt`, `macStoppedAt`, `macReason`. With `macPressedAt` it needs `notOnTikTok: true`, which clears it;
  without → 409 "Your Mac may have posted it already. Check your TikTok first." Working → 409 "Your Mac is posting it
  right now. Wait a minute." A post already waiting is answered as it is. It also turns the helper item back to `ok`
  when it was `needs_you`.
* **I posted it** (§42) on a Mac post: allowed while `waiting` or `stopped` (it becomes his own post; its Mac fields go
  into `beforeYou`, so his Undo puts the Mac post back as it was), refused while `working` with "Your Mac is posting it
  right now. Wait a minute."

### 47.4 What the owner sees (web)

* Every place that reads `Post.status` handles `"mac"`: the types, `metrics.calmCopy`, Library's TikTok row, the clip
  page's stack (`PlatformPerformance` carries the same `mac` and `via`), Review's "Uploaded just now" and the
  auto-posting lists. The helpers are in `web/src/lib/tiktokMac.ts`.
* **The TikTok row:** Waiting: "Waiting for your Mac", plus " · auto-posting is off" (`source: "auto"` while it is
  off), else " · set up your Mac first" (the helper never checked in), else " · your Mac was last seen {Sun 14:03}"
  (not seen for 10 minutes). Working: "Your Mac is posting it · {step}" with the step words "Getting the video",
  "Opening TikTok", "Uploading", "Setting Everyone and the switches", "Posting" and "Finding the link". Stopped: "Your
  Mac stopped: {reason}", with **Try again** (retry; once `pressedAt` is set it says "It's not on TikTok, try again" and
  sends `notOnTikTok`) and **Post it yourself instead**. Posted `via: "mac"`: "Posted by your Mac · Everyone", with
  Open and the numbers as for "Posted by you".
* **Post it yourself** stays as it is for clips without a Mac post. On a waiting or stopped Mac post it reads **Post it
  yourself instead**: Take it back (DELETE), then the §42 sheet. Hidden while the Mac works on it.
* **Review:** with `tiktokMac.on` and TikTok not approved, the hint above Upload reads "TikTok: your Mac posts it for
  everyone." instead of §42's `TIKTOK_PUBLIC_HINT`, and §42's sheet does not open by itself after Upload. Upload's own
  rules and buttons are unchanged.
* **Settings › Posting › Your Mac posts TikTok** (`/settings/posting/tiktok-mac`, `TikTokMacBranch.tsx`, in the tree
  after Auto-posting): the switch **My Mac posts my TikTok clips** (off: "Off. TikTok works as before: Post it
  yourself."; on: "On. Upload and auto-posting hand TikTok to your Mac."); the status line "Your Mac checked in {Sun
  14:03}.", "Your Mac hasn't checked in yet. Set it up on your Mac.", "Your Mac needs you: {reason}" or "Paused on your
  Mac."; while on, "{n} waiting for your Mac" and **Send these to my Mac** for the clips that show Post it yourself
  (its confirm line: "They go one at a time, oldest first."); and one quiet line: "To stop it, turn the switch off.
  Your Mac stops at once."
* **Auto-posting page** (§46.2): "Where they go" says "TikTok: your Mac posts it." while on, and "Post these on TikTok
  yourself" gets the same **Send these to my Mac**.
* Mock mode (`web/src/api/mock/tiktokMac.ts`) follows these rules; the helper's routes are test knobs
  (`window.__cfMock.mac`: ping, seen, claim, step, done, stopped, queue, post).

### 47.5 Tests (offline, fakes only)

* `api/tests/test_tiktok_mac.py`: the setting; Upload with the switch on (a Mac post in the same transaction), off,
  once TikTok approved the app, without the TikTok choices, without TikTok, and a campaign clip (today's path); a run
  never hands a campaign clip or a Private test to the Mac; never TikTok's API: the clip flow's publish loop and
  `ensure-posts`, `release.release_waiting`, Try again and Post now (`_try_again`, `release.restart`, a failed clip's
  Try again), settle-clip (posted with the other posts done; a TikTok-only Upload stays `confirmed` until the Mac is
  done) and `tiktok_self._clip_status`; the queue (off, order and jobs, the auto-posting off switch, at most 50); ping;
  claim races, a stale claim, `pressedAt` never claimed again, the switch off; steps from the claiming Mac only, live,
  the switch off before Post; stops and needs you, the pressed reason; done through `mark_posted` with a link, with the
  finder's `since`, repeat-safe, only from the claiming Mac, after a stop, never undone, never a second post with I
  posted it; I posted it vs the Mac (refused while working; waiting or stopped, and its Undo); Try again with and
  without `notOnTikTok`; Take it back (deleted, restored, refused while working); Send these to my Mac (the switch, 1–25
  ids, a new post once, the race guard both ways, each hand-over and its Take it back, every refusal, the queue order);
  the clip page; another owner.
* `test_autopost_run.py`: `test_tiktok_is_never_a_place_even_when_ready` (unchanged, the switch off) and beside it the
  switch-on case (five posts in one transaction, TikTok's for the Mac, `uploadTo` without TikTok); Practice and a
  Private test never make one; a campaign clip from a run never. `test_autopost_routes.py`: `leftOut`/`macPlaces`, the
  `tiktokYourself` filter. `test_http.py`: the nine routes.
* Web: `web/test/tiktokMac.test.ts` (the row words, step words, labels, who may be sent, the lines and the mock's
  rules) and `web/e2e/tiktok-mac.spec.ts` (Library row states, the Settings branch switch, Send these, the Review hint).

### 47.6 Never twice, never TikTok's API

* A Mac post is never `queued` or `pending_integration`: the clip flow publishes only `queued` posts, the release only
  `pending_integration` ones, Try again only failed and waiting ones, and Post now's carried posts are `queued` ones.
* One TikTok post per clip: Upload writes it with the clip's `postsCreated` condition; a send needs neither
  `tiktokForMac` nor `tiktokByYou`, I posted it's new post neither; the Mac's done and I posted it are the same
  conditional write on the one row.
* One Mac, one try at a time: the claim is conditional; a post whose helper pressed Post is never claimed again by
  itself; only the owner's "It's not on TikTok, try again" clears that.

### 47.7 Not verified live

The helper itself (its own PR); that TikTok Studio keeps accepting a background Chrome's uploads, and the reach of
script-posted videos (the 3-post trial compares 24-hour views with his phone posts, plan note §3); that `video/list`
sees a post the Mac made (as §42.5).
