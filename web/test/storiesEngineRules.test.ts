// The Lamo Stories engine's script rules from the first review (CONTRACTS §45.10, §45.33): everyone in a car has a
// seat, a scene stays light enough to draw quickly, look and voice choices come from the catalog (the character
// agent's vocabulary) and a character check uses them, and each scene's frames depend on that scene alone.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG, drawFrame, LIMITS, normalizeScript, previewCharacter, sceneFrames, sceneShapes, SEATS, validateCharacter, validateScript } from "../src/stories/engine/engine.ts";
import { prng } from "../src/stories/engine/math.ts";
import { RULES } from "../src/stories/engine/rules.ts";
import type { ActionId, CameraId, CharacterLook, PropAction, PropKind, Scene, SetId, StoryScript } from "../src/stories/engine/types.ts";

const ENGINE = join(import.meta.dirname, "../src/stories/engine");
const raw = (name: string): StoryScript => JSON.parse(readFileSync(join(ENGINE, "fixtures", name), "utf8")) as StoryScript;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
/** The fewest faces a character may have (CONTRACTS §45.6 CharacterInput). */
const FACES3 = ["neutral", "happy", "surprised"];

function errorsOf(s: unknown): string[] {
  const r = validateScript(s);
  return r.ok ? [] : r.errors;
}

function valid(s: unknown): StoryScript {
  const r = validateScript(s);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return normalizeScript(r.script);
}

const base = raw("ice-skid.json");
const member = base.cast.c1!;
const castOf = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i + 1}`, { ...clone(member), characterId: `ch${i + 1}`, name: `Pal ${i + 1}` }]));

function oneScene(scene: Partial<Scene>, cast = 4): StoryScript {
  const sc: Scene = { sceneId: "s1", title: "Test", durationSec: 6, set: "road_day", view: "side", camera: "wide", actors: [], props: [], beats: [], sfx: [], caption: null, note: null, ...scene };
  return { engine: 3, fps: 30, width: 1080, height: 1920, durationSec: sc.durationSec, title: "Test", seed: 11, cast: castOf(cast) as StoryScript["cast"], scenes: [sc], music: null, captionsOn: false, captions: [], safety: null };
}

describe("seats", () => {
  it("a car seats 2 and a truck 1; one more is an error that says what to do", () => {
    expect(SEATS).toEqual({ car: 2, truck: 1 });
    const inCar = (kind: "car" | "truck", n: number) =>
      oneScene({
        props: [{ propId: "car1", kind, x: 0.5, y: 0.74, scale: 1, rot: 0 }],
        actors: Array.from({ length: n }, (_, i) => ({ castId: `c${i + 1}`, x: 0.5, y: 0.74, facing: "right" as const, inCar: "car1" })),
      });
    expect(errorsOf(inCar("car", 2))).toEqual([]);
    expect(errorsOf(inCar("truck", 1))).toEqual([]);
    expect(errorsOf(inCar("car", 3))).toEqual(["scene 1 (s1): car1 seats 2 people, but c1, c2, c3 sit in it. Put c3 in another car or outside it."]);
    expect(errorsOf(inCar("truck", 2))).toEqual(["scene 1 (s1): car1 seats 1 person, but c1, c2 sit in it. Put c2 in another car or outside it."]);
    expect(errorsOf(inCar("car", 4))[0]).toMatch(/Put c3 and c4 in another car or outside it\.$/);
  });

  it("everyone who sits in a car is drawn: each rider's face shows in the window", () => {
    for (const view of ["side", "top"] as const) {
      const s = valid(oneScene({ view, props: [{ propId: "car1", kind: "car", x: 0.5, y: 0.7, scale: 1, rot: 0 }], actors: [1, 2].map((i) => ({ castId: `c${i}`, x: 0.5, y: 0.7, facing: "right" as const, inCar: "car1" })) }, 2));
      const alone = valid(oneScene({ view, props: [{ propId: "car1", kind: "car", x: 0.5, y: 0.7, scale: 1, rot: 0 }], actors: [{ castId: "c1", x: 0.5, y: 0.7, facing: "right", inCar: "car1" }] }, 2));
      // a second rider adds shapes (their head) to the frame
      expect(drawFrame(s, 30).length, view).toBeGreaterThanOrEqual(drawFrame(alone, 30).length + 3);
    }
  });
});

describe("busy scenes", () => {
  const kinds = CATALOG.props.map((p) => p.id) as PropKind[];
  const actions: ActionId[] = ["celebrate", "dance", "walk", "fall", "wave", "jump", "run"];
  const propActions: PropAction[] = ["move", "skid", "spin", "bump", "tyre_burst", "appear", "wobble", "flash"];

  it("the busiest scenes the first review found are now refused with a sentence the writer can act on", () => {
    const crowd = (kind: PropKind, view: "side" | "top", set: SetId) =>
      oneScene({
        set,
        view,
        actors: [1, 2, 3, 4].map((i) => ({ castId: `c${i}`, x: 0.15 + i * 0.15, y: 0.74, facing: "right" as const })),
        props: Array.from({ length: 12 }, (_, i) => ({ propId: `p${i}`, kind, x: 0.1 + (i % 4) * 0.25, y: 0.4 + Math.floor(i / 4) * 0.2, scale: 1, rot: 0 })),
        beats: [1, 2, 3, 4].map((i) => ({ at: 0.2, dur: 5, who: `c${i}`, do: "celebrate" as const })),
      });
    for (const [kind, view, set] of [
      ["car", "side", "road_night"],
      ["deer", "side", "country_road"],
      ["truck", "top", "highway"],
      ["sparkles", "side", "studio"],
    ] as const) {
      const errors = errorsOf(crowd(kind, view, set));
      expect(errors, `${kind} ${view}`).toHaveLength(1);
      expect(errors[0]).toMatch(/^scene 1 \(s1\): is too busy to draw quickly \(about \d+ shapes at once; the most is 480\)\. Use fewer /);
    }
    expect(errorsOf(crowd("car", "side", "road_night"))[0]).toContain("Use fewer cars or characters in it");
  });

  // in both drawing styles: Bright (no art, as before) and night drive (CONTRACTS §45.45), with night drive's estimates
  for (const art of ["classic", "night_drive"] as const)
  it(`a scene the budget allows really draws within it: 300 random valid scenes, every other frame${art === "classic" ? "" : " (night drive)"}`, () => {
    const rnd = prng(20261121);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;
    const sets = CATALOG.sets.map((s) => s.id) as SetId[];
    const cameras = CATALOG.cameras.map((c) => c.id) as CameraId[];
    let tried = 0;
    let checked = 0;
    let worst = 0;
    while (checked < 300 && tried < 5000) {
      tried += 1;
      const view = rnd() < 0.5 ? "side" : "top";
      const nActors = Math.floor(rnd() * 5);
      const nProps = Math.floor(rnd() * 13);
      const props = Array.from({ length: nProps }, (_, i) => ({ propId: `p${i}`, kind: pick(kinds), x: 0.1 + rnd() * 0.8, y: 0.3 + rnd() * 0.55, scale: 0.6 + rnd() * 0.8, rot: Math.round(rnd() * 40 - 20) }));
      const actors = Array.from({ length: nActors }, (_, i) => ({ castId: `c${i + 1}`, x: 0.1 + rnd() * 0.8, y: 0.62 + rnd() * 0.2, facing: rnd() < 0.5 ? ("left" as const) : ("right" as const) }));
      const beats = [
        ...actors.map((a) => ({ at: 0.1, dur: 5.5, who: a.castId, do: pick(actions), face: "laughing" as const, bubble: pick(["heart", "exclaim", "idea", "dots"] as const), noise: "yay" as const })),
        ...props.map((p, i) => {
          const act = pick(propActions);
          return { at: (i % 4) * 1.3, dur: 1.2, who: p.propId, do: act, ...(act === "move" || act === "skid" ? { to: { x: p.x + 0.05, y: p.y - 0.05 }, dir: "right" as const } : {}) };
        }),
      ];
      const one = oneScene({ set: pick(sets), view, camera: pick(cameras), actors, props, beats });
      const s = art === "classic" ? one : { ...one, art };
      if (errorsOf(s).length) continue;
      const n = valid(s);
      const estimate = sceneShapes(n.scenes[0]!, art);
      for (let f = 0; f < 180; f += 2) {
        const count = drawFrame(n, f).length;
        worst = Math.max(worst, count);
        expect(count, `scene ${checked} (estimate ${estimate}) frame ${f}`).toBeLessThanOrEqual(LIMITS.shapes + 40);
      }
      checked += 1;
    }
    expect(checked).toBe(300);
    expect(worst).toBeGreaterThan(250);
    // 300 scenes x 90 frames each takes about 6 s on a CI runner (night drive about twice that), past vitest's 5 s
    // default.
  }, art === "classic" ? 30_000 : 60_000);

  it("every scene of the fixtures is well inside the budget", () => {
    for (const name of ["sample-script.json", "ice-skid.json"]) for (const sc of raw(name).scenes) expect(sceneShapes(sc), `${name} ${sc.sceneId}`).toBeLessThanOrEqual(400);
  });
});

describe("looks and voices come from the catalog", () => {
  const look = (): CharacterLook => clone(member.look);
  const lists: [string, { id: string }[], (l: CharacterLook, v: string) => void][] = [
    ["body", CATALOG.looks.body, (l, v) => (l.body = v as CharacterLook["body"])],
    ["hair", CATALOG.looks.hair, (l, v) => (l.hair.style = v as CharacterLook["hair"]["style"])],
    ["eyes", CATALOG.looks.eyes, (l, v) => (l.eyes.shape = v as CharacterLook["eyes"]["shape"])],
    ["brows", CATALOG.looks.brows, (l, v) => (l.brows = v as CharacterLook["brows"])],
    ["nose", CATALOG.looks.nose, (l, v) => (l.nose = v as CharacterLook["nose"])],
    ["mouth", CATALOG.looks.mouth, (l, v) => (l.mouth = v as CharacterLook["mouth"])],
    ["pattern", CATALOG.looks.pattern, (l, v) => (l.outfit.pattern = v as CharacterLook["outfit"]["pattern"])],
    ["accessory", CATALOG.looks.accessory, (l, v) => (l.accessory = v as CharacterLook["accessory"])],
  ];

  for (const [key, entries, set] of lists) {
    it(`every ${key} in the catalog is accepted, draws its own way, and anything else is refused`, () => {
      const drawn = new Set<string>();
      for (const { id } of entries) {
        const l = look();
        set(l, id);
        const s = { ...clone(base), cast: { ...clone(base.cast), c1: { ...clone(member), look: l } } };
        expect(errorsOf(s), `${key} ${id}`).toEqual([]);
        expect(validateCharacter({ look: l, movementStyle: member.movementStyle, voice: member.voice, expressions: FACES3 })).toEqual({ ok: true });
        // a few moments, so a blink in one of them cannot hide the eyes
        drawn.add(JSON.stringify([0.5, 1.1, 2.3].map((t) => previewCharacter(l, "calm", "neutral", "idle", t, 400))));
      }
      expect(drawn.size, `${key}: each choice looks different`).toBe(entries.length);
      const l = look();
      set(l, "sparkly");
      const r = validateCharacter({ look: l, movementStyle: member.movementStyle, voice: member.voice, expressions: FACES3 });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.errors.join(" ")).toContain(entries.map((e) => e.id).join(", "));
    });
  }

  it("every voice style in the catalog is accepted, and the sentence lists them", () => {
    for (const { id } of CATALOG.looks.voiceStyle) expect(validateCharacter({ look: member.look, movementStyle: "calm", voice: { ...member.voice, style: id }, expressions: FACES3 })).toEqual({ ok: true });
    const r = validateCharacter({ look: member.look, movementStyle: "calm", voice: { ...member.voice, style: "opera" }, expressions: FACES3 });
    expect(r).toEqual({ ok: false, errors: ["character: voice.style must be babble, hum or none."] });
  });

  it("checks a character agent's answer: faces, movement style and name", () => {
    const good = { name: "Lamo", look: member.look, movementStyle: "bouncy", voice: member.voice, expressions: ["neutral", "happy", "shocked"] };
    expect(validateCharacter(good)).toEqual({ ok: true });
    expect(validateCharacter(null)).toEqual({ ok: false, errors: ["The character must be a JSON object { name, description, personality, traits, movementStyle, expressions, look, voice }."] });
    const bad = validateCharacter({ ...good, movementStyle: "floaty", expressions: ["happy", "sad"], name: "x".repeat(31) });
    expect(bad.ok).toBe(false);
    const errors = bad.ok ? [] : bad.errors;
    expect(errors.some((e) => /name must be 1 to 30 characters/.test(e))).toBe(true);
    expect(errors.some((e) => /movementStyle is "floaty"; use one of bouncy/.test(e))).toBe(true);
    expect(errors.some((e) => /expressions must be at least 3 different faces of neutral, happy/.test(e))).toBe(true);
    expect(validateCharacter({ ...good, expressions: ["happy", "sad", "proud"] }).ok).toBe(false);
    expect(validateCharacter({ ...good, expressions: ["neutral", "happy", "happy"] }).ok).toBe(false);
    expect(validateCharacter({ ...good, look: undefined }).ok).toBe(false);
  });

  // a CharacterInput (CONTRACTS §45.6): expressions are required, and its texts keep their lengths
  const good = () => ({ name: "Lamo", description: "A round, cheerful driver.", personality: "Calm and kind.", traits: ["careful", "funny"], look: member.look, movementStyle: "calm", voice: member.voice, expressions: ["neutral", "happy", "worried"] });
  const sentence = (input: unknown): string => {
    const r = validateCharacter(input);
    return r.ok ? "" : r.errors.join(" ");
  };
  it("a whole CharacterInput is accepted", () => {
    expect(validateCharacter(good())).toEqual({ ok: true });
  });
  it("a character with no expressions is refused", () => {
    const { expressions: _, ...rest } = good();
    expect(sentence(rest)).toMatch(/expressions must be at least 3 different faces of .*, with neutral among them/);
    expect(sentence({ ...good(), expressions: [] })).toMatch(/expressions must be at least 3/);
    expect(sentence({ ...good(), expressions: "neutral" })).toMatch(/expressions must be at least 3/);
  });
  it("a description or personality over 400 characters is refused", () => {
    expect(sentence({ ...good(), description: "x".repeat(900) })).toMatch(/description must be text of at most 400 characters \(it has 900\)/);
    expect(sentence({ ...good(), personality: "y".repeat(401) })).toMatch(/personality must be text of at most 400 characters/);
    expect(sentence({ ...good(), description: 7 })).toMatch(/description must be text/);
    expect(validateCharacter({ ...good(), description: "x".repeat(400), personality: "" })).toEqual({ ok: true });
  });
  it("more than 8 traits, or a trait over 30 characters, is refused", () => {
    expect(sentence({ ...good(), traits: Array.from({ length: 20 }, (_, i) => `trait ${i} ${"z".repeat(42)}`) })).toMatch(/traits must be up to 8/);
    expect(sentence({ ...good(), traits: Array.from({ length: 9 }, (_, i) => `t${i}`) })).toMatch(/traits must be up to 8/);
    expect(sentence({ ...good(), traits: ["x".repeat(31)] })).toMatch(/at most 30 characters each/);
    expect(sentence({ ...good(), traits: [3] })).toMatch(/traits must be/);
    expect(validateCharacter({ ...good(), traits: Array.from({ length: 8 }, () => "x".repeat(30)) })).toEqual({ ok: true });
  });
});

describe("each scene draws from its own time only", () => {
  it("changing one scene's length leaves every other scene's frames exactly as they were", () => {
    const a = valid(base);
    const longer = clone(base);
    // scene 2 grows from 5 s to 6.2 s, its beats and effects moved with it
    const k = 6.2 / longer.scenes[1]!.durationSec;
    longer.scenes[1] = { ...longer.scenes[1]!, durationSec: 6.2, beats: longer.scenes[1]!.beats.map((b) => ({ ...b, at: b.at * k, dur: b.dur * k })) };
    longer.durationSec += 1.2;
    longer.captions = longer.captions.map((c) => (c.at >= 9 ? { ...c, at: c.at + 1.2 } : c));
    const b = valid(longer);
    for (const sc of a.scenes) {
      if (sc.sceneId === "s2") continue;
      const [fa, ta] = sceneFrames(a, sc.sceneId);
      const [fb] = sceneFrames(b, sc.sceneId);
      for (let f = 0; f < ta - fa; f += 7) expect(drawFrame(b, fb + f), `${sc.sceneId} frame ${f}`).toEqual(drawFrame(a, fa + f));
    }
  });

  it("remaking one scene (a new seed) changes only that scene", () => {
    const a = valid(base);
    const b = valid({ ...clone(base), scenes: base.scenes.map((sc) => (sc.sceneId === "s4" ? { ...sc, seed: 99 } : sc)) });
    for (const sc of a.scenes) {
      const [from, to] = sceneFrames(a, sc.sceneId);
      const same = [from, Math.floor((from + to) / 2), to - 1].every((f) => JSON.stringify(drawFrame(a, f)) === JSON.stringify(drawFrame(b, f)));
      expect(same, sc.sceneId).toBe(sc.sceneId !== "s4");
    }
  });
});

describe("the rules the writer reads (§45.43)", () => {
  it("every rule has its own id, the car rules among them, and a script holds at most 2 cars", () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["skid_dir", "spin_dir", "side_dir", "top_rot", "steering", "coordinates", "arrow_rot", "prop_state", "sounds", "own_faces", "car_cast", "get_in_out", "honk", "driver_wave", "frame_shape", "shots", "shot_world"]);
    expect(LIMITS.cars).toBe(2);
    expect(SEATS.car).toBe(2);
  });
});
