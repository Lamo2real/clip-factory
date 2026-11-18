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
| Help corpus drift | `web/` | `node scripts/help-corpus.mjs --check` (corpus, routes table in [HELP_ASSISTANT.md](HELP_ASSISTANT.md), `/v1/help` rows of CONTRACTS §19); the CI `web-checks` job runs it right after `npm ci`, before type check, lint and tests | yes | – (the build regenerates the corpus) |
| Documentation | `docs/`, `README.md` | relative-link and anchor check, draw.io XML parse and PNG export (below); `docs/SETUP_POSTING.md` is also checked by the web test `setup-docs.test.ts` | by hand (the setup page: yes, through the web tests) | – |
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
```

Playwright serves the mock app on port 4179 and reuses a server already on that port. If another checkout's preview
server holds 4179, set `CF_E2E_PORT` to a free port, or the tests run against the other checkout's build.

**In CI the web checks are three jobs.** The Playwright suite (762 tests on 16 Nov 2026) took 32 to 40 minutes as one
job, so [ci.yml](../.github/workflows/ci.yml) splits it:

| Job | What it runs |
|---|---|
| `web-checks` | help corpus check, type check, lint, Vitest, the production build |
| `web-e2e (1/6)` … `web-e2e (6/6)` | one sixth of the Playwright tests each: `npm run e2e -- --shard=N/6 --workers=4`. Each shard builds the mock app once. Playwright splits test by test (`fullyParallel`), so every test runs in exactly one shard and the shards add up to the whole suite. |
| `web` | the gate: passes only when `web-checks` and all six shards passed. This is the check branch protection requires, so keep a job with this exact name. |

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

## Ask Clip Factory

The help assistant ([CONTRACTS.md §19.11](CONTRACTS.md#1911-tests-offline-fakes-only-no-aws-no-network),
[HELP_ASSISTANT.md](HELP_ASSISTANT.md)) is tested offline like everything else: a fake Bedrock client, a fake corpus
fetcher, the mock API with a deterministic fake model, no network.

**One shared eval file**, `web/src/features/help/helpEvals.json`: at least 44 cases `{q, expect, context?, history?}`
where `expect` is a doc id, `"unknown"` or `"refused"`. Both retrievers run it (`api/tests/test_help_evals.py` and
`web/test/helpRetrieve.test.ts`) and each case must pick the expected top doc. A case without its own `context` uses
the file's `defaultContext` in both runners (`api/tests/help_support.py` `eval_cases`, the same as the web test). The API test reads the web files
straight from the repository (it is skipped only if they are missing), so the Python and TypeScript retrievers cannot
drift apart; `api/tests/fixtures/help/evals.json` adds API-only cases on top. It holds the seven questions of
[BR-24](BUSINESS_REQUIREMENTS.md#br-24-ask-clip-factory-answers-that-take-you-there) AC3 and the list in §19.11,
including the follow-up "and the error sound?", the typo "instagarm connect", device cases ("download for mac" on a
desktop, "add to home screen" on iOS), unknown ("what's the weather") and refused ("what is my password").

```bash
cd web && node scripts/help-corpus.mjs --check && npx vitest run test/help
cd api && uv run pytest -q tests/test_help*.py
```

| Suite | Must show |
|---|---|
| API (pytest) | Off by default (flag unset: GET off, POST 403); kill switch `enabled: false` → 403, `model: false` → kb, read once per 60 s; 6 a minute and 60 an hour → 429 with `Retry-After` and `retryAfter`; cap reached → `kb_cap` and no model call; no model call for unknown or refused; bad bodies → 400; the exact Converse request (model id, `maxTokens` 700, no temperature, thinking disabled, schema with `additionalProperties: false`, the owner's skills block first and the help rules after it, sent through the shared `learn.converse_text` (§18.6), client timeouts, `max_attempts` 1); invented action id dropped; ungrounded bold name, invented digit or a live number written out → kb; malformed JSON, stop reasons, timeout, ClientError → kb; deadline skip; skills that cannot be loaded → `kb_skills` and no model call; `test_skills_everywhere.py` finds no model call outside the helper; corpus meta parse, other host or bad path refused, 10-minute cache, bundled fallback, sensitive filter; questions and answers never in any captured log record (token counts are logged as `usageIn` and `usageOut`); `requestId` in every error body; follow-up merge; exactly two help routes; the zip's `corpus.json` equals the web file (`tests/test_help_corpus.py::test_full_build_puts_the_web_corpus_in_the_zip` runs the whole Lambda build offline, with the dependency install faked, in every pytest run, so it is never skipped in CI); model answers with a link or domain, or a price the owner typed, fall back to the plain answer (`kb_ungrounded`). |
| Web (Vitest) | Retriever evals; composer; `when` filter; a bad action `to` is dropped; generator `--check`; nothing sensitive and no em or en dashes in the corpus; `helpApi` 27 s timeout, no `keepalive`, one refresh on 401; 429 → countdown and no retry; 5xx or network → local answer; status off → hidden and no local answers; live fill and live failure; unsaved guard; dodge math. |
| Playwright, mock mode (`e2e/help.spec.ts`, 375 × 812 and 1440 × 900) | Launcher name and place (not over the tab bar or update bar, above the update bar on desktop); three suggestions; "Where do I change my click sound?" → steps, vermilion **Open Sounds**, navigation to `/settings/look-and-feel/sounds`, the Click sound row gets the ring (panel closed on 375, open on 1440); the best-clip question shows the mock number; a refusal; `#429` notice with Ask disabled; `#503` → local answer and the copy-code link; `#off` → launcher gone; Escape returns focus; the Ask field spans the panel with a 44 px icon-only **Send** paper plane inside it (off when empty, Shift+Enter adds a line, four lines then scroll), the plane flies with its trail on send and the question bubble shows at once, the tap sound plays on click only; reduced motion → no animations, the plane only fades; each posting and skills guide opens its real page (`/settings/posting/setup/{platform}`, `/settings/clip-making/skills…`) and lights up its control (`setup-connect`/`setup-progress`, `skill-form`, `skill-edit`, `skill-delete`); dodge on scroll; no launcher over **Keep** on Review before any scroll (375 and 1440); after an answer button the spotlit control is the element at its centre (`elementFromPoint`), so nothing covers it; the conversation is still there after Close and reopen; Tab stays inside the phone sheet; the settled phone launcher covers no control at 320, 375, 390 and 430 px, with and without `?update=1`. `overflow.spec.ts` adds the open panel at 320, 375, 768, 1024, 1440 and 1920 px, with a five-line question and the field's width; `screenshots.spec.ts` adds it at 375 and 1440 px, plus `help-review-launcher-*`, `help-spotlight-keep-*`, `help-panel-reopened-*`, `help-ask-box-*` and `help-plane-flying-*`. Port 4179 by default, `CF_E2E_PORT` for another ([Web](#web)). |
| Infrastructure (`terraform test`) | `HELP_*` env on `cf-prod-api` (enabled in prod, off by module default); statement `HelpModel` has only `bedrock:InvokeModel` on the EU profile ARN and the six foundation-model ARNs; the model id comes from `config/models.json` (`eu.` for help, Fable still `global.`); CORS exposes `retry-after`; the metric filter and the alarm exist; `models.json` parses and `helpModel` names a model. |

## Contrast and text size

`web/e2e/contrast.spec.ts` (Playwright, mock mode, audit F081) opens every route in `ROUTES` (`web/e2e/helpers.ts`) at
320, 375 and 1440 px, with the browser asking for a light and then a dark colour scheme (the app is dark-only, so light
must render the same), with reduced motion so the backdrop's drift is parked and every run measures the same picture.
On each it fails on:

| Check | Rule |
|---|---|
| axe-core (`@axe-core/playwright`) | The `color-contrast` rule reports no violation. axe marks text on glass "needs review" (it can't see through `backdrop-filter`), so the next check covers glass. |
| Rendered contrast (`scanText` in `helpers.ts`) | Every visible text run, and what is typed in a field (or its placeholder while it is empty), reaches 4.5:1, or 3:1 for large text (24 px and up, or 18.66 px bold and up), against every background it can sit on: each ancestor's background colour and every stop of its gradients (the glass tints) composited over the backdrop, with the glass's `saturate()` and any ancestor `opacity` applied. The backdrop is photographed alone; a text run is tested against the darkest, the lightest and the quartile colours of the backdrop columns under it, over every row it can reach by scrolling (only its own rows when it is fixed). |
| Text size | No visible text is smaller than 12 px (the smallest token, `--fs-xs`, is 12.48 px). |

**The see-through window is held to the same bar.** In the desktop app's see-through look the page is transparent,
so there is no backdrop to photograph: the operating system draws the glass. The spec therefore simulates the
desktop app (`asDesktop` in `web/e2e/glass.ts`) and paints a stand-in for the glass behind the page (`paintGlass`),
then runs the same axe and rendered-contrast checks, for each glass that has its own tints:

| Glass | Painted behind the page |
|---|---|
| `liquid` (macOS 26+) | The floor it is planned for, rgb(106, 106, 106); the two measured floors, rgb(118, 118, 118) (another app in use) and rgb(180, 171, 148) (window in use); a busy picture blurred and mapped to the measured range, in use and not in use; white |
| `vibrancy` (also stands for `acrylic` and `mica`: the same numbers) | Black (nothing is promised for these glasses) and white |
| `blur` (Windows 10) | The app's tint over black, ≈ rgb(136, 135, 131), and white |

On every app route plus This week and the skill pages, at 320, 375 and 1440 px; and, per glass, on the screens an
address cannot reach: Frosted, the sign-in card, a clip page and This week with a starred star, the Ask panel with an
answer, a delete sheet, a toast. `paintGlass` waits two frames, so the photograph of the backdrop never shows the
paint before. The stand-ins and what they stand for are in
[Background modes and see-through glass](#background-modes-and-see-through-glass).

Not checked by the rendered-contrast pass: text on a picture (an `img`, `video`, `canvas` or `url()` background under
it; a picture painted on `<html>` as a stand-in for the glass is part of the backdrop and is checked), which axe
still checks; controls that are switched off (`:disabled`, `aria-disabled="true"`, exempt in WCAG 1.4.3);
visually hidden text (`.sr-only`). The spec has an allow-list for decorative `aria-hidden` text; it is empty, and every
entry must say why. `whiteContrastOnGradient()` in `helpers.ts` (white labels on vermilion buttons, used by
`audit-performance.spec.ts`) uses the same browser-side contrast kit.

The same three checks read the floating setup list in every face it has (open column, folded pill, glass bar, phone
sheet, skip question, "All set!", the Settings cards), light and dark: see
[The floating setup to-do list](#the-floating-setup-to-do-list).

The unit test `web/test/designTokens.test.ts` keeps [UX_DESIGN_SYSTEM.md](UX_DESIGN_SYSTEM.md)'s colour and radius
tables equal to `web/src/styles/tokens.css` and fails on a hard-coded `border-radius` outside the `--r-*` scale.

## Action motion

The action animations on buttons ([CONTRACTS.md §20](CONTRACTS.md#20-action-animations-owner-request-2026-11-16),
[UX_DESIGN_SYSTEM.md](UX_DESIGN_SYSTEM.md#action-motion-every-action-button-acts-out-what-it-does)) are tested like
everything else, offline against the mock app.

**The gallery.** `/__motion` is a test page that exists only in the mock build (`npm run dev:mock`, and the Playwright
server): one Button per kind, a "Make them fail" switch, a stepper and a segmented control. Use it to look at any
motion by hand, light and dark, with Reduce motion on and off.

```bash
cd web
npx vitest run test/motion.test.tsx
CF_E2E_PORT=4185 npx playwright test e2e/motion.spec.ts e2e/motion-*.spec.ts --workers=4
```

| Suite | Must show |
|---|---|
| Vitest (`test/motion.test.tsx`) | `nextAct` state machine; tokens in `motion.css` equal `ACT_TOKENS` and every duration is 180–760 ms; every kind has its rules in `motion.css`; `useAction` returns to idle after `ACT_MS`, reads Reduce motion at each play, clears its timer on unmount, plays one deny on `fail()`; Button calls the handler once and before the play, does not play when `aria-disabled` or `loading`, ends in `is-fail` on a rejected or `false` promise, does not play over a handler that failed its own handle (a refused Keep), honours `playOnClick={false}`, holds the spinner back until the motion ends; Stepper, Segmented and ErrorPanel mappings; the 300 ms sound de-duplication; `paperPlane.test.tsx` unchanged. |
| Playwright `e2e/motion.spec.ts` (CORE, the gallery) | Every kind: the handler fired while `is-play` is on, then back to `is-idle` within `ACT_MS + 200`; failing actions shake with one deny and no success; the stepper and segmented bumps; reduced motion from the OS and from the Settings switch: every kind gets `is-fade` and no `.act__item` has a transform at 25 / 50 / 75 %; at 320, 375, 430, 768, 1440 and 1920 px nothing scrolls sideways and no button changes width mid-animation. |
| Playwright `e2e/motion-home-jobs-review.spec.ts` | Make clips flies and the job starts before the flight ends; a disabled Make clips does not play; Paste (and its failure), Clear, the dropzone (plays on the file, shakes on a wrong one); the stepper and Exactly bumps; Stop job then Undo rewinds; Try again on a failed job; Keep pops the heart with its confetti; a refused Keep only shakes (never `is-play`); a Keep that does not finish shakes Try again; Throw away then Undo returns the card (`.is-returning`); caption tabs bump; the checks chevron turns; reduced motion; no overflow mid-animation. |
| Playwright `e2e/motion-library-clip-help.spec.ts` | Library Try again; This week: arrows slide, the newest week's Later week plays `nudge` (not a shake), the star spins on and settles off; Refresh numbers; the clip star; Ask's chips launch the plane, Start over, Copy the help code (and its failure); reduced motion; no overflow at six widths. |
| Playwright `e2e/motion-settings.spec.ts` | Every Settings, setup and skill control's kind, the pickers playing on the file, the Undo rewinds, the failure paths, reduced motion and no overflow. |
| Playwright `e2e/motion-shell.spec.ts` | The sidebar turn, Get the app chips / Download / Copy the link (and a blocked clipboard), Reload; sign in: Sign in snaps its link, a wrong password shakes it with one deny, the eye blinks, Start again turns. |
| Playwright `e2e/sound.spec.ts` | A touch swipe that starts on Review's Keep fires no click, plays no sound and leaves every `.act` at `is-idle`. |
| Playwright `e2e/overflow.spec.ts` (through `findOverflow` in `e2e/helpers.ts`) | Glyphs inside `.act:not(.is-idle)` are skipped while they play (like the flying plane); an idle `.act` is measured, so a glyph that overflows at rest fails. |
| Playwright `e2e/screenshots.spec.ts` | `screenshots/motion-mid-{light,dark}-{375,1440}.png`: send, keep, delete, refresh, save and copy paused at 50 % in the gallery. |

## Background modes and see-through glass

See-through, Picture and Colours ([CONTRACTS.md §22](CONTRACTS.md#22-background-modes-and-see-through-glass-owner-request-2026-11-16)).
Everything but the native window effect is tested offline against the mock app.

```bash
cd web
npx vitest run test/background.test.ts
CF_E2E_PORT=4186 npx playwright test e2e/background.spec.ts e2e/contrast.spec.ts --project=chromium
CF_E2E_PORT=4186 npx playwright test e2e/screenshots.spec.ts -g "see-through|settings-background" --project=screenshots
cd ../api && uv run pytest tests/test_settings_and_system.py
cd ../desktop/src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

| Suite | Must show |
|---|---|
| Vitest `test/background.test.ts` | WCAG contrast maths; `minVeil` is the smallest veil reaching 4.5:1; the measured Liquid Glass numbers and its floor, a tenth darker than the darkest measured; `TINTED_FLOOR` is the app tint (140/255) over black and equals `GLASS_TINT` in `main.rs`; black for the unmeasured glasses and for any dark setting; the window look's text colours: only four change, each to a relative luminance of 0.047 or less, the same hue, still told apart; Clear is the least that reaches AA and never under 0.35; Frosted is the 0.30 frost plus panels 0.15 heavier, and always shows less; **every glass × light and dark × Clear and Frosted × (floor, white, and for Liquid Glass both measured floors): every text colour of the window look reaches AA on a panel, on a pick-one track and on every tinted chip**; the stylesheets stay in step (`tokens.css` values and the `html.see-through` overrides, every `color:` declaration is a token or a named exception, the window-look rules for placeholders and marks exist, the numbers 0.08, 0.10 and 0.20 in `glass.css` are the ones in `background.ts`, the panel rule gives way to denser tints and lifts the tab bar); colours are 1–3 distinct `#rrggbb`; the colours veil holds AA on each colour and each pairwise blend; `resolveLook` for every mode and glass; only `__CF_DESKTOP__ === true` with a known `__CF_GLASS__` means real glass, an unknown name is `none`, and every name `main.rs` can send is known; the computer and phone sentences word for word; prefs defaults and junk; a picture with no saved mode starts in Picture; `applyLook` puts `see-through`, `data-backdrop`, `data-glass`, `data-strength`, `--backdrop-veil` and `--panel-veil` on `<html>`. |
| pytest `test_settings_and_system.py` | Defaults (no `backgroundMode` until saved, `clear`, the Clip Factory colours), saving (lower case, repeats dropped), a saved mode survives other saves, each refusal with its message, malformed stored values read as defaults. |
| Playwright `e2e/background.spec.ts` | Default and browser fallback (frosted backdrop, caustics, the sentence and its Get the app link); on an iPhone the phone sentence and no link; switching modes; the backdrop draws exactly the chosen colours with the computed veil; a fourth colour is refused; your own colour; persistence over a reload; Picture with and without a picture; an old picture with no saved mode is still shown (and after a reload); Glass strength picks see-through and thickens the frost; Night alone: previews wear the veil, the soft-colours line shows; search finds the new apples. Simulated desktop (`asDesktop` in `e2e/glass.ts`: `page.addInitScript` sets `__CF_DESKTOP__` and `__CF_GLASS__`). `liquid`: `html` and `body` transparent, no tint between panels for Clear, panels at the computed `--panel-veil` (under 0.5), the four deeper text colours on `<html>` and in drawn words, Frosted frosts the gaps and makes panels heavier, Colours brings the page and the usual text colours back. `vibrancy`, `acrylic`, `mica` and `blur` keep working, each with its own tint and AA on its darkest; a dark setting assumes black. Over the measured floors rgb(118, 118, 118) and rgb(180, 171, 148), the busy picture, the planned floor and white, every word on the Background page is readable, Clear and Frosted, at 375 and 1440 px. No visible text straight on the window (every surface under words is at least as strong as the look's own panel tint) on every screen, This week, the skill pages and a clip page, for `liquid` and `vibrancy`, at 375 and 1440 px. Glass `none` shows the in-app sentence; a glass name the page does not know gives an ordinary page. At 320, 375, 768, 1440 and 1920 px, light and dark: no overflow in any mode, one-line tile names, AA text on the darkest colour. |
| Playwright `e2e/contrast.spec.ts` | The window look on every screen: see [Contrast and text size](#contrast-and-text-size). |
| Playwright `e2e/screenshots.spec.ts` | `settings-background-*.png` (phone and desktop, light and dark) and the simulated see-through window on Home, Clear and Frosted, at 390 and 1440 px: `see-through-scene-*.png` over the busy picture as Liquid Glass shows it while the window is in use, `see-through-floor-*.png` over the darkest measured floor. |

**The stand-ins are not the real glass.** They are flat colours and one blurred picture, mapped through the four
measured numbers. In a browser a panel's own blur and saturation also work on the stand-in, which the real window may
not do. So the look is checked by hand on a built app as well.

### Hand check: the real window

The native effect (macOS Liquid Glass or vibrancy, Windows acrylic or blur) is drawn by the operating system outside
the web page, so no browser test can see it. After a desktop build, check it on **macOS 26 or newer**, on
**macOS 15** (or older) and on **Windows** (11, and 10 if there is one), with known pictures straight behind the
Clip Factory window.

1. Make the pictures: one pure black, one pure white, one with 22 pt black and white stripes, one with a few words in
   75 pt bold and one line of normal text, and a photo with clear shapes (a car).
2. Open a picture full screen (Preview or Photos), put the Clip Factory window on top of it, and pick See-through in
   Settings › Look & feel › Background.
3. Look twice at each picture: once with the Clip Factory window **in use** (click it), once **not in use** (click
   another app's window that does not cover it).
4. Read colours off the screen with a colour picker (Digital Color Meter on a Mac, the PowerToys colour picker on
   Windows): the bare glass between two panels, and the middle of a panel.

- [ ] **The page knows its glass.** In a debug build (`npm run dev` in `desktop/`), the web inspector's console
      gives `document.documentElement.dataset.glass`: `liquid` on macOS 26+, `vibrancy` on macOS 15 and older,
      `acrylic` on Windows 11 22H2+, `blur` on Windows 10 and Windows 11 21H2.
- [ ] **macOS 26+, bare glass.** It should match what was measured on 2026-11-16, give or take 5 levels:

      | | Over black | Over white |
      |---|---|---|
      | Window in use | rgb(180, 171, 148) | rgb(249, 248, 245) |
      | Window not in use | rgb(118, 118, 118) | rgb(225, 225, 225) |

      These were measured with the earlier light tint; with the bottle-green tint (ADR-43) the glass in use reads
      darker and greener. A panel should measure close to `mix(bottle green, glass, 0.73)`. Readability no longer
      depends on these numbers: the page plans for white behind every glass (`glassCeiling`).
- [ ] **macOS 26+, the system's own settings.** The numbers above were read with the system in dark mode only.
      Read the glass over the black picture again, in use and not in use, three more times: with the system in
      light appearance, with Reduce transparency switched on, and with Increase contrast switched on (System
      Settings › Accessibility › Display). Write the numbers down in CONTRACTS.md §22.3. If the glass over black is
      ever darker than rgb(106, 106, 106), adjust as described just above.
- [ ] **macOS 15 and Windows, bare glass.** Nobody has measured these: write down the glass over black and over
      white, in use and not in use. The page assumes **black** for them and gives panels 0.68. If the glass over black
      is clearly never darker than some grey, add the numbers next to `LIQUID_MEASURED`, give `glassFloor` that
      grey (a tenth darker) for that glass, and its panels get clearer. On Windows 10 the blur should be no darker
      than rgb(136, 135, 131).
- [ ] **Over white, every word is easy to read**, in use and not in use: body text, meta lines, vermilion-tinted
      links and the "Didn't work" pill (Jobs), green "Saved" and "Best guess" words, placeholders in empty fields, the
      labels of segmented bars, a toast, a delete sheet and the Ask panel. That is the case the tints are worked out
      for (bone words on bottle-green glass).
- [ ] **Over black, the same words are still easy to read**, and outlined bone buttons still look like buttons.
- [ ] **Over the stripes and the big words:** the stripes come through as soft bands, the 75 pt words can be guessed,
      the normal line cannot be read. Through a panel the same, softer.
- [ ] **Over the car:** its edges are guessable between the panels and softly through them, never sharp.
- [ ] Frosted shows less than Clear; Colours and Picture cover the desktop completely.
- [ ] The window stays glassy when another app is in front, and resizing or dragging does not lag.
- [ ] Linux: an ordinary window and the "This computer can't show see-through" line.

## What the tests must cover

### Web (Playwright, mock mode)
- **Sign-in screen**: renders, shows errors in plain English; mock mode skips it with a fake owner.
- **Main flow**: paste a YouTube link → job appears → steps advance → clips appear → open a clip → edit a caption →
  Confirm → celebration → the clip leaves Review and the badge counts down. Decline removes a clip.
- **Upload**: pick a file → progress → job created from the upload.
- **Watch the video** (`e2e/deep.spec.ts`, `test/deepSteps.test.tsx`,
  [ADR-40](DECISIONS.md#adr-40-watch-the-whole-video-before-picking)): a new job shows the ten steps in order with
  their plain labels, "Watch the video" fifth; a job saved with the old nine steps still shows its nine (the mock's
  `__cfMock.jobs.oldSteps()` knob makes one); a skipped Watch step shows its message. On Review, a clip with
  `pickedFor` shows one small "Why: Loud laugh + Fast action" line under the summary and a clip without shows no line
  at all, at 320, 390 and 1280 px, with no cursor change and no sideways scroll. The mock's step labels equal the
  API's list.
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
  - No overflow at every width from 320 px, at most one main vermilion button per screen, axe clean, on the field, every tree
    and every branch.
- **Set up posting**: covered under [Posting setup](#posting-setup).
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
- **Earnings** (`e2e/earnings.spec.ts`, [CONTRACTS §21](CONTRACTS.md#21-earnings-what-each-clip-probably-made-per-platform-owner-request-2026-11-16)):
  YouTube, Facebook and X start on, so the clip page first shows "Earned about $X" on those stacks (never "about less
  than 1¢") and "This clip earned about $Y" with a Best guess tag (equal to the stacks' sum within a few cents), while
  TikTok shows "Earned $0.00" with "Turn this on in Settings › Money if TikTok pays you."; "How is this worked out?"
  uses the short app names, says replays are left out, shows "off, so $0" and "clip too short, so $0", puts each mark on
  a dark round tile (`aria-hidden`, so X never reads "X X"), says "This only counts if you are in {App}'s paid
  program." with the app's `kidRules` under YouTube, Facebook and X (never under an app that is off), and links to
  Settings › Posting › Money; with YouTube, Facebook and X switched off the clip page shows "This clip earned $0.00"
  with "These apps are switched off in Settings › Money.", no Best guess tag, and per stack "YouTube does not pay you
  for views right now." plus what it would be; the Money edit flow starts with YouTube, Facebook and X on (each with its
  paid-program line) and TikTok and Instagram off, refuses "abc", "0.055" and "1000" with a plain line, saves "2,5" as
  $2.50, switches TikTok on (its paid-program line appears and the clip page then says "TikTok only pays for videos 1
  minute or longer."), shows the sources in plain words with readable dates and 44 px links, and goes back with **Use
  the usual**; Library and This week show each clip's guess and the week total with a visible Best guess tag by
  default, then "Earned $0.00" with its reason once everything is off, without changing the order; no overflow at
  320/375/768/1440/1920 px. Vitest `test/earnings.test.ts` covers every formula and format (rounding, less than 1¢,
  "about" rules, minimum length incl. exactly 60 s, the on/off defaults and switched-off apps, `paidProgramNote`, custom
  rate, missing views never adding up to $0, `paidViews`, zero reasons, source dates); pytest covers the
  `earningsRates` / `earningsPaid` validation, the config defaults (YouTube, Facebook and X on; TikTok and Instagram
  off) and the week `paidViews`.
- **Old account links**: `/settings/posting/accounts` and `/settings?account=youtube&status=coming_soon` redirect to
  Set up posting (`settings-tree.spec.ts`).
- **Kid-proof** ([UX-13](BUSINESS_REQUIREMENTS.md#ux-13-kid-proof-a-68-year-old-can-use-it)): at most one vermilion
  button per screen (plus the update bar's Reload); every button on phones is at least 48 × 48 px; every button except
  the phone tab bar has visible text; Throw away shows Undo and sends nothing until 8 s pass; Undo restores the clip.

- **What it learned** (`e2e/learned.spec.ts`, `test/lessons.test.ts`): lessons grouped by creator with the chip,
  platform, evidence line and winner links; Turn off / Turn on; Delete only after "Delete this lesson?"; the empty
  and not-enough states; Find a setting reaches it; Library links to it; no overflow, tap targets ≥ 44 px and axe
  contrast at 320–1920 px in light and dark; the screenshots spec adds `settings-learned`.

### Scripts
- `scripts/release-areas.sh`: `Area:` lines win over the folder map; the folder map uses the longest prefix; no match
  gives `["Improvements"]`; no previous version gives `["First release"]`; at most three labels, duplicates removed,
  each 1–3 words.

### API (pytest)
- Every route in [CONTRACTS.md §5](CONTRACTS.md#5-http-api-api-gateway-http-api-v2--lambda-cf-prod-api): success
  shape, validation errors (`bad_request`), missing items (`not_found`), wrong state (`conflict`), sizes (`too_large`),
  and the posting setup routes of [§17.4](CONTRACTS.md#174-api-all-jwt-5-errors-routessetuppy-package-clipfactory_apioauth)
  (Connect without keys is `409 conflict` "Paste your {Platform} keys first.").
- The user id comes from the JWT claims, never from the body; one user cannot read another's items.
- A new or retried job has the ten steps with their plain labels ("Watch the video" fifth); a job saved with the old
  nine steps is returned exactly as saved; a clip's `pickedFor` passes through when the agent wrote it and is absent
  otherwise.
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
  `ask_week` and the daily lessons call (`lessons.ask`) send the block as `system[0]` (a built-in and an owner skill, legacy
  `enabled: false` items included) and the task prompt last, with a cache point only from 8,000 characters;
  `test_skills_everywhere.py` fails on any `.converse(` outside `learn.converse_text`, any `converse_text(` without
  `skills=`, an alias of `.converse` or `.invoke_model` (used without calling it), a model method named in a string
  (`getattr(b, "converse")`), `getattr` / `attrgetter` / `methodcaller` with a computed name, `converse_text` used
  without calling it, an `invoke_model` that is not the Titan call (`modelId=self.embed_model_id`) in
  `vectors.py`, and any `converse_stream`, with a failing sample for each; the help call (Ask Clip Factory) is kept
  under the same rule by `test_the_help_call_is_scanned_like_every_other` (one `converse_text(skills=...)` in
  `help/model.py`, a direct call flagged) and `test_the_owners_own_skills_reach_the_model` (one skills block first, the
  help rules last); the build zip contains
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
- **Job flow**: success → `finish`; timeout or missed heartbeat → `fail` with "Making the clips stopped partway.
  Tap Try again." and `stop-session`; `JobFailed` → the agent's message; `Canceled` and `Superseded` → no write; a job that is missing,
  has another `sessionId` or is terminal → `start-agent` skips and the flow ends `superseded` (already `running` with
  this `sessionId` → no second invoke, the flow waits); every write is fenced on
  `sessionId`.
- **Clip flow**: only `pending_integration` posts → outcome `not_posted` with no wait; a queued post is published once
  even when its step is replayed; exhausted retries mark only that post `failed`; the wait is named `wait-48h` and lasts
  48 hours; the retired `distil` step calls no model and writes no Learning (`{"outcome": "retired"}`); the vector is
  upserted with `performed` and the performance JSON.

### Learn from results (`api/tests/test_learn_results.py`, pytest)
[CONTRACTS.md §16.12](CONTRACTS.md#1612-learn-from-results-creator-lessons-from-day-7-numbers-owner-request-2026-11-18):
- **Creator key**: channel id first, normalised names, uploads have none; the agent's `creators.py` is a byte-for-byte
  copy.
- **Day 7**: the window edges (6.49 and 8.51 days out, 6.5 and 8.5 in); the reading closest to 7 days wins; nothing
  outside the window is used; `0` is a number, a snapshot without views is not a reading; old snapshots count only
  when their views changed; a refresh that did not read views (insights only on YouTube with metrics from before
  `viewsUpdatedAt`, counts only on Instagram) never stamps the old views as day 7, and an Instagram insights refresh
  that brings views does; a disconnect between reading the snapshots and writing day 7 keeps the number out; frozen once, missing stays missing; a post is frozen only after 8.5 days.
- **Winners**: an all-equal baseline names none (the MAD floor); fewer than 20 own posts falls back to "all
  creators"; too few anywhere names none and says how many more; platforms never mix; the clip under test is left out;
  a bigger channel's normal clips are not owner-wide winners (each post divided by its creator's median); a baseline
  of zeros names none (the views and median floors); a post is judged once, so an old post never becomes a winner
  when the 90-day baseline moves.
- **Traits**: 3 winners, 2 source videos, a lift of 1.5 (each guard alone), a missing fact counts on neither side, at
  least 10 other clips with the fact to compare with, "all creators" winners from 2 creators; two jobs of one stream
  are one source; a name two channels share joins neither.
- **Words**: an invented number is rejected and retried once; still wrong after the retry is dropped; a fake clip id,
  three sentences, ids in the text and number words are rejected (teens, tens, compounds, "x10", "x2", multipliers,
  fractions), number words from the evidence pass; no retry without time for it; the call sends the skills block first and asks for
  the JSON schema.
- **Daily run**: freezes, judges and writes a `trial` lesson with code-computed evidence; a second run the same day
  changes no item and calls no model; a quiet day and one lucky clip call no model; not enough clips gives the
  "needs" counts; one creator's Bedrock failure leaves the others learned and its winners unseen; the time budget
  defers the model call; trial → active only after 7 days and a new winner; expiry after 90 days; at most 5 active;
  off and on; a deleted lesson's tombstone blocks it; old clips get their creator from the job (read only); a name key
  joins its id key; owners come from gsi2 (Query, no Scan); `weekly.handle` runs the daily mode on `aws.events`; only
  posts of the last 90 days are joined and kept in `seen`; freezing stops when the budget is spent; a lesson is never
  written over the owner's delete or a disconnect; the state is not written over a disconnect (`version`).
- **Forget**: disconnecting YouTube removes every `day7*` field, the YouTube lessons and their state.
- **Routes**: GET, PATCH off/on (400 for anything else, 404 for a bad or unknown id, 409 when it keeps losing a race;
  "on" only from off, an expired lesson unchanged), DELETE (204, then 404 and gone from GET); an expired lesson reads
  `expired`.

### Live updates and webhooks (pytest)
- **Authorizer**: accepts a token signed with the fixed test RSA key in `tests/fixtures/jwks.json`; rejects a wrong
  `iss`, `client_id` or `token_use`, an expired token, a bad signature and an unknown `kid`; never logs the token.
- **`cf-prod-ws`**: `$connect` stores the connection with a 2-hour TTL, `$disconnect` removes it (with and without the
  authorizer context), `ping` answers `pong`, anything else answers `bad_request`.
- **Broadcast**: coalesces to the last change per item, maps sort-key prefixes to event types, sends deletes from
  `OldImage`, removes a connection on `GoneException`, switches to `partial: true` over 24 KB, and never includes
  internal fields.
- **Hooks**: Meta challenge (right token 200, wrong 403), YouTube challenge, TikTok and X webhooks 501, POST stores a
  `HOOK#` item with a 14-day TTL, 413 over 256 KB, unknown platform 404, the query string is never logged. The OAuth
  callback is covered under [Posting setup](#posting-setup).

### Follow creators (CONTRACTS §24)
- **pytest** (`api/tests/test_follows.py`): links and names parse to the right platform and id; other hosts, user
  info, ports, IP literals, non-channel pages and bad ids are refused, and a lookup never calls anything for them;
  avatars only from the platforms' picture hosts; viewers round to 2 figures; creator keys match §16.12. Twitch HMAC
  good, changed body, wrong secret, stale, no secret (401, nothing stored); the verification POST echoes the challenge
  as text; online then offline updates every follower, notices the stream once (WATCH `waiting`, `autoMaking` false,
  no `JOB#`), a repeated delivery does nothing and a late online is ignored; revocation marks the creator. Kick RSA
  with a throwaway key: good, changed, stale, forged (401) and the public key fetched again at most once in 10 minutes.
  Routes: a name alone asks which site, Twitch without keys is found by name, follow needs `permission: true`, follow
  again, list, switch, remove (only the owner's items), keys saved to Secrets Manager only with masked hints, the
  EventSub secret made once, Check it, Remove writes `{"removed": true}` and never deletes. The tick: nothing without
  keys, names and badges filled in, subscriptions once per creator, no writes when nothing changed, unsubscribe when
  nobody follows, a finished stream noticed, the lease, YouTube uploads only after the follow, the 1,000-unit meter.
  The live push maps `FOLLOW#` to its public shape and never pushes `FOLLOWKEYS#`.
- **vitest** (`web/test/follows.test.ts`): badge and line words, live first, initials, live events, Find a setting,
  and the mock's rules (keys before and after, Remove, knobs).
- **Playwright** (`web/e2e/follow.spec.ts`): which-site buttons, Follow stays off until "Yes, they said I can", other
  sites refused, How do I ask?, a Kick follow before keys then the grown-up's keys (and Hold to remove), live badges
  change by themselves, Remove with Undo, the switch, Limit how many a day, Home's row only when following, and the page
  from 320 to 1920 px in light and dark (no overflow, 44 px targets, contrast).
- **Manual release gate** (before part 2): a real Twitch and Kick webhook round trip from eu-north-1, and the YouTube
  channel page read from AWS (the consent page).

### Posting setup
From [CONTRACTS.md §17.12](CONTRACTS.md#1712-tests-offline-fakes-only-no-aws-no-network). Everything offline: a fake
Secrets Manager, a recorded `HttpClient` with fixtures per platform, a `FakeDurableContext`, and the web mock mode with
its pretend consent page `/mock-oauth/{platform}`.

- **API, Connect** (pytest): state sign and verify (tampered, wrong platform, expired and reused all end `expired`);
  the PKCE verifier is deterministic and never stored; key formats (one good and one bad sample per row of §17.4, a
  Meta Login URL gives the `configId`); responses carry only masked hints, and no secret appears in any response, log
  line or DynamoDB item (the fakes are scanned); new keys with another `clientId` → `keys_changed`; Connect without keys
  → 409; the exact authorize URL per platform (PKCE only YouTube and X, no `scope` for Meta, `auth_type=rerequest`
  after `missing_permissions`); the callback per platform with recorded answers for every result code, several Pages →
  `choose` and the choose route; `Location` is always the fixed path with a listed code; the query is never logged;
  Check it per platform; Disconnect deletes the secret, revokes and sends YouTube's `forget`.
- **API, tokens and posting** (pytest): Google refresh keeps the old refresh token; TikTok and X rotation write the new
  secret before use, and the lease serialises two refreshers; `invalid_grant` → `needs_reconnect`; TikTok
  `expires_soon`; publishers against `tests/fixtures/publish/{platform}_*.json` (YouTube resumable and resume after an
  interruption, TikTok chunk maths for 3, 70 and 200 MB, Instagram resumable headers, Facebook `finish` → `complete`
  fallback, X 4 MB appends and links removed, caption limits); clip flow step and wait names
  `publish-/wait-/check-/finish-{platform}-{n}`, a replay with `publishHandle` creates nothing twice, `maxChecks`
  outcomes, the at-most-once message, `ReconnectNeededError` → failed, private TikTok → no `gsi2`, the TikTok id
  follow-up; the friendly error table; the X monthly cap; TikTok Keep options required and validated; broadcast
  `ACCOUNT#` and `SETUP#` → `setup`; `config.load` with the §17.7 values.
- **Infrastructure** (`terraform test`): the state-key secret uses `secret_string_wo` (no `secret_string`); IAM exactly
  as §17.9 per role (no secrets access for the job flow, realtime or learn); hooks timeout 28 s; environment variables
  on api, hooks, flows and stats; seven stream filter prefixes; output `oauth_callback_base` ends in `/oauth`;
  `test-write-web-config.sh` requires `oauthCallbackBase`.
- **Web units** (Vitest): every guide file has unique step ids (`^[a-z0-9-]{1,40}$`), `checkedOn` "2026-11-16", https
  Open links, known `ValueRef`s, the four parts in order and one `connect` step; key format samples (the same as the
  API's); `setupProgress` (optional steps not counted, auto steps, current step, ready rule); a sentence for every result
  code on every platform; the key file from Google fills both boxes.
- **This page and the app agree** (Vitest `setup-docs.test.ts`): it reads [SETUP_POSTING.md](SETUP_POSTING.md) and
  checks that under each `## {Platform}` heading every step title of that platform's guide appears, with the same
  number and in the same part (`### Part n: {part title}`, then `#### {number}. {title}`).
- **Playwright** (mock mode, `e2e/setup.spec.ts`, every journey at 375×812 and 1440×900, for every platform): the
  floating setup list "0/5" with that platform's **Set up** link → Set up posting → platform page; Get ready ticks; every Open button has the exact `href` and
  `target=_blank`; Copy puts the value on the clipboard and shows "Copied!"; a bad key shows the friendly error and Save
  stays disabled; good keys show only masked hints; Check it with working keys and nothing connected says "Your keys work. Now press
  Connect {Platform}." (the same sentence as the API); TikTok's verification file is listed; Connect →
  pretend consent → **Allow** → confetti, "Connected as", full ring; Facebook and Instagram choose an account; **Cancel**
  → the `denied` sentence; a reload resumes at the first unfinished step; TikTok shows "Works now, but your TikTok posts
  stay private until TikTok says yes."; an expired token shows the vermilion **Connect again**; Disconnect → Undo within
  8 s keeps it, after 8 s it is gone; all five ready → the floating setup list is gone and "5 of 5 ready".
  `e2e/tiktok-sheet.spec.ts`: Keep stays disabled until a privacy is chosen; branded content hides "Only me".
  **Try again** on a failed clip whose TikTok post needs new privacy choices opens the Post to TikTok sheet first and
  sends `{tiktok: {...}}` in the confirm body; the mock replaces that post's `postOptions`.
  `overflow.spec.ts` covers the setup list, each platform page, `/mock-oauth/youtube`, `/about.html` and the TikTok
  sheet from 320 to 1920 px; `screenshots.spec.ts` adds the list and the YouTube page at 375 and 1440, light and dark.

### The floating setup to-do list
From [CONTRACTS.md §17.13](CONTRACTS.md#1713-the-floating-setup-to-do-list-owner-request-2026-11-16).

- **Web units** (Vitest `test/setupTodo.test.ts`): a row per platform in the setup order with the right state and
  line; the list shows while anything is left and not before the data is in; it goes away when all are ready, all are
  skipped, or a mix; a confirmed skip finishes a row in any state that is not ready (half done, a dead token, an
  account to pick, a gate in `action`), so skipping every row always ends the list; an unconfirmed skip changes
  nothing (only the saved `setupSkipped` counts); ready wins over a skip and makes that skip stale, so a platform that
  was ready and stops being ready comes back; skip and un-skip keep the canonical order; both skip questions, the
  skipped note and the three "All set!" lines; hidden on the setup pages only; the pill, never the column, on a clip's
  page. **House rules read from the CSS**: `setup-todo.css` sets no `cursor`, no `backdrop-filter` and no background
  on a surface (the column, the pill, the bar, the panel, the card are the shared `.glass`); and with the column open
  at `TODO_RAIL_MIN` (1440 px) the page keeps at least the room it has at every width where a layout goes wider (it
  fails if someone adds a wider layout or widens the column). `test/session.test.tsx`: a settings updater builds on a
  save that is still on its way, so two list changes sent close together both land. `test/setupTodoList.test.tsx`
  (the component, as the pill): a device that has seen the list keeps its room while the setups load and gives it
  back when they cannot be read, one that has not holds none; the panel is a dialog with the page behind it `inert`;
  **Skip** asks first, **Keep it** saves nothing, the confirmed skip and **Un-skip** each save the whole list.
- **API** (pytest): `setupSkipped` defaults to `[]`, is saved in canonical order without repeats, un-skip shrinks it,
  bad values are 400 and a bad stored value reads as `[]` (`test_settings_and_system.py`); a skipped platform that is
  not connected gets a `pending_integration` post, never `queued`, and a skipped connected one is still `queued`
  (`test_clips.py`).
- **Playwright** (`e2e/setup-todo.spec.ts`): on every main page and not on the setup pages; a clip's page shows the
  pill on its glass bar and keeps its five-column fan; **Set up** opens each platform's page; **Skip** needs the
  confirm (**Keep it** is first, focused and the main vermilion button; **Keep it**, Escape and a tap outside change nothing),
  lasts after a reload, **Un-skip** from the list; a row that needs the owner (X out of credits) can be skipped,
  skipping every row ends the list, and once X is ready its skip is dropped, so it comes back when it needs the owner
  again; ready + skipped → "All set!" with the line for how it ended, confetti and the success sound, then gone, still
  gone after a reload, Settings says "All done"; an expired token brings it back with "Needs you: connect again";
  reduced motion has no confetti; it asks for the setups again on a page change; fold to the pill and unfold,
  remembered after a reload; Settings › Set up posting: **Skip** with the same confirm, "Skipped" on the card,
  **Un-skip**. **Where it sits**: the column opens at 1440 px and not at 1439 or 1280 px, the page keeps at least its
  1100 px room and Home's headline keeps its full stop; at 1440×860, 1440×790 and 1536×730 every row and both of its
  buttons show without scrolling, clear of the Ask pill, and a 600 px tall window fades the bottom; "All set!" on a
  setup page moves nothing at 1440 and 375 px. **Phones**: the pill above the brand row, the panel above the tab bar,
  48 px targets with 8 px between a row's buttons, the page behind the panel `inert` (messages are not), Tab and
  Shift+Tab stay inside, Escape returns focus to the pill, **Set up** lands focus on `<main>`; the pill stays on
  screen at every scroll position of every main page on its glass bar, and Tab brings a control out from under the
  bar; the last skip from the panel leaves focus on `<main>`; at 320 px the pill still says "Set up posting".
  **Everywhere**: at 320, 375, 768, 1024, 1280, 1440 and 1920 px in light and dark it covers no control at the top,
  middle or bottom of any main page, nothing overflows, every target in the open list is at least 44 px (48 px on
  phones), and the pointer stays the plain arrow on the list and on the skip question.
- **Readable** (`e2e/contrast.spec.ts`, the three checks of [Contrast and text size](#contrast-and-text-size)): the
  routes carry the list in its plainest face (five "Not started" rows: the column at 1440 px, the pill at 320 and
  375 px); six more tests read every other face in light and dark: the open column and the phone sheet with one row of
  every kind (`mixedSetup` in `e2e/helpers.ts`: ready, skipped, half done, needs you, not started), the folded pill,
  the pill under the pointer and on its glass bar, the skip question over the column and over the sheet, "All set!"
  as the column's card and in the pill's strip (its goodbye timer is held so it can be read), and Settings › Set up
  posting with its Skip and Un-skip lines. Each makes sure the list's own words were among the text it read.
- **The audit's specs run with the list showing**: `audit-setup.spec.ts` (the Settings cards with their Skip lines at
  every width, and the rule Home's card had: no line of the list starts with a lone mark at 320–414 px),
  `performance.spec.ts` and `audit-performance.spec.ts` (no setup is skipped first), `glide.spec.ts` (only the arrow
  cursor), `overflow.spec.ts` (ready rows included) and `help.spec.ts` (the launcher never rests on a control, the
  list's buttons included, at every width, with the update bar and with other fonts).
- **The list and the Ask pill**: `e2e/setup-todo.spec.ts` checks at 1920×900 with the update bar, 1440×900 and
  1440×600 (rows scrolled out of the column) that the Ask pill keeps its corner under the open column at every scroll
  position: not lifted, not stepped aside, on none of the list's buttons, at least 12 px below the column. Vitest
  `test/helpDodgeText.test.ts` covers `shownBox` (what a scroller cuts off is no obstacle; a fixed box and an
  absolutely placed one are cut only by what really holds them) and `controlBoxes` with the column's own scroller.
- **No jump on load**: on a device that has seen the list, a reload keeps the list's room from the first paint (the
  shell's paddings never change while the page loads) at 1440 and 375 px.
  `screenshots.spec.ts` writes `setup-todo`, `-open`, `-skip`, `-skipped` and `-all-set` at 375, 1024 and 1440 px,
  light and dark, and `setup-todo-scrolled` (the pill on its glass bar) at 375 and 1024 px.

### Agent (pytest)
- Prior learnings (`tests/test_learnings.py`): the exact heading `Prior learnings`, only active unexpired lessons for
  this job's creator keys and then "all creators" (trial, off, deleted, expired and other creators' lessons left out),
  the section left out when empty, and present right after the skills block in the moment-picking SDK prompt file, the
  Converse fallback, the second look, the checklist review and the captions; the retired 48-hour learnings never reach
  a prompt.
  Finalize stores `creatorKey`, `creatorKeys`, `creatorName`, `wordCount`, `firstWordSec` and `spokenText` (absent
  for an upload without speech).
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
- **Watch the video** ([ADR-40](DECISIONS.md#adr-40-watch-the-whole-video-before-picking),
  [CONTRACTS.md §8](CONTRACTS.md#8-agent-agentcore-runtime-cf_prod_clip_agent)). Nothing here calls AWS: Bedrock,
  Transcribe, S3, yt-dlp and (except one test) ffmpeg are fakes.
  - `test_picture.py`: the rendition ladder (tallest H.264 up to 480p, video-only before one with sound, so Twitch and
    Kick get 480p; then the smallest with a picture) and the disk rule (nothing fits → no picture, no failure); the size estimate's fall-backs; the picture download's
    arguments; the one ffmpeg command (two outputs from one input, `fps=2`, 768×432, `-g 2`, 300-second parts,
    `-skip_frame nokey` only for the keyframe plan); score parsing (mean and max per second); motion spikes (2.5 × the
    median around, merged, a still picture never spikes); frames by time across two parts, from disk or fetched; the
    smaller re-encode (parts over 18 MB); `prepare` runs ffmpeg under `time_limit`; the decode-speed probe and a
    failed probe counting as zero; and, when ffmpeg is installed, a real run on a generated video (parts, scores, frames).
  - `test_watch.py`: the chunk plan (150 s, 6 s lead-in, 12 hours = 288 chunks, never over `MAX_CHUNKS`); which frames
    are sent (one per 2 s, every frame within 3 s of up to 5 spikes, at most 30 extra); the strict schema; clamping
    times to the chunk and dropping dull events; the request (a time stamp before every image, then the words with
    speakers); resume from saved chunks; a busy service tried again with growing pauses (5, 10, 20, 40 s, never past
    the deadline) up to `MAX_TRIES` and never for a refusal; a rate-limited fake account (two calls at once, the rest
    throttled) still gets all 48 chunks of a 2-hour source watched; the pacer halving on a throttle, growing back and
    refunding the budget; a request refused for its images split again and again until accepted, the number named in
    the error learned and used for later chunks, every chunk refused once still all watched (the budget grows), the
    other pieces tried when one fails, a single refused frame ending as a failed chunk; the deadline; a cancel
    stopping the calls in flight; the call budget.
  - `test_nova.py`: the video block and the part's start time, no cache point; times shifted by the part's start;
    nothing called without a watch model; a denied or missing model stops the track at once, invalid requests after
    three; one bad part loses only that part; a busy part tried again up to `MAX_TRIES`; a part over 25 MB is not sent.
  - `test_verify.py`: time moves only within 5 s; the result validated again; a weak moment swapped for the best
    spare that passed its own look; never fewer than `clipTarget.min`; any failure keeps the moment as picked; a request refused for its images is
    thinned evenly (both ends kept) and later looks start thin; a tripped second-look budget keeps the picks.
  - `test_signals.py`: merging the two watchers; hot spots from any one track alone and from several (they add up,
    with the agreement bonus); the silent flag from the words; the timeline text with its 120-event and 25-hot-spot
    caps; every row of the `pickedFor` table, at most 40 characters.
  - `test_guard.py`: a budget allows its limit then trips, and a tripped guard is not retryable; the deadline; the
    chunk count never passes 400.
  - `test_pipeline.py` runs **all ten steps** against in-memory S3 and fake models and ends `ready` for every
    degradation row: no rendition that fits, a disk too small, a blocked download, a failed ffmpeg pass, a picture
    that takes too long, some Fable chunks failing, all of them failing, Nova denied, both watchers failing (the
    motion remains), no speaker labels, `signals.build` throwing, a failed second look, `pickedFor` that cannot be
    built, `CF_DEEP=off` (no speaker labels asked for either, also on a Try again with a saved log), a storage failure while
    saving the log (what was seen still reaches the finder), a cancel while the picture is still preparing (nothing
    left on disk), the disk filling up between resolve and the download, a failed download leaving no files, the
    second look raising, under half watched ("part of the video"), and a tall long upload decoded fully or at
    keyframes by its measured speed. Also: Try again reuses everything that was
    watched (no new model call, no new download) or watches only what is missing; `close` cancels the picture task;
    few words with strong picture events goes on, few words without them fails with the old sentence.
  - `test_agent.py`: without signals `system_prompt`, `hints`, `read_transcript`, `transcript.lines`, `brief_json` and
    the Converse gate are **byte-identical** to the code before ADR-40 (hashes taken from `origin/main` at
    `0abfbe2`); a window with no words but a strong picture event is read.
  - `test_transcribe.py`: the speaker-label settings are sent; a refused start is sent once more exactly as before; a
    job that ends FAILED with speaker labels runs once more without them (`…-p`), and `stop` removes both;
    `parse_speakers`. `test_render.py`: a moment with no word inside is not pause-trimmed, one with words is. `test_checklist.py`: the "Seen:" block and the captions item for a clip without speech.
    `test_server.py`: `close` runs when the job ends ready, failed or canceled; the second `Bedrock` client has no
    cache points. `test_owner_messages.py`: the new step messages are short and name no service, and every step message of a
    first run and a Try again is plain (no "clip(s)", "transcri", "audio", "spare").
    `test_agent.py` also checks that speakers without picture signals add the speaker paragraph.
  - `test_jobs.py`: the step weights sum to 1, and the ten keys and labels equal the ones parsed from
    `api/src/clipfactory_api/jobs.py`, `web/src/api/mock/fixtures.ts` and `web/src/api/types.ts`.
  - `test_skills_everywhere.py`: fake-client runs of the Fable watch, the Nova watch and the second look, each with
    the skills block first in `system`; the scan covers the six new modules.

### Infrastructure
- `terraform validate` passes; formatting is clean.
- Cognito client: 15-minute access and ID tokens, 30-day refresh token, rotation on, SRP only.
- Flows: `publish = true`, alias `live`, `durable_config` 30 600 s (job) and 259 200 s (clip) with 14 days retention,
  `timeouts.delete = "60m"`, no destinations.
- The stream trigger has exactly one filter with the seven sort-key prefixes (`JOB#`, `CLIP#`, `POST#`, `LEARNING#`,
  `WEEK#`, `ACCOUNT#`, `SETUP#`).
- The WebSocket authorizer sets no result TTL and no payload format version; WebSocket and REST logs contain no query
  or `requestOverride` and `data_trace_enabled = false`.
- The vector index is float32, 1024, cosine with the four non-filterable keys.
- No `aws_sqs_queue` or `aws_scheduler_*` remains; the only `aws_cloudwatch_event_rule`s are `cf-prod-stats` and
  `cf-prod-learn-daily` (`cron(0 5 * * ? *)`, targeting the unqualified `cf-prod-learn` with its own
  `aws_lambda_permission`; the learn role has no `dynamodb:Scan`; learn timeout 900 s).
- The delete gate: `scripts/test-check-plan-deletes.sh` (a plan that deletes or replaces the table, the user pool, a
  secret or a bucket fails with the resource named) and `scripts/test-deploy-workflow.sh` (the gate runs between
  `terraform plan` and `terraform apply`); the table, user pool, owner user, state-key secret, buckets and vector
  bucket and index carry `prevent_destroy`.
- Stats ([CONTRACTS.md §16.9](CONTRACTS.md#169-terraform-module-inframodulesstats-wired-in-envsprod)): the rule is
  `rate(15 minutes)`, derived from `config/platforms.json` (a test override with every interval at 30 gives
  `rate(30 minutes)`); its target and the Lambda permission's source ARN; `cf-prod-stats` retries 0 and event age 900 s,
  `cf-prod-learn` retries 1; the IAM statements are exactly those of §16.9 (no Bedrock or S3 Vectors on stats); the API
  has `STATS_FUNCTION_ARN`, `LEARN_FUNCTION_ARN` and may invoke both; `gsi2` exists with projection ALL; alarms exist for
  both functions.
- Skills ([CONTRACTS.md §18.8](CONTRACTS.md#188-infra-infra)): `cf-prod-clip-flow` and `cf-prod-learn` each have
  exactly the `Skills` statement (`s3:GetObject` on `skills/*`, no wider S3 access, no `s3:ListBucket`);
  `cf-prod-learn` has `MEDIA_BUCKET`; `cf-prod-stats` still has no S3 access at all.
- Deep analysis ([ADR-40](DECISIONS.md#adr-40-watch-the-whole-video-before-picking)): the agent runtime has
  `CF_WATCH_MODEL_ID` and `CF_DEEP=on` (`off` with `deep_analysis_enabled = false`); the statement `InvokeWatchModel`
  is `bedrock:InvokeModel` on exactly `var.watch_model_invoke_arns`, with no wildcard; the role has no
  `rekognition:`, `comprehend:`, `mediaconvert:`, `states:` or `batch:` action; `InvokeFable` and `Transcribe` are
  unchanged; in `envs/prod` the watch model comes from `config/models.json` (the EU profile and its six EU foundation
  models, seven ARNs).
- The outputs in [CONTRACTS.md §10](CONTRACTS.md#10-terraform-outputs-read-by-deployyml) exist with those names,
  including `ws_url`, `hooks_url`, `vector_bucket`, `vector_index`, `job_flow_alias_arn`, `clip_flow_alias_arn`,
  `stats_function_name`, `learn_function_name`, `stats_rule_name`, `stats_tick_minutes`.

## Manual checks after the first deploy

1. Sign in with the temporary password and set a new one.
2. Add a short public YouTube video; watch the steps; review the clips.
3. Watch a job from a second device: steps and clips appear on both within a couple of seconds (live updates).
   Turn the network off and on: the app catches up by itself with no error.
4. Before any platform is set up, keep one clip; it shows "Waiting for the account connection" on each platform. In
   the Lambda console, the `cf-prod-clip-flow` durable execution `clip-<clipId>-1` ends with outcome `not_posted`.
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
9. Keep a clip and open it from Library: five stacks read "Waiting for connection" with a link to Set up posting; Refresh
   numbers answers without calling any platform. In CloudWatch Logs, `/aws/lambda/cf-prod-stats` shows a `stats.tick`
   line every 15 minutes. In Library › This week, star the clip: "Learning from your picks…" turns into a "Best of
   week" learning within a minute or two.
10. Set up posting ([SETUP_POSTING.md](SETUP_POSTING.md)): open `{app_url}/about.html`, `/legal/privacy.html` and
   `/legal/terms.html` without signing in. Set up YouTube to the end, press **Check it**, then **Connect YouTube**: you
   come back with confetti and "Connected as …". In Secrets Manager (eu-north-1) you see `cf-prod/platforms/youtube/app`
   and `…/token`; in DynamoDB the `ACCOUNT#youtube` item has no token. Keep a short clip with **Only me** picked in
   "Who can see your clips": it appears on the channel as a private Short and the clip page shows its link. Press
   **Disconnect**, wait 8 s: the token secret is gone. Then the other four platforms the same way (X costs a little).
11. Push a small change with an `Area:` line; within 5 minutes the open app (browser and desktop app) shows the update
   bar with that label; press Reload and watch it finish.
12. **Watch the video** ([ADR-40](DECISIONS.md#adr-40-watch-the-whole-video-before-picking)): run a job on a short
   gaming video with a loud moment and a silent crash or stunt. The job shows ten steps; "Watch the video" ends with
   "Watched all …. Saw … big things."; at least one clip on Review carries a "Why:" line. In CloudWatch Logs for the
   agent: one `picture.ready`, one `watch.done` (its `fable` and `nova` counts equal the chunks and parts), `bedrock.usage`
   lines with token counts for the tools `report_scenes` and `check_moment` (add them up and correct the cost table
   in ADR-40), and no `deep.guard_tripped`. In S3, `jobs/<jobId>/source/` holds `picture.json`, `visual_log.json`,
   `signals.json` and `moments.json`. Press **Try again** on a finished copy of the job: Watch says "Used what it saw
   last time." If Nova's `watch.done` count is 0 with reason `denied` or `not_found`, open Amazon Nova 2 Lite once in
   the Bedrock console (eu-north-1) and check the EU inference profile is listed.
13. Open **Ask** on a phone and on a desktop. Ask "Where do I change my click sound?": the steps appear, **Open Sounds**
   goes to Look & feel › Sounds and the Click sound row lights up. Ask "How many views did my best clip get this
   week?" and check the number matches Library › This week. In CloudWatch Logs, `/aws/lambda/cf-prod-api` shows one
   `help.answer` line per question with no question text. If every answer comes back in plain words only, open
   Claude Haiku 5.5 once in the Bedrock console ([DEPLOYMENT.md](DEPLOYMENT.md#4-bedrock-model-access-and-data-retention)).
