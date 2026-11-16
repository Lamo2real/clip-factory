# Testing

Everything is tested offline. No test touches a real AWS account: AWS calls are stubbed in the Python suites (the
durable functions run against a fake durable context), the web app runs against its mock API, and Terraform is checked
with `validate` without a backend and `terraform test` against a mock AWS provider.

## What runs where

| Suite | Folder | Tools | In CI ([ci.yml](../.github/workflows/ci.yml)) | Before deploy ([deploy.yml](../.github/workflows/deploy.yml)) |
|---|---|---|---|---|
| Web unit and component tests | `web/` | Vitest, Testing Library | yes | yes |
| Web type check and lint | `web/` | TypeScript, ESLint | yes | yes |
| Web end-to-end and layout tests | `web/` | Playwright in mock mode | yes | yes |
| API Lambdas | `api/` | pytest, ruff, mypy (uv) | yes | yes |
| Agent runtime | `agent/` | pytest, ruff, mypy (uv) | yes | yes |
| Infrastructure | `infra/` | `terraform fmt -check`, `terraform validate`, `terraform test` (mock provider), tflint | yes | plan and apply |
| Documentation | `docs/`, `README.md` | relative-link check, draw.io XML parse and PNG export (below) | by hand | – |
| Workflows and scripts | `.github/`, `scripts/` | actionlint, shellcheck where available | yes | – |

The exact commands are in each folder's `package.json` or `pyproject.toml` and in `ci.yml`, which are the source of
truth. The common ones:

### Web

```bash
cd web
npm install
npm run dev:mock          # the app on http://localhost:5173 with the mock API
npm test                  # unit and component tests
npx playwright install    # once, downloads the test browsers
npx playwright test       # end-to-end and layout tests (start the mock server themselves)
CF_E2E_PORT=4233 npx playwright test   # same, on another port
```

Playwright serves the mock app on port 4179 and reuses a server already on that port. If another checkout's preview
server holds 4179, set `CF_E2E_PORT` to a free port, or the tests run against the other checkout's build.

### API and agent

```bash
cd api        # or: cd agent
uv sync
uv run ruff check
uv run mypy
uv run pytest -q
```

### Infrastructure

```bash
terraform -chdir=infra fmt -check -recursive
terraform -chdir=infra/envs/prod init -backend=false && terraform -chdir=infra/envs/prod validate
for dir in infra/modules/*/; do            # every module with a tests/ folder
  [ -d "${dir}tests" ] || continue
  terraform -chdir="$dir" init -backend=false && terraform -chdir="$dir" test
done
```

### Documentation and the diagram

```bash
xmllint --noout docs/architecture/aws-architecture.drawio
/Applications/draw.io.app/Contents/MacOS/draw.io -x -f png -s 2 \
  -o docs/architecture/aws-architecture.png docs/architecture/aws-architecture.drawio
```

Re-export the PNG whenever the `.drawio` file changes (the README shows the PNG), and check that every relative link
in `docs/` and `README.md` points at a file that exists.

## What the tests must cover

### Web (Playwright, mock mode)
- **Sign-in screen**: renders, shows errors in plain English; mock mode skips it with a fake owner.
- **Main flow**: paste a YouTube link → job appears → steps advance → clips appear → open a clip → edit a caption →
  Confirm → celebration → the clip leaves Review and the badge counts down. Decline removes a clip.
- **Upload**: pick a file → progress → job created from the upload.
- **Link validation**: YouTube, Twitch and Kick are accepted; any other link is refused before a job is created.
- **Skills** (`e2e/skills.spec.ts`, every test at 375×812 and 1440×900,
  [CONTRACTS.md §18.9](CONTRACTS.md#189-mock-mode-and-tests-offline-fakes-only)):
  - *Create*: Write a skill → answer the three questions → Save skill → confetti → the skill's page → Back → the row
    with **Always used**. A duplicate name shows the hint under the first question. Uploading a `.md` still works.
  - *Read*: open the fixture skill: its heading is rendered, `<script>alert(1)</script>` is visible as text and never
    runs, the `javascript:` link is not a link; there is no `role="switch"` on the Skills branch or any skill page
    (Sounds and Motion keep their own switches); a built-in has no Edit or Delete. The page shows no slug and no
    "About this skill" box, a first heading that repeats the title is left out, and rows and pages say where a skill
    came from in words, never ".md", ".zip" or "KB".
  - *Update*: Edit → change → Save changes → the new text shows; the description box grows to show every saved word. After `window.__cfMock.bumpSkillVersion(id)`, Save
    shows the conflict sheet; **Use the newest** reloads the form, **Save mine anyway** saves. A zip's **Replace the
    whole file** works. Reloading `/edit` by its address works; Back goes up one level; leaving with changes asks
    "Leave without saving?".
  - *Delete*: the sheet is near-solid (its white tint and the 0.4 ink scrim are checked) → Delete → the row is gone →
    Undo → the row is back and no request was sent; Delete again → after 8 s the mock `DELETE` ran. Back during the
    Undo shows "You just deleted this skill", and Undo brings it back.
  - *Upload clash*: uploading a file whose name is already used shows the upload words ("… To change it, open it and
    tap Replace the whole file." or, for a built-in, "… Change the name inside your file, then upload it again.").
  - `overflow.spec.ts` covers `/settings/clip-making/skills`, `/new`, `/{id}` and `/{id}/edit` at 320, 375, 600, 768,
    1024, 1440 and 1920 px; `settings-tree.spec.ts` finds "write a skill" under Add a skill; `screenshots.spec.ts`
    takes the skill pages (`settings-skill`, `settings-skill-written`, `settings-skill-new`, `settings-skill-edit`,
    `settings-skill-edit-zip`) and the `settings-skill-delete-sheet` at 375 and 1440 px, light and dark.
  - Vitest: `markdown.ts` (HTML shown as text, `javascript:` not a link, images not loaded, and a crafted heading line
    with 8,000-space runs parses in under 50 ms),
    `skillName.ts` (same examples as the API's `slug` and `humanize`), the router for the three skill pages and bad
    ids, and a grep that fails if anything in `web/src` uses `dangerouslySetInnerHTML`.
- **Settings**: clip range limits (1–10, min ≤ max), sound and reduce motion switches persist.
- **Settings tree** ([UX-14](BUSINESS_REQUIREMENTS.md#ux-14-settings-organised-like-a-field-of-apple-trees)):
  - `/settings` shows the four trees with their apple counts; each tree page shows its branches; every branch of
    [CONTRACTS.md §15.1](CONTRACTS.md#15-settings-as-a-tree-and-choosing-your-click-sounds-owner-request-2026-11-16)
    opens by its address directly (a fresh page load) and after a reload, with the right title and breadcrumb.
  - Every setting the app has appears in exactly one branch (a unit test over the tree data: no duplicates, no
    setting missing, every branch has at least one apple, every apple has a leaf or is marked as needing none).
  - Breadcrumb parts are links and go to their level; the phone Back button goes one level up; browser Back returns
    to the previous level.
  - Old addresses: `/settings#skills` (and each old anchor) lands on its branch; `/get-app` shows the install card.
  - Below 1024 px there is no folder panel; at 1024 and 1440 px the panel shows the whole tree, folders open and close
    with a click and with the Left and Right keys, the current branch has `aria-current="page"`, and the open folders
    are the same after a reload. A blocked `localStorage` still renders the panel.
  - **Find a setting**: "click" finds Click sound under `Look & feel › Sounds`; "COOKIES" finds the YouTube cookies;
    picking a result opens the branch with that apple highlighted and in view; a nonsense word shows "No setting
    called that. Try another word."; Escape clears; the keyboard can move through results.
  - With the app installed (standalone), Get the app is gone from the tree and search, and `/settings/app/get-the-app`
    says "You already have the app." with a way back.
  - No overflow at every width from 320 px, at most one tomato button per screen, axe clean, on the field, every tree
    and every branch.
- **Accounts**: every platform shows "Not connected"; Connect explains it arrives in the next phase.
- **Navigation**: below 768 px a bottom tab bar with icons only (no visible text, every item has an `aria-label`);
  from 768 px a sidebar that collapses with the hamburger and remembers the choice.
- **No overflow**: every screen at 320, 375, 390, 430, 768, 1024 and 1440 px; `/clips/{id}` and
  `/library?view=week` also at 600 px (the page's own breakpoint). Screenshots of both pages at 375 and 1440 px, light
  and dark. The test fails if the page scrolls
  sideways or any element's `scrollWidth` is larger than its `clientWidth` (except elements that are meant to scroll,
  which are marked).
- **Sounds** ([UX-09](BUSINESS_REQUIREMENTS.md#ux-09-two-click-sounds-never-on-scroll)): a click on an enabled
  control plays the chosen click sound; a click on a disabled control or an error toast plays the chosen error sound;
  a scroll or swipe plays nothing; the Sounds switch silences both. A fresh account plays click 6 "Water drop" and
  error 5 "Nope nope nope". (The audio layer is spied on, nothing is actually played.)
- **Sound picker** ([UX-15](BUSINESS_REQUIREMENTS.md#ux-15-pick-your-click-and-error-sounds)):
  - The Sounds branch shows 30 cards under "When it works" and 30 under "When it can't", numbered 1–30, with the
    names and feels of the [catalog](UX_DESIGN_SYSTEM.md#the-sound-catalog); cards 6 and 5 carry the "Pick" badge on a
    fresh account.
  - Tapping a card plays that recipe (the spy sees its id), moves the "Pick" badge and `aria-pressed` to it, and sends
    `PUT /v1/settings` with the new `clickSound` or `errorSound`; after a reload the pick is still there. A failed save
    puts the old pick back and says so.
  - After a new pick, clicking any other button in the app plays the new sound with no reload.
  - "Try it: Sign in" plays the click sound and shows "Signed in"; with Make it fail on, it plays the error sound,
    shakes (not with reduced motion) and shows "Wrong password. Try again."
  - With Sounds off: the "Sounds are off" note and "Turn sounds on" button appear, tapping a card picks it and plays
    nothing; "Turn sounds on" turns sound back on.
  - Cards are buttons reachable by keyboard, at least 48 px tall on phones, and do not overflow at 320 px with the
    longest names ("Nope nope nope", "Mini trombone").
- **Sound catalog** (Vitest): exactly 30 click and 30 error entries, ids 1–30 in each group with no gaps, names unique
  in a group and equal to the owner's picker page, every voice well formed (tone: a known wave, positive frequencies,
  `at` ≥ 0, `length` > 0, `0 < peak ≤ 0.5`; noise: a known filter type), every sound ends within 0.5 s; id 6 is
  "Water drop" and error id 5 is "Nope nope nope"; an unknown id falls back to the default.
- **Accessibility**: an axe scan on each screen reports no serious or critical issues.
- **PWA**: the manifest and service worker are served; the service worker never caches `/config.json`,
  `/version.json`, `/downloads/manifest.json` or API calls.
- **Get the app** ([BR-15](BUSINESS_REQUIREMENTS.md#br-15-get-the-app-matched-to-the-device),
  [BR-16](BUSINESS_REQUIREMENTS.md#br-16-never-offer-the-app-once-it-is-installed)): with emulated user agents, Mac
  shows "Download for Mac" pointing at the `.dmg`, Windows "Download for Windows" at the `.exe`, iPhone the three
  steps and no download, Android "Install app"; a manifest without the Mac file shows the browser install instead;
  standalone display mode, `navigator.standalone`, `window.__CF_DESKTOP__`, a `ClipFactoryDesktop` user agent and
  `cf.installed=1` each hide the sidebar item, card and banner; "Not now" hides the banner for 30 days.
- **Update bar** ([BR-17](BUSINESS_REQUIREMENTS.md#br-17-update-bar-what-is-new-and-a-reload-button),
  [UX-12](BUSINESS_REQUIREMENTS.md#ux-12-reload-that-feels-fast-and-fun)): a mocked `/version.json` with another
  version shows the bar with its area pills (and nothing when the version matches); "Later" hides it; Reload reaches
  about 75 % at 0.8 s, never goes backwards, ends at 100 % and reloads; it reloads by 10 s even if the service worker
  never answers; reduced motion fills without sparkle; the bar does not overflow at 320 px with three long labels.
- **Live updates** ([NFR-13](BUSINESS_REQUIREMENTS.md#nfr-13-live-updates), Vitest): reconnect backoff 1, 2, 4, 8,
  16, 30 s with a fresh token per attempt; each event type merges into the right screen cache; `partial` and a
  reconnect refetch; polls run only while disconnected (every 30 s while live); no `wsUrl` means polling only; no
  error toast for a dropped socket.
- **Like clips that did well** ([BR-18](BUSINESS_REQUIREMENTS.md#br-18-like-clips-that-did-well-while-reviewing)): the
  strip shows mock similar clips and is hidden when the list is empty; no overflow from 320 px.
- **Clip performance page** (`e2e/performance.spec.ts`, [BR-19](BUSINESS_REQUIREMENTS.md#br-19-see-how-a-clip-did-on-each-platform),
  [BR-20](BUSINESS_REQUIREMENTS.md#br-20-numbers-that-refresh-by-themselves-and-a-refresh-button),
  [UX-16](BUSINESS_REQUIREMENTS.md#ux-16-the-performance-page-the-video-on-top-smooth-lines-to-five-stacks)):
  - A Library card opens `/clips/{id}`; Back returns to Library; a kept clip on Review shows "See how it does".
  - Five stacks in the order YouTube, TikTok, Instagram, Facebook, X, each with only its own metric labels (no
    "Saves" on TikTok, no "Impressions" on Instagram or Facebook); a missing number is not shown as 0; the crown sits on
    the mock's best platform.
  - Refresh numbers → spinner → the numbers change when the mock pushes a `post` event → "Next check in" appears; a
    tap while every platform must wait plays the error sound and shows the toast saying when.
  - Each calm state (Waiting for connection, Not posted, Posting, Posted privately, no numbers yet, Failed) shows its
    words and its link goes to the right Settings branch or Review.
  - The Best this week star toggles (`aria-pressed`) and survives a reload.
  - Lines: five `path`s exist; at 1440 px every line ends within 2 px of its stack's top centre; at 800 px the row-2
    lines do not cross any row-1 card; at 375 px there is one trunk and five branches; with reduced motion
    `getAnimations()` is empty.
- **This week** (`e2e/week.spec.ts`, [BR-21](BUSINESS_REQUIREMENTS.md#br-21-pick-the-best-clips-of-each-week-so-the-next-clips-are-cut-better)):
  the tab opens `/library?view=week`; clips are sorted by views; ‹ goes to the previous week and › is off on the current
  one; starring sends exactly one `PUT …/best` after the 800 ms debounce; "Learning from your picks…" turns into the
  learning text after the mock `learning` event; an empty week shows "No clips this week yet. Make clips on Home."
- **Performance units** (Vitest): `lib/week.ts` (2026-01-01 is 2026-W01, 2027-01-01 is 2026-W53, weeks start on
  Monday, clock-change weeks are 167 and 169 hours); the Bézier builder `PerfLines.paths(layout, rects)` for the three
  layouts; compact numbers ("1.2K", "–" for null, "1:05"); status → words; live merge of `post` and `week` events.
- **Settings `coming_soon`**: `/settings?account=youtube&status=coming_soon` shows "Connecting YouTube arrives soon."
- **Kid-proof** ([UX-13](BUSINESS_REQUIREMENTS.md#ux-13-kid-proof-a-68-year-old-can-use-it)): at most one tomato
  button per screen (plus the update bar's Reload); every button on phones is at least 48 × 48 px; every button except
  the phone tab bar has visible text; Throw away shows Undo and sends nothing until 8 s pass; Undo restores the clip.

### Scripts
- `scripts/release-areas.sh`: `Area:` lines win over the folder map; the folder map uses the longest prefix; no match
  gives `["Improvements"]`; no previous version gives `["First release"]`; at most three labels, duplicates removed,
  each 1–3 words.

### API (pytest)
- Every route in [CONTRACTS.md §5](CONTRACTS.md#5-http-api-api-gateway-http-api-v2--lambda-cf-prod-api): success
  shape, validation errors (`bad_request`), missing items (`not_found`), wrong state (`conflict`), sizes (`too_large`),
  `501 not_implemented` for Connect.
- The user id comes from the JWT claims, never from the body; one user cannot read another's items.
- Job create and retry invoke the job flow's **alias** ARN with `InvocationType="Event"`, the exact
  `DurableExecutionName` (`job-{jobId}-{run}`) and a deterministic payload; `DurableExecutionAlreadyStartedException`
  is a no-op; a failed invoke leaves the job `failed` with "Could not start. Press Try again."
- Confirm rules ([CONTRACTS.md §14.5](CONTRACTS.md#145-durable-function-cf-prod-clip-flow-terraform-module-flows)):
  `review` writes the clip and one post per enabled platform in one transaction and starts `clip-{clipId}-1`;
  `pending` starts again with the same name; `started` and `posted` are no-ops; `failed` starts `clip-{clipId}-2`;
  `declined` is `409 conflict`.
- Decline deletes the clip's video, cover and vector, and still succeeds when the vector delete fails.
- `GET /v1/clips/{id}/similar` drops the clip itself, filters by user and `performed`, returns at most 5 sorted by
  similarity, and returns `[]` on any vector error.
- The vendored boto3 exposes `invoke(..., DurableExecutionName=...)`, the `send_durable_execution_callback_*` calls and
  the `s3vectors` client; `vectors.embed_text` matches the shared fixture the agent also tests.
- Skill upload: frontmatter is parsed; a zip without exactly one `SKILL.md` is refused, and so is a zip with a
  password-locked member or a member packed with anything but stored or deflate (`400`, on upload and on edit, so the
  API and the agent accept the same zips).
- Skills CRUD ([CONTRACTS.md §18](CONTRACTS.md#18-skills-full-create-read-update-delete-every-ai-call-uses-every-skill-owner-request-2026-11-16)):
  `slug` and `humanize` examples (accents, emoji only, an 80-character title); the written `SKILL.md` reads back with
  the same name, description and form; the limits (title 0 and 61, description 2 and 1025, instructions 50,001, a body
  over 256 KB and a file over 1 MB → `413`); a form edit of a `.zip` answers `413` only for a size limit and `400` for
  any other zip problem (a stored locked zip → `400`, never `500`); a name used by a built-in or another skill → `409`
  with `field: "title"` and the web's words (the form says "Pick another name."; an upload says "To change it, open it
  and tap Replace the whole file." or, for a built-in, "Change the name inside your file, then upload it again."),
  renaming a skill to itself is fine; editing an `.md` keeps its other frontmatter, editing a `.zip` keeps every other file byte for byte;
  replacing with another skill's upload key → `400`, `.md` → `.zip` is allowed; a stale `version` → `409`, the new
  file deleted and the old one kept; an old item without `version` saves as version 1; built-in `PUT`/`DELETE` →
  `409`; `PATCH` → `400` "Skills are always used now, so there is no switch."; the list has no `enabled`, puts
  built-ins first then the owner's by name, and deletes old choice items; `DELETE` removes every saved file; the
  detail has `form`, `formBlocked` and `files`.
- Every AI call uses every skill: `skills_block` order, the 40,000-character cut, the 120,000 budget cut (only when
  ≥ 2,000 characters are left), the list of skills left out, the empty block, the `skills.block` counts log, and the
  shared golden file `tests/fixtures/skills_block_golden.txt` byte for byte; `load_skills` reads each file once (a
  second call reads S3 zero times), skips oversize, missing and denied files, and raises after 3 retries;
  `distil_learning` and `ask_week` send the block as `system[0]` (a built-in and an owner skill, legacy
  `enabled: false` items included) and the task prompt last, with a cache point only from 8,000 characters;
  `test_skills_everywhere.py` fails on any `.converse(` outside `learn.converse_text`, any `converse_text(` without
  `skills=`, an alias of `.converse` or `.invoke_model` (used without calling it), a model method named in a string
  (`getattr(b, "converse")`), `getattr` / `attrgetter` / `methodcaller` with a computed name, `converse_text` used
  without calling it, an `invoke_model` that is not the Titan call (`modelId=self.embed_model_id`) in
  `vectors.py`, and any `converse_stream`, with a failing sample for each; the build zip contains
  `builtin_skills/*/SKILL.md`.
- Settings sounds ([CONTRACTS.md §15.4](CONTRACTS.md#154-api)): `PUT /v1/settings` accepts `clickSound` and
  `errorSound` from 1 to 30 and refuses 0, 31, 2.5, `"6"`, `true` and `null` with `400 bad_request` and a plain message;
  `GET /v1/settings` on settings stored without them returns 6 and 5.
- DynamoDB keys match [CONTRACTS.md §6](CONTRACTS.md#6-dynamodb-single-table-cf-prod-data-on-demand-pitr-on-streams-new_and_old_images).

- Clip performance ([CONTRACTS.md §16.2](CONTRACTS.md#16-clip-performance-stats-refresh-and-weekly-best-owner-request-2026-11-16)):
  always five platforms in STATS_ORDER with the status mapping; totals treat null as 0; the best platform's tie goes to
  the earlier platform; snapshots are read newest first (at most 500, so a long history keeps its newest points), put
  back in time order, then downsampled to at most 60 points and keep the last one; 404 for `review`,
  `declined` and another owner's clip; internal fields (`statsId`, `refreshStartedAt`, `statsDueAt`, `gsi2*`,
  `revision` and the rest) never appear.
- Refresh: `too_soon` honours `nextRefreshAt`, `blocked` honours `blockedUntil`; `private`, `not_connected`,
  `not_posted`; one async invoke with only the started post ids; a failed invoke rolls the claim back and answers
  `blocked` with "Could not check right now. Try again in a minute."; the Instagram and Facebook notes are present.
- Weeks: a bad week id or `from`/`to` gives 400; a clip's week is its first `postedAt`, else `decidedAt`; sort order;
  more than 10 picks or a clip from another week gives 400; the same picks give 200 and no invoke; the transaction sets
  `best`/`bestWeek` and clears unpicked clips; `revision` goes up by one; the learn invoke payload.
- `learn_week`: a superseded revision writes nothing; vectors get `best` true/false and the run survives vector errors;
  empty picks delete the old learning; `max_tokens`, `refusal`, `content_filtered` end `failed`; the learning id is
  reused on a re-save; Converse uses `maxTokens 4000`, effort low and no temperature.
- The broadcaster maps `WEEK#` to `week` events; the Lambda zip contains `clipfactory_api/config/platforms.json`.

### Stats poller (`api/tests/test_stats*.py`, pytest)
Recorded platform answers live in `api/tests/fixtures/stats/` (YouTube `videos.list` and Analytics, TikTok video
query, Instagram media, Facebook video insights and post views, X posts lookup). No test reaches a network.
- `config.load` validates the repository's `config/platforms.json` (all five platforms, the values in
  [§16.4](CONTRACTS.md#164-configplatformsjson-read-by-terraform-and-by-the-code-copied-into-the-zip)); `interval_for`
  gives the right tier at 47 h, 49 h, 8 days and 31 days.
- Each adapter builds the exact URLs and bodies with its batch size (51 YouTube ids → 2 requests, 21 TikTok → 2,
  101 X → 2), X drops the non-public fields for posts 30 days or older, and the recorded answers map to `PostMetrics`
  (milliseconds → seconds, missing → absent, never `impressions` for Meta, X views from the video's `view_count`).
- Limits: YouTube `quotaExceeded` → blocked until 08:00 UTC; TikTok 429 → 1 minute; Instagram 80002 with
  `estimated_time_to_regain_access` → blocked and **no retry**; a BUC header at 75 % → blocked; X 429 → until
  `x-rate-limit-reset`; the X monthly cap; two reservations at once over the limit → one is blocked.
- The tick reads only due posts, respects `STATS_TIME_BUDGET_SECONDS`, writes metrics, `statsDueAt` and `gsi2sk`,
  writes snapshots by the rules (60 min, 1 % change, final), and removes `gsi2` at 30 days; YouTube insights are read
  only every 360 minutes and slow values are kept between reads.
- Phase 1: with no account every adapter answers `not_connected` and makes zero HTTP calls; a manual refresh always
  clears `refreshStartedAt`, even on errors; the handler never raises on expected errors; the clip flow's `metrics` step
  uses `refresh_posts` and falls back to stored numbers when blocked; publishing writes the stats fields (a private
  TikTok post gets no `gsi2`).

### Durable flows (`api/tests/test_flows.py`, pytest)
A `FakeDurableContext` runs each `step` at once and records its name, records each `wait` and its duration, and hands
out callbacks whose `result()` returns or raises a preset `CallbackError`.
- **Job flow**: success → `finish`; timeout or missed heartbeat → `fail` with "The agent stopped responding. Press
  Retry." and `stop-session`; `JobFailed` → the agent's message; `Canceled` and `Superseded` → no write; a job that is missing,
  has another `sessionId` or is terminal → `start-agent` skips and the flow ends `superseded` (already `running` with
  this `sessionId` → no second invoke, the flow waits); every write is fenced on
  `sessionId`.
- **Clip flow**: only `pending_integration` posts → outcome `not_posted` with no wait; a queued post is published once
  even when its step is replayed; exhausted retries mark only that post `failed`; the wait is named `wait-48h` and lasts
  48 hours; distil outcomes (`max_tokens`, `refusal`, `content_filtered`, `no_learning`) write no Learning; the vector is
  upserted with `performed` and the performance JSON.

### Live updates and webhooks (pytest)
- **Authorizer**: accepts a token signed with the fixed test RSA key in `tests/fixtures/jwks.json`; rejects a wrong
  `iss`, `client_id` or `token_use`, an expired token, a bad signature and an unknown `kid`; never logs the token.
- **`cf-prod-ws`**: `$connect` stores the connection with a 2-hour TTL, `$disconnect` removes it (with and without the
  authorizer context), `ping` answers `pong`, anything else answers `bad_request`.
- **Broadcast**: coalesces to the last change per item, maps sort-key prefixes to event types, sends deletes from
  `OldImage`, removes a connection on `GoneException`, switches to `partial: true` over 24 KB, and never includes
  internal fields.
- **Hooks**: Meta challenge (right token 200, wrong 403), YouTube challenge, TikTok and X 501, POST stores a `HOOK#`
  item with a 14-day TTL, 413 over 256 KB, OAuth callback 302 to `/settings?account=…&status=coming_soon`, unknown
  platform 404, the query string is never logged.

### Agent (pytest)
- `/ping` answers `Healthy` when idle and `HealthyBusy` while a job runs; `/invocations` accepts `process_job`,
  `cancel` and `health`.
- Each pipeline step with stubbed yt-dlp, ffmpeg, Transcribe and Bedrock: step statuses, progress and heartbeats are
  written; failures produce a plain message.
- Skills are written to `.claude/skills/<name>/SKILL.md` (zips extracted): every built-in and every owner skill, also
  rows with `enabled: false`; old choice items are ignored; built-ins first, then the owner's by name.
- Every AI call uses every skill: each fake Converse request from the moment fallback, the facecam check, the
  checklist and the captions has `system[0].text` starting with `<owner_skills`, and exactly one `<owner_skills` per
  request; the Agent SDK prompt file starts with the block; after a cache-point `ValidationException` the call is
  retried without it and cache points stay off; a skipped skill is counted in the `analyze` message; the shared golden
  file matches byte for byte; `test_skills_everywhere.py` fails on any model call that goes around `Bedrock`'s helpers
  or `sdk_options(..., skills=)` (only the Titan `invoke_model` in `vectors.py` is allowed), and is as strict as the
  API's scan: a model method named in a string, `getattr` / `attrgetter` / `methodcaller` with a computed name, and an
  alias of `.converse`, `.structured`, `.detect_layout`, `sdk_options` or the SDK's `query` (used without calling it;
  `functools.partial(..., skills=)` is allowed) all fail, with a failing sample for each.
- Skill zips: `extract_zip` uses the API's rules on every member (`__MACOSX` included): over 20 MB, over 500 entries
  (folders count), unsafe names (`..`, absolute, backslash, drive letter), links, password-locked members, packing
  other than stored or deflate, over 50 MB unzipped, not exactly one `SKILL.md`, a `SKILL.md` more than one folder deep
  or over 1 MB are all refused; one 30 MB member in a zip under 20 MB is accepted, as in the API.
- Moment selection respects `clipTarget`; spares replace clips that fail the checklist.
- Required tags from the owner's notes always appear in the captions.
- Callbacks: with a `callbackId` the agent heartbeats at most every 5 minutes, sends success after the job is `ready`,
  sends `JobFailed`, `Canceled` or `Superseded` failures, ignores "callback already closed" errors, and sends nothing
  without a `callbackId`. A duplicate `process_job` for a running job is accepted and ignored.
- Vectors: finalize puts one vector per clip with the §14.6 metadata and `best: false`; "What worked before" queries
  `best` first, then `performed`, removes duplicates, keeps at most 8, falls back to all of the owner's clips under 3
  hits, and labels `best` hits "Owner's pick: best of the week"; a vector error skips the section.
- Learnings brief: up to 4 week learnings first under "The owner's best-of-week picks taught", then up to 10 others
  under "Learnings"; empty groups are left out.

### Infrastructure
- `terraform validate` passes; formatting is clean.
- Cognito client: 15-minute access and ID tokens, 30-day refresh token, rotation on, SRP only.
- Flows: `publish = true`, alias `live`, `durable_config` 30 600 s (job) and 259 200 s (clip) with 14 days retention,
  `timeouts.delete = "60m"`, no destinations.
- The stream trigger has exactly one filter with the five sort-key prefixes (`JOB#`, `CLIP#`, `POST#`, `LEARNING#`,
  `WEEK#`).
- The WebSocket authorizer sets no result TTL and no payload format version; WebSocket and REST logs contain no query
  or `requestOverride` and `data_trace_enabled = false`.
- The vector index is float32, 1024, cosine with the four non-filterable keys.
- No `aws_sqs_queue` or `aws_scheduler_*` remains; the only `aws_cloudwatch_event_rule` is `cf-prod-stats`.
- Stats ([CONTRACTS.md §16.9](CONTRACTS.md#169-terraform-module-inframodulesstats-wired-in-envsprod)): the rule is
  `rate(15 minutes)`, derived from `config/platforms.json` (a test override with every interval at 30 gives
  `rate(30 minutes)`); its target and the Lambda permission's source ARN; `cf-prod-stats` retries 0 and event age 900 s,
  `cf-prod-learn` retries 1; the IAM statements are exactly those of §16.9 (no Bedrock or S3 Vectors on stats); the API
  has `STATS_FUNCTION_ARN`, `LEARN_FUNCTION_ARN` and may invoke both; `gsi2` exists with projection ALL; alarms exist for
  both functions.
- Skills ([CONTRACTS.md §18.8](CONTRACTS.md#188-infra-infra)): `cf-prod-clip-flow` and `cf-prod-learn` each have
  exactly the `Skills` statement (`s3:GetObject` on `skills/*`, no wider S3 access, no `s3:ListBucket`);
  `cf-prod-learn` has `MEDIA_BUCKET`; `cf-prod-stats` still has no S3 access at all.
- The outputs in [CONTRACTS.md §10](CONTRACTS.md#10-terraform-outputs-read-by-deployyml) exist with those names,
  including `ws_url`, `hooks_url`, `vector_bucket`, `vector_index`, `job_flow_alias_arn`, `clip_flow_alias_arn`,
  `stats_function_name`, `learn_function_name`, `stats_rule_name`, `stats_tick_minutes`.

## Manual checks after the first deploy

1. Sign in with the temporary password and set a new one.
2. Add a short public YouTube video; watch the steps; review the clips.
3. Watch a job from a second device: steps and clips appear on both within a couple of seconds (live updates).
   Turn the network off and on: the app catches up by itself with no error.
4. Keep one clip; it shows "Waiting for the account connection" on each platform. In the Lambda console, the
   `cf-prod-clip-flow` durable execution `clip-<clipId>-1` ends with outcome `not_posted`.
5. Open `{hooks_url}/hooks/youtube?hub.mode=subscribe&hub.topic=https://www.youtube.com/xml/feeds/videos.xml%3Fchannel_id%3Dx&hub.challenge=hello`
   in a browser: it answers `hello`.
6. Install the app on a phone and on a desktop; scroll a long list on the phone and confirm there is no sound.
   Open Settings › Look & feel › Sounds, pick another click sound on the phone, and check the desktop plays it too
   after its next settings load. Find a setting by typing "sound".
7. Write a skill in Settings › Clip making › Skills (for example "Every caption ends with GG"), start another job and
   check that the clips, hooks and captions follow it. In CloudWatch Logs, the agent's `skills.block` line counts it.
   Edit it, read it back, delete it and Undo, then delete it for good.
8. Open **Get the app** on a Mac and on Windows; download, follow the first-open hint, and check that Get the app is
   gone inside the desktop app. On an iPhone, follow the three steps.
9. Keep a clip and open it from Library: five stacks read "Waiting for connection" with a link to Accounts; Refresh
   numbers answers without calling any platform. In CloudWatch Logs, `/aws/lambda/cf-prod-stats` shows a `stats.tick`
   line every 15 minutes. In Library › This week, star the clip: "Learning from your picks…" turns into a "Best of
   week" learning within a minute or two.
10. Push a small change with an `Area:` line; within 5 minutes the open app (browser and desktop app) shows the update
   bar with that label; press Reload and watch it finish.
