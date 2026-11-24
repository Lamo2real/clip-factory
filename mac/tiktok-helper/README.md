# Clip Factory TikTok helper (Mac)

The owner asked for this on 22 Nov 2026: "everytime the clip factory wants upload to all platforms it saves the video
to my downloads and then goes into tiktok and uploads it there for me, then deletes the video from downloads". He also
wants the same when he taps **Upload** with TikTok ticked. Contract: `docs/CONTRACTS.md` §47.

Clip Factory can't post publicly to TikTok through TikTok's API until TikTok approves the app (§42). So the cloud
marks the clip's TikTok post "waiting for your Mac", and this helper posts it from the owner's Mac.

On 23 Nov 2026 the owner asked for the same in Clips Funded: "btw i want the same way we upload to tiktok in clip
factory for clips funded". Since 1.2.0 the helper also posts Clips Funded's TikTok jobs, to @clips.funded only
(§47.10, "Clips Funded" below).

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

1.2.2 (§47.11): when a stop was only a TikTok login problem, the helper looks every 5 minutes (headless, nothing on
screen) and right after `setup`; once that lane's Chrome reads exactly its own account, "Your Mac needs you" ends and
the stopped clip carries on by itself (never another account, never a second press: a clip whose Post was pressed
stays for the owner).

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
- Remove it: `./uninstall.sh` (keeps the TikTok logins), or `./uninstall.sh --all` (also every profile and the
  keychain items).

## Setup (the owner's own steps, on his command)

```
./install.sh --no-start
node "$HOME/Library/Application Support/Clip Factory TikTok/app/src/cli.js" setup
./install.sh
```

Clip Factory's Settings › Posting › Your Mac posts TikTok shows these same three steps while the Mac has never
checked in (`MAC_SETUP_STEPS` in `web/src/screens/settings/TikTokMacBranch.tsx`), so that page is never a dead end.
Change both together.

`setup` shows the helper's Chrome window, the only time it is shown. In it he logs in to TikTok (the phone's QR code
is easiest) and signs in to Clip Factory. The helper keeps that Clip Factory sign-in in the login keychain
("Clip Factory TikTok helper") and refreshes it itself: since 1.2.1 every call gets a fresh access token when it needs
one (they last 15 minutes, a login wait up to 20), so the stop after a long wait still reaches Clip Factory. `setup`
waits for a running tick and holds `run.lock`, so a tick never touches the window.

## Clips Funded (1.2.0, §47.10)

Clips Funded's Review › Post it (and Try again) hands its TikTok job to this Mac while Clips Funded › Social accounts
› TikTok › **My Mac posts TikTok** is on. The helper posts it the way it posts Clip Factory's clips: hidden headless
Chrome, the same claim, beats, never-twice rule, 30-minute find window, row states and "your Mac needs you". The
differences:

- **Lanes.** Clip Factory's lane (`clips`) is 1.1.0's: `chrome/`, port 9339, its Keychain login, the top-level
  ledger, pacing, trial and backfill. Each Clips Funded workspace has a lane `ws:{id}`: its own profile
  `chrome-ws-{id}/`, its own port (the lowest free of 9340–9349, kept in `state.json`), its own ledger and pacing in
  `state.ws[id]`, its own needs-you, and no Keychain login. Only one helper Chrome runs at a time.
- **Clip Factory first.** Each tick Clip Factory's lane decides and checks in first, as in 1.1.0. Then each
  Clips Funded lane reads `GET /v1/workspaces/{ws}/tiktok/mac?version=1.2.0` and checks in
  (`POST …/tiktok/mac/ping`: `state`, `reason`, `version`, `device`, `setUp`, `handle`, `loginDone`, `resumeDone`). A
  Clips Funded post, look or login happens only in a tick where Clip Factory's lane has nothing to post, resume or look
  for; meanwhile its pressed posts still get their "finding" beat. Its errors go to `helper.log` (`ws.error`) and
  never reach Clip Factory's lane.
- **Start my Mac again** in Clips Funded (a paused Mac) ends this Mac's pause, the same one Clip Factory's button
  ends (`settings.paused`, every lane's); the ping's `resumeDone` clears the request.
- **The right account, every time (both lanes).** Before Studio › Posts is read, right before Post, before every
  look for a link, and on the link itself, the helper reads which TikTok its Chrome is logged in to (`src/whoami.js`)
  and refuses unless it is the target: @lamo.clips for Clip Factory (`GET /v1/accounts`' TikTok; when that has no
  @name, the account of the helper's own Clip Factory posts in `state.json`, so a 1.1.0 Mac goes on as it did), the
  job's `account.handle` for Clips Funded. Another account: "Your Mac is logged in to TikTok as …, not …" and
  needs-you; unreadable: a plain stop (a Studio row's link on another @name, while the account's own data reads the
  target, is unreadable, not another account). Nothing is posted either way. Each lane also refuses every other
  lane's account by handle and uid: a Clips Funded job never goes to Clip Factory's account, and a Clip Factory clip
  never goes to a Clips Funded account (if Clip Factory's TikTok in Settings ever becomes @clips.funded, its clips
  stop with "That TikTok account is your other workspace's…" and needs-you). A Clips Funded lane is never set up as
  Clip Factory's account. With no account known at all, Clip Factory's ping says paused, with why.
- **AI label.** Every Clips Funded post turns on TikTok Studio's "AI-generated content" switch and reads it back
  (again right before Post), or it doesn't post. "Disclose post content" stays off. Clip Factory's posts never touch
  either switch.
- **Fixed public defaults.** Everyone, Comments on, Reuse of content (Duet and Stitch) on, Audience control off,
  whatever the job says.
- **No caption matching with older posts.** A Clips Funded lane relies on the server's never-twice rule and the
  baseline saved at pressing, never on an older post with a similar caption. One exception: a post the owner tried
  again after a press ("Post it again? Only if it's not on your TikTok") first looks for a row with its caption that
  is new since that first press (the Only me copy and older stories were there before it); if one is there, that
  link is taken and nothing is posted again.
- **Files.** Its videos are saved as `clips-funded-….mp4` in Downloads and deleted once the post's link is found
  (or once `GET …/publishing` shows the job posted).
- **Login: no password anywhere.** The owner taps **Log in on my Mac** in Clips Funded. If the lane's profile already
  reads @clips.funded nothing opens. Otherwise the lane's old cookies are cleared first (a session TikTok ended on its
  side would read as a login at once), then a TikTok window opens on the Mac at the QR code (yellow frame, one
  pop-up: "Log in to TikTok as @clips.funded in the window. Scan the code with the TikTok app."). The window's
  profile never saves a password and never signs Chrome in (its Preferences: password saving, auto sign-in, autofill
  and browser sign-in off; `--disable-sync`); any Google cookies leave the profile once TikTok's login is in. The
  helper never attaches to that window's page; it only watches for TikTok's session cookie (never its value), closes
  the window, and reads the handle in the hidden Chrome. Another account is wiped from that profile and the window
  opens once more. After 20 minutes without a login the window closes. Until the lane reads @clips.funded, new posts
  wait ("Your Mac isn't set up yet" on the row). A post that finds TikTok logged out opens the same window once, then
  stops with "TikTok logged your Mac out. Tap Log in on my Mac." A lane that can't read any account three times
  (a TikTok cookie but no account) is no longer set up and stops with "… Tap Log in on my Mac." That login window,
  inside a post, holds the tick: Clip Factory's next clip can wait up to about 40 minutes (20 for the window, then
  the upload and the look for the link).
- **Events** carry `account` (`clips` or `ws:{id}`); new kinds `wrong_account` and `login_window`.

### The owner's one-time step (after merge and deploy, on his command)

1. Update the helper, from a main checkout:
   ```
   cd mac/tiktok-helper && ./install.sh --no-start
   node "$HOME/Library/Application Support/Clip Factory TikTok/app/src/cli.js" whoami
   ```
   It must print `"loggedInAs": ["@lamo.clips"]` and `"matches": true`. If not, nothing is started: reinstall
   1.1.0 from the previous main commit. Then `./install.sh`.
2. In Clips Funded › Social accounts › TikTok: turn on **My Mac posts TikTok**, then tap **Log in on my Mac**.
3. A TikTok window opens on the Mac with a code. On the phone: TikTok app → switch to @clips.funded (add it once
   with Continue with Google, his Google account, if it isn't there yet) → scan the code → Log in. The window closes
   by itself and the card says "logged in as @clips.funded". Use the code, not Google in the window: nothing is typed
   on the Mac then.
4. Optional check, which posts nothing:
   `node ".../cli.js" probe --workspace stories --story <an approved story>`. It fills in TikTok Studio, AI label
   included, stops before Post and saves `probe-ws-stories.png`.

`node ".../cli.js" setup --workspace stories` opens the same login window from the Mac. `whoami --workspace stories`
prints which TikTok that lane is logged in to. `status` shows every lane.

TikTok may link two automated accounts on one Mac and network, so an automation flag could hit both. The owner
accepted the automation risk for @lamo.clips on 22 Nov; this adds @clips.funded.

## Files

`~/Library/Application Support/Clip Factory TikTok/` holds:
- `chrome/`: Clip Factory's profile with the @lamo.clips TikTok login;
- `chrome-ws-{workspaceId}/` (1.2.0): one profile per Clips Funded workspace, with its own TikTok login
  (`chrome-ws-stories/` for @clips.funded);
- `state.json` (Clips Funded's lanes are in `ws`, Clip Factory's account in `clipsAccount`; nothing older moved);
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
