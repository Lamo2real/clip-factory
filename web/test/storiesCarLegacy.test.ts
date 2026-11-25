// The legacy golden (the "Realistic vehicles" work, WP-0). A vehicle look WITHOUT `detail` must draw byte for byte as
// it did before that work, in every view and both styles. This file was written from the untouched engine and its
// fixture (fixtures/stories-car-legacy.json) holds one sha256 per group of draw lists. It is never rewritten
// afterwards: a changed hash means the classic drawing changed. (STORIES_GOLDENS=write only makes the fixture when it
// does not exist yet, on the untouched code.)
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIGHTS, withWarm, type Light } from "../src/stories/engine/art.ts";
import { CAR_CAST_SHAPES, CAR_CAST_SHAPES_ND, CAR_VIEW_SHAPES, DEFAULT_CAR, type CarDraw } from "../src/stories/engine/car.ts";
import { drawCarView, drawPropView, plainCarLook } from "../src/stories/engine/carView.ts";
import { CATALOG } from "../src/stories/engine/catalog.ts";
import { drawFrame, ENGINE_VERSION, FORMATS, normalizeScript, previewCar, sceneShapes, validateScript, type CarMove } from "../src/stories/engine/engine.ts";
import { F, inFrame } from "../src/stories/engine/frame.ts";
import { Pen } from "../src/stories/engine/pen.ts";
import { drawProp, propState, type Occupants } from "../src/stories/engine/props.ts";
import type { ArtStyle, Beat, CarLook, CarMember, CastMember, CharacterLook, PropAction, Scene, SceneProp, ShotCue, ShotId, StoryScript } from "../src/stories/engine/types.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "stories-car-legacy.json");
const CL = CATALOG.carLooks;
const ids = <T extends string>(list: { id: T }[]): T[] => list.map((e) => e.id);
const NIGHT = withWarm(LIGHTS.night, 1);

/** Looks that use every catalog choice at least once (each list cycled), with or without eyes. */
function looks(eyes: boolean): CarLook[] {
  const lists = [ids(CL.body), ids(CL.pattern), ids(CL.windows), ids(CL.wheels), ids(CL.frontLights), ids(CL.rearLights), ids(CL.extra), ids(CL.eyes), ids(CL.mouth)];
  const n = Math.max(...lists.map((l) => l.length));
  const out: CarLook[] = [];
  for (let i = 0; i < n; i += 1) {
    const pick = <T>(l: T[]) => l[i % l.length]!;
    const eye = pick(ids(CL.eyes));
    out.push({
      body: pick(ids(CL.body)),
      length: [0.85, 1, 1.15][i % 3]!,
      height: [1.15, 0.85, 1][i % 3]!,
      paint: ["#d8352a", "#2f6fd1", "#f2c230", "#1f1f24"][i % 4]!,
      accent: ["#f4f1ea", "#1c1842", "#47d6a0"][i % 3]!,
      pattern: pick(ids(CL.pattern)),
      windows: pick(ids(CL.windows)),
      wheels: { style: pick(ids(CL.wheels)), rim: "#c9ccd2", size: [0.85, 1, 1.2][i % 3]! },
      lights: { front: pick(ids(CL.frontLights)), rear: pick(ids(CL.rearLights)) },
      extra: pick(ids(CL.extra)),
      face: { eyes: eyes ? (eye === "none" ? "windscreen" : eye) : "none", color: "#1c1842", mouth: pick(ids(CL.mouth)) },
      outline: "#1c1842",
    });
  }
  return out;
}

/** Every look group the golden covers, each hashed on its own so a failure names the group. */
const GROUPS: Record<string, CarLook[]> = {
  withEyes: looks(true),
  noEyes: looks(false),
  default: [DEFAULT_CAR],
  bodies: ids(CL.body).map((body) => ({ ...DEFAULT_CAR, body })),
};

const MOVES: (PropAction | null)[] = [null, "move", "stop", "honk", "blink", "tyre_burst"];
const TIMES = [0.3, 0.9, 1.5];
const ART_MODES: { name: string; art: ArtStyle; light: Light | null; night: boolean }[] = [
  { name: "bright", art: "classic", light: null, night: false },
  { name: "bright-lights", art: "classic", light: null, night: true },
  { name: "night-drive", art: "night_drive", light: NIGHT, night: true },
  { name: "night-drive-day", art: "night_drive", light: LIGHTS.studio, night: false },
];

function inMode<T>(m: (typeof ART_MODES)[number], fn: () => T): T {
  return inFrame({ width: 1080, height: 1920, art: m.art }, () => {
    if (m.light) F.light = m.light;
    return fn();
  });
}

/** The people a car of the cast carries: one rect per seat, so the seat positions are part of the hash. */
const RIDERS: Occupants = {
  side: (pen, seats) => {
    for (const s of seats) pen.rect(s.x - 5, s.topY, 10, s.beltY - s.topY, 2, "#abcdef");
  },
  top: (pen, seats) => {
    for (const s of seats) pen.circle(s.x, s.y, s.r, "#fedcba");
  },
};

function sideTopHash(cars: CarLook[]): string {
  const h = createHash("sha256");
  for (const car of cars) {
    for (const m of ART_MODES) {
      for (const view of ["side", "top"] as const) {
        for (const act of MOVES) {
          for (const t of TIMES) {
            const prop: SceneProp = { propId: "rosso", kind: "car", x: 0.5, y: 0.72, scale: 0.8, rot: 0, castId: "c2" };
            const beats: Beat[] = act ? [{ at: 0.2, dur: 1.6, who: "rosso", do: act, dir: "right", face: "surprised", ...(act === "move" || act === "stop" ? { to: { x: 0.62, y: 0.7 } } : {}) }] : [];
            const d: CarDraw = { car, style: "bouncy", seed: 11 };
            const prims = inMode(m, () => {
              const st = propState(prop, beats, view, t, { braking: act === "stop" ? 0.6 : 0, steer: 0.2, rolled: t * 300 }, d);
              if (!act) st.face = "happy";
              const pen = new Pen();
              drawProp(pen, st, view, t, 3, RIDERS, m.night, d);
              return pen.out;
            });
            h.update(JSON.stringify(prims));
          }
        }
      }
    }
  }
  return h.digest("hex");
}

function endViewHash(cars: CarLook[]): string {
  const h = createHash("sha256");
  const lightsOf = [
    { braking: 0, lights: false },
    { braking: 0, lights: true },
    { braking: 1, lights: true },
  ];
  for (const car of cars) {
    for (const view of ["back", "front"] as const) {
      for (const side of [-0.7, 0.7]) {
        for (const lt of lightsOf) {
          for (const truck of [false, true]) {
            const pen = new Pen();
            inMode(ART_MODES[2]!, () => {
              drawCarView(pen, car, view, { x: 540, y: 1200, w: 300, side, light: NIGHT, braking: lt.braking, lights: lt.lights, blink: 0.5, face: car.face.eyes === "none" ? null : "happy", t: 0.7, seed: 5, truck });
            });
            h.update(JSON.stringify(pen.out));
          }
        }
      }
    }
  }
  return h.digest("hex");
}

// ---- one frame of each shot with a classic own car, both styles ---------------------------------------------------

const SKIN = "#e1c2a4";
const person = (): CharacterLook => ({
  body: "tall",
  skin: SKIN,
  height: 1,
  width: 1,
  hair: { style: "curly", color: "#3c2a1b" },
  eyes: { shape: "round", color: "#1c1842" },
  brows: "thick",
  nose: "button",
  mouth: "wide",
  outfit: { top: "#b5402f", bottom: "#2e3d5c", accent: "#6f4e37", pattern: "plain" },
  accessory: "none",
  outline: "#1c1842",
});
const member = (id: string): CastMember => ({ characterId: id, name: id, look: person(), movementStyle: "calm", voice: { style: "babble", pitch: 1, noises: ["gasp", "hmm"], sfx: [] } });
const ownCar = (car: CarLook): CarMember => ({ characterId: "car-k1", name: "Rusty", car, movementStyle: "calm", voice: { style: "none", pitch: 1, noises: [], sfx: [] }, expressions: ["neutral"] });
const CLASSIC_OWN: CarLook = { body: "estate", length: 1, height: 1, paint: "#a39a6b", accent: "#e6e2d8", pattern: "plain", windows: "tinted", wheels: { style: "alloy", rim: "#c9ced8", size: 1 }, lights: { front: "square", rear: "bar" }, extra: "none", face: { eyes: "none", color: "#1c1842", mouth: "none" }, outline: "#1c1842" };
const SHOTS = CATALOG.shots.map((e) => e.id).filter((id): id is Exclude<ShotId, "scene"> => id !== "scene");

function drive(cuts: ShotCue[]): Scene {
  return {
    sceneId: "s1",
    title: "Drive",
    durationSec: 6,
    set: "highway_night",
    view: "side",
    camera: "wide",
    actors: [{ castId: "c1", x: 0.4, y: 0.78, facing: "right", inCar: "car1" }],
    props: [
      { propId: "car1", kind: "car", x: 0.4, y: 0.78, scale: 1, rot: 0, castId: "k1" },
      { propId: "car2", kind: "car", x: 0.7, y: 0.66, scale: 0.9, rot: 0 },
      { propId: "car3", kind: "car", x: 0.18, y: 0.79, scale: 0.9, rot: 0 },
      { propId: "truck1", kind: "truck", x: 0.9, y: 0.79, scale: 0.9, rot: 0 },
    ],
    beats: [
      { at: 0.2, dur: 1, who: "c1", do: "drive", face: "worried" },
      { at: 1.4, dur: 1, who: "car1", do: "speed_up" },
      { at: 2.6, dur: 1, who: "c1", do: "brake", face: "angry" },
      { at: 3.8, dur: 1, who: "car3", do: "blink" },
    ],
    sfx: [],
    caption: null,
    note: null,
    cuts,
  };
}

function story(art: ArtStyle, cuts: ShotCue[], car: CarLook = CLASSIC_OWN): StoryScript {
  const f = FORMATS[0]!;
  const raw: StoryScript = { engine: ENGINE_VERSION, fps: 30, width: f.width, height: f.height, durationSec: 6, title: "Night", seed: 9, cast: { c1: member("c1") }, cars: { k1: ownCar(car) }, scenes: [drive(cuts)], music: null, captionsOn: true, captions: [], safety: null, art };
  const r = validateScript(raw);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return normalizeScript(r.script);
}

function shotsHash(): string {
  const h = createHash("sha256");
  for (const art of ["night_drive", "classic"] as ArtStyle[]) {
    h.update(JSON.stringify(drawFrame(story(art, []), 40)));
    for (const shot of SHOTS) {
      for (const fr of [40, 100]) h.update(JSON.stringify(drawFrame(story(art, [{ at: 0.1, shot }]), fr)));
    }
  }
  return h.digest("hex");
}

/** The editor's previews (previewCar) in both styles, every move. */
function previewHash(): string {
  const h = createHash("sha256");
  const moves: CarMove[] = ["idle", "drive", "speed_up", "brake", "turn", "bounce", "honk", "blink", "stall"];
  for (const car of [...GROUPS.withEyes!, DEFAULT_CAR]) {
    for (const art of ["classic", "night_drive"] as ArtStyle[]) {
      for (const move of moves) h.update(JSON.stringify(previewCar(car, "bouncy", "happy", move, 0.9, 260, art)));
    }
  }
  return h.digest("hex");
}

function plainViewHash(): string {
  const h = createHash("sha256");
  for (const view of ["back", "front"] as const) {
    for (const kind of ["car", "truck"] as const) {
      const prop: SceneProp = { propId: "p1", kind, x: 0.5, y: 0.7, scale: 1, rot: 0 };
      const st = propState(prop, [], "side", 0.5, { braking: 0, steer: 0, rolled: 0 }, null);
      const pen = new Pen();
      inMode(ART_MODES[2]!, () => drawPropView(pen, st, view, { x: 540, y: 1200, w: 300, side: 0.5, light: NIGHT, t: 0.5, seed: 3 }, null));
      h.update(JSON.stringify(pen.out));
    }
  }
  h.update(JSON.stringify(plainCarLook("#123456")));
  return h.digest("hex");
}

const CUT_SETS: ShotCue[][] = [[], [{ at: 0.1, shot: "driver_view" }], [{ at: 0.1, shot: "side_window" }], [{ at: 0.1, shot: "road_wide" }], [{ at: 0.1, shot: "mirror" }]];

/** The shape budget numbers of a scene (script.ts), through the two-argument call the old tests use. */
function budgetNumbers(): Record<string, number> {
  const out: Record<string, number> = { CAR_CAST_SHAPES, CAR_CAST_SHAPES_ND, CAR_VIEW_SHAPES };
  for (const art of ["classic", "night_drive"] as ArtStyle[]) {
    for (const cuts of CUT_SETS) out[`${art}/${cuts.map((c) => c.shot).join("+") || "none"}`] = sceneShapes(drive(cuts), art);
  }
  return out;
}

function compute(): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [name, cars] of Object.entries(GROUPS)) {
    out[`sideTop/${name}`] = sideTopHash(cars);
    out[`endViews/${name}`] = endViewHash(cars);
  }
  out.shots = shotsHash();
  out.previews = previewHash();
  out.plainViews = plainViewHash();
  for (const [k, v] of Object.entries(budgetNumbers())) out[`budget/${k}`] = v;
  return out;
}

describe("a vehicle look without `detail` draws exactly as before", () => {
  it("matches the golden for the side and top views, the front and back views, the shots, the previews and the budget", () => {
    const now = compute();
    if (process.env.STORIES_GOLDENS === "write" && !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, `${JSON.stringify({ note: "sha256 of the classic vehicle draw lists; written once from the untouched engine; never rewrite", golden: now }, null, 2)}\n`);
    }
    const stored = JSON.parse(readFileSync(FIXTURE, "utf8")) as { golden: Record<string, string | number> };
    expect(Object.keys(now).sort()).toEqual(Object.keys(stored.golden).sort());
    for (const [k, v] of Object.entries(stored.golden)) expect(now[k], k).toBe(v);
  }, 180_000);

  it("covers every body, every catalog choice and both styles", () => {
    expect(GROUPS.bodies).toHaveLength(12);
    expect(new Set(GROUPS.withEyes!.map((l) => l.body)).size).toBe(12);
    expect(new Set(GROUPS.withEyes!.map((l) => l.wheels.style)).size).toBe(ids(CL.wheels).length);
    expect(ART_MODES.map((m) => m.art)).toContain("night_drive");
  });

  it("really draws: the golden's inputs make hundreds of prims, and one changed colour changes the hash", () => {
    const one = previewCar(DEFAULT_CAR, "bouncy", "happy", "idle", 0.5, 260, "night_drive");
    expect(one.length).toBeGreaterThan(30);
    const a = sideTopHash([DEFAULT_CAR]);
    expect(sideTopHash([DEFAULT_CAR])).toBe(a);
    expect(sideTopHash([{ ...DEFAULT_CAR, paint: "#d8352b" }])).not.toBe(a);
  });
});
