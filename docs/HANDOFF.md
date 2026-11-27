# Handoff

This page lets any Claude session, on any account, pick up the work. The standing rules are in
[CLAUDE.md](../CLAUDE.md); read that first. This page says where things stand, what is still open, how to do the
recurring jobs, and what was built this week. Written 24 Nov 2026, about 19:30 UTC.

Private notes (which account owns what, the owner's Mac, session ids) are kept outside this public repo, on the
owner's Mac, at `~/projects/clips/progress/HANDOFF-PRIVATE.md`. A session on that Mac can read them there; anywhere
else, ask the owner for them. Never copy them in here.

## Where things stand

- **Everything requested is merged to main and live.** main is at #206 ("iPhone: no band under the clock"). Its ci,
  deploy and desktop runs passed. There are no open pull requests.
- **Clip Factory** makes clips, posts them to YouTube, Instagram, Facebook and X, and learns from the numbers.
  Content Rewards, the campaign finder, Get paid and Ask as a full assistant are live.
- **Auto-posting** is on: every 6 hours, 1 clip per run, Practice off
  ([CONTRACTS §46](CONTRACTS.md#46-auto-posting-the-oldest-clips-in-review-go-up-by-themselves-every-x-hours-owner-request-2026-11-22)).
  Don't change it without the owner.
- **TikTok goes through the owner's Mac.** TikTok's review of the developer app has been pending since 21 Nov 2026.
  Until it is approved, an unaudited app can only post to private accounts, so the
  [TikTok Mac helper](../mac/tiktok-helper/README.md) posts instead
  ([CONTRACTS §47](CONTRACTS.md#47-your-mac-posts-it-on-tiktok-owner-request-2026-11-22),
  [ADR-86](DECISIONS.md#adr-86-no-manual-tiktok-sheet-the-mac-is-the-only-way-to-tiktok-until-tiktok-approves-the-app)).
  Version 1.3.0 is installed and running as @lamo.clips. Saved-login holds clear themselves. Campaign and paid clips
  get TikTok's branded-content label
  ([ADR-96](DECISIONS.md#adr-96-campaign-and-paid-clips-post-tiktok-through-the-mac-with-tiktoks-label)).
- **Clips Funded** is live with its own accounts: characters, sounds, cartoon cars, series folders, the night-drive
  look (the default), Write it myself (the owner's own script, made word for word) and TikTok through the same Mac
  to @clips.funded only.
- **Open issue #200** ("Nightly CI failed"). #203 fixed both causes. Close it once the next nightly full run
  (02:17 UTC) is green.
- **Ask's always-included pack** is at about 109,400 of its 110,000-token cap. See the follow-ups.

## Open owner questions

1. **Write it myself: show "what we'll draw" first?** Should it show a scene-by-scene confirmation before making the
   video? Recommended: yes. The rules-based word reader (`stories/agent/src/lamostories_agent/own_words.py`) can
   never cover all of English, and every review round found new phrasings.
2. **Set up posting bar:** should the "Set up posting" glass bar also leave the top when the page scrolls?
3. **iPhone green band:** if the iPhone still shows a green band at the top, the owner should remove the Home Screen
   app and add it again from Safari. iOS keeps the old status-bar style until then.
4. Older owner choices, no answer yet: GitHub Pro (more CI jobs at once; a billing choice), and the YouTube Partner
   Program steps (two-step sign-in and AdSense, for both channels).

## Watch: not seen live yet

- **The first labelled TikTok post** (a campaign or paid clip through helper 1.3.0). Check `events.log` for
  "posted", then the label in TikTok Studio, then its Content Rewards submission on Campaigns.
- **The first Clips Funded TikTok post through the Mac.** Whether the owner finished the one-time Clips Funded login
  on the Mac is not confirmed ([the step](../mac/tiktok-helper/README.md#the-owners-one-time-step-after-merge-and-deploy-on-his-command)).
- **Content Rewards' answer** to a link the Mac posted.
- **Auto-posting's Private test run** (a hidden Facebook draft Reel), CONTRACTS §46.14.
- **The first clip with a spoken take** (CONTRACTS §55). Check the agent log for the voice line; if Polly is refused,
  the clip is text-only and the job still finishes. Also look at the take's box on a real frame.
- **YouTube Shorts views.** Since 21 Nov new Clip Factory Shorts get very few views, while older ones got about a
  thousand. The posts are healthy. Likely causes: posting in bursts and reused-content signals. Advice for the owner:
  space posts out, never re-upload. Your take (own commentary on every clip, CONTRACTS §55) now ships; watch whether
  views recover.

## Follow-ups

- **Tidy Ask's pack** before it hits the cap. Shorten the owner-facing words (SETUP_POSTING.md, the business
  requirements sections, the help guides) rather than raising the cap, which would be a CONTRACTS §28.2 change.
  Easy trims: SETUP_POSTING's "Research sources" and "For maintainers" (check `web/test/setup-docs.test.ts` first).
  CONTRACTS §28.2 still says "about 43k today", which is stale.
- **Night drive polish** is mostly done (#196). Check that PR for anything left.
- **Old notes to fix when convenient:** the README's Status table is out of date, and GIT_WORKFLOW.md still says
  squash (PRs land as merge commits).
- Endless background loops cost redraws on devices without a GPU. The slide timing checks need a GPU, so they run on
  a Mac only.
- The longer open lists are in [ROADMAP.md](ROADMAP.md#phase-2-social-integrations) ("Still open" for auto-posting,
  Content Rewards and phase 2).

## When TikTok approves the app

1. If the production keys differ from the sandbox ones, paste them in Set up posting, then Connect again.
2. Ask to post publicly, using the answers in [SETUP_POSTING.md step 24](SETUP_POSTING.md#24-ask-to-post-publicly).
3. Leave TikTok's tick boxes (the attestations) for the owner.
4. Ask the owner before turning **Your Mac posts TikTok** off and going back to the API. Until they say so, the Mac
   keeps posting.
5. The API path keeps TikTok's own rules
   ([CONTRACTS §17.8](CONTRACTS.md#178-tiktok-post-to-tiktok-sheet-content-sharing-guidelines-web--api)): who can see
   it is picked from a list with no default, and Comments, Duet and Stitch are shown and start off. That is unlike
   the Mac path, which posts public by default. Don't carry the Mac's defaults over to the API.
6. If TikTok says no, tell the owner its comments in plain words. Don't build a cloud TikTok poster unless the owner
   asks: the owner chose to keep the Mac.

## Runbooks

### TikTok Mac helper

The source is [mac/tiktok-helper/](../mac/tiktok-helper/README.md); the contract is CONTRACTS §47. The helper runs on
the owner's Mac every minute (launchd job `com.clipfactory.tiktok-helper`), in hidden headless Chrome, with nothing
on screen. Only a real need of the owner (a TikTok code, a puzzle, a login it can't do) shows a frame and one pop-up.

**Who installs it:** the coordinator session. Routine updates after a merged fix are its job: once the deploy is
green, it installs from main as below, without waiting to be asked, so a fix never sits uninstalled. The session
that built the change never installs it. Only the first-time setup, the owner's logins and anything that shows on
the screen wait for the owner's command. The helper is live, so tests use fakes only.

**Update after a merged change to `mac/tiktok-helper/`:**

1. Wait until the PR is merged and the deploy is green (the server's version gates must be live first).
2. Make sure no run is in progress: there is no `run.lock` in the helper's install folder.
3. From an up-to-date main checkout: `cd mac/tiktok-helper && ./install.sh --no-start`. This keeps the settings,
   state, Chrome profiles and saved login.
4. `node "<install folder>/app/src/cli.js" whoami` must print `"loggedInAs": ["@lamo.clips"]` and `"matches": true`.
   With `--workspace stories` it must read @clips.funded.
5. Start it: `./install.sh`.
6. If `whoami` doesn't match, start nothing and put back the previous version (from the backup copy, or by
   installing from the previous main commit).

The install folder is `~/Library/Application Support/Clip Factory TikTok/` ([Files](../mac/tiktok-helper/README.md#files)).

**Useful commands** (`node <install folder>/app/src/cli.js ...`):

- `status` shows every lane; `off` and `on` pause it on this Mac only.
- `probe <clipId> --branded --quiet` fills in TikTok Studio and stops before Post: nothing posted, nothing on screen.
  It prints `label` and `paidPartnership`. Also `--your-brand`, and `--caption <text>` for a clip already on TikTok.
  For Clips Funded: `probe --workspace stories --story <id>`.
- Logs: `helper.log` and `events.log` in the install folder. Check `events.log` after each auto-posting run.
- First-time setup: `./install.sh --no-start`, then `cli.js setup` (the only visible window), then `./install.sh`.

**Server version gates:** check-ins count only from 1.1.0 (`MAC_BEATS_FROM`), and labelled posts are claimed only
by 1.3.0 or later (`MAC_BRAND_FROM`), both in `api/src/clipfactory_api/tiktok_self.py`.

**Good to know:**

- TikTok Studio's page changes often. When a post stops, read `events.log` and fix the selectors in the helper.
- In Studio, each checkbox is redrawn on every click, so read it again by its text after clicking.
- A Chrome update can drop the TikTok login (it happened on 24 Nov). The helper then asks for a login.
- To check that it runs hidden, count only the helper's own Chrome (the one in its install folder), not the owner's.

### Deploy guards

Every push to main deploys production with no approval: plan, then the delete gate, then the Clip Factory check,
then the wait for running jobs, then apply exactly that plan
([DEPLOYMENT.md](DEPLOYMENT.md#what-a-deploy-does)). A docs-only change (`docs/**` or a top-level `*.md`) does not
deploy.

**Read the plan after every deploy.** Find "Plan: x to add, y to change, z to destroy" in the deploy log. The only
expected replaces are `module.agent.terraform_data.image` and `module.stories_agent.terraform_data.image`: they are
build triggers that hold no data (CONTRACTS §45.18). Any other replace or destroy is a real problem: stop and tell
the owner.

**The delete gate** (`scripts/check-plan-deletes.sh`) stops any plan that deletes or replaces the table, the user
pool, a secret or a data bucket.

**The Clip Factory check** (`scripts/check-plan-clips-unchanged.sh`) stops a deploy when Clips Funded work seems to
change Clip Factory. A commit counts as Clips Funded work when it touches its folders (`stories/`, `web/src/stories/`,
`infra/modules/stories_*`, `api/src/clipfactory_api/workspaces/`, the story flow or their tests) or names Clips
Funded (or an old name) in its message. It matters when such a commit also touches `infra/`, `deploy.yml`, `agent/`,
`skills/` or `config/`.

When it stops a deploy:

1. Read the findings and the plan's replace and destroy list.
2. If the Clip Factory change is on purpose and nothing that holds data is destroyed, run the deploy again by hand:
   `gh workflow run deploy.yml --repo Lamo2real/clip-factory-legal --ref main -f allow_clip_factory_change=true`
   (in the web page: Actions, deploy, Run workflow, tick "Clip Factory changes on purpose"). The findings then only
   warn. A Clips Funded route on a Clip Factory path always stops.
3. Watch that run to the end.

This happened on 24 Nov with #203: a Clip Factory agent fix that also touched a Clips Funded test file. To avoid it,
keep the two apps' changes in separate PRs.

**Production logs** (read only, main only): `gh workflow run read-logs.yml --repo Lamo2real/clip-factory-legal --ref
main -f minutes=180` (add `-f job_id=<id>` for one job). After an auto-posting run look for `autopost.planned`,
`autopost.done`, then `clip_flow.posted` or `publish_failed` per platform. Count `publish.platform_error` for real
failures: a replay repeats `publish_failed` lines. Post links stay out of the public logs; the owner sees them under
Auto-posting › Recent.

### Merging main into a branch

Never rebase or force-push. When GitHub says DIRTY:

1. `git fetch origin && git merge origin/main`.
2. **Generated files: take main's copy, then regenerate.** Never merge them by hand. They are
   `api/src/clipfactory_api/ask/knowledge.json`, `api/src/clipfactory_api/ask/library/*.md`,
   `web/src/features/help/help-corpus.json` and the routes table in [HELP_ASSISTANT.md](HELP_ASSISTANT.md) (and the
   shard lists, below).
3. **CONTRACTS.md and DECISIONS.md by hand.** Keep both sides. Each § and ADR number appears once and in order; if
   main took your number, renumber yours.
4. Regenerate, from `web/` (it needs `npm ci`, because the help corpus reads the app's source):
   ```bash
   node scripts/help-corpus.mjs --write-docs && node scripts/ask-knowledge.mjs
   node scripts/help-corpus.mjs --check && node scripts/ask-knowledge.mjs --check
   git add -A ../api/src/clipfactory_api/ask src/features/help/help-corpus.json ../docs/HELP_ASSISTANT.md
   ```
   `ask-knowledge` prints "about N tokens". N must stay under 110,000 (`MAX_TOKENS` in `web/scripts/ask-knowledge.mjs`).
   CI's `web-checks` runs both checks. If it goes over, shorten owner-facing words; don't raise the cap.
5. Commit as "Merge origin/main (#N, what it was) into <branch>; Ask knowledge regenerated", then push once.

Only the 11 docs listed in `LIBRARY_DOCS` (in `web/scripts/ask-knowledge.mjs`) feed Ask's library. Editing any of
them changes the generated files and the pack size. CLAUDE.md, this page, ROADMAP.md and GIT_WORKFLOW.md are not
in it.

### Release train

When many open PRs keep conflicting on the generated files (each conflict costs another CI run of about 25 minutes):

1. Make `release/train-YYYY-MM-DD` from main and merge each PR's head into it.
2. Resolve every conflict once (generated files as above; rebuild the shard lists).
3. Turn off auto-merge on the member PRs so they don't race.
4. Open one PR for the train with auto-merge. Its body lists each PR and its head commit, every conflict resolution,
   the review findings and the targeted local checks.
5. Fix CI on the train and watch the deploy to live. GitHub marks the member PRs merged once their heads are in main.

#193 on 24 Nov is the example.

### e2e shard lists

The browser tests are split by time ([TESTING.md](TESTING.md#web)). Lists live in `web/e2e/shards/`: `chromium-1`
to `chromium-6` for 7 Chromium shards and `webkit-1` to `webkit-4` for 5 WebKit shards, plus `timings.tsv`. The last
shard of each group runs every test in no list, so new tests pile onto it until it hits its time limit and the `web`
gate fails.

From `web/` (these only list tests, they don't run them):

- Check: `node scripts/e2e-shards.mjs check` (CI runs it; it fails when a test would run in no shard or in two).
- After a conflict in the lists or a big new spec: `node scripts/e2e-shards.mjs build`, then `check`.
- Fresh times: `gh run view <id> --log > run.log`, `node scripts/e2e-shards.mjs timings run.log`, then `build`
  and `check`. Commit the lists.
- One CI shard on your machine: `node scripts/e2e-shards.mjs args chromium 3 7 core`, then pass those arguments to
  `npx playwright test`.
- To change the number of shards, change the matrix in `ci.yml` and `GROUPS` in the script together.

Modes: `core` on every PR, `style` on a PR that touches styles or glass, `full` at night and on a run by hand
([which tests run when](TESTING.md#which-browser-tests-run-when)).

### CI flakes seen and their real fixes

Never raise limits, skip or weaken a test. Find what the app or the test really does wrong.

- **Calm motion with 1 ms transitions** (#197). Calm motion cut transitions to 1 ms, but `transition-property` stayed
  `all`. On CI's software drawing the next frame comes hundreds of ms late, so tests read the old style. Fix:
  `transition-property: none` at zero specificity under reduced motion (`web/src/styles/base.css`), guarded by
  `web/test/calmMotion.test.ts` (every transition names its properties) and `web/e2e/calm-motion-transitions.spec.ts`.
  The animation version of the same problem (a 1 ms animation showing its first frame) was fixed with
  `animation-delay: -1s` under calm motion (#203).
- **Slow software WebKit frames** (#202). On CI's Linux WebKit, with no GPU, one frame can take 1 to 4 s, sometimes
  12 s. Playwright's "stable" check needs two frames, so a long spec ran out of time. The fix was in the app: while
  Ask's markup editor is open (`html.mk-open`), the page under it drops its blurs and pauses its endless loops.
  Lesson: cut hidden blurs and endless animations; don't add timeouts.
- **Timing measured against the tap** (#203). A "the calm switch is instant" check had a 300 ms wall-clock limit, which
  measured the CI machine, not the app. It now checks exactly: when the tap's own click ends, the address and panes
  have changed, and every later frame shows the new pane. A tap a busy machine sends late is tried again, and every
  wait names what it saw.
- **A busy event loop read as a silent agent step** (#203): fixed in the agent's job watchdog, which now leaves held
  time out of quiet time.
- Older ones: a smooth scroll or a pulse measured mid-animation; hover state leaking between tests (#177); a reduced
  motion transition left on a fold (#177); Linux-only differences (shellcheck version, a missing font, the 4-core
  "simple" glass tier) that only a full run by hand before the PR caught.
- **Known Mac-only local failures** that pass on CI: `bank.spec` "the ways in" (hover lift jitter) and the Clips Funded
  switch slide check (WebKit on macOS drops frames during the slide).

A flaky test that hits every PR gets its own small fix PR from main.

### Local browser tests

CI is the full test run. Locally, run one targeted spec at most, and only when it likely saves a failed CI run.

- Always set `CF_E2E_PORT` to a free port. Playwright reuses any server already on 4179, which may be another
  checkout's build.
- On the owner's Mac, run browser tests through the local slot wrapper `pw-slot.sh` (a small script outside this
  repo). It lets at most 2 browser suites run at once across all sessions, because the Mac slows to a crawl
  otherwise. `PW_SLOTS` sets the number (default 2); a slot frees itself 90 s after its run stops. Example:
  ```bash
  cd web && CI=1 CF_E2E_PORT=4233 pw-slot.sh npx playwright test e2e/x.spec.ts --project=chromium --workers=4
  ```
  On a machine without it, run the same command without `pw-slot.sh`, and run one suite at a time.
- WebKit needs `npx playwright install webkit` once.
- See-through glass can only be judged in the real desktop window, never in a browser test
  ([TESTING.md](TESTING.md#hand-check-the-real-window)). Only do that on the owner's command.

### Agent patterns

- **A coordinator session** holds the one chat with the owner. Other sessions send it their reports and questions;
  it relays them, installs the Mac helper, and keeps the owner's progress page true. On a new account, the first
  session you open becomes the coordinator.
- **Workflows for big features:** wide build stages (one builder per set of files that don't overlap), then review
  rounds ("re-review", "round 2") that push to the same branch. Each round's fixes go in the PR body with the
  targeted local checks and "CI is the full test run". Reviewers check that every line each PR added is still there
  after merges.
- **Never message an agent that runs inside a Workflow:** it starts a second copy on the same worktree. Put every
  decision in the brief. To change course, stop the workflow and resume it with an edited script, or let it finish and
  add a revise step. Messaging an idle plain background agent is fine.
- **One writer per PR branch.** Before adding a fixer, check that the original agent has really stopped.
- **Watch your own PR** with `gh pr checks <N> --watch --interval 60`, then the deploy run on main. Silence is not
  success.
- **The coordinator watches what nobody owns:** the nightly full run (02:17 UTC) and main's ci, deploy and desktop
  runs. It fixes each failure itself or hands it to a session, and sees the fix to green and live.
- **Models:** Opus for thinking and building; Sonnet for routine steps. If a Sonnet agent hits a CI failure it can't
  fix, hand it to Opus.

## This week's history

- **15 to 20 Nov:** the cloud rebuild and its rules. Arrow-only cursor, the AskMark and sliding highlights; glass
  measured in the real window; YouTube connected in production and the keep-the-owner's-data rule (17 Nov); the
  Bottle Green, Bone and Vermilion palette (18 Nov); posting preferences, and the lesson from #63, which dropped
  "Use my settings" and "More details".
- **21 Nov:** Content Rewards (#84 to #95, #99 to #101, #104, #113); Get paid (#97, #107, #111); Post it on TikTok
  yourself (#98); the campaign finder (#103, #105, #106, #108, #112); the second workspace's plan and first parts
  (#102, #114 to #116, #119); one CI run per PR commit (#109); TikTok app review sent in.
- **22 Nov:** the second workspace built and switched on (#121 to #153, #161 to #171); auto-posting (#129); the
  campaign finder on (#136); Get paid and Your bank (#120, #133, #154 to #158, #162, #172, #174); the first TikTok
  Mac helper (#160, #164, #166, #170); an Instagram upload fallback (#167); release #175. Rules added: separate
  accounts, Mac control only on command, fewer PRs, one chat, one agent per PR.
- **23 Nov:** release #176 (name and logo, warm liquid glass, TikTok through the Mac and public by default, helper
  1.1.0, faster CI); the logic of light and more glass (#177, #178, #182, #183); fonts (#181); the final name Clips
  Funded (#180); the colour-free glass switch (#179); missing views fixed (#184); fewer local tests.
- **24 Nov:** release train #193, carrying less text (#185), Clips Funded TikTok through the Mac with helper 1.2.0
  (#186), iPhone edge to edge (#188) and the kid-proof bug hunt (#189). Also drag and drop and paste a link (#187);
  sounds, cartoon cars and series (#190); Social accounts organised and skipped platforms hidden (#191); the
  night-drive look (#192, #196); helper 1.2.1, 1.2.2 and 1.2.3 (#194, #195, #198); calm motion (#197); Write it myself
  (#199, #201, #205); the Ask markup on WebKit (#202); the nightly fixes (#203); campaign and paid clips with TikTok's
  label, helper 1.3.0 (#204); no band under the clock on iPhone (#206).
