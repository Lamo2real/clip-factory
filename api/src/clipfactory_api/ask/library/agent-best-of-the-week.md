## Best of the week

The owner's words: "Each week, I will select the ones that perform best during that week, so that it knows how to edit
better in the future." Raw views are a weak teacher (each app counts views differently, YouTube Shorts count replays,
Meta numbers settle over two days), so the owner's own stars are the strongest signal the agent gets
([ADR-31](DECISIONS.md#adr-31-the-weekly-best-is-an-explicit-owner-signal),
[CONTRACTS.md §16.6–16.7](CONTRACTS.md#166-weekly-best-learning-lambda-cf-prod-learn)).

1. **The owner stars clips** in Library › This week (or with the star on a clip's performance page): up to 10 a week,
   sorted by views to help. Saving starts the Lambda `cf-prod-learn` (not the agent runtime).
2. **The memory is marked.** Each starred clip's vector gets `best = true`, each unstarred one `best = false`. New
   vectors start with `best = false` (finalize).
3. **One learning per week.** Claude Fable 5.1, with the owner's skills block first in its instructions, reads every
   clip of that week as a row (picked or not, hook, moment
   type, length, layout, score, YouTube title, the start of the TikTok caption, views, likes, comments and shares per
   platform, total views) and writes one plain learning of 1–3 short sentences, for example "Your picks open on the
   loudest second and stay under 25 s; skip slow build-ups even when they got views." It is stored as a Learning with
   `kind "week"` and the title "Best of week 2026-W46"; saving new picks for that week replaces it, and unstarring
   every clip removes it.
4. **The next job uses it.** Before choosing moments the agent reads:
   - the latest 4 week learnings, under "The owner's best-of-week picks taught" (after "Prior learnings", when there
     are any);
   - "What worked before" in two queries merged: clips marked `best` first, then other measured (`performed`) clips,
     up to 8 without duplicates (fewer than 3 hits tops up with any of the owner's clips). A `best` clip is labelled
     "Owner's pick: best of the week".
5. **It shows.** The week's learning appears in This week under the header, and on the Insights screen with the others.

What the picks change: which moments are chosen, how they are ranked, and how hooks and captions are written. They
never override the owner's skills or the rules above (never publish, only clip what is in the source), and they are
advice to the agent, not a rule. If the vectors or the learning cannot be read, the job carries on without them.
