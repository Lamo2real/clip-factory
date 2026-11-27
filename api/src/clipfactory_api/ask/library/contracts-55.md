## 55. CR active: the editor sheet fits every screen (owner request, 2026-11-27)

- **S1.** The Edit for campaign sheet never grows past the screen. Its head and its Make it bar stay in place; the middle scrolls inside it. The bar clears the phone's bottom edge.
- **S2.** Nothing sits over anything else: the preview is a normal block (no sticky strip), with its own height that scales to the screen (`clamp`, `dvh`) and its chips under it.
- **S3.** Text stays in its box (`min-width: 0`, `overflow-wrap`). The Add a picture tile has a minimum height, not a fixed shape, so its words wrap inside it. The delete buttons sit inside their tiles.
- **S4.** Tested at 375, 430, 820, 1280 and 1920 px wide in `web/e2e/cr-overlay.spec.ts`. Nothing else changes: pictures, text, timing and Reset work as before.
