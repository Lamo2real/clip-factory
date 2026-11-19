## ADR-35 Every upload is sent as a file, and posting waits inside the clip flow

- **Context.** Platforms take a video either as a file sent by the app or as a URL they fetch. TikTok's URL pull needs
  a verified media domain, Instagram and Facebook fetch URLs from Meta's servers, and every platform processes the
  video for seconds to minutes before it is live. The clip flow is a durable function (ADR-22).
- **Decision.** Clip Factory always **sends the file** (YouTube resumable upload, TikTok `FILE_UPLOAD` in chunks,
  Instagram and Facebook `rupload.facebook.com`, X chunked media upload), read from S3 in 8 MB ranges. A presigned S3
  URL is only a configured fallback for Instagram and Facebook (`publish.source` in `config/platforms.json`). Each
  platform is a `start → check → finish` publisher; the clip flow runs `publish-{platform}`, then durable
  `wait-{platform}-{n}` and `check-{platform}-{n}` steps, then `finish-{platform}`. Every platform call that creates
  something writes a `publishHandle` first, so a replayed step resumes instead of posting twice.
- **Alternatives.** *URL pull everywhere* (TikTok media-domain verification and another public bucket path; Meta
  fetches from outside AWS). *Polling inside one long step* (Lambda time spent waiting, and a retry repeats the
  upload). *A separate publish queue and worker* (the pattern §14 removed).
- **Consequences.** No media host to verify and no public media. Waiting costs nothing. The clip flow needs 1024 MB
  memory for the chunked reads. Steps that cannot be made idempotent on the platform side (TikTok init, Instagram
  publish, X post) are marked at-most-once and, if interrupted, ask the owner to look on the platform before **Try
  again**.
