## ADR-31 The weekly best is an explicit owner signal

- **Context.** The owner: "Each week, I will select the ones that perform best during that week, so that it knows how
  to edit better in the future." The app already learns automatically from numbers (the clip flow's `distil`, the
  `performed` vectors), but numbers across platforms are not comparable: YouTube Shorts count replays, Meta's views are
  estimates that settle over two days, X's video views differ from impressions, TikTok shows none while unaudited.
- **Decision.** The owner **stars** up to 10 clips a week in Library › This week (sorted by views to help) or on a
  clip's page. A week is an ISO week in the owner's own time zone; a clip belongs to the week of its first post (else
  the day it was kept). Saving (`PUT /v1/weeks/{week}/best`) writes the picks in one transaction with a `revision` and
  starts `cf-prod-learn`, which marks the vectors `best = true / false` and asks Claude Fable 5.1 for **one** "Best of
  week" learning comparing the picks with the rest of the week. The agent reads the latest 4 week learnings before the
  other 10 learnings, and `best` clips come first in "What worked before".
- **Alternatives.** *Pick the top clips by views automatically* (the owner asked to choose; views are not comparable
  across apps and miss what the owner likes; automatic learning from numbers already exists). *A thumbs up / down on
  every clip* (more taps, weaker signal than "the best of this week"). *Rank all clips of the week* (heavier for a
  child to use; a star is one tap). *A learning per picked clip* (many near-duplicate sentences crowding the prompt;
  one per week compares picks with non-picks). *Learning on a weekly schedule* (the owner may pick late or change
  picks; learning on save is simpler and immediate).
- **Consequences.** The owner's taste outranks raw numbers in what the agent sees. Re-saving replaces the week's
  learning (same `learningId`), unstarring everything removes it, and the `revision` check means a slow older run
  never overwrites a newer save. The picks shape which moments are chosen and how they are hooked and captioned; they
  do not change the editing rules in the skills. The week's boundaries come from the browser, so a week always matches
  the owner's calendar, including the weeks the clocks change (167 or 169 hours).
