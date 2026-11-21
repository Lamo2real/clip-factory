## Content Rewards campaigns

Contract: [CONTRACTS.md §38.1](CONTRACTS.md#381-words-and-rules-every-new-screen-follows) and the screens of §38.3–§38.7
([UX-19](BUSINESS_REQUIREMENTS.md#ux-19-content-rewards-that-an-8-year-old-can-follow), the steps in
[SETUP_POSTING.md](SETUP_POSTING.md#content-rewards)). The owner's bar: "even an 8 year old should be able to
understand how to navigate it", from setup to joining, to "Am I in?", to getting paid.

- **Where it lives.** No new tab or sidebar item (the phone bar keeps its six tabs). Set up posting keeps its five
  platform cards and "2 of 5 ready"; under them, after a gap (no line), a part "Get paid by brands" with one glass card
  **Content Rewards** (coin icon, a ring over 3 steps, one state line) that opens its own page. The campaigns are on
  `/campaigns` (a paste box on top, then one card per campaign) and `/campaigns/{uuid}`, and Home gets a "Campaigns"
  row of chips like the streamers row. The money is a part of the Money page (`#content-rewards`).
- **Words.** Short sentences, one action each, at most 26 words a line, words a child knows. **Bold** is always the
  other site's exact label, word for word (Content Rewards', Whop's, YouTube Studio's, Instagram's, Facebook's); a bold
  word is something to tap or type into only when the sentence says "tap" or "type in", and a heading there is
  introduced with "You'll see". Clip Factory's own buttons are in quotes ("tap Paste"), never bold. Where Content
  Rewards' help uses an older name, a hint names it (**Accounts**, help: Connected accounts). Whop's steps add "Whop
  may show this a little differently. Look for the same words." The one exception to plain words is the body of the
  pilot email, written for Content Rewards' team, under **Show more**.
- **Step cards** are the Set up posting cards: number in a circle, an icon, a title of six words or fewer, 1–4 short
  lines, then only what the step needs: **Open** buttons (the exact https page, a new tab or the system browser),
  **Copy** chips ("Copied!", select-all fallback), "If you see X, do Y" hints, fold-outs (questions that open more
  lines, never numbered) and "I did this" (green, at least 48 px). A step Clip Factory can see ticks itself; a step it
  can't see shows "I did this" and still ticks itself later. Only the three setup steps are numbered. The first step
  not done is open and scrolled into view; done steps fold to a green tick row. Waiting is never a step: a waiting
  card says "Nothing to do. I'll tell you when you're in."
- **One vermilion button per screen**, always the next step; everything else is glass or green:

  | Screen | The vermilion button |
  |---|---|
  | Content Rewards setup | the first open step's action ("Open Content Rewards", "Open Content Rewards settings", "Connect Content Rewards"); while "Content Rewards said no?" is open, "Open email" (Connect turns glass), and after "I sent it" Connect again; when done, "Connect again" only for a dead sign-in or in the sign-in-again week; "Add a campaign" when nothing else is left |
  | Campaigns, empty | "Open Content Rewards" while the box is empty; "Add campaign" once a campaign link is in it |
  | A campaign card | its next step's one button: "Connect Content Rewards", "Open campaign", "Yes, I applied", "I'm in. Read these rules", "Read these rules", "Add the logo", "Make clips anyway", "Make clips from this" or "Make clips for this campaign"; none while it waits or is paused |
  | Home | "Add campaign" when a campaign link is pasted, else "Make clips"; while the picked campaign has a hard stop, the button shows the stop's short text and can't be tapped |
  | A clip's Content Rewards line | "Copy and open" while the clip must be sent by hand (the Mac banner's "Copy and open" is green) |
  | Money's Content Rewards part | none until "Do you see **Finance**?" is answered; then "Move your money to Whop" at $1.00 or more ready, and once after a move "Your money is on Whop. Move it to your bank." |

- **Phones and touch tablets.** The next step's vermilion button of a card is pinned at the bottom right while the
  card is on screen (the thumb zone, as in the [dock](#money-dashboard-and-the-bottom-right-dock)), and Ask's
  launcher keeps clear of it (`data-help-clear`). Steps that need the Mac say "Do this step on your Mac" with no
  button.
- **Glass, no edges.** Cards, chips, tiles, the post line and the Mac banner are glass or soft fills: no borders, rims
  or hairlines, no cursor change (the arrow cursor only). Pick-one bars slide with `Glide`: "For a campaign" on Home,
  "Yes" / "No" for the Finance question. Membership, rules and post states are chips with words, never colour alone.
- **The campaign card**, top to bottom: the head (brand picture or a round letter, name, brand, one state chip,
  "Checked 2 min ago" and a glass "Check now" at its right end); the next step as a calm callout with the one
  vermilion button; **Pay** (one row per platform with its mark, Content Rewards' rates, "Money left" over a soft bar
  with a "Plenty left" / "Half used" / "Almost gone" chip); **Rules I'll follow** with a tick each (only what Clip
  Factory carries out); **Things you do** with a hand icon each and no tick; **I couldn't tell** with a question mark
  each; the logo drop box; videos to clip; "Your clips for this campaign"; and a quiet "Remove from Clip Factory" at
  the bottom (8 s Undo). Quiet answers ("It says Submit clip", "It says Not eligible") are small green text buttons,
  each undoable for 8 seconds.
- **The post line** (`CrPostLine`) sits next to the post's own row on the clip page, in Library, on the job page and on
  the campaign card: one sentence per state ("Sent ✓ · Waiting for the brand to check it", "Approved ✓ · 12.3K views
  on YouTube"), buttons glass unless said. The Mac banner (`CrSendNow`, no Web Push in the Mac app) shows the
  send-now line on every other page while a clip waits, reserves its room like the update bar, never covers a
  control and plays no sound.
- **Brand text** (names, briefs, rejection notes) is plain escaped text, never HTML, never a link unless code allowed
  it, at most 300 characters a line with **Show more**.
- **Money.** The same money look as the rest of the Money page: three tiles ("Still earning", "On its way", "Ready to
  move") with a hint each, the tag "Content Rewards' numbers · checked 20 min ago", amounts only formatted, never a
  rate × views. "Checking…" until Content Rewards' whole list was read.
- **Delight and mistakes.** "Content Rewards is connected!", "You're in!" and each money moment get confetti and the
  success sound once (acknowledged on the server); reduced motion skips the
  confetti and the slides; no new sounds. Every Undo is an 8-second toast; every error says what to do next and names
  the button to tap.
- **Not there yet.** When the API has no Content Rewards (404) every card, row, part and link is hidden; when it is
  switched off (503 `unavailable`) the setup card says "Coming soon" with no button, and the Campaigns page and Money
  part say "Content Rewards is coming soon to Clip Factory."
