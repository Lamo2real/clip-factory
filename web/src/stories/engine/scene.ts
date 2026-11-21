// Lamo Stories engine: one frame of one scene. Works out where every character and prop is, what the camera sees,
// then draws the place, the props and characters in depth order, the weather and the bubbles.

import { BUBBLE_R, bubbleSpan, drawBubble, type Bubble } from "./bubbles.ts";
import { cameraAt, layerMatrix, toScreen, visibleBox, type Box, type Cam, type Focus } from "./camera.ts";
import { DEG, TAU, clamp, clamp01, ease, hash, rand } from "./math.ts";
import { actorState, DRIVING, STYLES, type ActorState, type Style } from "./motion.ts";
import { Pen } from "./pen.ts";
import { endCardFrom, endCardLayout } from "./text.ts";
import { CARS, DECALS, drawProp, OVERLAYS, propBaseScale, propState, steerArrow, WEATHER, type DriverInput, type PropState } from "./props.ts";
import { drawCharacter, geometry, headTop, type Geo } from "./rig.ts";
import { drawSetBack, drawSetFront, drawSetWeatherBack, setInfo, type SetEnv } from "./sets.ts";
import type { ActionId, Beat, CastMember, Prim, PropAction, Scene, SceneActor, StoryScript } from "./types.ts";

export const W = 1080;
export const H = 1920;
/** output pixels per rig unit for a character standing at y = 0.72 (about 450 px tall) */
export const CHAR_PX = 5;

// ---- per-script preparation (cached per script object, checked against its contents) --------------------

export interface Prepared {
  starts: number[];
  total: number;
  geos: Map<string, Geo>;
  impacts: number[][];
  bubbles: Bubble[];
}

const CACHE = new WeakMap<StoryScript, { sig: string; prep: Prepared }>();

/** Everything the cached layout depends on, so a script edited in place is laid out again. */
function signature(s: StoryScript): string {
  return JSON.stringify([s.seed, s.cast, s.safety?.citations?.map((c) => c.publisher) ?? null, s.scenes.map((sc) => [sc.sceneId, sc.durationSec, sc.seed, sc.view, sc.camera, sc.actors, sc.props, sc.beats, sc.sfx])]);
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
  const starts = sceneStarts(s);
  const geos = new Map<string, Geo>();
  for (const [id, m] of Object.entries(s.cast)) geos.set(id, geometry(m.look));
  const prep: Prepared = {
    starts,
    total: s.scenes.reduce((a, sc) => a + sc.durationSec, 0),
    geos,
    impacts: s.scenes.map(impactsOf),
    bubbles: [],
  };
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

interface ActorRT {
  actor: SceneActor;
  member: CastMember;
  geo: Geo;
  style: Style;
  seed: number;
  st: ActorState;
}

interface SceneRT {
  scene: Scene;
  view: "side" | "top";
  t: number;
  seed: number;
  actors: ActorRT[];
  props: PropState[];
  occupants: Map<string, ActorRT[]>;
  steering: Map<string, number>;
  cam: Cam;
  scroll: number;
}

function beatsOf(scene: Scene, who: string): Beat[] {
  return scene.beats.filter((b) => b.who === who).sort((a, b) => a.at - b.at);
}

const MOVERS = new Set<PropAction>(["move", "skid", "spin", "stop", "bump"]);

/** How fast a driven car goes (0..1) at time t: brakes and stops slow it, driving speeds it back up. */
function driveSpeed(carBeats: Beat[], driverBeats: Beat[], t: number, base: number): number {
  const events: { at: number; dur: number; to: number; e: (x: number) => number }[] = [];
  for (const b of carBeats) {
    if (b.do === "stop") events.push({ at: b.at, dur: Math.max(0.2, b.dur), to: 0, e: ease.outCubic });
    if (b.do === "move" && !b.to) events.push({ at: b.at, dur: 0.6, to: 1, e: ease.inOutSine });
  }
  for (const b of driverBeats) {
    if (b.do === "brake") events.push({ at: b.at, dur: Math.max(0.2, b.dur), to: 0.3, e: ease.outQuad });
    if (b.do === "drive") events.push({ at: b.at, dur: 0.8, to: 1, e: ease.inOutSine });
  }
  events.sort((a, b) => a.at - b.at);
  let v = base;
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i]!;
    if (ev.at > t) break;
    const next = events[i + 1];
    const until = next && next.at <= t ? next.at : t;
    v = v + (ev.to - v) * ev.e(clamp01((until - ev.at) / ev.dur));
  }
  return v;
}

function rolled(carBeats: Beat[], driverBeats: Beat[], t: number, base: number, speed: number): number {
  let sum = 0;
  const dt = 1 / 30;
  for (let x = 0; x < t; x += dt) sum += driveSpeed(carBeats, driverBeats, Math.min(t, x + dt / 2), base) * speed * Math.min(dt, t - x);
  return sum;
}

export function sceneRuntime(s: StoryScript, prep: Prepared, index: number, t: number): SceneRT {
  const scene = s.scenes[index]!;
  const seed = (scene.seed ?? s.seed) >>> 0;
  const view = scene.view === "top" ? "top" : "side";
  const occupants = new Map<string, ActorRT[]>();
  const pending: { actor: SceneActor; member: CastMember; beats: Beat[]; geo: Geo; style: Style; seed: number }[] = [];
  for (const actor of scene.actors) {
    const member = s.cast[actor.castId];
    const geo = prep.geos.get(actor.castId);
    if (!member || !geo) continue;
    pending.push({ actor, member, beats: beatsOf(scene, actor.castId), geo, style: STYLES[member.movementStyle] ?? STYLES.bouncy, seed: hash(seed, actor.castId) });
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
    const input: DriverInput = { braking: 0, steer: 0, rolled: 0 };
    if (CARS.has(prop.kind) && driver) {
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
      const r = rolled(pb, driver?.beats ?? [], t, 1, px);
      input.rolled = r;
      if (r > scroll) {
        scroll = r;
        scrollSign = view === "top" ? (Math.cos(prop.rot * DEG) >= 0 ? 1 : -1) : 1;
      }
    }
    const st = propState(prop, pb, view, t, input);
    if (driven && !selfMoving) {
      const v = driveSpeed(pb, driver?.beats ?? [], t, 1);
      st.speed = Math.max(st.speed, v * 0.3);
      if (view === "side") scrollSign = st.facing;
    }
    props.push(st);
  }
  const unitsPerWidth = W / CHAR_PX;
  const actors: ActorRT[] = [];
  for (const p of pending) {
    const st = actorState(p.actor, p.beats, p.style, p.geo, p.seed, t, unitsPerWidth);
    const rt: ActorRT = { actor: p.actor, member: p.member, geo: p.geo, style: p.style, seed: p.seed, st };
    if (p.actor.inCar) {
      const car = props.find((c) => c.prop.propId === p.actor.inCar);
      if (car) {
        st.x = car.x;
        st.y = car.y;
        const list = occupants.get(car.prop.propId) ?? [];
        list.push(rt);
        occupants.set(car.prop.propId, list);
      }
    }
    actors.push(rt);
  }
  const focus = focusOf(actors, props, view);
  const cam = cameraAt(scene.camera, t, scene.durationSec, focus, seed, prep.impacts[index] ?? []);
  return { scene, view, t, seed, actors, props, occupants, steering, cam, scroll: scroll * scrollSign };
}

function actorScale(y: number, view: "side" | "top"): number {
  return CHAR_PX * (view === "side" ? clamp(1 + (y - 0.72) * 0.8, 0.8, 1.2) : 0.62);
}

function focusOf(actors: ActorRT[], props: PropState[], view: "side" | "top"): Focus {
  let box: Box | null = null;
  let face: { x: number; y: number; r: number } | null = null;
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    box = box ? { x0: Math.min(box.x0, x0), y0: Math.min(box.y0, y0), x1: Math.max(box.x1, x1), y1: Math.max(box.y1, y1) } : { x0, y0, x1, y1 };
  };
  for (const a of actors) {
    const x = a.st.x * W;
    const y = a.st.y * H;
    if (a.actor.inCar) {
      const car = props.find((c) => c.prop.propId === a.actor.inCar);
      const k = car ? propBaseScale(car, view) : 1;
      if (view === "top") {
        add(x - 120 * k, y - 200 * k, x + 120 * k, y + 200 * k);
        face ??= { x, y, r: 60 * k };
      } else {
        add(x - 300 * k, y - 300 * k, x + 300 * k, y);
        face ??= { x: x + (car?.facing ?? 1) * 52 * k, y: y - 222 * k, r: 40 * k };
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

function drawActor(pen: Pen, a: ActorRT, view: "side" | "top", t: number, dark: boolean): void {
  const st = a.st;
  const px = actorScale(st.y, view);
  const x = st.x * W;
  const y = st.y * H;
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
  drawExtras(pen, a.st, a.seed, a.geo, x, y, px, t);
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

function drawOccupantsSide(pen: Pen, riders: ActorRT[], t: number, seats: { x: number; beltY: number; topY: number }[]): void {
  riders.forEach((a, k) => {
    const seat = seats[k];
    if (!seat) return;
    const g = a.geo;
    const s = (seat.beltY - 12 - (seat.topY + 8)) / (g.shoulderY - g.top);
    const y0 = seat.beltY - 12 - s * (g.shoulderY + g.thigh);
    pen.save();
    pen.translate(seat.x, y0);
    pen.scale(s);
    drawCharacter(pen, a.member.look, g, a.st.pose, { t, seed: a.seed, face: a.st.face, inCar: true });
    pen.restore();
  });
}

/** Draws frame-time `t` of scene `index`. */
export function drawSceneFrame(s: StoryScript, index: number, t: number): Prim[] {
  const prep = prepare(s);
  const rt = sceneRuntime(s, prep, index, t);
  const pen = new Pen();
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
    if (a.actor.inCar && rt.occupants.has(a.actor.inCar)) return;
    items.push({ y: a.st.y, i, draw: () => drawActor(pen, a, rt.view, t, dark) });
  });
  rt.props.forEach((p, i) => {
    const kind = p.prop.kind;
    if (DECALS.has(kind) || OVERLAYS.has(kind) || WEATHER.has(kind)) return;
    const riders = rt.occupants.get(p.prop.propId) ?? [];
    items.push({
      // at the same depth the characters stand in front of the props
      y: p.y - 0.0001,
      i: 100 + i,
      draw: () =>
        drawProp(pen, p, rt.view, t, rt.seed, {
          side: (pn, seats) => drawOccupantsSide(pn, riders, t, seats),
          top: (pn, seats) => riders.forEach((a, k) => seats[k] && headTop(pn, a.member.look, seats[k]!.x, seats[k]!.y, seats[k]!.r)),
        }, night),
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
  let wx = a.st.x * W;
  let wy: number;
  let wr: number;
  if (a.actor.inCar) {
    const car = rt.props.find((c) => c.prop.propId === a.actor.inCar);
    const k = car ? propBaseScale(car, rt.view) : 1;
    if (rt.view === "top") {
      wy = a.st.y * H;
      wr = 40 * k;
    } else {
      const seat = (rt.occupants.get(a.actor.inCar) ?? []).indexOf(a);
      wx += (car?.facing ?? 1) * (seat <= 0 ? 52 : -112) * k;
      wy = a.st.y * H - 225 * k;
      wr = 44 * k;
    }
  } else {
    const px = actorScale(a.st.y, rt.view);
    wy = a.st.y * H + (a.geo.headY + a.st.pose.dy) * px;
    wr = Math.max(a.geo.headRX, a.geo.headRY) * px;
  }
  const [x, y] = toScreen(rt.cam, wx, wy);
  return [x, y, wr * rt.cam.zoom];
}

/** The lowest a bubble's centre may sit (above the captions), and the highest (under the platforms' top tabs). */
const BUBBLE_LOW = 1240;
const BUBBLE_HIGH = 330;
/** Half the widest balloon (the wide ones are 1.3 radii across), plus its outline. */
const BALLOON = BUBBLE_R * 1.3 + 8;

/** Places every bubble once per script: beside the speaker's head (never over it), clear of the bubbles showing at the
 * same time, and in a safety story's last seconds below the end card. A bubble that cannot keep clear of the end card
 * ends when the card starts, or is left out (the card's sources line matters more than a symbol). */
function layoutBubbles(s: StoryScript, prep: Prepared): Bubble[] {
  const out: Bubble[] = [];
  // a safety story's end card covers the top of the last scene's last seconds
  const below = s.safety ? endCardLayout((s.safety.citations ?? []).map((c) => c.publisher)).bottom + BALLOON + 24 : 0;
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
        const y0 = clamp(hy - 280, top, 1180);
        const others = out.filter((o) => o.scene === i && o.at < b.at + span && o.at + o.span > b.at);
        for (const y of [y0, y0 + BUBBLE_R * 2.4, y0 + BUBBLE_R * 4.8]) {
          if (y > BUBBLE_LOW) break;
          for (const side of [pref, -pref]) {
            // far enough to the side that the balloon never covers the face
            const need = Math.sqrt(Math.max(0, (hr + BALLOON + 12) ** 2 - (y - hy) ** 2));
            const x = clamp(hx + side * Math.max(190, need), 190, W - 190);
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
        const x = clamp(hx + pref * Math.max(190, hr + BALLOON + 12), 190, W - 190);
        spot = { x, y: clamp(hy - 280, BUBBLE_HIGH, 1180) };
      }
      if (!spot) continue;
      out.push({ kind: b.bubble, start: start + b.at, end: start + b.at + span, scene: i, at: b.at, span, x: spot.x, y: spot.y, hx, hy });
    }
  });
  return out;
}

/** A character's driving actions in this scene (the audio track adds the engine when someone drives). */
export function drives(scene: Scene): boolean {
  return scene.actors.some((a) => !!a.inCar) || scene.beats.some((b) => DRIVING.has(b.do as ActionId)) || scene.props.some((p) => CARS.has(p.kind) && scene.beats.some((b) => b.who === p.propId && b.do === "move"));
}
