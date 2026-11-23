## ADR-86 No manual TikTok sheet: the Mac is the only way to TikTok until TikTok approves the app

- **Context.** Since ADR-83 his Mac posts each TikTok clip for everyone, out of sight, at auto-posting runs and on
  Upload taps. The §42 sheet (ADR-66) was still offered everywhere: Post it yourself on Library, the clip page and
  Review, Post it yourself instead and I posted it on Mac posts, Auto-posting's Post these on TikTok yourself, and the
  sheet that opened by itself after Upload. Shown it (Save the video, Open TikTok, Send to my iPhone (AirDrop), the
  caption, the TikTok link, Not now, I posted it), the owner said on 2026-11-22: "i dont think these options are
  necessary becasue they are not gonna be used, the automation will cover it, so might wannna remove this popup".
  A one-tap post from a row also had to go at once: a `send` made `source: "sent"`, which the helper treats as backlog
  (one after each auto-posting run, never while it is off).
- **Options.** (1) Hide the sheet behind a setting: two ways to TikTok, and a button he said he won't use. (2) Remove
  it and every button that opens it, and let each TikTok row say what the Mac is doing with at most one button
  (Try again, Post with my Mac, Turn on, or the inline Add link); new routes for "at once". (3) The same as 2, with
  an optional, additive `now: true` on the two existing routes (`send`, `retry`) that makes the post
  `macSource: "upload"`, the source an Upload tap already gives and the helper already posts first and at once.
- **Decision.** (CONTRACTS §42.1, §46.2 item 7, §47.2 to §47.4) Option 3. The web loses `PostYourself.tsx`, every
  Post it yourself, Post it yourself instead and I posted it, the auto-open after Upload and Auto-posting's TikTok
  list; Where they go says "TikTok: turn on Your Mac posts TikTok to post there." with Turn on while the switch is
  off. `tiktokRow` gives one row per TikTok post: posted by the Mac or by him (with the inline Add link when it has
  no link), Posting…, the Mac can't post (off, never set up, not seen for 30 minutes: Turn on), waiting with its next
  time, Didn't work with Try again, Not on TikTok yet with Post with my Mac, a campaign clip, a Private test. Row taps
  send `now: true`; Settings' bulk Send these to my Mac does not, so it stays the backlog he chose ("Send them too").
  Every API route stays: `POST`/`DELETE …/tiktok/posted`, `GET …/file`, `DELETE …/tiktok/mac` and the
  `tiktokYourself` field of `GET /v1/autopost` are kept, the last three unused by the web. `TIKTOK_PRIVATE_ONLY` and
  the stored pressed reason stay word for word, because stored errors are matched against them; the web shows its own
  words for them. Once TikTok approves the app, a clip without a Mac post keeps the old API rows.
- **Consequences.** No route, table, index, stored field, Terraform or helper change; old apps keep working. A
  campaign clip can't go to the Mac (Branded content, its first 30 minutes): its row says "Campaign clip: post it in
  the TikTok app" with only the inline Add link, so posting it is in TikTok's own app. After the Mac pressed Post and
  could not confirm it, Try again sends `notOnTikTok`: if the clip did go up, that makes a second copy, so the row's
  words tell him to look on his TikTok first. A backlog clip's next time is an estimate (the web can't see when the
  helper last took one). The two server sentences that could reach a row now name what is there: the short-link
  error says "Clear the box and tap Save the link", and the campaign refusal says "Post it in the TikTok app, then
  add the link." The stored pressed reason keeps its old words (posts already hold it), and the web never shows it:
  it picks its own words by `pressedAt`.
- **Amended 2026-11-23.** The owner: "its always the automation that covers it weather its invoked by be clicking
  upload or if its the schedule". He never posts by hand, so a campaign clip goes to the Mac like any other (Upload,
  an auto-posting run, Post with my Mac, Send these to my Mac), on his own TikTok and always for Everyone
  (`tiktok_mac.options_for`, the campaign's rule; Upload's own campaign checks are unchanged). The refusal "Campaign
  clips go on TikTok by hand…" and the row "Campaign clip: post it in the TikTok app" are gone. A post still `working`
  15 minutes after its claim, with a Mac that checks in and is fine, reads "Not sure it posted" like a pressed one;
  the server takes It's on TikTok and Try again on it (`tiktok_self.mac_stuck`, in one write conditional on that same
  claim). It's on TikTok on a stopped (or stuck) Mac post also turns the helper's `needs_you` back to `ok`, as Try
  again does. Paused has no Start again (nothing asks the helper to go on), so the row says what comes next.
- **Amended 2026-11-23 (round 3).** It replaces the amendment above in its campaign and 15-minute parts (D1 to D6, after
  a skeptical review of that amendment; CONTRACTS §42.2, §46, §47.1 to §47.6, §38):
  - **D1, campaign clips skip TikTok for now.** No path (Upload with TikTok ticked, an auto-posting run, Post with my
    Mac, Send these to my Mac) makes a campaign Mac post again. Reasons: the helper can't set TikTok's Branded content
    disclosure yet (a paid promotion without it breaks TikTok's rules and risks the account), and the Mac's done never
    sends the post to Content Rewards (only the clip flow's publish loop makes a submission), so it could not earn.
    Upload and Try again refuse TikTok on a campaign clip until TikTok approved the app (`app_review` **and**
    `posting_audit` ok), and `send` refuses it with the same one sentence, `tiktok_mac.CAMPAIGN_SKIPS`: "Campaign
    clips skip TikTok for now: your Mac can't mark them as Branded content yet." Review leaves TikTok unticked for a
    campaign clip and its row says those words, with no dead end. Once TikTok approves the app a campaign clip's
    TikTok goes through TikTok's API as before. The stale "TikTok posts are private" campaign words are gone. Every
    other campaign check stays.
  - **D2, never twice.** A job is stuck only when its own beat (`macBeatAt`, which the helper now re-sends every
    minute while it works on the job) is 5 minutes old (`MAC_BEAT_STALE`), or its claim 50 minutes old
    (`MAC_CLAIM_MAX`: 12 minutes of upload wait, the post wait and the 30-minute find window), whichever comes
    first; server and web use the same rule from one constant each, pinned equal by a test. The 15-minute rule
    offered Try again while a healthy Mac was still uploading or looking for the link, and its re-wait could make a
    second copy. After Post was pressed, Try again ("Yes, post it again", with its confirm) is taken only once the
    30-minute find window is over (`MAC_STILL_LOOKING` before), moves the press to `macPressedBefore` and sets
    `macAgainAt`; the claim refuses any post that still has `macPressedAt`, and the helper never posts a job with
    `pressedBefore` unless `againAt` came after that window.
  - **D3, Find it for me never commits.** Nothing found → 409 "Not found yet. Try again in a minute, or paste the
    link." and nothing saved (TikTok not connected → "Clip Factory can't look on your TikTok until TikTok is
    connected. Paste the link instead."). Saving without a link needs the explicit "It's on TikTok, no link" confirm
    (`noLink: true`), which the server refuses while the Mac has not pressed Post and still beats the job: a clip
    marked posted while it was still uploading never reached TikTok and could not be sent again.
  - **D4, honest times.** Rows count the Mac's queue the way its plan picks (one per tick, Upload first, then auto,
    then the backlog: "next", "in line (N before it)"); the first backlog clip's time is the helper's own
    `backlogAt` (its ping), and a backfill says "in line" with no time. The web never guesses from `GET /v1/autopost`.
  - **D5, no dead ends.** Paused gets **Start my Mac again**, a hold gets **Let them go** (`POST /v1/tiktok/mac/request`,
    flags the helper reads on its next tick and acknowledges in its ping), needs you links straight to the stopped
    clip (`needsYouClipId`), and a working post whose Mac stopped checking in offers It's on TikTok and Try again.
  - **D6, the words.** No helper reason, server reason or `tiktok_self.py` sentence says "post it yourself" or "I
    posted it" (buttons he no longer has); the reason codes stay, only the words changed (`PRESSED`, `NOT_UPLOADED`,
    `TIKTOK_PRIVATE_ONLY`). Stored rows keep their old words; the web matches both.
