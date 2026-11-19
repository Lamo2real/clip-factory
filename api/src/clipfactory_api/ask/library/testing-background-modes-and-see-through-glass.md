## Background modes and see-through glass

See-through, Picture and Colours ([CONTRACTS.md §22](CONTRACTS.md#22-background-modes-and-see-through-glass-owner-request-2026-11-16)).
Everything but the native window effect is tested offline against the mock app.

```bash
cd web
npx vitest run test/background.test.ts
CF_E2E_PORT=4186 npx playwright test e2e/background.spec.ts e2e/contrast.spec.ts --project=chromium
CF_E2E_PORT=4186 npx playwright test e2e/screenshots.spec.ts -g "see-through|settings-background" --project=screenshots
cd ../api && uv run pytest tests/test_settings_and_system.py
cd ../desktop/src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

| Suite | Must show |
|---|---|
| Vitest `test/background.test.ts` | WCAG contrast maths; `minVeil` is the smallest veil reaching 4.5:1; the measured Liquid Glass numbers and its floor, a tenth darker than the darkest measured; `TINTED_FLOOR` is the app tint (140/255) over black and equals `GLASS_TINT` in `main.rs`; black for the unmeasured glasses and for any dark setting; the window look's text colours: only four change, each to a relative luminance of 0.047 or less, the same hue, still told apart; Clear is the least that reaches AA and never under 0.35; Frosted is the 0.30 frost plus panels 0.15 heavier, and always shows less; **every glass × light and dark × Clear and Frosted × (floor, white, and for Liquid Glass both measured floors): every text colour of the window look reaches AA on a panel, on a pick-one track and on every tinted chip**; the stylesheets stay in step (`tokens.css` values and the `html.see-through` overrides, every `color:` declaration is a token or a named exception, the window-look rules for placeholders and marks exist, the numbers 0.08, 0.10 and 0.20 in `glass.css` are the ones in `background.ts`, the panel rule gives way to denser tints and lifts the tab bar); colours are 1–3 distinct `#rrggbb`; the colours veil holds AA on each colour and each pairwise blend; `resolveLook` for every mode and glass; only `__CF_DESKTOP__ === true` with a known `__CF_GLASS__` means real glass, an unknown name is `none`, and every name `main.rs` can send is known; the computer and phone sentences word for word; prefs defaults and junk; a picture with no saved mode starts in Picture; `applyLook` puts `see-through`, `data-backdrop`, `data-glass`, `data-strength`, `--backdrop-veil` and `--panel-veil` on `<html>`. |
| pytest `test_settings_and_system.py` | Defaults (no `backgroundMode` until saved, `clear`, the Clip Factory colours), saving (lower case, repeats dropped), a saved mode survives other saves, each refusal with its message, malformed stored values read as defaults. |
| Playwright `e2e/background.spec.ts` | Default and browser fallback (frosted backdrop, caustics, the sentence and its Get the app link); on an iPhone the phone sentence and no link; switching modes; the backdrop draws exactly the chosen colours with the computed veil; a fourth colour is refused; your own colour; persistence over a reload; Picture with and without a picture; an old picture with no saved mode is still shown (and after a reload); Glass strength picks see-through and thickens the frost; Night alone: previews wear the veil, the soft-colours line shows; search finds the new apples. Simulated desktop (`asDesktop` in `e2e/glass.ts`: `page.addInitScript` sets `__CF_DESKTOP__` and `__CF_GLASS__`). `liquid`: `html` and `body` transparent, no tint between panels for Clear, panels at the computed `--panel-veil` (under 0.5), the four deeper text colours on `<html>` and in drawn words, Frosted frosts the gaps and makes panels heavier, Colours brings the page and the usual text colours back. `vibrancy`, `acrylic`, `mica` and `blur` keep working, each with its own tint and AA on its darkest; a dark setting assumes black. Over the measured floors rgb(118, 118, 118) and rgb(180, 171, 148), the busy picture, the planned floor and white, every word on the Background page is readable, Clear and Frosted, at 375 and 1440 px. No visible text straight on the window (every surface under words is at least as strong as the look's own panel tint) on every screen, This week, the skill pages and a clip page, for `liquid` and `vibrancy`, at 375 and 1440 px. Glass `none` shows the in-app sentence; a glass name the page does not know gives an ordinary page. At 320, 375, 768, 1440 and 1920 px, light and dark: no overflow in any mode, one-line tile names, AA text on the darkest colour. |
| Playwright `e2e/contrast.spec.ts` | The window look on every screen: see [Contrast and text size](#contrast-and-text-size). |
| Playwright `e2e/screenshots.spec.ts` | `settings-background-*.png` (phone and desktop, light and dark) and the simulated see-through window on Home, Clear and Frosted, at 390 and 1440 px: `see-through-scene-*.png` over the busy picture as Liquid Glass shows it while the window is in use, `see-through-floor-*.png` over the darkest measured floor. |

**The stand-ins are not the real glass.** They are flat colours and one blurred picture, mapped through the four
measured numbers. In a browser a panel's own blur and saturation also work on the stand-in, which the real window may
not do. So the look is checked by hand on a built app as well.

### Hand check: the real window

The native effect (macOS Liquid Glass or vibrancy, Windows acrylic or blur) is drawn by the operating system outside
the web page, so no browser test can see it. After a desktop build, check it on **macOS 26 or newer**, on
**macOS 15** (or older) and on **Windows** (11, and 10 if there is one), with known pictures straight behind the
Clip Factory window.

1. Make the pictures: one pure black, one pure white, one with 22 pt black and white stripes, one with a few words in
   75 pt bold and one line of normal text, and a photo with clear shapes (a car).
2. Open a picture full screen (Preview or Photos), put the Clip Factory window on top of it, and pick See-through in
   Settings › Look & feel › Background.
3. Look twice at each picture: once with the Clip Factory window **in use** (click it), once **not in use** (click
   another app's window that does not cover it).
4. Read colours off the screen with a colour picker (Digital Color Meter on a Mac, the PowerToys colour picker on
   Windows): the bare glass between two panels, and the middle of a panel.

- [ ] **The page knows its glass.** In a debug build (`npm run dev` in `desktop/`), the web inspector's console
      gives `document.documentElement.dataset.glass`: `liquid` on macOS 26+, `vibrancy` on macOS 15 and older,
      `acrylic` on Windows 11 22H2+, `blur` on Windows 10 and Windows 11 21H2.
- [ ] **macOS 26+, bare glass.** It should match what was measured on 2026-11-16, give or take 5 levels:

      | | Over black | Over white |
      |---|---|---|
      | Window in use | rgb(180, 171, 148) | rgb(249, 248, 245) |
      | Window not in use | rgb(118, 118, 118) | rgb(225, 225, 225) |

      These were measured with the earlier light tint; with the bottle-green tint (ADR-43) the glass in use reads
      darker and greener. A panel should measure close to `mix(bottle green, glass, 0.73)`. Readability no longer
      depends on these numbers: the page plans for white behind every glass (`glassCeiling`).
- [ ] **macOS 26+, the system's own settings.** The numbers above were read with the system in dark mode only.
      Read the glass over the black picture again, in use and not in use, three more times: with the system in
      light appearance, with Reduce transparency switched on, and with Increase contrast switched on (System
      Settings › Accessibility › Display). Write the numbers down in CONTRACTS.md §22.3. If the glass over black is
      ever darker than rgb(106, 106, 106), adjust as described just above.
- [ ] **macOS 15 and Windows, bare glass.** Nobody has measured these: write down the glass over black and over
      white, in use and not in use. The page assumes **black** for them and gives panels 0.68. If the glass over black
      is clearly never darker than some grey, add the numbers next to `LIQUID_MEASURED`, give `glassFloor` that
      grey (a tenth darker) for that glass, and its panels get clearer. On Windows 10 the blur should be no darker
      than rgb(136, 135, 131).
- [ ] **Over white, every word is easy to read**, in use and not in use: body text, meta lines, vermilion-tinted
      links and the "Didn't work" pill (Jobs), green "Saved" and "Best guess" words, placeholders in empty fields, the
      labels of segmented bars, a toast, a delete sheet and the Ask panel. That is the case the tints are worked out
      for (bone words on bottle-green glass).
- [ ] **Over black, the same words are still easy to read**, and outlined bone buttons still look like buttons.
- [ ] **Over the stripes and the big words:** the stripes come through as soft bands, the 75 pt words can be guessed,
      the normal line cannot be read. Through a panel the same, softer.
- [ ] **Over the car:** its edges are guessable between the panels and softly through them, never sharp.
- [ ] Frosted shows less than Clear; Colours and Picture cover the desktop completely.
- [ ] The window stays glassy when another app is in front, and resizing or dragging does not lag.
- [ ] Linux: an ordinary window and the "This computer can't show see-through" line.
