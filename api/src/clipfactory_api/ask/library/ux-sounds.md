## Sounds

Two kinds of sound, synthesised with the Web Audio API (no audio files). The owner picks which one plays for each,
from 30 choices each, in **Settings › Look & feel › Sounds**
([CONTRACTS.md §15.3](CONTRACTS.md#153-sounds)):

| Sound | When | Default (the owner's pick) |
|---|---|---|
| **Click sound** (`clickSound`) | A click on an enabled button, link, tab, switch or card. | **6 "Water drop"**, plip-plop |
| **Error sound** (`errorSound`) | A click on a disabled control, an error toast, and when an action fails. | **5 "Nope nope nope"**, three quick blips |

These replace the first build's two fixed sounds (a glass "tap" and a double-thud "deny"); both are still in the
catalog as click 1 "Glass tick" and error 1 "Double thud".

### The sound catalog

The 30 click sounds and 30 error sounds come from the sound picker page the owner tried and liked. They are data, not
code: `web/src/lib/soundCatalog.ts` holds one entry per sound, `{ id, name, feel, voices }`, and one player plays any
entry. A voice is either a tone or a burst of noise:

| Voice | Shape | Meaning |
|---|---|---|
| Tone | `[wave, startHz, endHz, at, length, peak, lowpassHz]` | an oscillator (`sine`, `triangle`, `square`, `sawtooth`) gliding from `startHz` to `endHz`, starting `at` seconds in, lasting `length` seconds, at gain `peak`, through a low-pass filter |
| Noise | `["noise", filterType, filterHz, at, length, peak]` | white noise through a `lowpass`, `highpass` or `bandpass` filter |

Numbers are the ids the owner sees on the cards (1–30 in each group) and the values stored in settings. The ids are
frozen: a sound may be retuned, but never renumbered or removed, so a saved pick always means the same sound.

| # | Click sound ("When it works") | Feel | Error sound ("When it can't") | Feel |
|---|---|---|---|---|
| 1 | Glass tick | The app's sound today | Double thud | The app's sound today |
| 2 | Soft pop | Round and quick | Buzz | Short low buzz |
| 3 | Bubble | Rises a little | Step down | Two notes falling |
| 4 | Wood block | Dry and woody | Bonk | Cartoon bonk |
| 5 | Marimba | Warm mallet note | **Nope nope nope** (default) | Three quick blips |
| 6 | **Water drop** (default) | Plip-plop | Low hum | Grumbly |
| 7 | Bell ting | Tiny bell | Wrong note | Two clashing notes |
| 8 | Key clack | Mechanical keyboard | Slide down | Falls away |
| 9 | Pluck | A plucked string | Soft double | Two soft knocks |
| 10 | Kalimba | Thumb piano | Error beep | Classic beep-beep |
| 11 | Micro click | Barely there | Clunk | Dull and heavy |
| 12 | Coin | Two quick notes up | Wobble | Wobbly no |
| 13 | Chirp up | Small and happy | Minor fall | Three sad notes |
| 14 | Soft thump | Deep and gentle | Muffled knock | Knock knock, no |
| 15 | Glass ping | Clear and high | Rasp | Scratchy |
| 16 | Pebble | Little stone tap | Bass drop | Deep fall |
| 17 | Toggle | Switch flick | Tsk tsk | Two dry clicks |
| 18 | Bloop | Playful | Stab | Sharp and sour |
| 19 | Sparkle | Three rising notes | Deflate | Air going out |
| 20 | Mallet | Soft and round | Locked | Latch, then thud |
| 21 | Snap | Finger snap | Two-tone down | Uh-oh |
| 22 | Cushion | Pillowy press | Growl | Low rumble |
| 23 | Tink | Tiny and sharp | Rubber | Bouncy no |
| 24 | Two-step | Two notes up | Hollow block | Two wooden knocks |
| 25 | Harp | Gentle strum | Fizzle | Spark that dies |
| 26 | Cork pop | Pop! | Honk | Little horn |
| 27 | Crystal | Glassy shimmer | Glitch | Steps tumbling down |
| 28 | Thock | Deep keyboard | Mini trombone | Wah-wah-wah |
| 29 | Chime | Little chord | Plunk | Low and short |
| 30 | Feather | Softest of all | Muted double | Two padded taps |

### The Sounds branch (the picker)

The branch is the picker page the owner liked, inside Settings and in the app's glass style:

1. **Sounds** switch (`soundEnabled`) with its leaf "Sounds only play when you tap, never when you scroll."
2. **When it works** (click sounds) and **When it can't** (error sounds): two groups of numbered glass cards in the card
   grid. Each card shows its number in a round badge, its name and its feel. Tapping a card plays it and picks it: the
   card gets a bone edge and a "Pick" badge, and `aria-pressed="true"`; the card that was picked before lets go. The
   playing card's number pulses once (none with reduced motion).
3. **Try it**: the vermilion button "Try it: Sign in" and a **Make it fail** switch beside it.
   - Off: plays the click sound and shows a green toast "Signed in".
   - On: plays the error sound, the button gives a small shake (none with reduced motion) and a vermilion toast says
     "Wrong password. Try again."
   - It is pretend: nothing is signed in or out.
4. A line under **Try it** says the picks in words, one coloured dot each: "Click 6: Water drop" and
   "Error 5: Nope nope nope" (with the owner's defaults). It is `aria-live="polite"`, so a new pick is read out.

Picks save the moment you tap (optimistic, like the Sounds switch) to the account (`PUT /v1/settings`), so they follow
the owner to every device. When **Sounds is off**, the cards stay visible but quiet: a note at the top says "Sounds
are off" with a secondary button "Turn sounds on", and tapping a card still picks it but plays nothing. No surprise
noise for someone who turned sound off.

The cards are real buttons (keyboard and screen reader friendly), at least 48 px tall, and wrap their names instead of
overflowing at 320 px. Card taps play only the card's own sound, never the click sound on top of it.

Rules:
- **Click only, never on scroll.** Sounds are triggered from the `click` event alone. Browsers do not fire `click`
  for scrolls, swipes or drags, so scrolling on a phone never makes a sound. Never use `pointerdown`, `touchstart`
  or `scroll` for sounds.
- Disabled controls get no native click, so they are marked `aria-disabled="true"` (kept focusable and clickable)
  and their click plays the error sound instead of doing anything.
- The audio context is created on the first click (browsers require a user gesture).
- The Sounds switch turns both off (`soundEnabled`). Sounds stay short (under half a second) and soft: no voice in the
  catalog peaks above gain 0.5, and the noise and low tones that reach it are filtered so they sound gentle.
- Settings saved before the picker existed have no `clickSound` or `errorSound`; they read as 6 and 5. An unknown
  number (outside 1–30) also plays the default, never silence or an error.
