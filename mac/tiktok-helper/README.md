# Clip Factory TikTok helper (Mac)

The owner asked for this on 22 Nov 2026: "everytime the clip factory wants upload to all platforms it saves the video
to my downloads and then goes into tiktok and uploads it there for me, then deletes the video from downloads". He also
wants the same when he taps **Upload** with TikTok ticked. Contract: `docs/CONTRACTS.md` §47.

Clip Factory can't post publicly to TikTok through TikTok's API until TikTok approves the app (§42). So the cloud
marks the clip's TikTok post "waiting for your Mac", and this helper posts it from the owner's Mac.

## What it does

Every minute, launchd runs `src/cli.js run`, which:

1. Signs in to Clip Factory, reads the queue (`GET /v1/tiktok/mac`), carries out the owner's requests from the app
   (see "From the app") and checks in (`POST /v1/tiktok/mac/ping`, see "What the ping reports").
2. Takes at most one clip, claiming it on the server first. The claim is a conditional write, so only one Mac can try
   at a time. From the claim until it is done with the clip, the helper beats it (see "The beat").
3. Saves the video to `~/Downloads`.
4. Opens TikTok Studio's upload page in **its own Chrome profile, headless**. Chrome is spawned directly, in new
   headless mode, so there's no window on screen, no Dock icon, no Cmd-Tab entry, and it never takes the owner's
   focus. To TikTok it looks like the visible Chrome: user agent and client hints without "HeadlessChrome", the Mac's
   screen size, pixel ratio 2. Chrome's notifications are off. All input goes through CDP (Input.dispatch\*,
   DOM.setFileInputFiles); no OS mouse, keyboard or file dialog is used.
5. Types the caption, sets "Who can see this post" (Everyone), and switches Comment and Reuse of content (Duet and
   Stitch) on. Audience control stays off.
6. Reads every setting back. Then it records "pressing" on disk and on the server, and only then presses Post.
7. Confirms the post by finding a new row with this caption in Studio › Posts, and sends its link
   (`…/tiktok/mac/done`).
8. Deletes only the video it saved itself for that post, and only after the link was found. A failed try keeps the
   video for the retry. It then quits Chrome.

**Nothing shows on the owner's screen** in a normal run: no frame, no notification, no sound. Results go to the clip's
row in Clip Factory and to `events.log`. Only the owner's own turn shows the yellow frame and one pop-up, with a
visible login window. That covers a TikTok code, a puzzle, a login the Keychain can't do, or the Clip Factory sign-in.

## Never twice

- The server's claim is the first lock: once a try has pressed Post (`pressedAt`), the post is never claimed again.
- The ledger in `state.json` (written before the click) is the second. After a crash once Post was pressed, the
  helper only looks for the post in Studio › Posts. That is the 30-minute find window (`FIND_FOR_MS` in
  `src/plan.js`, the server's `MAC_FIND_WINDOW`): after 30 minutes without it, it asks the owner.
- A job with `pressedAt` is never posted or resumed, whatever its state; it is only looked for.
- The owner's Try again on a pressed post moves `pressedAt` to `pressedBefore` and sets `againAt`. The helper posts
  such a job only when `againAt` is at least 30 minutes after `pressedBefore` (after the find window). Otherwise it
  skips it, never claims it, and logs `never_twice.skip`. The server refuses a Try again inside the window anyway.
- A fresh claim forgets the last try's press, baseline and beat step in the ledger.
- Before uploading, it looks for the same caption in Studio › Posts, in case it was already posted.
- `run.lock` keeps it to one run at a time.

## The beat

Clip Factory calls a Mac post stuck once its own beat (`macBeatAt`) is 5 minutes old (`MAC_BEAT_STALE`), or once its
claim is 50 minutes old. Only then does the row offer It's on TikTok, and Try again once the find window is over. So:
- While it posts a clip, the helper re-sends every minute (`BEAT_EVERY_MS`) the last step the server took for it
  (`ledger.sentStep`), with the job's attempt. A re-sent step is the beat.
- This Mac's other pressed posts in the queue, which it still looks for, get the same beat with `finding`.
- A look for a pressed post (doFind) first puts up the frame (no beat while it can't look), then sends a `finding`
  beat for that post and for every other pressed post of this Mac, and keeps beating them every minute while it looks
  (a login can take 20 minutes). A 409 on the post it looks for means it isn't this try's any more, so it isn't looked
  for this tick.
- Clip Factory counts beats only from a helper of version 1.1.0 or later (`MAC_BEATS_FROM`). For an older helper on
  the Mac only the 50-minute claim counts, and Start my Mac again isn't offered. After merging, run `./install.sh`
  again so the Mac runs this version.
- A beat never overlaps a step for the same job. Beat errors go to `helper.log` (`beat.failed`) and never stop the
  tick. A 409 on the beat of the clip being posted stops its next step, so Post is never pressed without the server's
  yes.
- No beats while the helper is idle, waiting or paused. Then the post really is stuck, and its row says so.

## Logging back in

The owner's TikTok login can be kept in the login Keychain (`node src/cli.js login`: "Email for TikTok", then the
password, kept only in the Keychain and never logged or sent anywhere). When TikTok logs the helper out, the helper
logs back in with it, at most twice in 24 hours, and never again after TikTok refuses it. Clip Factory's Settings ›
Posting › Your Mac posts TikTok has Change TikTok login and Forget TikTok login.

## Stops instead of guessing

It stops on any of these: a login page, a puzzle or code check, "Something went wrong", "Content may be restricted",
an unknown pop-up, a setting that didn't stick, or a timeout. It never solves puzzles, types passwords or uses
anti-detection tricks.

On a stop:
- The clip's TikTok row says why, with Try again (and It's on TikTok once Post was pressed). Every reason says what
  the owner can tap now.
- A line goes to `events.log` (no notification: nothing on his screen unless he's needed).
- A login or check the Keychain can't solve is his turn (yellow frame, one pop-up). If he isn't there within 20
  minutes, the helper is in "needs you" and pauses everything until he taps Try again.

## When it posts

The owner set this on 22 Nov: TikTok follows auto-posting, and his own Upload goes at once.
- A clip he uploads ("Upload to 4" with TikTok ticked) goes at once, ahead of everything else.
- An auto-posting run's own clips go at once, a minute apart.
- At most one backlog clip ("Send these to my Mac", oldest first) goes about 30 minutes after each auto-posting run,
  until the backlog is empty. That is 30 minutes after the last run if that run's slot is unused (at once if that
  time has passed), otherwise 30 minutes after the next run. With auto-posting off, the backlog waits. The ping
  reports this time (`backlogAt`, from `backlogAt()` in `src/plan.js`, the same rule the helper waits for).
- The trial (`settings.json` `trialLimit`) is lifted: `node src/cli.js trial none`. Start my Mac again in Clip
  Factory lifts it too when the trial pause is what holds the Mac.

## One-time backfill and batches

`node src/cli.js backfill on|burst|off` sets a one-time pace for the backlog ("Send these to my Mac" clips).
It switches itself off once the backlog is empty; then the rule in "When it posts" applies again.
- `on`: one every 2 hours, never within an hour of a run or an Upload, at most 7 backfill posts and 11 posts in all
  in any 24 hours. The 24-hour cap only counts posts already made, so jittery run times can reach 12 (review, 22 Nov).
- `burst`: back to back. Used on 22 Nov for the owner's "upload all videos ... right away". Any stop halts the whole
  batch (`paused`; Start my Mac again in Clip Factory, or `cli.js on`, resumes it).

`settings.json` `holdAutoBefore` (ISO time) holds auto-posting clips made before that time (used on 22 Nov when a
one-off Review run was stopped). Uploads and later runs post as usual. Let them go in Clip Factory lifts the hold.

## From the app

Clip Factory's Settings › Posting › Your Mac posts TikTok (and the paused rows) can ask this Mac for two things. The
helper reads them in `GET /v1/tiktok/mac` at its next tick, before it decides anything:
- **Start my Mac again** (`helper.resumeRequest`): `paused` becomes false in `settings.json`, and `trialLimit` becomes
  none when the trial pause is what holds it. Event `resumed`. It never clears "needs you": only the owner's Try again
  or It's on TikTok on the stopped clip does that.
- **Let them go** (`helper.letGoRequest`): `holdAutoBefore` is cleared. Event `hold_released`.

The ping then sends `resumeDone` / `letGoDone` (the request's time), which clears the request on the server.

## What the ping reports

Each tick's ping (`POST /v1/tiktok/mac/ping`) sends `state` (`ok`, `paused` or `needs_you`), `reason`, `version`,
`device` and `login`, plus, only when set:
- `backlogAt`: when the first backlog clip goes (see "When it posts"). Not sent during a backfill.
- `holdBefore`: the `holdAutoBefore` time, so rows held by it say "Held on your Mac".
- `backfill: true`: during a backfill; then backlog rows say "in line" with no time.
- `loginDone`, `resumeDone`, `letGoDone`: a request from the app that was carried out.

A Clip Factory that doesn't know these fields answers 400; the helper then checks in with `state`, `reason`,
`version` and `device` only.

Captions are typed line by line, with any hashtag or mention list closed before a new line, and retyped once more
slowly if the read-back is off. The video goes into TikTok's upload box by its path on the Mac
(CDP DOM.setFileInputFiles), so a large file is as quick as a small one.

## Off switch

- **Clip Factory › Settings › Posting › Your Mac posts TikTok**: the switch. Off = nothing is handed to the Mac, and
  the helper does nothing.
- On this Mac only: `node src/cli.js off` (and `on`).
- Remove it: `./uninstall.sh` (keeps the TikTok login), or `./uninstall.sh --all`.

## Setup (the owner's own steps, on his command)

```
./install.sh --no-start
node "$HOME/Library/Application Support/Clip Factory TikTok/app/src/cli.js" setup
./install.sh
```

`setup` shows the helper's Chrome window, the only time it is shown. In it he logs in to TikTok (the phone's QR code
is easiest) and signs in to Clip Factory. The helper keeps that Clip Factory sign-in in the login keychain
("Clip Factory TikTok helper") and refreshes it itself.

## Files

`~/Library/Application Support/Clip Factory TikTok/` holds:
- `chrome/`: the profile with the TikTok login;
- `state.json`;
- `settings.json`;
- `helper.log`;
- `events.log`;
- `app/`: the installed copy.

The launchd job is `~/Library/LaunchAgents/com.clipfactory.tiktok-helper.plist`.

## Risks the owner accepted (22 Nov 2026)

- TikTok's Community Guidelines: "We strictly prohibit automation tools, scripts, or other tricks designed to bypass
  our systems." There is no own-account exception.
- Reports say script-posted web uploads sometimes get close to 0 views.
- Sources: side-session note `tiktok-mac-automation-research.md`.
