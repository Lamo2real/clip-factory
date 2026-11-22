# Lamo Stories animation engine

One dependency-free TypeScript engine (CONTRACTS §45.10, ADR-71). The browser runs it for live previews
(`web/src/stories/preview/`), and Lamo Stories' own agent runs the same files with Deno (`cli.ts`) and rasterizes
its draw lists into the final frames (`stories/agent/src/lamostories_agent/raster.py`). This file is the one description of what a draw list means.
Both drawers must follow it exactly.

## Rules for the code in this folder

* Only relative `./*.ts` imports. No npm packages, DOM, network, `Date`, `performance` or `Math.random`.
  Randomness comes from `prng(seed)` or the stateless `rand(seed, i)` in `math.ts`. `Deno` appears only in `cli.ts`,
  which hands its arguments, files and stdout to `commands.ts` (so `web/test/storiesEngineCli.test.ts` runs the very
  same commands). A bad argument or file is one sentence on stderr and exit code 2.
  `web/test/storiesEngine.test.ts` scans the folder to keep it that way. Every output is 30 fps, in one of six sizes
  (below).
* Everything is pure and deterministic. The same script and frame number always give the same prims, in Node, in
  Deno and in every browser. Coordinates are rounded to 0.1 px and alphas to 0.001, so the lists are short and
  compare exactly.
* A scene draws with `scene.seed ?? script.seed`, so "Remake this scene" (a new scene seed) gives new snow, blinks
  and wobbles.
* Treat scripts as immutable. `prepare()` caches per-script layout (bubble positions, rig geometry) in a `WeakMap`.
  It checks a cheap signature (scene ids, lengths, beat counts, cameras, seeds) and works it out again when that
  changes. A changed object is always safe.
* Bump `ENGINE_VERSION` (in `engine.ts`) whenever what a frame draws changes, and write the shape goldens again
  (`STORIES_GOLDENS=write npx vitest run test/storiesEngineShapes.test.ts`): that test fails when the drawing changed
  without a bump.

## Output space

* Frames are **the script's `width` × `height`** in output pixels, origin top-left, x to the right, y down. 30 fps.
  The six sizes (CONTRACTS §45.34; `FORMATS` and `sizeFor(aspect, resolution?)` in `frame.ts`, `formats` in
  `cli.ts catalog`): 9:16 **1080 × 1920** (the default; Shorts, Reels and TikTok want it) or 720 × 1280, 1:1 1080 × 1080
  or 720 × 720, 16:9 1920 × 1080 or 1280 × 720. `validateScript` refuses any other pair, and a script written for an
  engine before 5 must be 1080 × 1920 (its writer laid it out for the tall frame).
* Inside, the engine lays a frame out in design pixels whose short side is 1080 (1080 × 1920, 1080 × 1080 or
  1920 × 1080). A character, a car, a line width, a radius and a letter are the same size against the short side in
  every shape, and the pen scales the whole list to the script's size: a 720 video is exactly the 1080 one scaled to
  two thirds. A 1080 × 1920 frame draws exactly what engine 4 drew (a cast with its own faces aside, below).
* Each place is laid out for the tall frame and kept in the same parts of any other frame: the horizon, the road, a
  window or a desk stay at the same height and across the same part of the width, things keep their size, and rows of
  trees, lamps and buildings repeat across a wider frame. A walk without `to` keeps its pace in pixels (so it crosses
  less of a wide frame per second).
* Prims can reach outside the frame (backgrounds are drawn wider for camera pans). Clip to the frame. Prims wholly
  outside the frame (plus a 60 px margin, 40 px at 720) are already dropped.

## Prims (`types.ts`)

Draw them **in list order** (painter's order: later prims cover earlier ones). Each one is composited
**source-over in sRGB**: `out = src · a + dst · (1 − a)` per channel, with colours as given (no linearising and no
premultiplied input). The frame starts as opaque black, and every frame's first prim covers the whole frame.

| `k` | Fields | Meaning |
|---|---|---|
| `fill` | `color` | The whole frame in one colour (opaque). |
| `grad` | `x0, y0, x1, y1, stops: [offset, color][]` | The whole frame painted with a linear gradient along the line (x0, y0) → (x1, y1). Each pixel takes the value at its projection onto that line. Before the first stop and after the last, the end colours carry on. Interpolate between stops in sRGB. Offsets are 0..1 and sorted. |
| `rect` | `x, y, w, h, r, color, a?` | An axis-aligned rectangle, top-left (x, y), size w × h, corners rounded with radius r (already ≤ min(w, h) / 2). |
| `circle` | `x, y, r, color, a?` | A filled disc. |
| `ellipse` | `x, y, rx, ry, rot, color, a?` | A filled ellipse centred on (x, y) with radii rx, ry, rotated by `rot` **degrees clockwise on screen** (y is down, the same as canvas `ellipse()`). |
| `poly` | `pts: [x0, y0, x1, y1, …], color, a?` | A closed polygon filled with the **non-zero** winding rule. Curves are already flattened. At least 3 points. |
| `line` | `pts: [x0, y0, …], w, color, a?` | An open polyline stroked with width `w`, **round caps and round joins**. At least 2 points. It is not closed: a closed ring repeats its first point at the end. |
| `image` | `asset, x, y, w, h, a?` | Reserved for reference pictures. The built-in engine never emits it. |

* `color` is always `"#rrggbb"` in lower case.
* `a` is the alpha, 0..1. When it is missing, the alpha is 1. It applies to the whole prim at once. Overlaps inside
  one prim (a self-crossing line, say) do not double up.
* Edges are anti-aliased by coverage: a pixel's alpha is multiplied by the part of the pixel the shape covers. 4×4
  supersampling or an analytic distance-to-edge ramp of about 1 px are both fine. The browser's canvas is the
  reference.
* Sizes are in output pixels. A `line` of `w` 3 is 3 px wide. Very thin lines (w < 1) still show faintly by coverage.

## Text (`textTrack`)

Text is not part of the prims. Captions and bubble symbols are drawn on top of the frames: by the browser in
`preview/draw.ts`, and by the agent as an ASS file burned in by libass.

* `x, y` is the **centre of the whole text block**. `text` may contain `\n` line breaks (captions have at most 2
  lines, the end card at most 4; a 60-character caption of very wide letters may take a third line at 40 px or
  less). Lines are centred. Line height is 1.18 × `size`. No word is ever dropped (`text.ts`): a caption that does not
  fit at its smallest size gets one more line, a word longer than a line is split, and the end card shortens the
  publishers' names before it would lose a word.
* Font: Inter, weight 800 (ExtraBold), `size` px, colour `color`. Bubble symbols (`? ! ♫ • • • ♥ #@! Zzz`) use the same
  font. A font without a glyph falls back to another font that has it.
* `caption` and `endcard` need contrast on any background. Draw each line with a dark outline (`#1c1842`,
  about `size × 0.09`) or put a rounded panel behind the block (`#1c1842` at 72 %). The browser draws the panel.
  `bubble` text sits inside a balloon the frames already drew, so it has no outline and no panel.
* Where things go (`TEXT_BOXES` in `text.ts`, design px; the track itself is in output px of the script's size).
  9:16: captions at y 1400 (above the platforms' bottom bar, x 520 keeps clear of the right-hand buttons), scene
  teaching text at y 330 (under the top tabs) in sunshine yellow, the safety end card at y 420. 1:1 and 16:9 use
  centred bands: captions at y 925, teaching text at y 145 and the end card at y 195, centred across the frame, with
  wider lines in 16:9. The end card shows for the last 2.5 s of the last scene (never reaching into the scene before).
  Every block, its panel included, stays inside its format's `safe` area (`cli.ts catalog` `formats`). In 1:1 and
  16:9 the last shot eases down over the 0.4 s before the end card, so every head (its hair too) is below the card. A
  bubble's symbol sits at its balloon's centre.
* The end card reads "Based on {who} advice. Check your local road rules.", the second sentence on its own last line.
  `{who}` is the cited publishers in short (the part after a dash, an acronym in brackets such as RoSPA, "Department
  of Motor Vehicles" as DMV): one or two names, or "{first}, {second} and other road safety" for three or more, or
  "{first} and other road safety" when that would need more than 4 lines; "checked road safety" with none.

## Sound (`audioTrack`)

`AudioEvent.at` is in seconds from the start of the video. `pan` runs from -1 (left) to 1 (right), worked out from
where the sound's maker stands. `pitch` (noises) is the character's voice pitch, and `voice` (noises,
`AudioEvent.voice`; `VoicedAudioEvent` in `tracks.ts` is the same type, kept for older imports) is the character's
voice style, `"babble"` (an open voice) or `"hum"` (a closed-mouth hum; the character's lips stay closed in the frames
too). A character whose voice is `none` makes no
noises. `dur` is set on looping sounds (`engine`, `wind`, `rain`, until the end of their scene) and on repeating ones
(`footsteps`, `heartbeat`, `tick`, `snow_crunch`) when a beat gives them a length. Music is not in the track: the mixer
reads `script.music`.

The track plays every effect of the scenes' lists (`Scene.sfx`; in a script not normalized yet, also `Beat.sfx`) and
nothing else, so what the owner removes in Review is gone from the sound. The place's sounds are in the lists too:
`normalizeScript` gives a new scene (one with no `seed` yet, or with effects still on its beats: the writer's answer)
its place's loop (rain on a rainy road, wind on ice, snow and fog and in the park, traffic on the highway), weather
props' loops and an engine hum while someone drives, as cues `"{sceneId}.amb{k}"` at 0 s, unless its list already has
that sound. A scene normalized before never gets them again, so an ambient sound the owner removed stays removed.
An ambient engine hum pans with the scene's first car; the other ambient sounds are centred.

## Coordinates in a script

* Actors' and props' `x, y` are 0..1 of the frame, whatever its shape. For an actor, or a prop that stands (cars, signs, trees, cones,
  deer), that point is where it touches the ground. For a flat or floating prop (ice, puddles, arrows, ticks), it is
  the centre. In side views the ground actors stand on runs from about y 0.62 to 0.85 (the road is 0.64–0.80). Things
  lower down look nearer and a little bigger.
* `view: "top"` is a road seen from above, running up the frame between x 0.25 and 0.75. A car's `rot` is its heading
  in degrees, clockwise from nose-up. While a car moves to a `to` point, it turns smoothly to face where it is going.
  A `skid` with `dir: "right"` slides the car's **rear to the car's right** (the nose turns left of the travel line),
  peaks at 40% of the skid and comes back straight by its end, leaving tyre marks; `dir: "left"` is the mirror. A
  swing back the other way is a second skid with the other `dir`. So "rear slides right? steer right" is a skid
  `dir: "right"` with the driver's `steer_right` over it: the steering arrow then curves to the right too, and the
  front wheels turn the driver's way (with nobody steering they point back along the travel line). A `spin` turns it
  all the way round (`dir` right is clockwise). An actor `inCar` a car shows through the windows (side view) or
  through the glass roof (top view); a car seats 2 and a truck 1. Their `steer_left` / `steer_right` turn the front
  wheels and draw a curved arrow ahead of the car.
* In a side view, `dir` on `move`, `stop`, `bump` or `appear` turns a prop to face that way (a `move` with `dir` and a
  `to` behind it reverses); on a `skid`, `spin` or `tyre_burst` it is the side of the slide and never turns the car
  round: the car faces the way it travels, nose first.
* A car with people in it and no `move` beat with `to` is driving: the road and the scenery roll past. `brake` slows
  it down, `stop` (a beat on the car) brings it to a halt, and `drive` speeds it up again. A prop `state` can say
  `parked` (no rolling), `driving`, `lights`, `brakes` or `flat` (cars). For an `arrow`, `curve_left` or
  `curve_right` bends it. A `tree` can be `pine` or `snow`, and a `phone` can be `ring` or `on`.
* An arrow points up at `rot` 0. Turn it with `rot` (degrees clockwise).
* Bubbles hold symbols only, never words. They stay fixed on screen while they show, beside the speaker's head as it
  was when the bubble started (never over the face), clear of the other bubbles. In a safety story's end-card seconds
  they show below the card; one that cannot ends when the card starts, or is left out.

* Each character keeps its own faces and noises: a cast member with `expressions` (copied from the saved character)
  may use only those faces on its beats, and only the noises of its `voice.noises`. A face an action implies (a gasp's
  shock, a fall's dizziness) shows only when the character has it; otherwise its last face stays. A cast without
  `expressions` (scripts made before) takes any face and noise of the catalog.

`cli.ts catalog` gives these rules to the writer and the fact checker as `rules` (one plain sentence each: `skid_dir`,
`spin_dir`, `side_dir`, `top_rot`, `steering`, `coordinates`, `arrow_rot`, `prop_state`, `sounds`, `own_faces`,
`frame_shape`; `rules.ts`), the state words as `propStates` and the six sizes as `formats`, next to `catalog` and
`limits`.

## Limits (`validateScript`, also in `cli.ts catalog` as `limits`)

A script has at most 30 scenes, 6 cast members, and per scene 4 actors, 12 props, 40 beats and 40 effects (the API's
own limit for an edited list); at most 40 captions; scenes add up to at most 180 s before `fitDuration`, and the
script's `durationSec` is their sum (within 0.05 s), so `frameCount` = round(durationSec × fps). A car seats 2 and a truck 1. A scene's busiest frame
must stay under about 480 shapes (`sceneShapes`): about 60 for the set (80 on a snowy or rainy road), 70 per
character, 45 per car, 36 per truck, 30 per deer, 36 to 42 for snow or rain (once), 15 for ice, trees and sparkles,
12 for any other prop. A writer who goes over gets a sentence that says which things to use fewer of.

## Own faces and noises (`validateScript`, `repairScript`, `cli.ts repair`)

`validateScript` refuses a beat whose `face` is not among its character's `expressions`, or whose `noise` is not in
its `voice.noises`, with a sentence the writer can act on ("Lamo (c1) does not make the face "angry"; Lamo's own
faces are neutral, happy and surprised. Use one of those, or leave face out."). A cast member's `expressions`, when
there, are different known faces with `neutral` among them. After the writer's last try, `cli.ts repair <script>`
(`repairScript`) makes every such face `neutral` and leaves every such noise out, changes nothing else, and prints
`{ script, changes: ScriptRepair[], ok, errors? }`: each change says the scene, the beat (from 0), the cast id, the
field, what it was and is now, and a sentence for the job's log; `ok` is the check of the repaired script.

## Characters (`validateCharacter`, `cli.ts character`)

The look and voice choices are `CATALOG.looks` (the character agent's vocabulary). `validateCharacter` checks the
character agent's answer as a `CharacterInput` (CONTRACTS §45.6): its look, movement style and voice the way a script's
cast is checked; its `expressions` (required: at least 3 different known faces, `neutral` among them); and, when they
are there, `name` (1 to 30), `description` and `personality` (at most 400 each) and `traits` (at most 8, each 1 to 30).

## Scenes stand alone

A scene's frames depend only on that scene, the cast's looks and the script's seed (and, for the last scene of a
safety story, its end card): changing another scene's length, or giving another scene a new seed, leaves every one of
its frames exactly the same. Only an edited scene needs animating again.
