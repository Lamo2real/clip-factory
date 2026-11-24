## 11. Design system (summary; details in docs/UX_DESIGN_SYSTEM.md)

* Colours (owner request 2026-11-18, ADR-43): **Bottle Green `#0F372B`** (the surface), **Bone `#EFE7DA`** (the
  words and the lines), **Vermilion `#E8392B` (every call to action)**. Every surface is **liquid glass**: bottle-green
  tints with bone words over a soft animated deep-green mesh with a vermilion glow (or the owner's own background),
  `backdrop-filter: blur() saturate()`, a soft light from above (the logic of light, §22.7, ADR-87: every layer is
  brighter than the one under it, and every pane is brighter at its top) and refraction on the hero surfaces. Every
  action button wears the vermilion CTA, **except the update bar's Reload, a colourless liquid-glass lens (ADR-87)**;
  secondary buttons are glass one step brighter than what they sit on (no outline, ADR-45); selected items in a
  pick-one bar are bone with green words.
* Type: **Times New Roman** (fallback Tinos, then serif) for display headlines, often italic with a vermilion underline
  swash; **Inter** for everything else.
* Layout inspiration: the "Sorrel" restaurant site: big serif italic headline on a green hero card, pill buttons, cards
  in a row, a rating-style stat block.
* Navigation: phones (< 768 px): bottom glass tab bar, **icons only** (aria-labels). Larger screens: left glass sidebar,
  collapsible with a hamburger (collapsed = icons only).
* Sounds (Web Audio, no files): one **tap** sound on clicks of enabled interactive elements; a different **deny**
  sound on clicks of disabled ones and on errors. Driven only by the `click` event, so scrolling never makes a sound.
  Off switch in Settings.
* Nothing may overflow its box at any width from 320 px up (enforced by Playwright tests).
* Every visible text run reads at WCAG AA: at least 4.5:1 (3:1 for 24 px, or 18.66 px bold, and up) on the glass and
  backdrop it can sit on, and no text is smaller than 12 px, on every screen at 320, 375 and 1440 px (enforced by
  `web/e2e/contrast.spec.ts` with axe-core and a rendered-contrast scan; see [TESTING.md](TESTING.md#contrast-and-text-size)).
  The desktop app's see-through window (§22.3) is held to the same bar, over stand-ins for the real window glass.
  Colour and radius tokens are the tables in UX_DESIGN_SYSTEM.md; corners use the `--r-*` scale.
* **Library** has two views: "All clips" (every kept clip, newest first, each card shows total views when measured)
  and "This week" (the week's clips sorted by views with a big "Best this week" star each, arrows for earlier weeks,
  §16.8). Tapping any clip in Library opens its performance page `/clips/{clipId}` (§16.8); on an All clips card the
  whole top (cover and hook) is the tap target, never just the one-line hook. Each post row says its status with the
  same words as the clip page's chip (`postStatusLabel` in `web/src/lib/metrics.ts`: a queued post reads
  "Uploading…", one waiting for its account "Waiting for setup"); posts waiting for accounts share one row "Waiting for
  setup. Posts once these accounts are connected.", except one whose place is set up now: it gets its own row
  "Ready to post" with **Post now** (§33.6). A clip whose posting did not start (`startPending` for more than 4 s,
  `START_GRACE_MS`: the start after a Try again, Post now or connect did not go through) shows "This clip has not started
  uploading yet. Tap Try again." with the big **Try again**, which sends Confirm and starts it (§14.5); its pill reads
  "Not started" (warn, not the green "Uploading"), and "Waiting for setup" when every post waits for its account. A
  card's views are the sum of its posts' views whenever any post has numbers. The "Show" filter lives in the address
  (`?show=waiting|posted`, changed with replace and the scroll kept), so Back and a reload keep it. The "Show" filter's empty list says why it is empty: no kept
  clips at all → "Nothing kept yet" + Go to Review, first on the page (no totals, no filter; the learnings box only
  when there are learnings); "Not posted yet" with every kept clip posted → "Everything is
  posted!" + Show all; "Posted" with kept clips still on their way → "Nothing posted yet" + Show all. Only a failed
  clip list is a page error: failed posts or insights show their own error panel with Try again in the totals area.
  This week's stars are saved at once when the page is hidden or closed (`keepalive`), not only after 800 ms.
* Installable PWA (manifest + service worker) on phone and desktop.

### 11.1 One top line (owner request, 2026-11-19)

Scrolled to the top, every column starts on the same horizontal line: the menu, the setup list (its open card or its
pill), the settings folders and the page's first panel or title plate. In the macOS desktop window the line sits under
the traffic lights' band; nothing ever covers the traffic lights.

* **Tokens** (`web/src/styles/tokens.css`): `--titlebar-h` is the desktop window's title bar band (0 everywhere but the
  macOS window, 28 px there); `--top-safe: max(env(safe-area-inset-top), var(--titlebar-h))` is what nothing may sit in
  (that band or a phone's status bar); `--top-line` is `--top-safe + 12px` on phones and `+ 14px` from 768 px. Every
  column reads `--top-line` (the sidebar `top`, the `.shell` `padding-top`, the setup list and its panel `top`, the
  folders' sticky `top`); none adds a number of its own to the safe area. `env(safe-area-inset-top)` appears only in
  `tokens.css` (a unit test holds it). From 768 px `.page-head` has no top padding, so the title plate starts on the line (phones keep 6 px of air under their top bar).
* **The pill shares the line.** While the setup list is folded to its pill (§17.13; under 1440 px, or the list
  closed; the desktop app's first 1200 x 820 window is one), the pill sits on the line at the page's right edge
  (`right` = the page gutter) and, **from 940 px**, the page starts on the line too (`--todo-top: 0`). The page's
  first row leaves the pill room on the right: `--todo-room` (the pill's width, measured by `SetupTodo.tsx` into
  `--todo-pill-w`, + 20 px) narrows the first `.page-head`'s title plate, pads the settings trail (whose breadcrumbs
  then keep to one row and end in "…" instead of wrapping, like on phones) and the home hero's side column steps
  12 px below the pill. The settings folders stick on the line with `z-index: 40`, over the strip's glass bar once the
  page scrolls, like the menu. What sticks inside the page (a review clip's video) stops below the bar
  (`--todo-clear`: 72 px). Below 940 px, where that row would be too narrow, and in the settings column from 1024 to
  1179 px (with the folders beside it), the page starts one strip lower (`--todo-top` / `--todo-clear`: 60 px on
  phones, 72 px from 768 px), the folders still on the line.
* **The desktop window** (§12.3) sets `window.__CF_TITLEBAR__` (28 on macOS, 0 elsewhere). `web/src/lib/look.ts`
  (`titlebarHeight`, `applyTitlebar`, run in `applyLookNow` before the first paint) reads it only when
  `__CF_DESKTOP__ === true` and the value is a number from 1 to 120, then sets `html[data-titlebar="overlay"]` and
  `--titlebar-h`. A web page that claims a title bar gets no band.
* **Dragging the window.** With the title bar laid over the page, `App.tsx` draws `.titlebar-drag`
  (`data-tauri-drag-region`, `aria-hidden`), shown only on `html[data-titlebar="overlay"]`: fixed at the top, full
  width, exactly `--titlebar-h` tall (the real title bar, never the 14 px of air below it, where a page control that
  scrolled up must still take its click),
  `z-index: 45`, transparent, no border, rim or shadow. Pressing it moves the window; a double click zooms it.
* **Phones** keep their own top bar under the pill strip (top bar at `--top-line + --todo-top`).
* **Also on the token:** `html { scroll-padding-top }`, the skip link, the sign-in screen, the small question sheet's
  scrim, the phone Ask sheet and the setup list's glass bar all clear `--top-safe`; so do the markup editor, the
  Post to TikTok sheet and Clips Funded's sheets.
* **Edge to edge on a phone (owner request, 2026-11-23: "remove the entire green top bar").** `index.html` asks for
  `apple-mobile-web-app-status-bar-style: black-translucent` with `viewport-fit=cover`, so an installed iPhone app has
  no solid band at the top: each app's own backdrop (Clip Factory's `.backdrop`, Clips Funded's `.stories-app::before`,
  both `position: fixed; inset: 0`) shows under the clock, the Dynamic Island and the signal. Nothing of a page sits
  there: every column still starts on `--top-line`, and nothing passes through it on the way in either: the setup
  list's pill (`todo-in`) and, on a phone, its panel (`todo-drop`) drop into place from at most the room between
  `--top-safe` and the line: 12 px on a phone, so the pill starts on the status bar's edge, never under the clock (a
  computer keeps their 14 and 16 px). `--status-bar-h` (`env(safe-area-inset-top)`, in `tokens.css`) is
  the status bar alone; only the status-bar scrim and glass strip are that tall. The scrim (`.app::after`,
  `.stories-app::after`): black, held under the clock to 75 % and easing out over the bar's last quarter
  (`--status-bar-fade`, a mask), exactly as strong as the white clock needs for AA over the look's top edge
  (`statusScrim` in `lib/background.ts` and `stories/look.ts`: 0 over the living backdrop, Ember, Rose, Lagoon and
  dark colours, so nothing is drawn; about 0.5 over Cream or a picture, planned for white). Once the page has scrolled
  (`<html data-scrolled>`, `lib/pageScrolled.ts`) cards and buttons slide up under the clock, so a strip of each app's
  own glass lies there (`.app::before`, Clips Funded's `.st-frame::before`): its blur and saturation and its veil
  planned for white (`--status-strip-veil` 0.66 green, `--st-status-strip-veil` 0.59 espresso: `statusStripVeil`), so
  the white clock keeps AA over anything, even where no backdrop-filter is drawn; it masks with the same fade and
  comes and goes on its opacity alone (never a filter transition). At the top of a page it is not drawn. Clips Funded's
  sticky panels (the chat list, a review's player, the character stage, an idea's basics) stop below `--top-safe`
  too, for an installed iPad app. The body under the backdrop is the backdrop's own top edge (`#0f3d31`), and
  `theme-color` is its average (`#13483C`): Android's installed app and browsers that tint their bars keep a coloured
  status bar (no web page can make it see-through there), now the backdrop's own top colour. An installed iPhone app
  picks the new style up when it is closed and opened again (at worst, removed and added to the Home Screen again).
  Tests: `test/edgeToEdge.test.ts`, `e2e/phone-edge-to-edge.spec.ts` (also scrolled: Home, Library, Clips Funded's
  Dashboard and Ideas keep the clock's and icons' zones at AA at every scroll stop).
* **Tests:** `e2e/top-line.spec.ts` (Chromium and WebKit): the simulated macOS window at 1000 x 650, 1200 x 820 (the
  pill) and 1440 x 900 on `/`, `/jobs`, `/review`, `/library`, `/settings` and a settings branch puts every column
  within 1 px of the line (42 px), keeps the 80 x 28 traffic-light corner clear and checks the 28 px drag strip; a tab
  scrolled up to 30 px (under the line, below the title bar) still takes its click; a Windows or Linux window and a
  web page claiming a band get the plain line (14 px); browsers at 1440, 1280, 1000, 820 and 390 px wide share their
  line. The band's 28 lives only in `main.rs` (`MAC_TITLEBAR_HEIGHT`); `look.ts` sets it inline, and a unit test holds
  that no stylesheet hard-codes it.
* **The job page's title plate** (owner screenshot, 2026-11-19): the job's tag ("Didn't work", "Ready", ...) sits
  inside the title plate, on one wrapping row with the start line (`.page-head__meta` in `.page-head__text`), never
  beside the plate or in the gap under it. `e2e/job-head.spec.ts` (Chromium and WebKit) opens a failed job on a
  phone (390 x 844), a tablet (800 x 1000), the macOS window (1000 x 650, 1440 x 900) and a 1400 x 900 browser and
  checks the plate starts at least 8 px below `--top-safe`, ends inside the window and holds the tag's whole box.
