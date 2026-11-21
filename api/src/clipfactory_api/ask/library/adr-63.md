## ADR-63 Content Rewards follow-ups: one fit check in the API, a new copy instead of turning a normal clip into a campaign clip, one 30-day total that includes Content Rewards

- **Context.** After approving §38 the owner asked (2026-11-21) for three things: the Connect steps checked so they are
  very simple and in time order, with a pleasant choice between campaign clips and the normal clips he makes today;
  all his money from every place, Content Rewards included, in one place; and to know before uploading whether a clip
  can earn on a campaign he joined, so he never sends one that can't. Content Rewards (CR) checks a post when it is
  sent: from an account linked inside CR, never sent before, live for less than 30 minutes; a post belongs to one
  campaign forever; rejections rest on the written brief; the same final clip in two campaigns is rejected as a
  reused edit; CR's disclosure page wants "#Ad" first and a text on the video at the start. The brief is free text
  that Claude reads into `CampaignRules`, with an `uncertain` list. Of the five platforms only YouTube (and Facebook,
  once checked) report money to apps; TikTok, Instagram and X report none; CR reports its balance and payouts but not
  what left the balance for Whop.
- **Options.** Where the fit runs: (1) in the web (fast, but Confirm could not trust it, and the rules would live in two
  languages); (2) in the agent at render time (it knows the video, but not later changes: membership, budget, places,
  posts); (3) one pure function in the API over stored items, computed on every read, used by the Review card, Confirm,
  Try again and the remake route, with the web re-checking only what changes while he types or taps; (4) results stored
  on the clip (stale the moment a campaign or a connection changes). A normal clip that could earn: (a) turn it into a
  campaign clip in place (posts with #Ad and the paid switch), which misses "Paid partnership" on the video and the
  logo that briefs and CR's disclosure page ask for, so it would be rejected; (b) a new campaign clip of the same moment,
  re-rendered with the campaign's rules, the original left as it is; (c) only "Make new clips for this campaign" (new
  moments). Money: (i) add CR's numbers into the MRR cards (they are platform estimates by day; CR's are payouts in
  rounds); (ii) keep CR only in its own part (§38.7: two places to look); (iii) one "All your money" card with one
  30-day period: each platform's reported rows in those days and CR's paid payouts dated in those days, one total per
  currency, and plain "Not available from …" rows.
- **Decision.** (CONTRACTS §39) Option 3: `contentrewards/fit.py`, pure, from stored items only (never CR, the public
  JSON or the network), each rule an item with a state (`ok`, `fix`, `remake`, `todo`, `no`, `check`, `note`), a verdict
  (`fits`, `fixable`, `doesnt_fit`, `cant_tell`) and `canUpload`/`canRemake`; uncertain rules are "I couldn't check",
  never a pass; Confirm and Try again refuse a campaign clip with a `no`, `remake` or `todo` item, with the item's
  words. Option (b) with (c) as its fallback: `POST …/campaigns/{id}/remake` makes a one-clip campaign job from the same
  source and moment (A's campaign checks, rules snapshot and logo copy), the agent skips finding moments for it, and a
  moment can earn on one campaign only; the copy waits behind `cr_remake_enabled` (default off) until the agent's part
  has merged. Option (iii): `GET /v1/money/everywhere`, pure on the server, CR's paid payouts kept by day
  (`CRMONEY.paidByDay`, filled once for older owners by a day scan that never changes the paid total); the MRR cards
  stay platform-only. The normal way is frozen: Home's form at `/` and the Review card of a clip with no campaign keep
  origin/main's controls and taps (5 to upload), enforced by click-count tests; the campaign way always starts from a
  campaign. The Connect steps keep their order (account, accounts inside CR, Connect) with clearer words and a way back
  to the campaign he came from.
- **Consequences.** The owner sees on every Review card whether a campaign clip can earn and fixes what Clip Factory can
  fix in one tap; a clip that can't earn can't go up the campaign way. A normal clip that could earn gets one quiet
  offer and a new copy in about 3 minutes; he uploads one of the two (both on one channel could look like reused
  content, §39.6). Language and source checks are only as good as the stored source fields (`sourceLanguage`, the
  channel name); unknown is "I couldn't check". "All your money" adds an estimate (YouTube) and paid money (CR) over the
  same days, tagged as such, never across currencies; what left CR for Whop stays "not available". Additive only: new
  attributes on `JOB#`, `CLIP#` and `CRMONEY`, one api env var; no table, index, bucket, secret or Lambda changes.
