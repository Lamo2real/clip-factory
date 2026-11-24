## Get paid

Contract: [CONTRACTS.md §40.1](CONTRACTS.md#401-what-the-owner-sees) and
[§40.2](CONTRACTS.md#402-the-status-per-place-honest-and-how-it-is-known),
[BR-30](BUSINESS_REQUIREMENTS.md#br-30-get-paid-set-up-each-places-payout-see-if-money-can-reach-you-and-what-was-sent-to-your-bank),
[UX-20](BUSINESS_REQUIREMENTS.md#ux-20-get-paid-that-a-child-can-follow), the steps in
[SETUP_POSTING.md](SETUP_POSTING.md#get-paid). The same look as [Set up posting](#set-up-posting), apart from it: it
never touches the "2 of 5 ready" ring or the floating setup list.

- **The list** (`/settings/posting/getpaid`, `data-help="getpaid-list"`; the Posting branch right after Set up
  posting, icon `coin`): the header "Get paid", the server's one-line summary ("YouTube says it can pay you. You said
  TikTok is done. Instagram needs you."), then one big glass card per place in the order YouTube, TikTok, Instagram,
  Facebook, X, then Content Rewards while it is on: mark, name, a small ring over that place's numbered steps, the
  status pill and one line; X's card adds its warning. **No vermilion on the list**: each card is one big tap to its
  page. Under the cards, the glass card **Your bank**: "Clip Factory can't see your bank. Look in your bank's app to
  see what arrived." and no button.
- **A place page** (`/settings/posting/getpaid/{place}`, `data-help="getpaid-place"`), top to bottom: the hero (mark,
  name, ring, "About 15 minutes · Free", "Steps checked on 21 Nov 2026"); the **status block**
  (`data-help="getpaid-status"`: the pill, the line, what is missing, holds, the reading chip "Clip Factory can see
  payments: on" / "off" (off is left out when a line above already says payments can't be seen), X's warning, and
  the next step as words); **Can you earn here?** (the place's first rule for his country on the card, the rest and
  one glass "Read YouTube's rules" per official page in a closed "See all the rules", or "Pick your country to see its
  rules." with a glass "Pick my country"); the step cards; **What Clip Factory can see** (at most 6 lines);
  **Sent to your bank** (`data-help="getpaid-sent"`); **When it's done** (glass "Check now", the connection's own
  buttons, the way back with `?back=`).
- **The pill**: never colour alone. Each status has its icon and its fixed words, with the tones `success`,
  `neutral`, `warn` and `error` at AA contrast, never the vermilion fill of a button. "Can get paid ✓ (YouTube says)"
  is success with the tick; "Can get paid (you said it's done)" is success with an outline icon and **no** ✓; "Not
  set up yet" is `warn` (the amber tint), never red, because a creator who is already paid but hasn't ticked must not
  be told money can't reach him; red (`error`) is only for a sign from the place: "Payment on hold (…)" and "Not set
  up (YouTube says)". "Live", "Active", "Verified ✓", "Connected", "Not connected" and "disconnected" never appear on
  a Get paid screen (the owner's "disconnected" is "Clip Factory can't check" or "Not set up").
- **One vermilion, the next step.** When the next step is a step card, the vermilion is that card's main button (its
  first Open, or "Allow payment reading"), and on phones it is pinned at the bottom right from the moment the page
  opens; the status block then says "Next: step 3, Add your bank." once, as words. Only a hold's fix or a reconnect
  puts the vermilion in the status block itself. A step that costs money (X Premium) is never vermilion, and with no
  next step the page has none. Everything else is glass: other Opens, done steps, Content Rewards' money steps (§38.7's
  own vermilion rules apply on `/money` only), "Save key" and "Connect Whop" (vermilion only when nothing else is
  next and Whop isn't connected).
- **Step cards** are Set up posting's: number in a circle (the optional reading step says "Optional" instead and sits
  right after step 1), an icon, a title of six words or fewer, 1 to 4 lines of 26 words or fewer, then only what the
  step needs: Open (exact https page, new tab, `rel="noopener noreferrer"`), Copy chips, "If you see…" hints and the
  green answer (≥ 48 px) in the step's own words ("I'm in", "I turned it on", "I joined", "X said yes", "I have
  Premium", else "I did this"). **Bold** is the other site's exact label; where nobody saw the screen the step says
  "{Site} may show this a little differently. Look for the same words." A step Clip Factory can see ticks itself and
  says who said so ("YouTube says you're in"). A phone step on a computer says "Do this in the TikTok app on your
  phone." and has no Open. A step that waits for the place carries its `when` line. The first step not done is open
  and scrolled into view; done steps fold to a green tick row that says "You said it's done" or "YouTube says".
  "Each time" steps sit unnumbered under the numbered ones. The ring counts only the numbered steps.
- **Sent to your bank rows**: newest first (at most 36): the date, the amount (formatted by the web, or Google's own
  text when its money type couldn't be read), the state words ("On its way", "Didn't go through. Whop puts it back in
  your balance.", "Came back from the bank."), "by Google" or "by Whop", and the arrive line on the newest. Places with
  no report show their "Not available from TikTok. Look in TikTok: …" line, never $0.
- **The Whop card** (`data-help="getpaid-whop"`, `#whop`, on Content Rewards' page): **See your Whop payouts here**,
  the unnumbered "Make your Whop key" step (Open, two Copy chips, the "Whop key" paste box with its format check
  "Your Whop key starts with app_.", "Save key"), then "Connect Whop". While switched off: "Coming soon: your Whop
  payouts here." with no button.
- **Money's Get paid card** (`data-help="getpaid-card"`, right after All your money, before the Apps band): title "Get
  paid", line "Can money reach you from each place?", one row per place (mark, name, pill) and one glass button at the
  row's right end ("See steps", "See why" or "See more", each to the place page with `?back=/money`). **No
  vermilion**, and no money on it (status only: one job per card). All your money gains the "Sent to your bank" lines
  and the "Sent to your bank, so far" block ([All your money](#all-your-money)).
- **Mistakes are cheap**: "Stop payment reading" and "Stop reading Whop" are 8-second Undo toasts, never a dialog.
  The result of a connection comes back as one calm sentence on the page ("Clip Factory can see your YouTube payments
  now. It checks once a day."), never a red page.
- **Everything else** as every new screen of §38.1: no `cursor:` rule, no edges, `<Glide>` for pick-one bars (the
  Content Rewards **Finance** question), reduced motion, WCAG AA, nothing tappable in a phone's top-left third, every
  page from 320 to 1920 px without sideways scroll, Ask never over the main button.
