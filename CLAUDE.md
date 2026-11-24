# CLAUDE.md

Read this at the start of every session. It holds the owner's standing rules and where things live. The fuller
handoff (where things stand, open questions, how-to runbooks and this week's history) is
[docs/HANDOFF.md](docs/HANDOFF.md). Read that next. Private notes (accounts, the owner's Mac) are outside the repo on
the owner's Mac, at `~/projects/clips/progress/HANDOFF-PRIVATE.md`. Never copy them in here.

## What this is

- **Clip Factory** (the docs say "Clip Factory Cloud") turns long videos and streams into short vertical clips. The
  owner reviews them, the app posts them to YouTube, TikTok, Instagram, Facebook and X, and it learns from the
  numbers. It is serverless on AWS (region `eu-north-1`, name prefix `cf-prod`) with an agent on Bedrock AgentCore,
  and a React web app that also installs as a phone app and a desktop app. See [README.md](README.md).
- **Clips Funded** is the second, separate workspace in the same app. The switch (Clip Factory | Clips Funded) sits
  in the left column right above the Live chip on a computer, and at the right end of the top bar on a phone. It
  makes short animated stories. It has its own API Lambda, agent runtime, roles and social accounts
  ([CONTRACTS §45](docs/CONTRACTS.md#45-clips-funded-a-second-separate-workspace-owner-request-2026-11-21),
  [ADR-76](docs/DECISIONS.md#adr-76-clips-funded-is-its-own-application-its-own-api-lambda-agentcore-runtime-and-iam-roles)).
- There is one owner and one user. The owner is not a developer, so everything they see must be kid-proof.
- This repo is **public**. The root files `index.html`, `privacy.html`, `terms.html`, `style.css` and `.nojekyll` are
  the GitHub Pages legal pages that TikTok and Google link to. Never move them.

## Where things live

| Folder | What |
|---|---|
| `web/` | The app (React 19, Vite, TypeScript). `web/src/stories/` is Clips Funded's part. |
| `api/` | Python 3.13 Lambdas. In `api/src/clipfactory_api/ask/` (Ask's code), `knowledge.json` and `library/*.md` are generated: never edit those two by hand. |
| `agent/`, `stories/agent/` | Clip Factory's and Clips Funded's AgentCore runtimes. |
| `skills/`, `stories/skills/` | Built-in skills. |
| `config/models.json` | The only place model ids live. `config/platforms.json` holds per-platform limits. |
| `infra/` | Terraform: `envs/prod`, `modules`, `bootstrap` (the deploy role). |
| `mac/tiktok-helper/` | The TikTok Mac helper ([its README](mac/tiktok-helper/README.md)). |
| `desktop/` | The Tauri desktop window ([its README](desktop/README.md)). |
| `scripts/` | Deploy helpers and the deploy guards, each with a `test-*.sh`. |
| `.github/workflows/` | `ci.yml`, `deploy.yml`, `desktop.yml`, `read-logs.yml`. |

The docs, linked here rather than copied:

- [docs/CONTRACTS.md](docs/CONTRACTS.md): **the single source of truth.** If code and contract disagree, the contract
  wins, and it changes in the same PR as the code. Each owner request gets its own dated §.
- [docs/DECISIONS.md](docs/DECISIONS.md): the ADR log (why each choice was made). New choices get a new ADR.
- [docs/BUSINESS_REQUIREMENTS.md](docs/BUSINESS_REQUIREMENTS.md): every requirement, numbered, with acceptance criteria.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/AGENT.md](docs/AGENT.md),
  [docs/HELP_ASSISTANT.md](docs/HELP_ASSISTANT.md) (Ask), [docs/SECURITY.md](docs/SECURITY.md).
- [docs/UX_DESIGN_SYSTEM.md](docs/UX_DESIGN_SYSTEM.md) and [docs/theme-bottle-green.md](docs/theme-bottle-green.md):
  colours, glass, motion and the kid-proof checklist. Check them before restating any colour.
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), [docs/TESTING.md](docs/TESTING.md), [docs/GIT_WORKFLOW.md](docs/GIT_WORKFLOW.md).
- [docs/SETUP_POSTING.md](docs/SETUP_POSTING.md): the owner's setup steps per platform.
- [docs/ROADMAP.md](docs/ROADMAP.md): what is built and what is still open.
- Clips Funded's own notes: [the glass contract](web/src/stories/styles/GLASS-CONTRACT.md) and
  [the animation engine](web/src/stories/engine/README.md).

## How it must look and feel

- **Kid-proof.** A 6 to 8 year old must manage every screen
  ([checklist](docs/UX_DESIGN_SYSTEM.md#kid-proof-checklist)).
- **Less text.** Per card: a short title, at most one short line and one clear main button. Status in one word.
  Explanations go in one folded section. Never drop what prevents a mistake: which account, money, public or
  private, things that can't be undone, an error and its fix, legal or safety.
- **Feels good.** A celebration on success, eased progress bars (slow start and end), click sounds on taps only
  (never on scroll).
- **See-through liquid glass** everywhere, and the logic of light: the top layer is the brightest.
- **The cursor never changes.** Always the plain arrow. Never add `cursor:` CSS; hover styling shows what is pressable.
- **Ask** uses its own AskMark (a chat bubble with a play button), never an AI sparkle.
- **Pick-one bars** (tabs, segmented controls, the sidebar) slide their highlight (`<Glide>`).
- **The workspace switch** is in exactly the same place, size and look in both apps. It is see-through glass with no
  colour of its own (so is the update bar's Reload), and the change between the apps slides like a window, slow in
  slow out ([CONTRACTS §45.38, S1 to S5](docs/CONTRACTS.md#4538-one-shell-switch-the-two-apps-kept-apart-2026-11-22-wins-over-anything-above)).
- **Update bar labels** are 1 to 3 words naming the place ("Settings · Profile picture"), never sentences
  ([Area lines](docs/GIT_WORKFLOW.md#area-lines-what-the-update-bar-says)).
- **Get the app** fits the device (Mac, Windows, iPhone, Android) and goes away once installed.
- **Phones:** edge to edge, and no band across the top, ever, in either app.
- **Uploads** accept drag and drop everywhere.
- Decide small UI details yourself. Don't ask the owner about them.

## Posting

- The most reach and money on every platform: public, comments, duets and stitches on, never "made for kids", and the
  paid or branded label only when a clip is paid (Content Rewards campaigns count as paid).
- TikTok's own rules win on its API path (once TikTok approves the app): who can see it is picked from a list with no
  default, and Comments, Duet and Stitch are shown and start off
  ([CONTRACTS §17.8](docs/CONTRACTS.md#178-tiktok-post-to-tiktok-sheet-content-sharing-guidelines-web--api)). Only the
  Mac path posts public by default.
- Review has one **Use my settings** tap plus a **More details** fold. Only platforms that are set up are offered.
- Nothing is posted without the owner's Confirm or Upload, or the auto-posting the owner set.
- Never switch auto-posting on or off, or change its schedule, without the owner's say.

## Hard rules

1. **Separate accounts.** Clip Factory posts only to its own accounts (TikTok @lamo.clips, the "Lamo Clips" channel
   and Page). Clips Funded posts only to its own (TikTok @clips.funded and its own Instagram, Facebook Page and
   YouTube channel). Clips Funded videos on Clip Factory's accounts is, in the owner's words, "a hard no". The
   same-account check runs at connect and before every upload. Sharing Clip Factory's developer *app* is allowed,
   but Clip Factory always goes first on quotas and limits.
2. **Keep the owner's data.** Setting up a platform is long manual work only the owner can do. A merge must never
   reset connected platforms or saved data. Never replace or destroy the DynamoDB table, the Cognito user pool,
   Secrets Manager secrets or the media bucket. Stored shapes change by adding fields only, never renames without a
   migration. After every deploy, read the plan's replace and destroy list (see HANDOFF).
3. **No AWS from a laptop.** Never run `aws` or `terraform` against AWS from the laptop, not even reads: its AWS
   profiles are for other, unrelated accounts. Deploys only run in GitHub Actions. For production logs use the
   read-only `read-logs` workflow.
4. **Only the visible name is "Clips Funded".** Internal names stay as they are (the `stories` workspace type,
   `module.stories_agent`, secret paths, database keys): renaming them replaces live resources and loses data
   ([ADR-85](docs/DECISIONS.md#adr-85-the-second-app-is-called-clips-funded-on-screen-every-internal-name-stays)).
   Never write any of its old names in new text.
5. **The owner's Mac is controlled only on the owner's command.** No screen control, raising windows, Apple Events
   or pop-ups unless the owner asks in their own words. Helping with their turn is not a command: say where a window
   is, or ask "Shall I bring it to the front?". When driving the browser on command, show the red frame and turn it
   off the moment you stop. The TikTok helper shows nothing on screen in a normal run. Machine guards on the owner's
   Mac are the owner's: never lift one without their word.
6. **The owner's alone:** logins, money, billing, legal tick boxes, private-data choices and creating accounts.
   Never ask for or type a password in chat.
7. **Privacy in this public repo.** No email addresses, real names, phone numbers, home folder paths, account ids,
   Keychain details or secrets, and nothing about the owner's other projects. Private notes stay outside the repo.
8. Never commit secrets, `.env` files, Terraform state or `config.json`.

## How work flows

- **Branch from `origin/main` in a fresh git worktree** (a sibling folder per task). Prefixes: `feat/`, `fix/`,
  `docs/`, `chore/`, `infra/`.
- **One PR per feature or request**, not one per piece. Parallel agents join their work on one branch locally. A
  pushed branch with no PR starts no CI, so push it as a backup. Open the PR once the feature and its own review
  are done, and batch review fixes into one push. Small urgent fixes (a broken main, a live bug, a flaky test that
  hits every PR) may go alone. When the owner says "now", ship finished work at once.
- **Merge on green without asking:** `gh pr merge N --auto --merge`. PRs land as merge commits; the "squash" in
  GIT_WORKFLOW.md is out of date. The owner (24 Nov): "merge everything if successful". Hold only on red CI, and put
  later review findings in a follow-up PR.
- **See it to production:** watch the PR's checks, then the deploy on main, then read the plan. Delete merged branches.
- **Never** push to main (except an emergency revert), force-push, rebase after the first push, merge red, or weaken
  or skip a test to get green.
- **One writer per PR branch.** When GitHub says DIRTY, merge `origin/main` into the branch. After a restart or a
  compaction, run `gh pr list` and `git worktree list` before starting a fix, so you don't make a duplicate.
- **Generated files** (the Ask knowledge, the help corpus, the e2e shard lists): on a conflict take main's copy,
  regenerate and run the checks. Ask's always-included pack must stay under 110,000 tokens and is nearly full.
  Recipes in [HANDOFF](docs/HANDOFF.md#merging-main-into-a-branch).
- **Many PRs at once:** use a release train ([HANDOFF](docs/HANDOFF.md#release-train)).
- **CI is the full test run.** The owner: "stop running tests all the time". Locally, run the directly affected unit
  test and the static checks (types, lint, ruff, mypy). At most one targeted browser spec, and only when it likely
  saves a failed CI run ([how](docs/HANDOFF.md#local-browser-tests)). Never run whole suites locally.
- **Fix every failure you own:** your PR's red checks and clashes, and main's ci or deploy failures from your merges.
  The coordinator owns what nobody else does: the nightly full run (02:17 UTC) and main's ci, deploy and desktop
  runs. It fixes each failure there or hands it to a session. Find the real cause. A true flake gets one rerun, and you say so. If the owning session hasn't fixed a failure in
  about 15 minutes, take it over on its branch (merges only), see it to green and live, then hand it back.
- **Keep what the owner asked for.** Every prompt to a helper agent says: "do not remove or replace owner-requested
  features; if something conflicts, keep it and report the conflict". Before calling anything live, compare what
  merged with the owner's exact words.
- Keep Clips Funded files and Clip Factory's `agent/`, `skills/` and `config/` changes in separate PRs, or plan for
  the deploy guard's rerun ([HANDOFF](docs/HANDOFF.md#deploy-guards)).
- **Commits:** imperative, with a type prefix (`feat: ...`). When the owner will see the change, end the commit and
  the PR body with `Area:` lines.

## Agents and models

- Work wide: 10 to 20 agents at once, one builder per set of files that don't overlap, plus parallel reviewers.
  "More agents" means more builders, not more test runners.
- Opus for diagnosis, design, the main build and hard reviews. Sonnet for routine steps: ship, CI watch, merge,
  screenshots, small copy.
- Never message an agent that runs inside a Workflow: it starts a second copy on the same worktree. Put every
  decision in the brief; to change course, stop it and resume with an edited script.
- Run screenshot-heavy work in a helper agent. If the same model error repeats after retries, compact or start a
  fresh session with a short handoff instead of pressing Try again.

## Talking to the owner

- Plain, short, kid-proof English. A question is one line, with options and your recommendation.
- One chat: every session sends its reports and questions to one coordinator session. On a new account, the first
  session you open becomes the coordinator.
- When work truly waits on the owner, tell them clearly, and notify their phone if that is set up.

## Quick commands

```bash
cd web && npm ci && npm run dev:mock      # the app on localhost:5173 with a fake API, no AWS needed
cd web && npm run typecheck && npm run lint && npx vitest run test/<file>.test.ts
cd api && uv sync && uv run ruff check && uv run ruff format --check && uv run mypy src && uv run pytest -q tests/<file>.py
gh pr checks <N> --watch --interval 60    # watch your PR yourself; silence is not success
gh workflow run read-logs.yml --ref main -f minutes=180   # read-only production logs
```
