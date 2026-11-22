## Kid-proof checklist

The owner's bar: "even a 6-year-old should be able to use it, or an 8-year-old"
([UX-13](BUSINESS_REQUIREMENTS.md#ux-13-kid-proof-a-68-year-old-can-use-it)). Every screen and every pull request that
changes one is checked against this list.

**One next step**
- [ ] Exactly one vermilion button on the screen, and it is the thing to do next. (Only the update bar may add a second.)
- [ ] The button says what happens, with an icon and a word: "Make clips", "Upload", "Throw away", "Try again".

**Big and clear**
- [ ] Every tap target ≥ 48 × 48 px on phones, with at least 8 px between neighbours.
- [ ] Buttons show icon + word everywhere except the phone tab bar and the send button inside the Ask field (its
  placeholder says what it does, and it has `aria-label` and a tip).
- [ ] Body text 16 px or larger; no grey-on-grey.

**Words a child knows**
- [ ] Sentences of 8 words or fewer where possible; no jargon on screen.

  | Instead of | Say |
  |---|---|
  | Submit, Start job | Make clips |
  | Confirm / Keep | Upload |
  | Decline, Delete | Throw away |
  | Retry | Try again |
  | Upload | Pick a video |
  | Failed, Error 500 | "That didn't work. Tap Try again." |
  | Pending integration | Waiting for the account connection |
  | Submission, submit | Clip, send, "Sent ✓" |
  | CPM | per 1,000 views |
  | MCP, OAuth, token, scope, API | sign in, allow (the jargon is never on screen) |
  | KYC | ID check |
  | EFT | bank transfer |
  | Live, Connected, Verified (for a payout) | "Can get paid ✓ (YouTube says)" or "Can get paid (you said it's done)" |
  | Not connected, disconnected (for a payout) | "Clip Factory can't check" or "Not set up yet" |

  Skills are the one place that says **Delete**, because a skill is the owner's own writing, not a clip
  ([Skill pages](#skill-pages)).

**No dead ends**
- [ ] Every screen has a way forward and a way back.
- [ ] Empty states name the exact button to tap: "Nothing here yet. Tap **Make clips** to start."
- [ ] Every error says what to do next, with the button to do it.
- [ ] Every button and setting a guide names has a `data-help` anchor (or is an apple), so **Ask** can point at it.

**Mistakes are cheap**
- [ ] No "Are you sure?" dialogs. Throwing away shows a toast with **Undo** for 8 s; nothing is deleted until it ends.
  The one exception is deleting a skill: a small glass sheet first, then the same Undo toast
  ([Skill pages](#skill-pages)).
- [ ] Forms can't be filled in wrong: a **Paste** button next to the link box, the link checked while typing (platform
  icon appears), hints right under the field, the main button inactive until the input is valid (its click plays the
  error sound and points at what is missing).

**Always know what is happening**
- [ ] Anything that takes longer than 300 ms shows progress.
- [ ] Success is celebrated (confetti, sparkle, a friendly toast), within the [delight moments](#motion-and-delight).
- [ ] Sounds and motion are never the only feedback; every state also has words.
