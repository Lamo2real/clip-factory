// Night drive people (docs/design-night-style.md §5, CONTRACTS §45.45): the same characters, drawn with soft thin
// outlines, cel shading, rim light and soft shadows, tiny dot eyes and short thick brows that carry the feeling, in the
// place's light. Classic draws exactly as before (every older story and golden stays the same), each character keeps
// its own geometry, faces and colours (lit, never swapped), and the shots get a bust, hands on the wheel and a foot on
// a pedal in both styles. Also: motion.ts says when the face last changed (faceSince) for the brows' small overshoot.
import { describe, expect, it } from "vitest";
import { grade, ink, inkPx, LIGHTS, ND, withWarm } from "../src/stories/engine/art.ts";
import { FACES, NOISE_MOUTH } from "../src/stories/engine/face.ts";
import { F, inFrame, withArt } from "../src/stories/engine/frame.ts";
import { mix } from "../src/stories/engine/math.ts";
import { actorState, faceSince, restPose, shownExpression, STYLES } from "../src/stories/engine/motion.ts";
import { Pen } from "../src/stories/engine/pen.ts";
import { drawBust, drawCharacter, drawFoot, drawWheelHands, geometry, headTop, REST, type Pose } from "../src/stories/engine/rig.ts";
import type { Beat, CharacterLook, Expression, Prim } from "../src/stories/engine/types.ts";

const HEX = /^#[0-9a-f]{6}$/;

/** Our own test characters (none of them is anyone else's character). */
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

/** Every look choice at least once: bodies, hair styles, accessories, patterns, eyes, brows, noses and mouths. */
function everyLook(): CharacterLook[] {
  const out: CharacterLook[] = [];
  const bodies = ["bean", "round", "tall", "square"] as const;
  const hair = ["none", "short", "spiky", "curly", "long", "bun", "cap"] as const;
  const acc = ["none", "glasses", "scarf", "bowtie", "helmet", "headphones"] as const;
  const pat = ["plain", "stripes", "dots"] as const;
  const eyes = ["round", "oval", "sleepy"] as const;
  const noses = ["dot", "button", "long", "none"] as const;
  for (let i = 0; i < 14; i += 1) {
    out.push(
      look({
        body: bodies[i % 4]!,
        hair: { style: hair[i % 7]!, color: i % 2 ? "#8a4b2a" : "#22160f" },
        accessory: acc[i % 6]!,
        outfit: { top: "#c0503a", bottom: "#3a3a4a", accent: "#f2f2f2", pattern: pat[i % 3]! },
        eyes: { shape: eyes[i % 3]!, color: "#1c1842" },
        brows: i % 2 ? "thin" : "thick",
        nose: noses[i % 4]!,
        mouth: i % 2 ? "small" : "wide",
        width: 0.9 + (i % 3) * 0.1,
        height: 0.9 + (i % 2) * 0.2,
      }),
    );
  }
  return out;
}

/** Every prim is one of the contract's kinds with finite numbers, "#rrggbb" colours and alphas in 0..1. */
function primProblems(prims: Prim[]): string[] {
  const bad: string[] = [];
  prims.forEach((p, i) => {
    const at = `prim ${i} (${p.k})`;
    if ("color" in p && !HEX.test(p.color)) bad.push(`${at}: colour ${p.color}`);
    if ("a" in p && p.a !== undefined && !(p.a >= 0 && p.a <= 1)) bad.push(`${at}: alpha ${p.a}`);
    const nums = Object.entries(p).filter(([k]) => k !== "k" && k !== "color" && k !== "stops");
    for (const [k, v] of nums) {
      const vals = Array.isArray(v) ? v : [v];
      if (vals.some((x) => typeof x !== "number" || !Number.isFinite(x))) bad.push(`${at}: ${k} is not finite`);
    }
    if (p.k === "poly" && p.pts.length < 6) bad.push(`${at}: fewer than 3 points`);
    if (p.k === "line" && (p.pts.length < 4 || p.w <= 0)) bad.push(`${at}: line`);
    if ((p.k === "circle" && p.r <= 0) || (p.k === "ellipse" && (p.rx <= 0 || p.ry <= 0))) bad.push(`${at}: radius`);
  });
  return bad;
}

/** One standing character, 5 design px per rig unit (the side view's size), feet at (540, 1400). */
function standing(l: CharacterLook, face: Expression = "neutral", o: { pose?: Pose; t?: number; faceSince?: number; inCar?: boolean } = {}): Prim[] {
  const g = geometry(l);
  const pen = new Pen();
  pen.translate(540, 1400);
  pen.scale(5, 5);
  const pose = o.pose ?? restPose("stand", o.t ?? 1.2, STYLES.bouncy, 7, g, !!o.inCar);
  drawCharacter(pen, l, g, pose, { t: o.t ?? 1.2, seed: 7, face: FACES[face], inCar: !!o.inCar, ...(o.faceSince !== undefined ? { faceSince: o.faceSince } : {}) });
  return pen.out;
}

/** Runs fn in a style and a light (as scene.ts sets them). */
function lit<T>(art: "night_drive" | "classic", light: keyof typeof LIGHTS, fn: () => T, warm = 0): T {
  return inFrame({ width: 1080, height: 1920, art }, () => {
    F.light = withWarm(LIGHTS[light], warm);
    return fn();
  });
}

const EXPRESSIONS = Object.keys(FACES) as Expression[];

/** The box around a draw list (an ellipse counts its longer radius both ways). */
function bbox(prims: Prim[]): { x0: number; y0: number; x1: number; y1: number } {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const add = (x: number, y: number, r = 0) => {
    b.x0 = Math.min(b.x0, x - r);
    b.x1 = Math.max(b.x1, x + r);
    b.y0 = Math.min(b.y0, y - r);
    b.y1 = Math.max(b.y1, y + r);
  };
  for (const p of prims) {
    if (p.k === "poly" || p.k === "line") for (let i = 0; i < p.pts.length; i += 2) add(p.pts[i]!, p.pts[i + 1]!, p.k === "line" ? p.w / 2 : 0);
    else if (p.k === "circle") add(p.x, p.y, p.r);
    else if (p.k === "ellipse") add(p.x, p.y, Math.max(p.rx, p.ry));
    else if (p.k === "rect") {
      add(p.x, p.y);
      add(p.x + p.w, p.y + p.h);
    }
  }
  return b;
}

describe("classic draws exactly as before", () => {
  it("a classic character is the same with or without a light, a face change time or a style frame around it", () => {
    for (const l of everyLook()) {
      const plain = standing(l, "angry");
      expect(lit("classic", "night", () => standing(l, "angry", { faceSince: 1.15 }), 0.8)).toEqual(plain);
      expect(withArt("classic", () => standing(l, "angry"))).toEqual(plain);
      expect(inFrame({ width: 1080, height: 1920 }, () => standing(l, "angry"))).toEqual(plain);
    }
  });

  it("a classic face keeps its white eyes and irises; night drive's are dots with no white", () => {
    const l = look();
    const classic = standing(l);
    const night = lit("night_drive", "night", () => standing(l));
    expect(classic.some((p) => p.k === "ellipse" && p.color === "#ffffff")).toBe(true);
    expect(night.some((p) => (p.k === "ellipse" || p.k === "circle") && p.color === "#ffffff")).toBe(false);
    const dot = lit("night_drive", "night", () => mix(ND.eye, grade("#1c1842"), 0.55));
    expect(night.filter((p) => p.k === "ellipse" && p.color === dot)).toHaveLength(2);
  });
});

describe("the picked eye colour", () => {
  it("tints night drive's dot eyes, standing and up close, and a pupil shows in the close-up", () => {
    const navy = look();
    const green = look({ eyes: { shape: "round", color: "#47d6a0" } });
    expect(lit("night_drive", "night", () => standing(green))).not.toEqual(lit("night_drive", "night", () => standing(navy)));
    const g = geometry(green);
    const close = (l: CharacterLook) =>
      lit("night_drive", "cabin", () => {
        const pen = new Pen();
        const s = (0.3 * 1080) / g.headRX;
        pen.translate(540, 0.47 * 1920);
        pen.scale(s, s);
        drawBust(pen, l, g, { ...REST, turn: 0 }, { t: 1.3, seed: 4, face: FACES.neutral, inCar: true, view: "front" });
        return pen.out;
      });
    const a = close(green);
    expect(a).not.toEqual(close(navy));
    const tint = lit("night_drive", "cabin", () => mix(ND.eye, grade("#47d6a0"), 0.55));
    expect(a.filter((p) => p.k === "ellipse" && p.color === tint)).toHaveLength(2);
    expect(a.filter((p) => p.k === "ellipse" && p.color === ND.eye)).toHaveLength(2);
  });
});

describe("night drive people", () => {
  it("every look, face and pose draws clean prims, the same twice, within the actor budget (92)", () => {
    let most = 0;
    const poses: [string, (g: ReturnType<typeof geometry>) => Pose, boolean][] = [
      ["stand", (g) => restPose("stand", 1.2, STYLES.bouncy, 3, g, false), false],
      ["sit", (g) => restPose("sit", 1.2, STYLES.calm, 3, g, false), false],
      ["lie", (g) => restPose("lie", 1.2, STYLES.heavy, 3, g, false), false],
      ["car", (g) => restPose("stand", 1.2, STYLES.zippy, 3, g, true), true],
    ];
    for (const l of everyLook()) {
      const g = geometry(l);
      for (const [name, pose, inCar] of poses) {
        for (const face of EXPRESSIONS) {
          const draw = () => lit("night_drive", "night", () => standing(l, face, { pose: pose(g), inCar }), 0.6);
          const a = draw();
          expect(primProblems(a), `${l.body} ${l.hair.style} ${name} ${face}`).toEqual([]);
          expect(draw()).toEqual(a);
          most = Math.max(most, a.length);
        }
      }
    }
    expect(most).toBeGreaterThan(40);
    expect(most).toBeLessThanOrEqual(92);
  });

  it("the outline is the soft ink, about 2.3 px on a standing character, and never the heavy classic line", () => {
    const l = look({ body: "bean" });
    const g = geometry(l);
    const night = lit("night_drive", "night", () => standing(l));
    const skin = lit("night_drive", "night", () => grade("#e8b58f"));
    const head = night.filter((p): p is Extract<Prim, { k: "ellipse" }> => p.k === "ellipse" && Math.abs(p.rx - g.headRX * 5) < 3.5);
    const fill = head.find((p) => p.color === skin)!;
    const line = head.find((p) => p.color === ink("#1c1842"))!;
    expect(fill).toBeDefined();
    expect(line).toBeDefined();
    expect(line.rx - fill.rx).toBeCloseTo(inkPx(5), 0);
    expect(line.rx - fill.rx).toBeLessThan(3);
    // classic: 1.7 units, 8.5 px at this size
    const classic = standing(l).filter((p): p is Extract<Prim, { k: "ellipse" }> => p.k === "ellipse" && p.color === "#1c1842" && Math.abs(p.rx - g.headRX * 5) < 10);
    expect(classic[0]!.rx - g.headRX * 5).toBeCloseTo(8.5, 0);
  });

  it("own colours are lit by the place, never swapped: studio keeps the owner's colours, night mutes them", () => {
    const l = look();
    const studio = lit("night_drive", "studio", () => standing(l));
    const night = lit("night_drive", "night", () => standing(l));
    const day = lit("night_drive", "day", () => standing(l));
    const has = (prims: Prim[], c: string) => prims.some((p) => "color" in p && p.color === c);
    expect(has(studio, "#e8b58f")).toBe(true);
    expect(has(studio, "#3f8f8a")).toBe(true);
    for (const [prims, L] of [
      [night, LIGHTS.night],
      [day, LIGHTS.day],
    ] as const) {
      expect(has(prims, "#e8b58f")).toBe(false);
      expect(has(prims, grade("#e8b58f", L))).toBe(true);
      expect(has(prims, grade("#3f8f8a", L))).toBe(true);
    }
  });

  it("the lamps' rim light and the soft shadows (cel, chin and feet) are drawn", () => {
    const night = lit("night_drive", "night", () => standing(look()), 0.5);
    const rim = withWarm(LIGHTS.night, 0.5);
    expect(night.filter((p) => p.k === "line" && p.color === rim.rim && Math.abs((p.a ?? 1) - rim.rimA) < 0.002).length).toBeGreaterThanOrEqual(2);
    expect(night.filter((p) => "color" in p && p.color === ND.ao).length).toBeGreaterThanOrEqual(3);
    expect(night.some((p) => p.k === "poly" && p.color === ND.celDark)).toBe(true);
    // in a car the feet are hidden: no shadow under them
    const inCar = lit("night_drive", "night", () => standing(look(), "neutral", { inCar: true }));
    expect(inCar.filter((p) => p.k === "ellipse" && p.color === ND.ao)).toHaveLength(0);
  });

  it("each face reads: brows are tapered 9-point strokes, open mouths are dark red, gritted teeth and a humming mouth stay closed", () => {
    const l = look();
    const brows = (face: Expression) => lit("night_drive", "night", () => standing(l, face)).filter((p) => p.k === "poly" && p.pts.length === 18);
    for (const face of EXPRESSIONS) expect(brows(face).length, face).toBeGreaterThanOrEqual(2);
    const prims = (face: Expression) => lit("night_drive", "night", () => standing(l, face));
    for (const face of ["happy", "laughing", "surprised", "shocked"] as Expression[]) expect(prims(face).some((p) => p.k === "poly" && p.color === ND.mouthInside), face).toBe(true);
    for (const face of ["neutral", "worried", "sad", "determined", "thinking", "proud", "scared", "relieved"] as Expression[]) expect(prims(face).some((p) => "color" in p && p.color === ND.mouthInside), face).toBe(false);
    expect(prims("angry").some((p) => "color" in p && p.color === ND.teeth)).toBe(true);
    // a shout while a noise plays opens the angry mouth; a humming voice keeps it closed
    const shout = { ...FACES.angry, mouth: NOISE_MOUTH.yelp.mouth, mouthOpen: 1 };
    const hum = { ...FACES.angry, mouth: "hum" as const, mouthOpen: 1 };
    const g = geometry(l);
    const draw = (face: typeof shout) =>
      lit("night_drive", "night", () => {
        const pen = new Pen();
        pen.translate(540, 1400);
        pen.scale(5, 5);
        drawCharacter(pen, l, g, restPose("stand", 1, STYLES.bouncy, 1, g, false), { t: 1, seed: 1, face, inCar: false });
        return pen.out;
      });
    expect(draw(shout).some((p) => p.k === "poly" && p.color === ND.mouthInside)).toBe(true);
    expect(draw(hum).some((p) => "color" in p && p.color === ND.mouthInside)).toBe(false);
  });

  it("the brows overshoot just after a face change and settle within 0.12 s", () => {
    const l = look();
    const now = lit("night_drive", "night", () => standing(l, "angry", { t: 2, faceSince: 2 }));
    const settled = lit("night_drive", "night", () => standing(l, "angry", { t: 2, faceSince: 1.8 }));
    const without = lit("night_drive", "night", () => standing(l, "angry", { t: 2 }));
    expect(now).not.toEqual(without);
    expect(settled).toEqual(without);
  });

  it("the geometry is unchanged: a character's head and feet sit where classic puts them", () => {
    for (const l of everyLook()) {
      const g = geometry(l);
      const bounds = (prims: Prim[]) => {
        const b = bbox(prims.filter((p) => !("color" in p) || p.color !== ND.ao));
        return { top: b.y0, bottom: b.y1 };
      };
      const c = bounds(standing(l));
      const n = bounds(lit("night_drive", "night", () => standing(l)));
      expect(Math.abs(n.top - c.top), `${l.body} ${l.hair.style}`).toBeLessThan(12);
      expect(Math.abs(n.bottom - c.bottom), `${l.body} ${l.hair.style}`).toBeLessThan(12);
      expect(g.headRX).toBeGreaterThan(0);
    }
  });

  it("the top view's head mark has the soft ink in night drive and is unchanged in classic", () => {
    const draw = () => {
      const pen = new Pen();
      headTop(pen, look(), 500, 500, 20);
      return pen.out;
    };
    const classic = draw();
    expect(classic[0]).toMatchObject({ k: "circle", color: "#1c1842" });
    const night = lit("night_drive", "night", draw);
    expect(night[0]).toMatchObject({ k: "circle", color: ink("#1c1842") });
    expect(primProblems(night)).toEqual([]);
  });
});

describe("the shots' close-ups, in both styles", () => {
  /** Face up close in 9:16: the head's centre at (0.5 W, 0.47 H), headRX 0.30 of 1080. */
  function bust(l: CharacterLook, face: Expression, view: "front" | "three_quarter", pose: Partial<Pose> = {}): Prim[] {
    const g = geometry(l);
    const pen = new Pen();
    const s = (0.3 * 1080) / g.headRX;
    pen.translate(540, 0.47 * 1920);
    pen.scale(s, s);
    drawBust(pen, l, g, { ...REST, turn: 0, ...pose }, { t: 1.3, seed: 4, face: FACES[face], inCar: true, view });
    return pen.out;
  }

  it("a bust draws every look and face cleanly in both styles, the same twice, with the head in the frame", () => {
    let most = 0;
    for (const l of everyLook()) {
      for (const view of ["front", "three_quarter"] as const) {
        for (const face of EXPRESSIONS) {
          for (const art of ["night_drive", "classic"] as const) {
            const a = lit(art, "cabin", () => bust(l, face, view), 0.4);
            expect(primProblems(a), `${art} ${view} ${face}`).toEqual([]);
            expect(lit(art, "cabin", () => bust(l, face, view), 0.4)).toEqual(a);
            most = Math.max(most, a.length);
          }
        }
        // everything (the head, hair, ears and accessory; the shirt runs off the bottom) is inside the frame's sides
        // and below its top
        for (const art of ["night_drive", "classic"] as const) {
          const box = bbox(lit(art, "cabin", () => bust(l, "shocked", view), 0.4));
          expect(box.x0, `${art} ${view} ${l.hair.style} ${l.accessory}`).toBeGreaterThan(0);
          expect(box.x1, `${art} ${view} ${l.hair.style} ${l.accessory}`).toBeLessThan(1080);
          expect(box.y0, `${art} ${view} ${l.hair.style} ${l.accessory}`).toBeGreaterThan(0);
        }
      }
    }
    expect(most).toBeLessThanOrEqual(90);
  });

  it("the shoulders are 2.6 × headRX wide and run down past the frame", () => {
    const l = look();
    const g = geometry(l);
    const s = (0.3 * 1080) / g.headRX;
    const night = lit("night_drive", "cabin", () => bust(l, "neutral", "front"));
    const shirtColour = lit("night_drive", "cabin", () => grade("#3f8f8a"));
    const shirt = night.find((p): p is Extract<Prim, { k: "poly" }> => p.k === "poly" && p.color === shirtColour)!;
    const xs = shirt.pts.filter((_, i) => i % 2 === 0);
    const ys = shirt.pts.filter((_, i) => i % 2 === 1);
    const shoulderY = 0.47 * 1920 + g.headRY * s * 1.6;
    const near = shirt.pts.reduce((w, v, i) => (i % 2 === 0 && Math.abs(shirt.pts[i + 1]! - shoulderY) < g.headRY * s * 0.3 ? Math.max(w, Math.abs(v - 540)) : w), 0);
    expect((near * 2) / (g.headRX * s)).toBeGreaterThan(2.5);
    expect((near * 2) / (g.headRX * s)).toBeLessThan(2.8);
    expect(Math.max(...ys)).toBeGreaterThan(1920);
    expect(Math.min(...xs)).toBeGreaterThan(0);
    expect(Math.max(...xs)).toBeLessThan(1080);
  });

  it("the bust keeps the character's own face: blinks, faces and the noise mouths change it", () => {
    const l = look();
    const a = lit("night_drive", "cabin", () => bust(l, "neutral", "front"));
    expect(lit("night_drive", "cabin", () => bust(l, "angry", "front"))).not.toEqual(a);
    expect(lit("night_drive", "cabin", () => bust(l, "neutral", "three_quarter"))).not.toEqual(a);
    expect(lit("night_drive", "cabin", () => bust(l, "neutral", "front", { turn: 0.6 }))).not.toEqual(a);
  });

  it("hands hold the wheel at each grip, and a foot rests on a pedal and presses it", () => {
    const l = look();
    const hands = (art: "night_drive" | "classic") =>
      lit(art, "cabin", () => {
        const pen = new Pen();
        drawWheelHands(pen, l, [
          [166, 1592],
          [914, 1592],
        ], 70, [540, 1805]);
        return pen.out;
      });
    for (const art of ["night_drive", "classic"] as const) {
      const h = hands(art);
      expect(primProblems(h)).toEqual([]);
      const skin = art === "classic" ? "#e8b58f" : lit(art, "cabin", () => grade("#e8b58f"));
      const mitts = h.filter((p): p is Extract<Prim, { k: "ellipse" }> => p.k === "ellipse" && p.color === skin && p.rx > 60);
      expect(mitts).toHaveLength(2);
      expect(Math.abs(mitts[0]!.x - 166)).toBeLessThan(20);
      expect(Math.abs(mitts[1]!.x - 914)).toBeLessThan(20);
    }
    const none = new Pen();
    drawWheelHands(none, l, [], 70);
    expect(none.out).toEqual([]);

    const foot = (press: number) =>
      lit("night_drive", "cabin", () => {
        const pen = new Pen();
        drawFoot(pen, l, 734, 1056, 22, press);
        return pen.out;
      });
    expect(primProblems(foot(0.2))).toEqual([]);
    expect(foot(0.2)).toEqual(foot(0.2));
    expect(foot(1)).not.toEqual(foot(0.2));
    expect(foot(0.2).length).toBeLessThanOrEqual(24);
  });
});

describe("when the face last changed (faceSince)", () => {
  const beats: Beat[] = [
    { at: 0, dur: 1, who: "c1", do: "idle", face: "happy" },
    { at: 1.5, dur: 0.6, who: "c1", do: "gasp" },
    { at: 3, dur: 1, who: "c1", do: "idle", face: "angry" },
    { at: 4.5, dur: 1.5, who: "c1", do: "fall" },
  ];

  it("is the start of the face shown now: a beat's face, a face an action implies, and its end", () => {
    const at = (t: number) => faceSince(beats, t, null, shownExpression(beats, t));
    expect(at(0.5)).toBe(-99);
    expect(at(1.6)).toBe(1.5);
    expect(shownExpression(beats, 1.6)).toBe("shocked");
    expect(at(2.2)).toBeCloseTo(2.1, 6);
    expect(shownExpression(beats, 2.2)).toBe("happy");
    expect(at(3.05)).toBe(3);
    expect(shownExpression(beats, 4.6)).toBe("shocked");
    expect(at(4.6)).toBe(4.5);
    expect(shownExpression(beats, 5.6)).toBe("dizzy");
    expect(at(5.6)).toBeCloseTo(5.1, 6);
  });

  it("matches the face actorState shows at every moment, and a character without the implied face keeps its own", () => {
    const l = look();
    const g = geometry(l);
    for (const faces of [null, ["neutral", "happy", "angry"] as Expression[]]) {
      for (let t = 0; t < 6.5; t += 0.05) {
        const st = actorState({ castId: "c1", x: 0.5, y: 0.75, facing: "right" }, beats, STYLES.bouncy, g, 3, t, 200, "babble", faces);
        expect(st.expression, `t ${t.toFixed(2)}`).toBe(shownExpression(beats, t, faces));
        expect(st.faceSince).toBeLessThanOrEqual(t);
        if (st.faceSince > 0) expect(shownExpression(beats, st.faceSince - 1e-3, faces)).not.toBe(st.expression);
      }
    }
  });
});
