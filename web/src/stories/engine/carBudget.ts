// Clips Funded engine: the shape budget of a vehicle look (CONTRACTS §45.48 section 4). A look without `detail` costs
// exactly what it always did (car.ts: CAR_CAST_SHAPES 56 / CAR_CAST_SHAPES_ND 72 / CAR_VIEW_SHAPES 34), so no stored
// script is priced again. A detailed look is measured by drawing it once into a counting pen at full detail, with its
// lights on, braking and a flat tyre, then adding the effects and the face, and is held at the caps below. car.ts
// re-exports both functions so old imports keep working.

import { LIGHTS, withWarm } from "./art.ts";
import { CAR_CAST_SHAPES, CAR_CAST_SHAPES_ND, CAR_VIEW_SHAPES, type CarDraw } from "./car.ts";
import { drawCarView, type CarViewOpts } from "./carView.ts";
import { F, inFrame } from "./frame.ts";
import { Pen } from "./pen.ts";
import { drawProp, propState } from "./props.ts";
import type { ArtStyle, CarLook, SceneProp } from "./types.ts";

/** The most any detailed look may draw, Bright. */
export const CAR_DETAIL_SHAPES = 88;
/** The same in night drive. */
export const CAR_DETAIL_SHAPES_ND = 112;
/** A detailed look's front or back view. */
export const CAR_VIEW_DETAIL_SHAPES = 64;

/** What the busiest effects add on top of the body (smoke, sparks, honk rings, skid dust), Bright and night drive. */
const EFFECTS = 12;
const EFFECTS_ND = 14;
/** What a face adds (eyes, lids and a mouth). */
const FACE = 9;
/** The look is drawn on the usual 1080 x 1920 frame at the size a car of the cast is usually staged at, a little over. */
const STAGE = { width: 1080, height: 1920 };
const MEMO_MAX = 16;

const memo = new Map<string, number>();

function remembered(key: string, make: () => number): number {
  const had = memo.get(key);
  if (had !== undefined) return had;
  const n = make();
  // a script holds at most two cars (LIMITS.cars); the memo never grows past a few looks
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(key, n);
  return n;
}

const hasEyes = (look: CarLook): boolean => look.face !== undefined && look.face.eyes !== "none";

/** The busiest frame of a car of the cast with this look (side or top view, eyes on). No `detail`: exactly 56 / 72. */
export function carShapes(look: CarLook, art: ArtStyle): number {
  const night = art === "night_drive";
  if (look.detail === undefined) return night ? CAR_CAST_SHAPES_ND : CAR_CAST_SHAPES;
  return remembered(`${art}|${JSON.stringify(look)}`, () => {
    const prop: SceneProp = { propId: "budget", kind: "car", x: 0.5, y: 0.72, scale: 1, rot: 0, castId: "budget", state: "flat lights brakes" };
    const d: CarDraw = { car: look, style: "bouncy", seed: 11 };
    let body = 0;
    inFrame({ ...STAGE, art }, () => {
      for (const view of ["side", "top"] as const) {
        for (const t of [0.45, 1.2]) {
          const st = propState(prop, [], view, t, { braking: 1, steer: 0, rolled: t * 300 }, d);
          const pen = new Pen();
          drawProp(pen, st, view, t, 3, {}, night, d);
          body = Math.max(body, pen.out.length);
        }
      }
    });
    const n = body + (night ? EFFECTS_ND : EFFECTS) + (hasEyes(look) ? FACE : 0);
    return Math.min(night ? CAR_DETAIL_SHAPES_ND : CAR_DETAIL_SHAPES, n);
  });
}

/** The busiest front or back view of this look. No `detail`: exactly 34. */
export function carViewShapes(look: CarLook): number {
  if (look.detail === undefined) return CAR_VIEW_SHAPES;
  return remembered(`view|${JSON.stringify(look)}`, () => {
    const light = withWarm(LIGHTS.night, 1);
    let busiest = 0;
    inFrame({ ...STAGE, art: "night_drive" }, () => {
      F.light = light;
      for (const view of ["front", "back"] as const) {
        for (const side of [0, 0.8, -0.8]) {
          for (const lights of [false, true]) {
            for (const face of hasEyes(look) ? (["happy", "surprised"] as const) : [null]) {
              const o: CarViewOpts = { x: 540, y: 1200, w: 300, side, light, braking: lights ? 1 : 0, lights, blink: 0, face, t: 0.5, seed: 3 };
              const pen = new Pen();
              drawCarView(pen, look, view, o);
              busiest = Math.max(busiest, pen.out.length);
            }
          }
        }
      }
    });
    return Math.min(CAR_VIEW_DETAIL_SHAPES, busiest);
  });
}
