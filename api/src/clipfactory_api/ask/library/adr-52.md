## ADR-52 YouTube from the cloud: PO tokens, one extraction per cut, a full download only as fallback, a file upload always one tap away

- **Context.** Two owner screenshots of a 1 h 41 min YouTube job: first "YouTube is blocking downloads from the cloud
  and your cookies did not help" at Find the video, then a failure at Cut the clips. YouTube flags datacenter
  addresses ("Sign in to confirm you're not a bot"); yt-dlp 2026.10.26 skips its `web` client without a PO token
  when cookies are given; cookies exported from a normal window are rotated by YouTube; our `--no-warnings` hid the
  warning that says so. Each clip's section ran a full extraction from the flagged address (10 to 30 calls for 10
  clips), and section downloads gave a 403 now and then even from a home connection.
- **Decision.** (CONTRACTS §29)
  - The bgutil PO token server runs in the agent container (loopback, supervised), with the plugin's script mode as
    backup; every YouTube call uses `player_client=default,mweb` and keeps yt-dlp's warnings.
  - Rotated cookies are detected and told plainly; Settings shows a private-window guide and checks the file before
    upload.
  - Cut the clips makes one extraction and reads every section from it; a 403-type failure refreshes it once; then
    one full download per job (1080 → 720 → 480 within the disk budget) and local cuts. Partial success is kept.
  - "Use a video file" on every failed link job opens New job with the file picker (the existing upload flow).
  - An optional proxy secret in Secrets Manager, read if it exists; never required, never created by Terraform.
- **Alternatives.**
  - *The Mac downloads it* (desktop app runs yt-dlp at home and uploads): yt-dlp, ffmpeg and Deno in the signed,
    notarized bundle (about 150 MB), and every YouTube change would need a signed desktop release. The file button
    gives the same home-connection result with no desktop release.
  - *A full download up front*: a multi-hour stream at 1080p is 10 to 25 GB and does not fit; sections are tens of MB.
  - *A required proxy*: the most reliable fix, but a cost and an account for the owner; kept optional.
  - *Script mode only*: a new Deno process per token; the server keeps tokens warm. *mweb only*: 360p.
- **Consequences.** The image grows by about 175 MB and runs a ~200 MB process. A job that falls back takes some
  minutes longer and needs disk for the full file. A token and fresh cookies raise the odds but do not guarantee
  passing the bot check from AWS; the file button and the proxy are the sure ways. Amends ADR-13.
