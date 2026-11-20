## ADR-59 Mac fetches it: the owner's desktop app downloads what YouTube refuses the cloud

The desktop app gets the YouTube video on the owner's home connection and sends it to the job, up front for jobs
made in the app and as a fallback for every other blocked YouTube job.

- **Context.** YouTube blocks AWS addresses: "Sign in to confirm you're not a bot", cookies that run out, 403s while
  cutting (§29). The PO token and cookies help only sometimes, and the owner wants no technical steps. His Mac is on a
  home connection YouTube does not block, and he usually has the app open when he starts jobs.
- **Options.** (1) A paid residential proxy: monthly cost, still blockable. (2) Ask for a video file every time:
  works, but it is the manual step he wants gone. (3) The desktop app downloads the video and uploads it to the job.
  For (3), the tools could be bundled as sidecars (about 200 MB more per installer, a full signed release and a
  "Restart now" for every yt-dlp bump, and not notarized anyway) or downloaded at first use from our own signed
  manifest.
- **Decision.** (CONTRACTS §35) Option 3, up front and as fallback, sharing one path: the job waits (status running,
  no compute) on a 24 h durable callback; the desktop window's page claims it, the app downloads at the best rung that
  fits the disk and PUTs 64 MB parts straight to signed S3 addresses; the API completes the upload and the callback,
  and the job goes on as an upload. The tools are pinned in `desktop/tools/tools.lock.json`, checked in CI against
  upstream's sums and the lock, published to our CloudFront, and the manifest is signed with a new ed25519 key whose
  private half lives only in the GitHub secret `CF_TOOLS_SIGNING_KEY`; the app checks it with the built-in public key.
  The page gets four commands for its own origin only, never a shell or the file system.
- **Consequences.** No extra running cost and no cookies. A job started on a phone with the Mac closed waits up to 24
  hours (the owner is told after 2 minutes) instead of failing at once; Use a video file stays one tap away when it
  fails. A whole video at up to 1080p goes over the owner's upload link, where the cloud fetched only the clips'
  sections. Tool bumps ship without an app release; the app shell change needs one "Restart now". The job flow's
  execution timeout grows to 41.5 h.
