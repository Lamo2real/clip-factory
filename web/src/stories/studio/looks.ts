// Every choice a character's rig offers (docs/CONTRACTS.md §45.8, CharacterLook in engine/types.ts), in plain words,
// plus the colour swatches and a fresh character to start from. The engine draws the same rig the same way every time,
// so these few choices are what keeps a character looking the same in every video. A car character (§45.42) has its
// own choices (CarLook, CATALOG.carLooks), its own swatches and a fresh car to start from.
import { isCar, type CarInput, type CharacterInput } from "../api/types.ts";
import { DEFAULT_CAR } from "../engine/car.ts";
import { CATALOG } from "../engine/catalog.ts";
import type { CarMove } from "../engine/engine.ts";
import type { CarLook, CharacterKind, CharacterLook, CharacterVoice, Expression, MovementStyle } from "../engine/types.ts";

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

/** A move's label, with "Parked" for the car standing still. */
export function carMoveLabel(m: CarMove): string {
  return m === "idle" ? "Parked" : (CAR_MOVES.find((x) => x.value === m)?.label ?? m);
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
