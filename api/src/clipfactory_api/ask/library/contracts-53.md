## 53. CR active: logo and text on a clip (owner request, 2026-11-26)

The owner wants a logo and text on a clip, made after it exists, in Review. BR-34, ADR-105.

- **C1. The switch.** Each Review card has a two-state switch, **CR inactive** (the default) and **CR active**, a
  `<Glide>` bar like the other pick-one bars. Inactive: the card, Upload and posting are exactly as before. Active:
  **Edit for campaign** appears. The switch itself changes nothing a platform sees. Clip field `cr`
  `{active: boolean, campaignId?: string}`, absent on old clips (= inactive). Switching to inactive on an edited clip
  puts the original back (C5) and says "Edit removed" in a toast.
- **C2. The editor.** Only a logo and text, nothing else. A glass sheet with the clip's cover as a 9:16 preview.
  **Logo**: pick from the logo library or add one; four corner presets plus drag; a size slider (8% to 50% of the width,
  default 22%). **Text**: one short line (80 characters at most; hashtags allowed), the same presets and drag, size
  Small, Medium or Large, white with a dark edge. **When**: **Whole clip** is the default; a fold **Only part of the
  clip** takes From and To in seconds. One **Make it** button. Placement is stored as fractions (`x`, `y` = the
  element's centre, 0 to 1 of the width and height), so it holds for any size.
- **C3. One warning line.** When the logo or text box overlaps the caption band or, on a `facecam_top` clip, the
  facecam, the editor says "Under the captions" or "On the facecam" (one short line, the box turns vermilion). The areas
  are the ones the renderer draws (`agent/.../render.py`; the web copy sits in `web/src/lib/overlayAreas.ts` and a test
  pins both). HUD areas are not known, so there is no warning for them.
- **C4. The logo library.** Logos are the owner's, kept in the media bucket at `logos/{userId}/{logoId}.{png|jpg|webp}`
  (PNG, JPEG, WebP by their first bytes, at most 10 MB, at most 60 logos). Add by drag and drop, paste, or the file
  picker; each can be deleted (Undo toast); deleting a logo never changes an already edited clip (the render copied
  it). A campaign's own logo (§38) is offered too: picking a campaign (C6) copies its logo into the library once.
  - `GET /v1/logos` → `{logos: [{logoId, name, url, width, height, campaignId?, createdAt}]}` (`url` presigned, 1 h).
  - `POST /v1/logos` `{filename, contentType, size}` → 201 `{logoId, uploadUrl}`: a presigned PUT; the item is
    `LOGO#{logoId}` `{status: "uploading"}`. Also `headers` (the `Content-Type` the PUT must send). 400 on a type other than
    png, jpeg, webp or a size over 10 MB; 409 at 60 logos.
  - `POST /v1/logos/{logoId}/complete` → `{logo}`: reads the object's first bytes and size, reads width and height,
    sets `status: "ready"`; else deletes it, 400 with one sentence ("Use a PNG, JPG or WebP picture under 10 MB.").
  - `POST /v1/logos/from-campaign` `{campaignId}` → `{logo}`: copies that campaign's ready logo (once; asked again it
    returns the same logo). 404 when it has none.
  - `DELETE /v1/logos/{logoId}` → 204 (item and file).
- **C5. The edit (additive clip fields).** `overlay` `{rev, status: "working"|"ready"|"failed", error?, logo?, text?,
  timing?}` with `logo` `{logoId, x, y, size}`, `text` `{text, x, y, size: "s"|"m"|"l"}` and `timing`
  `{startSec, endSec}` (absent = the whole clip). Internal: `origVideoKey` (the untouched file), `editKey`, `overlay.startedAt`, `overlay.logo.key`.
  - `PUT /v1/clips/{clipId}/cr` `{active, campaignId?}` → `{clip}`. Only while `status == "review"` (else 409 as
    Confirm). `active: false` also does C5's reset. `campaignId` must be one of the owner's campaigns (404 otherwise).
  - `PUT /v1/clips/{clipId}/overlay` `{logo?, text?, timing?}` (at least one of logo and text; `cr.active` required,
    else 409) → `{clip}` with `overlay.status: "working"`, then asks the Clip Factory agent runtime for
    `{"action": "overlay", "userId", "clipId", "jobId", "rev"}` (no job flow, no new Lambda: the agent already has
    ffmpeg). The agent cuts nothing: it draws the logo and text on the **original** file with ffmpeg, same size, same
    audio untouched, writes `jobs/{jobId}/clips/{clipId}/edit-{rev}.mp4`, and in one conditional write (clip still in
    review, `overlay.rev` still equal) sets `origVideoKey` (when unset), `editKey`, **`videoKey` = the edited file**,
    `overlay.status: "ready"`. Every platform, the Mac helper and the download read `videoKey`, so **posting is
    unchanged**. A stale or failed render deletes its output and sets `failed` with one sentence. A render that has
    not answered after 5 minutes counts as failed (`GET` reports it).
  - `DELETE /v1/clips/{clipId}/overlay` → `{clip}`: `videoKey` back to `origVideoKey`, the edited file deleted, `overlay`,
    `editKey` and `origVideoKey` removed. The Reset button. Idempotent.
  - Confirm, Upload and auto-posting refuse or skip a clip whose `overlay.status` is `working` ("The edit is still
    being made."); nothing else about them changes (the run's schedule, count and order are untouched). Throwing a
    clip away or deleting its job removes its edited file with it.
  - The public Clip carries `cr` and `overlay` (never the keys); the `videoUrl` is the edited file once ready.
- **C6. A campaign pre-picks.** In the editor, **For campaign** lists the owner's campaigns (§38). Picking one stores
  `cr.campaignId`, selects its logo (C4 from-campaign) and puts its required hashtags (§38 rules) in the text line,
  both editable. It changes no campaign-clip rule, fit check or Confirm check (§38.8, §39); a clip that is already a
  campaign copy keeps them.
