## 48. A skipped platform shows only in Settings and Social accounts, and Clips Funded's Social accounts look like Set up posting (owner request, 2026-11-24; wins over anything above)

The owner's two asks (24 Nov, about 00:15 UTC):

1. *"if i skip on a platform setup then i dont want to see it anywhere except in settings or social accounts tab"*
   (screenshot: Clips Funded › Dashboard with "Finish setting up: 1 left · Connect X · Open setup" and "Connected
   accounts 4 of 5", after X was skipped).
2. *"can you make the social account page to look organized like this"* (screenshot: Clip Factory › Settings ›
   Posting › Set up posting: breadcrumb, title card, "4 of 5 ready" with a ring and one line, a 2-column grid of
   platform rows, each with its icon tile, name, status, "About N minutes · Free", a check or an empty circle and a
   chevron that opens the platform's own page).

ADR-94 records the decision. It supersedes §17.13's skipped rows on the floating list, §45.36 E15 for platform steps
and §45.36 E18's card columns on Social accounts.

### 48.1 Rule S (both apps, one rule)

* **Skipped** means the owner confirmed a skip and the platform is not ready. In Clip Factory, ready means ready on
  Set up posting. In Clips Funded, it means the account is `connected`.
* A skipped platform is left out of **every reminder, count, "N left" list, nudge, "connect X" link and Ask
  suggestion**.
* It shows **only** in:
  * Clip Factory › Settings › Posting › Set up posting (its card says Skipped and has Un-skip) and on its own step
    page;
  * Clips Funded › Social accounts (its row says Skipped and has Un-skip) and on its own page `/stories/connections/<p>`;
  * Clips Funded's setup wizard `/stories/setup`, which Clips Funded's nav counts as Settings (`StoriesApp` NAV
    `match: ["settings", "setup"]`).
* **Counts** ("N of M") count only the platforms that are not skipped: M = 5 − skipped. With all 5 skipped there is
  no count, only "All skipped".
* **Ready (or connected) wins over a skip**, and the skip is then dropped. A platform that was set up and later needs
  the owner comes back to the lists.
* A skip never posts anything and never turns a posting switch off. Skipping in one app never touches the other app's
  skips or accounts.

### 48.2 The skip model

**Clip Factory: no data or API change.** `Settings.setupSkipped: Platform[]` (§17.13) is saved with
`PUT /v1/settings` through `useSkips()`. Skip always asks first (`SkipConfirm`), and Un-skip is one tap.
`todoRows(setups, skipped)` still gives each platform its state, and `staleSkips` still drops a skip once the
platform is ready. New pure helpers in `web/src/lib/setupTodo.ts`:

* `listRows(rows)` gives the rows that are not skipped;
* `listCount(rows)` gives `{ ready, total }` over those rows (all 5 skipped gives `{ 0, 0 }`);
* `withoutSkipped(list, skipped)` filters a list of platforms;
* `activeSkips(setups, skipped)` gives the skips of platforms that are not ready.

`todoCount` stays as it is. Its callers use `listCount`. `app/session.tsx` exports `useSessionIfAny()`, for parts that
also render without a SessionProvider (Home in its unit test).

**Clips Funded: an existing store gets a firm meaning, with nothing to migrate.**

* **Storage.** The `skipped` field of the workspace's `ONBOARD` item, which the wizard's "Skip for now" already
  writes. Its platform keys (`youtube`, `tiktok`, `instagram`, `facebook`, `x`) are the platform skips. Every other
  step key keeps its meaning ("later", still counted as left). There is no new item, no migration and no field
  removed. The owner's stored X skip counts the moment this deploys, and nothing rewrites `ONBOARD` on deploy.
* **Writes: no new route.** Skip and Un-skip use `PATCH /v1/workspaces/{ws}/onboarding` with
  `{ "step": "<platform>", "skipped": true | false }`, the same call the wizard makes. The workspaces API is
  `ANY /v1/workspaces/{proxy+}`, so there is no Terraform change, and the `ws_routes_*.py` EXPECTED lists stay as
  they are. Skipping a connected platform is accepted, but connected wins on read, and that read drops the skip.
* **Reads:**
  * `SocialAccount.skipped: boolean` is on every SocialAccount the API returns (GET `…/social`, and the check, choose
    and app answers). It is true when the platform is in `ONBOARD.skipped` and is not `connected`.
  * `Onboarding.total: number` was the literal `11`. It is now 11 minus the platform steps whose state is
    `"skipped"`. `done` is unchanged. `steps[]` keeps all 11 steps, and a skipped platform keeps the state
    `"skipped"`.
  * `StoriesDashboard.accounts[]` leaves skipped platforms out.
  * `needsYou[]` leaves out every item whose `platform` is skipped: the account's own line, and a post that stopped
    on that platform.
  * `needsYou` hrefs for account items, and for posts that stopped on an account problem, are
    `/stories/connections/{platform}` (plain `/stories/connections` when there is no platform).
* **Stale skip dropped on read.** This is the server's version of `staleSkips`. Every read that works out the
  accounts (`list_accounts`, `accounts_shown` for onboarding and the dashboard, and the single-account answers) drops
  the platforms that are `connected` now from `ONBOARD.skipped`. The drop is one `store.put_when(...)` of the whole
  ONBOARD item, on condition that `updatedAt` is still the value it read. On `ConditionFailed` it does nothing and
  logs `ws_skips.drop_raced` at info level, and the next read tries again. Skips of other steps are kept.
* **Module** `api/src/clipfactory_api/workspaces/skips.py`: `stored(item)` (the platform keys of ONBOARD.skipped, in
  `ws.PLATFORMS` order), `effective(stored, statuses)` (stored minus the connected platforms), `mark(store, user_id,
  workspace_id, accounts, now)` (one ONBOARD read: drops stale skips and sets `account["skipped"]`) and
  `social_href(platform)`.
* **Posting is unchanged.** A skipped platform is never connected, so `publish` already refuses it
  (`validate_destination`: 409, no PUBJOB). A pytest pins this.
* **Kept apart.** Clips Funded's skips live only in the workspace's ONBOARD item, and Clip Factory's only in the
  user's Settings. Neither app reads or writes the other's.
* **Client module** `web/src/stories/skips.ts`: `PLATFORM_STEPS`, `isSkippedPlatform(step)`, `leftOf(onboarding)` (not
  done, not Done itself, not a skipped platform; `Setup.tsx` re-exports it), `socialHref(p)`, `isSocialHref(href)`,
  `skipQuestion(p)`, `skippedLine(p)` and `useSkip(ws, after?)`. `useSkip` returns `{ busy, skip, unskip }`. Each sends
  the PATCH, then calls `setOnboarding`, `refreshDashboard(ws, { fresh: true })` and `after` (the page's own reload),
  and toasts "Skipped.
  You can un-skip it here." or "{Name} is back.". A second tap while one is saving does nothing. An error is a toast in
  plain words (`friendlyMessage`), and the call resolves false.
* **Mock** (`stories/api/mock/social.ts`, `onboarding.ts`, `dashboard.ts`) does the same as the API: `markSkips` sets
  `skipped` on every account answer and drops a stale skip, and the mock gives `total`, the dashboard filters, the
  platform hrefs and `postHref(error, storyId, platform?)`.

### 48.3 Every surface that hides a skipped platform

**Clip Factory**

| Surface | File | After |
|---|---|---|
| Floating setup list and the top-right pill (§17.13) | `components/SetupTodo.tsx` | The rows are `listRows`, so a skipped row leaves the list as soon as the skip is confirmed, and the list has no Un-skip. The pill and head use `listCount` ("1/4", name "Set up posting: 1 of 4 done"); the ring never divides by 0. The list shows while a row that is not skipped is not ready. A skip from the keyboard moves focus to the next row's Set up link, and the last one to the last remaining row's Set up, never to the page behind the list. A skip that did not save moves nothing, then or later. |
| Settings › Posting › Set up posting | `screens/settings/setup/SetupList.tsx` | Still the home of skips: all 5 cards, the Skipped line with Un-skip, and Skip on unfinished cards. The title and ring read "N of M ready" with M = not skipped. With all 5 skipped, the title is "All skipped" and there is no ring. "On your screen: N of M done" uses `listCount`. |
| Review › Upload to | `screens/review/UploadTo.tsx` (skips from `useSession()`) | `missingPlaces(ready, skipped)`: "Set up X to upload there too." never names a skipped place, and goes away when only skipped places are missing. "Nothing is set up yet" stays, since it names no place. |
| Review › campaign fit | `screens/review/CampaignFit.tsx` (`skipped` prop, from Review) | `withoutSkippedNotes`: a places note for a skipped place ("X pays too. Set it up…") is hidden. A campaign that pays only on a skipped place keeps its blocker, because that is the campaign's own rule, not a reminder. |
| Home › Your followers | `screens/home/FollowersTile.tsx`, `lib/followers.ts` | `notConnected(counts, skipped)`: "Not connected: …" leaves skipped places out. With nothing connected and every app skipped (`followersTileEmpty`), the tile renders nothing. |
| Home › Money tile | `screens/home/MoneyTile.tsx` | `moneyTileLine(view, skipped)` is null with nothing connected and every app skipped, and the tile then does not show. |
| Campaigns › Find campaigns | `lib/finder.ts`, `FindPage.tsx`, `FinderWant.tsx` | `placeToSetUp(setup, skipped)` returns `Platform \| null`. A skipped place has no chip, and "Set it up first." and "Set up another place" pass over it. When only skipped places are left, the main button reads "Open Set up posting" and goes to `SETUP_LIST_PATH` (`/settings/posting/setup`). |
| A clip's page › its five stacks | `screens/clip/ClipPerformance.tsx`, `components/PlatformStack.tsx`, `lib/metrics.ts` | The page reads `activeSkips(setup, me.settings.setupSkipped)`. `calmCopy(p, row, skipped)`: a skipped place with no post (`not_posted`, `waiting_for_connection`) says only "Not posted here." (`SKIPPED_STACK`), with no "Set up X" or "Open Where clips go" link. A real post there keeps its own words (posting, numbers, a failure and Try again). TikTok's Mac row still speaks first (see below). All five stacks stay, so the lines and the fan keep their places. |
| A clip's page › its campaign fit | `screens/clip/ClipFit.tsx` (`skipped` from the page) | `ClipFit` passes `skipped` to `CampaignFit`, as Review does, and `CampaignsFold` and `WaitingClipFit` take it too. `fitSummary(f, skipped)` runs on `withoutSkippedNotes`, so "X pays too. Set it up…" is never a campaign's one line. |
| Review › caption rows with nothing set up | `screens/review/Review.tsx` | With no place ready (or not known yet), the rows are `withoutSkipped(PLATFORM_ORDER, setupSkipped)`, and the too-long check looks at the same rows, so a hidden row never blocks Upload. With all five skipped, all five rows stay. |
| Ask › suggestion chips | `features/help/compose.ts` `suggestionsFor(context, skipped)`, `HelpPanel.tsx` | With TikTok skipped, the clip page's chip is "What does Upload do?" instead of "Why is my clip private on TikTok?". |
| Ask | `api/src/clipfactory_api/ask/prompt.py` | Rule 14: `APP STATE setup[] may say a platform is "skipped": he chose to leave it out. Never suggest setting it up, never show its setup buttons, and leave it out of what is left to do, unless he asks about that platform himself.` Ask has no post or upload tool. Uploads only go to ready places, so they never target a skipped platform. |

Left unchanged on purpose:

* **Settings pages:** Auto-post's "left out" lines, the Money cards in Settings, and Get paid for one platform.
  Settings may show the platform, and a platform's own page is where the owner went on purpose.
* **A clip's own data:** Library rows and Week show that clip's real post on each place. Library's "Waiting for
  setup. Posts once these accounts are connected." names the places of a post that really waits, so it stays. A
  clip's page keeps all five stacks, but a skipped one with no post only says "Not posted here." (above).
* **The money page's app chips** (`lib/moneyDash.ts` `APPS`): the five apps a payout can come from, not a reminder.
* **TikTok on the Mac:** a skip never turns "Your Mac posts TikTok" (§47) off. If TikTok is skipped while that switch
  is on, the Mac keeps posting, and TikTok's row keeps its Post with my Mac and Turn on buttons, because that switch
  is the owner's own. Whether a TikTok skip should also pause the Mac is the owner's call; until he answers, nothing
  changes.

**Clips Funded**

| Surface | File | After |
|---|---|---|
| Dashboard › setup card (setup open) | `stories/screens/Dashboard.tsx` | The ring uses the server's `done/total`. "Still to do" is `leftOf`. |
| Dashboard › "Finish setting up: N left" | same | Uses `leftOf`. When nothing is left, there is no card. In the owner's case, X was the only step left, so the card is gone. |
| Dashboard › Connected accounts | same; server `dashboard._accounts` | The server leaves skipped accounts out, and the tile shows "N of M" with M = `items.length` (no `\|\| 5` fallback). The owner's case reads "4 of 4". With M = 0, there is no number, only "Nothing to connect." and "Open Social accounts". |
| Needs you tile and the Needs you bar | `dashboard.py` `needs_you`, `mock/dashboard.ts`, `mock/mac.ts`, `Dashboard.tsx`, `ui.tsx` `NeedsYouBar` | Skipped platforms are left out, a TikTok post the Mac stopped (§47.10) too. Account items, and posts that stopped on an account problem that is still there, link to `/stories/connections/<p>` (once that account is connected again, Fix it opens the video's Review page, §47.10's merge: `afterFix` reads a platform page the same way). `isSocialHref` replaces the `=== "/stories/connections"` checks (the "Fix it first" order, and the bar's "already on this page" check). |
| Setup wizard | `stories/screens/Setup.tsx` | The ring and intro use the server's `done/total`. The step list keeps all 11 steps. A skipped platform step is chipped "Skipped", and other skipped steps keep "Later". The panel chip reads "Skipped" for a platform step and "Skipped for now" for other steps. On a skipped platform step, the foot shows "Un-skip" instead of "Skip for now" (never disabled: a tap while it saves plays the deny sound), and a quiet Next as its way on (a connect step to do has only "Skip for now", a connected one Next). "Skip for now" on a platform step toasts "Skipped. It stays in Social accounts.". The Done step's words use `leftOf`. `firstOpen` never lands on a skipped platform. |
| Settings head "N steps left" | `stories/screens/Settings.tsx` | Uses `leftOf`. |
| Publish sheet | `stories/studio/PublishSheet.tsx` | The "Not ready to post" list leaves skipped places out. Each "Connect in Social accounts" link opens `socialHref(p)`. "No Clips Funded account is connected yet…" stays, since it names no place. |

Left unchanged on purpose: the Posts panel's "Open Social accounts" (it belongs to a post that already exists) and
the chat agents' "Open Social accounts" (it names no platform).

### 48.4 Clips Funded › Social accounts, organized like Set up posting

**Routes** (`stories/routes.ts`): a new page type `{ name: "connection"; platform: Platform; result: string | null;
ws: string | null }`.

* `/stories/connections/<p>`, where `<p>` is one of the five platforms, opens that platform's page, with `result`
  and `ws` from the query. Any other `<p>` is `not_found`.
* `/stories/connections?platform=<valid p>…` is the OAuth landing (`social_callback.landing`, unchanged on the
  server). It opens that platform's page with its `result` and `ws`, **so the OAuth return lands on the platform's
  page**.
* Anything else under `/stories/connections` is `connections`, as before.
* `storiesHref({ name: "connection", platform })` gives `/stories/connections/${platform}`, never with `result` or
  `ws`.
* In `StoriesApp.tsx`, the router has a `connection` case, the "Social accounts" NAV item has
  `match: ["connections", "connection"]`, and `fromAddress` reads `ws` on both. `TITLES.connection` is "Social
  accounts".

**The list page `/stories/connections`** (`ConnectionsScreen`, its parts in `stories/screens/SocialRows.tsx`). The
section is `st-page st-connections st-social`. From the top:

1. **Header card**: `header.st-social-head.st-glass.st-glass--hero.st-lens`, with a round glass puck holding the plug,
   the `h1.st-display` "Social accounts" (Fugaz One) and one Fraunces line, "Clips Funded's own accounts. Clip
   Factory's stay as they are."
2. **`SetupBack`**, as before, while the setup is not finished (its small dial is a test point).
3. **Progress card** `section.st-social-progress.st-glass`: an `ArcDial` (value `ready`, max `max(1, total)`, label
   and valueText "{ready} of {total} ready", centre "{ready}" over "of {total}"), the `h2.st-display` "{ready} of
   {total} ready", and one line. The line is the first that fits:
   * with total 0, the title is "All skipped", there is no ring, and the line is "Tap one to bring it back.";
   * with ready = total, "Every place is ready.";
   * when a row needs the owner, "{Name} needs you." (the first such row in order);
   * otherwise, "Tap one to set it up.".

   `ready` counts the connected accounts that are not skipped, and `total` the accounts that are not skipped (rule S).
4. **Rows**: `ul.st-social-rows` (aria-label "Your five places") in the order YouTube, TikTok, Instagram, Facebook, X.
   The grid is `repeat(auto-fill, minmax(max(min(100%, 340px), calc((100% - var(--st-space-4)) / 2)), 1fr))`: 2
   columns from about 700 px and never more (the page area is 1180 px wide at 1440), and 1 column on phones. Each
   item is `li.st-social-row-wrap.st-glass[data-platform][data-state]`, holding:
   * the link `a.st-social-row.is-{state}` to `socialHref(p)`, at least 72 px tall (48 px targets on phones). It holds
     the icon tile `span.st-social-row__mark.st-conn__mark--{p}` with a 28 px `PlatformMark`, the name
     `span.st-social-row__name.st-display`, the status chip, one short line `span.st-social-row__line` (Fraunces,
     `--st-text-soft`; on a narrow phone it wraps rather than cutting off the handle), the circle (`span.st-social-row__done`, an `--st-accent` disc with a check
     in `--st-on-accent`, when ready; else `span.st-social-row__todo`, an empty ring drawn with an inset shadow, never
     a border) and the chevron `span.st-round-btn.st-social-row__go`;
   * under a hairline of light, the **skip line**, as Clip Factory's `setup-card__skip`. A skipped row has
     `p.st-social-row__skip[data-skipped=p]` with only a quiet "Un-skip" (aria-label "Un-skip {Name}"): its line
     already says "You won't post here.", so it is said once. A row that is not ready has `p.st-social-row__skip[data-skip=p]` with "Want to do it later?" and a
     quiet "Skip" (aria-label "Skip {Name}"). A ready row has no skip line.
   * **Skip asks first**, inside the row, as `.st-sure[role=group][aria-label="Skip {Name}?"]`: bold "Skip {Name}?" and
     "You won't post there until you set it up. You can come back here any time.". "Keep it" is the main button,
     comes first and gets focus, and "Skip {Name}" is quiet. Escape means Keep it, and focus goes back to the row's
     skip line. Only the confirmed answer saves (`useSkip(ws, social.reload).skip(p)`). There is no confetti.
   * Un-skip is one tap.
   * Kid-proof: nothing is ever `disabled`. While a save is on its way, the buttons get `aria-disabled` and the deny
     sound.
5. Loading is `StLoading "Checking the accounts…"`. An error is `StError` with Try again.
6. A `connections` page that still names a valid `platform` (only one built by hand) goes to `socialHref(p)` with its
   query, replacing the address.

The list page has no orange main button: the rows are the way on.

**Row states** (`rowOf(a)`, pure, in `SocialRows.tsx`; the first rule that matches wins). `appReady(a)` is the test
PlatformCard uses (`choice === "clips" || (choice === "own" && saved)`). It lives in `SocialRows.tsx`, and
`Connections.tsx` re-exports it.

| state | when | chip (tone) | the one line |
|---|---|---|---|
| `skipped` | `a.skipped` | Skipped (plain) | You won't post here. |
| `ready` | `connected` | Ready (mint) | "Connect again soon." when `reason === "expires_soon"`; else "{accountName} · {handle}" (the handle only when it differs, the name alone without one), or "Connected" |
| `needs_you` | `needs_reconnect` | Needs you (coral) | Connect again. |
| `needs_you` | `same_as_clips` | Needs you (coral) | That's Clip Factory's account. |
| `needs_you` | `choose_account` | Needs you (sun) | Pick where to post. |
| `in_progress` | `not_connected` and `appReady` | In progress (sky) | "Connect again." when `reason === "expired"`; else "Next: connect it." |
| `not_started` | anything else | Not started (sky) | `SETUP_TIME[p]` |

`SETUP_TIME` is Clips Funded's own copy of the minutes in Clip Factory's guides, for the longest way (with its own
app): YouTube "About 20 minutes · Free", TikTok "About 40 minutes · Free", Instagram "About 25 minutes · Free",
Facebook "About 25 minutes · Free", X "About 15 minutes · Costs a little". `socialProgress(accounts)` gives
`{ ready, total, title, line }`.

**The platform page `/stories/connections/<p>`** (`ConnectionScreen`, `stories/screens/SocialPlatform.tsx`). The
section is `st-page st-connections st-social-one[data-platform]`. From the top:

1. **Breadcrumb** `nav[aria-label=Breadcrumb].st-crumbs.st-plate`: "Social accounts › {Name}". "Social accounts"
   links to `/stories/connections`, and the name has `aria-current="page"`.
2. **`SetupBack`** while the setup is not finished, so the owner keeps the way back to the setup after OAuth.
3. **Skipped note**, only while `a.skipped`: `p.st-note.st-note--sky.st-social-one__skipped` with "You
   skipped {Name}. You won't post there until you set it up." and a glass "Un-skip" (aria-label "Un-skip {Name}").
   It is not a live region (it is there when the page opens, and a button never sits inside one). Un-skip takes the
   note away, and the keyboard's place moves to the card's name (`h1.st-conn__name`, `tabindex=-1`), never to the
   page behind it. Connecting drops the skip by itself (§48.2).
4. **`DisconnectedNote`** after a Disconnect.
5. **The card**: `ul.st-conns.st-conns--one` holding `<PlatformCard headingLevel={1} …/>`. This is the card as it
   was, with its chip, the new-account line, Identity, the same-account warnings (with "Open Clip Factory"), what is
   missing, the limit notes, the choose list, the sign-in tip, "Is this your Clips Funded …?", "Set up the app" with
   its AppPart, the one main button and the "More" fold (authorization, last checked, connected, ID, Check now,
   Disconnect with its "Are you sure?", the ready developer app with its keys, "Clip Factory posts to:", Limits).
   `headingLevel` (default 2) makes the card's name the page's `h1`; until the card shows (loading, an error), an
   `h1.sr-only` with the platform's name stands in. The card's chip for a connected account says "Ready" (it said
   "Connected"), the same word as its row and the "N of M ready" card.
6. **The OAuth landing**, moved here from the list page word for word: the result sentence as a toast; for
   `connected` or `clips_meta_check`, a fresh social read, then "Connected as {name} ({handle})." and the "Is this
   your Clips Funded {place}?" ask; confetti and the success sound when the result is good; `refreshDashboard` and
   `refreshOnboarding`. Then the address is replaced with `/stories/connections/<p>`, so a reload never repeats it.
7. Loading and errors as on the list page.
8. The shell's Needs you bar: on this page, an item for this platform says "Show me", which focuses its card. An item
   for another platform says "Fix it" and opens that platform's page.

The setup wizard's connect steps keep using `PlatformCard` (`inStep`) and `useSocial`, unchanged. §45.36 E18's card
columns (`useCardColumns`) are gone: the rows grid has no masonry. The pure column helpers (`columnsFor`,
`shortestColumns`, `balancedColumns`, `pickColumns`, `emptyUnder`, `columnBottoms`) and their tests stay.

**Look** (Clips Funded's espresso, cream and orange liquid glass, styles/GLASS-CONTRACT.md):
`web/src/stories/styles/st-social-rows.css`, imported once in `styles/stories.css` after `st-connections.css`. It uses
tokens only (`--st-*`) and the radii by kind: the wrap is a surface (`--st-r-*` 20), the link a control (14), the mark
tile an inner (10), and the circles and the chevron are round. Fugaz One (`.st-display`) is for the names, titles and
big numbers, and Fraunces for the lines. Words use the on-glass inks, and `--st-accent` is only for shapes (the done
disc, the dial's arc). There are no borders (light only) and no `cursor`, and every control has a hover. The glass
wrap never moves on hover; only the link's fill changes. Nothing overflows from 320 px. Targets are 44 px (48 px on
phones). The rise-in leaves no transform behind (`backwards` fill), so the glass sits untransformed once it is in. Reduced
motion drops the rise animation, reduced transparency is honoured, and `filter` and
`backdrop-filter` are never animated.

### 48.5 Words (every new or changed string; the app is "Clips Funded")

* Clips Funded's list page: "Social accounts", "Clips Funded's own accounts. Clip Factory's stay as they are.", "{n}
  of {m} ready", "Every place is ready.", "{Name} needs you.", "Tap one to set it up.", "All skipped", "Tap one to
  bring it back.". The chips "Ready", "Needs you", "In progress", "Not started" and "Skipped". The row lines "Connect
  again soon.", "Connected", "Connect again.", "That's Clip Factory's account.", "Pick where to post.", "Next: connect
  it.", "You won't post here." and the `SETUP_TIME` lines. "Want to do it later?" / "Skip". The question "Skip
  {Name}?" / "You won't post there until you set it up. You can come back here any time." / "Keep it" / "Skip
  {Name}". "Un-skip". The toasts "Skipped. You can un-skip it here." and "{Name} is back.".
* Clips Funded's platform card: the chip of a connected account, "Ready" (was "Connected").
* Clips Funded's platform page: "Social accounts › {Name}", "You skipped {Name}. You won't post there until you set it
  up." / "Un-skip".
* Clips Funded's wizard: the chip "Skipped", the toast "Skipped. It stays in Social accounts.", the foot button
  "Un-skip".
* Clips Funded's dashboard: "Nothing to connect.".
* Clip Factory: "All skipped" (Set up posting with all 5 skipped), "Open Set up posting" (Find campaigns when only
  skipped places are left), "Not posted here." (a clip page's stack for a skipped place with no post) and Ask
  rule 14.

### 48.6 Tests

Where a test pinned behaviour that the owner's ask changes (E15 listed skipped platforms, the floating list kept
skipped rows, cards on the list page, masonry), the case was rewritten to the new rule with at least as many
assertions. Test points moved; none was dropped.

* **Clip Factory, Vitest:** `setupTodo.test.ts` (`listRows`, `listCount` with "4 of 4", all skipped, ready over a stale
  skip, when the list shows, `withoutSkipped`, `activeSkips`); `setupTodoList.test.tsx` (the confirmed Skip takes
  the row away, saves `{ setupSkipped: ["tiktok"] }`, makes the pill "0 of 4 done" and moves focus to the next row;
  Un-skip in a mounted SetupList brings it back with "0 of 5"; "0 of 4 ready"; "All skipped" with no ring and no
  floating list); `upload.test.ts`, `followers.test.tsx`, `finder.test.ts` and `crFit.test.ts` with skips (also
  `fitSummary` with a skip); `metrics.test.ts` (`calmCopy` with a skip: "Not posted here." with no link, a real post
  keeps its words); `helpCorpus.test.ts` (no chip names a skipped TikTok). Pytest
  `test_ask_parts.py::test_rules_leave_a_skipped_platform_out`.
* **Clips Funded, pytest** `test_ws_skips.py`: `skipped: false` by default and the skip and Un-skip round trip;
  connected wins and the stored skip is dropped, and a later `needs_reconnect` comes back; `total` 10 with X skipped
  and 11 with only another step skipped; the dashboard's 4 accounts, no Needs you item for a skipped platform, the
  hrefs; the owner's stored `skipped: ["x"]` at once; the two apps' skips kept apart; publish to a skipped X is 409
  with no PUBJOB; a raced drop is ignored. `test_ws_social.py`, `test_ws_dashboard.py`,
  `test_ws_ai_onboarding.py` and `test_ws_one_name.py` changed values only.
* **Clips Funded, Vitest:** `storiesSkips.test.ts` (new), `storiesSocialRows.test.tsx` (new: every `rowOf` row,
  `socialProgress`, the five rows in order, Skip asks first, Un-skip, all skipped, the redirect, the platform page
  with and without its note), `storiesRouter.test.ts`, and the platform page in place of the list in
  `storiesConnections`, `storiesConnectionsRound4`, `storiesSeparateAccounts`, `storiesSocialGlass` and
  `storiesShellRound5` (E15 rewritten: platforms and the video step skipped leaves only "Pick how videos are made";
  only platforms skipped leaves no card). Also `storiesShellMock`, `storiesStudioRound5`, `storiesDashboardGlass` ("4
  of 4", "Nothing to connect.", and `refreshDashboard(ws, { fresh: true })` waiting for a read on its way, then reading
  once more), `storiesSetup`, `storiesSetupRound4`, `storiesSettings` and `storiesStudioScreens`.
* **Playwright:**
  * `skipped-platform.spec.ts` (new) checks rule S in both apps. In Clip Factory, a skipped X leaves the floating
    list, its count, Home's followers line, Review's hint and a clip page's X stack ("Not posted here.", no link),
    after a reload too; Settings keeps it as Skipped with
    Un-skip; Clips Funded's X is untouched; and Un-skip brings it back. In Clips Funded, it plays the owner's case:
    X skipped in the setup, then Finish leaves no "Finish setting up" card, "4 of 4" and nothing about X in Needs
    you; Social accounts and X's page keep it with Un-skip; Clip Factory's X is untouched; and Un-skip brings back
    "4 of 5", its Needs you lines and "Connect X".
  * Also `setup.spec.ts`, `upload-to.spec.ts`, `setup-todo.spec.ts`, `contrast.spec.ts` and `audit-setup.spec.ts`
    (`expectMixedList`), `stories-setup.spec.ts` (round 5 E15), `stories-studio.spec.ts` (the Fix it href),
    `stories-connections.spec.ts` (rows to pages, the OAuth landing, Skip and Un-skip from a row),
    `stories-social-glass.spec.ts` (five glass rows, 2 columns at 1440 with equal heights, 1 column at 390 and 320,
    and the card glass and contrast on each platform page), and `stories-shell`, `stories-rail-room`,
    `stories-switch-place` and `stories-clips-unchanged` (with `/stories/connections/youtube`).
