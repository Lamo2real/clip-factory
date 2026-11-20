## 33. Upload to many places (owner request, 2026-11-20)

The owner, on a Review card: "X isn't set up yet, so X should not be an option there", "I want to select as many as I
want, and once I hit confirm it should upload to those platforms", "Keep is not a good answer, it should just be
Upload", and, about every place: "No dropdown ... and that goes for YouTube, TikTok, Instagram, Facebook, X, all of
them". This first build had no dropdowns and no option panels; **§36 replaces that** with the card the owner then
asked for (Use my settings, one row per place with its options, TikTok's dropdown). Decision records: ADR-57, ADR-60.

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
* **Caption tabs** (replaced by one row per place, §36.1) showed only the chosen places. A place turned off keeps its
  text. Limits unchanged; the too-long check (`captionsTooLong` / `tabsTooLong`) counts
  only chosen places. The tab shows its mark, and its name only when open; X's name is screen-reader only (its mark
  reads "X"). `aria-label` always names the place.
* **Checks before posting** summary: the title may wrap (`min-width: 0`), the score never shrinks (`flex: 0 0 auto`,
  `nowrap`), so they never overlap.
* **Upload** (was Keep): "Upload to 4", or "Upload to YouTube" for one (never wraps onto two lines; the two buttons
  stack instead); disabled when none is on. "Going to: YouTube · TikTok · Instagram · Facebook" sits right above the
  actions and describes the button (`aria-describedby`). Vermilion on the top card only, bottom right (thumb zone),
  motion `send`. **Try again** (after an Upload that did not finish) runs the same checks as Upload: at least one
  place, and the TikTok sheet when TikTok is one of the places and its choices are not already made on this card.
* (Replaced by §36: "Use my settings" and each place's options in its own row.)
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
  On a `posted`, `failed` or `confirmed` clip, `platforms` also releases that clip's `pending_integration` posts for the
  named places (**Post now**, §33.6), the same way (`release.restart`, §17.6): each named waiting place must be
  connected now, else 400 with the same sentence ("Instagram is not set up yet. Turn it off, then tap Upload."), and a
  waiting TikTok post with no stored choice needs `tiktok` ("Pick who can see it on TikTok."), whose choices become its
  `postOptions`.
  A one-place Try again or Post now on a `posted` clip starts a new flow run while the first run may still be
  uploading another place or waiting for its numbers; no second post can happen: only `queued` posts publish, and a run
  only sends the posts tagged with its own `flowRun` (§17.6 "Release"). On a `confirmed`, `publishing` or `posted`
  clip whose start did not go through (`startPending`), a Confirm without `platforms` starts it (§14.5).

Without it (older clients) everything works exactly as before. Response unchanged (`{clip, posts}`). Types:
`Clip.uploadTo?`, `confirmClip(clipId, captions?, tiktok?, platforms?)`, `uploadClip` (was `keepClip`). Publishers are
unchanged: YouTube still follows `settings.youtubePrivacy` (never made for kids, always). No infrastructure, Terraform
or table change: one new attribute on new clip items. Existing kept and posted clips and their posts are untouched.

### 33.4 My settings

Replaced by §36.2 and §36.3: `settings.postPreset`, Settings › Posting › My settings and per-clip `options`. The owner's
YouTube choice (`youtubePrivacy`) still decides who can see the uploads unless a clip's own row changes it.

### 33.5 TikTok sheet

See §17.8 and §36.5: who can see it is the app's own dropdown (no default, Everyone first; when TikTok allows only
Only me, that is the one choice), then Comments, Duet and Stitch (off to start), Commercial
content with Your brand / Branded content (paid partnership), all visible. On the Review card the same controls are
in the TikTok row (§36), so the sheet opens only for Library's Try again and while nothing is set up.

### 33.6 Library and the clip page

Each post row says "Uploading…" (`queued`), "Uploaded" (+ Open), "Didn't work. {reason}" (`failed`, the existing
friendly sentence) with its own **Try again** (sends `platforms: [p]`; its accessible name is "Try again, {place}" so a
voice command "Try again" finds it; TikTok's "pick again" error opens the sheet first), or "Waiting for setup"
(`pending_integration`, older clips). Toast "Trying Facebook again!". A place that was disconnected since simply fails
again with its plain reason. The Jobs chip says "Uploading" for both `confirmed` and `publishing`.

**Post now (added 2026-11-20).** Connecting a place releases its waiting posts by itself (§17.6 "Release"); Post now is
the backup. On a Library card, a `pending_integration` post whose place is set up (`ready` from `GET /v1/setup`, read
as Review's Upload to reads it, kept fresh by live `setup` news) on a clip that is not `publishing` leaves the
"Waiting for setup" group and gets its own row: the place's mark and name, "Ready to post", and a **Post now** button
(accessible name "Post now, Instagram"; sends `platforms: [p]`; toast "Posting to Instagram!"; motion `send`). TikTok's
Post now opens the Post to TikTok sheet first (big button "Post now"). Places still not set up stay in the one
"Waiting for setup" line; while the setup is loading or the check failed, every waiting post stays there. Post now
stays on a card while another place of it is still uploading: the new run sends only that place (§17.6). The toast
only says "Posting to Instagram!" when the place really left `pending_integration` and the start went through; when
the card was out of date and the clip was still uploading, it says "This clip is still uploading. Post it to Instagram
when that is done." and when the start did not go through, "Still working on it. Try again in a minute." (then the
card's big Try again, §11). Mock mode does the same: a platform that becomes connected (`setup.finish`, the Meta pick,
the pretend consent page) releases its waiting posts, Confirm with `platforms` releases a named waiting place that is
connected, and `__cfMockFaults.startFails` leaves a released or retried clip `startPending`.

### 33.7 Words

"Upload" replaces "Keep" wherever it meant posting (Review, Home's "Nothing gets posted until you tap Upload.",
Library, Jobs' chip "Uploading", help and Ask, the TikTok app-review text, docs). "Keep it", "Keep editing", "Keep the
saved keys" and the like stay: they mean something else. Notifications on main say nothing about Keep.

### 33.8 Tests

`api/tests/test_upload_to.py`, `test_release.py` (Post now, the release on connect, two Post now taps on one clip
that never send a video twice, a run that never started handing its posts over, the strongly consistent Account read,
the callback's deadline, `startPending` and its Try again); `web/test/upload.test.ts` (was keep.test.ts; the mock's
release and Post now), `reviewSheets.test.tsx`; `web/e2e/upload-to.spec.ts` (with the Library's Post now row, a second
Post now on one card, the release on connect, and a start that did not go through turning into Try again),
`tiktok-sheet.spec.ts`, and the Review specs.
