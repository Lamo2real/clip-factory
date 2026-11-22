// Lamo Stories engine: the story script's rules (CONTRACTS §45.10). validateScript explains every problem in a
// sentence the writer can act on; normalizeScript moves beat effects into the scene lists and fills seeds;
// fitDuration lands the story on its target length without breaking any scene rule; repairScript swaps a face or
// drops a noise a character does not have, after the writer's last try (CONTRACTS §45.34).

import { sceneBeds } from "./ambience.ts";
import { CATALOG, catalogIds } from "./catalog.ts";
import { formatOf, formatsSentence } from "./frame.ts";
import { clamp, hash, isHex } from "./math.ts";
import type { CaptionCue, Scene, ScriptRepair, SfxCue, StoryScript, ValidateResult } from "./types.ts";

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

/** Limits that keep every frame light enough for the agent's rasterizer. */
export const LIMITS = { scenes: 30, cast: 6, actors: 4, props: 12, beats: 40, sfx: 40, captions: 40, totalSec: 180, shapes: 480 };

/** About how many shapes (prims) each thing adds to a frame at its busiest (measured on the busiest sets, with every
 * action it can do); weather draws once however many of it there are. */
export const SHAPES = {
  set: 60,
  wetSet: 80,
  actor: 70,
  props: { car: 45, truck: 36, deer: 30, snow: 36, rain: 42, fog: 8, ice_patch: 15, tree: 15, sparkles: 15 } as Partial<Record<string, number>>,
  prop: 12,
} as const;
const ONCE = new Set(["snow", "rain", "fog"]);

/** A scene's busiest frame, roughly, in shapes: validateScript keeps it at most LIMITS.shapes. */
export function sceneShapes(scene: { set?: unknown; actors?: unknown; props?: unknown }): number {
  let n = scene.set === "snowy_road" || scene.set === "rainy_road" ? SHAPES.wetSet : SHAPES.set;
  if (Array.isArray(scene.actors)) n += scene.actors.length * SHAPES.actor;
  const seen = new Set<string>();
  if (Array.isArray(scene.props)) {
    for (const p of scene.props) {
      const kind = isObj(p) && typeof p.kind === "string" ? p.kind : "";
      if (ONCE.has(kind) && seen.has(kind)) continue;
      seen.add(kind);
      n += SHAPES.props[kind] ?? SHAPES.prop;
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

/** The character agent's answer, or a saved character: a CharacterInput (CONTRACTS §45.6, §45.33). Its look, movement
 * style and voice follow the same rules as a script's cast; its faces are at least 3 different known ones, neutral
 * among them; its name, description, personality and traits keep their lengths. */
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
  checkLook(input.look, where, err);
  if (!STYLES.has(input.movementStyle as string)) err(`${where}: movementStyle is ${show(input.movementStyle)}; use one of ${list([...STYLES])}.`);
  checkVoice(input.voice, where, err);
  const faces = input.expressions;
  if (!Array.isArray(faces) || faces.length < 3 || faces.some((f) => !FACES.has(f as string)) || !faces.includes("neutral") || new Set(faces).size !== faces.length) {
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

function checkScene(sc: unknown, i: number, castIds: string[], seenScenes: Set<string>, seenFx: Set<string>, err: (m: string) => void, own: Map<string, Own>): Obj | null {
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
      if (!castIds.includes(cid)) err(`${aw}: castId ${show(cid)} is not in the cast (${list(castIds)}).`);
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
    const shapes = sceneShapes(sc);
    if (shapes > LIMITS.shapes) {
      const plural: Record<string, string> = { car: "cars", truck: "trucks", deer: "deer" };
      const heavy = [...new Set(props.map((p) => plural[(isObj(p) && (p.kind as string)) || ""]).filter((v): v is string => !!v))];
      err(`${where}: is too busy to draw quickly (about ${shapes} shapes at once; the most is ${LIMITS.shapes}). Use fewer ${[...heavy, "characters"].join(", ").replace(/, ([^,]*)$/, " or $1")} in it (a character is about ${SHAPES.actor} shapes, a car ${SHAPES.props.car}, a small prop ${SHAPES.prop}).`);
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
      if (b.face !== undefined && (!isActor || !FACES.has(b.face as string))) err(`${bw}: face ${show(b.face)} ${isActor ? `is not in the catalog; use one of ${list([...FACES], 14)}` : "is for characters only"}.`);
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
  }

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
  if (!isNum(s.durationSec) || s.durationSec <= 0 || s.durationSec > LIMITS.totalSec) err(`durationSec is ${show(s.durationSec)}; use the story's length in seconds (fitDuration brings it to at most ${MAX_SECONDS}).`);
  if (typeof s.title !== "string" || !s.title.trim() || s.title.length > 100) err("title must be 1 to 100 characters.");
  if (!isInt(s.seed) || s.seed < 0 || s.seed > 0xffffffff) err(`seed is ${show(s.seed)}; it must be a whole number from 0 to 4294967295.`);
  const castIds = checkCast(s.cast, err);
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
      checkScene(sc, i, castIds, seenScenes, seenFx, err, own);
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
 * same ones validateScript holds to their lists. */
export function repairScript(input: unknown): { script: unknown; changes: ScriptRepair[] } {
  if (!isObj(input) || !isObj(input.cast) || !Array.isArray(input.scenes)) return { script: input, changes: [] };
  const own = new Map<string, Own>();
  for (const [id, m] of Object.entries(input.cast)) {
    const o = ownOf(m);
    if (o) own.set(id, o);
  }
  const changes: ScriptRepair[] = [];
  const scenes = input.scenes.map((sc, i) => {
    if (!isObj(sc) || !Array.isArray(sc.beats)) return sc;
    const sceneId = typeof sc.sceneId === "string" ? sc.sceneId : `scene ${i + 1}`;
    const where = `scene ${i + 1}${typeof sc.sceneId === "string" ? ` (${sc.sceneId})` : ""}`;
    let changed = false;
    const beats = sc.beats.map((b, j) => {
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
 * sound; a scene normalized before is never given them again, so an effect the owner removed stays removed.
 * Idempotent. */
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
      const ambId = fresh(`${sc.sceneId}.amb`);
      for (const bed of sceneBeds(sc)) {
        if (sfx.length >= LIMITS.sfx || sfx.some((c) => c.sfx === bed.sfx)) continue;
        sfx.push({ id: ambId(), at: 0, sfx: bed.sfx, volume: bed.volume });
      }
    }
    const seed = hasSeed ? (sc.seed as number) : hash(s.seed, sc.sceneId);
    return { ...sc, seed, beats: stableSort(beats, byAt), sfx: stableSort(sfx, (a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), caption: sc.caption ?? null, note: sc.note ?? null };
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
 * a tenth of a second when it can) and never above MAX_SECONDS; every scene stays 2 to 15 s. */
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
        return { ...bt, at, dur: Math.max(0.05, Math.min(ms(bt.dur * k), ms(d - at))) };
      }),
      sfx: (sc.sfx ?? []).map((c) => ({ ...c, at: Math.min(ms(c.at * k), ms(d - 0.01)) })),
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
