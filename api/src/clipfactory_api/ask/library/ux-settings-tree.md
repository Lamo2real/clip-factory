## Settings tree

The owner's picture: "there is a field which is the entire settings, then we have apple trees which has multiple
trees, and each tree has multiple branches, and each branch has multiple apples, but they also have leaves ... so that
it is all organized." Settings is built exactly like that, and every setting has one place in it. The contract is
[CONTRACTS.md §15](CONTRACTS.md#15-settings-as-a-tree-and-choosing-your-click-sounds-owner-request-2026-11-16).

| Word | What it is on screen | Example |
|---|---|---|
| **Field** | All of Settings, the page at `/settings` | Settings |
| **Tree** | One of four big groups, its own page | Look & feel |
| **Branch** | A section inside a tree, its own page | Sounds |
| **Apple** | One thing you can change: a switch, a picker, a button | Click sound |
| **Leaf** | One short line of help under an apple or a branch | "Sounds only play when you tap, never when you scroll." |

### The map

Every tree and every branch is a real address, so a link, the browser's Back button and a bookmark all work. Branch
addresses sit under their tree: `/settings/look-and-feel/sounds`.

```
Settings                                   /settings
├── Clip making                            /settings/clip-making
│   ├── Clips          How many clips, Longest video
│   ├── Skills         Your skills (read, edit, delete; always used), Add a skill (write or upload)
│   └── YouTube help   YouTube cookies: add, remove
├── Posting                                /settings/posting
│   ├── Set up posting the five setups (YouTube, TikTok, Instagram, Facebook, X), "n of 5 ready" (was Accounts)
│   └── Where clips go the platforms to post to (at least one)
├── Look & feel                            /settings/look-and-feel
│   ├── Sounds         Sounds on/off, Click sound, Error sound, Try it
│   ├── Motion         Reduce motion
│   └── Background     What's behind the glass (See-through, Picture, Colours), Glass strength, Background picture (this device only), Background colours
└── App & account                          /settings/app
    ├── Get the app    the install card for this device
    ├── Updates        this version, Check for updates
    └── Account        signed-in email, Sign out
```

Branch slugs: `clips`, `skills`, `youtube`, `accounts`, `where`, `sounds`, `motion`, `background`, `get-the-app`,
`updates`, `account`. Old addresses keep working: `/settings#skills` style anchors redirect to their branch, `/get-app`
shows the same install card, and `/settings?account=…&status=…` (the OAuth return) still shows its message.

**Where a new setting goes.** Pick the tree by *what the owner is doing* (making clips, posting them, how the app
looks and sounds, the app itself), then the branch by *the thing it changes*. A new setting never sits loose on the
field or on a tree page; if no branch fits, add a branch. A branch with one apple is fine. Every apple gets a leaf
unless its name already says it all.

### What each level looks like

| Level | Layout |
|---|---|
| **Field** `/settings` | Serif title "Make it *yours*." (the word *yours* in italic) with the lede "How your clips are made, where they go, and how the app looks and sounds.", then a **Find a setting** search box, then the four trees as big glass cards in the card grid: icon, name, one line (for example "How your clips are made."), then how many apples it holds and its branch names ("… settings · Clips, Skills, YouTube help"). |
| **Tree** | Breadcrumb, the tree's title, its branches as glass cards: icon, name, one line. |
| **Branch** | Breadcrumb, the branch's title, its apples as rows grouped in glass panels. Each row: the label on the left, the control on the right (below it on narrow phones), the leaf under the label in `--ink-2` small text. |

- **Breadcrumb on every level:** `Settings › Look & feel › Sounds`, each part a link, the last one `aria-current="page"`.
  It truncates from the left on narrow screens, never wraps the page sideways. Below 768 px it is always one row:
  only the last three levels show, after a "…" when there are more (the Back pill goes up a level), and a name that
  still does not fit ends in "…", the levels above the current page first. Every shown part stays a 48 px target.
- **Back:** phones get a big secondary **Back** pill (arrow icon + "Back", 48 px tall) at the top of every tree and
  branch page; it goes one level up, not browser-back, so it never leaves Settings by surprise.
- **One main vermilion button per screen at most.** Most branches have none: switches and pickers save by themselves. The
  Sounds branch's vermilion button is "Try it: Sign in".
- **Saving:** every apple saves the moment it changes (optimistic, like the Sound switch); a failed save puts the
  control back (it reloads the saved settings), plays the error sound and shows the app's friendly error message for
  what went wrong (`friendlyMessage`), in a vermilion toast. The owner just taps again to retry.

### Phone and desktop

| Width | How you move through the tree |
|---|---|
| < 1024 px | **Drill down.** The field shows the trees; tap a tree to see its branches; tap a branch to see its apples. Back and the breadcrumb go up. One level on screen at a time. |
| ≥ 1024 px | **Folder panel.** A left glass panel inside Settings (beside the app sidebar) shows the whole tree; the content of the chosen level sits on the right. |

**The folder panel** (≥ 1024 px):
- Each tree is a folder row (chevron, icon, name). Clicking it opens or closes the folder like a file browser; the
  branches inside are links. Opening a tree's page also opens its folder.
- The current branch (or tree) uses a bone pill and the small vermilion dot, like the app's sidebar, with
  `aria-current="page"`. On a tree's own page that is the tree's folder row (a button, so it carries
  `aria-current="page"` itself); exactly one row in the panel is current on every Settings page.
- Which folders are open is remembered on that device (`localStorage`, wrapped so a private window still works); on a
  first visit only the current tree is open.
- It is a `nav` labelled "Settings sections"; folders are buttons with `aria-expanded`. Arrow Up and Down move between
  rows, Right opens a folder, Left closes it, Enter follows a link.
- Panel width 260 px, its own scroll if the tree is taller than the screen; names truncate with a tooltip.
- The 1024 px switch is Settings' own breakpoint, chosen so the app sidebar, the folder panel and a comfortable content
  column fit side by side; the app's general breakpoints are unchanged.

### Find a setting

- One pill search box at the top of the field (and at the top of the folder panel on desktop), labelled
  "Find a setting", placeholder "Try “sound” or “skills”", a magnifier icon and a clear (×) button.
- It searches every apple and every leaf by name, and also tree and branch names, ignoring case and accents, while
  you type. "sound", "click", "beep" all find the Sounds apples (each apple may carry a few extra everyday words).
- Results list under the box: the apple's name with its place under it (`Look & feel › Sounds`). Tapping a result
  opens that branch, scrolls to the apple and highlights it for 2 seconds: a deep-green wash with a vermilion edge
  and a soft inner glow that swells once and settles, drawn exactly on the panel's own lines. An apple alone in its
  panel lights the whole panel along its border and corners, whatever else the panel holds (Try it's picks, a note); in a panel of several, its row lights from the panel's
  left edge to its right edge between the dividers, taking the panel's top corners when it is the first row and the
  bottom corners when it is the last (a divider closes the last row when something follows it). Never a ring outside
  the panel. The keyboard focus ring of an apple follows the same lines (bone inside vermilion), instead of the page's
  own ring; in forced-colors mode a system-coloured outline shows instead. With reduced motion the light simply shows.
- Nothing found: "Nothing found for “<what you typed>”. Try a shorter word, like “sound”." Never an empty box.
- The list is a `listbox` linked to the box; Up and Down move, Enter opens, Escape clears.
