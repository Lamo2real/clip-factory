## ADR-66 TikTok for everyone: the owner posts it in TikTok himself, Clip Factory hands it over and counts it

**Context.** TikTok's API keeps an unaudited app's posts "Only me" on a private account, and its review and Direct Post
rules turn down personal tools ("Apps must not be for private or personal use"; "Not acceptable: A utility tool to help
upload contents to the account(s) you or your team manages"). The owner wants public TikTok posts now. The TikTok API
for Business would need a Business account, which Creator Rewards does not pay.

**Decision.** A manual hand-off (§42): the share menu on a phone, the file and TikTok's own upload page on a computer,
the caption copied on the same tap. The owner posts in TikTok, picking Everyone, then marks the clip posted, with the
post's link when he has it; the link's video id puts the post on the normal stats poller. Review, Use my settings and
TikTok's API row stay as they are, so the API path is ready if TikTok ever approves.

**Consequences.** No TikTok rule is touched: TikTok's posting API is not used for these posts, and the owner posts with
TikTok's own app. Everyone needs a public account, on which Clip Factory's own TikTok upload is refused until the audit,
so that row fails with a sentence that points to Post it yourself (no "make it private", no Try again) and offers the
button there. Numbers come from the post found on the connected account (`video/list`) or a pasted link, then
`video/query` as for any public post.

- **Amended by [ADR-86](#adr-86-no-manual-tiktok-sheet-the-mac-is-the-only-way-to-tiktok-until-tiktok-approves-the-app) (2026-11-22).** The hand-off sheet is gone from the web: his Mac
  posts TikTok (ADR-83). The routes (`…/tiktok/posted`, `…/file`) and every stored field stay; the only owner-facing
  part left is the inline Add link on a post he or his Mac made without its link.
