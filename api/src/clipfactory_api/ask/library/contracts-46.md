## 46. Auto-posting: the oldest clips in Review go up by themselves, every X hours (owner request, 2026-11-22)

Decision record: ADR-81. Builders: §46.16. Everything here is additive: no table, index, secret, bucket, Cognito or
cf-prod-api infrastructure changes; existing settings, clips and posts read exactly as before.

### 46.1 The owner's words and the answers he gave

The spec (2026-11-22, verbatim where quoted): "On each scheduled run, take the next clips from the review list, oldest
first, and post them." "Each clip goes to all my connected accounts on every platform in the same run." "Clips in
review post automatically, without my approval. I can still decline a clip before its turn, which removes it." "If
there are no clips in review, the run does nothing." "A clip is never posted twice, even if a run is retried or two
runs overlap." "If posting fails on one platform, retry once, record the error, and still post to the other
platforms." "Save the live link of every post next to its clip and campaign." Settings: an on/off switch ("While it
is off, nothing posts"), "Post every X hours" (1 to 24, default 5), "Clips per interval" (1 to 5, default 1),
"Changes take effect immediately when I save, without a redeploy", and under the controls the result in plain words,
"e.g. '1 clip every 5 hours = about 5 clips a day per platform', and warn me if it is more than 5 a day". Visibility:
"whether auto-posting is on, when the next run is, and which clips post next", and "failed posts with the error and a
way to retry them". Technical: EventBridge, serverless only, "even gaps between runs, including across midnight".

Asked before building, he answered "Yes, all your picks" (2026-11-22). They are the rules below:
1. **My settings, not bare platform defaults** (§36.2): public, most reach, never made for kids.
2. **TikTok is never part of a run.** Clip Factory's uploads fail on his public account until TikTok approves the app
   (§42), and TikTok's rules want the creator's own pick of who can see each post, with no default (§17.8), so a
   post nobody tapped can't be a TikTok post even after approval. Each auto-posted clip keeps **Post it yourself**.
   **Amended 2026-11-22 by the owner's new go ("Full auto, 3-post trial", relayed by the coordinator after he saw the
   risks; ADR-83):** TikTok is still never one of a run's places and never goes through TikTok's API, but while
   **Your Mac posts TikTok** is on (`settings.tiktokMac.on`, §47) a live run's normal clip also gets a TikTok post
   for his Mac (`source: "auto"`, My settings' Everyone with Comment, Duet and Stitch on), written in the same
   transaction as its other posts. Practice, Private test runs and campaign clips never get one. Clips already
   waiting go too when he sends them ("Send them too": oldest first, one every 30 minutes, after the trial).
   **Amended again 2026-11-22 (ADR-86):** there is no Post it yourself any more. While Your Mac posts TikTok is off, a
   run still leaves TikTok out, and Where they go (§46.2 item 3) says how to turn the Mac on.
3. **Campaign clips wait for his Upload** while Content Rewards can't take them from Clip Factory by itself (it only
   takes a clip in its first 30 minutes, §38.6; his account can't connect apps yet). Once it can (§46.5 rule 4) they go
   too, the campaign way (§38.14).
4. **A clip with a failed important check waits for him** (§46.5 rule 3).
5. **Clips already in Review count**, oldest first; the page shows the whole line before he turns it on.
6. **Retries stay as Upload's** (§17.6): up to 3 tries when a platform does not answer, and no blind retry where one
   would fail the same way or could post twice (X's post, Instagram's publish, TikTok's start). Every error is saved
   and the other platforms still post. This replaces "retry once".
7. **The timer is an EventBridge rule that fires every hour on the hour**; a run happens only when his X hours are up
   (§46.4).

Also decided: X is used once it is set up (never for clips posted before); only clips of finished jobs are picked;
a "Practice" mode and a "Private test run" let him test the whole flow with nothing public (§46.8).

### 46.2 What the owner sees

**Settings › Posting › Auto-posting** (`/settings/posting/auto`, `screens/settings/AutoPostBranch.tsx`; in the tree
after My settings). Top to bottom, every control saving the moment it changes (like My settings, §36.2), with the
toast "Saved.":
1. The switch **Post my clips by themselves** (`autoPost.on`). Under it one line: off "Off. Nothing posts by itself.";
   on "On. Next: Sun 15:00." (the owner's local time, weekday + 24-hour time, "Today"/"Tomorrow" never used); on in
   practice "On, practising. Next practice: Sun 15:00. Nothing gets sent."
2. **Post every** (the app's own `Dropdown`, §36.5: "1 hour", "2 hours" … "24 hours"; `everyHours`) and **Clips each
   time** (a `<Glide>` bar 1 2 3 4 5; `perRun`). Under them the **result line**, always shown:
   "{n} clip(s) every {h} hour(s) = {about }{d} clip(s) a day per platform." `d = perRun × 24 / everyHours`; whole →
   that number without "about" ("1 clip every 24 hours = 1 clip a day per platform."), else "about" + rounded half up
   ("1 clip every 5 hours = about 5 clips a day per platform.", 4.8; "2 clips every 7 hours = about 7 clips a day per
   platform.", 6.86). When `d > 5`, a warning under it in vermilion ink (`role="status"`): "That's more than 5 clips a
   day on each platform." and when `d > 100` also "YouTube takes at most 100 uploads a day, so some would wait until
   the next day." (videos.insert has its own bucket of 100 a day, checked 2026-11-22).
3. **Where they go**: "Goes to YouTube, Instagram and Facebook." (the run's places, §46.6, in STATS_ORDER), then one
   line per place left out: "TikTok: turn on Your Mac posts TikTok to post there." (`leftOut` reason
   `tiktok_yourself`, with **Turn on** → `/settings/posting/tiktok-mac`, ADR-86); "X: not set up yet." (with "Set up
   X" → `/settings/posting/setup/x`). With nothing set up: "Nothing is set up to post to. Set up a place first." and
   runs post nothing. While Your Mac posts TikTok is on (§47) the TikTok line is "TikTok: your Mac posts it." instead
   (`macPlaces`, and `leftOut` leaves TikTok out); on, but with no other place set up (TikTok back in `leftOut`, a run
   sends nothing, §46.6), it is "TikTok: your Mac posts it once another place is set up." with no Turn on.
4. **Next up** (`autopost.nextUp`, at most 10): cover, hook, and its time ("Sun 15:00"; with it off, no times and the
   title "Would go first"; a clip with no `runAt` shows no time), each with **Throw away** (the Review card's own
   decline with its Undo, §20.7, accessible name "Throw away, {hook}"). Empty: "Nothing in Review. New clips join the
   line when they are made."
   **Throw away holds the clip on the server at once** (here and on the Review card): the tap sends
   `POST /v1/clips/{clipId}/hold` (§46.9), so no run sends the clip while the 8 s Undo toast is up, nor before a
   decline that comes late (a phone locked during the toast stops its timer; the hold lasts a day); **Undo** lifts the
   hold (`DELETE /v1/clips/{clipId}/hold`); the decline itself (`POST …/decline`) still goes when the toast ends. A
   hold answered 409 "Auto-posting already sent this clip." means a run sent it first: the app says that sentence and
   does not throw it away (§46.13).
5. **Waits for you** (`autopost.waiting`): clips in Review that runs skip, each with its reason (§46.5) and **Open in
   Review**.
6. **Didn't work** (`autopost.failed`): one row per failed auto-posted post: place mark and name, hook, the saved
   friendly error (§17.6), **Try again** (the Library's per-place Try again: `confirm` with `platforms: [p]`, accessible
   name "Try again, {place}"). Hidden when empty.
7. *Removed 2026-11-22 (ADR-86).* **Post these on TikTok yourself** listed auto-posted clips not on TikTok yet, each
   with Post it yourself (and Send these to my Mac while the Mac was on). The page no longer has the list
   (`#auto-post-tiktok` and its settings-tree apple are gone): each clip's TikTok row in Library says what his Mac is
   doing (§47.4), and Settings › Posting › Your Mac posts TikTok keeps **Send these to my Mac**.
   `autopost.tiktokYourself` stays in the API (§46.9), unused by the web. Items 8 and 9 keep their numbers.
8. **Recent** (`autopost.runs`, newest first, 10): "Sun 10:00 · “hook”: YouTube ✓ Instagram ✓ Facebook ✗", each
   posted place with **Open** (its live `url`); a run with nothing: "Sun 05:00 · Nothing in Review, so nothing posted.";
   practice: "Sun 05:00 · Practice: would post “hook” to YouTube, Instagram and Facebook."; private test: "Private test
   · “hook”: YouTube (only you) · Facebook (draft) · Instagram (checked, not published)".
9. A fold **Test it first** (closed to start): the switch **Practice** (`autoPost.practice`, "Pick the clips on time,
   but send nothing. The clips stay in Review."), **Practice run now** and **Private test run** (glass buttons; the
   second's line: "Posts the next clip so only you can see it: YouTube as Only me, Facebook as a draft on your Page,
   Instagram uploaded and checked but not published. It leaves Review."). After a tap the page reads the status again
   every 3 s for 30 s; the run shows in Recent.

The page reads `GET /v1/autopost` on open, on focus, every 60 s while open, and after every change. Clip changes reach
Review and Library live as today (the clip item's stream news, §14.2).

**Review card** (§36), only while `autoPost.on`: one quiet line above the actions. A clip in Next up: "Goes up by
itself {Sun 15:00}. Throw it away to stop it." (practice: "Practice picks it {Sun 15:00}. Nothing gets sent."); a
waiting clip: "Auto-posting skips this one: {reason} Upload it yourself." Upload works as before; Throw away works as
before and also holds the clip at the tap (item 4).

**Home** (`NewJobForm.tsx`): the hint "Nothing gets posted until you tap Upload." becomes, while on, "Auto-posting is
on: your clips go up by themselves every {h} hour(s), oldest first." (practice: unchanged hint).

**Library and the clip page**: an auto-posted post row adds "· by auto-posting" after its state; a private test post
says "Private test · only you" (YouTube), "Private test · draft on your Page" (Facebook), "Private test · checked, not
published" (Instagram) instead of "Uploaded", and has no numbers.

### 46.3 Settings (`settings.py`, GET/PUT `/v1/settings`)

`Settings.autoPost: { on: boolean /* false */, everyHours: number /* 1..24, 5 */, perRun: number /* 1..5, 1 */,
practice: boolean /* false */, onAt?: string /* read-only: when it was last switched on */ }`.

* PUT may send any of `on`, `everyHours`, `perRun`, `practice`; each is merged over the stored value. Unknown keys and
  `onAt` → 400 "autoPost has a setting Clip Factory does not know.". `everyHours` an integer 1..24 else 400 "Pick 1 to
  24 hours.", `perRun` an integer 1..5 else 400 "Pick 1 to 5 clips.", `on`/`practice` booleans.
* When `on` goes false → true the server writes `onAt = now`. A PUT with `on: true` while already on keeps `onAt`.
* Every PUT that carries `autoPost` also puts the owner's registry item `AUTOPOSTOWNERS` / `USER#{userId}` (§46.10),
  so the tick finds him with one Query.
* A stored value that no longer validates reads the defaults (as `postPreset`). An owner who never saved it reads
  `{on: false, everyHours: 5, perRun: 1, practice: false}`: nothing changes for anyone until he turns it on.

### 46.4 The schedule (even gaps, across midnight)

* EventBridge rule `cf-prod-autopost-hourly`, `cron(0 * * * ? *)` (every hour at :00 UTC), target `cf-prod-autopost`.
  All times are UTC instants on whole hours ("slots"); the web shows them in local time.
* The tick's slot is `floorHour(event.time)`, the event's own time, never "now": a retried delivery of the same event
  is the same slot.
* `nextRunAt` (only while on) `= max(nextFullHour(onAt), lastRunAt + everyHours h)`, `lastRunAt` absent → the first
  term alone. `nextFullHour(t)` is the first whole hour strictly after `t`. A slot runs when `slot ≥ nextRunAt`. So
  runs fall exactly `everyHours` apart (5 h: 00, 05, 10, 15, 20, 01, 06 …); a changed `everyHours` counts from the last
  run (if that time has passed, the next full hour runs); switching on runs at the next full hour, never sooner than
  `everyHours` after the last run.
* **Shown** (`autopost.nextRunAt`, `schedule.next_run_at`): let `cur = floorHour(now)` and `evaluated =
  max(lastRunAt, lastTickAt)` (either may be absent; `lastTickAt` is the last slot a tick found not due, §46.7 step 1).
  When `nextRunAt ≤ cur`, `evaluated` is absent or `< cur`, and `now < cur + 3300 s` (`TICK_EVENT_AGE`, the
  Terraform `maximum_event_age_in_seconds`, §46.11: until then this hour's tick, or its retry, can still arrive), the
  shown run is `cur` (between :00 and the tick's claim it still says this hour). Otherwise `nextRunAt` when it is after
  `now`, else the next full hour (a lost tick, or one that already found the slot not due before a change made it
  due, is caught up by the next one). Examples (every 5 h, last run 08:00): 13:00:20 before the claim → 13:00; after
  the claim → 18:00; past 13:55 with no claim → 14:00. Last run 10:00, the 13:00 tick not due, `everyHours` lowered
  to 2 at 13:20 → 14:00.
* A run that finds nothing still counts (`lastRunAt` moves), so the gaps stay even.
* Practice runs (`practice: true`) keep the same times. Run-now actions (§46.8) never move the schedule.
* Why not a schedule the app changes (ADR-81): EventBridge Scheduler needs `iam:PassRole`, which the cf-prod-* role
  boundary forbids, and neither it nor a rule's `rate()` says when the next run is.

### 46.5 Which clips (`autopost/pick.py`)

Candidates: the owner's clips with `status: "review"` (one `query_all` of `CLIP#`), ordered oldest first by their job's
`createdAt` (the clip's own `createdAt` when the job is gone), then `rank` (best first), then `clipId`. A candidate is
**taken** unless one of these holds, in this order; then it is **waiting**, with the reason the owner sees:
1. Its job exists and is not `ready` → "It is still being made." (a retried job removes its earlier `review` clips).
2. It has no `videoKey` → "Its video is missing.".
3. A failed checklist item whose key is one of `hear`, `moving`, `zero_context`, `payoff`, `campaign_rules`, `logo`,
   `disclosure` → "A check didn't pass: {label}." (the agent drops clips that fail these, §8, so this is mostly
   `campaign_rules` that could not be checked).
4. A campaign clip (`routes/clips.campaign_clip` is not None): it waits unless **all** of: Content Rewards is on
   (`CONTENT_REWARDS`), `CRCONN.status` is `connected` (not `read_only`), the campaign's `membership` is `in` (not
   `manual`), `_require_campaign_open` passes, its places (rule below) are not empty, and the fit check (`_require_fit`
   with those places) passes. Reasons: "It's for a campaign, and Content Rewards can't take clips from Clip Factory by
   itself yet." (not connected or read only), "It's for a campaign you send by hand." (`manual`), else the refusal's
   own sentence.
5. A clip planned by another run that is still going (an `AUTORUN#` item with `state: "planned"` lists it, within
   15 minutes of its `plannedAt`, or of its `at` on runs stored before `plannedAt` existed) is skipped silently (not
   waiting). Counting from `plannedAt` keeps a tick that arrived late in its hour protecting its clips.

Before rules 1 to 5: a clip the owner is throwing away (its hold, `holdUntil`, is still in the future, §46.2) is
left out silently: not a candidate (a run whose only clips are held says "Nothing in Review, so nothing posted."),
neither taken nor waiting, so the next clip takes its turn. The hold ends by itself a day after the tap, or at once
with Undo (a lost Undo only keeps auto-posting off that clip for that day; Upload ignores the hold).

`nextUp` lists taken clips in order, at most 10; the i-th (0-based) gets `runAt = nextRunAt + floor(i / perRun) ×
everyHours h`, only when it has places (§46.6: a normal clip the run's places, a campaign clip its own; with nothing
set up no clip gets one) and, while `practice` is on, only for the first `perRun` (practice sends nothing, so every
practice run picks the same first clips again). No `runAt` while off. `waiting` lists the waiting ones (not rule 5 or
a hold), at most 20.

### 46.6 Places and options

* **Places** of a normal clip: every platform whose setup is `ready` (`oauth.setup.all_setups`, as Review's Upload to
  reads it, §33.2) except `tiktok`, in STATS_ORDER. A campaign clip: the same minus places `_place_refusal` refuses.
  Settings › Where clips go (`settings.platforms`) is not read (Upload ignores it too since §33). No places → the clip
  is not sent; the run's note says "Nothing is set up to post to."
* **Options** (`post_preset.upload_options(settings)`, the server twin of the web's `cardOptionsFrom` + `optionsFor`):
  YouTube `{privacy: settings.youtubePrivacy, category, madeForKids: false, notifySubscribers, embeddable}`, Instagram
  `{shareToFeed}`, X `{replies}` from `postPreset`, only for the places going; Facebook has none. A campaign clip gets
  the campaign versions exactly as Upload builds them (`_campaign_youtube`, `postOptions.campaign`). Captions are the
  clip's stored ones (his edits on the card are saved by `PATCH`). No TikTok options ever.

### 46.7 One run (`autopost/run.py`, shared by the tick and the API)

`run_once(deps, user_id, kind, slot)`; `kind` is `scheduled`, `practice_now` or `private_now`; `mode` is `live`,
`practice` (scheduled with `practice: true`, or `practice_now`) or `private` (`private_now`). `runId =
"{slot}#{kind}"` (slot = ISO UTC to the second for run-now).
1. **Scheduled only:** settings off → return `off`; this slot's own `AUTORUN#{runId}` already there (a retried
   delivery, or an overlapping invocation) → **resume** it (step 3), before any due check (the claim moved
   `lastRunAt` to this slot, so the slot is no longer due); `slot < nextRunAt` → `not_due`, writing
   `AUTOPOST.lastTickAt = slot` (an UpdateItem with no condition; it creates the item when absent) so the page stops
   showing this hour (§46.4).
2. **Plan:** pick (§46.5) the first `perRun` taken clips (`private_now`: 1, never a campaign clip), each with its
   places and options. Every run item stores `plannedAt` (the clock's time when it planned; `at` stays the slot).
3. **Claim** (scheduled): one `TransactWriteItems`: Put `AUTORUN#{runId}` (`state: "planned"`, `mode`, `clips:
   [{clipId, hook, places}]`, `note?`) on `attribute_not_exists(pk)`, and Update `AUTOPOST` `SET lastRunAt = :slot` on
   `attribute_not_exists(lastRunAt) OR lastRunAt < :slot`. Cancelled because the run item exists → **resume**: read it;
   `done` → return `done`; `planned` → continue at 4 with its own clips (never a new pick). Cancelled only on `AUTOPOST`
   (a later slot already moved `lastRunAt`) → return `not_due`; cancelled for another reason (a conflict, throttling)
   → claim again, at most a few times. Run-now: a Put of `AUTORUN#{runId}` alone, after `AUTOPOST.lastNowAt` moved on the condition
   that it is absent or ≥ 60 s old (else 409, §46.9).
   **Earlier stuck starts:** right after a live scheduled run claims (never while practising: nothing gets sent), and
   before it sends its own clips, it finishes the start of every clip an earlier scheduled run confirmed whose clip
   flow never started after all of that run's Lambda retries (`publishState: pending`, internal `autoRun` of another
   scheduled run, `status` `confirmed`/`publishing`/`posted`): each is read again and started with
   `release.start_flow` (Upload's own call), logging `autopost.finished_start` with `runId` and `clipId`; one that
   fails is logged (`autopost.finish_start_failed`) and skipped. One only starts while 30 s are left for it and for
   each of the run's own planned clips (30 s × (planned + 1)), so earlier clips never push its own into "Out of time.
   It goes next run."; earlier ones left over are finished by the next run.
4. **Send each planned clip** (`live` and `private`) through **Upload's own code**: `uploads.upload_review_clip(...)`,
   the review branch of `routes/clips.confirm` moved into one function the route now calls (Upload's behaviour,
   messages and tests unchanged), with `platforms` = its places, `options`, no `tiktok`, no caption patch, and
   `auto = {runId, at, test?}`. It writes `confirmed` and the posts in one transaction conditional on `status = review`
   and `attribute_not_exists(postsCreated)` (§14.5) and, only because `auto` is set, `attribute_not_exists(holdUntil)
   OR holdUntil < :now` (no live Throw away hold; Upload by hand ignores the hold), then starts
   `clip-{clipId}-{flowRun}`. A planned clip read with a live hold is not tried at all. Outcomes: `sent`; the
   condition failed → read the clip: its `autoRun` is this run → `sent` (and when its `publishState` is `pending`,
   finish the start, §14.5); another run's `autoRun` → `skipped` "Another auto-posting run sent it first."; else
   `skipped` with "You threw it away first." (`declined`, the clip is gone, or still in Review with a live hold),
   "You uploaded it yourself." (any other status), "It changed while it was being sent. It goes next run." (Upload's
   own race answer) or the campaign/fit refusal's sentence. `practice`: no write, outcome `would_send`.
5. Update `AUTORUN#{runId}`: `state: "done"`, each clip's `outcome`/`reason`. Out of time (`AUTOPOST_TIME_BUDGET_SECONDS`
   240, a new clip only starts with ≥ 30 s left) → the rest `skipped` "Out of time. It goes next run." (still in
   Review). Notes, in this order: a Private test with no normal clip taken → "Nothing in Review to test with."; no
   candidates (a held clip is none) → "Nothing in Review, so nothing posted."; no places → "Nothing is set up to post
   to."; candidates but none taken → "Every clip in Review is waiting for you.".
6. **The hourly Lambda** runs every owner; one owner's failure is logged (`autopost.owner_failed`) and the others still
   run, then the invocation fails, so Lambda's retry (the same event, the same slot) resumes that owner's run while
   every finished run answers `done`.

The clip flow then posts each place one after another (§17.6), so one place failing never stops the others.

### 46.8 Testing with nothing public

* **Practice** (`autoPost.practice`): scheduled runs plan, claim and record as usual and send nothing (`would_send`,
  and no earlier stuck start is finished, §46.7 step 3); clips stay in Review, so the next practice run picks the same
  ones (only they get a `runAt`, §46.5).
* **Practice run now** (`POST /v1/autopost/run {"kind": "practice"}`): one practice run now, inline in cf-prod-api.
* **Private test run** (`{"kind": "private"}`): one live run now, inline, of the first taken clip that is not a
  campaign clip (a campaign post would be sent to Content Rewards), with `auto.test = "private"`. Every post of it carries the internal `postOptions.test = "private"`, which only this run sets (no route
  body can: `post_preset.clip_options` keeps refusing unknown keys). Its places are the normal ones minus X (X has no
  private posts). Publishers:
  * YouTube: `privacyStatus: "private"` whatever the options say, `notifySubscribers=false`; url as usual (he can open
    it); `privacy: "private"`.
  * Facebook: the finish call sends `video_state=DRAFT`; marked posted with `privacy: "private"`, `platformPostId` =
    video id, no `url`, no `statsId`.
  * Instagram: the container is made, uploaded and checked to `FINISHED`; `media_publish` is never called; marked
    posted with `privacy: "private"`, no `url`, no `statsId`. (The unpublished container expires by itself.)
  * Private posts never join the stats poller (`mark_posted`: only public posts get `gsi2`, §16.3).
  The clip leaves Review and gets public `auto.test: "private"`; its posts public `test: "private"`.

### 46.9 API (`routes/autopost.py`, under `ANY /v1/{proxy+}`: no Terraform)

| Method & path | Body | 2xx |
|---|---|---|
| GET `/v1/autopost` | – | `AutoPostStatus` |
| POST `/v1/autopost/run` | `{ "kind": "practice" \| "private" }` | `{ "run": AutoRun }` |
| POST `/v1/clips/{clipId}/hold` (`routes/clips.py`) | none or `{}` | `{ "clip": Clip }` |
| DELETE `/v1/clips/{clipId}/hold` | – | 204 |

```ts
interface AutoPostSettings { on: boolean; everyHours: number; perRun: number; practice: boolean; onAt?: string }
interface AutoPostStatus {
  autoPost: AutoPostSettings;
  nextRunAt: string | null;               // null while off; the shown rule of §46.4
  perDay: number;                         // perRun * 24 / everyHours, not rounded
  places: Platform[];                     // a normal clip's places now (§46.6)
  leftOut: { platform: Platform; reason: "tiktok_yourself" | "not_set_up" }[];  // no TikTok while macPlaces has it
  macPlaces: Platform[];                  // §47: ["tiktok"] while Your Mac posts TikTok is on, else []
  nextUp: { clipId: string; jobId: string; hook: string; coverUrl?: string; runAt?: string }[];   // ≤ 10; §46.5
  waiting: { clipId: string; jobId: string; hook: string; coverUrl?: string; reason: string }[];  // ≤ 20
  runs: AutoRun[];                        // newest first, ≤ 10
  failed: { postId: string; clipId: string; hook: string; platform: Platform; error: string; at: string }[]; // ≤ 20
  tiktokYourself: { clipId: string; hook: string; coverUrl?: string }[];                          // ≤ 10
}
interface AutoRun {
  runId: string; at: string; kind: "scheduled" | "practice_now" | "private_now"; mode: "live" | "practice" | "private";
  state: "planned" | "done"; note?: string;
  clips: { clipId: string; hook: string; places: Platform[]; outcome?: "sent" | "would_send" | "skipped";
           reason?: string;
           posts: { platform: Platform; status: Post["status"]; url?: string; error?: string; test?: "private" }[] }[];
}
// Additions to existing shapes: Clip.auto?: { runId: string; at: string; test?: "private" };
// Post.auto?: true; Post.test?: "private"; Settings.autoPost (§46.3).
```
* `failed`: the owner's posts with `autoRun` and `status: "failed"`, newest first; `at` is the post's `createdAt`
  (the run's time: a post stores no failure time). `tiktokYourself`: clips with `auto`
  (not `test`) whose TikTok is not out for everyone (`tiktok_self` rules, §42.1); still served and still in the types
  and the mock, but the web no longer shows it (ADR-86, §46.2 item 7). `runs[].clips[].posts`: read by the
  clip's `postIds` (strongly consistent BatchGet).
* POST: unknown keys 400; `kind` missing or other → 400 "Pick practice or private.". A second run-now within 60 s →
  409 "A test run just started. Wait a minute." `private` with no taken clip → 200 with the run's note "Nothing in
  Review to test with." and no clips. Runs regardless of `on` (testing before switching on is the point).
* **Hold** (`POST /v1/clips/{clipId}/hold`, Throw away's tap, §46.2): on a clip with `status: "review"` (the
  update's condition) sets the internal `holdUntil = now + 24 h` (ISO, `clips.HOLD_FOR`: a day, so a decline that
  comes late, from a phone locked during the toast, still finds the clip held) and answers 200 `{"clip"}` (public
  shape: `holdUntil` never appears in it, or anywhere in the API). A second hold restarts the day. Unknown body keys
  → 400 "Unknown field: {key}." (no body, or `{}`, is fine). A clip not in Review → 409 "Auto-posting already sent
  this clip." when it has the internal `autoRun` (a run, or a Private test run, sent it), else 409 "This clip has
  already been uploaded or thrown away." (Upload's `ALREADY_DECIDED`). Not the caller's clip → 404 "We could not find
  that clip." as every clip route.
* **Undo** (`DELETE /v1/clips/{clipId}/hold`): removes `holdUntil`; 204 every time (safe to repeat, and never refused
  because the clip moved on: uploaded, declined or sent); 404 only when the clip is not the caller's.
* Neither changes `status`: the decline (`POST …/decline`) is still what throws the clip away. Upload
  (`POST …/confirm`) ignores the hold. Both write the clip item, so its live clip event (§14.2, still `review`, no
  `holdUntil`) arrives: the app keeps a clip it is throwing away hidden until its toast ends or Undo.
* Mock mode (`web/src/api/mock/autopost.ts`) follows the same rules, with a fake clock the e2e tests can move: the
  two hold routes, a held clip skipped by the pick and its run (outcome "You threw it away first."), and the shown
  `nextRunAt` and `runAt` rules of §46.4 and §46.5.

### 46.10 Data (additive: new sort keys and attributes only)

| Item | pk | sk | Attributes |
|---|---|---|---|
| Auto-post state | `USER#{userId}` | `AUTOPOST` | `type="autopost"`, `lastRunAt?`, `lastRunId?`, `lastNowAt?`, `lastTickAt?` (the last slot a tick found not due, §46.4) |
| Run | `USER#{userId}` | `AUTORUN#{runId}` | `type="autorun"`, `runId`, `at` (the slot), `plannedAt` (when it planned; rule 5 counts from it), `kind`, `mode`, `state`, `clips`, `note?`, `ttl` (180 days) |
| Owner registry | `AUTOPOSTOWNERS` | `USER#{userId}` | `type="autopostowner"`, `userId`, `since` |
| Clip | (as §6) | | `autoRun`, `autoAt`, `autoTest?` (internal; public `auto`), `holdUntil?` (internal: Throw away's hold, §46.9) |
| Post | (as §6) | | `autoRun` (internal; public `auto: true`), `postOptions.test?` (internal; public `test`) |

Runs are listed with a `Query` of `AUTORUN#` (newest first, `ScanIndexForward=false`, limit 10). Nothing here is ever
deleted except by TTL (`holdUntil` is removed by Undo, or simply ends). Runs stored before `plannedAt` read their `at`
instead.

**Settings saves never undo each other.** `PUT /v1/settings` reads the stored item, merges the patch, and puts it on
the condition that its `updatedAt` is still the one read (`attribute_not_exists(pk) OR updatedAt = :old`, or
`attribute_not_exists(updatedAt)` when it had none; each save's `updatedAt` is later than the one it replaces, even in
the same millisecond). A failed condition reads it again and merges the same patch, at most 3 times, then 409 "Your
settings just changed. Try again.", so a save that began before the owner turned auto-posting off can never turn it
back on. `onAt` and the `AUTOPOSTOWNERS` registry work as in §46.3.

### 46.11 Lambda and Terraform (new module `infra/modules/autopost`, wired in `envs/prod`)

* `cf-prod-autopost`: the shared zip, `clipfactory_api.autopost.handler.handler`, python3.13 arm64, 256 MB, timeout
  300 s, X-Ray, JSON logs to `/aws/lambda/cf-prod-autopost` (retention as the others). Env: `TABLE_NAME`,
  `MEDIA_BUCKET`, `CLIP_FLOW_ARN` (the clip flow's `live` alias), `SECRET_PREFIX`, `CONTENT_REWARDS`, `CR_REMAKE`
  (cf-prod-api's switch, so a fit refusal reads the same words), `AUTOPOST_TIME_BUDGET_SECONDS=240`. Event: EventBridge (`source == "aws.events"`) → every owner in `AUTOPOSTOWNERS`
  (one Query), `run_once(..., "scheduled", slot)`, one owner's failure logged and skipped.
* Role `cf-prod-fn-autopost` with the deploy boundary, exactly what the code calls: DynamoDB `GetItem`, `PutItem`,
  `UpdateItem`, `Query`, `BatchGetItem`, `TransactWriteItems`, `ConditionCheckItem` on the table and `index/*` (never
  `DeleteItem` or `Scan`); `lambda:InvokeFunction` on `${clip_flow_arn_prefix}:*` (start executions on the alias).
  No Secrets Manager (the campaign fit check reads only the table; `SECRET_PREFIX` only builds its deps) and no S3 (a
  run reads no files and signs no links), nothing else. Logs and X-Ray as the money module.
* `aws_lambda_function_event_invoke_config`: `maximum_retry_attempts = 2`, `maximum_event_age_in_seconds = 3300`
  (before the next tick); a retry is the same event, so it resumes its own run (§46.7 step 3).
* `aws_cloudwatch_event_rule` `${name}-autopost-hourly` `cron(0 * * * ? *)` ENABLED, its target (unqualified ARN,
  `retry_policy { maximum_event_age_in_seconds = 3300, maximum_retry_attempts = 2 }`) and `aws_lambda_permission`
  (`events.amazonaws.com`, the rule's ARN).
* The rule's own alarm `${name}-autopost-hourly-failed-invocations` (in the module, on `alarm_topic_arn`: two failed
  ticks in a row; monitoring's 15-minute schedule alarm can't fire for a rule that runs once an hour).
* `envs/prod/main.tf`: `module "autopost"` (inputs from `module.data`, `module.storage`, `module.flows`,
  `module.hooks`, `module.monitoring.alarm_topic_arn`, `var.content_rewards_enabled`, `var.cr_remake_enabled`, the
  boundary); monitoring gets `module.autopost.function_names` (its errors alarm). Both alarms are new, additive.
* **Not changed:** cf-prod-api's function, role and policy (run-now runs inline with Upload's existing grants), the
  table, every existing rule and alarm. The plan adds only `module.autopost.*` and the two new alarms; 0 to destroy.
  `scripts/check-plan-clips-unchanged.sh` has nothing to report.
* `infra/modules/autopost/tests/autopost.tftest.hcl`: names, the cron, ENABLED, retries 2 / age 3300, the target is
  the function, the permission's source is the rule, the role carries the boundary, no `DeleteItem`/`Scan`/`iam:*`/
  `scheduler:*`, the invoke grant is only the clip flow.

### 46.12 Words

As written in §46.2 and §46.5 to §46.9. "Auto-posting" (one word, hyphenated) everywhere; "Throw away", "Upload", "Try
again" keep their meaning; TikTok's line has **Turn on** (ADR-86: no Post it yourself). Ask (§19, §28) learns it
from this section and the help guide
"Turn on auto-posting" (`helpKb.json`): where the page is, what each control does, why TikTok and campaign clips wait,
how to test with Practice and the Private test run.

### 46.13 Edge cases

* He throws a clip away before its turn: the hold lands at the tap (§46.9), before the 8 s Undo toast ends and the
  decline goes, so no run picks or sends it meanwhile; if a run had planned it a moment before, the run sees the hold
  (or its conditional write fails on it) and the outcome is "You threw it away first."; Undo lifts the hold and the
  clip keeps its place. The hold lasts a day, so a decline that comes late (the phone was locked during the toast)
  still finds the clip held. If a run already sent it, the hold answers 409 and he is told "Auto-posting already sent
  this clip." (the clip is not thrown away).
* A tick that finds the slot not due marks it (`lastTickAt`), so a lower `everyHours` saved later that hour shows the
  next full hour, not a run that already passed (§46.4).
* A clip a run confirmed whose clip-flow start failed through every Lambda retry is started by the next live run
  (§46.7 step 3).
* Two settings saves at once (two tabs, or a slow save and the switch): the later one re-reads and merges, so neither
  undoes the other (§46.10).
* He taps Upload on a clip a run planned at the same instant: one transaction wins; the other side sees it taken.
* Two deliveries of one tick, or a retry after a crash: the same `runId`; the second resumes the first's plan.
* A tick that arrives late inside its hour still has its own slot; a tick lost entirely is caught up by the next one
  (one run, never two).
* A place fails at 3 a.m.: its post is `failed` with the plain sentence, shows in Didn't work and in Library with Try
  again; the other places of that clip post.
* He turns it off while a run is sending: clips already handed to the clip flow keep posting (like Upload); no new run
  starts.
* A place connected later gets only clips from later runs.

### 46.14 Not verified live

That Facebook keeps a `video_state=DRAFT` Reel hidden from everyone but Page admins and shows it under the Page's
drafts; that EventBridge's hourly cron fires within the first minute of the hour; checked at the first private test
run and the first hours of practice.

### 46.15 Tests (offline, fakes only)

* `api/tests/test_autopost_schedule.py`: every `everyHours` 1..24 over 10 days from several `onAt` minutes gives runs
  exactly `everyHours` apart, across midnight and month ends; switching on, changing `everyHours` (up and down), off and
  on again, practice; a late tick and a lost tick; `nextRunAt` shown: at 13:00:20 before the claim (13:00), after the
  claim, after lowering `everyHours` at 13:20 once the 13:00 tick marked `lastTickAt` (14:00), past the event age
  (14:00); `TICK_EVENT_AGE` equals both of Terraform's `maximum_event_age_in_seconds`.
* `test_autopost_run.py`: oldest first by job then rank; each waiting rule and its sentence; `perRun`; places (TikTok
  never, X only when ready, nothing set up); My settings options (never made for kids) and the campaign versions;
  nothing in Review does nothing but moves `lastRunAt`; off and not due; the same event twice, two overlapping
  invocations, a crash after the claim and its retry: every clip confirmed once and its flow started once; a clip
  thrown away or uploaded by hand after planning; out of time; one owner failing does not stop another; a not-due tick
  writes only `lastTickAt`; a late run (planned 16 min after its slot) still protects its clips from a Private test
  run (`plannedAt`); an earlier run's start that failed every retry is finished by the next live run (logged), one
  that fails again is logged and skipped, practice leaves it alone, earlier starts leave the time for the run's own
  clips (the rest are finished by the next run).
* `test_autopost_hold.py`: the hold and Undo routes (24 h, 200/204, 400 unknown keys, 404 another owner's, 409 with
  each sentence, `holdUntil` never public), a held clip skipped by the pick, Next up and a Private test run while the
  next clip takes its turn, a run inside the Undo toast, a hold after the plan (never even tried) and at the same
  instant as the run's write ("You threw it away first."), a hold that ended, Upload by hand ignoring it, a decline
  that comes hours late still finding the clip held, a run whose only clip is held ("Nothing in Review, so nothing
  posted.").
* `test_autopost_routes.py`: settings validation and `onAt`, the registry write, a save that loaded before auto-posting
  went off never turns it back on (and 409 after 3 lost races), `GET /v1/autopost` (each list, the `runAt`s: none
  with nothing set up, only the first `perRun` while practising; the shown `nextRunAt` before and after the claim and
  after a not-due tick), run-now practice and private, the 60 s limit, private with nothing.
* `test_autopost_private.py`: the three publishers' test behaviour, that only `postOptions.test` turns it on, that
  Upload's `options` can't set it, no `gsi2`.
* `test_flows.py` `test_one_place_failing_never_stops_the_others`: YouTube fails all 3 tries, Instagram and Facebook
  still post with their links, YouTube keeps its error, and the clip is `posted`.
* Upload's existing tests (`test_upload_to.py`, `test_campaign_posting.py`, `test_clips.py`, `test_release.py`) pass
  unchanged after the refactor.
* Web: `web/test/autopost.test.ts` (the result line for every pair 1..5 × 1..24, the warnings, time words, the
  left-out lines with TikTok's "turn on Your Mac posts TikTok" words, the mock's rules), `web/e2e/autopost.spec.ts`
  (switch, both controls save, result line and warning, Where they go with TikTok's **Turn on**, Next up with Throw
  away and Undo, Didn't work Try again, no `#auto-post-tiktok`, Recent, Practice run now, Private test run, the Review
  line and the Home hint; at 390×844 and 1440×900; and, at 1440×900, Where they go saying "TikTok: your Mac posts it."
  once the switch is on through **Turn on**).
* Infra: `autopost.tftest.hcl` (§46.11); `scripts/test-check-plan-deletes.sh` unchanged.

### 46.16 Who builds what (parallel builders; each stays inside its files)

* **S (server)**: `api/src/clipfactory_api/autopost/**` (new: `__init__.py`, `schedule.py`, `pick.py`, `run.py`,
  `handler.py`), `uploads.py` (new, the moved Upload core), `routes/clips.py` (and the hold routes),
  `routes/autopost.py` (new), the route table, `settings.py` and `routes/system.py` (the conditional save), `db.py`
  (an update's extra condition), `post_preset.py`, `posts.py`, `clips.py` (public `auto`, the hold),
  `platforms/{youtube,facebook,instagram}.py` (private test), `api/tests/test_autopost_*.py`,
  `api/scripts/build_lambda.py` if handlers are listed.
* **I (infra)**: `infra/modules/autopost/**` (new), `infra/envs/prod/main.tf`.
* **W (web)**: `web/src/screens/settings/AutoPostBranch.tsx` (new), `Settings.tsx`, `branches.tsx`, `web/src/lib/
  autopost.ts` (new), `web/src/api/**` (types, client, `mock/autopost.ts`, the hold routes), Throw away's hold and
  Undo (Next up and the Review card), Review's line, `NewJobForm.tsx`, Library's post-row words,
  `web/test/autopost.test.ts`, `web/e2e/autopost.spec.ts`.
* **D (docs and help)**: `docs/BUSINESS_REQUIREMENTS.md`, `ARCHITECTURE.md`, `TESTING.md`, `SECURITY.md`,
  `DEPLOYMENT.md` (nothing to do by hand), `ROADMAP.md`, `web/src/features/help/helpKb.json` (the guide); then the
  generated help corpus and Ask knowledge are regenerated once everything is merged.
