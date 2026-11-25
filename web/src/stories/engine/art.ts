// Lamo Stories engine: the night drive drawing style's palette, light, line and shading (CONTRACTS §45.45). A script
// with `art: "night_drive"` is drawn with soft thin outlines, cel shading, rim light, soft shadows and a muted night
// palette with sodium street lights; a script without it (every older one) draws exactly as before. Pure functions
// of the colour, the light and `F` (frame.ts), with no Date and no Math.random, so the preview and the final video
// are the same picture. Every token is our own, tuned to a mood; nothing here copies anyone's characters or scenes.

import { F, STUDIO_LIGHT } from "./frame.ts";
import { channels, clamp, mix, toHex } from "./math.ts";
import { joinShapes, type Pen } from "./pen.ts";
import type { Hex } from "./types.ts";

/** The light a part stands in. `grade` passes every own colour (a character's skin, a car's paint, a place's palette
 * row) through it; token colours (ND) are final and are not graded. */
export interface Light {
  /** the light's colour, multiplied in by `amount` */
  ambient: Hex;
  amount: number;
  /** 0..1 towards grey */
  desat: number;
  /** 0..1 towards ND.celDark */
  dark: number;
  /** 0..1: the street lamps' warm pulse (night places, inside the car) */
  warm: number;
  /** the rim light's colour and alpha */
  rim: Hex;
  rimA: number;
  night: boolean;
}

/** The lights (§45.45): studio changes nothing (previews and portraits keep the owner's picked colours), day and
 * indoor mute a little, night and cabin are the blue night with the sodium rim. scene.ts picks one per place and
 * part, and sets `warm` (with night's rim alpha 0.40 + 0.25 × warm) through `withWarm`. */
export const LIGHTS: Record<"studio" | "day" | "indoor" | "night" | "cabin", Readonly<Light>> = {
  studio: STUDIO_LIGHT,
  day: Object.freeze({ ambient: "#ece6dc", amount: 0.22, desat: 0.18, dark: 0.04, warm: 0, rim: "#fff6e5", rimA: 0.3, night: false }),
  indoor: Object.freeze({ ambient: "#f0d9b8", amount: 0.25, desat: 0.12, dark: 0.06, warm: 0, rim: "#ffe2b8", rimA: 0.28, night: false }),
  night: Object.freeze({ ambient: "#a7a3b8", amount: 0.6, desat: 0.1, dark: 0.1, warm: 0, rim: "#ffb35c", rimA: 0.4, night: true }),
  cabin: Object.freeze({ ambient: "#8f93ad", amount: 0.62, desat: 0.1, dark: 0.16, warm: 0, rim: "#ffb35c", rimA: 0.45, night: true }),
};

/** A light with the lamps' warm pulse in it: a night light's rim grows by 0.25 × warm. */
export function withWarm(L: Readonly<Light>, warm: number): Light {
  const w = clamp(warm, 0, 1);
  return { ...L, warm: w, rimA: L.night ? L.rimA + 0.25 * w : L.rimA };
}

/** The night drive palette (§45.45 §3): exact values, final colours (never graded). */
export const ND = {
  // night sky
  skyTop: "#141f3d",
  skyHigh: "#1e305a",
  skyMid: "#2f4369",
  skyHorizon: "#4d5a77",
  star: "#e8e6f2",
  // mountains
  mtnFar: "#1d3339",
  mtnFarLit: "#26434a",
  mtnNear: "#163a3b",
  mtnNearLit: "#1f4a4a",
  mtnRim: "#2e5a5c",
  cityGlow: "#ffb35c",
  cityDot: "#ffcf7a",
  // road
  asphalt: "#2e2a20",
  asphaltFar: "#3a3629",
  lane: "#d8d4c4",
  laneFar: "#aba896",
  edge: "#cfcabb",
  kerb: "#4a4840",
  verge: "#1f2a2a",
  vergeNear: "#182222",
  railLit: "#8a8c80",
  rail: "#6c6e60",
  railShadow: "#444845",
  railPost: "#3e4140",
  /** night drive's guard rail: two slim bars in a dark blue-grey (darker than the lane lines), a thin cool highlight
   * along the top (railSide, perspective.ts RAIL_BARS) */
  railBar: "#5d6470",
  railGlint: "#8e99ab",
  // lamps
  pole: "#364767",
  poleDark: "#263248",
  lampCore: "#fffdf1",
  /** the lamp's warm yellow lens around its small white-hot centre (lampCore) */
  lampHead: "#ffd47a",
  halo1: "#ffcf7a",
  halo2: "#ffb35c",
  halo3: "#ff9a3c",
  pool: "#ffb35c",
  cone: "#ffcf7a",
  /** night drive's street lamp (sets.ts lampGlow): a warm white-yellow emitter under a small dark grey head, its
   * glow falling off from gold (lampGlowIn) through amber (lampGlowOut) to clear, on a slate grey pole */
  lampLens: "#fff6d8",
  lampGlowIn: "#f2c76a",
  lampGlowOut: "#d98a3a",
  lampHousing: "#34373e",
  lampPole: "#4a5162",
  lampPoleDark: "#343a48",
  // car lights
  headCore: "#fdfdfd",
  headBloom: "#fff7e0",
  beam: "#fff3d0",
  tailCore: "#ff2d2d",
  tailGlow: "#ff3b30",
  brakeCore: "#ff5a4a",
  marker: "#caae3c",
  // inside the car
  cabinRoof: "#2a282c",
  pillar: "#312f33",
  pillarLit: "#4a474d",
  pillarInk: "#1b1a1e",
  dashTop: "#46454b",
  dashFace: "#2b2a2f",
  dashLip: "#1c1b1f",
  vent: "#1f1e22",
  ventSlat: "#3a393f",
  button: "#34333a",
  ledWarm: "#ffb35c",
  ledCool: "#7fd1ff",
  wheel: "#252525",
  wheelLit: "#3a3a3e",
  wheelHub: "#1f1f22",
  seat: "#2d2d2f",
  seatInk: "#1d1c20",
  seatStitch: "#3a393e",
  floor: "#23212b",
  pedal: "#6a6870",
  pedalGroove: "#4a4850",
  glassIn: "#0e1424",
  mirrorHousing: "#232227",
  // speed dial
  dialFace: "#151417",
  bezel: "#5a5a60",
  bezelLit: "#8a8a92",
  tick: "#f2efe6",
  redZone: "#c0392b",
  needle: "#ff7a1a",
  needleGlow1: "#ff9a3c",
  needleGlow2: "#ffb35c",
  hub: "#2a292e",
  // people
  ink: "#2a211c",
  eye: "#17110f",
  glint: "#fff6e5",
  mouthLine: "#2a1a17",
  mouthInside: "#5a1414",
  tongue: "#7a2a26",
  teeth: "#efe9dc",
  blush: "#c0756a",
  flush: "#a33a2a",
  /** the chunky people (rig.ts, face.ts): the warm white of an eye, the pink of a round cheek, the pale rubber of a
   * shoe's sole and toe cap, the darker gum sole under a pale shoe, and the warm white of a glossy streak. The eye
   * white and the rubber stand in the place's light (art.ts `lit`), so they never glow at night. */
  eyeWhite: "#fbf5ea",
  cheek: "#e8776c",
  sole: "#f1e7d6",
  soleGum: "#8a6a4f",
  gloss: "#fff3dc",
  // shading
  celDark: "#141018",
  ao: "#0b0a10",
  rimNight: "#ffb35c",
  rimDay: "#fff6e5",
  vignette: "#05060c",
} as const satisfies Record<string, Hex>;

/** True while the script being drawn is in night drive (every new drawing path sits behind it). */
export const nightDrive = (): boolean => F.art === "night_drive";

/** The luma grey of a colour (0.2126, 0.7152, 0.0722 of its sRGB channels). */
function grey(c: Hex): Hex {
  const [r, g, b] = channels(c);
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return toHex(y, y, y);
}

/** The channel product of two colours, / 255. */
function mul(a: Hex, b: Hex): Hex {
  const [r1, g1, b1] = channels(a);
  const [r2, g2, b2] = channels(b);
  return toHex((r1 * r2) / 255, (g1 * g2) / 255, (b1 * b2) / 255);
}

/** An own colour as it looks in the light: a little grey (desat), multiplied by the light's colour (amount), darker
 * (dark), and warmed by the lamps' pulse. Every step rounds to "#rrggbb", so it is the same everywhere. The studio
 * light gives the colour back unchanged. */
export function grade(c: Hex, L: Readonly<Light> = F.light): Hex {
  if (L.amount === 0 && L.desat === 0 && L.dark === 0 && L.warm <= 0) return c;
  const d = mix(c, grey(c), L.desat);
  let g = mix(d, mul(d, L.ambient), L.amount);
  g = mix(g, ND.celDark, L.dark);
  if (L.warm > 0) g = mix(g, mul(c, "#ffc07a"), 0.3 * L.warm);
  return g;
}

/** A pale token (an eye's white, a shoe's rubber sole) as it looks in the light: `k` of the way to its graded tone, so
 * it dims with the night but stays the brightest thing on a face. The studio light gives it back unchanged. */
export function lit(c: Hex, k = 0.7): Hex {
  return mix(c, grade(c), k);
}

/** The cel shadow of a colour: k of the way to ND.celDark. */
export function cel(c: Hex, k = 0.22): Hex {
  return mix(c, ND.celDark, k);
}

/** A lit top surface (roofs, bonnets, the top of the head, shoulders, dashboard tops): k of the way to white, then
 * warmed by the lamps' pulse (F.light.warm × 0.12 towards #ffcf8a). */
export function lift(c: Hex, k = 0.1): Hex {
  const up = mix(c, "#ffffff", k);
  const w = F.light.warm;
  return w > 0 ? mix(up, "#ffcf8a", w * 0.12) : up;
}

/** The outline colour of an own outline: half way to the soft brown ink, never the heavy navy. */
export function ink(outline: Hex): Hex {
  return mix(outline, ND.ink, 0.5);
}

/** A person's outline in design px for a head drawn at `designPxPerUnit` design px per rig unit: 2 to 3.6 px. */
export function inkPx(designPxPerUnit: number): number {
  return clamp(1.8 + 0.1 * designPxPerUnit, 2, 3.6);
}

/** A width of `designPx` design px in the pen's local units now (the pen's scale already holds the output scale). */
export function lineUnits(pen: Pen, designPx: number): number {
  const u = pen.unit();
  return u > 0 ? (designPx * F.k) / u : designPx;
}

const SOFT_RINGS = new Map<string, readonly (readonly [number, number])[]>();

/** A soft light's rings (§45.45): `n` stacked rings, the biggest first, each [t, alpha], t being how far out the ring
 * reaches from the light's own edge as a part of the whole glow (1 the outermost). Painted one over the other they
 * build up the falloff peak · (1 − t)^power, in steps that grow with the square of the ring's number, so the faint
 * outside (where a step shows most on a dark sky) moves in the smallest steps and no ring edge reads as a ring. Each
 * ring's edge sits where the falloff crosses the middle of its step. Stacked shapes, no gradient, so both drawers
 * paint it the same. */
export function softRings(n: number, peak = 0.85, power = 3): readonly (readonly [number, number])[] {
  const k = Math.max(1, Math.round(n));
  const key = `${k} ${peak} ${power}`;
  const hit = SOFT_RINGS.get(key);
  if (hit) return hit;
  const out: [number, number][] = [];
  let before = 0;
  for (let j = 1; j <= k; j += 1) {
    const level = peak * (j / k) ** 2;
    const mid = (before + level) / 2;
    out.push([1 - (mid / peak) ** (1 / power), 1 - (1 - level) / (1 - before)]);
    before = level;
  }
  SOFT_RINGS.set(key, out);
  return out;
}

const FADES = new Map<string, readonly (readonly [number, number])[]>();
/** How many stops a fade has: 16, so the straight pieces between them never show as a ring. */
const FADE_STOPS = 16;

/** A glow's fade (pen.glow, the `glow` prim): peak · (1 − d)^power at 16 stops from the centre (d 0) to the edge
 * (d 1, alpha 0), denser near the centre where it falls fastest. A real gradient, so no step shows however big the
 * light is; the same numbers every time. */
export function fadeStops(peak: number, power = 2): readonly (readonly [number, number])[] {
  const key = `${peak} ${power}`;
  const hit = FADES.get(key);
  if (hit) return hit;
  const out: [number, number][] = [];
  for (let i = 0; i < FADE_STOPS; i += 1) {
    const d = (i / (FADE_STOPS - 1)) ** 1.3;
    out.push([d, peak * (1 - d) ** power]);
  }
  FADES.set(key, out);
  return out;
}

const HALOS = new Map<string, readonly (readonly [number, number])[]>();

/** A car light's fade round its lens (pen.glow): flat at `peak` out to `inner` (the lens's own edge as a part of the
 * glow's radius, to 0.01), then peak · (1 − t)^power on out to the edge (t 0 at `inner`, 1 at the edge, alpha 0).
 * softRings' falloff as one smooth gradient: the same light, no ring edges. 16 stops, as fadeStops. */
export function haloStops(peak: number, inner: number, power = 3): readonly (readonly [number, number])[] {
  const k = Math.round(clamp(inner, 0, 0.95) * 100) / 100;
  if (k <= 0) return fadeStops(peak, power);
  const key = `${peak} ${k} ${power}`;
  const hit = HALOS.get(key);
  if (hit) return hit;
  const out: [number, number][] = [[0, peak]];
  for (let i = 0; i < FADE_STOPS - 1; i += 1) {
    const t = (i / (FADE_STOPS - 2)) ** 1.3;
    out.push([k + (1 - k) * t, peak * (1 - t) ** power]);
  }
  HALOS.set(key, out);
  return out;
}

const BELLS = new Map<string, readonly (readonly [number, number])[]>();

/** A pool of light's fade on the ground (pen.glow): peak · (1 − d²)^power at 16 even stops, flat-topped at its centre
 * (no bright point, as the light under a lamp) and ending at alpha 0, so pools that overlap add up with no seam. A
 * bell of `power` 2 over a glow 1.35 × a flat pool's size is as much light as that pool at 1.65 × its alpha. */
export function bellStops(peak: number, power = 2): readonly (readonly [number, number])[] {
  const key = `${peak} ${power}`;
  const hit = BELLS.get(key);
  if (hit) return hit;
  const out: [number, number][] = [];
  for (let i = 0; i < FADE_STOPS; i += 1) {
    const d = i / (FADE_STOPS - 1);
    out.push([d, peak * (1 - d * d) ** power]);
  }
  BELLS.set(key, out);
  return out;
}

/** How much bigger a soft pool of light (bellStops) is than the flat pool it replaces, and how much brighter at its
 * middle, so it is as much light. */
export const POOL_GROW = 1.35;
export const POOL_LIFT = 1.65;

/** How many soft rings a glow reaching `px` design px out on screen gets: one every 2.6 px, 3 to 20. */
export const softCount = (px: number): number => clamp(Math.round(px / 2.6), 3, 20);

/** Night drive's guard rail seen side on (the side window, the side view, the slivers of side window up close): from
 * x0 to x1 along `y`, `h` high (pen px) from the top of its upper bar to the bottom of its lower one; two slim bars
 * (ND.railBar) as one shape, the upper a little thicker, with a gap a fifth of `h` between them where the dark verge
 * behind shows, and a thin cool highlight (ND.railGlint) along the top. Two prims, as Bright's rail and lit line. */
export function railSide(pen: Pen, x0: number, x1: number, y: number, h: number, a = 1): void {
  const top = y - h / 2;
  const left = Math.min(x0, x1);
  const w = Math.abs(x1 - x0);
  pen.poly(joinShapes([rectPts(left, top, w, h * 0.42), rectPts(left, top + h * 0.62, w, h * 0.34)]), ND.railBar, a);
  pen.poly(rectPts(left, top, w, Math.max(1.4, h * 0.08)), ND.railGlint, a);
}

const rectPts = (x: number, y: number, w: number, h: number): number[] => [x, y, x + w, y, x + w, y + h, x, y + h];

/** A light: three stacked halos (r × 5, 3 and 1.6 at a 0.07, 0.16 and 0.38 × k, the biggest first) and the core on
 * top. Stacked circles, no gradient, so both drawers paint it the same. */
export function glow(pen: Pen, x: number, y: number, r: number, core: Hex, halo: Hex, k = 1): void {
  pen.circle(x, y, r * 5, halo, 0.07 * k);
  pen.circle(x, y, r * 3, halo, 0.16 * k);
  pen.circle(x, y, r * 1.6, halo, 0.38 * k);
  pen.circle(x, y, r, core);
}
