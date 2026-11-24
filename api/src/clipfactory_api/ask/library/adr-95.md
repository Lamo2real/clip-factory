## ADR-95 An owner's script is staged, never written: a faithful adapter, a code check and a report-only fact check

- **Context.** The owner (2026-11-24), about Clips Funded: "i also want the option to write my own script ... of
  what happens". Until now the AI wrote every story (an idea, then Write the story). The owner wants a clear option to
  write what happens and to get a video made from their script: their events in their order, their characters and
  cars from the cast, their words on screen as written (the videos have captions and no voices), and the series'
  memory. The AI may only fill what the engine needs. The AI path stays as it is, and stays the default. ADR-74
  (safety videos only from checked guidance) still holds, and an 8 year old must be able to use it.
- **Options.** (1) Send the owner's text to the writer as a brief: the writer would rewrite it, which is exactly what
  the owner does not want, and nothing would prove it kept the script. (2) A new "stage" task kind and model setting:
  new config, API, web and resolve cases for what the existing "Plan the animation" task already is. (3) A structured
  script (2 to 12 scenes of "What happens" and an optional caption, with who and where) staged by a faithful adapter
  on `animation_plan` whose schema has no words on screen; code puts the owner's captions in as `w_sN` cues and a
  code check proves the order, the cast, the place, the words and that every piece of each scene is tied to something
  drawn, with nothing added beyond small fillers; the fact check reports and never rewrites.
- **Decision.** (CONTRACTS §45.46) Option 3. Production › New's idea Pick gets a third choice, **Write it myself**
  ("Use an idea" stays the default): a scene list with counters, ↑ ↓ ✕, Paste a script, who and where read from the
  words, one plain question for an unknown name ("Who is Max?"), and a "Your video" strip. `ownScript` is an optional
  field on POST and PATCH stories and on the `STORY#` item; the API gives the scene ids, refuses a value over its
  limit with a kid sentence and never cuts it. The agent's adapter gets one more try when the check fails; then the
  job stops with an honest sentence naming the scene, and nothing is saved. Check the facts still runs (a topic
  matched from the owner's words for every kind, so a script that teaches safety is always checked): the owner's
  events, captions and beats are only reported ("Your scene 2 …"), only the AI's post captions are fixed, and the
  video cannot be approved until the check passes; Fix the words opens Change my script at that scene. Review's Ask
  for changes becomes Change my script, with no note box. A caption-only change re-runs only the caption steps.
- **Consequences.** With no `ownScript` every path is byte for byte as before. No new route, task kind, table,
  index or Terraform change, so no owner data is touched; old stories have no `ownScript` and read as before. The
  engine now counts a caption's and a title's length in letters (code points, as the API does), so a 60-letter
  caption with emoji is never refused; ASCII text counts the same, so no old script changes. Code cannot prove that a
  beat really "shows" its piece of the text (a report-only final look over the owner's scenes is a follow-up), and
  any change to what happens stages every scene again.
