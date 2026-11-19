## ADR-41 Learn from day-7 numbers, per creator and per platform

- **Context.** The owner wants Clip Factory to learn from its own results: about 7 days after posting some clips do
  far better than normal, and new clips should lean toward what those clips share. It must learn per creator (the
  streamer whose stream is clipped), never over-learn from a handful of clips or from luck, never make up numbers, run
  on its own and cheaply, and the owner must be able to read and undo every lesson. The one-sentence 48-hour learning
  (clip flow `distil`) did the opposite: one model sentence after each clip, from whatever few posts were measured,
  fed straight to the picker.
- **Decision.**
  - *One number per post, frozen at day 7.* The reading closest to 7 days after posting, read between 6.5 and 8.5
    days, chosen by when the views were really read (`viewsReadAt`), never interpolated. Missing stays missing.
  - *Per platform.* Each app counts views its own way (Shorts count replays, Meta settles over two days, X counts
    plays of the video), so a post is only ever compared with posts on its own platform, and platforms are never added.
  - *Median and MAD on log(1 + views).* View counts are heavy-tailed: one viral clip moves a mean and a standard
    deviation so much that nothing else stands out. The median and the median absolute deviation ignore a few
    outliers, and the log scale makes "twice as many" the same step for small and big creators. A winner needs both
    2 × the median and a robust z ≥ 2.5; the MAD is floored at 0.2 so a very even baseline does not turn a small bump
    into a winner, and tiny numbers never count (at least 100 views against a median of at least 10). At least 20
    baseline posts, else the owner-wide baseline, else no winners. In the owner-wide baseline every post is first
    divided by its own creator's median, so a bigger channel's normal clips are never winners just for being bigger.
    Each post is judged once, when its day-7 number freezes, and the verdict is stored: a later shift of the 90-day
    baseline never turns an old post into new evidence.
  - *Code finds the pattern, the model only words it.* A trait must be shared by ≥ 3 winners from ≥ 2 source videos (two
    jobs of one stream are one video), be compared with ≥ 10 other clips that have the same kind of fact, and be ≥ 1.5 ×
    as common among winners; an "all creators" trait needs winners from ≥ 2 creators. One Claude call per creator with new winners writes the lesson; every number in
    it must be one from the evidence and every cited clip a real winner, else one retry, then it is dropped.
  - *Trial, then active.* A new lesson is only tried (not given to the picker) until a run at least 7 days later
    finds a new winner with the same trait, so one lucky week cannot steer the picker. Active lessons expire 90 days
    after their last confirmation, at most 5 per creator.
  - *Where lessons go.* Active lessons for the job's creator, then active "all creators" ones, go under the exact
    heading "Prior learnings" right after the skills block into every call that picks moments or writes hooks: the
    finder (Agent SDK and fallback), the second look against the picture
    ([ADR-40](#adr-40-watch-the-whole-video-before-picking): it keeps, swaps or drops moments and can write a new
    hook), the checklist review and the captions. The watchers that only report what is seen get none. No active
    lesson, no section.
  - *The 48-hour learning left the picker.* It is no longer written or sent (the clip flow keeps its step name for
    replays, its metrics and its vector marking); older ones stay readable on Insights as "Older note". The owner's
    best-of-week learnings stay: they are an explicit owner signal (ADR-31).
  - *A deleted lesson stays deleted.* The design allowed "unless the owner turns learning back on for it", but there
    is no such control: a delete is final for that creator, platform and trait, and the delete question says so
    ("Clip Factory will stop using it and will not learn it again"). The owner can ask for an "unblock" later; until
    then this is the rule.
  - *Cheap.* One daily EventBridge rule on the existing `cf-prod-learn` (no new function, no new table, no Scan); no
    new winners means no model call.
- **Alternatives.** *Comparing against all platforms together or summing views* (mixes incomparable counts). *Mean and
  standard deviation* (one viral clip hides every other winner). *A fixed views threshold* (wrong for every creator
  but one). *Letting the model read all clips and say what works* (it finds patterns in noise and invents numbers).
  *Keeping the 48-hour learning next to the lessons* (two voices, one of them over-learning). *A new Lambda or a Step
  Functions workflow* (more to deploy for a few seconds of work a day).
- **Consequences.** A creator needs about 21 measured posts on a platform before its own baseline is used, and a
  lesson needs at least two daily runs a week apart before it reaches the picker, so learning is slow on purpose.
  "Creator" is defined in one place (`creators.py`); uploads are learned only owner-wide. Disconnecting YouTube deletes
  its day-7 numbers and the lessons built on them. The `cf-prod-learn` timeout rose from 300 to 900 seconds (changed
  in place).
