## 15. Settings as a tree, and choosing your click sounds (owner request, 2026-11-16)

The owner's picture: *the field* is all of Settings, the *trees* are a few big groups, each tree has *branches*
(sections), each branch has *apples* (the settings you change) and *leaves* (short help text). Everything has a place.

### 15.1 The tree (routes are real URLs; deep links work; old `/settings#skills` style anchors redirect)

| Tree (route) | Branch (route) | Apples (settings) | Leaves (help, one short line each) |
|---|---|---|---|
| **Clip making** `/settings/clip-making` | **Clips** `/clips` | How many clips (Fewest / Most steppers → `clipMin`/`clipMax`), Longest video (`maxSourceHours`) | what each does |
| | **Skills** `/skills` (superseded by §18.7) | **Your skills** (list, every one "Always used"; open one at `/skills/{skillId}`, edit at `/skills/{skillId}/edit`, delete with Undo); **Add a skill** (write it at `/skills/new`, or upload .md / .zip) | Clip Factory always uses every skill |
| | **YouTube help** `/youtube` | YouTube cookies: add / remove | when you need it |
| **Posting** `/settings/posting` | **Set up posting** `/setup` (was **Accounts** `/accounts`, which now redirects; §17.1) | the five setups (YouTube, TikTok, Instagram, Facebook, X) | do each one once |
| | **Where clips go** `/where` | platforms to post to (`settings.platforms`, at least one) | |
| | **Money** `/money` (§25.7) | Your country, one card per platform (YouTube, TikTok, Instagram, Facebook, X), Getting your money out | only platform-reported money, tagged as the platform's estimate |
| **Look & feel** `/settings/look-and-feel` | **Sounds** `/sounds` | Sounds on/off (`soundEnabled`); **Click sound** (1 of 30, `clickSound`); **Error sound** (1 of 30, `errorSound`); Try it | sounds only play when you tap, never when you scroll |
| | **Motion** `/motion` | Reduce motion (`reduceMotion`) | |
| | **Background** `/background` | What's behind the glass, Glass strength, Background picture (this device only), Background colours (§22) | |
| **App & account** `/settings/app` | **Get the app** `/get-the-app` | the device-aware install card (§12.1) | |
| | **Updates** `/updates` | this version, Check for updates (§12.2) | |
| | **Account** `/account` | signed-in email, Sign out | |

Branch routes are nested: `/settings/look-and-feel/sounds`. `/get-app` keeps working (same card).

### 15.2 How it looks and moves (kid-proof, §12.4)
* `/settings` (the field): a short search box "Find a setting" that searches every apple and leaf by name and jumps
  straight to it (highlights it on the panel's own lines for 2 s: the whole panel when the apple is alone in it, else
  its row from edge to edge between the dividers, with the panel's corners on the first and last row; never an outer
  ring, and the apple's programmatic focus draws no second ring, `settings.css` `.apple::after`), then the four trees as big glass cards (icon, name, one line, how many apples).
* A tree page lists its branches as cards (icon, name, one line). A branch page shows its apples as rows grouped in
  glass panels, each with its leaf under it.
* Breadcrumb on every level: `Settings › Look & feel › Sounds` (each part a link) plus a big Back button on phones.
  Below 768 px it is one row, truncating from the left: the last three levels after a "…", long names ending in "…".
* ≥ 1024 px: a left "folder" panel (260 px wide) inside Settings shows the whole tree (trees expand/collapse like
  folders, branches are links, the current one highlighted, state remembered), content on the right. On a tree's own
  page the tree's folder row is the highlighted one (green, vermilion dot, `aria-current="page"`). < 1024 px: drill-down
  pages.
* One vermilion CTA per screen at most; plain words; nothing overflows at any width from 320 px.

### 15.3 Sounds
* The 30 click sounds and 30 error sounds are the ones from the owner's sound picker page; their recipes live in
  `web/src/lib/soundCatalog.ts` as data (`{ id, name, feel, voices }`, oscillator voice
  `[wave, startHz, endHz, at, length, peak, lowpassHz]`, noise voice `["noise", filterType, filterHz, at, length, peak]`).
* Defaults (the owner's picks): **click sound 6 "Water drop"**, **error sound 5 "Nope nope nope"**.
* The Sounds branch is the picker the owner liked: two groups ("When it works" / "When it can't") of numbered glass
  cards (number, name, feel), tapping a card plays it and selects it (a "Pick" badge, `aria-pressed`), plus a
  "Try it: Sign in" button with a "Make it fail" switch (success plays the click sound with a green toast "Signed in",
  fail plays the error sound with a small shake and a vermilion toast "Wrong password. Try again."). Choices save
  instantly (optimistic, like `soundEnabled`) and follow the owner to every device.
* The sound engine plays the chosen recipes everywhere (click on enabled controls, error on disabled controls and error
  toasts, §11). Previewing a card always plays even when Sounds is off? **No**: when Sounds is off the cards show a
  note "Sounds are off" with a button to turn them on, and previews stay silent until then (kid-proof: no surprise).

### 15.4 API
* `Settings` gains `clickSound: number /* 1..30, default 6 */` and `errorSound: number /* 1..30, default 5 */`,
  validated in PUT `/v1/settings` (integers 1–30, else 400 with a plain message). Stored settings without them read
  as the defaults.
