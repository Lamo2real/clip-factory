# Clip Factory Stories · the liquid-glass contract

The owner's warm reference of 22 Nov (a dark espresso room, amber and copper light out of focus behind smoky glass,
cream solids, an orange accent) on direction B's technical base (one radius scale, a liquid rim on a few hero
surfaces, the three backgrounds). Colours, feel and kinds of shapes only: every screen stays Stories' own.

Eight screen builders start on these names now while the foundation keeps refining the visuals **behind** them.

## The rules for every builder

1. **Only `glass-tokens.css` defines `--st-*` design tokens.** Screens use them and never set them. A builder that
   needs a one-off value keeps it local to its own file with its own prefix (for example `--st-dash-gap`, set on
   its own screen class, never on `.stories-app`) and lists it in its result.
2. **Nobody renames or removes a contract name** (tokens, classes, components, props, data attributes). Add only.
   Need another look of a figure? Ask for a modifier in the foundation's files; do not restyle a figure's inside.
3. **Old names keep working** (`--st-ink`, `--st-sun`, `--st-panel`, `--st-stage`, `--st-s-fill`, …: listed below
   as "old"). Move your screen to the new names; add no new use of an old name.
4. **Radius: one scale, by kind, concentric.** Use `--st-r-*` only (test/storiesStyles.test.ts accepts nothing
   else). Never Clip Factory's `--r-*`: the shell's switch in Stories' top bar uses `--r-md`, and it must look the
   same in both workspaces.
   - surface 20: every glass surface (cards, hero, cream card, rail, top bar, tab bar, toasts, sheets, plates,
     preview bezel)
   - control 14: buttons (the main action too), fields, rows, tiles, option cards, pick-one tracks, steppers, a
     media row's thumbnail
   - inner 10: inside a control (segment options and their highlight, thumbs in a tile, icon pucks)
   - tiny 6: inside an inner (a caption box on a player, a hairline bar's ends)
   - round: only where round is the shape: pills and chips, counts, knobs and toggles, round icon buttons, avatars,
     dots, the dial, the tab bar's active highlight
   - **Concentric rule:** a child that hugs its parent's corner gets the parent's radius minus the gap between them.
     The gaps are picked so the scale lines up: surface 20 − `--st-gap-surface` 6 = control 14; control 14 −
     `--st-gap-control` 4 = inner 10; inner 10 − 4 = tiny 6; a surface around a player with `--st-bezel-pad` 10 =
     inner 10. Any other gap: `calc(var(--st-r-…) - gap)`, never a new number.
5. **Which words on which surface.**
   - On glass (any `.st-glass*`, the stage): `--st-text-strong`, `--st-text`, `--st-text-soft`, `--st-text-amber`,
     and the tone inks (`--st-coral-ink`, `--st-mint-ink`, `--st-sky-ink`).
   - `--st-text-muted` only on a card veil or deeper (wells, fields), never loose on the page.
   - On cream (`.st-cream`, the active pill, steppers) and on the action and status fills: `--st-on-cream`,
     `--st-on-cream-soft`; orange words on cream: `--st-on-cream-orange` (6.3:1).
   - **The bright orange `--st-accent` is for shapes only** (toggles, knobs' rings, the active dot, progress fills,
     the dial's arc). It is never a text colour. Glyphs on it: `--st-on-accent`.
   - The status fills `--st-coral`, `--st-mint`, `--st-sky` are fills and marks, never words.
6. **Backing plates.** Words loose on the page (a page head, the studio title, the studio's tab bar, the phone top
   bar) sit in `.st-plate`: invisible over Ember, a glass plate in Picture and See-through, where anything (a white
   desktop, a busy photo) can be behind them.
7. **Readability over all three backgrounds.** Every word at least 4.5:1, including a worst-case white or busy
   desktop or photo. Never set a veil yourself: the glass classes use the veils `look.ts` puts on `.stories-app`.
8. **The owner's standing rules.** The mouse cursor never changes (no `cursor` anywhere); hover on every control;
   no visible borders (light only: the thin glass edge); nothing overflows from 320 px; targets 44 px, 48 px on
   phones; no text under the floor (`--st-fs-min`, 13 px); reduced motion and reduced transparency honoured; never
   animate `filter` or `backdrop-filter`, and never change either on hover; a glass surface never moves on hover
   (controls may). Kid-proof: never `disabled` (use `aria-disabled` and the deny sound).
9. **Hands off.** The workspace switch with the Live chip (the shell's `web/src/app/WorkspaceDock.tsx`, drawn
   outside `.stories-app`): leave its box free through `--ws-dock-room`, exactly as today. Nothing in
   `web/src/app/**`, `web/src/components/Nav.tsx` or `web/src/styles/glide.css` is restyled. The logo is a shell
   element now (the rename branch: `components/WorkspaceMark.tsx`, `styles/ws-mark.css`, in Clip Factory's main
   bundle, where no `--st-` name may appear); this contract only sets its four shell tokens (`--ws-mark-*`,
   `--ws-wordmark`) on `.stories-app`. No new
   import from `web/src/lib`, `web/src/screens` or `web/src/components` into `web/src/stories` (copy a small
   helper into Stories instead; `web/src/app/shell.ts` is fine). Do not change user-visible words.

## Ownership map

- foundation: web/src/stories/styles/glass-tokens.css (the ONLY place --st-* design tokens are defined),
  web/src/stories/styles/glass.css, web/src/stories/styles/glass-figures.css,
  web/src/stories/styles/fonts.css, the index files web/src/stories/styles/stories.css and
  web/src/stories/styles/studio.css (import order only), web/src/stories/glass/** (new: the shared figure
  components), web/src/stories/look.ts, web/src/stories/settings/LookSection.tsx, the Look parts of
  web/src/stories/prefs.ts, web/public/fonts/stories/**, web/test/storiesStyles.test.ts,
  web/test/storiesGlass.test.tsx, web/src/stories/styles/GLASS-CONTRACT.md
- shell: web/src/stories/styles/st-frame.css, web/src/stories/styles/st-parts.css,
  web/src/stories/styles/st-controls.css, web/src/stories/styles/st-end.css, web/src/stories/StoriesApp.tsx
  (classes and wrappers only: never the switch, the logo, or the background hook the contract put there),
  web/src/stories/ui.tsx
- dashboard: web/src/stories/styles/st-dashboard.css, web/src/stories/screens/Dashboard.tsx
- library: web/src/stories/styles/st-library.css, web/src/stories/screens/Library.tsx
- make: web/src/stories/styles/sd-ideas.css, web/src/stories/styles/sd-characters.css,
  web/src/stories/screens/Ideas.tsx, web/src/stories/screens/Characters.tsx, and inside
  web/src/stories/styles/sd-end.css only the rules whose selectors are Ideas' or Characters' own classes
- produce: web/src/stories/styles/sd-kit.css, web/src/stories/styles/sd-production.css,
  web/src/stories/styles/sd-review.css, web/src/stories/styles/sd-sheet.css, web/src/stories/styles/sd-end.css
  (except the Ideas and Characters rules there), web/src/stories/screens/Production.tsx,
  web/src/stories/screens/Review.tsx, web/src/stories/studio/**
- settings: web/src/stories/styles/settings.css, web/src/stories/styles/st-settings.css,
  web/src/stories/styles/st-settings-video.css, web/src/stories/screens/Settings.tsx (not the Look wiring the
  contract added), web/src/stories/settings/** except LookSection.tsx
- social: web/src/stories/styles/social.css, web/src/stories/styles/st-connections.css,
  web/src/stories/styles/st-social-auth.css, web/src/stories/styles/st-setup.css,
  web/src/stories/screens/Connections.tsx, web/src/stories/screens/Setup.tsx
- chat: web/src/stories/styles/chat.css, web/src/stories/screens/Chat.tsx, web/src/stories/screens/References.tsx,
  web/src/stories/chat/**

Load order (stories.css): glass-tokens.css, glass.css, glass-figures.css, then the screens' files. fonts.css is not in
the index: StoriesApp adds its @font-face rules with the first Stories screen (stories/fonts.ts), because a font face
that arrives with the chunk the shell prefetches while Clip Factory is on screen repaints Clip Factory's words a pixel
off (web/scripts/clips-unchanged.sh with Stories on).
Later files win at equal specificity, so a screen can place and size a figure, but must not set a token.

## The data attributes on `.stories-app` (set by `useStoriesBackground`, never by a screen)

| attribute | values | meaning |
|---|---|---|
| `data-look` | `window` · `picture` · `colours` | what is drawn behind the glass: the desktop through the window (See-through in the Mac or Windows app), the owner's picture, or the colours (also See-through in a browser or on a phone, and Picture with no picture yet) |
| `data-strength` | `clear` · `frosted` | See-through's Glass strength (Frosted: a 0.30 frost, then the panels in the light's order, 0.96 / 0.84 / 0.77 / 0.72) |
| `data-glass` | `liquid` · `simple` · `solid` | how glass is drawn on this device: the liquid rim (Chromium on a capable device), plain CSS light (WebKit, low power), or solid (reduced transparency) |

Inline custom properties it sets: `--st-veil-page`, `--st-veil-card`, `--st-veil-tinted`, `--st-veil-hero`,
`--st-veil-rail`, `--st-veil-bar`, `--st-veil-float`, `--st-veil-plate`, `--st-stage-c1`, `--st-stage-c2-rgb`,
`--st-stage-c3-rgb`, `--st-picture`. In `window` while Stories is on screen it adds `html.see-through` (only when
Clip Factory had not, and takes away only what it added). See-through and its Glass strength are Stories' own,
never Clip Factory's Look or Glass strength: while Stories holds the window it marks `<html data-st-window>`, hides
Clip Factory's own `.backdrop` (its colours, picture or Frosted frost; inline, on that element only) and puts the
class back if Clip Factory's look takes it away meanwhile; Clip Factory on screen gets both back exactly as it left
them (look.ts `holdWindowGlass`, `keepWindowGlass`; test/storiesSeeThroughOwn.test.tsx,
e2e/stories-see-through-own.spec.ts). Screens style by these attributes only through the
glass classes; if a screen needs a look-specific rule, select `.stories-app[data-look="picture"] .your-class`.

## Tokens (glass-tokens.css)

### 1. Base and stage
| token | first value | meaning |
|---|---|---|
| `--st-base` | #1c130e | espresso: the page and the glass tint |
| `--st-base-2` | #2a1c14 | smoky brown: the lightest base stop |
| `--st-base-3` | #0f0a07 | roast: the far corner |
| `--st-glow-copper` | #e2621f | the copper light behind the glass (Ember's 2nd colour: low left, and the warm haze) |
| `--st-glow-amber` | #ff9a45 | the amber light behind the glass (Ember's 3rd colour: high right, and the light strip) |
| `--st-stage-c1`, `--st-stage-c2-rgb`, `--st-stage-c3-rgb` | Ember | what the stage draws (look.ts sets them) |
| `--st-stage-a2`, `--st-stage-a3` | 0.46, 0.3 | how strong the copper and the amber light are |
| `--st-picture` | none | Picture: the owner's picture (look.ts) |
| old: `--st-stage`, `--st-stage-2`, `--st-stage-3`, `--st-stage-copper`, `--st-stage-amber` | | |

### 2. Words
| token | value | where |
|---|---|---|
| `--st-text-strong` | #fffaf2 | headings, big numerals |
| `--st-text` | #fff6ea | body text on glass |
| `--st-text-soft` | #f2e5d4 | second lines |
| `--st-text-muted` | #dccab4 | hints, only on a card veil or deeper |
| `--st-text-amber` | #ffd9a8 | warm words on glass: chips, notes, "new" |
| `--st-on-cream` | #2a160b | words on cream, on the action and on status fills |
| `--st-on-cream-soft` | #5b3a24 | second lines on cream |
| `--st-on-cream-orange` | #9a3e0e | ORANGE WORDS on cream (6.3:1) |
| `--st-on-accent` | #2a160b | glyphs on the orange accent |
| `--st-coral-ink`, `--st-mint-ink`, `--st-sky-ink` | #ffd6cc, #c9f2dc, #d3ecf5 | needs-you, done, tip words (with an icon) |
| old: `--st-ink`, `--st-ink-soft`, `--st-ink-hint`, `--st-sun-ink`, `--st-on-sun`, `--st-on-cream-ember`, `--st-s-ink-2` | | |

### 3. Accent, action, cream
| token | value | meaning |
|---|---|---|
| `--st-accent` | #ff8a3d | orange SHAPES only: toggles, knobs' rings, active dot, progress, the dial's arc |
| `--st-accent-hover`, `--st-accent-pressed` | #ffa25c, #ef7a2c | |
| `--st-action` | #ff9a45 | the one main action of a screen (espresso words) |
| `--st-action-top`, `--st-action-bottom`, `--st-action-hover`, `--st-action-pressed` | #ffb766, #ff8a3d, #ffc27a, #ef7a2c | |
| `--st-cream` | #fff3e4 | solid cream: active pill, the one highlighted card, steppers |
| `--st-cream-2`, `--st-cream-hover` | #f6e6d2, #fffaf3 | |
| `--st-knob` | #fffaf3 | the white knob (dial, toggle) |
| `--st-selected` | cream 0.96 | the sliding highlight (espresso words) |
| `--st-coral`, `--st-mint`, `--st-sky` | #ff7f6a, #6fd9a4, #7cc6e6 | status fills and marks, never words |
| channels | `--st-veil-rgb` `--st-well-rgb` `--st-ink-rgb` `--st-cream-rgb` `--st-shadow-rgb` `--st-accent-rgb` `--st-action-rgb` `--st-amber-rgb` `--st-copper-rgb` `--st-coral-rgb` `--st-mint-rgb` `--st-sky-rgb` | for `rgb(var(--x-rgb) / a)` |
| old: `--st-sun`, `--st-sun-top`, `--st-sun-bottom`, `--st-sun-hover`, `--st-sun-deep`, `--st-ember`, `--st-sun-rgb`, `--st-ember-rgb` | | |

### 4. Veils (numbers 0..1 of the smoky tint; look.ts sets each look's)
| token | Ember | over a white desktop or photo: the measured floor (worst contrast) · drawn Clear · drawn Frosted |
|---|---|---|
| `--st-veil-page` | 0 (the owner's own colours: what keeps loose words, and loose controls at 4.6:1, readable) | 0 · 0 · 0.30 frost |
| `--st-veil-card` | 0.58 | 0.74 (5.34:1) · 0.84 · 0.84 |
| `--st-veil-tinted` | 0.66 | 0.80 with the colour cut to `--st-tint-cut` 0.12 (5.12:1) · 0.80 · 0.82 |
| `--st-veil-hero` | 0.60 | 0.76 (5.14:1), glare only in a top band with no words · 0.79 · 0.77 (a card inside a card uses it too) |
| `--st-veil-rail` | 0.62 | 0.78 (6.47:1) · 0.90 · 0.96 |
| `--st-veil-bar` | 0.72 | 0.78 · 0.79 · 0.77 |
| `--st-veil-float` | 0.72 (its controls' second lines keep 4.5:1 under the sheet's brighter top) | 0.74 · 0.74 · 0.72 |
| `--st-veil-plate` | 0 | 0.78 · 0.90 · 0.96 |

Over a picture or the desktop the drawn veils (look.ts `WINDOW_CLEAR`, `WINDOW_FROSTED`) are never thinner than the
measured floors (`MEASURED`; Frosted's frost and glass together), and keep the light's order over white (5a).
| `--st-veil-solid` | 0.96 | reduced transparency (look.ts puts it inline on every glass, page 0.9 over a desktop or picture) |
| `--st-veil-lens-rim` | 0.4 | a liquid hero's own tint: its filter lays the rest of `--st-veil-hero` under the words, so only the rim band (inside the padding, no words) is this thin |

### 5. The glass recipe
| token | meaning |
|---|---|
| `--st-tint-card`, `--st-tint-hero`, `--st-tint-rail`, `--st-tint-bar`, `--st-tint-float`, `--st-tint-plate`, `--st-tint-tinted`, `--st-tint-raised`, `--st-tint-cream` | the fills of each kind of surface: each is its level's light (`--st-light-N`) over its veil (`--st-shade-*`), lighter at the top (5a below) |
| `--st-tint-lens` | a liquid hero's fill (its light over the rim's veil; glass.css only) |
| `--st-shade-card`, `-tinted`, `-hero`, `-raised`, `-rail`, `-plate`, `-bar`, `-float`, `-lens` | each surface's veil, giving its level's light the share it takes: `v / (1 - light)`, top and bottom |
| `--st-fill-control`, `--st-fill-control-hover` | a glass control or inactive pill (a card's veil loose in Picture/See-through; on the colours the hover deepens loose on the page and is the cream lift `--st-fill-control-lift` inside a `.st-glass`) |
| `--st-fill-figure`, `--st-fill-figure-hover` | set only inside a `.st-glass` or `.st-plate` over a picture or the desktop: a GlassPill or RoundGlassButton there is the light cream glass (0.08, hover 0.12), never a second veil; unset on the cream card |
| `--st-fill-well`, `--st-fill-well-hover` | fields, tracks, the toggle's off track |
| `--st-track` | a progress bar's empty part |
| `--st-blur` 28px, `--st-blur-float` 36px, `--st-saturate` 1.35 | heavy blur |
| `--st-filter-glass` (none over Ember, blur in Picture/See-through), `--st-filter-bar`, `--st-filter-float` | the backdrop filters |
| `--st-edge-width` 1.25px, `--st-edge`, `--st-edge-hero`, `--st-edge-cream` | the thin light edge (a masked gradient ring, never a border) |
| `--st-sheen-soft` | the soft inner top highlight alone |
| `--st-sheen-panel` (1), `--st-sheen` (2), `--st-sheen-hero`, `--st-sheen-raised` (3), `--st-sheen-control` (4), `--st-sheen-float` (5), `--st-sheen-cream` | each level's bright top rim (`--st-rim-N`) in front of the soft inner top highlight |
| `--st-rim-light` | a hero's thick edge catching light, painted (all a WebKit hero has; under a liquid rim it softens it) |
| `--st-glow-1` … `--st-glow-5`, `--st-glow-behind` (= a card's, `--st-glow-2`), `--st-glow-action`, `--st-glow-action-hover`, `--st-glow-accent` | the gentle warm outer glow, by level |
| `--st-depth-1`, `--st-depth-2`, `--st-depth-3` | soft dark depth |
| `--st-focus-ring` | the focus ring (a box-shadow: cream then orange; on the cream card `--st-on-cream-orange` then orange) |
| old: `--st-panel`, `--st-panel-strong`, `--st-panel-hover`, `--st-s-fill`, `--st-s-fill-2`, `--st-s-fill-3`, `--st-shadow`, `--st-shadow-soft`, `--st-s-soft`, `--st-s-lift`, `--st-glow-sun`, `--st-glow-sun-hover` | |

### 5a. Elevation: the logic of light
The owner, 22 Nov: "the top layer is always brighter than the bottom, growing gradually in between", and more liquid
glass. One scale, defined once in glass-tokens.css (5a) and held to look.ts (`ELEVATION`, `ELEVATION_TOP`,
`KIND_LEVEL`) by test/storiesLight.test.ts.

| level | what sits there | fill (light / top extra) | rim | glow | classes and tokens |
|---|---|---|---|---|---|
| 0 | the backdrop: the stage, the page veil; a plate over the colours (it is the page) | 0 | — | — | `.stories-app::before` |
| 1 | page panels: the rail; a plate over a picture or the desktop (the page heads, the phone top bar, the studio's title and tab bar) | 0.025 / +0.03 | 0.14 | 0.26 | `--st-tint-rail`, `--st-tint-plate`, `--st-sheen-panel`, `--st-glow-1` |
| 2 | cards: `.st-glass`, an empty state | 0.045 / +0.04 | 0.20 | 0.42 | `--st-tint-card`, `--st-sheen`, `--st-glow-2` |
| 3 | raised: the hero (and a liquid hero), a tinted tile (needs you, done, a note: its colour asks for the owner), a card inside a card, the bars (`.st-glass--bar`: the phone tab bar, the composer) | 0.07 / +0.05 | 0.28 | 0.50 | `--st-tint-hero`, `--st-tint-lens`, `--st-tint-tinted`, `--st-tint-raised`, `--st-tint-bar`, `--st-sheen-hero`, `--st-sheen-raised`, `--st-glow-3` |
| 4 | controls: `.st-btn`, `.st-pill`, `.st-round-btn`, `.st-glass--control`, rows and tiles | its fill is its light, over the surface it sits on (`--st-fill-control`, the cream lift inside glass); top extra +0.015 (`--st-light-4`) | 0.32 | 0.52 | `--st-light-4`, `--st-sheen-control`, `--st-glow-4` |
| 5 | menus, popovers, sheets, toasts: `.st-glass--float` (the More sheet, the studio's and the chat's sheets, Undo) | 0.20 / +0.06 (its top brighter than any control under it, on a hero too) | 0.40 | 0.58 | `--st-tint-float`, `--st-sheen-float`, `--st-glow-5` |

- Solids (the cream card, the active pill, the steppers, the action, the status fills) are light itself, outside the
  scale. Wells (fields, tracks, the toggle's off track) are carved in: a step down from the surface they are in.
- Numbers: `--st-elev-0` … `--st-elev-5` (the light), `--st-elev-grad-0` … `-5` (the extra at the top, settled into
  the fill by `--st-elev-settle` 58%), `--st-elev-rim-0` … `-5`, `--st-elev-glow-0` … `-5`; built into `--st-light-N`
  (a background layer), `--st-shade-*` (each veil), `--st-rim-N` (`inset 0 2px 0 0`, a thin inner line just inside
  the light edge) and `--st-glow-N`. Over a picture or the desktop a control loose on the page carries a card's veil
  with `--st-elev-4-loose` (0.05) of light; inside glass it is the cream lift.
- **The light takes its share from the backdrop, never from the veil.** A surface of veil v and light e lays v of the
  smoky tint, e of cream, and lets 1 − v − e of what is behind through (its veil layer is v / (1 − e) under the light;
  clamped at 1, so solid glass still steps up). Over a white desktop or photo (where cream and white are alike) every
  surface keeps exactly its measured veil's contrast; over anything darker the light shows. Over the colours look.ts
  works the veils out with the light in (`lit`, `minVeilLit`). A liquid hero's rim tint is
  1 − (1 − v − e)(1 − rim) / ((1 − e)(1 − v)), so under its words it keeps exactly the hero's share.
- **Where it holds.** Over the espresso (the stage's own colour and the glass tint) and over black, each level is
  brighter than the one under it, at its top and at its bottom, in every look: the colours (Ember, Rose, Lagoon, the
  owner's own), a picture, See-through Clear and Frosted, and solid glass. A control is brighter than the surface it
  sits on; a control on a card is brighter than every raised surface but a tinted tile (whose tone is colour too), and
  a sheet brighter than it. Over a bright glow, a white or a busy picture or desktop, smoky glass is darker than what is
  behind it (that is what keeps its words readable): there each surface stays at or above its measured veil, and every
  word keeps 4.5:1 at its brightest part (its top), checked over every look's lightest pixels and, for bars and sheets,
  over a cream card or the action under them.
- **Over a light backdrop** (the owner's rule, Clip Factory's own, 23 Nov): the page-to-panel step may go darker where
  AA needs the veil, but from the panel upward every level is at least `LIGHT_STEP` (+0.015 relative luminance)
  brighter than the one under it over a white picture or desktop, and brighter over mid grey: panels 0.90, cards 0.84,
  raised surfaces 0.79, sheets 0.74 in Clear (about +0.017 a step), and a control a step up from the surface it sits
  on. Over white the light takes its share from what is behind, so there the order is the veils' alone: each level's
  veil is thinner than the one under it (test/storiesLight.test.ts and e2e/stories-light.spec.ts hold it).
- **For builders.** A new surface uses its level's tint (`background: var(--st-tint-card)` …) and sheen; a surface
  that writes its fill out lays `var(--st-light-N)` in front and divides its veil by `(1 - var(--st-elev-N))` (the
  test reads every screen file for it). Gradients and inset shadows only, never another blur layer (the WebView2
  budget); nothing animates `filter` or `backdrop-filter`.
- Known exceptions, kept on purpose: over a picture or the desktop, Settings' rows inside a card
  (`.st-stg-active`, `.st-stg-assign__row`, …) keep a card's veil, a step deeper (pinned by
  test/storiesSettingsStyles.test.tsx and test/storiesSocialGlass.test.ts for their words over a white desktop); a
  tinted tile is brighter than a plain card by its colour as well as its light.
- Proofs: test/storiesLight.test.ts (from the style sheets alone, no browser), e2e/stories-light.spec.ts (the pages:
  one surface per level as the browser computed it, in every look).

### 6. Liquid
`--st-lens-url` (none; glass/lens.ts sets it on each liquid hero), `--st-lens-band` 26px (how wide the bending rim is;
the lens code never makes it wider than the hero's own padding, so it never reaches words), `--st-lens-depth` 12px
(how far light moves at the very edge; never over 0.48 of the band, so the picture never folds), `--st-saturate-lens`
1.5. How it works (glass/lens.ts, started by `useStoriesBackground` only for `data-glass="liquid"` while Stories is on
screen, and never in `data-look="window"`, where the desktop is not part of the page): each `.st-lens` gets its own
SVG filter in `svg.st-lens__defs` (put on `body`, taken away when Stories goes off screen), its displacement map drawn
on a canvas at the hero's exact size and corner radius (a ResizeObserver rebuilds it only when that size changes). In
the band the backdrop is read from further in, most at the very edge (t²); the middle is still (128, 128) and frosted
inside the filter (`--st-blur`) under the rest of the hero's veil, so words keep exactly `--st-veil-hero`. One
displacement pass, no `<animate>`, never a filter transition. At most `LENS_BUDGET` (3) per screen in document order,
none over 1 MP or half the window (`LENS_MAX_AREA`, `pickLenses`). Chromium only (`html.refract`); WebKit (the Mac
app, Safari, iPhone) ignores `url()` there and keeps the plain CSS light (`--st-edge-hero`, `--st-sheen-hero`,
`--st-rim-light`). Reduced transparency: no lens, solid veils.

### 7. Radius
`--st-r-surface` 20px, `--st-r-control` 14px, `--st-r-inner` 10px, `--st-r-tiny` 6px, `--st-r-round` 999px;
gaps `--st-gap-surface` 6px, `--st-gap-control` 4px, `--st-bezel-pad` 10px (rule 4 above).

### 8. Space
`--st-space-1` 4 · `-2` 8 · `-3` 12 · `-4` 16 · `-5` 20 · `-6` 24 · `-7` 32 · `-8` 48 (px); `--st-gap` between
surfaces (12 → 28 px), `--st-inset` inside a surface (16 → 28 px).

### 9. Sizes
`--st-tap` 44px, `--st-tap-phone` 48px, `--st-tap-main` 52px, `--st-rail-w` (the shell's sidebar width),
`--st-tab-h` 66px, `--st-knob-size` 22px, `--st-toggle-w` 48px, `--st-toggle-h` 28px, `--st-thumb` 64px,
`--st-dial` 168px, `--st-dial-track` 10px.

### 10. Type
`--st-font` Playfair (OFL, opsz 5-1200, wdth 87.5-112.5, wght 300-900, read from the files' fvar table; the Latin file
covers å ä ö Å Ä Ö and − – ’ … · ›), `--st-font-caps` Jost
(OFL; short wide-tracked caps captions only), `--st-font-mark` (the logo's "C" stays Clip Factory's Times).
Sizes: `--st-fs-hero` 34 → 72 px, `--st-fs-h1` 32 → 56, `--st-fs-h2` 24 → 36, `--st-fs-h3` 20 → 26, `--st-fs-body`
17, `--st-fs-small` 15, `--st-fs-chip` 14, `--st-fs-caps` 13, **`--st-fs-min` 13 px: the floor**, `--st-fs-num`
40 → 68 (big light numerals), `--st-fs-unit` 0.42em (the unit beside a numeral). Axes and weights:
`--st-opsz-display` 600 (`.st-display` uses it: Womack-like hairlines and wedge serifs; reading sizes keep opsz
auto, sturdy for a 6-8-year-old), `--st-opsz-num` 900, `--st-wdth-display` 92%, `--st-weight-display` 500 (Womack is a
regular weight),
`--st-weight-num` 300, `--st-weight-body` 450, `--st-weight-ui` 650, `--st-lh-head` 1.08, `--st-lh-body` 1.5,
`--st-track-caps` 0.14em.

### 11. Motion
`--st-dur-tap` 110ms, `--st-dur-hover` 160ms, `--st-dur-glide` 340ms, `--st-dur-enter` 420ms, `--st-dur-progress`
900ms, `--st-dur-look` 480ms, `--st-dur-celebrate` 1400ms, `--st-dur-wiggle` 240ms (all travel ones 0 under reduced
motion); `--st-ease-out`, `--st-ease-glide`, `--st-ease-progress` (slow start, fast middle, slow end),
`--st-ease-spring` (a press release and the done tick only).

### 12. Layers
`--st-z-stage` -1, `--st-z-nav` 40 (the shell's dock is 41), `--st-z-float` 60, `--st-z-burst` 70.

### 13. The logo (the shell draws it; Stories only sets its colours here, on `.stories-app`)
The mark is a shell element (the rename branch: `web/src/components/WorkspaceMark.tsx` and `web/src/styles/ws-mark.css`,
in Clip Factory's main bundle, where ci.yml forbids any `--st-` or `.st-`), coloured by the shell's four names with
today's colours as fallbacks: `--ws-mark-tile` (cream tile gradient), `--ws-mark-letter` (espresso "C", 14.6:1),
`--ws-mark-dot` (#ff8a3d), `--ws-wordmark` (#fff6ea; the rail's and the phone top bar's `.st-brand` words use it
too). The old `--st-mark-tile`, `--st-mark-letter`, `--st-mark-dot`, `--st-wordmark` are gone. Also the shell's
`--focus` and `--mark-cut` in Stories' colours.

## Classes

glass.css:
- `.st-glass`: a smoky warm translucent panel (card veil, inner top highlight, outer glow, thin light edge via
  `::after`, radius surface, `--st-text` words). Give it `position` other than static only if you must: it is
  `relative` already.
- `.st-glass--hero`: brighter edge and sheen, its own veil; add `.st-lens` for a rim that may bend.
- `.st-glass--bar`: a bar something scrolls under (top bar, phone tab bar): heavy blur in every look.
- `.st-glass--float`: sheets, menus, toasts: the float veil and the heaviest blur.
- `.st-glass--tinted`: a colour-tinted tile (level 3: its colour asks for the owner); set `--st-tone-rgb` (for
  example `var(--st-mint-rgb)`).
- `.st-glass .st-glass` (a plain card inside a card): one level up (`--st-tint-raised`, `--st-sheen-raised`).
- `.st-glass--control`: a glass control or inactive pill (radius control, control fill, hover deepens).
- `.st-cream`: the solid cream surface with espresso words (the one highlighted card).
- `.st-plate`: the backing plate for loose words (rule 6).
- `.st-edge`: the thin light edge alone, for a surface with its own fill.
- `.st-lens` (+ `.is-liquid` from the lens code), `.st-lens__defs`: the liquid rim.
- `.st-lens--tinted` (set `--st-tone-rgb` on it): a liquid hero that keeps its colour, cut to `--st-tint-cut` from the
  top left, over the rim's tint (the cards that need the owner); without the rim it is the card's own tint.
- `.st-display` (Playfair display), `.st-caps` (Jost caps caption), `.st-num` (lining tabular figures).
- `.st-look`, `.st-look__picture`, `.st-look__art` (`--window`, `--picture`, `--colours`), `.st-look__pane`,
  `.st-look__swatches`, `.st-look__swatch`, `.st-look__thumb`, `.st-look__actions`, `.st-look__modes`: Settings › Look
  (foundation only).
- The stage is `.stories-app::before` (foundation only; nobody else draws `::before` on `.stories-app`).

glass-figures.css (the figures' own classes; screens place and size them, never restyle their inside):
`.st-pill` `.st-pill--small` `.st-pill.is-on` `.st-pill__icon` · `.st-round-btn` `.st-round-btn--lg`
`.st-round-btn--cream` `.st-round-btn--accent` `.st-round-btn.is-on` `.st-round-btn__dot` · `.st-stat`
`.st-stat__value` `.st-stat__num` `.st-stat__unit` `.st-stat__label` `.st-stat__hint` · `.st-dial` `.st-dial__svg`
`.st-dial__groove` `.st-dial__arc` `.st-dial__stop-a` `.st-dial__stop-b` `.st-dial__knob` `.st-dial__knob-shade`
`.st-dial__centre` `.st-dial__value` (size: `--st-dial-size`) · `.st-stepper` `.st-stepper__btn` `.st-stepper__sign`
`.st-stepper__value` · `.st-toggle` `.st-toggle__track` `.st-toggle__knob` ·
`.st-cream-card` `.st-cream-card__head` `.st-cream-card__eyebrow` `.st-cream-card__title` `.st-cream-card__body`
`.st-cream-card__toggle` `.st-cream-card__foot` · `.st-media` `.st-media__thumb` `.st-media__text`
`.st-media__title` `.st-media__meta` `.st-media__bar` `.st-media__track` `.st-media__fill` `.st-media__time`
`.st-media__controls` · `.st-tab-orb`.

## Components (`import { … } from "../glass/index.ts"`)

- `Glass({ variant?: "card" | "hero" | "bar" | "float" | "tinted"; tone?: string /* "255 154 69" */; lens?: boolean; as?: "div" | "section" | "article" | "aside" | "header" | "nav" | "li"; …HTMLAttributes })`
- `GlassPill({ active?: boolean; size?: "md" | "sm"; icon?: ReactNode; as?: "button" | "span"; children; …ButtonHTMLAttributes })`: active = solid cream, dark words; others glass. In a pick-one bar give each `role="radio"` and `aria-checked`, and keep the bar on `<Glide>`.
- `RoundGlassButton({ label: string; children /* the icon */; tone?: "glass" | "cream" | "accent"; size?: "md" | "lg"; active?: boolean; dot?: boolean; …ButtonHTMLAttributes })`
- `StatNumeral({ value: number | string; unit?: string; label: ReactNode; hint?: ReactNode; className? })`, plus `formatStat(value)`.
- `ArcDial({ value: number; max?: number /* 1 */; label: string; valueText?: string; size?: number; sweep?: number /* 240 */; children?: ReactNode /* the centre */; className? })`: `role="progressbar"` with min, max, now and words; plus `dialFraction(value, max)`, `knobAt(fraction, sweep)`.
- `Stepper({ value: number; onChange(next: number); label: string; min?; max?; step?; format?(n): string; onLimit?(); decreaseLabel?; increaseLabel?; className? })`: never disabled; at an end `aria-disabled` and `onLimit` (play the deny sound).
- `GlassToggle({ checked: boolean; onChange(next: boolean); label: string; id?; className? })`: `role="switch"`, orange when on.
- `CreamCard({ title: ReactNode; eyebrow?: ReactNode; children?; toggle?: ReactNode /* a GlassToggle */; footer?: ReactNode; as?: "section" | "article" | "div"; headingLevel?: 2 | 3 | 4; className? })`
- `MediaRow({ thumb?: string | ReactNode; thumbAlt?: string; title: ReactNode; meta?: ReactNode; progress?: number | null /* 0..1 */; progressLabel?: string; progressText?: ReactNode; controls?: ReactNode; as?: "div" | "li" | "article"; className? })`
- `PhoneTabHighlight({ className? })` and `TAB_ORB` ("st-tab-orb"): the round active highlight; put it in the active tab, or give the bar's `<Glide>` the class so it slides. The bar itself is `.st-glass.st-glass--bar`.
- `cx(...names)`: Stories' own class joiner.
- `glass/lens.ts` (the foundation's; screens only add `.st-lens` to a hero): `watchLenses(root, opts?)` → stop,
  `lensPixel`, `lensPixels`, `lensMapUrl`, `lensFilterParts` (built as elements), `lensFilterMarkup` (as text),
  `middleVeil`, `pickLenses`, `LENS_BUDGET`, `LENS_MAX_AREA`, `LENS_BAND`, `LENS_DEPTH`, `LENS_FOLD`.

## The background (look.ts, foundation)

`useStoriesBackground(root, active)` is StoriesApp's one call. Stories' own setting in `cf.stories.prefs` (`more`):
`look.mode` (`see-through` | `picture` | `colours`, default `colours`), `look.strength` (`clear` | `frosted`),
`look.colours` (1-3 hex, default Ember `#1c130e #e2621f #ff9a45`; presets Ember, Rose, Lagoon), `look.glass` (a device
override for checks); the picture in its own `cf.stories.picture` (shrunk to at most 1920 px, JPEG). Never Clip
Factory's `cf.prefs` or `cf.background`. Readers and writers: `useStoriesLook()`, `storiesLook()`,
`setStoriesLook(patch)`, `setStoriesPicture(url | null)`, `veilsFor(look, glass?, tier?)`, `lookKind(look)`,
`glassTier(env)`, `useReducedTransparency()`, `LENS_BUDGET`, `THEME_COLOUR` (#1C130E, for the shell to adopt with its
theme-colour tests). Settings › Look is `settings/LookSection.tsx`, shown for now at the end of Settings › Storage
(this device's own choices, beside Sounds and motion); its own tab is a later step.

**The stage is worked out exactly.** `STAGE_LIGHTS` is what glass.css draws (a light strip at the right edge, amber
high right, copper low left, a darker corner behind the page heads, a warm haze; test/storiesLens.test.ts holds the
CSS and the list together, e2e/stories-glass.spec.ts the drawn pixels and the model). `stageAt` is CSS's gradient
maths; `stageSpots(colours)` the lightest pixel over `STAGE_WINDOWS` (320 × 568 to 3440 × 900). Ember's lightest is
0.118 luminance, so loose words need no page veil (every ink at 4.5:1 or more). Colours too bright to read on get a
page veil instead, worked out the same way. Change a light: change both, and the test tells you if a word drops.

**Solid glass comes from here.** The veils are inline on `.stories-app`, so they beat every stylesheet rule; for
reduced transparency (and `look.glass` solid) `veilsFor` itself returns `--st-veil-solid` for every glass (page 0.9
over a desktop or a picture). glass-tokens.css's `@media` only covers the first paint. The hook follows the device's
setting live.

## Measured (22 Nov, the foundation's figures and glass classes in the mock app, e2e/stories-glass.spec.ts)

23 Nov, with the logic of light (5a): the same spec still finds every word at 4.5:1 or more over all seven
backgrounds at 375 and 1440 px (the light takes its share from the backdrop, so over white nothing gets lighter);
test/storiesLight.test.ts works every surface out at its top and bottom over every look's lightest pixels.

Every word against the lightest and the darkest pixel behind its own glyphs, at 375 and 1440 px, Chromium (liquid):

| background | worst word |
|---|---|
| Colours › Ember | 6.0:1 (orange caps on cream; every word on glass 6.9:1 or more) |
| a white picture | 5.3:1 (`--st-text-muted` on a card) |
| a busy picture | 5.4:1 |
| See-through, Clear, over a white desktop | 6.0:1 |
| See-through, Clear, over a busy desktop | 5.5:1 |
| See-through, Frosted, over white or busy | 6.0:1 |
| reduced transparency over a busy picture | 6.0:1 (solid glass, no backdrop filter) |

Not the foundation's, for the shell: the brand wordmark in the phone top bar measured 1.1:1 over a busy picture or a
busy desktop and 3.8:1 in the rail over a white picture with today's (old) rail. The phone top bar needs its
`.st-plate` (or `.st-glass--bar`) and the rail `--st-tint-rail`. WebKit in headless Playwright on a Mac does not really
blur behind glass (a known gap of its software compositor): judge WebKit's blur in the real Mac app, never there;
the veils are planned for a white pixel behind, so words hold either way.
