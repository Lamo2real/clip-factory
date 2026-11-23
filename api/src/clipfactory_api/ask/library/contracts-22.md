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
  `max(0.30, minVeil(ceiling))`; the cell with the best see-through while **inactive** wins) are in the
  see-through build spec, §7; nothing changes in `main.rs` and no test window is opened until the owner has been
  told.

### 22.3 Web: what is drawn (`lib/background.ts`, `lib/look.ts`, `components/Backdrop.tsx`, `styles/glass.css`)

* `readNativeGlass(window)` trusts `__CF_GLASS__` only when `__CF_DESKTOP__ === true` and the value is one of
  `liquid`, `vibrancy`, `mica`, `acrylic`, `blur`; anything else is `none`. So a desktop app that sends a name this
  web bundle does not know yet (or the other way round, during a rollout) falls back to an ordinary page.
  `resolveLook` turns mode + picture + colours + strength + glass + light/dark into one of: `window`, `frosted`,
  `picture`, `brand`, `colours`.
* `applyLook` (run in `main.tsx` before the first paint, then by `Backdrop` on every change) sets
  `html[data-backdrop]`, `html[data-glass]`, `html[data-strength]`, the `--backdrop-veil` and `--panel-veil` custom
  properties and, for `window` only, `html.see-through`, which makes `html` and `body` transparent so the native
  glass shows. **The window look** below means `html.see-through`.
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
    window look at AA over white: **0.73** (never less than `PANEL_VEIL_FLOOR`, 0.30). Lowest text contrast 4.61:1
    over white, 6.53 over the measured khaki, 12.77 over black.
  * **Frosted:** a green frost over the whole window (0.30) and panels 0.15 heavier than Clear (`FROSTED_EXTRA`, at
    most 0.95): **0.88**, 8.30:1 or better. What shows through a panel is (1 − window frost) × (1 − panel tint), so
    Frosted always shows less than Clear.
* **What carries the tint** (`styles/glass.css`):
  * Every `.glass` panel (`.glass--green`, the lead panel, a step more green under a stronger light, §22.7). The window
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
    page they carry 0.15 more green than a panel (`TRACK_EXTRA_VEIL`) with a lift of bone (0.08, `TRACK_LIFT`), in
    every look (4.68:1 or better); inside a lit surface they take the relative raise (§22.7). The selected pill is bone
    0.92 (`--selected`) with `--on-bone` words, 9.35:1 or better.
  * **The ladder (§22.7).** A fill under words is one step **brighter** than what it sits on, a lift of bone paid for
    with a step more green (`--fill`, `--fill-hover`, `--fill-press`, `--fill-ghost`); the success, vermilion and
    amber tints lay bottle green 0.35 (`CHIP_UNDER`, `CHIP_DEEPEN`) under their colour (`--tint-leaf`,
    `--tint-vermilion`, `--tint-amber`). Only true wells sit one step below: text fields and the link box
    (`--fill-field`), progress tracks and drop targets (`--fill-sunk`).
  * **No edges anywhere (owner, 2026-11-18; ADR-45).** No border, outline, lit rim, inset highlight line, hairline
    divider or ring is drawn on any box, chip, dot, avatar, input, sheet, bar or toast. A control reads as a control
    by its fill: buttons without a fill of their own (glass, ghost: Skip, Not now, Back) wear the raise (`--fill`,
    `--fill-control`; straight on the page the track recipe, bone 0.08 over green `--panel-veil` + 0.15, 4.68:1 or
    better; inside a surface the relative raise, §22.7), the danger button a vermilion tint (0.14) over the same
    green, fields and the link box a deeper well (`--fill-field`, deep green 0.45) with a
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
  | `.glass` panels, the sidebar, `.glass--clear`, the loose-text plates (every look: `html:is(.see-through, [data-backdrop])`) | `--panel-veil` + `--light-pay`: 0.33 + 0.08 over the app's backdrop, its grain included (`BRAND_PANEL_VEIL`, `LIGHT_PAY_OWN`); 0.73 + 0.04 over a white desktop or photo (`LIGHT_PAY_WHITE`) | 0.04 → 0 at 65 %, plus the catch light (`PANEL_LIGHT`, `SPECULAR`) | 4.65 over the app's backdrop (every blob subset, field end, `saturate()` and the grain at its peak); 4.81 over white; 4.61 in Colours |
  | `.glass--green` (the lead panel: hero, sign-in, learnings) | panel + 0.03 (`LEAD_EXTRA_VEIL`, at most 0.97) | 0.06 → 0 at 65 % (`LEAD_LIGHT`) | 4.64; 5.04 over white; 4.59 in Colours |
  | Nested `.glass`, rows, cards and controls inside a surface | the relative raise: green 0.14 over the parent (`RAISE_VEIL`) | flat 0.06 (`RAISE_LIFT`); hover 0.18 / 0.08 | 4.57 four levels deep, on hover (4.51 in Colours, on the lead panel) |
  | Pick-one tracks and every control straight on the page (`--fill` at `:root`, such as the Library tabs) | panel + 0.15 (`TRACK_EXTRA_VEIL`) | flat 0.08 (`TRACK_LIFT`); hover 0.09 | 4.58 on hover (4.53 in Colours) |
  | Fields (`--fill-field`) | deep green 0.45 over the panel: a well, one step below | none | 7.35 |
  | Floating layers: toasts, the update bar, the setup pill, list and sheet, the Ask launcher, the Ask panel and phone sheet (`--glass-tint-float`) | `max(FLOAT_VEIL 0.73, --panel-veil)` + 0.06 (`FLOAT_EXTRA_VEIL`), blur 28 px | 0.08 → 0.02 at 65 % (`FLOAT_LIGHT`); hover 0.09 | 4.70 over white; hover 4.60 |
  | The Reload lens on the update bar | green 0.38 over the bar (`LENS_VEIL`) | 0.14 → 0.07 (`LENS_LIGHT`); hover 0.42 / 0.16 | 4.68; hover 4.60 |
  | The tab bar (icons only, `--glass-tint-tabbar`) | `TABBAR_VEIL` 0.59 + 0.04, blur 28 px | 0.04 → 0.01 at 65 % | 3.22:1 over white; the chosen icon on bone 9.88 |
  | The question sheet, the picture viewer (`--glass-tint-overlay`) | 0.86 (viewer 0.90), over its own scrim | 0.12 → 0.04 at 65 % (`OVERLAY_LIGHT`) | 6.44 (viewer 6.79) over white, on the lightest scrim |
  | The vermilion CTA | `--cta`, white label | unchanged | 4.65 over white, 4.86 over a panel |

  The CTA is the one solid saturated surface on the glass. Every bone light on a pane is paid for with more green
  (§22.7): a sheen with no pay (bone 0.06 over the worst panel) would be 4.48:1, under AA.
* **Colours** (`coloursMeshSpots`, `coloursVeils`): the mesh as drawn: the field is the first colour (its gradient
  end 78 % first + 22 % third), the second colour a blob at 30 %, the third at 45 %, opacity 1; the corners are each
  field end with and without each blob, through every saturation. The panels carry what the corners need (never
  under 0.30) and the page nothing, up to 0.60; past that the panels stay at 0.60 and the page takes the rest
  (`page = ceil(1 − (1 − need) / 0.4)`). The default trio: page 0, panels 0.30 (it was a 0.74 page veil); Ocean +
  Grape 0 / 0.30; the old Sage trio 0.03 / 0.60; Sunny + Bubblegum 0.08 / 0.60; Cream 0.28 / 0.60; white 0.33 /
  0.60. `applyLook` sets both. The bone and deep-vermilion blobs are left out over the owner's colours. The Colours
  tile and strip wear the page veil (`--preview-veil`); when it is above 0 the card adds "Light colours show soft,
  so words stay easy to read." `coloursVeil` (deprecated) returns the combined green.
* **Picture:** no veil over the photo (`PICTURE_PAGE_VEIL` 0), so it shows at full strength between the panels;
  panels at `minVeil(white)` = 0.73 (`PICTURE_PANEL_VEIL`), 4.61:1 over a white photo, with the loose-text scrim.
* **The living backdrop** (`brand` and `frosted`, `BRAND_MESH`): the page owns it. A field from `#0f3d31` to
  `#08221b`; blobs (blur 56 px, opacity 1, drifting 24–28 s): deep teal `rgb(22 89 77 / 0.9)`, vermilion 0.62, leaf
  0.30, bone 0.06 and a deep vermilion `rgb(196 42 30 / 0.55)`; two soft lenses (70 and 46 vmax, a blurred bone glow
  of at most 0.08, never a drawn line, drifting 36 and 44 s). No page veil. Worst corner after saturate 1.75:
  rgb(252, 62, 38); bare bone on it is under AA, which is why loose words get the scrim. Through a panel the
  lightest and darkest spots stay at least 2.5:1 apart (2.58 at 1.6, 2.70 at 1.75), so the see-through has range.
* `prefers-reduced-transparency: reduce` raises the veil to 0.94 in every mode, and panels, the tab bar and the
  floating layers to 0.92; the pay is 0.04 and nothing blurs or bends (`backdrop-filter: none` on `.glass`, the
  title plates and the refracting surfaces). The light, the top glow, the shade and the shadow stay, so the top is
  still brighter.
* **Panels in the window look.** `.glass` keeps the recipe (blur, saturation, the light from above, shadow,
  refraction in Chromium); its tint is `--panel-veil` plus the pay for white (`LIGHT_PAY_WHITE`).
* **Frosted fallback** (see-through in a browser, installed PWA, phone, or the desktop app with `none`): the living
  backdrop above (already blurred), a frost pane (Clear: none; Frosted,
  `html[data-strength="frosted"]`: green 0.40 → deep green 0.45, so Glass strength always does something; no full-screen
  `backdrop-filter`, so phones do not repaint it every frame) and two soft caustic highlights drifting over 26 s and
  34 s (bone, soft-light, peak 0.06). Reduced motion stops them like every other loop.
* **Colours mesh:** a 160° gradient through the colours plus the drifting blobs in `--c1..--c3` (one or two colours
  repeat the last), then the veil.

### 22.4 Why phones and browsers cannot see through

Web pages, installed PWAs and phone home-screen apps are drawn on an opaque surface; no browser lets a page see the
wallpaper or windows behind it, and iOS gives a home-screen app no way to either. On a phone "see-through" therefore
means this: every panel, the top bar, the setup pill, the tab bar and sheets are glass over a living backdrop the
app draws itself (bottle green, deep teal, leaf, two vermilion glows, faint bone light and two soft lenses, drifting
slowly), which shows through 70 % of every panel and fully between them. Only the desktop app owns its window. The Background page says so in one sentence
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
  AA over white, never under 0.30; **the living backdrop**: glass.css draws exactly `BRAND_MESH` (field, five blobs,
  opacity 1, lens glow, caustic peak), Backdrop.tsx draws blob e in both meshes, no green page veil and no Clear frost,
  every blob subset × field end is enumerated independently and a subset beats the full stack, `BRAND_PANEL_VEIL` is
  0.30 and covers every corner at every saturation, the bare worst spot is under AA, the see-through range is at
  least 2.5:1, every `backdrop-filter` `saturate()` is in `SATURATIONS` and at most `GLASS_SATURATE_MAX`, a bone
  sheen with no pay still fails AA, nested glass carries the relative raise and no blur of its own, loose words get
  an E1 plate in every look and glass.css draws no button; **floating layers** resolve (their `var(--glass-tint-*)`
  tokens worked out) to at least `FLOAT_VEIL` with a 28 px blur, the sheet to 0.86, the tab bar to `TABBAR_VEIL`;
  **the logic of light** (§22.7): tokens.css and glass.css carry exactly the `--light-*` numbers of
  lib/background.ts, every tint and light runs at 180° or is flat, words reach AA at the top of every level and state
  (E1, the lead, E2–E4, hover, press, ghost, the page control, floats, Later, the lens, the sheet, the viewer, the
  menu and the list) over every brand corner, every glass, a white photo, all 1,464 swatch mixes and reduced
  transparency, the selected pill and the tab bar too, AA holds at any depth (the raise's fixed point), each level is
  brighter (ΔL ≥ −0.015 everywhere; over the brand field E2 − E1 ≥ 0.03, E3 − E2 ≥ 0.025, Reload − Later ≥ 0.04),
  and nothing transitions `backdrop-filter`;
  **colours**: blob strengths read from glass.css, the page/panel table, and 44,000+ mixes of 1–3 colours from a
  6-level grid all reach AA over every corner with panels at most 0.60; **no edges**: no stylesheet draws a border,
  outline, ring or hard line (a box-shadow layer with 2 px blur or less) outside the allowed selectors and outside
  `@media (forced-colors: active)` (where the system draws its own edges), the shared shadows, glows and every
  `--light-rim-*`, `--light-shade-*` and `--light-shadow-*` are soft, and `.glass` has no `::before` rim; Frosted is 0.30 plus panels 0.15 heavier and always shows less; **every glass × light
  and dark × Clear and Frosted × (white, the floor, and for Liquid Glass every measured point): every text colour of
  the window look reaches AA on a panel, on a pick-one track and on the vermilion and success tints, and the green
  words on the selected bone pill reach AA**; the picture look over a white photo; the stylesheets stay in step
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
  survives the upgrade (and a reload); Glass strength picks see-through and changes the frost; Night alone: the
  previews wear the backdrop's veil and the soft-colours line shows; search finds the new apples; a simulated
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
  the row, and the new-clip card than the hero (ΔL ≥ −0.015; over the app's own backdrop ≥ +0.015); over a flat
  backdrop a pane's top is brighter than its bottom. The Reload button paints no vermilion (fill, shine or glow), its
  words are `--ink`, and its top reads brighter than Later's. The screenshots are attached for review.
  `e2e/refract.spec.ts` also checks that the page title plate blurs before it bends.
* `e2e/screenshots.spec.ts`: the Background page, and the simulated see-through window on Home over the busy
  picture (window in use) and over the darkest measured floor, Clear and Frosted, at 390 and 1440 px:
  `see-through-{scene,floor}-{clear,frosted}-*.png` (the real glass can only be seen in a built app).
* desktop: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` (CI, Linux; the macOS
  path is compiled and tested on a Mac).

### 22.7 The logic of light (owner request, 2026-11-23, ADR-85)

The owner (with a screenshot of Library): "can you use the logic of light on the ui, meaning the top layer is always
brighter than the bottom, and it grows gradually in between ... and make it more liquid glassy while you are at it";
then: "can you make sure the reload button when a new feature is released is without color and only a liquid glassy
style". A refinement, not a redesign: Bottle Green, Bone, the vermilion CTAs, Times and Inter, the layout, the copy,
the cursor and the behaviour stay. Only the light changes: fills, lifts, the soft top light, the inner shade and the
shadows. `lib/background.ts` works out every number (`LIGHT_PAY_*`, `PANEL_LIGHT`, `RAISE_*`, `FLOAT_*`, `LENS_*` and
the pure `lit`, `panelTop`, `raised`, `onPage`, `floatTop`, `lens`, `oklabL`); `tokens.css` carries them as
`--light-*` and the per-level layers (`--glass-tint-*`, `--glass-light-*`, `--glass-shadow-*`); `glass.css`
re-declares the raise inside every lit surface. Brightness is OKLab L.

* **Two lights.** (a) Every level is brighter than the level under it, nested levels too. (b) Inside every pane the
  top is brighter than the bottom: a bone light from above that eases out and reaches the pane's base at 65 % of its
  height, plus a static catch light at the top centre (`--glass-spec`, 8 px deep: the smallest top padding above
  words, on the line plates and compact rows, so it is never under them; 14 px was first drawn, but measured words
  start 8 to 12 px down on the plates, the setup steps, the job rows and the Content Rewards chips).
* **Every bone lift is paid for.** Bone words cap whatever they sit on at luminance 0.140 (4.5:1), so a lift with no
  more green under it fails AA. The pay (`--light-pay`) is 0.08 over the app's own backdrops (the living mesh, Frosted,
  Colours) and 0.04 where white can be behind (the window look and Picture, `html:is(.see-through,
  [data-backdrop="picture"])`, and reduced transparency). The see-through veils (`--panel-veil`, `--float-veil`,
  `--tabbar-veil`), `GLASS_TINT` and the measured floors are unchanged; the pay goes on top of them.
* **A raised thing is one relative step brighter than its parent, at any depth.** Inside any lit surface it lays green
  0.14 and bone 0.06 over whatever it sits on (`RAISE_VEIL`, `RAISE_LIFT`); the step's fixed point is under the AA
  ceiling, so AA holds however deep things nest. Straight on the page it carries the pick-one track's recipe (panel +
  0.15, bone 0.08). One token works in both places: `:root` declares the page values of `--light-raise-*` and the
  fills built from them; every lit surface (`.glass`, the dropdown list, the workspace menu, the money dock, the TikTok
  sheet, the Ask launcher and panel, the title and line plates) declares them again, because a custom property
  resolves `var()` where it is declared.
* **The light is soft, never a line** (ADR-45 stays). The top glow is an inset shadow blurred 6 to 8 px with a negative
  spread (light catching the top of the glass, under 7 % at the sides), the bottom shade an inset shadow from below,
  the drop an offset soft shadow that grows with the level. No `inset 0 1px 0` hairline, no `::before` rim. Light comes
  from above on one axis: every tint and light runs at 180° or is flat (the 140°, 150° and 160° tints are gone; the
  backdrops themselves, L0, are unchanged).
* **Hover adds light; press takes it away** (§20.17). Ghost buttons (Later, Skip, Not now) rest with a fainter lift,
  no top glow and no shadow; on hover they rise to a raised control.
* **Tinted chips** lay bottle green 0.35 under their colour (`CHIP_UNDER`, was deep green), so a chip on a row is
  brighter than the row over the app's own backdrop and its colour still reads.
* **Liquid.** Refraction (`#cf-refract`, unchanged and never animated) on at most three surfaces a screen: the sidebar
  or tab bar, the setup rail, the Home hero, the sign-in card, the money dock and band, and the page title plate
  (`.page-head__text`, `blur(14px) url(#cf-refract) saturate(1.75)`: blur first). The money title plate blurs but does
  not bend (Money already has four). Nested glass and controls inside a blurred surface draw no blur of their own;
  chips over media keep theirs.
* **The Reload lens** (`.btn--lens` on the update bar, `variant="glass"`): green 0.38 and bone 0.14 at its top
  (`LENS_VEIL`, `LENS_LIGHT`), easing to half by its foot; hover 0.42 / 0.16 and `translateY(-1px)`; press 0.38 /
  0.06 with an inset shade. Bone words, no vermilion, no white label, no shine and no glow. Later beside it is a ghost,
  so the lens reads as the primary choice by light alone. The desktop app's **Update** (`AppOffer`) stays vermilion.

**The ladder.** `v` is `--panel-veil` (0.33 over the app's backdrop, 0.73 window Clear and Picture, 0.88 window
Frosted, 0.30 to 0.60 Colours, 0.92 reduced transparency); `pay` is `--light-pay`.

| Level | What | Tint (green) | Light (bone, top → base) | Top glow | Shade | Drop |
|---|---|---|---|---|---|---|
| L0 | The page, the backdrop (every mode) | unchanged | none | none | none | none |
| E1 | Panels, the sidebar, folders, the title and line plates, the setup bar | `v + pay`, flat | 0.04 → 0.02 at 22 % → 0.008 at 42 % → 0 at 65 %, plus the catch light | `--light-rim-1` | `--light-shade-1` | `--light-shadow-1` |
| E1 lead | The hero, the sign-in card, Library's learnings, the week's quote | `v + pay + 0.03` (at most 0.97) | 0.06 → 0 at 65 %, plus the catch light | `--light-rim-1` | `--light-shade-1` | `--light-shadow-1` |
| E2 | Raised on a panel: rows, inner cards, nested glass, controls, tracks, chips, callouts | relative: 0.14 over the parent (on the page `v + 0.15`) | flat 0.06 (on the page 0.08); the parent's light shows through | `--light-rim-2` (small things `--light-rim-sm`) | `--light-shade-2` | `--light-shadow-2` |
| E3 | Raised on E2: post marks, chips in rows, buttons in rows | the same step again | flat 0.06 | `--light-rim-sm` | `--light-shade-2` | `--light-shadow-2` |
| E3 float | Toasts, the update bar, the setup pill, rail and list, the Ask launcher and panel, the money dock | `max(float-veil, v) + 0.06` | 0.08 → 0.04 at 30 % → 0.02 at 65 %, plus the small catch light | `--light-rim-3` | `--light-shade-1` | `--light-shadow-3` |
| E3 lens | Reload on the update bar | 0.38 over the bar | 0.14 → 0.098 at 45 % → 0.07 | `--light-rim-lens` | `--light-shade-2` | `--light-shadow-2` |
| L5 overlay | The question sheet, the TikTok sheet, the picture viewer, the markup editor | `max(0.86, v)` (viewer 0.90) | 0.12 → 0.072 at 30 % → 0.04 at 65 %, plus the catch light | `--light-rim-3` | `--light-shade-1` | `--light-shadow-4` |
| L5 menu | The dropdown list (solid), the workspace menu (0.94) | solid or 0.94 | 0.10 → 0.06 at 40 % → 0.04 at 70 % | `--light-rim-3` | none | `--light-shadow-4` |
| E4 | The selected pill, glide pills, icon tiles, the tooltip | bone 0.92 (`--selected`), `--on-bone` words | none (the brightest) | none | `--light-shade-2` on the bone pills and tiles, so the brightest layer is lit from above too (the tooltip: none) | `--light-shadow-2` |
| Wells | Inputs, the link box, the find box, the sign-in fields | `--fill-field` (deep 0.45) and `--shade-field`, one step **below** the parent | none | none | none | none |

The tab bar is an E1 shell piece that floats: `tabbar-veil + 0.04`, light 0.04 → 0.01 at 65 %, `--light-rim-3` and
`--light-shadow-3`; its icons are 3.22:1 over white (icons only, 3:1).

**Worst text contrast, at the TOP of each surface** (where its light is strongest; the comfort halo never counts):

| Surface | App's backdrop (every corner, every `saturate()`) | Window Clear, Picture (white) | Window Frosted | Colours (1,464 swatch mixes) | Reduced transparency |
|---|---|---|---|---|---|
| E1 panel | 4.65 | 4.81 | 8.17 | 4.61 | 8.57 |
| E1 lead | 4.64 | 5.04 | 8.25 | 4.59 | 8.38 |
| E2 on E1 / hover / press | 4.64 / 4.60 / 4.94 | 4.75 / 4.69 / 5.06 | 7.29 / 7.00 / 7.88 | 4.59 / 4.55 / 4.88 | 7.59 / 7.26 / 8.20 |
| E3 on E2 / hover | 4.63 / 4.59 | 4.70 / 4.65 | 6.64 / 6.41 | 4.57 / 4.53 | 6.86 / 6.61 |
| E4 on E3 / hover | 4.61 / 4.57 | 4.66 / 4.61 | 6.16 / 5.98 | 4.56 / 4.52 | 6.32 / 6.13 |
| E2–E4 on the lead, hover | 4.56 | 4.72 | 6.01 | 4.51 | 6.05 |
| Ghost on a panel | 4.84 | 4.95 | 7.68 | 4.78 | 7.99 |
| A control on the page / hover | 4.68 / 4.58 | 6.10 / 5.95 | 8.66 / 8.42 | 4.63 / 4.53 | 8.66 / 8.42 |
| Selected pill (`--on-bone` words) | 9.43 | 9.35 | 9.39 | 9.39 | 9.40 |
| Float (planned over white) / hover | 4.70 / 4.60 | 4.70 / 4.60 | 7.27 / 7.08 | 4.70 / 4.60 | 8.17 / 7.95 |
| Later (a ghost on the bar) | 4.85 | 4.85 | 6.97 | 4.85 | 7.68 |
| **Reload lens: rest / hover / press** | **4.68 / 4.60 / 5.62** | 4.68 / 4.60 / 5.62 | 5.91 / 5.69 / 7.26 | 4.68 / 4.60 / 5.62 | 6.29 / 6.02 / 7.77 |

Over every look: the question sheet 6.44 (viewer 6.79) on its lightest scrim, the workspace menu 6.90, the solid list
8.19; tinted chips on a row: leaf 4.92, vermilion 6.00, amber 4.66; the danger button 4.77 (hover too). The margins are
thin at the tight spots (4.51 to 4.65): never round a number up by eye; change it in `lib/background.ts` and let
`test/background.test.ts` recompute. `LEAD_EXTRA_VEIL` is 0.03 for that reason: at 0.02 a raised card at the lead
panel's top, hovered two or three levels up, was 4.48:1 in some Colours mixes.

**Brightness steps (OKLab L).**

| Behind | L0 | E1 base → top | E1 lead top | E2 row (hover) | E3 mark | Float top | Later | Reload (hover) | E4 selected |
|---|---|---|---|---|---|---|---|---|---|
| The brand field `#08221b` | 0.229 | 0.261 → 0.291 | 0.308 | 0.336 (0.351) | 0.372 | 0.346 | 0.366 | 0.422 (0.434) | 0.889 |
| A teal blob of the mesh | 0.410 | 0.368 → 0.391 | 0.400 | 0.415 (0.423) | 0.433 | 0.379 | 0.393 | 0.439 (0.449) | 0.893 |
| The window over mid grey | 0.600 | 0.374 → 0.398 | 0.402 | 0.421 (0.429) | 0.439 | 0.417 | 0.425 | 0.459 (0.467) | 0.894 |
| The window or Picture over white | 1.000 | 0.480 → 0.499 | 0.488 | 0.502 (0.505) | 0.504 | 0.505 | 0.497 | 0.505 (0.510) | 0.898 |

**The limit of a white desktop** (read this before judging the window over white). Bone `#efe7da` has luminance 0.806;
words at 4.5:1 cap whatever they sit on at Y = 0.140 (OKLab L about 0.52). Over a pure white desktop or photo a panel
is already right under that cap, so nothing that holds bone words can be much brighter there:

* over the app's own backdrop (the default in browsers and on phones), over mid-tone desktops and pictures, and in
  Frosted, every step is clearly brighter (+0.02 to +0.05 L a level);
* over pure white the levels converge toward the cap: they stay in order within ±0.012 L (the lead panel reads 0.011 L
  under a panel's top there), below a just noticeable difference, and elevation is carried by the shape of the light
  (the top glow, the bottom shade, the growing drop). The tests hold AA and ΔL ≥ −0.015 at every corner; over the brand
  field E2 − E1 ≥ 0.03, E3 − E2 ≥ 0.025 and Reload − Later ≥ 0.04;
* floating layers plan for a white thumbnail under them (as AA needs): brighter than the panels and rows they cover,
  they can read dimmer than a small bright mark or a light picture right under them, and their elevation is the
  largest shadow.

**The see-through cost** (the price of light with AA): about 59 % of the app's own backdrop shows through a panel
(67 % before), 23 % of a white desktop or photo (27 % before); between panels nothing changes (100 %). The owner
judges the real see-through window; a browser cannot show it (§22.4), so it is checked with these maths and the
stand-ins of `e2e/glass.ts`, headless.

* **Performance (Windows WebView2).** All light is static: gradients and box-shadows composite once. Displacement only
  on the few hero surfaces; nothing transitions `backdrop-filter` (§20.17); the blurred panels that lift on hover
  (cards, job rows) keep PR #159's `will-change` and `data-dealt` fix, and only their shadow changes.
* **Tests:** `test/background.test.ts` (the logic of light), `test/styleFloors.test.ts` (the chips' green),
  `test/designTokens.test.ts` (the token tables in UX_DESIGN_SYSTEM.md), `e2e/light.spec.ts` and
  `e2e/refract.spec.ts` (§22.6).
