// "Write it myself": the owner's own script (docs/CONTRACTS.md §45.46).
// The owner writes a short list of scenes (what happens, and the words on screen); the AI only stages them. These are
// the pure helpers the scene list, the mock and the tests share: the limits, reading time and length (the same sums as
// the API and the agent, §45.46.4), splitting a pasted script into scenes, reading who and where from the words, the
// questions about a name the app does not know, and the checks before making it. Nothing here is ever cut or changed:
// a caption keeps exactly what was typed (only its ends are trimmed).
import { STEP_LABEL, type Character, type OwnScene, type OwnScript, type StepKey } from "../api/types.ts";
import { CATALOG } from "../engine/catalog.ts";
import type { SetId } from "../engine/types.ts";

/** The limits (§45.46.4): 2 to 12 scenes, 160 letters of what happens, 60 of a caption, ≤ 4 in a scene, ≤ 5 left out. */
export const OWN = { min: 2, max: 12, what: 160, caption: 60, who: 4, leaveOut: 5, known: 12, name: 40 } as const;

/** Letters as the API counts them (code points: an emoji is one). */
export function letters(s: string): number {
  return [...s].length;
}

// ---------- The step labels (§45.46.4) ----------

/** The owner's script's own step labels: "Your script", and "Add your words" when a scene has a caption. */
export function stepLabel(key: StepKey, own?: OwnScript | null): string {
  if (own && key === "storyboard") return "Your script";
  if (own && key === "captions" && hasCaption(own)) return "Add your words";
  return STEP_LABEL[key];
}

export function hasCaption(own: Pick<OwnScript, "scenes">): boolean {
  return own.scenes.some((s) => !!(s.caption ?? "").trim());
}

// ---------- Reading time and length (§45.46.4: the same in the web, the API and the agent) ----------

/** The seconds a scene needs: its caption's reading time (3 to 15 s), else 3. */
export function need(scene: { caption?: string | null }): number {
  const c = (scene.caption ?? "").trim();
  return c ? Math.min(15, Math.max(3, 2 + letters(c) / 15)) : 3;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const sumNeed = (scenes: readonly { caption?: string | null }[]) => scenes.reduce((a, s) => a + need(s), 0);

/** The length when the owner does not pick one: clamp(5 × ceil(max(Σneed, 5n) / 5), 15, min(90, 15n)). */
export function defaultLength(scenes: readonly { caption?: string | null }[]): number {
  const n = Math.max(1, scenes.length);
  return clamp(5 * Math.ceil(Math.max(sumNeed(scenes), 5 * n) / 5), 15, Math.min(90, 15 * n));
}

/** The length the video lands on (the agent's fit target): clamp(length, max(15, Σneed), min(89.5, 15n)). */
export function fitTarget(durationSec: number, scenes: readonly { caption?: string | null }[]): number {
  const n = Math.max(1, scenes.length);
  return clamp(durationSec, Math.max(15, sumNeed(scenes)), Math.min(89.5, 15 * n));
}

/** "15 to 60 seconds" for these scenes: what the length slider can give them. */
export function lengthRange(scenes: readonly { caption?: string | null }[]): { lo: number; hi: number } {
  const n = Math.max(1, scenes.length);
  return { lo: Math.max(15, Math.ceil(sumNeed(scenes))), hi: Math.min(90, 15 * n) };
}

/** Each scene's share of the length, in whole seconds (the preview's "about 5 s"). */
export function shares(durationSec: number, scenes: readonly { caption?: string | null }[]): number[] {
  if (!scenes.length) return [];
  const t = fitTarget(durationSec, scenes);
  const total = sumNeed(scenes);
  return scenes.map((s) => Math.max(2, Math.round((t * need(s)) / total)));
}

// ---------- Paste a script (§45.46.2) ----------

const HEADING = /^\s*(?:scene|shot)\s*(\d+)\b\s*[:.)\-–—]?\s*/i;
const LABEL = /^\s*(?:caption|words|on screen|text)\s*:\s*/i;
const QUOTED = /^\s*(?:"([^"]*)"|“([^”]*)”|'([^']*)'|‘([^’]*)’)\s*$/;

/** A line that is the scene's caption ("Caption: Oh no!", or only a quotation), its words; else null. */
function captionLine(line: string): string | null {
  if (LABEL.test(line)) return line.replace(LABEL, "").trim();
  const q = QUOTED.exec(line);
  if (q) return (q[1] ?? q[2] ?? q[3] ?? q[4] ?? "").trim();
  return null;
}

/** One chunk of lines as a scene: the caption lines become the caption, the others (joined by one space) what happens. */
function sceneOf(lines: string[]): { what: string; caption: string | null } {
  const what: string[] = [];
  const caption: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\t/g, " ").trim();
    if (!line) continue;
    const c = captionLine(line);
    if (c !== null) caption.push(c);
    else what.push(line);
  }
  const words = caption.filter(Boolean).join(" ");
  return { what: what.join(" ").replace(/ {2,}/g, " "), caption: words || null };
}

/**
 * A pasted script as scenes: split at "Scene 3:" headings, else at blank lines, else one scene a line. A line that
 * starts with "Caption:", "Words:", "On screen:" or "Text:", or is only a quotation, is that scene's caption. Nothing is
 * cut and nothing is dropped (a 13th scene is kept: the list shows its limit until it is fixed).
 */
export function splitScript(text: string): { what: string; caption: string | null }[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let chunks: string[][];
  if (lines.some((l) => HEADING.test(l))) {
    chunks = [];
    let now: string[] = [];
    for (const l of lines) {
      if (HEADING.test(l)) {
        if (now.some((x) => x.trim())) chunks.push(now);
        now = [l.replace(HEADING, "")];
      } else now.push(l);
    }
    if (now.some((x) => x.trim())) chunks.push(now);
  } else {
    const paras = text
      .replace(/\r\n?/g, "\n")
      .split(/\n[ \t]*\n/)
      .map((p) => p.split("\n"))
      .filter((p) => p.some((x) => x.trim()));
    if (paras.length > 1) chunks = paras;
    else {
      // one scene a line; a caption line belongs to the scene before it
      chunks = [];
      for (const l of lines) {
        if (!l.trim()) continue;
        if (captionLine(l.trim()) !== null && chunks.length) chunks[chunks.length - 1]!.push(l);
        else chunks.push([l]);
      }
    }
  }
  return chunks.map(sceneOf).filter((s) => s.what || s.caption);
}

// ---------- Who and where, read from the words (§45.46.2) ----------

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wholeWord = (w: string) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(w)}(?![\\p{L}\\p{N}])`, "iu");

/** True when the words use this name as a whole word, ignoring case. */
export function names(what: string, name: string): boolean {
  return !!name.trim() && wholeWord(name.trim()).test(what);
}

/** The words a character is called by: its name, and the first word of a longer name ("Nana" for Nana Rose). */
function callNames(c: Pick<Character, "name">): string[] {
  const name = c.name.trim();
  const first = name.split(/\s+/)[0] ?? "";
  return first && first !== name && letters(first) > 1 ? [name, first] : name ? [name] : [];
}

/** Every character of the workspace (people and cars) the words name, as whole words, ignoring case, in text order. */
export function namesIn<C extends Pick<Character, "characterId" | "name">>(what: string, characters: readonly C[]): C[] {
  const found: { c: C; at: number }[] = [];
  for (const c of characters) {
    let at = Infinity;
    for (const n of callNames(c)) {
      const m = wholeWord(n).exec(what);
      if (m && m.index < at) at = m.index;
    }
    if (at < Infinity) found.push({ c, at });
  }
  return found.sort((a, b) => a.at - b.at).map((x) => x.c);
}

/**
 * Everyday words that often start a sentence and are never names (days, months, meals, times, places to be): "Breakfast
 * is ready." or "On Saturday …" asks nothing (the agent's own_script.EVERYDAY is the same list). A person's word such as
 * Mum is still asked about: the cast may have no Mum to draw.
 */
export const EVERYDAY =
  "monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september " +
  "october november december breakfast lunch dinner supper snack teatime lunchtime bedtime playtime upstairs downstairs " +
  "everywhere somewhere nowhere weekend birthday holiday holidays christmas easter halloween summer winter spring autumn " +
  "afternoon noon midnight tonight outside inside home school";

/** Words with a capital that are not names (sentence starts, little words, sounds, everyday words). */
const COMMON = new Set(
  (EVERYDAY +
    " " +
    "the then he she they it i oh no yes suddenly later scene shot a an and but so or now next after before when while we you me my " +
    "his her him their them its our your this that these those there here what why how who where which wow hey hi hello ok okay " +
    "finally first second third last at in on out up down off over into onto behind under above near by for from to of as with without " +
    "if because until once again also even only still very too not never always maybe soon just together both all one two three four " +
    "five some each every everyone everybody someone somebody nobody nothing something everything meanwhile uh oops yay phew ah aha " +
    "ha haha hmm ooh ouch look wait stop go let lets don't can't won't isn't it's i'm he's she's they're we're you're that's there's " +
    "what's please thanks thank sorry good great bye goodbye end morning night day today tomorrow yesterday tonight bang boom crash " +
    "splash zoom vroom beep honk ding pop whoosh yikes uh-oh whoa nope yeah yep well like see watch come"
  ).split(/\s+/),
);

/** Place words: the catalog's places and the other words Where reads, never asked about as a name. */
const PLACE_WORDS = new Set(
  [
    ...CATALOG.sets.flatMap((s) => s.label.toLowerCase().split(/\s+/)),
    ..."road roads street streets town city motorway highway lounge sofa work desk office kitchen park parking car snow snowy ice icy rain rainy fog foggy night beach school home house garden shop supermarket forest farm zoo pool sea river bridge village garage bedroom bathroom hospital airport station castle space moon mountain hill lake".split(
      " ",
    ),
  ].filter(Boolean),
);

const TOKEN = /[\p{L}][\p{L}\p{M}\p{N}'’-]*/gu;

/** The words of a text, each without a possessive or a trailing dash ("Dash's" → "Dash"). */
function wordsOf(what: string): string[] {
  return (what.match(TOKEN) ?? []).map((w) => w.replace(/['’]s$/i, "").replace(/[-'’]+$/, "")).filter(Boolean);
}

/**
 * The names the words use that the app does not know (§45.46.2): a word with a capital that is not a common word, not a
 * place word, not a character's name and not answered yet ("Max"), each once, in text order.
 */
export function unknownNames(what: string, characters: readonly Pick<Character, "name">[], answered: Iterable<string> = []): string[] {
  const known = new Set<string>([...answered].map((a) => a.toLowerCase()));
  for (const c of characters) for (const w of c.name.toLowerCase().split(/\s+/)) if (w) known.add(w);
  const out: string[] = [];
  for (const w of wordsOf(what)) {
    const first = w[0]!;
    if (first === first.toLowerCase() || letters(w) < 2) continue;
    const low = w.toLowerCase();
    if (COMMON.has(low) || COMMON.has(low.replace(/['’]/g, "'")) || PLACE_WORDS.has(low) || known.has(low)) continue;
    if (out.some((x) => x.toLowerCase() === low)) continue;
    out.push(w);
  }
  return out;
}

/** The places Where can pick: the 16 sets of the catalog, by their labels. */
export const PLACES: readonly { id: SetId; label: string }[] = CATALOG.sets as { id: SetId; label: string }[];

export function placeLabel(id: string | null | undefined): string | null {
  return PLACES.find((p) => p.id === id)?.label ?? null;
}

/** The place the words name (§45.46.2), in this order; null: none (the AI picks the closest). */
const PLACE_RULES: [RegExp, SetId, RegExp?][] = [
  [/\b(highway|motorway)s?\b/i, "highway_night", /\bnight\b/i],
  [/\broads?\b/i, "road_night", /\bnight\b/i],
  [/\bcar park\b|\bparking\b/i, "parking_lot"],
  [/\bsnow(y|ing)?\b/i, "snowy_road"],
  [/\bice\b|\bicy\b/i, "icy_road"],
  [/\brain(y|ing|s)?\b/i, "rainy_road"],
  [/\bfog(gy)?\b/i, "foggy_road"],
  [/\b(highway|motorway)s?\b/i, "highway"],
  [/\bcountry road\b/i, "country_road"],
  [/\bcity street\b|\btown\b|\bstreets?\b/i, "city_street"],
  [/\bliving room\b|\blounge\b|\bsofa\b/i, "living_room"],
  [/\bkitchen\b/i, "kitchen"],
  [/\boffice\b|\bwork\b|\bdesk\b/i, "office"],
  [/\broad by day\b/i, "road_day"],
  [/\bpark\b/i, "park"],
  [/\bstudio\b/i, "studio"],
];

export function placeIn(what: string): SetId | null {
  for (const [re, id, also] of PLACE_RULES) if (re.test(what) && (!also || also.test(what))) return id;
  return null;
}

// ---------- The scene list's own state ----------

/** One scene as the owner types it (the page's own state; `toOwnScript` makes what is sent). */
export interface DraftScene {
  /** React's key and the fields' ids: stays with the scene when it moves */
  key: string;
  what: string;
  caption: string;
  /** the Who chips picked by hand; null: read from the words */
  who: string[] | null;
  /** the place picked by hand ("ai": AI picks, on purpose); null: read from the words */
  place: SetId | "ai" | null;
}

export interface ScriptDraft {
  scenes: DraftScene[];
  /**
   * The names the owner answered, by their lower-case form: a characterId ("Who is Max?" → Dash), "out" (Leave Max out)
   * or "seen" (answered in an earlier save: a script read back from the video).
   */
  answers: Record<string, string>;
}

let made = 0;
export function newScene(what = "", caption = ""): DraftScene {
  made += 1;
  return { key: `sc${made}`, what, caption, who: null, place: null };
}

export function emptyDraft(): ScriptDraft {
  return { scenes: [newScene(), newScene()], answers: {} };
}

export const written = (s: Pick<DraftScene, "what" | "caption">) => !!s.what.trim() || !!s.caption.trim();

/** The scene list started from an idea's steps: its beats become what happens, its on-screen words the captions. */
export function draftFromIdea(idea: { logline: string; concept?: { beats: string[]; onScreenText: string[] } }): ScriptDraft {
  const beats = idea.concept?.beats?.filter((b) => b.trim()) ?? [];
  const words = idea.concept?.onScreenText ?? [];
  const scenes = (beats.length ? beats : [idea.logline]).map((b, i) => newScene(b.trim(), (words[i] ?? "").trim()));
  while (scenes.length < OWN.min) scenes.push(newScene());
  return { scenes, answers: {} };
}

/** A saved script read back into the list ("Change my script"): what the owner sent stays as it was. */
export function draftFromOwn(own: OwnScript, cast: string[], characters: readonly Character[]): ScriptDraft {
  const answers: Record<string, string> = {};
  for (const s of own.scenes) {
    for (const n of s.leaveOut ?? []) answers[n.toLowerCase()] = "out";
    for (const n of s.known ?? []) if (!answers[n.toLowerCase()]) answers[n.toLowerCase()] = "seen";
    for (const n of unknownNames(s.what, characters)) if (!answers[n.toLowerCase()]) answers[n.toLowerCase()] = "seen";
  }
  const draft: ScriptDraft = { scenes: [], answers };
  draft.scenes = own.scenes.map((s) => {
    const sc = newScene(s.what, s.caption ?? "");
    const auto = sceneWho(sc, draft, cast, characters);
    // read back exactly as it was sent: Who stays as the words give it, else as it was picked ([]: AI picks)
    const given = (s.who ?? []).filter((id) => cast.includes(id));
    if (given.slice().sort().join() !== auto.slice().sort().join()) sc.who = given;
    const place = (s.place ?? null) as SetId | null;
    if (place !== placeIn(s.what)) sc.place = place ?? "ai";
    return sc;
  });
  return draft;
}

// ---------- Who, where and the questions, for one scene ----------

/** Who is in a scene: the Who chips picked by hand, else the cast the words name (and the names answered for them). */
export function sceneWho(s: DraftScene, draft: Pick<ScriptDraft, "answers">, cast: readonly string[], characters: readonly Pick<Character, "characterId" | "name">[]): string[] {
  if (s.who) return s.who.filter((id) => cast.includes(id));
  const out: string[] = [];
  for (const c of namesIn(s.what, characters)) if (cast.includes(c.characterId) && !out.includes(c.characterId)) out.push(c.characterId);
  for (const w of wordsOf(s.what)) {
    const to = draft.answers[w.toLowerCase()];
    if (to && to !== "out" && to !== "seen" && cast.includes(to) && !out.includes(to)) out.push(to);
  }
  return out;
}

/** Where a scene happens: picked by hand, else read from the words; null: the AI picks. */
export function scenePlace(s: Pick<DraftScene, "what" | "place">): SetId | null {
  if (s.place === "ai") return null;
  return s.place ?? placeIn(s.what);
}

/** The names in a scene the owner left out (as the words write them). */
export function sceneLeaveOut(s: DraftScene, draft: Pick<ScriptDraft, "answers">, characters: readonly Pick<Character, "characterId" | "name">[]): string[] {
  const out: string[] = [];
  const add = (n: string) => {
    if (!out.some((x) => x.toLowerCase() === n.toLowerCase())) out.push(n);
  };
  for (const c of namesIn(s.what, characters)) if (draft.answers[c.name.trim().toLowerCase()] === "out") add(c.name.trim());
  for (const w of wordsOf(s.what)) if (draft.answers[w.toLowerCase()] === "out") add(w);
  return out.slice(0, OWN.leaveOut).map((n) => [...n].slice(0, OWN.name).join(""));
}

/**
 * A question about a name: "Who is Max?" (`who`: one of the cast, Not a name, or Leave Max out), or "Rosa isn't in the
 * cast." (`outside`, a character of the workspace).
 */
export type Ask = { kind: "who"; name: string } | { kind: "outside"; name: string; characterId: string };

/** The questions still open, each once, at the first scene that names it. */
export function openAsks(draft: ScriptDraft, cast: readonly string[], characters: readonly Pick<Character, "characterId" | "name">[]): { scene: number; ask: Ask }[] {
  const out: { scene: number; ask: Ask }[] = [];
  const asked = new Set<string>();
  draft.scenes.forEach((s, i) => {
    for (const c of namesIn(s.what, characters)) {
      const low = c.name.trim().toLowerCase();
      if (cast.includes(c.characterId) || draft.answers[low] === "out" || asked.has(low)) continue;
      asked.add(low);
      out.push({ scene: i, ask: { kind: "outside", name: c.name.trim(), characterId: c.characterId } });
    }
    for (const n of unknownNames(s.what, characters, Object.keys(draft.answers))) {
      const low = n.toLowerCase();
      if (asked.has(low)) continue;
      asked.add(low);
      out.push({ scene: i, ask: { kind: "who", name: n } });
    }
  });
  return out;
}

/**
 * The words of a scene the owner answered and did not leave out (another name for someone in Who, or Not a name), as
 * the words write them: sent as `known`, so the agent never takes them for someone missing from the cast.
 */
export function sceneKnown(s: Pick<DraftScene, "what">, draft: Pick<ScriptDraft, "answers">): string[] {
  const out: string[] = [];
  for (const w of wordsOf(s.what)) {
    const to = draft.answers[w.toLowerCase()];
    if (to && to !== "out" && !out.some((x) => x.toLowerCase() === w.toLowerCase())) out.push(w);
  }
  return out.slice(0, OWN.known).map((n) => [...n].slice(0, OWN.name).join(""));
}

/** The script to send (§45.46.4): the written scenes in order, the words exactly as typed (only the ends trimmed). */
export function toOwnScript(draft: ScriptDraft, cast: readonly string[], characters: readonly Pick<Character, "characterId" | "name">[]): OwnScript {
  const last = draft.scenes.reduce((n, s, i) => (written(s) ? i : n), -1);
  return {
    scenes: draft.scenes.slice(0, last + 1).map((s): OwnScene => {
      const caption = s.caption.trim();
      const who = sceneWho(s, draft, cast, characters).slice(0, OWN.who);
      const place = scenePlace(s);
      const leaveOut = sceneLeaveOut(s, draft, characters);
      const known = sceneKnown(s, draft);
      return {
        what: s.what.trim(),
        ...(caption ? { caption } : {}),
        ...(who.length ? { who } : {}),
        ...(place ? { place } : {}),
        ...(leaveOut.length ? { leaveOut } : {}),
        ...(known.length ? { known } : {}),
      };
    }),
  };
}

/** Two scripts that say the same thing (the ids and empty fields aside). */
export function sameScript(a: OwnScript | null | undefined, b: OwnScript | null | undefined): boolean {
  const flat = (o: OwnScript | null | undefined) =>
    JSON.stringify(
      (o?.scenes ?? []).map((s) => [
        s.what.trim(),
        (s.caption ?? "").trim() || null,
        [...(s.who ?? [])].sort(),
        s.place ?? null,
        [...(s.leaveOut ?? [])].map((x) => x.toLowerCase()).sort(),
        [...(s.known ?? [])].map((x) => x.toLowerCase()).sort(),
      ]),
    );
  return flat(a) === flat(b);
}

// ---------- The checks before making it (§45.46.3) ----------

/** The caption marks the video's burned-in words would change (braces, a backslash): refused, never changed (§45.46.4). */
export const CAPTION_MARKS = /[{}\\]/;

/** Where a problem's fix is: a scene's what happens, its caption, its question, or the Add a scene button. */
export type Fix = { scene: number; field: "what" | "caption" | "ask" } | { add: true };

/** True when a text has a control character (a newline is allowed only where `newline` says), as the API refuses. */
export function hasControl(text: string, newline = false): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c < 0x20 || (c >= 0x7f && c < 0xa0)) && !(newline && c === 0x0a)) return true;
  }
  return false;
}

/**
 * The first problem with the scenes (§45.46.3, in its order), and where its fix is; null when they can be made. The title
 * and the kind are checked first by the page; the cast after.
 */
export function scriptProblem(draft: ScriptDraft, cast: readonly string[], characters: readonly Pick<Character, "characterId" | "name">[]): { text: string; fix: Fix } | null {
  const scenes = draft.scenes;
  const last = scenes.reduce((n, s, i) => (written(s) ? i : n), -1);
  const withWords = scenes.filter((s) => s.what.trim()).length;
  if (withWords < OWN.min) {
    const empty = scenes.findIndex((s) => !s.what.trim());
    return { text: "Write at least 2 scenes.", fix: empty >= 0 ? { scene: empty, field: "what" } : { add: true } };
  }
  for (let i = 0; i <= last; i += 1) if (!scenes[i]!.what.trim()) return { text: `Scene ${i + 1} is empty. Write what happens, or take it out.`, fix: { scene: i, field: "what" } };
  if (last + 1 > OWN.max) return { text: "Up to 12 scenes. Join some, or take some out.", fix: { scene: OWN.max, field: "what" } };
  for (let i = 0; i <= last; i += 1) if (letters(scenes[i]!.what.trim()) > OWN.what) return { text: `Scene ${i + 1} is too long. Use 160 letters or fewer.`, fix: { scene: i, field: "what" } };
  for (let i = 0; i <= last; i += 1) if (letters(scenes[i]!.caption.trim()) > OWN.caption) return { text: `Scene ${i + 1}'s caption is too long. Use 60 letters or fewer.`, fix: { scene: i, field: "caption" } };
  const ask = openAsks(draft, cast, characters)[0];
  if (ask) return { text: `Tell us who ${ask.ask.name} is, in scene ${ask.scene + 1}.`, fix: { scene: ask.scene, field: "ask" } };
  for (let i = 0; i <= last; i += 1) {
    const s = scenes[i]!;
    if (hasControl(s.what.trim(), true) || hasControl(s.caption.trim())) return { text: `Use plain letters in scene ${i + 1}.`, fix: { scene: i, field: hasControl(s.what.trim(), true) ? "what" : "caption" } };
    if (CAPTION_MARKS.test(s.caption)) return { text: `Scene ${i + 1}'s caption can't use { } or \\. Take them out.`, fix: { scene: i, field: "caption" } };
  }
  return null;
}

/** "Too long: 182 of 160 letters." for a field over its limit, else null. */
export function tooLong(value: string, max: number): string | null {
  const n = letters(value.trim());
  return n > max ? `Too long: ${n} of ${max} letters.` : null;
}

/** True when a caption has emoji (some may not show in the video's letters). */
export function hasEmoji(s: string): boolean {
  return /\p{Extended_Pictographic}/u.test(s);
}

/** The scene a fact problem is about ("Your scene 2 …"), from 1; null when it names none. */
export function sceneOfProblem(problem: string): number | null {
  const m = /\bYour scene (\d+)/i.exec(problem);
  return m ? Number(m[1]) : null;
}

/** A scene's label for the storyboard: its first words, cut at a word to 40 letters, with "…" (§45.46.6). */
export function sceneLabel(what: string): string {
  const t = what.trim().replace(/\s+/g, " ");
  // letters as the engine and the API count them (code points: an emoji is one)
  if (letters(t) <= 40) return t;
  const cut = [...t].slice(0, 39).join("");
  const at = cut.lastIndexOf(" ");
  return `${(at > 10 ? cut.slice(0, at) : cut).replace(/[\s,;:.!?-]+$/, "")}…`;
}

/** The owner's words, compared exactly (§45.46.6): case, punctuation and emoji count; only NFC and runs of spaces may differ. */
export function sameWords(a: string, b: string): boolean {
  const flat = (s: string) => s.normalize("NFC").split(/\s+/u).filter(Boolean).join(" ");
  return flat(a) === flat(b);
}
