## ADR-96 Campaign and paid clips post TikTok through the Mac with TikTok's label

- **Context.** Since ADR-86 round 3 (D1) a campaign clip never got a Mac post and a Review card with Your brand or
  Branded content ticked held Upload for TikTok (CONTRACTS §47.9): the helper could not set TikTok's commercial content
  disclosure, and the Mac's done never reached Content Rewards, so a campaign clip on TikTok could neither earn nor
  keep to TikTok's Branded Content Policy. The owner treats Content Rewards campaigns as paid partnerships and wants
  every clip on TikTok through his Mac ("its always the automation that covers it"), at most reach, never made for
  kids, with nothing on his screen while the helper runs.
- **Options.** (1) Keep skipping TikTok for campaign clips until TikTok approves the app: the campaigns that pay for
  TikTok earn nothing there meanwhile. (2) Post campaign clips through the Mac without the label: breaks TikTok's
  Branded Content Policy and risks the account. (3) Give the helper a disclosure step, read back like privacy, let the
  server hand the card's own TikTok choices (and a campaign's Everyone with Branded content) to the Mac, gate labelled
  posts on a helper that sets the label, and send the Mac's posted link to Content Rewards.
- **Decision.** (CONTRACTS §47.12) Option 3. Helper 1.3.0 opens Show more, sets Disclose post content with Your brand
  and Branded content from the job and reads them back (again right before Post), or stops before Post. The server
  takes the card's own TikTok row for a Mac post (`tiktokMac: true` on Upload), keeps a paid clip's label on the clip
  (`tiktokLabel`) for Post with my Mac and Send these to my Mac, gives every campaign clip Everyone with Branded
  content after all of Upload's campaign checks, stops a closed campaign's Mac post at its claim, never lets a helper
  older than `MAC_BRAND_FROM` claim a labelled post, and sends the Mac's posted campaign link to Content Rewards
  (`contentrewards.submit.send`, its 30-minute window). The Review card's Mac-mode TikTok row is the clip's own again
  (who can see it, the switches, Commercial content), starting on My settings with no tap.
- **Consequences.** Every field and body key is additive and nothing changes for an older web (My settings, as
  before). The helper on the Mac must be reinstalled from main before a labelled post goes; until then such a post
  waits and says so, and nothing is posted without its label. TikTok Studio's controls can change: the step finds
  them by their own words and fails closed. What TikTok shows after Post on a branded post is not verified live (the
  probe never posts); the first one is watched. Amends
  [ADR-86](#adr-86-no-manual-tiktok-sheet-the-mac-is-the-only-way-to-tiktok-until-tiktok-approves-the-app) (D1).
