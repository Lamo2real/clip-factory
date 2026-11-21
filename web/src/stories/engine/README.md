# Lamo Stories animation engine

One dependency-free TypeScript engine (CONTRACTS §45.10, ADR-71). The browser runs it for live previews
(`web/src/stories/preview/`), and the agent runs the same files with Deno (`cli.ts`) and rasterizes its draw lists
into the final frames (`agent/.../stories/raster.py`). This file is the one description of what a draw list means.
Both drawers must follow it exactly.

## Rules for the code in this folder

* Only relative `./*.ts` imports. No npm packages, DOM, network, `Date`, `performance` or `Math.random`.
  Randomness comes from `prng(seed)` or the stateless `rand(seed, i)` in `math.ts`. `Deno` appears only in `cli.ts`.
  `web/test/storiesEngine.test.ts` scans the folder to keep it that way.
* Everything is pure and deterministic. The same script and frame number always give the same prims, in Node, in
  Deno and in every browser. Coordinates are rounded to 0.1 px and alphas to 0.001, so the lists are short and
  compare exactly.
* A scene draws with `scene.seed ?? script.seed`, so "Remake this scene" (a new scene seed) gives new snow, blinks
  and wobbles.
* Treat scripts as immutable. `prepare()` caches per-script layout (bubble positions, rig geometry) in a `WeakMap`.
  It checks a cheap signature (scene ids, lengths, beat counts, cameras, seeds) and works it out again when that
  changes. A changed object is always safe.
* Bump `ENGINE_VERSION` (in `engine.ts`) whenever what a frame draws changes.

## Output space

* Frames are **1080 × 1920** output pixels, origin top-left, x to the right, y down. 30 fps.
* Prims can reach outside the frame (backgrounds are drawn wider for camera pans). Clip to the frame. Prims wholly
  outside the frame (plus a 60 px margin) are already dropped.

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
  lines, the end card at most 4). Lines are centred. Line height is 1.18 × `size`.
* Font: Inter, weight 800 (ExtraBold), `size` px, colour `color`. Bubble symbols (`? ! ♫ • • • ♥ #@! Zzz`) use the same
  font. A font without a glyph falls back to another font that has it.
* `caption` and `endcard` need contrast on any background. Draw each line with a dark outline (`#1c1842`,
  about `size × 0.09`) or put a rounded panel behind the block (`#1c1842` at 72 %). The browser draws the panel.
  `bubble` text sits inside a balloon the frames already drew, so it has no outline and no panel.
* Where things go: captions at y 1400 (above the platforms' bottom bar, x 520 keeps clear of the right-hand
  buttons). Scene teaching text at y 330 (under the top tabs) in sunshine yellow. The safety end card at y 500 for the
  last 2.5 s. A bubble's symbol sits at its balloon's centre.

## Sound (`audioTrack`)

`AudioEvent.at` is in seconds from the start of the video. `pan` runs from -1 (left) to 1 (right), worked out from
where the sound's maker stands. `pitch` (noises) is the character's voice pitch. `dur` is set on looping sounds
(`engine`, `wind`, `rain`, until the end of their scene) and on repeating ones (`footsteps`, `heartbeat`, `tick`,
`snow_crunch`) when a beat gives them a length. A scene gets its place's loop (rain on a rainy road, wind on ice and
snow, traffic on the highway), weather props' loops, and an engine hum while someone drives, unless its effects list
already has that sound. Music is not in the track: the mixer reads `script.music`.

## Coordinates in a script

* Actors' and props' `x, y` are 0..1 of the frame. For an actor, or a prop that stands (cars, signs, trees, cones,
  deer), that point is where it touches the ground. For a flat or floating prop (ice, puddles, arrows, ticks), it is
  the centre. In side views the ground actors stand on runs from about y 0.62 to 0.85 (the road is 0.64–0.80). Things
  lower down look nearer and a little bigger.
* `view: "top"` is a road seen from above, running up the frame between x 0.25 and 0.75. A car's `rot` is its heading
  in degrees, clockwise from nose-up. While a car moves to a `to` point, it faces where it is going. A `skid` swings
  its rear out to `dir`'s side and back, and leaves tyre marks. A `spin` turns it all the way round. An actor
  `inCar` a car shows through the windows (side view) or through the glass roof (top view). Their `steer_left` /
  `steer_right` turn the front wheels and draw a curved arrow ahead of the car.
* A car with people in it and no `move` beat with `to` is driving: the road and the scenery roll past. `brake` slows
  it down, `stop` (a beat on the car) brings it to a halt, and `drive` speeds it up again. A prop `state` can say
  `parked` (no rolling), `driving`, `lights`, `brakes` or `flat` (cars). For an `arrow`, `curve_left` or
  `curve_right` bends it. A `tree` can be `pine` or `snow`, and a `phone` can be `ring` or `on`.
* An arrow points up at `rot` 0. Turn it with `rot` (degrees clockwise).
* Bubbles hold symbols only, never words. They stay fixed on screen while they show, next to the speaker's head as it
  was when the bubble started.
