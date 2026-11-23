## 42. Post it on TikTok yourself (owner request, 2026-11-21)

The owner: he needs "the real deal", TikTok posts everyone can see, today. TikTok's API keeps every post of an
unaudited app "Only me" on a private account (developers.tiktok.com/doc/content-sharing-guidelines), and TikTok's
review rules ("Apps must not be for private or personal use"; Direct Post "Not acceptable: A utility tool to help
upload contents to the account(s) you or your team manages") make approval unlikely for a one-person tool. So Clip
Factory hands the clip to TikTok and the owner taps Post there himself, picking Everyone. Nothing here uses TikTok's
posting API. Decision record: ADR-66. Since 2026-11-22 his Mac posts instead (§47) and the web's hand-over sheet is gone;
the routes and stored fields stay (ADR-86).

### 42.1 What the owner sees

**Since 2026-11-22 the web has no manual TikTok sheet** ([ADR-86](DECISIONS.md#adr-86-no-manual-tiktok-sheet-the-mac-is-the-only-way-to-tiktok-until-tiktok-approves-the-app)).
Shown the "Post it yourself" sheet (Save the video, Open TikTok, Send to my iPhone (AirDrop), the caption, the TikTok
link, Not now, I posted it), the owner said (verbatim): "i dont think these options are necessary becasue they are not
gonna be used, the automation will cover it, so might wannna remove this popup". Until TikTok approves the app, his
Mac is the only way to TikTok (§47): every TikTok row says what the Mac is doing, with at most one button (§47.4).
Gone from the web: `screens/library/PostYourself.tsx` (the sheet and `PostYourselfButton`); **Post it yourself** on
Library cards, the clip page and Review's "Uploaded just now"; the sheet that opened by itself after Upload; **Post it
yourself instead** and **I posted it** on Mac posts; Auto-posting's **Post these on TikTok yourself** (§46.2 item 7).
Every route of §42.2 stays, so nothing stored breaks.

What stays for the owner:
* **Posted by you.** A clip he marked himself before (`by: "you"`, no `via`) keeps its row "Posted by you · Everyone",
  with **Open** and its numbers once read.
* **The inline Add link**, the only owner-facing use of §42.2 left: a post by him, or by his Mac (`via: "mac"`), that
  has no link reads "Posted by you · Everyone · add the link" or "Posted by your Mac · Everyone · add the link" and
  shows a link box right in the row (no sheet, dialog or portal), **Paste** and **Save the link**. Save the link sends
  `POST /v1/clips/{clipId}/tiktok/posted {link, since: post.postedAt}`; with the box empty Save the link says "Paste
  the link first, or tap Find it for me." (round 3, no request), and **Find it for me** sends `{since}` only: the
  finder (§42.2) looks for the post on his TikTok and saves it only with its link (round 3, D3: nothing found → the
  row's problem line says the server's words and nothing is saved). A toast says what happened ("Link saved! Clip
  Factory will count its views.", "Found it on your TikTok! …", or the answer's `note`). The clip page has the same field beside Refresh numbers, and its
  TikTok stack says "Posted by you. Add its TikTok link to count views." ("Posted by your Mac. …" for the Mac's).
* **A campaign clip** never goes to his Mac (round 3, D1, §47.2): its row says "Campaign clips skip TikTok for now:
  your Mac can't mark them as Branded content yet." with no button, and Review leaves TikTok unticked for it. The
  inline Add link has **Find it for me** right beside its box (the `{since}` call), then **Paste** and **Save the
  link**; from a "Not sure it posted" row also **It's on TikTok, no link** behind its own question (`{noLink: true}`).
* **Review** (TikTok ticked, TikTok not approved: `app_review` and `posting_audit` not both `ok`): one line just above
  TikTok's Music Usage line (which stays right above Upload, §17.8). While Your Mac posts TikTok is off it is
  `TIKTOK_PUBLIC_HINT`, "TikTok: turn on Your Mac posts TikTok so it posts for everyone."; while it is on, `MAC_HINT`,
  "TikTok: your Mac posts it for everyone." Nothing opens by itself after Upload. Upload to, Use my settings, each
  place's row with TikTok's dropdown and switches, and Upload to several places all stay.

TikTok's rule: Everyone needs a public account, while an unaudited app may only post to a private one
(`unaudited_client_can_only_post_to_private_accounts`). His account is public on purpose (since 2026-11-21), so Clip
Factory's own TikTok upload fails with `TIKTOK_PRIVATE_ONLY` (§17.6), stored word for word: "TikTok only takes Clip
Factory's own uploads on a private account for now, so your Mac posts it for everyone." (round 3; posts that failed
between 2026-11-21 and round 3 keep "TikTok only takes Clip Factory's uploads on a private account until it approves
the app. Tap Post it yourself to post it for everyone."). Posts that failed earlier keep the old "Make your TikTok
account private (Setup step 3), then press Try again." Stored errors are matched against all three, so none changes. The web shows its own words for both (`postError`): "TikTok only takes
Clip Factory's own uploads on a private account for now, so your Mac posts it for everyone." On that row Library shows
no Try again (it would fail the same way) and offers **Post with my Mac** (§47.4); the clip page says the same.

Before ADR-86 (2026-11-21 to 2026-11-22) the sheet handed the clip over by hand: the share menu on a phone, Save the
video and Open TikTok (TikTok Studio's upload page) on a computer, AirDrop on a Mac, the caption copied on the same tap,
numbered steps in TikTok's words, and I posted it (ADR-66). Its full description is in git history.

### 42.2 API (additive, under `ANY /v1/{proxy+}`; `routes/clips.py`, `tiktok_self.py`, `tiktok_link.py`)

| Method & path | Body | 2xx response |
|---|---|---|
| GET `/v1/clips/{clipId}/file` | – | `{ "url", "filename" }`: a 1-hour GET link with `ResponseContentDisposition: attachment; filename="clip-factory-<hook>.mp4"` and `video/mp4` (404 when declined or without a video) |
| POST `/v1/clips/{clipId}/tiktok/posted` | `{ "link"?: string, "since"?: ISO time, "noLink"?: boolean }` | `{ "clip", "posts", "note"? }` |
| DELETE `/v1/clips/{clipId}/tiktok/posted` | – | `{ "clip", "posts" }` |

**Round 3 (2026-11-23, D3, ADR-86): Find it for me never saves without a link.** The body says which of the row's three
answers it is (`noLink` via `validate.boolean`; a non-empty `link` with `noLink: true` → 400 "Send a link or noLink,
not both."; unknown keys 400):

| Body | What happens |
|---|---|
| `link` (non-empty) | the pasted link, as below |
| `noLink: true` (**It's on TikTok, no link**, behind its own confirm in the web) | marked posted by him without a link and **without the finder** (`mark_posted(..., no_link=True)`); answer `{clip, posts}` with no `note`. On a Mac post still `working` it is refused (409 "Your Mac is posting it right now. Wait a minute.") unless the job is stuck (§47.3), and on a `working` job the Mac never pressed Post for: with that `MAC_WORKING` while it still beats the job (`beat_fresh`, even past the 50-minute cap), else 409 "Your Mac stopped before it pressed Post, so it isn't on TikTok. Tap Try again." (`MAC_NOT_PRESSED`, review round 3) |
| neither (**Find it for me**) | a TikTok post already `by: "you"` with a `url` → 200, nothing changes. Else, before the finder, the same refusals as a save (`tiktok_self.check_can_mark`: not uploaded, still starting, `queued`, already public, a Mac post `working` and not stuck → `MAC_WORKING`), so TikTok is never asked for a clip that can't be marked. Then the finder: found → saved with its link (200, no `note`); nothing found, or TikTok did not answer → 409 **"Not found yet. Try again in a minute, or paste the link."** (`routes/clips.FIND_NONE`); TikTok not connected (or no OAuth client) → 409 **"Clip Factory can't look on your TikTok until TikTok is connected. Paste the link instead."** (`FIND_CANT`). Neither 409 writes anything |

`routes/clips.NOT_FOUND_YET` ("Saved. Clip Factory could not find it on your TikTok yet. Tap Find it for me in a
minute.") stays only for the **Mac's own done** (§47.3), which still saves without a link: the Mac knows it posted.

Otherwise unchanged by ADR-86. "I posted it" below names this write (`tiktok_self.mark_posted`), which the sheet's button used to
call: the web now calls the POST only from the inline Add link (§42.1), the Mac's done runs the same write (§47.3), and
the file link and the DELETE (Undo) stay for older apps, unused by the web. The sentences below are the server's,
unchanged, except the finder's note, which names **Find it for me** since 2026-11-23 (the button beside the inline
box); the one that still names I posted it ("… Clear the box and tap I posted it …") means the inline field's **Save
the link**.

* **I posted it** writes the clip's one TikTok post (one per clip, as everywhere) as `status: "posted"`, `privacy:
  "public"`, public `by: "you"`, `postedAt` now (kept when marked again), `perfCheckAt` +48 h. A post Clip Factory made
  (waiting, failed or private) keeps its earlier fields in the internal `beforeYou` and loses `error`,
  `platformPostId` and its stats fields; a clip with no TikTok post gets a new one (internal `madeByYou`, same keys as
  `create_for_clip`, appended to `postIds`, `campaignId` copied), in one transaction with the clip, which gets the
  internal `tiktokByYou` (the new post's id) on the condition that it has none: two taps at once never make two TikTok
  posts, and the route answers the second one as the first (it reads again and writes once more). A clip uploaded
  before `postIds` existed has no list: it starts from all the posts the full read found, so later reads still see
  every post. What was learned from Clip Factory's own video (`metrics`, `statsError`, `nextRefreshAt`, the day-7
  fields of §16.12, `lastSnapshotAt`, `lastSnapshotViews`, `insightsDueAt`) goes into `beforeYou` and off the post,
  so his post gets its own day-7 window; a later link to another video drops them again. The clip becomes
  `posted` when it was `failed`, or `confirmed` with nothing `queued` (the clip flow's settle rule, §14.5); a
  `publishing` clip is left to its flow.
* Refused (409, plain sentences): not uploaded ("Upload this clip first. Then your Mac can post it on TikTok.", round 3),
  posts not made yet (`postsCreated` absent: "This clip is still starting to upload. Try again in a minute."), TikTok
  `queued` ("This clip is still uploading to TikTok. Wait until it is done, then try again."), Clip Factory's own post
  already public ("This clip is already on TikTok for everyone."), a write that lost a race ("This clip just changed.
  Try again."). Unknown body keys 400.
* **The link** (`tiktok_link.resolve`): the first TikTok link in the pasted text. `https://www.tiktok.com/@name/video/<id>`
  (also `/photo/`, `m.tiktok.com`, no scheme, a query) and `m.tiktok.com/v/<id>.html` are read as they are; short links
  (`vm.tiktok.com/<code>`, `vt.tiktok.com/<code>`, `www.tiktok.com/t/<code>`) are opened with one GET that does not
  follow redirects, at most three times, each `Location` https on `tiktok.com`, `www.`, `m.`, `vm.` or `vt.` only
  (`App.tiktok_open`, 5 s). Stored as `url` `https://www.tiktok.com/@name/video/<id>`; `statsId` = the id, joining the
  poller's `gsi2` like any public post (§16.3; TikTok's `video/query` reads only the connected account's videos).
  When the connected TikTok account's `handle` is another `@username` (a handle without "@" is the display name and is
  not compared), or TikTok is not connected, the link is kept without
  `statsId` and the answer's `note` says "Saved. Views only show for posts on the TikTok account you connected."
  Errors (400): "That is not a TikTok link. In TikTok, tap Share, then Copy link, and paste it here.", "That link does
  not open a TikTok video. In TikTok, open your post, tap Share, then Copy link.", "TikTok did not open that link. Try
  again in a minute, or paste the long link from tiktok.com.", and, when a short link lands on TikTok's home page (what
  TikTok answered a server in every test on 2026-11-21), "Clip Factory could not open that short link. Clear the box
  and tap Save the link: Clip Factory looks for the post on your TikTok." Marking again with a link only adds or changes
  the link.
* **No link: finding it** (`tiktok_find.py`): with TikTok connected and no link stored yet, the API asks TikTok's
  Display API `POST /v2/video/list/` (`fields=id,share_url,create_time,video_description,title`, `max_count` 20;
  scope `video.list`, already granted, §16.3; public posts only, newest first) with the stored token. Candidates are
  posts made at most 10 minutes before `since` (clamped to the last 24 hours; absent: an hour ago). The one whose
  description starts like the clip's TikTok caption (first 24 letters, case and marks ignored) wins; with no match,
  the only candidate does; otherwise nothing. Found: `url` and `statsId` as for a link. Not found, or TikTok did not
  answer: Find it for me answers 409 `FIND_NONE` and saves nothing (round 3, above); only the Mac's done still marks
  it, with the `note` "Saved. Clip Factory could not find it on your TikTok yet. Tap Find it for me in a minute."
* **Undo** (DELETE): a post made here is deleted, leaves `postIds` and clears `tiktokByYou`; Clip Factory's own post gets `beforeYou` back
  (status, url, privacy, error, ids and stats fields as they were). The clip's status follows the same settle rule.
  Nothing to undo: 409 "This clip was not marked as posted by you, so there is nothing to undo."
* `Post.by?: "you"` and `PlatformPerformance.by?: "you"` (§16.2) are the only shape changes. No Terraform, table,
  index or secret change; existing clips and posts are untouched (new attributes only on posts the owner marks).

### 42.3 Web

`lib/tiktokYourself.ts` (`tiktokState`, `canPostYourself`, `tiktokAudited`, `videoFileName`, `failedForPublicAccount`,
`postError`, `looksLikeTikTokLink`, `TIKTOK_PRIVATE_ONLY`, `TIKTOK_PUBLIC_HINT`); the inline Add link in
`screens/library/MacButtons.tsx`, shown by `Library.tsx` and `ClipPerformance.tsx` when `tiktokRow` (§47.4) asks for
`add_link`; `lib/metrics.ts` `calmCopy`. `Api.markTikTokPosted(clipId, link?, since?)`; `Api.clipFile` and
`Api.undoTikTokPosted` stay in the Api and the mock, unused by the screens. Removed (ADR-86): `PostYourself.tsx`
(`PostYourself`, `PostYourselfButton`), `handOffFor`, `canShareVideo`, `steps`, `TIKTOK_UPLOAD_URL`,
`canPostYourselfHere` and `offerAfterUpload`. The mock follows the API's rules (a short link reads as the sample video;
mock clips without a video get a tiny stand-in file).

### 42.4 Tests

`api/tests/test_tiktok_yourself.py`, unchanged (links: full, short, away from TikTok, three hops, home page, not a
video, TikTok down, the real opener's hosts; I posted it: new post, link and poller, short link, another account,
replace and Undo, failed clip, Undo of a made post, link later, every refusal, another owner; finding it: by caption,
the only new post, too unsure, TikTok down; the file link); `web/test/tiktokYourself.test.ts` (the pure helpers left
and the mock's markTikTokPosted, Undo and file rules); `web/e2e/tiktok-yourself.spec.ts` (the inline Add link: a link
saved, and an empty box that runs the finder; no **Post it yourself**, **I posted it**, **AirDrop** or **Open TikTok**
control on Library, the clip page or Review). `web/test/postYourselfCaption.test.tsx` went with the sheet. The mock's
first look finds nothing and a later one finds the sample post.

### 42.5 Not verified live

Whether TikTok's short links ever reach the video from an AWS address (from this Mac they went to the home page); that
`video/list` and `video/query` with the Sandbox keys see a public video posted by hand or by the Mac on @lamo.clips.
The share-menu questions (Save Video on iOS 26, TikTok in that menu) went with the sheet (ADR-86). Research with quotes:
the side-session note `tiktok-manual-handoff-research.md` (2026-11-21).
