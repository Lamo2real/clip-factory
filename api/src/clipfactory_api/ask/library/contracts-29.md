## 29. YouTube downloads that hold up (owner request, 2026-11-19)

### 29.1 The owner's words

A 1 h 41 min YouTube job failed at **Find the video** ("YouTube is blocking downloads from the cloud and your cookies
did not help") although he had added cookies.txt; a retry got past it and failed at **Cut the clips**. He wants
YouTube jobs to download, with no technical steps for him. ADR-52 has the reasons.

### 29.2 The PO token sidecar

- The agent image carries `bgutil-ytdlp-pot-provider==2.0.2` (the yt-dlp plugin, `agent/pyproject.toml`) and its
  server built from the same tag (`agent/Dockerfile`, stage `pot`, tarball pinned by sha256). The two are bumped
  together.
- `pot.py` runs the server with the image's Deno: `deno run --allow-env --allow-net --allow-ffi=<home>/node_modules
  --allow-read=<home>/node_modules <home>/src/main.ts --host 127.0.0.1 --port 4416`. Loopback only; no write
  permission. It starts in the app's lifespan and is restarted with a doubling pause (1 s to 60 s) when it exits
  (`pot.exit` log line).
- Before a YouTube `-J` the agent waits up to 10 s for `GET /ping`. While the server is down yt-dlp uses the plugin's
  script mode (`youtubepot-bgutilscript:server_home=$CF_POT_HOME`), and with neither it runs without a token.
- `CF_POT=off` starts nothing (tests, emergencies). `CF_POT_HOME=/opt/bgutil/server` is set in the image.
- The build runs `python -m clipfactory_agent.pot`: `yt-dlp -v` (pointed at a dead local proxy, so it never reaches
  YouTube) must list `bgutil:http` and a usable `bgutil:script-deno`, and the server must answer `/ping`.

### 29.3 yt-dlp arguments for YouTube

Every YouTube call (resolve, audio, picture, sections, full download) gets the common arguments **without**
`--no-warnings`, plus `--extractor-args youtube:player_client=default,mweb`, the script-mode argument above, the
owner's cookies when saved, and `--proxy` when §29.8 gives one. `mweb` is never used alone (it only offers 360p).
Twitch and Kick keep their arguments exactly. yt-dlp's text goes to the log only (URLs redacted); the cookies' "no
longer valid … rotated" warning is kept in the error tail so the owner can be told.

### 29.4 Cut the clips, in order (YouTube links)

1. At the start of the step, one `-J` saved to `source/cut-info.json`. A bot check fails the step with `CUT_BLOCKED`,
   run-out cookies with `COOKIES_EXPIRED`; any other failure leaves the sections to fetch from the link as before.
2. Each clip: a section download with `--load-info-json cut-info.json` (no new player calls per clip).
3. A 403, fragment or merge failure: `cut-info.json` is fetched again **once per job** (under a lock), and the
   section is tried once more.
4. Still failing, or a bot check: **one** full download for the job (under the same lock), at the first rung of
   1080p → 720p → 480p (H.264 preferred) whose estimate (video + audio, +10%) leaves `DISK_RESERVE` (3 GB) free,
   `--http-chunk-size 10M`, `--max-filesize` 1.5× the estimate, 90 minutes at most. Log line `cut.full_fallback`
   (height, estimated bytes, seconds). No rung fits: `CUT_TOO_BIG`. The download fails: `CUT_BLOCKED` or
   `CUT_FAILED`; the failure is remembered so the other clips do not try again.
5. That clip and every later one (spares and checklist re-cuts too) are cut from `source/full.mp4` with the same
   ffmpeg arguments as uploads.
6. `full.mp4` and `cut-info.json` are deleted when the run ends (and when the step fails).

Network blips (timeouts, 5xx, 429) are still retried three times as before. A clip that cannot be cut is skipped;
the step fails only when none could be cut ("Cut 6 clips; 2 could not be cut." stays).

### 29.5 Owner words

| When | Words |
|---|---|
| Bot check, no cookies | YouTube stopped the cloud from getting this video. Tap Use a video file, or add your YouTube cookies in Settings › YouTube help. |
| Bot check, with cookies | YouTube stopped the cloud from getting this video, even with your cookies. Tap Use a video file, or get new cookies in Settings › YouTube help. |
| Cookies rotated or run out | Your YouTube cookies ran out. Get new ones in Settings › YouTube help, then tap Try again. |
| Cut step, all clips blocked | YouTube stopped the cloud while cutting the clips. Tap Try again. If it stops again, tap Use a video file. |
| Cut step, video too big for the disk | This video is too long to cut in the cloud right now. Tap Use a video file, or try a shorter video. |
| Cut step, anything else | The clips could not be cut this time. Tap Try again, or tap Use a video file. |
| Other download failure | The video could not be downloaded from YouTube. Check the link and tap Try again, or tap Use a video file. |

When no clip could be cut the step says, in this order of preference: blocked, cookies ran out, too big, the first
other plain reason, the generic words. Every message names a real button ("Try again" or "Use a video file"); none says
"Retry" or "the agent" or carries yt-dlp's text.

### 29.6 The cookies file: guide and check

- Settings › YouTube help shows "How to get cookies": open a private window in Chrome; allow Get cookies.txt LOCALLY
  in private windows; sign in to YouTube there; in the same tab go to `youtube.com/robots.txt`; export; close the
  private window and don't open it again; tap Add cookies.txt. Tip: a spare Google account is safest.
- Before upload the browser runs `checkCookies` (`web/src/lib/cookiesFile.ts`): Netscape lines of 7 tab-separated
  fields (`#HttpOnly_` allowed, CRLF allowed), `youtube.com` rows with at least one of `LOGIN_INFO`,
  `__Secure-3PSID`, `SAPISID` not expired (0 = session cookie, fine). Results: `notCookies`, `notSignedIn`,
  `expired` each get a plain sentence; only `ok` uploads. The text is never logged or sent anywhere but the existing
  presigned PUT.

### 29.7 "Use a video file"

A button on every failed link job, next to Try again, opening New job in file mode (`/?file=1&from={jobId}`) with
the clip count and notes copied. It uses the existing upload flow; the video then comes from the owner's own
connection. The button and the job page header are built on `fix/job-header` (§29.9).

### 29.8 Optional proxy

- Secret name `cf-prod/agent/youtube-proxy` (env `CF_YOUTUBE_PROXY_SECRET`), value `http://user:pass@host:port`
  (`https://`, `socks5://`, `socks5h://` also accepted). The agent role may `secretsmanager:GetSecretValue` on exactly
  that name plus the 6-character suffix.
- Terraform does **not** create the secret: the owner adds it only if ever needed. Missing, empty, unreadable or not a
  proxy URL: no proxy, the job goes on. Used for YouTube calls only; the value is never logged.

### 29.9 Job page header

The title card's top room and the status chip inside the card are fixed on `fix/job-header`, not in this change.

### 29.10 Tests

- Agent: `tests/test_youtube.py` (arguments per site, proxy for YouTube only, words, kinds, the full-download ladder,
  the Cut order with two parallel cuts, refresh then success, blocked → full at once, one failing clip still finishes,
  all blocked, too big, rotated cookies, Twitch unchanged, the proxy secret, the sidecar restart/off/ping, the stale
  cookies warning kept in the error tail).
- Web: `test/cookiesFile.test.ts`.
- Infra: `modules/agent/tests/runtime.tftest.hcl` (`youtube_proxy_secret_is_read_only`) and
  `envs/prod/tests/wiring.tftest.hcl` (the ARN pattern).

### 29.11 Not verified live

Tested on a home connection only, which never sees the AWS block: the agent's own commands with and without the token
(the token is made and used; sections at 1080p from the saved `-J`; a 480p full download cut locally to 10.0 s). Only
real jobs on AWS can show whether the token, fresh private-window cookies and `default,mweb` together pass "Sign in to
confirm" from the AgentCore address (bgutil says it might not; hence the file button and the proxy), how big the
container's disk really is (`cut.full_fallback` logs the height chosen), how long a full download takes from AWS, and
that `node-canvas` loads on Debian arm64 (CI's arm64 image build runs the check of §29.2).
