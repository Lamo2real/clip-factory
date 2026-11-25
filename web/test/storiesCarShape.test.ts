// Clips Funded: the detailed vehicle's shape (CONTRACTS §45.48 section 2): fitProfile, the box, the outline, the seats,
// the plan and the end views, for the nine presets, the owner's open two-seater and 2,000 random in-range profiles.
import { describe, expect, it } from "vitest";
import { carSpec } from "../src/stories/engine/car.ts";
import { PRESET } from "../src/stories/engine/carDetail.ts";
import { endShape, fitProfile, isOpen, lampAt, MAX_HL, profileOf, roundPath, sideShape, sizeOf, topShape2 } from "../src/stories/engine/carShape.ts";
import { prng } from "../src/stories/engine/math.ts";
import type { CarBody, CarLook, CarProfile } from "../src/stories/engine/types.ts";

const WHEELED: CarBody[] = ["hatchback", "sedan", "estate", "suv", "pickup", "van", "sports", "compact", "bus"];

function look(body: CarBody, detail: CarLook["detail"] = { v: 1 }): CarLook {
  return {
    body, length: 1, height: 1, paint: "#8a8f98", accent: "#1c1d20", pattern: "plain", windows: "clear",
    wheels: { style: "alloy", rim: "#c9ccd2", size: 1 }, lights: { front: "round", rear: "round" }, extra: "none",
    face: { eyes: "none", color: "#1c1842", mouth: "none" }, outline: "#17181b", detail,
  } as CarLook;
}

const OWNER: CarProfile = { body: "sports", lh: 379, wh: 162, tipH: 30, noseX: 3, noseH: 42, noseR: 20, chinH: 9, cowlX: 33, cowlH: 71, bonnet: 55, headX: 46, headH: 100, peakX: 50, roofX: 62, roofH: 97, deckX: 80, deckH: 84, tailX: 97, tailH: 81, rumpH: 15, sillH: 10, axF: 23, axR: 81, wheelD: 57, archGap: 9, beltH: 72, beltRise: 2, soft: 55, pillarX: 60, glassX: 62, panes: 1, roofW: 62, taperF: 22, taperR: 8 };

const RANGES: Record<string, [number, number]> = {
  lh: [150, 520], wh: [60, 220], tipH: [10, 85], noseX: [0, 14], noseH: [15, 92], noseR: [0, 100], chinH: [3, 40], cowlX: [1, 55], cowlH: [30, 90], bonnet: [0, 100],
  headX: [4, 72], headH: [40, 100], peakX: [4, 100], roofX: [12, 100], roofH: [40, 100], deckX: [20, 100], deckH: [20, 98], tailX: [86, 100], tailH: [15, 98],
  rumpH: [3, 45], sillH: [4, 40], axF: [8, 40], axR: [55, 94], wheelD: [20, 72], archGap: [0, 45], beltH: [30, 88], beltRise: [-10, 20], soft: [0, 100],
  pillarX: [10, 96], glassX: [20, 99], panes: [1, 5], roofW: [40, 100], taperF: [0, 40], taperR: [0, 40],
};

function randomProfile(r: () => number, body: CarBody): CarProfile {
  const p: Record<string, number | string> = { body };
  for (const [k, [lo, hi]] of Object.entries(RANGES)) p[k] = lo + Math.floor(r() * (hi - lo + 1));
  return p as unknown as CarProfile;
}

function area(poly: number[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i += 2) {
    const j = (i + 2) % poly.length;
    a += poly[i]! * poly[j + 1]! - poly[j]! * poly[i + 1]!;
  }
  return a / 2;
}

function finite(xs: number[]): boolean {
  return xs.every((v) => Number.isFinite(v));
}

function bbox(poly: number[]): { w: number; h: number; x0: number; x1: number; y0: number; y1: number } {
  const xs = poly.filter((_, i) => i % 2 === 0);
  const ys = poly.filter((_, i) => i % 2 === 1);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return { w: x1 - x0, h: y1 - y0, x0, x1, y0, y1 };
}

describe("fitProfile", () => {
  it("orders the stations and heights of any in-range profile", () => {
    const r = prng(7);
    for (let n = 0; n < 500; n += 1) {
      for (const open of [false, true]) {
        const q = fitProfile(randomProfile(r, "sedan"), open);
        expect(q.axF).toBeLessThan(q.axR);
        expect(q.noseX).toBeLessThan(q.cowlX);
        expect(q.cowlX).toBeLessThan(q.headX);
        expect(q.headX).toBeLessThanOrEqual(q.peakX);
        expect(q.peakX).toBeLessThanOrEqual(q.roofX);
        expect(q.roofX).toBeLessThanOrEqual(q.deckX);
        expect(q.deckX).toBeLessThanOrEqual(q.tailX);
        expect(q.tipH).toBeGreaterThan(q.chinH);
        expect(q.cowlH).toBeLessThan(q.headH);
        expect(q.beltH).toBeLessThan(q.headH);
        expect(Number.isInteger(q.panes)).toBe(true);
      }
    }
  });

  it("leaves a profile that is already in order alone", () => {
    for (const b of WHEELED) {
      const p = PRESET[b]!;
      expect(fitProfile(p, false)).toEqual(p);
    }
  });
});

describe("the nine presets", () => {
  it("all exist, are in range and measured as their own body", () => {
    for (const b of WHEELED) {
      const p = PRESET[b]!;
      expect(p.body).toBe(b);
      for (const [k, [lo, hi]] of Object.entries(RANGES)) {
        const v = (p as unknown as Record<string, number>)[k]!;
        expect(v, `${b}.${k}`).toBeGreaterThanOrEqual(lo);
        expect(v, `${b}.${k}`).toBeLessThanOrEqual(hi);
      }
      expect(profileOf(look(b))).toEqual(profileOf(look(b)));
    }
  });

  it("read as their shapes: an SUV is tall and boxy, a sports car low and wedged, a pickup has a bed", () => {
    const suv = sideShape(look("suv"));
    const sports = sideShape(look("sports"));
    expect(suv.tall / suv.len).toBeGreaterThan(sports.tall / sports.len);
    expect(sports.p.noseH).toBeLessThan(suv.p.noseH);
    const pick = sideShape(look("pickup"));
    expect(pick.panes.length).toBe(1);
    expect(pick.p.deckH).toBeLessThan(pick.p.roofH - 20);
    const bus = sideShape(look("bus"));
    expect(bus.panes.length).toBe(5);
  });

  it("every preset's outline fills at least 35% of its box", () => {
    for (const b of WHEELED) {
      const g = sideShape(look(b));
      const bb = bbox(g.sil);
      expect(Math.abs(area(g.sil)) / (bb.w * bb.h), b).toBeGreaterThanOrEqual(0.35);
    }
  });

  it("every preset has the classic Side fields, two seats and stays in the editor's box", () => {
    for (const b of WHEELED) {
      const g = sideShape(look(b));
      expect(g.hl).toBeLessThanOrEqual(MAX_HL);
      expect(g.hl).toBeGreaterThan(150);
      expect(finite(g.sil)).toBe(true);
      expect(Math.abs(area(g.sil))).toBeGreaterThan(0);
      for (const k of ["hl", "sill", "lowH", "cabH", "wr", "ax", "tall", "frontLeft", "frontRight"] as const) expect(Number.isFinite(g[k]), `${b}.${k}`).toBe(true);
      expect(typeof g.y).toBe("function");
      expect(typeof g.X).toBe("function");
      expect(g.spec).toBe(carSpec(b));
      expect(g.front.length).toBeGreaterThan(5);
      expect(g.frontRight).toBeGreaterThan(g.frontLeft);
      expect(g.seats).toHaveLength(2);
      for (const s of g.seats) {
        expect(s.topY).toBeLessThan(s.beltY - 40);
        expect(Math.abs(s.x)).toBeLessThan(g.hl);
      }
      expect(g.ax).toBeGreaterThan(g.axRear);
      expect(g.wells).toHaveLength(2);
      expect(g.arch).toHaveLength(2);
    }
  });
});

describe("sizes", () => {
  it("keeps a detailed vehicle within a fifth longer and a sixth lower than its classic body", () => {
    for (const b of WHEELED) {
      const B = carSpec(b);
      const len0 = 584 * B.len;
      const tall0 = 266 * B.hgt + 32.4 + B.lift;
      const s = sizeOf(look(b));
      expect(s.len).toBeLessThanOrEqual(len0 * 1.21);
      expect(s.tall).toBeGreaterThanOrEqual(tall0 * 0.82);
      expect(s.hl).toBeLessThanOrEqual(MAX_HL);
    }
  });

  it("measures the owner's open two-seater as 727 x 214 with 65 radius wheels", () => {
    const car = look("sports", { v: 1, toon: 30, profile: OWNER, roof: { type: "open", hoops: "twin" } });
    const s = sizeOf(car);
    expect(Math.round(s.len)).toBe(727);
    expect(Math.round(s.tall)).toBe(214);
    expect(Math.round(s.wrF)).toBe(65);
  });

  it("the sliders multiply and toon 0 is more real than toon 100", () => {
    const base = sizeOf(look("sedan"));
    expect(sizeOf({ ...look("sedan"), length: 1.15 }).len).toBeGreaterThan(base.len);
    expect(sizeOf({ ...look("sedan"), height: 0.85 }).tall).toBeLessThan(base.tall);
    expect(sizeOf(look("sedan", { v: 1, toon: 0 })).len / sizeOf(look("sedan", { v: 1, toon: 0 })).tall).toBeGreaterThan(sizeOf(look("sedan", { v: 1, toon: 100 })).len / sizeOf(look("sedan", { v: 1, toon: 100 })).tall);
  });

  it("a different rear wheel size makes a different rear radius", () => {
    const s = sizeOf(look("sports", { v: 1, wheels: { rearD: 70 } }));
    expect(s.wrR).toBeGreaterThan(s.wrF);
  });
});

describe("the owner's open mid-engine two-seater: anchors", () => {
  const car = look("sports", { v: 1, toon: 30, profile: OWNER, roof: { type: "open", hoops: "twin" }, cabin: { rows: 1 } });
  const g = sideShape(car);
  const pct = (x: number) => ((g.hl - x) / g.len) * 100;
  const hp = (yy: number) => (-yy / g.tall) * 100;

  it("is open and its landmarks land where the numbers say", () => {
    expect(g.open).toBe(true);
    expect(isOpen(car)).toBe(true);
    expect(pct(g.pts.tip![0])).toBeCloseTo(0, 5);
    expect(hp(g.pts.tip![1])).toBeCloseTo(30, 5);
    expect(pct(g.pts.cowl![0])).toBeCloseTo(33, 5);
    expect(hp(g.pts.cowl![1])).toBeCloseTo(71, 5);
    expect(pct(g.pts.head![0])).toBeCloseTo(46, 5);
    expect(hp(g.pts.head![1])).toBeCloseTo(100, 5);
    expect(pct(g.pts.deck![0])).toBeCloseTo(80, 5);
    expect(pct(g.pts.tail![0])).toBeCloseTo(97, 5);
    expect(pct(g.ax)).toBeCloseTo(23, 5);
    expect(pct(g.axRear)).toBeCloseTo(81, 5);
    expect((g.wr * 2 / g.tall) * 100).toBeGreaterThan(55);
  });

  it("has the deck higher than the bonnet and no roof over the seats", () => {
    expect(hp(g.pts.deck![1])).toBeGreaterThan(hp(g.pts.nose![1]) + 30);
    const topOfOutline = Math.min(...g.sil.filter((_, i) => i % 2 === 1));
    // the highest point of the outline is the hoops (97%), under the windscreen top (100%)
    expect(hp(topOfOutline)).toBeLessThan(98);
    expect(g.frame).not.toBeNull();
    expect(g.panes).toHaveLength(1);
  });

  it("seats the two riders in the open", () => {
    expect(g.seats).toHaveLength(2);
    for (const s of g.seats) expect(s.beltY - s.topY).toBeGreaterThanOrEqual(46);
  });

  it("the top view is open: a windscreen and no rear glass", () => {
    const t = topShape2(car);
    expect(t.open).toBe(true);
    expect(t.rearGlass).toBeNull();
    expect(t.seats[0]!.x).toBeLessThan(0);
    expect(t.seats[1]!.x).toBeGreaterThan(0);
  });

  it("the end views are lower and wider than a hatchback's", () => {
    const e = endShape(car, "front", 382);
    const h = endShape(look("hatchback"), "front", 382);
    expect(e.H / e.W).toBeLessThan(h.H / h.W);
  });
});

describe("the fuzz: 2,000 random in-range profiles x 9 bodies x open and closed", () => {
  it("is always drawable", () => {
    const r = prng(2024);
    let n = 0;
    for (let i = 0; i < 2000; i += 1) {
      const body = WHEELED[i % WHEELED.length]!;
      const open = i % 2 === 0;
      const rows = (i >> 1) % 2 === 0 ? 2 : 1;
      const car = look(body, { v: 1, profile: randomProfile(r, body), roof: { type: open ? "open" : "closed", hoops: i % 3 === 0 ? "twin" : "none" }, cabin: { rows }, arches: i % 5 === 0 ? "square" : "round" });
      const g = sideShape(car);
      n += 1;
      const ok = (cond: boolean, what: string) => { if (!cond) throw new Error(`${what} (case ${i}, ${body}, ${open ? "open" : "closed"}: ${JSON.stringify(car.detail!.profile)})`); };
      ok(finite(g.sil) && finite(g.mask) && g.panes.every(finite) && g.wells.every(finite), "NaN in the side shapes");
      const a = area(g.sil);
      const bb = bbox(g.sil);
      ok(Math.abs(a) > 0, "outline has no area");
      ok(Math.abs(a) >= 0.12 * bb.w * bb.h, `outline area ${(Math.abs(a) / (bb.w * bb.h)).toFixed(2)} of its box`);
      ok(g.seats.length === 2, "two seats");
      for (const s of g.seats) {
        ok(s.topY < s.beltY - 40, "seat too short");
        ok(Math.abs(s.x) < g.hl, "seat outside the length");
      }
      ok(g.hl <= MAX_HL, "longer than the editor's box");
      ok(bb.x1 <= g.hl + 20 && bb.x0 >= -g.hl - 20, `outline outside the length x ${bb.x0.toFixed(0)}..${bb.x1.toFixed(0)} hl ${g.hl.toFixed(0)}`);
      for (const pn of g.panes) {
        const pb = bbox(pn);
        ok(pb.x0 >= -g.hl - 12 && pb.x1 <= g.hl + 12 && pb.y0 >= -g.tall - 12 && pb.y1 <= 12, "pane outside the vehicle's box");
      }
      ok(g.panes.length >= 1, "no glass");
      const t = topShape2(car);
      ok(finite(t.outline) && area(t.outline) !== 0, "top outline");
      const e = endShape(car, i % 2 === 0 ? "front" : "back", 382);
      ok(finite(e.outline) && finite(e.glass) && Math.abs(area(e.outline)) > 0, "end outline");
      const lf = lampAt(g, "front");
      const lr = lampAt(g, "rear");
      ok(finite(lf) && finite(lr), "lamp centres");
    }
    expect(n).toBe(2000);
  });
});

describe("lampAt", () => {
  it("puts the front lamp at the nose and the rear lamp at the tail, for every lamp shape", () => {
    for (const shape of ["round", "square", "slim", "swept", "rect", "angled"]) {
      const g = sideShape(look("sedan", { v: 1, lights: { front: { shape: shape as never }, rear: { shape: "tall" } } }));
      const f = lampAt(g, "front");
      expect(f[0]).toBeGreaterThan(g.hl * 0.6);
      expect(f[0]).toBeLessThanOrEqual(g.hl);
      const r = lampAt(g, "rear");
      expect(r[0]).toBeLessThan(-g.hl * 0.9);
    }
  });

  it("follows the lamp's own height", () => {
    const lo = lampAt(sideShape(look("sedan", { v: 1, lights: { front: { shape: "round", h: 30 } } })), "front");
    const hi = lampAt(sideShape(look("sedan", { v: 1, lights: { front: { shape: "round", h: 60 } } })), "front");
    expect(hi[1]).toBeLessThan(lo[1]);
  });
});

describe("the plan and the end views", () => {
  it("the plan is inside a box a little wider than today's and has four wheels at the real axles", () => {
    for (const b of WHEELED) {
      const t = topShape2(look(b));
      const bb = bbox(t.outline);
      expect(bb.w).toBeLessThanOrEqual(196 * carSpec(b).wide * 1.15);
      expect(t.wheels).toHaveLength(4);
      const fronts = t.wheels.filter((w) => w.front);
      expect(fronts[0]!.y).toBeLessThan(t.wheels.find((w) => !w.front)!.y);
      expect(t.wsBase).toBeLessThan(t.wsTop);
      expect(t.L).toBeGreaterThan(100);
    }
  });

  it("the back view of a low wide car is lower and wider than a van's", () => {
    const a = endShape(look("sports"), "back", 382);
    const v = endShape(look("van"), "back", 382);
    expect(a.H / a.W).toBeLessThan(v.H / v.W);
  });
});

describe("motorbikes, planes and boats", () => {
  it("keep today's shape under the detailed drawer", () => {
    for (const b of ["motorbike", "plane", "boat"] as CarBody[]) {
      const g = sideShape(look(b));
      expect(g.hl).toBeGreaterThan(100);
      expect(g.seats).toHaveLength(2);
      expect(finite(g.sil)).toBe(true);
      const t = topShape2(look(b));
      expect(t.L).toBeGreaterThan(100);
      expect(endShape(look(b), "front", 382).w).toBe(382);
    }
  });
});

describe("roundPath", () => {
  it("rounds each corner by its own radius and keeps sharp ones sharp", () => {
    const sharp = roundPath([{ x: 0, y: 0, r: 0 }, { x: 10, y: 0, r: 0 }, { x: 10, y: 10, r: 0 }, { x: 0, y: 10, r: 0 }]);
    expect(sharp).toEqual([0, 0, 10, 0, 10, 10, 0, 10]);
    const round = roundPath([{ x: 0, y: 0, r: 4 }, { x: 40, y: 0, r: 0 }, { x: 40, y: 40, r: 0 }, { x: 0, y: 40, r: 0 }]);
    expect(round.length).toBeGreaterThan(8);
    expect(Math.min(...round.filter((_, i) => i % 2 === 0))).toBeGreaterThanOrEqual(0);
  });
});
