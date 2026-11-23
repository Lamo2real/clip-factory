## The logic of light

The owner (2026-11-23): "the top layer is always brighter than the bottom, and it grows gradually in between ... make
it more liquid glassy" ([DECISIONS.md ADR-87](DECISIONS.md#adr-87-the-logic-of-light-the-top-layer-is-brighter-every-lift-is-paid-for-reload-is-a-colourless-lens),
[CONTRACTS.md §22.7](CONTRACTS.md#227-the-logic-of-light-owner-request-2026-11-23-adr-87)). One key light above:

* **Every level is brighter than the one under it**, nested levels too: a panel over the page, a row over its card, a
  mark over its row, the selected pill over all of them. Only wells (fields, the link box, progress tracks) sit lower.
* **Inside every pane the top is brighter than the bottom**: a bone light from above that eases out and is gone by
  14 px down (it lies in the top padding, never under a word), a catch light at the top centre 8 px deep, a blurred top glow, a soft
  shade at the foot and a drop below that grows with the level. All soft: no line is ever drawn (ADR-45).
* **See-through first, every step earned with light.** Panes keep main's veils (67 % of the app's own backdrop shows
  through; a light look adds at most 0.05: 22 % of a white desktop or photo), and each level above a pane brings its
  own bone light over a little green, so its words keep AA (`lib/background.ts` works every number out;
  `web/test/background.test.ts` checks them in every look).
* **The ladder.** From a pane up, every level reads at least +0.015 OKLab L brighter than the one it sits on, where
  its words are, in every look (`LADDER_STEP`), wherever the AA cap leaves room. Where it leaves none (the brightest
  corners of the mesh, white under Clear and Picture, Cream, a vivid vermilion mesh: CONTRACTS §22.7 has the numbers)
  a level keeps AA and reads at most 0.03 darker instead. Page to pane may go darker over a light backdrop.
* **Hover adds light, press takes it away.** No hover is darker than its rest, in any look (a tab on the tab bar
  lays bone alone, so it adds light over a white thumbnail too).
* **Quiet buttons still look like buttons**: Later, Skip and Not now are a pill with a soft rim of light and their own
  small top light, at least +0.03 L over what they sit on, with no drop shadow.
* **The Reload button** on the update bar is a colourless lens: clear white glass with a catch light on its top edge
  and a clear rim, no tint at all, at least +0.03 L over Later on its whole face, bone words, no vermilion.

| Level | What | Tint | Light (top → base) |
|---|---|---|---|
| L0 | The page and the backdrop | unchanged | none |
| E1 | Panels, the sidebar, the title and line plates | panel veil + the pay (0 over the app's own backdrop, 0.05 in the window looks and Picture); a plate: plate veil + the pay | 0.04 → 0 at 14 px, plus the catch light |
| E1 lead | The hero, the sign-in card, Library's learnings | the panel's green | 0.075 → 0 at 14 px: brighter than E1 at its top edge |
| E2, E3 | Rows, cards, controls, marks, chips (each over the one under it) | 0.22 over the parent (on the page: panel + 0.22) | flat 0.09 (on the page 0.08) |
| Float | Toasts, the update bar, the setup pill and list, the Ask panel, the money dock | the floating veil + 0.16 | 0.08 → 0.02 |
| Lens | Reload | none: clear glass | white 0.18 → 0.12 at 32 %, a catch light on the top edge, a clear rim |
| Overlay, menu | Sheets, the viewer, the dropdown list, the workspace menu | 0.86 to solid | 0.12 / 0.10 → 0.04 |
| Selected | The pill, the glide, the tooltip | bone 0.92 | the brightest |
| Wells | Fields, the link box, progress tracks | one step below | none |

**Fills under words** (`web/src/styles/tokens.css`; glass.css declares `--light-raise-*` and the fills again inside
every lit surface, so one name is right on the page and inside a pane):

| Token | Value | Use |
|---|---|---|
| `--fill` | `linear-gradient(rgb(var(--bone-rgb) / var(--light-raise-lift)), rgb(var(--bone-rgb) / var(--light-raise-lift))), rgb(var(--green-rgb) / min(1, var(--light-raise-veil)))` | A raised thing under words (rows, inner cards, glass buttons, chips, step numbers): one step brighter than what it sits on, a bone lift over a step more green. On the page the track recipe; inside a lit surface the relative raise |
| `--fill-hover` | `linear-gradient(rgb(var(--bone-rgb) / var(--light-raise-hover-lift)), rgb(var(--bone-rgb) / var(--light-raise-hover-lift))), rgb(var(--green-rgb) / min(1, var(--light-raise-hover-veil)))` | Its hover: more bone paid for with more green, never darker |
| `--fill-press` | `linear-gradient(rgb(var(--bone-rgb) / var(--light-press-lift)), rgb(var(--bone-rgb) / var(--light-press-lift))), rgb(var(--green-rgb) / min(1, var(--light-raise-veil)))` | Its press: the same green, less bone |
| `--fill-ghost` | `linear-gradient(rgb(var(--bone-rgb) / var(--light-ghost-lift)), rgb(var(--bone-rgb) / var(--light-ghost-lift))), rgb(var(--green-rgb) / min(1, var(--light-ghost-veil)))` | A quiet fill (a skipped row, every other table row, the toast's Undo): a touch less than `--fill`, still a step of light over its parent |
| `--fill-control` | `var(--fill)` | The old name of `--fill`, for drop zones and check chips |
| `--fill-sunk` | `rgb(var(--green-deep-rgb) / 0.3)` | The few true wells that are not fields: progress tracks, drop targets |
| `--tint-leaf` | `linear-gradient(rgb(var(--green-leaf-rgb) / 0.22), rgb(var(--green-leaf-rgb) / 0.22)), linear-gradient(rgb(var(--bone-rgb) / 0.04), rgb(var(--bone-rgb) / 0.04)), rgb(var(--green-rgb) / 0.35)` | The success tint: leaf over bottle green 0.35 (`CHIP_UNDER`) |
| `--tint-vermilion` | `linear-gradient(rgb(var(--vermilion-rgb) / 0.2), rgb(var(--vermilion-rgb) / 0.2)), linear-gradient(rgb(var(--bone-rgb) / 0.13), rgb(var(--bone-rgb) / 0.13)), rgb(var(--green-rgb) / 0.35)` | The vermilion tint (pills, callouts, the error sound) over bottle green 0.35 |
| `--tint-amber` | `linear-gradient(rgb(246 201 69 / 0.16), rgb(246 201 69 / 0.16)), linear-gradient(rgb(var(--bone-rgb) / 0.01), rgb(var(--bone-rgb) / 0.01)), rgb(var(--green-rgb) / 0.35)` | The amber (warn) tint over bottle green 0.35 |
| `--selected` | `rgb(var(--bone-rgb) / 0.92)` | The selected pill and the glide: the brightest layer, `--on-bone` words |
| `--fill-field` | `rgb(var(--green-deep-rgb) / 0.45)` | Text fields and the link box: a well, one step below its parent |
| `--shade-field` | `inset 0 3px 10px rgb(var(--shadow-rgb) / 0.35)` | The field's soft inner shade (blurred, never a line) |
| `--shadow-1` | `var(--light-shadow-1)` | A panel's drop (the older name of `--light-shadow-1`) |
| `--shadow-2` | `var(--light-shadow-3)` | A floating layer's drop (the older name of `--light-shadow-3`) |

**The light's numbers** (each is a constant in `lib/background.ts`, named in brackets; the values here are the page's,
`:root`):

| Token | Value | Use |
|---|---|---|
| `--light-raise-veil` | `calc(var(--plate-veil) + 0.22)` | Green a raised thing lays over what it sits on. Page: plate veil + 0.22 (`TRACK_EXTRA_VEIL`; nothing dims under it); inside a lit surface, and on a pick-one track's options, 0.34 (`RAISE_VEIL`) |
| `--light-raise-lift` | `0.08` | Bone on top of it. Page 0.08 (`TRACK_LIFT`); inside 0.13 (`RAISE_LIFT`) |
| `--light-raise-hover-veil` | `calc(var(--plate-veil) + 0.22)` | Hover green. Page: plate veil + 0.22; inside 0.37 (`RAISE_HOVER_VEIL`) |
| `--light-raise-hover-lift` | `0.09` | Hover bone. Page 0.09 (`PAGE_HOVER_LIFT`); inside 0.145 (`RAISE_HOVER_LIFT`) |
| `--light-ghost-veil` | `calc(var(--plate-veil) + 0.22)` | A quiet fill's green. Page: the track's; inside 0.33 (`GHOST_VEIL`) |
| `--light-ghost-lift` | `0.06` | A quiet fill's bone. Page 0.06 (`PAGE_GHOST_LIFT`); inside 0.125 (`GHOST_LIFT`) |
| `--light-press-lift` | `0.03` | Bone when pressed (`RAISE_PRESS_LIFT`) |
| `--light-pay` | `0` | Extra green on a pane (`lightPay`): lib/look.ts sets each look's own on `<html>`. See-through first: 0 over the app's own backdrop, Clear and Frosted (`LIGHT_PAY_OWN`), 0 where white can be behind (`LIGHT_PAY_WHITE`), at most 0.05 in a light Colours look (`MAX_LIGHT_PAY`, never 0.82 or more in all), 0.04 under reduced transparency. The ladder is earned with each level's own light |
| `--light-panel` | `0.04` | A panel's light at its top edge, gone 14 px down (`PANEL_LIGHT`) |
| `--light-lead` | `0.075` | The lead panel's light: a whole step over a plain panel (`LEAD_LIGHT`) |
| `--light-lead-pay` | `0` | The lead panel's extra green (`LEAD_EXTRA_VEIL`) |
| `--light-float` | `0.08` | A floating layer's light (`FLOAT_LIGHT`) |
| `--light-float-hover` | `0.09` | Its hover (`FLOAT_HOVER_LIGHT`) |
| `--light-float-pay` | `0.02` | Its extra green over the floating veil (`FLOAT_EXTRA_VEIL`): the least over main's 0.73 at which a float's words and a chip on it keep AA over a white thumbnail |
| `--light-update-pay` | `0.22` | The update bar's extra green over the floating veil (`UPDATE_EXTRA_VEIL`, 0.95 in every look, Frosted included): the one float that darkens more, so Reload reads 0.08 over Later with bone words at AA over a white thumbnail |
| `--light-overlay` | `0.12` | Sheets, the picture viewer, the markup editor (`OVERLAY_LIGHT`) |
| `--light-menu` | `0.1` | The dropdown list and the workspace menu (`MENU_LIGHT`) |
| `--light-tabbar` | `0.04` | The tab bar's light (`TABBAR_LIGHT`) |
| `--light-tabbar-pay` | `0.04` | The tab bar's extra green (`TABBAR_EXTRA_VEIL`) |
| `--light-spec` | `0.06` | The catch light at the top centre, inside the top padding only (`SPECULAR`) |
| `--light-rim-1` | `inset 0 6px 8px -6px rgb(var(--bone-rgb) / 0.24)` | A panel's top glow: light catching the top of the glass, blurred, never a line |
| `--light-rim-2` | `inset 0 4px 6px -4px rgb(var(--bone-rgb) / 0.26)` | A raised thing's top glow |
| `--light-rim-2-hover` | `inset 0 4px 6px -4px rgb(var(--bone-rgb) / 0.34)` | Its hover |
| `--light-rim-3` | `inset 0 6px 8px -6px rgb(var(--bone-rgb) / 0.3)` | A floating layer's or an overlay's top glow |
| `--light-rim-sm` | `inset 0 3px 4px -3px rgb(var(--bone-rgb) / 0.22)` | The top glow of small things (marks, chips, step numbers) |
| `--light-rim-lens` | `inset 0 5px 7px -5px rgb(var(--bone-rgb) / 0.4)` | The Reload lens's top glow |
| `--light-rim-lens-hover` | `inset 0 5px 7px -5px rgb(var(--bone-rgb) / 0.5)` | Its hover |
| `--light-shade-1` | `inset 0 -14px 22px -18px rgb(var(--shadow-rgb) / 0.4)` | A pane's soft shade at its foot |
| `--light-shade-2` | `inset 0 -6px 10px -8px rgb(var(--shadow-rgb) / 0.4)` | A raised thing's soft shade at its foot |
| `--light-press` | `inset 0 2px 6px rgb(var(--shadow-rgb) / 0.35)` | The inset shade from above while pressed |
| `--light-shadow-1` | `0 1px 3px rgb(var(--shadow-rgb) / 0.16), 0 10px 28px -16px rgb(var(--shadow-rgb) / 0.55)` | A panel's drop |
| `--light-shadow-1-hover` | `0 2px 6px -1px rgb(var(--shadow-rgb) / 0.22), 0 16px 36px -18px rgb(var(--shadow-rgb) / 0.65)` | A panel that lifts on hover (cards, job rows) |
| `--light-shadow-2` | `0 2px 4px -2px rgb(var(--shadow-rgb) / 0.3), 0 6px 14px -8px rgb(var(--shadow-rgb) / 0.45)` | A raised thing's drop |
| `--light-shadow-2-hover` | `0 3px 6px -2px rgb(var(--shadow-rgb) / 0.32), 0 10px 20px -10px rgb(var(--shadow-rgb) / 0.55)` | Its hover |
| `--light-shadow-press` | `0 1px 3px rgb(var(--shadow-rgb) / 0.22)` | Its drop while pressed |
| `--light-shadow-3` | `0 4px 10px -4px rgb(var(--shadow-rgb) / 0.3), 0 22px 48px -22px rgb(var(--shadow-rgb) / 0.85)` | A floating layer's drop |
| `--light-shadow-4` | `0 8px 20px -8px rgb(var(--shadow-rgb) / 0.35), 0 30px 70px -30px rgb(var(--shadow-rgb) / 0.9)` | An overlay's or a menu's drop |

**The per-level layers** (a pane's `background` is `var(--glass-light), var(--glass-tint)`; its `box-shadow` one of
the `--glass-shadow-*`):

| Token | Value | Use |
|---|---|---|
| `--glass-tint-panel` | `linear-gradient(rgb(var(--green-rgb) / min(1, var(--panel-veil) + var(--light-pay))), rgb(var(--green-rgb) / min(1, var(--panel-veil) + var(--light-pay))))` | E1: a panel's green, the veil plus the pay |
| `--glass-tint-lead` | `linear-gradient(rgb(var(--green-rgb) / min(0.97, var(--panel-veil) + var(--light-pay) + var(--light-lead-pay))), rgb(var(--green-rgb) / min(0.97, var(--panel-veil) + var(--light-pay) + var(--light-lead-pay))))` | The lead panel's green |
| `--glass-tint-float` | `linear-gradient(rgb(var(--green-rgb) / min(1, max(var(--float-veil), var(--panel-veil)) + var(--light-float-pay))), rgb(var(--green-rgb) / min(1, max(var(--float-veil), var(--panel-veil)) + var(--light-float-pay))))` | A floating layer's green: it plans for white |
| `--glass-tint-overlay` | `linear-gradient(rgb(var(--green-rgb) / max(0.86, var(--panel-veil))), rgb(var(--green-rgb) / max(0.86, var(--panel-veil))))` | A sheet's green over its scrim |
| `--glass-tint-tabbar` | `linear-gradient(rgb(var(--green-rgb) / min(1, var(--tabbar-veil) + var(--light-tabbar-pay))), rgb(var(--green-rgb) / min(1, var(--tabbar-veil) + var(--light-tabbar-pay))))` | The tab bar's green (icons only, 3:1) |
| `--glass-spec` | `radial-gradient(60% 8px at 50% 0, rgb(var(--bone-rgb) / var(--light-spec)), transparent)` | The catch light, 8 px deep (panels, overlays): inside the smallest top padding above words, never under them |
| `--glass-spec-sm` | `radial-gradient(50% 8px at 50% 0, rgb(var(--bone-rgb) / var(--light-spec)), transparent)` | The small catch light, 8 px deep (floats, the tab bar) |
| `--glass-light-panel` | `var(--glass-spec), linear-gradient(180deg, rgb(var(--bone-rgb) / var(--light-panel)) 0, rgb(var(--bone-rgb) / calc(var(--light-panel) * 0.5)) 6px, rgb(var(--bone-rgb) / calc(var(--light-panel) * 0.15)) 11px, rgb(var(--bone-rgb) / 0) 14px)` | E1's light: brightest at the top edge, gone 14 px down |
| `--glass-light-lead` | `var(--glass-spec), linear-gradient(180deg, rgb(var(--bone-rgb) / var(--light-lead)) 0, rgb(var(--bone-rgb) / calc(var(--light-lead) * 0.5)) 6px, rgb(var(--bone-rgb) / calc(var(--light-lead) * 0.15)) 11px, rgb(var(--bone-rgb) / 0) 14px)` | The lead panel's light |
| `--glass-light-float` | `var(--glass-spec-sm), linear-gradient(180deg, rgb(var(--bone-rgb) / var(--light-float)) 0, rgb(var(--bone-rgb) / calc(var(--light-float) * 0.5)) 6px, rgb(var(--bone-rgb) / calc(var(--light-float) * 0.15)) 11px, rgb(var(--bone-rgb) / 0) 14px)` | A floating layer's light |
| `--glass-light-float-hover` | `var(--glass-spec-sm), linear-gradient(180deg, rgb(var(--bone-rgb) / var(--light-float-hover)) 0, rgb(var(--bone-rgb) / calc(var(--light-float-hover) * 0.5)) 6px, rgb(var(--bone-rgb) / calc(var(--light-float-hover) * 0.15)) 11px, rgb(var(--bone-rgb) / 0) 14px), linear-gradient(rgb(var(--bone-rgb) / 0.01), rgb(var(--bone-rgb) / 0.01))` | Its hover |
| `--glass-light-overlay` | `var(--glass-spec), linear-gradient(180deg, rgb(var(--bone-rgb) / var(--light-overlay)) 0%, rgb(var(--bone-rgb) / calc(var(--light-overlay) * 0.6)) 30%, rgb(var(--bone-rgb) / calc(var(--light-overlay) * 0.33)) 65%)` | An overlay's light |
| `--glass-light-menu` | `linear-gradient(180deg, rgb(var(--bone-rgb) / var(--light-menu)) 0%, rgb(var(--bone-rgb) / calc(var(--light-menu) * 0.6)) 40%, rgb(var(--bone-rgb) / calc(var(--light-menu) * 0.4)) 70%)` | A menu's light |
| `--glass-light-tabbar` | `var(--glass-spec-sm), linear-gradient(180deg, rgb(var(--bone-rgb) / var(--light-tabbar)) 0%, rgb(var(--bone-rgb) / calc(var(--light-tabbar) * 0.25)) 65%)` | The tab bar's light |
| `--glass-shadow-panel` | `var(--light-rim-1), var(--light-shade-1), var(--light-shadow-1)` | E1: top glow, foot shade, drop |
| `--glass-shadow-raise` | `var(--light-rim-2), var(--light-shade-2), var(--light-shadow-2)` | E2 and up |
| `--glass-shadow-raise-hover` | `var(--light-rim-2-hover), var(--light-shade-2), var(--light-shadow-2-hover)` | Their hover |
| `--glass-shadow-press` | `var(--light-press), var(--light-shadow-press)` | Pressed |
| `--glass-shadow-float` | `var(--light-rim-3), var(--light-shade-1), var(--light-shadow-3)` | A floating layer |
| `--glass-shadow-overlay` | `var(--light-rim-3), var(--light-shade-1), var(--light-shadow-4)` | An overlay |
