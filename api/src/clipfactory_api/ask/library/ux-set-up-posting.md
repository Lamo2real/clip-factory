## Set up posting

The setup list and the five platform pages
([CONTRACTS.md §17.1](CONTRACTS.md#171-what-the-owner-sees), [UX-17](BUSINESS_REQUIREMENTS.md#ux-17-set-up-posting-that-a-child-can-follow),
the steps in [SETUP_POSTING.md](SETUP_POSTING.md)).

- **The list** (`/settings/posting/setup`): a big ring "2 of 5 ready" in Times (the ring at the card's right edge at
  every width, in line with the cards below), then five big glass cards in the order
  YouTube, TikTok, Instagram, Facebook, X: platform mark, name, a small progress ring, one state line ("Ready", "Step
  7 of 23", "Needs you: connect again", "Not started", "Works now, posts stay private", "Skipped"). Leaf: "Do each
  one once. After that Clip Factory posts by itself."
- **A platform page**: mark, name, ring, "About 20 minutes · Free" (X: "Costs a little"), "Steps checked on 16 Nov
  2026" (the date never splits across lines). Below 600 px the mark and the ring share the hero's top row (ring on
  the right) and the words sit under them at full width. Then the four parts as glass sections (Get ready, Make your {Platform} key, Connect, Go public). Step numbers
  run on across the parts. The first unfinished step is open and scrolled into view; finished steps fold into a green
  tick row that opens again on tap. Below the parts, **When it's done**: the account's picture and name, **Check it**,
  **Connect again**, **Disconnect**, and the platform's own settings (YouTube "Who can see your clips", the X spend note).
- **A step card**: number in a circle, an icon, a title (≤ 6 words), 1–4 short sentences, platform button names in
  **bold** exactly as the platform writes them, then only what the step needs: **Open {site}** (new tab), **Copy**
  chips (label plus the value in a mono font; "Copied!" with a leaf-green tick), paste boxes with **Paste** and a format check
  under the box, the TikTok upload box, "**If you see** … do …" hints, and **I did this** (green, ≥ 48 px).
- **Colour**: one main vermilion button per screen, the current step's main action (Open, else Save keys, else Connect
  {Platform}, else Connect again when a token has died). Every other action wears the same vermilion; everything else is glass. Error results never turn the
  page red: a calm glass card with one sentence and the step to go back to.
- **Delight**: Connect comes back with confetti (skipped with reduced motion), the success sound and a big card
  "Connected as **@name**" with the avatar while the ring fills. Saved keys and a good **Check it** get a leaf-green tick and
  the success sound.
- **Mistakes are cheap**: Disconnect is an 8-second "Disconnecting YouTube… Undo" toast, never a dialog. Keys stay
  saved, so **Connect again** is one tap.
- **The floating setup list** ([CONTRACTS.md §17.13](CONTRACTS.md#1713-the-floating-setup-to-do-list-owner-request-2026-11-16))
  replaces the old Home card, so there is only ever one list. It is on every signed-in page except the setup pages
  themselves, until each platform is ready or skipped.
  - **Rows**: one per platform, in the usual order: the mark (with a leaf-green tick once ready), the name, one line
    ("Ready" / "In progress: 4 of 23" / "Not started" / "Skipped" / "Needs you: connect again") and two buttons,
    **Set up** (glass) and **Skip** (quiet; **Un-skip** once skipped). A ready row has no buttons. Every row that is
    not ready can be skipped, so skipping each one always ends the list.
  - **Skip asks first**, in the small glass question: "Skip TikTok? You won't post there until you set it up. You can
    do it later in Settings." **Keep it** comes first, has the focus and is the vermilion button (the safe answer is the
    strong one); **Skip TikTok** is plain glass with no motion. Escape and a tap outside mean Keep it.
  - **From 1440 px** it stays open in a 304 px column of its own at the top right, glass like the sidebar. The page
    gets narrower instead of being covered, and keeps at least the room it has in a 1100 px window, so no two-column
    layout is squeezed (that is why the column does not open sooner). **–** folds it to the pill (remembered on this
    device). On a short window it packs tighter, so all five rows and their buttons show at once: under 900 px tall
    the head loses its second line, under 820 px the line under the rows goes too. Shorter still (about 690 px), the
    rows scroll and the bottom fades out to show there is more.
  - **Below 1440 px, folded, and on a clip's page** (which needs its whole width): a 48 px glass pill, ring + "Set up
    posting" + "2/5" (the words stay at 320 px too), in a strip the page leaves free at the top (phones: above the
    brand row; the tab bar stays free). Once the page scrolls, a glass bar sits behind the pill and the page slides
    under it, so the pill is on screen at every scroll position and never on a control. Tapping it drops the list
    down as a glass panel over a light scrim (phones: full width, stopping above the tab bar; wider: 380 px at the
    right). The panel is a real dialog: the page behind it cannot be reached, Tab stays inside, and ×, Escape or a tap
    outside close it.
  - **All set!** When every platform is ready or skipped: a green glass card "**All set!**" with a line that says how
    it ended ("Every place is ready." / "Done for now. Skipped ones wait in Settings." / "All skipped. Set them up any
    time in Settings."), confetti and the success sound (no confetti with reduced motion), then it slides off to the
    right. It comes back by itself when a platform needs you again.
  - **Glass only**: the column, the pill, the bar, the panel and the "All set!" card are `.glass` surfaces that take
    their tint from `--glass-tint` like every other panel; none paints a background of its own, so a new glass look
    reaches the list without touching it. Hover lights the glass up; the cursor never changes.
  - **Steady**: on a device that has seen the list, its room is kept from the first paint, so the page does not jump
    when the list arrives a moment later. The Ask pill keeps its corner under the open column (14 px below it) at
    every scroll position; it never rests on one of the list's buttons.
  - **Settings › Posting › Set up posting** always has every platform and the line "On your screen: 2 of 5 done" (or
    "All done: the list is gone"). Inside each card, below a gap: "Want to do it later?" with **Skip** (the same
    question), or, once skipped, "You won't post to TikTok until you set it up." with **Un-skip**; the card's state
    line then says "Skipped". Cards in one row are the same height.
- **Overflow**: long values (redirect URIs, client ids) wrap inside their chip (`overflow-wrap: anywhere`), never
  widen the card; every page fits from 320 to 1920 px.
