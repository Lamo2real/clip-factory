// Clips Funded: the likeness acceptance (design-final section 7). The three reference looks (an open mid-engined
// two-seater, a boxy off-roader, a small hatchback) are valid, draw in every view and style inside their budgets with
// no NaN, show their landmarks as measurable numbers, and a look without `detail` still draws as it always did.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { carShapes, carViewShapes, checkCarLook, DEFAULT_CAR, type CarDraw } from "../src/stories/engine/car.ts";
import { checkCarDetail } from "../src/stories/engine/carDetail.ts";
import { drawCarView, type CarViewOpts } from "../src/stories/engine/carView.ts";
import { LIGHTS, withWarm } from "../src/stories/engine/art.ts";
import { CATALOG } from "../src/stories/engine/catalog.ts";
import { F, inFrame } from "../src/stories/engine/frame.ts";
import { Pen } from "../src/stories/engine/pen.ts";
import { drawProp, propState } from "../src/stories/engine/props.ts";
import type { ArtStyle, Beat, CarLook, Prim, PropAction, SceneProp } from "../src/stories/engine/types.ts";

type Refs = Record<"spider" | "suv" | "poppy", CarLook>;
const REFS = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "car-likeness-looks.json"), "utf8")) as Refs;
const NAMES = ["spider", "suv", "poppy"] as const;
const NIGHT = withWarm(LIGHTS.night, 1);
const ACTIONS: (PropAction | null)[] = [null, ...CATALOG.propActions.map((a) => a.id as PropAction)];
const MOVERS = new Set<PropAction>(["move", "skid", "spin", "stop", "bump", "speed_up", "stall"]);
const STYLES: ArtStyle[] = ["classic", "night_drive"];

const withFace = (look: CarLook): CarLook => ({ ...look, face: { eyes: "windscreen", color: "#1c1842", mouth: "grille" } });
const stripped = (look: CarLook): CarLook => {
  const { detail: _detail, ...rest } = look;
  return rest as CarLook;
};

/** One car's prims at time t of one prop action (or none), in a view and a style. */
function side(car: CarLook, view: "side" | "top", act: PropAction | null, t: number, art: ArtStyle, state?: string): Prim[] {
  const prop: SceneProp = { propId: "rosso", kind: "car", x: 0.5, y: 0.72, scale: 0.8, rot: 0, castId: "c2", ...(state ? { state } : {}) };
  const beats: Beat[] = act ? [{ at: 0.2, dur: 1.6, who: "rosso", do: act, dir: "right", ...(MOVERS.has(act) ? { to: { x: 0.62, y: 0.7 } } : {}), face: "surprised" }] : [];
  const d: CarDraw = { car, style: "bouncy", seed: 11 };
  return inFrame({ width: 1080, height: 1920, art }, () => {
    const st = propState(prop, beats, view, t, { braking: 0, steer: 0, rolled: t * 300 }, d);
    if (!act) st.face = "surprised";
    const pen = new Pen();
    drawProp(pen, st, view, t, 3, {}, art === "night_drive", d);
    return pen.out;
  });
}

function endView(car: CarLook, view: "front" | "back", sideK: number, lights: boolean, art: ArtStyle = "night_drive"): Prim[] {
  return inFrame({ width: 1080, height: 1920, art }, () => {
    F.light = NIGHT;
    const o: CarViewOpts = { x: 540, y: 1200, w: 300, side: sideK, light: NIGHT, braking: lights ? 1 : 0, lights, blink: 0, face: car.face.eyes === "none" ? null : "happy", t: 0.5, seed: 3 };
    const pen = new Pen();
    drawCarView(pen, car, view, o);
    return pen.out;
  });
}

function numbers(p: Prim): number[] {
  const out: number[] = [];
  for (const v of Object.values(p)) {
    if (typeof v === "number") out.push(v);
    else if (Array.isArray(v)) for (const e of v.flat()) if (typeof e === "number") out.push(e);
  }
  return out;
}

const colourOf = (p: Prim): string | undefined => ("color" in p ? p.color : undefined);
const withColour = (ps: Prim[], c: string, kind?: Prim["k"]): Prim[] => ps.filter((p) => colourOf(p)?.toLowerCase() === c && (kind === undefined || p.k === kind));

/** The box of a polygon's points. */
function box(p: Prim): { x0: number; x1: number; y0: number; y1: number } {
  if (p.k !== "poly" && p.k !== "line") throw new Error("not a polygon");
  const xs = p.pts.filter((_, i) => i % 2 === 0), ys = p.pts.filter((_, i) => i % 2 === 1);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/** The car's body outline in Bright: the biggest polygon painted in the look's outline colour. */
function outline(look: CarLook): { w: number; h: number; y0: number } {
  const ps = withColour(side(look, "side", null, 0.5, "classic"), look.outline.toLowerCase(), "poly");
  expect(ps.length, "the outline polygon").toBeGreaterThan(0);
  let best = box(ps[0]!);
  for (const p of ps) {
    const b = box(p);
    if ((b.x1 - b.x0) * (b.y1 - b.y0) > (best.x1 - best.x0) * (best.y1 - best.y0)) best = b;
  }
  return { w: best.x1 - best.x0, h: best.y1 - best.y0, y0: best.y0 };
}

describe("the reference looks pass the engine's own checks", () => {
  for (const name of NAMES) {
    it(`${name} is valid, small, and made of added fields only`, () => {
      const errs: string[] = [];
      checkCarLook(REFS[name], name, (m) => errs.push(m));
      checkCarDetail(REFS[name].detail, name, (m) => errs.push(m));
      expect(errs).toEqual([]);
      expect(JSON.stringify(REFS[name].detail).length).toBeLessThanOrEqual(2400);
      expect(REFS[name].detail?.v).toBe(1);
    });
  }
});

describe("they draw in every view, style, action and face with no NaN", () => {
  for (const name of NAMES) {
    for (const face of [false, true]) {
      it(`${name}${face ? " with a face" : ""}: side and top, both styles, all ${ACTIONS.length} actions; front and back`, () => {
        const look = face ? withFace(REFS[name]) : REFS[name];
        let drawn = 0;
        for (const art of STYLES) {
          for (const view of ["side", "top"] as const) {
            for (const act of ACTIONS) {
              for (const t of [0.3, 1.1]) {
                const ps = side(look, view, act, t, art);
                expect(ps.length, `${art} ${view} ${act}`).toBeGreaterThan(8);
                for (const p of ps) for (const n of numbers(p)) if (!Number.isFinite(n)) throw new Error(`${name} ${art} ${view} ${act} t=${t}: a prim has ${n}`);
                drawn += 1;
              }
            }
          }
        }
        for (const view of ["front", "back"] as const) {
          for (const sideK of [0, 0.8, -0.8]) {
            for (const lights of [false, true]) {
              const ps = endView(look, view, sideK, lights);
              expect(ps.length, `${view}`).toBeGreaterThan(5);
              for (const p of ps) for (const n of numbers(p)) expect(Number.isFinite(n), `${name} ${view} ${sideK}`).toBe(true);
              drawn += 1;
            }
          }
        }
        expect(drawn).toBeGreaterThan(100);
      });
    }
  }
});

describe("they stay inside their shape budgets", () => {
  for (const name of NAMES) {
    it(`${name}: carShapes - 8 <= its busiest frame <= carShapes, and the end views fit carViewShapes`, () => {
      const look = REFS[name];
      for (const art of STYLES) {
        let busiest = 0;
        for (const view of ["side", "top"] as const) {
          for (const act of ACTIONS) for (const t of [0.45, 1.2]) busiest = Math.max(busiest, side(look, view, act, t, art).length);
          for (const state of ["flat lights brakes", "lights", "flat"]) busiest = Math.max(busiest, side(look, view, null, 0.5, art, state).length);
        }
        const price = carShapes(look, art);
        expect(busiest, `${name} ${art}`).toBeLessThanOrEqual(price);
        expect(busiest, `${name} ${art} is priced close to what it draws`).toBeGreaterThanOrEqual(price - 8);
      }
      let views = 0;
      for (const view of ["front", "back"] as const) for (const sideK of [0, 0.8, -0.8]) for (const lights of [false, true]) views = Math.max(views, endView(look, view, sideK, lights).length);
      expect(views).toBeLessThanOrEqual(carViewShapes(look));
    });
  }
});

describe("the owner's two-seater shows what the photos show", () => {
  const spider = REFS.spider;
  const closed: CarLook = { ...spider, detail: { ...spider.detail!, roof: { type: "closed" } } };

  it("its outline is as long and as low as the numbers say (lh 379 means 3.79 : 1), and the other two as theirs", () => {
    for (const [name, lh, wh] of [["spider", 379, 162], ["suv", 245, 98], ["poppy", 227, 105]] as const) {
      void wh; // `wh` is the width : height ratio of the top view; the side outline is checked against `lh` only
      const o = outline(REFS[name]);
      const want = lh / 100; // `lh` is length / height x 100
      expect(o.w / o.h, name).toBeGreaterThan(want * 0.88);
      expect(o.w / o.h, name).toBeLessThan(want * 1.12);
    }
    // the two-seater is the longest and lowest of the three
    const [a, b, c] = NAMES.map((n) => outline(REFS[n]));
    expect(a!.w / a!.h).toBeGreaterThan(b!.w / b!.h);
    expect(a!.w / a!.h).toBeGreaterThan(c!.w / c!.h);
  });

  it("the top is open: no roof, so the highest paint is lower than the same car closed, and the glass is only the screen", () => {
    for (const art of STYLES) {
      const open = side(spider, "side", null, 0.5, art);
      const shut = side(closed, "side", null, 0.5, art);
      const top = (ps: Prim[]): number => Math.min(...withColour(ps, spider.paint.toLowerCase(), "poly").map((p) => box(p).y0));
      expect(top(open), art).toBeGreaterThan(top(shut));
      const glass = art === "classic" ? "#425460" : "#1f3845";
      expect(withColour(open, glass, "poly").length, `${art}: only the screen wedge is glass`).toBeLessThanOrEqual(1);
    }
  });

  it("the black centre stripe is there in the side and the top view, in both styles", () => {
    for (const art of STYLES) {
      for (const view of ["side", "top"] as const) {
        const ps = side(spider, view, null, 0.5, art);
        expect(withColour(ps, "#111111").length, `${art} ${view}`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("the stripe is gone when the pattern is plain and the detail stripe says none", () => {
    const plain: CarLook = { ...spider, pattern: "plain", detail: { ...spider.detail!, stripe: { layout: "none" } } };
    const n = (l: CarLook): number => withColour(side(l, "side", null, 0.5, "classic"), "#111111").length;
    expect(n(plain)).toBeLessThan(n(spider));
  });

  it("two wheels are drawn in the side view and four in the top view, with five-spoke black rims", () => {
    const ps = side(spider, "side", null, 0.5, "classic");
    expect(withColour(ps, "#2b2b36", "circle").length, "tyres in the side view").toBe(2);
    expect(withColour(ps, "#1a1a1a", "circle").length, "rim discs").toBe(2);
    expect(withColour(ps, "#1a1a1a", "poly").length, "spoke shapes").toBe(2);
    const top = side(spider, "top", null, 0.5, "classic");
    expect(withColour(top, "#2b2b36", "rect").length, "tyres in the top view").toBe(4);
  });

  it("the yellow calipers are exactly two prims in the side view, and none of them turns with the wheel", () => {
    for (const art of STYLES) {
      const at = (t: number): Prim[] => withColour(side(spider, "side", "spin", t, art), "#ffd21f", "poly");
      const a = at(0.3), b = at(0.9);
      expect(a.length, art).toBe(2);
      expect(b.length, art).toBe(2);
      // a brake caliper does not spin: it keeps its place while the wheel turns
      for (let i = 0; i < 2; i += 1) {
        const p = a[i], q = b[i];
        if (p?.k !== "poly" || q?.k !== "poly") throw new Error("a caliper is a polygon");
        const bp = box(p), bq = box(q);
        expect(Math.abs(bp.x1 - bp.x0 - (bq.x1 - bq.x0)), `${art} width`).toBeLessThanOrEqual(0.5 + 1e-6); // one 0.5 rounding step of the pen at most; a spinning caliper moves by many units
        expect(Math.abs(bp.y1 - bp.y0 - (bq.y1 - bq.y0)), `${art} height`).toBeLessThanOrEqual(0.5 + 1e-6);
      }
    }
  });

  it("the other two have the calipers their parts name, and the hatchback has none", () => {
    expect(withColour(side(REFS.suv, "side", null, 0.5, "classic"), "#c8102e", "poly").length).toBe(2);
    expect(withColour(side(REFS.poppy, "side", null, 0.5, "classic"), "#ffd21f", "poly").length).toBe(0);
  });

  it("the front and back views have lamps and are not the plain look's drawing", () => {
    for (const view of ["front", "back"] as const) {
      const ps = endView(spider, view, 0, true);
      expect(ps.some((p) => p.k === "glow" || p.k === "circle" || p.k === "ellipse" || p.k === "poly"), `${view} lamps`).toBe(true);
      expect(JSON.stringify(ps), view).not.toBe(JSON.stringify(endView(stripped(spider), view, 0, true)));
    }
  });
});

describe("they do not look like the old default", () => {
  it("each detailed look draws different shapes than the same look without detail", () => {
    for (const name of NAMES) {
      const a = JSON.stringify(side(REFS[name], "side", null, 0.5, "classic"));
      const b = JSON.stringify(side(stripped(REFS[name]), "side", null, 0.5, "classic"));
      expect(a, name).not.toBe(b);
    }
  });

  it("the two-seater's outline is longer and lower than the default look's", () => {
    const def = outline(DEFAULT_CAR);
    const o = outline(REFS.spider);
    expect(o.w / o.h).toBeGreaterThan((def.w / def.h) * 1.1);
  });

  it("a look without detail has the old price", () => {
    for (const name of NAMES) {
      expect(carShapes(stripped(REFS[name]), "classic")).toBe(56);
      expect(carShapes(stripped(REFS[name]), "night_drive")).toBe(72);
      expect(carViewShapes(stripped(REFS[name]))).toBe(34);
    }
  });
});
