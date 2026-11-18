# Bottle green theme: the colour system

Design record for the November 2026 colour change. The owner asked for this on 2026-11-18: "every single UI thing we have is going to be tailored towards these colors. It's still going to be liquid glassy so that you can see through the application ... the CTA should be still orange, and all CTAs should be orange. The font style could be the same, but the colors should change."

| Brand colour | Hex | RGB | Relative luminance | Replaces |
|---|---|---|---|---|
| Bottle Green | `#0F372B` | 15 55 43 | 0.030 | Sage `#9CAF88` (and ink `#1E2A1B` as the dark of the system) |
| Bone | `#EFE7DA` | 239 231 218 | 0.806 | Off-white `#F7F5EF` |
| Vermilion | `#E8392B` | 232 57 43 | 0.203 | Tomato `#E8412C` |

The reference is the dance-theatre page. It has a deep bottle-green field, big bone serif headings, small bone uppercase navigation, a thin bone hairline under the header, a bone outlined circle-arrow button, and vermilion as the one loud colour.

**The rule in one line:** green is the surface, bone is the words and the lines, and vermilion is the action.

Fonts stay the same: Times New Roman for display, Inter for the UI. All layouts, glass recipes (blur, saturate, lit rim, refraction), `<Glide>` sliding highlights, motion, celebrations and click sounds stay the same. Only colour changes.

**The polarity flip.** Today the app is light glass with dark text. It becomes dark green glass with light (bone) text. So every contrast check changes direction: the worst backdrop is now the lightest thing that can sit behind a panel (a white window, a white photo), not the darkest. That flip drives most of the maths below.

All ratios in this document were computed with the same sRGB compositing and the WCAG 2.x formulas as `web/src/lib/background.ts` (`mix`, `luminance`, `contrast`, `minVeil`). None of them was estimated by eye.

---

## 1. Tokens

### 1.1 Brand fills (`:root` in `web/src/styles/tokens.css`)

The old sage, off-white and tomato tokens are renamed: `--sage*` becomes `--green*`, `--offwhite*` becomes `--bone*`, and `--tomato*` becomes `--vermilion*`. The `--ink*` names stay, but they are redefined as the **text** tokens (see 1.2), so their roughly 300 call sites keep working.

| Token | Value | Role | Replaces |
|---|---|---|---|
| `--green` | `#0f372b` | The main surface. Every glass tint, veil and scrim. Text on bone. | `--sage` (as fill), `--ink` (as the dark) |
| `--green-rgb` | `15 55 43` | For `rgb(var(--green-rgb) / a)` tints | `--sage-rgb`, `--offwhite-rgb` as glass base |
| `--green-deep` | `#0a2820` | Deeper green: code blocks, the video letterbox base, pressed tracks, sheet scrims | — |
| `--green-deep-rgb` | `10 40 32` | Shadows (see `--shadow-rgb`) | `--ink-rgb` (shadow use) |
| `--green-2` | `#1b4a3b` | Raised green: hover on green rows, avatar and cover placeholders (bone on it 8.19:1) | `--sage-mist` |
| `--green-3` | `#2a5c4a` | Mesh highlight green: backdrop blobs, chart grid fills (bone on it 6.27:1) | `--sage-deep` (as fill) |
| `--green-leaf` | `#5fa585` | Success fill: done ticks, ring progress, success chip tint (at 0.25), confetti | `--sage-deep` (as success) |
| `--bone` | `#efe7da` | Words, hairlines, outlined buttons, selected Glide pill, tooltip, inner focus ring | `--offwhite` |
| `--bone-rgb` | `239 231 218` | Hairlines, track lifts, rims | `--offwhite-rgb`, `--ink-rgb` (line use) |
| `--bone-deep` | `#d9cdb8` | Pressed state of bone fills (green on it 8.35:1) | — |
| `--vermilion` | `#e8392b` | Accent dots, progress fill, the AskMark dot, the Glide bar and dot, the brand dot, chart "best" line, the swash | `--tomato` |
| `--vermilion-rgb` | `232 57 43` | Glows, selection tint, chip tints | `--tomato-rgb` |
| `--vermilion-deep` | `#c42a1e` | Badge and count fill (white on it 5.68:1), outer focus ring, failure flash | `--tomato-deep` |
| `--vermilion-light` | `#f07a6c` | Progress gradient end, confetti, glow tops (vs green 4.81:1, so usable as a UI mark) | raw `#f2785f`, `#ef6a52`, `#ff8f6b` |
| `--cta-top` | `rgb(206 48 36)` | Primary CTA gradient top | raw `rgb(208 54 34)` |
| `--cta-bottom` | `rgb(184 38 28)` | Primary CTA gradient bottom | raw `rgb(186 42 26)` |
| `--cta-hover-top` | `rgb(216 54 40)` | CTA hover top | — |
| `--cta-pressed` | `rgb(170 34 25)` | CTA pressed | — |
| `--shadow-rgb` | `4 20 15` | The base of every drop shadow | `--ink-rgb` (shadow use) |
| `--line-rgb` | `239 231 218` (= bone) | Hairlines, input borders, track lifts | `--ink-rgb` (hairline/track use) |

**Retiring `--ink-rgb`.** Today `--ink-rgb` is used about 125 times for three different jobs. Each use is re-pointed as follows:

- Shadows go to `--shadow-rgb`.
- Hairlines, rings and the track shade go to `--line-rgb` (a bone lift).
- Dark scrims go to `--green-deep-rgb`.

Do not alias it. A dark hairline on dark glass is invisible, so every use has to be looked at.

### 1.2 Text tokens (`TEXT_TOKENS` in `lib/background.ts`, `:root` in tokens.css)

All text is light. The hierarchy comes mostly from size, weight and uppercase tracking, as in the reference nav. It does not come from dimmer colour, because every step dimmer costs see-through.

| Token | Root value | Window value (`html.see-through`) | Use | Least green veil for AA over white |
|---|---|---|---|---|
| `--ink` | `#efe7da` (bone) | `#efe7da` | Body text, headings, icons | 0.73 |
| `--ink-2` | `#e9e0d0` | `#efe7da` | Secondary text, notes | 0.75 |
| `--ink-3` | `#e4dac9` | `#efe7da` | Meta text, placeholders | 0.77 |
| `--vermilion-ink` | `#ffd2ca` | `#ffe2dc` | Error and warning words, the "over the limit" counter, failed status. Always paired with a vermilion icon or dot, so the meaning is not carried by colour alone | 0.76 / 0.73 |
| `--green-ink` | `#d2e8c4` | `#e4f2da` | Success words and icons (saved, connected, ok) | 0.75 / 0.71 |
| `--green-text` | `#d6ebc8` | `#e4f2da` | Words on the success chip tint (apple tag, sound number tiles) | 0.74 / 0.71 |
| `--on-bone` | `#0f372b` | — | Text on any bone fill: the selected Glide pill, tooltip, inverted chips, bone buttons. 10.68:1 on solid bone | (not on green) |
| `--on-cta` | `#ffffff` | — | CTA and badge labels (see 3.3) | — |

So the root set needs a green veil of **0.77** over pure white, and the window set needs **0.73**.

Renamed tokens:

- `--tomato-ink` becomes `--vermilion-ink`.
- `--sage-ink` becomes `--green-ink`.
- `--sage-text` becomes `--green-text`.
- `--sage-mist` is retired (it was unused).

Vermilion itself is never used for words. Vermilion on solid green is only 3.15:1, and on the window panel over white it drops to 1.36:1.

### 1.3 Composite tokens

```css
--shadow-1: 0 1px 2px rgb(var(--shadow-rgb) / 0.18), 0 8px 24px -14px rgb(var(--shadow-rgb) / 0.55);
--shadow-2: 0 2px 6px rgb(var(--shadow-rgb) / 0.2),  0 22px 48px -24px rgb(var(--shadow-rgb) / 0.65);
--focus:    0 0 0 3px rgb(var(--bone-rgb) / 0.95), 0 0 0 5.5px var(--vermilion-deep);
```

The shadows are heavier than today because a dark shadow on a dark surface reads less strongly. The focus ring keeps its shape. Its inner bone ring is 4.61:1 or better against any panel, and the vermilion outer ring is 3.39:1 against the bone ring.

---

## 2. Surface model

**Default glass.** Every `.glass` surface is bottle-green glass with bone text. A light glass is the exception. It is used only for small, inverted, "selected" objects (bone with green text), the way the reference uses the bone circle button.

### 2.1 Core glass recipe (`glass.css`)

| Part | Today | New |
|---|---|---|
| `.glass` tint | white 0.66 to off-white 0.48 | `linear-gradient(rgb(green / calc(var(--panel-veil) + 0.04)), rgb(green / calc(var(--panel-veil) - 0.04)))`. `--panel-veil` is now set by `applyLook` for **every** look (see section 3). It is not fixed in CSS. |
| blur / saturate | 22px / 1.7 | 22px / **1.4** (saturate on a dark tint over-pumps reds) |
| border | white 0.5 | `rgb(var(--line-rgb) / 0.22)` |
| inset highlight | white 0.75 top, ink 0.05 bottom | bone 0.28 top, `--shadow-rgb` 0.25 bottom |
| lit rim `::before` | white 0.95 / 0.1 / 0 / 0.55 | bone 0.55 / 0.06 / 0 / 0.3 (keeps the liquid sheen without lightening the text area) |
| `.glass--sage` | sage tint | becomes **`.glass--green`**: one step deeper, `panel-veil + 0.08`, used for the hero, the help launcher and setup-todo (where sage glass was used) |
| `.glass--tomato` | tomato 0.22 | becomes **`.glass--vermilion`**: the panel, then vermilion 0.16, then a green deepen of 0.2 (chip rule, 4.4) |
| `.glass--clear` | the lightest veil | `max(--panel-veil - 0.1, --panel-veil-floor)`. It only drops below `--panel-veil` in the brand and frosted looks, where we own the backdrop. |
| denser surfaces (toast, help panel, sheet, setup-todo panel, update bar) | white 0.86 to 0.95 | green **0.90** (sheet 0.94) in every look, so bone gets 7.9:1 or better over white |

### 2.2 Per component family

| Family | Surface | Text / icons | Active / selected | Notes |
|---|---|---|---|---|
| Sidebar | `.glass` (green) | items `--ink-2`, hover `--ink` on bone 0.08 | Glide pill: **bone 0.92 + `--on-bone` text** (9.2:1 or better), with a vermilion bar `::before` and a 1.5px bone ring around the bar | Count badge: `--vermilion-deep` fill with white text (5.68:1). Header hairline: bone 0.22 (as in the reference). |
| Tab bar (phone) | `.glass`, `max(panel-veil, 0.62)` | `--ink-2` | Bone pill + green text, vermilion dot `::after` with a 1.5px bone ring | |
| Cards / panels | `.glass` | `--ink`, `--ink-2`, `--ink-3` | — | Card titles: display serif in bone. Hover adds bone 0.06 plus `--shadow-2`. |
| Sheets / modals | green 0.94 | bone | — | Scrim: `--green-deep` 0.55 |
| Primary CTA `.btn--primary` | `linear-gradient(--cta-top, --cta-bottom)` at 0.97, inset white 0.35, glow vermilion 0.55 | **white**, 600 weight | hover `--cta-hover-top`; pressed `--cta-pressed` | See 3.3 for why the fill is darkened. Shine `::before` white 0.3. Text shadow `rgb(90 14 6 / 0.35)`. |
| Every other CTA ("all CTAs orange") | Same recipe as `.btn--primary` | white | — | `.btn--sage`, `.help-sage`, `.fly-btn--sage`, `.skill-form__use`, `.linkbox__paste` and the setup copy button all become the vermilion CTA. The `sage` tone props and classes are renamed (`tone="primary"`). There is one visual CTA style. |
| Secondary `.btn--glass` | transparent, **1.5px bone ring** (4.61:1 or better), bone text | | hover bone 0.1 fill | The reference's outlined circle-arrow. The icon-only round variant (`.icon-btn--ring`) is used for "next" arrows. |
| Ghost `.btn--ghost` | none, bone 0.35 ring | `--ink` | hover bone 0.08 | |
| Bone button `.btn--bone` (new, optional) | bone 0.92 | `--on-bone` | pressed `--bone-deep` | Only for non-action selection (for example "Copied" confirmation chips). Never competes with the CTA. |
| Danger `.btn--danger` | transparent, 1.5px vermilion ring + bone halo | `--vermilion-ink` | hover vermilion 0.14 | The destructive confirm inside `.confirm-row` is the vermilion CTA (it is the action). |
| Inputs, dropzone, linkbox, find box | the panel, then green 0.3 deeper | `--ink`; placeholder `--ink-3` | focus: border `--vermilion`, ring vermilion 0.3 + `--focus` | Border bone **0.7** (3.14:1 over white, 6.93 over black). Invalid: vermilion border + `--vermilion-ink` message. Ok: `--green-leaf` border. YouTube `--mark-cut` becomes the field colour (see 2.3). |
| Switch | OFF: transparent track, 1.5px bone ring; thumb bone | | ON: CTA gradient track, bone thumb (4.20:1, UI) | |
| Segmented / tabs / bg-modes (Glide) | track: panel + 0.1, bone lift 0.08 | labels `--ink-2` (5.27:1 or better) | **bone 0.92 pill + `--on-bone`** | The `.glide--dark` variant (old inverted) becomes the same bone pill. The `.glide--menu` / `.glide--tabbar` vermilion bar and dot stay (e2e pin changes to rgb(232, 57, 43)). |
| Chips / pills | neutral: bone 0.1 + bone 0.3 ring | `--ink-2` | — | vermilion: vermilion 0.16, green deepen 0.2, `--vermilion-ink`. success: `--green-leaf` 0.25, deepen 0.2, `--green-text`. inverted (old `.pill--ink`, `.lib-tab.is-on`, `.money__tile`, `.pstack__mark`, current `.gstep__num`): **bone 0.92 + `--on-bone`**. warn: no fill, 1.5px `#f6c945` ring, text `#ffeec4` (4.9:1). |
| Badges / pulse dot | `--vermilion-deep` + white | | | Ring `rgb(var(--bone-rgb) / 0.9)` |
| Toasts | green 0.90 + `--shadow-2` | bone | | success icon `--green-ink`, error icon `--vermilion` with a bone ring; timer bar `--green-leaf` |
| Progress (bars, update bar) | track bone 0.14 | — | fill `--vermilion` to `--vermilion-light`, glow vermilion 0.5 | The "sage" variant becomes `--green-leaf` to `#8cc7a8`. The done fill is `--green-leaf`. |
| Ring progress (setup) | track bone 0.14 | number `--ink` | fill `--green-leaf`; full ring `--vermilion` with a celebration | |
| Timeline | connector bone 0.2, done `--green-leaf` | label `--ink`, pending `--ink-3` | running: vermilion dot + pulse on a bone node | failed: `--vermilion-deep` node, white glyph |
| Confetti (`lib/confetti.ts`) | — | — | — | `['#E8392B', '#EFE7DA', '#F07A6C', '#5FA585', '#FFF8EE']`. No bottle green: it would vanish on the green surface. |
| Celebration flash (`motion.css .act`) | `--act-tint: var(--vermilion-deep)`; on the CTA, white 0.62 | | check-pop `--green-leaf` | |
| Focus ring | `--focus` (bone inner, vermilion-deep outer) everywhere | | | `:focus-visible` outline 2.5px `--vermilion-deep` |
| Scrollbars | `scrollbar-color: rgb(var(--bone-rgb) / 0.35) transparent` | | | `html { color-scheme: dark }` (base.css:13), so native controls and scrollbars draw dark |
| Selection | `::selection` vermilion 0.55 + `#fff` | 5.51:1 or better | | |
| Tooltip `[data-tip]` | bone 0.96 | `--on-bone` (9.8:1 or better) | | |
| Code / markdown pre | `--green-deep` 0.86 | bone (9.04:1) | | `.md` inline code bone 0.1, links `--vermilion-ink` + vermilion 0.6 underline, blockquote rule `--green-leaf` |
| Help panel (Ask Clip Factory) | green 0.90 (sheet 0.94) | bone | chips: transparent + bone 0.35 ring, hover bone 0.1 | Launcher: `.glass--green` with a bone AskMark. Spark bubble: bone 0.92 + `--on-bone` mark. `--me` bubble: bone 0.92 + `--on-bone` (inverted, like the reference button). `--bot`: green 0.5 + bone ring 0.2. `--notice`: green + vermilion 0.4 ring. Thinking dots `--green-leaf`. `.help-ring` stays bone with a vermilion glow. The "Do it" action is the vermilion CTA. |
| AskMark | currentColor (bone) | | | **dot `fill: var(--vermilion)`** stays, so it becomes `#E8392B`. On bone mark backgrounds the dot keeps the bone/green cutout. |
| Brand mark (sidebar logo) | bone 0.92 tile + green "C" | | `.brand__dot` `--vermilion` | Matches the new icon (section 6) |
| Setup pages (guide steps, gates, key form, copy chips, result cards, TikTok sheet) | `.glass` | `--ink*` | current step: bone 0.35 ring, inset bone 0.2 | `.gstep__num` current: bone pill + `--on-bone`; done: `--green-leaf` + green "✓" glyph in `--on-bone`. The upload zone is dashed bone 0.5. The `.btn--sage` step actions become the vermilion CTA. The illustrated Safari steps keep Safari blue `#0a64d8` on a **bone mock-browser card `#f7f2e8`** (4.92:1); it depicts Safari, so the system blue stays. |
| Review player | letterbox `#071c15` | note text bone 14.4:1 on `--green-deep` 0.88 | | Review card: `.glass`; checklist pass `--green-ink`, fail `--vermilion` icon + `--vermilion-ink` score |
| Charts (performance, earnings) | panel | axis and labels `--ink-3` | — | Line: bone 0.85 (3.83:1 or better, UI). Best: `--vermilion` 3px with a 1.5px bone casing (casing 4.61:1 or better). Origin dot `--green-leaf`. Spark line bone, best spark vermilion. Winner marks / crown / best chip: `--vermilion-deep` + white. Star button ON: vermilion CTA fill + white star (an active state, so vermilion). Earned guesses: `--green-leaf` 0.25 + `--green-text`. |
| Backdrop (brand / frosted) | see 3.2 | | | |
| Skeleton shimmer | bone 0.06 to bone 0.14 | | | |
| Thumb / cover placeholders | `--green-2` to `--green-3` | | | |
| Swatch picker | swatch rings bone 0.35; selected: 3px bone + 5.5px vermilion-deep | | | The "own colour" conic starts and ends on `#e8392b` |

### 2.3 Cutouts (`--mark-cut`)

Fake cutouts must match the surface behind them:

| Where | New `--mark-cut` |
|---|---|
| on panels (linkbox YouTube, account, setup heads, todo marks) | `#244d40`, the panel over the mid backdrop. It reads as a hole whether the panel is lighter or darker. |
| on bone fills (selected chips, check-chip ON, thumb mark) | `#efe7da` |
| on vermilion fills (winner mark) | `--vermilion-deep` (as today) |
| on inverted bone marks (`.pstack__mark`, `.money__tile`) | `#0f372b` |
| `PlatformMark.tsx` fallback `var(--mark-cut, #F7F5EF)` | `var(--mark-cut, #0F372B)` |

---

## 3. Contrast

### 3.1 How the veils are worked out (the new direction)

For bone text, the governing backdrop is the **lightest** one that can be behind a surface:

- In the window look, assume **white** for every native glass (Liquid, vibrancy, acrylic, mica, blur) and for both schemes. The measured lightest Liquid Glass, active over white, is rgb(249,248,245), which is effectively white. Using white needs no new measurement.
- In the picture look, assume a white photo.
- In the colours look, the lightest chosen colour decides. A 50/50 sRGB blend of two colours is never lighter than both of them, so only the single colours need checking. "Own colour" can be `#ffffff`.

The darkest backdrop is still checked, so that green text on bone fills and bone rings are covered at both ends. But dark backdrops now only help bone text.

The veils chosen:

| Look | Page / backdrop veil (green) | Panel veil `--panel-veil` | Loose text (page heads, crumbs, etc.) |
|---|---|---|---|
| window, Clear | 0 | **0.73** = `minVeil(WHITE, WINDOW_TEXT, GREEN)` (27% of the desktop shows through panels; the gaps show the whole desktop) | scrim at panel veil (as today) |
| window, Frosted | 0.30 | **0.88** = min(0.95, clear + 0.15) | scrim at panel veil |
| picture | **0.35** (65% of the photo shows) | **0.65**, so the combined value is 1 − 0.65 × 0.35 = 0.7725, at least 0.77 | **scrim at panel veil** (new for picture: loose text gets the window-look scrim rule) |
| colours (new default) | `coloursVeil` = 0.74 (bone decides; vermilion alone 0.28, green 0) | 0.45 | bare veil (passes) |
| brand / frosted (we own the backdrop) | green frost **0.15** | **0.45** (`--panel-veil-floor`, 55% shows) | bare frost (passes) |
| prefers-reduced-transparency | 0.94 | 0.92 | — |
| no backdrop-filter | — | 0.90 | — |

These are the colours-look veils for the existing swatches with the root text set. They are computed, not fixed: Cream `#f7f5ef` 0.75, Sage 0.60, Sunny 0.68, Mint 0.68, Sky 0.66, Ocean 0.16, Grape 0.36, Bubblegum 0.61, Night 0, `#ffffff` 0.77.

### 3.2 The brand backdrop (default on web, PWA and phones, and the frosted look)

The page owns this backdrop, so it is designed dark. That way panels can stay thin, and more of the moving mesh shows through than today (55% vs today's 34–52%).

- Base: `radial(#174a3a) + linear(#0f372b → #0b2c22 → #133f31)`
- Blobs:
  - a: `--green-3` 0.9
  - b: `--vermilion` 0.42
  - c: `--green-leaf` 0.35
  - d: **bone 0.30 at most** (the lightest spot it allows needs a green veil of 0.11, which the 0.15 frost covers)
- Caustics: bone soft-light 0.25 / 0.08 / 0
- Grain: `mix-blend-mode: overlay`, bone-tinted noise, opacity 0.10

These all need a veil of 0, except the bone blob. The bg-tile and bg-picker previews (`screens.css` 1283 and 1440) copy this recipe.

### 3.3 Vermilion button label

| Label on raw `#E8392B` | Ratio | Result |
|---|---|---|
| white | 4.16 | fails 4.5 |
| bone | 3.39 | fails |
| bottle green | 3.15 | fails |

None of the three passes for small text, and CTA labels are about 15–16px semibold, below the 18.66px-bold large-text size. So **the fill is darkened slightly** (the same approach as today) and the label is **white**:

| CTA state | Fill | White label |
|---|---|---|
| rest, top | `rgb(206 48 36)` at 0.97 over white | 4.96 |
| rest, bottom | `rgb(184 38 28)` at 0.97 over white | 6.03 |
| rest, top over green | — | 5.36 |
| hover, top | `rgb(216 54 40)` at 0.97 over white | 4.52 |
| pressed | `rgb(170 34 25)` | 7.11 |
| bone label on the same fill (rejected) | — | 4.04 |

The fill still reads as `#E8392B` vermilion, because the gradient, glow and shine use `--vermilion` and `--vermilion-light`. Badges use `--vermilion-deep` `#c42a1e` with white (5.68).

### 3.4 Text on surfaces, worst cases (WCAG 4.5:1 needed; every cell passes)

The window rows use the window text set. All other rows use the root set.

| Backdrop (worst case) | composite bg | `--ink` | `--ink-2` | `--ink-3` | `--vermilion-ink` | `--green-ink` | `--green-text` |
|---|---|---|---|---|---|---|---|
| window Clear, panel 0.73, over white | 80,109,100 | 4.61 | 4.61 | 4.61 | 4.62 | 4.85 | 4.85 |
| window Clear, over Liquid active / white (measured) | 78,107,98 | 4.74 | 4.74 | 4.74 | 4.76 | 4.99 | 4.99 |
| window Clear, over Liquid inactive / white (measured) | 72,101,92 | 5.21 | 5.21 | 5.21 | 5.22 | 5.48 | 5.48 |
| window Clear, over Liquid active / black (measured khaki) | 60,86,71 | 6.53 | 6.53 | 6.53 | 6.54 | 6.87 | 6.87 |
| window Clear, over Liquid inactive / black (measured) | 43,72,63 | 8.14 | 8.14 | 8.14 | 8.17 | 8.57 | 8.57 |
| window Clear, over black | 11,40,31 | 12.77 | 12.77 | 12.77 | 12.81 | 13.44 | 13.44 |
| window Frosted, page 0.30 + panel 0.88, over white | 35,72,61 | 8.30 | 8.30 | 8.30 | 8.33 | 8.74 | 8.74 |
| window Frosted, over Liquid inactive / white | 33,69,58 | 8.63 | 8.63 | 8.63 | 8.65 | 9.08 | 9.08 |
| window Frosted, over black | 14,50,39 | 11.33 | 11.33 | 11.33 | 11.36 | 11.92 | 11.92 |
| picture, page 0.35 + panel/scrim 0.65, white photo | 70,101,91 | 5.26 | 4.93 | 4.67 | 4.71 | 4.95 | 5.10 |
| picture, black photo | 12,42,33 | 12.44 | 11.66 | 11.03 | 11.14 | 11.69 | 12.05 |
| colours default, veil 0.74, bare, on bone | 73,101,89 | 5.22 | 4.89 | 4.63 | 4.67 | 4.90 | 5.05 |
| colours default, veil 0.74 + panel 0.45, on bone | 47,80,68 | 7.26 | 6.80 | 6.44 | 6.50 | 6.82 | 7.03 |
| colours default, bare, on vermilion | 71,56,43 | 9.19 | 8.61 | 8.15 | 8.23 | 8.63 | 8.90 |
| colours default, on green | 15,55,43 | 10.68 | 10.01 | 9.47 | 9.57 | 10.04 | 10.35 |
| brand / frosted, lightest mesh spot, panel 0.45 | 52,84,72 | 6.82 | 6.39 | 6.05 | 6.11 | 6.41 | 6.61 |
| brand / frosted, lightest mesh spot, loose text on frost 0.15 | — | — | — | 4.69 | — | — | — |
| reduced transparency, 0.92 over white | 34,71,60 | 8.41 | 7.88 | 7.45 | 7.53 | 7.90 | 8.15 |
| no backdrop-filter, 0.90 over white | 39,75,64 | 7.90 | 7.40 | 7.00 | 7.07 | 7.42 | 7.65 |

### 3.5 UI and other pairs

"Panel / white" and "panel / black" mean the window Clear panel (0.73) over a white or a black backdrop. These are the two extremes of every other look.

| Pair | Ratio | Needs |
|---|---|---|
| bone on solid green / white on green / green on bone | 10.68 / 13.11 / 10.68 | 4.5 |
| vermilion vs solid green (dots, rings, Glide bar) | 3.15 | 3 (UI) |
| vermilion vs panel / white | 1.36 | **fails**: so every vermilion indicator on glass carries a 1.5–2px bone ring or sits on a bone pill |
| bone ring vs panel / white, panel / black | 4.61 / 12.77 | 3 |
| focus: vermilion-deep outer vs bone inner | 3.39 (vermilion) | 3 |
| focus inner bone 0.95 vs panel / white | 4.34 | 3 |
| leaf `#5fa585` / vermilion fill vs panel / white | 1.94 / 1.36 | **fails**: bone casing on every fill (4.61) |
| done node `#8cc7a8` with bone edge; green tick on it | 4.61 (edge) / 6.77 | 3 / 4.5 |
| green text on bone pill 0.92, panel / white / black | 9.69 / 9.19 | 4.5 |
| input border bone 0.7 vs panel / white / black | 3.14 / 6.93 | 3 |
| outlined button ring (bone 0.85) vs panel / white | 3.83 | 3 |
| track label bone on a Glide track (panel + 0.1, bone lift 0.08), over white | 5.27 | 4.5 |
| `--vermilion-ink` (window) on vermilion chip (0.22 + deepen 0.2), over white | 5.69 | 4.5 |
| `--green-ink` (window) on success chip (`#5fa585` 0.25 + deepen 0.2), over white | 4.96 | 4.5 |
| tooltip green on bone 0.96, over white / black | 10.78 / 9.80 | 4.5 |
| selection white on vermilion 0.55, panel / white | 5.51 | 4.5 |
| switch thumb bone vs ON track | 4.20 | 3 |
| switch OFF: bone 1.5px ring vs panel / white | 4.61 | 3 (a bone 0.35 *fill* was 1.86 and is rejected) |
| chart line bone 0.85 vs panel / white | 3.83 | 3 |
| chart best line: bone casing vs panel / white | 4.61 | 3 |
| Safari blue `#0a64d8` on bone card `#f7f2e8` | 4.92 | 4.5 |
| warn text `#ffeec4` on the panel (no amber fill) / white | about 4.9 | 4.5 (an amber 0.18 fill + `#f6d27a` was 3.01 and is rejected) |
| code: bone on `--green-deep` 0.86, over white | 9.04 | 4.5 |
| player note: bone on `#071c15` | 14.43 | 4.5 |

---

## 4. `html.see-through` and `lib/background.ts`

### 4.1 tokens.css

```css
/* The window look (§22.3). Panels are bottle-green glass at --panel-veil; the text goes to bone or lighter so the
   panels need the least green over the lightest the window can be (white). Each has a relative luminance of 0.806
   or more. Keep in step with WINDOW_TEXT_TOKENS in lib/background.ts (test/background.test.ts reads this file). */
html.see-through {
  --ink-2: #efe7da;
  --ink-3: #efe7da;
  --vermilion-ink: #ffe2dc;
  --green-ink: #e4f2da;
  --green-text: #e4f2da;
}
```

### 4.2 background.ts

```ts
export const TEXT_TOKENS = {
  "--ink": "#efe7da", "--ink-2": "#e9e0d0", "--ink-3": "#e4dac9",
  "--vermilion-ink": "#ffd2ca", "--green-ink": "#d2e8c4", "--green-text": "#d6ebc8",
} as const;
export const WINDOW_TEXT_TOKENS: Record<TextToken, string> = {
  ...TEXT_TOKENS,
  "--ink-2": "#efe7da", "--ink-3": "#efe7da",
  "--vermilion-ink": "#ffe2dc", "--green-ink": "#e4f2da", "--green-text": "#e4f2da",
};
export const VEIL: Rgb = hexToRgb("#0f372b");       // bottle green (was off-white)
export const BONE: Rgb = hexToRgb("#efe7da");
```

| Item | Change |
|---|---|
| `TEXT_COLOURS` | `--ink`, `--ink-2`, `--ink-3`, `--vermilion-ink`, `--green-ink`, `--green-text` (all six, since all are light now) |
| `glassCeiling(glass, scheme)` (new) | returns `WHITE` for every glass and scheme. Liquid could use the measured `[249,248,245]`, but white is simpler and safer. |
| `seeThroughVeils` | `clear = max(PANEL_VEIL_FLOOR, minVeil(glassCeiling(...), TEXT_COLOURS_WINDOW))` = **0.73**; frosted = `min(0.95, clear + 0.15)` = **0.88**, with page 0.30 |
| `glassChecks` | keep floor, white and the measured points. All of them are now checked for bone text (the floor passes easily) **and** for `--on-bone` on bone 0.92 pills |
| `TRACK_SHADE` (ink 0.08) | becomes `TRACK_LIFT = 0.08` of **bone**. `TRACK_EXTRA_VEIL` stays at 0.1 (more green on tracks). |
| `CHIP_LIFT` (white 0.2) | becomes `CHIP_DEEPEN = 0.2` of **green** over a tinted chip, so a vermilion or leaf chip is never lighter than its panel |
| `coloursVeil` | samples only the single colours (blends are never lighter than both ends); `max(minVeil(c, TEXT_COLOURS, VEIL))` |
| `MIN_PANEL_VEIL` 0.35 | becomes `PANEL_VEIL_FLOOR = 0.45`, the floor in the brand and frosted looks; window values come out higher anyway |
| `applyLook` | sets `--panel-veil` for every look: window as above, picture 0.65 (page 0.35), colours 0.45, brand and frosted 0.45 (frost 0.15). The picture look gains the loose-text scrim rule (`html[data-backdrop=picture]` alongside `html.see-through` for the scrim selectors only). |
| `TINTED_FLOOR` | becomes `mix(VEIL, BLACK, GLASS_TINT_ALPHA)` with the new green tint. It is only used as a floor check now. |
| `SWATCHES` | the first three become `{#0f372b "Bottle green"}`, `{#efe7da "Bone"}`, `{#e8392b "Vermilion"}`. Then Sage `#9caf88` and Cream `#f7f5ef` are added so old picks still show a name. Then the rest as today. |
| `DEFAULT_COLOURS` | `["#0f372b", "#efe7da", "#e8392b"]` |

Tests to rewrite in the same change:

- `web/test/background.test.ts`: polarity, tokens, every `color:` declaration, the `NOT_ON_A_PANEL_TINT` allowlist becomes `#fff` (CTA), `var(--on-bone)`, `#0a64d8`, `#ffeec4`
- `web/test/styleFloors.test.ts`: `--vermilion-ink` on vermilion glass and leaf glass composites
- `web/test/designTokens.test.ts` and `docs/UX_DESIGN_SYSTEM.md` tables
- `e2e/glide.spec.ts`: 77 and 137 become `rgb(232, 57, 43)`
- `e2e/audit-setup.spec.ts`, `audit.spec.ts`, `settings-tree.spec.ts`: ink and `--green-text` pins
- `e2e/background.spec.ts`: swatch hexes and veil
- `e2e/glass.ts`: adds a pure-white desktop stand-in as the governing case

---

## 5. Default behind-the-glass colours

- `api/src/clipfactory_api/settings.py` `DEFAULTS["backgroundColours"] = ["#0f372b", "#efe7da", "#e8392b"]  # bottle green, bone, vermilion`
- **Read-time migration in `with_defaults`** (no migration job and no infra change; the mapped value is written only
  when the owner next saves settings, as every default is):

  ```python
  OLD_DEFAULT_COLOURS = ("#9caf88", "#f7f5ef", "#e8412c")
  ...
  if field == "backgroundColours" and tuple(c.lower() for c in out[field]) == OLD_DEFAULT_COLOURS:
      out[field] = list(DEFAULTS["backgroundColours"])  # untouched old default follows the new look
  ```

  Only an exact, in-order match of the old trio is mapped. Any custom choice, including a reordering or a subset, is kept. A later PUT stores whatever the owner picks.
- Error text: `"Colours must be like #0f372b."` (CONTRACTS §22.1).
- Mirrors: `web/src/lib/background.ts` `DEFAULT_COLOURS`, `web/src/api/mock/fixtures.ts:515`, and the pytest pins at `api/tests/test_settings_and_system.py` 24, 395, 398, 426–428 and 454. Add a test that the old trio reads back as the new trio, and that a custom trio and a reordered old trio read back unchanged.

---

## 6. Everything outside the stylesheets

| Item | Change |
|---|---|
| `web/index.html` | `<meta name="theme-color" content="#0F372B">`, `color-scheme` `dark`, `apple-mobile-web-app-status-bar-style` `black-translucent` |
| `web/public/manifest.webmanifest` | `background_color "#0F372B"`, `theme_color "#0F372B"` |
| Icon (`web/scripts/gen-icons.mjs` + hand-kept `web/public/favicon.svg`) | Background: radial `#1B4A3B` to `#0F372B`. Rim: bone 0.35. Italic Tinos "C": `#EFE7DA`. Dot: `#E8392B`. Glow: vermilion 0.45. Then run `npm run icons` in `web/` (regenerates `icons/*.png` and `brand/clip-factory-1024.png`), then `desktop/scripts/make-icons.sh` (CI runs it before desktop builds anyway). The owner may want to re-upload `brand/clip-factory-1024.png` as the TikTok and Facebook dev-app icon, but that is optional. |
| Desktop native tint (`desktop/src-tauri/src/main.rs` `GLASS_TINT`) | `Color(15, 55, 43, 140)`, bottle green, same alpha, so the gaps between panels look green while the window is active. Safety does not depend on it: the veil maths uses the white ceiling, which the tint can only darken (and the inactive window drops the tint anyway). The 2026-11-16 measurements were taken with the off-white tint. They stay in CONTRACTS §22.3 as history, and the `LIQUID_MEASURED` overWhite points remain valid upper bounds. `background.test.ts` keeps requiring `GLASS_TINT == [...VEIL, round(GLASS_TINT_ALPHA*255)]`. `Theme::Light` stays in this pass (no unmeasured native change). Switching it to `Theme::Dark` is a later option for the owner to look at on their own Mac. No agent opens windows on the Mac. |
| `lib/confetti.ts` | see 2.2 |
| `components/AskMark.tsx` | no code change: the dot is `var(--vermilion)` (rename from `--tomato`). The doc comment becomes "brand's vermilion dot". |
| `components/PlatformMark.tsx` | fallback cut `#0F372B` |
| `screens/settings/branches.tsx` SeeThroughArt | window body `#0f372b` at 0.73, titlebar `#0a2820`, text lines bone. Sky, sun and hills stay (they are the desktop behind). |
| `api/mock/art.ts`, `mock/setup.ts` | brand scene `#0f372b / #2a5c4a / #0a2820` with glow `#e8392b`; avatar gradient `#2a5c4a` to `#0f372b` with a bone letter. Mock only. |
| `web/public/legal/site.css` (about / privacy / terms under `web/public`) | same tokens: green body `#0f372b` to `#0b2c22`, bone text, vermilion links (`--vermilion-ink`). The repo-root GitHub Pages files (`index.html`, `privacy.html`, `terms.html`, `style.css`, `.nojekyll`) are **not touched**. |
| Help corpus (`helpKb.json`, generated `help-corpus.json`) | It never names sage, tomato or off-white. "Clip Factory colours" stays correct. The one user-visible palette wording is the swatch names (Bottle green, Bone, Vermilion, then Sage, Cream, ...). If a help entry lists swatch names, update it and regenerate with `node web/scripts/help-corpus.mjs` (`--check` in CI). |
| `docs/CONTRACTS.md` | §11/§12 palette lines, §20 animation colour words (Tomato becomes Vermilion, Sage becomes Bottle green or leaf), §20.13 Glide bar and dot, §20.15 AskMark dot, §22.1 default and error text, §22.3 veil maths (ceiling instead of floor, the window numbers from 3.1), §22 swatch names. "Help launcher: sage glass, never tomato" becomes "green glass, never vermilion". |
| Comments and class names | `glass--sage` becomes `glass--green`, `pill--tomato` becomes `pill--vermilion`, `tone="sage"` becomes `tone="primary"` (CTAs) or `"success"` (states). Comments with tomato or sage are updated in the same sweep. |
| `infra/` | nothing (no colour there; owner data untouched) |

## 7. Order of work

1. tokens.css, background.ts (+ unit tests). This is the contrast engine.
2. glass.css, base.css, then the rest of `styles/*.css` by family (2.2).
3. Non-CSS literals (confetti, PlatformMark, branches art, mocks).
4. API default and read-time migration (+ pytest).
5. Icons, manifest, theme-color, native tint.
6. Docs (CONTRACTS, UX_DESIGN_SYSTEM) and e2e pins.
7. Screenshot pass of every screen in each look and strength, including the e2e contrast scan with a white desktop stand-in.

## 8. Where the build differs from this record

Decided while building (ADR-43), each checked by the unit tests and the e2e contrast scan:

- **Chip tints.** Instead of a green deepen of 0.2 laid over a tint, `--tint-leaf` and `--tint-vermilion` lay deep green
  (`--green-deep`, 0.35, `CHIP_DEEPEN`) under the tint (leaf 0.22, vermilion 0.20). Lowest contrast over white: 5.21:1
  for leaf, 6.40:1 for vermilion. Plain wells under words are deep green (`--fill`, 0.30); hover adds green and a
  bone ring rather than a bone lift, so nothing under words is ever lighter than its panel.
- **Pick-one tracks** carry `panel-veil + 0.1` with the bone lift in every look, not only the window look.
- **The brand mesh** is darker than in 3.2 (green-3 blob 0.6, leaf blob 0.22, bone highlight 0.12) under a 0.15 green
  veil in every brand look: the spec's blob strengths stacked to a spot that needed a veil of 0.3 for `--ink-3`.
- **Every other action** is `.btn--action` (the CTA look) rather than a second `.btn--primary`, so the "one main
  action per screen" checks still hold. The Ask panel's "Stay" (leave-page question) is a glass button; "Leave" is
  the action.
- **Fail flash** uses `--vermilion-light` on glass (vermilion-deep on green is too dark to see), white on the CTA.
- **Status bar** is `black`, not `black-translucent`, so the page never slides under the iPhone status bar.
- **Sound cards**: the picked card keeps green glass with a 2 px bone ring (not a bone fill); the tap group's solid
  fill is leaf with deep green words (5.37:1), the deny group's vermilion-deep with white (5.68:1).
- **Cut-outs on bone marks** (`.money__tile`, `.pstack__mark`) are `#efe7da`, the tile's own colour.
- **No `--on-cta` token** (1.2): the CTA and badge labels use a literal `#fff`; tokens.css never defined it.
- **`.glass--clear`** (2.1) is a fixed 0.40 to 0.36 green in the brand, frosted and colours looks (where the page owns
  the dark backdrop), not `max(panel-veil - 0.1, floor)`; in the window and picture looks it is the panel tint.
- **`--panel-veil`** (2.1, 4.2): `applyLook` sets it only for the window and picture looks and removes it otherwise;
  every other look uses the 0.45 floor in tokens.css (`PANEL_VEIL_FLOOR`).
- **Focus and secondary-ring ratios** (1.3, 2.2): the focus ring's inner bone is at 0.95, so it is 4.34:1 against a
  panel over white (not 4.61); `.btn--glass` has a bone 0.85 ring, 3.83:1 there (not a solid 1.5px bone, 4.61). Both
  stay above 3:1. Text fields use `--focus-field` (a 2px bone ring and a faint vermilion glow) so a focused field
  never looks like one with an error; an invalid field keeps its bone edge with 2px of vermilion outside it.
- **Best marks are labels** (2.2 charts row): the best chip, the "Best on" mark, the week card's best pill and the
  crown are the bone pill with green words and a vermilion edge, not `--vermilion-deep` + white. Solid vermilion is
  only for actions (and the star button's ON state).
- **Every CTA is vermilion** (owner, 2026-11-18): the setup list's Set up, Get the app's Show me, Money's Save (off
  until the amount changes), Check for updates, Choose a picture, Add cookies.txt, and each setup step's Open,
  Connect and Save keys are `.btn--action` when they are not the screen's one `.btn--primary`. A CTA that is off is a
  thin vermilion (0.35) over deep green (0.6) with the label at 0.7 white (4.34:1 or more), not a faded red.
- **Floating layers** (the Ask panel and sheet, toasts, the update bar, the phone setup list, the TikTok sheet) are
  0.84 to 0.82 green, not 0.90 to 0.96, so they still read as glass: bone on 0.82 green over pure white is 6.12:1,
  `--ink-3` 5.42:1. The confirm `.sheet` stays near solid (0.95/0.94).
- **Frosted** caustics peak at bone 0.10 (not 0.25), and loose text in the frosted look gets the same panel-tint
  scrim as the window and picture looks: worked out with the caustic's soft-light in test/background.test.ts.
- **The colours mesh** keeps the first colour as the field; the second (a 26% highlight) and third (a 30% glow) are
  mixed into it, so the default reads as deep green with a breath of bone and a warm vermilion glow. The stored
  default and `coloursVeil` are unchanged.
- **Non-text indicators** (3.5): the progress fill has a 1.5px bone casing, the progress ring a bone casing stroke
  under its arc, done timeline nodes are a light leaf (`#8cc7a8`, tick 6.77:1) with a bone edge, and the done
  connector is bone. Leaf vs panel / white was 1.94:1 and vermilion 1.36:1.
- **Swatch tick**: white or bottle green, whichever has more contrast on that colour (`swatchTickIsDark`), so Sage
  and any colour near it never get a white tick under 3:1.
