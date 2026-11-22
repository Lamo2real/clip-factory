// Lamo Stories animation engine (docs/CONTRACTS.md §45.10): story script → draw lists, text and sound timelines.
// One file set, two places: the browser draws it on a canvas for live previews, and the agent runs it with Deno
// (cli.ts) and rasterizes the draw lists into the final frames. Pure and deterministic: no DOM, no Date, no
// Math.random (the seeded PRNG only), relative ".ts" imports only. engine/README.md describes the prims.
//
// The pieces: script.ts (validate, normalize, fit, repair, frame maths), frame.ts (the six sizes and shapes),
// scene.ts (one frame of a scene), rig.ts and face.ts (characters), motion.ts (actions and movement styles),
// props.ts, sets.ts, camera.ts, bubbles.ts, text.ts and tracks.ts (text and audio), ambience.ts (the place's sounds
// normalize lists), rules.ts (what the script's words mean, for the writer), commands.ts and cli.ts (the command
// line), pen.ts (transforms into prims), math.ts.

import { CATALOG } from "./catalog.ts";
import { FACES } from "./face.ts";
import { DEFAULT_FORMAT, FORMATS, formatOf, sizeFor } from "./frame.ts";
import { hash } from "./math.ts";
import { actorState, restPose, STYLES } from "./motion.ts";
import { Pen } from "./pen.ts";
import { blendPose, drawCharacter, geometry } from "./rig.ts";
import { drawExtras, drawSceneFrame } from "./scene.ts";
import { fitDuration, FPS, frameCount, HEIGHT, LIMITS, locateFrame, MAX_SECONDS, normalizeScript, repairScript, sceneFrames, sceneList, sceneShapes, SEATS, SIZES_FROM_ENGINE, validateCharacter, validateScript, WIDTH } from "./script.ts";
import { audioTrack, textTrack } from "./tracks.ts";
import type { ActionId, Beat, CharacterLook, Expression, MovementStyle, Prim, StoryScript } from "./types.ts";

export { CATALOG };
export type * from "./types.ts";
export { prng } from "./math.ts";
export { audioTrack, fitDuration, FPS, frameCount, HEIGHT, LIMITS, MAX_SECONDS, normalizeScript, repairScript, sceneFrames, sceneList, sceneShapes, SEATS, SIZES_FROM_ENGINE, textTrack, validateCharacter, validateScript, WIDTH };
export { DEFAULT_FORMAT, FORMATS, formatOf, sizeFor };

/** Bumps whenever drawing changes; stored on each job's meta (2: the full rig, sets, props and cameras; 3: a skid
 * slides the rear to its dir's side, cars turn smoothly, bubbles keep clear of the end card and use scene time; 4: a
 * side-view skid with a dir goes nose first, a humming voice keeps its lips closed, the place's sounds are listed;
 * 5: six sizes, 9:16, 1:1 and 16:9 at 1080 or 720 (the 1080 × 1920 frames are drawn as before), and a character
 * that carries its own faces shows only those, even the ones an action implies). */
export const ENGINE_VERSION = 5;

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

/** One character, drawn into a size × size box from (0, 0): the Characters page and every cast picker. */
export function previewCharacter(look: CharacterLook, style: MovementStyle, expression: Expression, action: ActionId, t: number, size: number): Prim[] {
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
  pen.ellipse(x - lie * 40 * px, y + 2, (30 + lie * 30) * px, 6 * px, 0, "#000000", 0.18);
  pen.save();
  pen.translate(x, y);
  pen.scale(px, px);
  drawCharacter(pen, look, g, pose, { t, seed, face: FACES[expression] ?? FACES.neutral, inCar: false });
  pen.restore();
  drawExtras(pen, state, seed, g, size / 2, y, px, t);
  return pen.out;
}
