// Lamo Stories animation engine (docs/CONTRACTS.md §45.10): story script → draw lists, text and sound timelines.
// One file set, two places: the browser draws it on a canvas for live previews, and the agent runs it with Deno
// (cli.ts) and rasterizes the draw lists into the final frames. Pure and deterministic: no DOM, no Date, no
// Math.random (the seeded PRNG only), relative ".ts" imports only. engine/README.md describes the prims.
//
// The pieces: script.ts (validate, normalize, fit, repair, frame maths), frame.ts (the six sizes and shapes),
// scene.ts (one frame of a scene), rig.ts and face.ts (characters), motion.ts (actions and movement styles),
// props.ts, car.ts (a car of the cast, drawn from its own look), sets.ts, camera.ts, bubbles.ts, text.ts and
// tracks.ts (text and audio), ambience.ts (the place's sounds normalize lists), rules.ts (what the script's words
// mean, for the writer), commands.ts and cli.ts (the command line), pen.ts (transforms into prims), math.ts, and
// art.ts (the night drive drawing style's palette, light and shading, §45.45).

import { nightDrive } from "./art.ts";
import { CAR_CAST_SHAPES, CAR_SEATS, carHasFace, checkCarLook, DEFAULT_CAR, type CarDraw } from "./car.ts";
import { CATALOG } from "./catalog.ts";
import { FACES } from "./face.ts";
import { artOf, DEFAULT_FORMAT, F, FORMATS, formatOf, sizeFor, withArt } from "./frame.ts";
import { hash } from "./math.ts";
import { actorState, restPose, STYLES } from "./motion.ts";
import { Pen } from "./pen.ts";
import { drawProp, propState, type DriverInput } from "./props.ts";
import { blendPose, drawCharacter, geometry } from "./rig.ts";
import { drawExtras, drawSceneFrame } from "./scene.ts";
import { CUTS, fitDuration, FPS, frameCount, HEIGHT, LIMITS, locateFrame, MAX_SECONDS, normalizeScript, repairScript, scaleCuts, sceneFrames, sceneList, sceneShapes, SEATS, SIZES_FROM_ENGINE, validateCharacter, validateScript, WIDTH } from "./script.ts";
import { audioTrack, textTrack } from "./tracks.ts";
import type { ActionId, ArtStyle, Beat, CarLook, CharacterLook, Expression, MovementStyle, Prim, SceneProp, StoryScript } from "./types.ts";

export { CATALOG };
export type * from "./types.ts";
export { prng } from "./math.ts";
export { audioTrack, CUTS, fitDuration, FPS, frameCount, HEIGHT, LIMITS, MAX_SECONDS, normalizeScript, repairScript, scaleCuts, sceneFrames, sceneList, sceneShapes, SEATS, SIZES_FROM_ENGINE, textTrack, validateCharacter, validateScript, WIDTH };
export { artOf, DEFAULT_FORMAT, FORMATS, formatOf, sizeFor, withArt };
export { CAR_CAST_SHAPES, CAR_SEATS, carHasFace, checkCarLook, DEFAULT_CAR };
export type { CarDraw };

/** Bumps whenever drawing changes; stored on each job's meta (2: the full rig, sets, props and cameras; 3: a skid
 * slides the rear to its dir's side, cars turn smoothly, bubbles keep clear of the end card and use scene time; 4: a
 * side-view skid with a dir goes nose first, a humming voice keeps its lips closed, the place's sounds are listed;
 * 5: six sizes, 9:16, 1:1 and 16:9 at 1080 or 720 (the 1080 × 1920 frames are drawn as before), and a character
 * that carries its own faces shows only those, even the ones an action implies; 6: a car of the cast, drawn from its own
 * look, the car moves speed_up, bounce, honk, blink and stall, and getting in and out: older scripts draw as before;
 * 7: the night drive drawing style (script.art), cuts between shots inside a scene and the highway at night: older
 * scripts draw as before). */
export const ENGINE_VERSION = 7;

/** The draw list for one frame of the whole story (frames past the end show the last frame). */
export function drawFrame(s: StoryScript, frame: number): Prim[] {
  if (!s.scenes.length) return [{ k: "fill", color: "#1c1842" }];
  const n = frameCount(s);
  const f = Math.min(Math.max(0, Math.floor(Number.isFinite(frame) ? frame : 0)), Math.max(0, n - 1));
  const { index, t } = locateFrame(s, f);
  return drawSceneFrame(s, index, t);
}

/** How long each action's loop lasts on the Characters page (seconds). */
const LOOP: Partial<Record<ActionId, number>> = { idle: 3, walk: 2, run: 1.6, fall: 3.4, get_up: 3, sit: 3, dance: 3, celebrate: 2.6, slip: 2.4 };

/** One character, drawn into a size × size box from (0, 0): the Characters page and every cast picker. `art` is the
 * drawing style (§45.45; classic when left out), drawn in the studio light so the owner's own colours show. */
export function previewCharacter(look: CharacterLook, style: MovementStyle, expression: Expression, action: ActionId, t: number, size: number, art: ArtStyle = "classic"): Prim[] {
  return withArt(artOf(art), () => drawPreviewCharacter(look, style, expression, action, t, size));
}

function drawPreviewCharacter(look: CharacterLook, style: MovementStyle, expression: Expression, action: ActionId, t: number, size: number): Prim[] {
  const g = geometry(look);
  const st = STYLES[style] ?? STYLES.bouncy;
  const seed = hash(look.skin, look.body, look.hair.style, look.outfit.top);
  const pen = new Pen({ x0: -size * 0.1, y0: -size * 0.1, x1: size * 1.1, y1: size * 1.1 });
  const unitsTall = -g.top + 16;
  const px = (size * 0.8) / unitsTall;
  const y = size * 0.92;
  const period = LOOP[action] ?? 2.4;
  const tt = ((t % period) + period) % period;
  const beats: Beat[] = action === "idle" ? [] : [{ at: 0.15, dur: Math.max(0.6, period - 0.75), who: "me", do: action, ...(action === "walk" || action === "run" ? { to: { x: 0.5, y: 0.72 } } : {}) }];
  const state = actorState({ castId: "me", x: 0.5, y: 0.72, facing: "right" }, beats, st, g, seed, tt, 1080 / px);
  // the loop's last moment eases back to standing, so sit and fall loop without a jump
  const back = Math.max(0, Math.min(1, (tt - (period - 0.4)) / 0.4));
  const pose = back > 0 ? blendPose(state.pose, restPose("stand", tt, st, seed, g, false), back * back * (3 - 2 * back)) : state.pose;
  // a character lying down is moved over so all of it stays in the box
  const lie = Math.max(0, Math.min(1, -pose.rot / 90));
  const x = size / 2 + lie * 40 * px;
  // night drive's soft shadows under the feet are drawn by the rig itself
  if (!nightDrive()) pen.ellipse(x - lie * 40 * px, y + 2, (30 + lie * 30) * px, 6 * px, 0, "#000000", 0.18);
  pen.save();
  pen.translate(x, y);
  pen.scale(px, px);
  drawCharacter(pen, look, g, pose, { t, seed, face: FACES[expression] ?? FACES.neutral, inCar: false });
  pen.restore();
  drawExtras(pen, state, seed, g, size / 2, y, px, t);
  return pen.out;
}

/** What the Characters page's car editor tries (CONTRACTS §45.41). */
export type CarMove = "idle" | "drive" | "speed_up" | "brake" | "turn" | "bounce" | "honk" | "blink" | "stall";

/** How long a car move loops in the editor (seconds). */
const CAR_LOOP = 2.4;

/** The car's beats for each move, and how fast the road goes by (0..1 of a drive) at time t of the loop. */
const CAR_MOVES: Record<CarMove, { beats: Omit<Beat, "who">[]; speed: (t: number) => number }> = {
  idle: { beats: [], speed: () => 0 },
  drive: { beats: [], speed: () => 1 },
  speed_up: { beats: [{ at: 0.2, dur: 1.6, do: "speed_up" }], speed: (t) => 0.15 + 0.85 * Math.min(1, Math.max(0, (t - 0.2) / 1.6)) ** 2 },
  brake: { beats: [{ at: 0.5, dur: 1.2, do: "stop" }], speed: (t) => (t < 0.5 ? 1 : 1 - Math.min(1, (t - 0.5) / 1.2) ** 0.5) },
  turn: { beats: [], speed: () => 0.7 },
  bounce: { beats: [{ at: 0.3, dur: 1.2, do: "bounce" }], speed: () => 0 },
  honk: { beats: [{ at: 0.3, dur: 0.9, do: "honk" }], speed: () => 0 },
  blink: { beats: [{ at: 0.3, dur: 1.4, do: "blink" }], speed: () => 0 },
  stall: { beats: [{ at: 0.6, dur: 0.8, do: "stall" }], speed: (t) => (t < 0.6 ? 0.8 : 0.8 * (1 - Math.min(1, (t - 0.6) / 0.4))) },
};

/** A car of the cast on plain ground, drawn into a size × size box from (0, 0), looping the move over 2.4 s: the
 * Characters page, the car options and every cast picker. "turn" shows the top view, nose left then right. `art` is
 * the drawing style (§45.45; classic when left out), in the studio light. */
export function previewCar(car: CarLook, style: MovementStyle, expression: Expression, move: CarMove, t: number, size: number, art: ArtStyle = "classic"): Prim[] {
  return withArt(artOf(art), () => drawPreviewCar(car, style, expression, move, t, size));
}

function drawPreviewCar(car: CarLook, style: MovementStyle, expression: Expression, move: CarMove, t: number, size: number): Prim[] {
  const spec = CAR_MOVES[move] ?? CAR_MOVES.idle;
  const tt = ((t % CAR_LOOP) + CAR_LOOP) % CAR_LOOP;
  const view = move === "turn" ? "top" : "side";
  const prop: SceneProp = { propId: "me", kind: "car", x: 0.5, y: 0.72, scale: 1, rot: 0, castId: "me" };
  const beats: Beat[] = spec.beats.map((b) => ({ ...b, who: "me" }));
  const d: CarDraw = { car, style, seed: hash(car.paint, car.body, car.wheels.style, car.face.eyes) };
  // the road's distance so far: the integral of the speed, summed in small steps so the wheels never jump
  let rolled = 0;
  for (let u = 0; u < tt; u += 0.05) rolled += spec.speed(u) * 0.05 * 700;
  const driver: DriverInput = { braking: 0, steer: 0, rolled };
  const st = propState(prop, beats, view, tt, driver, d);
  st.speed = Math.max(st.speed, spec.speed(tt) * 0.32);
  st.face = carHasFace(car) ? expression : null;
  if (move === "turn") {
    st.rot = -28 * Math.sin((Math.PI * 2 * tt) / CAR_LOOP);
    st.wheelTurn = -32 * Math.cos((Math.PI * 2 * tt) / CAR_LOOP);
  }
  const pen = new Pen({ x0: -size * 0.1, y0: -size * 0.1, x1: size * 1.1, y1: size * 1.1 });
  const s = size / (view === "top" ? 760 : 1120);
  pen.translate(size / 2, view === "top" ? size / 2 : size * 0.7);
  pen.scale(s, s);
  pen.translate(-st.x * F.w, -st.y * F.h);
  drawProp(pen, st, view, tt, d.seed, {}, false, d);
  return pen.out;
}
