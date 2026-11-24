// A person and a car in one story (docs/CONTRACTS.md §45.42): the script's own `cars`, drawn by the one car prop of a
// scene whose castId names it; the sentences validateScript gives the writer; getting in and out (outside, then in the
// seat, the road still meanwhile); a honk's own sound; the shape budget; repairScript and a car's faces; a car
// character's check; a seated rider's wave inside the window; and every car draft of the practice writer.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as characters from "../src/stories/api/mock/characters.ts";
import * as ideas from "../src/stories/api/mock/ideas.ts";
import { createStore, type MockStore } from "../src/stories/api/mock/store.ts";
import * as stories from "../src/stories/api/mock/stories.ts";
import type { Character, StoriesApi } from "../src/stories/api/types.ts";
import { CAR_CAST_SHAPES, DEFAULT_CAR } from "../src/stories/engine/car.ts";
import { drawFrame, ENGINE_VERSION, fitDuration, normalizeScript, repairScript, sceneShapes, validateCharacter, validateScript } from "../src/stories/engine/engine.ts";
import { FACES } from "../src/stories/engine/face.ts";
import { inFrame } from "../src/stories/engine/frame.ts";
import { actorState, STYLES } from "../src/stories/engine/motion.ts";
import { Pen } from "../src/stories/engine/pen.ts";
import { drawCharacter, geometry } from "../src/stories/engine/rig.ts";
import { RULES } from "../src/stories/engine/rules.ts";
import { drives, prepare, sceneRuntime } from "../src/stories/engine/scene.ts";
import { SHAPES } from "../src/stories/engine/script.ts";
import type { Beat, CarLook, CarMember, Prim, Scene, SceneActor, SceneProp, StoryScript } from "../src/stories/engine/types.ts";

const ENGINE = join(import.meta.dirname, "../src/stories/engine");
const raw = (name: string): StoryScript => JSON.parse(readFileSync(join(ENGINE, "fixtures", name), "utf8")) as StoryScript;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const base = raw("ice-skid.json");
const PIP = { ...clone(base.cast.c1!), name: "Pip" };
const PAINT = "#2a7bd8";
const rosso = (car: Partial<CarLook> = {}, extra: Partial<CarMember> = {}): CarMember => ({
  characterId: "chRosso",
  name: "Rosso",
  car: { ...clone(DEFAULT_CAR), paint: PAINT, ...car },
  movementStyle: "zippy",
  voice: { style: "none", pitch: 1, noises: [], sfx: ["engine", "honk"] },
  expressions: ["neutral"],
  ...extra,
});
const FACED = (): CarMember => rosso({ face: { eyes: "windscreen", color: "#1c1842", mouth: "grille" } }, { expressions: ["neutral", "happy", "surprised"] });

const carProp = (extra: Partial<SceneProp> = {}): SceneProp => ({ propId: "car1", kind: "car", castId: "c2", x: 0.56, y: 0.74, scale: 1, rot: 0, ...extra });
const rider = (extra: Partial<SceneActor> = {}): SceneActor => ({ castId: "c1", x: 0.16, y: 0.76, facing: "right", inCar: "car1", ...extra });

/** One scene with Pip (c1) and, unless `cars` is null, Rosso (c2). */
function script(scene: Partial<Scene>, cars: Record<string, CarMember> | null = { c2: rosso() }, seeded = true): StoryScript {
  const sc: Scene = { sceneId: "s1", title: "Test", durationSec: 6, ...(seeded ? { seed: 5 } : {}), set: "parking_lot", view: "side", camera: "wide", actors: [], props: [], beats: [], sfx: [], caption: null, note: null, ...scene };
  return { engine: ENGINE_VERSION, fps: 30, width: 1080, height: 1920, durationSec: sc.durationSec, title: "My first car", seed: 11, cast: { c1: clone(PIP) }, ...(cars ? { cars } : {}), scenes: [sc], music: null, captionsOn: false, captions: [], safety: null };
}

function errorsOf(s: unknown): string[] {
  const r = validateScript(s);
  return r.ok ? [] : r.errors;
}

function valid(s: unknown): StoryScript {
  const r = validateScript(s);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return normalizeScript(r.script);
}

/** Getting in at 0.5 s for 1.5 s, then the car speeds off. */
const boarding = (more: Beat[] = []): StoryScript =>
  script({
    set: "road_day",
    actors: [rider()],
    props: [carProp()],
    beats: [{ at: 0.5, dur: 1.5, who: "c1", do: "get_in" }, { at: 2.4, dur: 1.2, who: "car1", do: "speed_up" }, ...more],
  });

describe("the script's own cars (§45.42)", () => {
  it("a person and a car of the cast validate, draw, and the car shows in its own paint", () => {
    const s = valid(boarding());
    expect(s.cars?.c2?.name).toBe("Rosso");
    for (const f of [0, 40, 90, 150]) {
      const prims = drawFrame(s, f);
      expect(prims.length).toBeGreaterThan(20);
      expect(prims.some((p: Prim) => "color" in p && p.color === PAINT), `frame ${f}`).toBe(true);
    }
    // the same scene with a plain car prop instead never shows that paint
    const plain = valid(script({ set: "road_day", actors: [rider({ inCar: undefined })], props: [carProp({ castId: undefined })] }, null));
    expect(drawFrame(plain, 40).some((p: Prim) => "color" in p && p.color === PAINT)).toBe(false);
  });

  it("an older script without cars reads as before", () => {
    expect(errorsOf(raw("ice-skid.json"))).toEqual([]);
    expect(errorsOf(raw("sample-script.json"))).toEqual([]);
  });

  it("prepare makes a rig for the people only, never for a car", () => {
    const s = valid(boarding());
    expect([...prepare(s).geos.keys()]).toEqual(["c1"]);
  });

  it("at most 2 cars, each with an id of its own", () => {
    expect(errorsOf(script({}, { c2: rosso(), c3: rosso(), c4: rosso() }))).toEqual(["cars has 3 cars; the most is 2."]);
    expect(errorsOf(script({}, { c1: rosso() }))).toEqual(["c1 is both in cast and in cars; give the car its own id."]);
  });

  it("each car: its look, no voice, and the faces rule", () => {
    const bad = errorsOf(script({}, { c2: rosso({ body: "tank" as CarLook["body"] }) }));
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatch(/^cars\.c2: car\.body is "tank"; use one of hatchback, /);
    expect(errorsOf(script({}, { c2: rosso({}, { voice: { style: "babble", pitch: 1, noises: ["gasp"], sfx: [] } }) }))).toEqual([
      'cars.c2: a car has no voice: its voice.style is "none" and its voice.noises is []. Copy the saved car\'s voice.',
    ]);
    expect(errorsOf(script({}, { c2: rosso({}, { expressions: ["neutral", "happy", "sad"] }) }))).toEqual(['cars.c2: a car with no face keeps only the neutral face: expressions is ["neutral"].']);
    expect(errorsOf(script({}, { c2: { ...FACED(), expressions: ["neutral", "happy"] } }))[0]).toMatch(/^cars\.c2: expressions must be the car's own faces: at least 3 different faces/);
    expect(errorsOf(script({}, { c2: FACED() }))).toEqual([]);
  });

  it("a car is never an actor: it is a car prop with its castId", () => {
    expect(errorsOf(script({ actors: [{ castId: "c2", x: 0.5, y: 0.74, facing: "right" }] }))).toEqual(['scene 1 (s1): c2 (Rosso) is a car. Put it in props as {kind: "car", castId: "c2"}, not in actors.']);
  });

  it("castId only on a prop of kind car, naming one of the cars, once a scene", () => {
    expect(errorsOf(script({ props: [{ propId: "t1", kind: "truck", castId: "c2", x: 0.5, y: 0.74, scale: 1, rot: 0 }] }))).toEqual(['scene 1 (s1): prop t1 has castId c2; only a prop of kind "car" can be a car of the cast.']);
    expect(errorsOf(script({ props: [carProp({ castId: "c9" })] }))).toEqual(["scene 1 (s1): prop car1 has castId c9, which is not one of the cars. Use one of c2."]);
    expect(errorsOf(script({ props: [carProp({ castId: "c9" })] }, null))).toEqual(["scene 1 (s1): prop car1 has castId c9, which is not one of the cars. This story has no cars: leave castId out."]);
    expect(errorsOf(script({ props: [carProp(), carProp({ propId: "car2", x: 0.2 })] }))).toEqual(["scene 1 (s1): c2 is in two props; a car of the cast is one prop per scene."]);
  });

  it("a beat reaches the car by its prop id, never its cast id", () => {
    expect(errorsOf(script({ props: [carProp()], beats: [{ at: 0.5, dur: 1, who: "c2", do: "honk" }] }))).toEqual(['scene 1 (s1) beat 1: c2 (Rosso) is a car; reach it by its prop id "car1".']);
    expect(errorsOf(script({ beats: [{ at: 0.5, dur: 1, who: "c2", do: "honk" }] }))).toEqual(['scene 1 (s1) beat 1: c2 (Rosso) is a car; add a car prop with castId "c2" to this scene\'s props and reach it by that prop\'s id.']);
  });

  it("a car makes faces only when it has one, and only its own; repairScript takes the others away", () => {
    const faceBeat = (face: Beat["face"]): Partial<Scene> => ({ props: [carProp()], beats: [{ at: 0.5, dur: 1, who: "car1", do: "honk", face }] });
    expect(errorsOf(script(faceBeat("happy")))).toEqual(["scene 1 (s1), beat 1: Rosso has no face; leave face out."]);
    expect(errorsOf(script(faceBeat("angry"), { c2: FACED() }))).toEqual(['scene 1 (s1), beat 1: Rosso does not make the face "angry"; its own faces are neutral, happy and surprised. Use one of those, or leave face out.']);
    expect(errorsOf(script(faceBeat("happy"), { c2: FACED() }))).toEqual([]);
    // a plain car prop still takes no face at all
    expect(errorsOf(script({ props: [carProp({ castId: undefined })], beats: [{ at: 0.5, dur: 1, who: "car1", do: "honk", face: "happy" }] }))[0]).toMatch(/face "happy" is for characters only/);

    const faceless = repairScript(script(faceBeat("happy")));
    expect(faceless.changes).toEqual([{ sceneId: "s1", beat: 0, castId: "c2", field: "face", was: "happy", now: null, text: 'scene 1 (s1) beat 1: Rosso has no face, so its face "happy" is left out.' }]);
    expect((faceless.script as StoryScript).scenes[0]!.beats[0]).not.toHaveProperty("face");
    expect(errorsOf(faceless.script)).toEqual([]);
    const faced = repairScript(script(faceBeat("angry"), { c2: FACED() }));
    expect(faced.changes.map((c) => [c.castId, c.was, c.now])).toEqual([["c2", "angry", "neutral"]]);
    expect(errorsOf(faced.script)).toEqual([]);
    // a face it has is left alone
    expect(repairScript(script(faceBeat("happy"), { c2: FACED() })).changes).toEqual([]);
  });

  it("the shape budget counts a car of the cast as its own car", () => {
    const at = { set: "road_day", actors: [] };
    expect(SHAPES.carCast).toBe(CAR_CAST_SHAPES);
    expect(CAR_CAST_SHAPES).toBeLessThanOrEqual(64);
    expect(sceneShapes({ ...at, props: [carProp()] })).toBe(SHAPES.set + CAR_CAST_SHAPES);
    expect(sceneShapes({ ...at, props: [carProp({ castId: undefined })] })).toBe(SHAPES.set + 45);
  });
});

describe("getting in and out (§45.42)", () => {
  const rt = (s: StoryScript, t: number) => inFrame(s, () => sceneRuntime(s, prepare(s), 0, t));

  it("get_in and get_out need inCar", () => {
    const s = script({ actors: [rider({ inCar: undefined })], props: [carProp()], beats: [{ at: 0.5, dur: 1.5, who: "c1", do: "get_in" }] });
    expect(errorsOf(s)).toEqual(["scene 1 (s1): c1 gets in at 0.5 s but has no inCar. Give c1 inCar: the car's propId."]);
    const out = script({ actors: [rider({ inCar: undefined })], props: [carProp()], beats: [{ at: 1, dur: 1.5, who: "c1", do: "get_out" }] });
    expect(errorsOf(out)).toEqual(["scene 1 (s1): c1 gets out at 1 s but has no inCar. Give c1 inCar: the car's propId."]);
  });

  it("at most one of each, get_in first, 0.8 to 3 seconds each", () => {
    const beats = (list: [number, number, "get_in" | "get_out"][]) => script({ actors: [rider()], props: [carProp()], beats: list.map(([at, dur, d]) => ({ at, dur, who: "c1", do: d })) });
    expect(errorsOf(beats([[0.2, 1, "get_in"], [3, 1, "get_in"]]))).toEqual(["scene 1 (s1): c1 gets in 2 times; a character gets in at most once a scene."]);
    expect(errorsOf(beats([[0.2, 1, "get_out"], [3, 1, "get_out"]]))).toEqual(["scene 1 (s1): c1 gets out 2 times; a character gets out at most once a scene."]);
    expect(errorsOf(beats([[3, 1, "get_in"], [0.5, 1, "get_out"]]))).toEqual(["scene 1 (s1): c1 gets out at 0.5 s before getting in is done (4 s); get_in comes first, then get_out."]);
    expect(errorsOf(beats([[0.2, 0.5, "get_in"]]))).toEqual(["scene 1 (s1): c1's get_in lasts 0.5 s; getting in or out takes 0.8 to 3 seconds."]);
    expect(errorsOf(beats([[0.2, 3.5, "get_out"]]))).toEqual(["scene 1 (s1): c1's get_out lasts 3.5 s; getting in or out takes 0.8 to 3 seconds."]);
    expect(errorsOf(beats([[0.2, 1.2, "get_in"], [3, 1.5, "get_out"]]))).toEqual([]);
  });

  it("the car stays where it is while someone gets in or out", () => {
    const s = (car: Beat) => script({ actors: [rider()], props: [carProp()], beats: [{ at: 0.5, dur: 1.5, who: "c1", do: "get_in" }, car] });
    expect(errorsOf(s({ at: 1, dur: 1, who: "car1", do: "speed_up" }))).toEqual(["scene 1 (s1): car1 moves at 1 s while c1 is still getting in (until 2 s). Start the drive after get_in ends."]);
    expect(errorsOf(s({ at: 0.2, dur: 1, who: "car1", do: "move", to: { x: 0.7, y: 0.74 } }))).toEqual(["scene 1 (s1): car1 moves at 0.2 s while c1 is still getting in (until 2 s). Start the drive after get_in ends."]);
    expect(errorsOf(s({ at: 1, dur: 0.6, who: "car1", do: "stall", to: { x: 0.6, y: 0.74 } }))[0]).toMatch(/car1 moves at 1 s while c1 is still getting in/);
    // honking, flashing, a stop or stall in place, and a drive after it are fine
    for (const ok of [{ do: "honk" }, { do: "blink" }, { do: "stop" }, { do: "stall" }, { do: "bounce" }] as const) expect(errorsOf(s({ at: 1, dur: 0.6, who: "car1", ...ok })), ok.do).toEqual([]);
    expect(errorsOf(s({ at: 2, dur: 1, who: "car1", do: "speed_up" }))).toEqual([]);
    const out = script({ actors: [rider()], props: [carProp()], beats: [{ at: 3, dur: 1.5, who: "c1", do: "get_out" }, { at: 3.4, dur: 1, who: "car1", do: "skid" }] });
    expect(errorsOf(out)).toEqual(["scene 1 (s1): car1 moves at 3.4 s while c1 is still getting out (until 4.5 s). Stop the car before get_out starts."]);
  });

  it("the driver waves only while the car stands still; a passenger may wave any time", () => {
    const two = (beats: Beat[]) => {
      const s = script({ actors: [rider(), rider({ castId: "c3", x: 0.42 })], props: [carProp()], beats });
      s.cast.c3 = { ...clone(PIP), name: "Bo" }; // a passenger
      return s;
    };
    const drive: Beat = { at: 2.2, dur: 1.5, who: "car1", do: "speed_up" };
    const waveWhileMoving = "scene 1 (s1): c1 drives car1 and waves at 2.5 s while it moves (2.2 to 3.7 s). The driver waves only while the car is stopped: wave before it moves or after it stops, or let a passenger wave.";
    expect(errorsOf(two([{ at: 0.2, dur: 1.5, who: "c1", do: "get_in" }, drive, { at: 2.5, dur: 1, who: "c1", do: "wave" }]))).toEqual([waveWhileMoving]);
    // the passenger's wave, the driver's wave before the drive, and a wave from outside before getting in are fine
    expect(errorsOf(two([{ at: 0.2, dur: 1.5, who: "c1", do: "get_in" }, drive, { at: 2.5, dur: 1, who: "c3", do: "wave" }]))).toEqual([]);
    expect(errorsOf(two([{ at: 0.2, dur: 1.5, who: "c1", do: "get_in" }, { at: 1.8, dur: 0.4, who: "c1", do: "wave" }, { ...drive, at: 2.4 }]))).toEqual([]);
    expect(errorsOf(two([{ at: 0.1, dur: 0.8, who: "c1", do: "wave" }, { at: 1, dur: 1, who: "c1", do: "get_in" }, drive]))).toEqual([]);
  });

  it("before get_in the rider stands outside, walks to the door, then sits in its seat", () => {
    const s = valid(boarding());
    const before = rt(s, 0.3).actors[0]!;
    expect(before.seated).toBe(false);
    expect(before.st.x).toBeCloseTo(0.16, 2);
    const walking = rt(s, 1).actors[0]!;
    expect(walking.seated).toBe(false);
    expect(walking.st.x).toBeGreaterThan(0.2);
    // fading over the last quarter: both halves show
    const fading = rt(s, 1.8).actors[0]!;
    expect(fading.other).not.toBeNull();
    expect(fading.alpha + (fading.other?.alpha ?? 0)).toBeCloseTo(1, 5);
    const after = rt(s, 2.2);
    expect(after.actors[0]!.seated).toBe(true);
    expect(after.actors[0]!.other).toBeNull();
    expect(after.actors[0]!.st.x).toBeCloseTo(after.props[0]!.x, 5);
    // a frame with the rider outside draws them in front of the car; seated they are drawn through the window
    expect(drawFrame(s, 9).length).not.toBe(drawFrame(s, 75).length);
  });

  it("get_out: seated, then stepping out, then standing 0.08 away from the door", () => {
    const s = valid(script({ set: "road_day", actors: [rider({ x: 0.56, y: 0.74 })], props: [carProp()], beats: [{ at: 0.2, dur: 0.6, who: "car1", do: "stop" }, { at: 1.5, dur: 2, who: "c1", do: "get_out" }, { at: 4, dur: 1.5, who: "c1", do: "wave" }] }));
    expect(rt(s, 1).actors[0]!.seated).toBe(true);
    const out = rt(s, 4.5);
    const a = out.actors[0]!;
    expect(a.seated).toBe(false);
    expect(a.alpha).toBe(1);
    // the car faces right: the door is behind its middle, and the rider ends further back from it
    expect(a.st.x).toBeLessThan(out.props[0]!.x - 0.2);
    expect(a.st.active.some((b) => b.do === "wave")).toBe(true);
  });

  it("the road does not roll during get_in, and the car starts only when told", () => {
    const still = valid(script({ set: "road_day", actors: [rider()], props: [carProp()], beats: [{ at: 0.5, dur: 1.5, who: "c1", do: "get_in" }] }));
    for (const t of [0.2, 1, 1.9, 3, 5.5]) expect(rt(still, t).scroll, `t ${t}`).toBe(0);
    const s = valid(boarding());
    for (const t of [0.2, 1, 1.9, 2.3]) expect(rt(s, t).scroll, `t ${t}`).toBe(0);
    expect(Math.abs(rt(s, 4).scroll)).toBeGreaterThan(100);
    // with nobody getting in, a driven car rolls from the start, as before
    const driving = valid(script({ set: "road_day", actors: [rider({ x: 0.56, y: 0.74 })], props: [carProp()] }));
    expect(Math.abs(rt(driving, 1).scroll)).toBeGreaterThan(100);
  });

  it("a driver who gets out stops the road first", () => {
    const s = valid(script({ set: "road_day", actors: [rider({ x: 0.56, y: 0.74 })], props: [carProp()], beats: [{ at: 3, dur: 1.5, who: "c1", do: "get_out" }] }));
    const at = (t: number) => Math.abs(rt(s, t).scroll);
    expect(at(2)).toBeGreaterThan(0);
    expect(at(3.2)).toBeCloseTo(at(3), 0);
    expect(at(5.5)).toBeCloseTo(at(3), 0);
  });

  it("fitting the story's length keeps getting in and out to 0.8 to 3 seconds, and the script valid", () => {
    const s = (dur: number, sec: number) =>
      valid(script({ durationSec: sec, set: "road_day", actors: [rider()], props: [carProp()], beats: [{ at: 0.4, dur, who: "c1", do: "get_in" }, { at: 0.4 + dur, dur: 1, who: "car1", do: "speed_up" }] }));
    const longer = fitDuration(s(2.9, 6), 9);
    expect(longer.scenes[0]!.durationSec).toBe(9);
    expect(longer.scenes[0]!.beats.find((b) => b.do === "get_in")!.dur).toBe(3);
    expect(errorsOf(longer)).toEqual([]);
    const shorter = fitDuration(s(0.8, 6), 5.4);
    expect(shorter.scenes[0]!.beats.find((b) => b.do === "get_in")!.dur).toBe(0.8);
    expect(errorsOf(shorter)).toEqual([]);
  });

  it("a seated rider's wave keeps its hand inside the window", () => {
    const front = [-8, -168, -8, -276, 50, -278, 140, -168];
    const inside = (px: number, py: number) => {
      let c = false;
      for (let i = 0, j = front.length - 2; i < front.length; j = i, i += 2) {
        const [xi, yi, xj, yj] = [front[i]!, front[i + 1]!, front[j]!, front[j + 1]!];
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    const m = base.cast.c1!;
    const g = geometry(m.look);
    const seat = { x: 52, beltY: -168, topY: -276 };
    const s = (seat.beltY - 12 - (seat.topY + 8)) / (g.shoulderY - g.top);
    const y0 = seat.beltY - 12 - s * (g.shoulderY + g.thigh);
    const box = (action: "wave" | "idle") => {
      let x1 = -Infinity;
      let top = Infinity;
      for (let t = 0.3; t < 1.8; t += 0.1) {
        const st = actorState({ castId: "c1", x: 0.5, y: 0.72, facing: "right", inCar: "car1" }, action === "idle" ? [] : [{ at: 0, dur: 2, who: "c1", do: "wave" }], STYLES[m.movementStyle], g, 7, t, 216);
        const pen = new Pen({ x0: -2000, y0: -2000, x1: 2000, y1: 2000 });
        pen.translate(seat.x, y0);
        pen.scale(s);
        drawCharacter(pen, m.look, g, st.pose, { t, seed: 7, face: FACES.neutral, inCar: true });
        for (const p of pen.out) {
          const pts = p.k === "poly" || p.k === "line" ? p.pts : p.k === "circle" ? [p.x + p.r, p.y - p.r] : p.k === "ellipse" ? [p.x + Math.max(p.rx, p.ry), p.y - Math.max(p.rx, p.ry)] : p.k === "rect" ? [p.x + p.w, p.y] : [];
          for (let i = 0; i + 1 < pts.length; i += 2) {
            x1 = Math.max(x1, pts[i]!);
            top = Math.min(top, pts[i + 1]!);
          }
        }
      }
      return { x1, top };
    };
    const wave = box("wave");
    const idle = box("idle");
    // no higher than the window's top, and reaching no further forward than the rider already does
    expect(wave.top).toBeGreaterThanOrEqual(seat.topY);
    expect(wave.x1).toBeLessThanOrEqual(idle.x1 + 1);
    // the hand itself is inside the windscreen
    const hx = seat.x + (g.headRX * 0.75) * s;
    const hy = y0 + (g.headY + g.headRY * 0.45) * s;
    expect(inside(hx, hy)).toBe(true);
  });
});

describe("sounds and rules", () => {
  it("a honk beat on a car adds its honk by itself, once, and only to a new scene", () => {
    const s = script({ set: "road_day", actors: [rider({ x: 0.56, y: 0.74 })], props: [carProp()], beats: [{ at: 1, dur: 0.5, who: "car1", do: "honk" }, { at: 3, dur: 0.5, who: "car1", do: "honk", sfx: "honk" }, { at: 3.2, dur: 0.5, who: "car1", do: "honk" }] }, { c2: rosso() }, false);
    const n = valid(s);
    const honks = n.scenes[0]!.sfx.filter((c) => c.sfx === "honk");
    expect(honks).toEqual([
      { id: "s1.fx2", at: 1, sfx: "honk", volume: 0.8 },
      { id: "s1.fx1", at: 3, sfx: "honk", volume: 0.8 },
    ]);
    expect(normalizeScript(n)).toEqual(n);
    // the owner took one away: normalizing again never puts it back
    const edited = { ...n, scenes: [{ ...n.scenes[0]!, sfx: n.scenes[0]!.sfx.filter((c) => c.id !== "s1.fx2") }] };
    expect(normalizeScript(edited).scenes[0]!.sfx.filter((c) => c.sfx === "honk")).toHaveLength(1);
  });

  it("speeding up counts as driving (the engine hum)", () => {
    const sc = script({ set: "road_day", props: [carProp({ castId: undefined })], beats: [{ at: 1, dur: 1, who: "car1", do: "speed_up" }] }, null).scenes[0]!;
    expect(drives(sc)).toBe(true);
    expect(drives({ ...sc, beats: [{ at: 1, dur: 1, who: "car1", do: "honk" }] })).toBe(false);
  });

  it("the writer reads the car rules", () => {
    const rule = (id: string) => RULES.find((r) => r.id === id)?.text;
    expect(rule("car_cast")).toBe("A car of the cast is never an actor: it is a car prop with its castId. People ride in it with inCar set to that prop's propId.");
    expect(rule("get_in_out")).toBe("get_in and get_out need inCar, last 0.8 to 3 seconds, and happen while the car is parked. The car moves only after get_in ends.");
    expect(rule("honk")).toBe("honk adds the honk sound by itself.");
    expect(rule("driver_wave")).toBe("The driver waves only while the car is stopped; a passenger may wave any time.");
  });
});

describe("a car character's check (§45.41)", () => {
  const car = () => ({ kind: "car", name: "Rosso", description: "A small red hatchback.", personality: "Eager.", traits: ["quick"], car: clone(DEFAULT_CAR), movementStyle: "zippy", voice: { style: "none", pitch: 1, noises: [], sfx: ["engine", "honk"] }, expressions: ["neutral"] });
  const sentence = (input: unknown): string => {
    const r = validateCharacter(input);
    return r.ok ? "" : r.errors.join(" ");
  };

  it("a car with no face and only the neutral face is accepted; a person's look is not needed", () => {
    expect(validateCharacter(car())).toEqual({ ok: true });
    expect(validateCharacter({ ...car(), car: { ...DEFAULT_CAR, face: { eyes: "headlights", color: "#1c1842", mouth: "grille" } }, expressions: ["neutral", "happy", "worried"] })).toEqual({ ok: true });
  });

  it("refuses a voice, the wrong faces, a bad look and an unknown kind", () => {
    expect(sentence({ ...car(), voice: { style: "babble", pitch: 1, noises: [], sfx: [] } })).toBe("character Rosso: A car has no voice. Pick its sounds instead.");
    expect(sentence({ ...car(), voice: { style: "none", pitch: 1, noises: ["gasp"], sfx: [] } })).toBe("character Rosso: A car has no voice. Pick its sounds instead.");
    expect(sentence({ ...car(), expressions: ["neutral", "happy", "sad"] })).toBe("character Rosso: A car with no face keeps only the neutral face.");
    expect(sentence({ ...car(), car: { ...DEFAULT_CAR, face: { eyes: "windscreen", color: "#1c1842", mouth: "none" } } })).toMatch(/expressions must be at least 3 different faces/);
    expect(sentence({ ...car(), car: { ...DEFAULT_CAR, paint: "red" } })).toMatch(/car\.paint must be a colour/);
    expect(sentence({ ...car(), car: undefined })).toMatch(/car is missing/);
    expect(sentence({ ...car(), voice: { style: "none", pitch: 1, noises: [], sfx: Array.from({ length: 9 }, () => "honk") } })).toMatch(/voice\.sfx must be up to 8 known effects/);
    expect(sentence({ ...car(), kind: "boat" })).toBe("character Rosso: Pick a person or a car.");
  });

  it("a person is checked as before (with or without kind)", () => {
    const person = { name: "Pip", look: PIP.look, movementStyle: "calm", voice: PIP.voice, expressions: ["neutral", "happy", "sad"] };
    expect(validateCharacter(person)).toEqual({ ok: true });
    expect(validateCharacter({ ...person, kind: "person" })).toEqual({ ok: true });
    expect(validateCharacter({ ...person, kind: "person", look: undefined }).ok).toBe(false);
  });
});

// ---------- the practice writer's car stories ----------

describe("every car draft of the mock writer validates", () => {
  let store: MockStore;
  let api: StoriesApi;
  const ROSSO_ID = "01JSTCH00000000000000CAR99";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T12:00:00.000Z"));
    store = createStore();
    store.workspaces.push({ workspaceId: "stories", workspaceName: "Clips Funded", workspaceType: "stories", builtin: false, configuration: { defaultDurationSec: 45 }, version: 1 } as never);
    ideas.seed(store);
    characters.seed(store);
    stories.seed(store);
    const pip = store.characters.find((c) => c.characterId === stories.SEED_IDS.characters.pip)!;
    const car: Character = { ...clone(pip), characterId: ROSSO_ID, name: "Rosso", kind: "car", car: clone(DEFAULT_CAR), look: undefined, voice: { style: "none", pitch: 1, noises: [], sfx: ["engine", "honk"] }, expressions: ["neutral"] } as Character;
    store.characters.push(car);
    api = { ...ideas.api(store), ...characters.api(store), ...stories.api(store) } as StoriesApi;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function call<T>(p: Promise<T>): Promise<T> {
    const out = p.then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    await vi.advanceTimersByTimeAsync(1200);
    const r = await out;
    if (!r.ok) throw r.e;
    return r.v;
  }

  it("Pip and Rosso, every kind and length: three scenes or more, the car of the cast in each, all valid", async () => {
    const C = stories.SEED_IDS.characters;
    for (const category of ["comedy", "everyday_skills", "explainer"] as const)
      for (const durationSec of [15, 45, 90]) {
        const { story } = await call(api.createStory("stories", { characterIds: [C.pip, ROSSO_ID], durationSec, captionsOn: true, musicMood: "playful", brief: { title: "My first car", logline: "Pip buys a car and drives it.", category } }));
        stories.advanceJobs(store, Date.now() + 10 * 60_000);
        const s = store.scripts[story.storyId]!;
        expect(validateScript(s).ok, `${category} ${durationSec}`).toBe(true);
        expect(Object.keys(s.cast)).toEqual(["c1"]);
        expect(Object.keys(s.cars ?? {})).toEqual(["c2"]);
        expect(s.scenes.length).toBeGreaterThanOrEqual(3);
        expect(s.scenes.map((sc) => sc.title).slice(0, 2)).toEqual(["The new car", "Off we go"]);
        expect(s.scenes.at(-1)!.title).toBe("Oops");
        for (const sc of s.scenes) expect(sc.props.find((p) => p.propId === "car1")?.castId, sc.sceneId).toBe("c2");
        expect(s.scenes[0]!.beats.some((b) => b.who === "c1" && b.do === "get_in")).toBe(true);
        expect(s.scenes[1]!.sfx.some((c) => c.sfx === "honk")).toBe(true);
        for (const sc of s.scenes) for (const f of [0, Math.round(sc.durationSec * 15)]) expect(() => drawFrame({ ...s, scenes: [sc], durationSec: sc.durationSec }, f)).not.toThrow();
      }
  });

  it("the lead is the first person even when the car was picked first, and a driving-safety idea uses the cast's car", async () => {
    const C = stories.SEED_IDS.characters;
    const { story } = await call(api.createStory("stories", { characterIds: [ROSSO_ID, C.pip, C.bolt], durationSec: 30, brief: { title: "Rosso and pals", logline: "A ride.", category: "comedy" } }));
    stories.advanceJobs(store, Date.now() + 10 * 60_000);
    const s = store.scripts[story.storyId]!;
    expect(s.cast.c1!.characterId).toBe(C.pip);
    expect(s.cast.c2!.characterId).toBe(C.bolt);
    expect(s.cars!.c3!.characterId).toBe(ROSSO_ID);
    expect(validateScript(s).ok).toBe(true);
    const skid = await call(api.createStory("stories", { characterIds: [C.pip, ROSSO_ID], durationSec: 40, ideaId: stories.SEED_IDS.ideas.skid }));
    stories.advanceJobs(store, Date.now() + 20 * 60_000);
    const safe = store.scripts[skid.story.storyId]!;
    expect(validateScript(safe).ok).toBe(true);
    expect(safe.scenes.some((sc) => sc.props.some((p) => p.castId === "c2"))).toBe(true);
  });

  it("a car alone, or two cars, is refused in the API's words", async () => {
    const C = stories.SEED_IDS.characters;
    await expect(call(api.createStory("stories", { characterIds: [ROSSO_ID], brief: { title: "x", logline: "y", category: "comedy" } }))).rejects.toMatchObject({ status: 400, message: "Add someone to drive it." });
    store.characters.push({ ...clone(store.characters.find((c) => c.characterId === ROSSO_ID)!), characterId: "01JSTCH00000000000000CAR98", name: "Blue" });
    await expect(call(api.createStory("stories", { characterIds: [C.pip, ROSSO_ID, "01JSTCH00000000000000CAR98"], brief: { title: "x", logline: "y", category: "comedy" } }))).rejects.toMatchObject({ status: 400, message: "Pick one car." });
  });
});
