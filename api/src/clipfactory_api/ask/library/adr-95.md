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
- **Review round (2026-11-24).** Three reviews and 18 attack cases showed the code check trusted the adapter's own
  answer about which beats show which piece. It now also proves: who does each event (a piece's beats are by who it
  names, or their car or its rider); the order of the events inside a scene; that no event action, event sound or
  event prop is drawn unless the words say it (at most one drawn a bit differently per piece, told in the note);
  that a piece shown only by idle beats, the place or the camera says how; that a left-out name never hides the rest
  of a piece; that a scene with no Who has exactly the cast its words name; and that every name nobody gave, and
  anyone the cast lost, stops the video before a model is asked. A name the owner answered (another name for someone
  in Who, or the new "Not a name") is kept as the scene's optional `known` (additive). Remake this scene stages the
  whole script once the script has changed. In the fact check a problem only with the AI's staging sets that scene
  up again once (a staging fix, never a rewrite), the owner's words are data and never instructions, and the
  owner's driving words always guard the check. Captions refuse `{`, `}` and `\` (the burned-in words would change
  them) and the agent image draws emoji (Symbola). The web says "Type an idea" for the AI path, asks nothing about
  everyday words, and says "Your script" once on the video's page. A name at a sentence start is still asked about:
  skipping it would let the AI give Max's part to someone in the cast.
