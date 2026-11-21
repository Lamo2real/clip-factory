## ADR-65 Campaign finder: Content Rewards' public pages read politely, joining stays the owner's own tap

- **Context.** The owner asked (2026-11-21) whether he can find campaigns and join them by requirements he sets, once
  Content Rewards (CR) lets Clip Factory sign in. CR's official MCP server (23 tools, API version `2026-10-01`) lists
  the campaigns he joined, sends his posts and reads his money, but has **no tool to browse Discover and none to join
  or apply**; its REST API is for brands. Joining also accepts that campaign's terms, a choice only he can make. CR's
  robots.txt allows crawlers everywhere except `/api/…` and a few account pages, and names a `sitemap.xml` that lists
  every public campaign page with its `lastmod`; each campaign page is server-rendered and carries the same campaign
  object as the undocumented `/api/campaign/campaigns/{uuid}` JSON. The full Discover list comes only from
  `/api/campaign/campaigns/discover` in the browser. CR's Terms say nothing on reading public pages; Whop's Terms forbid
  automated access to Whop's own service; ADR-62 already rules out browser automation and reading `/api/…` on a
  schedule.
- **Options.** (1) Drive CR's site with a robot to search and join: against Whop's no-bots terms, it breaks on the first
  pop-up, and it would accept a brand's terms for him. (2) Wait for an official search-and-join tool: nothing for him
  today. (3) Read the `/api/…` Discover listing on a schedule: one request gives 50 campaigns, but robots.txt asks
  crawlers not to, and ADR-62 says no. (4) Read only what robots.txt allows (the sitemap, then each campaign page),
  a few times a day, one page at a time, capped, cached and backed off, from a Lambda with no secret; match his
  requirements in pure code; he joins on CR with his own tap; Clip Factory adds the campaign in one tap, or by itself
  once its sign-in sees the join in `list_my_campaigns`. (5) Only a link to CR's filtered Discover page: no match on his
  places, money left or what Clip Factory can make, and nothing to tell him when a new one appears.
- **Decision.** (CONTRACTS §41) Option 4, with option 5 kept as "Look on Content Rewards yourself" and option 2 asked
  for: a signed-in owner can send CR one fixed feature request through MCP `send_feedback` with one tap. The finder
  reads `robots.txt` once a day and honours it on every request, `sitemap.xml` once a look and at most 40 campaign
  pages a look (at least 1 s apart, 100 s at most), every 6 hours plus a rate-limited "Look again now", never more than
  6 reading looks a day, with a 429/503/403 backoff and a `blocked` state; it never reads `/api/…`, Discover, group,
  invite or Whop pages, images or other creators' data, and sends nothing about the owner (a shared cache,
  `User-Agent: ClipFactory/1`, no cookies). It runs as a new action of `cf-prod-campaigns` (no secret, no CR API call),
  started by the existing `cf-prod-stats` tick: no new Lambda, schedule, secret or grant. One pure function decides
  each match from CR's public fields only (pay per 1,000 views with geo rates, places, money left, open or apply,
  category, language) and refuses only what the public page shows (drafts first, its own sound, its own overlay,
  slideshows, almost no money left); whatever the page can't tell is said as "I can't tell…", never as a pass. Rates
  and money left are CR's own numbers, tagged so; nothing estimates what a clip would earn. At most one notification
  a day, and never right after he asked. Joining stays his tap on **Join Campaign**; "I joined: add it" uses §38's
  add with the link it already has; once signed in, a listed campaign he opened from the finder is added by itself and
  its "You're in!" comes as for any campaign. It ships behind `cr_finder_enabled` (default off) and is turned on by one
  line once every part has merged.
- **Consequences.** He finds, opens and adds a matching campaign in 2 taps of his own once signed in (3 before CR's
  pilot yes) plus CR's **Join Campaign**, with no search, copy or paste. Open campaigns still hide their rules until he
  joins, so a match can later meet a §38.4 stop; Clip Factory reads the rules right after the join and the fit check
  (§39.3) guards every upload. The first full look takes a day or two; money left can be up to 12 hours old ("as of"
  shown). The finder depends on CR's page format and on CR keeping these pages open to crawlers: a format change shows
  "I can't read Content Rewards' campaign pages right now", a robots.txt change or a block stops it by itself, and
  "Look on Content Rewards yourself" always works. Additive only: the owner item `CRFIND`, the shared cache under pk
  `CRPUBLIC` (with TTL), one env var on three Lambdas and one stream-filter prefix; nothing that holds the owner's data
  is replaced or destroyed.
