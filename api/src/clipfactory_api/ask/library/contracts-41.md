## 41. Campaign finder: campaigns that match what you want (owner request, 2026-11-21)

The owner's words: *"Also, will I be able to find campaigns and join them based on some requirements that I set if the
MCP and my connection to content rewards through Clip Factory gets accepted?"* The answer he got: Content Rewards'
official MCP server (23 tools, checked live 2026-11-21, `mcp-tools.json` of API version `2026-10-01`) has **no tool to
browse Discover and none to join or apply**, so joining stays his own tap on Content Rewards (CR). Joining also means
accepting that campaign's terms, which is his call, and driving CR's site with a robot would break Whop's no-bots
terms. What was proposed instead, and approved (*"Yes, build it"*): a **campaign finder**. He sets what he wants once;
Clip Factory reads CR's **public** campaign pages (what anyone sees logged out) a few times a day, ranks the ones that
match, tells him "3 new campaigns match", and gives each match an "Open on Content Rewards" button. He taps **Join
Campaign** there; Clip Factory adds the campaign with one tap ("I joined: add it", no copy or paste, it already knows
the link), and by itself once CR's sign-in yes has arrived (`list_my_campaigns` lists it). Decision record: ADR-65.

What this section adds, and what it leaves alone. It builds on §38 and §39 as merged and live (switched on by PR #88
and PR #93). It adds a page, `/campaigns/find`, an entry card on the Campaigns page, a chip on Home's campaigns row, one
notification, seven routes under `/v1/contentrewards/finder`, one owner item (`CRFIND`), a shared cache of public
campaign pages (pk `CRPUBLIC`) and one new action of the existing `cf-prod-campaigns` Lambda, started by the existing
`cf-prod-stats` tick. **The normal way of making clips is untouched**: Home's form at `/`, its 5 taps to upload and the
Review card of a normal clip stay exactly as on origin/main (§39.1, §39.5's click counts keep passing); Home's
campaigns row sits under the form and was never part of it. The §17.13 floating to-do list stays at exactly five rows.
§25's money rule stays: the finder shows only Content Rewards' own published numbers (pay per 1,000 views, the most a
clip can earn, the money left of the campaign's budget), tagged "Content Rewards' numbers", and never a guess of what a
clip would earn. Data is additive only (§41.5). Where this section and §38 or §39 disagree about the finder, this one
wins; every change to an earlier section is listed in §41.6 (**Changes to earlier sections**). The whole finder ships
behind its own switch, `cr_finder_enabled`, **default `false`**, turned on by one last PR (§41.6).

Facts it rests on (checked 21 Nov 2026; the raw samples are in the side-session notes `content-rewards-raw/`
(`endpoints.json`, `detail-objects.json`, `field-presence-matrix.json`) and `content-rewards-raw/finder-samples/`
(`robots-2026-11-21.txt`, `sitemap-2026-11-21.xml`, `cards-and-details.json`, four saved campaign pages)):
* `https://contentrewards.com/robots.txt` is `User-Agent: *`, `Allow: /`, `Disallow: /api/` (and `/dev/`, `/home`,
  `/onboarding`, `/partners`, `/refer`, `/session-profile`, `/book-a-demo/start`, `/confirmation`), and names
  `Sitemap: https://contentrewards.com/sitemap.xml`. So `/sitemap.xml` and `/c/campaigns/{uuid}` may be read by a
  crawler; every `/api/…` path may not. §38.10 already reads `/api/campaign/campaigns/{uuid}` only when the owner acts,
  never on a schedule; that rule stays.
* `sitemap.xml` (130 KB, no `ETag`, `Cache-Control: public, max-age=0, must-revalidate`) lists 946 URLs, of which 766 are
  `https://contentrewards.com/c/campaigns/{uuid}`, each with a `<lastmod>`; 303 changed in November 2026, 207 in
  October.
* A campaign page `/c/campaigns/{uuid}` (about 250 KB of HTML, `<meta name="robots" content="index, follow, …">`) is
  server-rendered (Next.js App Router). Its data sits in `self.__next_f.push([1,"…"])` scripts (an RSC stream) holding
  react-query's dehydrated state; two queries matter: `["campaigns","detail",uuid]`, the **same object** §38.10 reads
  as JSON (`name`, `organization`, `organizationId`, `status`, `statusReason`, `requiresApplication`, `private`,
  `showOnDiscover`, `type`, `description`, `configuration.{payoutModel, geoRates, budget, minClipViews, content,
  creator, requirement, rules}`, `metrics.budgetSpentCents`, `briefCounts` or `lockedReferences`, `launchDate`), and
  `["campaigns","discover-card",uuid]`, the Discover card (`payouts[] {platform, payoutType, rateCents,
  minPayoutCents, maxPayoutCents, amountCents}`, `platforms`, `categories[] {id, name}`, `budgetCents`,
  `metrics.{budgetSpentCents, budgetProgressBps}`, `geoPriced`, `group`, `listedAt`, `requiresApplication`). The only
  special string seen is `"$undefined"`; long texts may be `"$<hex>"` references to a `T` row of the stream.
* A removed campaign's page answers **HTTP 200** with a soft-404 body ("404 This page needs a better hook.",
  `<meta name="robots" content="noindex, nofollow, nocache">`) and no campaign query; the JSON answers 404
  `{error: {code: NOT_FOUND}}`.
* The Discover page `/c/discover` (1.5 MB of HTML) inlines only 15 cards (the "new" and "trending" rows); its full list
  comes from `/api/campaign/campaigns/discover?…` in the browser, which robots.txt disallows. So the finder never reads
  either.
* Paused, ended and out-of-budget campaigns leave Discover (help center); private campaigns open only from an invite.
  Open campaigns hide their content rules ("N rules, visible once you join") and every reference file until you join;
  application campaigns show their brief and requirements. Category is missing on some campaigns (13 of 154 in one
  listing). Some campaigns are geo-priced (`geoRates.tiers[] {label, countries, platform, rate}` and
  `geoRates.restOfWorld[] {platform, rate}`; the base `rate` can be 0); pool campaigns have no rate at all.
* CR's Terms say nothing about reading public pages; Whop's Terms forbid automated access to **Whop's** service (its
  site and apps), which this does not touch. Third-party tools already read CR's public boards. Clip Factory still
  asks CR for an official way (§41.1, "Ask Content Rewards").

### 41.1 What the owner sees

All §38.1 rules hold: kid-proof words a 6–8-year-old understands (§12.4), at most 26 words a line, one action each, no
jargon ("CPM", "budget", "API", "MCP", "scrape", "sitemap", "robots" never appear on a screen: say "per 1,000 views",
"money", "Content Rewards' pages"); **bold** = Content Rewards' own label, word for word (**Join Campaign**, **Apply**,
**Submit application**, **Hold to confirm**, **Submit clip**, **Pending review**, **Discover**); one vermilion button
per screen, everything else glass or green; no `cursor:` rule; no visible edges (soft fills only); pick-one bars are
`<Glide>`; reduced motion skips slides and confetti; WCAG AA; on phones and touch tablets the screen's vermilion is
pinned bottom right; brand text (names, brands, CR's category names) is plain escaped text, at most 300 characters,
never a link Clip Factory didn't make. "Content Rewards", never "CR", on a screen.

**Where it lives.**
* **The page** `/campaigns/find` (route `{ name: "campaigns_find" }`, matched **before** `/campaigns/{id}`, whose
  pattern would otherwise take "find"; `screens/campaigns/FindPage.tsx`, `data-help="cr-finder"`). The Campaigns tab
  stays highlighted. No new tab or sidebar item.
* **The Campaigns page** `/campaigns` gets one glass card at the top, above the paste box (`FinderEntry.tsx`,
  `data-help="cr-finder-entry"`): title "Find campaigns", one line, and a glass "Find campaigns" (→ `/campaigns/find`).
  The line: never started "Tell me what you want. I'll find campaigns that pay for it."; new matches "3 new campaigns
  match what you want." (with a small "New" chip); else "4 campaigns match what you want."; none "None match right now.
  I look 4 times a day."; stopped "You stopped finding campaigns." The card's button is the page's vermilion only in the
  §38.4 empty state where `join-find`'s "Open Content Rewards" was the vermilion (Content Rewards signed in, no campaign,
  the box empty): then "Find campaigns" is vermilion and that Open is glass (§41.6 change 1). In every other state the
  page's vermilion is unchanged (§38.4, §39.1 change 10).
* **Home's campaigns row** (`CampaignsRow.tsx`, under the form): with new matches, a first chip "3 new campaigns match"
  (`Icon` `search`, → `/campaigns/find`, `data-help="cr-finder-entry"`); the row also shows when that is its only chip.
  When the row shows anyway and the finder is on with no new match, a last chip "Find campaigns". No chip, no row
  change, while the finder is off, never started, or answered 404/503.
* **The notification** (§41.4): "3 new campaigns match what you want." opens `/campaigns/find`.
* **Settings tree**: Posting › Set up posting gains the apple `campaign-finder` "Find campaigns", leaf "Campaigns on
  Content Rewards that pay what you want.", words `["find campaigns", "campaign finder", "discover", "new campaigns",
  "requirements", "what i want", "content rewards"]`, href `/campaigns/find`.
* While `GET /v1/contentrewards/finder` answers **404** (an API before this section) or **503** (any code: Content
  Rewards or the finder switched off), the entry card, the chips and the "Find another campaign" mapping (§41.6 change
  2) are hidden, and `/campaigns/find` itself shows only "Find campaigns is coming soon to Clip Factory." with a glass
  "Your campaigns" (→ `/campaigns`).

**The page, top to bottom.**
1. Header: "Find campaigns", the line "Campaigns on Content Rewards that pay what you want. I look 4 times a day." and,
   once it has run, "Looked at 2:10 pm" with the glass "Look again now" (§41.5; while limited: "You can look again at
   2:40 pm." in place of the button).
2. **What you want** (`FinderWant.tsx`, `data-help="cr-finder-want"`, anchor `#want`). Open the first time and when the
   owner taps "Change"; otherwise folded to one summary line ("At least $1 per 1,000 views · YouTube, Instagram · Half
   the money left · Open to join") with a glass "Change". Every change saves at once (`PATCH`, 500 ms debounce; no Save
   button) and the matches update by themselves; a glass "Done" folds it. Controls, in this order:

   | Control | Kind | Choices (`FinderWant` value) | Default (chosen for him) |
   |---|---|---|---|
   | "Pays at least" + the line "for every 1,000 views" | `<Glide>` | "$0.50" (50) · "$1" (100) · "$2" (200) · "$3" (300) → `minPer1kCents` | "$1" |
   | "Where you post" | chips, many | YouTube, Instagram, Facebook, X, TikTok → `places` (`null` = "the places you set up") | `null`: the places `ready` in `GET /v1/setup`, the line "The places you set up." |
   | "Money left" | `<Glide>` | "Any" (0) · "A quarter" (25) · "Half" (50) · "Most" (75) → `minLeftPct` | "Half" |
   | "Who can join" | `<Glide>` | "Open to join" (`open`) · "Also ones I apply to" (`any`) → `access` | "Open to join" |
   | "What it's about" | chips, many | "Anything" + up to 12 of CR's categories seen in the cache, most common first → `categories` (ids) | "Anything" (`[]`) |
   | "Language" | chips, many | "Any" + English, Spanish, Portuguese, French, German, Italian → `languages` (codes) | "Any" (`[]`) |
   | "Other ways to get paid" | switch | "Also show campaigns that pay per post or share a prize." → `otherPay` | off |
   | "Tell me about new ones" | switch | "At most once a day." → `tellMe` | on |

   Under the controls, fixed (not a control): "I skip campaigns Clip Factory can't make clips for, like ones that need
   their own sound or picture on the video." The TikTok chip, until TikTok's posting audit passes (§17.4 gate
   `posting_audit: ok`): shown off and not tappable (`aria-disabled`), with the §38.4 line "TikTok: not yet. TikTok keeps
   Clip Factory's posts private until it checks the app, and private posts can't earn." A place not set up yet (not
   `ready` in `GET /v1/setup`) is shown off and not tappable, with "Set it up first." under it (matching only ever uses
   ready places, §41.3). Chips are toggle buttons (`aria-pressed`), soft-filled
   when on, at least 44 px (48 on phones). Never started: the card is open, the defaults are picked, and its vermilion
   "Find campaigns for me" (the first `PATCH`, which starts the first look) is the screen's only vermilion.
3. **The matches** (`FinderMatchCard.tsx`, `data-help="cr-finder-match"`), ranked (§41.3), 10 then "Show more" (at most
   20). One match is open at a time: the first is open when the page loads; tapping another's head opens it and folds
   the rest. **The open match carries the screen's vermilion**; the folded ones show only their head. A match, top to
   bottom:
   * Head: a round letter of the brand (no outside picture), the campaign name (two lines at most), the brand, a "New"
     chip when it is new to him (§41.4), and the access chip "Open to join" or "You apply first".
   * Pay, one row per place he posts to that the campaign pays for (STATS_ORDER): the place's mark and name and the
     server's line (§41.3): "$1.50 per 1,000 views · up to $250 a clip", "Up to $2.00 per 1,000 views · up to $1,200 a
     clip" (geo-priced), "$5.00 for each approved post", "Shares the prize money", "A monthly fee for picked creators".
   * Money left: "$2,410.10 left of $2,500" over the §38.4 soft bar and its chip ("Plenty left" under 50% used, "Half
     used" from 50%), then the grey "Content Rewards' numbers, 2:10 pm".
   * **Why it matched**, one line made by the server (§41.3): "Pays $1.50 per 1,000 views on YouTube and Instagram. 96%
     of the money left. Open to join."
   * Up to three quiet notes ("Pays less in some countries.", "It has 2 rules you see once you join.", "Also pays on
     TikTok, once TikTok checks Clip Factory."), up to three heads-ups with a warning `Icon` ("It may need its own
     sound. Clip Factory can't add one.", "This brand wants your face on camera."), and up to three "can't tell" lines
     with a question mark ("I can't tell how much money is left.").
   * Buttons, before he opened it: vermilion **"Open on Content Rewards"** (→ `https://contentrewards.com/c/campaigns/
     {uuid}`, a new tab or the system browser, `rel="noopener noreferrer"`; the same tap sends `PATCH …/matches/{id}
     {"said": "opened"}`, never awaited before the open) and the quiet "Not for me" (hides it; 8 s toast "Hidden. Undo").
   * After he opened it (`opened` set): the steps, then the vermilion **"I joined: add it"** (an application campaign:
     **"I applied: add it"**), with "Open on Content Rewards" glass and "Not for me" quiet. Open campaign: "1 Tap **Join
     Campaign**." "2 If it asks, press and hold **Hold to confirm**." "3 Come back here and tap I joined: add it."
     Application: "1 Tap **Apply**. Tick your accounts and answer the questions." "2 Tap **Submit application**." "3 Come
     back here and tap I applied: add it." If you see (folds, never numbered): a sign-in page → "Sign in with your email
     code, then tap **Join Campaign** again."; **Submit clip** → "You're in already. Tap I joined: add it."; **Pending
     review** → "You applied already. Tap I applied: add it."; "This brand has gone quiet" or "Campaign is not accepting
     applications" → "Pick another one. Tap Not for me."
   * "I joined: add it" sends `POST …/matches/{id}/add` (§41.5), shows "Adding…" on the button, then opens the
     campaign's card `/campaigns/{uuid}`, where §38.4's next step takes over ("You're in!" with confetti once when
     Content Rewards lists it; `manual` with "After each post, I'll remind you…" while Clip Factory isn't signed in;
     "Waiting for the brand" for an application). An error stays on the match with its sentence and the same button.
   * **By itself, once signed in** (Content Rewards `connected` or `read_only`): when the window or tab comes back
     (`visibilitychange`) while a match was opened in the last 2 hours, the page sends `POST …/finder/joined`; each
     campaign Content Rewards now lists is added (§41.5) and its match turns into "You're in! FaZe Clips is in your
     campaigns." with the vermilion "Make clips for this campaign" (→ `/?campaign={uuid}`) when the campaign's
     `nextStepKind` is `make_clips`, else "See what to do next" (→ `/campaigns/{uuid}`). The `cf-prod-stats` tick does
     the same within 15 minutes when the page is closed (§41.5), and the owner gets §38.11's "You're in!" notification.
4. Under the matches, one quiet line: "Open campaigns show their rules only after you join. I read them right after you
   join and tell you if a clip can earn." Then the fold **"Why not more?"**: "I looked at 154 campaigns. 4 match." and
   one line per reason with a count, most first (§41.3 `skipped`): "62 pay less than $1.00 per 1,000 views.", "31 have
   less than half the money left.", "12 don't pay for the places you post.", "9 want you to apply first.", "5 need
   something Clip Factory can't make.", "3 you said Not for me." (+ the quiet "Bring them back", `{"unhideAll": true}`).
5. Glass "Look on Content Rewards yourself" (→ `https://contentrewards.com/c/discover`, new tab).
6. **Ask Content Rewards** (only while signed in to Content Rewards, `canAskCr`; `data-help="cr-finder-ask"`): a quiet
   card "Want Clip Factory to join for you?" "Content Rewards doesn't let apps find or join campaigns yet. You can ask
   them to add it." with the glass "Ask Content Rewards" (one tap; `POST …/finder/ask`; toast "Sent. Thank you!"), then
   "You asked Content Rewards on 21 Nov." The message, written for CR's team, sits under **Show more** "What it says"
   (§41.5) and is never the visible label of anything (the §38.3 exception).
7. The quiet "Stop finding campaigns" (`{"want": {"on": false}}`, 8 s toast with Undo); stopped, the page shows "You
   stopped finding campaigns." and the vermilion "Find campaigns again" (`{"want": {"on": true}}`).

**Empty, waiting and error states** (`Finder.state`, §41.5; each says what to do next and names the button):

| State | The page says | The screen's vermilion |
|---|---|---|
| `new` | the What you want card, open, defaults picked | "Find campaigns for me" |
| `looking` (a look or a change is being worked on, ≤ 10 min) | "Looking at Content Rewards' campaigns… This takes a minute or two." (the old matches stay below, dimmed) | none |
| `ok`, the first look not finished (`looked.pending > 0`) and no match yet | "No match yet. I've looked at 120 campaigns so far. I'll look at more later today." | none |
| `ok`, no match | "No campaign matches right now. I look again 4 times a day." + glass "Change what you want" (opens the card) | none |
| `ok`, no place set up (`resolvedPlaces` empty) | "Set up a place to post first. Then I can find campaigns that pay for it." | "Set up YouTube" (→ `/settings/posting/setup/youtube?back=/campaigns/find`) |
| `down` (Content Rewards' pages didn't answer; matches from the last good look, if any, stay) | "Content Rewards didn't answer. I'll try again in a few hours." | the first match's, else none |
| `blocked` (Content Rewards stopped Clip Factory's reads) | "Content Rewards isn't letting Clip Factory look right now. Tap Look on Content Rewards yourself." | none |
| `not_allowed` (CR's robots.txt now forbids these pages) | "Content Rewards asked apps not to read its campaign pages. Tap Look on Content Rewards yourself." | none |
| `unreadable` (the page format changed) | "I can't read Content Rewards' campaign pages right now. Tap Look on Content Rewards yourself." | none |
| `off` (he stopped it) | "You stopped finding campaigns." | "Find campaigns again" |
| GET failed (network) | the shared `ErrorPanel` "Couldn't load. Tap Try again." | "Try again" |

In `down`, `blocked`, `not_allowed` and `unreadable` the matches already stored still show, with "As of Fri 21 Nov,
2:10 pm" over them.

**Step counts.** A step is one tap of his own; waiting is never a step. Getting to the page: 1 (the notification, the
Home chip or the Campaigns card). The very first time: +1 ("Find campaigns for me").

| Case | Find page → making clips | Taps |
|---|---|---|
| Signed in to Content Rewards (after CR's pilot yes) | "Open on Content Rewards" · on CR **Join Campaign** (+ **Hold to confirm** when it asks) · back to Clip Factory (its window or tab; the page adds the campaign by itself) · "Make clips for this campaign" | **2** of his own + the Join tap on CR (+ the switch back) |
| Not signed in (today: CR's pilot yes is pending) | "Open on Content Rewards" · **Join Campaign** · back · "I joined: add it" · the card's next step "Make clips for this campaign" | **3** of his own + the Join tap; while CR hides an open campaign's rules from Clip Factory, the card first asks for them once (§38.4 `rules_paste`: "Open campaign", copy, paste, "I'm in. Read these rules") |
| An application campaign | "Open on Content Rewards" · **Apply**, answer, **Submit application** · back · "I applied: add it" (then "Waiting for the brand"; "You're in!" comes by itself when signed in) | **2** of his own + CR's apply taps |

Compared with §38.2 journey B (open Discover, sort, pick, **Join Campaign**, share icon, **Copy campaign link**, Paste,
"Add campaign": 6–7 taps), the finder removes the search, the copy and the paste.

### 41.2 Reading the public list

**Where it runs.** In `cf-prod-campaigns` (§38.16: async only, 120 s, 512 MB, **no secret access**, no Content Rewards
API call), action `find` (§41.5), started by the `cf-prod-stats` tick when a look is due and by the api on the owner's
taps. One look reads once for every owner (the cache is shared: nothing about any owner is ever sent to Content
Rewards), then matches each owner. Package `api/src/clipfactory_api/contentrewards/finder/` (builder P):
`config.py` (every number below), `robots.py`, `sitemap.py`, `rsc.py`, `source.py` (the polite reader), `normalize.py`,
`match.py`, `words.py`, `run.py`.

**Exactly what is read** (nothing else, ever):

| # | URL | When | Cap | What is kept |
|---|---|---|---|---|
| 1 | `https://contentrewards.com/robots.txt` | at most once a day (when the stored copy is older than 24 h) | 64 KB, 8 s | the text (≤ 8 KB) and its read time, on `CRPUBLIC/STATE` |
| 2 | `https://contentrewards.com/sitemap.xml` (and, if it is a `<sitemapindex>`, at most 5 child sitemaps on `contentrewards.com`) | once per reading look | 4 MB each, 10 s | nothing stored: each look takes every `<url>` whose `<loc>` is exactly `https://contentrewards.com/c/campaigns/{uuid}` (the uuid in any case, kept lower-case; no query, no fragment) with its `<lastmod>`; at most 5,000 |
| 3 | `https://contentrewards.com/c/campaigns/{uuid}` | the plan below, at most 40 a look | 2 MB, 8 s | the campaign's `card` (`FinderCard`) and the §38.10 stripped `public` copy |

Every request: `GET`, one at a time, at least 1 s between the starts of two requests, `User-Agent: ClipFactory/1` (the
§38.9 agent, no owner detail), no cookie, no `Authorization`, no `Referer`, through `fetch.get` (§38.10's SSRF guard:
https only, public addresses only) with `allow` = host exactly `contentrewards.com`, port 443, **and the path allowed
by the stored robots.txt**; at most 3 redirects, each hop checked the same way (a hop elsewhere ends that read as
`FetchFail("host")`). The status and `Retry-After` of non-200 answers are taken by `source.py`'s own `opener` wrapper
around `fetch.https_open` (`fetch.py` is unchanged).

**Never read:** any `/api/…` path (the Discover listing JSON, the campaign JSON, the discover cards, `/api/geo`), not
even on Check now (the §38.10 reads on the owner's own add stay as they are); `/c/discover` and its filtered pages;
`?group=1` pages (every sibling has its own page in the sitemap); invite links; anything on Whop; any signed-in page;
`/c/api/og/…` images, banners, brand logos and reference files (the match shows a round letter; the brand picture is
copied only after he adds the campaign, §38.10); the parts of a page about other creators (`metrics.topClips`,
`metrics.topEarners`, `chartPoints` and every username are dropped while parsing and never stored or logged).

**robots.txt** (`robots.py`, pure; RFC 9309): the group whose `User-agent` matches `clipfactory` (case-insensitive),
else `*`; `Allow` and `Disallow` with `*` and `$`; the longest matching rule wins, `Allow` on a tie; an empty
`Disallow` allows all; percent-encoding compared decoded. Against the 21 Nov file: `/sitemap.xml` and `/c/campaigns/
{uuid}` allowed; `/api/campaign/campaigns/discover`, `/home`, `/home/x`, `/home?x` disallowed; `/homepage` allowed. When
the file can't be read: the stored copy is used if it is at most 7 days old; with no usable copy nothing is read that
look (`sourceState: down`). When it forbids the sitemap or `/c/campaigns/`: nothing is read (`not_allowed`) until a
daily read allows it again.

**The page parser** (`rsc.py`, pure, `queries(html) -> dict[tuple[str, ...], Any]`): take every
`self.__next_f.push([1,"…"])` string literal in document order (a JSON string literal; other push shapes ignored),
JSON-decode each, join them into one stream; split the stream into rows: `<hex id>:<json>\n` or `<hex
id>:T<hex length>,<that many UTF-8 bytes of text>` (no newline after); in every JSON row that contains `"queries"`,
walk to each `{"queries": [...]}` and keep `queryKey → state.data` for keys that are lists; then resolve strings:
`"$undefined"` → the key is absent, `"$$…"` → the literal `"$…"`, `"$<hex>"` naming a `T` row → that row's text, any
other `"$…"` left as it is (never used). The page is the campaign when `("campaigns","detail",uuid)` is there (its
`id` equal to the uuid asked for); `("campaigns","discover-card",uuid)` is optional. **Gone**: HTTP 404, or HTTP 200 with
`<meta name="robots"` containing `noindex` and no detail query (the soft-404 body). **Unreadable**: 200, no `noindex`
and no detail query (a format change).

**Normalizing** (`normalize.py`, pure, `card(detail, discover_card, lastmod, now) -> FinderCard`, golden-tested on the
15 saved pairs of `cards-and-details.json`): pay and places from the detail with A's `campaigns.pay_from_public` (so
`geoRates` become `countryRates` and `otherCountriesPer1kCents`, a `per_post` campaign's rate becomes
`perPostCents`, a pool's rows have no rate), budget with `campaigns.budget_from_public`, the toggles with
`rules.toggles` (`preApproval`, `sound` = `rules.sound.mustUseProvided`, `logoRequired`, `faceOnCamera`), access from
`requiresApplication`, `kind` from `campaigns.campaign_type(type)`; categories from the detail's
`configuration.content.contentCategories`, else the card's `categories` (each `{id, name}`, id `^[a-z0-9-]{1,40}$`,
name ≤ 40 characters, at most 6); content types from `configuration.content.contentTypes[].id` (at most 8);
`hiddenRules` = `briefCounts.contentRules` for an open campaign (null for an application one); the overlay signal and
the languages (§41.3) from the name, the description and, for application campaigns, `content.guidelines`,
`creator.description` and `rules.reviewerOnly` (that text is read here and **not stored**); `onDiscover` =
`status == "active"` and `showOnDiscover` is not `false` and neither `private` nor `organizationPrivate` is `true`.

```ts
interface FinderCard {                 // CRPUBLIC/CAMP#{uuid}.card, ≤ 6 KB; never sent to the web as it is
  uuid: string; name: string /* ≤ 200 */; brand: string /* ≤ 200 */; orgId: string | null;
  status: string; onDiscover: boolean; access: "open" | "application";
  kind: "cpm" | "per_post" | "pool" | "retainer" | "other";
  pay: CrPay[] /* §38.8, from pay_from_public */; platformsPaid: Platform[];
  budget: { totalCents: number | null; spentCents: number | null; leftCents: number | null; usedPct: number | null };
  categories: { id: string; name: string }[]; contentTypes: string[];
  toggles: { preApproval: boolean; sound: boolean; logoRequired: boolean; faceOnCamera: boolean };
  overlay: "needed" | "maybe" | null; namedLanguages: string[] /* codes */; pageLanguage: string | null;
  hiddenRules: number | null; launchedAt: string | null; listedAt: string | null; groupName: string | null;
}
```

**The plan** (`source.plan(entries, cache, matched, now, cap=40) -> list[uuid]`, pure, golden `plan_cases.json`). Only
sitemap entries whose `lastmod` is within `LASTMOD_WINDOW = 60 days` are ever read. In this order, without repeats,
until `cap`:
1. current matches of any owner whose cached read is older than `MATCH_STALE = 12 h` (at most 10), oldest read first
   (keeps money left and status fresh: CR's `lastmod` doesn't move when only the money left changes);
2. entries not in the cache, or whose `lastmod` is newer than the cached `lastmod`, newest `lastmod` first;
3. cached `ok` entries read more than `RECHECK = 3 days` ago, oldest read first.
A cached `gone` entry is read again only when its `lastmod` changes; an entry with `fails ≥ 3` likewise. An entry
gone from the sitemap counts as gone for matching (its item is left to its TTL).

**When, how often, and limits:**

| What | Rule |
|---|---|
| Scheduled look | every `RUN_EVERY = 6 h` (`STATE.nextRunAt`), started by the 15-minute `cf-prod-stats` tick: "4 times a day" |
| One look at a time | the lease `STATE.runningUntil = now + 150 s` (a conditional UpdateItem); a look that can't take it only matches its own owner from the cache |
| A look's reading | stops at `READ_DEADLINE = 100 s` after the start (the Lambda has 120 s); the matching uses what is cached by then |
| Reading looks | at most `READS_PER_DAY = 6` a day (UTC), at least `READ_GAP = 30 min` apart; a look asked for inside the gap only matches |
| Check now ("Look again now") | per owner at most once per 30 minutes and 4 times a day (api, §41.5); it reads only when the reading rules above allow, else it re-matches |
| A change to What you want | re-matches from the cache only (no reading) |
| First fill | about 300 campaigns in the window at 40 a look: a day or two; meanwhile the page says how many it has looked at |
| Most in a day | 6 sitemap reads, 240 pages (≈ 60 MB), 1 robots.txt |

**Backoff** (`STATE`, every case logged `finder.read` with the status class only, never a body):

| Answer | Then |
|---|---|
| 429 or 503 (any URL) | stop reading this look; `backoffUntil = now + max(Retry-After, 1 h)`, doubled for each look in a row that ends this way, at most 24 h |
| 403, or a 200 that is a challenge page (HTML with no `__next_f` data and no `noindex`, from the first two pages of a look) | stop; `backoffUntil = now + 24 h`; `blockedLooks + 1`; at 3 in a row → `sourceState: blocked` (tried once a day); cleared by the next good page |
| 5xx, timeout or network error on one page | skip it (`fails + 1` on its cache item); 3 such in one look → stop, backoff 1 h |
| the sitemap can't be read | no page is read this look; matching uses the cache; `sourceState: down` when the newest good read is older than 24 h |
| 5 unreadable pages in a row | stop; `sourceState: unreadable`; logged `finder.format_changed` at error |
| robots.txt forbids what is needed | `sourceState: not_allowed`, nothing read until it allows it again |

**Cache** (§41.5 data): `CRPUBLIC/CAMP#{uuid}` holds the card, its state (`ok`, `gone`, `unreadable`), `lastmod`,
`readAt`, `fails` and `ttl = readAt + 60 days`; `CRPUBLIC/PUB#{uuid}` holds the §38.10 `public.strip(detail)` copy (≤
16 KB, the shape `campaigns.apply_public` and `ids.match_campaign` take) for `ok` campaigns, so adding a match or
adopting it later needs no extra read of Content Rewards on a schedule. Matching reads only `CAMP#` items (one Query).

### 41.3 Matching and ranking (one pure function, golden cases)

`finder.match.find(cards, want, *, places, own, hidden, now) -> FindResult` (`match.py` and `words.py`, pure, no I/O):
`cards` are the cached `ok` `FinderCard`s whose uuid is in the latest sitemap (or whose read is newer than it), `want`
the owner's `FinderWant` with the defaults filled in, `places` the **resolved** places, `own` the uuids of his
`CAMPAIGN#` items, `hidden` his "Not for me" uuids. `places` = `want.places` (or, when `null`, every place) passed
through A's `gates.upload_places(want_places, all_setups(…), {})`: places `ready` on Set up posting, TikTok only while
its `posting_audit` gate is `ok`, in STATS_ORDER. `FindResult = {matches: FinderMatch[] (≤ 20, ranked), skipped: {code,
count, text}[], looked: number}`.

**Defaults** (the same literal in P's `finder/config.py` and Q's `finderapi.py`, both tested against this line):
`{"on": true, "minPer1kCents": 100, "places": null, "categories": [], "minLeftPct": 50, "access": "open",
"otherPay": false, "languages": [], "tellMe": true}`.

**Each card, in this order** (the first refusal is its `skipped` code; a card can be refused only by a fact on the
public page):

| # | Check | Refused (`skipped` code) when | Otherwise adds |
|---|---|---|---|
| 1 | already his | uuid in `own` (`own`) | |
| 2 | Not for me | uuid in `hidden` (`hidden`) | |
| 3 | on Discover | not `onDiscover` (`not_listed`, never counted on the page) | |
| 4 | Clip Factory can make it | `toggles.preApproval` (drafts first), `toggles.sound` (its own sound), `overlay == "needed"`, or content types not empty and without `clipping` (slideshows, face-only UGC) (`cant_make`) | heads-up "It may need its own sound. Clip Factory can't add one." when `sound` is a content type; "It may want its own picture on top of the video. Clip Factory can't add one." when `overlay == "maybe"`; "This brand wants your face on camera." when `toggles.faceOnCamera` |
| 5 | money left | used ≥ 95% (`budget_gone`) | |
| 6 | places | no paid place in `places` (`not_your_places`) | note "Also pays on Facebook and X." (paid places not in his list, never TikTok) and "Also pays on TikTok, once TikTok checks Clip Factory." (TikTok paid, its audit not passed) |
| 7 | how it pays | `kind != "cpm"` and not `want.otherPay` (`other_pay`) | |
| 8 | who can join | `access == "application"` and `want.access == "open"` (`apply`) | |
| 9 | pay | `kind == "cpm"` and no place of `places` with `top ≥ want.minPer1kCents` (`low_pay`) | note "Pays less in some countries." when a counted place is geo-priced |
| 10 | money left, his choice | `used_bps > 10000 − 100 × want.minLeftPct` (`budget_low`); unknown total or spent passes | can't tell "I can't tell how much money is left." when unknown |
| 11 | topic | `want.categories` not empty, the card has categories, none of them picked (`topic`) | can't tell "I can't tell what it's about." when the card has none |
| 12 | language | `want.languages` not empty and the card's `namedLanguages` not empty and none of them picked (`language`) | heads-up "Its page is in Spanish." when only `pageLanguage` is known and not picked; can't tell "I can't tell the language." when neither is known |

Numbers: `used_bps = round(10000 × spentCents / totalCents)` (CR's numbers; null when either is null or the total is
0); for a CPM place, `top` = the largest of its `per1kCents`, `otherCountriesPer1kCents` and every `countryRates[].
per1kCents` (what Discover shows as "Up to $2.00"), geo-priced when it has country rates; the "counted" places are the
places in `places` that pay (for CPM: with `top ≥ minPer1kCents`). Hidden rules: note "It has 2 rules you see once you
join." ("1 rule") for an open campaign with `hiddenRules > 0`. Notes, heads-ups and can't-tell lines keep the table's
order, at most 3 each.

**The overlay signal** (`normalize.overlay(text)`): split the text into sentences at `.`, `!`, `?` and line breaks; a
sentence with the word `overlay` or `overlays` is **needed** when it also has one of `must`, `required`, `require`,
`requires`, `need`, `needs`, `include`, `includes`, `use`, `add`, `put` and none of `no`, `not`, `don't`, `dont`,
`without`, `never` (whole words, case-insensitive); else **maybe**; no such sentence → null. (KreekCraft: "Every clip
must include KreekCraft's overlay and drive viewers back to his livestream!" → needed.) The logo is not an overlay:
Clip Factory adds logos (§38.13).

**Languages** (`normalize.languages(name, text)`): `namedLanguages` = §39.3's table through A's
`campaigns.languages_in` over the **name** only ("Split-Screen UGC [English]" → `["en"]`); `pageLanguage` = a stop-word
count over the description when it has at least 25 words, for en, es, pt, fr, de, it only (the lists live in
`config.py`, ten common words each), the winner needing at least 6 hits and 1.5 times the runner-up, else null.

**Ranking.** Sort key, smallest first: (1) `0` when the match has no heads-up and no can't-tell line, else `1`; (2)
kind: `cpm` 0, `per_post` 1, `pool` 2, `retainer` 3, `other` 4; (3) minus the best `top` over the counted places (0 when
not CPM); (4) minus `leftCents` (unknown last); (5) minus `launchedAt` (newest first; unknown last); (6) the uuid. The
first 20 are kept.

**The words** (`words.py`; integer cents, formatting only; rates always with cents "$1.50", other amounts with
`gates.money`; every line ≤ 26 words and free of the §41.1 banned words, tested):
* Pay row (`FinderPay.line`): CPM "$1.50 per 1,000 views" (geo-priced: "Up to $2.00 per 1,000 views") + " · up to
  {money(maxPayoutCents)} a clip" when known; per post "$5.00 for each approved post" + " · needs 1,000 views" when
  `minViews`; pool "Shares the prize money"; retainer "A monthly fee for picked creators"; other "Pays in its own way.
  See its page." A place under his minimum still shows its own rate (never hidden, never in the why line).
* Why line: `"{pay} on {counted places}."` + (`" {category name}."` when he picked categories and one matched) +
  (`" {100 − ceil(used_bps / 100)}% of the money left."` when known) + `" Open to join."` / `" You apply first."`, where
  `{pay}` is "Pays $1.50 per 1,000 views" (one rate), "Pays up to $2.00 per 1,000 views" (geo, or different rates:
  the highest `top`), "Pays $5.00 for each approved post", "Shares the prize money", "A monthly fee for picked
  creators", "Pays in its own way" and places are joined "YouTube, Instagram and X".
* Money left: `"{money(leftCents)} left of {money(totalCents)}"`; with `asOf` = the card's `readAt`.
* `skipped` (one per code with a count > 0, biggest first; `not_listed` never shown): `low_pay` "{n} pay less than
  $1.00 per 1,000 views." (his minimum), `budget_low` "{n} have less than half the money left." ("a quarter of the
  money" for 25, "three quarters of the money" for 75; never for 0), `budget_gone` "{n} have almost no money left.", `not_your_places` "{n} don't pay for the places you
  post.", `apply` "{n} want you to apply first.", `other_pay` "{n} pay per post or share a prize.", `cant_make` "{n}
  need something Clip Factory can't make.", `topic` "{n} are about other things.", `language` "{n} want another
  language.", `hidden` "{n} you said Not for me.", `own` "{n} are in your campaigns already." ("1 campaign pays less
  than …" etc. in the singular).

**Golden cases** (P: `api/tests/finder_cases.py` writes `api/tests/fixtures/finder/{samples.json, match_cases.json,
normalize_cases.json, plan_cases.json}`; `samples.json` is `cards-and-details.json` with `topClips`, `topEarners`,
`chartPoints` and usernames removed). Each case is `{name, want, places, tiktokOk, own, hidden, now, expect: {order,
skipped, lines}}`. With `places` = YouTube, Instagram, Facebook and X set up, TikTok's audit not passed, `now` =
2026-11-21T12:00:00Z:
* **default** → in order: CNPL Pickleball `3d9ef19f-…` ("Pays $1.50 per 1,000 views on YouTube and Instagram. 96% of the
  money left. Open to join."; note "Also pays on TikTok, once TikTok checks Clip Factory."), ENERGY DRINKS
  `e4a9465f-…` ("Pays $1.00 per 1,000 views on YouTube, Instagram and X. 98% of the money left. Open to join."; notes
  "It has 1 rule you see once you join.", the TikTok note), The Weeknd `4c7d1ede-…` (Instagram, $1.50, 83%; heads-up
  sound), 8lanco `d5d8b659-…` (Instagram, $1.00, 99%; heads-up sound; "It has 2 rules you see once you join.").
  Refused: COD DMZ, Santa Cruz, Fundingpips, Split-Screen UGC `budget_low`; ForgeGUI `budget_gone`; KreekCraft and
  TradeLens and Mack `cant_make` (overlay; slideshows; drafts first); UnGodly and Hablando `apply`; Kai Cenat
  `other_pay`.
* **also apply** (`access: any`) → UnGodly first (YouTube $1.75, 95%, "You apply first."), then the four above.
* **gaming** (`access: any`, `categories: ["gaming"]`) → UnGodly only.
* **other pay, any money** (`otherPay: true`, `minLeftPct: 0`) → Fundingpips ($6.00), Split-Screen UGC ($3.00), COD DMZ
  (Instagram $1.50), Pickleball, ENERGY DRINKS, Santa Cruz, then Kai Cenat (pool, "Shares the prize money on YouTube,
  Instagram and X."), then the two sound heads-ups.
* **$2 and up** (`minPer1kCents: 200`, `access: any`, `minLeftPct: 0`) → Fundingpips, Split-Screen UGC.
* **YouTube only** → Pickleball, ENERGY DRINKS.
* **TikTok after its audit** (`tiktokOk: true`) → COD DMZ's TikTok row is "Up to $2.00 per 1,000 views" with "Pays less
  in some countries." (still refused by `budget_low` in the default; shown with `minLeftPct: 0`).
* **English** (`languages: ["en"]`, `access: any`, `minLeftPct: 0`) → Split-Screen UGC kept (named English); Hablando
  "I can't tell the language." (6 words); a description in Spanish of 25+ words → "Its page is in Spanish.".
* **hidden** and **own** → the uuid is refused with `hidden` / `own`, and counted.
The web never decides a match; it shows the server's words.

### 41.4 Notifications

* **New matches**: one Web Push (§32) "Content Rewards" · "3 new campaigns match what you want." ("1 new campaign matches
  what you want."), url `/campaigns/find`, tag `crfind` (a new one replaces an older one), TTL 24 h, normal urgency.
* **When** (P, in `run.py`, only on a **scheduled** look, never on a start, Check now or a change, when he is looking
  anyway): `want.on` and `want.tellMe`, and at least one current match was first shown after both the last notice and
  his last visit (`shown[uuid] > max(notice.at, seenAt)`), and the last notice is at least 24 hours old (or there is
  none). Then `CRFIND.notice = {key: "{YYYYMMDDHH}:{count}", count, at}`. The first look after "Find campaigns for me"
  never sets one. **Never more than one a day.**
* **Sending** (Q, `push/notify.py`): a `MODIFY` of `CRFIND` whose `notice.key` changed, with `want.tellMe` not `false`
  and `want.on` not `false`, under the owner's existing "Content Rewards news" choice (`notify.contentRewards`, §38.11),
  deduped by `NOTIFIED#cr#finder:{key}` (2-day TTL), to his active devices.
* **Turning it off**: the switch "Tell me about new ones" on What you want (`want.tellMe`), or Settings › App & account
  › Notifications › "Content Rewards news" (which stops all Content Rewards news); "Stop finding campaigns" stops the
  looks too. In the app, "New" chips and the Home chip still say it.
* "New" (`FinderMatch.isNew`, Q): `shown[uuid] > seenAt` (no `seenAt` yet: every match is new). The page sends `PATCH
  {"seenAll": true}` 2 s after it showed the matches while visible (and again after a live refresh), so the Home chip
  and the entry card stop saying "new".

### 41.5 API, data, the job, live and mock mode

**Routes** (all JWT, §5 errors; `routes/finder.py`, rows in `routes/__init__.py`; under `/v1/contentrewards`, so
§38.8's 404/503 rule hides everything on an older or switched-off API; each also answers 503 `unavailable` "Coming
soon." unless `CR_FINDER=on`):

| Method & path | Body | 2xx response |
|---|---|---|
| GET `/v1/contentrewards/finder` | – | `Finder` (items only: `CRFIND`, the setups, his `CAMPAIGN#` uuids, `CRPUBLIC/STATE`; never Content Rewards) |
| PATCH `/v1/contentrewards/finder` | one or more of `{"want": Partial<FinderWant>}`, `{"seenAll": true}`, `{"unhideAll": true}` | `{ "finder": Finder }`. The first `want` ever creates `CRFIND` with the full defaults merged, writes `CROWNERS/USER#{id}` (§38.11, `campaigns.own`) and starts a look (`why: "start"`); a later change of `want` starts a match-only look (`why: "want"`); `unhideAll` empties `hidden` and starts one too; each sets `lookingSince` |
| POST `/v1/contentrewards/finder/check` | – | `202 { "started": true, "nextAllowedAt" }` or `200 { "started": false, "nextAllowedAt" }` ("Look again now": at most once per 30 minutes and 4 times a UTC day per owner, `CRFIND.checkNow {at, day, n}`; invokes `why: "check_now"`) |
| PATCH `/v1/contentrewards/finder/matches/{campaignId}` | `{ "said": "opened" \| "not_for_me" \| null }` | `{ "finder" }` (`opened` sets `opened[uuid] = now`; `not_for_me` adds it to `hidden` and drops it from the answer; `null` takes it out of `hidden` (the toast's Undo); 404 "That campaign isn't in your matches any more. Tap Look again now." for a uuid that is neither a stored match nor opened nor hidden) |
| POST `/v1/contentrewards/finder/matches/{campaignId}/add` | – | `201 { "campaign": Campaign }` new, `200 { "campaign" }` already added (below) |
| POST `/v1/contentrewards/finder/joined` | – | `{ "added": CampaignSummary[] }` (signed in only, else `{ "added": [] }`; one `list_my_campaigns`, cached 2 minutes per container (§38.9); at most every 30 s per owner, else `{ "added": [] }`) |
| POST `/v1/contentrewards/finder/ask` | – | `{ "askedAt" }` (one MCP `send_feedback`; 409 `conflict` "Connect Content Rewards first." when not signed in; once per 30 days: inside them, `200` with the stored `askedAt` and nothing sent) |

`want` checks (400 `bad_request` "Pick one of the choices shown." with `field`): only the nine keys; `on`, `otherPay`,
`tellMe` booleans; `minPer1kCents` ∈ {50, 100, 200, 300}; `places` `null` or a list of distinct `Platform`s; `minLeftPct`
∈ {0, 25, 50, 75}; `access` ∈ {`open`, `any`}; `categories` ≤ 12 distinct ids `^[a-z0-9-]{1,40}$`; `languages` distinct
codes of {`en`, `es`, `pt`, `fr`, `de`, `it`}.

**Add** (`finderapi.add`): the uuid must be a stored match, opened or hidden (else the 404 above). Then exactly §38.8's
`campaigns.add(deps, user_id, links.campaign_url(uuid), now)` (the owner's own action, so its one §38.10 public read is
allowed), then the brand picture as `add_campaign` does, then his answer through `routes/contentrewards.apply_said`
(the §38.8 `PATCH` logic, unchanged): an **application** campaign → `said: "applied"` (signed in and not listed yet:
`apply_first` becomes `waiting`; not signed in: the answer is kept and used once Clip Factory can look); an **open** campaign → `said: "joined_by_hand"` **only** when the
membership after the add is not `in` and Content Rewards can't look (not signed in, or `blocked`), which makes it
`manual` (§38.4); signed in and not listed yet, the membership stays `not_joined` with §38.4's checks and its quiet "I
joined, but it still says not joined". `added[uuid] = now`, `addedBy: "finder"` on the `CAMPAIGN#` item. When the public
read fails (`platform_down`) and `CRPUBLIC/PUB#{uuid}` is at most 24 hours old, the item is made from that copy instead
(the adopt path below, without a listed row). The answer is §38.8's `Campaign`.

**Adopt** (`finderapi.adopt(deps, user_id, listed, now) -> list[CampaignSummary]`, used by `…/finder/joined` and the
tick): signed in only (`connected` or `read_only`, not `blocked`). Candidates: uuids opened in the last 30 days and the
stored matches, with no `CAMPAIGN#` item and a `PUB#` copy. For each, A's `ids.match_campaign(listed, uuid, public,
use_typeid=conn.typeidVerified is not False, org_matches=conn.orgMatched is not False)`; a match (`typeid` or `name`,
never `ambiguous`) is added: first a `PutItem` of the new `CAMPAIGN#{uuid}` with `attribute_not_exists(pk)` and
`membership: "unknown"` (the same base fields as `campaigns.add`, `campaigns.apply_public(item, public, now)`,
`addedBy: "finder"`), **then** the item read back (`campaigns.get`, so it is `Loaded`),
`campaigns.check_membership(deps, user_id, item, conn, now, fresh=False)` (the list just read) and `campaigns.save` (an
UpdateItem), so the change to `in` is a `MODIFY` and §38.11's "You're in!" notification and the card's confetti happen
as for any campaign; the rules read starts there (§38.12 step 3), and `CROWNERS` is already written. At most 5 adds per
call.

**Ask** (`finderapi.ASK_MESSAGE`, literal, no personal data, URL or token): "Feature request from Clip Factory:
creators ask for MCP tools to search Discover campaigns (filters for pay per 1,000 views, platforms, category, budget
left, open or application, language) and to join an open campaign, or start an application, with the creator's
consent. Today Clip Factory reads only public campaign pages a few times a day, and the creator taps Join Campaign on
Content Rewards." Sent as `send_feedback {message, agent_name: "clip-factory", agent_version: "1"}` through the owner's
`McpClient` (§38.9; a `CrError` → 503 `platform_down` "Content Rewards didn't answer. Try again in a minute."). Sets
`askedAt`.

**`GET /v1/contentrewards`** (§38.8 overview) gains `finder?: { on: boolean; newCount: number; matches: number }`, only
while `CR_FINDER=on` and the owner has a `CRFIND` item (Home's chip and the entry card read it, so Home makes no extra
call).

```ts
interface FinderWant {
  on: boolean; minPer1kCents: 50 | 100 | 200 | 300; places: Platform[] | null; minLeftPct: 0 | 25 | 50 | 75;
  access: "open" | "any"; categories: string[]; languages: ("en" | "es" | "pt" | "fr" | "de" | "it")[];
  otherPay: boolean; tellMe: boolean;
}
interface FinderPay { platform: Platform; line: string; per1kCents: number | null; topPer1kCents: number | null;
  perPostCents: number | null; maxPayoutCents: number | null; geo: boolean }
interface FinderMatch {
  campaignId: string /* uuid */; url: string /* https://contentrewards.com/c/campaigns/{uuid} */;
  name: string; brand: string; access: "open" | "application"; kind: "cpm" | "per_post" | "pool" | "retainer" | "other";
  pay: FinderPay[] /* his places that pay, STATS_ORDER */; maxPerClipCents: number | null;
  budget: { totalCents: number | null; leftCents: number | null; usedPct: number | null; line: string | null;
            asOf: string; tag: "Content Rewards' numbers" };
  categories: { id: string; name: string }[]; why: string;
  notes: string[]; headsUp: string[]; cantTell: string[];          // ≤ 3 each, the server's words (§41.3)
  hiddenRules: number | null; launchedAt: string | null; rank: number;
  isNew: boolean; opened?: string;                                 // added by the api from CRFIND (Q)
}
interface Finder {
  state: "new" | "looking" | "ok" | "down" | "blocked" | "not_allowed" | "unreadable" | "off";
  want: FinderWant; resolvedPlaces: Platform[]; tiktokWaits: boolean;
  matches: FinderMatch[]; newCount: number; hiddenCount: number;
  skipped: { code: string; count: number; text: string }[];
  looked: { campaigns: number; pending: number };                  // pending > 0 while the first fill goes on
  categories: { id: string; name: string; count: number }[];       // for the chips, ≤ 12
  lastLookAt?: string; asOf?: string; nextAllowedAt?: string;      // Look again now
  canAskCr: boolean; askedAt?: string;
}
```

`state` (Q): `off` when `want.on` is false; `new` with no `CRFIND`; `looking` when `lookingSince` is newer than
`matchedAt` (or there is no `matchedAt`) and at most 10 minutes old; else P's `sourceState` (`down`, `blocked`,
`not_allowed`, `unreadable`) or `ok`. The answer drops matches now hidden or added and sets `isNew` and `opened`.
`resolvedPlaces` and `tiktokWaits` come from `gates.upload_places` and `gates.tiktok_waits` over the setups, so the
want card's chips and the matches agree.

**Data** (additive only: new sort keys and a new partition key value in the existing table; no index, table, bucket,
secret or Lambda is added, replaced or destroyed):

| Item | pk | sk | Attributes |
|---|---|---|---|
| Finder (one per owner) | `USER#{userId}` | `CRFIND` | `type="crfind"`, `userId`. **Written by the api (Q)**: `want`, `createdAt`, `seenAt`, `hidden` (string set, ≤ 500), `opened` (map uuid → ISO, ≤ 50, oldest dropped), `added` (map uuid → ISO, ≤ 100), `lookingSince`, `checkNow` `{at, day, n}`, `joinedAt`, `askedAt`, `updatedAt`. **Written by the look (P)**, only by UpdateItem of these names with `attribute_exists(pk)` (a look never creates the item): `matches` (`FinderMatch[]` without `isNew` and `opened`, ≤ 20), `matchedAt`, `matchedWant` (a hash), `shown` (map uuid → ISO first shown, ≤ 300, oldest dropped), `notice` `{key, count, at}`, `skipped`, `looked`, `categories`, `sourceState` |
| Page cache | `CRPUBLIC` | `CAMP#{uuid}` | `type="crpublic"`, `uuid`, `state` (`ok` \| `gone` \| `unreadable`), `lastmod`, `readAt`, `fails`, `card` (`FinderCard`, ≤ 6 KB), `ttl` (`readAt` + 60 days) (P) |
| Public copy | `CRPUBLIC` | `PUB#{uuid}` | `type="crpubliccopy"`, `uuid`, `public` (§38.10 `public.strip`, ≤ 16 KB), `readAt`, `ttl` (P; read by Q) |
| Reader state | `CRPUBLIC` | `STATE` | `type="crpublicstate"`, `robots` `{text ≤ 8 KB, readAt}`, `lastLookAt`, `lastReadAt`, `nextRunAt`, `runningUntil`, `backoffUntil`, `backoffLooks`, `blockedLooks`, `readsToday` `{day, n}`, `entries` (sitemap entries in the window), `cached`, `sourceState` (P; `nextRunAt` and `runningUntil` read by Q's tick) |
| CR owners | `CROWNERS` | `USER#{userId}` | unchanged (§38.11); Q also writes it on the first finder `PATCH` |
| Campaign | `USER#{userId}` | `CAMPAIGN#{uuid}` | + `addedBy: "finder"` (internal, Q) |

`CRPUBLIC` items never travel (the broadcast takes only `USER#` keys) and hold no owner data. TTL uses the table's
existing `ttl` attribute.

**The job** (no new Lambda, schedule, secret or grant):
* `cf-prod-campaigns` (P, `contentrewards/handler.py`): `{"action": "find", "userId"?: string, "why": "schedule" |
  "start" | "check_now" | "want"}` is handled **before** the uuid check of the other actions; it answers `{"action":
  "find", "outcome": "off"}` unless `CR_FINDER=on`. `finder.run.run(deps, user_id, why, now)`: (1) `why == "want"`:
  match that owner from the cache, nothing read. (2) else take the lease (lost: match `userId`'s owner only, or end);
  (3) read when `backoffUntil` is past, the last read is at least 30 minutes old and fewer than 6 reading looks happened
  today: robots.txt when due, the sitemap, the plan, the pages, until 100 s; (4) owners: `userId`, or every
  `CROWNERS` owner whose `CRFIND.want.on` is true; for each, the setups (`oauth.setup.all_setups`, items only), his
  `CAMPAIGN#` uuids, `match.find`, and one UpdateItem of P's attributes (and the notice for a scheduled look); (5)
  `STATE` (`lastLookAt`, `nextRunAt = now + 6 h` after a scheduled look, the counters), the lease cleared. It never
  raises: an owner's failure is logged and the next owner goes on. Its deps (`CampaignsDeps`) gain nothing but the
  existing `get` (fetch) and `clock`; it makes no MCP call and reads no secret (its fakes have none).
* `cf-prod-stats` (Q, `stats/handler.py` `_cr_tick`, after `poll.run_tick`, inside the same try): when `CR_FINDER=on`,
  read `CRPUBLIC/STATE`; when `nextRunAt` is absent or past and `runningUntil` is absent or past, invoke
  `cf-prod-campaigns` async `{"action": "find", "why": "schedule"}` through `AsyncInvoker.find(user_id=None, why)`
  (Q, `async_invoke.py`; the api uses the same with its `userId`). The existing grants cover both invokes (§38.16).
* `contentrewards/poll.py` (Q): in step 3 (membership), when the owner is signed in and `CRFIND.opened` has a uuid from
  the last 48 hours with no `CAMPAIGN#` item, `list_my_campaigns` is read even if no campaign is due (one more call,
  inside the 25), then `finderapi.adopt` with that list.

**Live** (§14.2): the broadcast (Q, `realtime/broadcast.py`) maps `CRFIND` to `{type: "contentrewards", op: "upsert",
id: "finder", partial: true}` (no new `LiveItemType`); the web's finder store refetches `GET
/v1/contentrewards/finder` (1 s debounce) on `contentrewards` events with `id: "finder"` and on a resync, and the
existing Content Rewards store refetches the overview as today. The realtime and notify stream filters gain the
prefix `CRFIND` (R; notify still `MODIFY` only).

**Mock mode** (`VITE_MOCK=1`, S, `web/src/api/mock/finder.ts`; state in `sessionStorage` `cf-mock-finder`): the seven
routes and the overview's `finder`. Fixtures from the golden samples: the four default matches, UnGodly (application,
shown with "Also ones I apply to"), Kai Cenat (pool, shown with "Other ways to get paid"), COD DMZ (geo-priced, refused
by money left until "Any"), and a `skipped` list. A look takes 3 s on the fake clock (`looking`, then `ok`).
`window.__cfMock.finder.{newMatches(n), setState(state), joinedOnCr(uuid) /* the next joined call adds it, as signed
in */, signedIn(bool), reset()}`. Mock words match the server's (§41.3).

### 41.6 Who builds what, the switch, tests, not verified live

**Builders** (each stays inside its files; each PR passes CI alone, in any order; T merges after S):

| Builder | Owns |
|---|---|
| P api-finder-reader (`feature/finder-reader`) | `api/src/clipfactory_api/contentrewards/finder/{__init__.py, config.py, robots.py, sitemap.py, rsc.py, source.py, normalize.py, match.py, words.py, run.py}` (new), `contentrewards/handler.py` (the `find` action only); tests `api/tests/{test_finder_robots.py, test_finder_sitemap.py, test_finder_rsc.py, test_finder_source.py, test_finder_normalize.py, test_finder_match.py, test_finder_run.py}` (new), `api/tests/finder_fakes.py` (new: a recording `opener`, a fake clock, a fake store), `api/tests/finder_cases.py` writing `api/tests/fixtures/finder/{samples.json, match_cases.json, normalize_cases.json, plan_cases.json}`, fixtures `api/tests/fixtures/finder/{robots.txt, sitemap.xml, sitemap-index.xml, page-open.html, page-apply.html, page-pool.html, page-geo.html, page-soft-404.html, page-changed.html, page-challenge.html}` (trimmed from `finder-samples/`: only the `self.__next_f.push` scripts and the robots meta kept; `sitemap.xml` cut to about 30 entries) |
| Q api-finder-routes (`feature/finder-api`) | `api/src/clipfactory_api/contentrewards/finderapi.py` (new: want checks and defaults, the view, add, adopt, ask, the tick check), `routes/finder.py` (new), `routes/__init__.py` (the seven rows), `routes/contentrewards.py` (the overview's `finder` key only), `contentrewards/poll.py` (the adopt hook in step 3), `stats/handler.py` (the tick check), `async_invoke.py` (`find`), `realtime/broadcast.py` (`CRFIND`), `push/notify.py` (`CRFIND` in `CR_PREFIXES`, the finder event); tests `api/tests/{test_finder_routes.py, test_finder_adopt.py, test_finder_notify.py, test_finder_tick.py}` (new, literal item shapes from §41.5, their own small fakes), updates to `test_realtime.py`, `test_cr_poll.py` (the hook), `test_cr_routes.py` (no `finder` key while off) |
| R infra (`feature/finder-infra`) | `infra/modules/contentrewards/{main.tf, variables.tf, tests/contentrewards.tftest.hcl}`, `infra/modules/api/{main.tf, variables.tf, tests/api.tftest.hcl}`, `infra/modules/stats/{main.tf, variables.tf, tests/*.tftest.hcl}` (env `CR_FINDER = var.cr_finder_enabled ? "on" : "off"` on the three Lambdas, variable default `false`), `infra/modules/realtime/{main.tf, tests/*}` and `infra/modules/notify/{main.tf, tests/*}` (prefix `CRFIND`), `infra/envs/prod/{main.tf, variables.tf, tests/wiring.tftest.hcl}` (`variable "cr_finder_enabled"`, bool, **default `false`**, wired to the three modules); and, last, the one-line switch PR |
| S web (`feature/finder-web`) | `web/src/screens/campaigns/{FindPage.tsx, FinderWant.tsx, FinderMatchCard.tsx, FinderEntry.tsx}` (new), `screens/campaigns/{CampaignsPage.tsx (the entry card, change 1), NextStep.tsx (change 2)}`, `screens/home/CampaignsRow.tsx` (the chips), `lib/finder.ts` (new: the store, 404/503 rule, debounced want, live refetch, `finderHref`), `lib/{router.ts (`campaigns_find` before `campaign`), backLink.ts (change 7), settingsTree.ts (the apple), contentRewards.ts (`findAnother`, change 2)}`, `api/{index.ts, types.ts}` (the §41.5 shapes, `CrOverview.finder?`), `api/mock/{finder.ts (new), contentrewards.ts (the overview's `finder`), index.ts}`, `app/App.tsx` (the route, the CSS import), `styles/finder.css` (new); tests `web/test/{finder.test.ts, finderPage.test.tsx}` (new), `web/e2e/finder.spec.ts` (new), updates to `backLink.test.ts`, `noGuesses.test.ts` (the new files), `settings-tree.spec.ts`, `screenshots.spec.ts` (`finder`, `finder-want` at 375 and 1440); the generated files |
| T docs and help (`docs/finder-help`) | `web/src/features/help/{helpKb.json, helpEvals.json}`: guides `cr-find` "Find campaigns that pay what I want", `cr-find-join` "I found a campaign. How do I join it?", `cr-find-why-not` "Why can't Clip Factory join campaigns for me?", `cr-find-missing` "A campaign isn't in Find campaigns", one eval question each, highlighting only S's anchors (`cr-finder`, `cr-finder-want`, `cr-finder-match`, `cr-finder-entry`, `cr-finder-ask`), synonyms "find campaigns", "campaign finder", "discover" → "find campaigns"; `docs/{ARCHITECTURE.md (a new flow, the next free number, and `cf-prod-campaigns`' row: it reads Content Rewards' public pages, never its API, and has no secret), SECURITY.md (outside pages read by a no-secret Lambda, robots.txt honoured, nothing about the owner sent, brand text plain), TESTING.md, BUSINESS_REQUIREMENTS.md (the owner's ask as an I-row), ROADMAP.md, UX_DESIGN_SYSTEM.md (the match card), DEPLOYMENT.md (the switch PR)}`; the generated files. Merge after S (its highlights must be real anchors) |

* **Shared contracts nobody changes alone**: the routes, bodies and types of §41.5; `CRFIND` and who writes which
  attribute; `CRPUBLIC` `CAMP#`, `PUB#`, `STATE` and their attributes; the `find` event and its four `why` values; the
  defaults literal of §41.3; the `skipped` codes and every server word of §41.3 (S's mock copies them); `CR_FINDER` /
  `cr_finder_enabled`; the live event `id: "finder"`; the anchors of §41.1; the notice key and the dedupe key.
* **No builder imports another's new code**: Q reads P's items by the shapes above with literal keys (never
  `contentrewards.finder`), P reads Q's `want`, `hidden`, `seenAt`, `createdAt` and `notice` the same way; both may
  import merged §38/§39 code (`campaigns`, `gates`, `rules`, `ids`, `links`, `public`, `fetch`, `oauth.setup`). Before P
  merges, Q's invoke reaches a `cf-prod-campaigns` that answers `bad_event` (harmless; the switch is off), and GET
  answers `state: "new"` / `looking`; before Q merges, P's look finds no `CRFIND` owner and only sets `nextRunAt`; S hides
  everything on 404 and 503; R only adds an env var that defaults to `off` and two filter prefixes.
* **Conflict-prone files shared with §40's builders** (PR #97): `realtime/broadcast.py`, `push/notify.py`,
  `routes/__init__.py`, `infra/modules/{realtime, notify, api}`, `infra/envs/prod`, `web/src/api/{types.ts, index.ts}`,
  `lib/{router.ts, backLink.ts, settingsTree.ts}`, `app/App.tsx`, `api/mock/index.ts`. Edits are additive rows;
  whoever merges second rebases and keeps both.
* **Generated files** (`web/src/features/help/help-corpus.json`, `docs/HELP_ASSISTANT.md`'s routes block,
  `api/src/clipfactory_api/ask/knowledge.json`, `api/src/clipfactory_api/ask/library/*.md`) are never edited by hand:
  S and T run `node web/scripts/help-corpus.mjs --write-docs` and `node web/scripts/ask-knowledge.mjs` (from `web/`);
  on a conflict, take main's copy and run both again.
* Commits end with the paragraph "Area: Campaign finder".

**The prod switch.** Every finder route answers 503 `unavailable`, the tick never invokes a look and `cf-prod-campaigns`
answers `off`, unless `CR_FINDER=on` (an unset value is off) on all three Lambdas, set by Terraform
`cr_finder_enabled` (modules and `envs/prod` default **`false`**; R's tests plan both values). After P, Q, R, S and T
have merged, one last one-line PR (owner: R) sets `envs/prod`'s default to `true` and updates `wiring.tftest.hcl`'s
expectation; setting it back to `false` turns the whole finder off again (the stored items stay). The plan of that PR
changes three env vars in place and nothing else; the deploy's delete gate must still print "Delete gate: the plan
deletes or replaces nothing that holds the owner's data."

**Changes to earlier sections** (each a change of words or a small addition; the builder named carries it out):
1. §38.4 empty state (S): while the finder answers 200, Content Rewards is signed in, he has no campaign and the box is
   empty, the vermilion is the entry card's "Find campaigns" instead of `join-find`'s "Open Content Rewards" (which
   turns glass). Every other state of §38.4 and §39.1 change 10 is unchanged.
2. §38.4, §38.6, §39.3 "Find another campaign" (S): while the overview has `finder`, every "Find another campaign"
   whose href is `https://contentrewards.com/c/discover` opens `/campaigns/find` in the same tab instead
   (`lib/finder.ts` `finderHref`, used by `NextStep.tsx`, `CampaignsPage.tsx` and `findAnother`); the server's words
   and hrefs stay as they are, and the Find page keeps "Look on Content Rewards yourself".
3. §38.4 Home's campaigns row (S): + the finder chips of §41.1; the row also shows when the only chip is "3 new
   campaigns match".
4. §38.8 (Q): `GET /v1/contentrewards` gains the optional `finder` key; seven routes under `/v1/contentrewards/finder`.
5. §38.9, §38.10, §38.16 (T, docs): "`cf-prod-campaigns` … never calls Content Rewards" → "… never calls Content
   Rewards' API and has no secret; since §41 it reads Content Rewards' public campaign pages that robots.txt allows
   (`/sitemap.xml`, `/c/campaigns/{uuid}`) for the finder". §38.10's rule for `/api/…` (only on the owner's own action,
   never on a schedule) is unchanged and now holds for the finder too.
6. §38.11 (Q, R): the broadcast and notify filters gain `CRFIND`; the "Content Rewards news" leaf becomes "You're in,
   send-now reminders, approvals, proof, money and new campaigns." (S, `settingsTree.ts`).
7. §39.1 `?back=` (S): + `/campaigns/find` → "Back to Find campaigns".
8. §38.12 step 3 (Q): the adopt hook (§41.5).
9. §38.17 (S, T): + the apple `campaign-finder` and the guides of T.

**Tests** (offline, fakes only: no AWS, no Content Rewards, no network; `cf-prod-campaigns`' fakes have no MCP client
and no Secrets client):
* **P**: robots (CR's 21 Nov file: allowed, disallowed, `$`, `*`, longest match, Allow on a tie, the `clipfactory`
  group, a stale copy used up to 7 days, none → `down`, forbidding → `not_allowed`); sitemap (a urlset, an index with
  children, only exact `/c/campaigns/{uuid}` locs, upper-case uuid lowered, a query refused, a missing `lastmod`, the
  5,000 and 4 MB caps); rsc (each trimmed page: detail and card found, `$undefined` absent, a `T` row resolved,
  `$$` unescaped, the soft 404 → gone, a changed page → unreadable, a challenge page); the reader with the recording
  opener and a fake clock: **every recorded URL is allowed by robots.txt and none contains `/api/`**, one request at a
  time, starts ≥ 1 s apart, ≤ 40 pages, the 100 s deadline, `User-Agent: ClipFactory/1` and no cookie, auth or referer
  header, a redirect off `contentrewards.com` refused, 429 with `Retry-After` → backoff (doubling, 24 h cap), 403 three
  looks in a row → `blocked`, 5xx skip and three → stop, five unreadable → `unreadable`, the 30-minute gap and 6 a day;
  the plan (`plan_cases.json`: stale matches first, new and changed newest first, rechecks, the 60-day window, gone and
  failing entries); normalize (`normalize_cases.json` for all 15 samples: pay with geo, pool, budget, toggles,
  categories, types, overlay, languages, hidden rules, `onDiscover`); match (`match_cases.json`, every case of §41.3,
  `skipped` counts, ranking ties, the 20 cap); words (each sentence of §41.3, ≤ 26 words, none of the banned words, no
  amount that isn't CR's number formatted); the run (each `why`, the lease lost, owners from `CROWNERS` with `want.on`,
  `CRFIND` only updated never created, the notice once a day, never on `start`/`check_now`/`want`, the first look never,
  `tellMe` false, one owner's failure, `STATE` counters); `handler.find` with `CR_FINDER` off → `off`.
* **Q**: every route row (503 while off; §38.8's 404/503; want checks and the defaults literal; the first PATCH →
  `CRFIND` with all defaults, `CROWNERS`, invoke `start`; a want change → invoke `want`; check limits 30 min and 4 a day;
  `said` opened, not_for_me, null, the 404; add for open/application × signed in/not → the right `said` and membership,
  `platform_down` → from `PUB#` when fresh, 404 when stale; joined: not signed in → `[]`, signed in → listed opened ones
  added as `unknown` then updated to `in` (a `MODIFY`, `celebrate: "in"`), ambiguous never added, 30 s limit, at most
  5; ask: 409 not signed in, the exact `send_feedback` payload with no personal data, URL or token, once per 30 days);
  the view (`state` precedence, `looking` 10 min, `isNew`, hidden and added dropped, `resolvedPlaces` with TikTok
  before and after its audit); the overview's `finder` (absent while off or without `CRFIND`); broadcast `CRFIND` →
  `{type: "contentrewards", id: "finder", partial: true}`; notify (once per key, dedupe, `tellMe` false, `on` false,
  `notify.contentRewards` false, the singular); the tick (invoke only when on and due and not running); the poll hook
  (only signed in, only with a recent opened uuid, inside the 25 calls).
* **R**: `terraform test`, mock providers: `CR_FINDER = "off"` by default and `"on"` with the variable on
  `cf-prod-api`, `cf-prod-stats` and `cf-prod-campaigns` (each module's exact env key set updated); `cf-prod-campaigns`
  still has no `secretsmanager` action; the realtime and notify filters include `CRFIND` (notify still `MODIFY` only);
  `envs/prod` defaults `false` and still plans with `true`; nothing replaced (the delete gate test).
* **S**, Vitest: `lib/finder.ts` (404 and 503 → hidden, the debounce, `finderHref` only for the Discover URL and only
  while on, `isNew` → chips), `FindPage` for every state of §41.1's table with its single vermilion, the open match
  holding the vermilion and moving with it, opened → steps and "I joined: add it" / "I applied: add it", "Not for me"
  with Undo, "Why not more?", the want card's controls and their `PATCH` bodies, the TikTok chip disabled, the ask card
  only signed in, `noGuesses` over the new files. **Playwright (mock mode)** `web/e2e/finder.spec.ts` at **375×812 and
  1440×900**, light and dark: never started → defaults → "Find campaigns for me" → looking → four matches; change "Who
  can join" → UnGodly first; Open (a new page opens, `opened` sent) → "I joined: add it" → the campaign card; signed
  in: `joinedOnCr` + `visibilitychange` → "You're in! …" with "Make clips for this campaign"; Home's "3 new campaigns
  match" chip and the Campaigns entry card; the notification's url; 404 and 503 hide every entry and the page says
  coming soon; §39.5's `two-ways.spec.ts` still counts 5 taps for the normal way; every new screen: no sideways scroll
  at 320–1920, no edges, targets ≥ 44 px (48 on phones), the arrow cursor only, axe contrast light and dark, reduced
  motion, the phone vermilion bottom right, Ask never over the main button.
* **T**: `node web/scripts/help-corpus.mjs --check` (every highlight is a real anchor) and `node
  web/scripts/ask-knowledge.mjs --check`.

**Local checks per builder**: P and Q `cd api && uv sync --frozen && uv run ruff check && uv run ruff format --check &&
uv run mypy src && uv run pytest -q`; R `terraform -chdir=infra fmt -check -recursive`, then `terraform init
-backend=false && terraform test` in `infra/modules/contentrewards`, `infra/modules/api`, `infra/modules/stats`,
`infra/modules/realtime`, `infra/modules/notify` and `infra/envs/prod`, and `tflint --recursive`; S `cd web && npm ci &&
node scripts/help-corpus.mjs --check && node scripts/ask-knowledge.mjs --check && npm run typecheck && npm run lint &&
npm test && npm run build && npx playwright test e2e/finder.spec.ts e2e/two-ways.spec.ts e2e/content-rewards.spec.ts
--project=chromium`; T the two `--check` commands.

**Not verified live** (each is checked at the first look in prod, read in the logs, or at the owner's first add): that
CR's firewall serves campaign pages and the sitemap to AWS addresses (else `blocked`, and the page says so); that 40
pages a look, 1 s apart, a few looks a day, is fine with CR (no published limit for pages); that `sitemap.xml` keeps
listing every public campaign page and that its `lastmod` moves when status or pay changes (the 12-hour re-read of
matches covers the money left); that the page's RSC format and the two query keys stay (CR's web app is version
2.1.435 and changes often; a change is `unreadable`, not a wrong match); a `per_post` campaign's `payoutModel` shape (no
sample); what the content type `sound` means on a campaign that also allows `clipping` (a heads-up only); the overlay
sentence rule and the page-language guess on more briefs; that a signed-in creator's campaign page shows **Join
Campaign** for open campaigns and **Apply** for application ones as the logged-out samples suggest; that
`list_my_campaigns` lists a campaign right after **Join Campaign** (else §38.4's 15-minute checks and its quiet ask
cover it); the TypeID mapping for adopting (§38.9 rule 2 covers a miss); that CR's team reads `send_feedback` feature
requests; and that CR keeps allowing these pages in robots.txt (checked every day; a change stops the finder by itself).
