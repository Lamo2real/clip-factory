"""Every rule of "learn from results" in one place (docs/CONTRACTS.md §16.12, ADR-40). Change values here only.

Clip Factory checks each post's views 7 days after posting, finds the clips that did far better than that creator's
normal on that platform, looks at what those clips share, and turns it into a lesson for the clip picker. These
numbers decide how sure it has to be before it says anything.
"""

from __future__ import annotations

from datetime import timedelta

# --- the day-7 number (one per post, frozen once) ---------------------------------------------------------------
DAY7_TARGET = timedelta(days=7)  # the reading closest to 7 days after posting is used ...
DAY7_EARLIEST = timedelta(days=6.5)  # ... if it was read no earlier than 6.5 days after posting
DAY7_LATEST = timedelta(days=8.5)  # ... and no later than 8.5 days. Outside this window: missing, for good.
# A post is frozen only once its window has closed, so a later, closer reading can never change the answer.

# --- the winner test (per creator and per platform; platforms are never mixed or added up) ------------------------
BASELINE_DAYS = 90  # the baseline is posts made in the last 90 days that have a day-7 number
MIN_BASELINE = 20  # fewer than 20 baseline posts for this creator: use all creators' posts on that platform instead
WINNER_RATIO = 2.0  # a winner has at least 2 times the baseline median of day-7 views ...
WINNER_Z = 2.5  # ... AND a robust z-score of at least 2.5 on log(1 + views) (median and MAD, see below)
MAD_SCALE = 1.4826  # turns a MAD into a standard deviation for normally spread data
# The MAD of log(1 + views) is never taken below 0.2. With very even baselines (every clip ~1,000 views) the spread is
# close to 0 and any small bump would score a huge z. At the floor the z-test alone needs about 2.1 times the median
# (exp(2.5 * 1.4826 * 0.2) = 2.10), so it is never looser than the 2-times rule; an all-equal baseline names no winners.
MAD_FLOOR = 0.2
# Tiny numbers are noise: with a baseline of zeros, 2 views would pass both tests above. A winner needs at least this
# many day-7 views, and its baseline median must be at least BASELINE_MIN_MEDIAN views, before anything is named.
WINNER_MIN_VIEWS = 100
BASELINE_MIN_MEDIAN = 10
# The "all creators" fallback must not name a big channel's normal clips winners just because the channel is big.
# Each post is first divided by its own creator's median on that platform (so 1.0 = normal for that creator) and then
# scaled to a typical creator's size. A creator needs at least this many other measured posts on the platform to have
# a median worth dividing by; posts of creators with fewer are not judged owner-wide.
POOL_MIN_CREATOR_POSTS = 5
# Each post is judged ONCE, against the baseline as it was when its day-7 number froze, and the verdict is stored on
# the post (day7Verdict). A post that could not be judged within this time after freezing (too few clips then) is
# never judged later, so an old post can never turn into a "new" winner only because the 90-day baseline moved.
JUDGE_WITHIN = timedelta(days=7)

# --- the second look (which traits the winners share) ----------------------------------------------------------
TRAIT_MIN_WINNERS = 3  # at least 3 winners share the trait ...
TRAIT_MIN_SOURCES = 2  # ... coming from at least 2 different source videos (one lucky stream is not a pattern) ...
TRAIT_MIN_LIFT = 1.5  # ... and the trait is at least 1.5 times as common among winners as among the other clips
# The lift needs a real comparison: at least this many other (non-winner) clips must have the same kind of fact (for
# example a known talking speed). Clips made before pacing was stored have none, so right after launch "fast talking"
# can not win against an empty comparison group.
TRAIT_MIN_OTHERS = 10
# An "all creators" lesson goes to every creator's jobs, so its winners must come from at least 2 different creators.
TRAIT_MIN_CREATORS_ALL = 2
NORMAL_SAMPLE = 8  # normal clips shown to the model next to the winners

# --- lessons ----------------------------------------------------------------------------------------------------
CONFIRM_AFTER = timedelta(days=7)  # a "trial" lesson becomes "active" when a run at least 7 days later ...
# ... finds at least one new winner that has the same trait.
ACTIVE_FOR = timedelta(days=90)  # an active lesson (and a trial one) expires 90 days after its last confirmation
MAX_ACTIVE_PER_CREATOR = 5  # at most 5 active lessons per creator; the best supported ones win
LESSON_MAX_CHARS = 240  # one or two short sentences
LESSON_MAX_SENTENCES = 2

# --- the daily run ----------------------------------------------------------------------------------------------
# cf-prod-learn has a 900 s timeout. The run stops starting new work after DAILY_BUDGET_SECONDS and leaves the rest
# for tomorrow. The daily run has its own Bedrock client: each read waits at most BEDROCK_READ_TIMEOUT seconds and is
# tried at most BEDROCK_MAX_ATTEMPTS times, so one model attempt takes at most about 2 x 60 = 120 s. An attempt (the
# first or the one retry) is only started when MODEL_CALL_SECONDS are still left, so the run ends by 720 + 150 = 870 s,
# before the timeout, and the lesson upkeep and the saved status always run.
DAILY_BUDGET_SECONDS = 720.0
MODEL_CALL_SECONDS = 150.0
BEDROCK_READ_TIMEOUT = 60
BEDROCK_MAX_ATTEMPTS = 2
MODEL_MAX_TOKENS = 8000
MAX_OWNER_POSTS = 20_000  # the gsi2 read that finds the owners stops here (one owner; far above real numbers)
