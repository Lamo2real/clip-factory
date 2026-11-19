## Clip performance page

The owner's picture: "the video on top, like the preview of it ... and then there's like ... lines that go, in a smooth
manner, leading to each vertical stack of information, like how many likes you got, how many views you got ... each
stack is tailored for YouTube ... TikTok ... Instagram ... X ... Facebook." The page lives at `/clips/{clipId}` and is
reached by tapping any clip in Library, or "See how it does" on a kept clip in Review
([CONTRACTS.md §16.8](CONTRACTS.md#168-web), [UX-16](BUSINESS_REQUIREMENTS.md#ux-16-the-performance-page-the-video-on-top-smooth-lines-to-five-stacks)).

The order is always **YouTube, TikTok, Instagram, Facebook, X** (`STATS_ORDER`), on every screen size, in the DOM and
for screen readers. Every other screen that lists platforms (Library card rows, Review caption tabs, Settings › Posting
› Where clips go) uses the same order, from the one constant `PLATFORM_ORDER` in `web/src/lib/format.ts`.

### Anatomy, top to bottom

| # | Part | Spec |
|---|---|---|
| 1 | Header row | Back (secondary pill, arrow + "Back"; returns where the owner came from, else Library) and the clip's hook as the title in serif italic. The title wraps; it is never cut off. |
| 2 | Preview | `<video controls playsinline preload="metadata">` with the cover as `poster`; `aspect-ratio: 9 / 16`; a rounded `.glass` frame, centred. Never autoplays. Without a video URL: the cover image. Width: 280 px (≥ 1024), 240 px (600–1023), `min(100%, 56vh × 9/16)` (< 600). |
| 3 | Stat block | Beside the preview from 1024 px, under it below. The **total views** in the display serif with "views across platforms" and a small "(each app counts views its own way)". The **Best this week** star toggle. The one vermilion **Refresh numbers** button. "Updated 3 min ago" under it. |
| 4 | Lines + stacks | The five lines grow from the preview to the five platform stacks ([below](#the-lines)). |

**Best this week star.** A green glass toggle, star icon + "Best this week", at least 48 px, `aria-pressed`. Pressed: a
filled star and a bone edge; never vermilion, because the page's one vermilion button is Refresh. It is the same pick as the
star in [This week](#this-week-in-library).

**Refresh numbers.** Icon + word. While any platform it started is still `refreshing` it shows a spinner. When every
platform has to wait (`too_soon` or `blocked`), it reads "Next check in 4 min" with `aria-disabled="true"`: a tap
plays the error sound and a toast says when the next check is allowed. A successful refresh needs no toast: the
numbers change in place, and stacks that must wait show "Next check in … min".

### The lines

One `<svg aria-hidden="true">` sits behind the stacks, sized to the page container and redrawn by a
`ResizeObserver`. Start and end points come from `getBoundingClientRect` of the preview and of each stack.

- **Shape.** Each line is one cubic Bézier from the preview's bottom centre `(x0, y0)` to the top centre of its stack
  `(xi, yi)`: `M x0 y0 C x0 (y0 + 0.55·dy), xi (yi − 0.55·dy), xi yi` with `dy = yi − y0`. The handles leave and
  arrive vertically, so every line starts straight down and lands straight into its card: the "smooth manner" the
  owner asked for.
- **Stroke.** 2 px, round caps, `--green-leaf` at 70 % (the app is dark-only, so the same colour under a dark OS setting). The best platform's line is `--vermilion`.
  A 6 px dot at each end.
- **Draw-in.** `pathLength="1"`, `stroke-dasharray: 1`, `stroke-dashoffset` from 1 to 0 over 900 ms with
  `cubic-bezier(0.22, 1, 0.36, 1)`, 80 ms apart in STATS_ORDER, once per page load. Each stack fades in and rises
  12 px as its line arrives. Reduced motion (system or app): the lines are drawn at once, no fade.

### Per screen size

**Laptops and monitors (≥ 1024 px).** Five equal columns (`grid-template-columns: repeat(5, minmax(0, 1fr))`, gap
16 px), at least 96 px of space between the preview and the stacks so the fan reads clearly.

```
                         ┌───────┐   1.2M views across platforms
                         │ video │   (each app counts views its own way)
                         │  9:16 │   [☆ Best this week]  [↻ Refresh numbers]
                         └───┬───┘   Updated 3 min ago
       ╭──────────╭──────────┼──────────╮──────────╮
       │          │          │          │          │
  ┌────┴────┐┌────┴────┐┌────┴────┐┌────┴────┐┌────┴────┐
  │ YouTube ││ TikTok  ││Instagram││Facebook ││    X    │
  │ crown   ││         ││         ││         ││         │
  │ 8.4K    ││ 3.1K    ││ 1.9K    ││ 950     ││ 410     │
  └─────────┘└─────────┘└─────────┘└─────────┘└─────────┘
```

**Tablets and small laptops (600–1023 px).** A 6-track grid (`repeat(6, minmax(0, 1fr))`, column gap ≥ 24 px).
Row 1: YouTube, TikTok, Instagram span tracks 1–2, 3–4, 5–6. Row 2: Facebook spans 2–3 and X 4–5, so their centres
fall exactly at 1/3 and 2/3 of the width, in the gaps between the row-1 cards. Their lines run straight down those gaps
and never cross a card.

```
                    ┌─────┐
                    │video│
                    └──┬──┘
       ╭─────────╭─────┼─────╮─────────╮
       │         │     │     │         │
  ┌────┴────┐    │┌────┴────┐│    ┌────┴────┐
  │ YouTube │    ││ TikTok  ││    │Instagram│
  └─────────┘    │└─────────┘│    └─────────┘
            ┌────┴────┐ ┌────┴────┐
            │Facebook │ │    X    │
            └─────────┘ └─────────┘
  (the Facebook and X lines run down the gaps between the first-row cards)
```

**Phones (< 600 px).** One column of full-width cards (the page's 16 px gutter on each side) with 44 px of room on the
left. A **trunk** leaves the preview's bottom centre, curves to `x = 20 px` and runs down the left edge. Each card gets
a **branch**: from the trunk at the card's top + 28 px, a quarter curve (`C` with 16 px handles) into the card's left
edge at its platform mark. The trunk stops at the last branch. Nothing overflows at 320 px.

```
          ┌─────┐
          │video│
          └──┬──┘
   ╭─────────╯          trunk: down the left edge (x = 20 px)
   │   ┌──────────────────┐
   ├──╮│ YouTube   crown  │   branch: a quarter curve into the
   │  ╰┤ 8.4K views       │   card at top + 28 px
   │   └──────────────────┘
   │   ┌──────────────────┐
   ├──╮│ TikTok           │
   │  ╰┤ 3.1K views       │
   :   └──────────────────┘
   ╰──╮ ... Instagram, Facebook, X (the trunk ends at the last branch)
```

The 600 px and 1024 px switches belong to this page (like the Settings folder panel's 1024 px); the app's own
breakpoints stay as they are.

### A platform stack

A `<section aria-labelledby>` glass card (`--r-md`, padding 16 px, `min-width: 0`), read top to bottom:

1. The platform mark and name; on the best platform a small crown with visually hidden "Best".
2. A status chip: Posted, Posted privately, Waiting for connection, Posting, Failed, Not posted.
3. The big number (tabular figures): views (Facebook: plays; X: video views).
4. Metric rows: icon, label, value. Labels wrap; values never cut. **Only that platform's fields**, and only the ones
   the platform returned (a missing number is left out, never shown as 0):

| Platform | Fast (every check) | Slow group and its note |
|---|---|---|
| YouTube | Views, Likes, Comments | "Updates daily": Engaged views, Watch time, Average view, Average % watched, Shares, New subscribers |
| TikTok | Views, Likes, Comments, Shares | – |
| Instagram | Likes, Comments | "Can take 2 days": Views (the big number), Reach, Shares, Saves, Reposts, Average watch, Total watch, Skip rate |
| Facebook | – | "Can take 2 days": Plays (the big number), First plays, Replays, Reactions (emoji breakdown), Comments + shares, Average watch, Total watch, New followers, Reach (when present) |
| X | Video views, Impressions, Likes, Reposts, Quotes, Replies, Bookmarks, Link clicks, Profile clicks, Watched to 25 / 50 / 75 / 100 % (only while present, the first 30 days) | – |

5. The **sparkline**: a 120 × 32 SVG polyline of views over time, shown from 2 readings, `role="img"` with
   `aria-label="Views went from 1.2K to 8.4K"`.
6. "Updated 3 min ago" (fast numbers); for a slow group also "Insights from 2 days ago".
7. "Open on {Platform}" (new tab, `rel="noopener noreferrer"`) and, when a refresh has to wait, "Next check in 12 min".

Numbers are compact (`Intl.NumberFormat` with `notation: "compact"`: 1.2K, 3.4M), "–" for null, durations as "1:05".

**Calm states** (one plain line, one link button; never an error colour except Failed):

| State | Words | Link |
|---|---|---|
| Waiting for connection | "Connect {Platform} in Settings › Posting › Set up posting." | `/settings/posting/setup/{platform}` |
| Not posted | "Not posted here. Turn on {Platform} in Settings › Posting › Where clips go." | `/settings/posting/where` |
| Posting | "Posting now…" with a small spinner | – |
| Posted privately (TikTok) | "Posted privately. TikTok shows numbers after the app is approved." | – |
| Posted, no numbers yet | "Numbers are on the way. Check back in a few minutes." | – |
| Failed | "Posting failed: {reason}. Go to Library and press Try again." (`--vermilion-ink` text) | Library |

**Live.** A `post` event for one of this clip's posts replaces that stack's numbers and adds a sparkline point; a
`clip` event updates the star; a reconnect or a `partial` event refetches the page. With no live connection the page
refetches every 60 s.

### This week in Library

- Two pill tabs at the top of Library: **All clips | This week** (`/library`, `/library?view=week`,
  `/library?view=week&week=2026-W45`).
- Header "This week · 10–16 Nov" (or "Week of 3–9 Nov") with ‹ and › arrow buttons ("Earlier week", "Later week"); ›
  is `aria-disabled` on the current week (a tap only nudges it, with the info toast and no sound). Below 360 px the
  dates take their own line under "This week" and the "·" is hidden from the eyes (screen readers still hear it), so
  no dot hangs at a line end; at any wider width a no-break space ties the "·" to the dates, so a wrap moves them
  together.
- A status line under the header: "Star the clips that did best this week." → "Learning from your picks…" (spinner)
  → the learning in a green glass quote labelled "Best of week". On failure: "Could not learn this time. Change a pick to
  try again."
- One card per clip, sorted by views: rank number, cover, hook (2 lines), total views (or "Not posted yet"), a row of
  five tiny platform marks with their views, and the big **Best this week** star (≥ 48 px, `aria-pressed`). Tapping
  the card (not the star) opens the clip's performance page. Below 380 px the star moves to its own full-width row
  under the card (still ≥ 48 px tall) so the hook and views get the width; the views number and the word "views"
  never split over two lines.
- Starring is instant (optimistic) and saved once, 800 ms after the last tap, with the toast "Saved. Clip Factory will
  learn from your picks." A failed save puts the stars back and says so in plain words. Up to 10 picks a week (the
  API refuses more with "Pick clips from this week only." for clips of another week).
- Empty week: "No clips this week yet. Make clips on Home." with a link to Home.
- No vermilion button on This week: starring is the action, and it saves by itself.
