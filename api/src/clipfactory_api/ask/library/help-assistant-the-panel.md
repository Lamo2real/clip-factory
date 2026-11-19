## The panel

The look and the exact numbers are in [UX_DESIGN_SYSTEM.md](UX_DESIGN_SYSTEM.md#ask-clip-factory) and
[CONTRACTS.md §19.8](CONTRACTS.md#198-web-websrcfeatureshelp). The parts that are easy to get wrong:

- **Desktop panel is non-modal, the phone sheet is modal.** On phones the sheet is `aria-modal="true"`, the page and
  the launcher are `inert`, and Tab stays inside the sheet.
- **The chat is kept** when the panel closes and reopens (in memory only) until **Start over**. On wide screens the
  panel closes by itself when it would cover the control an answer button lit up.
- **The Ask field** spans the full width of the panel and grows from one line to four. A round icon-only paper-plane
  **Send** button sits inside its right end, off while the field is empty. Sending makes the plane fly off up and to
  the right (520 ms) and a new one fade back in (240 ms); the question bubble does not wait for it. With reduced motion
  the plane only fades. The motion is reusable by any button (`useLaunch` / `<Flight>` in
  `web/src/components/PaperPlane.tsx`, `web/src/styles/fly.css`).
- **The launcher stays calm and out of the way**: it has one home spot (phones: above the tab bar at the right; wide
  screens: bottom right) and never moves; nothing about it changes while the page scrolls or a finger is down. Once
  the page has been still (260 ms), if it would make a control hard to tap (covering over 30 % of it, or leaving no
  44 px part of it free; a big card or row link it rests on the edge of does not count) it fades out where it stands,
  letting taps through; it fades back in only after 700 ms of stillness with its spot clear, and holds each state for
  at least a second, so it never blinks. Every page keeps extra room under its last control. Only what shows counts: a
  tab scrolled out of its row or a line cut off by a scroller is no obstacle. The buttons of the setup to-do list
  count like any other control, so with the list open at the top right the launcher stays in its corner under it.
- **Spotlight**: a very tall target (over 60 % of the window) rings only its heading, 80 px from the top.
- **Go Home** is left out of the "I don't know" answer while you are already on Home.
