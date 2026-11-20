## ADR-57 Upload replaces Keep; the owner picks places per clip; no dropdowns, no extra options

**Corrected by ADR-58.** The "no preset, no options, button bar for TikTok" part below was a misreading: the owner asked
for a one-tap preset of his own settings and options per platform, and TikTok's rules ask for a dropdown. The Upload,
`platforms` and per-place Try again parts stand.

Upload to many places at once, nothing else to pick, inside each platform's rules.

- **Context.** The owner read the caption tab strip as a pick-one platform picker, saw X offered though X was not set
  up, and asked for "Upload" instead of "Keep", for any number of places per clip, and never "made for kids" (he
  swears in some clips). He also said no dropdown, and that goes for YouTube, TikTok, Instagram, Facebook and X. A first
  build added a "Use my settings" button, a "More details" panel with a category dropdown and switches, a "Who can
  reply" dropdown and a My settings page; a review showed that is the opposite of what he asked, and that a stored
  preset made YouTube ignore his saved privacy.
- **Options.** (1) Keep posting to Where clips go and only rename the button; (2) a per-clip destination list sent
  with Upload and nothing else; (3) (2) plus a stored preset and per-clip options.
- **Decision.** (CONTRACTS §33) Option 2: `platforms` on Confirm (additive; older clients work as before), `uploadTo` on
  the clip, Try again per place. No preset, no `options`: every place keeps its saved setup, so YouTube still follows
  `youtubePrivacy`, and YouTube's made-for-kids flag stays false. TikTok's Content Sharing Guidelines (updated 4 Aug
  2026) still require the creator to pick the privacy with no default from `privacy_level_options` (only "Only me"
  until TikTok audits the app), and to see Comments, Duet and Stitch off by default; so the TikTok sheet shows that as
  one bar of buttons (not a dropdown, the owner's word) with nothing picked, and stays visible on every TikTok upload.
- **Consequences.** One tap more for TikTok than the owner wanted, and Everyone cannot be picked at all until TikTok
  approves the app; everything else is one tap. Whether TikTok accepts a button bar in place of its "dropdown" is to be
  confirmed at app review. No table or infrastructure change; existing clips and posts are untouched.
