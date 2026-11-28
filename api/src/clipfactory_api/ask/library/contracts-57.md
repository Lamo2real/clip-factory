## 57. Reference videos: edit like these (owner request, 2026-11-28)

BR-38, ADR-114. Clip Factory only; Clips Funded is not touched. The owner: "i want to be abe to attach a video, either
through drag and drop or just hitting upload and selecting a video, and i should be able to click on multiple videos
and select them as well as delete any of them, and if i drag and ddrop when i hover the file over the dropbox it
should be highlited with the dropbox of where i am dropping it. and this video should essentially be a refrence to how
i want my videos edited exactly, everything from format to hook to placement and etc. this should be combined with
the skills when creating videos".

- **V1. The screen.** One glass card, "Edit like these", at the top of Settings › Clip making › Skills, above the skills list (which stays as it was). A drop box: drag files over it and it lights up
  (highlight while dragging, off when they leave or drop); the "Upload" button opens the picker with **multiple select**.
  Many files at once; each goes up on its own. The list shows, per video: thumbnail, name, one word of status
  (Uploading, Looking, Ready, Failed), a trash button, and "Try again" on a failed one. An eased bar while it uploads
  and looks, a celebration when it turns Ready. Per video one fold: the short summary lines, then the "Not yet" lines
  (V8). Types MP4, MOV, WebM, M4V; the box says "Up to 10 videos, 500 MB each".
- **V2. Stored (add-only, nothing replaced).** File `refs/{userId}/{refId}.{mp4|mov|webm|m4v}` and thumbnail
  `refs/{userId}/{refId}-thumb.jpg` in the media bucket (not under `uploads/`: they stay until the owner deletes them).
  Item `pk USER#{userId}`, `sk REFVID#{refId}` (Clips Funded's `REFVID#` lives in its own partition, §45.3: no clash):
  `type="refvideo"`, `refId`, `userId`, `name` (from the file name, 60 characters at most), `key`, `contentType`, `size`,
  `createdAt`, `status` (`uploading|analyzing|ready|failed`), `analyzeRev` (bumped on every complete or retry), `analyzeStartedAt` (when the last look started; one stuck over 20 minutes may be started again), and
  once looked at `thumbKey`, `style` (EditStyle, V6), `summary` (3 to 7 short lines), `unsupported` (short lines),
  `duration`, `width`, `height`, `analyzedAt`; on failure `error` (one sentence). At most 10 videos, each 1 byte to
  500 MB, types `video/mp4`, `video/quicktime`, `video/webm`, `video/x-m4v`. An `uploading` item older than 1 hour is
  stale and removed, like logos (§53 C4).
- **V3. API** (`routes/refvideos.py`, same shape as logos).
  - `GET /v1/refvideos` → `{refvideos: [{refId, name, status, createdAt, thumbUrl?, videoUrl?, summary?, unsupported?, error?, duration?}]}`,
    newest first, `uploading` ones left out, the two urls presigned.
  - `POST /v1/refvideos` `{filename, contentType, size}` → 201 `{refId, uploadUrl, headers: {"Content-Type"}}`. 400 "That
    file is not a video we can use. Use MP4, MOV or WebM up to 500 MB."; 409 "You have 10 reference videos. Delete one first."
  - `POST /v1/refvideos/{refId}/complete` → the object must exist and its size match; sets `status: "analyzing"`, bumps
    `analyzeRev`, removes `error`, asks the agent (V5) → 202 `{refvideo}`. The same call is "Try again" on a failed item
    or one stuck in `analyzing` for over 20 minutes. If the agent refuses: `status: "failed"`, "We could not look at
    this video. Try again.", 503.
  - `DELETE /v1/refvideos/{refId}` → item first, then the video and thumbnail → 204. 404 "We could not find that video."
  - IAM: `refs` joins the API role's object prefixes (get, put, delete; no listing).
- **V4. Tests.** `api/tests/test_refvideos.py`, `agent/tests/test_reference.py`, `test_editstyle.py`,
  `web/test/refVideos.test.ts`, `web/test/settingsTree.test.ts`.
- **V5. The agent action.** `{"action": "reference", "userId", "refId", "rev"}` → accepted at once; it runs in a runner
  of its own (counts as busy, never touches jobs). `reference.py` downloads the video, looks at the first 120 seconds
  (size, length, cuts by scene detection, about 8 frames, the words with times when they can be read), then makes one
  Bedrock structured call with the job default `agentModel` (`config/models.json`; no new model id) and the tool
  `edit_style`. Code clamps the answer and fills `unsupported` (V8). It writes the thumbnail, then **one conditional
  update**: only while `status == "analyzing"` and `analyzeRev == rev`, `status: "ready"` with the fields of V2. Any
  failure writes `status: "failed"`, "We could not read this video. Try again." (also conditional on `rev`) and never
  raises. A video deleted meanwhile writes nothing.
- **V6. EditStyle** (the `style` field; every field optional, enums lower-case). `format` `{aspect: 9:16|1:1|16:9|4:5,
  layout: split_facecam_top|split_facecam_bottom|full_frame|blur_fill|camera_only, notes}`; `hook` `{seconds 0..5,
  onScreenText, spoken, visual, textPosition: top|middle|bottom|none, pattern}`; `captions` `{present, wordsPerLine
  1..6, size: small|medium|large, weight: regular|bold|black, casing: upper|lower|sentence|title, color #RRGGBB,
  highlightColor #RRGGBB|null, highlightMode: word|none, outline, box, position: top|middle|bottom, emoji}`;
  `placement` `{logo: none|top_left|top_right|bottom_left|bottom_right|center, extraText}`; `pacing` `{cutsPer10s,
  avgShotSeconds, zooms: none|some|many, jumpCuts, lengthSeconds, speedRamps}`; `audio` `{music, musicMood,
  soundEffects, voiceover}`; `ending` `{type: loop|punchline|call_to_action|hard_cut|fade, notes}`; `summary` (3 to 7
  lines, 90 characters at most); `unsupported`. Free text is capped at 60 to 160 characters per field.
- **V7. The merge (at job start, `agent/editstyle.py`).** Every `ready` reference counts. Per field the **most common
  value wins; a tie goes to the newest video; numbers use the median**. A field no reference has keeps today's
  default. The result is two things: a **RenderStyle** (what `render.py` draws, V8) and one extra section at the **end**
  of the skills block (§18.6), after every skill: "Reference videos: edit like these", the merged style in short lines,
  each reference's hook pattern, and "When a task gives a limit, that limit wins." So it is combined with the skills
  and never changes a task's answer format or limits. No ready reference: no section and no change, byte for byte.
  Campaign (Content Rewards) clips and copies keep their own layout and mark row (§53); caption changes still apply; a
  copy keeps its original's frame layout.
- **V8. What is drawn, what is only said, what is "Not yet".**

  | EditStyle | Result |
  |---|---|
  | `layout` split_facecam_top | facecam on top, gameplay below (today's default with a facecam) |
  | `layout` full_frame, blur_fill | the whole frame over its blurred copy, even with a facecam |
  | `layout` split_facecam_bottom | Not yet: "Facecam at the bottom" |
  | `aspect` other than 9:16 | Not yet: "Square or wide videos" (always 1080 x 1920) |
  | `hook.textPosition` none, top | none: no hook text burned in; top: today. middle, bottom: Not yet ("Hook text in the middle", "Hook text at the bottom"), kept at top |
  | `hook.pattern`, `onScreenText`, `spoken`, `visual` | prompt text for the hook choice |
  | `captions.present` false | no captions burned in |
  | `wordsPerLine` | 1 to 4 words a line (5 and 6 count as 4) |
  | `size` small, medium, large | 64, 82, 100 |
  | `color`, `highlightColor`, `highlightMode` | text colour, the said word's colour, or no highlight |
  | `casing`, `box`, `weight` regular | upper, lower, title case; a box behind; Bold off |
  | `position` bottom, middle | bottom as today; middle: caption bottom at y = 1180. top: Not yet ("Captions at the top"), kept at the bottom |
  | `emoji` | Not yet: "Emoji in captions" |
  | `jumpCuts` false | silences are not cut |
  | `zooms` none, some, many | none: no punch-in; some: on (as today); many: Not yet ("Many zooms"), drawn as some |
  | `lengthSeconds`, `cutsPer10s`, `ending` loop, punchline, hard_cut | prompt text (preferred length, how the moment ends); **the task's own limits win** |
  | `speedRamps`, `ending` fade, call_to_action | Not yet ("Speed ramps", "A fade at the end", "A call to action at the end") |
  | `placement.logo` | Not yet: "A logo on every clip" (logos stay per clip in Review, §53) |
  | `audio` music, sound effects, voiceover | Not yet: "Added music", "Sound effects" |

  "Not yet" lines come from code, never from the model, and are shown in the video's fold. Nothing unsupported is
  faked.

- **V9. Campaign clips and copies.** A Content Rewards campaign clip follows only the caption look and the pacing: it
  keeps its hook, its framing, its mark row and its disclosure exactly as §38.13 says. A copy (§39.3) keeps the framing
  its original was cut with. With no ready reference video every clip is rendered exactly as before.
