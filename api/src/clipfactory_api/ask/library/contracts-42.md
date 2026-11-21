## 42. Post it on TikTok yourself (owner request, 2026-11-21)

The owner: he needs "the real deal", TikTok posts everyone can see, today. TikTok's API keeps every post of an
unaudited app "Only me" on a private account (developers.tiktok.com/doc/content-sharing-guidelines), and TikTok's
review rules ("Apps must not be for private or personal use"; Direct Post "Not acceptable: A utility tool to help
upload contents to the account(s) you or your team manages") make approval unlikely for a one-person tool. So Clip
Factory hands the clip to TikTok and the owner taps Post there himself, picking Everyone. Nothing here uses TikTok's
posting API. Decision record: ADR-66.

### 42.1 What the owner sees

* **Library** (each card) and **the clip page** (beside Refresh numbers): **Post it yourself** (TikTok mark; accessible
  name "Post it on TikTok yourself") on every uploaded clip (`confirmed` with posts, `publishing`, `posted`,
  `failed`) whose TikTok is not out for everyone: no TikTok post, or one that is waiting for setup, failed, or
  uploaded privately. Not while Clip Factory is uploading it (`queued`), not when its own upload is public, and not once
  he marked it. On a Library card TikTok then always has its own row ("Not on TikTok yet" when the clip has no TikTok
  post; a TikTok post waiting for setup leaves the "Waiting for setup" group), after YouTube in the usual order.
* **The sheet** (`screens/library/PostYourself.tsx`, the Post to TikTok sheet's look and modal rules, §17.8): title
  "Post it on TikTok yourself", one line ("Everyone can see it, because you post it in TikTok. Clip Factory's own
  TikTok upload stays Only me until TikTok approves the app."), the video, numbered steps in TikTok's words, the TikTok
  caption (read-only, "· copied" once copied), then one way to hand it over:
  * **A phone that can share a video file** (`navigator.canShare({files})` on iOS or Android): the video is fetched
    when the sheet opens ("Getting the video ready…"; `cache: "no-store"`; a `.mp4` file name, since iOS reads the
    type from it), so **Save to my phone** (vermilion) opens the share menu on the same tap that copies the caption
    (copying first: it does not use up the tap, `share()` does; the share holds the file only, no text or title,
    which makes some apps drop the file; its answer is not waited for). TikTok is rarely in that menu for a web app,
    so the steps say: pick Save Video (TikTok in the list? pick it instead); open TikTok, +, Upload, the clip, Next;
    paste the caption; check it says Everyone (TikTok starts a new post with the last post's privacy, Only you after
    Clip Factory's uploads) and turn on Comments, Duet and Stitch; a campaign clip also turns on Disclose post content
    › Branded content; Post; come back and tap I posted it. Closing the share menu is not an error; a share that fails
    for any other reason (or a video that did not load) shows **Save the video** (the file link below) with "The share
    menu did not open. Tap Save the video below. It goes to Files: open it there, tap Share, then Save Video. Then open
    TikTok and tap +." The link and the video load apart: Save the video never waits for the whole video, which only
    the share menu and AirDrop need.
  * **A computer** (and a phone that cannot share files): **Save the video** (vermilion; the file link below, so the
    browser saves it to Downloads; the Mac app opens it in the system browser, which does the same) and **Open TikTok**
    (`https://www.tiktok.com/tiktokstudio/upload` in a new tab, the system browser in the Mac app). Both copy the
    caption. On a Mac (Safari and the Mac app's WKWebView both share files) a quiet **Send to my iPhone (AirDrop)**
    opens the share menu with the file. The computer steps use TikTok Studio's words: "Who can watch this video",
    Comment, Duet and Stitch, and for a campaign clip Show more › Disclose post content › Branded content.
  * **TikTok link** (optional: "Clip Factory looks for the post on your TikTok"), with **Paste**, and **I posted it**
    (vermilion once the video was handed over; it sends `since`, a minute before the sheet opened). Confetti, the sheet
    closes, and one Undo toast: "On TikTok for everyone!" plus " Clip Factory will count its views." when it has the
    post, or the answer's `note` without its "Saved." ("… Clip Factory could not find it on your TikTok yet. Tap Add
    link in a minute."). Undo takes it back (§42.2).
* **After**: the TikTok row says "Posted by you · Everyone", with Open and its numbers once read; without a link
  "Posted by you · Everyone · add the link to count views" and **Add link** (the same sheet with only the link box,
  **Find it on my TikTok**, which asks again from when he marked it, and **Save the link**). The clip page's TikTok stack says "Posted by you. Add its TikTok link in Library to count views."
  until it has one.
* **Right after Upload on Review** (`offerAfterUpload`): when nothing of Clip Factory's is on its way to TikTok (no
  TikTok post, or one waiting for setup) and TikTok's `posting_audit` gate is not `ok`, the clip's line in "Uploaded
  just now" gets **Post it yourself** too (its Undo brings the button back), and when TikTok is set up (he posts
  there) but was left unticked, the sheet opens by itself (Not now closes it), except on a campaign clip. Nothing
  else on Review changes: Upload to, Use my settings, each place's row with TikTok's dropdown and switches, and Upload
  to several places all stay. TikTok ticked there is still Clip Factory's own upload, "Only me" until TikTok approves.

TikTok's rule: Everyone needs a public account, while an unaudited app may only post to a private one
(`unaudited_client_can_only_post_to_private_accounts`). His account is public on purpose (since 2026-11-21), so Clip
Factory's own TikTok upload fails with "TikTok only takes Clip Factory's uploads on a private account until it approves
the app. Tap Post it yourself to post it for everyone." (`TIKTOK_PRIVATE_ONLY`, §17.6). On that row Library shows that
sentence, also for posts that failed earlier with the old one ("Make your TikTok account private (Setup step 3), then
press Try again."), with **Post it yourself** and no Try again (it would fail the same way); the clip page says the
same. On Review, while TikTok is ticked and TikTok has not approved the app (`app_review` and `posting_audit` both
`ok`), one line just above TikTok's Music Usage line (which stays right above Upload, §17.8) says: "Until TikTok approves the app, Clip Factory can only upload to a private TikTok
account. Yours is public? Untick TikTok, tap Upload, then post it yourself." TikTok stays ticked as it was (every set-up
place starts ticked, §36.1); once he unticks it and uploads, Upload to remembers that (§33.2) and the sheet opens by
itself after Upload (below).

### 42.2 API (additive, under `ANY /v1/{proxy+}`; `routes/clips.py`, `tiktok_self.py`, `tiktok_link.py`)

| Method & path | Body | 2xx response |
|---|---|---|
| GET `/v1/clips/{clipId}/file` | – | `{ "url", "filename" }`: a 1-hour GET link with `ResponseContentDisposition: attachment; filename="clip-factory-<hook>.mp4"` and `video/mp4` (404 when declined or without a video) |
| POST `/v1/clips/{clipId}/tiktok/posted` | `{ "link"?: string, "since"?: ISO time }` | `{ "clip", "posts", "note"? }` |
| DELETE `/v1/clips/{clipId}/tiktok/posted` | – | `{ "clip", "posts" }` |

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
* Refused (409, plain sentences): not uploaded ("Upload this clip first. Then you can post it on TikTok yourself."),
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
  and tap I posted it: Clip Factory looks for the post on your TikTok." Marking again with a link only adds or changes
  the link.
* **No link: finding it** (`tiktok_find.py`): with TikTok connected and no link stored yet, the API asks TikTok's
  Display API `POST /v2/video/list/` (`fields=id,share_url,create_time,video_description,title`, `max_count` 20;
  scope `video.list`, already granted, §16.3; public posts only, newest first) with the stored token. Candidates are
  posts made at most 10 minutes before `since` (clamped to the last 24 hours; absent: an hour ago). The one whose
  description starts like the clip's TikTok caption (first 24 letters, case and marks ignored) wins; with no match,
  the only candidate does; otherwise nothing. Found: `url` and `statsId` as for a link. Not found, or TikTok did not
  answer: the post is still marked and `note` is "Saved. Clip Factory could not find it on your TikTok yet. Tap Add
  link in a minute."
* **Undo** (DELETE): a post made here is deleted, leaves `postIds` and clears `tiktokByYou`; Clip Factory's own post gets `beforeYou` back
  (status, url, privacy, error, ids and stats fields as they were). The clip's status follows the same settle rule.
  Nothing to undo: 409 "This clip was not marked as posted by you, so there is nothing to undo."
* `Post.by?: "you"` and `PlatformPerformance.by?: "you"` (§16.2) are the only shape changes. No Terraform, table,
  index or secret change; existing clips and posts are untouched (new attributes only on posts the owner marks).

### 42.3 Web

`lib/tiktokYourself.ts` (`handOffFor`, `canShareVideo`, `tiktokState`, `canPostYourself`, `canPostYourselfHere`,
`tiktokAudited`, `offerAfterUpload`, `steps`, `videoFileName`, `looksLikeTikTokLink`, `TIKTOK_UPLOAD_URL`),
`screens/library/PostYourself.tsx` (`PostYourself`, `PostYourselfButton`), `Library.tsx`, `ClipPerformance.tsx`,
`Review.tsx` (Uploaded just now), `lib/metrics.ts` `calmCopy`; `Api.clipFile`,
`markTikTokPosted(clipId, link?)`, `undoTikTokPosted`; the mock follows the API's rules (a short link reads as the
sample video; mock clips without a video get a tiny stand-in file).

### 42.4 Tests

`api/tests/test_tiktok_yourself.py` (links: full, short, away from TikTok, three hops, home page, not a video, TikTok
down, the real opener's hosts; I posted it: new post, link and poller, short link, another account, replace and Undo,
failed clip, Undo of a made post, link later, every refusal, another owner; finding it: by caption, the only new post,
too unsure, TikTok down; the file link); `web/test/tiktokYourself.test.ts` (the pure helpers and the mock's rules);
`web/e2e/tiktok-yourself.spec.ts` (Library: button, sheet, I posted it, Add link, Find it, Undo; Review: Uploaded just
now). The mock's first
look finds nothing and a later one finds the sample post.

### 42.5 Not verified live

Whether iOS 26 offers Save Video for a file shared from the Home Screen app (reported working on iOS 16; WebKit bug
255641 fixed the Save actions in 2023), and whether TikTok appears in that menu at all (reports say only from Photos);
whether TikTok's short links ever reach the video from an AWS address (from this Mac they went to the home page);
that `video/list` and `video/query` with the Sandbox keys see a public video posted by hand on @lamo.clips. Research
with quotes: the side-session note `tiktok-manual-handoff-research.md` (2026-11-21).
