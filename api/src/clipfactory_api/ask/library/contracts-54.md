## 54. CR active: several pictures, a sheet that fits (owner request, 2026-11-26)

The owner: more than one image on a CR clip. BR-35, ADR-107.

- **L1. Layers.** A CR-active clip carries up to **4 pictures** at once (the soft cap). Tapping a library logo **adds it
  as another layer**; tapping the same logo again adds another copy. Each layer has its own place, size and time. Text
  stays one line, as in §53 C2.
- **L2. The layer list.** A small row of chips under the preview, one per picture (its thumbnail) plus the Text chip.
  The chosen chip is the one the presets, Size, drag and When change; a small **x** on it removes it. At 4: one line,
  "That's 4 pictures. Remove one to add another." and the library logos stop adding. Each picture's warning line
  (§53 C3, captions or facecam) shows for the chosen one, and a chip whose picture is covered shows a small vermilion dot.
- **L3. Stored, additive.** `overlay.logos` `[{layerId, logoId, x, y, size, timing?}]` (at most 4; `layerId` a short
  id the web makes, unique in the list; `timing` `{startSec, endSec}`, absent = the whole clip). The internal bucket
  `key` is added per layer like §53's `logo.key` and never shown. **`overlay.logo` (one picture) stays readable:** a
  clip edited under §53 has no `logos`, and everything reads its `logo` as a one-layer list; the web shows it as one
  layer and any new Make it writes `logos` and no `logo`. `overlay.timing` keeps meaning the text's time (and the
  one picture's time of a §53 edit that has no layer timing).
- **L4. API.** `PUT /v1/clips/{id}/overlay` also takes `logos` (the layers). Each `logoId` must be one of the owner's
  ready logos, `size` 0.08 to 0.5, place inside the picture, `timing` as §53; more than 4 layers is 400 "Up to 4
  pictures." `logo` is still accepted (one layer). At least one picture or the text is needed. Nothing else about
  §53 C5 changes (the original is kept, Reset, Confirm waits, auto-posting only skips a clip still being made).
- **L5. The agent.** One ffmpeg run draws every layer over the original in list order (later on top), each between its
  own start and end (whole clip by default), then the text on top. Same audio, size and encoder as §53.
- **L6. The sheet fits every screen (owner, 2026-11-27).** It never grows past the screen: head and Make it bar stay, the middle scrolls inside it. Nothing sits over anything else; text wraps inside its box. Checked at 375 to 1920 px in `web/e2e/cr-overlay.spec.ts`.
