## The liquid glass recipe

```css
.glass {
  --glass-tint: linear-gradient(140deg, rgb(var(--green-rgb) / calc(var(--panel-veil) + 0.04)), rgb(var(--green-rgb) / var(--panel-veil)));
  position: relative;
  isolation: isolate;
  background: var(--glass-tint);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate)); /* 18px, 1.6 */
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  border: 1px solid transparent; /* keeps the box size; no edge is drawn */
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-1);
}
:where(.glass) .glass {
  --glass-tint: transparent; /* nested glass: the outer panel gives the green */
}
```

`--panel-veil` is 0.33 over the app's own living backdrop (worked out over every blob subset, both field ends, every
`saturate()` the CSS uses and the grain at its peak, `lib/background.ts`), 0.73 over a white desktop or photo, and between the two for
light owner colours.

Variants: `.glass--green` (hero, Ask launcher), `.glass--vermilion`, `.glass--clear`. In Chromium, `.glass--refract`
also bends the backdrop through the `#cf-refract` SVG filter.

**Buttons.** Every action is the vermilion CTA (`.btn--primary` for the screen's one main action, `.btn--action` for
the rest, the same look). Secondary buttons (`.btn--glass`, `.btn--ghost`: Skip, Not now, Back) wear the soft
control fill (`--fill-control`) with bone words and no ring; `.btn--danger` a vermilion tint over the same green with
`--vermilion-ink` words. Selected things in a pick-one bar (the `<Glide>` pill, the menu, the tab bar) are bone
with `--on-bone` words, with the vermilion bar or dot riding along on the bone.

**What is behind the glass (Settings › Look & feel › Background, [CONTRACTS.md §22](CONTRACTS.md#22-background-modes-and-see-through-glass-owner-request-2026-11-16)).**
Three choices, picked from three preview tiles with one sliding highlight:

* **See-through (the default).** In the Mac and Windows app the page itself is transparent and the window's own
  glass shows what is behind it, blurred by the system: macOS Liquid Glass (26+) or the under-window vibrancy
  material, Windows 11 acrylic, Windows 10 blur. You can guess the shapes (the edges of a car on the wallpaper), never
  read them. In a browser, an installed web app or on a phone nothing can look behind the page, so see-through shows
  the **frosted Clip Factory colours**: a deep green mesh with a vermilion glow and a faint bone highlight, behind a
  green frost, with two soft highlights slowly moving through it like light in glass. The Background page says why
  in one plain sentence and links to Get the app.
* **Picture.** The owner's own photo (kept on the device), under a bottle-green veil.
* **Colours.** 1 to 3 colours from the named swatches or the owner's own, drifting as a soft mesh.

**Glass strength** (see-through): Clear (default) shows more of what is behind, Frosted less. In a browser or on a
phone it thickens the frost over the Clip Factory colours, so it always does something.

**The tint keeps text readable on every background.** Its strength is worked out, not guessed (`lib/background.ts`):
the smallest bottle green at which every text colour that can sit on it reaches 4.5:1 on the **lightest** thing
behind. The words are light, so a white desktop or a white photo is the hardest case, not a dark one.

**In see-through the tint sits on the panels, not on the window.** Between panels the desktop shows through the
window's own glass untouched (Clear) or under a green frost (Frosted, 0.30). Every glass panel, and every piece of
text that sits straight on the window (page title and its line, breadcrumbs, headings and lines between panels),
carries the panel tint; loose text gets it as a plate of real padding behind the words (never a spread shadow, so
it never hugs or cuts a letter): the plate starts at the page edge like a panel and its words start where a panel's
words start (`--loose-x`). The picture look uses the same plates.

| Backdrop | Lightest thing behind | Tint |
|---|---|---|
| See-through, every native glass (Liquid Glass, vibrancy, acrylic, blur), either setting | White (Liquid Glass over white was measured at rgb(249, 248, 245)) | Panels: **Clear 0.73; Frosted 0.88** over the 0.30 window frost |
| Picture | A white photo | 0.35 over the photo, then panels at 0.65 (together 0.77) |
| Colours | The lightest colour (a blend of two is never lighter than both) | 0 (dark colours) up to 0.77 (white), over the whole backdrop; the default needs 0.74; the previews in Settings wear it too |
| See-through in a browser, or Picture with none on the device | The mesh's bone highlight | A green frost of 0.15 everywhere; panels 0.45 |
| Reduce transparency (system) | – | 0.94 everywhere, panels 0.92 |

**Rules that keep every word readable** (`styles/glass.css`; the numbers are checked in `web/test/background.test.ts`):

* **Floating surfaces keep their own denser tint** (toasts, sheets, the Ask panel, the update bar, a starred star).
* **Nothing that holds words is weaker than the panel tint**: the tab bar, glass, ghost and danger buttons and the
  Library tabs carry at least that much, wherever they sit.
* **Pick-one tracks** (segmented bars, tab rows, the Background tiles, the AI models) carry 0.10 more green than a
  panel, with a lift of bone (0.08) so the track still shows.
* **Fills under words are never lighter than their panel.** Wells are deep green (`--fill`); the success and
  vermilion tints lay deep green (0.35) under their colour (`--tint-leaf`, `--tint-vermilion`). Hover answers with
  more green (and a soft glow for a chosen thing), never with a lighter fill and never with a ring.
