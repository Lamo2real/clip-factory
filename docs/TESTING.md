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
```

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
- **Skills**: upload a `.md`, toggle on and off, view content; built-in skills cannot be deleted.
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
- **No overflow**: every screen at 320, 375, 390, 430, 768, 1024 and 1440 px. The test fails if the page scrolls
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
- Skill upload: frontmatter is parsed; a zip without exactly one `SKILL.md` is refused.
- Settings sounds ([CONTRACTS.md §15.4](CONTRACTS.md#154-api)): `PUT /v1/settings` accepts `clickSound` and
  `errorSound` from 1 to 30 and refuses 0, 31, 2.5, `"6"`, `true` and `null` with `400 bad_request` and a plain message;
  `GET /v1/settings` on settings stored without them returns 6 and 5.
- DynamoDB keys match [CONTRACTS.md §6](CONTRACTS.md#6-dynamodb-single-table-cf-prod-data-on-demand-pitr-on-streams-new_and_old_images).

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
- Skills are written to `.claude/skills/<name>/SKILL.md` (zips extracted); only enabled ones.
- Moment selection respects `clipTarget`; spares replace clips that fail the checklist.
- Required tags from the owner's notes always appear in the captions.
- Callbacks: with a `callbackId` the agent heartbeats at most every 5 minutes, sends success after the job is `ready`,
  sends `JobFailed`, `Canceled` or `Superseded` failures, ignores "callback already closed" errors, and sends nothing
  without a `callbackId`. A duplicate `process_job` for a running job is accepted and ignored.
- Vectors: finalize puts one vector per clip with the §14.6 metadata; "What worked before" queries `performed` first and
  falls back to all of the owner's clips under 3 hits; a vector error skips the section.

### Infrastructure
- `terraform validate` passes; formatting is clean.
- Cognito client: 15-minute access and ID tokens, 30-day refresh token, rotation on, SRP only.
- Flows: `publish = true`, alias `live`, `durable_config` 30 600 s (job) and 259 200 s (clip) with 14 days retention,
  `timeouts.delete = "60m"`, no destinations.
- The stream trigger has exactly one filter with the four sort-key prefixes.
- The WebSocket authorizer sets no result TTL and no payload format version; WebSocket and REST logs contain no query
  or `requestOverride` and `data_trace_enabled = false`.
- The vector index is float32, 1024, cosine with the four non-filterable keys.
- No `aws_sqs_queue`, `aws_scheduler_*` or `aws_cloudwatch_event_rule` remains.
- The outputs in [CONTRACTS.md §10](CONTRACTS.md#10-terraform-outputs-read-by-deployyml) exist with those names,
  including `ws_url`, `hooks_url`, `vector_bucket`, `vector_index`, `job_flow_alias_arn`, `clip_flow_alias_arn`.

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
7. Upload a skill in Settings, start another job and check that the clips follow it.
8. Open **Get the app** on a Mac and on Windows; download, follow the first-open hint, and check that Get the app is
   gone inside the desktop app. On an iPhone, follow the three steps.
9. Push a small change with an `Area:` line; within 5 minutes the open app (browser and desktop app) shows the update
   bar with that label; press Reload and watch it finish.
