# Clips Funded animation engine

One dependency-free TypeScript engine (CONTRACTS §45.10, ADR-71). The browser runs it for live previews
(`web/src/stories/preview/`), and Clips Funded's own agent runs the same files with Deno (`cli.ts`) and rasterizes
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
  (`STORIES_GOLDENS=write npx vitest run test/storiesEngineShapes.test.ts test/storiesEngineNight.test.ts`): those
  tests fail when the drawing changed without a bump (the Bright sample's frames, and night drive's fixture,
  `fixtures/night-drive.json`, whose four full frames the agent's `test_stories_raster.py` also rasterizes).

## Output space

* Frames are **the script's `width` × `height`** in output pixels, origin top-left, x to the right, y down. 30 fps.
  The six sizes (CONTRACTS §45.34; `FORMATS` and `sizeFor(aspect, resolution?)` in `frame.ts`, `formats` in
  `cli.ts catalog`): 9:16 **1080 × 1920** (the default; Shorts, Reels and TikTok want it) or 720 × 1280, 1:1 1080 × 1080
  or 720 × 720, 16:9 1920 × 1080 or 1280 × 720. `validateScript` refuses any other pair, and a script written for an
  engine before 5 must be 1080 × 1920 (its writer laid it out for the tall frame).
* Inside, the engine lays a frame out in design pixels whose short side is 1080 (1080 × 1920, 1080 × 1080 or
  1920 × 1080). A character, a car, a line width, a radius and a letter are the same size against the short side in
  every shape, and the pen scales the whole list to the script's size: a 720 video is exactly the 1080 one scaled to
  two thirds. A 1080 × 1920 frame draws exactly what engine 4 drew, with two exceptions: a cast with its own faces
  (below), and a safety story's end-card seconds, whose bubbles keep below the 9:16 end card, which now fits the
  platforms' safe area (Text, below) and so can be a size smaller.
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
| `glow` | `x, y, rx, ry, rot, color, fade: [offset, alpha][], a?` | A soft light (night drive only): the ellipse of `ellipse`, painted in one colour whose alpha fades with how far out a point is, in radii (0 the centre, 1 the edge): linear between the `fade` stops (offsets 0..1 and sorted, alphas 0..1), the end stops' alphas before the first and after the last, times `a`; nothing past the edge, so the engine ends every fade at alpha 0. The browser draws it as a radial gradient in the ellipse's own frame (`preview/draw.ts`), `raster.py` by the same formula. |
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
  9:16 keeps inside the safe area of TikTok, Reels and Shorts (x 80 to 910, y 260 to 1440: under their top tabs,
  above their bottom bar and 170 px clear of their right-hand buttons; the same box the agent's `ass.py` keeps to),
  every block centred across it at x 495: captions at y 1345, scene teaching text at y 350 in sunshine yellow, the
  safety end card at y 420 (engine 4 used x 520 / 540, y 1400 and 330, which reached past that box). 1:1 and 16:9 use
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
`car_cast`, `get_in_out`, `honk`, `driver_wave`, `frame_shape`, `shots`, `shot_world`; `rules.ts`), the state words
as `propStates` and the six sizes as `formats`, next to `catalog` and `limits`.

## Limits (`validateScript`, also in `cli.ts catalog` as `limits`)

A script has at most 30 scenes, 6 cast members, and per scene 4 actors, 12 props, 40 beats and 40 effects (the API's
own limit for an edited list); at most 40 captions; scenes add up to at most 180 s before `fitDuration`, and the
script's `durationSec` is their sum (within 0.05 s), so `frameCount` = round(durationSec × fps). A car seats 2 and a truck 1. A scene's busiest frame
must stay under about 480 shapes (`sceneShapes`): about 60 for the set (80 on a snowy or rainy road), 70 per
character, 45 per car, 56 per car of the cast, 36 per truck, 30 per deer, 36 to 42 for snow or rain (once), 15 for ice, trees and sparkles,
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

## Cars of the cast (`car.ts`, CONTRACTS §45.42, §45.43)

A car character is never an actor. It is `script.cars[id]` (a `CarMember`: `characterId`, `name`, `car` (a `CarLook`),
`movementStyle`, `voice` with style `none` and no noises, and `expressions`), with an id that is never a `cast` key.
A scene shows it as a car prop with `castId: id`. That prop draws the car's own look, and its `color` is ignored.
Beats reach it by the prop's `propId`. `cast` stays people only, so the people code (geometry, motion, faces, bubbles,
noises) never sees a car, and `prepare()` makes no geometry for one. A script made before engine 6 has no `cars`.

* **The look** (`CATALOG.carLooks`, `checkCarLook`): a body (hatchback, saloon, estate, SUV, pickup, van, sports car,
  tiny car), `length` and `height` 0.85 to 1.15, `paint`, `accent` (the roof and pillars of a two-tone car, the
  stripes, the mirror caps) and `outline` colours, a pattern (plain, two colours, a side stripe, racing stripes),
  windows (clear, tinted, dark), wheels (steel, hubcaps, alloy, sporty, off-road; a rim colour; size 0.85 to 1.2),
  front lights (round, square, slim), back lights (round, a long bar, square), one thing on top (nothing, a roof rack,
  a spoiler, a roof box) and a face. `DEFAULT_CAR` is a red hatchback with alloy wheels and no face.
* **The drawing** works in the same frame as the plain car: origin on the ground at its centre, facing +x (top view:
  its centre, nose up), px × k. Each body is one silhouette polygon (bonnet, windscreen rake, roof, back) scaled by its
  body's length and height factors times `length` and `height`, with an outline of the people's weight. The riders sit
  behind the glass with a tint over them (0.25 tinted, 0.4 dark), so a driver always shows. A plate is always one
  plain light rectangle (`#f4f1ea`), front and back, and no badge or text is ever drawn. The wheels' spokes turn with
  the distance rolled and the front pair with the steering (top view), as on the plain car. A car with eyes `none` is
  a real-looking car. Eyes `windscreen` are two big eyes on the windscreen glass; `headlights` turns the front lights
  into eyes with pupils. They use `face.ts`'s face parameters and blink timing, in `face.color`; the top view shows
  the windscreen eyes only, small. A `grille` mouth bends the grille into the face's smile or frown.
* **Its movement style** changes the drawing, never the timing: bouncy bounces 1.6 times as much and sways a little
  when it stands, calm 0.6 times, clumsy wobbles by up to 2°, zippy shows speed lines sooner, and heavy dips its nose
  half as much again when it stops.
* **The car moves** (prop actions; on a plain car or truck too): `speed_up` is a `move` that starts slowly and ends
  fast, with two exhaust puffs at its start; `bounce` is a suspension hop (the body rises about 6% of the car's height
  and settles, the wheels stay down); `honk` pulses the body and sends three sound-wave arcs from the nose
  (`normalizeScript` adds its `honk` effect by itself); `blink` flashes the headlights twice over its beat (and the
  eyes, when it has them); `stall` is a 0.4 s shudder with one dark puff that brings the speed to 0, and with `to` it
  stops like `stop`, only jerkier. `speed_up` is a mover, and so is `stall` with `to`. A beat's `face` on a car is the
  car's face from then on (only on a car with a face, and only from its own faces).
* **People with a car.** A car seats 2 (`CAR_SEATS`); the first rider drives. `get_in` and `get_out` need `inCar`
  (that car's `propId`), last 0.8 to 3 s each, at most one of each per actor and scene, getting in first. Before
  `get_in` the actor is an actor outside: it can walk, wave and make faces. During the first 60% it walks to the door
  (the car's x minus 0.35 of its length, on the camera side, on the ground); then it steps in with a small squash,
  sliding into the seat, and fades out over the last 25% while the seated rider fades in. `get_out` is the reverse
  and ends standing just beside the door. The road rolls only while a seated driver is in, the car is not `parked`,
  the last `get_in` has ended and the first `get_out` has not started; the car itself does not move during them.
  A driver waves only while the car is stopped; a passenger may wave any time.
* **Validation** says, in a sentence the writer can act on: at most 2 cars; a car id that is also a cast id; each car
  through `checkCarLook`, a voice of `none` and the faces rule (`["neutral"]` without eyes, at least 3 with neutral
  with them); a car used as an actor ("put it in props as {kind: "car", castId}"); a `castId` on a prop that is not a
  car, or that is not one of the cars; one car in two props of a scene; a face the car does not make (`repairScript`
  takes it out, as for people); getting in or out without `inCar`, too short or too long, or out of order; and the car
  moving while someone is still getting in.
* **Shapes.** A car of the cast is at most `CAR_CAST_SHAPES` (56) prims at its busiest, with eyes on
  (`web/test/storiesEngineCars.test.ts` measures every choice, every prop action and both views); `sceneShapes`
  counts it so.
* **The editor's preview** (`previewCar(car, style, expression, move, t, size)`) draws the car on plain ground into a
  size × size box, looping the move over 2.4 s: idle, drive, speed up, brake, turn (the top view, nose left then
  right), bounce, honk, flash its lights and stall.

## The night drive drawing style (`art.ts`, CONTRACTS §45.45)

A script's `art` is its drawing style: `"night_drive"` (Night drive, what new videos are made in) or `"classic"`
(Bright, the first videos' look). A script without `art`, every one made before engine 7, draws exactly as before:
the same prims for a missing `art` and for `"classic"`. `inFrame` puts the style in `F.art` and the studio light in
`F.light`; `withArt(art, fn)` does the same for the editors' previews (`previewCharacter(…, art)`,
`previewCar(…, art)`, classic when left out), which draw in the studio light so the owner's own colours show.

* **The look** is surface drawing only: people, cars and places keep their geometry (the BODY table, `CHAR_PX`, the
  car sizes, the seats), so layout, bubbles and the in-frame rules stay. Every new drawing path sits behind
  `nightDrive()`. Outlines are soft and thin (`ink(outline)`, half way to a soft brown; `inkPx`, 2 to 3.6 design px),
  with cel shadows (`cel`), lit tops (`lift`), a rim light from the street lamps and soft shadows under chins, cars
  and feet. The big soft lights are `glow` prims, the one prim kind night drive adds (a true gradient, so no ring
  or step shows however big a light is): each near street lamp's amber halo, gold glow and warm white bloom
  (`sets.ts lampBloom`, `art.ts fadeStops`: 16 stops of peak · (1 − d)^power), the warm sweep of a lamp passing
  (`light.ts drawLightSweep`) and the vignette (`light.ts drawVignette`, `VIGNETTE`: a dark glow in each corner,
  about 0.18 in the very corners at night and half that by day; the middle of each edge is left alone). Small
  lights are stacked shapes (`art.ts glow`, and `softRings`: rings whose alphas build a smooth falloff in steps that
  are smallest where the light is faintest, more rings the bigger a light shows): car lights and the headlights in
  the rear-view mirror; each far street lamp is one small `glow`. There is no film grain. Lights that share a colour
  and an alpha (the far street lamps' lenses, a row of side-view lamps' heads, a car's two headlights) are one
  polygon of several loops (`pen.ts joinShapes`, bridges
  walked out and back, so the non-zero rule fills each loop once in both drawers).
* **Light** (`LIGHTS`): studio changes nothing; day, indoor, night and cabin mute an own colour through `grade`
  (a little grey, the light's colour, darker, warmed by the lamps' pulse). Own colours (skin, paint, a place's palette)
  are graded; the palette tokens (`ND`) are final. Night places (`road_night`, `highway_night`) use the night light,
  and the inside of a car the cabin light.
* **`highway_night`** ("Highway at night") is a road with two lanes each way, street lamps with halos and pools,
  mountains, a distant city glow and guard rails. Both styles draw it (Bright without the finish). In night drive
  `road_night` gets the night palette too; every other place keeps its own palette, graded under its light.
* **Cuts between shots** (`Scene.cuts`, up to 8 `{ at, shot, who? }`): the action, beats and sound go on, only the
  picture cuts, hard, with the camera's settle. Before the first cut a scene shows the whole scene. Cuts are sorted,
  at least 0.6 s apart and 0.6 s before the scene's end (`CUTS`), in side views only, and `who` is an actor of the
  scene. Driver's eyes, Side window, Mirror, Speed dial, Feet on the pedals and Behind the car need someone sitting
  in a car or truck on a road place, never while that rider gets in or out; Down the road needs a road; Face up
  close needs a person (and, for a person in a car, what the car shots need). `normalizeScript` sorts them;
  `fitDuration` (and the API's and the mock's scene-length edits, `scaleCuts`) scale them with their scene: a cut
  less than 0.6 s before the new end is dropped, of two cuts less than 0.6 s apart the later one is kept, and a shot
  in the car that would now show its rider getting in or out goes back to the whole scene, so a valid script stays
  valid at any length (getting in or out also keeps its 0.8 to 3 s). `rules.ts` tells the writer as `shots` and
  `shot_world`.
* **Shapes.** In night drive `sceneShapes(scene, "night_drive")` is the larger of the whole scene's estimate and
  each cut's shot. The whole scene is its place's measured count (`sets.ts SET_SHAPES_ND`, e.g. 128 for
  `highway_night` and 104 for `road_night`), 92 a character, the measured props (`props.ts PROP_SHAPES_ND`: 58 a car,
  60 a truck, 30 a deer), 72 a car of the cast (`car.ts CAR_CAST_SHAPES_ND`) and any other prop 2 more than in
  Bright. A shot is its measured count (`shots.ts SHOT_SHAPES`, its place, the inside of the car, the own car and the
  driver) plus 34 (`car.ts CAR_VIEW_SHAPES`) for each other car or truck it may show, at most 4. Night drive's limit
  is `LIMITS.shapesNight`, 560 (Bright's stays 480): every night estimate is the busiest look, light and camera,
  about a fifth over what a scene really draws, so two kids in their car with two other cars on the highway at
  night, four people, or three people and two cars fit as they do in Bright.
* **Where it is drawn.**
  * `art.ts`: the tokens (`ND`), the lights, `grade`, `cel`, `lift`, `ink`, `inkPx`, `lineUnits`, `glow`, `withWarm`.
  * `light.ts`: which light each part stands in (`lightFor`), the lamps' warm pulse that rolls with the road
    (`lampWarm`, a lamp every 40 m), the vignette (a soft dark glow in each corner) and the warm sweep over the
    dashboard and the face (in night drive a soft warm glow along the band, its edges fading out).
  * `sets.ts lampGlow`: in night drive a street lamp is a bright warm emitter: a warm white lens bar
    (`ND.lampLens`) nearly as wide as its thin dark grey head (`ND.lampHousing`, `lampHeadPts`), its light three
    `glow` prims (`lampBloom`): a wide amber halo (`ND.lampGlowOut`, `LAMP_HALO` lens half widths past the lens), a
    strong gold glow (`ND.lampGlowIn`) half as far and a warm white bloom round the lens, each a little lower than
    the one inside it (light falls down), on a slate pole (`ND.lampPole`) that stands on a flat darker base with a
    soft shadow; no flat disc, no ring and no cone of light under it. Each far lamp is one gold glow
    (`lampRing`, `LAMP_GLOW`) and all their lenses one polygon. The side view draws each lamp's light, then the
    whole row's heads and lenses at once (`lampRow`). Lamps show through the windows too (`perspective.ts`
    `lampsBehind` in Face up close, `sideLamps` in Side window, `glassLamp` in the mirror's glass). Bright keeps its
    gold bloom round a cobra head (`ND.lampHead`, `ND.lampCore`). Headlights
    and tail lights fade the same soft way (`car.ts bloom` and `tailGlow`, `carView.ts headBloom`, `softPair`,
    `softBar`), the glow under a lens in the front and back views.
  * `rig.ts`, `face.ts`: the night people (dot eyes tinted with the picked eye colour, a pupil up close, short thick
    brows, soft scalloped hair with strand groups, cel shadows, rim light along the hair's own edge, folds) and three
    new drawings for the shots, both styles: `drawBust` (front or three-quarter, from the head's centre),
    `drawWheelHands` and `drawFoot`. `motion.ts` gives `faceSince`, so the brows overshoot a new face by 20% for
    0.12 s.
  * `car.ts`, `props.ts`: the night cars and props (three paint tones, door lines, handles, mirror, side marker, glass
    reflections, rims, headlight bloom, tail and brake glow, soft shadows); `carView.ts`: a car or truck from the
    back or the front (`drawCarView`, `drawPropView`), boxy with a side towards the vanishing point, for the shots.
  * `perspective.ts`: the road ahead in perspective (`project`, 3.6 m lanes, lamps 10 m high every 40 m), streaming
    with the road's metres so it carries on across cuts. In night drive the lamps stand on poles all the way to the
    horizon, each smaller than the one before, so the two rows meet in a warm glowing line at the vanishing point:
    the near ones each with their own soft rings, the far ones (glow under 13.5 px) sharing a few polygons; every pole
    and arm is drawn before the rails, so a rail stands in front of a pole's flat foot; `shots.ts`: `shotAt`, each shot's world (who drives, the
    other cars' gaps and lanes) and the eight shots, each filling the frame in every size; `camera.ts shotCamera`.
  * `sets.ts`: `highway_night`, the night recipe for `road_night` and the other places graded under their light.

## Scenes stand alone

A scene's frames depend only on that scene, the cast's looks and the script's seed (and, for the last scene of a
safety story, its end card): changing another scene's length, or giving another scene a new seed, leaves every one of
its frames exactly the same. Only an edited scene needs animating again.
