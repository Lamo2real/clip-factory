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
