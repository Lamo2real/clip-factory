// The night drive drawing style's script side (docs/CONTRACTS.md §45.45): `script.art` and a scene's `cuts` between
// shots, the sentences validateScript gives the writer, normalizeScript's order, fitDuration's (and the mock's edit)
// scaling of cuts, the night estimates of sceneShapes, the palette's light (art.ts), the frame's style (inFrame,
// withArt), the catalog's lists and the rules the writer reads. A script without art or cuts is checked, normalized,
// fitted and drawn exactly as before.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as characters from "../src/stories/api/mock/characters.ts";
import * as ideas from "../src/stories/api/mock/ideas.ts";
import { createStore, type MockStore } from "../src/stories/api/mock/store.ts";
import * as stories from "../src/stories/api/mock/stories.ts";
import type { StoriesApi } from "../src/stories/api/types.ts";
import { cel, grade, ink, inkPx, lift, LIGHTS, lineUnits, ND, nightDrive, withWarm } from "../src/stories/engine/art.ts";
import { DEFAULT_CAR } from "../src/stories/engine/car.ts";
import { CATALOG } from "../src/stories/engine/catalog.ts";
import { drawFrame, ENGINE_VERSION, fitDuration, frameCount, normalizeScript, previewCar, previewCharacter, scaleCuts, sceneShapes, validateScript } from "../src/stories/engine/engine.ts";
import { F, inFrame, STUDIO_LIGHT, withArt } from "../src/stories/engine/frame.ts";
import { Pen } from "../src/stories/engine/pen.ts";
import { RULES } from "../src/stories/engine/rules.ts";
import { PROP_SHAPES_ND } from "../src/stories/engine/props.ts";
import { CUTS, LIMITS, SHAPES, SHAPES_ND, SHOT_CAR, SHOT_ESTIMATES } from "../src/stories/engine/script.ts";
import { SET_SHAPES_ND } from "../src/stories/engine/sets.ts";
import type { CarMember, Scene, ShotCue, StoryScript } from "../src/stories/engine/types.ts";

const ENGINE = join(import.meta.dirname, "../src/stories/engine");
const raw = (name: string): StoryScript => JSON.parse(readFileSync(join(ENGINE, "fixtures", name), "utf8")) as StoryScript;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const base = raw("ice-skid.json");
const PIP = { ...clone(base.cast.c1!), name: "Pip" };
const rosso = (): CarMember => ({ characterId: "chRosso", name: "Rosso", car: clone(DEFAULT_CAR), movementStyle: "zippy", voice: { style: "none", pitch: 1, noises: [], sfx: [] }, expressions: ["neutral"] });

/** One night drive scene (s2) on the road at night: Pip (c1) drives Rosso (car1, cast c2). */
function script(scene: Partial<Scene> = {}, extra: Partial<StoryScript> = {}): StoryScript {
  const sc: Scene = {
    sceneId: "s2",
    title: "Night",
    durationSec: 6,
    seed: 5,
    set: "road_night",
    view: "side",
    camera: "wide",
    actors: [{ castId: "c1", x: 0.5, y: 0.74, facing: "right", inCar: "car1" }],
    props: [{ propId: "car1", kind: "car", castId: "c2", x: 0.5, y: 0.74, scale: 1, rot: 0 }],
    beats: [],
    sfx: [],
    caption: null,
    note: null,
    ...scene,
  };
  return { engine: ENGINE_VERSION, fps: 30, width: 1080, height: 1920, durationSec: sc.durationSec, title: "At night", seed: 11, cast: { c1: clone(PIP) }, cars: { c2: rosso() }, scenes: [sc], music: null, captionsOn: false, captions: [], safety: null, art: "night_drive", ...extra };
}

function errorsOf(s: unknown): string[] {
  const r = validateScript(s);
  return r.ok ? [] : r.errors;
}

const cut = (at: number, shot: ShotCue["shot"], who?: string): ShotCue => ({ at, shot, ...(who ? { who } : {}) });

describe("script.art: the drawing style", () => {
  it("is optional, and only night_drive or classic", () => {
    expect(errorsOf(script())).toEqual([]);
    expect(errorsOf(script({}, { art: "classic" }))).toEqual([]);
    const { art: _art, ...none } = script();
    expect(errorsOf(none)).toEqual([]);
    expect(errorsOf(script({}, { art: "noir" as never }))).toEqual(['art must be "night_drive" or "classic" (the drawing style).']);
  });

  it("every fixture draws byte-identical with art missing and with art classic", () => {
    for (const name of ["ice-skid.json", "sample-script.json"]) {
      const s = raw(name);
      const n = frameCount(s);
      for (const f of [0, Math.floor(n / 3), Math.floor(n / 2), n - 1]) {
        expect(JSON.stringify(drawFrame({ ...s, art: "classic" }, f)), `${name} frame ${f}`).toBe(JSON.stringify(drawFrame(s, f)));
      }
    }
  });

  it("the previews draw classic unless asked, and put the frame's style back", () => {
    const look = base.cast.c1!.look;
    expect(JSON.stringify(previewCharacter(look, "calm", "happy", "idle", 0.5, 200, "classic"))).toBe(JSON.stringify(previewCharacter(look, "calm", "happy", "idle", 0.5, 200)));
    expect(JSON.stringify(previewCar(DEFAULT_CAR, "calm", "neutral", "idle", 0.5, 200, "classic"))).toBe(JSON.stringify(previewCar(DEFAULT_CAR, "calm", "neutral", "idle", 0.5, 200)));
    previewCharacter(look, "calm", "happy", "idle", 0.5, 200, "night_drive");
    previewCar(DEFAULT_CAR, "calm", "neutral", "idle", 0.5, 200, "night_drive");
    expect(F.art).toBe("classic");
    expect(F.light).toBe(STUDIO_LIGHT);
  });

  it("inFrame and withArt set the style and the studio light, and put both back", () => {
    expect(F.art).toBe("classic");
    inFrame({ width: 1080, height: 1920, art: "night_drive" }, () => {
      expect(F.art).toBe("night_drive");
      expect(nightDrive()).toBe(true);
      expect(F.light).toBe(LIGHTS.studio);
      withArt("classic", () => expect(nightDrive()).toBe(false));
      expect(F.art).toBe("night_drive");
    });
    inFrame({ width: 1080, height: 1920, art: "noir" }, () => expect(F.art).toBe("classic"));
    inFrame({ width: 1080, height: 1920 }, () => expect(F.art).toBe("classic"));
    withArt("night_drive", () => expect(F.art).toBe("night_drive"));
    expect(F.art).toBe("classic");
  });
});

describe("cuts between shots inside a scene", () => {
  it("are optional and checked only when there: up to 8, sorted, 0.6 s apart and before the end", () => {
    expect(errorsOf(script({ cuts: [] }))).toEqual([]);
    expect(errorsOf(script({ cuts: [cut(0, "road_behind"), cut(1.5, "driver_view"), cut(3, "face"), cut(4.2, "mirror")] }))).toEqual([]);
    expect(errorsOf(script({ cuts: [cut(3, "face"), cut(3.3, "mirror")] }))).toEqual(["Scene s2: cuts at 3 s and 3.3 s are too close; keep cuts at least 0.6 s apart."]);
    expect(errorsOf(script({ cuts: [cut(3, "face"), cut(2, "mirror")] }))).toEqual(["Scene s2: cuts must be in time order; the cut at 2 s comes after the one at 3 s."]);
    expect(errorsOf(script({ cuts: [cut(5.5, "face")] }))).toEqual(["Scene s2: the cut at 5.5 s is too near the end; cut before 5.4 s (0.6 s before the scene ends)."]);
    expect(errorsOf(script({ cuts: [cut(-1, "face")] }))).toEqual(["Scene s2: cut 1's at is -1; use seconds from the scene's start (0 or more)."]);
    expect(errorsOf(script({ cuts: [cut(1, "dolly" as never)] }))[0]).toMatch(/^Scene s2: cut 1's shot "dolly" is not a shot; use one of scene, driver_view, face, side_window, mirror, speed_dial, pedals, road_behind, road_wide\.$/);
    const nine = Array.from({ length: 9 }, (_, i) => cut(i * 0.6, "face"));
    expect(errorsOf(script({ durationSec: 8, cuts: nine }))).toContain("Scene s2: has 9 cuts; the most is 8.");
    expect(errorsOf(script({ cuts: "face" as never }))).toEqual(["Scene s2: cuts must be a list of up to 8 cuts { at, shot, who } (it may be empty)."]);
  });

  it("work in side views only", () => {
    expect(errorsOf(script({ view: "top", cuts: [cut(1, "face")] }))).toEqual(["Scene s2 is seen from above; cuts work in side views only."]);
  });

  it("who is an actor of the scene", () => {
    expect(errorsOf(script({ cuts: [cut(1, "face", "c1")] }))).toEqual([]);
    expect(errorsOf(script({ cuts: [cut(1, "face", "c9")] }))).toEqual(['Scene s2: the cut at 1 s is about "c9", who is not in this scene; use one of its actors (c1) or leave who out.']);
  });

  it("a shot from the car needs someone sitting in a car, on a road, and not while getting in or out", () => {
    const walking = { actors: [{ castId: "c1", x: 0.3, y: 0.74, facing: "right" as const }] };
    for (const shot of ["driver_view", "side_window", "mirror", "speed_dial", "pedals", "road_behind"] as const) {
      expect(errorsOf(script({ ...walking, cuts: [cut(1.5, shot)] })), shot).toEqual([`Scene s2: the shot "${shot}" at 1.5 s needs someone sitting in a car; nobody in this scene has inCar. Put the driver in a car, or use the whole scene.`]);
    }
    const boarding = { beats: [{ at: 0.4, dur: 2, who: "c1", do: "get_in" as const }] };
    expect(errorsOf(script({ ...boarding, cuts: [cut(1.5, "driver_view")] }))).toEqual(['Scene s2: the shot "driver_view" at 1.5 s needs someone sitting in a car; c1 is still getting in until 2.4 s. Cut after that, or use the whole scene.']);
    expect(errorsOf(script({ ...boarding, cuts: [cut(2.4, "driver_view")] }))).toEqual([]);
    // the shot lasts until the next cut: a cut back to the whole scene before getting in is fine
    expect(errorsOf(script({ beats: [{ at: 1, dur: 2, who: "c1", do: "get_in" }], cuts: [cut(0, "road_behind"), cut(1, "scene")] }))).toEqual([]);
    const out = { beats: [{ at: 4, dur: 1.5, who: "c1", do: "get_out" as const }] };
    expect(errorsOf(script({ ...out, cuts: [cut(3, "pedals")] }))).toEqual(['Scene s2: the shot "pedals" at 3 s needs someone sitting in a car; c1 gets out from 4 s. Cut back to the whole scene before that.']);
    expect(errorsOf(script({ ...out, cuts: [cut(3, "pedals"), cut(3.8, "scene")] }))).toEqual([]);
    expect(errorsOf(script({ set: "kitchen", cuts: [cut(1, "driver_view")] }))).toEqual(['Scene s2 is in the kitchen; the shot "driver_view" needs a road. Use a road place or another shot.']);
  });

  it("Down the road needs a road, and Face up close a person (in a car, the car shots' rules)", () => {
    expect(errorsOf(script({ cuts: [cut(1, "road_wide")] }))).toEqual([]);
    expect(errorsOf(script({ set: "kitchen", actors: [], props: [], cuts: [cut(1, "road_wide")] }))).toEqual(['Scene s2 is in the kitchen; the shot "road_wide" needs a road. Use a road place or another shot.']);
    expect(errorsOf(script({ set: "kitchen", actors: [{ castId: "c1", x: 0.4, y: 0.74, facing: "right" }], props: [], cuts: [cut(1, "face")] }))).toEqual([]);
    expect(errorsOf(script({ set: "kitchen", actors: [], props: [], cuts: [cut(1, "face")] }))).toEqual(['Scene s2: the shot "face" at 1 s needs a person in the scene; add an actor or use another shot.']);
    expect(errorsOf(script({ beats: [{ at: 0.4, dur: 2, who: "c1", do: "get_in" }], cuts: [cut(1, "face")] }))).toEqual(['Scene s2: the shot "face" at 1 s needs someone sitting in a car; c1 is still getting in until 2.4 s. Cut after that, or use the whole scene.']);
    expect(errorsOf(script({ cuts: [cut(1, "scene")] }))).toEqual([]);
  });

  it("normalizeScript sorts them and leaves a scene without cuts as it was", () => {
    const s = normalizeScript(script({ cuts: [cut(3, "face"), cut(1, "driver_view")] }));
    expect(s.scenes[0]!.cuts).toEqual([cut(1, "driver_view"), cut(3, "face")]);
    const plain = normalizeScript(script());
    expect("cuts" in plain.scenes[0]!).toBe(false);
    expect(normalizeScript(base)).toEqual(normalizeScript(clone(base)));
    expect(normalizeScript(base).scenes.some((sc) => "cuts" in sc)).toBe(false);
  });

  it("fitDuration scales them with their scene and drops any that breaks the 0.6 s rules", () => {
    const s = normalizeScript(script({ durationSec: 10, cuts: [cut(0, "road_behind"), cut(2, "driver_view"), cut(3, "face"), cut(8, "road_wide")] }));
    const shorter = fitDuration(s, 5);
    expect(shorter.scenes[0]!.durationSec).toBe(5);
    // 0, 1, 1.5 (only 0.5 s after 1: the later one is kept, it decides what shows from then on), 4 (before 4.4, 0.6 s
    // before the end: kept)
    expect(shorter.scenes[0]!.cuts).toEqual([cut(0, "road_behind"), cut(1.5, "face"), cut(4, "road_wide")]);
    expect(validateScript(shorter).ok).toBe(true);
    // a scene is at most 15 s: 10 s becomes 15, and its cuts 1.5 times later
    expect(fitDuration(s, 20).scenes[0]!.cuts).toEqual([cut(0, "road_behind"), cut(3, "driver_view"), cut(4.5, "face"), cut(12, "road_wide")]);
    // a cut that lands 0.6 s or less before the new end is dropped
    expect(fitDuration(normalizeScript(script({ durationSec: 10, cuts: [cut(9, "face")] })), 4).scenes[0]!.cuts).toEqual([]);
    expect("cuts" in fitDuration(normalizeScript(script()), 5).scenes[0]!).toBe(false);
    expect(scaleCuts([cut(1, "face"), cut(1.4, "mirror"), cut(2, "pedals")], 1, 3)).toEqual([cut(1.4, "mirror"), cut(2, "pedals")]);
  });

  it("a valid night script stays valid at every new length: a shot in the car never lands on getting in or out", () => {
    // getting out at 5.5 s, with the cut back to the whole scene the checks ask for just before it
    const out = script({ set: "highway_night", durationSec: 8, beats: [{ at: 5.5, dur: 1.5, who: "c1", do: "get_out" }], cuts: [cut(1, "road_behind"), cut(4.8, "driver_view"), cut(5.4, "scene")] });
    // getting in at the start, the face right after it
    const into = script({ set: "highway_night", durationSec: 8, beats: [{ at: 0, dur: 0.9, who: "c1", do: "get_in" }], cuts: [cut(1, "face"), cut(3, "driver_view"), cut(5, "mirror")] });
    for (const s of [out, into]) {
      expect(errorsOf(s)).toEqual([]);
      for (const target of [3, 4.5, 6, 7.2, 7.6, 7.9, 8.5, 10, 12, 15]) {
        const fit = fitDuration(normalizeScript(s), target);
        expect(errorsOf(fit), `${s.scenes[0]!.beats[0]!.do} fitted to ${target} s`).toEqual([]);
      }
    }
    // the cases that broke: 5 % shorter keeps the later cut back to the whole scene before getting out, and 75 %
    // turns the face that would show while getting in back into the whole scene
    expect(fitDuration(normalizeScript(out), 7.6).scenes[0]!.cuts).toEqual([cut(0.95, "road_behind"), cut(5.13, "scene")]);
    expect(fitDuration(normalizeScript(into), 6).scenes[0]!.cuts).toEqual([cut(0.75, "scene"), cut(2.25, "driver_view"), cut(3.75, "mirror")]);
    // the same with the scene given to scaleCuts directly (the mock's and the API's scene-length edits)
    const sc = normalizeScript(into).scenes[0]!;
    const beats = [{ ...sc.beats[0]!, dur: 0.8 }];
    expect(scaleCuts(sc.cuts!, 0.75, 6, { ...sc, beats })).toEqual([cut(0.75, "scene"), cut(2.25, "driver_view"), cut(3.75, "mirror")]);
    expect(scaleCuts(sc.cuts!, 0.75, 6)).toEqual([cut(0.75, "face"), cut(2.25, "driver_view"), cut(3.75, "mirror")]);
  });
});

describe("sceneShapes in night drive", () => {
  it("is the classic estimate in Bright and the larger of the scene's and each cut's shot in night drive", () => {
    const sc = script({ cuts: [cut(1, "driver_view")] }).scenes[0]!;
    expect(sceneShapes(sc)).toBe(sceneShapes(sc, "classic"));
    expect(sceneShapes(sc)).toBe(SHAPES.set + SHAPES.actor + SHAPES.carCast);
    // a place's own measured count (sets.ts SET_SHAPES_ND) wins over the flat night set estimate
    const whole = SET_SHAPES_ND[sc.set] + SHAPES_ND.actor + SHAPES_ND.carCast;
    expect(sceneShapes({ ...sc, cuts: undefined }, "night_drive")).toBe(whole);
    expect(sceneShapes({ ...sc, cuts: [cut(1, "pedals")] }, "night_drive")).toBe(whole);
    expect(sceneShapes(sc, "night_drive")).toBe(Math.max(whole, SHOT_ESTIMATES.driver_view));
    const traffic = { ...sc, props: [...sc.props, ...[2, 3, 4, 5, 6].map((i) => ({ propId: `t${i}`, kind: "car" as const, x: 0.1 * i, y: 0.7, scale: 1, rot: 0 }))] };
    expect(sceneShapes(traffic, "night_drive")).toBe(Math.max(whole + 5 * SHAPES_ND.props.car!, SHOT_ESTIMATES.driver_view + 4 * SHOT_CAR));
  });

  it("validateScript holds a night drive scene to night drive's own limit (560) with the night estimates", () => {
    const crowd = { set: "highway_night" as const, actors: [], props: Array.from({ length: 9 }, (_, i) => ({ propId: `t${i}`, kind: "car" as const, x: 0.1 * i, y: 0.7, scale: 1, rot: 0 })) };
    expect(errorsOf(script(crowd, { art: "classic" }))).toEqual([]);
    const about = SET_SHAPES_ND.highway_night + 9 * PROP_SHAPES_ND.car;
    expect(LIMITS.shapesNight).toBe(560);
    expect(about).toBeGreaterThan(LIMITS.shapesNight);
    expect(errorsOf(script(crowd)).join(" ")).toContain(`is too busy to draw quickly (about ${about} shapes at once; the most is 560). Use fewer cars or characters in it (a character is about 92 shapes, a car ${PROP_SHAPES_ND.car}, a small prop 14).`);
  });

  it("the busy scenes Bright allows fit night drive too: traffic round the own car, four people, three people and two cars", () => {
    const cast = { c1: clone(PIP), c3: { ...clone(PIP), name: "Ada" }, c4: { ...clone(PIP), name: "Bo" }, c5: { ...clone(PIP), name: "Cy" } };
    const car = (propId: string, x: number) => ({ propId, kind: "car" as const, x, y: 0.7, scale: 1, rot: 0 });
    const own = script().scenes[0]!.props[0]!;
    const rider = (castId: string) => ({ castId, x: 0.5, y: 0.74, facing: "right" as const, inCar: "car1" });
    const standing = (ids: string[]) => ids.map((castId, i) => ({ castId, x: 0.2 + i * 0.2, y: 0.8, facing: "right" as const }));
    const scenes = [
      // two kids in their car with two other cars on the highway at night (the reviewers' 488 of 480 before)
      { set: "highway_night" as const, actors: [rider("c1"), rider("c3")], props: [own, car("t1", 0.15), car("t2", 0.85)] },
      { set: "highway_night" as const, actors: standing(["c1", "c3", "c4", "c5"]), props: [] },
      { set: "highway_night" as const, actors: standing(["c1", "c3", "c4"]), props: [car("t1", 0.15), car("t2", 0.85)] },
    ];
    for (const sc of scenes) {
      const s = script(sc, { cast });
      expect(sceneShapes(s.scenes[0]!, "night_drive"), sc.actors.map((a) => a.castId).join(" ")).toBeGreaterThan(LIMITS.shapes);
      expect(errorsOf(s)).toEqual([]);
      expect(errorsOf({ ...s, art: "classic" })).toEqual([]);
    }
  });
});

describe("the palette's light (art.ts)", () => {
  const near = (a: string, b: string) => {
    const ch = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    return ch(a).every((v, i) => Math.abs(v - ch(b)[i]!) <= 4);
  };

  it("grade keeps the owner's colours in the studio light and lights them at night, deterministically", () => {
    for (const c of ["#f2c9a0", "#d8352a", "#123456", "#ffffff"]) expect(grade(c, LIGHTS.studio)).toBe(c);
    expect(near(grade("#f2c9a0", LIGHTS.night), "#af8f7a")).toBe(true);
    expect(near(grade("#d8352a", LIGHTS.night), "#932925")).toBe(true);
    expect(near(grade("#c9a227", LIGHTS.night), "#8e7428")).toBe(true);
    expect(near(grade("#4fb3ff", LIGHTS.day), "#5aa6de")).toBe(true);
    expect(grade("#d8352a", LIGHTS.night)).toBe(grade("#d8352a", LIGHTS.night));
    // a red car stays red at night, only darker; the lamps' pulse warms it
    const red = grade("#d8352a", LIGHTS.night);
    expect(parseInt(red.slice(1, 3), 16)).toBeGreaterThan(parseInt(red.slice(3, 5), 16) * 2);
    expect(grade("#d8352a", withWarm(LIGHTS.night, 1))).not.toBe(red);
  });

  it("the shading helpers, the line weights and the lamps' warm rim", () => {
    expect(cel("#ffffff")).toBe("#cbcacc");
    expect(cel("#ffffff", 0)).toBe("#ffffff");
    expect(lift("#000000")).toBe("#1a1a1a");
    expect(ink("#1c1842")).toBe("#231d2f");
    expect(ink(ND.ink)).toBe(ND.ink);
    expect(inkPx(5)).toBeCloseTo(2.3);
    expect(inkPx(13.5)).toBeCloseTo(3.15);
    expect(inkPx(0)).toBe(2);
    expect(inkPx(30)).toBe(3.6);
    const pen = new Pen();
    pen.scale(5);
    expect(lineUnits(pen, 2.3)).toBeCloseTo(0.46);
    expect(withWarm(LIGHTS.night, 1).rimA).toBeCloseTo(0.65);
    expect(withWarm(LIGHTS.day, 1).rimA).toBeCloseTo(LIGHTS.day.rimA);
    expect(LIGHTS.night.warm).toBe(0);
  });
});

describe("the catalog and the rules", () => {
  it("lists the drawing styles, the shots and the highway at night in plain words", () => {
    expect(CATALOG.arts).toEqual([
      { id: "night_drive", label: "Night drive" },
      { id: "classic", label: "Bright" },
    ]);
    expect(CATALOG.shots.map((s) => `${s.id}: ${s.label}`)).toEqual([
      "scene: Whole scene",
      "driver_view: Driver's eyes",
      "face: Face up close",
      "side_window: Side window",
      "mirror: Mirror",
      "speed_dial: Speed dial",
      "pedals: Feet on the pedals",
      "road_behind: Behind the car",
      "road_wide: Down the road",
    ]);
    expect(CATALOG.sets.at(-1)).toEqual({ id: "highway_night", label: "Highway at night" });
    expect(ENGINE_VERSION).toBe(8);
  });

  it("the writer reads what a cut is and what the shots show", () => {
    const text = Object.fromEntries(RULES.map((r) => [r.id, r.text]));
    expect(text.shots).toMatch(/^A scene can cut between shots while its action and sound go on: cuts is a list of \{at, shot, who\?\}/);
    expect(text.shots).toContain("Bubbles show beside the face in Face up close and Side window, and at the top in the other shots.");
    expect(text.shot_world).toContain("a car whose y is under 0.72 is in the other lane");
    expect(text.shot_world).toContain("brake lights the brake lights and drops the speed needle.");
  });
});

describe("the practice writer in night drive (the mock)", () => {
  let store: MockStore;
  let api: StoriesApi;
  const ROSSO = "01JSTCH00000000000000CAR98";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-24T12:00:00.000Z"));
    store = createStore();
    store.workspaces.push({ workspaceId: "stories", workspaceName: "Clips Funded", workspaceType: "stories", builtin: false, configuration: { defaultDurationSec: 45 }, version: 1 } as never);
    ideas.seed(store);
    characters.seed(store);
    stories.seed(store);
    const pip = store.characters.find((c) => c.characterId === stories.SEED_IDS.characters.pip)!;
    store.characters.push({ ...clone(pip), characterId: ROSSO, name: "Rosso", kind: "car", car: clone(DEFAULT_CAR), look: undefined, voice: { style: "none", pitch: 1, noises: [], sfx: ["engine", "honk"] }, expressions: ["neutral"] } as never);
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

  it("a new video is night drive by default, Bright when asked, and a wrong style is refused", async () => {
    const C = stories.SEED_IDS.characters;
    const brief = { title: "A night ride", logline: "Pip drives home at night.", category: "comedy" as const };
    const { story } = await call(api.createStory("stories", { characterIds: [C.pip], brief }));
    expect(story.art).toBe("night_drive");
    const bright = await call(api.createStory("stories", { characterIds: [C.pip], brief, art: "classic" }));
    expect(bright.story.art).toBe("classic");
    await expect(call(api.createStory("stories", { characterIds: [C.pip], brief, art: "noir" as never }))).rejects.toThrow("Pick a drawing style: Night drive or Bright.");
  });

  it("a car story at night: on the roads at night, with valid cuts, the pinned titles and the car of the cast in each", async () => {
    const C = stories.SEED_IDS.characters;
    for (const durationSec of [15, 45, 90]) {
      const { story } = await call(api.createStory("stories", { characterIds: [C.pip, ROSSO], durationSec, brief: { title: "My first car", logline: "Pip buys a car and drives it.", category: "comedy" } }));
      stories.advanceJobs(store, Date.now() + 10 * 60_000);
      const s = store.scripts[story.storyId]!;
      expect(validateScript(s).ok, `${durationSec}`).toBe(true);
      expect(s.art).toBe("night_drive");
      expect(s.scenes.map((sc) => sc.title).slice(0, 2)).toEqual(["The new car", "Off we go"]);
      expect(s.scenes.at(-1)!.title).toBe("Oops");
      for (const sc of s.scenes) expect(["road_night", "highway_night"]).toContain(sc.set);
      expect(s.scenes[0]!.beats.some((b) => b.who === "c1" && b.do === "get_in")).toBe(true);
      expect(s.scenes[1]!.sfx.some((c) => c.sfx === "honk")).toBe(true);
      for (const sc of s.scenes) {
        const cuts = sc.cuts ?? [];
        for (let i = 1; i < cuts.length; i += 1) expect(cuts[i]!.at - cuts[i - 1]!.at).toBeGreaterThanOrEqual(CUTS.gap - 1e-9);
      }
    }
  });

  it("a scene's new length scales its cuts as the engine does", async () => {
    const C = stories.SEED_IDS.characters;
    const { story } = await call(api.createStory("stories", { characterIds: [C.pip], brief: { title: "A night ride", logline: "Pip drives home at night.", category: "comedy" } }));
    stories.advanceJobs(store, Date.now() + 10 * 60_000);
    const s = store.scripts[story.storyId]!;
    const sc = s.scenes[0]!;
    sc.cuts = [cut(0, "face"), cut(Math.round(sc.durationSec * 5) / 10, "scene")];
    const want = scaleCuts(sc.cuts, 2 / sc.durationSec, 2);
    const got = await call(api.getStory("stories", story.storyId));
    await call(api.patchStory("stories", story.storyId, { version: got.story.version, scenes: [{ sceneId: sc.sceneId, durationSec: 2 }] }));
    expect(store.scripts[story.storyId]!.scenes[0]!.cuts).toEqual(want);
  });
});
