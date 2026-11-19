## ADR-13 Download audio first, then only the clip sections

- **Context.** Streams can be 10 hours long; downloading full video in the cloud is slow and costly.
- **Decision.** For links, the agent downloads audio only, finds the moments, then downloads just the few seconds of
  video per clip (yt-dlp section download). Uploaded files are already in S3 and are read directly.
- **Consequences.** Jobs are faster and cheaper. The source is capped at `maxSourceHours` (default 6).
- **Amended by [ADR-40](#adr-40-watch-the-whole-video-before-picking) (2026-11-17).** The audio-only half no longer
  holds: after the audio, the agent also downloads a small copy of the whole picture (up to 480p, no sound) so the
  moments can be picked with the picture. The clip sections are still downloaded on their own, at full quality.
