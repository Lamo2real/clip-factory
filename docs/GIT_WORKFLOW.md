# Git workflow

The owner's rule: build features in separate branches, merge them automatically without asking, and delete the
branches afterwards. `main` is always deployable, and every push to it deploys production.

## The flow

1. **Branch from `main`** with a short, descriptive name:

   | Prefix | For |
   |---|---|
   | `feat/` | New behaviour (`feat/skills-upload`) |
   | `fix/` | A bug fix (`fix/clip-card-overflow`) |
   | `docs/` | Documentation only |
   | `chore/` | Tooling, dependencies, CI |
   | `infra/` | Terraform changes |

2. **Commit** small, focused changes. Messages in the imperative, with a type prefix:
   `feat: add skill upload in Settings`, `fix: stop caption text overflowing on 320 px`. When the owner will see the
   change, end the message with [`Area:` lines](#area-lines-what-the-update-bar-says).
3. **Open a pull request** into `main`. The description says what changed and why, and how it was tested, and ends
   with the same `Area:` lines.
   If a contract changes, [CONTRACTS.md](CONTRACTS.md) changes in the same pull request.
4. **CI runs** ([ci.yml](../.github/workflows/ci.yml)): web lint, types, unit and Playwright tests; Python lint,
   types and tests for `api/` and `agent/`; Terraform format and validate.
5. **Automatic merge when green.** Auto-merge is enabled on the pull request (squash). No review is required, by the
   owner's choice. If CI fails, the branch is fixed and pushed again; it is never merged red.
6. **The branch is deleted** after the merge (the repository setting "Automatically delete head branches" is on, and
   the local branch is removed too).
7. **The merge deploys** ([deploy.yml](../.github/workflows/deploy.yml)).

With the GitHub CLI:

```bash
git switch -c feat/skills-upload
# ... work, commit ...
git push -u origin feat/skills-upload
gh pr create --fill --base main
gh pr merge --auto --squash --delete-branch
```

## Area lines: what the update bar says

After every deploy the app shows a bar with a few words about what changed, for example `Settings · Profile picture`
([BR-17](BUSINESS_REQUIREMENTS.md#br-17-update-bar-what-is-new-and-a-reload-button)). Those words come from `Area:`
trailer lines in the commit message, read by `scripts/release-areas.sh` at deploy time
([ADR-20](DECISIONS.md#adr-20-update-labels-from-area-commit-lines-then-a-folder-map)).

**How to write them**

- Put them in the **last paragraph** of the message, after a blank line, one per line, as `Area: <label>`. They can
  share that paragraph with other trailers such as `Co-Authored-By:`.
- A label is **1–3 words**, the name of the place the owner sees on screen, capitalised like a heading's first word:
  `Settings`, `Profile picture`, `Review`, `Get the app`, `Sounds`, `Sign in`.
  A longer label is cut to its first 3 words (never ending on a joining word such as "and"), so keep it short
  yourself: `Fixes: Home` rather than `Fixes: Home and Jobs`.
- No sentences, no full stops, no technical words (`API`, `Lambda`, `Terraform`, `refactor`), no version numbers.
- At most three per commit. Across all commits in a deploy, the first three different labels are shown.
- Changes the owner cannot see (infrastructure, CI, tests) need no `Area:` line. The folder map
  (`web/areas.json`) then decides, and failing that the bar says "Improvements".

```
feat: let the owner pick a profile picture

Adds an image picker to the Settings profile card and stores the image per device.

Area: Settings
Area: Profile picture
```

| Good | Not good | Why |
|---|---|---|
| `Area: Profile picture` | `Area: Added a profile picture upload` | A label, not a sentence |
| `Area: Review` | `Area: ClipReview.tsx` | Words on screen, not file names |
| `Area: Get the app` | `Area: Tauri NSIS` | No jargon |
| `Area: Sounds` | `Area: misc` | Say where; leave it out if there is nothing to see |

**Squash merges.** Pull requests are squash-merged ([ADR-10](DECISIONS.md#adr-10-feature-branches-automatic-merge-after-green-ci-branches-deleted)),
so only the squashed commit lands on `main`. To make sure the `Area:` lines reach it:
1. The repository setting for squash commit messages is **"Default to pull request title and description"** (see
   below), and
2. the pull request description **ends** with the same `Area:` lines, as its last paragraph.

```bash
gh pr create --base main --title "feat: profile picture in Settings" \
  --body $'Lets the owner pick a profile picture.\n\nArea: Settings\nArea: Profile picture'
```

## Repository settings (one-time)

In GitHub → Settings:
- General → Pull Requests: allow **squash merging** with the default commit message **"Pull request title and
  description"** (so `Area:` lines reach `main`), enable **Allow auto-merge**, enable **Automatically delete head branches**.
- Branches → a rule (or ruleset) for `main`: require a pull request and require the CI status checks to pass. No
  required approvals.

## Rules

- Never push directly to `main`, except an emergency revert.
- Never merge a red pull request.
- Never commit secrets, `.env` files, Terraform state or `config.json` (the `.gitignore` covers them).
- The legal pages at the root (`index.html`, `privacy.html`, `terms.html`, `style.css`, `.nojekyll`) are served by
  GitHub Pages; change them only on purpose, in their own pull request.
