## What runs where

| Suite | Folder | Tools | In CI ([ci.yml](../.github/workflows/ci.yml)) | In the deploy ([deploy.yml](../.github/workflows/deploy.yml)) |
|---|---|---|---|---|
| Web unit and component tests | `web/` | Vitest, Testing Library | yes | no |
| Web type check and lint | `web/` | TypeScript, ESLint | yes | no |
| Web end-to-end and layout tests | `web/` | Playwright in mock mode | yes | no |
| API Lambdas | `api/` | pytest, ruff, mypy (uv) | yes | no |
| Agent runtime | `agent/` | pytest, ruff, mypy (uv), the image build and its self-check | yes | no (it builds and pushes the image) |
| Funded Clips agent | `stories/agent/` | pytest, ruff, mypy (uv), ffmpeg, the image build and its self-check | yes (job `stories-agent`; the `web` gate waits for it) | no (it builds and pushes the image) |
| Desktop app | `desktop/` | `cargo fmt --check`, clippy, `cargo test`, the tools lock and its signing | yes, when `desktop/` changes (the `web` gate waits for it) | no ([desktop.yml](../.github/workflows/desktop.yml) builds it after a deploy) |
| Infrastructure | `infra/` | `terraform fmt -check`, `terraform validate`, `terraform test` (mock provider), tflint | yes | no tests: plan, the delete gate, the Clip Factory check and apply |
| Help corpus drift | `web/` | `node scripts/help-corpus.mjs --check` (corpus, routes table in [HELP_ASSISTANT.md](HELP_ASSISTANT.md), `/v1/help` rows of CONTRACTS §19); the CI `web-checks` job runs it right after `npm ci`, before type check, lint and tests | yes | no (the build regenerates the corpus) |
| Documentation | `docs/`, `README.md` | relative-link and anchor check, draw.io XML parse and PNG export (below); `docs/SETUP_POSTING.md` is also checked by the web test `setup-docs.test.ts` (the five platforms, and the Content Rewards steps once `## Content Rewards` is there) | by hand (the setup page: yes, through the web tests) | no |
| Workflows and scripts | `.github/`, `scripts/`, `mac/tiktok-helper/` | actionlint 1.7.12 (every workflow, with shellcheck on their `run:` steps), shellcheck (`scripts/*.sh`, `desktop/scripts/*.sh`, the TikTok helper's install scripts), each `scripts/test-*.sh`, the TikTok helper's `npm test` | yes (job `scripts`) | no |

`deploy.yml` runs none of these tests. It deploys each push to `main` (and a run by hand), and a change reaches `main`
only through a pull request whose required checks passed in `ci.yml` (`web`, `api`, `agent`, `infra`, `scripts`;
`web` also waits for `stories-agent` and `desktop`). The push's own `ci` run goes on beside the deploy and does not
hold it back. What `deploy.yml` checks is the release itself: the delete gate and the Clip Factory check on the saved
plan, then the smoke test against the live app after the upload.

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
CF_E2E_PORT=4233 npx playwright test   # same, on another port (when 4179, the default, is taken)
npx playwright install webkit           # once, for the WebKit projects (Ask pictures in Safari and on iPhone)
CF_E2E_PORT=4233 npx playwright test e2e/help-pictures.spec.ts --project=chromium --project=webkit --project=webkit-phone
```

The `webkit` (Desktop Safari) and `webkit-phone` (iPhone 15) projects run the specs that hold the Mac app (WKWebView)
and the iPhone PWA, headless: Ask's pictures and files, the motion, stillness and top-line checks, Home's boxes and
covers, Get paid, and the Funded Clips switch's slide (`webkit` only; `testMatch` in `web/playwright.config.ts`). CI
runs them in jobs of their own, the `web-e2e (WebKit N/5)` shards, so only those jobs install WebKit and its system
packages.

Playwright serves the mock app on port 4179 and reuses a server already on that port. If another checkout's preview
server holds 4179, set `CF_E2E_PORT` to a free port, or the tests run against the other checkout's build. On CI
(`CI` set) a `test.only` left in a spec fails the run (`forbidOnly`), instead of quietly running that one test.

**In CI the web checks are a few jobs.** The Playwright suite (about 1,990 tests on 23 Nov 2026) took 32 to 40 minutes
as one job, so [ci.yml](../.github/workflows/ci.yml) splits it:

| Job | What it runs |
|---|---|
| `changes` | which areas a change touches (web, e2e, the two agents, desktop) and how much of the browser tests run (`e2e_mode`, below). A job whose area did not change is skipped. |
| `web-checks` | a real `npm ci` (never node_modules from a cache, so a `package.json` that disagrees with `package-lock.json` fails here), the help corpus and Ask knowledge checks, the shard check (`node scripts/e2e-shards.mjs check`), type check, lint, Vitest, the bundle (`vite build`) and the Funded Clips bundle check (none of its code or styles in the main bundle). npm's download folder comes from a cache that only the nightly run and a run by hand save; a pull request only reads it |
| `web-e2e (1/7)` … `web-e2e (7/7)` | Chromium (the `chromium` and, at night, `screenshots` projects), 4 workers each. Each shard builds the mock app once. |
| `web-e2e (WebKit 1/5)` … `web-e2e (WebKit 5/5)` | `webkit` and `webkit-phone`, 2 workers each |
| `web` | the gate: passes only when `web-checks`, every shard, `stories-agent` and `desktop` passed, or `changes` said they had nothing to check (then each must be skipped). `stories-agent` and `desktop` are not required checks of their own, so this is what keeps a pull request with failing Funded Clips agent tests or desktop tests from merging. It fails when `changes` did not finish, so "skipped" only ever means "nothing it tests changed". This is the check branch protection requires, so keep a job with this exact name. |

**Shards are split by time, not by count.** Playwright's own `--shard` splits in file order, which put all of
`contrast.spec.ts` in one shard (14 to 23 minutes while the others took 8 to 12). So every shard but the last runs a
list made from each test's saved time (`web/e2e/shards/<group>-<n>.txt`, built from `web/e2e/shards/timings.tsv`), and
the last shard runs every test in no list (`--test-list-invert`), so a new or renamed test always runs.
`node scripts/e2e-shards.mjs check` (in `web-checks`) has Playwright list each shard with the arguments CI passes, in
each of the three modes below, and fails when a test would run in no shard or in two, when a B3 tag is wrong, when
a mode leaves out more or less than B3 chose (all three are pinned in the check, so a pull request cannot shrink its own
run), or when `ci.yml` names a mode the script does not know or does not run the full mode at night. To refresh the times:
`gh run view <id> --log > run.log`, then `node scripts/e2e-shards.mjs timings run.log` and
`node scripts/e2e-shards.mjs build`. To change the number of shards, change the matrix in `ci.yml` and `GROUPS` in
`scripts/e2e-shards.mjs` together, then run `build`.

**WebKit too.** The macOS desktop app draws with WebKit, so `nav-smooth.spec.ts` (the menu highlight sampled every
frame), `page-still.spec.ts` (no blink or twitch on a page change) and `top-line.spec.ts` (one top line, the
traffic-light band) also run in the `webkit` Playwright project (CI: the `web-e2e (WebKit N/5)` shards). The
WebKit slide check (`nav-smooth`) runs on macOS only: Playwright's WebKit on the Linux runners is the GTK/WPE port,
whose headless run never started the glide's Web Animation at all, which says nothing about the Mac app's WKWebView;
`page-still` and `top-line` pass there and run in CI. On a Mac: `npx playwright install webkit`, then `CF_E2E_PORT=4471 npx playwright test nav-smooth page-still top-line
--project=chromium --project=webkit`.

A failed shard uploads `playwright-report-N` (or `playwright-report-webkit-N`, with its `test-results`); the other
shards still finish. To run one CI shard on your machine, print its arguments and pass them on:
`node scripts/e2e-shards.mjs args chromium 3 7 core` (the group, the shard, the total and the mode), then
`npx playwright test <those arguments>`. `deploy.yml` does not run the browser tests: a deploy starts from a push to
`main`, and `main` only takes pull requests whose `web` check passed.

### Which browser tests run when

The owner chose this (B3, 23 Nov 2026: "Yes, trim them"), so a pull request's run stays short. The `changes` job
picks the mode (`e2e_mode`), and `scripts/e2e-shards.mjs` (`MODES`) turns it into Playwright arguments:

| Mode | When | What it leaves out |
|---|---|---|
| `full` | the nightly run (02:17 UTC) and a run by hand (Actions, ci, Run workflow) | nothing: every test of every project |
| `style` | a pull request that changes a style, token, glass or theme file: `web/src/styles/**`, `web/src/stories/styles/**` and any other stylesheet (the legal pages' `web/public/legal/site.css` too), `web/src/components/ui.tsx`, `web/src/lib/background.ts` and `look.ts`, `web/e2e/glass.ts`, `web/e2e/helpers.ts` (the helpers `contrast.spec.ts` uses), `web/e2e/contrast.spec.ts` or `web/scripts/e2e-shards.mjs` (the script that picks each mode's tests); also a pull request that changes `ci.yml` or has no usable base, which runs every check | the `screenshots` project (174 tests that only take pictures; CI never keeps them) |
| `core` | every other pull request that touches the web | the `screenshots` project, and the `@contrast-full` part of `contrast.spec.ts` |

Every test in `contrast.spec.ts` carries exactly one of two tags. `@contrast-core` runs on every pull request: one
width per breakpoint group (375 px for a phone, 1440 px for a wide screen) in one background mode (the browser's own
look, light), on every route, plus the setup list, "All set!", Ask's files and the tab bar over a white thumbnail.
`@contrast-full` is the rest: 320 px, dark, the window look over every glass stand-in and a picture behind the page.
A contrast slip from a change outside those style files shows up in the nightly run at the latest.

**Affected only.** A pull request that touches only folders the web never reads (`agent/`, `api/` outside Ask, the routes
and the few files the web's unit tests read, `infra/`, `mac/`, `scripts/`, `stories/agent/`, `desktop/` outside the
window code, `.github/`) skips `web-checks` and the browser tests; `web` still reports. The agent jobs run only when
their own inputs change.

**Main and the nightly run.** A push to `main` does not run the web checks and browser tests again: its pull request
ran them. Branch protection is not strict, so two green pull requests can still break `main` together, which the
nightly full run finds. When a job of the nightly run fails, is cancelled or times out, its last job (`nightly
alert (runs only at night)`, shown as skipped on every other run) opens one issue, "Nightly CI failed", assigned to
the owner (`Lamo2real`, so GitHub notifies them even without watching the repository), with the run's link and the
jobs that did not pass, or adds the new run to the one still open in a comment that mentions `@Lamo2real`; close it
once a nightly run is green.

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
