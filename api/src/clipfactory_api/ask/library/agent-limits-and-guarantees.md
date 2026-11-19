## Limits and guarantees

- Between `clipTarget.min` and `clipTarget.max` clips (defaults 5 and 10). Fewer only when the source does not
  contain enough good moments; the job says so.
- Clips are 20–45 seconds unless a skill says otherwise.
- The source is capped at `maxSourceHours`.
- **No cost ceiling** (the owner's decision, 2026-11-17): the deep analysis watches the whole source with the best
  signals and never trades coverage for money. What a job is expected to cost is in
  [ADR-40](DECISIONS.md#adr-40-watch-the-whole-video-before-picking).
- **Technical limits of the deep analysis** (never a money limit):
  - Disk: the picture download must leave 3 GB free, measured before it starts (`shutil.disk_usage`); the downloaded
    file is deleted once the parts are cut, and the local parts are deleted before render.
  - Requests: a Fable chunk is 75–108 images, sent whole first. AWS's documents disagree on how many images one
    request may carry (the Converse API reference says 20 per message; the user guide says Bedrock sets none and the
    model's own limit applies), so a request refused for its images or size is split, again and again if needed, and
    the accepted number (`Bedrock.image_limit`) is used for every later chunk and the second look (whose frames are
    thinned evenly to it). A part sent to Nova is at most 18 MB (Nova takes 25 MB, and boto3 sends it base64-encoded,
    4/3 larger), and a larger part is encoded smaller once.
  - Parallel work: 8 Fable chunks, 4 Nova parts, 4 second looks and 2 frame grabs at a time. Model calls run in their
    own pool of 16 threads, so the heartbeat writes never queue behind them.
  - Time: the picture gets `max(20 min, a third of the source's length)` to be ready (the same limit its ffmpeg pass
    has), the two watchers together `max(25 min, a fifth of the source's length)`, the second look 15 minutes. What is
    done by then is kept. A tall (over 720p), long (over 45 min) upload is decoded at every frame when a 60-second
    timed probe says it fits in 70% of that limit, else at its keyframes only.
  - **Busy services**: a chunk or part turned away as busy (after `retry.py`'s own tries) is tried again after a
    growing pause (5, 10, 20, 40, 60 s), six tries in all, while the deadline allows; each track halves its calls in
    flight on a throttle (never below one) and adds one back after as many successes in a row. Logged as
    `fable.try_again`, `nova.try_again` and `deep.slow_down`.
  - **Runaway guard**: the plan (chunks, parts, moments) is computed before the first call, and each track may make
    at most about three times that many calls (`3 × chunks + 8`, raised to `3 × chunks × requests per chunk + 8` when
    a chunk must be split; `3 × parts + 8`; `3 × moments + 4`), with at most 400 chunks. A throttled call is not
    counted (nothing was done). Passing a bound stops that track, keeps what it has and logs `deep.guard_tripped`.
    Splitting always ends (each request is smaller than the one it came from), and the watch step never raises a
    retryable error, so the job's own step retries cannot repeat finished work.
- `CF_DEEP=off` switches the picture download, the Watch step, the second look and the speaker labels off without a
  code change; the finder's prompts are then exactly the ones before ADR-40 (tested). Three small changes stay on
  either way: a clip with no word inside it is not pause-trimmed, the captions check passes a clip with no speech, and
  a clip can still say why it was picked from the loudness and the most-replayed peaks.
- The agent never invents content: hooks and captions describe what is in the clip.
- Only clip content the owner has the rights to, or is in an official campaign for (the playbook's rules).
