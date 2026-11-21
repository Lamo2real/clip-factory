## ADR-62 Content Rewards: the official sign-in through the desktop app's loopback door, sending from the cloud, a reminder when it can't

- **Context.** The owner joins paid clipping campaigns on Content Rewards (CR) and wants Clip Factory to follow each
  campaign's rules and send every clip so it can earn, in at most 5 steps per campaign, kid-proof from setup to
  getting paid. A post earns only if it is sent within 30 minutes of going live, from an account linked inside CR,
  and only once, to one campaign. The local app tried this with browser automation in a signed-in Chrome: 9 Shorts
  posted on an $8,500 campaign, 0 of 7 links sent (a declined application it could not read, a pop-up over the page,
  TikTok drafts with no public link). Whop's terms ban scrapers and CR's older clipper terms banned automated
  posting. Since October 2026 CR has an official MCP server with a person's OAuth sign-in (a pilot) whose
  `create_my_submission` sends your own post "the same as the creators app", but its OAuth server only takes
  `http://localhost` / `127.0.0.1` redirects (no https), its refresh token is single use and rotates (two refreshers
  end the connection), it lasts 30 days unused and 90 days at most, and any request with an `Origin` header gets 403.
- **Options.** (1) Browser automation of contentrewards.com (the local app's way): breaks on the first pop-up, can't
  tell a declined application, against Whop's terms. (2) The undocumented public JSON for everything: read only, no
  way to submit, robots.txt disallows it for crawlers. (3) CR's REST API: brand and agency keys only, not for a
  clipper. (4) The official MCP sign-in, with the redirect landing on a one-shot `127.0.0.1` listener in the owner's
  desktop app, the code exchanged and every token kept by the cloud, and every MCP call made by Lambda. (5) The same
  sign-in run entirely on the Mac (tokens and calls in the desktop app): phone uploads could not send while the Mac
  sleeps, and the 30-minute window would depend on the Mac being on. (6) No sign-in: after each post, remind the
  owner to paste the link himself.
- **Decision.** (CONTRACTS §38) Option 4 with option 6 as the fallback. Clip Factory registers itself with CR (RFC
  7591, `client_name` "Clip Factory", five fixed loopback redirects `http://127.0.0.1:47811–47815/`, no secret); the
  desktop app's narrow `cr_connect_*` commands (app origin only) open the door for at most 5 minutes, open CR's
  sign-in in the system browser, take only `?code&state` (the state must match the URL it opened), show "Done, go
  back to Clip Factory" and hand the code to its own page, which posts it to the API at once (the code lives 60 s).
  The API exchanges it with PKCE S256 (the verifier derived from the signed state, never stored) and keeps the token
  only in Secrets Manager (`cf-prod/platforms/contentrewards/token`, created at runtime under the existing prefix and
  grants), refreshed under the §17.6 lease so exactly one process ever uses a refresh token. The clip flow sends each
  campaign post right after it is live and public (`idempotency_key` = the post id), retries every minute until 25
  minutes after posting, then stops; `cf-prod-stats` follows membership, reviews, views and money on its 15-minute
  tick. When sending is not possible (no sign-in, the pilot refused the write scope, an older campaign closed to apps,
  or the 25 minutes ran out) the owner gets a notification "Send this to Content Rewards now (N min left)" that opens
  the clip with Copy link and Open campaign. No browser automation anywhere; the public campaign JSON is read only to
  preview a card, rate-limited and cached. Claude turns the brief into rules (the local app's RULES_SCHEMA, ported);
  pay, budget, status and platforms come only from CR's own fields; pure-code gates (the local `ruleCheck.js`) decide
  the stops. Campaign clips go up public, never made for kids, with paid partnership on where the platform's API has
  it, "#Ad" first in the caption, the required tags, "Paid partnership" on screen for 3 seconds and the logo in the
  band above the picture. CR is a separate connection, never a sixth `Platform`, and money from CR is shown only as CR
  reports it (§25 extended).
- **Consequences.** The owner signs in on the Mac once and again at least every 90 days (a week's warning); after
  that everything runs in the cloud, so a phone upload is sent too. CR's pilot may refuse the write scope at first:
  then Clip Factory reads campaigns and money and reminds him after each post, and the setup card offers the ready
  email to CR support. The alpha API can change: the client tolerates unknown fields and values, a daily keep-alive
  shows breakage early, and unexpected errors go to CR through `send_feedback`. TikTok campaign clips wait for
  TikTok's audit (private posts can't earn). Instagram and Facebook carry the disclosure in the caption and on the
  video only. Additive only: new sort keys (`CRCONN`, `CRSTATE#`, `CAMPAIGN#`, `CRSUB#`, `CRMONEY`, `CROWNERS`), new
  attributes, a new media prefix `campaigns/`, runtime secrets, one new Lambda `cf-prod-campaigns`, two widened
  stream filters; nothing that holds the owner's data is replaced. One signed desktop release ("Restart now").
