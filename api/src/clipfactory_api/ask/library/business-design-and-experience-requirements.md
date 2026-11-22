## Design and experience requirements

### UX-01 Colours
- AC1: Call-to-action buttons are vermilion `#E8392B`, every one of them (owner request 2026-11-18).
- AC2: The rest of the palette is bottle green `#0F372B` (the glass) and bone `#EFE7DA` (the words and the lines).

### UX-02 Liquid glass everywhere
"I want them to be liquid glassy so that you can almost see through the application."
- AC1: Every surface (cards, bars, sheets, dialogs, inputs) is translucent with backdrop blur and a light edge highlight;
  no solid panels.
- AC2: Text on glass meets WCAG AA contrast (4.5:1 for body text) on the default backdrop.
- AC3: Where `backdrop-filter` is not supported, surfaces fall back to a more opaque tint that stays readable.

### UX-03 Layout inspired by the reference site
"Take inspiration from that, how it's all placed and in a cohesive manner."
- AC1: Large serif italic headline on a green hero card, pill buttons, cards in a row, a stat block.
- AC2: The person in the reference image is not used; only the layout, colours and feel are.

### UX-04 Fonts: Inter and Times
- AC1: Display headlines use Times New Roman (fallback Tinos, then serif), often italic.
- AC2: Everything else uses Inter.

### UX-05 Nothing overflows its box
"The text is running out of the box ... Make sure to never let that happen."
- AC1: No text or image crosses the edge of its container at any width from 320 px up.
- AC2: Automated Playwright tests check every screen at phone, tablet and desktop widths.

### UX-06 Phone navigation: icons only
- AC1: Below 768 px wide, a bottom glass tab bar shows icons only (no words), each with an accessible label.
- AC2: Tap targets are at least 48×48 px (raised from 44 by UX-13); the bar respects the phone's safe area.

### UX-07 Desktop navigation: collapsible sidebar
- AC1: From 768 px up, a left glass sidebar with icons and names.
- AC2: A hamburger button (three stripes) collapses it to icons only; the choice is remembered.

### UX-08 Pleasant, "dopamine" feedback
- AC1: Key moments celebrate: Confirm, a job finishing, a skill added. Ordinary clicks do not.
- AC2: Motion is short (under 400 ms for feedback) and respects "reduce motion" (system or app setting).

### UX-09 Two click sounds, never on scroll
- AC1: Clicking an enabled control plays the owner's **click sound** (default 6 "Water drop").
- AC2: Clicking a disabled control, an error toast, or a failed action plays the owner's **error sound** (default
  5 "Nope nope nope"), which sounds clearly different.
- AC3: Scrolling, swiping or dragging on a phone never makes a sound (sounds are tied to the `click` event only).
- AC4: Sounds can be turned off in Settings › Look & feel › Sounds.
- AC5: Changing the pick in Settings changes the sound everywhere in the app at once, with no reload.

### UX-10 Phone, browser and desktop install
- AC1: The app works in any modern browser on phone and computer.
- AC2: It installs as a PWA on the phone home screen and on the desktop (Chrome, Edge, Safari).
- AC3: On Mac and Windows it can also be downloaded as a desktop app (BR-15, NFR-11).

### UX-11 Plain English
- AC1: Every label, message and error is a plain sentence a non-technical owner understands.

### UX-12 Reload that feels fast and fun
"Once you click reload, there should be a nice UI to where it goes fast to 80% or to 70%, and then it's almost like
it's slow in and slow out, but in the middle, it's really quick ... so that the user's dopamine is still being hit."
- AC1: Pressing Reload turns the bar into a progress bar that runs from 0 to 75 % in about 0.8 s on an ease-in-out
  curve: a soft start, a quick middle, a soft landing ([the curve](UX_DESIGN_SYSTEM.md#the-reload-curve)).
- AC2: While the new version installs (service worker update, fresh files), the bar keeps creeping forward slowly; it
  never stops dead and never goes backwards.
- AC3: When the new version is ready, it eases to 100 %, a small sparkle plays, and the page reloads by itself.
- AC4: After 10 seconds it reloads anyway, so the bar can never hang.
- AC5: With reduce motion on, the bar simply fills, with no sparkle.

### UX-13 Kid-proof: a 6–8-year-old can use it
"The entire application should be idiot proof. So even a 6-year-old should be able to use it, or an 8-year-old."
([CONTRACTS.md §12.4](CONTRACTS.md#124-kid-proof-ux-a-68-year-old-must-manage-it), [checklist](UX_DESIGN_SYSTEM.md#kid-proof-checklist))
- AC1: Every screen has one obvious next step: exactly one main vermilion button (the update bar's Reload is the only extra).
- AC2: Tap targets are at least 48 × 48 px on phones.
- AC3: Buttons show an icon **and** a word (the phone tab bar is the one icon-only place, UX-06).
- AC4: Words are short and everyday: "Make clips", "Upload", "Throw away", "Try again". No jargon on screen.
- AC5: Empty screens say exactly what to tap ("Nothing here yet. Tap **Make clips** to start.").
- AC6: No dead ends: every screen has a way forward or back, and every error says what to do next.
- AC7: Throwing something away shows a toast with **Undo** for 8 seconds instead of an "Are you sure?" dialog; the
  action is only carried out when the 8 seconds pass. One deliberate exception: deleting a skill first shows a small
  glass sheet, because a skill can hold a lot of typing (BR-06 AC4); the Undo toast still follows.
- AC8: Forms cannot be filled in wrong: a Paste button next to the link box, the link checked as it is typed, hints
  right under the field, and the main button only active when the input is valid (a click on it before then plays the
  deny sound and points at what is missing).
- AC9: Progress is always visible while something is happening, and success is celebrated (UX-08).

### UX-14 Settings organised like a field of apple trees
"There is a field which is the entire settings, then we have apple trees which has multiple trees, and each tree has
multiple branches, and each branch has multiple apples, but they also have leaves ... so that it is all organized."
([CONTRACTS.md §15.1](CONTRACTS.md#15-settings-as-a-tree-and-choosing-your-click-sounds-owner-request-2026-11-16),
[Settings tree](UX_DESIGN_SYSTEM.md#settings-tree))
- AC1: Settings (the **field**) opens on four **trees**: Clip making, Posting, Look & feel, App & account. Each tree
  holds **branches**; each branch holds **apples** (the things you change), each with a **leaf** (one short line of
  help) unless its name already says it all. No setting sits loose outside a branch.
- AC2: Every tree and branch has its own address (for example `/settings/look-and-feel/sounds`). Opening that address
  directly, reloading, the browser's Back button and bookmarks all land on the same place. The old addresses
  (`/settings#skills` style anchors, `/get-app`, `/settings?account=…&status=…`) keep working.
- AC3: Every tree and branch page shows a breadcrumb (`Settings › Look & feel › Sounds`), each part a link. On phones a
  big Back button goes one level up.
- AC4: Below 1024 px wide, Settings drills down one level at a time. From 1024 px, a folder panel on the left shows the
  whole tree: trees open and close like folders, the current branch is highlighted, and which folders are open is
  remembered on that device.
- AC5: A **Find a setting** box on the Settings page searches every apple, leaf, tree and branch name while you type.
  Picking a result opens its branch, scrolls to it and highlights it. No match says "No setting called that. Try
  another word."
- AC6: The tree, the folder panel and search are kid-proof (UX-13): at most one main vermilion button per screen, 48 px
  targets on phones, plain words, nothing overflows from 320 px, and everything works with a keyboard and a screen
  reader.

### UX-15 Pick your click and error sounds
"Include this entire page in the Clip Factory to allow the ... user of the application to select the normal click and
the error clicks. And I actually like the UI ... and the UX." The owner's picks: "Tap sound: 6 Water drop. Error
sound: 5 Nope nope nope." ([CONTRACTS.md §15.3](CONTRACTS.md#153-sounds), [the picker](UX_DESIGN_SYSTEM.md#the-sounds-branch-the-picker))
- AC1: Settings › Look & feel › Sounds shows the owner's sound picker: 30 numbered click sounds ("When it works") and
  30 numbered error sounds ("When it can't"), each card with its number, name and feel, the same names and sounds as
  the picker page the owner tried.
- AC2: Tapping a card plays its sound and makes it the pick (a "Pick" badge, `aria-pressed`). One pick per group.
- AC3: "Try it: Sign in" plays the click sound with a "Signed in" toast; with **Make it fail** on, it plays the error
  sound with a small shake and "Wrong password. Try again." Nothing is really signed in or out.
- AC4: A pick saves at once and follows the owner to every device; if the save fails, the pick goes back and the app
  says so in plain words.
- AC5: New accounts, and accounts that never picked, use click sound 6 "Water drop" and error sound 5 "Nope nope nope".
- AC6: With Sounds off, the cards say "Sounds are off" with a "Turn sounds on" button, and tapping a card picks it
  without playing anything.
- AC7: The sounds are defined as data (one catalog entry per sound) and played by one player; numbers never change
  meaning, so a saved pick always plays the same sound.

### UX-16 The performance page: the video on top, smooth lines to five stacks
"It should be quite a nice design actually. So we should have the video on top, like the preview of it, the thumbnail
of it, and then there's like ... lines that go, in a smooth manner, leading to each vertical stack of information ...
So maybe 5 lines ... for both the phone resolution and the normal laptop's resolution or PC ... monitors."
([anatomy per screen size](UX_DESIGN_SYSTEM.md#clip-performance-page))
- AC1: The clip's 9:16 video sits on top, centred in a rounded glass frame, with its cover as the poster; it never
  plays by itself.
- AC2: Five smooth curved lines grow out of the bottom of the video, one to the top of each platform stack. They draw
  in once, one after another (80 ms apart, 900 ms each), and the stacks rise in as their line arrives. The best
  platform's line is vermilion, the others green. With reduce motion (system or app setting) the lines are simply there.
- AC3: Laptops and monitors (≥ 1024 px): five equal columns side by side, the lines fanning out from the video and
  ending exactly at the top centre of each stack.
- AC4: Tablets and small laptops (600–1023 px): three stacks in the first row, two in the second, the second-row lines
  running straight down the gaps between the first-row cards, never over a card.
- AC5: Phones (< 600 px): one column of full-width cards; one trunk line runs from the video down the left edge, and a
  small curved branch leads into each card.
- AC6: Nothing overflows at any width from 320 px; numbers never get cut off; labels wrap.
- AC7: Kid-proof (UX-13): the only main vermilion button is **Refresh numbers**; the **Best this week** star is a big green
  toggle; every state has words; the page works with a keyboard and a screen reader (the lines are decoration and are
  hidden from screen readers; each stack is a labelled section).

### UX-17 Set up posting that a child can follow
The owner: "It should be really clear on what to do, the steps, essentially idiot proof. Even an 8-year-old should
be able to do it." ([UX design system](UX_DESIGN_SYSTEM.md#set-up-posting))
- AC1: A step card has a number, a picture-like icon, a title of 6 words or fewer, 1–4 sentences of 15 words or
  fewer with one action each, and the platform's button names in bold exactly as the platform shows them.
- AC2: One main vermilion button per screen: the current step's main action (Open, Save keys, Connect {Platform} or Connect
  again). **I did this**, Copy and Paste are vermilion and at least 48 px tall.
- AC3: Copy shows "Copied!" with a leaf-green tick and works without clipboard permission; a bad key shows what it should
  look like right under the box, and Save keys stays off until the keys look right.
- AC4: Connecting celebrates (confetti, the success sound, the account's picture and name); every other result plays
  the error sound and shows one calm sentence and the step to go back to.
- AC5: Nothing overflows from 320 to 1920 px; phone bottom bar and desktop sidebar as everywhere else.

---

### UX-18 Ask Clip Factory looks and behaves like the rest of the app
([UX_DESIGN_SYSTEM.md](UX_DESIGN_SYSTEM.md#ask-clip-factory))
- AC1: Desktop: a green glass pill **Ask** with a sparkle icon, bottom right, 12 px above the update bar when it shows.
  Phones: a 56 px icon-only glass circle that never covers the tab bar or the update bar and hides while you scroll
  down.
- AC2: The panel is glass, 400 px wide on desktop and a full-screen sheet on phones; it opens with "Hi! What do you
  want to do?" and three suggested questions that fit the page and the device.
- AC3: Only the first button of the newest answer is vermilion; the launcher is never vermilion (green glass).
- AC4: The click sound plays on taps only; a rate-limit or error notice plays the error sound; nothing plays when an
  answer simply arrives.
- AC5: Leaving a page with an unsaved caption edit or pasted link asks "You have a change that isn't saved yet. Leave
  anyway?" with **Stay** and **Leave**; never a scary dialog.
- AC6: The spotlight ring fades over 2.4 s and is a still ring with reduced motion; Escape closes the panel and returns
  focus; it works with a keyboard and a screen reader.
- AC7: Nothing overflows from 320 to 1920 px, with the panel open.

### UX-19 Content Rewards that an 8-year-old can follow
([UX_DESIGN_SYSTEM.md](UX_DESIGN_SYSTEM.md#content-rewards-campaigns), [CONTRACTS.md §38.1](CONTRACTS.md#381-words-and-rules-every-new-screen-follows))
- AC1: Plain short words on every Content Rewards screen ("Join", "Copy", "Paste", "Make clips", "sign in", "allow",
  "per 1,000 views", "clip", "sent"); never "MCP", "OAuth", "token", "scope", "CPM", "submission" or "API" on screen.
- AC2: **Bold** is always the other site's exact label; Clip Factory's own buttons are in quotes; Whop steps say
  "Whop may show this a little differently. Look for the same words."
- AC3: One vermilion button per screen, the next step; on phones it sits at the bottom right while its card is on
  screen. Everything else is glass or green; no edges, no `cursor` changes; pick-one choices slide (`Glide`).
- AC4: A step Clip Factory can see ticks itself; a step it can't see has its own green answer right under its Open
  button ("I have an account", "I added them") and still ticks itself later. Waiting is never a step: Clip Factory
  watches and tells the owner.
- AC5: Every error says what to do next and names the button; every Undo is an 8-second toast; celebrations (confetti
  and the success sound) happen once each and skip motion when reduced motion is on.
- AC6: Brand text is plain escaped text, at most 300 characters a line with **Show more**.
- AC7: Nothing overflows from 320 to 1920 px; targets are at least 44 px (48 on phones); WCAG AA contrast; Ask never
  covers the main button.
- AC8: The names of BR-26 AC3 are the only words for the two ways and for adding an account inside Content Rewards.
- AC9: The fit block keeps one vermilion button per screen: Upload when the clip can go (or can't yet, off, with the
  words why), "Make a {name} copy" or the item's own button when that is the next step; "Fix it for me" and "Read the
  rules" are glass, "Turn on Branded content" and "I read them. They're OK" green. The "could earn" line is glass and
  never takes the vermilion from Upload. A verdict is never colour alone (a mark and words).
- AC10: All your money is a glass card with no vermilion button; each row has at most one glass button, at its right
  end, so nothing tappable sits in a phone's top-left third.

### UX-20 Get paid that a child can follow
([UX_DESIGN_SYSTEM.md](UX_DESIGN_SYSTEM.md#get-paid), [CONTRACTS.md §40.1](CONTRACTS.md#401-what-the-owner-sees))
- AC1: The step cards look and work like Set up posting's: a number, a short title, short lines, Open, Copy, "If you
  see…" and a green answer in the step's own words; **bold** is the other site's exact label.
- AC2: One vermilion button per screen, the next step (pinned at the bottom right on phones); the list and Money's card
  have none; a step that costs money (X Premium) is never it.
- AC3: Plain words: "ID check" (never KYC), "bank transfer" (never EFT), "AdSense for YouTube" (never "AdSense"
  alone), "Whop key"; never "OAuth", "token", "scope" or "API" on screen.
- AC4: A status is never colour alone (an icon and words), "Not set up yet" is never red, and every tone is AA.
- AC5: Every Undo is an 8-second toast; every connection result is one calm sentence that names the button to tap.
- AC6: No edges, no `cursor` changes, `<Glide>` for pick-one bars, reduced motion respected, nothing overflows from
  320 to 1920 px, targets at least 44 px (48 on phones), and Ask never covers the main button.
