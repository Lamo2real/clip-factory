// Every choice a character's rig offers (docs/CONTRACTS.md §45.8, CharacterLook in engine/types.ts), in plain words,
// plus the colour swatches and a fresh character to start from. The engine draws the same rig the same way every time,
// so these few choices are what keeps a character looking the same in every video. A car character (§45.42) has its
// own choices (CarLook, CATALOG.carLooks), its own swatches and a fresh car to start from.
import { isCar, type CarInput, type CharacterInput } from "../api/types.ts";
import { DEFAULT_CAR } from "../engine/car.ts";
import { CAR_DETAIL, FAMILY_FIT, resolveDetail } from "../engine/carDetail.ts";
import { CATALOG } from "../engine/catalog.ts";
import type { CarMove } from "../engine/engine.ts";
import type { CarDetail, CarLook, CarWheelShape, CharacterKind, CharacterLook, CharacterVoice, Expression, MovementStyle } from "../engine/types.ts";
import { VEHICLE_OF } from "../engine/types.ts";

type Opt<T extends string> = { value: T; label: string };

export const BODY: Opt<CharacterLook["body"]>[] = [
  { value: "bean", label: "Bean" },
  { value: "round", label: "Round" },
  { value: "tall", label: "Tall" },
  { value: "square", label: "Square" },
];

export const HAIR: Opt<CharacterLook["hair"]["style"]>[] = [
  { value: "none", label: "No hair" },
  { value: "short", label: "Short" },
  { value: "spiky", label: "Spiky" },
  { value: "curly", label: "Curly" },
  { value: "long", label: "Long" },
  { value: "bun", label: "Bun" },
  { value: "cap", label: "Cap" },
];

export const EYES: Opt<CharacterLook["eyes"]["shape"]>[] = [
  { value: "round", label: "Round" },
  { value: "oval", label: "Oval" },
  { value: "sleepy", label: "Sleepy" },
];

export const BROWS: Opt<CharacterLook["brows"]>[] = [
  { value: "thin", label: "Thin" },
  { value: "thick", label: "Thick" },
];

export const NOSE: Opt<CharacterLook["nose"]>[] = [
  { value: "dot", label: "Dot" },
  { value: "button", label: "Button" },
  { value: "long", label: "Long" },
  { value: "none", label: "No nose" },
];

export const MOUTH: Opt<CharacterLook["mouth"]>[] = [
  { value: "small", label: "Small" },
  { value: "wide", label: "Wide" },
];

export const PATTERN: Opt<CharacterLook["outfit"]["pattern"]>[] = [
  { value: "plain", label: "Plain" },
  { value: "stripes", label: "Stripes" },
  { value: "dots", label: "Dots" },
];

export const ACCESSORY: Opt<CharacterLook["accessory"]>[] = [
  { value: "none", label: "Nothing" },
  { value: "glasses", label: "Glasses" },
  { value: "scarf", label: "Scarf" },
  { value: "bowtie", label: "Bow tie" },
  { value: "helmet", label: "Helmet" },
  { value: "headphones", label: "Headphones" },
];

export const VOICE_STYLE: Opt<CharacterVoice["style"]>[] = [
  { value: "babble", label: "Babble" },
  { value: "hum", label: "Hum" },
  { value: "none", label: "Quiet" },
];

/** What each way of moving looks like, in one line. */
export const MOVE_LINE: Record<MovementStyle, string> = {
  bouncy: "Springy, with a little bounce",
  calm: "Slow and smooth",
  clumsy: "Wobbly and a bit silly",
  zippy: "Quick as a flash",
  heavy: "Big, slow steps",
};

export const SKIN = [
  { hex: "#ffe0c7", name: "Light peach" },
  { hex: "#f2c9a0", name: "Peach" },
  { hex: "#e0a878", name: "Tan" },
  { hex: "#c68652", name: "Caramel" },
  { hex: "#8d5a3b", name: "Brown" },
  { hex: "#5c3a24", name: "Dark brown" },
  { hex: "#9be3c4", name: "Mint green" },
  { hex: "#b8a6ff", name: "Lilac" },
];

export const HAIR_COLORS = [
  { hex: "#1f1a17", name: "Black" },
  { hex: "#3b2a1a", name: "Dark brown" },
  { hex: "#8a5a2b", name: "Brown" },
  { hex: "#e8c15a", name: "Blond" },
  { hex: "#c8501e", name: "Ginger" },
  { hex: "#d9d6d0", name: "Grey" },
  { hex: "#ff6f61", name: "Coral" },
  { hex: "#62c6ff", name: "Sky blue" },
];

export const EYE_COLORS = [
  { hex: "#1c1842", name: "Dark" },
  { hex: "#5a3b1e", name: "Brown" },
  { hex: "#2f7d5b", name: "Green" },
  { hex: "#2c6fb6", name: "Blue" },
  { hex: "#7a4fb5", name: "Purple" },
];

export const CLOTHES = [
  { hex: "#ff6f61", name: "Coral" },
  { hex: "#ffc94a", name: "Sunshine" },
  { hex: "#47d6a0", name: "Mint" },
  { hex: "#62c6ff", name: "Sky" },
  { hex: "#8b6cff", name: "Violet" },
  { hex: "#ff9ec7", name: "Pink" },
  { hex: "#fff6e5", name: "Cream" },
  { hex: "#2b2f45", name: "Ink" },
  { hex: "#3c6e47", name: "Forest" },
  { hex: "#a33b2f", name: "Brick" },
];

export const OUTLINES = [
  { hex: "#1c1842", name: "Night" },
  { hex: "#1f1a17", name: "Black" },
  { hex: "#5a3b1e", name: "Brown" },
  { hex: "#3a2f8f", name: "Indigo" },
];

export const DEFAULT_LOOK: CharacterLook = {
  body: "bean",
  skin: "#f2c9a0",
  height: 1,
  width: 1,
  hair: { style: "short", color: "#3b2a1a" },
  eyes: { shape: "round", color: "#1c1842" },
  brows: "thick",
  nose: "button",
  mouth: "wide",
  outfit: { top: "#ffc94a", bottom: "#2b2f45", accent: "#ff6f61", pattern: "plain" },
  accessory: "none",
  outline: "#1c1842",
};

export const DEFAULT_VOICE: CharacterVoice = { style: "babble", pitch: 1, noises: ["gasp", "yay", "hmm"], sfx: ["boing", "pop"] };

export const DEFAULT_FACES: Expression[] = ["neutral", "happy", "surprised", "worried", "relieved"];

export function newCharacter(): CharacterInput {
  return {
    name: "",
    description: "",
    personality: "",
    traits: [],
    movementStyle: "bouncy",
    expressions: [...DEFAULT_FACES],
    look: structuredClone(DEFAULT_LOOK),
    voice: structuredClone(DEFAULT_VOICE),
  };
}

/** The limits a character must keep (CONTRACTS §45.6 CharacterInput). */
export const CHAR_LIMITS = { name: 30, description: 400, personality: 400, traits: 8, trait: 30, faces: 3, noises: 8, sfx: 8, refs: 8 } as const;

/** Why this character cannot be saved yet, or null. */
export function characterProblem(c: CharacterInput): string | null {
  if (isCar(c)) return carProblem(c);
  if (!c.name.trim()) return "Give your character a name.";
  if (c.name.trim().length > CHAR_LIMITS.name) return `Keep the name to ${CHAR_LIMITS.name} letters.`;
  if (c.description.length > CHAR_LIMITS.description) return "Make the description a little shorter.";
  if (c.personality.length > CHAR_LIMITS.personality) return "Make the personality a little shorter.";
  if (c.traits.length > CHAR_LIMITS.traits) return `Keep it to ${CHAR_LIMITS.traits} traits.`;
  if (c.expressions.length < CHAR_LIMITS.faces) return `Pick at least ${CHAR_LIMITS.faces} faces.`;
  if (!c.expressions.includes("neutral")) return "Keep the Neutral face.";
  if (c.voice.noises.length > CHAR_LIMITS.noises) return `Pick at most ${CHAR_LIMITS.noises} noises.`;
  if (c.voice.sfx.length > CHAR_LIMITS.sfx) return `Pick at most ${CHAR_LIMITS.sfx} sound effects.`;
  return null;
}

/** Why this car cannot be saved yet, or null (the API's rules, §45.42: no voice, and no face keeps only neutral). */
function carProblem(c: CarInput): string | null {
  if (!c.name.trim()) return "Give your vehicle a name.";
  if (c.name.trim().length > CHAR_LIMITS.name) return `Keep the name to ${CHAR_LIMITS.name} letters.`;
  if (c.description.length > CHAR_LIMITS.description) return "Make the description a little shorter.";
  if (c.personality.length > CHAR_LIMITS.personality) return "Make the personality a little shorter.";
  if (c.traits.length > CHAR_LIMITS.traits) return `Keep it to ${CHAR_LIMITS.traits} traits.`;
  if (c.car.face.eyes === "none") {
    if (c.expressions.length !== 1 || c.expressions[0] !== "neutral") return "A car with no face keeps only the neutral face.";
  } else {
    if (c.expressions.length < CHAR_LIMITS.faces) return `Pick at least ${CHAR_LIMITS.faces} faces.`;
    if (!c.expressions.includes("neutral")) return "Keep the Neutral face.";
  }
  if (c.voice.style !== "none" || c.voice.noises.length) return "A car has no voice. Pick its sounds instead.";
  if (c.voice.sfx.length > CHAR_LIMITS.sfx) return `Pick at most ${CHAR_LIMITS.sfx} sound effects.`;
  return null;
}

/** The editable part of a saved character (what PUT sends back). */
export function inputOf(c: CharacterInput): CharacterInput {
  if (isCar(c))
    return {
      kind: "car",
      name: c.name,
      description: c.description,
      personality: c.personality,
      traits: [...c.traits],
      movementStyle: c.movementStyle,
      expressions: [...c.expressions],
      car: structuredClone(c.car),
      voice: structuredClone(c.voice),
    };
  return {
    name: c.name,
    description: c.description,
    personality: c.personality,
    traits: [...c.traits],
    movementStyle: c.movementStyle,
    expressions: [...c.expressions],
    look: structuredClone(c.look),
    voice: structuredClone(c.voice),
  };
}

/**
 * The face a preview shows for a character (§45.35 D21): happy when it has that face, else its first face that is not
 * neutral, else neutral. A character needs only neutral and two other faces, so a cast without "happy" is never drawn
 * smiling with a face it does not have.
 */
export function showFace(c: { expressions: Expression[]; kind?: CharacterKind; car?: CarLook }): Expression {
  // A car with no face has only neutral (§45.42).
  if (c.kind === "car" && c.car?.face?.eyes === "none") return "neutral";
  const faces = Array.isArray(c.expressions) ? c.expressions : [];
  if (faces.includes("happy")) return "happy";
  return faces.find((e) => e !== "neutral") ?? "neutral";
}

// ---------- A car character (§45.42) ----------

type CarOpt<K extends keyof typeof CATALOG.carLooks> = Opt<(typeof CATALOG.carLooks)[K][number]["id"]>;
const carOpts = <K extends keyof typeof CATALOG.carLooks>(k: K): CarOpt<K>[] =>
  (CATALOG.carLooks[k] as { id: string; label: string }[]).map((e) => ({ value: e.id, label: e.label })) as CarOpt<K>[];

export const CAR_BODY = carOpts("body");
export const CAR_PATTERN = carOpts("pattern");
export const CAR_WINDOWS = carOpts("windows");
export const CAR_WHEELS = carOpts("wheels");
export const CAR_FRONT_LIGHTS = carOpts("frontLights");
export const CAR_REAR_LIGHTS = carOpts("rearLights");
export const CAR_EXTRA = carOpts("extra");
export const CAR_EYES = carOpts("eyes");
export const CAR_MOUTH = carOpts("mouth");

/** Car paint (and the second colour): the usual car colours plus a few bright ones. */
export const PAINT = [
  { hex: "#d8352a", name: "Red" },
  { hex: "#f08a24", name: "Orange" },
  { hex: "#ffc94a", name: "Yellow" },
  { hex: "#3f8f4e", name: "Green" },
  { hex: "#2f6fb5", name: "Blue" },
  { hex: "#62c6ff", name: "Sky blue" },
  { hex: "#1f2a44", name: "Navy" },
  { hex: "#8b6cff", name: "Purple" },
  { hex: "#ff9ec7", name: "Pink" },
  { hex: "#f4f1ea", name: "White" },
  { hex: "#c9ccd2", name: "Silver" },
  { hex: "#7a7f88", name: "Grey" },
  { hex: "#1c1c22", name: "Black" },
];

export const RIMS = [
  { hex: "#c9ccd2", name: "Silver" },
  { hex: "#7a7f88", name: "Grey" },
  { hex: "#1c1c22", name: "Black" },
  { hex: "#f4f1ea", name: "White" },
  { hex: "#e8c15a", name: "Gold" },
  { hex: "#d8352a", name: "Red" },
];

/** How each way of moving looks on a car, in one line. */
export const CAR_MOVE_LINE: Record<MovementStyle, string> = {
  bouncy: "Springy, bounces when it stops",
  calm: "Smooth and steady",
  clumsy: "A bit wobbly",
  zippy: "Quick off the mark",
  heavy: "Slow to start, dips when it brakes",
};

/** The moves a car can try in the editor (§45.42), in the editor's order; idle is the parked car. */
export const CAR_MOVES: Opt<Exclude<CarMove, "idle">>[] = [
  { value: "drive", label: "Drive" },
  { value: "speed_up", label: "Speed up" },
  { value: "brake", label: "Brake" },
  { value: "turn", label: "Turn" },
  { value: "bounce", label: "Bounce" },
  { value: "honk", label: "Honk" },
  { value: "blink", label: "Flash lights" },
  { value: "stall", label: "Stall" },
];

/** What the editor's "Try a move" can show: a move, or the vehicle's nose ("front") or tail ("rear") head on (§45.48). */
export type CarTry = Exclude<CarMove, "idle"> | "front" | "rear";

/** The moves, then the two views. "Rear" (never "Back": Back is the editor's own button). */
export const CAR_TRIES: Opt<CarTry>[] = [...CAR_MOVES, { value: "front", label: "Front" }, { value: "rear", label: "Rear" }];

/** A move's label, with "Parked" for the car standing still. */
export function carMoveLabel(m: CarMove | CarTry): string {
  return m === "idle" ? "Parked" : (CAR_TRIES.find((x) => x.value === m)?.label ?? m);
}

/** The faces a car gets when its eyes go on with fewer than 3 (§45.42). */
export const CAR_FACES_ON: Expression[] = ["neutral", "happy", "surprised"];

export function newCar(): CarInput {
  return {
    kind: "car",
    name: "",
    description: "",
    personality: "",
    traits: [],
    movementStyle: "calm",
    expressions: ["neutral"],
    car: structuredClone(DEFAULT_CAR),
    voice: { style: "none", pitch: 1, noises: [], sfx: ["engine", "honk"] },
  };
}

/** The swatches with this colour added first when it is not one of them (a colour taken from the owner's photos). */
export function withColour(colors: { hex: string; name: string }[], hex: string, name: string): { hex: string; name: string }[] {
  return colors.some((c) => c.hex.toLowerCase() === hex.toLowerCase()) ? colors : [{ hex, name }, ...colors];
}

// ---------- Realistic vehicles (§45.48): the editor's words and the one place a `detail` key is written ----------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The choices of one enum rule of the detail schema, with the words the editor shows (`only` keeps some, in this order). */
export function detailOpts<T extends string = string>(path: string, only?: readonly string[]): Opt<T>[] {
  const rule = CAR_DETAIL[path];
  if (!rule || !("e" in rule)) return [];
  const ids = only ? only.filter((id) => rule.e.includes(id)) : rule.e;
  return ids.map((id) => ({ value: id as T, label: rule.label?.[id] ?? id }));
}

/** Roof: the four a kid can tell apart (the other two, a sunroof and a glass roof, stay with the AI). */
export const CAR_ROOF = detailOpts<"closed" | "open" | "targa" | "soft_top">("roof.type", ["closed", "open", "targa", "soft_top"]);

/** How cartoony: the three steps, as the number each writes (0 real proportions, 70 chunky). */
export const CAR_TOON: (Opt<"little" | "medium" | "lot"> & { toon: number })[] = [
  { value: "little", label: "A little", toon: 0 },
  { value: "medium", label: "Medium", toon: 30 },
  { value: "lot", label: "A lot", toon: 70 },
];

/** The step nearest to a `toon` number. */
export function toonStep(toon: number): "little" | "medium" | "lot" {
  return CAR_TOON.reduce((best, t) => (Math.abs(t.toon - toon) < Math.abs(best.toon - toon) ? t : best)).value;
}

/** Brakes: plain (the dull grey calipers) or coloured. */
export const CAR_BRAKES: Opt<"plain" | "coloured">[] = [
  { value: "plain", label: "Plain" },
  { value: "coloured", label: "Coloured" },
];

/** The brake colours; the first is the one "Coloured" starts with. */
export const BRAKE_COLOURS = [
  { hex: "#c8102e", name: "Red" },
  { hex: "#ffd21f", name: "Yellow" },
  { hex: "#2f6fb5", name: "Blue" },
  { hex: "#c9ccd2", name: "Silver" },
  { hex: "#1c1c22", name: "Black" },
];

/** The caliper colour of plain brakes (a dull grey: the engine's own default when nothing else says). */
export const PLAIN_CALIPER = "#5a5f68";

/** The picks of "More details" in the editor's order: the label shown, the key it writes and whether the family can use it. */
export const DETAIL_PICKS: { label: string; path: string; fit: "wheels" | "frontLight" | "rearLight" | "front" | "side" | "rear" | "always" }[] = [
  { label: "Wheel design", path: "wheels.shape", fit: "wheels" },
  { label: "Front lamp", path: "lights.front.shape", fit: "frontLight" },
  { label: "Rear lamp", path: "lights.rear.shape", fit: "rearLight" },
  { label: "Nose", path: "front.grille", fit: "front" },
  { label: "Sides", path: "side.intake", fit: "side" },
  { label: "Tail", path: "rear.exhaust", fit: "rear" },
  { label: "Stripes", path: "stripe.layout", fit: "always" },
  { label: "Finish", path: "finish", fit: "always" },
];

/** A copy of the detail with one key written (`undefined` removes it, and an object left empty goes with it). */
export function setDetail(detail: CarDetail, path: string, value: unknown): CarDetail {
  return setDetails(detail, [[path, value]]);
}

/** Several keys at once, in order. */
export function setDetails(detail: CarDetail, entries: [string, unknown][]): CarDetail {
  const out = structuredClone(detail) as unknown as Record<string, unknown>;
  for (const [path, value] of entries) {
    const keys = path.split(".");
    const last = keys[keys.length - 1]!;
    const parents: [Record<string, unknown>, string][] = [];
    let cur = out;
    let reached = true;
    for (const k of keys.slice(0, -1)) {
      let next = cur[k];
      if (!isObj(next)) {
        if (value === undefined) {
          reached = false;
          break;
        }
        next = {};
        cur[k] = next;
      }
      parents.push([cur, k]);
      cur = next as Record<string, unknown>;
    }
    if (!reached) continue;
    if (value === undefined) delete cur[last];
    else cur[last] = value;
    for (let i = parents.length - 1; i >= 0; i -= 1) {
      const [parent, k] = parents[i]!;
      if (isObj(parent[k]) && Object.keys(parent[k]).length === 0) delete parent[k];
      else break;
    }
  }
  return out as unknown as CarDetail;
}

/** The detail with the keys a classic control's tap would otherwise hide removed (so every tap shows). */
export const CLASSIC_CLEARS = {
  wheels: ["wheels.shape", "wheels.spokes"],
  front: ["lights.front.shape"],
  rear: ["lights.rear.shape"],
  pattern: ["stripe.layout", "twoTone"],
  extra: ["rear.spoiler"],
} as const;

/** What a classic control's tap writes: the patch, and (for a detailed vehicle) the detail without the keys it hides. */
export function classicTap(car: CarLook, patch: Partial<CarLook>, clears: readonly string[]): Partial<CarLook> {
  if (car.detail === undefined) return patch;
  return { ...patch, detail: setDetails(car.detail, clears.map((p) => [p, undefined] as [string, unknown])) };
}

/** What the "Photo shape" line is about: the body the AI measured, while the picked Shape is another (else null). */
export function photoShape(car: CarLook): string | null {
  const p = car.detail?.profile;
  if (!p || p.body === car.body) return null;
  return CAR_BODY.find((b) => b.value === p.body)?.label ?? null;
}

const SPOKE_WORDS: Partial<Record<CarWheelShape, string>> = { straight: "spokes", split: "double spokes", y: "forked spokes", star: "blade spokes", turbine: "fan blades" };
const WHEEL_WORDS: Partial<Record<CarWheelShape, string>> = { steel: "Steel wheels", cap: "Hubcap wheels", mesh: "Mesh wheels", dish: "Dish wheels", wire: "Wire wheels", block: "Chunky wheels" };

/**
 * What the editor saw, in a few words under the vehicle's name ("Open top · Centre stripe · Yellow brakes · 5 double
 * spokes"): labels and colour names only, at most four items, and nothing for a vehicle with no `detail`.
 */
export function seenLine(car: CarLook): string {
  if (car.detail === undefined) return "";
  const R = resolveDetail(car);
  const d = car.detail;
  const items: string[] = [];
  const label = (path: string, id: string) => {
    const rule = CAR_DETAIL[path];
    return rule && "e" in rule ? (rule.label?.[id] ?? id) : id;
  };
  if (R.roof.type !== "closed") items.push(label("roof.type", R.roof.type));
  if (R.stripe.layout !== "none") items.push(`${label("stripe.layout", R.stripe.layout)} stripe`);
  if (R.fits.brakes && R.brakes.disc !== "none" && R.brakes.caliper.toLowerCase() !== PLAIN_CALIPER) {
    items.push(`${BRAKE_COLOURS.find((c) => c.hex === R.brakes.caliper.toLowerCase())?.name ?? "Coloured"} brakes`);
  }
  if (R.fits.wheels) {
    const spoke = SPOKE_WORDS[R.wheels.shape];
    items.push(spoke ? `${R.wheels.spokes} ${spoke}` : (WHEEL_WORDS[R.wheels.shape] ?? "Wheels"));
  }
  if (d.lights?.front?.shape !== undefined && R.fits.frontLight) items.push(`${label("lights.front.shape", R.lights.front.shape)} lamps`);
  if (R.rear.spoiler !== "none" && R.fits.rear) items.push(label("rear.spoiler", R.rear.spoiler));
  if (R.finish !== "gloss") items.push(`${label("finish", R.finish)} finish`);
  return items.slice(0, 4).join(" · ");
}

/** The extras this vehicle's family can carry, with their labels (chips, up to 6). */
export function extraOpts(car: CarLook): Opt<string>[] {
  const rule = CAR_DETAIL["extras"];
  if (!rule || !("l" in rule)) return [];
  const fit = FAMILY_FIT[VEHICLE_OF[car.body] ?? "car"].extras;
  return rule.l.filter((id) => (fit as string[]).includes(id)).map((id) => ({ value: id, label: rule.label?.[id] ?? id }));
}

/** The most extras a vehicle may have. */
export const MAX_EXTRAS = CAR_DETAIL["extras"] && "l" in CAR_DETAIL["extras"] ? CAR_DETAIL["extras"].max : 6;
