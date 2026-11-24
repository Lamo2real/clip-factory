// The Lamo Stories animation engine (docs/CONTRACTS.md §45.10, ADR-71): the script rules, the frame maths, the
// text and sound tracks, determinism and seeds, the speed budget, and the folder's "pure TypeScript" rule.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  audioTrack,
  drawFrame,
  ENGINE_VERSION,
  fitDuration,
  frameCount,
  LIMITS,
  MAX_SECONDS,
  normalizeScript,
  sceneFrames,
  sceneList,
  textTrack,
  validateScript,
} from "../src/stories/engine/engine.ts";
import { CATALOG, previewCharacter } from "../src/stories/engine/engine.ts";
import type { ArtStyle, CastMember, CharacterLook, Prim, Scene, StoryScript } from "../src/stories/engine/types.ts";

const ENGINE = join(import.meta.dirname, "../src/stories/engine");
const raw = (name: string): StoryScript => JSON.parse(readFileSync(join(ENGINE, "fixtures", name), "utf8")) as StoryScript;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function valid(s: unknown): StoryScript {
  const r = validateScript(s);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.script;
}

function errorsOf(s: unknown): string[] {
  const r = validateScript(s);
  return r.ok ? [] : r.errors;
}

const sample = () => normalizeScript(valid(raw("sample-script.json")));
const iceSkid = () => normalizeScript(valid(raw("ice-skid.json")));

const HEX = /^#[0-9a-f]{6}$/;

/** Every prim is one of the contract's types with sane numbers (CONTRACTS §45.10, engine/README.md). */
function primProblems(prims: Prim[], box = { x0: -4000, y0: -4000, x1: 5080, y1: 5920 }): string[] {
  const bad: string[] = [];
  const num = (v: unknown, what: string) => {
    if (typeof v !== "number" || !Number.isFinite(v)) bad.push(`${what} is not a finite number`);
  };
  const inX = (v: number, what: string) => (v < box.x0 || v > box.x1 ? bad.push(`${what} ${v} out of range`) : 0);
  const inY = (v: number, what: string) => (v < box.y0 || v > box.y1 ? bad.push(`${what} ${v} out of range`) : 0);
  prims.forEach((p, i) => {
    const at = `prim ${i} (${p.k})`;
    if ("color" in p && !HEX.test(p.color)) bad.push(`${at}: colour ${p.color}`);
    if ("a" in p && p.a !== undefined && (typeof p.a !== "number" || p.a < 0 || p.a > 1)) bad.push(`${at}: alpha ${p.a}`);
    switch (p.k) {
      case "fill":
        break;
      case "grad":
        [p.x0, p.y0, p.x1, p.y1].forEach((v) => num(v, at));
        if (p.stops.length < 2) bad.push(`${at}: fewer than 2 stops`);
        p.stops.forEach(([o, c], j) => {
          if (o < 0 || o > 1 || (j > 0 && o < p.stops[j - 1]![0])) bad.push(`${at}: stop offset ${o}`);
          if (!HEX.test(c)) bad.push(`${at}: stop colour ${c}`);
        });
        break;
      case "rect":
        [p.x, p.y, p.w, p.h, p.r].forEach((v) => num(v, at));
        if (p.w <= 0 || p.h <= 0 || p.r < 0 || p.r > Math.min(p.w, p.h) / 2 + 0.11) bad.push(`${at}: size ${p.w}×${p.h} r ${p.r}`);
        inX(p.x, at);
        inY(p.y, at);
        break;
      case "circle":
        [p.x, p.y, p.r].forEach((v) => num(v, at));
        if (p.r <= 0) bad.push(`${at}: radius ${p.r}`);
        inX(p.x, at);
        inY(p.y, at);
        break;
      case "ellipse":
        [p.x, p.y, p.rx, p.ry, p.rot].forEach((v) => num(v, at));
        if (p.rx <= 0 || p.ry <= 0) bad.push(`${at}: radii ${p.rx} ${p.ry}`);
        inX(p.x, at);
        inY(p.y, at);
        break;
      case "poly":
      case "line":
        if (p.pts.length % 2 !== 0 || p.pts.length < (p.k === "poly" ? 6 : 4)) bad.push(`${at}: ${p.pts.length} coordinates`);
        p.pts.forEach((v, j) => {
          num(v, at);
          if (j % 2 === 0) inX(v, at);
          else inY(v, at);
        });
        if (p.k === "line" && !(p.w > 0)) bad.push(`${at}: width ${p.w}`);
        break;
      case "image":
        bad.push(`${at}: the built-in engine never draws images`);
        break;
      default:
        bad.push(`${at}: unknown prim`);
    }
  });
  return bad;
}

describe("the fixtures", () => {
  it("sample-script.json and ice-skid.json validate as they are, and after normalize and fit", () => {
    for (const name of ["sample-script.json", "ice-skid.json"]) {
      expect(errorsOf(raw(name)), name).toEqual([]);
      const s = normalizeScript(valid(raw(name)));
      expect(errorsOf(s), name).toEqual([]);
      expect(errorsOf(fitDuration(s, 40)), name).toEqual([]);
    }
  });

  it("ice-skid.json is a 45 s driving-safety story with a top-view skid, two cast members and checked captions", () => {
    const s = raw("ice-skid.json");
    expect(s.scenes.reduce((a, sc) => a + sc.durationSec, 0)).toBe(45);
    expect(Object.keys(s.cast)).toHaveLength(2);
    expect(s.safety?.topicId).toBe("skid-recovery");
    expect(s.scenes.some((sc) => sc.view === "top" && sc.beats.some((b) => b.do === "skid"))).toBe(true);
    expect(s.captions.length).toBeGreaterThan(3);
    expect(s.captions.every((c) => /^skid-recovery\.(x?\d+)$/.test(c.guidanceRef ?? ""))).toBe(true);
    // the guidance refs are shown steps of the checked list (stories/config/guidance.json)
    const guidance = JSON.parse(readFileSync(join(import.meta.dirname, "../../stories/config/guidance.json"), "utf8")) as {
      topics: { id: string; steps: { id: string; shown: boolean }[]; donts: { id: string; shown: boolean }[] }[];
    };
    const topic = guidance.topics.find((t) => t.id === "skid-recovery")!;
    const shown = new Set([...topic.steps, ...topic.donts].filter((x) => x.shown).map((x) => x.id));
    for (const c of s.captions) expect(shown.has(c.guidanceRef!), c.guidanceRef).toBe(true);
  });
});

describe("validateScript", () => {
  const base = () => clone(raw("sample-script.json")) as unknown as Record<string, unknown> & StoryScript;
  const cases: [string, (s: StoryScript & Record<string, unknown>) => unknown, RegExp][] = [
    ["not an object", () => [], /must be a JSON object/],
    ["the wrong frame rate", (s) => ({ ...s, fps: 25 }), /fps is 25; it must be 30/],
    ["the wrong size", (s) => ({ ...s, width: 1920, height: 1080 }), /must be 1080 × 1920/],
    ["no scenes", (s) => ({ ...s, scenes: [] }), /scenes must be a list of 1 to 30/],
    ["an unknown set", (s) => ((s.scenes[0]!.set = "moon" as never), s), /scene 1 \(s1\): set "moon" is not in the catalog; use one of studio/],
    ["an unknown camera", (s) => ((s.scenes[0]!.camera = "drone" as never), s), /camera "drone" is not in the catalog/],
    ["an unknown view", (s) => ((s.scenes[0]!.view = "front" as never), s), /view must be "side" or "top"/],
    ["an unknown action", (s) => ((s.scenes[0]!.beats[0]!.do = "fly" as never), s), /scene 1 \(s1\) beat 1: action "fly" is not in the catalog/],
    ["a prop action on a character", (s) => ((s.scenes[0]!.beats[0]!.do = "skid"), s), /"skid" is a prop action; c1 is a character/],
    ["a character action on a prop", (s) => (s.scenes[0]!.beats.push({ at: 0.1, dur: 1, who: "car1", do: "wave" }), s), /"wave" is a character action; car1 is a prop/],
    ["a cast member who is not in the scene", (s) => ((s.scenes[1]!.actors = []), s), /scene 2 \(s2\) beat 1: c1 is in the cast but not in this scene; add it to this scene's actors/],
    ["someone who is not anywhere", (s) => ((s.scenes[0]!.beats[0]!.who = "ghost"), s), /who "ghost" is not in this scene; use an actor \(c1\) or a prop \(car1\)/],
    ["a beat after the scene", (s) => ((s.scenes[0]!.beats[0]!.at = 3.5), s), /beat 1: starts at 3.5 s, but the scene is only 3 s long/],
    ["a beat that ends after the scene", (s) => ((s.scenes[0]!.beats[0]!.dur = 2.9), s), /beat 1: ends at 3.1 s, after the scene ends \(3 s\)/],
    ["a beat of no length", (s) => ((s.scenes[0]!.beats[0]!.dur = 0), s), /dur is 0; a beat lasts at least 0.05 s/],
    ["an effect after the scene", (s) => ((s.scenes[0]!.sfx = [{ id: "x1", at: 3.2, sfx: "pop", volume: 0.5 }]), s), /scene 1 \(s1\) effect 1: plays at 3.2 s, but the scene is only 3 s long/],
    ["an unknown effect", (s) => ((s.scenes[0]!.sfx = [{ id: "x1", at: 1, sfx: "laser" as never, volume: 0.5 }]), s), /sfx "laser" is not in the catalog/],
    ["a loud effect", (s) => ((s.scenes[0]!.sfx = [{ id: "x1", at: 1, sfx: "pop", volume: 2 }]), s), /volume is 2; use 0 to 1/],
    ["two effects with one id", (s) => ((s.scenes[0]!.sfx = [{ id: "x1", at: 1, sfx: "pop", volume: 1 }]), (s.scenes[1]!.sfx = [{ id: "x1", at: 1, sfx: "pop", volume: 1 }]), s), /id "x1" is used twice; effect ids must be unique/],
    ["a scene too short", (s) => ((s.scenes[0]!.durationSec = 1), s), /durationSec is 1; a scene lasts 2 to 15 seconds/],
    ["a scene too long", (s) => ((s.scenes[0]!.durationSec = 16), s), /durationSec is 16; a scene lasts 2 to 15 seconds/],
    ["a durationSec that disagrees with the scenes", (s) => ({ ...s, durationSec: 60 }), /^durationSec is 60 but the scenes add up to 6 s; set it to 6 \(or run fit\)\.$/],
    ["a scene length changed without the total", (s) => ((s.scenes[1]!.durationSec = 4.5), s), /durationSec is 6 but the scenes add up to 7\.5 s/],
    ["two scenes with one id", (s) => ((s.scenes[1]!.sceneId = "s1"), s), /sceneId "s1" is used twice/],
    ["an unknown face", (s) => ((s.scenes[0]!.beats[0]!.face = "smug" as never), s), /face "smug" is not in the catalog/],
    ["a bubble on a prop", (s) => (s.scenes[0]!.beats.push({ at: 0.1, dur: 1, who: "car1", do: "flash", bubble: "idea" }), s), /bubble "idea" is for characters only/],
    ["an unknown bubble", (s) => ((s.scenes[0]!.beats[0]!.bubble = "words" as never), s), /bubble "words" is not in the catalog/],
    ["an unknown noise", (s) => ((s.scenes[0]!.beats[0]!.noise = "hello" as never), s), /noise "hello" is not in the catalog/],
    ["a walk off the frame", (s) => ((s.scenes[0]!.beats[0]!.to = { x: 1.4, y: 0.7 }), s), /to must be \{ x, y \} from 0 to 1/],
    ["sitting in a tree", (s) => (s.scenes[0]!.props.push({ propId: "t1", kind: "tree", x: 0.2, y: 0.7, scale: 1, rot: 0 }), (s.scenes[0]!.actors[0]!.inCar = "t1"), s), /inCar "t1" must be the propId of a car or truck/],
    ["an unknown prop", (s) => ((s.scenes[0]!.props[0]!.kind = "boat" as never), s), /kind "boat" is not in the catalog/],
    ["a prop with a cast id", (s) => ((s.scenes[0]!.props[0]!.propId = "c1"), s), /propId "c1" is also a cast id/],
    ["too many actors", (s) => ((s.scenes[0]!.actors = Array.from({ length: 5 }, () => ({ castId: "c1", x: 0.5, y: 0.7, facing: "left" as const }))), s), /has 5 actors; the most is 4/],
    ["an actor off the frame", (s) => ((s.scenes[0]!.actors[0]!.x = 1.2), s), /actor 1: x is 1.2; use 0 to 1/],
    ["a caption too long", (s) => ((s.captions[0]!.text = "x".repeat(61)), s), /caption 1: text must be 1 to 60 characters/],
    ["a caption after the story", (s) => ((s.captions[0]!.at = 7), s), /caption 1: starts at 7 s, after the story ends \(6 s\)/],
    ["a caption that runs past the end", (s) => ((s.captions[0]!.dur = 6), s), /caption 1: ends at 6.5 s, after the story ends \(6 s\)/],
    ["a scene caption too long", (s) => ((s.scenes[0]!.caption = "y".repeat(61)), s), /caption must be null or at most 60 characters/],
    ["a look without a skin colour", (s) => ((s.cast.c1!.look.skin = "peach"), s), /cast c1: look.skin must be a colour/],
    ["an unknown body", (s) => ((s.cast.c1!.look.body = "blob" as never), s), /look.body is "blob"; use one of bean, round, tall, square/],
    ["an unknown movement style", (s) => ((s.cast.c1!.movementStyle = "wiggly" as never), s), /movementStyle is "wiggly"/],
    ["a voice out of range", (s) => ((s.cast.c1!.voice.pitch = 3), s), /voice.pitch is 3; use a number from 0.5 to 2/],
    ["an unknown music mood", (s) => ({ ...s, music: { mood: "disco", volume: 0.5 } }), /music must be null or \{ mood/],
    ["no captions switch", (s) => ({ ...s, captionsOn: "yes" }), /captionsOn must be true or false/],
    ["a bad seed", (s) => ({ ...s, seed: -1 }), /seed is -1/],
    ["a bad safety block", (s) => ({ ...s, safety: { topicId: "" } }), /safety must be null or \{ topicId, citations/],
  ];
  for (const [what, make, expected] of cases) {
    it(`rejects ${what} with a sentence that says how to fix it`, () => {
      const errors = errorsOf(make(base()));
      expect(errors.length, `no error for ${what}`).toBeGreaterThan(0);
      expect(errors.some((e) => expected.test(e)), errors.join("\n")).toBe(true);
    });
  }

  it("accepts a durationSec within 0.05 s of the scenes' sum (rounding), and frameCount follows it", () => {
    for (const d of [5.96, 6, 6.04]) expect(errorsOf({ ...base(), durationSec: d }), String(d)).toEqual([]);
    const s = valid(base());
    expect(frameCount(s)).toBe(Math.round(s.durationSec * s.fps));
    const f = fitDuration(iceSkid(), 37);
    expect(frameCount(f)).toBe(Math.round(f.durationSec * f.fps));
  });

  it("accepts a writer's raw answer: effects on beats, no seeds, no effect lists", () => {
    const s = base();
    for (const sc of s.scenes) {
      delete (sc as Partial<typeof sc>).sfx;
      delete sc.seed;
    }
    const r = validateScript(s);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.script.scenes.every((sc) => Array.isArray(sc.sfx))).toBe(true);
  });
});

describe("normalizeScript", () => {
  it("moves beat effects into the scene's list with ids {sceneId}.fx{k} and gives every scene a seed", () => {
    const before = valid(raw("sample-script.json"));
    const copy = clone(before);
    const s = normalizeScript(before);
    expect(before).toEqual(copy);
    expect(s.scenes.flatMap((sc) => sc.beats).some((b) => b.sfx !== undefined)).toBe(false);
    // the icy road's wind comes first: a new scene gets its place's sound in its list
    expect(s.scenes[0]!.sfx).toEqual([
      { id: "s1.amb1", at: 0, sfx: "wind", volume: 0.18 },
      { id: "s1.fx1", at: 0.2, sfx: "skid", volume: 0.8 },
    ]);
    for (const sc of s.scenes) expect(Number.isInteger(sc.seed)).toBe(true);
    expect(s.scenes[0]!.seed).not.toBe(s.scenes[1]!.seed);
  });

  it("is idempotent and keeps ids unique", () => {
    const once = iceSkid();
    expect(normalizeScript(once)).toEqual(once);
    const s = clone(valid(raw("sample-script.json")));
    s.scenes[0]!.sfx = [{ id: "s1.fx1", at: 1, sfx: "pop", volume: 0.5 }];
    const n = normalizeScript(s);
    expect(n.scenes[0]!.sfx.map((c) => c.id)).toEqual(["s1.amb1", "s1.fx2", "s1.fx1"]);
    const ids = once.scenes.flatMap((sc) => sc.sfx.map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps a scene's own seed (a remade scene keeps its new seed)", () => {
    const s = clone(valid(raw("sample-script.json")));
    s.scenes[1]!.seed = 99;
    expect(normalizeScript(s).scenes[1]!.seed).toBe(99);
  });
});

describe("fitDuration", () => {
  const total = (s: StoryScript) => s.scenes.reduce((a, sc) => a + sc.durationSec, 0);
  it("lands within ±10% of the target with every scene 2 to 15 s, beats, effects and captions inside", () => {
    for (const target of [20, 30, 45, 60, 75, 89.5]) {
      const s = fitDuration(iceSkid(), target);
      expect(Math.abs(total(s) - target) / target).toBeLessThanOrEqual(0.1);
      expect(total(s)).toBeLessThanOrEqual(MAX_SECONDS);
      expect(s.durationSec).toBeCloseTo(total(s), 5);
      for (const sc of s.scenes) {
        expect(sc.durationSec).toBeGreaterThanOrEqual(2);
        expect(sc.durationSec).toBeLessThanOrEqual(15);
        expect(Math.round(sc.durationSec * 10)).toBeCloseTo(sc.durationSec * 10, 6);
        for (const b of sc.beats) {
          expect(b.at).toBeGreaterThanOrEqual(0);
          expect(b.at + b.dur).toBeLessThanOrEqual(sc.durationSec + 1e-9);
        }
        for (const c of sc.sfx) expect(c.at).toBeLessThan(sc.durationSec);
      }
      for (const c of s.captions) expect(c.at + c.dur).toBeLessThanOrEqual(total(s) + 1e-9);
      expect(errorsOf(s)).toEqual([]);
    }
  });

  it("never goes above 89.5 s, and keeps the 2 s and 15 s scene limits when the target cannot be met", () => {
    expect(total(fitDuration(iceSkid(), 200))).toBeLessThanOrEqual(MAX_SECONDS);
    expect(total(fitDuration(iceSkid(), 1))).toBe(18);
    const short = fitDuration(sample(), 60);
    expect(total(short)).toBe(30);
    expect(short.scenes.every((sc) => sc.durationSec === 15)).toBe(true);
  });

  it("scales beat and effect times with their scene and moves captions with the scenes under them", () => {
    const s = iceSkid();
    const f = fitDuration(s, 36);
    const k = f.scenes[2]!.durationSec / s.scenes[2]!.durationSec;
    expect(f.scenes[2]!.beats[1]!.at).toBeCloseTo(s.scenes[2]!.beats[1]!.at * k, 2);
    expect(f.scenes[3]!.sfx[0]!.at).toBeCloseTo(s.scenes[3]!.sfx[0]!.at * (f.scenes[3]!.durationSec / s.scenes[3]!.durationSec), 2);
    // cap2 starts 0.3 s into scene 4 in the original; it stays in scene 4 after fitting
    const start4 = f.scenes.slice(0, 3).reduce((a, sc) => a + sc.durationSec, 0);
    const cap2 = f.captions.find((c) => c.id === "cap2")!;
    expect(cap2.at).toBeGreaterThanOrEqual(start4);
    expect(cap2.at).toBeLessThan(start4 + f.scenes[3]!.durationSec);
  });

  it("is idempotent", () => {
    const once = fitDuration(iceSkid(), 40);
    expect(fitDuration(once, 40)).toEqual(once);
    expect(fitDuration(iceSkid(), 45)).toEqual(iceSkid());
  });
});

describe("frames", () => {
  it("counts round(duration × fps) frames and the scenes tile them exactly", () => {
    const s = iceSkid();
    expect(frameCount(sample())).toBe(180);
    expect(frameCount(s)).toBe(1350);
    let next = 0;
    for (const sc of s.scenes) {
      const [from, to] = sceneFrames(s, sc.sceneId);
      expect(from).toBe(next);
      expect(to - from).toBe(Math.round(sc.durationSec * 30));
      next = to;
    }
    expect(next).toBe(frameCount(s));
    for (const x of sceneList(s)) expect(x.mid >= x.from && x.mid < x.to).toBe(true);
    expect(sceneFrames(s, "nope")).toEqual([0, 0]);
  });

  it("is deterministic: the same frame twice, and a fresh copy of the script, draw the same prims", () => {
    const s = iceSkid();
    for (const f of [0, 77, 400, 700, 1349]) {
      const a = drawFrame(s, f);
      expect(drawFrame(s, f)).toEqual(a);
      expect(drawFrame(iceSkid(), f)).toEqual(a);
      expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    }
  });

  it("draws only contract prims with finite numbers, starting with a full-frame background, under 400 per frame", () => {
    for (const s of [sample(), iceSkid()]) {
      let most = 0;
      for (let f = 0; f < frameCount(s); f += 3) {
        const prims = drawFrame(s, f);
        expect(primProblems(prims), `frame ${f}`).toEqual([]);
        expect(["fill", "grad"]).toContain(prims[0]!.k);
        most = Math.max(most, prims.length);
      }
      expect(most).toBeLessThanOrEqual(400);
    }
  });

  it("shows the last frame past the end and the first before the start", () => {
    const s = sample();
    expect(drawFrame(s, 5000)).toEqual(drawFrame(s, 179));
    expect(drawFrame(s, -3)).toEqual(drawFrame(s, 0));
  });

  it("uses scene.seed ?? script.seed: a remade scene (new seed) looks different, the others stay the same", () => {
    const s = iceSkid();
    const remade = clone(s);
    remade.scenes[0]!.seed = (s.scenes[0]!.seed ?? 0) + 1;
    expect(drawFrame(remade, 40)).not.toEqual(drawFrame(s, 40));
    expect(drawFrame(remade, 200)).toEqual(drawFrame(s, 200));
    const noSeed = clone(s);
    delete noSeed.scenes[1]!.seed;
    const otherScript = clone(noSeed);
    otherScript.seed += 1;
    expect(drawFrame(otherScript, 200)).not.toEqual(drawFrame(noSeed, 200));
  });

  it("rolls the road past a car that is being driven (side view)", () => {
    const s = iceSkid();
    const [from] = sceneFrames(s, "s2");
    const dashes = (f: number) =>
      drawFrame(s, f)
        .filter((p): p is Extract<Prim, { k: "rect" }> => p.k === "rect" && p.color === "#ffffff" && p.h < 20)
        .map((p) => p.x);
    expect(dashes(from + 10)).not.toEqual(dashes(from + 20));
  });

  it("leaves tyre marks behind a skidding car seen from above", () => {
    const s = iceSkid();
    const [from] = sceneFrames(s, "s3");
    const early = drawFrame(s, from + 30).filter((p) => p.k === "line" && p.color === "#1d1d26");
    const late = drawFrame(s, from + 150).filter((p) => p.k === "line" && p.color === "#1d1d26");
    expect(early).toHaveLength(0);
    expect(late.length).toBeGreaterThanOrEqual(2);
  });

  it("an engine version is set", () => {
    expect(Number.isInteger(ENGINE_VERSION) && ENGINE_VERSION >= 2).toBe(true);
  });
});

describe("textTrack", () => {
  it("captions sit in the bottom safe area in at most 2 lines, and a scene caption that repeats one is not shown twice", () => {
    const t = textTrack(sample());
    expect(t).toEqual([{ start: 0.5, end: 2.5, kind: "caption", text: "Ease off the\naccelerator", x: 495, y: 1345, size: 64, color: "#fff6e5" }]);
    for (const e of textTrack(iceSkid()).filter((x) => x.kind === "caption")) {
      expect(e.text.split("\n").length).toBeLessThanOrEqual(2);
      expect(e.size).toBeGreaterThanOrEqual(40);
      expect(e.y === 1345 || e.y === 350).toBe(true);
    }
  });

  it("wraps long captions onto two balanced lines", () => {
    const s = iceSkid();
    const e = textTrack(s).find((x) => x.text.startsWith("Keep steering"))!;
    expect(e.text).toBe("Keep steering where\nyou want to go");
  });

  it("puts each bubble's symbol at its balloon, words never", () => {
    const s = iceSkid();
    const bubbles = textTrack(s).filter((e) => e.kind === "bubble");
    expect(bubbles.map((b) => b.text)).toEqual(["?", "♫", "!", "♥"]);
    for (const b of bubbles) {
      expect(b.x).toBeGreaterThanOrEqual(150);
      expect(b.x).toBeLessThanOrEqual(930);
      // the balloon is drawn in the frames at the same spot
      const prims = drawFrame(s, Math.round(((b.start + b.end) / 2) * 30));
      const near = prims.some((p) => (p.k === "ellipse" || p.k === "circle") && Math.hypot(p.x - b.x, p.y - b.y) < 12 && p.color !== "#1c1842")
        || prims.some((p) => p.k === "poly" && Math.abs((Math.min(...p.pts.filter((_, i) => i % 2 === 0)) + Math.max(...p.pts.filter((_, i) => i % 2 === 0))) / 2 - b.x) < 30 && p.color === "#ffffff");
      expect(near, `${b.text} at ${b.x},${b.y}`).toBe(true);
    }
  });

  it("ends a safety story with its sources and the local rules line for the last 2.5 s", () => {
    const s = iceSkid();
    const end = textTrack(s).filter((e) => e.kind === "endcard");
    expect(end).toHaveLength(1);
    expect(end[0]!.start).toBeCloseTo(42.5, 6);
    expect(end[0]!.end).toBeCloseTo(45, 6);
    expect(end[0]!.text.replace(/\n/g, " ")).toBe("Based on The Highway Code and Ontario Ministry of Transportation advice. Check your local road rules.");
    expect(textTrack(sample()).some((e) => e.kind === "endcard")).toBe(false);
  });

  it("with captions off keeps the bubbles and the end card only", () => {
    const s = { ...iceSkid(), captionsOn: false };
    const kinds = new Set(textTrack(s).map((e) => e.kind));
    expect([...kinds].sort()).toEqual(["bubble", "endcard"]);
  });
});

describe("audioTrack", () => {
  it("has every effect and noise at its absolute time, with the voice's pitch and a pan from where it stands", () => {
    const a = audioTrack(sample());
    expect(a).toContainEqual({ at: 0.2, kind: "sfx", id: "skid", volume: 0.8, pan: 0 });
    expect(a).toContainEqual({ at: 0.2, kind: "noise", id: "gasp", volume: 0.9, pitch: 1.2, pan: 0, voice: "babble" });
    expect(a).toContainEqual({ at: 3.5, kind: "noise", id: "phew", volume: 0.9, pitch: 1.2, pan: 0, voice: "babble" });
    // the icy road's wind for its scene
    expect(a).toContainEqual({ at: 0, kind: "sfx", id: "wind", volume: 0.18, dur: 3, pan: 0 });
  });

  it("covers every scene effect of the story, adds the engine while someone drives, and stays sorted", () => {
    const s = iceSkid();
    const a = audioTrack(s);
    let start = 0;
    for (const sc of s.scenes) {
      for (const c of sc.sfx) expect(a.some((e) => e.kind === "sfx" && e.id === c.sfx && Math.abs(e.at - (start + c.at)) < 0.001)).toBe(true);
      start += sc.durationSec;
    }
    const engine = a.filter((e) => e.id === "engine");
    expect(engine.length).toBeGreaterThanOrEqual(5);
    expect(engine.every((e) => (e.dur ?? 0) > 0)).toBe(true);
    for (let i = 1; i < a.length; i += 1) expect(a[i]!.at).toBeGreaterThanOrEqual(a[i - 1]!.at);
    for (const e of a) {
      expect(e.pan ?? 0).toBeGreaterThanOrEqual(-1);
      expect(e.pan ?? 0).toBeLessThanOrEqual(1);
      expect(e.volume).toBeGreaterThanOrEqual(0);
      expect(e.volume).toBeLessThanOrEqual(1);
      expect(e.at).toBeLessThan(45);
    }
    expect(a.filter((e) => e.kind === "noise" && e.pitch === 0.85).map((e) => e.id)).toEqual(["hmm", "sigh", "phew", "giggle"]);
    // Lamo waves on the left, Pip on the right: their noises pan apart
    const s1 = a.filter((e) => e.kind === "noise" && e.at < 4);
    expect(s1.find((e) => e.id === "hmm")!.pan).toBeGreaterThan(0.3);
  });

  it("a silent character makes no noises, and effects stay", () => {
    const s = clone(sample());
    s.cast.c1!.voice.style = "none";
    const a = audioTrack(s);
    expect(a.some((e) => e.kind === "noise")).toBe(false);
    expect(a.some((e) => e.id === "skid")).toBe(true);
  });
});

describe("speed", () => {
  it("draws a 45 s story at under 2 ms a frame on average", () => {
    const s = iceSkid();
    const n = frameCount(s);
    drawFrame(s, 0);
    const t0 = performance.now();
    let prims = 0;
    for (let f = 0; f < n; f += 1) prims += drawFrame(s, f).length;
    const ms = (performance.now() - t0) / n;
    expect(prims).toBeGreaterThan(n * 20);
    expect(ms).toBeLessThan(2);
  });
});

describe("the engine folder is plain TypeScript (§45.10)", () => {
  const files = readdirSync(ENGINE).filter((f) => f.endsWith(".ts"));
  const code = (f: string) =>
    readFileSync(join(ENGINE, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'])\/\/.*$/gm, "$1")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  it("imports nothing but relative ./*.ts files", () => {
    expect(files.length).toBeGreaterThan(8);
    for (const f of files) {
      const text = readFileSync(join(ENGINE, f), "utf8");
      const specs = [...text.matchAll(/(?:import|export)\s[^;]*?\sfrom\s+"([^"]+)"/g), ...text.matchAll(/\bimport\s*\(\s*["']([^"']+)/g)].map((m) => m[1]!);
      for (const spec of specs) expect(/^\.\/[A-Za-z0-9_-]+\.ts$/.test(spec), `${f}: ${spec}`).toBe(true);
      expect(/\brequire\s*\(/.test(code(f)), f).toBe(false);
    }
  });

  it("uses no DOM, clock, network or Math.random (Deno only in cli.ts)", () => {
    const banned = /\b(document|window|navigator|localStorage|sessionStorage|fetch|XMLHttpRequest|WebSocket|requestAnimationFrame|setTimeout|setInterval|performance|Date|process|globalThis)\b|Math\.random/;
    for (const f of files) {
      const hit = code(f).match(banned);
      expect(hit?.[0] ?? null, f).toBeNull();
      if (f !== "cli.ts") expect(/\bDeno\b/.test(code(f)), f).toBe(false);
    }
  });
});

// ---- every catalog id draws ---------------------------------------------------------------------------------

type ListKey = Exclude<keyof typeof CATALOG, "looks" | "carLooks">;
const ids = <K extends ListKey>(k: K) => CATALOG[k].map((e) => e.id) as (typeof CATALOG)[K][number]["id"][];

/** Looks that use every body, hair style, eye shape, brow, nose, mouth, pattern and accessory at least once. */
function looks(): CharacterLook[] {
  const bodies = ["bean", "round", "tall", "square"] as const;
  const hair = ["none", "short", "spiky", "curly", "long", "bun", "cap"] as const;
  const eyes = ["round", "oval", "sleepy"] as const;
  const noses = ["dot", "button", "long", "none"] as const;
  const patterns = ["plain", "stripes", "dots"] as const;
  const acc = ["none", "glasses", "scarf", "bowtie", "helmet", "headphones"] as const;
  const skins = ["#f2c9a0", "#8d5a3b", "#ffd9b8", "#c68642", "#5c3a21", "#e8b98a", "#f9e0c7"];
  return hair.map((h, i) => ({
    body: bodies[i % 4]!,
    skin: skins[i]!,
    height: [1, 0.85, 1.15, 0.95, 1.05, 1, 0.9][i]!,
    width: [1, 1.15, 0.85, 1.05, 0.95, 1, 1.1][i]!,
    hair: { style: h, color: ["#3b2a1a", "#ffc94a", "#1b1b2a", "#ff6f61", "#62c6ff", "#ffffff", "#7a4a2a"][i]! },
    eyes: { shape: eyes[i % 3]!, color: ["#1c1842", "#47d6a0", "#2b1a10"][i % 3]! },
    brows: i % 2 === 0 ? "thick" : "thin",
    nose: noses[i % 4]!,
    mouth: i % 2 === 0 ? "wide" : "small",
    outfit: { top: ["#ff6f61", "#47d6a0", "#62c6ff", "#ffc94a", "#fff6e5", "#2a2466", "#ff8a3d"][i]!, bottom: "#1c1842", accent: "#ffc94a", pattern: patterns[i % 3]! },
    accessory: acc[i % 6]!,
    outline: "#1c1842",
  }));
}

function castOf(n: number): Record<string, CastMember> {
  const styles = ids("movementStyles");
  const ls = looks();
  return Object.fromEntries(
    Array.from({ length: n }, (_, i) => [
      `c${i}`,
      { characterId: `ch${i}`, name: `Kid ${i}`, look: ls[i % ls.length]!, movementStyle: styles[i % styles.length]!, voice: { style: "babble", pitch: 0.6 + i * 0.25, noises: ["gasp"], sfx: [] } },
    ]),
  ) as Record<string, CastMember>;
}

/** `art` is the drawing style (§45.45): Bright leaves the field out, as every script before it did. */
function storyOf(scenes: Scene[], cast = castOf(5), art: ArtStyle = "classic"): StoryScript {
  return { engine: 2, fps: 30, width: 1080, height: 1920, durationSec: scenes.reduce((a, sc) => a + sc.durationSec, 0), title: "Every id", seed: 3, cast, scenes, music: { mood: "calm", volume: 0.3 }, captionsOn: true, captions: [], safety: null, ...(art === "night_drive" ? { art } : {}) };
}

const scene = (sceneId: string, p: Partial<Scene>): Scene => ({ sceneId, title: sceneId, durationSec: 2, set: "studio", view: "side", camera: "wide", actors: [], props: [], beats: [], sfx: [], caption: null, note: null, ...p });

function drawsCleanly(s: StoryScript): void {
  expect(errorsOf(s)).toEqual([]);
  const n = normalizeScript(valid(s));
  for (const sc of n.scenes) {
    const [from, to] = sceneFrames(n, sc.sceneId);
    for (const k of [0, 0.15, 0.35, 0.55, 0.75, 0.97]) {
      const f = Math.min(to - 1, from + Math.floor((to - from) * k));
      const prims = drawFrame(n, f);
      expect(primProblems(prims), `${sc.sceneId} frame ${f}`).toEqual([]);
      expect(prims.length, `${sc.sceneId} frame ${f}`).toBeLessThanOrEqual(400);
    }
  }
  expect(() => textTrack(n)).not.toThrow();
  expect(() => audioTrack(n)).not.toThrow();
}

// every id draws in both drawing styles: Bright (no art, as before) and night drive (CONTRACTS §45.45)
for (const art of ["classic", "night_drive"] as const)
describe(art === "classic" ? "every catalog id draws" : "every catalog id draws in night drive", () => {
  it("every set, in side and top view, with every camera", () => {
    const cams = ids("cameras");
    const scenes = ids("sets").flatMap((set, i) =>
      (["side", "top"] as const).map((view, j) =>
        scene(`set${i}${view}`, {
          set,
          view,
          camera: cams[(i * 2 + j) % cams.length]!,
          actors: [
            { castId: "c0", x: 0.3, y: 0.74, facing: "right" },
            { castId: "c1", x: 0.5, y: 0.72, facing: "right", inCar: "car1" },
          ],
          props: [{ propId: "car1", kind: "car", x: 0.6, y: view === "top" ? 0.55 : 0.72, scale: 0.8, rot: 0 }],
          beats: [{ at: 0.2, dur: 1.5, who: "c0", do: "walk", to: { x: 0.45, y: 0.76 } }],
        }),
      ),
    );
    // a story holds at most LIMITS.scenes scenes: every set and view is drawn, in as many stories as that takes
    for (let i = 0; i < scenes.length; i += LIMITS.scenes) drawsCleanly(storyOf(scenes.slice(i, i + LIMITS.scenes), castOf(5), art));
  });

  it("every action with every movement style, every face, bubble and noise, standing and in a car", () => {
    // getting in and out needs a parked car and its own timing rules: storiesEngineCasting.test.ts draws those
    const actions = ids("actions").filter((a) => a !== "get_in" && a !== "get_out");
    const faces = ids("expressions");
    const bubbles = ids("bubbles");
    const noises = ids("noises");
    const beatsFor = (who: string) =>
      actions.map((a, k) => ({ at: k * 0.5, dur: 0.6, who, do: a, face: faces[k % faces.length]!, ...(k % 3 === 0 ? { bubble: bubbles[(k / 3) % bubbles.length]! } : {}), ...(k % 2 === 0 ? { noise: noises[k % noises.length]! } : {}) })).map((b) => ({ ...b, dur: Math.min(b.dur, 15 - b.at) }));
    const scenes = ids("movementStyles").map((_, i) =>
      scene(`style${i}`, { durationSec: 15, set: "park", camera: (["medium", "close", "wide", "push_in", "shake"] as const)[i]!, actors: [{ castId: `c${i}`, x: 0.5, y: 0.74, facing: i % 2 ? "left" : "right" }], beats: beatsFor(`c${i}`) }),
    );
    for (const view of ["side", "top"] as const) {
      scenes.push(
        scene(`car${view}`, {
          durationSec: 15,
          set: "road_day",
          view,
          camera: "medium",
          actors: [
            { castId: "c0", x: 0.5, y: 0.7, facing: "right", inCar: "car1" },
            { castId: "c1", x: 0.5, y: 0.7, facing: "right", inCar: "car1" },
          ],
          props: [{ propId: "car1", kind: "car", x: 0.5, y: 0.7, scale: 1, rot: 0, state: "driving" }],
          beats: beatsFor("c0"),
        }),
      );
    }
    drawsCleanly(storyOf(scenes, castOf(5), art));
  });

  for (const view of ["side", "top"] as const) {
    it(`every prop with every prop action (${view} view)`, () => {
      const kinds = ids("props");
      const actions = ids("propActions");
      const groups = [kinds.slice(0, 12), kinds.slice(12)];
      const scenes = actions.flatMap((act, i) =>
        groups.map((group, g) =>
          scene(`p${i}g${g}`, {
            durationSec: 3,
            set: view === "top" ? "icy_road" : "rainy_road",
            view,
            camera: "wide",
            props: group.map((kind, k) => ({ propId: `x${k}`, kind, x: 0.15 + (k % 4) * 0.23, y: 0.35 + Math.floor(k / 4) * 0.2, scale: 0.5, rot: k * 15, ...(kind === "arrow" && k % 2 ? { state: "curve_left" } : {}) })),
            beats: group.map((_, k) => ({ at: 0.2, dur: 2.2, who: `x${k}`, do: act, dir: k % 2 ? ("left" as const) : ("right" as const), ...(k % 3 === 0 ? { to: { x: 0.5, y: 0.5 } } : {}) })),
          }),
        ),
      );
      drawsCleanly(storyOf(scenes, castOf(5), art));
    });
  }

  it("previewCharacter draws every look, face, action and movement style inside its size × size box", () => {
    const size = 240;
    const box = { x0: -0.12 * size, y0: -0.12 * size, x1: 1.12 * size, y1: 1.12 * size };
    const styles = ids("movementStyles");
    for (const [i, look] of looks().entries()) {
      for (const expression of ids("expressions")) {
        const prims = previewCharacter(look, styles[i % styles.length]!, expression, "idle", 0.7, size, art);
        expect(primProblems(prims, box), `${expression}`).toEqual([]);
      }
      for (const action of ids("actions")) {
        for (const t of [0, 0.4, 0.9, 1.6, 2.3]) {
          const prims = previewCharacter(look, styles[(i + 1) % styles.length]!, "happy", action, t, size, art);
          expect(prims.length, action).toBeGreaterThan(25);
          expect(primProblems(prims, box), `${action} at ${t}`).toEqual([]);
        }
      }
    }
    // the same inputs always draw the same character
    const l = looks()[0]!;
    expect(previewCharacter(l, "bouncy", "happy", "wave", 1.1, 300, art)).toEqual(previewCharacter(l, "bouncy", "happy", "wave", 1.1, 300, art));
  });

  it("the same character looks the same in every story (the rig, not a picture)", () => {
    const l = looks()[2]!;
    const a = previewCharacter(l, "calm", "neutral", "idle", 0, 300, art);
    const b = previewCharacter(JSON.parse(JSON.stringify(l)) as CharacterLook, "calm", "neutral", "idle", 0, 300, art);
    expect(a).toEqual(b);
    const other = previewCharacter({ ...l, hair: { ...l.hair, color: "#00ff00" } }, "calm", "neutral", "idle", 0, 300, art);
    expect(other).not.toEqual(a);
  });
});
