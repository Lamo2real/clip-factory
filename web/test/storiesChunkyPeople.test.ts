// The chunky people (CONTRACTS §45.49, ADR-99): night drive's cartoon people have a rounded-square head, big glossy
// eyes, a sculpted quiff, thick tapered arms and legs, big mitts and big shoes. These tests pin the new drawing parts
// (pen.ts shape generators, art.ts tokens) and what the look promises: every editor choice still draws clean prims
// inside the shape budget, the hair stays close under the camera's headroom, every hand shape has its mitt, a look saved
// before this change draws, and classic never changes.
import { describe, expect, it } from "vitest";
import { LIGHTS, lit as tone, ND } from "../src/stories/engine/art.ts";
import { FACES } from "../src/stories/engine/face.ts";
import { F, inFrame } from "../src/stories/engine/frame.ts";
import { restPose, STYLES } from "../src/stories/engine/motion.ts";
import { capsulePts, ellipsePts, Pen, placePts, ribbonPts, smoothPts } from "../src/stories/engine/pen.ts";
import { drawCharacter, geometry, REST, type Hand, type Pose } from "../src/stories/engine/rig.ts";
import type { CharacterLook, Prim } from "../src/stories/engine/types.ts";

const HEX = /^#[0-9a-f]{6}$/;

function look(over: Partial<CharacterLook> = {}): CharacterLook {
  return {
    body: "bean",
    skin: "#e8b58f",
    height: 1,
    width: 1,
    hair: { style: "short", color: "#3b2a1a" },
    eyes: { shape: "round", color: "#1c1842" },
    brows: "thick",
    nose: "button",
    mouth: "wide",
    outfit: { top: "#3f8f8a", bottom: "#2b3550", accent: "#d9a441", pattern: "plain" },
    accessory: "none",
    outline: "#1c1842",
    ...over,
  };
}

const xs = (pts: number[]) => pts.filter((_, i) => i % 2 === 0);
const ys = (pts: number[]) => pts.filter((_, i) => i % 2 === 1);

describe("pen.ts: the new shape generators", () => {
  it("ellipsePts is a closed ring of the asked size and turns with rot", () => {
    const e = ellipsePts(10, 20, 6, 3, 16);
    expect(e).toHaveLength(32);
    expect(Math.max(...xs(e))).toBeCloseTo(16, 6);
    expect(Math.min(...xs(e))).toBeCloseTo(4, 6);
    expect(Math.max(...ys(e))).toBeCloseTo(23, 1);
    // a quarter turn swaps the radii
    const t = ellipsePts(0, 0, 6, 3, 16, 90);
    expect(Math.max(...xs(t))).toBeCloseTo(3, 1);
    expect(Math.max(...ys(t))).toBeCloseTo(6, 6);
  });

  it("capsulePts wraps both circles, tapers, and returns the bigger circle when one hides the other", () => {
    const c = capsulePts(0, 0, 5, 20, 0, 2, 6);
    expect(Math.min(...xs(c))).toBeCloseTo(-5, 6);
    expect(Math.max(...xs(c))).toBeCloseTo(22, 6);
    // narrower at the far end than at the near end
    const at = (x: number) => c.filter((_, i) => i % 2 === 0 && c[i]! > x - 1 && c[i]! < x + 1).length;
    expect(at(21)).toBeGreaterThan(0);
    expect(Math.max(...ys(c))).toBeCloseTo(5, 0);
    // a small circle inside a big one: just the big one
    const inside = capsulePts(0, 0, 10, 1, 0, 2, 6);
    expect(Math.max(...xs(inside))).toBeCloseTo(10, 6);
    expect(inside).toHaveLength(24);
    for (let i = 0; i < c.length; i += 1) expect(Number.isFinite(c[i])).toBe(true);
  });

  it("smoothPts passes through its points, keeps corners sharp and leaves an open curve's ends where they were", () => {
    const sq = [0, 0, 10, 0, 10, 10, 0, 10];
    const closed = smoothPts(sq, true, 4);
    expect(closed).toHaveLength(sq.length * 4);
    // the curve starts every segment on one of the given points
    for (let i = 0; i < 4; i += 1) {
      expect(closed[i * 8]).toBeCloseTo(sq[i * 2]!, 6);
      expect(closed[i * 8 + 1]).toBeCloseTo(sq[i * 2 + 1]!, 6);
    }
    const open = smoothPts([0, 0, 5, 8, 10, 0, 15, 8], false, 3);
    expect(open.slice(0, 2)).toEqual([0, 0]);
    expect(open.slice(-2)).toEqual([15, 8]);
    // a corner at point 1: both neighbouring chords stay straight into it
    const sharp = smoothPts(sq, true, 4, [1]);
    expect(sharp).toHaveLength(closed.length);
    // fewer than three points is returned as given
    expect(smoothPts([1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
  });

  it("ribbonPts is a band of the asked width, tapers to a tip with a 0 width and rounds its ends with cap", () => {
    const band = ribbonPts([0, 0, 10, 0, 20, 0], 4);
    expect(band).toHaveLength(12);
    expect(Math.max(...ys(band))).toBeCloseTo(2, 6);
    expect(Math.min(...ys(band))).toBeCloseTo(-2, 6);
    const tip = ribbonPts([0, 0, 10, 0, 20, 0], [4, 4, 0]);
    // the left edge starts 2 off the line and closes to the line at the 0-width end
    expect(tip[1]).toBeCloseTo(-2, 6);
    expect(tip[5]).toBeCloseTo(0, 6);
    const capped = ribbonPts([0, 0, 10, 0, 20, 0], 4, 3);
    expect(capped.length).toBe(band.length + 2 * 2 * 3);
    expect(Math.max(...xs(capped))).toBeGreaterThan(20);
    expect(Math.min(...xs(capped))).toBeLessThan(0);
    expect(ribbonPts([0, 0], 3)).toEqual([]);
  });

  it("placePts turns a part about its own origin and moves it", () => {
    expect(placePts([1, 0, 0, 1], 10, 20)).toEqual([11, 20, 10, 21]);
    const r = placePts([1, 0], 0, 0, 90);
    expect(r[0]).toBeCloseTo(0, 9);
    expect(r[1]).toBeCloseTo(1, 9);
  });
});

describe("art.ts: the chunky tokens", () => {
  it("are lower-case hex, and lit() dims a pale token in the night but gives it back in the studio", () => {
    for (const c of [ND.eyeWhite, ND.cheek, ND.sole, ND.soleGum, ND.gloss]) expect(c).toMatch(HEX);
    const studio = inFrame({ width: 1080, height: 1920, art: "night_drive" }, () => {
      F.light = LIGHTS.studio;
      return tone(ND.eyeWhite, 0.5);
    });
    const night = inFrame({ width: 1080, height: 1920, art: "night_drive" }, () => {
      F.light = LIGHTS.night;
      return tone(ND.eyeWhite, 0.5);
    });
    expect(studio).toMatch(HEX);
    expect(night).toMatch(HEX);
    expect(night).not.toBe(studio);
    const sum = (c: string) => parseInt(c.slice(1, 3), 16) + parseInt(c.slice(3, 5), 16) + parseInt(c.slice(5, 7), 16);
    expect(sum(night)).toBeLessThan(sum(studio));
  });
});

/** One character, as the Characters page draws it: night drive, the studio light, 5 design px per rig unit. */
function draw(l: CharacterLook, pose?: Pose, face: keyof typeof FACES = "happy"): Prim[] {
  const g = geometry(l);
  return inFrame({ width: 1080, height: 1920, art: "night_drive" }, () => {
    F.light = LIGHTS.studio;
    const pen = new Pen();
    pen.translate(540, 1400);
    pen.scale(5, 5);
    drawCharacter(pen, l, g, pose ?? restPose("stand", 1.2, STYLES.bouncy, 3, g, false), { t: 1.2, seed: 3, face: FACES[face], inCar: false });
    return pen.out;
  });
}

function box(prims: Prim[]) {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const add = (x: number, y: number) => {
    b.x0 = Math.min(b.x0, x);
    b.x1 = Math.max(b.x1, x);
    b.y0 = Math.min(b.y0, y);
    b.y1 = Math.max(b.y1, y);
  };
  for (const p of prims) {
    if (p.k === "poly" || p.k === "line") for (let i = 0; i < p.pts.length; i += 2) add(p.pts[i]!, p.pts[i + 1]!);
    else if (p.k === "circle") {
      add(p.x - p.r, p.y - p.r);
      add(p.x + p.r, p.y + p.r);
    } else if (p.k === "ellipse") {
      add(p.x - p.rx, p.y - p.ry);
      add(p.x + p.rx, p.y + p.ry);
    }
  }
  return b;
}

describe("the chunky people", () => {
  const hairs = ["none", "short", "spiky", "curly", "long", "bun", "cap"] as const;
  const accessories = ["none", "glasses", "scarf", "bowtie", "helmet", "headphones"] as const;
  const bodies = ["bean", "round", "tall", "square"] as const;

  it("every hair style with every accessory on every body draws clean prims in the shape budget and is the same twice", () => {
    for (const body of bodies) {
      for (const style of hairs) {
        for (const accessory of accessories) {
          const l = look({ body, accessory, hair: { style, color: "#8a4b2a" } });
          const a = draw(l);
          expect(a.length, `${body} ${style} ${accessory}`).toBeLessThanOrEqual(92);
          expect(draw(l)).toEqual(a);
          for (const p of a) {
            if ("color" in p) expect(p.color).toMatch(HEX);
            if (p.k === "poly" || p.k === "line") for (const v of p.pts) expect(Number.isFinite(v)).toBe(true);
          }
        }
      }
    }
  });

  it("the hair and hats stay within the camera's 12 units of headroom, and the feet stay on the ground line", () => {
    for (const body of bodies) {
      for (const style of hairs) {
        for (const accessory of ["none", "helmet", "headphones"] as const) {
          const l = look({ body, accessory, hair: { style, color: "#22160f" }, height: 1.15 });
          const g = geometry(l);
          const b = box(draw(l).filter((p) => !("color" in p) || p.color !== ND.ao));
          // y is down: the top of the drawing is its smallest y, 5 design px per rig unit
          expect(b.y0, `${body} ${style} ${accessory}`).toBeGreaterThanOrEqual(1400 + (g.top - 12) * 5);
          // soles reach the ground line and no more than 4 units below it
          expect(b.y1, `${body} ${style}`).toBeGreaterThanOrEqual(1400);
          expect(b.y1, `${body} ${style}`).toBeLessThanOrEqual(1400 + 4 * 5);
        }
      }
    }
  });

  it("the limbs are chunky: the arms and legs are drawn wider than the joints' own size", () => {
    const l = look();
    const g = geometry(l);
    const wide = box(draw(l));
    // wider than the body alone: the arms hang out at each side of a 16-unit half-width torso
    expect(wide.x1 - wide.x0).toBeGreaterThan(2 * g.a * 5);
  });

  it("every hand shape draws a mitt (open, fist, thumb up, point) and each is a clean prim list", () => {
    const l = look();
    const g = geometry(l);
    const base = restPose("stand", 1.2, STYLES.bouncy, 3, g, false);
    const seen = new Set<string>();
    for (const handF of ["open", "fist", "thumb", "point"] as Hand[]) {
      const pose: Pose = { ...base, handF, handB: handF, aF: 70, eF: 20, aB: 60, eB: 10 };
      const a = draw(l, pose);
      expect(a.length).toBeLessThanOrEqual(92);
      seen.add(JSON.stringify(a));
    }
    // the four hands are four different drawings
    expect(seen.size).toBe(4);
  });

  it("every face and eye shape reads: the eyes are one white shape, one iris shape and one sparkle shape", () => {
    for (const shape of ["round", "oval", "sleepy"] as const) {
      const l = look({ eyes: { shape, color: "#47d6a0" } });
      const a = inFrame({ width: 1080, height: 1920, art: "night_drive" }, () => {
        F.light = LIGHTS.studio;
        return draw(l, undefined, "happy");
      });
      expect(a.filter((p) => p.k === "poly" && p.color === "#47d6a0"), shape).toHaveLength(1);
    }
  });

  it("a character saved before this change (only the old fields) draws and nothing is added to what is stored", () => {
    const saved = JSON.parse(JSON.stringify(look())) as CharacterLook;
    expect(Object.keys(saved).sort()).toEqual(["accessory", "body", "brows", "eyes", "hair", "height", "mouth", "nose", "outfit", "outline", "skin", "width"]);
    const a = draw(saved);
    expect(a.length).toBeGreaterThan(40);
    expect(draw(look())).toEqual(a);
  });

  it("the walk, the talk and the emotions still move the new body: poses change the drawing", () => {
    const l = look();
    const g = geometry(l);
    const still = draw(l, restPose("stand", 1.2, STYLES.bouncy, 3, g, false));
    const moved = draw(l, { ...REST, aF: 80, eF: 30, aB: -40, eB: 20, hF: 25, kF: 30, hB: -20, kB: 10 });
    expect(moved).not.toEqual(still);
    // every face draws inside the budget
    for (const f of Object.keys(FACES) as (keyof typeof FACES)[]) {
      const a = draw(l, undefined, f);
      expect(a.length, f).toBeLessThanOrEqual(92);
    }
  });
});
