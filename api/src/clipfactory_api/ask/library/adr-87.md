## ADR-87 The logic of light: the top layer is brighter, every lift is paid for, Reload is a colourless lens

Amends ADR-45.

- **Context.** The owner (2026-11-23, with a screenshot of Library): "can you use the logic of light on the ui,
  meaning the top layer is always brighter than the bottom, and it grows gradually in between ... and make it more
  liquid glassy while you are at it"; then: "can you make sure the reload button when a new feature is released is
  without color and only a liquid glassy style". Under ADR-45 every fill under words was deep green, so a row was
  darker than its card and a mark darker than its row (darker the deeper it nested), almost every hover went darker,
  the most important panel (the hero, `.glass--green`) was the dimmest, and the 140° to 160° tints made each pane's
  top-left denser, so darker over a light backdrop. Bone words cap whatever they sit on at luminance 0.140 (4.5:1):
  a bone sheen with no more green under it is 4.48:1 over the worst panel, the reason ADR-45 had none. The update
  bar's Reload was a second vermilion CTA.
- **Decision.** (CONTRACTS §22.7, §20.17, §11, §12.2)
  1. *Two lights.* Every level is brighter than the level under it, nested levels included; inside every pane the
     top is brighter than the bottom, a bone light from above that eases out and is gone by 65 % of the height.
  2. *Every bone lift is paid for* with a step more green under it (`--light-pay`), and the pay leaves room for the
     ladder (below): `lightPay` works out for each look the least green at which it holds over everything the look
     can show, and lib/look.ts sets it on `<html>`: 0.39 over the app's own backdrop (`LIGHT_PAY_OWN`), 0.16 in the
     window's Clear and in Picture (`LIGHT_PAY_WHITE`), 0 in Frosted, 0 to 0.42 in Colours, 0.04 under reduced
     transparency. The see-through veils, `GLASS_TINT` and the measured floors are unchanged.
  3. *A raised thing is one relative step brighter than its parent at any depth*: green 0.22 and bone 0.09 inside a
     lit surface (its fixed point is under the AA ceiling, so AA holds however deep things nest); straight on the
     page the pick-one track's recipe (panel + 0.22, bone 0.08).
  3a. *The ladder, with no tolerance* (review, 2026-11-23). From a pane up, every nested level reads at least +0.015
     OKLab L brighter than its parent (`LADDER_STEP`) in every look: a row on a pane, a mark, chip or button on the
     row, the lead panel over a plain one, an option over its own track; no level above them ever steps back. Page
     to pane is the one exception, said plainly in CONTRACTS §22.7: bone words need the pane darker than a white
     desktop or photo, a bright spot of the mesh or a light colour, so page to pane may go darker there. Ghost
     buttons are at least +0.03 over what they sit on; Reload's face at least +0.03 over Later's.
  4. *Context through inheritance.* `tokens.css` declares the page values of `--light-raise-*` and the fills built
     from them; every lit surface declares them again (a custom property resolves `var()` where it is declared). One
     name, `--fill`, is right on the page and inside a pane; no per-screen recipes.
  5. *The light is soft, never a line.* A blurred top glow (negative spread, top edge only), a static catch light at
     the top centre 8 px deep (inside the smallest top padding above words; 14 px was first drawn, but the line
     plates and compact rows start their words 8 to 12 px down), a soft shade at the foot and a drop that grows with
     the level. No
     `inset 0 1px 0` hairline, no `::before` rim: the no-edges rule stays.
  6. *One key light above*: every tint and light runs at 180° or is flat.
  7. *Liquid refraction on at most three surfaces a screen*: the existing hero surfaces only (the review took the
     page title plate's bend and its own blur away, and Money's band blurs without bending, so Money stays at
     three; `e2e/refract.spec.ts` counts them at 1440 and 390); nothing new on cards, buttons, toasts, the stat tile
     or the update bar. Nested glass and controls inside a
     blurred surface draw no blur of their own.
  8. *Hover adds light, press takes it away*; no hover is darker than its rest. Only `background-color`,
     `box-shadow`, `transform`, `opacity` or registered numbers transition; never `backdrop-filter`.
  9. *The Reload button is a colourless lens* (`.btn--lens`): clear glass with no tint at all (a near-transparent
     white face, a catch light on its top edge, a clear rim, a soft inner glow, the drop of a raised thing), bone
     words, no vermilion, no shine sweep, no glow and no backdrop-filter of its own (inside the blurred bar a second
     blur laid the bar's tint again and made it darker than Later over a white thumbnail); it reads as the primary
     choice beside Later (a ghost, still a pill with a soft rim of light) by light alone. The desktop
     app's Update stays vermilion: the owner did not ask, and it is a download.
  10. *Tinted chips* lay bottle green 0.35 under their colour (`CHIP_UNDER`, was deep green) and a little bone
      between the two (`CHIP_TINTS`: leaf 0.04, vermilion 0.13, amber 0.02), so a chip is a step of light over its
      row in every look. The danger button lays its vermilion over the raise's own fill for the same reason.
  11. *The lead panel is the brightest pane*, not the dimmest: the panel's green under a 0.075 light, a whole step
      over a plain panel.
- **Alternatives.** *A 1 px white rim* (the refractive-glass recipe's lit edge): a drawn edge, which the owner banned
  in ADR-45. *Raising the base veils to 0.82 or more* so the light needs no pay: the owner said 86 % solid did not
  feel see-through. *Lifts without pay*: under AA. *Displacement on every card*: the Windows WebView2 hover lag of
  PR #159. *A pay of 0.06*: a panel exactly at 4.50, no margin. *A raise of 0.12 / 0.06*: E3 at 4.44 in Colours. *A
  lens of 0.42 / 0.14*: darker than Later over white. *A floating hover with + 0.10 green*: darker over white.
- **Consequences.** The see-through cost of the ladder: about 28 % of the app's own backdrop shows through a panel
  (67 % before ADR-87) and 11 % of a white desktop or photo (27 %); between panels nothing changes. To relax it, change
  one constant (`LADDER_STEP` or `LADDER_DEPTH`) and every look's pay recomputes. Over a white desktop or photo a pane
  sits darker than the page, and every level above it is a visible step brighter. Floating layers
  plan for a white thumbnail under them, so they can read dimmer than a small bright mark right under them; their
  elevation is the largest shadow. `test/background.test.ts` recomputes every contrast and brightness step over every
  look (the margins are 4.51 to 4.65 at the tight spots), `e2e/light.spec.ts` measures the steps in the render. The
  owner judges the real see-through window.
