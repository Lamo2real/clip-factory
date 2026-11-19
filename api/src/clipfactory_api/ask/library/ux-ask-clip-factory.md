## Ask Clip Factory

The help assistant ([BR-24](BUSINESS_REQUIREMENTS.md#br-24-ask-clip-factory-answers-that-take-you-there),
[UX-18](BUSINESS_REQUIREMENTS.md#ux-18-ask-clip-factory-looks-and-behaves-like-the-rest-of-the-app),
[CONTRACTS.md §19.8](CONTRACTS.md#198-web-websrcfeatureshelp), [HELP_ASSISTANT.md](HELP_ASSISTANT.md)). It is on every
signed-in page and follows every rule on this page.

```
 Desktop (≥ 768 px)                                  Phone (< 768 px)
 ┌──────────────────────────────┐                    ┌───────────────────────┐
 │ Ask Clip Factory  Start over ×│                    │ Ask Clip Factory    × │  full-screen sheet,
 │ Hi! What do you want to do?  │                    │ Hi! What do you want  │  safe-area padding
 │ (How do I make clips…?)      │  3 suggestion      │ to do?                │
 │ (What does Keep do?)         │  chips             │ (chips)               │
 │ (How many views…?)           │                    │                       │
 │[Ask me how to do it…    (➤)] │  Ask field, full   │[Ask me how to do… (➤)]│
 │                              │  width, ➤ = send   │                       │
 └──────────────────────────────┘ 400 px             └───────────────────────┘
                     (✦ Ask)  pill, 24 px from the right,       (✦) 56 px circle above
   [ update bar ]             12 px above the update bar        the tab bar and update bar
```

| Part | Spec |
|---|---|
| Launcher, desktop | green glass pill, sparkle icon + "Ask", fixed bottom right (`right: 24px`), 12 px above the update bar when it shows (the bar publishes its height as `--update-bar-h`). |
| Launcher, phone | 56 px icon-only glass circle, `aria-label="Ask Clip Factory"`, `right: max(16px, safe-area-inset-right)`, bottom = tab bar + safe area + 18 px + `--update-bar-h` (+ 10 px when the bar shows). Never covers the tab bar or the update bar. |
| Dodge | One home spot, and it never moves: no lift, no glide, never sideways or to the middle of the screen. Nothing changes while the page scrolls (drag, wheel, fling, momentum, rubber-band) or a finger is down. Once page and finger have been still for 260 ms, if it would make a control hard to tap (covering over 30 % of a link, button, field, switch or choice, or leaving no 44 px part of it free; a big card or row link it only rests on the edge of does not count), it fades out where it stands (opacity and a slight shrink, 420 ms; taps go through to the control). It fades back in only after 700 ms of stillness with its spot clear, and keeps each state at least 1 s, so it never blinks. Shown while it has keyboard focus or its panel is open. Words are no obstacle. No fade with reduced motion (it simply goes). |
| Room on phones | Pages get extra bottom padding under their last control, so the settled launcher never covers a control at 320, 375, 390 or 430 px, with or without the update bar. |
| Panel, desktop | Non-modal dialog (`aria-modal="false"`), 400 px wide, `max-height: min(640px, 100dvh - 140px)`, anchored above the launcher, `.glass--strong`. If it would cover the control an answer button just lit up, it closes (the chat is kept). |
| Panel, phone | Modal full-screen sheet (`aria-modal="true"`; the page and the launcher are `inert`; Tab stays in the sheet) with safe-area padding; covers the tab bar while open; Close brings it back. |
| Conversation | Kept when the panel closes and reopens, in memory only, until **Start over** (or a reload). |
| Header | "Ask Clip Factory" in Times italic, **Start over** (quiet), Close (×, 48 px). |
| Empty state | "Hi! What do you want to do?" and three suggestion chips chosen by page and device. Default: "How do I make clips from a Twitch link?", "What does Keep do?", "How many views did my best clip get this week?" (Settings pages, skill pages included, swap the second for the sounds question; clip pages show "Why is my clip private on TikTok?"). |
| Ask field | One glass field across the **full width** of the panel (10 px from each edge), one line (52 px) growing to four lines then scrolling, radius 26 px, focus ring on the whole field. Textarea 16 px, placeholder "Ask me how to do something", 300 letters (counter from 250, under the field), Enter sends, Shift+Enter new line, the phone keyboard shows "send". At its right end, inside the field: a round 44 px icon-only **Send** button with a paper plane (`aria-label="Send"`). Vermilion while it is the one main action, green once an answer button is vermilion, off (`aria-disabled`) when the field is empty, an answer is coming or the 429 countdown runs. Sending plays the [action animation](#action-motion-every-action-button-acts-out-what-it-does): the plane flies off (520 ms) and a new one fades back (240 ms); the question bubble shows at once. With reduced motion the plane only fades. On phones the sheet follows the visible screen so the keyboard never hides the field. |
| Thinking | Three bouncing green dots; "Still looking…" after 6 s; still dots with reduced motion. |
| Answer | One or two sentences (button names in bold), numbered steps (`<ol>`, ≤ 6), up to two buttons with icon + word. Only the **first button of the newest answer is vermilion**; older answers' buttons and the Ask button turn green, so the screen keeps one vermilion. Whether the model helped is never shown. |
| Live number | A soft shimmer where the number goes, then the number in the app's compact format ("1.2K"). |
| Unknown or refused | The fixed sentence and the three chips again; unknown also offers **Go Home**, except while you are on Home. |
| Unsaved change | Inline, inside the panel: "You have a change that isn't saved yet. Leave anyway?" with **Stay** and **Leave** (both green). No browser dialog. |
| Spotlight | Waits up to 4 s for the control, scrolls it to the centre (smooth unless reduced motion), draws a bone ring with a soft vermilion glow that fades over 2.4 s, says "Here it is: {label}" politely, never moves focus. A target taller than 60 % of the window rings only its heading, scrolled to 80 px from the top. |
| Notices | 429: "Let's take a short break. You can ask again in {n} seconds." with a countdown and Ask disabled. Off: "Ask Clip Factory is turned off right now." Under a 503, local fallback or failed number: a small link "Something went wrong? Copy the help code" that copies the request id and toasts "Copied. Send this code to whoever helps you with Clip Factory." |
| Sounds | The click sound only on a click or tap (send button, chips, buttons), not when Enter sends; the error sound with the 429, 503 and failed-number notices; nothing when an answer arrives. |
| Keyboard and screen readers | Focus goes to the textarea on open; on desktop Tab stays natural (non-modal), in the phone sheet it stays inside; Escape closes and returns focus to whatever opened it; the log is `aria-live="polite"`. |

**Writing answers and guides.** Same voice as the screens: words a child knows, one idea per step, the button's exact
name in bold, no em or en dashes, no emojis, no jargon (never "job ID", "token", "API"). Steps start with a verb:
"Tap **Make clips**."
