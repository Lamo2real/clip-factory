## ADR-93 Night drive is a drawing style in the one engine: an `art` field, cuts between shots, surface drawing only

- **Context.** The owner (2026-11-24) sent a reference video of a cartoon drive at night and asked for their videos
  in that style, "a little bit more detailed", keeping every feature: "its just a simple design style change". The
  look needs soft lines, cel shading, a muted night palette with sodium lamps and glow, and film-like shots inside a
  car (the driver's eyes through the windscreen, the face, the mirror, the speed dial, the pedals). Every old story,
  golden and preview had to stay as it was, and the preview and the final video had to stay the same picture.
- **Options.** (1) Replace the drawing outright: every old story and golden would change, and there would be no way
  back to the bright look. (2) An AI video model or an ffmpeg filter for the look: the preview could not match the
  final video, and a filter cannot add shots. (3) A drawing style in the same engine: `StoryScript.art`
  (`"night_drive"` or `"classic"`, a missing field is classic), surface drawing behind `nightDrive()` with the
  geometry unchanged, and `Scene.cuts` for shots inside a scene, all as the prims both drawers already paint.
- **Decision.** (CONTRACTS §45.45) Option 3. New videos are made in Night drive (the workspace's `video.art`
  default, which the owner can set back to Bright in Settings › Video or per video in Production › New); the engine
  itself never reads a missing `art` as Night drive. Own colours (skin, paint, a place's palette) are lit by the
  place's light (`grade`); palette tokens are final. One new place (`highway_night`) and eight shots (`shots.ts`,
  `perspective.ts`, `carView.ts`); cuts are hard, the action and sound go on across them, and the writer cuts every 2
  to 4 seconds. A vignette of prims, no film grain (it would need a new prim kind in both drawers). `ENGINE_VERSION`
  is 7. No preset copies the reference's characters, and the reference is never copied into the repo or a prompt.
- **Consequences.** Bright draws byte for byte as before (the shapes golden changed only its engine field), and a
  night goldens file pins the new look prim by prim; `raster.py` is checked against the same frames. Night frames have
  more shapes, so the writer's estimate reads measured counts per place, prop and shot. Rasterizing a night shot is
  about 1.7 to 2.3 times the Bright highway's time a frame (a faster polygon fill is a follow-up). The look reaches
  final videos only through the PR and the agent image's CI deploy; no infra changes and no data is reset (older
  workspaces get `video.art` filled in on read).
