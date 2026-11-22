// Lamo Stories mock: the characters part (docs/CONTRACTS.md §45.8, §45.16.8). Builder G.
// Saved rigs with their faces, moves and sounds; edits carry a version (409 when it is stale); delete refuses while a
// story with the character is being made; reference pictures go through a pretend presigned PUT (mock:// URLs, which
// web/src/api/upload.ts plays out with progress); a portrait only when AI pictures are on in Settings; and "Design
// with AI": a picture for it (designUpload, a design_ref the Library never lists) and the character agent's task that
// suggests a whole CharacterInput from the owner's words and/or that picture (a draft: nothing is saved).
import type { Character, CharacterInput, LibraryItem, ProductionJob, StoriesApi, StoriesConfig } from "../types.ts";
import type { CharacterLook, Expression, MovementStyle, NoiseId, SfxId } from "../../engine/types.ts";
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

function check(c: CharacterInput): void {
  const name = (c.name ?? "").trim();
  if (!name) fail(400, "bad_request", "Give your character a name.");
  if (name.length > 30) fail(400, "bad_request", "Keep the name to 30 letters.");
  if ((c.description ?? "").length > 400) fail(400, "bad_request", "Make the description a little shorter.");
  if ((c.personality ?? "").length > 400) fail(400, "bad_request", "Make the personality a little shorter.");
  if (!Array.isArray(c.traits) || c.traits.length > 8 || c.traits.some((t) => !t.trim() || t.length > 30)) fail(400, "bad_request", "Use up to 8 short traits.");
  if (!MOVES.includes(c.movementStyle)) fail(400, "bad_request", "Pick a way of moving.");
  if (!Array.isArray(c.expressions) || c.expressions.length < 3 || !c.expressions.includes("neutral") || c.expressions.some((e) => !EXPRESSIONS.includes(e)))
    fail(400, "bad_request", "Pick at least 3 faces, with Neutral.");
  if (!c.look || !/^#[0-9a-f]{6}$/i.test(c.look.skin)) fail(400, "bad_request", "Pick a skin colour.");
  if (!c.voice || c.voice.pitch < 0.5 || c.voice.pitch > 2 || c.voice.noises.length > 8 || c.voice.sfx.length > 8) fail(400, "bad_request", "Check the sounds: up to 8 noises and 8 effects.");
}

function input(c: CharacterInput): CharacterInput {
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
const pending = new WeakMap<MockStore, Map<string, { characterId: string; contentType: string; filename: string; size: number }>>();
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
    const url = picture("#322a73", c.look.outfit.top, c.look.skin);
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
export function designFromWords(words: string, withPicture: boolean, salt: number): CharacterInput {
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
export const PICTURES_OFF = "AI pictures are off. Turn them on in Lamo Stories › Settings › Video › Picture maker.";

/**
 * The practice character agent redesigning a saved character (§45.34): it starts from the character as it is (CURRENT),
 * keeps its name, and changes only the parts the owner's words are about; words about none of them give a new outfit.
 */
export function redesign(current: CharacterInput, fresh: CharacterInput, words: string): CharacterInput {
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
      await delay(120);
      const assetId = mockId();
      uploads.set(assetId, { characterId: id, contentType: file.contentType, filename: file.filename, size: file.size });
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
      const url = picture("#26205a", c.look.outfit.top, c.look.skin);
      c.references.push({ assetId, url, contentType: up.contentType, createdAt: iso() });
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
      if ((config(store, ws).providers?.images ?? "builtin-rig") !== "nova-canvas")
        fail(409, "conflict", PICTURES_OFF);
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
        meta: { writerModel: null, engineVersion: null, seed: 7, scriptVersion: null, targetSec: null, actualSec: null, safetyTopicId: null, providers: { images: "nova-canvas" }, models: [] },
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
      const ref = body.referenceAssetId;
      if (!words && !ref) fail(400, "bad_request", "Say what your character is like, or add a picture.");
      if (ref) {
        const design = designsOf(store).get(ref);
        const charRef = store.assets.some((a) => a.assetId === ref && a.kind === "character_ref" && store.characters.some((c) => c.workspaceId === ws && c.characterId === a.characterId));
        if (!(design && design.ws === ws) && !charRef) fail(404, "not_found", "We could not find that picture. Add it again.");
      }
      // A redesign (§45.34): that character is the agent's CURRENT; it keeps its name and only what was asked changes.
      const current = body.characterId !== undefined ? find(store, ws, body.characterId) : null;
      await delay(160);
      const salt = store.characters.length + store.tasks.length;
      // The character agent's suggestion; nothing is saved until the owner taps Save.
      return startMockTask(store, ws, "character_design", body.override, () => {
        const fresh = designFromWords(words, !!ref, salt);
        return { character: current ? redesign(input(current), fresh, words) : fresh };
      });
    },
  };
}

