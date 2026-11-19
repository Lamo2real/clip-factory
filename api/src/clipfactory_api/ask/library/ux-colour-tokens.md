## Colour tokens

The palette is the November 2026 bottle-green look ([DECISIONS.md ADR-43](DECISIONS.md#adr-43-bottle-green-glass-bone-words-vermilion-actions)):
**green is the surface, bone is the words, vermilion is the action.** Since ADR-45 the glass is see-through and draws
no edges anywhere (no borders, rings, rims or hairlines): a pane shows by its blur, tint and shadow, a control by its
fill. The tables below are the values
in `web/src/styles/tokens.css`. `web/test/designTokens.test.ts` fails if a row here and the CSS disagree, if a
colour or radius token in `tokens.css` is missing from these tables, or if this doc names a custom property the CSS
doesn't define. `web/test/background.test.ts` fails if a stylesheet writes words in a colour that is not one of the
six text colours (`--ink`, `--ink-2`, `--ink-3`, `--vermilion-ink`, `--green-ink`, `--green-text`) or a named
exception (white on a vermilion fill, `--on-bone` on a bone fill, Safari's blue in the Get the app drawings).

| Token | Value | Use |
|---|---|---|
| `--green` | `#0f372b` | Bottle green: every glass tint, veil and scrim; words on bone |
| `--green-deep` | `#0a2820` | Deeper green: code blocks, wells under words, sheet scrims, words on a leaf fill |
| `--green-2` | `#1b4a3b` | Raised green: cover and avatar placeholders (bone on it 8.19:1) |
| `--green-3` | `#2a5c4a` | Mesh highlight green: backdrop blobs, placeholders (bone on it 6.27:1) |
| `--green-leaf` | `#5fa585` | Success fills: done ticks, ring progress, the success tint, the toast timer |
| `--bone` | `#efe7da` | Bone: the words, the selected pill, the tooltip, the control fill's lift |
| `--bone-deep` | `#d9cdb8` | Pressed bone fills |
| `--vermilion` | `#e8392b` | Accent dots, progress fills, the Ask mark's dot, the Glide bar and dot, the swash, the best chart line |
| `--vermilion-deep` | `#c42a1e` | Badges and counts (white on it 5.68:1), the outer focus ring |
| `--vermilion-light` | `#f07a6c` | Progress gradient ends, glow tops, the error toast icon |
| `--ink` | `#efe7da` | Body text, headings, icons (bone) |
| `--ink-2` | `#efe7da` | Secondary text (bone: the hierarchy is size and weight) |
| `--ink-3` | `#efe7da` | Meta text (leaves, hints, timestamps, placeholders), bone too |
| `--vermilion-ink` | `#ffe2dc` | Error and warning **words**, always with a vermilion icon or dot. Vermilion itself is never used for words (3.15:1 on solid green) |
| `--green-ink` | `#e4f2da` | Success words and icons (saved, connected, passed) |
| `--green-text` | `#e4f2da` | Words on the success tint (the apple tag, the sound number tiles) |
| `--on-bone` | `#0f372b` | Words on a bone fill: the selected pill, inverted chips, the tooltip (10.68:1 on solid bone) |

`--green-rgb`, `--green-deep-rgb`, `--green-leaf-rgb`, `--bone-rgb` and `--vermilion-rgb` hold the same colours as
space-separated channels so CSS can add alpha: `rgb(var(--green-rgb) / 0.3)`. `--shadow-rgb` is the base of every
drop shadow and `--line-rgb` (bone) of the few marks that are not box edges (scrollbars, link underlines, ring
tracks). Shared fills: `--cta` (the CTA gradient), `--fill` and `--fill-hover` (deep green wells under words),
`--tint-leaf`, `--tint-vermilion` and `--tint-amber` (tints laid over deep green, so a chip is never lighter than its
panel), `--selected` (bone 0.92).

**One text set everywhere (ADR-45).** Every text colour is bone or lighter in every look (the window look used to have
its own lighter set; now all looks use it), so the panels need the least green; the hierarchy comes from size,
weight and spacing. A soft green halo (`text-shadow`) sits behind words on glass for comfort only: it is never
counted toward AA.

**No edges, and how things still read as controls.** Where an edge carried meaning, a fill or a soft glow does now:

| Token | Use |
|---|---|
| `--fill-control` | Buttons without a fill of their own (glass, ghost), drop zones, check chips, step numbers: a bone lift (0.08) over a step more green than a panel (`--panel-veil` + 0.10), the pick-one track's recipe |
| `--fill-field` | Text fields and the link box: deep green 0.45, a well deeper than the panel |
| `--shade-field` | The field's soft inner shade (blurred, never a line) |
| `--glow-bone`, `--glow-vermilion`, `--glow-leaf` | Soft glows (18 px blur) for a chosen, live, best or done thing, instead of a ring |

The only lines left are the allowed ones: the keyboard focus ring while `:focus-visible`, the temporary "found"
highlight from search and Ask's spotlight, progress bars and rings, the switch track, spinners, and text underlines.
`web/test/background.test.ts` fails on any other border, ring or hard line in a stylesheet, and
`web/e2e/edges.spec.ts` on any visible one on any screen.

Glass tints are not tokens: each glass variant sets its own `--glass-tint` gradient (in `web/src/styles/glass.css`),
and a component may override it. Every tint is bottle green; `--panel-veil` is how much.

| Class | `--glass-tint` |
|---|---|
| `.glass` | green at `--panel-veil` + 0.04 → green at `--panel-veil`, 140° |
| `.glass--green` | one step deeper: green + 0.10 → deep green + 0.08, 150° (the hero, the Ask launcher, the setup list's card) |
| `.glass--vermilion` | the panel, a breath of vermilion (0.16 → 0.08), then green 0.20 over it |
| `.glass--clear` | the panel tint |
| Nested `.glass` | transparent: the outer panel already gives the words their green |
| Floating layers | green `--float-veil` (0.73) + 0.02 → 0.73, blur 28 px (toasts, the Ask panel and sheet, the setup list, pill and sheet, the update bar): content scrolls under them, so they plan for white |
| The tab bar | green `--tabbar-veil` (0.59) + 0.03 → 0.59, blur 28 px (icons only, 3:1 over white) |
| The question sheet | green 0.88 → 0.86, over its own scrim |
| No `backdrop-filter` | green 0.92 → 0.90 |
| `prefers-reduced-transparency` | green 0.94 → 0.92, and the backdrop veil 0.94 |

Contrast: body text is `--ink` (bone) on green glass, 10.68:1 on solid green. The CTA's white label is at least
4.5:1 because the fill is vermilion a shade deeper (`--cta`, 4.96–6.03:1). Every vermilion dot on glass carries a
soft glow of its own or sits beside words that carry its meaning. Never put text directly on the moving backdrop:
loose words get a scrim at the panel tint.
`web/e2e/contrast.spec.ts` checks the rendered contrast and text size of every screen, in every look (see
[TESTING.md](TESTING.md)).
