## Action motion

The action animations on buttons ([CONTRACTS.md §20](CONTRACTS.md#20-action-animations-owner-request-2026-11-16),
[UX_DESIGN_SYSTEM.md](UX_DESIGN_SYSTEM.md#action-motion-every-action-button-acts-out-what-it-does)) are tested like
everything else, offline against the mock app.

**The gallery.** `/__motion` is a test page that exists only in the mock build (`npm run dev:mock`, and the Playwright
server): one Button per kind, a "Make them fail" switch, a stepper and a segmented control. Use it to look at any
motion by hand, light and dark, with Reduce motion on and off.

```bash
cd web
npx vitest run test/motion.test.tsx
CF_E2E_PORT=4185 npx playwright test e2e/motion.spec.ts e2e/motion-*.spec.ts --workers=4
```

| Suite | Must show |
|---|---|
| Vitest (`test/motion.test.tsx`) | `nextAct` state machine; tokens in `motion.css` equal `ACT_TOKENS` and every duration is 180–760 ms; every kind has its rules in `motion.css`; `useAction` returns to idle after `ACT_MS`, reads Reduce motion at each play, clears its timer on unmount, plays one deny on `fail()`; Button calls the handler once and before the play, does not play when `aria-disabled` or `loading`, ends in `is-fail` on a rejected or `false` promise, does not play over a handler that failed its own handle (a refused Keep), honours `playOnClick={false}`, holds the spinner back until the motion ends; Stepper, Segmented and ErrorPanel mappings; the 300 ms sound de-duplication; `paperPlane.test.tsx` unchanged. |
| Playwright `e2e/motion.spec.ts` (CORE, the gallery) | Every kind: the handler fired while `is-play` is on, then back to `is-idle` within `ACT_MS + 200`; failing actions shake with one deny and no success; the stepper and segmented bumps; reduced motion from the OS and from the Settings switch: every kind gets `is-fade` and no `.act__item` has a transform at 25 / 50 / 75 %; at 320, 375, 430, 768, 1440 and 1920 px nothing scrolls sideways and no button changes width mid-animation. |
| Playwright `e2e/motion-home-jobs-review.spec.ts` | Make clips flies and the job starts before the flight ends; a disabled Make clips does not play; Paste (and its failure), Clear, the dropzone (plays on the file, shakes on a wrong one); the stepper and Exactly bumps; Stop job then Undo rewinds; Try again on a failed job; Keep pops the heart with its confetti; a refused Keep only shakes (never `is-play`); a Keep that does not finish shakes Try again; Throw away then Undo returns the card (`.is-returning`); caption tabs bump; the checks chevron turns; reduced motion; no overflow mid-animation. |
| Playwright `e2e/motion-library-clip-help.spec.ts` | Library Try again; This week: arrows slide, the newest week's Later week plays `nudge` (not a shake), the star spins on and settles off; Refresh numbers; the clip star; Ask's chips launch the plane, Start over, Copy the help code (and its failure); reduced motion; no overflow at six widths. |
| Playwright `e2e/motion-settings.spec.ts` | Every Settings, setup and skill control's kind, the pickers playing on the file, the Undo rewinds, the failure paths, reduced motion and no overflow. |
| Playwright `e2e/motion-shell.spec.ts` | The sidebar turn, Get the app chips / Download / Copy the link (and a blocked clipboard), Reload; sign in: Sign in snaps its link, a wrong password shakes it with one deny, the eye blinks, Start again turns. |
| Playwright `e2e/sound.spec.ts` | A touch swipe that starts on Review's Upload fires no click, plays no sound and leaves every `.act` at `is-idle`. |
| Playwright `e2e/overflow.spec.ts` (through `findOverflow` in `e2e/helpers.ts`) | Glyphs inside `.act:not(.is-idle)` are skipped while they play (like the flying plane); an idle `.act` is measured, so a glyph that overflows at rest fails. |
| Playwright `e2e/screenshots.spec.ts` | `screenshots/motion-mid-{light,dark}-{375,1440}.png`: send, keep, delete, refresh, save and copy paused at 50 % in the gallery. |
