## 11. Design system (summary; details in docs/UX_DESIGN_SYSTEM.md)

* Colours (owner request 2026-11-18, ADR-43): **Bottle Green `#0F372B`** (the surface), **Bone `#EFE7DA`** (the
  words and the lines), **Vermilion `#E8392B` (every call to action)**. Every surface is **liquid glass**: bottle-green
  tints with bone words over a soft animated deep-green mesh with a vermilion glow (or the owner's own background),
  `backdrop-filter: blur() saturate()`, refractive bone highlight edges. Every action button wears the vermilion CTA;
  secondary buttons are bone-outlined glass; selected items in a pick-one bar are bone with green words.
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
  same words as the clip page's chip (`postStatusLabel` in `web/src/lib/metrics.ts`: a queued post reads "Posting",
  one waiting for its account "Waiting for connection"); posts waiting for accounts share one row "Waiting for
  connection. Posts once these accounts are connected.". The "Show" filter's empty list says why it is empty: no kept
  clips at all → "Nothing kept yet" + Go to Review; "Not posted yet" with every kept clip posted → "Everything is
  posted!" + Show all; "Posted" with kept clips still on their way → "Nothing posted yet" + Show all.
* Installable PWA (manifest + service worker) on phone and desktop.
