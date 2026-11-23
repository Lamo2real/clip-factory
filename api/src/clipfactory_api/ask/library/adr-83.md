## ADR-83 Your Mac posts it on TikTok: a post that waits for the owner's Mac, claimed once, finished by I posted it's write

- **Context.** TikTok keeps an unaudited app's posts "Only me" on a private account, his account is public on purpose,
  and approval is unlikely for a one-person tool (ADR-66, CONTRACTS §42), so every TikTok post has been his own Post
  it yourself. On 2026-11-22 he asked for "an automation for my mac" that saves the video, uploads it in TikTok and
  deletes the file, every time Clip Factory uploads to all platforms and on demand from "Upload to 4". Shown the risks
  first (TikTok's Terms and Community Guidelines on automation, reports of 0 views for script-posted web uploads,
  CAPTCHAs and login expiry; plan note `tiktok-mac-automation-plan.md`), he chose "Full auto, 3-post trial", and for
  clips already waiting "Send them too". The auto-posting session's nine constraints had to hold (rule 2 changes only
  on his go; the post is written with the other posts; never `queued`; done through the same conditional write as I
  posted it; never Practice, Private tests or campaign clips; the off switch; `tiktokYourself`; the kept test).
- **Options.** (1) The Mac polls clips and posts and records with I posted it: no claim, so two Macs or a crash could
  post twice, and the app can't show progress. (2) Reuse `queued` and teach the clip flow to skip TikTok: every API
  path (the flow, the release, Try again, Post now) would need a new exception, and one missed would send the post to
  TikTok's API. (3) A new post status `mac`, outside every API path by construction, with a server queue, a conditional
  claim, steps, a stop and a done, as §35's "Mac fetches it" works for sources.
- **Decision.** Option 3. Upload (with TikTok chosen, the switch on and TikTok not approved) and live auto-posting
  runs write the TikTok post as a Mac post in the clip's own Upload transaction (`create_for_clip`'s explicit
  `tiktok_mac` path); Send these to my Mac makes one, or hands a failed, waiting or private Clip Factory post over in
  place (kept in `beforeMac` for Take it back). The helper claims a post with one conditional write; once it says
  "pressing" (`macPressedAt`) the post is never claimed again by itself, and only the owner's "It's not on TikTok, try
  again" clears it. Its done runs `tiktok_self.mark_posted`, so the Mac and I posted it share one write and one post
  per clip (`tiktokByYou`, and the new `tiktokForMac` for sends). Undo never takes back what the Mac posted (it is on
  TikTok), and Take it back is refused once the Mac pressed Post (the restored post could go out through TikTok's API
  as a second copy); it deletes or restores the post and updates the clip in one transaction. Every Mac post asks
  for My settings' choices (Everyone, Comment, Duet and Stitch on), whatever Upload's TikTok sheet said (before the
  audit it offers only Only me), and done writes the privacy that was asked for. The job carries the claim's
  `attempt`, which the helper may send back, so an older attempt of the same Mac is never taken for the new one.
  While the switch is off, waiting and stopped Mac posts are offered again as Post it yourself instead. Campaign clips keep their own path (Branded content, the first 30 minutes). Everything is under `ANY
  /v1/{proxy+}`, additive, and with the switch off nothing changes.
- **Consequences.** No Terraform, table, index, secret or bucket change. The owner sees each step live (post events
  already stream). The risks stay his choice: TikTok may remove posts, cut reach or ban the account; the 3-post trial
  compares 24-hour views with his phone posts before night runs post by themselves for long. The switch stops it at
  once: no claim, and no step before Post, while it is off. The helper (Chrome profile, LaunchAgent, notifications) is
  its own PR.
- **Amended by [ADR-86](#adr-86-no-manual-tiktok-sheet-the-mac-is-the-only-way-to-tiktok-until-tiktok-approves-the-app) (2026-11-22).** Post it yourself instead, I posted it and "It's not
  on TikTok, try again" are gone from the web: a stopped row has only Try again, which sends `now: true` (and
  `notOnTikTok` once Post was pressed, after the row told him to look on his TikTok first). Take it back stays in the
  API, unused by the web.
