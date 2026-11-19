## ADR-33 Posting setup: bring your own keys, with a guided list per platform

- **Context.** The owner: "Facebook, Instagram, YouTube, TikTok and X should each be a step to connect to … the user
  should not have to write code … an 8-year-old should be able to do it." Every platform requires a registered
  developer app (OAuth client) before anyone can post through its API. A single shared Clip Factory app would need
  Google verification and a security assessment for `youtube.upload`, TikTok's audit, Meta's App Review and Business
  Verification, and a paid X plan, all in the name of one legal entity, before the first post.
- **Decision.** **Bring your own keys.** The owner creates one developer app per platform by following a step list in
  **Settings › Posting › Set up posting** (four parts: Get ready, Make your key, Connect, Go public). Every step is
  data (`web/src/setup/{platform}.ts`) with Open buttons to the exact page, Copy buttons for every value, paste boxes
  that check the key format, "If you see…" hints for anything uncertain, and the date the steps were checked
  (2026-11-16). The same list is [docs/SETUP_POSTING.md](SETUP_POSTING.md), and a web test keeps the two in step.
  Clip Factory keeps the owner's app in a state that needs no platform review where the platform allows it
  (Google: published but unverified, which only shows a warning to its own user; Instagram: Development mode with the
  owner's own accounts).
- **Alternatives.** *One shared Clip Factory app per platform* (months of reviews and audits, a company behind it, and
  a single point of failure; not possible for one private owner on TikTok and X today). *A third-party posting
  service* (another account, monthly fee, and the owner's tokens held by someone else). *Browser automation of the
  platforms' upload pages* (against every platform's terms, breaks often, needs the owner's passwords). *Written
  instructions only* (no Copy buttons, no format checks, no progress: not kid-proof).
- **Consequences.** About 2 hours of one-time clicking across five sites, guided. Some limits stay with the owner's
  app: TikTok posts stay "Only me" until TikTok approves the app and its audit, which it may refuse for a tool one
  person uses; Facebook Reels may stay visible only to the owner if Meta wants App Review before Live; X costs about
  $0.015 per post. The setup says each of these plainly. When a platform renames a button, only the data file and
  [SETUP_POSTING.md](SETUP_POSTING.md) change.
