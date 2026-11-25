## 50. Library: sort the clips (owner request, 2026-11-25)

Owner: "filter or sort the videos by something ... most relevant or most popular or from low to high in views or from
high to low ... on all, on not posted yet, and on posted ... follow the theme ... not a button ... slow in, slow out,
but the middle is fast ... phone and laptop." ADR-102.

- **S1. The sort.** A **Sort by** line at the right of the All / Not posted yet / Posted bar (its own row, at the left,
  on a phone). Four choices: **Most relevant** (the list as it came, newest first: the default), **Most popular**
  (likes, comments and shares, views break ties), **Views: high to low**, **Views: low to high**. It sorts inside the
  filter. It lives in the address (`?sort=popular|most|least`, next to `?show=`), so Back and a reload keep it.
- **S2. Not a button.** A caption, the pick and a chevron, no fill; a hairline grows under the pick on hover and
  while open. The list is the app's own (`components/Dropdown.tsx`, `variant="sort"`), glass like every menu, with a
  tick on the pick, opens below (above where there is no room) and is all in sight above the tab bar.
- **S3. Motion.** One curve opens and closes it, `--ease-unfold` (slow in, fast in the middle, slow out): it unfolds
  from its top edge in 420 ms and folds away in 340 ms, the choices follow one after another. Calm motion: no travel.
