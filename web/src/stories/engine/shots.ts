// Lamo Stories engine: the shots inside a scene (CONTRACTS §45.45 §8). A scene's `cuts` cut its picture to another
// shot while its action, beats and sound go on: the driver's eyes through the windscreen, the face up close from the
// dashboard, the side window, the rear-view mirror, the speed dial, the feet on the pedals, behind the car and down the
// road. Every shot reads the same scene state as the side view (scene.ts passes it in): where each car is along the
// way and in which lane, how fast the own car goes, who brakes, steers, honks or blinks, and the road's metres, so the
// lane dashes, posts and lamps stream on across cuts. Every shot fills the frame (no band, no letterbox) and is drawn
// only with the engine's prims, so the preview and the final video are the same picture.

import { fadeStops, grade, LIGHTS, lift, ND, nightDrive, railSide, softCount, softRings } from "./art.ts";
import { layerMatrix, shotCamera, type Cam } from "./camera.ts";
import type { CarDraw } from "./car.ts";
import { drawPropView } from "./carView.ts";
import { F } from "./frame.ts";
import { drawLightSweep, lampPhase, lightFor, metres, type LightPart } from "./light.ts";
import { channels, DEG, clamp, clamp01, ease, hash, hex, lerp, mix, noise, rand, smoothstep, toHex } from "./math.ts";
import type { ActorState } from "./motion.ts";
import { arcPts, clipConvex, joinShapes, roundRectPts, type Pen } from "./pen.ts";
import { depthAtRow, drawOutside, FOCAL, glassLamp, glassPoles, groundQuad, LANE_W, lampsBehind, project, pxPerM, roadPlan, sideLamps, type Cam3, type RoadPlan } from "./perspective.ts";
import { drawProp, drawWeather, plainColor, type Occupants, type PropState } from "./props.ts";
import { drawBust, drawFoot, drawWheelHands, type BustView, type Geo, type Pose } from "./rig.ts";
import { lampGlow, ridgeTop, roadLook, setInfo, type RoadLook } from "./sets.ts";
import type { Beat, CameraId, CharacterLook, Hex, Scene, SetId, ShotCue, ShotId } from "./types.ts";

/** The short side, design px: the shots' sizes are parts of it. */
const S = 1080;

// ---- which shot shows when --------------------------------------------------------------------------------------

/** The shot showing at a moment of a scene: its cue, and when it started and ends (seconds from the scene's start). */
export interface ShotSpan {
  cue: ShotCue;
  from: number;
  until: number;
}

const WHOLE: ShotCue = { at: 0, shot: "scene" };

/** The shot at scene time t: the whole scene before the first cut (and in a scene without cuts), then each cut's shot
 * until the next cut or the scene's end. */
export function shotAt(scene: Pick<Scene, "cuts" | "durationSec">, t: number): ShotSpan {
  const end = scene.durationSec;
  const cuts = Array.isArray(scene.cuts) ? scene.cuts : [];
  if (!cuts.length) return { cue: WHOLE, from: 0, until: end };
  const list = [...cuts].sort((a, b) => a.at - b.at);
  let span: ShotSpan = { cue: WHOLE, from: 0, until: list[0]!.at };
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i]!;
    if (c.at > t) break;
    span = { cue: c, from: c.at, until: list[i + 1]?.at ?? end };
  }
  return span;
}

/** The first cut after scene time t (Infinity when there is none): a bubble never shows across it. */
export function nextCutAfter(scene: Pick<Scene, "cuts">, t: number): number {
  let next = Infinity;
  for (const c of Array.isArray(scene.cuts) ? scene.cuts : []) if (c.at > t + 1e-9 && c.at < next) next = c.at;
  return next;
}

/** About how many shapes each shot draws at its busiest: its place, the inside of the car, the own car and the driver,
 * before the other cars it shows (each at most CAR_VIEW_SHAPES of car.ts). Measured by web/test/storiesNightShots.test.ts
 * on every road place, size and style (the side window with a car of the cast alongside in its side view); the
 * writer's estimate (script.ts sceneShapes) reads it. */
export const SHOT_SHAPES: Record<ShotId, number> = {
  scene: 0,
  driver_view: 299,
  face: 164,
  side_window: 165,
  mirror: 226,
  speed_dial: 123,
  pedals: 76,
  road_behind: 235,
  road_wide: 236,
};
/** At most this many other cars show in a shot (the nearest ones). */
export const SHOT_CARS = 4;

// ---- what scene.ts passes in ------------------------------------------------------------------------------------

/** A character in the scene now. */
export interface ShotPerson {
  castId: string;
  look: CharacterLook;
  geo: Geo;
  st: ActorState;
  seed: number;
  /** the car it sits in now (its seat shows), or null standing outside */
  car: string | null;
  /** its place among that car's riders (0 drives) */
  seat: number;
}

/** A car or truck in the scene now. */
export interface ShotCar {
  st: PropState;
  /** a car of the cast, drawn as itself; null for a plain car or truck */
  draw: CarDraw | null;
  truck: boolean;
  /** how fast it drives (0..1.3) at a scene time, while someone drives it; null otherwise */
  speedAt: ((time: number) => number) | null;
  /** its riders, for the side view's drawing (the side window shows a car alongside with its people) */
  occ: Occupants;
}

export interface ShotInput {
  set: SetId;
  span: ShotSpan;
  t: number;
  dur: number;
  seed: number;
  /** the side view's scroll (design px, signed) and whether a car is rolling the road by */
  scroll: number;
  rolling: boolean;
  /** the lamps' warm pulse (light.ts) */
  warm: number;
  people: ShotPerson[];
  cars: ShotCar[];
  steering: Map<string, number>;
  camera: CameraId;
  impacts: number[];
  beats: Beat[];
  /** a safety story's last scene in a square or wide frame: the end card's bottom (design px) and when it shows */
  card: { bottom: number; from: number } | null;
}

// ---- the shot's world (§8.1) ------------------------------------------------------------------------------------

interface Other {
  car: ShotCar;
  /** metres along the way the own car faces: + ahead, - behind */
  ahead: number;
  gap: number;
  /** across: 0 the own lane, -3.6 the other lane */
  X: number;
  oncoming: boolean;
  /** a skid or spin rolls its view (degrees); a bump or a burst jolts it (0..1) */
  roll: number;
  jolt: number;
}

interface World {
  driver: ShotPerson | null;
  own: ShotCar | null;
  dir: number;
  others: Other[];
  /** the road's metres (always growing) */
  m: number;
  steer: number;
  braking: number;
  look: RoadLook;
  plan: RoadPlan;
}

const lane = (y: number): number => (y < 0.72 ? 1 : 0);

function worldOf(x: ShotInput): World {
  const seated = x.people.filter((p) => p.car !== null);
  const who = x.span.cue.who;
  // the cut's person when it sits in a car, else the scene's first rider (validateScript checks the same one)
  const driver = (who ? seated.find((p) => p.castId === who) : undefined) ?? seated[0] ?? null;
  const own = driver ? (x.cars.find((c) => c.st.prop.propId === driver.car) ?? null) : null;
  const dir = own && own.st.facing < 0 ? -1 : 1;
  const ownLane = own ? lane(own.st.y) : 0;
  const others: Other[] = [];
  for (const car of x.cars) {
    if (car === own || !car.st.visible || car.st.alpha < 0.05 || car.st.scale < 0.05) continue;
    const along = (car.st.x - (own ? own.st.x : 0.5)) * dir * (F.w / 1080) * 20;
    const oncoming = !!own && (car.st.facing < 0 ? -1 : 1) !== dir;
    const side = rand(hash(x.seed, car.st.prop.propId), 1) < 0.5 ? -1 : 1;
    const jolt = Math.max(car.st.bumpAge >= 0 && car.st.bumpAge < 0.5 ? Math.exp(-car.st.bumpAge * 6) : 0, car.st.burstAge >= 0 && car.st.burstAge < 0.5 ? Math.exp(-car.st.burstAge * 6) : 0);
    others.push({
      car,
      ahead: along,
      gap: Math.max(4, Math.abs(along)),
      X: oncoming || lane(car.st.y) !== ownLane ? -LANE_W : 0,
      oncoming,
      roll: 15 * clamp01(car.st.skidding) * side + (car.st.spinX < 0.999 ? 15 * (1 - car.st.spinX) * 0.5 * side : 0),
      jolt,
    });
  }
  const look = roadLook(x.set);
  return {
    driver,
    own,
    dir,
    others,
    m: metres(Math.abs(x.scroll)),
    steer: own ? (x.steering.get(own.st.prop.propId) ?? 0) : 0,
    braking: own ? own.st.braking : 0,
    look,
    plan: roadPlan(look),
  };
}

/** The shots that need someone sitting in a car on a road (Face up close needs only a person). */
const CAR_SHOTS = new Set<ShotId>(["driver_view", "side_window", "mirror", "speed_dial", "pedals", "road_behind"]);

/** Whether the shot can show now: a car shot needs a rider in a car on a road, Down the road a road, Face up close a
 * person. scene.ts draws the whole scene when it cannot (validateScript keeps the writer's cuts to what can show). */
function canShow(x: ShotInput, w: World): boolean {
  const shot = x.span.cue.shot;
  const road = setInfo(x.set).road;
  if (shot === "scene") return false;
  if (shot === "face") return !!faceSubject(x, w);
  if (shot === "road_wide") return road;
  if (CAR_SHOTS.has(shot)) return road && !!w.driver && !!w.own;
  return false;
}

/** Whether the shot of `x.span` shows now (otherwise the scene draws the whole scene). */
export function shotShows(x: ShotInput): boolean {
  return canShow(x, worldOf(x));
}

function faceSubject(x: ShotInput, w: World): ShotPerson | null {
  const who = x.span.cue.who;
  return (who ? x.people.find((p) => p.castId === who) : undefined) ?? w.driver ?? x.people[0] ?? null;
}

// ---- helpers ----------------------------------------------------------------------------------------------------

const tall = (): boolean => F.aspect === "9:16";
/** A layout number: the 9:16 one, or the 16:9 one (1:1 shares 16:9's parts, squeezed to its width). */
const P = (tallV: number, wideV: number): number => (tall() ? tallV : wideV);

/** Night drive sets the part's light (§4.2); classic keeps the studio light, so nothing is graded (at a night place
 * its cars still light up). */
function lightPart(x: ShotInput, part: LightPart): void {
  F.light = nightDrive() ? lightFor(x.set, part, x.warm) : { ...LIGHTS.studio, night: setInfo(x.set).night };
}

function rotateAbout(pen: Pen, x: number, y: number, deg: number): void {
  if (Math.abs(deg) < 1e-6) return;
  pen.translate(x, y);
  pen.rotate(deg);
  pen.translate(-x, -y);
}

/** An arc drawn as a few short lines, so each is rasterized over a small box (a whole rim in one line costs its whole
 * box); angles in degrees, clockwise on screen; `segs` straight steps in each piece. */
function arcLine(pen: Pen, cx: number, cy: number, r: number, a0: number, a1: number, w: number, color: Hex, a = 1, pieces = 8, segs = 4): void {
  for (let i = 0; i < pieces; i += 1) {
    const f0 = a0 + ((a1 - a0) * i) / pieces;
    const f1 = a0 + ((a1 - a0) * (i + 1)) / pieces;
    pen.line(arcPts(cx, cy, r, r, f0, f1, segs), w, color, a);
  }
}

/** Night drive: how many straight steps an arc of radius `r` (pen units) over `deg` degrees needs so that, as it shows
 * now, no step's middle falls more than 0.15 output px inside the true curve (a 460 px rim: about 120), at least
 * `least`; classic keeps `least`. */
function roundSegs(pen: Pen, r: number, deg: number, least: number): number {
  if (!nightDrive()) return least;
  return Math.max(least, Math.ceil(Math.abs(deg) * DEG * Math.sqrt((r * pen.unit()) / 1.2)));
}

/** arcLine's steps per piece for a smooth night drive arc (roundSegs over `pieces` pieces), 4 in classic. */
const pieceSegs = (pen: Pen, r: number, deg: number, pieces: number): number => Math.ceil(roundSegs(pen, r, deg, 4 * pieces) / pieces);

/** Everything of the box (ox0, oy0)-(ox1, oy1) but a rounded window (x0, y0)-(x1, y1), as rects round it and a fillet
 * in each rounded corner (radii top-left, top-right, bottom-right, bottom-left): the inside of a car round a window,
 * rasterized only where it shows (a keyhole would cost the whole box). */
function frameRound(pen: Pen, ox0: number, oy0: number, ox1: number, oy1: number, x0: number, y0: number, x1: number, y1: number, radii: [number, number, number, number], color: Hex): void {
  pen.rect(ox0, oy0, ox1 - ox0, y0 - oy0, 0, color);
  pen.rect(ox0, y1, ox1 - ox0, oy1 - y1, 0, color);
  pen.rect(ox0, y0 - 1, x0 - ox0, y1 - y0 + 2, 0, color);
  pen.rect(x1, y0 - 1, ox1 - x1, y1 - y0 + 2, 0, color);
  const corners: [number, number, number, number, number][] = [
    [x0, y0, 1, 1, radii[0]],
    [x1, y0, -1, 1, radii[1]],
    [x1, y1, -1, -1, radii[2]],
    [x0, y1, 1, -1, radii[3]],
  ];
  for (const [cx, cy, sx, sy, r] of corners) {
    if (r <= 0.5) continue;
    const a0 = Math.atan2(-sy, -sx) / DEG;
    pen.poly([cx - sx * 0.5, cy - sy * 0.5, ...arcPts(cx + sx * r, cy + sy * r, r, r, a0 - 45, a0 + 45, 6)], color);
  }
}


/** The own car's paint (its bonnet in Driver's eyes). */
function paintOf(car: ShotCar): Hex {
  return car.draw && !car.truck ? hex(car.draw.car.paint, "#c9a227") : plainColor(car.st.prop, nightDrive());
}

/** A car's front or back view (carView.ts) with its moves: brake lights, blinking headlights, a face, a roll and a
 * jolt. The origin is the ground at the car's centre on screen; `w` its width; `side` (-1..1) how much of its right
 * side shows (a car left of the vanishing point shows its right side). */
function viewCar(pen: Pen, car: ShotCar, view: "back" | "front", x: number, y: number, w: number, side: number, t: number, roll = 0, jolt = 0, bloom = 1): void {
  pen.save();
  if (jolt > 0.01) pen.translate(noise(hash(car.st.prop.propId) % 97, t * 30) * 8 * jolt, -Math.abs(noise(31, t * 30)) * 6 * jolt);
  rotateAbout(pen, x, y, roll);
  if (car.st.alpha < 1) pen.fade(car.st.alpha);
  drawPropView(pen, car.st, view, { x, y, w, side: clamp(side, -1, 1), light: F.light, t, seed: hash(car.st.prop.propId), bloom }, car.draw);
  pen.restore();
  if (jolt > 0.05) pen.circle(x, y - w * 0.4, w * 0.6, "#fff3b0", 0.25 * jolt);
}

/** The other cars a camera sees (ahead of it at depth > zMin), the nearest SHOT_CARS of them, drawn far to near. `z`
 * turns a car's place into its depth. */
function drawTraffic(pen: Pen, c: Cam3, w: World, t: number, z: (o: Other) => number, zMin: number, W: number): void {
  const seen = w.others
    .map((o) => ({ o, Z: z(o) }))
    .filter((v) => v.Z > zMin)
    .sort((a, b) => a.Z - b.Z)
    .slice(0, SHOT_CARS)
    .reverse();
  for (const { o, Z } of seen) {
    const [sx, sy] = project(c, o.X, 0, Z);
    const cw = pxPerM(c, Z) * (o.car.truck ? 2.5 : 1.85);
    viewCar(pen, o.car, o.oncoming ? "front" : "back", sx, sy, cw, (c.vpX - sx) / (W * 0.45), t, o.roll, o.jolt);
  }
}

/** The weather of the place (and any rain, snow or fog prop) over an outside view. */
function weatherOver(pen: Pen, x: ShotInput, w: World): void {
  const kinds = new Set<"snow" | "rain" | "fog">();
  if (w.look.weather) kinds.add(w.look.weather);
  for (const k of kinds) {
    drawWeather(pen, k, x.t, x.seed, "back", 1);
    drawWeather(pen, k, x.t, x.seed, "front", 1);
  }
}

/** How a bust turns: a little idle turn (in Face up close and Side window), and ±0.6 for look_left and look_right. */
function bustTurn(p: ShotPerson, t: number): number {
  let look = 0;
  for (const b of p.st.active) {
    if (b.do !== "look_left" && b.do !== "look_right") continue;
    const k = Math.min(smoothstep(0, 0.2, t - b.at), 1 - smoothstep(b.dur - 0.2, b.dur, t - b.at));
    look += (b.do === "look_left" ? -0.6 : 0.6) * k;
  }
  return 0.08 * noise(p.seed + 17, 0.6 * t) + look;
}

/** The body bob while the road rolls (design px). */
function bob(x: ShotInput, p: ShotPerson): number {
  return x.rolling ? 2.2 * Math.sin(2 * Math.PI * 1.7 * x.t) + 1.2 * noise(p.seed + 23, x.t * 3) : 0;
}

/** Draws a bust with its head's centre at (hx, hy) and the head's rx at `rx` design px. */
function bust(pen: Pen, p: ShotPerson, hx: number, hy: number, rx: number, view: BustView, turn: number, lampSide: 1 | -1, t: number): void {
  const u = rx / p.geo.headRX;
  const pose: Pose = { ...p.st.pose, dx: 0, dy: 0, rot: 0, lean: 0, sx: 1, sy: 1, turn };
  pen.save();
  pen.translate(hx, hy);
  pen.scale(u);
  drawBust(pen, p.look, p.geo, pose, { t, seed: p.seed, face: p.st.face, inCar: true, view, lampSide, faceSince: p.st.faceSince });
  pen.restore();
}

// ---- the shots' layouts (shared with the bubbles) -----------------------------------------------------------------

interface BustLayout {
  hx: number;
  hy: number;
  rx: number;
}

/** In a safety story's last seconds (square and wide frames) a bust eases down and smaller so the head (its hair too)
 * stays below the end card, its chin in the frame. */
function clearCard(x: ShotInput, b: BustLayout, geo: Geo): BustLayout {
  if (!x.card) return b;
  const from = x.card.from - 0.4;
  if (x.t <= from) return b;
  const u = b.rx / geo.headRX;
  const ry = geo.headRY * u;
  const top = b.hy - ry - 12 * u;
  const chin = b.hy + ry;
  const need = x.card.bottom - top;
  if (need <= 0) return b;
  const k = ease.inOutSine(clamp01((x.t - from) / 0.4));
  const chinTo = Math.min(F.h - 16, chin + need);
  const s = clamp((chinTo - x.card.bottom) / (chin - top), 0.45, 1);
  const hyTo = chinTo - s * ry;
  return { hx: b.hx, hy: lerp(b.hy, hyTo, k), rx: lerp(b.rx, b.rx * s, k) };
}

/** The square frame is as narrow as 9:16 and as low as 16:9: its busts are a little smaller, so a bubble fits beside
 * the head, and the side window's driver sits where 9:16's does. */
const square = (): boolean => F.aspect === "1:1";

/** Face up close: the head low enough that a bubble fits above it under 9:16's top tabs and hair of any style stays
 * in the wider frames, a little left of the middle in the square frame so a bubble fits beside it. */
function faceLayout(x: ShotInput, p: ShotPerson): BustLayout {
  return clearCard(x, { hx: F.w * (square() ? 0.4 : 0.5), hy: F.h * (square() ? 0.54 : P(0.53, 0.56)), rx: (square() ? 0.25 : 0.3) * S }, p.geo);
}

function sideLayout(x: ShotInput, p: ShotPerson): BustLayout {
  return clearCard(x, { hx: F.w * (square() ? 0.36 : P(0.36, 0.3)), hy: F.h * (square() ? 0.54 : 0.5), rx: (square() ? 0.23 : 0.26) * S }, p.geo);
}

/** The shot's camera (§8.2) on its focus, as a pen matrix. */
function camFor(x: ShotInput, fx: number, fy: number): Cam {
  return shotCamera(x.camera, x.t, x.span.from, x.span.until, [fx, fy], x.seed, x.impacts, x.rolling);
}

/** How far hair reaches above a head, rig units (the tallest styles reach 12; this is the middle of the styles). */
const HAIR_UP = 9;

/** A head on screen as an ellipse round the face and hair (px). */
export interface HeadEllipse {
  x: number;
  y: number;
  ax: number;
  ay: number;
}

/** Where the big head of this shot is on screen (an ellipse round the face and its hair) in Face up close and Side
 * window, with whose head it is: bubbles go beside it or above it. Null for the shots without a face. */
export function shotHead(x: ShotInput): (HeadEllipse & { castId: string }) | null {
  const shot = x.span.cue.shot;
  if (shot !== "face" && shot !== "side_window") return null;
  const w = worldOf(x);
  if (!canShow(x, w)) return null;
  const p = shot === "face" ? faceSubject(x, w) : w.driver;
  if (!p) return null;
  const b = shot === "face" ? faceLayout(x, p) : sideLayout(x, p);
  const cam = camFor(x, b.hx, b.hy);
  const u = b.rx / p.geo.headRX;
  const hair = HAIR_UP * u * 0.5;
  const cy = b.hy - hair;
  const m = layerMatrix(cam, 1);
  const sx = m[0] * b.hx + m[2] * cy + m[4];
  const sy = m[1] * b.hx + m[3] * cy + m[5];
  // the ears and the bob a little wider, the hair on top
  return { castId: p.castId, x: sx, y: sy, ax: b.rx * 1.08 * cam.zoom, ay: (p.geo.headRY * u + hair) * cam.zoom };
}

// ---- drawing ------------------------------------------------------------------------------------------------------

/** Draws the shot of `x.span` into the pen (screen px of the frame), or returns false when it cannot show now (the
 * caller draws the whole scene). */
export function drawShot(pen: Pen, x: ShotInput): boolean {
  const w = worldOf(x);
  if (!canShow(x, w)) return false;
  const light = F.light;
  switch (x.span.cue.shot) {
    case "driver_view":
      driverView(pen, x, w);
      break;
    case "face":
      faceShot(pen, x, w, faceSubject(x, w)!);
      break;
    case "side_window":
      sideWindow(pen, x, w);
      break;
    case "mirror":
      mirrorShot(pen, x, w);
      break;
    case "speed_dial":
      speedDial(pen, x, w);
      break;
    case "pedals":
      pedals(pen, x, w);
      break;
    case "road_behind":
      roadBehind(pen, x, w);
      break;
    case "road_wide":
      roadWide(pen, x, w);
      break;
    default:
      return false;
  }
  F.light = light;
  return true;
}

// ---- Driver's eyes ------------------------------------------------------------------------------------------------

function driverView(pen: Pen, x: ShotInput, w: World): void {
  const W = F.w;
  const H = F.h;
  const hor = P(0.335, 0.4) * H;
  const dashY = P(0.585, 0.7) * H;
  const top = 0.03 * H;
  const vpX = W / 2 + w.steer * 0.03 * W;
  const c: Cam3 = { vpX, hor, f: FOCAL, camX: -0.35, camH: 1.2 };
  pen.setMatrix(layerMatrix(camFor(x, vpX, hor), 1));
  lightPart(x, "out");
  pen.save();
  rotateAbout(pen, vpX, hor, w.steer * 1.2);
  // only what the windscreen (and in the wider frames the side windows) shows: the pillars and the dash cover the rest
  const ox = tall() ? W * 0.05 - 40 : -80;
  drawOutside(pen, c, { look: w.look, plan: w.plan, m: w.m, t: x.t, seed: x.seed, sway: -(vpX - W / 2), x0: ox, x1: W - ox, top: 0, bottom: dashY + 12, zNear: depthAtRow(c, dashY) * 0.8, warm: x.warm });
  drawTraffic(pen, c, w, x.t, (o) => (o.ahead > 0 ? o.gap - 1.2 : -1), 2.2, W);
  pen.restore();
  weatherOver(pen, x, w);
  // a sliver of the own car's bonnet under the windscreen, in its paint with a lit edge
  const paint = grade(paintOf(w.own!));
  const bonnetTop = [-80, dashY - 0.008 * H, W * 0.25, dashY - 0.02 * H, W * 0.5, dashY - 0.026 * H, W * 0.75, dashY - 0.02 * H, W + 80, dashY - 0.008 * H];
  pen.poly([...bonnetTop, W + 80, dashY + 8, -80, dashY + 8], paint);
  pen.line(bonnetTop, 3, lift(paint, 0.25), 0.8);
  lightPart(x, "cabin");
  cabinFront(pen, x, w, top, dashY);
}

/** The inside of the car from the driver's seat: the windscreen's frame (roof, pillars, the dash), the mirror, the
 * dashboard's vents, buttons and dials, the wheel and the hands on it. */
function cabinFront(pen: Pen, x: ShotInput, w: World, top: number, dashY: number): void {
  const W = F.w;
  const H = F.h;
  const tl = tall();
  const pin = tl ? [0.12, 0.05] : [0.16, 0.08];
  // the A pillars either side of the windscreen (the roof and the dash cover the rest); in the wider frames a side
  // window shows past each pillar, darkened a little by its glass
  const mirrorX = (pts: number[]) => pts.map((v, i) => (i % 2 === 0 ? W - v : v));
  const pillar = tl
    ? [-90, top - 2, W * pin[0]!, top - 2, W * pin[1]!, dashY + 4, -90, dashY + 4]
    : [-90, top - 2, W * pin[0]!, top - 2, W * pin[1]!, dashY + 4, W * (pin[1]! - 0.06), dashY + 4, W * (pin[0]! - 0.065), top + 1, 0, top + 0.07 * H, -90, top + 0.07 * H];
  if (!tl) {
    const side = [0, top + 0.07 * H, W * (pin[0]! - 0.065), top, W * (pin[1]! - 0.06), dashY, 0, dashY];
    pen.poly(side, ND.glassIn, 0.18);
    pen.poly(mirrorX(side), ND.glassIn, 0.18);
  }
  pen.poly(pillar, ND.pillar);
  pen.poly(mirrorX(pillar), ND.pillar);
  pen.rect(-90, -90, W + 180, top + 90, 0, ND.cabinRoof);
  // the pillars' soft ink edges and the lamps' light along them
  for (const s of [1, -1]) {
    const ex0 = s > 0 ? W * pin[0]! : W * (1 - pin[0]!);
    const ex1 = s > 0 ? W * pin[1]! : W * (1 - pin[1]!);
    pen.line([ex0, top, ex1, dashY], 3, ND.pillarInk, 0.9);
    pen.line([ex0 - s * 4, top + 4, ex1 - s * 4, dashY - 4], 4, ND.pillarLit, (s > 0 ? 0.7 : 0.5) + 0.3 * x.warm);
  }
  // the rear-view mirror at the top, with the lights of a car close behind in it
  const mw = 0.36 * S;
  const mh = 0.075 * S;
  const mx = W / 2;
  const my = P(0.085, 0.1) * H;
  pen.line([mx, top - 20, mx, my - mh / 2], 10, ND.mirrorHousing);
  pen.rect(mx - mw / 2, my - mh / 2, mw, mh, mh / 2, ND.mirrorHousing);
  pen.rect(mx - mw / 2 + 8, my - mh / 2 + 7, mw - 16, mh - 14, mh / 2 - 7, "#1f2c44");
  pen.line([mx - mw / 2 + mh / 2, my - mh / 2 + 3, mx + mw / 2 - mh / 2, my - mh / 2 + 3], 2.5, ND.pillarLit, 0.6);
  const behind = w.others.filter((o) => o.ahead < 0 && o.gap < 45).sort((a, b) => a.gap - b.gap)[0];
  const gx = mx - mw / 2 + 8;
  const gy = my - mh / 2 + 7;
  const gw = mw - 16;
  const gh = mh - 14;
  const glass = roundRectPts(gx, gy, gw, gh, gh / 2);
  const hz = my + gh * 0.02;
  // a car close behind: its headlights' half spacing in the mirror
  const sp = behind ? clamp(60 / behind.gap, 6, 28) : 0;
  if (nightDrive()) {
    // night drive: a faint reflection of the road behind and its centre line, and with nobody close behind a pair of
    // small headlights far down it
    const vx = mx - w.steer * gw * 0.06 + noise(x.seed + 51, x.t * 0.25) * gw * 0.04;
    pen.poly(clipConvex([gx, hz, gx + gw, hz, gx + gw, gy + gh, gx, gy + gh], glass), "#1a2233", 0.85);
    pen.poly(clipConvex([vx - 5, hz, vx + 5, hz, vx + gw * 0.34, gy + gh + 2, vx - gw * 0.34, gy + gh + 2], glass), "#2a2a30", 0.9);
    // the centre line: three short faint dashes, longer the nearer they come, and none of them in a headlight's glow
    const bottom = gy + gh;
    const clear = behind ? (sp * 1.85 + 4) / (bottom - hz) : 0;
    const ddx = gw * 0.12 - 3;
    const ddy = bottom - hz;
    const dl = Math.hypot(ddx, ddy) || 1;
    // a point on the line, 0.7 px (half the dash's width) to one side of it
    const at = (t: number, side: number): number[] => [vx + 3 + ddx * t + (side * 0.7 * ddy) / dl, hz + ddy * t - (side * 0.7 * ddx) / dl];
    const dashes: number[][] = [];
    for (const [t0, t1] of [[0.34, 0.42], [0.56, 0.7], [0.82, 0.96]] as const) {
      const from = Math.max(t0, clear);
      if (from <= t1 - 0.04) dashes.push([...at(from, -1), ...at(from, 1), ...at(t1, 1), ...at(t1, -1)]);
    }
    if (dashes.length) pen.poly(joinShapes(dashes), ND.laneFar, 0.22);
    if (!behind) mirrorLights(pen, [vx - 16, vx], hz + 4, 1.8, 7.5, 0.85, glass);
  }
  if (behind) {
    const ox = behind.X === 0 ? 0 : -mw * 0.22;
    // night drive: a car close behind sits on the reflected road, its lights a little under the horizon
    if (nightDrive()) mirrorLights(pen, [mx + ox - sp, mx + ox + sp], hz + sp * 0.35, Math.max(2.4, sp * 0.3), sp * 1.1, 1, glass);
    else {
      for (const s of [-1, 1]) {
        pen.circle(mx + ox + s * sp, my, sp * 0.9, ND.headBloom, 0.3);
        pen.circle(mx + ox + s * sp, my, Math.max(2.4, sp * 0.3), ND.headCore);
      }
    }
  }
  // the dashboard: the lip under the glass, its top (where a passing lamp's light sweeps), its face
  const topBand = dashY + P(0.055, 0.07) * H;
  pen.rect(-90, dashY - 2, W + 180, topBand + 0.012 * H - dashY + 2, 0, ND.dashTop);
  pen.poly([-90, topBand + 0.013 * H, W * 0.5, topBand - 0.006 * H, W + 90, topBand + 0.013 * H], ND.dashFace);
  pen.rect(-90, topBand + 0.012 * H, W + 180, H + 90 - topBand, 0, ND.dashFace);
  pen.line([-90, dashY + 2, W + 90, dashY + 2], 9, ND.dashLip);
  drawLightSweep(pen, x.warm, w.m, -60, W + 60, dashY - 0.02 * H, topBand + 0.05 * H);
  // the wheel's centre and size
  const wx = W / 2;
  const wy = P(0.94, 1.1) * H;
  const wr = P(0.4, 0.42) * S;
  const rim = 0.055 * S;
  // two vents with three slats each, and three buttons with lights on the right
  const ventY = P(dashY + 0.115 * H, dashY + 0.12 * H);
  for (const vx of tl ? [0.13, 0.87] : [0.2, 0.8]) {
    const cx = vx * W;
    const vw = 0.17 * S;
    const vh = 0.055 * S;
    pen.rect(cx - vw / 2, ventY - vh / 2, vw, vh, vh * 0.4, ND.vent);
    for (let i = 0; i < 3; i += 1) {
      const y = ventY - vh * 0.25 + i * vh * 0.25;
      pen.line([cx - vw * 0.4, y, cx + vw * 0.4, y], 3, ND.ventSlat);
    }
  }
  const btnY = dashY + P(0.075, 0.08) * H;
  for (let i = 0; i < 3; i += 1) {
    const bx = W * (tl ? 0.76 : 0.71) + i * 0.065 * S;
    pen.rect(bx - 0.022 * S, btnY - 0.016 * S, 0.044 * S, 0.032 * S, 6, ND.button);
    pen.circle(bx, btnY - 0.004 * S, 3.5, i === 1 ? ND.ledCool : ND.ledWarm, 0.85);
  }
  // the dials behind the wheel, glowing a little more the faster the car goes
  const speed = clamp01(w.own?.speedAt?.(x.t) ?? 0);
  const dialY = tl ? dashY + 0.085 * H : wy - wr * 0.62;
  pen.ellipse(wx, dialY + 0.005 * S, 0.27 * S, 0.075 * S, 0, ND.dashLip);
  for (const s of [-1, 1]) {
    const dx = wx + s * 0.1 * S;
    pen.circle(dx, dialY, 0.056 * S, ND.dialFace);
    pen.line(arcPts(dx, dialY, 0.05 * S, 0.05 * S, 135, 405, 14), 3, ND.halo2, 0.25 + 0.35 * speed);
    const a = (135 + 270 * (s < 0 ? 0.15 + 0.6 * speed : 0.3 + 0.2 * speed)) * DEG;
    pen.line([dx, dialY, dx + Math.cos(a) * 0.042 * S, dialY + Math.sin(a) * 0.042 * S], 3, ND.needle);
  }
  // the wheel: rim, a lit top arc that follows the lamps, three spokes and the hub, turning with the steering
  const rot = w.steer * 35;
  const wSegs = pieceSegs(pen, wr + rim / 2, 360, 10);
  arcLine(pen, wx, wy, wr, 0, 360, rim + 5, ND.pillarInk, 1, 10, wSegs);
  arcLine(pen, wx, wy, wr, 0, 360, rim, ND.wheel, 1, 10, wSegs);
  arcLine(pen, wx, wy, wr - rim * 0.16, -140 + rot, -40 + rot, rim * 0.26, ND.wheelLit, 0.45 + 0.45 * x.warm, 3, pieceSegs(pen, wr, 100, 3));
  for (const a of [180, 0, 90]) {
    const r0 = (a + rot) * DEG;
    pen.line([wx + Math.cos(r0) * 0.1 * S, wy + Math.sin(r0) * 0.1 * S, wx + Math.cos(r0) * (wr - rim * 0.3), wy + Math.sin(r0) * (wr - rim * 0.3)], rim * 0.8, ND.wheel);
  }
  pen.circle(wx, wy, 0.13 * S, ND.pillarInk);
  pen.circle(wx, wy, 0.125 * S, ND.wheelHub);
  pen.circle(wx, wy - 0.02 * S, 0.04 * S, ND.wheelLit, 0.6);
  const grips: [number, number][] = [-60, 60].map((d) => {
    const r0 = (d + rot) * DEG;
    return [wx + Math.sin(r0) * wr, wy - Math.cos(r0) * wr] as [number, number];
  });
  if (w.driver) drawWheelHands(pen, w.driver.look, grips, rim * 1.05, [wx, wy]);
}

/** Night drive: a pair of headlights in the rear-view mirror, each a small white core of radius `r` (alpha `core`) in
 * a soft bloom that fades to clear `reach` past it (art.ts softRings, each ring of both lights one polygon, kept on the
 * mirror's `glass`): no ring edge, no grey button. */
function mirrorLights(pen: Pen, xs: number[], y: number, r: number, reach: number, core: number, glass: number[]): void {
  const ring = (rr: number) => joinShapes(xs.map((cx) => clipConvex(arcPts(cx, y, rr, rr, 0, 360, 16).slice(0, -2), glass)));
  for (const [t, a] of softRings(Math.min(6, softCount((reach * pen.unit()) / F.k)), 0.75)) pen.poly(ring(r + t * reach), ND.headBloom, a);
  pen.poly(ring(r), ND.headCore, core);
}

// ---- Face up close ------------------------------------------------------------------------------------------------

function faceShot(pen: Pen, x: ShotInput, w: World, p: ShotPerson): void {
  const W = F.w;
  const H = F.h;
  const b = faceLayout(x, p);
  pen.setMatrix(layerMatrix(camFor(x, b.hx, b.hy), 1));
  const car = p.car ? x.cars.find((c) => c.st.prop.propId === p.car) : undefined;
  const lampSide: 1 | -1 = w.dir > 0 ? -1 : 1;
  if (car) {
    lightPart(x, "out");
    const winTop = P(0.045, 0.05) * H;
    const winBot = P(0.4, 0.44) * H;
    pen.grad(0, winTop, 0, winBot, w.look.sky);
    // slow mountains through the rear window (they drift the other way to the road)
    const horizon = P(0.36, 0.4) * H;
    const ridge = ridgeTop(W * 0.06, W * 0.94, horizon, 0.17 * S, w.m * 3 * w.dir, x.seed, 18, w.look.ridge);
    pen.poly([...ridge, W * 0.94, winBot + 40, W * 0.06, winBot + 40], w.look.far);
    pen.line(ridge, 2.4, w.look.rim ?? w.look.farLit, 0.5);
    if (w.look.lit && nightDrive()) {
      // night drive: the road's lamps behind the car glowing through the rear window, the near ones at its top edge,
      // never hidden behind the head; in the wider frames the road behind runs off to the side of the head
      const hu = b.rx / p.geo.headRX;
      const hair = HAIR_UP * hu * 0.5;
      const head = { x: b.hx, y: b.hy - hair, rx: b.rx * 1.12, ry: p.geo.headRY * hu + hair };
      lampsBehind(pen, { vpX: b.hx + P(0, 0.27) * W, hor: horizon, f: FOCAL * 0.7, camX: 0, camH: 1.2 }, w.plan, w.m, W * 0.1, winTop, W * 0.9, winBot, head);
    } else if (w.look.lit) {
      // one lamp's glow crossing the rear window at each lamp passing
      const lx = W / 2 + lampPhase(w.m) * W * 4 * w.dir;
      if (lx > W * 0.05 && lx < W * 0.95) lampGlow(pen, lx, winTop + 0.07 * H, 0.012 * S, 0.02 * S, 0.006 * S);
    }
    // slivers of side window at the edges with the rail lines streaming past
    const slivers = [
      [0, P(0.4, 0.45) * H, W * 0.07, P(0.38, 0.43) * H, W * 0.07, P(0.62, 0.7) * H, 0, P(0.64, 0.72) * H],
      [W, P(0.4, 0.45) * H, W, P(0.64, 0.72) * H, W * 0.93, P(0.62, 0.7) * H, W * 0.93, P(0.38, 0.43) * H],
    ];
    lightPart(x, "cabin");
    const wr = 0.06 * S;
    const sl = slivers.map((p) => [...p]);
    frameRound(pen, -90, -90, W + 90, H + 90, W * 0.1, winTop, W * 0.9, winBot, [wr, wr, wr, wr], ND.cabinRoof);
    pen.line([W * 0.1 + wr, winTop, W * 0.9 - wr, winTop], 3, ND.pillarInk, 0.9);
    // the side windows' slivers show through the cabin at the edges
    for (const p of sl) {
      pen.poly(p, w.look.verge);
      const ry = p[1]! + (p[5]! - p[1]!) * 0.42;
      const xs = p[0] === 0 ? [-40, p[4]! + 40] : [p[0]! + 40, p[4]! - 40];
      if (nightDrive()) railSide(pen, xs[0]!, xs[1]!, ry - 1.5, 10, 0.9);
      else {
        pen.line([xs[0]!, ry, xs[1]!, ry], 6, ND.rail, 0.9);
        pen.line([xs[0]!, ry - 5, xs[1]!, ry - 5], 2, ND.railLit, 0.9);
      }
      // the rail's posts streaming past, fast
      const x0 = Math.min(p[0]!, p[4]!);
      const sw = Math.abs(p[4]! - p[0]!);
      for (let k = 0; k < 2; k += 1) {
        const px = x0 + ((((-w.m * 160 * w.dir + k * 0.5 * sw) % sw) + sw) % sw);
        pen.line([px, ry - 4, px, ry + 26], 5, ND.railPost, 0.9);
      }
    }
    // the rear seats' backs and headrests, then the driver's own seat behind the head
    for (const s of [-1, 1]) {
      const cx = W / 2 + s * W * 0.37;
      seatShape(pen, cx - 0.17 * S, P(0.4, 0.46) * H, 0.34 * S, H, 0.09 * S);
      seatShape(pen, cx - 0.085 * S, P(0.355, 0.39) * H, 0.17 * S, 0.08 * S, 0.04 * S);
    }
    const u = b.rx / p.geo.headRX;
    const ry = p.geo.headRY * u;
    seatShape(pen, b.hx - b.rx * 1.25, b.hy + ry * 0.4, b.rx * 2.5, H, b.rx * 0.6);
    seatShape(pen, b.hx - b.rx * 0.75, b.hy - ry * 1.08, b.rx * 1.5, ry * 0.9, b.rx * 0.35);
  } else backdrop(pen, x, w, b.hy);
  bust(pen, p, b.hx, b.hy + bob(x, p), b.rx, "front", bustTurn(p, x.t), lampSide, x.t);
  if (car) {
    drawLightSweep(pen, x.warm, w.m, b.hx - b.rx * 1.4, b.hx + b.rx * 1.4, b.hy - b.rx * 1.2, b.hy + b.rx * 1.3);
    if (p.seat === 0) {
      // the top of the wheel along the bottom, with the hands at its ends when they are in the frame
      const cx = b.hx;
      const cy = P(1.15, 1.3) * H;
      const r = P(0.5, 0.55) * S;
      const rot = w.steer * 35;
      const rim = 0.06 * S;
      const wSegs = pieceSegs(pen, r + rim / 2, 140, 6);
      arcLine(pen, cx, cy, r, 200 + rot, 340 + rot, rim + 5, ND.pillarInk, 1, 6, wSegs);
      arcLine(pen, cx, cy, r, 200 + rot, 340 + rot, rim, ND.wheel, 1, 6, wSegs);
      arcLine(pen, cx, cy, r - rim * 0.15, 235 + rot, 305 + rot, rim * 0.26, ND.wheelLit, 0.45 + 0.45 * x.warm, 3, pieceSegs(pen, r, 70, 3));
      const grips = [-58, 58]
        .map((d) => {
          const r0 = (d + rot) * DEG;
          return [cx + Math.sin(r0) * r, cy - Math.cos(r0) * r] as [number, number];
        })
        .filter((g) => g[1] < H + rim * 0.5);
      if (grips.length) drawWheelHands(pen, p.look, grips, rim * 1.05, [cx, cy]);
    }
  }
}

/** A seat's back or headrest: a soft rounded block with a darker edge and a stitch line. */
function seatShape(pen: Pen, x: number, y: number, w: number, h: number, r: number): void {
  pen.rect(x - 3, y - 3, w + 6, h + 6, r + 3, ND.seatInk);
  pen.rect(x, y, w, h, r, ND.seat);
  pen.line([x + r * 0.6, y + Math.min(h * 0.5, r * 1.4), x + w - r * 0.6, y + Math.min(h * 0.5, r * 1.4)], 2.5, ND.seatStitch, 0.9);
}

/** Behind a person standing outside (Face up close without a car): the sky and the far layer of their place. */
function backdrop(pen: Pen, x: ShotInput, w: World, hy: number): void {
  const W = F.w;
  const H = F.h;
  lightPart(x, "out");
  const info = setInfo(x.set);
  const g = (c: string) => (nightDrive() ? grade(c) : c);
  if (info.road) {
    const base = hy + 0.32 * S;
    pen.grad(0, 0, 0, base, w.look.sky);
    const r1 = ridgeTop(-80, W + 80, base, 0.36 * S, x.t * 6, x.seed, 18, w.look.ridge);
    pen.poly([...r1, W + 80, H + 80, -80, H + 80], w.look.far);
    const r2 = ridgeTop(-80, W + 80, base + 0.08 * S, 0.18 * S, x.t * 14 + 400, x.seed + 3, 18, "hills");
    pen.poly([...r2, W + 80, H + 80, -80, H + 80], w.look.near);
    return;
  }
  if (info.outdoor) {
    pen.grad(0, 0, 0, hy + 0.3 * S, [
      [0, g("#5cc2ff")],
      [1, g("#d8f3ff")],
    ]);
    const r = ridgeTop(-80, W + 80, hy + 0.3 * S, 0.2 * S, 0, x.seed, 16, "hills");
    pen.poly([...r, W + 80, H + 80, -80, H + 80], g("#a6dca4"));
    return;
  }
  if (x.set === "studio") {
    pen.grad(0, 0, 0, H, [
      [0, "#231e58"],
      [0.55, "#3a3288"],
      [1, "#1c1842"],
    ]);
    return;
  }
  const wall = x.set === "kitchen" ? "#fff1d6" : x.set === "living_room" ? "#ffe0c2" : "#e3ecf7";
  pen.fill(g(wall));
  pen.rect(W * 0.08, hy - 0.5 * S, 0.34 * S, 0.38 * S, 18, g("#ffffff"));
  pen.rect(W * 0.08 + 14, hy - 0.5 * S + 14, 0.34 * S - 28, 0.38 * S - 28, 12, g("#9fdcff"));
}

// ---- Side window --------------------------------------------------------------------------------------------------

function sideWindow(pen: Pen, x: ShotInput, w: World): void {
  const W = F.w;
  const H = F.h;
  const p = w.driver!;
  const b = sideLayout(x, p);
  pen.setMatrix(layerMatrix(camFor(x, b.hx, b.hy), 1));
  const wx0 = W * (square() ? 0.48 : P(0.48, 0.45));
  const wx1 = W * (square() ? 0.98 : P(0.98, 0.95));
  const wy0 = H * P(0.14, 0.12);
  const wy1 = H * P(0.62, 0.7);
  const ww = wx1 - wx0;
  const wh = wy1 - wy0;
  // the window: a rounded top corner at its back (the side the scenery streams to)
  const back = -w.dir;
  const r = 0.18 * S;
  lightPart(x, "out");
  pen.grad(0, wy0, 0, wy1, w.look.sky);
  // slow mountains, the rail streaming fast, a lamp passing at each pulse
  const mtn = ridgeTop(wx0 - 60, wx1 + 60, wy0 + wh * 0.62, wh * 0.45, -w.m * 6 * w.dir, x.seed, 14, w.look.ridge);
  pen.poly([...mtn, wx1 + 60, wy1 + 40, wx0 - 60, wy1 + 40], w.look.far);
  // night drive: small lamps along the far side of the road always in the window, their poles down behind the rail,
  // and the near one passing
  const railY = wy0 + wh * 0.8;
  const nd = nightDrive();
  if (w.look.lit && nd) sideLamps(pen, wx0, wx1, wy0, wh, w.m, w.dir, back, LAMP_SPAN, railY);
  else if (w.look.lit) {
    const lx = (wx0 + wx1) / 2 - lampPhase(w.m) * LAMP_SPAN * w.dir;
    if (lx > wx0 - 120 && lx < wx1 + 120) {
      pen.line([lx, wy1 + 20, lx, wy0 + wh * 0.12], 0.02 * S, w.look.pole);
      lampGlow(pen, lx + 0.05 * S * back, wy0 + wh * 0.1, 0.022 * S, 0.035 * S, 0.01 * S);
    }
  }
  pen.rect(wx0 - 60, railY, ww + 120, wy1 - railY + 40, 0, w.look.verge);
  for (let i = 0; i < 8; i += 1) {
    const px = wx0 - 60 + ((((-w.m * 140 * w.dir + i * 0.09 * S) % (0.72 * S)) + 0.72 * S) % (0.72 * S)) * (ww + 120) / (0.72 * S);
    // night drive: the post's round top inside the rail's upper bar
    pen.line([px, railY - (nd ? 0.0085 * S : wh * 0.02), px, railY + wh * 0.1], 5, ND.railPost);
  }
  // night drive: two slim bars with the dark verge between them and a thin cool highlight (art.ts railSide)
  if (nd) railSide(pen, wx0 - 60, wx1 + 60, railY - 0.001 * S, 0.024 * S);
  else {
    pen.line([wx0 - 60, railY, wx1 + 60, railY], 0.022 * S, ND.rail);
    pen.line([wx0 - 60, railY - 0.008 * S, wx1 + 60, railY - 0.008 * S], 3, ND.railLit);
  }
  // a car in the other lane within 8 m, in its side view, scaled into the window
  const along = w.others.filter((o) => o.X !== 0 && Math.abs(o.ahead) <= 8).sort((a, c) => Math.abs(a.ahead) - Math.abs(c.ahead))[0];
  if (along) {
    const st = along.car.st;
    const k = ww / 520;
    pen.save();
    pen.translate((wx0 + wx1) / 2 + along.ahead * (ww / 16) * w.dir, wy1 + wh * 0.16);
    pen.scale(k);
    pen.translate(-st.x * F.w, -st.y * F.h);
    drawProp(pen, st, "side", x.t, x.seed, along.car.occ, w.look.night, along.car.draw);
    pen.restore();
  }
  lightPart(x, "cabin");
  // the car's inside around the window, the door panel under the sill with its armrest and handle
  frameRound(pen, -90, -90, W + 90, H + 90, wx0, wy0, wx1, wy1, back < 0 ? [r, 0, 0, 0] : [0, r, 0, 0], ND.cabinRoof);
  pen.line(back < 0 ? [wx0 + r, wy0, wx1, wy0] : [wx0, wy0, wx1 - r, wy0], 3, ND.pillarInk, 0.9);
  pen.line([wx0 + 6, wy1 + 4, wx1 - 6, wy1 + 4], 4, ND.pillarLit, 0.5 + 0.3 * x.warm);
  pen.rect(wx0 - 0.08 * S, wy1 + 0.02 * S, ww + 0.2 * S, H, 0.03 * S, ND.pillar);
  pen.line([wx0 - 0.04 * S, wy1 + 0.13 * S, wx1 + 0.1 * S, wy1 + 0.11 * S], 0.03 * S, ND.seatInk);
  pen.line([wx0 - 0.04 * S, wy1 + 0.12 * S, wx1 + 0.1 * S, wy1 + 0.1 * S], 3, ND.pillarLit, 0.5);
  pen.rect(wx0 + ww * 0.62, wy1 + 0.05 * S, 0.11 * S, 0.035 * S, 0.017 * S, ND.seatInk);
  pen.rect(wx0 + ww * 0.62 + 6, wy1 + 0.05 * S + 5, 0.11 * S - 12, 0.012 * S, 4, ND.pillarLit, 0.7);
  // the driver at three quarters in front of it, lit by the lamps from the window's side
  seatShape(pen, b.hx - b.rx * 1.35, b.hy + b.rx * 0.2, b.rx * 2.2, H, b.rx * 0.6);
  bust(pen, p, b.hx, b.hy + bob(x, p), b.rx, "three_quarter", -0.45 + bustTurn(p, x.t), 1, x.t);
  drawLightSweep(pen, x.warm, w.m, b.hx - b.rx * 1.4, b.hx + b.rx * 1.4, b.hy - b.rx * 1.2, b.hy + b.rx * 1.3);
}

/** How far a lamp travels across the side window over a lamp gap (px): it crosses the window in about 0.35 s. */
const LAMP_SPAN = 2880;

// ---- Mirror -------------------------------------------------------------------------------------------------------

function mirrorShot(pen: Pen, x: ShotInput, w: World): void {
  const W = F.w;
  const H = F.h;
  const cx = W / 2;
  // in 9:16 the mirror sits high on the windscreen, so the road with its lane lines shows under it
  const cy = P(0.3, 0.45) * H;
  const mw = P(1.12 * W, 0.7 * W);
  const mh = 0.42 * S;
  const behind = w.others.filter((o) => o.ahead < 0).sort((a, b) => a.gap - b.gap)[0];
  pen.setMatrix(layerMatrix(camFor(x, cx, cy), 1));
  // around it, the road ahead through the windscreen, simplified
  lightPart(x, "out");
  // the road's horizon just under the mirror in 9:16, so the far road, its lamps and the lane lines fill the windscreen
  // (night drive: a little lower, so the two rows of lamps show under the mirror and meet in their warm V)
  const hor = P(nightDrive() ? 0.5 : 0.45, 0.42) * H;
  const c: Cam3 = { vpX: W / 2 + w.steer * 0.03 * W, hor, f: FOCAL, camX: -0.35, camH: 1.2 };
  drawOutside(pen, c, { look: w.look, plan: w.plan, m: w.m, t: x.t, seed: x.seed, sway: -(c.vpX - W / 2), x0: -80, x1: W + 80, top: 0, bottom: H + 80, zNear: 0.6, simple: true, warm: x.warm });
  lightPart(x, "cabin");
  pen.rect(-90, -90, W + 180, 0.05 * H + 90, 0, ND.cabinRoof);
  pen.line([cx, 0.05 * H - 6, cx, cy - mh / 2], 0.03 * S, ND.mirrorHousing);
  // the dashboard along the bottom
  const dashY = P(0.8, 0.84) * H;
  pen.poly([-90, dashY, W + 90, dashY, W + 90, dashY + 0.05 * H, W / 2, dashY + 0.04 * H, -90, dashY + 0.05 * H], ND.dashTop);
  pen.poly([-90, dashY + 0.05 * H, W / 2, dashY + 0.04 * H, W + 90, dashY + 0.05 * H, W + 90, H + 90, -90, H + 90], ND.dashFace);
  pen.line([-90, dashY + 2, W + 90, dashY + 2], 8, ND.dashLip);
  drawLightSweep(pen, x.warm, w.m, -60, W + 60, dashY - 0.02 * H, dashY + 0.1 * H);
  pen.ellipse(cx, cy + mh * 0.56, mw * 0.5, mh * 0.1, 0, ND.ao, 0.25);
  // the mirror's glass: the road behind receding to its middle, seen through the own car's rear window
  const gx0 = cx - mw / 2;
  const gy0 = cy - mh / 2;
  // night drive: the glass's corners in fine steps, its sky the same shape as everything clipped to it, so no sliver
  // of sky shows between the glass and the housing
  const glass = nightDrive() ? fineRoundRect(gx0, gy0, mw, mh, mh * 0.3) : roundRectPts(gx0, gy0, mw, mh, mh * 0.3);
  lightPart(x, "out");
  const ghor = cy - mh * 0.08;
  const gc: Cam3 = { vpX: cx, hor: ghor, f: FOCAL * 0.42, camX: -0.35, camH: 1.2 };
  const clip = (pts: number[]) => clipConvex(pts, glass);
  // the housing (an ink edge, its body, the rim round the glass), then the glass
  const hx0 = gx0 - 0.035 * S;
  const hy0 = gy0 - 0.035 * S;
  pen.rect(hx0 - 3, hy0 - 3, mw + 0.07 * S + 6, mh + 0.07 * S + 6, mh * 0.38 + 3, ND.pillarInk);
  pen.rect(hx0, hy0, mw + 0.07 * S, mh + 0.07 * S, mh * 0.38, ND.pillar);
  pen.rect(gx0 - 0.01 * S, gy0 - 0.01 * S, mw + 0.02 * S, mh + 0.02 * S, mh * 0.32, ND.mirrorHousing);
  const glassSky = w.look.sky[Math.floor((w.look.sky.length - 1) / 2)]![1];
  if (nightDrive()) {
    // night drive: the glass's sky fades from its own colour under the rear window's top down to the horizon's haze,
    // as the sky outside does, never a flat light band over the ridge
    pen.poly(glass, glassSky);
    glassSkyFade(pen, w.look.sky, Math.floor((w.look.sky.length - 1) / 2), cx - mw * 0.42, cx + mw * 0.42, gy0 + mh * 0.1 - 2, ghor + 2);
  } else {
    pen.rect(gx0, gy0, mw, mh, mh * 0.3, glassSky);
    pen.poly(clip([gx0, ghor - mh * 0.12, gx0 + mw, ghor - mh * 0.12, gx0 + mw, ghor + 2, gx0, ghor + 2]), w.look.sky[w.look.sky.length - 1]![1]);
  }
  const ridge = ridgeTop(gx0, gx0 + mw, ghor + 2, mh * 0.12, w.m * 2, x.seed + 9, 14, w.look.ridge);
  pen.poly(clip([...ridge, gx0 + mw, ghor + 4, gx0, ghor + 4]), w.look.far);
  pen.poly(clip([gx0, ghor + 2, gx0 + mw, ghor + 2, gx0 + mw, gy0 + mh, gx0, gy0 + mh]), w.look.verge);
  pen.poly(clip(groundQuad(gc, w.plan.left, w.plan.right, 1.5, 400)), w.look.asphalt);
  if (w.look.edge) for (const ex of [w.plan.left + 0.25, w.plan.right - 0.25]) pen.poly(clip(groundQuad(gc, ex - 0.1, ex + 0.1, 1.5, 400)), w.look.edge, 0.9);
  for (let k = 0; k < 6; k += 1) {
    const z = ((w.m % 12) + 12) % 12 + k * 12;
    if (z < 2) continue;
    pen.poly(clip(groundQuad(gc, w.plan.dash - 0.1, w.plan.dash + 0.1, z, z + 3)), w.look.lane);
  }
  if (w.look.lit) {
    // night drive: the lamps in the glass stand on their poles, down to the verge (one shape, under their lights)
    if (nightDrive()) {
      const seen: { x: number; arm: number; z: number }[] = [];
      for (const L of w.plan.lamps) {
        for (let k = 0; k < 4; k += 1) {
          const z = ((w.m % 40) + 40) % 40 + k * 40 + 4;
          const [lx, ly] = project(gc, L.x + L.arm * 2, 10, z);
          if (lx > gx0 + 10 && lx < gx0 + mw - 10 && ly > gy0 + 10) seen.push({ x: L.x, arm: L.arm, z });
        }
      }
      glassPoles(pen, gc, seen, glass);
    }
    for (const L of w.plan.lamps) {
      for (let k = 0; k < 4; k += 1) {
        const z = ((w.m % 40) + 40) % 40 + k * 40 + 4;
        const [lx, ly] = project(gc, L.x + L.arm * 2, 10, z);
        if (!(lx > gx0 + 10 && lx < gx0 + mw - 10 && ly > gy0 + 10)) continue;
        // night drive: a small warm glow round a bright lens, never a flat see-through dot
        if (nightDrive()) glassLamp(pen, lx, ly, Math.max(2, 7 - k * 1.5));
        else pen.circle(lx, ly, Math.max(2, 7 - k * 1.5), ND.halo1, 0.7);
      }
    }
  }
  if (behind) {
    const Z = Math.max(3, behind.gap - 1);
    const [bx, by] = project(gc, behind.X, 0, Z);
    const bw = Math.min(mh * 0.7, pxPerM(gc, Z) * (behind.car.truck ? 2.5 : 1.85));
    // strong headlight bloom, which a blink flares more (carView.ts)
    viewCar(pen, behind.car, "front", bx, by, bw, (cx - bx) / (mw * 0.5), x.t, behind.roll, behind.jolt, 1.8);
    if (behind.car.st.honkAge >= 0) {
      for (let i = 0; i < 3; i += 1) {
        const p = (behind.car.st.honkAge * 2.2 + i / 3) % 1;
        pen.line(arcPts(bx, by - bw * 0.5, bw * (0.5 + p * 0.5), bw * (0.3 + p * 0.3), 215, 325, 8), 4, "#fff6e5", 0.7 * (1 - p));
      }
    }
  }
  lightPart(x, "cabin");
  // the own car's rear window frame, the two rear headrests, a glint across the glass
  const rwTop = gy0 + mh * 0.1;
  const rwBot = gy0 + mh * 0.74;
  const rw = [cx - mw * 0.34, rwTop, cx + mw * 0.34, rwTop, cx + mw * 0.41, rwBot, cx - mw * 0.41, rwBot];
  const frame = [
    [gx0, gy0, gx0 + mw, gy0, gx0 + mw, rwTop, gx0, rwTop],
    [gx0, rwBot, gx0 + mw, rwBot, gx0 + mw, gy0 + mh, gx0, gy0 + mh],
    [gx0, rwTop, rw[0]!, rwTop, rw[6]!, rwBot, gx0, rwBot],
    [rw[2]!, rwTop, gx0 + mw, rwTop, gx0 + mw, rwBot, rw[4]!, rwBot],
  ];
  for (const f of frame) pen.poly(clip(f), ND.cabinRoof);
  for (let i = 0; i < 4; i += 1) pen.line([rw[i * 2]!, rw[i * 2 + 1]!, rw[((i + 1) % 4) * 2]!, rw[((i + 1) % 4) * 2 + 1]!], 3, ND.pillarInk, 0.9);
  for (const s of [-1, 1]) seatShape(pen, cx + s * mw * 0.2 - mh * 0.24, gy0 + mh * 0.68, mh * 0.48, mh * 0.27, mh * 0.12);
  // the glint: night drive keeps it on the rear window's glass, off the car's dark frame round it
  const glint = clip([cx - mw * 0.3, gy0, cx - mw * 0.18, gy0, cx - mw * 0.36, gy0 + mh, cx - mw * 0.48, gy0 + mh]);
  pen.poly(nightDrive() ? clipConvex(glint, rw) : glint, "#ffffff", 0.06);
  // the housing's lit top edge, along its top (a flat arc, not a circle through the sky)
  const hTop = gy0 - 0.035 * S;
  pen.line(arcPts(cx, hTop + mh * 0.38, mw * 0.5, mh * 0.38, 200, 340, 16), 4, ND.pillarLit, 0.6 + 0.3 * x.warm);
}

/** How many steps of colour the mirror's sky fades in (night drive): about 2 levels of 255 each. */
const GLASS_SKY_STEPS = 20;

/** Night drive's sky in the mirror's glass, x0..x1 from y0 down to y1 (the horizon): the sky's own stops from stop
 * `from` (the glass's colour) to the last (the horizon's haze), in GLASS_SKY_STEPS stacked rects, each band the same
 * small step of colour (so the bands are thin where the sky brightens fast, near the horizon) and each reaching a
 * pixel into the next, so no seam shows. Inside the rear window's frame, which hides its ends. */
function glassSkyFade(pen: Pen, sky: [number, string][], from: number, x0: number, x1: number, y0: number, y1: number): void {
  const o0 = sky[from]![0];
  const at = (t: number): [number, number, number] => {
    const o = o0 + (1 - o0) * t;
    let i = from;
    while (i + 1 < sky.length - 1 && sky[i + 1]![0] < o) i += 1;
    const [oa, ca] = sky[i]!;
    const [ob, cb] = sky[Math.min(sky.length - 1, i + 1)]!;
    return channels(mix(ca, cb, ob > oa ? (o - oa) / (ob - oa) : 1));
  };
  // the colour's change down the glass, finely sampled, so each band can take the same share of it
  const K = 48;
  const cum = [0];
  let prev = at(0);
  for (let i = 1; i <= K; i += 1) {
    const c = at(i / K);
    cum.push(cum[i - 1]! + Math.max(...c.map((v, j) => Math.abs(v - prev[j]!))));
    prev = c;
  }
  const total = cum[K]!;
  if (total <= 0) return;
  // where (0..1 down the glass) the colour has changed by a part f of the whole
  const where = (f: number): number => {
    const goal = f * total;
    let i = 1;
    while (i < K && cum[i]! < goal) i += 1;
    const a = cum[i - 1]!;
    const b = cum[i]!;
    return (i - 1 + (b > a ? (goal - a) / (b - a) : 0)) / K;
  };
  const h = y1 - y0;
  for (let j = 1; j <= GLASS_SKY_STEPS; j += 1) {
    const ya = y0 + h * where((j - 0.5) / GLASS_SKY_STEPS);
    const yb = j === GLASS_SKY_STEPS ? y1 : y0 + h * where((j + 0.5) / GLASS_SKY_STEPS) + 1;
    const [r, g, b] = at(where(j / GLASS_SKY_STEPS));
    pen.rect(x0, ya, x1 - x0, yb - ya, 0, toHex(r, g, b));
  }
}

/** A rounded rectangle's outline with each corner in 12 steps of 7.5° (pen.ts roundRectPts takes 30° steps, which
 * show as corners on a big mirror). */
function fineRoundRect(x: number, y: number, w: number, h: number, r: number): number[] {
  const pts: number[] = [];
  const corners: [number, number, number][] = [
    [x + w - r, y + r, -90],
    [x + w - r, y + h - r, 0],
    [x + r, y + h - r, 90],
    [x + r, y + r, 180],
  ];
  for (const [cx, cy, a0] of corners) pts.push(...arcPts(cx, cy, r, r, a0, a0 + 90, 12));
  return pts;
}

// ---- Speed dial ---------------------------------------------------------------------------------------------------

/** A 5 × 7 stroke font for the dial's numbers: each digit a few polylines on a 0..4 × 0..6 grid. */
const DIGITS: Record<string, number[][]> = {
  "0": [[1, 0, 3, 0, 4, 1, 4, 5, 3, 6, 1, 6, 0, 5, 0, 1, 1, 0]],
  "1": [[1, 1, 2, 0, 2, 6], [1, 6, 3, 6]],
  "2": [[0, 1, 1, 0, 3, 0, 4, 1, 4, 2, 0, 6, 4, 6]],
  "3": [[0, 0, 4, 0, 2, 2.5, 3, 2.5, 4, 3.5, 4, 5, 3, 6, 1, 6, 0, 5]],
  "4": [[3, 6, 3, 0, 0, 4, 4, 4]],
  "5": [[4, 0, 0, 0, 0, 2.5, 3, 2.5, 4, 3.5, 4, 5, 3, 6, 0, 6]],
  "6": [[3, 0, 1, 0, 0, 1, 0, 5, 1, 6, 3, 6, 4, 5, 4, 3.5, 3, 2.7, 0, 2.7]],
  "7": [[0, 0, 4, 0, 1.5, 6]],
  "8": [[1, 0, 3, 0, 4, 1, 4, 2, 3, 3, 1, 3, 0, 4, 0, 5, 1, 6, 3, 6, 4, 5, 4, 4, 3, 3, 1, 3, 0, 2, 0, 1, 1, 0]],
};

function digit(pen: Pen, d: string, x: number, y: number, h: number, color: string): void {
  const k = h / 6;
  for (const st of DIGITS[d] ?? []) {
    const pts: number[] = [];
    for (let i = 0; i < st.length; i += 2) pts.push(x + (st[i]! - 2) * k, y + (st[i + 1]! - 3) * k);
    pen.line(pts, Math.max(2, h * 0.14), color);
  }
}

/** The rev counter's needle (0..8): how fast the car goes, more while it speeds up, less while it brakes, eased over
 * 0.15 s; a stall shudders it for 0.4 s, then it falls to 0. */
function revs(x: ShotInput, w: World): number {
  const own = w.own!;
  const id = own.st.prop.propId;
  const driverId = w.driver?.castId ?? "";
  const at = (time: number) => {
    const speed = own.speedAt?.(time) ?? 0;
    let rise = 0;
    let brake = 0;
    let stall = -1;
    for (const b of x.beats) {
      const tau = time - b.at;
      if (tau < 0) continue;
      if (b.who === id && b.do === "speed_up") rise = Math.max(rise, tau < b.dur ? Math.sin((Math.PI / 2) * clamp01(tau / Math.max(0.3, b.dur))) : Math.max(0, 1 - (tau - b.dur) / 0.4));
      if (b.who === driverId && b.do === "brake" && tau < b.dur) brake = Math.max(brake, Math.sin(Math.PI * clamp01(tau / Math.max(0.2, b.dur))));
      if (b.who === id && (b.do === "stop" && tau < b.dur)) brake = Math.max(brake, 0.6);
      if (b.who === id && b.do === "stall") stall = tau;
    }
    const v = 0.9 + 2.6 * speed + 2.2 * rise - 1.0 * brake;
    if (stall >= 0) return stall < 0.4 ? v : v * Math.max(0, 1 - (stall - 0.4) / 0.35);
    return v;
  };
  let sum = 0;
  for (let i = 0; i < 4; i += 1) sum += at(x.t - (0.15 * i) / 3);
  let v = clamp(sum / 4, 0, 8);
  const stall = x.beats.filter((b) => b.who === id && b.do === "stall" && x.t >= b.at).pop();
  if (stall && x.t - stall.at < 0.4) v += (3 / 33.75) * Math.sin((x.t - stall.at) * 70);
  return v;
}

/** Night drive: the camera `c` eased so the box (x0, y0)-(x1, y1) stays in the frame, `m` px in from its edges: zoomed
 * out as far as it needs (never in), then moved along as little as it needs. */
function keepInFrame(c: Cam, x0: number, y0: number, x1: number, y1: number, m: number): Cam {
  const zoom = Math.min(c.zoom, (F.w - 2 * m) / (x1 - x0), (F.h - 2 * m) / (y1 - y0));
  const fit = (v: number, lo: number, hi: number, half: number) => (hi - lo >= 2 * half ? (lo + hi) / 2 : clamp(v, hi - half, lo + half));
  return { ...c, zoom, cx: fit(c.cx, x0, x1, (F.w / 2 - m) / zoom), cy: fit(c.cy, y0, y1, (F.h / 2 - m) / zoom) };
}

/** Night drive's rev needle light, from its tail (bx, by) to its tip: one long soft glow along the needle and a small
 * soft one at the tip (the `glow` prim, a true gradient, so no band, ring or disc shows), under the needle itself. */
function needleGlow(pen: Pen, bx: number, by: number, tx: number, ty: number): void {
  const len = Math.hypot(tx - bx, ty - by);
  pen.save();
  pen.translate((bx + tx) / 2, (by + ty) / 2);
  pen.rotate(Math.atan2(ty - by, tx - bx) / DEG);
  pen.glow(0, 0, len / 2 + 0.035 * S, 0.034 * S, ND.needleGlow1, fadeStops(0.7, 1.5));
  pen.restore();
  pen.glow(tx, ty, 0.03 * S, 0.03 * S, ND.needleGlow2, fadeStops(0.55, 2));
}

function speedDial(pen: Pen, x: ShotInput, w: World): void {
  const W = F.w;
  const H = F.h;
  const tl = tall();
  const nd = nightDrive();
  // night drive: a dial small enough that its whole ring, 0 to 8 and the red zone, is always in the frame
  const cx = W * P(nd ? 0.5 : 0.56, 0.5);
  const cy = H * P(nd ? 0.52 : 0.56, 0.58);
  const r = S * (nd ? P(0.41, 0.4) : P(0.58, 0.46));
  const v = revs(x, w);
  const ang = (n: number) => (225 - (270 * n) / 8) * DEG;
  const pt = (n: number, rr: number): [number, number] => [cx + Math.cos(ang(n)) * rr, cy - Math.sin(ang(n)) * rr];
  const tip = pt(v, r * 0.86);
  const cam = camFor(x, tip[0], tip[1]);
  const R = r * 1.058 + 0.02 * S;
  pen.setMatrix(layerMatrix(nd ? keepInFrame(cam, cx - R, cy - R, cx + R, cy + r * 0.8, 0.03 * S) : cam, 1));
  lightPart(x, "cabin");
  pen.fill(ND.dashFace);
  pen.ellipse(W * 0.5, -0.2 * S, W, 0.36 * S, 0, ND.dashTop);
  // the edge of a second dial on the right (9:16; below the rev counter in night drive) or both sides (wider frames)
  for (const s of tl ? [1] : [-1, 1]) {
    const ox = tl ? (nd ? W * 0.9 : W + 0.22 * S) : cx + s * r * 2.15;
    const oy = tl ? cy + r * (nd ? 1.78 : 1.02) : cy + 0.05 * S;
    const r2 = r * (tl ? (nd ? 0.7 : 0.62) : 0.74);
    pen.circle(ox, oy, r2 * 1.05, ND.bezel);
    pen.circle(ox, oy, r2, ND.dialFace);
    if (nd) sideGauge(pen, x, w, ox, oy, r2, s < 0 ? "fuel" : "speed");
    else pen.line(arcPts(ox, oy, r2 * 0.86, r2 * 0.86, 140, 270, roundSegs(pen, r2 * 0.86, 130, 12)), 4, ND.tick, 0.6);
    pen.line(arcPts(ox, oy, r2 * 1.03, r2 * 1.03, 200, 290, roundSegs(pen, r2 * 1.03, 90, 10)), 3, ND.bezelLit, 0.5);
  }
  // the dial: bezel with its lit arc, the face, ticks, the red zone and the numbers (night drive: the bezel's ring
  // as two true circles, so its edges stay round however close the camera comes)
  if (nd) {
    pen.circle(cx, cy, r * 1.035 + 0.02 * S, ND.bezel);
    pen.circle(cx, cy, r * 1.035 - 0.02 * S, ND.dialFace);
  } else {
    pen.circle(cx, cy, r * 1.02, ND.dialFace);
    arcLine(pen, cx, cy, r * 1.035, 0, 360, 0.04 * S, ND.bezel, 1, 12);
  }
  arcLine(pen, cx, cy, r * 1.04, 200, 300, 0.014 * S, ND.bezelLit, 0.6, 4, pieceSegs(pen, r * 1.04, 100, 4));
  const red: number[] = [];
  const redSegs = roundSegs(pen, r * 0.9, 50.625, 10);
  for (let i = 0; i <= redSegs; i += 1) red.push(...pt(6.5 + (1.5 * i) / redSegs, r * 0.9));
  pen.line(red, 0.035 * S, ND.redZone);
  for (let n = 0; n <= 8; n += 1) {
    const [x0, y0] = pt(n, r * 0.95);
    const [x1, y1] = pt(n, r * 0.95 - 0.06 * S);
    pen.line([x0, y0, x1, y1], 0.012 * S, ND.tick);
    if (n < 8) {
      for (let k = 1; k <= 4; k += 1) {
        const m = n + k / 5;
        const [a0, b0] = pt(m, r * 0.95);
        const [a1, b1] = pt(m, r * 0.95 - 0.035 * S);
        pen.line([a0, b0, a1, b1], 0.006 * S, ND.tick, 0.9);
      }
    }
    // the numbers sit inside the ticks, clear of them
    const [nx, ny] = pt(n, r * 0.7);
    digit(pen, String(n), nx, ny, 0.065 * S, n >= 7 ? ND.redZone : ND.tick);
  }
  // the needle with its glow, a small warm glow at its tip, and the hub; its tail points straight back through the
  // hub's centre (180°: 16/3 of the 8 steps of 270°)
  const [bx, by] = pt(v + 16 / 3, r * 0.14);
  if (nd) needleGlow(pen, bx, by, tip[0], tip[1]);
  else {
    pen.circle(tip[0], tip[1], 0.04 * S, ND.needleGlow2, 0.18);
    pen.circle(tip[0], tip[1], 0.022 * S, ND.needleGlow1, 0.45);
    pen.line([bx, by, tip[0], tip[1]], 0.05 * S, ND.needleGlow2, 0.12);
    pen.line([bx, by, tip[0], tip[1]], 0.03 * S, ND.needleGlow1, 0.35);
  }
  pen.line([bx, by, tip[0], tip[1]], 0.016 * S, ND.needle);
  pen.circle(cx, cy, 0.075 * S, ND.hub);
  pen.line(arcPts(cx, cy, 0.075 * S, 0.075 * S, 0, 360, roundSegs(pen, 0.075 * S, 360, 24)), 4, ND.bezel);
  pen.circle(cx - 0.02 * S, cy - 0.02 * S, 0.02 * S, ND.bezelLit, 0.35);
  arcLine(pen, cx, cy, r * 1.058, 0, 360, 3, ND.pillarInk, 0.8, 12, pieceSegs(pen, r * 1.058, 360, 12));
}

/** Night drive's second dials beside the rev counter, centred on (ox, oy) with face radius r2: the speedometer (its
 * needle, 0 to 8 steps of 30 km/h over the rev counter's 270°, follows the own car's speed, so it shows about 100
 * km/h at the top left, the part every frame shape keeps in view) or, left of the rev counter in the wider frames, the
 * fuel gauge (E to F over 70° on its right, the side in view, the E tick red, about three quarters full). The ticks
 * of a kind are one shape; the needle has a hub with a lit spot. */
function sideGauge(pen: Pen, x: ShotInput, w: World, ox: number, oy: number, r2: number, kind: "speed" | "fuel"): void {
  const speed = kind === "speed";
  const a0 = speed ? 225 : -35;
  const sweep = speed ? -270 : 70;
  const steps = speed ? 8 : 4;
  // a tick: a short bar with round ends, like the rev counter's round-capped ticks
  const tick = (n: number, len: number, hw: number): number[] => {
    const a = (a0 + (sweep * n) / steps) * DEG;
    const pts: number[] = [];
    for (const [rr, from] of [[r2 * 0.9 - hw, -90], [r2 * 0.9 - len + hw, 90]] as const) {
      for (let i = 0; i <= 4; i += 1) {
        const b = a + (from + (180 * i) / 4) * DEG;
        pts.push(ox + Math.cos(a) * rr + Math.cos(b) * hw, oy - Math.sin(a) * rr - Math.sin(b) * hw);
      }
    }
    return pts;
  };
  const majors: number[][] = [];
  const minors: number[][] = [];
  for (let n = speed ? 0 : 1; n <= steps; n += 1) majors.push(tick(n, r2 * 0.13, r2 * 0.017));
  if (speed) for (let n = 0; n < steps; n += 1) minors.push(tick(n + 0.5, r2 * 0.07, r2 * 0.009));
  else pen.poly(tick(0, r2 * 0.13, r2 * 0.017), ND.redZone);
  pen.poly(joinShapes(majors), ND.tick);
  if (minors.length) pen.poly(joinShapes(minors), ND.tick, 0.85);
  // the needle: speed eased over 0.15 s like the rev counter, the fuel still
  let v = 0.72 * steps;
  if (speed) {
    let sum = 0;
    for (let i = 0; i < 4; i += 1) sum += w.own?.speedAt?.(x.t - (0.15 * i) / 3) ?? 0;
    v = clamp((3.4 * sum) / 4, 0, steps);
  }
  const a = (a0 + (sweep * v) / steps) * DEG;
  const [ux, uy] = [Math.cos(a), -Math.sin(a)];
  pen.line([ox - ux * r2 * 0.16, oy - uy * r2 * 0.16, ox + ux * r2 * 0.78, oy + uy * r2 * 0.78], r2 * 0.032, ND.needle);
  pen.circle(ox, oy, r2 * 0.11, ND.hub);
  pen.circle(ox - r2 * 0.03, oy - r2 * 0.03, r2 * 0.03, ND.bezelLit, 0.35);
}

// ---- Feet on the pedals -------------------------------------------------------------------------------------------

function pedals(pen: Pen, x: ShotInput, w: World): void {
  const W = F.w;
  const H = F.h;
  const p = w.driver!;
  const id = w.own!.st.prop.propId;
  // the foot: on the accelerator, pressing it on a speed_up, over to the brake in 0.25 s on a brake beat
  let toBrake = 0;
  let press = 0.2;
  for (const b of x.beats) {
    const tau = x.t - b.at;
    if (tau < 0 || tau > b.dur + 0.25) continue;
    if (b.who === p.castId && b.do === "brake") {
      toBrake = Math.max(toBrake, Math.min(ease.inOutSine(tau / 0.25), 1 - ease.inOutSine((tau - b.dur) / 0.25)));
    }
    if (b.who === id && b.do === "speed_up" && tau < b.dur) press = Math.max(press, 0.2 + 0.8 * Math.sin((Math.PI / 2) * clamp01(tau / 0.3)));
  }
  const brakeAt: [number, number] = [W * P(0.36, 0.42), H * 0.52];
  const accAt: [number, number] = [W * P(0.68, 0.62), H * 0.58];
  const brakeDown = 0.04 * S * clamp01(toBrake > 0.6 ? (toBrake - 0.6) / 0.4 : 0);
  const accDown = 0.04 * S * (toBrake > 0.3 ? 0 : (press - 0.2) / 0.8);
  const fx = lerp(accAt[0], brakeAt[0], toBrake);
  const fy = lerp(accAt[1] - 0.06 * S, brakeAt[1] - 0.02 * S, toBrake) + (toBrake > 0.6 ? brakeDown : accDown);
  pen.setMatrix(layerMatrix(camFor(x, fx, fy), 1));
  lightPart(x, "cabin");
  pen.fill(ND.floor);
  // the dash's underside along the top, with its lip
  pen.poly([-90, -90, W + 90, -90, W + 90, H * 0.16, W * 0.5, H * 0.2, -90, H * 0.23], ND.dashFace);
  pen.line([-90, H * 0.23, W * 0.5, H * 0.2, W + 90, H * 0.16], 6, ND.dashLip);
  pen.poly([-90, H * 0.78, W + 90, H * 0.7, W + 90, H + 90, -90, H + 90], mix(ND.floor, ND.celDark, 0.25));
  drawLightSweep(pen, x.warm * 0.6, w.m, -60, W + 60, H * 0.2, H * 0.6);
  // the brake: a rounded pad with five slots; the accelerator: tall, with grooves; each on its arm
  pedal(pen, brakeAt[0], brakeAt[1] + brakeDown, 0.3 * S, 0.2 * S, -20, 5, "slots");
  pedal(pen, accAt[0], accAt[1] + accDown, 0.16 * S, 0.46 * S, -15, 7, "grooves");
  drawFoot(pen, p.look, fx, fy, 25 - 10 * toBrake, toBrake > 0.6 ? 1 : press);
}

function pedal(pen: Pen, x: number, y: number, w: number, h: number, rot: number, n: number, kind: "slots" | "grooves"): void {
  pen.line([x, y - h * 0.3, x + w * 0.2, H0()], 0.035 * S, ND.pillarInk);
  pen.line([x, y - h * 0.3, x + w * 0.2, H0()], 0.025 * S, ND.button);
  pen.save();
  pen.translate(x, y);
  pen.rotate(rot);
  pen.ellipse(w * 0.04, h * 0.5 + 0.02 * S, w * 0.55, 0.03 * S, 0, ND.ao, 0.35);
  pen.rect(-w / 2 - 4, -h / 2 - 4, w + 8, h + 8, Math.min(w, h) * 0.2 + 4, ND.pillarInk);
  pen.rect(-w / 2, -h / 2, w, h, Math.min(w, h) * 0.2, ND.pedal);
  pen.line([-w / 2 + 8, -h / 2 + 6, w / 2 - 8, -h / 2 + 6], 3, lift(ND.pedal, 0.25), 0.7);
  for (let i = 0; i < n; i += 1) {
    if (kind === "slots") {
      const sx = -w * 0.34 + (w * 0.68 * i) / (n - 1);
      pen.rect(sx - w * 0.035, -h * 0.3, w * 0.07, h * 0.6, w * 0.03, ND.pedalGroove);
    } else {
      const sy = -h * 0.38 + (h * 0.76 * i) / (n - 1);
      pen.rect(-w * 0.3, sy - h * 0.012, w * 0.6, h * 0.024, h * 0.01, ND.pedalGroove);
    }
  }
  pen.restore();
}

/** Where the pedals' arms meet the dash's underside. */
const H0 = (): number => F.h * 0.19;

// ---- Behind the car ----------------------------------------------------------------------------------------------

function roadBehind(pen: Pen, x: ShotInput, w: World): void {
  const W = F.w;
  const H = F.h;
  const vpX = W * 0.5;
  const hor = H * P(0.38, 0.42);
  const c: Cam3 = { vpX, hor, f: FOCAL, camX: 0, camH: 1.6 };
  const groundY = H * P(0.86, 0.9);
  const carW = S * P(0.62, 0.46);
  const sway = w.steer * 0.05 * W;
  pen.setMatrix(layerMatrix(camFor(x, vpX, hor), 1));
  lightPart(x, "out");
  drawOutside(pen, c, { look: w.look, plan: w.plan, m: w.m, t: x.t, seed: x.seed, sway: 0, x0: -80, x1: W + 80, top: 0, bottom: H + 80, zNear: 1.2, warm: x.warm });
  drawTraffic(pen, c, w, x.t, (o) => (o.ahead > 0 ? 7 + o.gap - 2 : -1), 8, W);
  // the own car from behind, big at the bottom, with its shadow, brake lights and plate
  const own = w.own!;
  const ox = W / 2 + sway;
  viewCar(pen, own, "back", ox, groundY, carW, (-sway / (W * 0.45)) * 0.4, x.t, w.steer * -2, 0);
  weatherOver(pen, x, w);
}

// ---- Down the road -----------------------------------------------------------------------------------------------

function roadWide(pen: Pen, x: ShotInput, w: World): void {
  const W = F.w;
  const H = F.h;
  const vpX = W * P(0.42, 0.45);
  // in 9:16 the horizon is at the middle and the own car nearer (bigger and lower), so the road under it is not an
  // empty half of the frame
  const hor = H * P(0.5, 0.42);
  // the camera stands by the road's right edge, 1.2 m up, so the road takes the left of the frame and the rail, the
  // verge and the grass the right
  const c: Cam3 = { vpX, hor, f: FOCAL, camX: 1.2, camH: 1.2 };
  const plan: RoadPlan = { ...w.plan, lamps: w.plan.lamps.length ? [{ x: w.plan.left - 1.5, arm: 1 }, { x: w.plan.right + 1.5, arm: -1 }] : [] };
  pen.setMatrix(layerMatrix(camFor(x, vpX, hor), 1));
  lightPart(x, "out");
  drawOutside(pen, c, { look: w.look, plan, m: w.m, t: x.t, seed: x.seed, sway: 0, x0: -80, x1: W + 80, top: 0, bottom: H + 80, zNear: 1, warm: x.warm });
  // every car by its gap and lane: the own car about 12 m ahead from behind, oncoming ones from the front
  const OWN_Z = P(7, 12);
  const list: { car: ShotCar; X: number; Z: number; front: boolean; roll: number; jolt: number }[] = [];
  if (w.own) list.push({ car: w.own, X: 0, Z: OWN_Z, front: false, roll: 0, jolt: 0 });
  for (const o of w.others) list.push({ car: o.car, X: o.X, Z: OWN_Z + o.ahead, front: o.oncoming, roll: o.roll, jolt: o.jolt });
  const seen = list.filter((v) => v.Z > 5).sort((a, b) => a.Z - b.Z).slice(0, SHOT_CARS + 1).reverse();
  for (const v of seen) {
    const [sx, sy] = project(c, v.X, 0, v.Z);
    const cw = pxPerM(c, v.Z) * (v.car.truck ? 2.5 : 1.85);
    viewCar(pen, v.car, v.front ? "front" : "back", sx, sy, cw, (vpX - sx) / (W * 0.45), x.t, v.roll, v.jolt, v.front ? 1.4 : 1);
  }
  weatherOver(pen, x, w);
}
