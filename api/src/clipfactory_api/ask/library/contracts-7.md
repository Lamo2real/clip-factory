## 7. S3 media bucket `cf-prod-media-<accountId>` (private, SSE-S3, CORS for PUT from app origins)

| Prefix | What | Lifecycle |
|---|---|---|
| `uploads/{userId}/{uploadId}/{safeFilename}` | uploaded source videos | expire after 14 days |
| `jobs/{jobId}/source/` | `audio.m4a`, `video.mp4` (uploads only), `transcript.json` (Transcribe output), `words.json` (`[[start, end, word], …]`), `loudness.json` (dB per second), `meta.json`, and the deep-analysis files below (§8 "Watch") | expire after 14 days |
| `jobs/{jobId}/source/picture/part-NNNN.mp4` | the picture for watching: 768×432, 2 fps, no sound, 300 seconds per part | expire after 14 days |
| `jobs/{jobId}/source/watch/chunk-NNNN.json`, `watch/nova-NNNN.json` | one watcher answer each, saved at once: `{i, start, end, ok, scene, events[]}` | expire after 14 days |
| `jobs/{jobId}/clips/{clipId}/` | `clip.mp4`, `cover.jpg` | kept |
| `skills/{userId}/{skillId}/{revisionId}/` | `SKILL.md` or `skill.zip`, one folder per saved revision (§18.1; skills added before §18 keep their old key `skills/{userId}/{skillId}/SKILL.md\|skill.zip` until their next save) | kept; old revisions deleted after each save, all deleted with the skill |
| `private/{userId}/youtube-cookies.txt` | optional cookies for yt-dlp | kept, never returned by the API |
