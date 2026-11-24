// Lamo Stories mock: the characters part (docs/CONTRACTS.md §45.8, §45.16.8). Builder G.
// Saved rigs with their faces, moves and sounds; edits carry a version (409 when it is stale); delete refuses while a
// story with the character is being made; reference pictures go through a pretend presigned PUT (mock:// URLs, which
// web/src/api/upload.ts plays out with progress); a portrait only when AI pictures are on in Settings; and "Design
// with AI": a picture for it (designUpload, a design_ref the Library never lists) and the character agent's task that
// suggests a whole CharacterInput from the owner's words and/or that picture (a draft: nothing is saved).
// A car character (§45.42): the API's car rules mirrored (no voice, no face keeps only neutral), a design from up to 6
// photos that suggests 3 cartoon cars to pick from (result.characters; result.character is the first), and Rosso,
// the seeded red hatchback (SEED_CAR_ID, added once every part has seeded: afterSeed, or seedCar in a test).
// Vehicles (§45.47): still kind "car", with the new bodies (bus, motorbike, plane, boat) and an optional `interior`;
// a design takes up to 8 photos (6 outside, 4 inside, `referenceSides`) and keeps to the `vehicle` family's bodies,
// and inside photos give the interior; each reference picture keeps its `side`. The rule texts are §45.47's.
import {
  isCar,
  VEHICLE_OF,
  type CarInput,
  type Character,
  type CharacterInput,
  type LibraryItem,
  type PersonInput,
  type PhotoSide,
  type ProductionJob,
  type StoriesApi,
  type StoriesConfig,
  type VehicleType,
} from "../types.ts";
import { DEFAULT_CAR } from "../../engine/car.ts";
import { CATALOG } from "../../engine/catalog.ts";
import type { CarBody, CarLook, CharacterLook, Expression, MovementStyle, NoiseId, SfxId } from "../../engine/types.ts";
import { startMockTask } from "./ideas.ts";
import { delay, type MockStore } from "./store.ts";
import { clone, fail, guardWs, iso, mockId, SEED_IDS } from "./stories.ts";

export const KEYS = ["listCharacters", "createCharacter", "getCharacter", "putCharacter", "deleteCharacter", "referenceUpload", "referenceComplete", "deleteReference", "makePortrait", "designCharacter", "designUpload"] as const;

const EXPRESSIONS = ["neutral", "happy", "laughing", "surprised", "shocked", "scared", "worried", "angry", "determined", "thinking", "sad", "proud", "dizzy", "relieved"];
const MOVES = ["bouncy", "calm", "clumsy", "zippy", "heavy"];
const TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_BYTES = 10 * 1024 * 1024;
/** How long a pretend portrait takes. */
const PORTRAIT_MS = 3000;

/** A small picture as a data URL (the practice app has no files): a framed figure in the character's colours. */
export function picture(bg: string, body: string, head: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" rx="18" fill="${bg}"/><rect x="38" y="58" width="44" height="48" rx="18" fill="${body}"/><circle cx="60" cy="42" r="22" fill="${head}"/><circle cx="52" cy="40" r="3" fill="#1c1842"/><circle cx="68" cy="40" r="3" fill="#1c1842"/><path d="M50 50q10 8 20 0" stroke="#1c1842" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function look(partial: Partial<CharacterLook> & Pick<CharacterLook, "skin">): CharacterLook {
  return {
    body: "bean",
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
    ...partial,
  };
}

/** Rosso, the seeded car (a red hatchback). */
export const SEED_CAR_ID = "01JSTCH0000000000000000005";

/** A small picture of a car as a data URL, in its paint (the practice app has no files). */
export function carPicture(bg: string, paint: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" rx="18" fill="${bg}"/><path d="M14 78 q4-20 24-22 l10-16 q4-6 12-6 h18 q8 0 13 7 l10 15 q18 2 20 22 v6 h-107 z" fill="${paint}"/><path d="M50 44 h26 l9 13 h-44 z" fill="#bfe3f2"/><circle cx="36" cy="86" r="11" fill="#1c1842"/><circle cx="36" cy="86" r="5" fill="#c9ccd2"/><circle cx="88" cy="86" r="11" fill="#1c1842"/><circle cx="88" cy="86" r="5" fill="#c9ccd2"/><circle cx="108" cy="72" r="4" fill="#ffe9a8"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** The character's own small picture: a figure in its colours, or its car. */
function pictureOf(c: CharacterInput, bg: string): string {
  return isCar(c) ? carPicture(bg, c.car.paint) : picture(bg, c.look.outfit.top, c.look.skin);
}

const HEX = /^#[0-9a-f]{6}$/i;
const ids = (list: { id: string }[]) => list.map((e) => e.id);

/** Why this car look is not one the engine draws (the API's car_look), or null. */
function carLookProblem(car: unknown): string | null {
  const k = CATALOG.carLooks;
  const c = car as Partial<CarLook> | null;
  if (!c || typeof c !== "object") return "Pick how the car looks.";
  const inRange = (n: unknown, lo: number, hi: number) => typeof n === "number" && n >= lo && n <= hi;
  // Every body the engine knows (§45.47: the new vehicles too), the same list as the API's CAR_BODIES.
  if (!Object.keys(VEHICLE_OF).includes(c.body as string)) return "Pick the car's shape.";
  if (!inRange(c.length, 0.85, 1.15) || !inRange(c.height, 0.85, 1.15)) return "Keep the car's length and height in range.";
  if (![c.paint, c.accent, c.outline, c.wheels?.rim, c.face?.color].every((h) => typeof h === "string" && HEX.test(h))) return "Pick the car's colours.";
  if (!ids(k.pattern).includes(c.pattern as string) || !ids(k.windows).includes(c.windows as string)) return "Pick the car's paint and windows.";
  if (!c.wheels || !ids(k.wheels).includes(c.wheels.style) || !inRange(c.wheels.size, 0.85, 1.2)) return "Pick the car's wheels.";
  if (!c.lights || !ids(k.frontLights).includes(c.lights.front) || !ids(k.rearLights).includes(c.lights.rear)) return "Pick the car's lights.";
  if (!ids(k.extra).includes(c.extra as string)) return "Pick what is on top of the car.";
  if (!c.face || !ids(k.eyes).includes(c.face.eyes) || !ids(k.mouth).includes(c.face.mouth)) return "Pick the car's face.";
  if (c.interior !== undefined) {
    const i = c.interior as Partial<NonNullable<CarLook["interior"]>> | null;
    if (!i || typeof i !== "object" || ![i.seat, i.dash, ...(i.trim === undefined ? [] : [i.trim])].every((h) => typeof h === "string" && HEX.test(h))) return "Pick the car's colours.";
  }
  return null;
}

function check(c: CharacterInput): void {
  const kind = (c as { kind?: unknown }).kind;
  if (kind !== undefined && kind !== "person" && kind !== "car") fail(400, "bad_request", "Pick a person or a vehicle.");
  const name = (c.name ?? "").trim();
  if (!name) fail(400, "bad_request", "Give your character a name.");
  if (name.length > 30) fail(400, "bad_request", "Keep the name to 30 letters.");
  if ((c.description ?? "").length > 400) fail(400, "bad_request", "Make the description a little shorter.");
  if ((c.personality ?? "").length > 400) fail(400, "bad_request", "Make the personality a little shorter.");
  if (!Array.isArray(c.traits) || c.traits.length > 8 || c.traits.some((t) => !t.trim() || t.length > 30)) fail(400, "bad_request", "Use up to 8 short traits.");
  if (!MOVES.includes(c.movementStyle)) fail(400, "bad_request", "Pick a way of moving.");
  if (isCar(c)) {
    if (!Array.isArray(c.expressions) || c.expressions.some((e) => !EXPRESSIONS.includes(e))) fail(400, "bad_request", "Pick at least 3 faces, with Neutral.");
    const bad = carLookProblem(c.car);
    if (bad) fail(400, "bad_request", bad);
    if (!c.voice || c.voice.style !== "none" || c.voice.noises.length) fail(400, "bad_request", "A car has no voice. Pick its sounds instead.");
    if (c.voice.sfx.length > 8) fail(400, "bad_request", "Check the sounds: up to 8 noises and 8 effects.");
    if (c.car.face.eyes === "none" ? c.expressions.length !== 1 || c.expressions[0] !== "neutral" : c.expressions.length < 3 || !c.expressions.includes("neutral"))
      fail(400, "bad_request", c.car.face.eyes === "none" ? "A car with no face keeps only the neutral face." : "Pick at least 3 faces, with Neutral.");
    return;
  }
  if (!Array.isArray(c.expressions) || c.expressions.length < 3 || !c.expressions.includes("neutral") || c.expressions.some((e) => !EXPRESSIONS.includes(e)))
    fail(400, "bad_request", "Pick at least 3 faces, with Neutral.");
  if (!c.look || !/^#[0-9a-f]{6}$/i.test(c.look.skin)) fail(400, "bad_request", "Pick a skin colour.");
  if (!c.voice || c.voice.pitch < 0.5 || c.voice.pitch > 2 || c.voice.noises.length > 8 || c.voice.sfx.length > 8) fail(400, "bad_request", "Check the sounds: up to 8 noises and 8 effects.");
}

function input(c: CharacterInput): CharacterInput {
  if (isCar(c))
    return {
      kind: "car",
      name: c.name.trim(),
      description: c.description,
      personality: c.personality,
      traits: c.traits.map((t) => t.trim()),
      movementStyle: c.movementStyle,
      expressions: [...c.expressions],
      car: clone(c.car),
      // A car's pitch is stored as 1 (§45.42).
      voice: { ...clone(c.voice), pitch: 1 },
    };
  return {
    name: c.name.trim(),
    description: c.description,
    personality: c.personality,
    traits: c.traits.map((t) => t.trim()),
    movementStyle: c.movementStyle,
    expressions: [...c.expressions],
    look: clone(c.look),
    voice: clone(c.voice),
  };
}

function find(store: MockStore, ws: string, id: string): Character {
  const c = store.characters.find((x) => x.characterId === id && x.workspaceId === ws);
  if (!c) fail(404, "not_found", "We could not find that character. It may have been deleted.");
  return c;
}

function out(store: MockStore, c: Character): Character {
  const copy = clone(c);
  copy.storyCount = store.stories.filter((s) => s.workspaceId === c.workspaceId && s.characterIds.includes(c.characterId)).length;
  return copy;
}

function config(store: MockStore, ws: string): Partial<StoriesConfig> {
  return (store.workspaces.find((w) => w.workspaceId === ws)?.configuration ?? {}) as Partial<StoriesConfig>;
}

/** The pretend upload in flight: assetId → the character and type it was asked for. */
const pending = new WeakMap<MockStore, Map<string, { characterId: string; contentType: string; filename: string; size: number; side?: PhotoSide }>>();
/** A portrait job and when it started. */
const portraits = new WeakMap<ProductionJob, number>();

function addAsset(store: MockStore, c: Character, assetId: string, kind: LibraryItem["kind"], url: string, contentType: string, bytes: number): void {
  store.assets.push({ assetId, kind, storyId: null, characterId: c.characterId, title: c.name, url, contentType, bytes, version: null, createdAt: iso(), meta: { current: 1 } });
}

/** Finishes portrait jobs whose time is up (each read of a character calls this). */
function settlePortraits(store: MockStore, now = Date.now()): void {
  for (const job of store.jobs) {
    const start = portraits.get(job);
    if (start === undefined || (job.status !== "queued" && job.status !== "running")) continue;
    const step = job.steps[0]!;
    if (now - start < PORTRAIT_MS) {
      job.status = "running";
      step.status = "running";
      job.progress = Math.min(0.95, (now - start) / PORTRAIT_MS);
      continue;
    }
    const c = store.characters.find((x) => x.characterId === job.contentId);
    job.status = "ready";
    job.progress = 1;
    step.status = "done";
    step.finishedAt = iso(now);
    job.updatedAt = iso(now);
    if (!c) continue;
    const assetId = mockId();
    const url = pictureOf(c, "#322a73");
    for (const a of store.assets) if (a.kind === "portrait" && a.characterId === c.characterId) a.meta = { ...a.meta, current: 0 };
    c.portrait = { assetId, url };
    addAsset(store, c, assetId, "portrait", url, "image/png", 48_000);
  }
}

// ---------- Design with AI (the practice character agent) ----------

/** Pictures sent for "Design with AI": assetId → the workspace, its type and a pretend picture. Never in the Library. */
const designs = new WeakMap<MockStore, Map<string, { ws: string; contentType: string; filename: string }>>();

function designsOf(store: MockStore) {
  let d = designs.get(store);
  if (!d) {
    d = new Map();
    designs.set(store, d);
  }
  return d;
}

const COLOR_WORDS: [RegExp, string][] = [
  [/\b(yellow|sunny|gold(en)?)\b/i, "#ffc94a"],
  [/\b(red|coral|orange)\b/i, "#ff6f61"],
  [/\b(green|mint)\b/i, "#47d6a0"],
  [/\b(blue|sky)\b/i, "#62c6ff"],
  [/\b(purple|violet|lilac)\b/i, "#8b6cff"],
  [/\bpink\b/i, "#ff9ec7"],
  [/\b(white|cream)\b/i, "#fff6e5"],
  [/\b(black|dark)\b/i, "#2b2f45"],
  [/\bbrown\b/i, "#a33b2f"],
];

const HAIR_COLOR_WORDS: [RegExp, string][] = [
  [/\b(blond|blonde|golden) hair\b/i, "#e8c15a"],
  [/\b(ginger|red) hair\b/i, "#c8501e"],
  [/\b(grey|gray|silver|white) hair\b/i, "#d9d6d0"],
  [/\bblack hair\b/i, "#1f1a17"],
  [/\bbrown hair\b/i, "#8a5a2b"],
  [/\b(blue) hair\b/i, "#62c6ff"],
  [/\b(pink|coral) hair\b/i, "#ff6f61"],
];

const NAMES = ["Zuzu", "Momo", "Taz", "Kiki", "Bix", "Lulu", "Rolo", "Fizz"];

function pickBy<T>(text: string, table: [RegExp, T][], fallback: T): T {
  return table.find(([re]) => re.test(text))?.[1] ?? fallback;
}

/**
 * The practice character agent: a whole rig, faces, moves and sounds from the owner's words (and, when there is one,
 * a picture), using only the engine's own look choices, so the draft always draws and always saves.
 */
export function designFromWords(words: string, withPicture: boolean, salt: number): PersonInput {
  const t = words.trim();
  const named = /\b(?:called|named)\s+([A-Z][A-Za-z'-]{0,20}(?:\s+[A-Z][A-Za-z'-]{0,20})?)/.exec(t)?.[1];
  const name = (named ?? NAMES[salt % NAMES.length]!).slice(0, 30);
  const body: CharacterLook["body"] = /\btall\b|\blanky\b/i.test(t) ? "tall" : /\bround\b|\bchubby\b|\bplump\b/i.test(t) ? "round" : /\bsquare\b|\bboxy\b|\brobot\b/i.test(t) ? "square" : "bean";
  const hairStyle: CharacterLook["hair"]["style"] = /\bbald\b|\bno hair\b/i.test(t)
    ? "none"
    : /\bcurly\b/i.test(t)
      ? "curly"
      : /\bspiky\b/i.test(t)
        ? "spiky"
        : /\blong hair\b/i.test(t)
          ? "long"
          : /\bbun\b/i.test(t)
            ? "bun"
            : /\bcap\b|\bhat\b/i.test(t)
              ? "cap"
              : "short";
  const accessory: CharacterLook["accessory"] = /\bglasses|specs\b/i.test(t)
    ? "glasses"
    : /\bscarf\b/i.test(t)
      ? "scarf"
      : /\bbow ?tie\b/i.test(t)
        ? "bowtie"
        : /\bhelmet\b/i.test(t)
          ? "helmet"
          : /\bheadphones\b/i.test(t)
            ? "headphones"
            : "none";
  const movementStyle: MovementStyle = /\bclumsy|wobbly|silly\b/i.test(t) ? "clumsy" : /\bfast|quick|speedy|zippy|rush/i.test(t) ? "zippy" : /\bcalm|slow|wise|gentle\b/i.test(t) ? "calm" : /\bbig|heavy|strong\b/i.test(t) ? "heavy" : "bouncy";
  const top = pickBy(t, COLOR_WORDS, withPicture ? "#62c6ff" : "#ffc94a");
  const hair = pickBy(t, HAIR_COLOR_WORDS, hairStyle === "cap" ? top : "#3b2a1a");
  const robot = /\brobot\b/i.test(t);
  const look: CharacterLook = {
    body,
    skin: robot ? "#9be3c4" : /\bdark skin|brown skin\b/i.test(t) ? "#8d5a3b" : "#f2c9a0",
    height: body === "tall" ? 1.1 : body === "round" ? 0.95 : 1,
    width: body === "round" ? 1.1 : 1,
    hair: { style: hairStyle, color: hair },
    eyes: { shape: /\bsleepy|tired\b/i.test(t) ? "sleepy" : "round", color: "#1c1842" },
    brows: movementStyle === "calm" ? "thin" : "thick",
    nose: robot ? "dot" : "button",
    mouth: /\bshy|quiet\b/i.test(t) ? "small" : "wide",
    outfit: { top, bottom: top === "#2b2f45" ? "#62c6ff" : "#2b2f45", accent: top === "#ff6f61" ? "#ffc94a" : "#ff6f61", pattern: /\bstripe/i.test(t) ? "stripes" : /\bdots|spotty|spots\b/i.test(t) ? "dots" : "plain" },
    accessory,
    outline: "#1c1842",
  };
  const shy = /\bshy|quiet\b/i.test(t);
  const expressions: Expression[] = ["neutral", "happy", "surprised", movementStyle === "clumsy" ? "dizzy" : "worried", shy ? "worried" : "laughing", "determined", "relieved"].filter((e, i, a) => a.indexOf(e) === i) as Expression[];
  const noises: NoiseId[] = shy ? ["hmm", "giggle", "sigh"] : movementStyle === "clumsy" ? ["oops", "whoa", "laugh"] : ["gasp", "yay", "phew"];
  const sfx: SfxId[] = robot ? ["beep", "click"] : movementStyle === "zippy" ? ["whoosh", "pop"] : ["boing", "ding"];
  const traits = [...new Set((t.match(/\b(brave|kind|funny|shy|clumsy|curious|calm|wise|cheeky|careful|cheerful|speedy|grumpy|happy)\b/gi) ?? []).map((w) => w.toLowerCase()))].slice(0, 8);
  const description = (t || "Designed from your picture.").slice(0, 400);
  return {
    name,
    description,
    personality: (traits.length ? `${traits.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(", ")}.` : withPicture ? "Friendly and curious, like in your picture." : "Friendly and curious.").slice(0, 400),
    traits: traits.length ? traits : ["friendly", "curious"],
    movementStyle,
    expressions,
    look,
    voice: { style: robot ? "hum" : "babble", pitch: shy ? 1.3 : movementStyle === "heavy" ? 0.7 : 1, noises, sfx },
  };
}

/** The sentence for a portrait while AI pictures are off (CONTRACTS §45.34: it names Settings › Video › Picture maker). */
export const PICTURES_OFF = "AI pictures are off. Turn them on in Clips Funded › Settings › Video › Picture maker.";
/** An older pick of Amazon Nova Canvas, which Amazon ended (the API's sentence, §45.37). */
export const NOVA_CANVAS_ENDED = "Amazon Nova Canvas was ended by Amazon on 30 Sep 2026. Pick another picture maker in Clips Funded › Settings › Video.";

/**
 * The practice character agent redesigning a saved character (§45.34): it starts from the character as it is (CURRENT),
 * keeps its name, and changes only the parts the owner's words are about; words about none of them give a new outfit.
 */
export function redesign(current: CharacterInput, fresh: CharacterInput, words: string): CharacterInput {
  // A car is redesigned by carRedesign; a person only from a person.
  if (isCar(current) || isCar(fresh)) return { ...structuredClone(current), name: current.name };
  const t = words.trim();
  const next = structuredClone(current);
  const said = (re: RegExp) => re.test(t);
  let changed = false;
  if (said(/\b(tall|lanky|round|chubby|plump|square|boxy|robot)\b/i)) {
    next.look = { ...next.look, body: fresh.look.body, height: fresh.look.height, width: fresh.look.width };
    changed = true;
  }
  if (said(/\b(bald|no hair|curly|spiky|long hair|bun|cap|hat)\b|\bhair\b/i)) {
    next.look = { ...next.look, hair: { ...fresh.look.hair } };
    changed = true;
  }
  if (said(/\b(glasses|specs|scarf|bow ?tie|helmet|headphones)\b/i)) {
    next.look = { ...next.look, accessory: fresh.look.accessory };
    changed = true;
  }
  if (COLOR_WORDS.some(([re]) => re.test(t)) || said(/\b(stripe|stripes|dots|spotty|spots|jumper|shirt|outfit|clothes)\b/i)) {
    next.look = { ...next.look, outfit: { ...fresh.look.outfit } };
    changed = true;
  }
  if (said(/\b(clumsy|wobbly|silly|fast|quick|speedy|zippy|rush|calm|slow|wise|gentle|heavy|strong|bouncy)\b/i)) {
    next.movementStyle = fresh.movementStyle;
    changed = true;
  }
  if (said(/\b(sound|sounds|voice|noise|noises|hum|beep)\b/i)) {
    next.voice = structuredClone(fresh.voice);
    changed = true;
  }
  if (said(/\b(face|faces|smile|frown|expression)\b/i)) {
    next.expressions = [...fresh.expressions];
    changed = true;
  }
  if (!changed) next.look = { ...next.look, outfit: { ...fresh.look.outfit, top: fresh.look.outfit.top === current.look.outfit.top ? "#8b6cff" : fresh.look.outfit.top } };
  return { ...next, name: current.name };
}

// ---------- Design with AI for a car (the practice character agent, §45.42) ----------

const CAR_COLOR_WORDS: [RegExp, string][] = [
  [/\b(red|cherry)\b/i, "#d8352a"],
  [/\borange\b/i, "#f08a24"],
  [/\b(yellow|gold(en)?)\b/i, "#ffc94a"],
  [/\bgreen\b/i, "#3f8f4e"],
  [/\bnavy\b/i, "#1f2a44"],
  [/\b(light blue|sky)\b/i, "#62c6ff"],
  [/\bblue\b/i, "#2f6fb5"],
  [/\b(purple|violet)\b/i, "#8b6cff"],
  [/\bpink\b/i, "#ff9ec7"],
  [/\bwhite\b/i, "#f4f1ea"],
  [/\bsilver\b/i, "#c9ccd2"],
  [/\b(grey|gray)\b/i, "#7a7f88"],
  [/\bblack\b/i, "#1c1c22"],
];

const PAINT_NAME: Record<string, string> = {
  "#d8352a": "red",
  "#f08a24": "orange",
  "#ffc94a": "yellow",
  "#3f8f4e": "green",
  "#1f2a44": "navy",
  "#62c6ff": "light blue",
  "#2f6fb5": "blue",
  "#8b6cff": "purple",
  "#ff9ec7": "pink",
  "#f4f1ea": "white",
  "#c9ccd2": "silver",
  "#7a7f88": "grey",
  "#1c1c22": "black",
};

const CAR_BODY_WORDS: [RegExp, CarBody][] = [
  // §45.47: the other vehicles first ("a bus" is never a hatchback).
  [/\b(bus|coach)\b/i, "bus"],
  [/\b(motorbike|motorcycle|scooter|moped)\b/i, "motorbike"],
  [/\b(plane|aeroplane|airplane|jet)\b/i, "plane"],
  [/\b(boat|ship|yacht|ferry)\b/i, "boat"],
  [/\bhatch(back)?\b/i, "hatchback"],
  [/\b(saloon|sedan)\b/i, "sedan"],
  [/\b(estate|wagon)\b/i, "estate"],
  [/\b(suv|jeep|4x4)\b/i, "suv"],
  [/\b(pick-?up|truck)\b/i, "pickup"],
  [/\bvan\b/i, "van"],
  [/\b(sports?|racer|racing)\b/i, "sports"],
  [/\b(tiny|mini|little)\b/i, "compact"],
];

const CAR_NAMES = ["Rosso", "Zoom", "Bluey", "Rusty", "Sunny", "Biscuit", "Pebble", "Comet", "Nugget", "Scooter", "Dot", "Bumble", "Turbo", "Maple"];

/** What makes each option look different (the first is the closest to the photos). */
const CAR_VARIANTS: ((c: CarLook) => Partial<CarLook>)[] = [
  () => ({}),
  (c) => ({ pattern: "stripe", accent: c.paint === "#f4f1ea" ? "#1c1c22" : "#f4f1ea", wheels: { ...c.wheels, style: "sport" } }),
  (c) => ({ face: { ...c.face, eyes: "windscreen" }, wheels: { ...c.wheels, style: "hubcap" } }),
  (c) => ({ pattern: "two_tone", accent: "#f4f1ea", wheels: { ...c.wheels, style: "steel", rim: "#7a7f88" } }),
  (c) => ({ pattern: "racing_stripes", accent: "#f4f1ea", extra: "spoiler", wheels: { ...c.wheels, style: "sport", size: 1.1 } }),
  (c) => ({ face: { ...c.face, eyes: "headlights", mouth: "grille" }, windows: "tinted" }),
];

/** A shade a little lighter or darker, for options past the sixth. */
function shade(hex: string, by: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v + by))).toString(16).padStart(2, "0");
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
}

/** Each kind's bodies (§45.47 D6), from VEHICLE_OF. */
const BODIES_OF = (vehicle: VehicleType) => (Object.keys(VEHICLE_OF) as CarBody[]).filter((b) => VEHICLE_OF[b] === vehicle);

/** The inside colours the mock "sees" in inside photos (the real agent reads them off the photos). */
const MOCK_INTERIOR = { seat: "#3a3f4b", dash: "#23262e", trim: "#c9ccd2" };

/** The car the words (and the photos) describe, before any option's own change. A `vehicle` keeps to its bodies. */
function carFromWords(t: string, base: CarLook, vehicle?: VehicleType): CarLook {
  const said = CAR_BODY_WORDS.find(([re]) => re.test(t))?.[1] ?? base.body;
  const allowed = vehicle ? BODIES_OF(vehicle) : null;
  const body = !allowed || allowed.includes(said) ? said : allowed.includes(base.body) ? base.body : allowed[0]!;
  const paint = CAR_COLOR_WORDS.find(([re]) => re.test(t))?.[1] ?? base.paint;
  const face = /\b(eyes|face|smile|smiling|cute)\b/i.test(t) ? { ...base.face, eyes: "windscreen" as const } : base.face;
  return {
    ...base,
    body,
    paint,
    length: /\b(small|short)\b/i.test(t) ? 0.9 : /\blong\b/i.test(t) ? 1.1 : base.length,
    windows: /\btinted\b/i.test(t) ? "tinted" : base.windows,
    extra: /\broof rack\b/i.test(t) ? "roof_rack" : /\bspoiler\b/i.test(t) ? "spoiler" : /\broof box\b/i.test(t) ? "roof_box" : base.extra,
    face,
  };
}

/**
 * The practice character agent's cartoon cars (§45.42): `count` options from the owner's words (and photos), each
 * clearly different from the others and from `avoid`, the first the closest; their names are not taken. A redesign
 * starts from the saved car (`current`) and keeps its name.
 */
export function designCars(
  words: string,
  photos: number,
  salt: number,
  count: number,
  avoid: CarLook[],
  taken: string[],
  current: CarInput | null = null,
  vehicle?: VehicleType,
  insidePhotos = 0,
): CarInput[] {
  const t = words.trim();
  const start = carFromWords(t, current ? current.car : { ...DEFAULT_CAR, wheels: { ...DEFAULT_CAR.wheels }, lights: { ...DEFAULT_CAR.lights }, face: { ...DEFAULT_CAR.face } }, vehicle);
  // Inside photos set only the interior (§45.47).
  if (insidePhotos > 0) start.interior = { ...MOCK_INTERIOR };
  const names = new Set(taken.map((n) => n.toLowerCase()));
  const zippy = /\b(fast|quick|zippy|sport|racing)\b/i.test(t);
  const out: CarInput[] = [];
  for (let i = 0; i < count; i += 1) {
    const v = avoid.length + i + (current ? 1 : 0);
    const tweak = CAR_VARIANTS[v % CAR_VARIANTS.length]!(start);
    const car: CarLook = { ...start, ...tweak, wheels: { ...start.wheels, ...(tweak.wheels ?? {}) }, face: { ...start.face, ...(tweak.face ?? {}) } };
    if (v >= CAR_VARIANTS.length) car.paint = shade(car.paint, v % 2 ? 24 : -24);
    const name = current ? current.name : (CAR_NAMES.map((_, k) => CAR_NAMES[(salt + v + k) % CAR_NAMES.length]!).find((n) => !names.has(n.toLowerCase())) ?? `Car ${salt + v}`);
    names.add(name.toLowerCase());
    const eyes = car.face.eyes !== "none";
    const colour = PAINT_NAME[start.paint] ?? "bright";
    const shape = CATALOG.carLooks.body.find((b) => b.id === car.body)?.label.toLowerCase() ?? (VEHICLE_OF[car.body] === "car" ? "car" : car.body);
    out.push({
      kind: "car",
      name,
      description: `A ${car.length < 0.95 ? "small " : ""}${colour} ${shape}${eyes ? " with eyes on its windscreen" : ""}.`.slice(0, 400),
      personality: current?.personality || (photos ? "Brand new and a bit nervous, like in your photos." : "Brand new and a bit nervous.").slice(0, 400),
      traits: current?.traits.length ? [...current.traits] : ["shiny", "new"],
      movementStyle: current?.movementStyle ?? (zippy ? "zippy" : "calm"),
      expressions: eyes ? ["neutral", "happy", "surprised"] : ["neutral"],
      car,
      voice: { style: "none", pitch: 1, noises: [], sfx: current ? [...current.voice.sfx] : ["engine", "honk"] },
    });
  }
  return out;
}

/** Rosso, the seeded red hatchback (§45.42): added once, after every part has seeded. */
export function seedCar(store: MockStore): void {
  if (store.characters.some((c) => c.characterId === SEED_CAR_ID)) return;
  const at = iso(Date.now() - 10 * 86_400_000);
  const rosso: Character = {
    kind: "car",
    characterId: SEED_CAR_ID,
    workspaceId: "stories",
    name: "Rosso",
    description: "A small red hatchback with alloy wheels and round lights.",
    personality: "Brand new and a bit nervous. Loves a clean road and a sunny day.",
    traits: ["new", "shiny", "a bit nervous"],
    movementStyle: "zippy",
    expressions: ["neutral"],
    car: { ...DEFAULT_CAR, length: 0.95, wheels: { ...DEFAULT_CAR.wheels }, lights: { ...DEFAULT_CAR.lights }, face: { ...DEFAULT_CAR.face } },
    voice: { style: "none", pitch: 1, noises: [], sfx: ["engine", "honk", "brake_squeal"] },
    references: [],
    portrait: null,
    storyCount: 0,
    version: 1,
    createdAt: at,
    updatedAt: at,
  };
  store.characters.push(rosso);
}

/** Rosso joins the cast once every part has seeded, so parts that count the people they seed still count four. */
export function afterSeed(store: MockStore): void {
  seedCar(store);
}

export function seed(store: MockStore): void {
  const ws = "stories";
  const at = iso(Date.now() - 12 * 86_400_000);
  const base = { workspaceId: ws, references: [], portrait: null, storyCount: 0, version: 1, createdAt: at, updatedAt: at };
  const pip: Character = {
    ...base,
    characterId: SEED_IDS.characters.pip,
    name: "Pip",
    description: "A small, round-faced driver in a sunny yellow jumper with a coral scarf.",
    personality: "Cheerful and curious. Gets a fright easily, then stays calm and does the right thing.",
    traits: ["cheerful", "curious", "careful driver"],
    movementStyle: "bouncy",
    expressions: ["neutral", "happy", "surprised", "shocked", "worried", "determined", "relieved", "proud"],
    look: look({ skin: "#f2c9a0", accessory: "scarf", outfit: { top: "#ffc94a", bottom: "#2b2f45", accent: "#ff6f61", pattern: "plain" } }),
    voice: { style: "babble", pitch: 1.25, noises: ["gasp", "whoa", "phew", "yay"], sfx: ["boing", "ding"] },
  };
  const refId = "01JSTRF0000000000000000001";
  pip.references = [{ assetId: refId, url: picture("#26205a", "#ffc94a", "#f2c9a0"), contentType: "image/png", createdAt: at }];
  const bolt: Character = {
    ...base,
    characterId: SEED_IDS.characters.bolt,
    name: "Bolt",
    description: "A tall, quick kid in a sky-blue cap and striped top.",
    personality: "Always in a rush. Learns that slow and steady gets it right.",
    traits: ["speedy", "funny", "never gives up"],
    movementStyle: "zippy",
    expressions: ["neutral", "happy", "laughing", "surprised", "thinking", "proud"],
    look: look({ body: "tall", skin: "#8d5a3b", height: 1.1, hair: { style: "cap", color: "#62c6ff" }, nose: "dot", outfit: { top: "#62c6ff", bottom: "#fff6e5", accent: "#ffc94a", pattern: "stripes" } }),
    voice: { style: "hum", pitch: 1.5, noises: ["whoa", "laugh", "yay"], sfx: ["whoosh", "pop"] },
  };
  const nana: Character = {
    ...base,
    characterId: SEED_IDS.characters.nana,
    name: "Nana Rose",
    description: "A round, kind grandma with a grey bun, glasses and a mint cardigan with dots.",
    personality: "Calm and wise. Has seen it all and explains things slowly.",
    traits: ["calm", "wise", "loves maps"],
    movementStyle: "calm",
    expressions: ["neutral", "happy", "thinking", "worried", "relieved"],
    look: look({ body: "round", skin: "#ffe0c7", hair: { style: "bun", color: "#d9d6d0" }, eyes: { shape: "sleepy", color: "#2c6fb6" }, brows: "thin", mouth: "small", accessory: "glasses", outfit: { top: "#47d6a0", bottom: "#8b6cff", accent: "#fff6e5", pattern: "dots" } }),
    voice: { style: "hum", pitch: 0.8, noises: ["hmm", "sigh", "giggle"], sfx: ["ding", "tick"] },
  };
  const dash: Character = {
    ...base,
    characterId: SEED_IDS.characters.dash,
    name: "Dash",
    description: "A square, clumsy friend in a coral helmet who trips over everything.",
    personality: "Big-hearted and a bit clumsy. Makes everyone laugh.",
    traits: ["clumsy", "kind", "hungry"],
    movementStyle: "clumsy",
    expressions: ["neutral", "happy", "laughing", "shocked", "dizzy", "sad"],
    look: look({ body: "square", skin: "#c68652", width: 1.1, hair: { style: "none", color: "#1f1a17" }, nose: "long", accessory: "helmet", outfit: { top: "#ff6f61", bottom: "#3c6e47", accent: "#ffc94a", pattern: "plain" } }),
    voice: { style: "babble", pitch: 0.65, noises: ["oops", "yelp", "laugh", "babble"], sfx: ["thud", "boing", "sad_trombone"] },
  };
  store.characters.push(pip, bolt, nana, dash);
  addAsset(store, pip, refId, "character_ref", pip.references[0]!.url, "image/png", 52_000);
}

export function api(store: MockStore): Pick<StoriesApi, (typeof KEYS)[number]> {
  const uploads = pending.get(store) ?? new Map();
  pending.set(store, uploads);
  return {
    async listCharacters(ws) {
      guardWs(store, ws);
      await delay(120);
      settlePortraits(store);
      return store.characters
        .filter((c) => c.workspaceId === ws)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => out(store, c));
    },
    async createCharacter(ws, c) {
      guardWs(store, ws);
      check(c);
      await delay(200);
      const name = c.name.trim();
      if (store.characters.some((x) => x.workspaceId === ws && x.name.toLowerCase() === name.toLowerCase()))
        fail(409, "conflict", `You already have a character called ${name}. Pick another name.`);
      const at = iso();
      const made: Character = { ...input(c), characterId: mockId(), workspaceId: ws, references: [], portrait: null, storyCount: 0, version: 1, createdAt: at, updatedAt: at };
      store.characters.push(made);
      return out(store, made);
    },
    async getCharacter(ws, id) {
      guardWs(store, ws);
      await delay(100);
      settlePortraits(store);
      return out(store, find(store, ws, id));
    },
    async putCharacter(ws, id, c) {
      guardWs(store, ws);
      check(c);
      await delay(200);
      const saved = find(store, ws, id);
      if (c.version !== saved.version) fail(409, "conflict", `${saved.name} was changed somewhere else while you were editing.`);
      const name = c.name.trim();
      if (store.characters.some((x) => x.workspaceId === ws && x.characterId !== id && x.name.toLowerCase() === name.toLowerCase()))
        fail(409, "conflict", `You already have a character called ${name}. Pick another name.`);
      Object.assign(saved, input(c), { version: saved.version + 1, updatedAt: iso() });
      for (const a of store.assets) if (a.characterId === id) a.title = saved.name;
      return out(store, saved);
    },
    async deleteCharacter(ws, id) {
      guardWs(store, ws);
      await delay(160);
      const c = find(store, ws, id);
      const busy = store.stories.some(
        (s) => s.workspaceId === ws && s.characterIds.includes(id) && store.jobs.some((j) => j.jobId === s.currentJobId && (j.status === "queued" || j.status === "running")),
      );
      if (busy) fail(409, "conflict", `${c.name} is in a story that is being made. Wait until it is done.`);
      store.characters = store.characters.filter((x) => x.characterId !== id);
      store.assets = store.assets.filter((a) => !(a.characterId === id && a.storyId === null));
    },
    async referenceUpload(ws, id, file) {
      guardWs(store, ws);
      const c = find(store, ws, id);
      if (!TYPES.includes(file.contentType)) fail(400, "bad_request", "Pick a PNG, JPG or WebP picture.");
      if (file.size > MAX_BYTES) fail(413, "too_large", "That picture is too big. Pick one under 10 MB.");
      if (c.references.length >= 8) fail(409, "conflict", "A character can have up to 8 pictures. Remove one first.");
      if (file.side !== undefined && file.side !== "outside" && file.side !== "inside") fail(400, "bad_request", "Pick outside or inside.");
      await delay(120);
      const assetId = mockId();
      uploads.set(assetId, { characterId: id, contentType: file.contentType, filename: file.filename, size: file.size, ...(file.side === "inside" ? { side: "inside" } : {}) });
      return { assetId, uploadUrl: `mock://stories/refs/${assetId}`, headers: { "Content-Type": file.contentType } };
    },
    async referenceComplete(ws, id, assetId) {
      guardWs(store, ws);
      const c = find(store, ws, id);
      const up = uploads.get(assetId);
      if (!up || up.characterId !== id) fail(404, "not_found", "That picture did not arrive. Try again.");
      if (c.references.length >= 8) fail(409, "conflict", "A character can have up to 8 pictures. Remove one first.");
      await delay(140);
      uploads.delete(assetId);
      const url = pictureOf(c, "#26205a");
      // A picture keeps its side (§45.47); left out, it is an outside one.
      c.references.push({ assetId, url, contentType: up.contentType, createdAt: iso(), ...(up.side === "inside" ? { side: "inside" as const } : {}) });
      c.updatedAt = iso();
      addAsset(store, c, assetId, "character_ref", url, up.contentType, up.size);
      return out(store, c);
    },
    // A character's reference picture (a reference video is deleteReferenceVideo, the references part: §45.34).
    async deleteReference(ws, id, assetId) {
      guardWs(store, ws);
      const c = find(store, ws, id);
      await delay(120);
      if (!c.references.some((r) => r.assetId === assetId)) fail(404, "not_found", "That picture is already gone.");
      c.references = c.references.filter((r) => r.assetId !== assetId);
      store.assets = store.assets.filter((a) => a.assetId !== assetId);
      return out(store, c);
    },
    async makePortrait(ws, id) {
      guardWs(store, ws);
      const c = find(store, ws, id);
      // §45.37: AI portraits come from Stability AI or the owner's own picture model; Amazon ended Nova Canvas, so an
      // older pick of it is refused with the API's sentence (a call could only fail).
      const images = config(store, ws).providers?.images ?? "builtin-rig";
      if (images === "nova-canvas") fail(409, "conflict", NOVA_CANVAS_ENDED);
      if (images !== "stability" && images !== "own-images") fail(409, "conflict", PICTURES_OFF);
      await delay(160);
      const at = iso();
      const job: ProductionJob = {
        jobId: mockId(),
        workspaceId: ws,
        contentType: "character",
        contentId: c.characterId,
        jobType: "portrait",
        status: "queued",
        steps: [{ key: "portrait", label: "Draw the picture", status: "pending" }],
        progress: 0,
        configuration: { run: ["portrait"], from: null, sceneIds: null, note: null },
        meta: { writerModel: null, engineVersion: null, seed: 7, scriptVersion: null, targetSec: null, actualSec: null, safetyTopicId: null, providers: { images }, models: [] },
        createdAt: at,
        updatedAt: at,
      };
      store.jobs.push(job);
      portraits.set(job, Date.now());
      return clone(job);
    },
    async designUpload(ws, file) {
      guardWs(store, ws);
      if (!TYPES.includes(file.contentType)) fail(400, "bad_request", "Pick a PNG, JPG or WebP picture.");
      if (file.size > MAX_BYTES) fail(413, "too_large", "That picture is too big. Pick one under 10 MB.");
      await delay(120);
      const assetId = mockId();
      designsOf(store).set(assetId, { ws, contentType: file.contentType, filename: file.filename });
      return { assetId, uploadUrl: `mock://stories/design/${assetId}`, headers: { "Content-Type": file.contentType } };
    },
    async designCharacter(ws, body) {
      guardWs(store, ws);
      const words = (body.description ?? "").trim();
      if (words.length > 600) fail(400, "bad_request", "Keep the description to 600 letters.");
      // The older single picture goes first (§45.42); up to 8 (§45.47: 6 outside, 4 inside), each once.
      const refs = [...new Set([...(body.referenceAssetId ? [body.referenceAssetId] : []), ...(body.referenceAssetIds ?? [])])];
      if (refs.length > 8) fail(400, "bad_request", "Pick up to 8 photos.");
      const sides: PhotoSide[] | null = body.referenceSides ?? null;
      if (sides) {
        if (sides.length !== (body.referenceAssetIds ?? []).length || sides.some((x) => x !== "outside" && x !== "inside")) fail(400, "bad_request", "Say outside or inside for each photo.");
        if (sides.filter((x) => x === "outside").length > 6 || sides.filter((x) => x === "inside").length > 4) fail(400, "bad_request", "Pick up to 6 outside and 4 inside photos.");
      }
      if (body.vehicle !== undefined && !(Object.values(VEHICLE_OF) as string[]).includes(body.vehicle)) fail(400, "bad_request", "Pick a person or a vehicle.");
      if (body.count !== undefined && (!Number.isInteger(body.count) || body.count < 1 || body.count > 4)) fail(400, "bad_request", "count must be 1 to 4.");
      if (body.kind !== undefined && body.kind !== "person" && body.kind !== "car") fail(400, "bad_request", "Pick a person or a vehicle.");
      if ((body.avoid ?? []).length > 8) fail(400, "bad_request", "Send up to 8 cars to stay away from.");
      // A redesign (§45.34): that character is the agent's CURRENT; it keeps its name and only what was asked changes.
      const current = body.characterId !== undefined ? find(store, ws, body.characterId) : null;
      const saved = current ? (current.kind ?? "person") : null;
      if (saved && body.kind && body.kind !== saved) fail(400, "bad_request", `Keep the same kind: this character is ${saved === "car" ? "a car" : "a person"}.`);
      const kind = body.kind ?? saved ?? "person";
      if (!words && !refs.length) fail(400, "bad_request", kind === "car" ? "Add a photo of your car, or say what it is like." : "Say what your character is like, or add a picture.");
      for (const ref of refs) {
        const design = designsOf(store).get(ref);
        const charRef = store.assets.some((a) => a.assetId === ref && a.kind === "character_ref" && store.characters.some((c) => c.workspaceId === ws && c.characterId === a.characterId));
        if (!(design && design.ws === ws) && !charRef) fail(404, "not_found", "We could not find that picture. Add it again.");
      }
      await delay(160);
      const salt = store.characters.length + store.tasks.length;
      // The character agent's suggestions; nothing is saved until the owner taps Save.
      return startMockTask(store, ws, "character_design", body.override, () => {
        if (kind === "car") {
          const taken = store.characters.filter((c) => c.workspaceId === ws).map((c) => c.name);
          const insides = (sides ?? []).filter((x) => x === "inside").length;
          const cars = designCars(words, refs.length, salt, body.count ?? 3, body.avoid ?? [], taken, current && isCar(current) ? (input(current) as CarInput) : null, body.vehicle, insides);
          return { character: cars[0], characters: cars };
        }
        const fresh = designFromWords(words, refs.length > 0, salt);
        const character = current ? redesign(input(current), fresh, words) : fresh;
        return { character, characters: [character] };
      });
    },
  };
}

