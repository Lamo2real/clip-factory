## 33. Upload to many places (owner request, 2026-11-20)

The owner, on a Review card: "X isn't set up yet, so X should not be an option there", "I want to select as many as I
want, and once I hit confirm it should upload to those platforms", "Keep is not a good answer, it should just be
Upload", and, about every place: "No dropdown ... and that goes for YouTube, TikTok, Instagram, Facebook, X, all of
them". So there are **no dropdowns and no extra option panels anywhere**: each place uses its own saved setup (YouTube:
Settings › Set up posting › YouTube › who can see it), and the one thing a platform's own rules make the owner pick
every time, TikTok's "Who can see it", is one bar of buttons. Decision record: ADR-57.

### 33.1 What it was before

The bar under "Checks before posting" was the caption tab strip (a pick-one `<Glide>` over all five platforms), not a
destination picker. Keep posted to every platform in Where clips go: connected ones `queued`, the rest
`pending_integration` (so X got a post that waited forever). One failed platform on an otherwise posted clip had no
Try again. The X tab showed the X mark and the letter "X" ("X X").

### 33.2 Review card (web)

* **Upload to** (`screens/review/UploadTo.tsx`): one soft-fill toggle chip (`.check-chip.upload-chip`, `aria-pressed`,
  a check mark when on, no border; not a Glide: more than one can be on) per place that is **set up** (`ready` from
  `GET /v1/setup`), in STATS_ORDER. A place not set up gets no chip; one quiet link under the row names them all
  ("Set up X to upload there too.", to `/settings/posting/setup/{first}`), hidden when all five are ready. With
  nothing set up, the row is a callout ("Nothing is set up yet. Upload saves it, and it goes up once you set up a
  place.") and Upload works the old way (no `platforms`). While the setup is still loading, or when the check
  failed (callout "Could not check your places. Check again, then tap Upload." and a **Check again** button),
  `ready` is unknown: Upload stays off, so a failed check can never send the clip to places nobody picked.
* **Which start on (per device):** the last Upload's choice in localStorage `cf-upload-to` (saved on Upload, not on
  each tap) minus places no longer ready; with none saved, Where clips go minus places not ready; if that leaves
  nothing, every ready place.
* **Caption tabs** show only the chosen places (still a pick-one Glide tablist: it picks which caption is edited). A
  place turned off keeps its text. Limits unchanged; the too-long check (`captionsTooLong` / `tabsTooLong`) counts
  only chosen places. The tab shows its mark, and its name only when open; X's name is screen-reader only (its mark
  reads "X"). `aria-label` always names the place.
* **Checks before posting** summary: the title may wrap (`min-width: 0`), the score never shrinks (`flex: 0 0 auto`,
  `nowrap`), so they never overlap.
* **Upload** (was Keep): "Upload to 4", or "Upload to YouTube" for one (never wraps onto two lines; the two buttons
  stack instead); disabled when none is on. "Going to: YouTube · TikTok · Instagram · Facebook" sits right above the
  actions and describes the button (`aria-describedby`). Vermilion on the top card only, bottom right (thumb zone),
  motion `send`. **Try again** (after an Upload that did not finish) runs the same checks as Upload: at least one
  place, and the TikTok sheet when TikTok is one of the places and its choices are not already made on this card.
* There is no "Use my settings", no "More details", and no per-clip options: nothing else to pick on the card.
* Toast after Upload: "Uploading to 4 places!" / "Uploading to YouTube!"; with TikTok, also "TikTok can take a few
  minutes to process your clip."

### 33.3 API (additive)

`POST /v1/clips/{clipId}/confirm` body gains one optional field:

* `"platforms": string[]` — non-empty, no repeats, known platforms, each with a connected account, else 400 with a
  plain sentence ("X is not set up yet. Turn it off, then tap Upload.", "Pick at least one place to upload to.",
  "YouTube is in the list twice. Pick each place once."). It need not be in `settings.platforms`. On a `review` clip
  the clip gets `uploadTo` (STATS_ORDER; public, read-only) and posts for exactly those places; `create_for_clip`
  (and so the flow's `ensure-posts`) loops over `uploadTo` when present, `settings.platforms` otherwise. TikTok's
  sheet choices are needed only when `tiktok` is in the list. On a `posted` or `failed` clip, `platforms` names the
  failed posts to try again: only those go back to `queued` (fresh `publishHandle`, no `error`), `flowRun + 1`, a
  `failed` clip becomes `confirmed`, a `posted` one stays `posted`; naming a place with no failed post changes nothing.
  A one-place Try again on a `posted` clip starts a new flow run while the first run may still be waiting for its
  numbers; no second post can happen (only `queued` posts publish).

Without it (older clients) everything works exactly as before. Response unchanged (`{clip, posts}`). Types:
`Clip.uploadTo?`, `confirmClip(clipId, captions?, tiktok?, platforms?)`, `uploadClip` (was `keepClip`). Publishers are
unchanged: YouTube still follows `settings.youtubePrivacy` (never made for kids, always). No infrastructure, Terraform
or table change: one new attribute on new clip items. Existing kept and posted clips and their posts are untouched.

### 33.4 Nothing else to pick

There is no "My settings" page, no `settings.postPreset`, and no per-clip `options`. Each place keeps using its saved
setup, so the owner's YouTube choice under Set up posting › YouTube still decides who can see the uploads.

### 33.5 TikTok sheet

See §17.8: who can see it is one bar of buttons (a `<Glide>` radio group, no dropdown, no default, Everyone first;
when TikTok allows only Only me, that is one button), then Comments, Duet and Stitch (off to start), Commercial
content with Your brand / Branded content (paid partnership), all visible. The big button says **Upload**. The sheet
opens only when TikTok is one of the chosen places.

### 33.6 Library and the clip page

Each post row says "Uploading…" (`queued`), "Uploaded" (+ Open), "Didn't work. {reason}" (`failed`, the existing
friendly sentence) with its own **Try again** (sends `platforms: [p]`; its accessible name is "Try again, {place}" so a
voice command "Try again" finds it; TikTok's "pick again" error opens the sheet first), or "Waiting for setup"
(`pending_integration`, older clips). Toast "Trying Facebook again!". A place that was disconnected since simply fails
again with its plain reason. The Jobs chip says "Uploading" for both `confirmed` and `publishing`.

### 33.7 Words

"Upload" replaces "Keep" wherever it meant posting (Review, Home's "Nothing gets posted until you tap Upload.",
Library, Jobs' chip "Uploading", help and Ask, the TikTok app-review text, docs). "Keep it", "Keep editing", "Keep the
saved keys" and the like stay: they mean something else. Notifications on main say nothing about Keep.

### 33.8 Tests

`api/tests/test_upload_to.py`; `web/test/upload.test.ts` (was keep.test.ts), `reviewSheets.test.tsx`;
`web/e2e/upload-to.spec.ts`, `tiktok-sheet.spec.ts`, and the Review specs.
