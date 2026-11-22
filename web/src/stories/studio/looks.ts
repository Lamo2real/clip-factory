// Every choice a character's rig offers (docs/CONTRACTS.md §45.8, CharacterLook in engine/types.ts), in plain words,
// plus the colour swatches and a fresh character to start from. The engine draws the same rig the same way every time,
// so these few choices are what keeps a character looking the same in every video.
import type { CharacterInput } from "../api/types.ts";
import type { CharacterLook, CharacterVoice, Expression, MovementStyle } from "../engine/types.ts";

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

/** The editable part of a saved character (what PUT sends back). */
export function inputOf(c: CharacterInput): CharacterInput {
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
export function showFace(c: Pick<CharacterInput, "expressions">): Expression {
  const faces = Array.isArray(c.expressions) ? c.expressions : [];
  if (faces.includes("happy")) return "happy";
  return faces.find((e) => e !== "neutral") ?? "neutral";
}
