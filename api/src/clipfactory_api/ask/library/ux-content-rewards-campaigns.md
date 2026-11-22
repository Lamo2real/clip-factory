## Content Rewards campaigns

Contract: [CONTRACTS.md §38.1](CONTRACTS.md#381-words-and-rules-every-new-screen-follows) and the screens of §38.3–§38.7,
as changed by [§39](CONTRACTS.md#39-content-rewards-the-two-ways-all-your-money-and-does-this-clip-fit-owner-request-2026-11-21)
([UX-19](BUSINESS_REQUIREMENTS.md#ux-19-content-rewards-that-an-8-year-old-can-follow), the steps in
[SETUP_POSTING.md](SETUP_POSTING.md#content-rewards)). The owner's bar: "even an 8 year old should be able to
understand how to navigate it", from setup to joining, to "Am I in?", to getting paid.

- **Where it lives.** No new tab or sidebar item (the phone bar keeps its six tabs). Set up posting keeps its five
  platform cards and "2 of 5 ready"; under them, after a gap (no line), a part "Get paid by brands" with one glass card
  **Content Rewards** (coin icon, a ring over 3 steps, one state line) that opens its own page. The campaigns are on
  `/campaigns` (a paste box on top, then one card per campaign) and `/campaigns/{uuid}`, and Home gets a "Campaigns"
  row of chips like the streamers row. The money is a part at the end of the Money page (`#content-rewards`), and
  its 30 days are a row of [All your money](#all-your-money) at the top. The [campaign finder](#campaign-finder) is
  `/campaigns/find`, reached from a card at the top of `/campaigns`, a chip on Home's campaigns row and its
  notification.
- **Words.** Short sentences, one action each, at most 26 words a line, words a child knows. **Bold** is always the
  other site's exact label, word for word (Content Rewards', Whop's, YouTube Studio's, Instagram's, Facebook's); a bold
  word is something to tap or type into only when the sentence says "tap" or "type in", and a heading there is
  introduced with "You'll see". Clip Factory's own buttons are in quotes ("tap Paste"), never bold. Where Content
  Rewards' help uses an older name, a hint names it (**Accounts**, help: Connected accounts). Whop's steps add "Whop
  may show this a little differently. Look for the same words." The one exception to plain words is the body of the
  pilot email, written for Content Rewards' team, under **Show more**.
- **One name for each thing** ([§39.1](CONTRACTS.md#391-connect-in-time-order-and-the-two-ways); screens, help
  guides, docs and notifications use only these):

  | Thing | Words |
  |---|---|
  | The normal way | "Make clips" (Home's main button at `/`, as before). Its clips carry no label; only where both ways are named side by side: "normal clips" ("Make normal clips instead") |
  | The campaign way | "Make campaign clips" wherever he starts it from Home (the row chip, and Home's main button at `/?campaign=` only); the campaign card keeps "Make clips for this campaign" |
  | Clips made the campaign way | "campaign clips", one "campaign clip" ("Campaign clips · FaZe Clips" on Home and the job page, "Campaign clip · FaZe Clips" on Review and the clip page, the Library chip "Campaign") |
  | A normal clip that could earn | "This clip could earn money on FaZe Clips." and "Make a FaZe Clips copy"; the new clip is "the FaZe Clips copy" |
  | Putting a social account inside Content Rewards | "add" ("Add YouTube in Content Rewards first.", "I added it", setup step 2's "I added them"); never "link" or "connect" for this |
  | Connect | only Clip Factory and Content Rewards (step 3 "Connect Content Rewards") and each platform's own setup |
  | The site | "Content Rewards", never "CR" on a screen |

  Never on a screen: "the Content Rewards way", "mode", "normal mode", "compatible", "clip type", "upload type",
  "campaign type". Content Rewards' own button names stay bold and word for word (**Connect account**, **Join
  Campaign**).
- **Step cards** are the Set up posting cards: number in a circle, an icon, a title of six words or fewer, 1–4 short
  lines, then only what the step needs: **Open** buttons (the exact https page, a new tab or the system browser),
  **Copy** chips ("Copied!", select-all fallback), "If you see X, do Y" hints, fold-outs (questions that open more
  lines, never numbered) and the step's answer (green, at least 48 px). A step Clip Factory can see ticks itself; a
  step it can't see has an answer button and still ticks itself later. Only the three setup steps are numbered. The
  first step not done is open and scrolled into view; done steps fold to a green tick row. Waiting is never a step: a
  waiting card says "Nothing to do. I'll tell you when you're in."
- **Connect Content Rewards, in time order** (`/settings/posting/setup/contentrewards`, the only place Connect
  happens, [§39.1](CONTRACTS.md#391-connect-in-time-order-and-the-two-ways)), top to bottom:
  0. while steps 1 and 2 are both open, a shortcut card "Already use Content Rewards, with YouTube added there?" (the
     places he connected in Clip Factory, never TikTok; "with your accounts added" when none) with a green "Yes" that
     ticks both and opens step 3. No "No": step 1 is right below.
  1. "Make a Content Rewards account": first line "Have one already? Tap I have an account.", then the vermilion
     "Open Content Rewards" with the green "I have an account" right under it, before the other lines, folds and hints.
  2. "Add your accounts there": first line "Already added YouTube there? Tap I added them.", the vermilion "Open
     Content Rewards settings" with the green "I added them" right under it; its last line "Then come back to Clip
     Factory. Tap I added them."
  3. "Connect Content Rewards" (on a phone "Do this step on your Mac." with no button).
  4. When it's done and the page was opened with `?back=` (a campaign card, Campaigns, Review, a clip page or Money),
     the vermilion is the way back ("Back to FaZe Clips", "Back to your campaigns", "Back to your clip", "Back to
     Money") instead of "Add a campaign", and the result card adds "Next: back to FaZe Clips.". While "Content Rewards
     said no?" waits for "I sent it", "Open email" is the vermilion and the way back is glass. Each platform's own
     setup page reads `?back=` the same way. Only exact same-origin shapes count (`web/src/lib/backLink.ts`).
- **One vermilion button per screen**, always the next step; everything else is glass or green:

  | Screen | The vermilion button |
  |---|---|
  | Content Rewards setup | the first open step's action ("Open Content Rewards", "Open Content Rewards settings", "Connect Content Rewards"; the answers "Yes", "I have an account" and "I added them" are green); while "Content Rewards said no?" is open, "Open email" (Connect turns glass), and after "I sent it" Connect again; when done, the way back when the page has `?back=`, "Connect again" only for a dead sign-in or in the sign-in-again week, "Add a campaign" when nothing else is left; in a desktop browser (or a Mac app that can't update itself) "Get the app" |
  | Campaigns, empty | while Content Rewards is not connected, "Set up Content Rewards" (the part "Then join a campaign" and its Open are glass); once connected, "Open Content Rewards" while the box is empty, or, while the finder is on, the finder card's "Find campaigns" (then "Open Content Rewards" is glass); "Add campaign" once a campaign link is in it |
  | A campaign card | its next step's one button: "Connect Content Rewards" (with the card's `?back=`; on a phone "Set up Content Rewards"), "Open campaign", "Yes, I applied", "I'm in. Read these rules", "Read these rules", "Add the logo", "Make clips anyway", "Make clips from this", "Make clips for this campaign" or "Find another campaign" (the brand said no); none while it waits or is paused ("Find another campaign" is glass on the other hard stops); none while a campaign added from the finder says "Checking that you joined…" (its first 15 minutes) or "Waiting for the brand" (an application added while Clip Factory can't look), with a glass "Open campaign" |
  | Find campaigns | never started, "Find campaigns for me" (with no place set up, "Set up YouTube"); with matches, the open match's "Open on Content Rewards", or "I joined: add it" / "I applied: add it" after he opened it; the newest "You're in!" row's "Make clips for this campaign" when there is one; stopped, "Find campaigns again"; none while it looks |
  | Home at `/` | "Add campaign" when a campaign link is pasted, else "Make clips" (the normal way, as before) |
  | Home at `/?campaign=` | "Make campaign clips"; while the campaign has a hard stop, the button shows the stop's short text and can't be tapped |
  | Review, a campaign clip | by the fit's verdict ([the fit block](#the-fit-block)): Upload, or "Make a FaZe Clips copy", or the first `todo` item's button, or "Make new clips for this campaign" / "Find another campaign" |
  | Review, a normal clip | Upload, as before; the "could earn" line's buttons are glass |
  | All your money | none |
  | A clip's Content Rewards line | "Copy and open" while the clip must be sent by hand (the Mac banner's "Copy and open" is green) |
  | Money's Content Rewards part | none until "Do you see **Finance**?" is answered; then "Move your money to Whop" at $1.00 or more ready, and once after a move "Your money is on Whop. Move it to your bank." |

- **Phones and touch tablets.** The next step's vermilion button of a card is pinned at the bottom right while the
  card is on screen (the thumb zone, as in the [dock](#money-dashboard-and-the-bottom-right-dock)), and Ask's
  launcher keeps clear of it (`data-help-clear`). Steps that need the Mac say "Do this step on your Mac" with no
  button.
- **Glass, no edges.** Cards, chips, tiles, the post line and the Mac banner are glass or soft fills: no borders, rims
  or hairlines, no cursor change (the arrow cursor only). Pick-one bars slide with `Glide`: "Which campaign" on Home at
  `/?campaign=` (only with two or more campaigns that can make clips), "Yes" / "No" for the Finance question.
  Membership, rules and post states are chips with words, never colour alone.
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
  part say "Content Rewards is coming soon to Clip Factory." The fit block, the "could earn" line and All your money
  stay hidden while their routes answer 404 (the old campaign strip stays), and the copy has its own switch. Both
  switches are on in prod (PR #88 and PR #93); these states show only if one is turned off again. The campaign
  finder has its own switch too, on in prod since PR #136 (22 Nov 2026); only if it is turned off again, on 404 or 503
  its card, chips and the "Find another campaign" mapping are hidden and `/campaigns/find` says "Find campaigns is
  coming soon to Clip Factory."

### The two ways

Contract: [CONTRACTS.md §39.1](CONTRACTS.md#391-connect-in-time-order-and-the-two-ways),
[BR-26](BUSINESS_REQUIREMENTS.md#br-26-normal-clips-or-campaign-clips-two-clear-ways-the-normal-way-unchanged).

- **The normal way is frozen.** Home at `/` is the form it always was (Source bar "Paste a link" / "Pick a video", the
  link box with Paste and Clear, How many clips, Notes, "Make clips", "Nothing gets posted until you tap Upload."): no
  campaign field, bar, chip, line or warning inside it, whatever campaigns exist (the "Your campaigns" row stays
  under the form). The Review card of a clip with no campaign keeps its controls; the only addition is the optional
  "could earn" line when a joined campaign fits. Click-count tests hold it at 5 taps.
- **The campaign way starts from a campaign**, never from a field on the normal form: the row chip "Make campaign
  clips" (a chip whose next step is making clips; every other chip opens the card, and the row's line says "Tap a
  campaign to make clips for it." while any chip says Make campaign clips), the card's vermilion "Make clips for this
  campaign", a campaign video's "Make clips from this", or the fit's "Make new clips for this campaign".
- **Home at `/?campaign={uuid}`**, above the link box: the strip "Campaign clips · **FaZe Clips**" with the line "Clip
  Factory follows its 9 rules on every clip." and, at the strip's right end, a quiet "Make normal clips instead" (to
  `/`); the bar "Which campaign" only with two or more campaigns (no "None"); under the link box the campaign's own
  rule lines when it has them ("FaZe Clips pays only for clips of FaZe's YouTube and Twitch.", "FaZe Clips wants
  clips in English."), its videos and channel chips; the main button reads "Make campaign clips", so he sees which way
  he is on as he taps. The job page's strip says "Campaign clips · FaZe Clips · Following 9 rules".

### The fit block

Contract: [CONTRACTS.md §39.3](CONTRACTS.md#393-does-this-clip-fit-the-campaign-the-fit-check),
[BR-28](BUSINESS_REQUIREMENTS.md#br-28-does-this-clip-fit-the-campaign-know-before-uploading). The server decides the
fit; the card only shows it and re-checks the tags, #Ad, the paid switch and the places while he types or taps.

- **Where.** At the top of a campaign clip's Review card (it replaces the old campaign strip) and on its clip page
  while it waits in Review (`data-help="cr-review-strip cr-fit"`): "Campaign clip · **FaZe Clips**" (the name links to
  the campaign card), the verdict's headline and lines, then its buttons. After the clip posts, the post lines take
  over.
- **Lines.** Problems first (can't, a thing to do, a copy needed, a fix, a check, a note), then the passed ones folded
  under "See what's right (7)". One short sentence each; brand text is plain escaped text. A tick only for a check
  that passed; the verdict always has a mark and words, never colour alone.
- **One vermilion per screen**, by verdict:

  | Verdict | Headline | The vermilion |
  |---|---|---|
  | fits | "Can earn on FaZe Clips" (green, a check mark) | Upload; any tag or #Ad line has an optional glass "Fix it for me" |
  | fixable, the paid switch | "Almost ready for FaZe Clips" | Upload, off, "Turn on Branded content for TikTok first."; the green "Turn on Branded content" is its own button |
  | fixable, a copy | "FaZe Clips needs a copy of this clip" | "Make a FaZe Clips copy" (Upload off: "Tap Make a FaZe Clips copy first.") |
  | fixable, a thing to do | "One thing first for FaZe Clips" | that item's button (Upload off with its words) |
  | wait | "Wait a little for FaZe Clips" + "Keep it here. Upload turns on by itself when it can go." | none of its own: Upload, off, with the wait's words |
  | doesn't fit | "This clip can't earn on FaZe Clips" | "Make new clips for this campaign" (or "Find another campaign"); Upload off |
  | can't tell | "Check 2 things, then upload" | Upload; "I couldn't check these:", one glass "Read the rules" per page and the green "I read them. They're OK" |

  "Throw away" stays glass. "I read them. They're OK" folds the lines under "You checked this (2)" with the headline
  "You checked these for FaZe Clips" (kept on this device only; a new or changed line opens the block again); it never
  changes Upload and is never shown as a Clip Factory tick.
- **Fix it for me** puts #Ad and the campaign's tags back in the card's words at once, with an 8 s toast "Fixed: #Ad
  and #FaZe are back." and Undo; it is never needed (the upload puts them back). "Turn on Branded content" (TikTok's
  words, never folded into another button) is the owner's own tap, with the toast "Branded content is on for TikTok."
- **Normal clips: the "could earn" line** (`data-help="cr-review-strip cr-fit-suggest"`), only when a joined campaign
  fits and a copy can be made, only while the clip waits in Review: one quiet glass line under Checks before posting,
  "This clip could earn money on FaZe Clips." · "I'd make a copy with its logo, “Paid partnership” and #Ad. This one
  stays as it is." · a soft warning's text when there is one · glass "Make a FaZe Clips copy" · quiet "Not now" (hides
  it for that clip on this device). Upload stays the vermilion and the 2-tap upload is untouched. Then "Making a FaZe
  Clips copy… It shows here in about 3 minutes." and, when it is in Review, "The FaZe Clips copy is ready, right
  below. Upload the copy to earn money. You can throw this one away." The copy arrives right after its original on the
  same Review page. The clip page also has, closed by default, "Can it earn on your campaigns?" with one line per
  campaign. With no campaign, or an older api, nothing shows.

### All your money

Contract: [CONTRACTS.md §39.2](CONTRACTS.md#392-all-your-money-in-one-place),
[BR-27](BUSINESS_REQUIREMENTS.md#br-27-all-your-money-in-one-place).

- **Where.** The first card on `/money`, right under the page header and above the Apps chips and period band (the
  band changes only the cards below it), `data-help="money-everywhere"`. A glass card with **no vermilion** button.
- **Top.** "All your money", then "Every place · 30 days up to Sat 16 Nov" (+ "· YouTube is 2–3 days behind" when
  YouTube is in it).
- **Rows**, in the order YouTube, TikTok, Instagram, Facebook, X, then Content Rewards: the place's mark (Content
  Rewards: the coin), its name, its words by state ("YouTube says" · "$12.40" · "YouTube's estimate"; "Not available
  from TikTok" · "TikTok doesn't tell apps what you earn." · "Look in TikTok: Profile, then Balance."; "Coming soon";
  "Not set up yet"; "YouTube needs your OK"; "Waiting for the first numbers"; "Couldn't check today"; "Sign in
  again"), never a number or $0 for a place that doesn't report one, and at most one glass button at the row's right
  end (so on phones nothing tappable sits in the top-left third). Under Content Rewards, its small lines in money's
  time order: "Right now (Content Rewards says, 2:10 pm): Still earning … · Ready to move to Whop … · On its way to
  Whop …", "Earned so far, since you started: …", "Sent to your bank: not available from Content Rewards. Look on
  Whop: **Balances**." (since §40.4 every row's `sent` line; it was "Paid out to your bank") and a glass "See it all" (to `#content-rewards`) only while the row has no button of its own.
- **The total**: "Total: $24.80" (the biggest number on the page; it never counts up), "YouTube + Content Rewards · 30
  days up to Sat 16 Nov", the tag line "YouTube's estimate + Content Rewards' numbers"; two currencies give one line
  each and "Different money, like dollars and euros, is never added together."; then "Not in the total: TikTok,
  Instagram and X (not available) · Facebook (coming soon)." With nothing to add: "Nothing to add up yet." and no total.
- **Sent to your bank** ([CONTRACTS.md §40.4](CONTRACTS.md#404-money-sent-toward-his-bank-per-place-and-in-total)):
  under each row, in any state, one small grey line from the row's `sent` ("Sent to your bank by Google: kr 2 468,00
  so far · YouTube says", or the place's not-available line). Under the total, the block **Sent to your bank, so
  far**: one line per currency with its places ("$210.00 · Whop (all your Whop money, Content Rewards too)"), "Google
  and Whop say they sent it.", "Different money, like dollars and kronor, is never added together.", "Not in this:
  TikTok, Instagram, Facebook and X (not available)." and "Clip Factory can't see your bank. Look in your bank's app
  to see what arrived."; only with no sent rows: "Nothing sent to your bank yet." It is never added to the total
  above (a different thing over a different time), and it is never on the Get paid card.
- **Numbers.** Amounts are only formatted (`tabular-nums`); all adding is on the server.

### Campaign finder

Contract: [CONTRACTS.md §41.1](CONTRACTS.md#411-what-the-owner-sees),
[I-50](BUSINESS_REQUIREMENTS.md#interpretations-and-open-questions),
[ADR-65](DECISIONS.md#adr-65-campaign-finder-content-rewards-public-pages-read-politely-joining-stays-the-owners-own-tap).
He says once what he wants; Clip Factory shows the campaigns on Content Rewards that match, best first, and he joins
each one himself on Content Rewards. The server decides every match and writes every line; the page only shows them.

- **Where.** The page `/campaigns/find` (`data-help="cr-finder"`), no new tab or sidebar item. A glass card at the top
  of `/campaigns`, above the paste box (`data-help="cr-finder-entry"`): "Find campaigns", one line ("Tell me what you
  want. I'll find campaigns that pay for it.", "3 new campaigns match what you want." with a small "New" chip, "4
  campaigns match what you want.", "None match right now. I look 4 times a day.", "You stopped finding campaigns.")
  and a glass "Find campaigns". On Home's campaigns row (under the form, never inside it), a first chip "3 new
  campaigns match" with new matches, else a last chip "Find campaigns" when the row shows anyway. The notification
  "3 new campaigns match what you want." opens the page. Settings › Posting › Set up posting has the apple "Find
  campaigns". Every "Find another campaign" that went to Discover opens `/campaigns/find` while the finder is on.
- **The page, top to bottom.** The header "Find campaigns", "Campaigns on Content Rewards that pay what you want. I
  look 4 times a day." and, once it has run, "Looked at 2:10 pm" with a glass "Look again now" (while limited: "You
  can look again at 2:40 pm."); **What you want**; the matches (10, then "Show more", at most 20); the quiet lines "You
  join each campaign yourself on Content Rewards." and how the rules are read after joining; the fold "Why not more?"
  ("I looked at 154 campaigns. 6 match." and one line per reason with a count, most first, plus a quiet "Bring them
  back"); a glass "Look on Content Rewards yourself"; while signed in, the quiet card "Clip Factory can't join for
  you" with a glass "Ask Content Rewards" (`data-help="cr-finder-ask"`); the quiet "Stop finding campaigns".
- **What you want** (`data-help="cr-finder-want"`, anchor `#want`): open the first time and on "Change", else folded to
  one summary line ("At least $1 per 1,000 views · YouTube, Instagram · Some money left · Anyone can join") with a
  glass "Change". Every change saves at once (no Save button) and the matches update by themselves; a
  glass "Done" folds it. Never started, its vermilion "Find campaigns for me" is the screen's only one.

  | Control | Kind | Choices | Picked for him |
  |---|---|---|---|
  | "Pays at least", "for every 1,000 views" | `Glide` | $0.50 · $1 · $2 · $3 | $1 |
  | "Where you post" | chips, many | YouTube, Instagram, Facebook, X, TikTok | the places he set up ("The places you set up.") |
  | "Money left" | `Glide` | Any · Some left · Half or more · Most left | Some left |
  | "Who can join" | `Glide` | Anyone can join · Also ones I apply to | Anyone can join |
  | "What it's about" | chips, many | Anything + up to 12 of Content Rewards' categories | Anything |
  | "Language" | chips, many | Any + English, Spanish, Portuguese, French, German, Italian | Any |
  | "Other kinds of pay" | switch | "Also show campaigns that pay per post or share a prize." | off |
  | "Tell me about new ones" | switch | "At most once a day." | on |

  Where their words don't fit on one row (the row under 400 px, phones up to about 465 px), "Money left" and "Who can
  join" lay their choices out in even halves (a 2 × 2 grid with a rounded track and highlight, and two halves side by
  side), never one choice alone on a second row.

  Under them, fixed: "I skip campaigns Clip Factory can't make clips for, like ones that need their own sound or
  picture on the video." Chips are toggle buttons (`aria-pressed`), soft-filled when on, at least 44 px (48 on
  phones). TikTok, until TikTok's audit, and a place not set up are shown off and can't be tapped (`aria-disabled`),
  with their one line ("TikTok: not yet. …", "Set it up first."), and a quiet "Set up another place" under the chips.
- **The match card** (`FinderMatchCard`, `data-help="cr-finder-match"`), one open at a time (the first on load;
  tapping another's head opens it and folds the rest; after "Not for me" the next one opens). Top to bottom:
  1. **Head**: a round letter of the brand (never an outside picture), the campaign name (two lines at most), the
     brand, a "New" chip when it is new to him, and the access chip "Anyone can join" or "You apply first".
  2. **Pay**: one row per place he posts to that the campaign pays for, with the place's mark and the server's line
     ("$1.50 per 1,000 views · up to $250 a clip", "Up to $2.00 per 1,000 views", "$5.00 for each approved post",
     "Shares the prize money", "Pays picked creators each month").
  3. **Money left**: "$2,410.10 left of $2,500" over the soft bar with its chip, in the bands of Why it matched's
     money words ("All left", "Most left", "Half or more left" green; "Some left" quiet; "A little left" amber), then the
     grey "Content Rewards' numbers, 2:10 pm". Amounts are only formatted (`tabular-nums`), never a guess of what a
     clip would earn.
  4. **Why it matched**, one line: "Pays $1.50 per 1,000 views on YouTube and Instagram. Most of the money is left.
     Anyone can join." The money left is in plain words, never a percent.
  5. Up to three quiet **notes** ("It has 2 rules you see once you join."), up to three **heads-ups** with a warning
     `Icon` ("It may need its own sound. Clip Factory can't add one.") and up to three **can't tell** lines with a
     question mark ("I can't tell how much money is left."). Never colour alone: each has its mark and words.
  6. **Buttons**: before he opened it, the vermilion "Open on Content Rewards" (a new tab or the system browser) and a
     quiet "Not for me" (8 s toast "Hidden. Undo"). After he opened it, the numbered steps (Content Rewards' own
     labels in bold: **Join Campaign**, **Submit clip**, **Apply**, **Submit application**, **Brief**, **Content
     requirements**), the "If you see" fold, the rules box when Clip Factory can't read the rules yet, and the
     vermilion "I joined: add it" ("I applied: add it" for an application), with "Open on Content Rewards" glass. Two
     hours later with no add, the vermilion goes back to "Open on Content Rewards".

  A folded match shows its head and a glass "Open on Content Rewards", so **every match has "Open on Content
  Rewards"** and only the open match's is vermilion. A "You're in! FaZe Clips is in your campaigns." row above the
  matches (the page added it by itself when he came back) takes the vermilion: "Make clips for this campaign", or,
  while the rules are read, "Reading the rules… (about 30 seconds)" on a button that can't be tapped yet.
- **States** each say what to do next and name the button: never started (the want card, open); no place set up ("Set
  up a place to post first. Then I can find campaigns that pay for it." with the vermilion "Set up YouTube");
  looking ("Looking at Content Rewards' campaigns… This takes a minute or two.", or "Updating your matches…" with the
  old ones dimmed below; no vermilion); the first look still going ("No match yet. I've looked at 120 campaigns so
  far. I'll look at more later today."); no match ("No campaign matches right now. I look again 4 times a day." with
  a glass "Change what you want"); Content Rewards didn't answer, stopped Clip Factory, asked apps not to read, or
  changed its pages (one sentence each, ending "Tap Look on Content Rewards yourself." where it helps, with the
  matches already stored under "As of Fri 21 Nov, 2:10 pm"); stopped ("You stopped finding campaigns." and the
  vermilion "Find campaigns again"); a failed load (the shared `ErrorPanel`, "Try again").
- **Words.** The §38.1 rules: words a 6 to 8-year-old knows, at most 26 words a line, one action each, "Content
  Rewards" never "CR", **bold** only for Content Rewards' own labels word for word. Never on a screen: "CPM",
  "budget", "API", "MCP", "scrape", "sitemap", "robots"; say "per 1,000 views", "money", "Content Rewards' pages".
  Brand text (names, brands, Content Rewards' category names) is plain escaped text, at most 300 characters, never a
  link Clip Factory didn't make. Under "Ask Content Rewards" › **Show more** › "What it says", the message to Content
  Rewards' team is the one exception to the plain words (the line "This is what Clip Factory sends to Content Rewards'
  team." sits above it).
- **Glass, motion, phones.** Glass or soft fills only, no edges, the arrow cursor only; pick-one bars slide with
  `Glide`; reduced motion skips the slides and the confetti; WCAG AA in light and dark. On phones and touch tablets
  the screen's vermilion is pinned bottom right and Ask keeps clear of it. "New" chips stay for the whole visit, even
  after the page tells the server he has seen them.
