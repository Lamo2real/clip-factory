## ADR-89 Clips Funded posts TikTok through the same Mac: one helper, two lanes, the right account checked every time

- **Context.** Since ADR-83 and ADR-86 the owner's Mac posts Clip Factory's TikTok clips for everyone, out of sight.
  Clips Funded posts TikTok through Clip Factory's shared TikTok app, still in Sandbox, so its API posts can only be
  Only me. On 2026-11-23, with a screenshot of Clips Funded › Social accounts › TikTok connected as @clips.funded, the
  owner said: "btw i want the same way we upload to tiktok in clip factory for clips funded". Hard rules: never cross
  accounts (Clips Funded never touches Clip Factory's, and the other way round); every Clips Funded post carries
  TikTok's AI label and is never branded; Clip Factory's flow (four auto-posting runs a day) stays exactly as it is;
  an older helper never picks a Clips Funded job; no password in chat, logs, files or the server; no Terraform change.
- **Options.** (1) A second helper install with its own launchd job: two Chromes racing for one Mac, two sign-ins,
  and nothing to keep Clip Factory first. (2) Clips Funded jobs in Clip Factory's `/v1/tiktok/mac` queue: one queue,
  but Clips Funded data in Clip Factory's partition and Clip Factory's Lambda reading Clips Funded's accounts, which
  §45 forbids. (3) One helper with two lanes: Clip Factory's lane unchanged on the wire, and one lane per Clips Funded
  workspace on new routes in Clips Funded's own Lambda and partition, each lane with its own Chrome profile, port,
  ledger, needs-you and login. For the @clips.funded login (it signs in with Google): (a) a TikTok password for
  @clips.funded in the Keychain, which he would have to make and type; (b) an email-code login, which still needs his
  inbox and his turn each time; (c) one visible sign-in in the lane's own Chrome profile with the TikTok app's QR code,
  the helper never attached to that window (Continue with Google there would type his Google password on the Mac, so
  the code is the documented way, and the window's profile is hardened so it can't save a password either).
- **Decision.** (CONTRACTS §47.10, §45.14) Option 3 with login (c). Helper 1.2.0 runs Clip Factory's lane first every
  tick, exactly as 1.1.0, and a Clips Funded lane only when Clip Factory's has nothing to post, resume or find; a ws
  error never reaches Clip Factory's lane. Before Studio › Posts is read, right before Post, before every look for a
  link and on the link itself, the helper reads the signed-in handle (the passport answer, Studio's own post links,
  the page's rehydration data) and refuses unless it is the lane's target: the job's recorded `@handle` for Clips
  Funded, `GET /v1/accounts`' TikTok handle for Clip Factory (else the one account of the helper's own Clip Factory
  posts, so a 1.1.0 Mac goes on as it did). Each lane also refuses every other lane's account by handle and uid, both
  ways. The server's claim re-checks the open_id and the stored handle, and done refuses a link on another account. Clips Funded's Mac posts are always Everyone with Comments, Duet
  and Stitch on, Disclose post content off and TikTok's "AI-generated content" switch on and read back (no switch, no
  post). `MAC_WS_FROM = "1.2.0"` gates the queue and the claim. The switch is `StoriesConfig.tiktokMac`, shown as **My
  Mac posts TikTok** in Clips Funded's TikTok card, which also shows the Mac's state and **Log in on my Mac**. The web
  rows follow Clip Factory's Mac rows in Clips Funded's own words; a post the API made Only me (`onlyMe`) offers **Post
  with my Mac** and is handed over in place, so a story keeps one TikTok row.
- **Alternatives.** *Reuse Clip Factory's routes with a workspace field*: Clip Factory's Lambda would read Clips
  Funded's partition. *Caption matching for Clips Funded's lost posts* (as Clip Factory's `findExisting`): an older
  story's post with a similar caption could be taken as done, so a ws lane relies on the server's never-twice rule and
  the baseline saved at pressing. *A Keychain password for @clips.funded*: a password he never had to make, in one
  more place. *Reading the handle from www.tiktok.com's feed links*: those are other people's videos, so off Studio
  only the account's own data counts.
- **Consequences.** No Clip Factory route, server file, web file or Terraform changes; Clip Factory's ping keeps its
  keys and now says 1.2.0 (and `paused`, with why, when it can't tell which TikTok is Clip Factory's). A Clips Funded
  post can make one Clip Factory job wait one tick at most (about 40 minutes at worst, when it meets a logout). A later
  TikTok logout of @clips.funded is the owner's turn again (no saved login): the row says so with **Set it up** and the
  card has Log in on my Mac, which clears the profile's old cookies first. A paused Mac has **Start my Mac again** in
  Clips Funded too (the same pause as Clip Factory's). If no handle source is readable, nothing posts in either lane
  (`whoami` before 1.2.0 starts is the go-live gate). TikTok may link two
  automated accounts on one Mac and network, so an automation flag could hit both; the owner accepted the automation
  risk for @lamo.clips on 22 Nov. Mac-posted Clips Funded videos get no view numbers yet, and It's on TikTok is
  paste-only (no Find it for me); both are follow-ups.
