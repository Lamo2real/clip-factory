## 22. Background modes and see-through glass (owner request, 2026-11-16)

The owner wants the whole app to feel like liquid glass you can almost see through: "if there's a car behind it, I
can see the edges of the car", on the Mac and Windows app and on phones. Three choices sit in
Settings › Look & feel › Background; **see-through is the default**.

| Mode | What is behind the glass |
|---|---|
| `see-through` (default) | Desktop app with native glass: whatever is behind the window (the wallpaper, other windows), blurred by the system; it shows between the panels and softly through them, so it can be guessed, never read. Anywhere else: frosted Clip Factory colours with slow light moving through them. |
| `picture` | The owner's own picture (kept on the device, as before, §12). No picture yet: the Clip Factory colours. |
| `colours` | 1 to 3 colours the owner picks (swatches or their own colour), blended as a slow mesh. |

### 22.1 Settings (api, `settings.py`)

`Settings` gains three fields (all `PUT /v1/settings`, validated, §5 errors):

```ts
backgroundMode?: "see-through" | "picture" | "colours"  // no server default: absent until saved
backgroundColours: string[]   // 1..3 distinct "#rrggbb", stored lower case; default ["#0f372b", "#efe7da", "#e8392b"]
glassStrength: "clear" | "frosted"                       // default "clear"
```

Bad values are 400 with a plain message ("Pick what goes behind the glass: See-through, Picture or Colours.",
"Pick Clear or Frosted glass.", "Pick 1 to 3 colours.", "Colours must be like #0f372b."). A malformed stored value
reads as the default. A stored value that is exactly the colours before the bottle-green look (`#9caf88`, `#f7f5ef`,
`#e8412c`, in that order: an owner who never changed them) reads as today's default (ADR-43); read time only (no
migration job: the mapped value is written only when the owner next saves settings, as every default is), and any
other choice is kept. The web reads a cached copy of that trio in `cf.prefs` the same way (`currentColours`). The picture itself never leaves the device (`localStorage` `cf.background`). The web keeps a
copy of the three fields in `cf.prefs` so the look applies before `/v1/me` answers, like sound and motion (§15.4);
old servers without the fields read as the defaults.

**Upgrade rule (existing pictures).** `backgroundMode` has no server default: `GET /v1/settings` and `/v1/me` leave
it out until the owner saves one, and the web never copies an absent mode over the device's. Until then the device
decides: no mode in `cf.prefs` and a picture in `cf.background` (set before see-through existed) → `picture`, so the
owner keeps seeing their picture after the upgrade; otherwise `see-through`. Once saved, the saved mode wins
everywhere.

### 22.2 Desktop window glass (`desktop/`, Tauri v2)

* `src-tauri/src/main.rs` picks the glass from the operating system before the window is built and tells the page
  its name:

  | Computer | `window.__CF_GLASS__` | What draws it |
  |---|---|---|
  | macOS 26 or newer | `liquid` | Liquid Glass (`LiquidGlassRegular`) |
  | macOS 11 to 15 | `vibrancy` | The under-window vibrancy material (`UnderWindowBackground`, an `NSVisualEffectView`) |
  | Windows 11 22H2+ (build ≥ 22621) | `acrylic` | Acrylic |
  | Windows 10 1809 (17763) to Windows 11 21H2 | `blur` | Blur behind (acrylic lags while dragging on those builds) |
  | Anything else (Linux, older Windows) | `none` | An ordinary opaque window |

  Mica is not used: it only shows the wallpaper's colours, never the shapes the owner wants to guess.
* Every Mac asks Tauri for the same effects, `[LiquidGlassRegular, UnderWindowBackground]`, state `Active`: Tauri
  draws Liquid Glass where it exists and falls back to the vibrancy material where it does not. Which of the two the
  page is told comes from the signal Tauri and window-vibrancy use for that fallback: AppKit's own version number
  (`NSAppKitVersionNumber`, a constant AppKit exports) against window-vibrancy's
  `MIN_APPKIT_VERSION_LIQUID_GLASS`, **2685** (macOS 26.0). `Glass::for_appkit(version)` is a pure function of the
  number, so it is unit-tested; a test pins window-vibrancy to 0.8.x in `Cargo.lock`, so an update asks for a fresh
  look at the threshold. Reading the constant is the crate's one `unsafe` item: `[lints.rust] unsafe_code` is
  `"deny"` (not `"forbid"`, which could not be allowed anywhere) and is allowed on that extern block only. No new
  crates.
* With glass, the window is `transparent(true)` with those effects and a bottle-green tint (`GLASS_TINT`,
  15/55/43 at 140/255; it was the light 247/245/239 until ADR-43), so the gaps between the panels look green. Who
  honours the tint: **macOS 26+ Liquid Glass does while the window is in use, and drops it while another app is in
  use** (measured with the earlier light tint, §22.3); the Windows `blur` path does (worked out, not measured);
  Windows 11 22H2+ acrylic drops it (window-vibrancy sets only the system backdrop type; tauri documents `color` as
  having no effect on Windows 11); the vibrancy material of macOS 15 and older takes none. Readability never depends
  on the tint: the page plans for the lightest each glass can be (white), which a tint can only darken. The window
  theme stays forced to **Light**, the material that was measured; switching it is for the owner to look at on a Mac.
* macOS transparency needs `app.macOSPrivateApi: true` (tauri.conf.json) and tauri's `macos-private-api` feature.
  This rules out the Mac App Store, which the app does not use (unsigned `.dmg`, §12.3).
* The injected script starts with `window.__CF_GLASS__ = "liquid" | "vibrancy" | "acrylic" | "blur" | "none"` and
  `window.__CF_DESKTOP_VERSION__ = "<version>"`, followed by `init.js` (`__CF_DESKTOP__ = true`, outward links). The
  remote page still gets **no** Tauri IPC (`withGlobalTauri` off, empty capability).
* **Note (2026-11-18): a copy built before this glass existed never sets `__CF_GLASS__`.** It is not a computer that
  can't show glass; it is an old app. The page asks it to update (§12.6) instead of showing the `none` note. New
  copies update themselves (§12.6), so this cannot happen again.
* `windows-version` (already in the lock file through tauri) reads the Windows build. Unit tests cover the choice
  per OS, AppKit version and Windows build, the glass this computer reports, and the script prefix for every glass.
* **Phase 2 pending measurement (ADR-45).** The window look's panel tint stays 0.73 (planned for white) until the
  real Mac glass is measured with the bottle-green tint: Liquid Glass Regular and Clear, light and dark window
  theme, with and without the tint, in use and not, over flat colours on a helper window behind it. The rig, the
  18-cell matrix and how to pick from it (ceiling = measured over white lifted 15 % toward white; panel =
  `max(PANEL_VEIL_FLOOR, minVeil(ceiling))`, the floor 0.20 since 2026-11-23; the cell with the best see-through while
  **inactive** wins) are in the
  see-through build spec, §7; nothing changes in `main.rs` and no test window is opened until the owner has been
  told.

### 22.3 Web: what is drawn (`lib/background.ts`, `lib/look.ts`, `components/Backdrop.tsx`, `styles/glass.css`)

* `readNativeGlass(window)` trusts `__CF_GLASS__` only when `__CF_DESKTOP__ === true` and the value is one of
  `liquid`, `vibrancy`, `mica`, `acrylic`, `blur`; anything else is `none`. So a desktop app that sends a name this
  web bundle does not know yet (or the other way round, during a rollout) falls back to an ordinary page.
  `resolveLook` turns mode + picture + colours + strength + glass + light/dark into one of: `window`, `frosted`,
  `picture`, `brand`, `colours`.
* `applyLook` (run in `main.tsx` before the first paint, then by `Backdrop` on every change) sets
  `html[data-backdrop]`, `html[data-glass]`, `html[data-strength]`, the `--backdrop-veil`, `--panel-veil`,
  `--plate-veil`, `--glass-brightness` and `--light-pay` custom properties and, for `window` only, `html.see-through`,
  which makes `html` and `body` transparent so the native glass shows. **The window look** below means
  `html.see-through`.
* **What shows through, and the glass's own dimming (owner, 2026-11-23: "make sure everything is more see through
  in a liquid glassy style").** What a pane shows of what is behind it is `(1 − page veil)(1 − green)(b)`
  (`showThrough`): its green is its veil plus the look's pay, and `b` is the `brightness()` its own `backdrop-filter`
  ends with (`blur(24px) saturate(1.6) brightness(var(--glass-brightness))`; the refracting ones
  `blur(var(--glass-refract-blur)) url(#cf-refract) saturate(1.75) brightness(…)`, 18 px; over a photo 18 px and
  14 px, as before, so its shapes still read). A black and white edge behind a pane reads exactly that much through
  it (Chromium, 23 Nov: 0.584 behind 0.20 green at `brightness(0.73)`, 0.671 behind main's 0.33). **Dimming is not
  free see-through:** it takes away as much as it lets the green give back, so 0.20 at 0.73 showed less of the app's
  backdrop than main's 0.33 with no dimming. It pays only where the green itself is much of what the words have to
  beat (a white photo, light colours). So each look takes the pair that shows the most (`bestGlass`: for every
  `brightness()` from 1 down to `MIN_GLASS_BRIGHTNESS` 0.5, the least veil that keeps AA and the ladder's first rung
  over the backdrop as the pane sees it, `veilOver`, with the look's pay on top), and `b` = 1 where dimming gains
  nothing. `dimRgb` is the sRGB `brightness()` Chromium and WebKit draw (each channel × b; Clips Funded models it the
  same way). The app's own backdrop: 0.20 at 0.87 (70 %; main 67 %); a photo: 0.29 + 0.10 at 0.5 (30.5 %; main 22 %);
  the owner's colours: 1 for dark mixes (the default trio 0.20 + 0.05, 75 %; main 65 %) down to 0.5 for light ones
  (cream 33 %, white 30.5 %; main 25 % and 23 %). A pane dimmed to b pays up to 0.05 / b (`mostPay`, §22.7), so the
  pay takes 0.05 of what shows through it at most, as on an undimmed pane. The window look draws none (`--glass-brightness: 1`): the native glass
  is behind the page, where no web filter reaches. Layers planned for white as it is (toasts, the setup pill, rail and
  list, the Ask launcher and panel, the money dock, the overlays, the update bar and the tab bar) set
  `--glass-brightness: 1` on themselves, so they keep main's see-through. **Plates** (the title and line plates,
  `--glass-tint-plate`) and **controls straight on the page** (the track recipe, `--light-raise-veil` at `:root`)
  draw no filter of their own, so they carry the plate veil (`--plate-veil`), what the backdrop needs as it is:
  main's 0.33 over the app's backdrop, 0.73 over a white photo. The refraction budget (at most three bending
  surfaces a screen), reduced transparency and the WebView2 budget are unchanged: no new filtered surface, nothing
  transitions `backdrop-filter` or `filter`.
* **The tint (contrast).** Bottle green whose strength is computed, not guessed: `minVeil` is the smallest alpha at
  which every text colour that can sit on it reaches 4.5:1 against the green composited (sRGB, as browsers do) over
  the **lightest** thing behind it. Every text colour is light (bone or lighter, ADR-43), so a white desktop or a
  white photo is the hardest case; a dark backdrop only helps.
* **What Liquid Glass really draws (measured; kept as a record).** On 2026-11-16, on macOS 27.2 (system in dark mode,
  the window forced to the light theme, Tauri 2.12.5 / window-vibrancy 0.8.1, `LiquidGlassRegular` with the light
  `GLASS_TINT` of that time, page
  transparent), a helper window put a known picture straight behind the real window and the screen was captured:

  | The window is | Glass over pure black | Glass over pure white | A panel at 0.86 over black |
  |---|---|---|---|
  | in use (active) | rgb(180, 171, 148) | rgb(249, 248, 245) | rgb(240, 236, 227) |
  | showing, another app in use (inactive) | rgb(118, 118, 118) | rgb(225, 225, 225) | rgb(230, 229, 225) |

  * With no page loaded the glass in use is the same khaki over black, so that colour is the system's glass, not
    the page. In use, the tint is honoured: the glass behaves like the tint colour at roughly 62–73% over the blurred
    picture. Not in use, the tint is dropped for a neutral light grey at roughly 58%.
  * The glass blurs strongly: 22 pt black and white stripes come through as soft bands, 75 pt bold text is still
    guessable, normal text cannot be read.
  * **To re-measure.** The "in use" row was taken with the old light tint. The window now carries the bottle-green
    `GLASS_TINT` (15/55/43 at 140/255, `desktop/src-tauri/src/main.rs`), so the real glass in use over black will be
    darker and greener than rgb(180, 171, 148). Readability does not depend on it (the page plans for white, which a
    tint can only darken), but `LIQUID_MEASURED.active` and the stand-in in `web/e2e/glass.ts` describe a tint that
    is gone until the owner measures it again on a Mac. Nothing here opens a window to do so.
  * Panels composite as `mix(VEIL, glass, veil)`, within about ±3 levels of what was measured, so the maths below
    describes the real window.
  * **Not measured:** Liquid Glass without the tint, `LiquidGlassClear`, the vibrancy material of macOS 15 and
    older, and every Windows material. Those keep careful assumptions (below) until someone measures them
    ([TESTING.md](TESTING.md#background-modes-and-see-through-glass) says how). Also not measured: whether a
    panel's own `backdrop-filter` (blur, saturation) reaches the glass behind the page. Over the flat black and white
    that were measured it changes nothing, and the darkest glass is a flat grey either way.
  * **Also not measured: the system's own settings, and the green tint.** Every number above was read with the
    system in dark mode and the light tint. With bone text none of them decides the tint any more: the page plans
    for white behind every glass (`glassCeiling`), which no tint or setting can exceed, so no new measurement is
    needed for readability.
* **The lightest each glass can be** (`glassCeiling(glass, scheme)`) is **white** for every glass and both
  settings: it decides the panel tint. **The darkest** (`glassFloor`) is still checked, so words on bone fills are
  covered at both ends: `liquid` light rgb(106.2, 106.2, 106.2) (`LIQUID_FLOOR`, the darkest measured made a tenth
  darker), `blur` light the app's green tint over black (`TINTED_FLOOR`, from the same numbers as `GLASS_TINT`), and
  black for the rest and for dark. `glassChecks(glass, scheme)` lists everything text is checked against: white, the
  floor and, for `liquid` in light, every measured point.
* **Text colours** (`TEXT_TOKENS`; `WINDOW_TEXT_TOKENS` is the same set since ADR-45). One set in every look, all
  bone or lighter (relative luminance 0.806 or more), so the panels need the least green; hierarchy comes from size,
  weight and tracking, not from dimmer colour. A soft green `text-shadow` halo sits behind words on glass, page
  titles, breadcrumbs and the brand name for comfort; it is **never** counted toward AA.

  | Token | Value | What it is for |
  |---|---|---|
  | `--ink` | `#efe7da` | Body text, headings, icons (bone) |
  | `--ink-2` | `#efe7da` | Secondary text |
  | `--ink-3` | `#efe7da` | Meta text, placeholders |
  | `--vermilion-ink` | `#ffe2dc` | Error and warning words, always with a vermilion icon or dot |
  | `--green-ink` | `#e4f2da` | Success words and icons: saved, ready, passed |
  | `--green-text` | `#e4f2da` | Words on the success tint |

  Words on a bone fill use `--on-bone` (`#0f372b`, 10.68:1 on bone); words on a vermilion fill are white. A unit test
  reads the stylesheets: `tokens.css` holds exactly these values, and **every** `color:` declaration is one of the six
  tokens or a named exception that sits on a fill of its own (white on the CTA, `--on-bone` on bone, the blue of the
  Get the app drawings on their bone card, the warn pill, glyph blinks).
* **Tints in the window look** (`seeThroughVeils(glass, scheme, strength)`). The tint lives **on the panels and on
  loose text**, not over the whole window, so the desktop stays guessable between them. Two values go on `<html>`:
  `--backdrop-veil` over the whole window and `--panel-veil` on every panel.
  * **Clear:** nothing between the panels (0). A panel carries the least green that keeps every text colour of the
    window look at AA over white: **0.73** (never less than `PANEL_VEIL_FLOOR`, 0.20). Lowest text contrast 4.61:1
    over white, 6.53 over the measured khaki, 12.77 over black.
  * **Frosted:** a green frost over the whole window (0.30) and panels the least green that keeps AA over the frost
    on white and still shows a little less than a Clear panel, (1 − frost)(1 − panel) < 1 − clear: **0.62** (AA over
    the frost needs 0.61, showing less than Clear's 0.73 needs more than 0.614; it was 0.88, Clear + 0.15), 4.67:1 over
    white, 6.58 over the measured khaki, 12.74 over black. So Frosted still always shows less than Clear (with the pay
    a panel shows 23 % of a white desktop, 33 % of what is under its frost, where main's 0.88 showed 8 % and 12 %).
  * **The window look pays for the light** (`lightPay` over every spot a desktop can show, §22.7; `LIGHT_PAY_WHITE`
    0.05 in Clear and Frosted): over a white desktop a pane at the AA floor leaves the levels above it no room to read
    brighter (with no pay a row read +0.000 L over its pane), so the pay lowers it a step: Clear 0.73 + 0.05 as on
    main, Frosted 0.62 + 0.05. Clips Funded's See-through Clear keeps main's veils for the same reason.
  * **Plates carry their words' light** (`windowPlateVeil`, `PLATE_WORDS_LIGHT`). A pane's words start below its top
    light; a line plate's start about 6 px down (8 px of padding, less a display face's tall glyph box: the phone
    top-bar name, This week's title), where half the plate's top light and a quarter of its catch light still lie
    (0.035 of bone). In the window look the pay covers it: the plates carry the panels' 0.73 + 0.05 (Clear, 5.39:1 over
    white with that light) and 0.62 + 0.05 (Frosted, 5.21:1). Two small panes have their words in their top light too,
    so in every look they carry the plate's tint, under their own dimming where the look dims: the phone top bar's
    Live chip (beside the brand's plate, words about 6 px down) and the "All set!" card in a phone's pill strip (8 px
    above its words, to stay inside the bar). Over the app's own backdrop they keep 5.02:1 there, over the owner's
    colours 4.73 (the plate takes a step or two more green over a dark mix at the floor for it). Settings › Posting ›
    Money's first panel (`.money-top`, which holds no apple rows) has the apples' 18 px of room above and below its
    words, so its words start below its light as every pane's do.
* **What carries the tint** (`styles/glass.css`):
  * Every `.glass` panel (`.glass--green`, the lead panel: the same green under a stronger light, a whole step brighter,
    §22.7). The window
    rule is written with `:where(html.see-through)`, so a surface with a **denser tint of its own** keeps it (toasts,
    sheets, the Ask panel, the update bar, the starred star's vermilion), and the lead panel keeps its step.
  * **Nothing that holds words is weaker than the panel tint.** What can sit straight on the window carries at least
    that much: the tab bar, glass, ghost and danger buttons (also on hover), the Library tabs.
  * Every piece of text that sits straight on the window **or the picture** gets an E1 plate (the panel tint with its
    light from above and its soft shadow, §22.7) of real padding (8 px above and below; at the sides the words keep their `--loose-x` start, so the plate starts at the
    page edge like a panel and never hugs or cuts a letter): page title and its line, breadcrumbs, the phone top-bar name,
    the headings and lines between panels, back links, the review count, setup part titles, a clip page's title and
    "Updated" line, This week's title, its star line and its count and money line, a skill's meta line.
  * Pick-one tracks (`.segmented`, `.tabs`, the Background tiles, the AI models) are a raised groove: straight on the
    page they carry 0.22 more green than a plate (`TRACK_EXTRA_VEIL` over `--plate-veil`: a track draws no filter, so
    nothing dims under it) with a lift of bone (0.08, `TRACK_LIFT`), in every look (4.84:1 or better); inside a lit surface they take the relative raise (§22.7). Their options (and the
    stepper's buttons and the workspace switch's names) take the relative raise over their own track: glass.css names
    them (`.segmented > *` and the rest, never the track, whose own fill keeps what it sits on), so an option's hover
    is a step of light over its track, on the page too (4.80:1 or better). The selected pill is bone 0.92
    (`--selected`) with `--on-bone` words, 9.30:1 or better.
  * **The ladder (§22.7).** A fill under words is one step **brighter** than what it sits on, a lift of bone paid for
    with a step more green (`--fill`, `--fill-hover`, `--fill-press`, `--fill-ghost`); the success, vermilion and
    amber tints lay bottle green 0.35 (`CHIP_UNDER`, `CHIP_DEEPEN`) and a lift of bone (0.04, 0.13, 0.02,
    `CHIP_TINTS`) under their colour (`--tint-leaf`, `--tint-vermilion`, `--tint-amber`), so a chip is a step over its
    row. Only true wells sit one step below: text fields and the link box (`--fill-field`), progress tracks and drop
    targets (`--fill-sunk`).
  * **No edges anywhere (owner, 2026-11-18; ADR-45).** No border, outline, lit rim, inset highlight line, hairline
    divider or ring is drawn on any box, chip, dot, avatar, input, sheet, bar or toast. A control reads as a control
    by its fill: buttons without a fill of their own (glass, ghost: Skip, Not now, Back) wear the raise (`--fill`,
    `--fill-control`; straight on the page the track recipe, bone 0.08 over green `--plate-veil` + 0.22, 4.84:1 or
    better; inside a surface the relative raise, §22.7), the danger button a vermilion tint (0.14) over the same
    fill (its green and its bone lift, so it is a step of light over its pane too), fields and the link box a deeper well (`--fill-field`, deep green 0.45) with a
    blurred inner shade; a chosen, live, best, copied or done thing gets a soft glow (`--glow-*`, 18 px blur) or a
    tint, never a ring; rows are told apart by spacing and their light. The light of §22.7 is no edge: every layer
    of it is blurred more than 2 px (a top glow, a bottom shade, a drop), never an `inset 0 1px 0` hairline. Allowed, because they are not static box edges: the focus
    ring while `:focus-visible`, the temporary found highlight and Ask's spotlight, progress bars and rings, the
    switch track, spinners and the running step's pulse, the short action blinks, and text underlines.
  * Vermilion dots and bars sit beside words that carry their meaning (a count, "Live", a percentage); they no
    longer carry a bone ring.
  * The unit tests work these numbers through the same contrast maths for every glass and read them back out of
    `glass.css` and `tokens.css`.
* **Worst spot.** Over a backdrop the page draws itself, the worst spot is **the lightest of every corner of the
  mesh**: every subset of the blobs at their peaks (not only all of them stacked: `saturate()` lifts a green-only
  subset more than a stack with vermilion in it) over both field ends, seen bare (the scrims have no filter) and
  through every `saturate()` the CSS uses (`SATURATIONS`: 1, 1.4, 1.6, 1.75; the largest is `GLASS_SATURATE_MAX`).
  Luminance is convex in each blob's alpha, so the drifting mesh is never lighter than a corner. The veil is the
  largest `minVeil` over all corners (`minVeilOver`), because green is mixed in sRGB and a slightly darker corner of
  another hue can need a little more.
* **Per-surface tints** (`lib/background.ts`; the worst text contrast is over the worst spot, or over white for what
  content scrolls under):

  | Surface | Tint | Light (bone, top → base, §22.7) | Worst text contrast (at the top) |
  |---|---|---|---|
  | `.glass` panels, the sidebar, `.glass--clear` | `--panel-veil` + `--light-pay` (§22.7) over the backdrop as the pane's own `brightness()` dims it: 0.20 + 0 over the app's backdrop, Clear and Frosted (`BRAND_PANEL_VEIL`, dimmed by 0.87; `LIGHT_PAY_OWN` 0); 0.29 + 0.10 over a white photo (dimmed by 0.5; `mostPay`, 0.05 / 0.5); 0.73 + 0.05 over a white desktop in the window's Clear and 0.62 + 0.05 in its Frosted (no web filter dims it); in Colours 0.20 to 0.29 + 0 to 0.10 (`MAX_LIGHT_PAY` / b, `mostPay`) at `brightness()` 1 to 0.5, never 0.82 or more | 0.04 at the top edge → 0 at 14 px, inside the top padding (`PANEL_LIGHT`), plus the catch light (`SPECULAR`) | 4.67 over the app's backdrop at its very brightest corner; 5.39 over white (window Clear), 5.21 (Frosted); 5.14 over a white photo; 4.75 in Colours |
  | The loose-text plates (every look: `html:is(.see-through, [data-backdrop])`; `--glass-tint-plate`, no filter of their own) | `--plate-veil` + `--light-pay`, at most 0.05 of it (`platePay`: no filter, so the backdrop shows at its full light under a plate): 0.33 over the app's backdrop (`BRAND_PLATE_VEIL`, main's), 0.73 over a white photo (`PICTURE_PLATE_VEIL`), the panels' 0.73 and 0.62 in the window's Clear and Frosted (`windowPlateVeil`: the pay covers the light under a plate's words), 0.24 to 0.73 in Colours | as a panel | 4.52 over the app's backdrop (as on main); 5.39 over a white photo; 4.77 in Colours |
  | `.glass--green` (the lead panel: hero, sign-in, learnings) | the panel's (`LEAD_EXTRA_VEIL` 0) | 0.075 at the top edge → 0 at 14 px (`LEAD_LIGHT`) | as the panel where its words are |
  | Nested `.glass`, rows, cards and controls inside a surface | the relative raise: green 0.34 over the parent (`RAISE_VEIL`) | flat 0.13 (`RAISE_LIFT`); hover 0.37 / 0.145 | 4.64 on hover at the brightest corner of the app's backdrop, 4.95 over a white desktop (4.63 in Colours) |
  | Pick-one tracks and every control straight on the page (`--fill` at `:root`, such as the Library tabs) | plate veil + 0.22 (`TRACK_EXTRA_VEIL`; no filter, so nothing dims under it) | flat 0.08 (`TRACK_LIFT`); hover 0.09 | 4.98 on hover (4.80 in Colours); an option's hover over it 4.71 |
  | Fields (`--fill-field`) | deep green 0.45 over the panel: a well, one step below | none | 7.53 |
  | Floating layers: toasts, the setup pill, list and sheet, the Ask launcher, the Ask panel and phone sheet (`--glass-tint-float`) | `max(FLOAT_VEIL 0.73, --panel-veil)` + 0.02 (`FLOAT_EXTRA_VEIL`, the least the AA cap over a white thumbnail needs: at main's 0.73 the setup pill's word read 4.49:1 in WebKit and a chip on the Ask sheet 4.48:1 in Chromium, measured at their own line boxes in e2e/contrast.spec.ts), blur 28 px | 0.08 at the top edge → 0 at 14 px (`FLOAT_LIGHT`); hover 0.09 there plus a flat 0.01 (`FLOAT_HOVER_LIFT`) | 4.91 over white; hover 4.81 |
  | The update bar | `max(FLOAT_VEIL + 0.22, --panel-veil)` = 0.95 in every look, Frosted included (`UPDATE_EXTRA_VEIL`, the one float that darkens more: over a white thumbnail the AA cap leaves Reload no room for +0.08 over Later otherwise) | as a float | Later 7.15, Reload 4.93 (hover 4.59) over white |
  | Reload on the update bar (`.btn--lens`) | none: clear glass, white light alone | white 0.18 where its words are (0.24 at its top edge); hover 0.205 | 4.93; hover 4.59 (over white) |
  | The tab bar (icons only, `--glass-tint-tabbar`) | `TABBAR_VEIL` 0.59 + 0.04, blur 28 px | 0.04 → 0.01 at 65 % | 3.22:1 over white; the chosen icon on bone 9.88 |
  | The question sheet, the picture viewer (`--glass-tint-overlay`) | 0.86 (viewer 0.90), over its own scrim | 0.12 → 0.04 at 65 % (`OVERLAY_LIGHT`) | 6.44 (viewer 6.79) over white, on the lightest scrim |
  | The vermilion CTA | `--cta`, white label | unchanged | 4.65 over white, 4.86 over a panel |

  The CTA is the one solid saturated surface on the glass. Every bone light on a pane is paid for with more green
  (§22.7): a sheen with no pay (bone 0.06 over the worst panel) would be 4.18:1, under AA, so a pane's light lies in
  its top padding, never under its words. Over the app's own backdrop the pay is 0 (see-through first); the window
  look, Picture and the owner's colours pay, at most 0.05 of what shows through a pane (0.05 of green where nothing
  dims, 0.05 / b on a pane dimmed to b), to leave the levels above a pane room to climb under the AA cap.
* **Colours** (`coloursMeshSpots`, `coloursVeils`): the mesh as drawn: the field is the first colour (its gradient
  end 78 % first + 22 % third), the second colour a blob at 30 %, the third at 45 %, opacity 1; the corners are each
  field end with and without each blob, through every saturation. The glass takes the veil and dimming that show the
  most of the mesh with an undimmed surface's pay on top (`bestGlass`, `MAX_LIGHT_PAY`; a dimmed pane then pays
  0.05 / b, `mostPay`, which leaves the choice as it was): the panels carry what the dimmed corners need
  (`veilOver`, never under 0.20) and the page nothing, up to 0.60; past that the panels stay at 0.60 and the page
  takes the least that covers it (no mix needs it any more: white needs 0.29 at half the light). The plates carry what
  the corners need as they are, and what the Live chip's words in its top light need under its dimming. Page / panel /
  plate / dimming, and what a pane shows (main): the default trio 0 / 0.20 / 0.24 / 1, 75 % (0 / 0.30, 65 %); Ocean +
  Grape 0 / 0.20 / 0.25 / 0.97, 73 % (65 %); the old Sage trio 0 / 0.20 / 0.61 / 0.62, 45 % with its 0.08 pay
  (0.03 / 0.60); Sunny + Bubblegum 0 / 0.21 / 0.63 / 0.58, 41 % with 0.08 (0.08 / 0.60); Cream 0 / 0.24 / 0.71 / 0.5,
  33 % with 0.10 (0.28 / 0.60, 25 %); white 0 / 0.29 / 0.73 / 0.5, 30.5 % with 0.10 (0.33 / 0.60, 23 %). Dark mixes take no dimming at all. `applyLook` sets all four. The bone and deep-vermilion blobs are left out over the owner's colours. The Colours
  tile and strip wear the page veil (`--preview-veil`); when it is above 0 the card adds "Light colours show soft,
  so words stay easy to read." `coloursVeil` (deprecated) returns the combined green.
* **Picture:** no veil over the photo (`PICTURE_PAGE_VEIL` 0), so it shows at full strength between the panels;
  a pane dims a white photo to half (`PICTURE_BRIGHTNESS` 0.5, `bestGlass`) and carries 0.29 over it
  (`PICTURE_PANEL_VEIL`, it was 0.73) and the pay (0.10: 0.05 / 0.5, `mostPay`), 5.14:1 at its brightest, so it
  shows 30.5 % of the photo (22 % on main); the loose-text plates carry 0.73 (`PICTURE_PLATE_VEIL`, `minVeil(white)`)
  and 0.05 of the pay (`platePay`), with nothing dimmed under them (22 %, as on main). The blur stays main's (18 px, 14 px where it bends).
* **The living backdrop** (`brand` and `frosted`, `BRAND_MESH`): the page owns it. A field from `#0f3d31` to
  `#08221b`; blobs (blur 56 px, opacity 1, drifting 24–28 s): deep teal `rgb(22 89 77 / 0.9)`, vermilion 0.62, leaf
  0.30, bone 0.06 and a deep vermilion `rgb(196 42 30 / 0.55)`; two soft lenses (70 and 46 vmax, a blurred bone glow
  of at most 0.08, never a drawn line, drifting 36 and 44 s). No page veil. Worst corner after saturate 1.75:
  rgb(255, 65, 40); bare bone on it is under AA, which is why loose words get the plate. A pane dims it a little,
  `brightness(0.87)` (`BRAND_BRIGHTNESS`, `bestGlass`: at 0.88 it would need 0.21), and carries 0.20 green
  (`BRAND_PANEL_VEIL`, the floor; it was 0.33), 4.67:1 at the brightest corner, so 70 % of the backdrop shows through
  (main's 0.33 with no dimming showed 67 %, the most a veil alone can there; 0.20 at 0.73 showed 58 %). Through a panel
  the lightest and darkest spots stay 2.89:1 apart at 1.6 and 2.81 at 1.75 (2.79 and 2.63 at main's 0.33), so the
  see-through has more range than before.
* `prefers-reduced-transparency: reduce` raises the veil to 0.94 in every mode, and panels, plates, the tab bar and
  the floating layers to 0.92; the pay is 0.04 and nothing blurs, bends or dims (`backdrop-filter: none` on `.glass` and the
  refracting surfaces; the title plates draw no filter in any look). The light, the top glow, the shade and the
  shadow stay, so the top is still brighter and the ladder holds.
* **Panels in the window look.** `.glass` keeps the recipe (blur, saturation, the light from above, shadow,
  refraction in Chromium; `brightness(1)`, nothing to dim); its tint is `--panel-veil`, the AA floor over a white
  desktop, plus the look's pay (`LIGHT_PAY_WHITE` 0.05 in Clear and Frosted, §22.7).
* **Frosted fallback** (see-through in a browser, installed PWA, phone, or the desktop app with `none`): the living
  backdrop above (already blurred), a frost pane (Clear: none; Frosted,
  `html[data-strength="frosted"]`: green 0.40 → deep green 0.45, so Glass strength always does something; no full-screen
  `backdrop-filter`, so phones do not repaint it every frame) and two soft caustic highlights drifting over 26 s and
  34 s (bone, soft-light, peak 0.06). Reduced motion stops them like every other loop.
* **Colours mesh:** a 160° gradient through the colours plus the drifting blobs in `--c1..--c3` (one or two colours
  repeat the last), then the veil.

### 22.4 Why phones and browsers cannot see through

**How much of what is behind a pane shows through** (`showThrough`: `(1 − page veil)(1 − green)(b)`, the green
being the pane's veil and the look's pay, `b` its own `brightness()`; a black and white edge behind a pane reads
exactly this much through it in Chromium; the pane's light from above is the same in every look and left out).
See-through first (coordinator 2026-11-23: the light ladder may not be paid for by darkening panes; a light look may
add at most 0.05 and never reach 0.82; a pane its own glass dims to b takes 0.05 / b of green, which costs it the
same 0.05 of what shows through, `mostPay`). Owner, 2026-11-23: "make sure everything is more see through in a liquid
glassy style". The first pass of this work (ccc3cb1c) counted only `1 − green`: it dimmed every pane and lowered the
green, and the dimming took away more than the thinner green gave back over the app's own backdrop, a photo, the
light colours and the floating layers. Each look now takes the pair that shows the most (§22.3, `bestGlass`), and
test/background.test.ts holds every row at or above main.

| Look | main (6e737671) | first pass (ccc3cb1c), as drawn | **now** | the pane's glass now |
|---|---|---|---|---|
| The app's own backdrop, Clear and Frosted, browser and phone (panels) | 67 % (0.33) | 58 % (0.20 at 0.73) | **70 %** (0.20 at 0.87) | `brightness(0.87)`; 4.67:1 at the brightest corner (the most AA allows there: a veil alone tops out at main's 67 %) |
| The title and line plates over the app's backdrop (no filter of their own) | 67 % (0.33) | 67 % | 67 % (0.33, unchanged) | none; 4.52:1 as on main |
| Window Clear (liquid, every glass), panels and plates, over a white desktop | 22 % (0.73 + 0.05) | 27 % (0.73 + 0), the ladder flat | 22 % (0.73 + 0.05, unchanged) | `brightness(1)`: the desktop cannot be dimmed; the AA floor (0.72 gives 4.47:1) and the ladder's pay leave no room |
| Window Frosted (0.30 frost over the whole window), panels and plates | 8 % (0.88) | 27 % (0.62 + 0), the ladder flat | **23 %** (0.62 + 0.05) | `brightness(1)`; 5.21:1 over the frost on white |
| Picture (white or busy photo), panels | 22 % (0.73 + 0.05) | 18 % (0.59 + 0.05 at 0.5) | **30.5 %** (0.29 + 0.10 at 0.5) | `brightness(0.5)`; 5.14:1 over a white photo; blur 18 px as on main |
| Picture, the plates | 22 % (0.73 + 0.05) | 22 % | 22 % (unchanged) | none |
| Colours, default trio | 65 % (0.30 + 0.05) | 75 % | **75 %** (0.20 + 0.05) | `brightness(1)`: dimming gains nothing over dark colours |
| Colours, Ocean + Grape | 65 % (0.30 + 0.05) | 71 % (0.20 + 0.05 at 0.94) | **73 %** (0.20 + 0.05 at 0.97) | `brightness(0.97)` |
| Colours, Cream (`#f7f5ef`) | 25 % (0.65 on a 0.28 page veil) | 19 % (0.62 at 0.5) | **33 %** (0.24 + 0.10 at 0.5), no page veil | `brightness(0.5)` |
| Colours, white | 23 % (0.65 on a 0.33 page veil) | 18 % (0.64 at 0.5) | **30.5 %** (0.29 + 0.10 at 0.5), no page veil | `brightness(0.5)` |
| Floating layers (toasts, setup pill and rail, Ask launcher and panel, money dock) | 25 % (0.75) | 18 % brand, 13 % Picture (dimmed, tint unchanged) | 25 % (0.75, unchanged) | `brightness(1)` on themselves: they plan for a white thumbnail as it is |
| Floating layers in the window's Frosted | 7 % (0.90) | 18 % (0.75) | **18 %** (0.75: the larger of 0.73 and the 0.62 panel, + 0.02) | `brightness(1)` |
| The update bar | 5 % (0.95) | 4 % | 5 % (0.95, unchanged: `UPDATE_EXTRA_VEIL`, test/buttonLight.test.ts) | `brightness(1)` |
| The tab bar | 37 % (0.63) | 27 % brand (dimmed) | 37 % (0.63, unchanged; icons only, 3.22:1 over white) | `brightness(1)`; window Frosted 24 % (0.66), was 6 % |
| The overlays (the question sheet, the markup dialog, the TikTok sheet, the picture viewer) | 14 % (0.86) | dimmed | 14 % (unchanged) | `brightness(1)` |

The window numbers are the AA floors measured with the maths of this section over a white desktop (`glassCeiling`),
the lightest any glass can be: Clear 0.73 (4.61:1; 0.72 gives 4.47:1), Frosted 0.62 over its 0.30 frost (4.67:1;
0.61 also holds AA but would show as much as a Clear panel), each with the ladder's pay on top (0.05: with none a
row on a pane read +0.000 L over it, the logic of light flat). They stay at or above that floor in every glass,
setting and measured point (`glassChecks`; Clear 6.53:1 over the measured khaki, 12.77 over black). A plate's words
sit in its top light (0.035 of bone, `PLATE_WORDS_LIGHT`); the pay covers it (5.39:1 Clear, 5.21 Frosted). With no
pay, e2e/contrast.spec.ts found the phone top-bar name, This week's title and the Live chip at 4.32 to 4.40:1 over
white.


Web pages, installed PWAs and phone home-screen apps are drawn on an opaque surface; no browser lets a page see the
wallpaper or windows behind it, and iOS gives a home-screen app no way to either. On a phone "see-through" therefore
means this: every panel, the top bar, the setup pill, the tab bar and sheets are glass over a living backdrop the
app draws itself (bottle green, deep teal, leaf, two vermilion glows, faint bone light and two soft lenses, drifting
slowly), which shows through 70 % of every panel (each pane dims it a little first) and fully between them. Only the desktop app owns its window. The Background page says so in one sentence
under the choice whenever see-through is picked and there is no native glass:

> See-through works in the Mac and Windows app. Browsers don't let apps look behind them, so here you get the Clip
> Factory colours. **Get the app** (→ `/get-app`)

The **Get the app** link shows only on a Mac or Windows computer (`lib/device.ts`), where the app can do
see-through. On a phone (iPhone, iPad, Android), where getting the app gives a home-screen app that still cannot,
the sentence is "See-through works in the Mac and Windows app on a computer. Phones don't let apps look behind
them, so here you get the Clip Factory colours." with no link. Other computers (Linux, Chromebook) get the browser
sentence without the link.

In the desktop app without glass (Linux, old Windows): "This computer can't show see-through, so here you get the
Clip Factory colours." (no link).

In a desktop app too old to say what glass it has (built before 2026-11-16 16:54, no `__CF_GLASS__`): "Update the
app to see through." and a big vermilion **Update the app** button that downloads the new app (§12.6).

### 22.5 Settings › Look & feel › Background (web, `screens/settings/branches.tsx`)

Branch line: "See-through glass, your picture or your colours." Apples (`lib/settingsTree.ts`, each a `data-help`
anchor for Ask Clip Factory):

| Apple id | Name | Leaf | Control |
|---|---|---|---|
| `background-kind` | What's behind the glass | Pick See-through, Picture or Colours. | A radio group of three preview tiles with one `<Glide>` (`.bg-modes`, `glide--tile`): a blurred car behind frost, your picture (or the picture icon), your colours. The note of §22.4 under it. |
| `glass-strength` | Glass strength | Clear shows more of what's behind. Frosted shows less. | `Segmented` Clear / Frosted. Choosing one also picks See-through. In the desktop app it sets the window frost and panel tint; elsewhere it thickens the frost over the Clip Factory colours. |
| `background-picture` | Background picture | Use your own picture behind the glass. It stays on this device. | Choose / Change picture (`upload`), Remove picture (`undo`, rewinds on Undo). A picked picture also picks Picture. |
| `background-colours` | Background colours | Mix up to 3 colours behind the glass. | A preview strip, twelve named swatches (Bottle green, Bone, Vermilion, Green, Cream, Sunny, Mint, Sky, Ocean, Grape, Bubblegum, Night; `aria-pressed`; Green and Cream stay so a colour picked before ADR-43 keeps its name) and "Your own colour" (`input type=color`, saved on `change` only). Tapping a colour adds or removes it and picks Colours. A fourth: "You can mix 3 colours. Tap one of yours to take it off first." The last one: "Keep at least one colour. Pick another one first." |

The apple whose mode is in use shows an "In use" pill. The three tile names stay on one line at every width
(`white-space: nowrap`, a slightly smaller size on narrow phones), so "See-through" never splits at its hyphen. Every control is reachable by keyboard; the cursor never
changes (§20.14); hover lights up the tiles and swatches.

### 22.6 Tests

* Vitest `test/background.test.ts`: contrast maths against WCAG reference values; `minVeil` is minimal and reaches AA
  (0.73 over white for the one text set); the ceiling is white for every glass; the measured
  Liquid Glass numbers stay on record; `TINTED_FLOOR` is the app's green tint over black and equals `GLASS_TINT` in
  `main.rs`; one text set, all bone or lighter, and no `html.see-through` text block; Clear is the least that reaches
  AA over white, never under 0.20, and the window draws no dimming; **the glass's own dimming**: `dimRgb` is the sRGB
  `brightness()` browsers draw (each channel × b) and `showThrough` is `(1 − page)(1 − green)(b)` (0.584 for 0.20 at
  0.73, the Chromium measurement), every `brightness()` in a `backdrop-filter` is `var(--glass-brightness)` and comes
  last, the CSS starts at the app's own backdrop's numbers, each look's pair is `bestGlass`'s (no other dimming, every
  0.01, shows more with the veil it needs), the floating layers, overlays and the tab bar set `--glass-brightness: 1`,
  and **what shows through a pane is at least main's in every look** (the §22.4 rows, main's numbers written in);
  **the living backdrop**: glass.css draws exactly `BRAND_MESH` (field, five blobs,
  opacity 1, lens glow, caustic peak), Backdrop.tsx draws blob e in both meshes, no green page veil and no Clear frost,
  every blob subset × field end is enumerated independently and a subset beats the full stack, `BRAND_PANEL_VEIL` is
  0.20 over every corner at every saturation as `brightness(0.87)` dims it (undimmed it would fail) and
  `BRAND_PLATE_VEIL` 0.33 over every corner as it is, the bare worst spot is under AA, the see-through range is at
  least 2.8:1 and more than at main's 0.33, every `backdrop-filter` `saturate()` is in `SATURATIONS` and at most `GLASS_SATURATE_MAX`, a bone
  sheen with no pay still fails AA, nested glass carries the relative raise and no blur of its own, loose words get
  an E1 plate (the plate veil, no filter) in every look and glass.css draws no button; **floating layers** resolve (their `var(--glass-tint-*)`
  tokens worked out) to at least `FLOAT_VEIL` with a 28 px blur, the sheet to 0.86, the tab bar to `TABBAR_VEIL`;
  **the logic of light** (§22.7): tokens.css and glass.css carry exactly the `--light-*` numbers of
  lib/background.ts, every tint and light runs at 180° or is flat, words reach AA at the top of every level and state
  (E1, the lead, the plates, E2–E4 on each, hover, press, quiet, the page control, an option over its own track,
  chips, floats and the levels on them, the sheet, the viewer, the menu and the list) over every brand corner, every glass, a white photo,
  all 1,464 swatch mixes and reduced transparency, each with its look's own pay (`lightPay`), the selected pill and
  the tab bar too, AA holds at any depth (the raise's fixed point), **the ladder** holds with no tolerance (from a
  pane up each of the first two levels, their quiet fills, the lead panel and a chip on a row climbs at least +0.015
  OKLab L; nothing steps back; every hover adds light, an option's over its own track too), each look's pay is the
  least that does it (0.01 less breaks it), and nothing transitions `backdrop-filter` or `filter`;
  **colours**: blob strengths read from glass.css, the page / panel / plate / dimming table, and 44,000+ mixes of 1–3
  colours from a 6-level grid all reach AA over every corner (panes dimmed, plates and page controls as they are)
  with panels at most 0.60 and the dimming between 0.5 and 1; **no edges**: no stylesheet draws a border,
  outline, ring or hard line (a box-shadow layer with 2 px blur or less) outside the allowed selectors and outside
  `@media (forced-colors: active)` (where the system draws its own edges), the shared shadows, glows and every
  `--light-rim-*`, `--light-shade-*` and `--light-shadow-*` are soft, and `.glass` has no `::before` rim; Frosted is 0.30 plus panels the least that keeps AA over it and always shows
  less; **every glass × light
  and dark × Clear and Frosted × (white, the floor, and for Liquid Glass every measured point): every text colour of
  the window look reaches AA on a panel, on a pick-one track and on the vermilion and success tints, and the green
  words on the selected bone pill reach AA**; the picture look over a white photo (panes dimmed to half, plates as it
  is); the stylesheets stay in step
  (`tokens.css` values, `html.see-through` overrides, every `color:` declaration is a token or a named exception, the
  sound groups' colours, the panel rule gives way to denser tints and the tab bar is lifted, every surface tint is
  green); colours validation and veils; `resolveLook` for every mode and glass; only the wrapper can claim glass, an
  unknown name is `none`, and every name `main.rs` can send is known; the notes' exact sentences (computer, phone and
an old desktop app, told apart from a real `none` by a missing `__CF_GLASS__`, §12.6);
  prefs defaults and junk; an existing picture with no saved mode starts in Picture; `applyLook` on `<html>`.
* pytest `api/tests/test_settings_and_system.py`: defaults (no `backgroundMode` until saved), saving (lower case,
  repeats dropped), every refusal and its message, malformed stored values.
* Playwright `e2e/glass.ts`: the stand-ins for the real window glass, shared by the specs below. `asDesktop(page,
  glass, strength?, version?)` simulates the wrapper (`addInitScript` setting `__CF_DESKTOP__` / `__CF_GLASS__`, and
  `__CF_DESKTOP_VERSION__` "1.42.0" unless `version` is null, a copy from before the updater);
  `paintGlass` paints what is behind the transparent page: the measured floors rgb(118, 118, 118) and
  rgb(180, 171, 148), the floor each glass is planned for, white, and a busy picture (sky, sun, cloud, red car,
  black garage, grass) blurred and mapped to the measured range for a window in use and not in use.
* Playwright `e2e/contrast.spec.ts`: **the window look is held to the same bar as every other look.** For `liquid`,
  `vibrancy` (it stands for `acrylic` and `mica`: the same numbers) and `blur`, on every app route plus This week
  and the skill pages, at 320, 375 and 1440 px, each stand-in is painted and the same axe and rendered-contrast scan
  runs (4.5:1, 3:1 for large text, nothing under 12 px). A second test per glass covers what an address cannot
  reach: Frosted, the sign-in card, a clip page and This week with a starred star, the Ask panel with an answer, a
  delete sheet, a toast.
* Playwright `e2e/background.spec.ts`: the default and the browser fallback note with its Get the app link; on a
  phone the phone sentence and no link; switching modes, the chosen colours on the backdrop, the fourth-colour
  refusal, your own colour, persistence over a reload; Picture without and with a picture; an existing picture
  survives the upgrade (and a reload); Glass strength picks see-through and changes the frost; Bone alone: the
  glass dims it, so there is no page veil, the previews show it as it is and no soft-colours line shows; search finds the new apples; a simulated
  `liquid` desktop has transparent `html` and `body`, no tint between panels for Clear, panels at the computed
  `--panel-veil` (under 0.5), the four deeper text colours on `<html>` and in drawn words, Frosted's frost and
  heavier panels, and the usual colours again once Colours is picked; `vibrancy`, `acrylic`, `mica` and `blur` keep
  working, each with its own tint; a dark setting assumes black; over the measured floors and the busy picture every
  word on the Background page is readable, Clear and Frosted, at 375 and 1440 px; no text straight on the window
  (`looseText` in `e2e/helpers.ts`: every surface under words is at least as strong as the look's panel tint) on
  every screen, This week, the skill pages and a clip page, for `liquid` and `vibrancy`, at 375 and 1440 px; `none`
  glass in the app, an old desktop app (no `__CF_GLASS__`: the update note, button and bar, §12.6), and a glass name
  the page does not know; no overflow, one-line tile names and AA text at 320,
  375, 768, 1440 and 1920 px, light and dark, in every mode.
* Playwright `e2e/edges.spec.ts`: on every route, This week, the skill pages, a clip page, Home with the Ask panel
  open and the Library with the setup list open, at 390 × 844 and 1440 × 900, no element or pseudo-element shows a
  border, outline or hard ring/line with any opacity, except the allowed ones; a control test draws one and checks
  the scan finds it.
* Playwright `e2e/light.spec.ts` (headless Chromium): Library and Home at 1440 × 900 and 390 × 844 in brand
  see-through, Frosted, Picture (a white picture), Colours and Colours (Cream). From screenshot pixels (4 × 4 px in
  the top padding, beside each child in its parent's padding) a post row is brighter than its card and its mark than
  the row, and the new-clip card than the hero, by at least +0.015 OKLab L in every look (no tolerance); over a flat
  backdrop a pane's top is brighter than its bottom. The Reload button paints no vermilion (fill, shine or glow), its
  words are `--ink`, and its top reads brighter than Later's. The screenshots are attached for review.
  `e2e/refract.spec.ts` also counts the refracting surfaces on every screen (Money included) at 1440 and 390: at most
  three, each blurring before it bends, and the title plates draw no filter. `e2e/contrast.spec.ts` measures the tab
  bar, the setup pill, the Ask launcher and panel over a white sheet from the pixels the browser draws (their green
  and their bone light from above).
* `e2e/screenshots.spec.ts`: the Background page, and the simulated see-through window on Home over the busy
  picture (window in use) and over the darkest measured floor, Clear and Frosted, at 390 and 1440 px:
  `see-through-{scene,floor}-{clear,frosted}-*.png` (the real glass can only be seen in a built app).
* desktop: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` (CI, Linux; the macOS
  path is compiled and tested on a Mac).

### 22.7 The logic of light (owner request, 2026-11-23, ADR-87)

The owner (with a screenshot of Library): "can you use the logic of light on the ui, meaning the top layer is always
brighter than the bottom, and it grows gradually in between ... and make it more liquid glassy while you are at it";
then: "can you make sure the reload button when a new feature is released is without color and only a liquid glassy
style". A refinement, not a redesign: Bottle Green, Bone, the vermilion CTAs, Times and Inter, the layout, the copy,
the cursor and the behaviour stay. Only the light changes: fills, lifts, the soft top light, the inner shade and the
shadows. `lib/background.ts` works out every number (`LADDER_*`, `LIGHT_PAY_*`, `PANEL_LIGHT`, `RAISE_*`, `GHOST_*`,
`FLOAT_*`, `UPDATE_EXTRA_VEIL`, `CHIP_TINTS` and the pure `lit`, `panelTop`, `panelWords`, `noRoom`, `raised`, `onPage`, `floatTop`, `chipOn`,
`ladderFaults`, `ladderPay`, `lightPay`, `oklabL`); `tokens.css` carries them as
`--light-*` and the per-level layers (`--glass-tint-*`, `--glass-light-*`, `--glass-shadow-*`); `glass.css`
re-declares the raise inside every lit surface. Brightness is OKLab L.

* **Two lights.** (a) From a pane up, every level is brighter than the level under it, nested levels too (the
  ladder, below). (b) Inside every pane the
  top is brighter than the bottom: a bone light from above that lies in the pane's top padding (full at the top edge,
  half at 6 px, gone 14 px down, so it is never under a word, a heading included), plus a static catch light at the top centre (`--glass-spec`, 8 px deep: the smallest top padding above
  words, on the line plates and compact rows, so it is never under them; 14 px was first drawn, but measured words
  start 8 to 12 px down on the plates, the setup steps, the job rows and the Content Rewards chips).
* **See-through first; every step is earned with light** (coordinator, 2026-11-23, after review of 7bb0fe0a, which
  reached the ladder by darkening every pane: 28 % of the backdrop showed through). Bone words cap whatever they sit on
  at luminance 0.140 (4.5:1, about OKLab L 0.52). Panes carry no pay over the app's own backdrop, Clear and Frosted
  (`LIGHT_PAY_OWN` 0: 0.20 over the mesh dimmed by 0.87). Floating layers plan for a white thumbnail, so they take only the least the AA cap over white
  needs (`FLOAT_EXTRA_VEIL` 0.02, 0.75: at main's 0.73 the setup pill's word read 4.49:1 in WebKit and a chip on the
  Ask sheet 4.48:1). The window look, Picture and Colours, where a light backdrop can be behind, pay at most 0.05 of
  what shows through a surface (`MAX_LIGHT_PAY`): 0.05 of green where the backdrop shows at its full light (the
  window look's panes, every plate: `platePay`, which `--glass-tint-plate` caps with `min()`), and 0.05 / b on a pane
  whose own glass dims it to b (`mostPay`, rounded down to 0.01: 0.10 at half the light). Green over a dimmed backdrop
  covers only b of its light, so 0.05 alone lowered such a pane only b as far under the AA cap: in Cream the new-clip
  card read +0.003 over the hero at its words and +0.014 in its top padding (e2e, Chromium on Linux, under the whole
  step); with 0.10 it reads +0.009 at its words (main +0.010). Never 0.82 or more in all (`SEE_THROUGH_LIMIT`):
  `lightPay` takes the least at which every level climbs a whole step with no exemption, on the panes (over the
  backdrop as their glass sees it) and on the plates (over it as it is) (`ladderPay(..., strict)`), capped there, so
  the window's Clear is 0.78 as on main (0.73 + `LIGHT_PAY_WHITE` 0.05) and its Frosted 0.67, Picture 0.39 on its panes
  (0.29 + 0.10, dimmed by 0.5) and 0.78 on its plates, the default Colours 0.25, Cream 0.34 on its panes (0.24 + 0.10)
  and 0.76 on its plates, with no page veil; 0.04 under reduced transparency. (With no pay
  in the window look a row read +0.000 L over its pane over a white desktop: the logic of light flat.) `lib/look.ts` sets `--light-pay` on `<html>`. The pane light lies in the top padding, so the words of
  every pane and float sit on its plain glass and keep main's AA (`WORDS_LIGHT` 0, `FLOAT_WORDS_LIGHT` 0).
* **Where the AA cap leaves no room** (`noRoom`, `LADDER_ROOM_L` 0.44, `LADDER_RED_A` 0.06 over `LADDER_RED_L` 0.38,
  `LADDER_ROOM` 0.12): a level that keeps AA at any depth has its fixed point at the cap (about L 0.515 over bottle
  green), so over a parent already at L 0.44 or more (or a vermilion-red one at L 0.38 or more, where green and bone
  mixed over red in sRGB lose L), or one that has not even 0.12 of bone room under AA, it keeps AA and may read at
  most 0.03 darker (`LADDER_SLACK`) instead of climbing a whole step. That is only: the brightest corners of the
  living backdrop (its teal and vermilion glows: over the vermilion corner `255 51 27` a row reads −0.029 under its
  pane at the height of its words, with its words at 5.50:1; 71 of the model's 256 brand placements read darker than
  their pane, by at most that: `veilOver`'s first rung, `rowRoom`, keeps it inside the slack), white under the
  window's Clear and Frosted at the 0.05 cap (row +0.016 and +0.012, mark +0.009 and +0.007), a white photo under
  Picture at its 0.10 cap (row +0.010, mark +0.006: with 30 % of the photo showing through, the cap leaves less room
  than main's +0.016 at 22 %; see-through first), Cream and white at 0.10 (row +0.009 and +0.010, mark +0.005 and
  +0.006), vivid vermilion meshes and a float over a white thumbnail (0). Everywhere else every level climbs +0.015 or more (over the brand field +0.124 then +0.067;
  the window over mid grey +0.060 then +0.034). Each raised thing's own base green (`RAISE_VEIL` 0.34 under `RAISE_LIFT` 0.13) is the
  least that keeps that fixed point at the cap: it is what lets the step be light over a dark parent and still keep
  AA over a bright one.
* **A raised thing is one relative step brighter than its parent, at any depth.** Inside any lit surface it lays green
  0.34 and bone 0.13 over whatever it sits on (`RAISE_VEIL`, `RAISE_LIFT`; hover 0.37 / 0.145); the step's fixed point is at the AA
  ceiling, so a resting stack keeps AA however deep things nest. Straight on the page it carries the pick-one track's
  recipe (plate veil + 0.22, bone 0.08: nothing dims the backdrop under it). One token works in both places: `:root` declares the page values of
  `--light-raise-*` and the fills built from them; every lit surface (`.glass`, the dropdown list, the workspace
  menu, the money dock, the TikTok sheet, the Ask launcher and panel, the title and line plates) and every option of a
  pick-one track (`.segmented > *`, `.tabs > *`, `.bg-modes > *`, `.model-picks > *`, `.stepper > *`,
  `.ws-switch > *`) declares them again, because a custom property resolves `var()` where it is declared. A quiet
  fill (`--fill-ghost`, and a ghost button inside a lit surface) is green 0.33 and bone 0.125 (`GHOST_*`): a step over
  its parent, never over a raised fill.
* **The light is soft, never a line** (ADR-45 stays). The top glow is an inset shadow blurred 6 to 8 px with a negative
  spread (light catching the top of the glass, under 7 % at the sides), the bottom shade an inset shadow from below,
  the drop an offset soft shadow that grows with the level. No `inset 0 1px 0` hairline, no `::before` rim. Light comes
  from above on one axis: every tint and light runs at 180° or is flat (the 140°, 150° and 160° tints are gone; the
  backdrops themselves, L0, are unchanged).
* **Hover adds light; press takes it away** (§20.17). Ghost buttons (Later, Skip, Not now) rest with a fainter lift,
  no top glow and no shadow; on hover they rise to a raised control.
* **Tinted chips** lay bottle green 0.35 under their colour (`CHIP_UNDER`, was deep green) and a lift of bone between
  them (leaf 0.04, vermilion 0.13, amber 0.01, `CHIP_TINTS`), so a chip on a row or a mark is a whole step brighter
  than it in every look (a vermilion chip read darker than a bluish row without it) and its colour still reads.
* **Liquid.** Every pane blurs (24 px, it was 18; over a photo 18 px as before), saturates and, where that shows
  more, dims what it sees (`brightness()`, each look's own, §22.3), so its green is thin. Refraction (`#cf-refract`,
  unchanged and never animated, `blur(var(--glass-refract-blur)) url(#cf-refract) saturate(1.75)
  brightness(var(--glass-brightness))`: blur first, the dimming last; 18 px, it was 14, and 14 px over a photo) on at most three surfaces a screen (`e2e/refract.spec.ts` counts them on every screen at 1440 and 390):
  the sidebar or tab bar, the setup rail, the Home hero, the sign-in card and the money dock. Money's band blurs
  without bending (with the menu, the rail and the dock it would be four). The page title plates (`.page-head__text`,
  `.dash-head__text`) draw no filter at all: their tint alone holds their words (worked out with nothing blurred).
  Nested glass and controls inside a blurred surface draw no blur of their own; chips over media keep theirs.
* **Reload is plainly the main choice** (`.btn--lens` on the update bar, `variant="glass"`): colourless clear glass,
  no green and no vermilion, white light alone over the bar (0.18 where its words are, 0.06 more at its top edge, a
  catch light 9 px deep, a clear rim and a small drop). At the height of its words it reads at least +0.08 OKLab L
  over Later in every look (+0.087 over a white thumbnail, +0.093 over the brand field), its bone words 4.93:1 at rest
  and 4.59:1 on hover (white 0.205, with the 1 px lift). To leave that room over a white thumbnail the update bar is the
  one floating layer that darkens more: `UPDATE_EXTRA_VEIL` 0.22 over the float veil (0.95, L 0.369 over white).
  **Later** beside it is a ghost, still a button (a pill with a soft rim and its own top light), quieter: bone 0.06
  over the bar (+0.037 over white), hover 0.09, no drop. `e2e/update.spec.ts` holds Reload +0.08 over Later at
  mid-height and Later +0.03 over the bar. The desktop app's **Update** (`AppOffer`) stays vermilion.

**The ladder.** `v` is `--panel-veil` (0.20 over the app's backdrop, dimmed by the pane's own `brightness(0.87)`;
0.73 window Clear and 0.62 window Frosted; 0.29 over a photo, dimmed to half; 0.20 to 0.29 Colours; 0.92 reduced
transparency) and, on a plate, `--plate-veil` (0.33 over the app's backdrop, 0.73 over a photo, as it is); `pay` is
`--light-pay`, the look's own (above). **From a
pane up, every level reads at least +0.015 OKLab L brighter than the level it sits on (`LADDER_STEP`), in every
look, measured where the words are (mid-height), wherever the AA cap leaves room (above):** a row on a pane, a mark,
chip or button on the row and a fourth raised level on that (no depth exemption since this review), their quiet
fills, a tinted chip over its row, and the rows and marks on a floating layer; the next level of light is the bone
selected pill (E4). Every hover adds light (an option's over its own track
too), every press takes it away, never below the level under it.

| Level | What | Tint (green) | Light (bone, top → base) | Top glow | Shade | Drop |
|---|---|---|---|---|---|---|
| L0 | The page, the backdrop (every mode) | unchanged | none | none | none | none |
| E1 | Panels, the sidebar, folders, the title and line plates, the setup bar | `v + pay`, flat (a plate: `--plate-veil + pay`) | 0.04 at the top edge → 0.02 at 6 px → 0.006 at 11 px → 0 at 14 px (inside the top padding), plus the catch light | `--light-rim-1` | `--light-shade-1` | `--light-shadow-1` |
| E1 lead | The hero, the sign-in card, Library's learnings, the week's quote | `v + pay` (`LEAD_EXTRA_VEIL` 0, at most 0.97) | 0.075 at the top edge → 0 at 14 px, plus the catch light: brighter than E1 at its top | `--light-rim-1` | `--light-shade-1` | `--light-shadow-1` |
| E2 | Raised on a panel: rows, inner cards, nested glass, controls, tracks, callouts | relative: 0.34 over the parent (on the page `--plate-veil + 0.22`) | flat 0.13 (on the page 0.08); hover 0.37 / 0.145 | `--light-rim-2` (small things `--light-rim-sm`) | `--light-shade-2` | `--light-shadow-2` (rows inside a card: `--glass-shadow-row`, the faintest drop) |
| E3 | Raised on E2: post marks, chips in rows, buttons in rows, a track's options | the same step again (a chip: its tint over a bone lift over green 0.35) | flat 0.13 | `--light-rim-sm` | `--light-shade-2` | `--light-shadow-2` |
| E3 float | Toasts, the setup pill, rail and list, the Ask launcher and panel, the money dock: a pane of its own, its rows and marks climb the ladder on it where a white thumbnail is not right under them | `max(float-veil, v) + 0.02` (the update bar `max(float-veil + 0.22, v)`) | 0.08 at the top edge → 0 at 14 px, plus the small catch light; hover 0.09 there and a flat 0.01 | `--light-rim-3` | `--light-shade-1` | `--light-shadow-3` |
| E3 Reload | Reload on the update bar, the main choice | none: clear glass, white light alone | white 0.24 at its top edge → 0.18 from 32 % down (its words); hover 0.205 | `--light-rim-lens` | `--light-shade-2` | `--light-shadow-2` |
| L5 overlay | The question sheet, the TikTok sheet, the picture viewer, the markup editor | `max(0.86, v)` (viewer 0.90) | 0.12 → 0.072 at 30 % → 0.04 at 65 %, plus the catch light | `--light-rim-3` | `--light-shade-1` | `--light-shadow-4` |
| L5 menu | The dropdown list (solid), the workspace menu (0.94) | solid or 0.94 | 0.10 → 0.06 at 40 % → 0.04 at 70 % | `--light-rim-3` | none | `--light-shadow-4` |
| E4 | The selected pill, glide pills, icon tiles, the tooltip | bone 0.92 (`--selected`), `--on-bone` words | none (the brightest) | none | `--light-shade-2` on the bone pills and tiles, so the brightest layer is lit from above too (the tooltip: none) | `--light-shadow-2` |
| Wells | Inputs, the link box, the find box, the sign-in fields | `--fill-field` (deep 0.45) and `--shade-field`, one step **below** the parent | none | none | none | none |

The tab bar is an E1 shell piece that floats: `tabbar-veil + 0.04`, light 0.04 → 0.01 at 65 %, `--light-rim-3` and
`--light-shadow-3`; its icons are 3.22:1 over white (icons only, 3:1). A tab's hover lays bone 0.05 alone over the
bar (no green, which would read darker than the bar over a white thumbnail), with `--light-rim-sm`: it adds light
over anything under the bar, and the icons keep 3:1 over white.

**Worst text contrast, where the words are** (a pane's and a float's light lies in their top padding; the comfort
halo never counts):

| Surface | App's backdrop (every corner, every `saturate()`) | Window Clear (white) | Window Frosted (white) | Picture (white) | Colours (all 1,464 swatch mixes) | Reduced transparency |
|---|---|---|---|---|---|---|
| E1 panel and E1 lead | 4.67 | 5.39 | 5.21 | 5.14 | 4.75 | 9.51 |
| E1 plate (no filter) | 4.52 | 5.39 | 5.21 | 5.39 | 4.78 | 9.51 |
| E2 on E1 / hover | 4.70 / 4.64 | 5.04 / 4.95 | 4.94 / 4.86 | 4.90 / 4.83 | 4.69 / 4.63 | 7.00 / 6.74 |
| E3 on E2 / hover | 4.67 / 4.62 | 4.85 / 4.78 | 4.79 / 4.73 | 4.77 / 4.71 | 4.65 / 4.60 | 5.85 / 5.69 |
| E4 on E3 / hover | 4.65 / 4.59 | 4.74 / 4.68 | 4.71 / 4.65 | 4.70 / 4.64 | 4.63 / 4.58 | 5.28 / 5.17 |
| E2–E4 on the lead, hover | 4.59 | 4.68 | 4.65 | 4.64 | 4.58 | 5.17 |
| E2 on a plate, hover | 4.55 | 4.95 | 4.86 | 4.95 | 4.65 | 6.74 |
| A quiet fill / a ghost inside glass, rest | 4.72 | 5.07 | 4.96 | 4.93 | 4.71 | 7.09 |
| A control straight on the page, hover / an option over its track, hover | 4.98 / 4.82 | 7.29 / 5.90 | 6.09 / 5.35 | 7.29 / 5.90 | 4.80 / 4.71 | 8.42 / 6.39 |
| The Live chip and "All set!" (the plate's tint under their own dimming, words in their top light) | 5.02 | 5.01 | 4.85 | 7.61 | 4.73 | 9.51 |
| Float over a white thumbnail / hover | 4.91 / 4.81 | 4.91 / 4.81 | 4.91 / 4.81 | 4.91 / 4.81 | 4.91 / 4.81 | 8.95 / 8.72 |
| Later on the update bar / hover (white under the bar) | 7.15 / 6.88 | 7.15 / 6.88 | 7.15 / 6.88 | 7.15 / 6.88 | 7.15 / 6.88 | 8.25 / 7.92 |
| **Reload: rest / hover** (white under the bar) | **4.93 / 4.59** | 4.93 / 4.59 | 4.93 / 4.59 | 4.93 / 4.59 | 4.93 / 4.59 | 5.58 / 5.17 |

The margins are thin by design: see-through first means a pane sits at the least green that keeps AA over the
lightest thing its look can show, as its own glass sees it (over the app's backdrop the floor, 0.20 at 0.87, leaves 4.67). Never round a number up by eye; change it in `lib/background.ts` and let
`test/background.test.ts` and `test/buttonLight.test.ts` recompute.

**Brightness steps (OKLab L).**

| Behind | L0 | E1 words → top edge | E1 lead top edge | E2 row (hover) | E3 mark | Float words | A row on the float | E4 selected | E2 − E1 / E3 − E2 |
|---|---|---|---|---|---|---|---|---|---|
| The brand field `#08221b` | 0.229 | 0.227 → 0.260 | 0.288 | 0.353 (0.366) | 0.421 | 0.494 | 0.501 | 0.893 | +0.126 / +0.068 |
| The mesh's tightest corner `179 122 87` (no room: a 0.20 pane over it, dimmed, is at 4.71:1) | 0.630 | 0.512 → 0.530 | 0.546 | 0.508 (0.510) | 0.507 | 0.494 | 0.501 | 0.899 | −0.005 / −0.000 |
| The brightest teal corner of the mesh `48 147 114` | 0.597 | 0.493 → 0.511 | 0.526 | 0.498 (0.501) | 0.502 | 0.494 | 0.501 | 0.898 | +0.004 / +0.004 |
| The window over mid grey (`#999`) | 0.683 | 0.411 → 0.433 | 0.453 | 0.453 (0.460) | 0.477 | 0.494 | 0.501 | 0.897 | +0.043 / +0.024 |
| The window's Clear over white (no pay; Frosted +0.001 / +0.001) | 1.000 | 0.509 → 0.527 | 0.543 | 0.509 (0.512) | 0.509 | 0.494 | 0.501 | 0.899 | +0.000 / +0.000 |
| Picture over a white photo (dimmed to half, pay at its 0.10 cap) | 1.000 | 0.486 → 0.505 | 0.522 | 0.496 (0.500) | 0.502 | 0.494 | 0.501 | 0.898 | +0.010 / +0.006 |

(Floats plan for a white thumbnail under them, so their column is the same in every row.) The update bar over white:
bar 0.369, Later 0.406 (+0.037), Reload 0.493 (+0.087), Reload on hover 0.510.

Later and Reload on the update bar are components.css's and system.css's (test/buttonLight.test.ts holds them: Later
+0.03 over the bar, Reload +0.08 over Later, their words at AA at rest and on hover, in every look).

**Page to pane: the one exception** (read this before judging the window over white). Bone `#efe7da` has luminance
0.806; words at 4.5:1 cap whatever they sit on at Y = 0.140 (OKLab L about 0.52). The ladder needs room under that cap:
two whole steps above a pane, the lead panel's step and a hover on top. So:

* **page to pane may go darker, over a light backdrop only**: over a white desktop or photo, a bright spot of the
  mesh (its teal and vermilion corners) or a light colour, a pane that holds bone words sits darker than what is
  behind it, low enough for its ladder (its look's pay). Over the app's own dark field the pane is still a touch
  brighter than the page at its words (0.229 → 0.232: its own dimming takes back most of what its thin green adds;
  0.255 on main) and its lit top more so (0.264);
* **from the pane up, a level climbs +0.015 L wherever the AA cap leaves room**: where it does not (`noRoom`, the
  list above) a level may read at most 0.03 darker (`LADDER_SLACK`); that is the tolerance `test/background.test.ts`
  holds, and `e2e/light.spec.ts` holds the Library's row and mark and Home's new-clip card to a whole +0.015 in every
  look it samples. A pane-card's hover (`--glass-light-hover-face`) keeps AA first and adds +0.000 to +0.002 in the
  light looks; over the brand mesh's brightest corners it reads up to 0.010 darker (no single recipe both adds light
  there and keeps 4.5:1 at the mesh's `179 122 87`, where a pane is at 4.67:1);
* floating layers plan for a white thumbnail under them (as AA needs) and are panes of their own: they can read darker
  than a light picture right under them (page to pane again), the levels on them climb, and their elevation is the
  largest shadow.

**The see-through cost**: none, measured as `showThrough` (the pane's own dimming counted). Over the app's own
backdrop, Clear and Frosted, 70 % shows through a panel (67 % on main, the most a veil alone can there); 22 % of a
white desktop in the window's Clear (as on main: the AA floor and the ladder's pay) and 23 % in its Frosted (8 %);
30.5 % of a white photo (22 %); 75 % of the default Colours (65 %), 33 % of cream (25 %), 30.5 % of white (23 %); the
plates keep main's tints (67 % over the app's backdrop); floating layers 25 % in every look (Frosted 7 % before);
only the update bar 5 % (§22.4 has every look). The
owner judges the real see-through window; a browser cannot show it (§22.4), so it is checked with these maths and the
stand-ins of `e2e/glass.ts`, headless.

* **Performance (Windows WebView2).** All light is static: gradients and box-shadows composite once. The see-through
  pass (2026-11-23) adds no filtered surface: `brightness()` is one more colour step inside each pane's existing
  `backdrop-filter` (1 on the floating layers, the overlays and the tab bar), and the blur grows from 18 to 24 px
  (refraction 14 to 18 px) over the meshes, main's 18 and 14 over a photo; the title plates, tracks and page controls
  still draw no filter. Displacement only
  on the few hero surfaces, at most three a screen, never on the title plates; nothing transitions `backdrop-filter`
  or `filter` (§20.17; the review card leaves with a fade and a slide, no blur); the blurred panels that lift on hover
  (cards, job rows) keep PR #159's `will-change` and `data-dealt` fix, and only their shadow changes.
* **Tests:** `test/background.test.ts` (the logic of light), `test/styleFloors.test.ts` (the chips' green),
  `test/designTokens.test.ts` (the token tables in UX_DESIGN_SYSTEM.md), `e2e/light.spec.ts` and
  `e2e/refract.spec.ts` (§22.6).

### 22.8 The sidebar is still while the page scrolls (owner request, 2026-11-28)

The owner, in the Mac app: "this sidebar is bugging out and blinking and every time i scroll". In the desktop window
(`html.see-through`) the sidebar, and Clips Funded's rail (`.stories-app[data-look="window"] .st-rail`), draw no
`backdrop-filter`. Nothing of the page is ever behind them (the shell is padded past them, the window look draws no
backdrop) and no web filter can see the desktop (§22.3), so the filter changed no pixel (measured in WebKit and
Chromium: identical). In WKWebView the fixed filter layer, with the workspace switch's and Live chip's own filters over
it, was re-sampled on scroll and blinked. Their tint, light, glow and shadow are unchanged; in browsers, on phones and in
the picture and colours looks they keep their blur and bend. The page itself loads from the cloud, so the desktop app
picks this up on a reload. `test/sidebarScrollStill.test.ts`.
