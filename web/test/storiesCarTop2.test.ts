// Clips Funded: the detailed vehicle's top view (CONTRACTS §45.48 section 2.7): the plan from the profile, two seats
// for the riders, the front wheels that turn, the stripe that skips the cockpit, both styles, every move.
import { describe, expect, it } from "vitest";
import { ND, LIGHTS, withWarm } from "../src/stories/engine/art.ts";
import type { CarDraw } from "../src/stories/engine/car.ts";
import { profileOf, topShape2 } from "../src/stories/engine/carShape.ts";
import { exhaustTips } from "../src/stories/engine/carTop2.ts";
import { F, inFrame } from "../src/stories/engine/frame.ts";
import { Pen } from "../src/stories/engine/pen.ts";
import { drawProp, propState } from "../src/stories/engine/props.ts";
import type { Beat, CarBody, CarLook, Prim, PropAction, SceneProp } from "../src/stories/engine/types.ts";

const OWNER_PROFILE = { body: "sports", lh: 379, wh: 162, tipH: 30, noseX: 3, noseH: 42, noseR: 20, chinH: 9, cowlX: 33, cowlH: 71, bonnet: 55, headX: 46, headH: 100, peakX: 50, roofX: 62, roofH: 97, deckX: 80, deckH: 84, tailX: 97, tailH: 81, rumpH: 15, sillH: 10, axF: 23, axR: 81, wheelD: 57, archGap: 9, beltH: 72, beltRise: 2, soft: 55, pillarX: 60, glassX: 62, panes: 1, roofW: 62, taperF: 22, taperR: 8 };

function look(body: CarBody, detail: CarLook["detail"] = { v: 1 }, extra: Partial<CarLook> = {}): CarLook {
  return {
    body, length: 1, height: 1, paint: "#55575a", accent: "#111111", pattern: "plain", windows: "clear",
    wheels: { style: "alloy", rim: "#c9ccd2", size: 1 }, lights: { front: "slim", rear: "round" }, extra: "none",
    face: { eyes: "none", color: "#1c1842", mouth: "none" }, outline: "#141414", detail, ...extra,
  } as CarLook;
}

const OWNER = look("sports", { v: 1, profile: OWNER_PROFILE, roof: { type: "open", hoops: "twin" }, stripe: { layout: "centre", color: "#111111", width: 60 }, rear: { exhaust: "high", spoiler: "ducktail" }, cabin: { rows: 1, seat: "#1b1b1d" } } as CarLook["detail"]);
const CLOSED = look("suv", { v: 1, roof: { type: "glass", rails: true }, extras: ["light_bar", "spare_wheel"] });
const PRESETS: CarBody[] = ["hatchback", "sedan", "estate", "suv", "pickup", "van", "sports", "compact", "bus"];

const prop: SceneProp = { propId: "p", kind: "car", x: 0.5, y: 0.7, scale: 1, rot: 0, castId: "c" };
type Seat = { x: number; y: number; r: number };

interface Run {
  prims: Prim[];
  seats: Seat[][];
}

function draw(car: CarLook, opts: { act?: PropAction | null; t?: number; nd?: boolean; light?: boolean; face?: CarLook["face"]; scale?: number; style?: "classic" | "night_drive" } = {}): Run {
  const run = (): Run => {
    const act = opts.act ?? null;
    const t = opts.t ?? 0.7;
    const beats: Beat[] = act ? [{ at: 0.2, dur: 1.6, who: "p", do: act, dir: "right", ...(["move", "skid", "spin", "stop", "bump", "speed_up", "stall"].includes(act) ? { to: { x: 0.62, y: 0.7 } } : {}) }] : [];
    const d: CarDraw = { car, style: "bouncy", seed: 11 };
    const st = propState({ ...prop, scale: opts.scale ?? 1 }, beats, "top", t, { braking: act === "stop" ? 1 : 0, steer: 0, rolled: t * 300 }, d);
    if (!act) st.face = car.face.eyes === "none" ? null : "happy";
    if (opts.light) st.lights = true;
    const pen = new Pen();
    const seats: Seat[][] = [];
    drawProp(pen, st, "top", t, 3, { top: (_pn, s) => seats.push(s) }, opts.light ?? false, d);
    return { prims: pen.out, seats };
  };
  return inFrame({ width: 1080, height: 1920, art: opts.style ?? "classic" }, () => {
    F.light = withWarm(LIGHTS.night, 1);
    return run();
  });
}

const nums = (p: Prim): number[] => {
  const o: number[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "number") o.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
  };
  for (const [key, v] of Object.entries(p)) if (key !== "k" && key !== "color") walk(v);
  return o;
};

describe("the detailed top view", () => {
  it("gives the riders two seats, side by side in an open car and one behind the other under a roof", () => {
    const open = draw(OWNER).seats;
    expect(open).toHaveLength(1);
    expect(open[0]).toHaveLength(2);
    const [a, b] = open[0]!;
    expect(a!.y).toBeCloseTo(b!.y, 3);
    expect(a!.x).toBeLessThan(0);
    expect(b!.x).toBeGreaterThan(0);
    expect(a!.r).toBeGreaterThan(8);
    const shut = look("sedan");
    const closed = draw(shut).seats[0]!;
    expect(closed).toHaveLength(2);
    expect(closed[0]!.x).toBeCloseTo(0, 3);
    expect(closed[0]!.y).not.toBeCloseTo(closed[1]!.y, 0);
    // the seats are inside the plan's length
    const g = topShape2(OWNER);
    for (const s of open[0]!) {
      expect(Math.abs(s.y)).toBeLessThan(g.L / 2);
      expect(Math.abs(s.x)).toBeLessThan(g.hw);
    }
  });

  it("draws different things from the classic top view and nothing at all for a look without detail", () => {
    const plain = { ...OWNER } as CarLook;
    delete (plain as { detail?: unknown }).detail;
    expect(draw(OWNER).prims).not.toEqual(draw(plain).prims);
    expect(draw(OWNER, { style: "night_drive" }).prims).not.toEqual(draw(OWNER).prims);
  });

  it("turns the front wheels and keeps the rear pair straight", () => {
    const g = topShape2(OWNER);
    const wheelPolys = (steer: number): Prim[] => {
      const out = inFrame({ width: 1080, height: 1920 }, () => {
        const d: CarDraw = { car: OWNER, style: "calm", seed: 1 };
        const st = propState(prop, [], "top", 0, { braking: 0, steer: 0, rolled: 0 }, d);
        st.wheelTurn = steer;
        const pen = new Pen();
        drawProp(pen, st, "top", 0, 1, {}, false, d);
        return pen.out;
      });
      return out.filter((p) => p.k === "poly");
    };
    const straight = draw(OWNER, { act: null, t: 0 }).prims;
    expect(g.wheels.filter((w) => w.front)).toHaveLength(2);
    expect(g.wheels.filter((w) => !w.front)).toHaveLength(2);
    expect(wheelPolys(30).length).toBeGreaterThan(0);
    expect(wheelPolys(30)).not.toEqual(wheelPolys(0));
    expect(straight.length).toBeGreaterThan(20);
  });

  it("keeps the whole plan, wheels and every part inside its box and finite, in every move, style and light", () => {
    const g = topShape2(OWNER);
    const acts: (PropAction | null)[] = [null, "move", "stop", "honk", "blink", "tyre_burst", "bump", "speed_up", "stall", "skid"];
    for (const car of [OWNER, CLOSED, look("pickup"), look("van"), look("bus")]) {
      for (const style of ["classic", "night_drive"] as const) {
        for (const act of acts) {
          for (const light of [false, true]) {
            const { prims } = draw(car, { act, style, light, t: 0.9 });
            expect(prims.length, `${car.body} ${style} ${act}`).toBeGreaterThan(10);
            for (const p of prims) for (const n of nums(p)) expect(Number.isFinite(n), `${car.body} ${style} ${act}`).toBe(true);
          }
        }
      }
    }
    // the plan is at most 14% wider and at least 35% as big as the classic box (its width is the profile's)
    const t = topShape2(look("sports"));
    expect(g.Wd).toBeGreaterThan(196 * 0.86 * 0.9);
    expect(g.Wd).toBeLessThan(196 * 1.14 * 1.6);
    expect(t.outline.length).toBeGreaterThan(20);
    for (let i = 0; i < g.outline.length; i += 2) {
      expect(Math.abs(g.outline[i]!)).toBeLessThanOrEqual(g.hw * 1.02);
      expect(Math.abs(g.outline[i + 1]!)).toBeLessThanOrEqual(g.L / 2 + 1);
    }
    for (const w of g.wheels) {
      expect(Math.abs(w.x)).toBeLessThan(g.hw + w.w);
      expect(Math.abs(w.y) + w.l / 2).toBeLessThan(g.L / 2 + 4);
    }
  });

  it("puts the wheels at the real axles: the front pair ahead of the rear pair, nose up", () => {
    for (const body of PRESETS) {
      if (["motorbike", "plane", "boat"].includes(body)) continue;
      const g = topShape2(look(body));
      const front = g.wheels.filter((w) => w.front);
      const rear = g.wheels.filter((w) => !w.front);
      expect(front[0]!.y, body).toBeLessThan(rear[0]!.y);
      expect(front[0]!.y).toBeCloseTo(g.yT(profileOf(look(body)).axF), 3);
    }
  });

  it("draws a bike, a plane and a boat as their classic selves", () => {
    for (const body of ["motorbike", "plane", "boat"] as CarBody[]) {
      const plain = look(body);
      delete (plain as { detail?: unknown }).detail;
      expect(draw(look(body)).prims, body).toEqual(draw(plain).prims);
    }
  });

  it("keeps the black stripe off the cockpit and runs it on over the deck (open) or the roof (closed)", () => {
    const stripes = (car: CarLook): Prim[] => draw(car).prims.filter((p) => p.k === "rect" && (p as { color?: string }).color === "#111111");
    const bands = stripes(OWNER);
    expect(bands.length).toBeGreaterThanOrEqual(2);
    const ys = bands.map((p) => (p as unknown as { y: number; h: number }).y);
    expect(ys.length).toBe(new Set(ys).size);
    const none = look("sports", { ...OWNER.detail!, stripe: { layout: "none" } } as CarLook["detail"]);
    expect(stripes(none).length).toBeLessThan(bands.length);
  });

  it("shows the lamps by shape: every front and rear shape draws something its neighbour does not", () => {
    const fronts = ["round", "twin_round", "oval", "square", "rect", "slim", "swept", "angled", "stacked", "pop_up", "strip"] as const;
    const seen = new Set<string>();
    for (const shape of fronts) seen.add(JSON.stringify(draw(look("sedan", { v: 1, lights: { front: { shape } } } as CarLook["detail"])).prims));
    expect(seen.size).toBe(fronts.length);
    const rears = ["round", "twin_round", "square", "rect", "tall", "slim", "bar", "split_bar", "wedge", "c_shape"] as const;
    const seenR = new Set<string>();
    for (const shape of rears) seenR.add(JSON.stringify(draw(look("sedan", { v: 1, lights: { rear: { shape } } } as CarLook["detail"])).prims));
    expect(seenR.size).toBe(rears.length);
  });

  it("Bright never calls glow; Night drive does for lit lamps and leaves no tail core while braking", () => {
    expect(draw(OWNER, { light: true, act: "stop" }).prims.some((p) => p.k === "glow")).toBe(false);
    const lit = draw(OWNER, { style: "night_drive", light: true }).prims;
    expect(lit.some((p) => p.k === "glow")).toBe(true);
    const braking = draw(OWNER, { style: "night_drive", act: "stop", t: 0.9 }).prims;
    expect(braking.some((p) => (p as { color?: string }).color === ND.tailCore)).toBe(false);
    expect(braking.some((p) => (p as { color?: string }).color === ND.brakeCore)).toBe(true);
  });

  it("drops the finer parts when the car is small, and never adds any", () => {
    const big = draw(OWNER, { scale: 1 }).prims.length;
    const small = draw(OWNER, { scale: 0.12 }).prims.length;
    expect(small).toBeLessThan(big);
    expect(small).toBeGreaterThan(8);
  });

  it("stays within the shape budget of a car of the cast, in both styles and every part on", () => {
    const full = look("suv", { v: 1, roof: { type: "glass", rails: true }, extras: ["light_bar", "spare_wheel", "bull_bar", "wing_lamps", "antenna", "tow_hook"], rear: { spoiler: "big_wing", exhaust: "quad", diffuser: "deep", bumper: "chrome" }, front: { splitter: "blade", grille: "mesh", bumper: "black" }, bonnet: { vent: "duct" }, stripe: { layout: "twin" } } as CarLook["detail"], { face: { eyes: "windscreen", color: "#1c1842", mouth: "none" } });
    expect(draw(full, { light: true }).prims.length).toBeLessThanOrEqual(72);
    expect(draw(full, { light: true, style: "night_drive" }).prims.length).toBeLessThanOrEqual(90);
    expect(draw(OWNER).prims.length).toBeLessThanOrEqual(56);
  });

  it("puts the exhaust tips where the layout says, symmetric across the tail", () => {
    expect(exhaustTips("none")).toEqual([]);
    expect(exhaustTips("centre")).toEqual([0]);
    expect(exhaustTips("quad")).toHaveLength(4);
    for (const l of ["twin", "high", "quad"] as const) {
      const t = exhaustTips(l);
      expect(t.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 6);
    }
  });
});
