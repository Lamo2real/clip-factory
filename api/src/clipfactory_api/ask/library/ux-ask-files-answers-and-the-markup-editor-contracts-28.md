## Ask: files, answers and the markup editor (CONTRACTS §28)

* **File tile**: 168 × 64 (72 tall in the phone sheet), a soft control fill, a bone square with the format icon
  (`fileText`, `fileTable`, `fileCode`, `filePdf`, `file`), the format in capitals (xs, bold), the name on one line with
  an ellipsis and the size in xs. In the question bubble the tile is solid green with bone words. Picture tiles keep
  the §26 look; a small bone pen says "tap to mark", and it turns red (`--ask-ink`) once marked. Take-away is the §26
  32 px circle in a 44 px target. A progress ring covers a tile while it uploads. On phones the tray is one row that
  scrolls sideways (the chat stays in view with 10 files); wider panels wrap it, at most 156 px tall, and scroll inside.
  Notes over the tray are opaque. A screen reader hears the format for one file and the count for several.
* **Composer**: the paperclip (`paperclip`) at the left of the field, "Ask me anything", the paper plane at the right;
  while an answer streams the plane becomes a green glass **Stop answer** square (the same button, so keyboard focus
  stays on it). "Still using: …" pills (small text) above the field for carried files, each with a 32 px take-away
  circle in a 44 px target. Drops show "Drop it here". Files dragged over the Ask button make it grow a little and
  glow (a soft leaf glow, no ring; still with less motion).
* **Answer**: a status line with the Ask mark (it breathes; still with less motion), safe markdown, tables in a soft
  fill with zebra rows, code in a deep green block with a **Copy** pill, bone `[n]` chips, a **Sources** box, the app
  buttons (the newest answer's first is vermilion), a soft leaf tip for "Turn on web search", and **Copy answer**.
* **Markup editor**: a modal glass dialog (≤ 1100 × 820; 92vw × 88vh on tablets; full screen on phones), the picture
  on a deep green stage, a `<Glide>` tool bar (Pen, Box, Arrow; one Tab stop, arrow keys choose) at the bottom left,
  green glass Undo, Redo (desktop and tablet; a long press of Undo on phones, with no text callout or menu), Clear,
  Cancel and the vermilion **Save** at the bottom right (56 px on phones; on phones Cancel is the × at the top right, on tablets a 48 px × in the bar).
  In the page the tools come before the picture and the actions after it (Tab: tools, picture, Undo, Redo, Clear,
  Cancel, Save); a grid draws them in the bottom bar. The picture is a "drawing area" (`role="application"`), and a
  trackpad pinch zooms it, never the page. The ink `--ask-ink: #E8231B` is a
  content colour drawn on the picture with a white halo, never a UI edge, and never the vermilion action colour.
* **Search key card** (Settings › App & account › Ask): the steps, then **Get a search key** as a glass button
  (≥ 48 px, external icon) under them, never a link inside a sentence; **Save key** is the card's vermilion action.
* **Bigger**: the panel grows to `min(880px, 100vw - 48px)` on desktops and tablets; Start over shows as its icon
  while the panel is narrow so the title stays on one line.
