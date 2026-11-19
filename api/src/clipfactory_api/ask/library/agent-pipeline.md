## Pipeline

| # | Step (`key`) | The owner sees | What happens | Tools |
|---|---|---|---|---|
| 1 | Resolve (`resolve`) | Find the video | Detects the platform; reads title, channel, duration and thumbnail (yt-dlp metadata), or checks the uploaded object in S3. Refuses private, deleted or unsupported sources with a plain reason. Links: also chooses the small rendition the watchers will look at (`meta.picture`: the tallest H.264 up to 480p and 30 fps that fits the disk, video-only before one with sound, so Twitch and Kick get 480p too; else none). | yt-dlp, S3 |
| 2 | Download (`download`) | Get the video | The sound first, exactly as before, and it must succeed. Links: audio only, cut at `maxSourceHours`. Uploads: extracts the audio from the file in S3. Writes `audio.m4a` (and `meta.json`). Then it starts preparing the picture **in the background** and returns: the small rendition is downloaded (links) or read in place (uploads), one ffmpeg pass cuts it into 2 fps parts of 300 seconds (`picture/part-NNNN.mp4`) and scores how much the picture changes every second (`picture.json`). | yt-dlp, ffmpeg |
| 3 | Transcribe (`transcribe`) | Write down the words | Amazon Transcribe batch job, word timestamps, language detected automatically, speaker labels (who is talking). Writes `transcript.json`, `words.json` (`[start, end, word]`) and `speakers.json`. Almost no words is no longer the end here (`meta.fewWords`): the picture may still carry clips. | Transcribe |
| 4 | Analyze (`analyze`) | Listen for big moments | Loudness per second (`loudness.json`) to find shouting and laughing spikes; loads the skills, the learnings and "What worked before". | ffmpeg |
| 5 | Watch (`watch`) | Watch the video | Waits for the picture, then two models watch **all of it** at the same time. **Fable** gets every 150 seconds as frames (one per 2 seconds, plus every frame around the loudest and fastest seconds) with that part's words. **Nova 2 Lite** gets each 300-second part as real video. Both report what is seen as events (a crash, a stunt, a face, text on screen, how strong, whether anybody is talking). The answers are merged into `visual_log.json`, and with the loudness, the picture-change score, the most-replayed peaks and the speakers into hot spots (`signals.json`). Never fails the job: see [Watching the video](#watching-the-video). | ffmpeg, Bedrock (vision, video) |
| 6 | Select (`select`) | Pick the best moments | First, "What worked before": the source's title, channel, notes and transcript start are embedded with Titan and up to 8 similar clips of this owner are read from S3 Vectors: the owner's `best` (best-of-the-week) clips first, then `performed` ones (fewer than 3 → any of the owner's clips; an error → skipped). Then Claude reads each window (the words **with the picture notes between them**, the loudness spikes, the fast-picture seconds, the hot spots) with the skills block, learnings and those examples and proposes moments, including ones with nobody talking; a final pass ranks them, keeps `clipTarget.max` plus a few spares, and writes hooks. Then **the second look**: Claude sees every frame of each picked moment and spare with its words, may move the timing by at most 5 seconds or fix the hook, and a moment that does not hold up is swapped for a spare that does. Code then writes each clip's `pickedFor` ("Loud laugh + Fast action"). | Bedrock, Bedrock (vision) |
| 7 | Render (`render`) | Cut the clips | Per moment: downloads only that section of video; Claude looks at one frame to find the facecam; ffmpeg builds 1080×1920 (facecam under the hook, gameplay below, or a blurred fill when there is no facecam), trims dead air (never from a moment without words), adds the hook and burned-in ASS captions inside every platform's safe area (see [The finished picture](#the-finished-picture)), punches in on the face around `peak_at`, normalises the sound to -14 LUFS, makes the cover from the peak frame. | yt-dlp, ffmpeg, Bedrock (vision) |
| 8 | Checklist (`checklist`) | Check each clip | Runs the pre-post checklist from the skills. Measured items (sound and motion in the first second, hook length, clip length, captions present, or "No speech to caption." for a clip without words) are computed; judgement items (makes sense with zero context, pays off) are asked of Claude, who also gets what was seen inside the clip. One fix pass; a clip that still fails is replaced by a spare. | ffmpeg, Bedrock |
| 9 | Captions (`captions`) | Write the captions | One caption per platform: YouTube title (under 60 characters) and description, Instagram, Facebook, TikTok, X. Required tags from the owner's notes are added by code, so they are never forgotten. | Bedrock |
| 10 | Finalize (`finalize`) | Finish up | One vector per new clip (`PutVectors`, status `review`), then job `ready`, `clipCount` set, then the success callback. Clips are in `review`. | Titan, S3 Vectors, DynamoDB, Lambda callback |

A step that does not apply is marked `skipped` (for example `watch` when the picture could not be fetched: "Could not
watch the video this time. Picking from the words and the sound.").

### Watching the video

The owner asked for the source to be analysed with the words **and** the picture before the clips are chosen
([ADR-40](DECISIONS.md#adr-40-watch-the-whole-video-before-picking)). Before this, the picture was only looked at
after a moment was picked (one frame, to find the facecam), so a crash or a stunt with nobody talking could not be
found.

| Signal | From | What it adds |
|---|---|---|
| Words | Amazon Transcribe | What is said, and when (as before). |
| Who is talking | Transcribe speaker labels | Lines start with `S1:`, `S2:`; a back-and-forth is visible. Every prompt that shows them says the numbers restart in long videos and are not names. Off with `CF_DEEP=off`. |
| Loudness | ffmpeg | Shouting and laughing (as before). |
| Picture change | ffmpeg, the same pass that cuts the parts | Where the picture moves fast or cuts. Needs no model, so it is still there when Bedrock is not. |
| What is seen | Claude Fable 5.1 on frames of the whole source | Events with a kind, a strength 1–10, the streamer's face, text on screen. |
| What is seen, again | Amazon Nova 2 Lite on the video parts | An independent second opinion; fills the gaps Fable leaves; agreement makes a hot spot stronger. |
| Most replayed | YouTube | Where viewers rewind (as before). |

**Nothing is sampled away.** Every second of the source is in a chunk; a longer source gets more chunks, more time
and the same coverage. The only limits are technical ones (below).

**Every signal is optional at run time.** If the small rendition cannot be downloaded, ffmpeg fails, a model is
throttled, refuses, is not allowed or times out, the failure is logged, nothing is marked failed, and the job picks
from the signals it has. With no picture data at all, the finder's prompts are byte for byte what they were before
(tested). What the owner sees on the Watch step:

| What happened | Step message |
|---|---|
| Everything was watched | "Watched all 2:03:10. Saw 41 big things." |
| Some parts were not watched by either model | "Watched most of the video (44 of 48 parts)." ("part of the video" when under half) |
| No model answered, the picture-change score exists | "Saw where the picture moves fast. Picking with that, the words and the sound." |
| No picture at all (or `CF_DEEP=off`) | skipped: "Could not watch the video this time. Picking from the words and the sound." |
| Try again after a full watch | "Used what it saw last time." (Fable is asked again for any chunk it lost to a busy service or the deadline, even when Nova covered it) |

`meta.json` → `deep` records how each part went (`prep`, `decode` with its `mode` "all" or "keyframes", `fable`,
`nova`, `speakers`, `secondLook`: ok, partial or skipped, with the reason), and every model answer logs its token counts (`bedrock.usage`), so what a job really cost
can be read from the logs.

### The finished picture

Every clip is made once, 1080×1920 at 30 fps, and posted to TikTok, YouTube Shorts, Instagram Reels, Facebook Reels
and X. Each app covers part of the picture with its own text and buttons, so `render.py` keeps every word and face
out of the **union** of what they cover (`SAFE` = x 60–918, y 192–1440):

| Covered by | Where | What the renderer does |
|---|---|---|
| TikTok's tabs | top 10% (y < 192) | The hook hangs from y = 212 (ASS alignment 8) in the band above the picture (`BAND` = 400) and grows down. |
| Name, caption, sound, title, subscribe | bottom 25% (y > 1440) | The captions stand on y = 1380 (alignment 2) and grow up, over the top of the gameplay or the lower picture. |
| Like, comment, share buttons | right 15% (x > 918) | libass wraps the hook and captions between `MarginL` 60 and `MarginR` 172, so lines centre at x ≈ 484. |

- **facecam_top:** hook band 0–400, facecam 400–960 (`CAM_H` 560, full width; the face sits in its middle), gameplay
  960–1920 (the part under the bottom bar is only picture).
- **blur_fill:** the whole frame 880 px tall (`FILL_H`) at y = 400, over a blurred copy of itself.
- **Punch-in:** when the clip still contains `peak_at`, the facecam (or the whole picture in a `camera_only` shot) zooms
  to 120% around that second: smoothstep in over 0.4 s, held 1.2 s, smoothstep out over 0.6 s (`PUNCH_*`). ffmpeg's
  `zoompan` works on a picture twice the size so it moves in half pixels. It zooms toward the point at 50% across and
  40% down, so at full zoom the middle half across and 15–80% down (where a webcam's face is) is never cut. Gameplay
  without a facecam is not zoomed.
- **Loudness:** after the encode, two-pass `loudnorm` (`loudness.normalize`): the first pass measures, the second applies
  it with `linear=true` toward -14 LUFS integrated, ceiling -1.5 dBTP (the AAC encode adds a few tenths, so the file
  stays at or under -1 dBTP). When turning a quiet voice up all the way would push its peaks over the ceiling, loudnorm
  limits those peaks instead of clipping them. The picture is copied, not encoded again. A clip quieter than -45 LUFS
  (silence, hum) is left alone. The levels before and after are in `RenderResult.extra["loudness"]`.
- **Cover:** the frame at `peak_at` (2 s in when that second was cut with a pause), so it is the punched-in face.

The tests measure this: `test_rendered_hook_and_captions_land_inside_the_safe_area` burns the longest hook and caption
onto a black frame and checks where the letters land; the punch-in test evaluates the zoom frame by frame; the
loudness test measures the file that is kept.
