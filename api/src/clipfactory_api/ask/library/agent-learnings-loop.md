## Learnings loop

Clip Factory learns from its own results once a day, per creator (the streamer whose stream was clipped) and per
platform ([CONTRACTS.md §16.12](CONTRACTS.md#1612-learn-from-results-creator-lessons-from-day-7-numbers-owner-request-2026-11-18),
[ADR-41](DECISIONS.md#adr-41-learn-from-day-7-numbers-per-creator-and-per-platform)).

1. The stats poller reads every posted clip's numbers for 30 days and keeps snapshots for 90 days. Each snapshot says
   when its views were really read.
2. Every day at 05:00 UTC, `cf-prod-learn` freezes each post's **day-7 number**: the views read closest to 7 days
   after posting, between 6.5 and 8.5 days. No reading in that window means no number, for good.
3. It finds the **winners**: clips with at least 2 times the creator's median day-7 views on that platform and a
   robust z-score of at least 2.5 (at least 20 posts to compare with, else every creator's posts on that platform).
4. **Second look.** Code lists what the winners share (moment type, length, layout, hook length, talking speed, how
   fast the first word comes, score, posting hour). A trait needs 3 winners from 2 different videos and must be 1.5
   times as common among winners. Only then, one Claude call (skills block first) writes a lesson per trait in plain
   words. Every number in a lesson must come from the evidence; every cited clip must be a real winner.
5. **Trying, then using.** A new lesson is only tried. A run at least 7 days later that finds a new winner with the
   same trait makes it active. Active lessons end 90 days after their last confirmation; at most 5 per creator.
6. **Prior learnings.** Each new job gets the active lessons for its creator, then the active "all creators" ones
   ([below](#prior-learnings)).
7. The owner reads, turns off or deletes lessons in Settings › Clip making › What it learned.

The 48-hour clip flow still reads the numbers and marks the clip's vector `performed` (for "What worked before"), but
it no longer writes a one-sentence learning, and older ones are never sent to the agent: one sentence from a handful
of clips was too easy to over-learn from. They stay readable in Library as "Older note".

Until at least one platform is set up in Settings › Posting › Set up posting ([SETUP_POSTING.md](SETUP_POSTING.md)),
there are no posts with numbers, so nothing is learned. Learning is slow on purpose: a creator needs about 21 measured
posts on a platform, and a lesson needs two runs a week apart before the agent uses it.

### Prior learnings

The owner's clipper skill (added in Settings › Clip making › Skills, not in this repository) accepts an optional input
headed **Prior learnings**: plain-text patterns about what has worked for a creator. The agent fills it:

- **What:** active, unexpired creator lessons whose creator is this job's creator (by channel id, or by name for
  older jobs), best supported first, then active "all creators" lessons; at most 10 lines, each pattern once. Trial,
  turned-off, deleted and expired lessons are never included.
- **How:** the exact heading `Prior learnings`, one line saying these are patterns from this creator's past clips that
  did far better than normal, advice and never a rule, then one `- pattern` per line. No ids, no JSON, no numbers
  table.
- **Where:** right after the skills block, before everything else in the task prompt, in every call that picks
  moments or writes hooks: the moment-picking prompt (the Agent SDK prompt file and the Converse fallback), the second
  look against the picture (it keeps, swaps or drops moments and can write a new hook), the checklist review (it can
  write a new hook) and the captions. The two watchers (Fable on frames, Nova 2 Lite on video) only report what is
  seen, so they get none.
- **When empty:** the section is left out entirely (never an empty heading or "none").
