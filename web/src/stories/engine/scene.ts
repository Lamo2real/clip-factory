// Lamo Stories engine: one frame of one scene. Works out where every character and prop is, what the camera sees,
// then draws the place, the props and characters in depth order, the weather and the bubbles. It works in the
// frame's design px (frame.ts: the short side is 1080, positions 0..1 of the frame); the pen scales the result to
// the script's own size. A car of the cast (§45.43) is a car prop with a castId, drawn as that car; a rider can get in
// (walk to the door, step in, fade into the seat) and get out again.

import { BUBBLE_R, bubbleSpan, drawBubble, type Bubble } from "./bubbles.ts";
import { cameraAt, layerMatrix, toScreen, visibleBox, type Box, type Cam, type Focus } from "./camera.ts";
import { F, inFrame } from "./frame.ts";
import { DEG, TAU, clamp, clamp01, ease, hash, rand, smoothstep } from "./math.ts";
import { carSide, type CarDraw } from "./car.ts";
import { actorState, boardingAt, boardingOf, DRIVING, STYLES, type ActorState, type Boarding, type Style } from "./motion.ts";
import { frameView, Pen } from "./pen.ts";
import { endCardFrom, endCardLayout, textBoxes } from "./text.ts";
import { CARS, DECALS, drawProp, OVERLAYS, propBaseScale, propState, steerArrow, WEATHER, type DriverInput, type PropState } from "./props.ts";
import { drawCharacter, geometry, headTop, type Geo } from "./rig.ts";
import { drawSetBack, drawSetFront, drawSetWeatherBack, setInfo, type SetEnv } from "./sets.ts";
import type { ActionId, Beat, CastMember, Prim, PropAction, Scene, SceneActor, StoryScript, VideoAspect } from "./types.ts";

/** design pixels per rig unit for a character standing at y = 0.72 (about 450 px tall, 5/12 of the short side) */
export const CHAR_PX = 5;

// ---- per-script preparation (cached per script object, checked against its contents) --------------------

export interface Prepared {
  starts: number[];
  total: number;
  geos: Map<string, Geo>;
  impacts: number[][];
  bubbles: Bubble[];
  /** a safety story in a square or wide frame: how far down the end card's panel reaches (design px), so the last
   * shot can keep the heads below it */
  cardBottom: number | null;
}

const CACHE = new WeakMap<StoryScript, { sig: string; prep: Prepared }>();

/** Everything the cached layout depends on, so a script edited in place is laid out again. */
function signature(s: StoryScript): string {
  return JSON.stringify([s.width, s.height, s.seed, s.cast, s.cars ?? null, s.safety?.citations?.map((c) => c.publisher) ?? null, s.scenes.map((sc) => [sc.sceneId, sc.durationSec, sc.seed, sc.view, sc.camera, sc.actors, sc.props, sc.beats, sc.sfx])]);
}

export function sceneStarts(s: StoryScript): number[] {
  const out: number[] = [];
  let t = 0;
  for (const sc of s.scenes) {
    out.push(t);
    t += sc.durationSec;
  }
  return out;
}

export function prepare(s: StoryScript): Prepared {
  const sig = signature(s);
  const hit = CACHE.get(s);
  if (hit && hit.sig === sig) return hit.prep;
  return inFrame(s, () => prepareNow(s, sig));
}

function prepareNow(s: StoryScript, sig: string): Prepared {
  const starts = sceneStarts(s);
  const geos = new Map<string, Geo>();
  // people only: a car of the cast (script.cars) has no rig
  for (const [id, m] of Object.entries(s.cast)) geos.set(id, geometry(m.look));
  const prep: Prepared = {
    starts,
    total: s.scenes.reduce((a, sc) => a + sc.durationSec, 0),
    geos,
    impacts: s.scenes.map(impactsOf),
    bubbles: [],
    cardBottom: null,
  };
  if (s.safety && F.aspect !== "9:16") {
    const card = endCardLayout((s.safety.citations ?? []).map((c) => c.publisher), textBoxes().endcard);
    prep.cardBottom = card.bottom + card.size * 0.28 + 24;
  }
  prep.bubbles = layoutBubbles(s, prep);
  CACHE.set(s, { sig, prep });
  return prep;
}

function impactsOf(scene: Scene): number[] {
  const out: number[] = [];
  for (const b of scene.beats) {
    if (b.do === "bump" || b.do === "tyre_burst") out.push(b.at);
    if (b.do === "fall") out.push(b.at + Math.min(0.6, b.dur * 0.6));
    if (b.sfx === "thud" || b.sfx === "bump" || b.sfx === "tyre_burst") out.push(b.at);
  }
  for (const c of scene.sfx ?? []) if (c.sfx === "thud" || c.sfx === "bump" || c.sfx === "tyre_burst") out.push(c.at);
  out.sort((a, b) => a - b);
  return out.filter((v, i) => i === 0 || v - out[i - 1]! > 0.15);
}

// ---- scene state -----------------------------------------------------------------------------------------

/** One view of a character this frame: where it is and how much of it shows. */
interface ActorView {
  st: ActorState;
  /** in its car's seat (drawn through the windows) or standing outside */
  seated: boolean;
  /** 0..1 */
  alpha: number;
}

interface ActorRT extends ActorView {
  actor: SceneActor;
  member: CastMember;
  geo: Geo;
  style: Style;
  seed: number;
  /** while getting in or out of a car: the other half of the cross-fade (seated while `st` is outside, or the other
   * way round) */
  other: ActorView | null;
}

interface SceneRT {
  scene: Scene;
  view: "side" | "top";
  t: number;
  seed: number;
  actors: ActorRT[];
  props: PropState[];
  /** the cast's own cars by prop id (§45.43) */
  carDraws: Map<string, CarDraw>;
  occupants: Map<string, ActorRT[]>;
  steering: Map<string, number>;
  cam: Cam;
  scroll: number;
}

/** The seated view of a rider (the main one or the cross-fade's other half), if it shows. */
function seatedView(a: ActorRT): ActorView | null {
  if (a.seated) return a.alpha > 0.01 ? a : null;
  return a.other?.seated && a.other.alpha > 0.01 ? a.other : null;
}

/** The outside view of a character (standing, walking, getting in or out), if it shows. */
function outsideView(a: ActorRT): ActorView | null {
  if (!a.seated) return a.alpha > 0.01 ? a : null;
  return a.other && !a.other.seated && a.other.alpha > 0.01 ? a.other : null;
}

function beatsOf(scene: Scene, who: string): Beat[] {
  return scene.beats.filter((b) => b.who === who).sort((a, b) => a.at - b.at);
}

const MOVERS = new Set<PropAction>(["move", "skid", "spin", "stop", "bump", "speed_up", "stall"]);

/** When the road may roll by a car (§45.43): from the moment its last rider is in (the last get_in's end) until the
 * first one starts getting out. With nobody getting in or out it is the whole scene. */
interface RollWindow {
  from: number;
  until: number;
}
const ALWAYS: RollWindow = { from: -Infinity, until: Infinity };

/** How fast a driven car goes (0..1, a little more while it speeds up) at time t: brakes and stops slow it, a stall
 * stops it with a jerk, driving and speeding up get it going again. Before its window it stands still and starts
 * again only when told (drive, move or speed_up); it eases to a halt as the first rider starts getting out. */
function driveSpeed(carBeats: Beat[], driverBeats: Beat[], t: number, base: number, win: RollWindow = ALWAYS): number {
  if (t < win.from) return 0;
  const events: { at: number; dur: number; to: number; e: (x: number) => number }[] = [];
  for (const b of carBeats) {
    if (b.do === "stop") events.push({ at: b.at, dur: Math.max(0.2, b.dur), to: 0, e: ease.outCubic });
    if (b.do === "move" && !b.to) events.push({ at: b.at, dur: 0.6, to: 1, e: ease.inOutSine });
    // speeding up: slow, then fast, to a little over the usual speed
    if (b.do === "speed_up" && !b.to) events.push({ at: b.at, dur: Math.max(0.3, b.dur), to: 1.3, e: ease.inQuad });
    if (b.do === "stall" && !b.to) events.push({ at: b.at, dur: 0.4, to: 0, e: ease.outQuad });
  }
  for (const b of driverBeats) {
    if (b.do === "brake") events.push({ at: b.at, dur: Math.max(0.2, b.dur), to: 0.3, e: ease.outQuad });
    if (b.do === "drive") events.push({ at: b.at, dur: 0.8, to: 1, e: ease.inOutSine });
  }
  const live = Number.isFinite(win.from) ? events.filter((ev) => ev.at >= win.from) : events;
  live.sort((a, b) => a.at - b.at);
  let v = Number.isFinite(win.from) ? 0 : base;
  for (let i = 0; i < live.length; i += 1) {
    const ev = live[i]!;
    if (ev.at > t) break;
    const next = live[i + 1];
    const until = next && next.at <= t ? next.at : t;
    v = v + (ev.to - v) * ev.e(clamp01((until - ev.at) / ev.dur));
  }
  if (Number.isFinite(win.until)) v *= 1 - smoothstep(win.until - 0.6, win.until, t);
  return v;
}

function rolled(carBeats: Beat[], driverBeats: Beat[], t: number, base: number, speed: number, win: RollWindow = ALWAYS): number {
  let sum = 0;
  const dt = 1 / 30;
  for (let x = 0; x < t; x += dt) sum += driveSpeed(carBeats, driverBeats, Math.min(t, x + dt / 2), base, win) * speed * Math.min(dt, t - x);
  return sum;
}

/** A car's half length and its seats' x (side view, px at k = 1, facing +x): a car of the cast's own (car.ts), else
 * the plain car's of props.ts. */
function carSpots(car: CarDraw | undefined): { half: number; seats: number[] } {
  if (!car) return { half: 292, seats: [52, -112] };
  const side = carSide(car.car);
  return { half: side.hl, seats: side.seats.map((x) => x.x) };
}

/** Where a rider gets in and out (0..1 of the frame), and where its seat is, from the car at that moment. Side view:
 * the door is 0.35 of the car's length behind its middle, on the camera's side; top view: beside the car, on its left.
 * `away` is where a rider who got out ends up: 0.08 further from the car. */
function doorOf(car: PropState, view: "side" | "top", seat: number, draw: CarDraw | undefined): { door: { x: number; y: number }; seat: { x: number; y: number }; away: { x: number; y: number }; facing: "left" | "right" } {
  const k = propBaseScale(car, view);
  const spots = carSpots(draw);
  const len = spots.half / 292;
  if (view === "top") {
    const h = car.rot * DEG;
    // the car's left (nose up: -x), and its nose
    const lx = -Math.cos(h);
    const ly = -Math.sin(h);
    const side = (98 + 70) * k;
    const back = (seat === 0 ? -24 : 62) * k * len;
    const sx = car.x + (-Math.sin(h) * back) / F.w;
    const sy = car.y + (Math.cos(h) * back) / F.h;
    const door = { x: clamp(car.x + (lx * side) / F.w, 0.04, 0.96), y: clamp(car.y + (ly * side) / F.h, 0.04, 0.96) };
    const away = { x: clamp(door.x + lx * 0.08, 0.04, 0.96), y: clamp(door.y + (ly * 0.08 * F.w) / F.h, 0.04, 0.96) };
    return { door, seat: { x: sx, y: sy }, away, facing: lx < 0 ? "left" : "right" };
  }
  const f = car.facing >= 0 ? 1 : -1;
  const L = (2 * spots.half * k) / F.w;
  const door = { x: clamp(car.x - f * 0.35 * L, 0.04, 0.96), y: Math.min(1, car.y + 0.012) };
  const seatX = car.x + (f * (spots.seats[seat] ?? spots.seats[0] ?? 0) * k) / F.w;
  return { door, seat: { x: seatX, y: Math.min(1, car.y + 0.004) }, away: { x: clamp(door.x - f * 0.08, 0.04, 0.96), y: door.y }, facing: f > 0 ? "left" : "right" };
}

/** A rider's beats split by where it is (§45.43): outside before it has got in, in its seat between, and outside again
 * once it starts getting out. Getting in is a walk to the door over its first 60%, then a step into the seat; getting
 * out is a step out to the door over its first 40%, then a walk 0.08 away. Each part keeps the face it had. */
function boardingBeats(beats: Beat[], b: Boarding, spots: { inDoor: ReturnType<typeof doorOf> | null; outDoor: ReturnType<typeof doorOf> | null }): { before: Beat[]; seated: Beat[]; after: Beat[] } {
  const plain = beats.filter((x) => x.do !== "get_in" && x.do !== "get_out");
  const faceBy = (t: number): Beat["face"] => {
    let face: Beat["face"];
    for (const x of beats) if (x.at <= t + 1e-9 && x.face) face = x.face;
    return face;
  };
  const keep = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  const before: Beat[] = [];
  const seated: Beat[] = [];
  const after: Beat[] = [];
  const gi = b.getIn;
  const go = b.getOut;
  for (const x of plain) {
    if (gi && x.at < b.inEnd) before.push(x);
    else if (go && x.at >= b.outAt) after.push(x);
    else seated.push(x);
  }
  if (gi && spots.inDoor) {
    const who = gi.who;
    before.push(keep({ at: gi.at, dur: Math.max(0.05, gi.dur * 0.6), who, do: "walk" as const, to: spots.inDoor.door, face: gi.face, noise: gi.noise }));
    before.push(keep({ at: gi.at + gi.dur * 0.6, dur: Math.max(0.05, gi.dur * 0.4), who, do: "get_in" as const, to: spots.inDoor.seat }));
    const face = faceBy(gi.at);
    if (face) seated.push({ at: gi.at, dur: 0.05, who, do: "idle", face });
  }
  if (go && spots.outDoor) {
    const who = go.who;
    after.push(keep({ at: go.at, dur: Math.max(0.05, go.dur * 0.4), who, do: "get_out" as const, to: spots.outDoor.door, face: go.face ?? faceBy(go.at), noise: go.noise }));
    after.push(keep({ at: go.at + go.dur * 0.4, dur: Math.max(0.05, go.dur * 0.6), who, do: "walk" as const, to: spots.outDoor.away }));
  }
  const byAt = (p: Beat, q: Beat) => p.at - q.at;
  return { before: before.sort(byAt), seated: seated.sort(byAt), after: after.sort(byAt) };
}

const NO_DRIVER: DriverInput = { braking: 0, steer: 0, rolled: 0 };

export function sceneRuntime(s: StoryScript, prep: Prepared, index: number, t: number): SceneRT {
  const scene = s.scenes[index]!;
  const seed = (scene.seed ?? s.seed) >>> 0;
  const view = scene.view === "top" ? "top" : "side";
  const occupants = new Map<string, ActorRT[]>();
  const pending: { actor: SceneActor; member: CastMember; beats: Beat[]; geo: Geo; style: Style; seed: number; board: Boarding | null }[] = [];
  for (const actor of scene.actors) {
    const member = s.cast[actor.castId];
    const geo = prep.geos.get(actor.castId);
    if (!member || !geo) continue;
    const beats = beatsOf(scene, actor.castId);
    pending.push({ actor, member, beats, geo, style: STYLES[member.movementStyle] ?? STYLES.bouncy, seed: hash(seed, actor.castId), board: actor.inCar ? boardingOf(beats) : null });
  }
  // a car of the cast is drawn as its own car (§45.43)
  const carDraws = new Map<string, CarDraw>();
  for (const prop of scene.props) {
    const m = prop.kind === "car" && prop.castId ? s.cars?.[prop.castId] : undefined;
    if (m) carDraws.set(prop.propId, { car: m.car, style: m.movementStyle, seed: hash(seed, prop.castId!) });
  }
  // drivers steer and brake their cars; a car with people in it rolls the road by
  let scroll = 0;
  let scrollSign = 1;
  const steering = new Map<string, number>();
  const props: PropState[] = [];
  for (const prop of scene.props) {
    const pb = beatsOf(scene, prop.propId);
    const riders = pending.filter((p) => p.actor.inCar === prop.propId);
    const driver = riders[0];
    const draw = carDraws.get(prop.propId);
    const input: DriverInput = { braking: 0, steer: 0, rolled: 0 };
    // the road rolls only while everyone who gets in is in and nobody has started getting out
    const win: RollWindow = riders.some((r) => r.board)
      ? { from: Math.max(-Infinity, ...riders.map((r) => r.board?.inEnd ?? -Infinity)), until: Math.min(Infinity, ...riders.map((r) => r.board?.outAt ?? Infinity)) }
      : ALWAYS;
    if (CARS.has(prop.kind) && driver && boardingAt(driver.board, t).seat > 0.5) {
      for (const b of driver.beats) {
        if (t < b.at || t >= b.at + b.dur) continue;
        const p = b.dur > 0 ? (t - b.at) / b.dur : 1;
        if (b.do === "brake") input.braking = Math.max(input.braking, Math.sin(Math.PI * clamp01(p * 1.2)) ** 0.5);
        if (b.do === "steer_left" || b.do === "steer_right") input.steer = (b.do === "steer_left" ? -1 : 1) * Math.sin(Math.PI * clamp01(p)) ** 0.6;
      }
      if (input.steer !== 0) steering.set(prop.propId, input.steer);
    }
    const driven = CARS.has(prop.kind) && (riders.length > 0 || (prop.state ?? "").includes("driving")) && !(prop.state ?? "").includes("parked");
    const selfMoving = pb.some((b) => MOVERS.has(b.do as PropAction) && !!b.to);
    if (driven && !selfMoving) {
      const px = view === "top" ? 1300 : 1150;
      const r = rolled(pb, driver?.beats ?? [], t, 1, px, win);
      input.rolled = r;
      if (r > scroll) {
        scroll = r;
        scrollSign = view === "top" ? (Math.cos(prop.rot * DEG) >= 0 ? 1 : -1) : 1;
      }
    }
    const st = draw ? propState(prop, pb, view, t, input, draw) : propState(prop, pb, view, t, input);
    if (driven && !selfMoving) {
      const v = driveSpeed(pb, driver?.beats ?? [], t, 1, win);
      st.speed = Math.max(st.speed, v * 0.3);
      if (view === "side") scrollSign = st.facing;
    }
    props.push(st);
  }
  const unitsPerWidth = F.w / CHAR_PX;
  const actors: ActorRT[] = [];
  for (const p of pending) {
    const voice = p.member.voice?.style ?? "babble";
    const faces = ownFaces(p.member);
    const stateOf = (input: SceneActor, beats: Beat[]) => actorState(input, beats, p.style, p.geo, p.seed, t, unitsPerWidth, voice, faces);
    const car = p.actor.inCar ? props.find((c) => c.prop.propId === p.actor.inCar) : undefined;
    const base = { actor: p.actor, member: p.member, geo: p.geo, style: p.style, seed: p.seed };
    let rt: ActorRT;
    if (car && p.board) {
      // getting in or out (§45.43): outside, then in the seat, then outside again, cross-faded
      const carBeats = beatsOf(scene, car.prop.propId);
      const draw = carDraws.get(car.prop.propId);
      const seatNo = Math.max(0, pending.filter((q) => q.actor.inCar === p.actor.inCar).indexOf(p));
      const at = (time: number) => (draw ? propState(car.prop, carBeats, view, time, NO_DRIVER, draw) : propState(car.prop, carBeats, view, time, NO_DRIVER));
      const inDoor = p.board.getIn ? doorOf(at(p.board.inAt), view, seatNo, draw) : null;
      const outDoor = p.board.getOut ? doorOf(at(p.board.outAt), view, seatNo, draw) : null;
      const parts = boardingBeats(p.beats, p.board, { inDoor, outDoor });
      const vis = boardingAt(p.board, t);
      const seatedNow = (): ActorView => {
        const st = stateOf(p.actor, parts.seated);
        st.x = car.x;
        st.y = car.y;
        return { st, seated: true, alpha: vis.seat };
      };
      const outsideNow = (): ActorView => {
        const after = !!p.board!.getOut && t >= p.board!.outAt;
        const from = after && outDoor ? { castId: p.actor.castId, x: outDoor.seat.x, y: outDoor.seat.y, facing: outDoor.facing } : { castId: p.actor.castId, x: p.actor.x, y: p.actor.y, facing: p.actor.facing };
        return { st: stateOf(from, after ? parts.after : parts.before), seated: false, alpha: vis.out };
      };
      const main = vis.seat >= vis.out ? seatedNow() : outsideNow();
      const other = main.seated ? (vis.out > 0.01 ? outsideNow() : null) : vis.seat > 0.01 ? seatedNow() : null;
      rt = { ...base, ...main, other };
    } else {
      const st = stateOf(p.actor, p.beats);
      if (car) {
        st.x = car.x;
        st.y = car.y;
      }
      rt = { ...base, st, seated: !!car, alpha: 1, other: null };
    }
    if (car) {
      const list = occupants.get(car.prop.propId) ?? [];
      list.push(rt);
      occupants.set(car.prop.propId, list);
    }
    actors.push(rt);
  }
  const focus = focusOf(actors, props, view, carDraws);
  const cam = cameraAt(scene.camera, t, scene.durationSec, focus, seed, prep.impacts[index] ?? []);
  if (prep.cardBottom !== null && index === s.scenes.length - 1) clearEndCard(cam, actors, view, focus, prep.cardBottom, t, scene.durationSec);
  return { scene, view, t, seed, actors, props, carDraws, occupants, steering, cam, scroll: scroll * scrollSign };
}

/** In a square or wide frame the end card's band at the top reaches down to where heads are. Over the 0.4 s before
 * the card shows, the last shot eases down until every head (its hair too) is below the card: never so far that a
 * face leaves the frame, and no further than the feet allow when that is enough. */
function clearEndCard(cam: Cam, actors: ActorRT[], view: "side" | "top", focus: Focus, cardBottom: number, t: number, dur: number): void {
  const from = endCardFrom(dur) - 0.4;
  if (t <= from) return;
  let top = Infinity;
  let chin = -Infinity;
  let feet = -Infinity;
  for (const a of actors) {
    if (a.seated) continue;
    const px = actorScale(a.st.y, view);
    const y = a.st.y * F.h;
    // HAIR: how far spiky hair, a bun or a cap reach above the head's top (rig units)
    top = Math.min(top, y + (a.geo.top + Math.min(0, a.st.pose.dy) - HAIR) * px);
    chin = Math.max(chin, y + (a.geo.headY + a.st.pose.dy + a.geo.headRY) * px);
    feet = Math.max(feet, y);
  }
  if (!Number.isFinite(top)) {
    // only people in cars (or no one): the shot's own box
    if (!focus.box) return;
    top = focus.box.y0;
    feet = focus.box.y1;
    chin = focus.face ? focus.face.y + focus.face.r : feet;
  }
  const onScreen = (y: number) => F.h / 2 + (y - cam.cy) * cam.zoom;
  const need = cardBottom - onScreen(top);
  if (need <= 0) return;
  const keepFeet = F.h - 16 - onScreen(feet);
  const keepFace = F.h - 16 - onScreen(chin);
  const shift = Math.min(need, Math.max(0, keepFeet, keepFace));
  cam.cy -= (shift * ease.inOutSine(clamp01((t - from) / 0.4))) / cam.zoom;
}

/** How far the tallest hair styles reach above a character's head top (rig units, measured on every look). */
const HAIR = 12;

/** The faces a cast member keeps to (CONTRACTS §45.34), or null for a cast copied before characters carried them. */
function ownFaces(m: CastMember): CastMember["expressions"] | null {
  return Array.isArray(m.expressions) && m.expressions.length ? m.expressions : null;
}

function actorScale(y: number, view: "side" | "top"): number {
  return CHAR_PX * (view === "side" ? clamp(1 + (y - 0.72) * 0.8, 0.8, 1.2) : 0.62);
}

/** Where a seated rider's head is in a car of the cast (side view, px at k = 1, facing +x): over its own seat
 * (car.ts), a little under the window's top, as the plain car's 52 / -112 and -225 are. */
function seatHead(draw: CarDraw, seat: number): { x: number; y: number } {
  const seats = carSide(draw.car).seats;
  const s = seats[Math.max(0, seat)] ?? seats[0];
  return s ? { x: s.x, y: s.topY + 51 } : { x: 52, y: -225 };
}

function focusOf(actors: ActorRT[], props: PropState[], view: "side" | "top", draws: Map<string, CarDraw> = new Map()): Focus {
  const W = F.w;
  const H = F.h;
  let box: Box | null = null;
  let face: { x: number; y: number; r: number } | null = null;
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    box = box ? { x0: Math.min(box.x0, x0), y0: Math.min(box.y0, y0), x1: Math.max(box.x1, x1), y1: Math.max(box.y1, y1) } : { x0, y0, x1, y1 };
  };
  for (const a of actors) {
    const x = a.st.x * W;
    const y = a.st.y * H;
    // a rider getting in or out is framed where it stands until it is in its seat
    if (a.seated) {
      const car = props.find((c) => c.prop.propId === a.actor.inCar);
      const k = car ? propBaseScale(car, view) : 1;
      if (view === "top") {
        add(x - 120 * k, y - 200 * k, x + 120 * k, y + 200 * k);
        face ??= { x, y, r: 60 * k };
      } else {
        add(x - 300 * k, y - 300 * k, x + 300 * k, y);
        const draw = draws.get(a.actor.inCar ?? "");
        const h = draw ? seatHead(draw, 0) : { x: 52, y: -222 };
        face ??= { x: x + (car?.facing ?? 1) * h.x * k, y: y + h.y * k, r: 40 * k };
      }
      continue;
    }
    const px = actorScale(a.st.y, view);
    add(x - 32 * px, y + a.geo.top * px, x + 32 * px, y);
    face ??= { x, y: y + a.geo.headY * px, r: a.geo.headRY * px };
  }
  if (!box) {
    for (const p of props) {
      if (WEATHER.has(p.prop.kind) || !p.visible) continue;
      const x = p.x * W;
      const y = p.y * H;
      const k = propBaseScale(p, view) * (CARS.has(p.prop.kind) ? 1 : 0.6);
      if (CARS.has(p.prop.kind) || !box) add(x - 260 * k, y - 280 * k, x + 260 * k, y + (view === "top" ? 200 * k : 0));
    }
  }
  return { box, face };
}

// ---- drawing ---------------------------------------------------------------------------------------------

function drawActor(pen: Pen, a: ActorRT, v: ActorView, view: "side" | "top", t: number, dark: boolean): void {
  if (v.alpha < 1) {
    // fading in or out while getting in or out of a car
    pen.save();
    pen.fade(v.alpha);
    drawActorNow(pen, a, v.st, view, t, dark);
    pen.restore();
    return;
  }
  drawActorNow(pen, a, v.st, view, t, dark);
}

function drawActorNow(pen: Pen, a: ActorRT, st: ActorState, view: "side" | "top", t: number, dark: boolean): void {
  const px = actorScale(st.y, view);
  const x = st.x * F.w;
  const y = st.y * F.h;
  if (dark) {
    // a soft light behind the head keeps dark hair readable at night and on the stage
    const hy = y + (a.geo.headY + st.pose.dy) * px;
    pen.circle(x, hy, (a.geo.headRX + 22) * px, "#fff6e5", 0.07);
    pen.circle(x, hy, (a.geo.headRX + 10) * px, "#fff6e5", 0.07);
  }
  const lift = Math.max(0, -st.pose.dy);
  const lying = st.pose.rot < -45;
  const shadowK = 1 - Math.min(0.5, lift / 40);
  pen.ellipse(x - (lying ? st.facing * 40 * px : 0), y + 2, (lying ? 60 : 30) * px * shadowK, 6 * px * shadowK, 0, "#000000", 0.2 * shadowK);
  pen.save();
  pen.translate(x, y);
  pen.scale(px * st.flip, px);
  drawCharacter(pen, a.member.look, a.geo, st.pose, { t, seed: a.seed, face: st.face, inCar: false });
  pen.restore();
  drawExtras(pen, st, a.seed, a.geo, x, y, px, t);
}

const CONFETTI = ["#ffc94a", "#ff6f61", "#47d6a0", "#62c6ff", "#fff6e5"];

/** Confetti when celebrating, music notes when dancing, speed lines, landing dust (world px). */
export function drawExtras(pen: Pen, st: ActorState, seed: number, geo: Geo, x: number, y: number, px: number, t: number): void {
  const a = { seed };
  const topY = y + geo.top * px;
  if (st.extras.confetti > 0) {
    for (let i = 0; i < 9; i += 1) {
      const fall = ((t * (0.55 + rand(a.seed, i) * 0.4) + rand(a.seed, i + 9)) % 1) * 1;
      const cx = x + (rand(a.seed, i + 20) - 0.5) * 120 * px + Math.sin(t * 3 + i) * 10 * px;
      const cy = topY - 40 * px + fall * 120 * px;
      pen.save();
      pen.translate(cx, cy);
      pen.rotate(t * 260 + i * 40);
      pen.rect(-2.2 * px, -1.2 * px, 4.4 * px, 2.4 * px, 0, CONFETTI[i % CONFETTI.length]!, 1 - fall * 0.6);
      pen.restore();
    }
  }
  if (st.extras.notes > 0) {
    for (let i = 0; i < 2; i += 1) {
      const p = (t * 0.6 + i * 0.5) % 1;
      const nx = x + (i === 0 ? -1 : 1) * 34 * px + Math.sin(p * TAU) * 6 * px;
      const ny = topY + 8 * px - p * 24 * px;
      const al = 1 - p;
      pen.circle(nx, ny, 3.4 * px, "#1c1842", al);
      pen.line([nx + 3 * px, ny, nx + 3 * px, ny - 12 * px, nx + 8 * px, ny - 9 * px], 1.6 * px, "#1c1842", al);
    }
  }
  if (st.extras.speed > 0) {
    for (let i = 0; i < 3; i += 1) {
      const yy = y - (18 + i * 22) * px;
      const x0 = x - st.facing * 30 * px;
      const len = (26 + i * 10) * px * st.extras.speed;
      pen.line([x0, yy, x0 - st.facing * len, yy], 2.4 * px, "#ffffff", 0.6);
    }
  }
  if (st.extras.dust >= 0) {
    const p = st.extras.dust / 0.8;
    for (let i = 0; i < 4; i += 1) {
      const side = i % 2 === 0 ? -1 : 1;
      const d = (14 + i * 6) * px * (0.4 + p);
      pen.circle(x + side * d, y - 4 * px - p * 10 * px, (6 + i) * px * (0.6 + p * 0.6), "#e9e1d3", 0.7 * (1 - p));
    }
  }
}

/** The riders in their seats (side view), each in the seat of its place among the car's riders; one still outside
 * leaves its seat empty, one getting in or out fades. */
function drawOccupantsSide(pen: Pen, riders: ActorRT[], t: number, seats: { x: number; beltY: number; topY: number }[]): void {
  riders.forEach((a, k) => {
    const seat = seats[k];
    const v = seatedView(a);
    if (!seat || !v) return;
    const g = a.geo;
    const s = (seat.beltY - 12 - (seat.topY + 8)) / (g.shoulderY - g.top);
    const y0 = seat.beltY - 12 - s * (g.shoulderY + g.thigh);
    pen.save();
    if (v.alpha < 1) pen.fade(v.alpha);
    pen.translate(seat.x, y0);
    pen.scale(s);
    drawCharacter(pen, a.member.look, g, v.st.pose, { t, seed: a.seed, face: v.st.face, inCar: true });
    pen.restore();
  });
}

/** The tops of the riders' heads (top view), the same way. */
function drawOccupantsTop(pen: Pen, riders: ActorRT[], seats: { x: number; y: number; r: number }[]): void {
  riders.forEach((a, k) => {
    const seat = seats[k];
    const v = seatedView(a);
    if (!seat || !v) return;
    if (v.alpha >= 1) return headTop(pen, a.member.look, seat.x, seat.y, seat.r);
    pen.save();
    pen.fade(v.alpha);
    headTop(pen, a.member.look, seat.x, seat.y, seat.r);
    pen.restore();
  });
}

/** Draws frame-time `t` of scene `index`, in output pixels of the script's size. */
export function drawSceneFrame(s: StoryScript, index: number, t: number): Prim[] {
  return inFrame(s, () => drawSceneNow(s, index, t));
}

function drawSceneNow(s: StoryScript, index: number, t: number): Prim[] {
  const prep = prepare(s);
  const rt = sceneRuntime(s, prep, index, t);
  const pen = new Pen(frameView(F.w * F.k, F.h * F.k, F.k), F.k);
  const scene = rt.scene;
  const env: SetEnv = {
    pen,
    t,
    seed: rt.seed,
    scroll: rt.scroll,
    layer: (d) => pen.setMatrix(layerMatrix(rt.cam, d)),
    view: visibleBox(rt.cam),
  };
  drawSetBack(scene.set, rt.view, env);
  const weather = rt.props.filter((p) => WEATHER.has(p.prop.kind) && p.visible).map((p) => p.prop.kind as "snow" | "rain" | "fog");
  drawSetWeatherBack(scene.set, env, weather);
  const ground = layerMatrix(rt.cam, 1);
  pen.setMatrix(ground);
  const night = setInfo(scene.set).night;
  const dark = night || scene.set === "studio";
  for (const p of rt.props) if (DECALS.has(p.prop.kind)) drawProp(pen, p, rt.view, t, rt.seed, {}, night);
  type Item = { y: number; i: number; draw: () => void };
  const items: Item[] = [];
  rt.actors.forEach((a, i) => {
    // riders in their seats are drawn by their car; one getting in or out stands outside too
    const v = outsideView(a);
    if (!v) return;
    items.push({ y: v.st.y, i, draw: () => drawActor(pen, a, v, rt.view, t, dark) });
  });
  rt.props.forEach((p, i) => {
    const kind = p.prop.kind;
    if (DECALS.has(kind) || OVERLAYS.has(kind) || WEATHER.has(kind)) return;
    const riders = rt.occupants.get(p.prop.propId) ?? [];
    const occ = {
      side: (pn: Pen, seats: { x: number; beltY: number; topY: number }[]) => drawOccupantsSide(pn, riders, t, seats),
      top: (pn: Pen, seats: { x: number; y: number; r: number }[]) => drawOccupantsTop(pn, riders, seats),
    };
    const car = rt.carDraws.get(p.prop.propId);
    items.push({
      // at the same depth the characters stand in front of the props
      y: p.y - 0.0001,
      i: 100 + i,
      draw: () => (car ? drawProp(pen, p, rt.view, t, rt.seed, occ, night, car) : drawProp(pen, p, rt.view, t, rt.seed, occ, night)),
    });
  });
  items.sort((a, b) => a.y - b.y || a.i - b.i);
  for (const it of items) {
    pen.setMatrix(ground);
    it.draw();
  }
  pen.setMatrix(ground);
  if (rt.view === "top") {
    for (const p of rt.props) {
      const steer = rt.steering.get(p.prop.propId);
      if (steer !== undefined && Math.abs(steer) > 0.05) steerArrow(pen, p, Math.sign(steer), Math.abs(steer) * 1.4);
    }
  }
  for (const p of rt.props) if (OVERLAYS.has(p.prop.kind)) drawProp(pen, p, rt.view, t, rt.seed, {}, night);
  drawSetFront(scene.set, rt.view, env, weather);
  for (const b of prep.bubbles) if (b.scene === index && t >= b.at && t < b.at + b.span) drawBubble(pen, b, t - b.at);
  return pen.out;
}

// ---- bubbles: placed once per script so the frames and the text track agree -----------------------------

/** Where a character's head is on screen, and about how big it is there (px). */
function headOnScreen(rt: SceneRT, castId: string): [number, number, number] | null {
  const a = rt.actors.find((x) => x.actor.castId === castId);
  if (!a) return null;
  let wx = a.st.x * F.w;
  let wy: number;
  let wr: number;
  if (a.seated) {
    const car = rt.props.find((c) => c.prop.propId === a.actor.inCar);
    const k = car ? propBaseScale(car, rt.view) : 1;
    if (rt.view === "top") {
      wy = a.st.y * F.h;
      wr = 40 * k;
    } else {
      const seat = (rt.occupants.get(a.actor.inCar ?? "") ?? []).indexOf(a);
      const draw = rt.carDraws.get(a.actor.inCar ?? "");
      const h = draw ? seatHead(draw, seat) : { x: seat <= 0 ? 52 : -112, y: -225 };
      wx += (car?.facing ?? 1) * h.x * k;
      wy = a.st.y * F.h + h.y * k;
      wr = 44 * k;
    }
  } else {
    const px = actorScale(a.st.y, rt.view);
    wy = a.st.y * F.h + (a.geo.headY + a.st.pose.dy) * px;
    wr = Math.max(a.geo.headRX, a.geo.headRY) * px;
  }
  const [x, y] = toScreen(rt.cam, wx, wy);
  return [x, y, wr * rt.cam.zoom];
}

/** Per shape (design px): the highest a bubble's centre may sit (under the platforms' top tabs in 9:16), the lowest
 * (above the captions), and the lowest it starts looking from. */
const BUBBLE_AT: Record<VideoAspect, { high: number; low: number; start: number }> = {
  "9:16": { high: 330, low: 1240, start: 1180 },
  "1:1": { high: 160, low: 765, start: 705 },
  "16:9": { high: 160, low: 765, start: 705 },
};
/** A bubble's centre keeps this far in from the frame's left and right edges. */
const BUBBLE_SIDE = 190;
/** Half the widest balloon (the wide ones are 1.3 radii across), plus its outline. */
const BALLOON = BUBBLE_R * 1.3 + 8;

/** Places every bubble once per script: beside the speaker's head (never over it), clear of the bubbles showing at the
 * same time, and in a safety story's last seconds below the end card. A bubble that cannot keep clear of the end card
 * ends when the card starts, or is left out (the card's sources line matters more than a symbol). */
function layoutBubbles(s: StoryScript, prep: Prepared): Bubble[] {
  const out: Bubble[] = [];
  const W = F.w;
  const { high: BUBBLE_HIGH, low: BUBBLE_LOW, start: START } = BUBBLE_AT[F.aspect];
  // a safety story's end card covers the top of the last scene's last seconds
  const below = s.safety ? endCardLayout((s.safety.citations ?? []).map((c) => c.publisher), textBoxes().endcard).bottom + BALLOON + 24 : 0;
  const last = s.scenes.length - 1;
  s.scenes.forEach((scene, i) => {
    const start = prep.starts[i]!;
    const cardFrom = s.safety && i === last ? endCardFrom(scene.durationSec) : Infinity;
    for (const b of [...scene.beats].sort((x, y) => x.at - y.at)) {
      if (!b.bubble || !(b.who in s.cast) || !scene.actors.some((a) => a.castId === b.who)) continue;
      const rt = sceneRuntime(s, prep, i, b.at);
      const head = headOnScreen(rt, b.who);
      if (!head) continue;
      const [hx, hy, hr] = head;
      const pref = hx > W / 2 ? -1 : 1;
      const place = (top: number, span: number): { x: number; y: number } | null => {
        const y0 = clamp(hy - 280, top, START);
        const others = out.filter((o) => o.scene === i && o.at < b.at + span && o.at + o.span > b.at);
        for (const y of [y0, y0 + BUBBLE_R * 2.4, y0 + BUBBLE_R * 4.8]) {
          if (y > BUBBLE_LOW) break;
          for (const side of [pref, -pref]) {
            // far enough to the side that the balloon never covers the face
            const need = Math.sqrt(Math.max(0, (hr + BALLOON + 12) ** 2 - (y - hy) ** 2));
            const x = clamp(hx + side * Math.max(BUBBLE_SIDE, need), BUBBLE_SIDE, W - BUBBLE_SIDE);
            if (Math.hypot(x - hx, y - hy) < hr + BALLOON + 12) continue;
            if (others.some((o) => Math.hypot(o.x - x, o.y - y) < BUBBLE_R * 2.3)) continue;
            return { x, y };
          }
        }
        return null;
      };
      let span = Math.min(bubbleSpan(b.dur), scene.durationSec - b.at);
      let spot = place(b.at + span > cardFrom ? below : BUBBLE_HIGH, span);
      if (!spot && b.at + span > cardFrom && cardFrom - b.at >= 0.6) {
        span = cardFrom - b.at;
        spot = place(BUBBLE_HIGH, span);
      }
      if (!spot && !(b.at + span > cardFrom)) {
        // a crowded moment: beside the head, even if it touches another bubble
        const x = clamp(hx + pref * Math.max(BUBBLE_SIDE, hr + BALLOON + 12), BUBBLE_SIDE, W - BUBBLE_SIDE);
        spot = { x, y: clamp(hy - 280, BUBBLE_HIGH, START) };
      }
      if (!spot) continue;
      out.push({ kind: b.bubble, start: start + b.at, end: start + b.at + span, scene: i, at: b.at, span, x: spot.x, y: spot.y, hx, hy });
    }
  });
  return out;
}

/** A character's driving actions in this scene (the audio track adds the engine when someone drives): someone in a
 * car, a driving action, or a car that moves or speeds up. */
export function drives(scene: Scene): boolean {
  return scene.actors.some((a) => !!a.inCar) || scene.beats.some((b) => DRIVING.has(b.do as ActionId)) || scene.props.some((p) => CARS.has(p.kind) && scene.beats.some((b) => b.who === p.propId && (b.do === "move" || b.do === "speed_up")));
}
