## ADR-49 Still page changes, a compositor-only glide, and one top line under an overlay title bar

- **Context.** The owner (2026-11-19, the Mac app, macOS 27.2, see-through Liquid Glass): the menu highlight was smooth
  for two thirds of its slide and laggy for the last third; every page change made the whole window blink white and
  twitch; and the top was ragged: a white native title bar strip, then the menu, the setup card, the settings folders
  and the title plate starting 14, 18, 28 and 34 px down. The Mac app draws with WebKit (WKWebView); the earlier
  smoothness tests ran in Chromium only. Measured in headless WebKit and Chromium with the wrapper simulated: the page
  cross-fade (View Transitions) thinned every glass panel to 32 to 53 % for 100 ms and ended with a 35 to 118 ms stall
  at about 400 ms; the `page-in` fade left the new page transparent for 300 ms; the 460 ms spring reached the item at
  170 ms, overshot to 110 % and crept back; the glide also animated width and height and a separate `scale`.
- **Decision.**
  - *A page change is an instant swap* (CONTRACTS §20.16): no View Transition, no `page-in`, no panel fading in.
  - *The glide is FLIP on the compositor* (§20.13): new place and size at once, one Web Animation on `transform` from the
    old box, a 360 ms non-overshooting ease-out `cubic-bezier(0.22, 1, 0.36, 1)` with the stretch folded in.
  - *One top line* (§11.1): `--titlebar-h`, `--top-safe` and `--top-line` in tokens.css, read by every column. The
    folded setup list's pill shares the line from 940 px: the page starts on it and its first row leaves the pill room
    (`--todo-room`), the settings folders stick on it over the strip's bar.
  - *No see-through loading state* (§20.16): `useLoad` remembers each page's last result for the session, and first-visit
    skeletons carry the panel tint (in the cloud app a page's data takes a full round trip, which showed as a white
    sheet under the title on every page change).
  - *An overlay title bar on macOS* (§12.3): `TitleBarStyle::Overlay` + `hidden_title(true)`, `__CF_TITLEBAR__ = 28`, a
    transparent `data-tauri-drag-region` strip exactly over the 28 px band, and one runtime capability for the app's own origin:
    `core:window:allow-start-dragging` and `core:window:allow-internal-toggle-maximize`.
  - *WebKit* for the three specs that hold this (`nav-smooth`, `page-still`, `top-line`): the `webkit` Playwright
    project; CI runs it in the one `web-e2e (WebKit)` job. `nav-smooth`'s WebKit run is macOS only: on the Linux
    runners WebKit (GTK/WPE, not the Mac's engine) never started the glide's animation at all.
- **Alternatives.** *Keep the cross-fade but shorter*: still blends two pictures of the whole window and still ends with
  WebKit rebuilding the glass. *A transform-only page entrance*: the owner asked for the window to stay still. *Defer the
  slide until the new page has painted*: measured, it moved the late frames rather than removing them, and added a
  delay to every tap. *`traffic_light_position`*: depends on tao's inset maths; the system place is fine with a 28 px band.
  *The page one pill strip below the menu in pill mode*: the first build did this, and at the app's default window
  (1200 x 820, pill mode) the page sat 72 px below the menu, which is what the owner asked to fix. *A drag strip as
  tall as the top line (42 px)*: invisible, so a control that scrolled up into its lower 14 px moved the window
  instead. *Animating width for every glide*: needs the main thread; kept for the in-page bars with uneven options
  only, where a scaled pill squashed its round ends.
- **Consequences.** Page changes cost no animation at all. In headless WebKit the slide's last third has no frame over
  34 ms (was 35 to 118 ms); a new page's own layout can still give the main thread an odd 25 to 80 ms frame in the
  slide's first half, which a compositor animation does not show. The title bar change reaches the owner only with a
  new desktop build; until then the web part already lines every column up (the band is 0 without the new wrapper).
  Not measured on the real Mac window: the title bar height on macOS 27, and the slide's smoothness in WKWebView.
