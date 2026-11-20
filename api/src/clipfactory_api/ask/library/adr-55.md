## ADR-55 The live status line: a small item of its own, from fixed templates

- **Context.** The owner wants the line under a job's progress bar to show, in real time and in one line, what the job
  is running right now, "commands or whatever it might be" (CONTRACTS §31). Until now the line was the job's `note`
  (§30), set only when a job was picked up again, and the step messages changed a few times per step.
- **Options.** (1) Write the line into the job item: every second would rewrite several KB (the `steps` array) and send
  that over every socket, 3 to 5 times the write units. (2) Show the real command lines: they hold paths, signed
  links and cookie files, and mean nothing to the owner. (3) A small `JOBLIVE#` item per job, filled only from fixed
  templates with number slots, throttled to one write a second when the words change.
- **Decision.** Option 3. The agent's `LiveStatus` fills templates from yt-dlp and ffmpeg progress, part counts and
  model calls, scrubs every value once more, and writes at most once a second plus a 30-second refresh, best effort.
  The broadcast carries it as `jobLive` with an allow-list of fields and a hash of the session (`run`) so the web can
  drop a line of an older run. Page loads get it attached to working jobs. The "commands" are a tiny monospace line
  such as `ffmpeg · 1080×1920 · 30 fps` or `Claude Fable 5.1 · thinking`, never a real command.
- **Consequences.** The line moves about once a second while a job runs, for well under a cent per job-hour. Nothing
  new polls. The stream filter gains one prefix in place (no replacement), and the item expires on its own by TTL, so
  no data of the owner's is touched. A screen reader hears only step and clip changes. The same line can later feed
  phone notifications without new agent work.
