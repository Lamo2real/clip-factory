// Lamo Stories engine: the story script's rules (CONTRACTS §45.10). validateScript explains every problem in a
// sentence the writer can act on; normalizeScript moves beat effects into the scene lists and fills seeds;
// fitDuration lands the story on its target length without breaking any scene rule; repairScript swaps a face or
// drops a noise a character does not have, after the writer's last try (CONTRACTS §45.34). A car of the cast
// (§45.43) lives in the script's own `cars` map and is drawn by the one car prop of a scene whose castId names it.
// The drawing style (`art`) and the cuts between shots inside a scene (`cuts`) are §45.45: both are optional, and a
// script without them is checked, normalized and fitted exactly as before.

import { sceneBeds } from "./ambience.ts";
import { CAR_CAST_SHAPES, CAR_CAST_SHAPES_ND, CAR_VIEW_SHAPES, carHasFace, checkCarLook } from "./car.ts";
import { CATALOG, catalogIds } from "./catalog.ts";
import { formatOf, formatsSentence } from "./frame.ts";
import { clamp, hash, isHex } from "./math.ts";
import { CARS, PROP_SHAPES_ND } from "./props.ts";
import { SET_SHAPES_ND, setInfo } from "./sets.ts";
import { SHOT_CARS as SHOT_CARS_MAX, SHOT_SHAPES } from "./shots.ts";
import type { ArtStyle, CaptionCue, CarLook, Scene, SetId, ShotCue, ShotId, ScriptRepair, SfxCue, StoryScript, ValidateResult } from "./types.ts";

/** The default size (9:16); FORMATS (frame.ts) has all six. */
export const WIDTH = 1080;
export const HEIGHT = 1920;
/** The first engine whose scripts may have another size than 1080 × 1920: a script written for an older engine was
 * laid out for the tall frame only. */
export const SIZES_FROM_ENGINE = 5;
export const FPS = 30;
/** Facebook Reels take at most 90 s; the audio tail needs a little room (CONTRACTS §45.9). */
export const MAX_SECONDS = 89.5;
export const SCENE_MIN = 2;
export const SCENE_MAX = 15;

/** How many people sit in each vehicle (a driver and one passenger in a car, a driver in a truck's cab). */
export const SEATS = { car: 2, truck: 1 } as const;

/** Limits that keep every frame light enough for the agent's rasterizer; `cars` is the script's own cars (§45.43). */
export const LIMITS = { scenes: 30, cast: 6, cars: 2, actors: 4, props: 12, beats: 40, sfx: 40, captions: 40, totalSec: 180, shapes: 480 };

/** About how many shapes (prims) each thing adds to a frame at its busiest (measured on the busiest sets, with every
 * action it can do); weather draws once however many of it there are. */
export const SHAPES = {
  set: 60,
  wetSet: 80,
  actor: 70,
  props: { car: 45, truck: 36, deer: 30, snow: 36, rain: 42, fog: 8, ice_patch: 15, tree: 15, sparkles: 15 } as Partial<Record<string, number>>,
  prop: 12,
  /** a car prop with a castId: the cast's own car (§45.43), eyes and all */
  carCast: CAR_CAST_SHAPES,
} as const;
const ONCE = new Set(["snow", "rain", "fog"]);

/** The night drive style's estimates (§45.45): every person, car and place has more shading, so more shapes. A place
 * at night has lamps, halos, mountains and the vignette (each place's own measure is SET_SHAPES_ND, sets.ts); "props"
 * is each kind's classic estimate plus `prop`; a car of the cast is car.ts's measured CAR_CAST_SHAPES_ND. */
export const SHAPES_ND = {
  set: 72,
  nightSet: 100,
  wetSet: 95,
  actor: 92,
  /** measured by props.ts (PROP_SHAPES_ND) */
  props: { ...PROP_SHAPES_ND } as Partial<Record<string, number>>,
  /** added to a classic estimate of any other prop */
  prop: 2,
  carCast: CAR_CAST_SHAPES_ND,
} as const;

/** Each shot's busiest frame (§45.45, measured by shots.ts): its place, the inside of the car, the own car and the
 * driver. */
export const SHOT_ESTIMATES: Readonly<Record<ShotId, number>> = SHOT_SHAPES;
/** Each other car or truck a shot shows adds its front or back view (car.ts CAR_VIEW_SHAPES), for at most
 * `SHOT_CARS` of them (the nearest). */
export const SHOT_CAR = CAR_VIEW_SHAPES;
export const SHOT_CARS = SHOT_CARS_MAX;

/** A scene's busiest frame, roughly, in shapes: validateScript keeps it at most LIMITS.shapes. In night drive it is
 * the larger of the whole scene's estimate and each cut's shot (its own estimate plus the other cars it shows). */
export function sceneShapes(scene: { set?: unknown; actors?: unknown; props?: unknown; cuts?: unknown }, art: ArtStyle = "classic"): number {
  if (art !== "night_drive") return classicShapes(scene);
  const night = scene.set === "road_night" || scene.set === "highway_night";
  const wet = scene.set === "snowy_road" || scene.set === "rainy_road";
  const measured = typeof scene.set === "string" ? SET_SHAPES_ND[scene.set as SetId] : undefined;
  let n: number = measured ?? (night ? SHAPES_ND.nightSet : wet ? SHAPES_ND.wetSet : SHAPES_ND.set);
  if (Array.isArray(scene.actors)) n += scene.actors.length * SHAPES_ND.actor;
  const seen = new Set<string>();
  let vehicles = 0;
  if (Array.isArray(scene.props)) {
    for (const p of scene.props) {
      const kind = isObj(p) && typeof p.kind === "string" ? p.kind : "";
      if (kind === "car" || kind === "truck") vehicles += 1;
      if (ONCE.has(kind) && seen.has(kind)) continue;
      seen.add(kind);
      if (kind === "car" && isObj(p) && typeof p.castId === "string") n += SHAPES_ND.carCast;
      else n += SHAPES_ND.props[kind] ?? (SHAPES.props[kind] ?? SHAPES.prop) + SHAPES_ND.prop;
    }
  }
  if (Array.isArray(scene.cuts)) {
    // the own car is in the shot's estimate; every other car or truck it may show adds its own
    const others = Math.min(SHOT_CARS, Math.max(0, vehicles - 1)) * SHOT_CAR;
    for (const c of scene.cuts) {
      const shot = isObj(c) && typeof c.shot === "string" ? SHOT_ESTIMATES[c.shot as ShotId] : undefined;
      if (shot) n = Math.max(n, shot + others);
    }
  }
  return n;
}

function classicShapes(scene: { set?: unknown; actors?: unknown; props?: unknown }): number {
  let n = scene.set === "snowy_road" || scene.set === "rainy_road" ? SHAPES.wetSet : SHAPES.set;
  if (Array.isArray(scene.actors)) n += scene.actors.length * SHAPES.actor;
  const seen = new Set<string>();
  if (Array.isArray(scene.props)) {
    for (const p of scene.props) {
      const kind = isObj(p) && typeof p.kind === "string" ? p.kind : "";
      if (ONCE.has(kind) && seen.has(kind)) continue;
      seen.add(kind);
      n += kind === "car" && isObj(p) && typeof p.castId === "string" ? SHAPES.carCast : (SHAPES.props[kind] ?? SHAPES.prop);
    }
  }
  return n;
}

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const TOL = 0.05;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown): v is number => isNum(v) && Number.isInteger(v);
const show = (v: unknown): string => {
  const s = v === undefined ? "nothing" : JSON.stringify(v);
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
};
const list = (ids: string[], max = 12): string => (ids.length > max ? `${ids.slice(0, max).join(", ")}, ...` : ids.join(", "));

const SETS = new Set(catalogIds("sets"));
const ACTIONS = new Set(catalogIds("actions"));
const PROP_ACTIONS = new Set(catalogIds("propActions"));
const PROPS = new Set(catalogIds("props"));
const CAMERAS = new Set(catalogIds("cameras"));
const BUBBLES = new Set(catalogIds("bubbles"));
const NOISES = new Set(catalogIds("noises"));
const SFX = new Set(catalogIds("sfx"));
const FACES = new Set(catalogIds("expressions"));
const STYLES = new Set(catalogIds("movementStyles"));
const MOODS = new Set(catalogIds("musicMoods"));
const SHOTS = new Set(catalogIds("shots"));

/** The look and voice choices come from the catalog (CONTRACTS §45.33), so the character agent's schema and this
 * check can never disagree. */
const LOOKS = CATALOG.looks;
const choice = (list: { id: string }[]) => list.map((e) => e.id);
const LOOK_ENUMS: Record<string, string[]> = {
  body: choice(LOOKS.body),
  brows: choice(LOOKS.brows),
  nose: choice(LOOKS.nose),
  mouth: choice(LOOKS.mouth),
  accessory: choice(LOOKS.accessory),
};
const HAIR = choice(LOOKS.hair);
const EYES = choice(LOOKS.eyes);
const PATTERNS = choice(LOOKS.pattern);
const VOICES = choice(LOOKS.voiceStyle);

function checkLook(look: unknown, where: string, err: (m: string) => void): void {
  if (!isObj(look)) {
    err(`${where}: look is missing. Copy the character's saved look into the cast.`);
    return;
  }
  for (const [k, allowed] of Object.entries(LOOK_ENUMS)) {
    if (typeof look[k] !== "string" || !allowed.includes(look[k] as string)) err(`${where}: look.${k} is ${show(look[k])}; use one of ${allowed.join(", ")}.`);
  }
  if (!isHex(look.skin)) err(`${where}: look.skin must be a colour like "#f2c9a0".`);
  if (!isHex(look.outline)) err(`${where}: look.outline must be a colour like "#1c1842".`);
  for (const k of ["height", "width"]) {
    if (!isNum(look[k]) || (look[k] as number) < 0.85 || (look[k] as number) > 1.15) err(`${where}: look.${k} is ${show(look[k])}; use a number from 0.85 to 1.15.`);
  }
  const hair = look.hair;
  if (!isObj(hair) || !HAIR.includes(hair.style as string) || !isHex(hair.color)) err(`${where}: look.hair needs a style (${HAIR.join(", ")}) and a colour.`);
  const eyes = look.eyes;
  if (!isObj(eyes) || !EYES.includes(eyes.shape as string) || !isHex(eyes.color)) err(`${where}: look.eyes needs a shape (${EYES.join(", ")}) and a colour.`);
  const o = look.outfit;
  if (!isObj(o) || !isHex(o.top) || !isHex(o.bottom) || !isHex(o.accent) || !PATTERNS.includes(o.pattern as string)) {
    err(`${where}: look.outfit needs top, bottom and accent colours and a pattern (${PATTERNS.join(", ")}).`);
  }
}

function checkVoice(v: unknown, where: string, err: (m: string) => void): void {
  if (!isObj(v)) {
    err(`${where}: voice is missing ({ style, pitch, noises, sfx }).`);
    return;
  }
  if (!VOICES.includes(v.style as string)) err(`${where}: voice.style must be ${VOICES.join(", ").replace(/, ([^,]*)$/, " or $1")}.`);
  if (!isNum(v.pitch) || v.pitch < 0.5 || v.pitch > 2) err(`${where}: voice.pitch is ${show(v.pitch)}; use a number from 0.5 to 2.`);
  if (!Array.isArray(v.noises) || v.noises.length > 8 || v.noises.some((n) => !NOISES.has(n as string))) err(`${where}: voice.noises must be up to 8 of ${list([...NOISES])}.`);
  if (!Array.isArray(v.sfx) || v.sfx.length > 8 || v.sfx.some((n) => !SFX.has(n as string))) err(`${where}: voice.sfx must be up to 8 known effects.`);
}

/** True when the faces are different known ones with neutral among them. */
const knownFaces = (faces: unknown, min: number): boolean =>
  Array.isArray(faces) && faces.length >= min && faces.every((f) => FACES.has(f as string)) && faces.includes("neutral") && new Set(faces).size === faces.length;

/** Whether a car look (valid or not) has a face: eyes on the windscreen or in the headlights. */
function carFaced(car: unknown): boolean {
  return isObj(car) && isObj(car.face) && carHasFace(car as unknown as CarLook);
}

/** The character agent's answer, or a saved character: a CharacterInput (CONTRACTS §45.6, §45.33). Its look, movement
 * style and voice follow the same rules as a script's cast; its faces are at least 3 different known ones, neutral
 * among them; its name, description, personality and traits keep their lengths. A car (`kind: "car"`, §45.42) has a
 * car look instead of a person's, no voice (style "none", no noises) and, with no face, only the neutral face. */
export function validateCharacter(input: unknown): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const err = (m: string) => {
    if (errors.length < 40) errors.push(m);
  };
  if (!isObj(input)) return { ok: false, errors: ["The character must be a JSON object { name, description, personality, traits, movementStyle, expressions, look, voice }."] };
  const where = typeof input.name === "string" && input.name.trim() ? `character ${input.name.trim().slice(0, 30)}` : "character";
  if (input.name !== undefined && (typeof input.name !== "string" || !input.name.trim() || input.name.length > 30)) err(`${where}: name must be 1 to 30 characters.`);
  for (const k of ["description", "personality"]) {
    const v = input[k];
    if (v !== undefined && (typeof v !== "string" || v.length > 400)) err(`${where}: ${k} must be text of at most 400 characters (it has ${typeof v === "string" ? v.length : "no text"}).`);
  }
  const traits = input.traits;
  if (traits !== undefined && (!Array.isArray(traits) || traits.length > 8 || traits.some((x) => typeof x !== "string" || !x.trim() || x.length > 30))) {
    err(`${where}: traits must be up to 8 words or short phrases of at most 30 characters each.`);
  }
  const kind = input.kind;
  if (kind !== undefined && kind !== "person" && kind !== "car") {
    err(`${where}: Pick a person or a car.`);
    return { ok: false, errors };
  }
  const faces = input.expressions;
  if (kind === "car") {
    // a car's look is its car; a person's look, if any, is ignored
    checkCarLook(input.car, where, err);
    if (!STYLES.has(input.movementStyle as string)) err(`${where}: movementStyle is ${show(input.movementStyle)}; use one of ${list([...STYLES])}.`);
    checkVoice(input.voice, where, err);
    const v = isObj(input.voice) ? input.voice : null;
    if (v && (v.style !== "none" || (Array.isArray(v.noises) && v.noises.length > 0))) err(`${where}: A car has no voice. Pick its sounds instead.`);
    if (!carFaced(input.car)) {
      if (!Array.isArray(faces) || faces.length !== 1 || faces[0] !== "neutral") err(`${where}: A car with no face keeps only the neutral face.`);
    } else if (!knownFaces(faces, 3)) err(`${where}: expressions must be at least 3 different faces of ${list([...FACES], 14)}, with neutral among them.`);
    return errors.length ? { ok: false, errors } : { ok: true };
  }
  checkLook(input.look, where, err);
  if (!STYLES.has(input.movementStyle as string)) err(`${where}: movementStyle is ${show(input.movementStyle)}; use one of ${list([...STYLES])}.`);
  checkVoice(input.voice, where, err);
  if (!knownFaces(faces, 3)) {
    err(`${where}: expressions must be at least 3 different faces of ${list([...FACES], 14)}, with neutral among them.`);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

/** The faces and noises a cast member keeps to (CONTRACTS §45.34), or null for a cast copied before characters
 * carried their faces (old scripts): then any face and noise of the catalog goes. */
interface Own {
  name: string;
  faces: string[];
  noises: string[];
}

function ownOf(m: unknown): Own | null {
  if (!isObj(m) || !Array.isArray(m.expressions)) return null;
  const voice = isObj(m.voice) ? m.voice : {};
  return {
    name: typeof m.name === "string" && m.name.trim() ? m.name.trim() : "This character",
    faces: m.expressions.filter((f): f is string => typeof f === "string"),
    noises: Array.isArray(voice.noises) ? voice.noises.filter((n): n is string => typeof n === "string") : [],
  };
}

const andList = (items: string[]): string => items.join(", ").replace(/, ([^,]*)$/, " and $1");

/** The sentence for a face a character does not have. */
function strayFace(where: string, who: string, own: Own, face: string): string {
  return `${where}: ${own.name} (${who}) does not make the face "${face}"; ${own.name}'s own faces are ${andList(own.faces)}. Use one of those, or leave face out.`;
}

/** The sentence for a noise a character does not make. */
function strayNoise(where: string, who: string, own: Own, noise: string): string {
  const has = own.noises.length ? `${own.name}'s own noises are ${andList(own.noises)}. Use one of those, or leave noise out.` : `${own.name} makes no noises; leave noise out.`;
  return `${where}: ${own.name} (${who}) does not make the noise "${noise}"; ${has}`;
}

function checkCast(cast: unknown, err: (m: string) => void): string[] {
  if (!isObj(cast) || Object.keys(cast).length === 0) {
    err("cast must list at least one character: { castId: { characterId, name, look, movementStyle, voice } }.");
    return [];
  }
  const ids = Object.keys(cast);
  if (ids.length > LIMITS.cast) err(`cast has ${ids.length} characters; the most is ${LIMITS.cast}.`);
  for (const id of ids) {
    const where = `cast ${id}`;
    if (!ID.test(id)) err(`${where}: a cast id may use letters, digits, "_" and "-" only (1 to 40).`);
    const m = cast[id];
    if (!isObj(m)) {
      err(`${where}: must be an object with characterId, name, look, movementStyle and voice.`);
      continue;
    }
    if (typeof m.characterId !== "string" || !m.characterId) err(`${where}: characterId is missing.`);
    if (typeof m.name !== "string" || !m.name.trim() || m.name.length > 30) err(`${where}: name must be 1 to 30 characters.`);
    checkLook(m.look, where, err);
    if (!STYLES.has(m.movementStyle as string)) err(`${where}: movementStyle is ${show(m.movementStyle)}; use one of ${list([...STYLES])}.`);
    checkVoice(m.voice, where, err);
    const faces = m.expressions;
    if (faces !== undefined && (!Array.isArray(faces) || faces.length === 0 || faces.some((f) => !FACES.has(f as string)) || !faces.includes("neutral") || new Set(faces).size !== faces.length)) {
      err(`${where}: expressions must be the character's own faces: different faces of ${list([...FACES], 14)}, with neutral among them. Copy them from the saved character.`);
    }
  }
  return ids;
}

/** A car of the cast as the scene checks need it (§45.43): its name, whether it has a face, and its own faces. */
interface CarInfo {
  name: string;
  face: boolean;
  /** its own faces; null when the script carries none (any face of the catalog goes on a car with a face) */
  faces: string[] | null;
}

/** The script's own cars (§45.43): each one a car look, no voice and its faces, under an id of its own. */
function checkCars(cars: unknown, castIds: string[], err: (m: string) => void): Map<string, CarInfo> {
  const out = new Map<string, CarInfo>();
  if (cars === undefined) return out;
  if (!isObj(cars)) {
    err("cars must be an object { castId: { characterId, name, car, movementStyle, voice, expressions } } (it may be empty).");
    return out;
  }
  const ids = Object.keys(cars);
  if (ids.length > LIMITS.cars) err(`cars has ${ids.length} cars; the most is ${LIMITS.cars}.`);
  for (const id of ids) {
    const where = `cars.${id}`;
    if (!ID.test(id)) err(`${where}: a car's id may use letters, digits, "_" and "-" only (1 to 40).`);
    if (castIds.includes(id)) err(`${id} is both in cast and in cars; give the car its own id.`);
    const m = cars[id];
    if (!isObj(m)) {
      err(`${where}: must be an object with characterId, name, car, movementStyle and voice.`);
      continue;
    }
    if (typeof m.characterId !== "string" || !m.characterId) err(`${where}: characterId is missing.`);
    if (typeof m.name !== "string" || !m.name.trim() || m.name.length > 30) err(`${where}: name must be 1 to 30 characters.`);
    checkCarLook(m.car, where, err);
    if (!STYLES.has(m.movementStyle as string)) err(`${where}: movementStyle is ${show(m.movementStyle)}; use one of ${list([...STYLES])}.`);
    checkVoice(m.voice, where, err);
    const v = isObj(m.voice) ? m.voice : null;
    if (v && (v.style !== "none" || (Array.isArray(v.noises) && v.noises.length > 0))) err(`${where}: a car has no voice: its voice.style is "none" and its voice.noises is []. Copy the saved car's voice.`);
    const face = carFaced(m.car);
    const faces = m.expressions;
    if (faces !== undefined) {
      if (!face && (!Array.isArray(faces) || faces.length !== 1 || faces[0] !== "neutral")) err(`${where}: a car with no face keeps only the neutral face: expressions is ["neutral"].`);
      else if (face && !knownFaces(faces, 3)) err(`${where}: expressions must be the car's own faces: at least 3 different faces of ${list([...FACES], 14)}, with neutral among them. Copy them from the saved car.`);
    }
    const name = typeof m.name === "string" && m.name.trim() ? m.name.trim() : "This car";
    out.set(id, { name, face, faces: Array.isArray(faces) ? faces.filter((f): f is string => typeof f === "string") : null });
  }
  return out;
}

/** The actions that move a car (§45.43): always, or (stop, stall) only on the way to a `to` point. */
const CAR_MOVES = new Set(["move", "speed_up", "skid", "spin", "bump"]);
const movesCar = (b: Obj): boolean => CAR_MOVES.has(b.do as string) || ((b.do === "stop" || b.do === "stall") && b.to !== undefined);
/** Getting in or out of a car takes 0.8 to 3 seconds; the car may start or stop moving within `slack` of it. */
export const BOARDING = { min: 0.8, max: 3, slack: 0.1 } as const;

function checkScene(sc: unknown, i: number, castIds: string[], seenScenes: Set<string>, seenFx: Set<string>, err: (m: string) => void, own: Map<string, Own>, cars: Map<string, CarInfo> = new Map(), art: ArtStyle = "classic"): Obj | null {
  if (!isObj(sc)) {
    err(`scene ${i + 1}: must be an object.`);
    return null;
  }
  const sid = typeof sc.sceneId === "string" ? sc.sceneId : "";
  const where = `scene ${i + 1}${sid ? ` (${sid})` : ""}`;
  if (!ID.test(sid)) err(`${where}: sceneId must be 1 to 40 letters, digits, "_" or "-".`);
  else if (seenScenes.has(sid)) err(`${where}: sceneId "${sid}" is used twice; every scene needs its own id.`);
  seenScenes.add(sid);
  if (typeof sc.title !== "string" || sc.title.length > 40) err(`${where}: title must be text of at most 40 characters.`);
  const d = sc.durationSec;
  const dur = isNum(d) ? d : 0;
  if (!isNum(d) || d < SCENE_MIN || d > SCENE_MAX) err(`${where}: durationSec is ${show(d)}; a scene lasts ${SCENE_MIN} to ${SCENE_MAX} seconds.`);
  if (sc.seed !== undefined && (!isInt(sc.seed) || sc.seed < 0 || sc.seed > 0xffffffff)) err(`${where}: seed must be a whole number from 0 to 4294967295.`);
  if (!SETS.has(sc.set as string)) err(`${where}: set ${show(sc.set)} is not in the catalog; use one of ${list([...SETS], 15)}.`);
  if (sc.view !== "side" && sc.view !== "top") err(`${where}: view must be "side" or "top" (a road seen from above).`);
  if (!CAMERAS.has(sc.camera as string)) err(`${where}: camera ${show(sc.camera)} is not in the catalog; use one of ${list([...CAMERAS])}.`);
  if (sc.caption !== undefined && sc.caption !== null && (typeof sc.caption !== "string" || sc.caption.length > 60)) err(`${where}: caption must be null or at most 60 characters.`);
  if (sc.note !== undefined && sc.note !== null && (typeof sc.note !== "string" || sc.note.length > 500)) err(`${where}: note must be null or at most 500 characters.`);

  // props first: actors may sit in a car
  const props = Array.isArray(sc.props) ? sc.props : null;
  const propKinds = new Map<string, string>();
  /** prop id → the car of the cast it draws, and the other way round */
  const propCar = new Map<string, string>();
  const carProp = new Map<string, string>();
  if (!props) err(`${where}: props must be a list (it may be empty).`);
  else {
    if (props.length > LIMITS.props) err(`${where}: has ${props.length} props; the most is ${LIMITS.props}.`);
    props.forEach((p, j) => {
      const pw = `${where} prop ${j + 1}`;
      if (!isObj(p)) return err(`${pw}: must be an object.`);
      const pid = p.propId as string;
      if (typeof pid !== "string" || !ID.test(pid)) err(`${pw}: propId must be 1 to 40 letters, digits, "_" or "-".`);
      else if (propKinds.has(pid)) err(`${pw}: propId "${pid}" is used twice in this scene.`);
      else if (castIds.includes(pid)) err(`${pw}: propId "${pid}" is also a cast id; give the prop another id.`);
      if (!PROPS.has(p.kind as string)) err(`${pw}: kind ${show(p.kind)} is not in the catalog; use one of ${list([...PROPS], 24)}.`);
      if (typeof pid === "string") propKinds.set(pid, p.kind as string);
      for (const k of ["x", "y"]) if (!isNum(p[k]) || (p[k] as number) < -0.5 || (p[k] as number) > 1.5) err(`${pw}: ${k} is ${show(p[k])}; use 0 to 1 (a little outside, down to -0.5 or up to 1.5, starts it off screen).`);
      if (!isNum(p.scale) || p.scale < 0.1 || p.scale > 4) err(`${pw}: scale is ${show(p.scale)}; use 0.1 to 4.`);
      if (!isNum(p.rot)) err(`${pw}: rot must be a number of degrees.`);
      if (p.color !== undefined && !isHex(p.color)) err(`${pw}: color must be like "#ff6f61".`);
      if (p.state !== undefined && (typeof p.state !== "string" || p.state.length > 40)) err(`${pw}: state must be a short text.`);
      if (p.castId !== undefined) {
        const cid = typeof p.castId === "string" ? p.castId : show(p.castId);
        const ids = [...cars.keys()];
        if (p.kind !== "car") err(`${where}: prop ${pid} has castId ${cid}; only a prop of kind "car" can be a car of the cast.`);
        else if (typeof p.castId !== "string" || !cars.has(p.castId)) err(`${where}: prop ${pid} has castId ${cid}, which is not one of the cars. ${ids.length ? `Use one of ${list(ids)}.` : "This story has no cars: leave castId out."}`);
        else if (carProp.has(p.castId)) err(`${where}: ${p.castId} is in two props; a car of the cast is one prop per scene.`);
        else {
          carProp.set(p.castId, pid);
          if (typeof pid === "string") propCar.set(pid, p.castId);
        }
      }
    });
  }

  const actors = Array.isArray(sc.actors) ? sc.actors : null;
  const actorIds: string[] = [];
  const riders = new Map<string, string[]>();
  if (!actors) err(`${where}: actors must be a list (it may be empty).`);
  else {
    if (actors.length > LIMITS.actors) err(`${where}: has ${actors.length} actors; the most is ${LIMITS.actors}.`);
    actors.forEach((a, j) => {
      const aw = `${where} actor ${j + 1}`;
      if (!isObj(a)) return err(`${aw}: must be an object.`);
      const cid = a.castId as string;
      if (!castIds.includes(cid) && cars.has(cid)) err(`${where}: ${cid} (${cars.get(cid)!.name}) is a car. Put it in props as {kind: "car", castId: "${cid}"}, not in actors.`);
      else if (!castIds.includes(cid)) err(`${aw}: castId ${show(cid)} is not in the cast (${list(castIds)}).`);
      else if (actorIds.includes(cid)) err(`${aw}: ${cid} is in this scene twice.`);
      actorIds.push(cid);
      for (const k of ["x", "y"]) if (!isNum(a[k]) || (a[k] as number) < 0 || (a[k] as number) > 1) err(`${aw}: ${k} is ${show(a[k])}; use 0 to 1 of the frame.`);
      if (a.facing !== "left" && a.facing !== "right") err(`${aw}: facing must be "left" or "right".`);
      if (a.inCar !== undefined) {
        const kind = propKinds.get(a.inCar as string);
        if (kind !== "car" && kind !== "truck") err(`${aw}: inCar ${show(a.inCar)} must be the propId of a car or truck in this scene.`);
        else riders.set(a.inCar as string, [...(riders.get(a.inCar as string) ?? []), typeof cid === "string" ? cid : "?"]);
      }
    });
    // everyone in a car must have a seat, or they would vanish from the picture
    for (const [car, who] of riders) {
      const seats = SEATS[propKinds.get(car) as "car" | "truck"];
      if (who.length > seats) err(`${where}: ${car} seats ${seats === 1 ? "1 person" : `${seats} people`}, but ${who.join(", ")} sit in it. Put ${who.slice(seats).join(" and ")} in another car or outside it.`);
    }
  }

  if (props && actors && props.length <= LIMITS.props && actors.length <= LIMITS.actors) {
    const shapes = sceneShapes(sc, art);
    if (shapes > LIMITS.shapes) {
      const plural: Record<string, string> = { car: "cars", truck: "trucks", deer: "deer" };
      const heavy = [...new Set(props.map((p) => plural[(isObj(p) && (p.kind as string)) || ""]).filter((v): v is string => !!v))];
      const nd = art === "night_drive";
      err(`${where}: is too busy to draw quickly (about ${shapes} shapes at once; the most is ${LIMITS.shapes}). Use fewer ${[...heavy, "characters"].join(", ").replace(/, ([^,]*)$/, " or $1")} in it (a character is about ${nd ? SHAPES_ND.actor : SHAPES.actor} shapes, a car ${nd ? SHAPES_ND.props.car : SHAPES.props.car}, a small prop ${nd ? SHAPES.prop + SHAPES_ND.prop : SHAPES.prop}).`);
    }
  }

  const beats = Array.isArray(sc.beats) ? sc.beats : null;
  if (!beats) err(`${where}: beats must be a list (it may be empty).`);
  else {
    if (beats.length > LIMITS.beats) err(`${where}: has ${beats.length} beats; the most is ${LIMITS.beats}.`);
    beats.forEach((b, j) => {
      const bw = `${where} beat ${j + 1}`;
      if (!isObj(b)) return err(`${bw}: must be an object.`);
      const who = b.who as string;
      const isActor = actorIds.includes(who);
      const isProp = propKinds.has(who);
      if (!isActor && !isProp) {
        if (castIds.includes(who)) err(`${bw}: ${who} is in the cast but not in this scene; add it to this scene's actors.`);
        else if (cars.has(who)) err(`${bw}: ${who} (${cars.get(who)!.name}) is a car; ${carProp.has(who) ? `reach it by its prop id "${carProp.get(who)}"` : `add a car prop with castId "${who}" to this scene's props and reach it by that prop's id`}.`);
        else err(`${bw}: who ${show(who)} is not in this scene; use an actor (${list(actorIds) || "none"}) or a prop (${list([...propKinds.keys()]) || "none"}).`);
      }
      const act = b.do as string;
      if (isActor && !ACTIONS.has(act)) {
        if (PROP_ACTIONS.has(act)) err(`${bw}: "${act}" is a prop action; ${who} is a character. Use one of ${list([...ACTIONS], 28)}.`);
        else err(`${bw}: action ${show(act)} is not in the catalog; use one of ${list([...ACTIONS], 28)}.`);
      }
      if (isProp && !PROP_ACTIONS.has(act)) {
        if (ACTIONS.has(act)) err(`${bw}: "${act}" is a character action; ${who} is a prop. Use one of ${list([...PROP_ACTIONS])}.`);
        else err(`${bw}: prop action ${show(act)} is not in the catalog; use one of ${list([...PROP_ACTIONS])}.`);
      }
      if (!isNum(b.at) || b.at < 0) err(`${bw}: at is ${show(b.at)}; use seconds from the scene's start (0 or more).`);
      else if (isNum(d) && b.at >= dur) err(`${bw}: starts at ${b.at} s, but the scene is only ${dur} s long.`);
      if (!isNum(b.dur) || b.dur < 0.05) err(`${bw}: dur is ${show(b.dur)}; a beat lasts at least 0.05 s.`);
      else if (isNum(b.at) && isNum(d) && b.at + b.dur > dur + TOL) err(`${bw}: ends at ${round(b.at + b.dur)} s, after the scene ends (${dur} s). Shorten dur or start it earlier.`);
      const car = isProp ? cars.get(propCar.get(who) ?? "") : undefined;
      if (b.face !== undefined && car) {
        // a car of the cast makes faces only when it has one, and only its own (§45.43)
        if (!FACES.has(b.face as string)) err(`${bw}: face ${show(b.face)} is not in the catalog; use one of ${list([...FACES], 14)}.`);
        else if (!car.face) err(`${where}, beat ${j + 1}: ${car.name} has no face; leave face out.`);
        else if (car.faces && !car.faces.includes(b.face as string)) err(`${where}, beat ${j + 1}: ${car.name} does not make the face "${b.face}"; its own faces are ${andList(car.faces)}. Use one of those, or leave face out.`);
      } else if (b.face !== undefined && (!isActor || !FACES.has(b.face as string))) err(`${bw}: face ${show(b.face)} ${isActor ? `is not in the catalog; use one of ${list([...FACES], 14)}` : "is for characters only"}.`);
      else if (b.face !== undefined && own.has(who) && !own.get(who)!.faces.includes(b.face as string)) err(strayFace(bw, who, own.get(who)!, b.face as string));
      if (b.bubble !== undefined && (!isActor || !BUBBLES.has(b.bubble as string))) err(`${bw}: bubble ${show(b.bubble)} ${isActor ? `is not in the catalog; use one of ${list([...BUBBLES])}` : "is for characters only"}.`);
      if (b.noise !== undefined && (!isActor || !NOISES.has(b.noise as string))) err(`${bw}: noise ${show(b.noise)} ${isActor ? `is not in the catalog; use one of ${list([...NOISES])}` : "is for characters only"}.`);
      else if (b.noise !== undefined && own.has(who) && !own.get(who)!.noises.includes(b.noise as string)) err(strayNoise(bw, who, own.get(who)!, b.noise as string));
      if (b.sfx !== undefined && !SFX.has(b.sfx as string)) err(`${bw}: sfx ${show(b.sfx)} is not in the catalog; use one of ${list([...SFX], 23)}.`);
      if (b.dir !== undefined && b.dir !== "left" && b.dir !== "right") err(`${bw}: dir must be "left" or "right".`);
      if (b.to !== undefined) {
        const to = b.to;
        const lo = isProp ? -0.5 : 0;
        const hi = isProp ? 1.5 : 1;
        if (!isObj(to) || !isNum(to.x) || !isNum(to.y) || to.x < lo || to.x > hi || to.y < lo || to.y > hi) err(`${bw}: to must be { x, y } from ${lo} to ${hi}.`);
      }
    });
    if (actors) {
      checkBoarding(where, actors, beats, err);
      checkDriverWave(where, actors, beats, err);
    }
  }
  if (sc.cuts !== undefined) checkCuts(sc, sid || `${i + 1}`, dur, actors ?? [], beats ?? [], propKinds, err);

  const sfx = sc.sfx === undefined ? [] : Array.isArray(sc.sfx) ? sc.sfx : null;
  if (!sfx) err(`${where}: sfx must be a list of effects (it may be empty).`);
  else {
    if (sfx.length > LIMITS.sfx) err(`${where}: has ${sfx.length} effects; the most is ${LIMITS.sfx}.`);
    sfx.forEach((c, j) => {
      const cw = `${where} effect ${j + 1}`;
      if (!isObj(c)) return err(`${cw}: must be an object { id, at, sfx, volume }.`);
      if (typeof c.id !== "string" || !c.id) err(`${cw}: id is missing.`);
      else if (seenFx.has(c.id)) err(`${cw}: id "${c.id}" is used twice; effect ids must be unique in the story.`);
      else seenFx.add(c.id);
      if (!SFX.has(c.sfx as string)) err(`${cw}: sfx ${show(c.sfx)} is not in the catalog; use one of ${list([...SFX], 23)}.`);
      if (!isNum(c.at) || c.at < 0) err(`${cw}: at is ${show(c.at)}; use seconds from the scene's start.`);
      else if (isNum(d) && c.at >= dur) err(`${cw}: plays at ${c.at} s, but the scene is only ${dur} s long.`);
      if (!isNum(c.volume) || c.volume < 0 || c.volume > 1) err(`${cw}: volume is ${show(c.volume)}; use 0 to 1.`);
    });
  }
  return sc;
}

const round = (v: number) => Math.round(v * 100) / 100;

/** Getting in and out (§45.43): each needs inCar, lasts 0.8 to 3 s, at most one of each per character and scene,
 * get_in before get_out, and the car stays where it is while it happens. */
function checkBoarding(where: string, actors: unknown[], beats: unknown[], err: (m: string) => void): void {
  const all = beats.filter(isObj);
  for (const a of actors) {
    if (!isObj(a) || typeof a.castId !== "string") continue;
    const id = a.castId;
    const own = all.filter((b) => b.who === id && (b.do === "get_in" || b.do === "get_out") && isNum(b.at) && isNum(b.dur));
    if (!own.length) continue;
    const gin = own.filter((b) => b.do === "get_in");
    const gout = own.filter((b) => b.do === "get_out");
    if (typeof a.inCar !== "string") {
      const first = own[0]!;
      err(`${where}: ${id} gets ${first.do === "get_in" ? "in" : "out"} at ${round(first.at as number)} s but has no inCar. Give ${id} inCar: the car's propId.`);
      continue;
    }
    if (gin.length > 1) err(`${where}: ${id} gets in ${gin.length} times; a character gets in at most once a scene.`);
    if (gout.length > 1) err(`${where}: ${id} gets out ${gout.length} times; a character gets out at most once a scene.`);
    for (const b of own) {
      const d = b.dur as number;
      if (d < BOARDING.min || d > BOARDING.max) err(`${where}: ${id}'s ${b.do} lasts ${round(d)} s; getting in or out takes ${BOARDING.min} to ${BOARDING.max} seconds.`);
    }
    const gi = gin[0];
    const go = gout[0];
    if (gi && go && (go.at as number) < (gi.at as number) + (gi.dur as number)) err(`${where}: ${id} gets out at ${round(go.at as number)} s before getting in is done (${round((gi.at as number) + (gi.dur as number))} s); get_in comes first, then get_out.`);
    const car = a.inCar;
    for (const [b, word, fix] of [
      [gi, "in", "Start the drive after get_in ends."],
      [go, "out", "Stop the car before get_out starts."],
    ] as const) {
      if (!b) continue;
      const from = b.at as number;
      const end = from + (b.dur as number);
      // a tenth of a second of slack, for a length fitDuration stretched to its 0.8 s
      const moving = all.find((m) => m.who === car && isNum(m.at) && isNum(m.dur) && movesCar(m) && (m.at as number) < end - BOARDING.slack && (m.at as number) + (m.dur as number) > from + BOARDING.slack);
      if (moving) err(`${where}: ${car} moves at ${round(moving.at as number)} s while ${id} is still getting ${word} (until ${round(end)} s). ${fix}`);
    }
  }
}

/** The driver (a car's first rider, §45.43) waves only while the car stands still: a wave while it is in the car may
 * not overlap a beat that moves the car. A passenger may wave any time. */
function checkDriverWave(where: string, actors: unknown[], beats: unknown[], err: (m: string) => void): void {
  const all = beats.filter(isObj).filter((b) => isNum(b.at) && isNum(b.dur));
  const drivers = new Map<string, string>();
  for (const a of actors) if (isObj(a) && typeof a.castId === "string" && typeof a.inCar === "string" && !drivers.has(a.inCar)) drivers.set(a.inCar, a.castId);
  for (const [car, id] of drivers) {
    const own = all.filter((b) => b.who === id);
    const gi = own.find((b) => b.do === "get_in");
    const go = own.find((b) => b.do === "get_out");
    const inFrom = gi ? (gi.at as number) + (gi.dur as number) : 0;
    const inTo = go ? (go.at as number) : Infinity;
    for (const w of own.filter((b) => b.do === "wave")) {
      const from = Math.max(w.at as number, inFrom);
      const to = Math.min((w.at as number) + (w.dur as number), inTo);
      if (to - from <= BOARDING.slack) continue; // waving from outside the car
      const moving = all.find((m) => m.who === car && movesCar(m) && (m.at as number) < to - BOARDING.slack && (m.at as number) + (m.dur as number) > from + BOARDING.slack);
      if (moving) err(`${where}: ${id} drives ${car} and waves at ${round(w.at as number)} s while it moves (${round(moving.at as number)} to ${round((moving.at as number) + (moving.dur as number))} s). The driver waves only while the car is stopped: wave before it moves or after it stops, or let a passenger wave.`);
    }
  }
}

/** The most cuts a scene may have, and how close two may be (and how near the scene's end the last). */
export const CUTS = { max: 8, gap: 0.6 } as const;
/** The shots that look from inside or right behind the driver's car (§45.45): they need someone sitting in a car on a
 * road. Face up close needs it too when its person sits in a car. */
export const CAR_SHOTS: ReadonlySet<ShotId> = new Set<ShotId>(["driver_view", "side_window", "mirror", "speed_dial", "pedals", "road_behind"]);

const shotList = () => [...SHOTS].join(", ");

/** The cuts of a scene (§45.45): at most 8, sorted, at least 0.6 s apart and 0.6 s before the end, in a side view, each
 * shot with what it shows: a rider in a car on a road for the car shots, a road for Down the road, a person for Face
 * up close, and never while that rider is getting in or out. */
function checkCuts(sc: Obj, sid: string, dur: number, actors: unknown[], beats: unknown[], propKinds: Map<string, string>, err: (m: string) => void): void {
  const scene = `Scene ${sid}`;
  const cuts = sc.cuts;
  if (!Array.isArray(cuts)) {
    err(`${scene}: cuts must be a list of up to ${CUTS.max} cuts { at, shot, who } (it may be empty).`);
    return;
  }
  if (!cuts.length) return;
  if (cuts.length > CUTS.max) err(`${scene}: has ${cuts.length} cuts; the most is ${CUTS.max}.`);
  if (sc.view === "top") {
    err(`${scene} is seen from above; cuts work in side views only.`);
    return;
  }
  const actorIds = actors.filter(isObj).map((a) => a.castId).filter((v): v is string => typeof v === "string");
  // who sits in a car or truck of this scene, in the scene's order (the first is the scene's driver)
  const riders = actors.filter(isObj).filter((a) => typeof a.castId === "string" && typeof a.inCar === "string" && (propKinds.get(a.inCar) === "car" || propKinds.get(a.inCar) === "truck")).map((a) => a.castId as string);
  const road = SETS.has(sc.set as string) && setInfo(sc.set as SetId).road;
  const label = (CATALOG.sets.find((e) => e.id === sc.set)?.label ?? String(sc.set)).toLowerCase();
  const boarding = beats.filter(isObj).filter((b) => (b.do === "get_in" || b.do === "get_out") && typeof b.who === "string" && isNum(b.at) && isNum(b.dur));
  let prev: number | null = null;
  cuts.forEach((c, j) => {
    if (!isObj(c)) return err(`${scene}: cut ${j + 1} must be an object { at, shot, who }.`);
    const shot = c.shot as string;
    const at = c.at;
    if (!SHOTS.has(shot)) err(`${scene}: cut ${j + 1}'s shot ${show(shot)} is not a shot; use one of ${shotList()}.`);
    if (!isNum(at) || at < 0) {
      err(`${scene}: cut ${j + 1}'s at is ${show(at)}; use seconds from the scene's start (0 or more).`);
      return;
    }
    if (at >= dur - CUTS.gap) err(`${scene}: the cut at ${round(at)} s is too near the end; cut before ${round(dur - CUTS.gap)} s (${CUTS.gap} s before the scene ends).`);
    if (prev !== null) {
      if (at < prev) err(`${scene}: cuts must be in time order; the cut at ${round(at)} s comes after the one at ${round(prev)} s.`);
      else if (at - prev < CUTS.gap - 1e-9) err(`${scene}: cuts at ${round(prev)} s and ${round(at)} s are too close; keep cuts at least ${CUTS.gap} s apart.`);
    }
    prev = at;
    const who = c.who;
    if (who !== undefined && (typeof who !== "string" || !actorIds.includes(who))) {
      err(`${scene}: the cut at ${round(at)} s is about ${show(who)}, who is not in this scene; use one of its actors (${list(actorIds) || "none"}) or leave who out.`);
      return;
    }
    if (!SHOTS.has(shot) || shot === "scene") return;
    // the shot lasts until the next cut or the scene's end
    const next = cuts[j + 1];
    const until = isObj(next) && isNum(next.at) && next.at > at ? next.at : dur;
    const name = `the shot "${shot}" at ${round(at)} s`;
    const needsRoad = () => {
      if (!road) err(`${scene} is in the ${label}; the shot "${shot}" needs a road. Use a road place or another shot.`);
      return road;
    };
    let rider: string | null = null;
    if (shot === "face") {
      const person = typeof who === "string" ? who : (riders[0] ?? actorIds[0]);
      if (!person) return err(`${scene}: ${name} needs a person in the scene; add an actor or use another shot.`);
      if (!riders.includes(person)) return;
      rider = person;
    } else if (shot === "road_wide") {
      needsRoad();
      return;
    } else if (CAR_SHOTS.has(shot as ShotId)) {
      rider = typeof who === "string" && riders.includes(who) ? who : (riders[0] ?? null);
      if (!rider) return err(`${scene}: ${name} needs someone sitting in a car; nobody in this scene has inCar. Put the driver in a car, or use the whole scene.`);
    }
    if (!rider || !needsRoad()) return;
    for (const b of boarding.filter((x) => x.who === rider)) {
      const from = b.at as number;
      const end = from + (b.dur as number);
      if (from >= until - 1e-9 || end <= at + 1e-9) continue;
      if (b.do === "get_in") err(`${scene}: ${name} needs someone sitting in a car; ${rider} is still getting in until ${round(end)} s. Cut after that, or use the whole scene.`);
      else err(`${scene}: ${name} needs someone sitting in a car; ${rider} gets out from ${round(from)} s. Cut back to the whole scene before that.`);
    }
  });
}

export function validateScript(input: unknown): ValidateResult {
  const errors: string[] = [];
  const err = (m: string) => {
    if (errors.length < 80) errors.push(m);
  };
  if (!isObj(input)) return { ok: false, errors: ["The script must be a JSON object."] };
  const s = input;
  if (!isInt(s.engine) || s.engine < 1) err(`engine is ${show(s.engine)}; it must be a whole number of 1 or more (the engine version).`);
  if (s.fps !== FPS) err(`fps is ${show(s.fps)}; it must be ${FPS}.`);
  if (s.width !== WIDTH || s.height !== HEIGHT) {
    const sizes = formatsSentence();
    if (!formatOf(s.width, s.height)) err(`width × height is ${show(s.width)} × ${show(s.height)}; use one of ${sizes}.`);
    else if (!isInt(s.engine) || s.engine < SIZES_FROM_ENGINE) {
      err(`width × height is ${show(s.width)} × ${show(s.height)}; a script for engine ${show(s.engine)} must be ${WIDTH} × ${HEIGHT} (vertical 9:16). Scripts for engine ${SIZES_FROM_ENGINE} and later may also be ${sizes}.`);
    }
  }
  if (s.art !== undefined && s.art !== "night_drive" && s.art !== "classic") err('art must be "night_drive" or "classic" (the drawing style).');
  const art: ArtStyle = s.art === "night_drive" ? "night_drive" : "classic";
  if (!isNum(s.durationSec) || s.durationSec <= 0 || s.durationSec > LIMITS.totalSec) err(`durationSec is ${show(s.durationSec)}; use the story's length in seconds (fitDuration brings it to at most ${MAX_SECONDS}).`);
  if (typeof s.title !== "string" || !s.title.trim() || s.title.length > 100) err("title must be 1 to 100 characters.");
  if (!isInt(s.seed) || s.seed < 0 || s.seed > 0xffffffff) err(`seed is ${show(s.seed)}; it must be a whole number from 0 to 4294967295.`);
  const castIds = checkCast(s.cast, err);
  const cars = checkCars(s.cars, castIds, err);
  const own = new Map<string, Own>();
  if (isObj(s.cast)) for (const id of castIds) {
    const o = ownOf(s.cast[id]);
    if (o) own.set(id, o);
  }
  if (s.music !== null && s.music !== undefined) {
    if (!isObj(s.music) || !MOODS.has(s.music.mood as string) || !isNum(s.music.volume) || s.music.volume < 0 || s.music.volume > 1) {
      err(`music must be null or { mood: one of ${list([...MOODS])}, volume: 0 to 1 }.`);
    }
  }
  if (typeof s.captionsOn !== "boolean") err("captionsOn must be true or false.");
  let total = 0;
  if (!Array.isArray(s.scenes) || s.scenes.length === 0) err(`scenes must be a list of 1 to ${LIMITS.scenes} scenes.`);
  else {
    if (s.scenes.length > LIMITS.scenes) err(`there are ${s.scenes.length} scenes; the most is ${LIMITS.scenes}.`);
    const seenScenes = new Set<string>();
    const seenFx = new Set<string>();
    s.scenes.forEach((sc, i) => {
      checkScene(sc, i, castIds, seenScenes, seenFx, err, own, cars, art);
      if (isObj(sc) && isNum(sc.durationSec)) total += sc.durationSec;
    });
    if (total > LIMITS.totalSec) err(`the scenes add up to ${round(total)} s; write at most ${LIMITS.totalSec} s (fitDuration then brings it to the target).`);
    else if (isNum(s.durationSec) && total > 0 && Math.abs(s.durationSec - total) > TOL) {
      err(`durationSec is ${round(s.durationSec)} but the scenes add up to ${round(total)} s; set it to ${round(total)} (or run fit).`);
    }
  }
  if (s.captions !== undefined) {
    if (!Array.isArray(s.captions)) err("captions must be a list (it may be empty).");
    else {
      if (s.captions.length > LIMITS.captions) err(`there are ${s.captions.length} captions; the most is ${LIMITS.captions}.`);
      const seen = new Set<string>();
      s.captions.forEach((c, j) => {
        const cw = `caption ${j + 1}`;
        if (!isObj(c)) return err(`${cw}: must be { id, at, dur, text }.`);
        if (typeof c.id !== "string" || !c.id) err(`${cw}: id is missing.`);
        else if (seen.has(c.id)) err(`${cw}: id "${c.id}" is used twice.`);
        else seen.add(c.id);
        if (!isNum(c.at) || c.at < 0) err(`${cw}: at is ${show(c.at)}; use seconds from the start of the video.`);
        else if (total > 0 && c.at >= total) err(`${cw}: starts at ${c.at} s, after the story ends (${round(total)} s).`);
        if (!isNum(c.dur) || c.dur < 0.3) err(`${cw}: dur is ${show(c.dur)}; a caption shows for at least 0.3 s.`);
        else if (isNum(c.at) && total > 0 && c.at + c.dur > total + TOL) err(`${cw}: ends at ${round(c.at + c.dur)} s, after the story ends (${round(total)} s).`);
        if (typeof c.text !== "string" || !c.text.trim() || c.text.length > 60) err(`${cw}: text must be 1 to 60 characters.`);
        if (c.guidanceRef !== undefined && (typeof c.guidanceRef !== "string" || !c.guidanceRef)) err(`${cw}: guidanceRef must be a guidance step id like "skid-recovery.2".`);
      });
    }
  }
  if (s.safety !== null && s.safety !== undefined) {
    const sf = s.safety;
    if (!isObj(sf) || typeof sf.topicId !== "string" || !sf.topicId || !Array.isArray(sf.citations)) err("safety must be null or { topicId, citations: [{ publisher, title, url }] }.");
    else if (sf.citations.some((c) => !isObj(c) || typeof c.publisher !== "string" || typeof c.title !== "string" || typeof c.url !== "string")) err("safety.citations: each needs publisher, title and url.");
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, script: withDefaults(s as unknown as StoryScript) };
}

/** After the writer's last try (CONTRACTS §45.34): every beat's face that its character does not have becomes
 * neutral, and every noise it does not make is left out. Works on the raw script (anything else about it is left as
 * it was, valid or not) and says what it changed; only cast members that carry their own faces are touched, the
 * same ones validateScript holds to their lists. A car of the cast (§45.43) with no face loses every face on its
 * prop's beats; one with a face keeps only its own (another becomes neutral). */
export function repairScript(input: unknown): { script: unknown; changes: ScriptRepair[] } {
  if (!isObj(input) || !isObj(input.cast) || !Array.isArray(input.scenes)) return { script: input, changes: [] };
  const own = new Map<string, Own>();
  for (const [id, m] of Object.entries(input.cast)) {
    const o = ownOf(m);
    if (o) own.set(id, o);
  }
  const cars = new Map<string, CarInfo>();
  if (isObj(input.cars))
    for (const [id, m] of Object.entries(input.cars)) {
      if (!isObj(m)) continue;
      const name = typeof m.name === "string" && m.name.trim() ? m.name.trim() : "This car";
      cars.set(id, { name, face: carFaced(m.car), faces: Array.isArray(m.expressions) ? m.expressions.filter((f): f is string => typeof f === "string") : null });
    }
  const changes: ScriptRepair[] = [];
  const scenes = input.scenes.map((sc, i) => {
    if (!isObj(sc) || !Array.isArray(sc.beats)) return sc;
    const sceneId = typeof sc.sceneId === "string" ? sc.sceneId : `scene ${i + 1}`;
    const where = `scene ${i + 1}${typeof sc.sceneId === "string" ? ` (${sc.sceneId})` : ""}`;
    // this scene's car props of the cast: prop id → the car's cast id
    const propCar = new Map<string, string>();
    for (const p of Array.isArray(sc.props) ? sc.props : []) if (isObj(p) && p.kind === "car" && typeof p.propId === "string" && typeof p.castId === "string" && cars.has(p.castId)) propCar.set(p.propId, p.castId);
    let changed = false;
    const beats = sc.beats.map((b, j) => {
      if (isObj(b) && typeof b.who === "string" && typeof b.face === "string" && propCar.has(b.who)) {
        const castId = propCar.get(b.who)!;
        const car = cars.get(castId)!;
        if (car.face && (!car.faces || car.faces.includes(b.face))) return b;
        const next: Obj = { ...b };
        const now = car.face && car.faces!.includes("neutral") ? "neutral" : null;
        if (now) next.face = now;
        else delete next.face;
        const text = car.face ? `${where} beat ${j + 1}: ${car.name}'s face "${b.face}" is now ${now ? `"${now}"` : "left out"} (${car.name}'s own faces are ${andList(car.faces!)}).` : `${where} beat ${j + 1}: ${car.name} has no face, so its face "${b.face}" is left out.`;
        changes.push({ sceneId, beat: j, castId, field: "face", was: b.face, now, text });
        changed = true;
        return next;
      }
      if (!isObj(b) || typeof b.who !== "string" || !own.has(b.who)) return b;
      const o = own.get(b.who)!;
      const next: Obj = { ...b };
      const bw = `${where} beat ${j + 1}`;
      const before = changes.length;
      if (typeof b.face === "string" && !o.faces.includes(b.face)) {
        const now = o.faces.includes("neutral") ? "neutral" : null;
        if (now) next.face = now;
        else delete next.face;
        changes.push({ sceneId, beat: j, castId: b.who, field: "face", was: b.face, now, text: `${bw}: ${o.name}'s face "${b.face}" is now ${now ? `"${now}"` : "left out"} (${o.name}'s own faces are ${andList(o.faces)}).` });
      }
      if (typeof b.noise === "string" && !o.noises.includes(b.noise)) {
        delete next.noise;
        changes.push({ sceneId, beat: j, castId: b.who, field: "noise", was: b.noise, now: null, text: `${bw}: ${o.name}'s noise "${b.noise}" is left out (${o.noises.length ? `${o.name}'s own noises are ${andList(o.noises)}` : `${o.name} makes no noises`}).` });
      }
      if (changes.length === before) return b;
      changed = true;
      return next;
    });
    return changed ? { ...sc, beats } : sc;
  });
  return { script: changes.length ? { ...input, scenes } : input, changes };
}

/** Optional parts filled in, so the rest of the engine can rely on them. */
function withDefaults(s: StoryScript): StoryScript {
  return {
    ...s,
    music: s.music ?? null,
    captions: s.captions ?? [],
    safety: s.safety ?? null,
    scenes: s.scenes.map((sc) => ({ ...sc, sfx: sc.sfx ?? [], caption: sc.caption ?? null, note: sc.note ?? null })),
  };
}

const byAt = <T extends { at: number }>(a: T, b: T) => a.at - b.at;

/** Moves every Beat.sfx into its scene's own effects list (ids "{sceneId}.fx{k}"), gives each scene a seed (from the
 * script's seed and the scene id), and sorts beats and effects by time. A new scene (one with no seed yet, or with
 * effects still on its beats: the writer's answer) also gets the sounds its place needs for the whole scene (ids
 * "{sceneId}.amb{k}": wind, rain, traffic, an engine hum while someone drives), unless its list already has that
 * sound, and a honk ("{sceneId}.fx{k}") for each honk beat of a car with no honk within 0.3 s of it; a scene
 * normalized before is never given them again, so an effect the owner removed stays removed. Idempotent. */
export function normalizeScript(s: StoryScript): StoryScript {
  const used = new Set<string>();
  for (const sc of s.scenes) for (const c of sc.sfx ?? []) used.add(c.id);
  const fresh = (prefix: string) => {
    let k = 0;
    return () => {
      let id: string;
      do {
        k += 1;
        id = `${prefix}${k}`;
      } while (used.has(id));
      used.add(id);
      return id;
    };
  };
  const scenes: Scene[] = s.scenes.map((sc) => {
    const sfx: SfxCue[] = (sc.sfx ?? []).map((c) => ({ ...c }));
    const hasSeed = isInt(sc.seed) && sc.seed >= 0;
    const isNew = !hasSeed || sc.beats.some((b) => b.sfx !== undefined);
    const fxId = fresh(`${sc.sceneId}.fx`);
    const beats = sc.beats.map((b) => {
      if (!b.sfx) return { ...b };
      const { sfx: effect, ...rest } = b;
      sfx.push({ id: fxId(), at: b.at, sfx: effect, volume: 0.8 });
      return rest;
    });
    if (isNew) {
      // a car's honk plays its sound by itself (§45.43), unless the scene already honks within 0.3 s of it
      const carProps = new Set(sc.props.filter((p) => CARS.has(p.kind)).map((p) => p.propId));
      for (const bt of beats) {
        if (bt.do !== "honk" || !carProps.has(bt.who) || sfx.length >= LIMITS.sfx) continue;
        if (sfx.some((c) => c.sfx === "honk" && Math.abs(c.at - bt.at) <= 0.3)) continue;
        sfx.push({ id: fxId(), at: bt.at, sfx: "honk", volume: 0.8 });
      }
      const ambId = fresh(`${sc.sceneId}.amb`);
      for (const bed of sceneBeds(sc)) {
        if (sfx.length >= LIMITS.sfx || sfx.some((c) => c.sfx === bed.sfx)) continue;
        sfx.push({ id: ambId(), at: 0, sfx: bed.sfx, volume: bed.volume });
      }
    }
    const seed = hasSeed ? (sc.seed as number) : hash(s.seed, sc.sceneId);
    const out: Scene = { ...sc, seed, beats: stableSort(beats, byAt), sfx: stableSort(sfx, (a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), caption: sc.caption ?? null, note: sc.note ?? null };
    if (Array.isArray(sc.cuts)) out.cuts = stableSort(sc.cuts.map((c) => ({ ...c })), byAt);
    return out;
  });
  return { ...s, scenes, captions: stableSort([...(s.captions ?? [])], byAt), music: s.music ?? null, safety: s.safety ?? null };
}

function stableSort<T>(items: T[], cmp: (a: T, b: T) => number): T[] {
  return items
    .map((v, i) => ({ v, i }))
    .sort((a, b) => cmp(a.v, b.v) || a.i - b.i)
    .map((x) => x.v);
}

const ms = (v: number) => Math.round(v * 1000) / 1000;

/** Scales every scene (its beats, effects and the captions over it too) so the total lands on the target (±10%, to
 * a tenth of a second when it can) and never above MAX_SECONDS; every scene stays 2 to 15 s, and getting in or out of
 * a car 0.8 to 3 s. */
export function fitDuration(s: StoryScript, targetSec: number): StoryScript {
  const n = s.scenes.length;
  if (n === 0) return s;
  const old = s.scenes.map((sc) => sc.durationSec);
  const lo = SCENE_MIN * n;
  const hi = Math.min(MAX_SECONDS, SCENE_MAX * n);
  const want = Number.isFinite(targetSec) && targetSec > 0 ? targetSec : old.reduce((a, b) => a + b, 0);
  const target = Math.floor(clamp(want, lo, hi) * 10 + 1e-9);
  // the factor that makes the clamped scenes add up to the target
  const sumAt = (f: number) => old.reduce((a, d) => a + clamp(d * f * 10, SCENE_MIN * 10, SCENE_MAX * 10), 0);
  let a = 0;
  let b = 64;
  for (let i = 0; i < 64; i += 1) {
    const m = (a + b) / 2;
    if (sumAt(m) < target) a = m;
    else b = m;
  }
  const exact = old.map((d) => clamp(d * b * 10, SCENE_MIN * 10, SCENE_MAX * 10));
  const tenths = exact.map((v) => Math.floor(v + 1e-9));
  let left = target - tenths.reduce((x, y) => x + y, 0);
  const order = exact.map((v, i) => ({ i, frac: v - Math.floor(v + 1e-9) })).sort((x, y) => y.frac - x.frac || x.i - y.i);
  for (let pass = 0; left > 0 && pass < 4; pass += 1) {
    for (const { i } of order) {
      if (left <= 0) break;
      if (tenths[i]! < SCENE_MAX * 10) {
        tenths[i]! += 1;
        left -= 1;
      }
    }
  }
  for (let pass = 0; left < 0 && pass < 4; pass += 1) {
    for (const { i } of [...order].reverse()) {
      if (left >= 0) break;
      if (tenths[i]! > SCENE_MIN * 10) {
        tenths[i]! -= 1;
        left += 1;
      }
    }
  }
  const dur = tenths.map((v) => v / 10);
  const oldStarts: number[] = [];
  const newStarts: number[] = [];
  let ot = 0;
  let nt = 0;
  for (let i = 0; i < n; i += 1) {
    oldStarts.push(ot);
    newStarts.push(nt);
    ot += old[i]!;
    nt += dur[i]!;
  }
  const scenes: Scene[] = s.scenes.map((sc, i) => {
    const d = dur[i]!;
    const k = d / (old[i]! || 1);
    return {
      ...sc,
      durationSec: d,
      beats: sc.beats.map((bt) => {
        const at = Math.min(ms(bt.at * k), ms(d - 0.05));
        const dur = Math.max(0.05, Math.min(ms(bt.dur * k), ms(d - at)));
        // getting in or out keeps to its 0.8 to 3 seconds (§45.43)
        if (bt.do === "get_in" || bt.do === "get_out") return { ...bt, at, dur: Math.min(ms(d - at), clamp(dur, BOARDING.min, BOARDING.max)) };
        return { ...bt, at, dur };
      }),
      sfx: (sc.sfx ?? []).map((c) => ({ ...c, at: Math.min(ms(c.at * k), ms(d - 0.01)) })),
      ...(Array.isArray(sc.cuts) ? { cuts: scaleCuts(sc.cuts, k, d) } : {}),
    };
  });
  const total = nt;
  const remap = (t: number): number => {
    for (let i = n - 1; i >= 0; i -= 1) {
      if (t >= oldStarts[i]! - 1e-9) return newStarts[i]! + (t - oldStarts[i]!) * (dur[i]! / (old[i]! || 1));
    }
    return 0;
  };
  const captions: CaptionCue[] = (s.captions ?? []).map((c) => {
    const at = Math.min(ms(remap(c.at)), ms(Math.max(0, total - 0.3)));
    const end = Math.min(ms(remap(c.at + c.dur)), ms(total));
    return { ...c, at, dur: Math.max(0.3, ms(end - at)) };
  });
  return { ...s, scenes, captions, durationSec: Math.round(total * 10) / 10 };
}

/** A scene's cuts scaled with it (§45.45): each at × k, then any cut that comes less than 0.6 s after the one kept
 * before it, or less than 0.6 s before the scene's new end, is dropped. The API's _scale_scene does the same. */
export function scaleCuts(cuts: ShotCue[], k: number, d: number): ShotCue[] {
  const out: ShotCue[] = [];
  for (const c of cuts) {
    const at = ms(c.at * k);
    if (at >= d - CUTS.gap) continue;
    const last = out[out.length - 1];
    if (last && at - last.at < CUTS.gap - 1e-9) continue;
    out.push({ ...c, at });
  }
  return out;
}

export function frameCount(s: StoryScript): number {
  return Math.round(s.scenes.reduce((sum, sc) => sum + sc.durationSec, 0) * s.fps);
}

/** [first frame, end frame) of one scene; the scenes tile 0..frameCount exactly. */
export function sceneFrames(s: StoryScript, sceneId: string): [number, number] {
  let start = 0;
  for (const sc of s.scenes) {
    if (sc.sceneId === sceneId) return [Math.round(start * s.fps), Math.round((start + sc.durationSec) * s.fps)];
    start += sc.durationSec;
  }
  return [0, 0];
}

/** Each scene's frame range and its middle frame (the still). */
export function sceneList(s: StoryScript): { sceneId: string; from: number; to: number; mid: number }[] {
  return s.scenes.map((sc) => {
    const [from, to] = sceneFrames(s, sc.sceneId);
    return { sceneId: sc.sceneId, from, to, mid: from + Math.floor((to - from) / 2) };
  });
}

/** The scene a frame belongs to and the time inside it. */
export function locateFrame(s: StoryScript, frame: number): { index: number; t: number } {
  let start = 0;
  let index = 0;
  for (let i = 0; i < s.scenes.length; i += 1) {
    const from = Math.round(start * s.fps);
    if (frame >= from) index = i;
    start += s.scenes[i]!.durationSec;
  }
  let st = 0;
  for (let i = 0; i < index; i += 1) st += s.scenes[i]!.durationSec;
  return { index, t: Math.max(0, (frame - Math.round(st * s.fps)) / s.fps) };
}

export { CATALOG };
