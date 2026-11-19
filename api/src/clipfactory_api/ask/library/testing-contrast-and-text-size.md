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
