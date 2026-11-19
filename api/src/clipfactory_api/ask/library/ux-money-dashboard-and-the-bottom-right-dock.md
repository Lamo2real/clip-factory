## Money dashboard and the bottom-right dock

Contract: docs/CONTRACTS.md §27, ADR-50. Monthly MRR is the main card (display-size number, counts up once); Weekly
and Daily share a row; Yearly always says "At this pace for a year". Every amount carries its tag ("YouTube's
estimate"). Apps that never share money are named once in a note with "Not shared" chips, never shown as $0.

- **The dock (a page pattern).** On phones and touch tablets a page whose controls the thumb needs often keeps them in
  a glass dock at the bottom right, above the tab bar: two right-aligned rows, the most-used row nearest the thumb,
  every target 44 px, `--float-veil` tint, no edge. The page sets `.has-money-dock` and `--dock-h` on `<html>` before
  it paints, so Ask's launcher moves its home spot above the dock (it still never moves while the page is open), and
  the page's bottom padding grows so the last row scrolls clear. Nothing tappable in the top-left third.
  On a short phone the content above the dock tightens so the page's key number is in view above it on first load.
  The dock comes right after the page title in the DOM (reading and tab order); `position: fixed` keeps it where it
  shows.
- **Wide screens with a mouse.** The same controls sit at the right end of a full-width glass band under the title
  that stays at the top while the page scrolls. The page scrolls under the whole band, so the controls never float
  over content beside them (a floating pill would hide a row's money or a sort bar).
- **Loading a new choice.** The last numbers stay in place dimmed until the new ones arrive; if the new load fails
  they go and the error with Try again shows instead, so old numbers never sit under new chips.
- **Toggle chips** (several can be on) are buttons with `aria-pressed` and the `--selected` fill; pick-one choices
  stay Segmented with Glide.
- **Charts.** Hand-drawn SVG bars, no gridlines, axes or borders; one soft baseline band; YouTube bone, Facebook leaf;
  never vermilion; a small tip on tap mirrored in a polite live line, and "Show as a list".
