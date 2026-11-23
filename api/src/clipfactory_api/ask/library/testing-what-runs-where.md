## What runs where

| Suite | Folder | Tools | In CI ([ci.yml](../.github/workflows/ci.yml)) | Before deploy ([deploy.yml](../.github/workflows/deploy.yml)) |
|---|---|---|---|---|
| Web unit and component tests | `web/` | Vitest, Testing Library | yes | yes |
| Web type check and lint | `web/` | TypeScript, ESLint | yes | yes |
| Web end-to-end and layout tests | `web/` | Playwright in mock mode | yes | yes |
| API Lambdas | `api/` | pytest, ruff, mypy (uv) | yes | yes |
| Agent runtime | `agent/` | pytest, ruff, mypy (uv) | yes | yes |
| Infrastructure | `infra/` | `terraform fmt -check`, `terraform validate`, `terraform test` (mock provider), tflint | yes | plan and apply |
| Help corpus drift | `web/` | `node scripts/help-corpus.mjs --check` (corpus, routes table in [HELP_ASSISTANT.md](HELP_ASSISTANT.md), `/v1/help` rows of CONTRACTS §19); the CI `web-checks` job runs it right after `npm ci`, before type check, lint and tests | yes | – (the build regenerates the corpus) |
| Documentation | `docs/`, `README.md` | relative-link and anchor check, draw.io XML parse and PNG export (below); `docs/SETUP_POSTING.md` is also checked by the web test `setup-docs.test.ts` (the five platforms, and the Content Rewards steps once `## Content Rewards` is there) | by hand (the setup page: yes, through the web tests) | – |
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
CF_E2E_PORT=4233 npx playwright test   # same, on another port (when 4179, the default, is taken)
npx playwright install webkit           # once, for the WebKit projects (Ask pictures in Safari and on iPhone)
CF_E2E_PORT=4233 npx playwright test e2e/help-pictures.spec.ts --project=chromium --project=webkit --project=webkit-phone
```

The `webkit` (Desktop Safari) and `webkit-phone` (iPhone 15) projects run only `e2e/help-pictures.spec.ts`, headless:
the Mac app (WKWebView) and the iPhone PWA are WebKit, so picking, pasting and dropping pictures is checked there too.
CI runs them in jobs of their own, `web-e2e (WebKit 1/2)` and `web-e2e (WebKit 2/2)` (two shards, 2 workers each, so the browsers do not starve one small runner), so only those jobs install WebKit and its system packages.

Playwright serves the mock app on port 4179 and reuses a server already on that port. If another checkout's preview
server holds 4179, set `CF_E2E_PORT` to a free port, or the tests run against the other checkout's build.

**In CI the web checks are three jobs.** The Playwright suite (762 tests on 16 Nov 2026) took 32 to 40 minutes as one
job, so [ci.yml](../.github/workflows/ci.yml) splits it:

| Job | What it runs |
|---|---|
| `web-checks` | help corpus check, type check, lint, Vitest, the production build |
| `web-e2e (1/6)` … `web-e2e (6/6)` | one sixth of the Playwright tests each: `npm run e2e -- --shard=N/6 --workers=4`. Each shard builds the mock app once. Playwright splits test by test (`fullyParallel`), so every test runs in exactly one shard and the shards add up to the whole suite. |
| `web` | the gate: passes only when `web-checks` and all six shards passed. This is the check branch protection requires, so keep a job with this exact name. |

**WebKit too.** The macOS desktop app draws with WebKit, so `nav-smooth.spec.ts` (the menu highlight sampled every
frame), `page-still.spec.ts` (no blink or twitch on a page change) and `top-line.spec.ts` (one top line, the
traffic-light band) also run in the `webkit` Playwright project (CI: the `web-e2e (WebKit 1/2, 2/2)` jobs). The
WebKit slide check (`nav-smooth`) runs on macOS only: Playwright's WebKit on the Linux runners is the GTK/WPE port,
whose headless run never started the glide's Web Animation at all, which says nothing about the Mac app's WKWebView;
`page-still` and `top-line` pass there and run in CI. On a Mac: `npx playwright install webkit`, then `CF_E2E_PORT=4471 npx playwright test nav-smooth page-still top-line
--project=chromium --project=webkit`.

A failed shard uploads `playwright-report-N` (its `test-results`); the other shards still finish. To run one shard on
your machine: `npx playwright test --shard=3/6`. To add a shard, add a number to the `shard` list in `ci.yml`; the
total is read from the list's length. `deploy.yml` does not run the browser tests: a deploy starts from a push to
`main`, and `main` only takes pull requests whose `web` check passed.

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
