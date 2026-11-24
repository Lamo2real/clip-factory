## 49. Numbers roll when they change (owner request, 2026-11-24)

The owner: "make the numbers roll when they increase or decrease".

- **R1. One part does it.** `web/src/components/Roll.tsx` (styles in `web/src/styles/roll.css`) shows a number. When
  the number changes while it is on screen, each digit that changed slides to its new value like an odometer: up
  when the number grew, down when it shrank. Digits that did not change, and the other characters (".", ",", "K",
  "$"), stay still.
- **R2. Never on first load.** The first number is only shown. A roll starts only from a number that was already on
  screen, whether the new one came from live news or from a reload. A missing number ("–") never rolls.
- **R3. Timing.** One roll lasts 750 ms, slow in and slow out (`--ease-in-out`). A change in the middle of a roll
  starts a fresh roll to the newest number.
- **R4. Nothing jumps.** The number uses same-width digits and each rolling digit sits in a window one line high, so
  the tile and everything beside it keep their size. The written form is kept ("26.8K" stays "26.8K").
- **R5. Reduced motion** (the setting or the system): the number is swapped with no roll.
- **R6. Screen readers** get the final number only; the rolling digits are hidden from them. No sound plays.
- **R7. Where.** Library: the views, likes and shares totals and each post's views, likes and comments. Home: the
  views total. The Review count in the sidebar and on the tab bar. Money: every amount except the one big number
  that counts up from zero, which keeps its count-up.
