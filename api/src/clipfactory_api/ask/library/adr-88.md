## ADR-88 Reference videos from a link: Clips Funded's own pinned fetcher behind an egress guard, and one drop hook

Amends ADR-78 (its "Reference links to other people's videos are not downloaded").

- **Context.** The owner (2026-11-23, with a screenshot of Clips Funded › References, whose card had only "Upload a
  video" and "Found one online? Save it to your device first, then upload the video file."): "i should be able to
  upload with drag and drop (which there isnt currently so fix that" and "and i also want a feature to just paste a
  link instead of uploading a video directly". Clips Funded's runtime had no downloader on purpose, and its drop was
  one card's handlers: invisible, flickering on every child, refused everywhere else, and missing the window guard
  when the app opened straight into Clips Funded. A fetch from a link the owner pastes is a server-side request to an
  address someone else chose (SSRF): the runtime can reach the instance metadata service (169.254.169.254, the
  container credentials at 169.254.170.2) and AWS's own addresses.
- **Options.** Where to fetch: the API Lambda (29 s, no ffmpeg), Clip Factory's runtime and its job flow (its
  cookies, proxy and PO tokens are already wired in), or Clips Funded's own runtime with its own pinned copy. How to
  hold the fetch to the public internet: trust yt-dlp's own checks, an egress rule in the VPC (the runtime is on
  AgentCore's public network: no security group to tighten without new infra), or a local proxy that every byte goes
  through. Which links: any https link, or an allowlist of sites and URL shapes. Drag and drop: patch each upload
  site, or one shared hook.
- **Decision.** (CONTRACTS §45.40, §45.11.1, §12.5)
  1. *Clips Funded's own fetcher.* The action `fetch_reference` on `cf_prod_story_agent`, a `reference_fetch` job
     with one step ("Get the video"); its own pinned `yt-dlp[default]==2026.10.26` (Clip Factory's pin). Code shapes
     are copied from Clip Factory (`sources.py`, `contentrewards/fetch.py`, `logo.py`), never imported (ADR-76).
     Nothing of Clip Factory's cookies, PO tokens, proxy secret, Mac fetch, TikTok helper or social tokens is used;
     IAM already keeps the stories role out of `private/` and Clip Factory's secrets. No Terraform change.
  2. *One allowlist, three copies, one fixture.* Seven sites (YouTube, TikTok, Instagram, Facebook, X, Google Drive,
     Dropbox), exact hosts and URL shapes, https or no scheme only, no user info, port 443 or none, ≤ 2048
     characters, only the kept query keys, the same hand parser in the API, the agent and the web, all three tested
     against `stories/agent/tests/fixtures/reference_links.json`. The API refuses anything else with a sentence before
     any job exists; the agent checks the link again before it fetches.
  3. *The egress guard (SSRF rules).* `netguard.Guard`, a CONNECT-only proxy on 127.0.0.1 started for one fetch,
     carries every byte of it (yt-dlp gets `--proxy` and the proxy variables; Drive and Dropbox go through
     `set_tunnel`): only `CONNECT host:443` (anything else, plain http included, is 405); the host must pass
     `safe_host`; every resolved address must be public (no loopback, private, link-local 169.254.0.0/16,
     `fd00:ec2::/32`, multicast, reserved or unspecified), and the tunnel connects to the checked address itself, so
     DNS rebinding cannot reach a private one; every redirect and CDN hop is a new CONNECT, checked again; all
     incoming bytes count against one cap (`min(2 GiB, (free − 512 MiB) / 2)`) and every tunnel closes past it; 60 s
     idle, at most 16 tunnels; logs hold host names and counts only.
  4. *yt-dlp held to the allowlist.* Argument lists only (no shell), `--ignore-config`, `--no-playlist`,
     `--playlist-items 1`, `--no-cache-dir`, `--use-extractors` with exactly the seven platform extractors and never
     `generic`, `--` before the URL, never `--cookies`, `--exec`, `--load-info-json` or a user-supplied `-o`; a test
     checks offline that every platform shape in the fixture has an allowed extractor. A link shape only `generic`
     takes (Facebook's `/share/…` and `fb.watch`) is out of the table. Live, over 10 minutes and over the cap are
     refused from `-J` before anything is downloaded; the download is capped again (`--max-filesize`, the guard) and
     the file is probed (a video of ≤ 600.5 s, ≤ 2 GiB) before it is stored.
  5. *For study only, kept private.* The file becomes the reference's own `ws/…/references/{refId}/source.mp4`,
     analyzed like an upload; the keep settings apply; nothing is published. The final write is fenced on
     `currentJobId`, and a refused write deletes the uploaded file.
  6. *The plain fallback.* Every failure says why in kid words and keeps "Upload a video" and the page drop; "Try
     again" asks once more (`POST …/references/{refId}/fetch`).
  7. *One drop hook.* `useFileDrop` (element or page zones, a counted highlight, text into text boxes untouched,
     Ask's own drops never taken), `DropOverlay` (one glass layer and pill in each app's own glass, a shaking coral
     refusal, an sr-only status line) and a window guard installed once in `main.tsx`; Clip Factory's new-job card
     keeps its own drop code.
- **Consequences.** A pasted link works without the owner saving the file first, and every upload site takes drops.
  The runtime image gains yt-dlp (its build check runs it, and the self-check confirms the extractors without
  `generic`). YouTube's, TikTok's, Meta's and X's terms forbid downloading or automated collection: the fetch uses no
  login, is for study only and keeps the files private; the owner decides whether to keep it on. Many platforms block
  downloads from cloud addresses, so some links will fail and say so. Follow-ups: Clips Funded's own PO-token sidecar
  for YouTube (additive to the image only) if YouTube links mostly fail; "Get it again" for a link reference whose
  file a keep setting cleared; Facebook share links resolved through the guard and checked again; Vimeo or other
  sites as rows of the table.
