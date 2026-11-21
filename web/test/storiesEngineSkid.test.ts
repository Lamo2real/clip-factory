// The Lamo Stories engine shows a skid the way the checked guidance teaches it (CONTRACTS §45.10, §45.11.5): a skid
// with `dir: "right"` slides the car's rear to the right, and a driver who steers right ("steer into the skid") gets
// a steering arrow that points right too. Read from the drawn frames: the car's lights give its rotation, the
// arrow's head gives the direction it points.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { drawFrame, normalizeScript, sceneFrames, validateScript } from "../src/stories/engine/engine.ts";
import { rearSwing } from "../src/stories/engine/props.ts";
import type { Prim, Scene, StoryScript } from "../src/stories/engine/types.ts";

const ENGINE = join(import.meta.dirname, "../src/stories/engine");
const raw = (name: string): StoryScript => JSON.parse(readFileSync(join(ENGINE, "fixtures", name), "utf8")) as StoryScript;

function valid(s: unknown): StoryScript {
  const r = validateScript(s);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return normalizeScript(r.script);
}

type Pt = [number, number];
const DEG = Math.PI / 180;
const HEADLIGHTS = new Set(["#ffe08a", "#fff3b0"]);
const TAILLIGHTS = new Set(["#b3262d", "#ff2d2d"]);
const ARROW = "#ffc94a";

function centre(p: Prim): Pt {
  if (p.k === "poly" || p.k === "line") {
    let x = 0;
    let y = 0;
    for (let i = 0; i < p.pts.length; i += 2) {
      x += p.pts[i]!;
      y += p.pts[i + 1]!;
    }
    return [x / (p.pts.length / 2), y / (p.pts.length / 2)];
  }
  if (p.k === "rect") return [p.x + p.w / 2, p.y + p.h / 2];
  if (p.k === "ellipse" || p.k === "circle") return [p.x, p.y];
  throw new Error(`no centre for ${p.k}`);
}

const mean = (pts: Pt[]): Pt => [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
/** The right-hand side of a heading (degrees clockwise from up, on a y-down screen). */
const rightOf = (heading: number): Pt => [Math.cos(heading * DEG), Math.sin(heading * DEG)];
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
const headingOf = (v: Pt) => Math.atan2(v[0], -v[1]) / DEG;

/** The long axis of a wheel (a rotated rounded rectangle), as a heading in degrees (mod 180). */
function axisOf(p: Extract<Prim, { k: "poly" }>): number {
  const [cx, cy] = centre(p);
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (let i = 0; i < p.pts.length; i += 2) {
    const dx = p.pts[i]! - cx;
    const dy = p.pts[i + 1]! - cy;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }
  const ang = 0.5 * Math.atan2(2 * xy, xx - yy); // the main axis from +x, y down
  return Math.atan2(Math.cos(ang), -Math.sin(ang)) / DEG;
}

const WHEELS = new Set(["#24242e", "#55556a"]);

/** How far the front wheels turn from the car body (degrees, + to the car's right), read from the two wheels nearest
 * the nose. */
function frontWheelTurn(prims: Prim[], car: Drawn): number {
  const wheels = prims.filter((p): p is Extract<Prim, { k: "poly" }> => p.k === "poly" && WHEELS.has(p.color));
  expect(wheels.length, "four wheels").toBe(4);
  const front = [...wheels].sort((a, b) => Math.hypot(centre(a)[0] - car.nose[0], centre(a)[1] - car.nose[1]) - Math.hypot(centre(b)[0] - car.nose[0], centre(b)[1] - car.nose[1])).slice(0, 2);
  const turns = front.map((w) => ((((axisOf(w) - car.heading) % 180) + 270) % 180) - 90);
  return (turns[0]! + turns[1]!) / 2;
}

interface Drawn {
  nose: Pt;
  tail: Pt;
  mid: Pt;
  /** the car body's heading, read from its lights */
  heading: number;
  /** the steering arrow's head: where its point is and which way it points */
  arrow: { tip: Pt; dir: Pt } | null;
}

/** Reads one top-view car from a frame: its head and tail lights, and the steering arrow nearest its nose. */
function readCar(prims: Prim[]): Drawn {
  const heads = prims.filter((p) => p.k === "ellipse" && HEADLIGHTS.has(p.color)).map(centre);
  const tails = prims.filter((p) => (p.k === "poly" || p.k === "rect") && TAILLIGHTS.has(p.color)).map(centre);
  expect(heads.length, "two headlights").toBe(2);
  expect(tails.length, "two tail lights").toBe(2);
  const nose = mean(heads);
  const tail = mean(tails);
  const mid = mean([nose, tail]);
  const heading = headingOf([nose[0] - tail[0], nose[1] - tail[1]]);
  // the steering arrow starts at the nose: a yellow stroke, then its head, a yellow triangle [base, point, base]
  let arrow: Drawn["arrow"] = null;
  let best = Infinity;
  prims.forEach((p, i) => {
    if (p.k !== "line" || p.color !== ARROW || p.w < 10) return;
    const d = Math.hypot(p.pts[0]! - nose[0], p.pts[1]! - nose[1]);
    const head = prims[i + 2];
    if (d >= best || !head || head.k !== "poly" || head.color !== ARROW || head.pts.length !== 6) return;
    const [ax, ay, tx, ty, bx, by] = head.pts as [number, number, number, number, number, number];
    best = d;
    arrow = { tip: [tx, ty], dir: [tx - (ax + bx) / 2, ty - (ay + by) / 2] };
  });
  // it must start right at the car's nose (within half a car length)
  if (best > Math.hypot(nose[0] - tail[0], nose[1] - tail[1]) / 2) arrow = null;
  return { nose, tail, mid, heading, arrow };
}

const angleDiff = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;

const CAST = () => raw("ice-skid.json").cast;

/** One top-view scene: a car driven by c1 skids from (x, y) heading `rot` towards `to`; c1 may steer. */
function skidScene(dir: "left" | "right", rot: number, steer: "left" | "right" | null): { s: StoryScript; travel: number; at: number; dur: number } {
  // the skid runs through the middle of the frame, so the car and the arrow ahead of it stay in view
  const reach = 0.24;
  const step = { x: Math.sin(rot * DEG) * reach, y: -Math.cos(rot * DEG) * reach * (9 / 16) };
  const from = { x: 0.5 - step.x / 2, y: 0.55 - step.y / 2 };
  const to = { x: from.x + step.x, y: from.y + step.y };
  const scene: Scene = {
    sceneId: "s1",
    title: "Skid",
    durationSec: 5,
    set: "icy_road",
    view: "top",
    camera: "wide",
    actors: [{ castId: "c1", x: 0.5, y: 0.72, facing: "right", inCar: "car1" }],
    props: [{ propId: "car1", kind: "car", x: from.x, y: from.y, scale: 1, rot, color: "#62c6ff" }],
    beats: [
      { at: 0.5, dur: 3, who: "car1", do: "skid", dir, to },
      ...(steer ? [{ at: 0.6, dur: 2.8, who: "c1", do: steer === "left" ? ("steer_left" as const) : ("steer_right" as const) }] : []),
    ],
    sfx: [],
    caption: null,
    note: null,
  };
  const s = valid({ engine: 3, fps: 30, width: 1080, height: 1920, durationSec: 5, title: "Skid", seed: 7, cast: { c1: CAST().c1 }, scenes: [scene], music: null, captionsOn: false, captions: [], safety: null });
  return { s, travel: rot, at: 0.5, dur: 3 };
}

describe("a top-view skid slides the rear to dir's side", () => {
  for (const dir of ["right", "left"] as const) {
    const side = dir === "right" ? 1 : -1;
    for (const rot of [0, 35, 90, -120]) {
      it(`dir ${dir}, heading ${rot}°: the rear slides ${dir} of the travel line and the steer_${dir} arrow points ${dir}`, () => {
        const { s, travel, at, dur } = skidScene(dir, rot, dir);
        for (const p of [0.2, 0.4, 0.6, 0.8]) {
          const f = Math.round((at + dur * p) * 30);
          const car = readCar(drawFrame(s, f));
          const right = rightOf(travel);
          // the tail lights are on dir's side of the line the car travels along
          const tailSide = dot([car.tail[0] - car.mid[0], car.tail[1] - car.mid[1]], right);
          expect(tailSide * side, `p ${p}: tail ${tailSide.toFixed(1)} px to the right of the travel line`).toBeGreaterThan(8);
          // so the nose turns the other way: the body is rotated away from dir by the swing
          const turned = angleDiff(car.heading, travel);
          expect(turned * side, `p ${p}: nose ${turned.toFixed(1)}°`).toBeLessThan(-4);
          expect(Math.abs(turned + rearSwing(p, side))).toBeLessThan(2.5);
          // the steering arrow points to the same side as the slide, against the travel line and against the car
          expect(car.arrow, `p ${p}: a steering arrow`).not.toBeNull();
          expect(dot(car.arrow!.dir, right) * side, `p ${p}: the arrow points ${dir} of the travel line`).toBeGreaterThan(0);
          expect(dot(car.arrow!.dir, rightOf(car.heading)) * side, `p ${p}: the arrow points to the car's ${dir}`).toBeGreaterThan(0);
          expect(dot([car.arrow!.tip[0] - car.nose[0], car.arrow!.tip[1] - car.nose[1]], rightOf(car.heading)) * side).toBeGreaterThan(0);
          // and the front wheels turn that way too, back towards the travel line (steering into the skid)
          const wheels = frontWheelTurn(drawFrame(s, f), car);
          expect(wheels * side, `p ${p}: front wheels ${wheels.toFixed(1)}° from the body`).toBeGreaterThan(5);
          expect(Math.abs(angleDiff(car.heading + wheels, travel)), `p ${p}: wheels point along the travel line`).toBeLessThan(Math.abs(turned) + 1);
        }
      });
    }
  }

  it("the rear swings out and back by the skid's end, never the other way on its own", () => {
    for (const side of [1, -1]) {
      for (let p = 0; p <= 1.0001; p += 0.02) expect(rearSwing(p, side) * side).toBeGreaterThanOrEqual(0);
      expect(Math.abs(rearSwing(0, side))).toBeLessThan(1e-9);
      expect(Math.abs(rearSwing(1, side))).toBeLessThan(1e-9);
      expect(rearSwing(0.4, side) * side).toBeCloseTo(34, 5);
    }
  });

  it("with no one steering there is no arrow, and the rear still slides dir's way", () => {
    for (const dir of ["right", "left"] as const) {
      const side = dir === "right" ? 1 : -1;
      const { s, travel, at, dur } = skidScene(dir, 0, null);
      const car = readCar(drawFrame(s, Math.round((at + dur * 0.4) * 30)));
      expect(car.arrow).toBeNull();
      expect(dot([car.tail[0] - car.mid[0], car.tail[1] - car.mid[1]], rightOf(travel)) * side).toBeGreaterThan(8);
    }
  });

  it("a driver steering the wrong way (a 'don't do this' scene) gets an arrow that shows the wrong way honestly", () => {
    const { s, at, dur } = skidScene("right", 0, "left");
    const car = readCar(drawFrame(s, Math.round((at + dur * 0.4) * 30)));
    expect(dot(car.arrow!.dir, rightOf(car.heading))).toBeLessThan(0);
  });

  it("the skid marks trail behind the rear wheels on dir's side", () => {
    for (const dir of ["right", "left"] as const) {
      const side = dir === "right" ? 1 : -1;
      const { s, travel, at, dur } = skidScene(dir, 0, dir);
      const prims = drawFrame(s, Math.round((at + dur * 0.5) * 30));
      // tyre marks are dark translucent lines on the road
      const marks = prims.filter((p): p is Extract<Prim, { k: "line" }> => p.k === "line" && p.color === "#1d1d26");
      expect(marks.length).toBeGreaterThanOrEqual(2);
      const car = readCar(prims);
      const last = marks.map((m) => [m.pts[m.pts.length - 2]!, m.pts[m.pts.length - 1]!] as Pt);
      // the newest mark points sit behind the car's middle and on dir's side of the travel line
      const offs = last.map((p) => dot([p[0] - car.mid[0], p[1] - car.mid[1]], rightOf(travel)));
      expect(Math.max(...offs.map((o) => o * side))).toBeGreaterThan(40);
    }
  });
});

describe("the ice-skid fixture teaches 'rear slides right? steer right' with a picture that matches", () => {
  const s = valid(raw("ice-skid.json"));

  for (const id of ["s3", "s5"]) {
    it(`${id}: while the car skids, its rear is right of where it travels${id === "s5" ? ", and the steering arrow points right" : ""}`, () => {
      const scene = s.scenes.find((sc) => sc.sceneId === id)!;
      const skid = scene.beats.find((b) => b.do === "skid")!;
      expect(skid.dir).toBe("right");
      // where the car travels during the skid: from its position when the skid starts to the skid's `to`
      const [first] = sceneFrames(s, id);
      const before = scene.beats.filter((b) => b.who === skid.who && b.to && b.at + b.dur <= skid.at).pop();
      const start = before?.to ?? scene.props.find((p) => p.propId === skid.who)!;
      const travel = headingOf([(skid.to!.x - start.x) * 1080, (skid.to!.y - start.y) * 1920]);
      let checked = 0;
      for (let f = Math.ceil((skid.at + 0.4) * 30); f < Math.floor((skid.at + skid.dur) * 30); f += 3) {
        const p = (f / 30 - skid.at) / skid.dur;
        if (rearSwing(p, 1) < 8) continue;
        const car = readCar(drawFrame(s, first + f));
        const tailSide = dot([car.tail[0] - car.mid[0], car.tail[1] - car.mid[1]], rightOf(travel));
        expect(tailSide, `frame ${f} of ${id}`).toBeGreaterThan(8);
        const steering = scene.beats.some((b) => b.do === "steer_right" && b.at + 0.2 <= f / 30 && f / 30 < b.at + b.dur - 0.2);
        if (steering) {
          expect(car.arrow, `frame ${f} of ${id}: arrow`).not.toBeNull();
          expect(dot(car.arrow!.dir, rightOf(travel)), `frame ${f} of ${id}: arrow right`).toBeGreaterThan(0);
        }
        checked += 1;
      }
      expect(checked).toBeGreaterThan(10);
    });
  }

  it("cap3 'Rear slides right? Steer right.' shows over the scene where the car skids right and the driver steers right", () => {
    const cap = s.captions.find((c) => c.guidanceRef === "skid-recovery.4")!;
    expect(cap.text).toMatch(/right.*right/i);
    let start = 0;
    const under = s.scenes.filter((sc) => {
      const from = start;
      start += sc.durationSec;
      return from < cap.at + cap.dur && start > cap.at;
    });
    const scene = under.find((sc) => sc.view === "top" && sc.beats.some((b) => b.do === "skid"))!;
    expect(scene.beats.find((b) => b.do === "skid")!.dir).toBe("right");
    expect(scene.beats.some((b) => b.do === "steer_right")).toBe(true);
    expect(scene.beats.some((b) => b.do === "steer_left")).toBe(false);
  });
});

describe("a side view keeps the car facing its way through a skid", () => {
  it("a skid's dir does not turn a car round in a side view", () => {
    const s = raw("ice-skid.json");
    const scene: Scene = {
      sceneId: "s1",
      title: "Skid",
      durationSec: 4,
      set: "icy_road",
      view: "side",
      camera: "wide",
      actors: [],
      props: [{ propId: "car1", kind: "car", x: 0.7, y: 0.74, scale: 1, rot: 0, color: "#62c6ff" }],
      beats: [
        { at: 0, dur: 1, who: "car1", do: "move", dir: "left", to: { x: 0.5, y: 0.74 } },
        { at: 1, dur: 2, who: "car1", do: "skid", dir: "right", to: { x: 0.3, y: 0.74 } },
      ],
      sfx: [],
      caption: null,
      note: null,
    };
    const script = valid({ ...s, durationSec: 4, scenes: [scene], captions: [], safety: null });
    // the headlights stay at the front, on the left, for the whole skid
    for (const t of [0.8, 1.5, 2.5]) {
      const side = readSideCar(drawFrame(script, Math.round(t * 30)));
      expect(side.head[0], `t ${t}`).toBeLessThan(side.tail[0]);
    }
  });

  // a skid that is the car's first beat: its dir is the side of the slide, and the car still goes nose first
  for (const dir of ["left", "right"] as const) {
    for (const [from, to] of [
      [0.7, 0.3],
      [0.3, 0.7],
    ] as const) {
      const way = to < from ? "left" : "right";
      it(`a first-beat skid with dir ${dir} travelling ${way} faces ${way} for the whole skid`, () => {
        const s = raw("ice-skid.json");
        const scene: Scene = {
          sceneId: "s1",
          title: "Skid",
          durationSec: 3,
          set: "icy_road",
          view: "side",
          camera: "wide",
          actors: [],
          props: [{ propId: "car1", kind: "car", x: from, y: 0.74, scale: 1, rot: 0, color: "#62c6ff" }],
          beats: [{ at: 0, dur: 2.5, who: "car1", do: "skid", dir, to: { x: to, y: 0.74 } }],
          sfx: [],
          caption: null,
          note: null,
        };
        const script = valid({ ...s, durationSec: 3, scenes: [scene], captions: [], safety: null });
        let last: number | null = null;
        for (const t of [0.1, 0.5, 1, 1.5, 2, 2.4]) {
          const car = readSideCar(drawFrame(script, Math.round(t * 30)));
          // the nose (headlights) is on the side the car travels to
          if (way === "left") expect(car.head[0], `t ${t}: headlights left of the tail lights`).toBeLessThan(car.tail[0]);
          else expect(car.head[0], `t ${t}: headlights right of the tail lights`).toBeGreaterThan(car.tail[0]);
          // and it really travels that way
          const mid = (car.head[0] + car.tail[0]) / 2;
          if (last !== null) expect((mid - last) * (way === "left" ? -1 : 1), `t ${t}: moving ${way}`).toBeGreaterThan(0);
          last = mid;
        }
      });
    }
  }
});

/** A side-view car's headlights and tail lights (both must be drawn). */
function readSideCar(prims: Prim[]): { head: Pt; tail: Pt } {
  const heads = prims.filter((p) => p.k === "ellipse" && HEADLIGHTS.has(p.color)).map(centre);
  const tails = prims.filter((p) => (p.k === "poly" || p.k === "rect") && TAILLIGHTS.has(p.color)).map(centre);
  expect(heads.length, "headlights drawn").toBeGreaterThan(0);
  expect(tails.length, "tail lights drawn").toBeGreaterThan(0);
  return { head: mean(heads), tail: mean(tails) };
}
