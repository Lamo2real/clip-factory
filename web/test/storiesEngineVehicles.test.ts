// More vehicles (docs/CONTRACTS.md §45.47, ADR-97): a vehicle is still a car of the cast (kind "car") with one of the
// new bodies (bus, motorbike, plane, boat), its family worked out from the body (VEHICLE_OF); its inside colours from
// the inside photos (CarLook.interior) show in the cabin shots; planes and boats have their own places, the sky and the
// sea, with no road and no lanes; and two vehicles of the cast can be in one scene.
import { describe, expect, it } from "vitest";
import { LIGHTS, ND } from "../src/stories/engine/art.ts";
import { CAR_CAST_SHAPES, CAR_CAST_SHAPES_ND, CAR_VIEW_SHAPES, carSide, checkCarLook, DEFAULT_CAR, type CarDraw } from "../src/stories/engine/car.ts";
import { drawCarView } from "../src/stories/engine/carView.ts";
import { CATALOG, drawFrame, ENGINE_VERSION, normalizeScript, previewCar, validateScript } from "../src/stories/engine/engine.ts";
import { Pen } from "../src/stories/engine/pen.ts";
import { drawOutside, FOCAL, roadPlan, type Cam3 } from "../src/stories/engine/perspective.ts";
import { drawProp, propState } from "../src/stories/engine/props.ts";
import { roadLook, setInfo } from "../src/stories/engine/sets.ts";
import { cabinColours, type ShotCar } from "../src/stories/engine/shots.ts";
import { VEHICLE_OF, type CarBody, type CarLook, type CarMember, type CastMember, type CharacterLook, type Prim, type Scene, type SceneProp, type SetId, type StoryScript } from "../src/stories/engine/types.ts";

const NEW: CarBody[] = ["bus", "motorbike", "plane", "boat"];
const look = (body: CarBody, extra: Partial<CarLook> = {}): CarLook => ({ ...DEFAULT_CAR, body, paint: "#1a7f5a", ...extra });
const colours = (prims: Prim[]): Set<string> => new Set(prims.flatMap((p) => ("color" in p ? [p.color] : [])));
const INSIDE = { seat: "#b8865a", dash: "#5a3a8c", trim: "#c0c4ca" };

function propPrims(car: CarLook, view: "side" | "top", night = false): Prim[] {
  const prop: SceneProp = { propId: "v", kind: "car", x: 0.5, y: 0.72, scale: 0.8, rot: 0, castId: "k1" };
  const d: CarDraw = { car, style: "calm", seed: 3 };
  const st = propState(prop, [], view, 0.5, { braking: 0, steer: 0, rolled: 120 }, d);
  const pen = new Pen();
  drawProp(pen, st, view, 0.5, 3, {}, night, d);
  return pen.out;
}

describe("the new vehicles", () => {
  it("are four more car bodies with their own words, each in its family", () => {
    expect(CATALOG.carLooks.body.slice(-4)).toEqual([
      { id: "bus", label: "Bus" },
      { id: "motorbike", label: "Motorbike" },
      { id: "plane", label: "Plane" },
      { id: "boat", label: "Boat" },
    ]);
    expect(NEW.map((b) => VEHICLE_OF[b])).toEqual(["bus", "motorbike", "plane", "boat"]);
    for (const b of CATALOG.carLooks.body) expect(VEHICLE_OF[b.id as CarBody], b.id).toBeDefined();
    expect(CATALOG.props.find((p) => p.id === "car")?.label).toBe("Vehicle");
    // the engine itself is unchanged in its version: the new bodies and places are additive
    expect(ENGINE_VERSION).toBe(9);
  });

  it("pass the look check, an interior too; a bad interior says what to fix in one sentence", () => {
    const errors: string[] = [];
    for (const b of NEW) checkCarLook(look(b, { interior: INSIDE }), "cars.k1", (m) => errors.push(m));
    checkCarLook(look("sedan", { interior: { seat: "#111111", dash: "#222222" } }), "cars.k1", (m) => errors.push(m));
    expect(errors).toEqual([]);
    const bad: string[] = [];
    checkCarLook(look("plane", { interior: { seat: "tan", dash: "#222222" } }), "cars.k1", (m) => bad.push(m));
    expect(bad).toEqual(['cars.k1: car.interior needs a seat and a dash colour like "#2d2d2f" (and a trim colour, if any).']);
  });

  it("each draws its own shape: a bike has no glass, a plane has wings, a boat floats with no wheels", () => {
    const glass = "#bfe3f2";
    const bike = propPrims(look("motorbike"), "side");
    expect(bike.some((p) => "color" in p && p.color === glass)).toBe(false);
    expect(propPrims(look("bus"), "side").some((p) => "color" in p && p.color === glass)).toBe(true);
    const tyre = "#2b2b36";
    const boat = colours(propPrims(look("boat"), "side"));
    expect(boat.has("#e9f6ff")).toBe(true);
    // a boat's only dark navy is none: no tyres under it (a car has two)
    const tyres = (prims: Prim[]) => prims.filter((p) => p.k === "ellipse" && p.color === tyre).length;
    expect(tyres(propPrims(look("boat"), "side"))).toBe(0);
    expect(tyres(propPrims(look("hatchback"), "side"))).toBe(2);
    const wing = (car: CarLook) => propPrims(car, "side").filter((p) => p.k === "poly" && p.pts.length === 8 && p.color !== car.paint).length;
    expect(wing(look("plane"))).toBeGreaterThan(wing(look("hatchback")));
    // a plane's tail fin stands above its roof
    const plane = carSide(look("plane"));
    expect(Math.min(...plane.sil.filter((_, i) => i % 2 === 1))).toBeLessThan(plane.y(2) - 40);
  });

  it("stay within the measured shape budgets in both views, both styles, and in the front and back views", () => {
    for (const b of NEW) {
      for (const car of [look(b), look(b, { face: { eyes: "windscreen", color: "#1c1842", mouth: "grille" }, interior: INSIDE })]) {
        for (const view of ["side", "top"] as const) {
          expect(propPrims(car, view).length, `${b} ${view}`).toBeLessThanOrEqual(CAR_CAST_SHAPES);
          expect(previewCar(car, "calm", "happy", view === "top" ? "turn" : "drive", 0.6, 240, "night_drive").length, `${b} ${view} nd`).toBeLessThanOrEqual(CAR_CAST_SHAPES_ND);
        }
        for (const v of ["back", "front"] as const) {
          const pen = new Pen();
          drawCarView(pen, car, v, { x: 500, y: 900, w: 300, side: 0.4, light: LIGHTS.night, braking: 1, lights: true, blink: 1, face: "happy", t: 0.5, seed: 4 });
          expect(pen.out.length, `${b} ${v}`).toBeLessThanOrEqual(CAR_VIEW_SHAPES);
          expect(pen.out.every((p) => Object.values(p).every((x) => typeof x !== "number" || Number.isFinite(x))), `${b} ${v}`).toBe(true);
        }
      }
    }
  });

  it("draws the inside photos' colours in the cabin, and the usual cabin without them", () => {
    const shotCar = (car: CarLook): ShotCar => ({ st: propState({ propId: "v", kind: "car", x: 0.5, y: 0.72, scale: 1, rot: 0, castId: "k1" }, [], "side", 0, { braking: 0, steer: 0, rolled: 0 }), draw: { car, style: "calm", seed: 1 }, truck: false, speedAt: null, occ: {} });
    expect(cabinColours(shotCar(look("sedan")))).toEqual({ roof: ND.cabinRoof, pillar: ND.pillar, dashTop: ND.dashTop, dashFace: ND.dashFace, dashLip: ND.dashLip, seat: ND.seat, seatInk: ND.seatInk });
    expect(cabinColours(null).dashTop).toBe(ND.dashTop);
    const own = cabinColours(shotCar(look("sedan", { interior: INSIDE })));
    expect(own.dashTop).toBe(INSIDE.dash);
    expect(own.seat).toBe(INSIDE.seat);
    expect(own.pillar).toBe(INSIDE.trim);
    // in a driver's eyes shot the dash is the car's own colour
    const withInside = drawFrame(valid(story([drive("road_day")], "classic", look("sedan", { interior: INSIDE }))), 40);
    const plain = drawFrame(valid(story([drive("road_day")], "classic")), 40);
    expect(colours(withInside).has(INSIDE.dash)).toBe(true);
    expect(colours(plain).has(INSIDE.dash)).toBe(false);
    expect(colours(plain).has(ND.dashTop)).toBe(true);
  });
});

describe("the sky and the sea", () => {
  it("are outdoor places with their own words and sound, and no lanes", () => {
    const ids = CATALOG.sets.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["sky", "sea"]));
    expect(CATALOG.sets.find((s) => s.id === "sky")?.label).toBe("Sky");
    expect(CATALOG.sets.find((s) => s.id === "sea")?.label).toBe("Sea");
    for (const set of ["sky", "sea"] as SetId[]) {
      expect(setInfo(set)).toMatchObject({ outdoor: true, night: false, weather: null, road: true });
      expect(roadLook(set)).toMatchObject({ open: true, posts: false, rail: false, edge: null, lamps: "none" });
    }
    expect(roadLook("road_day").open).toBeUndefined();
  });

  it("draws no road and no lane dashes down the way ahead; a road place does", () => {
    const c: Cam3 = { vpX: 540, hor: 700, f: FOCAL, camX: -0.35, camH: 1.2 };
    const out = (set: SetId) => {
      const look = roadLook(set);
      const pen = new Pen();
      drawOutside(pen, c, { look, plan: roadPlan(look), m: 37, t: 1, seed: 5, sway: 0, x0: 0, x1: 1080, top: 0, bottom: 1300, zNear: 2 });
      return { prims: pen.out, look };
    };
    for (const set of ["sky", "sea"] as SetId[]) {
      const { prims, look } = out(set);
      expect(prims.some((p) => "color" in p && (p.color === look.lane || p.color === look.laneFar)), set).toBe(false);
    }
    const road = out("road_day");
    expect(road.prims.some((p) => "color" in p && p.color === road.look.lane)).toBe(true);
  });

  it("a plane flies in the sky and a boat sails on the sea, with the cast's own vehicles in one scene", () => {
    for (const [set, body] of [
      ["sky", "plane"],
      ["sea", "boat"],
    ] as [SetId, CarBody][]) {
      const s = story([{ ...drive(set), cuts: [] }], "classic", look("sedan"), { k2: { characterId: "car-k2", name: "Second", car: look(body, { paint: "#e0533d" }), movementStyle: "calm", voice: { style: "none", pitch: 1, noises: [], sfx: [] }, expressions: ["neutral"] } });
      s.scenes[0]!.props.push({ propId: "car2", kind: "car", x: 0.75, y: 0.7, scale: 0.9, rot: 0, castId: "k2" });
      const ok = valid(s);
      for (const fr of [0, 60]) {
        const seen = colours(drawFrame(ok, fr));
        expect(seen.has("#1a7f5a"), `${set} ${fr}`).toBe(true);
        expect(seen.has("#e0533d"), `${set} ${fr}`).toBe(true);
      }
    }
  });
});

// ---- a small story ----------------------------------------------------------------------------------------------

const person: CharacterLook = {
  body: "tall",
  skin: "#e1c2a4",
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
};

/** c1 drives the cast's own car k1 at `set`, the scene cutting to the driver's eyes. */
function drive(set: SetId): Scene {
  return {
    sceneId: "s1",
    title: "Go",
    durationSec: 4,
    set,
    view: "side",
    camera: "wide",
    actors: [{ castId: "c1", x: 0.4, y: 0.78, facing: "right", inCar: "car1" }],
    props: [{ propId: "car1", kind: "car", x: 0.4, y: 0.78, scale: 1, rot: 0, castId: "k1" }],
    beats: [{ at: 0.2, dur: 1, who: "c1", do: "drive" }],
    sfx: [],
    caption: null,
    note: null,
    cuts: [{ at: 0.1, shot: "driver_view" }],
  };
}

function story(scenes: Scene[], art: "classic" | "night_drive", ownLook: CarLook = look("sedan"), more: Record<string, CarMember> = {}): StoryScript {
  const c1: CastMember = { characterId: "c1", name: "c1", look: person, movementStyle: "calm", voice: { style: "babble", pitch: 1, noises: [], sfx: [] } };
  const own: CarMember = { characterId: "car-k1", name: "Own", car: ownLook, movementStyle: "calm", voice: { style: "none", pitch: 1, noises: [], sfx: [] }, expressions: ["neutral"] };
  return { engine: ENGINE_VERSION, fps: 30, width: 1080, height: 1920, durationSec: scenes.reduce((a, s) => a + s.durationSec, 0), title: "Go", seed: 9, cast: { c1 }, cars: { k1: own, ...more }, scenes, music: null, captionsOn: true, captions: [], safety: null, art };
}

function valid(s: unknown): StoryScript {
  const r = validateScript(s);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return normalizeScript(r.script);
}
