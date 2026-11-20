## 35. Mac fetches it (owner decision, 2026-11-20)

When YouTube blocks the cloud (the bot check, "cookies ran out", a 403 that the §29.4 fallback cannot get past), the
Clip Factory app on the owner's Mac gets the video on his home connection and sends it to the job. He does nothing
but keep the app open, which he usually has. No cookies, no extra cost. Windows uses the same code. See ADR-59.

### 35.1 The flow

* **Up front.** A YouTube link job made in the desktop app (`window.__CF_MAC_FETCH__` exists) is created with
  `macFetch: true` and gets `macFetch: {state: "waiting", up: true}`. The job flow's `start-agent` sees `up` and goes
  straight to the wait: the cloud never asks YouTube for it.
* **Fallback.** Every other YouTube link job gets `macFetch: {state: "cloud"}`. The agent (`st.mac_ok`, only for jobs
  with the map) turns these into `NeedsMac` instead of a failure: a bot check or run-out cookies at Find the video or
  Get the video (`sources.explain_or_mac`), a whole-download 403, and at Cut the clips a bot check on the first `-J`,
  or no clip cut because of a block, run-out cookies, or a failed or too-big full download (`pipeline.needs_mac`).
  The job stays `running`; the blocked step stays running with "Waiting for your Mac to get the video"; the agent
  sends the callback failure `MacFetch`. Private, removed and live videos, and Twitch and Kick, fail as before.
* **The wait** (`flows/job_flow.py`, steps `mac-wait-n`, `mac-stop-old-n`, `mac-nudge-n`, `mac-source-n`, callback
  `mac-done-n`, 24 h, no compute): `begin_mac_wait` writes `macFetch.state: waiting`, `since`, the callback id
  (`macCallbackId`, internal) and the step and live line words. After 2 minutes, if no Mac has claimed it
  (`state` still `waiting`), `nudgedAt` is set and cf-prod-notify sends "Open Clip Factory on your Mac to continue."
  (it follows the "It stopped" choice). One Mac fetch per flow run.
* **The video arrives.** `switch_to_mac_upload` makes it an upload job on a new session: `source.type: upload`,
  `key: uploads/{userId}/mac-{jobId}/video.mp4`, `fetchedBy: "mac"`, `linkPlatform: "youtube"`, keeping `url`, the
  title and the channel (the Mac's only when the job has none); done steps stay done, the waiting step and later ones
  go back to pending, `pickUp`, the note "Your Mac sent the video.", a fresh 8 h (`runStartedAt`). The next attempt
  runs the agent on it through the upload path (§29.7, PR #48).
* **Ends.** 24 h with no video: failed, "Your Mac didn't get the video. Use a video file instead." (the source stays a
  link, so Try again and Use a video file both work). The job page shows Use a video file also while the job waits and
  after Stop, so nobody (a Windows PC, a Mac without the app) has to wait the 24 h. The Mac stopping: failed with its words (§35.5). Stop job: the
  cancel route sends the callback failure `Canceled` (a quiet `canceled`) and aborts a half-sent upload.
* The job flow's execution timeout is 149,400 s (8.5 h + 24 h + 8.5 h), changed in place.
* **Try again** (`routes/jobs.retry`, `macfetch.restarted`): a leftover wait never carries into the new run. `macFetch`
  goes back to `{state: "cloud"}` (or `{state: "waiting", up: true}` for a job made in the desktop app), so the claim,
  the upload id, `nudgedAt` and `macCallbackId` are forgotten; a video the Mac already sent (`done`) stays.

### 35.2 The desktop app (`desktop/src-tauri/src/mac_fetch/`)

* Four app commands, registered with `tauri_build` `AppManifest::commands` and granted at runtime only to the app's
  own origin in the `main` window (`mac_fetch::capability`, like the title-bar drag): `mac_fetch_start {jobId, url}`,
  `mac_fetch_status {jobId}`, `mac_fetch_upload {jobId, partSize, parts}`, `mac_fetch_cancel {jobId}`.
  `capabilities/main.json` stays empty. The design named three; `status` was added because a polled status needs no
  event permission for the remote page.
* `init.js` defines `window.__CF_MAC_FETCH__ = {version: 1, start, status, upload, cancel}` over Tauri's own bridge.
* Checks (`check.rs`): the link only `https` on `youtube.com`, `www.youtube.com`, `m.youtube.com`, `youtu.be`, no
  user info or port, an 11-character id `[A-Za-z0-9_-]{11}` from `/watch?v=`, `/shorts/`, `/live/`, `/embed/` or
  `youtu.be/`; yt-dlp only ever gets `[hidden]<id>`. The job id is a ULID. At most 2 fetches at
  once, one per job.
* yt-dlp always runs with `--ignore-config --no-plugin-dirs --no-cookies --no-cookies-from-browser --no-playlist
  --no-cache-dir --js-runtimes deno:<path> --ffmpeg-location <dir>`, never `--exec`, never `-U`; the link is the one
  argument after `--`. It runs in its own process group; a cancel stops the group (SIGTERM, SIGKILL 2 s later;
  `taskkill /T` on Windows) and removes `<app data>/fetch/<jobId>/`.
* The download: one `-J` (details and sizes; a live or upcoming stream is refused), then the first of 1080p, 720p,
  480p (H.264 first) whose estimate + 10% leaves 3 GB free, else "Your Mac is full. Free up N GB.". `--continue` with
  `.part` files resumes; the result is `video.mp4`. Progress from `--progress-template` (bytes per format).
* **Room for the merge.** yt-dlp saves the video and the sound as two files and merges them into a third, so a rung
  needs twice its estimate (+10%) plus 3 GB free; "Free up N GB" uses the same number.
* **Tries.** The page does not fail the job on the first stumble. `failed`, `send` and `tools` are tried again 4 times
  (after 3, 10, 30 and 60 s, each shorter than the 2 minutes after which another Mac may claim the job, with a progress
  report before every wait). A download carries on from its `.part` files; a send asks `source-upload` again for fresh
  addresses (same `uploadId`, so sent parts stay sent) and the app skips the parts it has (`parts.json`). Only after the
  tries run out is `failed` reported. `blocked`, `gone`, `live` and `full` are final. A 404 on a report (job deleted)
  stops the fetch and removes the copy, like a 409.
* **The window keeps working in the background.** The window is built with background throttling off, because the
  fetch is driven by page timers (the 30 s look at the jobs, the 1 s poll, the reports).
* **Leftovers.** At start-up a thread removes `<app data>/fetch/<jobId>/` folders not touched for 3 days (a job stopped
  or deleted while the app was closed); a job waits at most 24 h, so nothing live is that old.
* **One install at a time.** `tools::ensure` takes an exclusive lock on `<app data>/tools/.install.lock`, so two fetches
  starting together never write the same temp file.
* yt-dlp's text stays on the computer; the page only gets codes: `blocked`, `gone`, `live`, `full` (+ `needGb`),
  `tools`, `failed`, `send`, `canceled`.

### 35.3 Sending the video

* `POST /v1/jobs/{id}/mac-progress` `{deviceId, phase: getting|sending|failed, pct, error, needGb}`: the first Mac to
  report claims the job (`macFetch.deviceId`, internal); another computer gets 409 "Another computer is already
  getting this video." until the first has been quiet for 2 minutes. At most one write every 3 s (else 429). It moves
  `macFetch` (`state`, `pct`, `at`) and the live line (§31): "Your Mac is getting the video" / "Your Mac is sending
  the video", detail "42%". `failed` sends the callback failure `MacFailed` with the words of §35.5. Before the job
  flow has written its wait (a Mac faster than the flow, up front), `failed` and `complete` answer 503 "The job is
  getting ready for your Mac. Try again in a few seconds." and the page tries again.
* `POST /v1/jobs/{id}/source-upload` `{deviceId, size}` (1 byte to 64 GB): a multipart upload at
  `uploads/{userId}/mac-{jobId}/video.mp4` with 64 MB parts and one signed `UploadPart` address per part (6 h). The
  same size again reuses the upload, so parts already sent stay.
* The app, not the page, sends the parts: only to `https://<media bucket host>/uploads/...` with a signed part query
  for that part number (the host is baked in at build time, `CF_MEDIA_HOST`), and remembers sent parts in
  `parts.json` for a resume. So there is no CORS change and the page never holds the video.
* `POST /v1/jobs/{id}/source-upload/complete` `{deviceId, parts: [{n, etag}], title, creator, durationSec}`: every
  part in order, completes the upload, checks the object's size, then sends the `mac-done` callback with
  `{key, size, title, creator, durationSec}` (409 "This job stopped waiting for your Mac." when the wait already ended).
* The web sees `macFetch` as `{state, up, since, nudgedAt, pct, at}` only (`macfetch.public`); never the device, the
  upload id, the key or the callback id.
* The web (`web/src/lib/macFetch.ts`, `app/MacFetchHost.tsx`, desktop app only): reads the job list at start, on a
  resync and every 30 s, and every live job event; for a job that waits it starts the app, polls it every second,
  reports every 5 s, asks for the part addresses when the video is ready, hands them over, finishes the upload and
  lets the app remove its copy. A 409 stops it. `deviceId` is made once per app (`cf.macDevice`).

### 35.4 The tools (pinned, signed, downloaded at first use)

* `desktop/tools/tools.lock.json` pins yt-dlp 2026.10.26 (`yt-dlp_macos` universal, `yt-dlp.exe`, the cloud agent's
  version), Deno 2.9.8 and ffmpeg/ffprobe 6.1.1 (eugeneware/ffmpeg-static b6.1.1) for macOS arm64 and x64 and Windows
  x64: upstream URL, SHA-256 and size of each download, and of the unpacked file for the zips.
* CI job `desktop-tools` (no OIDC token) downloads each file, checks it against upstream's own sums (yt-dlp's
  `SHA2-256SUMS`, Deno's `.sha256sum`) and the lock, unpacks, writes `tools.json` (`schema`, `serial`, `lock`, per tool
  and platform `url`, `sha256`, `size`) and signs it with ed25519 (`CF_TOOLS_SIGNING_KEY`, a GitHub secret only; not
  the updater key), then checks the signature with the public key from `tools.rs`. `desktop-tools-upload` copies the
  files to `downloads/tools/<tool>/<version>/<platform>/<name>` (immutable) and the manifest and `tools.json.sig`
  (no-cache). Nothing runs when the live manifest already has this lock's hash. `desktop/tools/**` is left out of
  desktop-plan's hash, so a tool bump never rebuilds the app.
* The app (`tools.rs`) reads `tools.json` and its signature from its own CloudFront before every fetch, checks the
  signature with the built-in public key, refuses a lower `serial` than the last accepted one, a yt-dlp older than
  2026.10.26, any file not on its own host, then downloads what it lacks (no redirects), checks size and SHA-256,
  and renames it into place; every file is hashed again before each fetch. Offline, the saved signed manifest is used.
* Bumping: change the lock, run `build_tools.py relock` with the new files, raise `serial`, open a PR.

### 35.5 Owner words

| When | Words |
|---|---|
| Waiting (step, live line, job page) | Waiting for your Mac to get the video |
| No Mac after 2 minutes (notification, job page outside the app) | Open Clip Factory on your Mac to continue. |
| The Mac downloads | Your Mac is getting the video: 42% |
| The Mac sends | Your Mac is sending the video: 63% |
| The video arrived (note) | Your Mac sent the video. |
| Not enough room | Your Mac is full. Free up 6 GB. |
| 24 h, no video | Your Mac didn't get the video. Use a video file instead. |
| YouTube refused the Mac too | YouTube stopped your Mac too. Tap Use a video file. |
| Private or removed | This video is private or was removed, so it can't be downloaded. |
| Still live | This stream is still live or has not started. Try again once it has ended. |
| Tools could not be set up | Your Mac could not set up its video tools. Check its internet, then tap Try again. |
| Anything else | Your Mac could not get the video. Tap Try again, or tap Use a video file. / Your Mac could not send the video. Tap Try again, or tap Use a video file. |

The job page shows the words in a flat info callout (`MacWait.tsx`): no edges, no `cursor:`, no motion of its own
(the live line already announces the step to screen readers).

### 35.6 Tests

* Desktop: `cargo test` (link checks and attacks, job ids, part addresses, the argument list, manifest signature,
  rollback, minimum version, foreign host, bad file, offline reuse, the disk ladder, error codes, progress lines, the
  process group cancel, the capability's four commands for the app origin only, the part list and resume). A real
  download on a home connection: `CF_PROOF_TOOLS=<folder> cargo test real_download -- --ignored`.
  `desktop/tools/test_build_tools.py` (lock shape, the yt-dlp pin matches the agent, sign and verify).
* API: `api/tests/test_mac_fetch.py` (the wait after a block, up front, 24 h, the Mac's own words, a cancel, the nudge,
  a wrong result, old jobs, the map on new jobs, what the web sees, the routes, the claim, the 3 s limit, multipart,
  a partial video, a closed wait, cancel and abort, the notification).
* Agent: `agent/tests/test_mac_fetch.py`. Web: `web/test/macFetch.test.tsx`. Infra: the API's callback and abort
  grants (`modules/api/tests`), the job flow's timeout (`modules/flows/tests`). `scripts/test-deploy-workflow.sh`: the
  tools key only in desktop-tools, no OIDC there, the hash leaves `desktop/tools` out, the build gets `CF_MEDIA_HOST`.

### 35.7 Not verified live

Only CI and a deploy can show: the signed manifest on CloudFront, the app downloading the tools from there, the API
signing part addresses and the app sending to the real bucket, the job flow's 2-minute wait and 24 h callback on AWS,
and the notification. Unsigned and not notarized: the tools are files the app writes itself (no quarantine flag), as
the app itself is (no Apple certificates, §12.3).
