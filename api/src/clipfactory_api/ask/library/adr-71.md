## ADR-71 One animation engine in TypeScript, drawn by the browser and by the agent

- **Context.** Clips Funded needs 30–60 s vertical cartoons without voice-over, with recurring characters that must
  look and move the same in every video, previews in the app, and a pipeline that works today. No image or video
  generation model is set up in the account; Amazon Nova Canvas and Nova Reel are not offered in eu-north-1 (Ireland,
  N. Virginia and Tokyo only), Reel writes to a bucket in its own Region, and generated frames or clips do not keep a
  character the same from one shot to the next. ffmpeg, numpy and Deno are already in the agent image; Lambdas have
  no ffmpeg.
- **Options.** (1) AI video for every shot (not in-Region, inconsistent characters, realistic clips need AI labels);
  (2) AI images per scene plus pan and zoom (inconsistent, slideshow-like); (3) a 2D rig engine in Python only, with
  previews rendered by the agent (a cold start for every preview, and the browser could not animate the Characters
  page); (4) the engine in the browser only, exporting the video there (the app would have to stay open, and Safari and
  Chrome encode differently); (5) one dependency-free TypeScript engine that turns a story script into draw lists:
  the browser draws them on a canvas for instant previews, the agent runs the same file with Deno and rasterizes the
  lists with numpy into frames for ffmpeg.
- **Decision.** (CONTRACTS §45.10, §45.11.3) Option 5. Characters are rigs (a few looks choices), copied into each
  story's script, so consistency is by construction; the writer (Claude) only picks from the engine's catalog and names
  characters by cast id; effects, character noises and music are synthesized with numpy, so there are no audio files
  and no licences. AI images (Nova Canvas) can be added later behind the rigs (ADR-75).
- **Consequences.** Previews and videos use the same draw lists (shared code; the rasterizer is tested on fixed draw
  lists). The look is clean flat-shaded 2D, not painted or realistic; new actions, props or sets are code in one
  folder. The engine folder is copied into Clips Funded's own agent image (ADR-76), so that image's tag hash includes
  it, and an engine change rebuilds only that image; Clip Factory's agent image never changes because of Clips
  Funded. Rendering 45 s
  takes a few minutes on the agent.
