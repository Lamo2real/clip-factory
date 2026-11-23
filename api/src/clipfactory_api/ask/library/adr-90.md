## ADR-90 A series' memory is data kept per series, written by a recap task after each approval

- **Context.** The owner (2026-11-23): "Can you create a folder for each series i create so it is organized and if
  you think it good maybe it could save context from previous videos if they are in the same folder".
- **Options.** (1) Keep it in the workspace memory (MEM#): it would mix series, grow without a bound and fill the
  owner's own memory. (2) Rebuild it from every earlier script for each new idea or video: large prompts and cost
  that grows with each episode. (3) A `SERIES#` item per series with a short story so far and one summary per
  episode, written by a task after each approval, and a bounded slice of it sent to the idea agent and the writer.
- **Decision.** (CONTRACTS §45.43) Option 3. A series is a folder (a name, a line, a cast and a cover) and a place in
  the rail, with an "All ▾" switch on Ideas, Production, Review and Library whose choice lives in the address
  (`?series=`), never in a hidden filter. After an approval, a `series_recap` task (the creative director, routed as
  `text_edit`) writes the episode's summary (≤ 400) and the story so far (≤ 1500, in Who, Places, Running jokes and
  Where things stand), under a version condition; the owner can read and edit it. `series_context` sends the story so
  far, the newest 5 summaries, up to 20 earlier titles and the cast, at most 8000 bytes.
- **Consequences.** An approval never fails because of the recap (it is best effort, and the folder offers "Write it
  again"). Episodes and their numbers are worked out on each read. Deleting a series never deletes a video: its
  videos and ideas move to "No series". No infra: the same table partition, and API Gateway already proxies the
  routes. The series memory never goes into MEM#.
