# Clip Factory TikTok helper (Mac)

The owner asked for this on 22 Nov 2026: "everytime the clip factory wants upload to all platforms it saves the video
to my downloads and then goes into tiktok and uploads it there for me, then deletes the video from downloads". He also
wants the same when he taps **Upload** with TikTok ticked. Contract: `docs/CONTRACTS.md` §47.

Clip Factory can't post publicly to TikTok through TikTok's API until TikTok approves the app (§42). So the cloud
marks the clip's TikTok post "waiting for your Mac", and this helper posts it from the owner's Mac.

## What it does

launchd runs `src/cli.js run` every minute. Each run:
1. Signs in to Clip Factory, checks in (`POST /v1/tiktok/mac/ping`) and reads the queue (`GET /v1/tiktok/mac`).
2. Takes at most one clip, and claims it on the server first (a conditional write: one Mac, one try).
3. Saves the video to `~/Downloads`.
4. Opens TikTok Studio's upload page in **its own Chrome profile**. Chrome starts hidden in the background
   (`open -g -j`) with its window off-screen, so the owner's screen, mouse, keyboard, Safari and everyday Chrome are
   never touched.
5. Types the caption, sets "Who can watch this video" (Everyone) and switches Comment, Duet and Stitch on.
6. Reads every setting back, records "pressing" on disk and on the server, and only then presses Post.
7. Confirms the post by a new row with this caption in Studio › Posts and sends the link (`…/tiktok/mac/done`).
8. Deletes the video from Downloads (after every try, successful or not) and quits Chrome.

## Never twice

- The server's claim is the first lock: once a try has pressed Post, the post is never claimed again.
- The ledger in `state.json` (written before the click) is the second. After a crash once Post was pressed, the
  helper only looks for the post in Studio › Posts; after 30 minutes without it, it asks the owner.
- Before uploading, it looks for the same caption in Studio › Posts, in case it was already posted.
- `run.lock` keeps it to one run at a time.

## Stops instead of guessing

It stops on any of these: a login page, a puzzle or code check, "Something went wrong", "Content may be restricted",
an unknown pop-up, a setting that didn't stick, or a timeout. It never solves puzzles, types passwords or uses
anti-detection tricks.

On a stop:
- The clip's TikTok row says why, with Try again and Post it yourself instead.
- A Mac notification appears and a line goes to `events.log`.
- A login or check puts the helper in "needs you" and pauses everything until he taps Try again.

## Pace and trial

- At most one post every 30 minutes (5 after an Upload he tapped himself).
- The owner's trial: it pauses after 3 posts (`settings.json` `trialLimit`) until their views are checked. To lift
  it: `node src/cli.js trial none`.

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
