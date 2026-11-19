## Typography

Sizes are the tokens in `web/src/styles/tokens.css`; refer to them by name, never by a copied number.

| Role | Font | Size token | Weight / style |
|---|---|---|---|
| Display (Home hero) | `--font-display`: Times New Roman, Tinos, serif | `--fs-display` = `clamp(2.35rem, 1.55rem + 3.6vw, 4.5rem)` | 400, italic words, tight leading 0.98 |
| H1 (page titles, `.display-2`) | `--font-display` | `--fs-h1` = `clamp(1.95rem, 1.45rem + 2.1vw, 3.1rem)` | 400, often italic words |
| H2 (section titles, `.display-3`) | `--font-display` | `--fs-h2` = `clamp(1.45rem, 1.2rem + 1vw, 2.05rem)` | 400, italic words |
| H3 (subheads, e.g. skill text) | `--font-ui`: Inter | `--fs-h3` = `clamp(1.05rem, 1rem + 0.25vw, 1.2rem)` | 700 |
| Body | `--font-ui` | `--fs-body` = 1rem (16 px, never smaller on phones, so iOS does not zoom inputs) | 400, leading 1.5 |
| Small / meta | `--font-ui` | `--fs-small` = 0.875rem | 500–600 |
| Tiny labels (chips, star word) | `--font-ui` | `--fs-xs` = 0.78rem | 600–700 |
| Numbers (stats) | `--font-ui`, `font-variant-numeric: tabular-nums` | per component | 600–750 |

Nothing is set smaller than `--fs-xs`, badges and stickers included (the tab bar and sidebar counts, the sound
**Pick** sticker, the "Like clips that did well" meta line). `web/test/styleFloors.test.ts` fails on any smaller
`font-size`.

The vermilion **swash**: a hand-drawn SVG underline under one or two italic words of a display headline ("Make it
*viral*"). Used once per screen at most.

Both fonts are bundled with the app, never loaded from Google Fonts: `web/src/main.tsx` imports Inter Variable
(`@fontsource-variable/inter`) and Tinos 400 and 400 italic (`@fontsource/tinos`), so they are built into the app and
cached for offline use. Tinos is the metric-compatible twin of Times New Roman, used where Times New Roman is missing
(Android, Linux). The public pages (`about.html`, `legal/*.html`) load no webfonts on purpose; they use the same stacks
(see [CONTRACTS.md §17.3](CONTRACTS.md)).

Relative times use one style everywhere (`relative()` in `web/src/lib/format.ts`; the clip page's `ago()` uses it):
"just now", "3 min ago", "2 h ago", "yesterday", "4 days ago", and ahead "in 5 min", "tomorrow", "in 2 days". Durations
read "6 h 10 min". Neither ever says "60 min" or "24 h".
