## Layout and spacing

- Spacing scale (px): 4, 8, 12, 16, 24, 32, 48, 64. Tokens `--space-1` … `--space-8`.
- Radii come from the scale below. Every `border-radius` uses a token (or `calc()` on one for the inner corner of a
  padded box); only hairline bars and tiny thumbs under 8 px, circles (`50%`) and `inherit` stay literal.
  `web/test/designTokens.test.ts` fails on any other hard-coded radius.

| Token | Value | Use |
|---|---|---|
| `--r-xs` | `10px` | Small chips, thumbs and inputs inside rows |
| `--r-sm` | `12px` | Inputs, buttons inside cards, small tiles |
| `--r-md` | `18px` | Cards, chat bubbles, list rows |
| `--r-lg` | `26px` | Panels and glass surfaces (the `.glass` default) |
| `--r-xl` | `34px` | Hero cards and the clip page's big panels |
| `--r-pill` | `999px` | Pills, chips and pill buttons |

- Content max width 1200 px, centred. Gutters 16 px on phones, 24 px on tablets, 32 px on desktop.
- **One text line down the left of a page.** Panels pad their sides by `--inset`; words that sit loose on the page
  (the page title and its line, breadcrumbs, back links, headings and lines between panels, the review count, a
  skill's meta line) start `--loose-x` in (the panel's 1 px rim plus `--inset`), so their first letter lines up with
  the first letter inside the panels below, in every look and at every width. Cards pad their sides by `--inset` too
  (branch cards, the Home hero, the Get the app banner, job rows, the views total, Library cards, Review cards), so
  their icon tile, thumbnail or first word sits on the same line; the breadcrumb's first word too (`e2e/text-line.spec.ts`
  checks it at 320, 390, 768 and 1440 px). Boxes (panels, buttons, pick-one tracks, the Back pill) keep the page edge.

| Token | Value | Use |
|---|---|---|
| `--inset` | `clamp(16px, 2.6vw, 24px)` | A panel's side padding: where words start inside it |
| `--loose-x` | `calc(var(--inset) + 1px)` | Where loose words start: a panel's rim plus `--inset` |
- Grid: one column on phones; cards in rows of 2 from 768 px, 3 from 1100 px (`repeat(auto-fill, minmax(min(100%, 300px), 1fr))`).
- Breakpoints: phone < 768 px, tablet 768–1099 px, desktop ≥ 1100 px.

**Layout inspiration** (the "Sorrel" reference): a big serif italic headline on a green hero card, pill buttons beside
it, a row of cards below, and a rating-style stat block (for example "8 clips waiting · 3 jobs running · 24 posted").
The person in the reference image is not used.
