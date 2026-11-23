## 20. Action animations (owner request, 2026-11-16)

The owner's words: "Most buttons in the application should have that: the animation of sending a paper plane or
adding something or whatever it might be." Today only **Ask › Send** has an action animation of its own (the paper
plane, §19). Every other control has the shared press feedback only (the ripple from the tap point, `scale(0.955)` on
`:active`, the "nope" shake on `aria-disabled`, the spinner while loading) plus a handful of one-off effects (confetti
on Keep, Connect and skill save, the leaving card in Review, `skill-pop`, `sound-pulse`, `try-shake`, the UpdateBar
spark). This section turns the paper plane into **one motion system** that every action button uses, so a tap always
shows what just happened: the plane flies, the plus pops, the bin tips, the arrow spins. Everything in §12.4 still
holds (an 8-year-old must manage, liquid glass, Green / Bone, Vermilion only for the one main action, nothing
overflows from 320 to 1920 px, readable at every size). Where this section and an earlier one disagree, this one wins.
Only `web/**` and `docs/**` change.

### 20.1 Principles

1. **Decoration, never a gate.** The handler runs first, synchronously, in the same click; the animation starts in the
   same tick and nothing (navigation, a request, a toast, a state change) ever waits for it (§20.4).
2. **One meaning per motion.** Each kind (§20.3) means one thing everywhere: a flying plane is always "sent", a tipping
   bin is always "deleted". A child learns it once.
3. **Small and inside the button.** The motion lives on the button's own icon, inside the button's box. It never moves
   the label, never changes the button's size, never covers another control.
4. **Navigation and closing stay quiet.** Moving around (links, tabs, back, cards, rows) and closing (Close, Cancel,
   Not now, Later, Stay, Keep it, Keep editing) keep the existing press feedback only. Motion is for **doing** things.
5. **Failure never looks like success** (§20.5). **Reduced motion means no movement** (§20.6).
6. **No new sounds** (§20.8). No confetti added: confetti stays only where it is today (wins).

### 20.2 The motion system (CORE)

**Tokens.** One easing family, already in `styles/tokens.css`; this section adds the action tokens next to them (in
`styles/motion.css`, `:root`) and mirrors them as constants in `lib/motion.ts`. A unit test parses `motion.css` and
fails if the CSS and TS values drift.

| Token | Value | Use |
|---|---|---|
| `--ease-out` (exists) | `cubic-bezier(0.16, 1, 0.3, 1)` | every "go" movement: fly, drop, slide, spin |
| `--ease-spring` (exists) | `cubic-bezier(0.34, 1.56, 0.64, 1)` | every "pop" with overshoot: plus, tick, star, heart, return |
| `--act-press` | `180ms` | the press bump (segmented, chips, blink, number bump); the existing `:active` scale stays as is |
| `--act-short` | `360ms` | small actions: add, remove, clear, paste, copy, stop, next/prev, undo, tick |
| `--act-mid` | `480ms` | main actions: keep, save, upload, download, delete, connect, play |
| `--act-long` | `600ms` | spins and the radar: refresh, check, retry (560) |
| `--act-fail` | `320ms` | the failure shake (§20.5) |
| `--act-rewind` | `360ms` | the Undo rewind (§20.7) |
| `--act-fade` | `240ms` | the reduced-motion stand-in (§20.6) |

Send keeps its own §19 timings unchanged (`FLIGHT_MS` 520 + `RETURN_MS` 240, `FADE_MS` 300): they are exported from
`components/PaperPlane.tsx` as today and are the one grandfathered exception to the table. No action animation is
shorter than 180 ms or longer than 760 ms end to end.

**The API.** One hook, one glyph wrapper, one prop. The existing `useLaunch` / `<Flight>` (today in
`components/PaperPlane.tsx`, not `lib/hooks.ts`) is generalised into it.

```ts
// web/src/lib/motion.ts
export type ActionKind =
  | "send" | "keep" | "add" | "remove" | "delete" | "throw" | "clear" | "save" | "tick"
  | "upload" | "download" | "copy" | "paste" | "refresh" | "retry" | "undo"
  | "connect" | "disconnect" | "check" | "star" | "play" | "stop" | "next" | "prev"
  | "toggle" | "blink" | "nudge";
export type ActPhase = "idle" | "play" | "fade" | "fail" | "fail-fade" | "rewind";
export interface ActState { shot: number; phase: ActPhase }
export type ActEvent = "play" | "fail" | "rewind" | "end";
/** Pure state machine, unit-tested. `reduced` turns play into fade, fail into fail-fade, rewind into fade. */
export function nextAct(s: ActState, e: ActEvent, reduced: boolean): ActState;
export const ACT_MS: Record<ActionKind, number>;          // the durations in §20.3
export const ACT_ICON: Partial<Record<ActionKind, IconName>>; // the default glyph when a button has no icon
export interface ActionHandle extends ActState {
  kind: ActionKind;
  play(): void;                         // starts (or restarts) the motion; never throws
  fail(opts?: { sound?: boolean }): void; // §20.5; sound defaults to true
  rewind(): void;                       // §20.7, used by Undo
  events?(): number;                    // how many play/fail/rewind calls so far (Button reads it, below)
}
export function useAction(kind: ActionKind): ActionHandle;
```

```tsx
// web/src/components/ui.tsx
/** Wraps a glyph in its action motion. aria-hidden, pointer-events: none; the button keeps its own name. */
export function ActGlyph({ act, children, look }: {
  act: Pick<ActionHandle, "kind" | "shot" | "phase">; children: ReactNode; look?: "act" | "fly"; // "fly" = §19 DOM
}): JSX.Element;
// Button and LinkButton gain one optional prop:
act?: ActionKind | ActionHandle;
// Button only: false = the tap does not play (the screen plays it later); the glyph, data-act and the failure stay.
playOnClick?: boolean; // default true
```

Rules for the API:

* `act="keep"` is enough for most buttons: Button calls `useAction(kind)` itself. A screen passes a handle from
  `useAction(kind)` only when it must call `fail()` or `rewind()` later (Undo flows, errors reported by a toast).
* `useAction` reads `prefersReducedMotion()` (the setting **or** the OS) **at the moment of each play**, so flipping
  Settings › Look & feel › Motion › Reduce motion applies to the very next tap without a reload.
* Every `play()` bumps `shot`. `<ActGlyph>` keys its inner element by `shot`, so a second tap restarts the motion from
  the start instead of queuing a second one: **at most one animation runs per button**. A timer returns the phase to
  `idle` after `ACT_MS[kind]` (cleared on unmount and on every new event; no timers leak).
* Button, when `act` is set and the button has no `icon`, renders `ACT_ICON[kind]` before the label so there is a
  glyph to move (the label never moves). Builders check that the extra icon fits at 320 px (§20.10); where it does
  not, pass an explicit `icon` or use a handle on a smaller glyph.
* DOM: the button gets `data-act="<kind>"`; the wrapper is
  `<span class="act act--<kind> is-<phase>" aria-hidden="true"><span class="act__item" key={shot}>…</span></span>`.
  Tests rely on these names.
* Spinner: while `loading` is true the existing spinner still replaces the glyph, but only once the current play has
  ended (`phase === "idle"`), so a quick request does not cut the motion off. This delays a picture, never the action.
* Not played when the button is `aria-disabled` or `loading` at the time of the tap: those keep the existing "nope"
  shake and the deny sound.
* **The handler wins.** Button reads `handle.events()` before and after `onClick`: if the handler already played,
  failed or rewound the same handle (a refused Keep calls `fail()` and returns), Button does not play over it.
* **`playOnClick={false}`** is for a motion that belongs to a later moment, not the tap: buttons that open a file
  picker (`upload` plays when the file arrives), Review's Keep (the heart plays when a keep really starts, not on the
  tap that only opens the TikTok sheet) and Try it: Sign in (plays only when the pretend sign-in works). A rejected or
  `false` promise from the handler still plays the failure.
* Toggles that change state (expand chevrons, sidebar collapse) are **state-driven, not shots**: a CSS `transition`
  on `transform: rotate()` keyed to `aria-expanded` / `aria-pressed` (240 ms `--ease-out`), no hook. `.act-turn` is
  `display: inline-grid` itself, so any span can carry it; a screen sets only `--act-turn` (default 90°).
* Direction: `next` / `prev` / `nudge` move along `--act-dir`, which `.act` reads from `--act-dir-in` (default 0° for
  next and nudge, 180° for prev). A screen sets `--act-dir-in` on the button (`90deg` = down); it inherits into the
  glyph. (`--act-dir` itself cannot be set from outside: `.act` declares it.)

**PaperPlane keeps working unchanged in behaviour.** `useLaunch()` becomes a thin alias of `useAction("send")` that
still returns `{ shot, mode, launch }` (`mode` is `"fly"` for `play`, `"fade"` for `fade`, else `null`); `<Flight>`
renders through `<ActGlyph>` but keeps the exact DOM and classes it has today (`.fly`, `.fly__item` keyed by shot,
`.fly__trail` only while flying, `.is-flying` / `.is-fading`) and `styles/fly.css` stays the source of the flight
keyframes. `PaperPlaneButton`'s props and look do not change. `test/paperPlane.test.tsx` and the Send checks in
`e2e/help.spec.ts` must pass **without edits**.

**Files.** CORE owns `web/src/lib/motion.ts`, `web/src/styles/motion.css` (imported once next to `fly.css`), the
`act` prop and `<ActGlyph>` in `components/ui.tsx`, the `useLaunch` / `<Flight>` refactor in `components/PaperPlane.tsx`
(and `fly.css` only for shared tokens), the 300 ms same-kind de-duplication in `SoundEngine.play` (§20.8), the
Stepper/Segmented/ErrorPanel mappings inside `ui.tsx`, and the dev-only gallery `/__motion` (§20.10).

### 20.3 The kinds

All movement uses `transform` and `opacity` only. "Fresh one" means the glyph is replaced by a new copy that fades and
scales in from 0.8 to 1 over the last third of the duration with `--ease-spring`, so the button never ends empty.

| Kind | Default glyph | Full motion | Duration |
|---|---|---|---|
| `send` | paper plane (or the button's own icon) | the §19 flight: lifts, tilts −16°, flies off with the fading trail, fresh one fades back. Ask's icon-only paper plane (`.fly`, `PaperPlaneButton`) keeps +34 / −30 px and a 38 px trail. Every labelled `send` (`.act--send`: Make clips, the Find a setting "Ask Clip Factory" row, TikTok Keep…) flies mostly up, +8 / −16 px at −63° with an 18 px trail, so the glyph and trail fade out before they reach the label (§20.1 (3)) and before a pill's top edge | 520 + 240 |
| `keep` | `heart` | pops 1 → 1.28 → 1 (`--ease-spring`) while floating up 6 px and back, with a bone ring that grows 0.6 → 1.8 (`::after`); the ring holds its opacity (0.9 → 0.7) until 45 % and then fades, on `cubic-bezier(0.33, 1, 0.68, 1)`, so a child sees it (the same ring for `save`, `connect`, `star` and the `check` radar) | 480 |
| `add` | `plus` | turns 90° and pops 1 → 1.25 → 1 | 360 |
| `remove` | `minus` | squashes `scale(0.6, 1.2)` and springs back | 300 |
| `delete` | `trash` | tips −12° and drops 6 px while fading to 0.15, fresh one | 480 |
| `throw` | `trash` | tossed up and away from the label (to −12 / −12 px, then −20 / +6 px, turning −40°, out through the pill's left edge) while fading, fresh one; it never crosses the words | 520 |
| `clear` | `x` | turns 90° and shrinks to 0.3 while fading, fresh one | 300 |
| `save` | `check` | the tick pops in from 0.4 → 1.15 → 1 with a bone ring as in `keep` | 480 |
| `tick` | `check` | the tick pops 0.6 → 1.12 → 1 (no ring), for small "done" marks | 300 |
| `upload` | `upload` | the arrow shoots up 14 px and fades, fresh one rises in from +10 px | 480 |
| `download` | `download` | the arrow drops 12 px and fades, fresh one drops in from −10 px | 480 |
| `copy` | `copy` | a ghost copy (`::before`, same glyph) slides +4 / −4 px and fades, the glyph nudges −2 / +2 px; then the existing check swap / "Copied!" ring takes over | 360 |
| `paste` | `paste` | drops in from −8 px with `--ease-spring` and settles | 360 |
| `refresh` | `retry` | one full turn clockwise (`--ease-out`) | 600 |
| `retry` | `retry` | one full turn counter-clockwise ending with a small spring overshoot | 560 |
| `undo` | `undo` | rewinds: turns −200° and springs back to 0 | 420 |
| `connect` | `link` | squeezes to 0.8, snaps to 1.15 → 1 with a bone ring as in `keep` | 480 |
| `disconnect` | `logout` | slides out 6 px and fades to 0.4, then comes back to rest | 420 |
| `check` | `checkCircle` | a radar: two rings (`::before`, `::after`, 120 ms apart) grow 0.6 → 1.9 and fade; the glyph bobs 1 → 1.1 → 1 | 600 |
| `star` | `star` | turning on: spins 144° and pops 1 → 1.35 → 1 with a ring, inside the on-state pose (−12°, 1.12), which sits on the `.act` wrapper (`.star-btn.is-on .act`), never on the icon, so the glyph's box does not overflow at rest; turning off: shrinks 0.85 → 1 | 520 / 240 |
| `play` | `volume` | two sound rings grow 1 → 1.9 and fade; the glyph bumps 1.12 (the card's existing `sound-pulse` stays) | 480 |
| `stop` | `stop` | the square shrinks to 0.55 and springs back | 420 |
| `next` / `prev` | `chevronRight` / `chevronLeft` | the chevron slides out 10 px the way it points and fades, fresh one slides in from the other side (`--act-dir-in: 90deg` and `chevronDown` for down, used by "Show older jobs") | 360 |
| `toggle` | none | the newly chosen option's label bumps 1 → 1.06 → 1 | 180 |
| `blink` | `eye` | the eye closes `scaleY(0.1)` and opens | 180 |
| `nudge` | `chevronRight` | "nothing further that way": 4 px along `--act-dir` and back, no tint, no shake, no sound; under reduced motion nothing at all (the toast says why) | 240 |

State-driven (no kind): expand chevrons turn 90° (a right-pointing chevron then points down), the sidebar collapse
icon turns 180°, both 240 ms `--ease-out`, both directions.

The **Vermilion main actions** get the richest kinds and keep their existing extras: Make clips (`send`), Keep (`keep` +
the existing confetti and leaving card), Refresh numbers (`refresh`), Connect (`connect` + the existing confetti and
success sound on return), Save keys (`save`), Save / Make the skill (`save` + the existing confetti on create), Reload
(the existing spark, §20.9 (d)), Ask Send (`send`).

### 20.4 The action never waits

* Button's click order is fixed: `ripple(e)`, then `onClick(e)` (synchronously, never in a `setTimeout`, a
  `requestAnimationFrame`, an `animationend` listener or after an `await`), then `act.play()`.
* Nothing navigates, submits, posts or closes "after the animation". If a screen today delays work to show motion, it
  stops doing so (the one allowed exception: UpdateBar's final `reloadInto`, which already waits ≤ 650 ms after the
  update has finished, §12; it is not lengthened).
* If the click unmounts the button (navigation, the Review card leaving, a sheet closing), the motion is simply cut;
  that is fine. Builders never keep a button alive to finish its motion.
* The glyph is `aria-hidden="true"` and `pointer-events: none`; the motion never changes the accessible name, focus,
  or what a second tap hits. Screen readers hear the result (toast, new page), not the motion.

### 20.5 When the action fails

* Button watches what `onClick` returns: if it is a Promise that **rejects** or resolves to `false`, Button calls
  `act.fail()`. Screens that catch their own errors (and show `toast.error`) call `handle.fail({ sound: false })`
  from a `useAction` handle instead, because the error toast already plays the deny sound.
* `fail()` cancels whatever is running (the plane does not keep flying, the tick does not stay) and plays the shared
  failure: the glyph returns to rest and shakes gently, `translateX` ±4 px three times, tinted `--vermilion-deep` for the
  first 160 ms, 320 ms in all. Under reduced motion: a 240 ms tint only (`fail-fade`).
* No success visuals on failure, ever: no ring, no tick, no confetti, no success sound, no "Copied!".
* The existing `try-shake` on Try it: Sign in (SoundsBranch) and the "nope" shake on `aria-disabled` stay; they are
  the same family and need no change.

### 20.6 Reduced motion

When Settings › Look & feel › Motion › Reduce motion is on **or** the OS reports `prefers-reduced-motion: reduce`
(`prefersReducedMotion()`, `html.reduce-motion` and the media query, as `fly.css` does today):

* every kind becomes `fade`: the glyph's opacity dips to 0.45 and its colour eases to Green (`currentColor` swap on the
  wrapper), then back, 240 ms total (Send keeps its 300 ms fade: `--send-fade` in motion.css for the in-button
  `.act--send`, the `fly-fade` rules in fly.css for the paper plane, both equal to `SEND_FADE_MS`, which is how long
  `phaseMs("send", "fade")` holds `.is-fade`; `web/test/sendMotion.test.ts` and `e2e/send-fade.spec.ts` keep them in
  step). **No transform at all**: no rotate, no translate, no scale, no rings, no ghost copy, no trail.
* `fail` becomes `fail-fade` (tint only), `rewind` becomes `fade`, state-driven chevrons swap angle instantly.
* The existing press scale on `:active` and the ripple already follow the global reduced-motion rule and are not
  touched here.
* The CSS guards both ways: `@media (prefers-reduced-motion: reduce)` and `.reduce-motion` select the fade keyframes,
  so even a stale `phase` can never move anything.

### 20.7 Undo and the rewind

Throw away, Stop job, skill Delete, cookies Remove, Remove picture, verification-file Remove and Disconnect only
really happen after the 8 s Undo toast (`toast.undo`, `UNDO_MS`). Their motion plays **at the tap** (the owner sees
the result at once). If Undo is tapped:

* the button is still on screen (cookies Remove, Remove picture, verification Remove, Disconnect): the
  screen keeps the `useAction` handle and calls `handle.rewind()` from `onUndo`: the glyph plays its motion backwards
  (`animation-direction: reverse`, `--act-rewind` 360 ms, ending at rest);
* the button is swapped for a note at the tap and comes back on Undo (Stop job: "Stopping in a few seconds" replaces
  it, so its `stop` motion is cut at the tap, §20.4): the screen still keeps the handle, so the Stop job button that
  comes back plays `rewind()`;
* the button is gone (Throw away: the card left; skill Delete: the row left): the item that comes back gets
  `.is-returning` for 360 ms (opacity 0 → 1, `scale(0.96)` → 1, `--ease-spring`), the mirror of its leaving motion.
* The toast's own Undo button keeps its press feedback only (it closes straight away).

### 20.8 Sounds (no new sounds)

* **Tap** stays exactly as today: `installClickSounds` plays it on click only (never on pointerdown, never on scroll),
  once per click, whatever the kind. Motion adds no extra tap.
* **Success** plays only where it plays today or where the real result arrives for a Vermilion main action (Connect /
  account pick as now; Keep, Save keys and skill save when the server says yes). Never at the tap, never on a guess.
* **Error / deny** plays on `fail()` (unless `{ sound: false }`) and on a tap on an `aria-disabled` button, as now, unless the button carries `data-sound="off"` (the newest week's Later week nudge, §20.11).
* CORE adds a 300 ms same-kind de-duplication to `SoundEngine.play` so a failure that both calls `fail()` and shows
  an error toast is heard once.
* Muted sounds (Settings › Sounds off) change nothing about motion.

### 20.9 Performance

* Animate `transform` and `opacity` only (the ring and ghost pseudo-elements too). No `width`, `height`, `top`,
  `left`, `margin`, `filter`, `box-shadow`, `stroke-dashoffset` or `clip-path` animation. The colour change in the
  reduced fade is a single `color` transition on a ≤ 24 px glyph (allowed: it repaints only the glyph).
* No layout reads in the play path (no `getBoundingClientRect`, no `offsetWidth`); the ripple's existing reflow stays
  the only one.
* `.act` is `display: inline-grid` with the glyph's fixed size and `contain: layout style` (no paint containment,
  so a glyph in flight is clipped by the button, not by its own box), so nothing around it ever moves; `.btn` already has `overflow: hidden`, so a flying glyph is clipped to the button and can never widen
  the page. `will-change: transform, opacity` is set only by `.is-play` / `.is-rewind` and dropped at `idle`.
* Motion starts only from a click (or Enter / Space). Nothing animates on scroll, hover, focus, mount, or while a
  list scrolls under the finger; touch scrolls that start on a button do not play it.
* One animation per button at a time (§20.2), all CSS keyframes (no JS animation loop, no rAF, no Web Animations
  `el.animate`), no library added. The newest week's nudge is the `nudge` kind, not script.
* Target: no long task over 50 ms and no dropped frame in a 4× CPU-throttled Chromium trace while tapping Make clips,
  Keep and Refresh numbers.

### 20.10 Tests

Unit (Vitest, `web/test/motion.test.ts(x)`, CORE):

* `nextAct`: idle → play → idle on `end`; a second `play` mid-play bumps `shot` and stays `play`; `fail` from any
  phase → `fail` (reduced: `fail-fade`); `rewind` → `rewind` (reduced: `fade`); reduced turns `play` into `fade`.
* `useAction`: reads reduced motion per play (toggle the pref between two plays); clears its timer on unmount; returns
  to `idle` after `ACT_MS[kind]` with fake timers.
* Button with `act`: `onClick` is called exactly once and **before** `data-act`'s wrapper reaches `is-play` (assert the
  handler's call order with a spy on `play`); no play when `aria-disabled` or `loading`; a rejecting handler ends in
  `is-fail`; the default glyph is rendered when there is no `icon`; the glyph is `aria-hidden`.
* `ACT_MS` / tokens match `styles/motion.css`.
* `paperPlane.test.tsx` passes unchanged.

End to end (Playwright, `web/e2e/motion.spec.ts`; CORE writes the gallery checks, each APPLY builder adds the checks
for its screens):

* A dev/mock-only route `/__motion` (registered only when the e2e mock mode is on, never in a production build) shows
  one Button per kind; each handler writes `performance.now()` into `data-fired`. For every kind: tap → the wrapper has
  `act--<kind>` and `is-play`, `data-fired` is set while `is-play` is still present (the handler fired before the
  animation ended), and the wrapper returns to `is-idle` within `ACT_MS + 200`. A "fail" toggle makes handlers reject:
  `is-fail` appears, no `is-play` ring/tick remains, and the sound log (§15 test hook) shows one `deny`, no `success`.
* Real screens, one per builder at least: Make clips (`send`, the job starts before the flight ends), Keep (`keep`),
  Throw away then Undo (`.is-returning`), Stop job then Undo (`is-rewind`), Refresh numbers (`refresh`), a Copy chip
  (`copy`), a stepper (`add` / `remove` + number bump), Save keys (`save`), Ask Send still `is-flying` with its trail.
* Reduced motion, both sources (`page.emulateMedia({ reducedMotion: "reduce" })`, and the Settings switch with the OS
  at no-preference): every kind gets `is-fade`, and `getComputedStyle(item).transform` stays `none` at 25 / 50 / 75 %
  of the fade.
* Overflow with animations running: at 320, 375, 430, 768, 1440 and 1920 px, start every kind in the gallery and on
  Home, Review, Library, Clip, Settings › Set up posting, then (paused mid-way) assert
  `scrollWidth <= innerWidth`, no button grew (`offsetWidth` before == during), and the existing `overflow.spec.ts`
  rules still pass. `findOverflow` (`e2e/helpers.ts`) skips anything inside `.act:not(.is-idle)` (a glyph mid-pop or
  mid-shake leaves its box on purpose, like `.fly.is-flying`); an idle `.act` is measured like everything else, so a
  glyph that overflows at rest still fails.
* Screenshots mid-animation (pause with `document.getAnimations()` at 50 %): `send`, `keep`, `delete`, `refresh`,
  `save`, `copy` at 375 and 1440 px, light and dark, into the existing screenshots spec output
  (`screenshots/motion-mid-{light,dark}-{375,1440}.png`, the `/__motion` grid).
* No sound on scroll: a touch scroll that starts on an `act` button plays neither motion nor tap (`sound.spec.ts`,
  a swipe from Review's Keep: no click, empty sound log, no `.act` leaves `is-idle`).
* The Ask launcher still dodges controls (existing `help.spec.ts` dodge checks pass unchanged).

Gates for every builder: `npm run typecheck`, `npm run lint`, `npx vitest run`, `npm run build`,
`node scripts/help-corpus.mjs --check`, `npx playwright test --workers=4` (set `CF_E2E_PORT=4185` if 4179 is busy).

### 20.11 Mapping: every control

"Press" = the existing ripple / press scale only, no `act`. Line numbers are from the inventory on 2026-11-16; if a
line moved, the label decides. Durations come from §20.3 unless stated.

**CORE: `components/ui.tsx`, `components/PaperPlane.tsx`**

| Control | Kind | Notes |
|---|---|---|
| ui.tsx:158 Toggle (switch) | none | the thumb slide already is the motion |
| ui.tsx:191 Segmented options | `toggle` | the chosen label bumps, 180 ms |
| ui.tsx:223 Fewer: \<label\> | `remove` | and the number bumps 1 → 0.88 → 1, 180 ms |
| ui.tsx:235 More: \<label\> | `add` | and the number bumps 1 → 1.15 → 1, 180 ms |
| ui.tsx:308 Try again (ErrorPanel) | `retry` | |
| PaperPlane.tsx:86 Send (PaperPlaneButton) | `send` | unchanged behaviour, via the alias |

**APPLY (a): `screens/home`, `screens/jobs`, `screens/review`**

| Control | Kind | Notes |
|---|---|---|
| Home.tsx:97 Go to Review, :133 All jobs, :148 working job row, :171 Last finished, :198 Review teaser | press | |
| NewJobForm.tsx:128 Paste a link / Pick a video | `toggle` | via Segmented |
| NewJobForm.tsx:167 Clear link | `clear` | |
| NewJobForm.tsx:171 Paste | `paste` | the linkbox mark `pop` stays |
| NewJobForm.tsx:200 Dropzone (file input) | `upload` | played on `change` with a file, not on the click that opens the picker |
| NewJobForm.tsx:245 Cancel upload | `clear` | |
| NewJobForm.tsx:256 Pick for me / Exactly | `toggle` | via Segmented |
| NewJobForm.tsx:265 clip count stepper | `add` / `remove` | via Stepper (CORE) |
| NewJobForm.tsx:285 **Make clips** (Vermilion) | `send` | its own icon flies; the job is created at the tap; `fail()` if creating it fails |
| Jobs.tsx:79,98 Make clips (navigate) | press | |
| Jobs.tsx:117 Show older jobs | `next` | `chevronDown`, steps down (`--act-dir-in: 90deg` on the button) |
| Jobs.tsx:130 job row; JobDetail.tsx:116 See all jobs, :211 Check these clips, :226 source link, :267 clip tile, :285 All jobs | press | |
| JobDetail.tsx:195 Stop job | `stop` | handle; the button is swapped for the "Stopping" note at the tap (motion cut, §20.4); the one that comes back on Undo plays `rewind()` (§20.7); the pending stop lives in `pendingStops.ts`, so the note stays after leaving and coming back (§12.5) |
| JobDetail.tsx:206 Try again | `retry` | |
| Jobs.tsx:30 / JobDetail.tsx:45 confetti on finish | unchanged | not a click |
| Review.tsx:128 Show every job | `clear` | |
| Review.tsx:144 See how it does, :159 Make clips, :383 source times, :501 See the job | press | |
| Review.tsx:428 Checks before posting (summary) | state | chevron turns 90° (points down when open) |
| Review.tsx:476 Throw away | `throw` | the card's leaving motion stays; Undo → `.is-returning` on the card |
| Review.tsx **Upload** (Vermilion) / Try again | `send` / `retry` | `playOnClick={false}`: plays when an upload really starts, not on the tap that opens the TikTok sheet; a refused Upload (caption too long, nothing picked) only shakes; confetti and leaving card stay; success sound only when the upload succeeds; `fail()` on error (§33) |
| UploadTo.tsx Upload to chips | `tick` | soft-fill toggle chips with `aria-pressed` and a check mark; the tick plays when a chip turns on |
| PlaceRows.tsx place rows | `toggle` | chevron turn |
| TikTokSheet.tsx:93 backdrop, :99 Close, :197 Not now, :174/181 policy links | press | |
| TikTokSheet.tsx Who can see it (button bar) | `toggle` | the chosen button's label bumps and the glide slides; checkboxes (native) none |
| TikTokSheet.tsx:152-155 Toggles | none | switch thumb |
| TikTokSheet.tsx Upload / Try again | `send` / `retry` | it posts to TikTok |

**APPLY (b): `screens/library`, `screens/clip`, `features/help` (and `lib/markdown.ts` links)**

| Control | Kind | Notes |
|---|---|---|
| Library.tsx:59/63 tabs, :106 Make clips, :190 Go to Review, :228/233 card cover/hook, :244 See how it does, :294 Open the post | press | |
| Library.tsx:173 Show: All / Not posted yet / Posted | `toggle` | via Segmented |
| Library.tsx:353 Try again (KeepAgain) | `retry` | `fail()` on error |
| WeekView.tsx:124 Go back, :182 Make clips, :264/269 week card | press | |
| WeekView.tsx:138 Earlier week | `prev` | |
| WeekView.tsx Later week | `next` | when it is already the newest week: the `nudge` kind (4 px and back, no fail, no deny) with the info toast; the button keeps `aria-disabled="true"` for screen readers and carries `data-sound="off"` so no click sound (not even deny) plays |
| WeekView.tsx:300 Best this week (star) | `star` | on / off variants |
| ClipPerformance.tsx:159 Go to Library, :309 platform chips, :417 Back | press | |
| ClipPerformance.tsx:163 Try again | `retry` | |
| ClipPerformance.tsx:360 Best this week (star) | `star` | |
| ClipPerformance.tsx:371 **Refresh numbers** (Vermilion) | `refresh` | spinner only after the turn ends; `fail()` on error |
| HelpLauncher.tsx:102 Ask | press | **no transform added**: `dodge.ts` and the inline `translateY` own it |
| HelpPanel.tsx:335 suggestion chips | press + `send` | the chip asks at once and launches the panel's Send plane (same `launch()`) |
| HelpPanel.tsx:384 Stay, :464 Close | press | |
| HelpPanel.tsx:387 Leave, :395 answer action buttons | press | |
| HelpPanel.tsx:456/460 Start over | `refresh` | |
| HelpPanel.tsx:490/508 **Send** | `send` | unchanged (useLaunch alias) |
| HelpPanel.tsx:534 Copy the help code | `copy` | |
| markdown.ts:383 answer links | press | |

**APPLY (c): `screens/settings` (incl. `setup/`, skills, sounds)**

| Control | Kind | Notes |
|---|---|---|
| Settings.tsx:125 tree card, :195 search submit, :261 result, :292 branch card, :431 All settings, :466 folder link; parts.tsx:100 Back, :115 breadcrumb | press | |
| Settings.tsx:222 Clear the search | `clear` | |
| Settings.tsx:245 Ask Clip Factory \<query\> | `send` | the Ask mark flies, the panel opens at the tap |
| Settings.tsx:441 folder toggle | state | chevron turns 90° |
| parts.tsx:65 AppleSwitch; branches.tsx:178 Reduce motion; SoundsBranch.tsx:42 Sounds on, :198 Make it fail | none | switch thumb |
| branches.tsx:34/38/48 steppers | `add` / `remove` | via Stepper |
| branches.tsx:116 Add cookies.txt / Replace | `upload` | on `change` with a file (`playOnClick={false}`, as every picker row below) |
| branches.tsx:120 Remove (cookies) | `delete` | handle; `rewind()` on Undo |
| branches.tsx:148 Post to platform check-chips | `tick` | on turning on; off: press |
| branches.tsx:226 Choose / Change picture | `upload` | on `change` with a file |
| branches.tsx PictureApple Remove picture (was Use the colours) | `undo` | handle; `rewind()` on Undo |
| branches.tsx:255 GetAppPanel | see (d) | |
| branches.tsx:287 Check for updates | `refresh` | |
| branches.tsx:303 Sign out | `disconnect` | |
| SoundsBranch.tsx:113 sound cards | `play` | `sound-pulse` stays |
| SoundsBranch.tsx:151 Turn sounds on | `play` | |
| SoundsBranch.tsx:210 Try it: Sign in | `play` | its `try-shake` + deny on fail stays (it is the fail motion) |
| SkillsSection.tsx:137 Write a skill | `add` | |
| SkillsSection.tsx:140 Upload a file | `upload` | confetti 90 stays (on success only) |
| SkillsSection.tsx:155 skill row; SkillPages.tsx:59/80 Back, :166 Edit, :169 Delete (opens the sheet), :208 Keep it, :653 Cancel, :663 Keep editing, :666 Leave | press | |
| SkillPages.tsx:211 Delete (sheet) | `delete` | the row leaves; Undo → `.is-returning` (the existing `skill-pop` may serve) |
| SkillPages.tsx:386 Use the newest | `refresh` | |
| SkillPages.tsx:389 Save mine anyway | `save` | |
| SkillPages.tsx:454 Replace the whole file | `upload` | |
| SkillPages.tsx:633 Use the example | `paste` | |
| SkillPages.tsx:650 **Save / Make the skill** (Vermilion) | `save` | create keeps confetti 110 and `skill-pop`; `fail()` on error |
| setup/SetupList.tsx:41 platform card; StepCard.tsx:73 open link; KeyForm.tsx:116 Change keys, :209 Keep the saved keys; SetupPlatform.tsx:362 Go to step N; MockConsent.tsx:37 Cancel | press | |
| setup/SetupList.tsx Skip \<Platform\> (opens the question, §17.13) | press | |
| setup/SetupList.tsx Un-skip \<Platform\> | `undo` | |
| StepCard.tsx:48 step header | state | chevron turns 90° |
| StepCard.tsx:87 icon download | `download` | |
| StepCard.tsx:120 Not done yet | `undo` | |
| StepCard.tsx:124 I did this | `tick` | |
| bits.tsx:81 Copy \<label\> | `copy` | then the existing check / "Copied!" / bone ring |
| KeyForm.tsx:165 Paste the \<key\> | `paste` | |
| KeyForm.tsx:187/199 key file from Google | `upload` | |
| KeyForm.tsx:205 **Save keys** (Vermilion) | `save` | `fail()` on a bad key |
| KeyForm.tsx:246, SetupPlatform.tsx:466 Check it | `check` | `fail()` when the check fails |
| VerificationUpload.tsx:90 Pick the file | `upload` | |
| VerificationUpload.tsx:101 Remove \<file\> | `delete` | handle; `rewind()` on Undo |
| SetupPlatform.tsx:242 **Connect \<Platform\>** (Vermilion), :464 Connect again | `connect` | OAuth leaves the page at once (desktop app: the spinner stops on return, §17.1); confetti + success on return stay |
| SetupPlatform.tsx:450 Who can see (segmented) | `toggle` | via Segmented |
| SetupPlatform.tsx:468 Disconnect | `disconnect` | handle; `rewind()` on Undo |
| ChooseAccount.tsx:42 account card | `connect` | spinner after the motion; confetti + success stay |
| MockConsent.tsx:40 Allow | `connect` | |

**APPLY (d): `components/*` other than ui.tsx and PaperPlane.tsx, `app/*`, `screens/SignIn.tsx`**

| Control | Kind | Notes |
|---|---|---|
| Nav.tsx:53 Collapse / Expand menu | state | the icon turns 180° (240 ms) |
| Nav.tsx:64 brand, :76 sidebar items, :101 Get the app, :117 N jobs working, :135 tab bar items | press | existing 0.97 / 0.88 press stays |
| GetApp.tsx:65 Go home, :369 Show me, :377 Not now | press | |
| GetApp.tsx:107 Checking downloads | none | |
| GetApp.tsx:121 device chips | `toggle` | chip bump |
| GetApp.tsx:162 Download for Mac/Windows/Linux, :176 install from this browser, :204 Install app | `download` | |
| GetApp.tsx:268 Copy the link | `copy` | then the existing check swap |
| UpdateBar.tsx:66 Later | press | |
| UpdateBar.tsx:69 **Reload** (the colourless lens since ADR-85; it was vermilion) | existing | the spark spin / pop / confetti stays as the `refresh` motion; its icon gets `act="refresh"` for the tap; nothing new waits |
| Toasts.tsx:134 Undo | press | the rewind plays on the source control (§20.7) |
| Toasts.tsx:141 Close message; Sheet.tsx:50 scrim / Escape | press / none | |
| SetupTodo.tsx the pill, **–** (make it small), × (close), Set up \<Platform\>, Skip \<Platform\> (opens the question) | press | navigation, opening and closing stay quiet (§17.13) |
| SetupTodo.tsx Un-skip \<Platform\> | `undo` | |
| SkipConfirm.tsx Keep it, Skip \<Platform\> | press | opting out is quiet: no tick, no success sound; "All set!" (confetti, success) plays only when the list is really finished |
| PlatformStack.tsx:103 setup link, :145 Open on \<Platform\> | press | |
| App.tsx:107 Try again (boot failed) | `retry` | the reload happens at the tap |
| App.tsx:152 Skip link | none | |
| App.tsx:158 brand, :206 Go home | press | |
| SignIn.tsx:141 Sign in / Save password and continue | `connect` | glyph `key` (was a trailing chevron); `fail()` with deny on a wrong password, a missing field or a refused new password; no success sound or confetti: signing in opens the app |
| SignIn.tsx:145 Start again | `retry` | |
| SignIn.tsx:161 Show / Hide password | `blink` | |

### 20.12 Who builds what

1. **CORE first** (one builder; nothing else starts until it is merged into the feature branch): §20.2 files,
   every kind's keyframes and the reduced / fail / rewind variants in `styles/motion.css`, the `useLaunch` / `<Flight>`
   alias, the `SoundEngine` de-duplication, the CORE rows of §20.11, `/__motion`, `web/test/motion.test.ts(x)`, the
   gallery part of `e2e/motion.spec.ts`, and the overflow / reduced-motion / screenshot harness the APPLY builders reuse.
2. **APPLY builders in parallel**, each owning only its folder (§20.11 (a)–(d)): add `act` (or a handle) per the table,
   wire `fail()` / `rewind()`, remove any code that delays an action for motion, and add their screens' e2e checks to
   `e2e/motion.spec.ts` in their own `test.describe` block. They do not edit `ui.tsx`, `lib/motion.ts`,
   `styles/motion.css` or `PaperPlane.tsx`; a missing capability goes back to CORE.
   * (a) `screens/home`, `screens/jobs`, `screens/review`
   * (b) `screens/library`, `screens/clip`, `features/help` (incl. `lib/markdown.ts` links)
   * (c) `screens/settings` (incl. `setup/`, skills, sounds)
   * (d) `components/*` except `ui.tsx` / `PaperPlane.tsx`, `app/*` (Nav, UpdateBar, GetApp, Toasts, Sheet), and
     `screens/SignIn.tsx`
3. **docs**: `docs/TESTING.md` lists `motion.spec.ts` and the gallery; the help corpus picks up nothing new (motion is
   not a feature to ask about), and `help-corpus.mjs --check` must stay green.

Done means: every row of §20.11 behaves as written at 320–1920 px in light and dark, with Reduce motion on and off,
all gates in §20.10 pass, and Ask › Send looks and behaves exactly as before.

### 20.13 The glide: sliding highlights (owner request, 2026-11-16)

Every bar where you pick one of a few things shows its choice with **one** highlight that slides from the old choice
to the new one, instead of the old pill vanishing and a new one appearing.

* **Where:** every `Segmented` (Paste a link / Upload a video, Pick for me / Exactly, every other segmented bar), the
  place rows on Review, Library's All clips / This week tabs, the sidebar menu (the glass pill and the vermilion bar
  move together) and the phone tab bar (the glass tile and the vermilion dot move together).
* **How:** `components/Glide.tsx` renders one `aria-hidden` element as the first child of the bar and moves it to the
  item matching its `active` selector, measured from the bar (which is `position: relative`), so a scrolling tab row
  carries it along. Styles live in `styles/glide.css`.
* **Motion (rebuilt 2026-11-19, ADR-49):** a 360 ms ease-out slide, `cubic-bezier(0.22, 1, 0.36, 1)` (`GLIDE_MS`,
  `GLIDE_EASE` in `Glide.tsx`), that never passes the target: no spring, no overshoot, no creep back (the old 460 ms
  `--ease-spring` reached the item at 170 ms, overshot to 110 % and crawled back for the last 190 ms, which read as
  lag). On the way it stretches along its path and narrows across it (at most +9 % / -7 %, centred), and the stretch
  eases back to nothing before it lands. It aims at the item's layout box (offsets, not the painted box), so a tapped
  item's press shrink never makes it aim small and snap at the end. Only a change of choice slides: first paint, a
  resize or a layout shift moves it instantly, except while a slide is under way, when it re-aims from where it is
  painted.
* **Compositor only (FLIP):** the glide takes its new place (`--glide-x/-y`) and size at once; one Web Animation
  (`id: "glide-slide"`, 24 keyframes of `transform: translate() scale()` with `transform-origin: 0 0`, linear between)
  carries it there from the old box, the stretch folded into the same transform. Nothing transitions its transform,
  width, height or position (the only CSS transition is its opacity), there is no separate `scale` animation and no
  forced layout per tap, and `.glide` has `will-change: transform`. So WebKit (the macOS app) and Chromium run the
  slide on the compositor and a busy main thread (a new page being laid out under the glass) cannot stall it.
* **Bars with options of different widths** (more than a tenth apart, `unevenBoxes`: the Library's All / Not posted
  yet / Posted, the Review caption platform tabs) animate `width` and `height` in the same `glide-slide` animation and
  only move by `transform`, so the pill's round ends and its shadow are never squashed. These bars sit inside a page,
  never over one being rebuilt; the menu, the phone tab bar and the background tiles keep the transform-only slide.
* **Fallback:** until it has measured, the bar has no `has-glide` class and the chosen item paints its own highlight,
  so there is never a moment with no highlight. With `has-glide`, the chosen item drops its own background, its
  vermilion marker and its shadow, and the glide draws them.
* **Reduced motion:** no slide and no stretch (no Web Animation is started). The highlight jumps to the choice (only a
  150 ms opacity fade).
* **Accessibility:** the chosen state stays on the item itself (`aria-checked`, `aria-selected`, `aria-current`); the
  glide is decoration only.
* **Tests:** `e2e/glide.spec.ts` checks that it travels (one transform-only `glide-slide` animation with a stretch),
  lands on the choice in every bar, follows a page change in the menu and the tab bar, snaps on resize, and does not
  slide under reduced motion. `e2e/nav-smooth.spec.ts` (Chromium, and WebKit on macOS) samples the glide every frame for
  every menu switch in the simulated macOS window (1000 x 650), a 1440 x 900 browser and the phone tab bar: one
  transform-only animation, lands to the pixel, never passes the item (≤ 101 %), never creeps back, no step bigger than
  the curve's own launch, and fewer than half the switches with a frame later than about two and a half frames in the
  last two thirds (frame times follow the machine's load; the old cross-fade stalled most switches). `web/test/stillNav.test.ts` holds the curve and the keyframes.

### 20.14 The cursor never changes (owner rule, 2026-11-16)

The pointer is always the plain arrow, everywhere in the app: on buttons, links, tabs, inputs, text, while loading
and on disabled controls. `styles/base.css` sets `cursor: default !important` on every element; no other stylesheet
sets `cursor`. What can be pressed shows itself by **hover** instead: every button, link, chip, tab, switch option,
card and menu item lights up under the pointer. `e2e/glide.spec.ts` checks that no pressable element on any main page
(or the Ask panel) shows any cursor but the arrow.

### 20.15 The Ask mark

Ask Clip Factory has its own mark instead of a generic sparkle: a chat bubble with a clip's play button inside, and
the brand's vermilion dot on its corner (the same dot as the "C" in the logo). The dot breathes slowly (2.8 s, still
under reduced motion). It is used on the Ask launcher, the panel's header and Settings' "Ask Clip Factory" search row
(`components/AskMark.tsx`). The sparkle icon stays for "Clip Factory learned" and update messages.

### 20.16 A page change is still (owner request, 2026-11-19)

The owner: every page change made the whole see-through window blink white and twitch. A page change now swaps the
content in place and nothing else moves: no cross-fade, no fade-in, no lift, in the desktop window, browsers and phones.

* **No View Transition.** `router.ts` `transition()` just runs the update. The old cross-fade captured the whole window
  as two pictures and blended them: every glass panel, the unchanged menu included, thinned to 32 to 53 % for the first
  100 ms (over the light window glass that is a white blink), and WebKit rebuilt every glass layer when it ended at
  about 400 ms, right on the last third of the menu highlight's slide (35 to 118 ms frames). `TRANSITION_CAP_MS` and the
  tap-through cap are gone with it.
* **No page entrance.** `.main > *` no longer runs `page-in` (from opacity 0.001): in the see-through window a new page
  was transparent for about 300 ms after every tap, so the light glass showed through. Pages and their panels are at
  full strength from their first frame. Small things inside a page may still arrive (a badge pops, a list row rises),
  but nothing animates `.main`, `.shell`, `.app`, a page or a glass panel's opacity as a page opens (the Home get-app
  banner lost its `rise` for this).
* **No see-through loading state.** A page's data takes a full round trip to the cloud, and every visit used to start
  empty: the skeletons were 6 % bone over the see-through window, one near-white sheet under the page title until the
  data came. Now `useLoad(load, key, cache)` keeps the last result per cache name and key for the life of the page
  (Home, Jobs, Review, Library, the setup list and the streamers row opt in): a page visited before shows what it
  showed last at once and refreshes in the background. Sign-out (and a sign-in that ends) forgets it all
  (`forgetLoaded`). On a first visit the skeletons carry the panel tint (`--panel-veil` green under the shimmer;
  inside a panel, the panel's), so the glass never shows through.
* **Unchanged:** the backdrop stays mounted (it lives in `App`, outside the routed page); focus still moves to the page
  for screen readers; scroll still resets to the top.
* **Tests:** `e2e/page-still.spec.ts` (Chromium **and WebKit**): through every menu page change, every frame for 700 ms
  has no View Transition, no animation fading the page or a glass panel, no page panel under full opacity, and the same
  backdrop element; over white "glass" behind the see-through window (1000 x 650) the title bar band, the menu and the
  gap beside it stay within 3 grey levels of rest in screenshots taken right after each tap (the old cross-fade moved
  them 30 to 60); the same at 1440 x 900 in a browser and on a phone. With the mock API slowed to 1.2 s a call
  (`__cfMockFaults.latencyMs`), first and second visits to every menu page never show more of the white glass below
  the page title than either page at rest (the old skeletons: 94 % white). `e2e/navigation.spec.ts` checks that no page
  change calls `startViewTransition`; `web/test/stillNav.test.ts` fails on any `::view-transition` rule or an
  animation on the page's own blocks.

### 20.17 Light is static (owner request, 2026-11-23, ADR-85)

The logic of light (§22.7) never moves: every light, top glow, shade and shadow is a gradient or a box-shadow that is
drawn once. No specular sweep, no moving highlight, no animated refraction.

* **Hover adds light; press takes it away.** Hover is one step up (more bone paid for with more green, a stronger top
  glow, a bigger shadow, and `translateY(-1px)` only under `prefers-reduced-motion: no-preference`); press is one step
  down (less bone, an inset shade from above and the existing `scale(0.955)`). No hover anywhere is darker than its
  rest.
* **What may transition** on hover and press: `background-color`, `box-shadow`, `transform` and `opacity` (150 to
  250 ms, `--ease-out`), or a registered `@property` number (the lens's `--btn-lift` and `--btn-veil`, so its light
  fades in). A gradient layer cannot interpolate, so it swaps at once while the shadow and transform animate.
* **Never** transition or animate `backdrop-filter`, a blur, a `saturate()`, a `url()` or any SVG filter parameter
  (Windows WebView2 repaints every frame; PR #159). `test/background.test.ts` fails on any `transition` or
  `@keyframes` that names `backdrop-filter` (or `transition: all`).
* Under reduced motion the light is the same; the global 1 ms rule makes every state swap instant.
