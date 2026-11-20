## Motion and delight

- Durations: 120 ms (press), 200 ms (hover, toggle), 320 ms (sheets, page fade). Easing `cubic-bezier(.2,.8,.2,1)`.
- Buttons press to `scale(0.97)` and spring back.
- **Delight moments** (the "dopamine hits"), only these:
  - Confirm a clip: a short burst of vermilion and green confetti from the button, the card slides away, the badge counts down.
  - A job finishes: the progress ring fills and glows once; a toast "8 clips are ready to review".
  - A skill is added (written or uploaded): success sound, confetti, the toast "Your skill is ready. Clip Factory will
    use it every time.", and the new row pops in with a small bounce on the way back.
  - An update is installed: the Reload progress bar ([the reload curve](#the-reload-curve)) ends in a small sparkle.
- Reduced motion (system `prefers-reduced-motion` or `reduceMotion` in Settings): no confetti, no drifting backdrop,
  fades only (action motions too, see below).

### Action motion (every action button acts out what it does)

The owner asked for it: "Most buttons in the application should have that: the animation of sending a paper plane
or adding something." Every button that **does** something plays one small motion on its own glyph that shows what
just happened: the plane flies, the plus pops, the bin is tossed, the arrow spins. The full contract (API, every
control in the app and its kind) is [CONTRACTS.md §20](CONTRACTS.md#20-action-animations-owner-request-2026-11-16);
this is the designer's summary.

**Rules**
- **Decoration, never a gate.** The action happens at the tap; the motion starts in the same tick. Nothing
  (navigation, a request, a toast) ever waits for it. If the tap removes the button, the motion is simply cut.
- **One meaning per motion.** A flying plane always means "sent", a tossed bin always "thrown away". A child learns
  it once.
- **Small and inside the button.** Only the glyph moves (transform and opacity). The label never moves or gets
  covered, the button never changes size, nothing leaves its box at rest. Inside a normal pill a flying glyph fades
  out before the edge; it never looks swallowed.
- **Moving around and closing stay quiet.** Links, tabs, back, Close, Cancel, Not now keep the press feedback only.
- **Failure never looks like success.** A failed action shakes its glyph gently (±4 px, vermilion for the first half,
  320 ms) with the error sound once; no ring, tick, confetti or success sound. A refused action (Upload with a caption
  that is too long) only shakes.
- **Undo** plays the motion backwards on the button (360 ms), or, when the button is gone, the item that comes back
  fades and grows in (`.is-returning`).
- **Sounds do not change**: the click sound still plays on a click only (never on scroll, a touch scroll that starts
  on a button plays nothing), success where a real result arrives, the error sound on a failure. No new sounds and
  no new confetti: confetti stays for wins.

**Tokens** (`web/src/styles/motion.css` `:root`, mirrored in `web/src/lib/motion.ts`; a unit test keeps them equal)

| Token | Value | Use |
|---|---|---|
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | every "go": fly, drop, slide, spin |
| `--ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | every "pop" with overshoot: plus, tick, star, heart, return |
| `--act-press` | 180 ms | toggle bump, blink, the stepper number |
| `--act-short` | 360 ms | add, clear, paste, copy, next / prev |
| `--act-mid` | 480 ms | keep, save, upload, download, delete, connect, play, the success ring |
| `--act-long` | 600 ms | refresh, check (retry 560) |
| `--act-fail` | 320 ms | the failure shake |
| `--act-rewind` | 360 ms | the Undo rewind and `.is-returning` |
| `--act-fade` | 240 ms | the reduced-motion stand-in, the nudge |

Send keeps the paper plane's own timings: 520 ms flight with its trail, 240 ms return, 300 ms fade under reduced
motion (`--send-fade`, also for a labelled send button). A labelled send flies mostly up (+8 / −16 px, 18 px trail)
so its glyph fades out before it reaches the button's words; only the icon-only paper plane flies the full +34 / −30 px.

**The kinds**

| Kind | Glyph | What it does | Used by (examples) |
|---|---|---|---|
| `send` | paper plane or the button's icon | flies off up and right with a trail, a fresh one fades back | Make clips, Ask Send, Review Upload, TikTok Upload, Ask Clip Factory |
| `keep` | heart | pops and floats up with a bone ring | (kept for later use; Review Upload plays `send` since §33) |
| `add` / `remove` | plus / minus | plus turns 90° and pops; minus squashes | steppers, Write a skill |
| `delete` | bin | tips and drops, fresh one | Remove, skill Delete |
| `throw` | bin | tossed up and away from the label, fresh one | Throw away |
| `clear` | x | turns and shrinks away, fresh one | Clear link, Cancel upload |
| `save` / `tick` | check | pops in with a ring / pops without one | Save keys, Save skill / I did this, chips |
| `upload` / `download` | arrows | shoots up / drops, fresh one | file pickers (when the file arrives) / Get the app |
| `copy` / `paste` | copy / paste | a ghost sheet slides off / drops in | Copy chips / Paste |
| `refresh` / `retry` / `undo` | arrows | one turn clockwise / one turn back with a spring / a half turn back | Refresh numbers / Try again / Not done yet |
| `connect` / `disconnect` | link / log out | squeezes and snaps with a ring / slides out and back | Connect, Sign in / Sign out, Disconnect |
| `check` | check circle | a two-ring radar | Check it |
| `star` | star | spins and pops on with a ring; settles off | Best this week |
| `play` / `stop` | volume / stop | sound rings / the square shrinks | sound cards / Stop job |
| `next` / `prev` | chevrons | slides out the way it points, fresh one in (down for Show older jobs) | week arrows, Show older jobs |
| `nudge` | chevron | 4 px and back: "nothing further that way" | Later week on the newest week |
| `toggle` | the chosen label | bumps 1.06 | Segmented, caption tabs, device chips |
| `blink` | eye | closes and opens | Show / Hide password |

State-driven turns (no kind): expand chevrons turn 90° and the sidebar icon 180°, 240 ms, both ways.

**Reduced motion** (Settings › Look & feel › Motion › Reduce motion, or the system `prefers-reduced-motion`)
- Every kind becomes a 240 ms fade: the glyph dips to 0.45 opacity and tints green. No rotate, translate or scale, no
  rings, ghost or trail. Send keeps its 300 ms fade. The nudge does nothing.
- A failure is a vermilion tint only; Undo is the same fade; chevrons switch angle at once.
- The switch applies to the very next tap, without a reload.

**Building it**: `act="keep"` on a `Button` or `LinkButton` is enough for most buttons; a screen takes a handle from
`useAction(kind)` when it must call `fail()` or `rewind()` later, and passes `playOnClick={false}` when the motion
belongs to a later moment (a file arriving, a keep starting). A raw `<button>` wraps its icon in `<ActGlyph>`. Do not
hand-roll a new animation per button; add a kind to `motion.css` and `lib/motion.ts` instead. Try every kind at
`/__motion` in the mock app (`npm run dev:mock`).

### Sliding highlights and the cursor

* **Glide.** In every pick-one bar (segmented bars, caption tabs, Library's view tabs, the sidebar, the phone tab
  bar) the chosen highlight slides to the new choice on a spring and stretches a little on the way (CONTRACTS §20.13).
  It never slides on resize, and jumps under Reduce motion.
* **The cursor is always the arrow.** Never `cursor: pointer`, never an I-beam, never a wait or not-allowed cursor.
  Pressable things show themselves on hover (CONTRACTS §20.14). Every new control needs a visible hover state.
* **Ask mark.** Ask Clip Factory uses its own mark (chat bubble, play button, vermilion dot), never a generic AI sparkle
  (CONTRACTS §20.15).
