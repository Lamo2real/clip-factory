// Lamo Stories mock: "Write it myself", the owner's own script (docs/CONTRACTS.md
// §45.46.9). Small hooks the stories part calls, so its own file changes little: the limits and the
// kid sentences of a script (§45.46.4, as the API's own_script.py says them), the topic its words match, the
// practice adapter that stages one scene for each script scene in the owner's order (who and where kept, the owner's
// caption cues `w_sN` built by code, word for word), the code check that proves it (a self-test of the mock), the fact
// check that reports on the owner's words and never rewrites them, and the PATCH paths (words only, or staged again)
// with the captions editor's mirror.
import { ApiError } from "../../../api/errors.ts";
import { ENGINE_VERSION, fitDuration, normalizeScript, validateScript } from "../../engine/engine.ts";
import { setInfo } from "../../engine/sets.ts";
import type { ActionId, ArtStyle, Beat, CaptionCue, CarMember, CastMember, Scene, SceneActor, SceneProp, SetId, StoryScript } from "../../engine/types.ts";
import { aboutDriving, CAPTION_MARKS, fitTarget, hasCaption, hasControl, letters, namesIn, need, PLACES, placeIn, placeLabel, sameWords, sceneLabel, stepLabel } from "../../studio/ownScript.ts";
import { isCar, STEP_ORDER, type Character, type IdeaCategory, type MusicMood, type OwnScene, type OwnScript, type StepKey, type Story, type StoryFormat } from "../types.ts";
import { citationsFor, topicFor } from "./ideas.ts";

const NO_GUIDANCE = "Clips Funded only makes driving-safety videos from checked advice, and this one isn't in the list yet.";

/** §45.46.4's sentences (the same words as the API's own_script.py). */
export const OWN_WORDS = {
  few: "Write at least 2 scenes.",
  many: "Up to 12 scenes.",
  empty: (n: number) => `Scene ${n} is empty. Write what happens.`,
  long: (n: number) => `Scene ${n} is too long. Use 160 letters or fewer.`,
  captionLong: (n: number) => `Scene ${n}'s caption is too long. Use 60 letters or fewer.`,
  notInCast: (n: number) => `Scene ${n} has someone who isn't in the cast.`,
  tooManyWho: (n: number) => `Scene ${n} has too many people. Keep 4 or fewer.`,
  marks: (n: number) => `Scene ${n}'s caption can't use { } or \\. Take them out.`,
  badPlace: (n: number) => `Scene ${n}'s place isn't one we can draw. Pick one from the list.`,
  plain: (n: number) => `Use plain letters in scene ${n}.`,
  manyLeftOut: (n: number) => `Scene ${n} leaves out too many names. Keep 5 or fewer.`,
  nameLong: (n: number) => `Scene ${n} has a name that is too long. Use 40 letters or fewer.`,
  noScript: "This video has no script of yours.",
  follows: "This video follows your script. Tap Change my script.",
} as const;

/** The job's sentences when the staging did not keep the script (§45.46.4; the agent's keys.py says the same). */
const OWN_FAILS = {
  lost: (n: number) => `Scene ${n} got lost while we set it up. Tap Try again.`,
  words: (n: number) => `Scene ${n}'s caption didn't stay as you wrote it. Tap Try again.`,
  who: (n: number, name: string) => `Scene ${n} didn't fit: ${name} isn't in your cast. Add ${name} to the cast, or change scene ${n}.`,
  extra: (n: number) => `Scene ${n} got something you didn't write. Tap Try again.`,
  place: (n: number, place: string) => `Scene ${n} didn't stay in the ${place}. Tap Try again.`,
};

/** A staging that broke the owner's script: the job stops with this sentence and nothing is saved. */
export class OwnFailed extends Error {}

const SETS = new Set<string>(PLACES.map((p) => p.id));

function bad(message: string, field: string): never {
  throw new ApiError(400, "bad_request", message, field);
}

/**
 * The owner's script, checked (§45.46.4), with the scene ids given by position and every scene's six keys (as the API
 * keeps it). Nothing is ever cut: a value over its limit is refused with its kid sentence.
 */
export function checkOwnScript(value: unknown, characterIds: readonly string[]): OwnScript {
  const body = value as { scenes?: unknown } | null;
  if (!body || typeof body !== "object" || !Array.isArray(body.scenes) || body.scenes.length < 2) bad(OWN_WORDS.few, "ownScript.scenes");
  if (body.scenes.length > 12) bad(OWN_WORDS.many, "ownScript.scenes");
  const scenes = (body.scenes as unknown[]).map((raw, i): OwnScene => {
    const n = i + 1;
    const f = `ownScript.scenes[${i}]`;
    const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    if (s.what !== undefined && s.what !== null && typeof s.what !== "string") bad(OWN_WORDS.empty(n), `${f}.what`);
    const what = typeof s.what === "string" ? s.what.trim() : "";
    if (!what) bad(OWN_WORDS.empty(n), `${f}.what`);
    if (letters(what) > 160) bad(OWN_WORDS.long(n), `${f}.what`);
    if (hasControl(what, true)) bad(OWN_WORDS.plain(n), `${f}.what`);
    let caption: string | null = null;
    if (s.caption !== undefined && s.caption !== null) {
      if (typeof s.caption !== "string") bad(OWN_WORDS.plain(n), `${f}.caption`);
      caption = s.caption.trim() || null;
      if (caption && letters(caption) > 60) bad(OWN_WORDS.captionLong(n), `${f}.caption`);
      if (caption && hasControl(caption)) bad(OWN_WORDS.plain(n), `${f}.caption`);
      if (caption && CAPTION_MARKS.test(caption)) bad(OWN_WORDS.marks(n), `${f}.caption`);
    }
    let who: string[] = [];
    if (s.who !== undefined && s.who !== null) {
      if (!Array.isArray(s.who) || s.who.some((x) => typeof x !== "string" || !characterIds.includes(x))) bad(OWN_WORDS.notInCast(n), `${f}.who`);
      who = [...new Set(s.who as string[])]; // a repeat counts once
      if (who.length > 4) bad(OWN_WORDS.tooManyWho(n), `${f}.who`);
    }
    let place: string | null = null;
    if (s.place !== undefined && s.place !== null) {
      if (typeof s.place !== "string" || !SETS.has(s.place)) bad(OWN_WORDS.badPlace(n), `${f}.place`);
      place = s.place;
    }
    let leaveOut: string[] = [];
    if (s.leaveOut !== undefined && s.leaveOut !== null) {
      if (!Array.isArray(s.leaveOut) || s.leaveOut.some((x) => typeof x !== "string")) bad(OWN_WORDS.plain(n), `${f}.leaveOut`);
      leaveOut = [...new Set((s.leaveOut as string[]).map((x) => x.trim()).filter(Boolean))];
      if (leaveOut.length > 5) bad(OWN_WORDS.manyLeftOut(n), `${f}.leaveOut`);
      if (leaveOut.some((x) => letters(x) > 40)) bad(OWN_WORDS.nameLong(n), `${f}.leaveOut`);
      if (leaveOut.some((x) => hasControl(x))) bad(OWN_WORDS.plain(n), `${f}.leaveOut`);
    }
    let known: string[] = [];
    if (s.known !== undefined && s.known !== null) {
      if (!Array.isArray(s.known) || s.known.some((x) => typeof x !== "string")) bad(OWN_WORDS.plain(n), `${f}.known`);
      known = [...new Set((s.known as string[]).map((x) => x.trim()).filter(Boolean))];
      if (known.length > 12 || known.some((x) => letters(x) > 40)) bad(OWN_WORDS.nameLong(n), `${f}.known`);
      if (known.some((x) => hasControl(x))) bad(OWN_WORDS.plain(n), `${f}.known`);
    }
    return { sceneId: `s${n}`, what, caption, who, place, leaveOut, ...(known.length ? { known } : {}) };
  });
  return { scenes };
}

/** Every word the owner wrote (the topic match reads them): what happens in each scene, then the captions. */
export function ownTexts(own: OwnScript): string[] {
  return [...own.scenes.map((s) => s.what), ...own.scenes.map((s) => s.caption ?? "").filter(Boolean)];
}

/**
 * The checked topic the owner's words are about, or null. Another kind than driving safety gets one only when its
 * words are about driving (then it is kept: such a video is always fact checked); a joke about a puddle gets none.
 */
export function ownTopic(title: string, logline: string, own: OwnScript, category?: IdeaCategory): string | null {
  if (category && category !== "driving_safety" && !aboutDriving(ownTexts(own))) return null;
  return topicFor([title, logline, ...ownTexts(own)].join(" \n "));
}

/** The step labels of a video's job: "Your script", and "Add your words" when a scene has a caption. */
export function jobLabel(key: StepKey, story: Pick<Story, "ownScript">): string {
  return stepLabel(key, story.ownScript);
}

/** §45.46.5's defaults for an owner's script: captions on when a scene has a caption, and the length its scenes need. */
export function ownDefaults(own: OwnScript): { captionsOn: boolean | undefined; durationSec: number } {
  return { captionsOn: hasCaption(own) ? true : undefined, durationSec: defaultFor(own) };
}

function defaultFor(own: OwnScript): number {
  const n = own.scenes.length;
  let total = 0;
  for (const s of own.scenes) total += need(s);
  return Math.min(Math.max(5 * Math.ceil(Math.max(total, 5 * n) / 5), 15), 90, 15 * n);
}

// ---------- The practice adapter: one scene for each script scene, in order ----------

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Where a kind of video happens when the words name no place. */
const USUAL: Record<IdeaCategory, SetId> = { driving_safety: "road_day", everyday_skills: "kitchen", comedy: "park", explainer: "studio" };
const DRIVING: ReadonlySet<string> = new Set(["drive", "steer_left", "steer_right", "brake", "brace"]);

/** The cast in its order (people c1, c2, …, then the car), and each character's cast id. */
function castOf(chars: Character[]): { cast: Record<string, CastMember>; cars: Record<string, CarMember>; key: Map<string, string> } {
  const cast: Record<string, CastMember> = {};
  const cars: Record<string, CarMember> = {};
  const key = new Map<string, string>();
  [...chars.filter((c) => !isCar(c)), ...chars.filter(isCar)].forEach((c, i) => {
    const id = `c${i + 1}`;
    key.set(c.characterId, id);
    if (isCar(c)) cars[id] = { characterId: c.characterId, name: c.name, car: structuredClone(c.car), movementStyle: c.movementStyle, voice: structuredClone(c.voice), expressions: [...c.expressions] };
    else cast[id] = { characterId: c.characterId, name: c.name, look: structuredClone(c.look), movementStyle: c.movementStyle, voice: structuredClone(c.voice) };
  });
  return { cast, cars, key };
}

function beat(at: number, dur: number, who: string, act: Beat["do"], extra: Partial<Pick<Beat, "to">> = {}): Beat {
  return { at: r1(at), dur: r1(Math.max(0.3, dur)), who, do: act, ...extra };
}

/** The owner's caption cues (§45.46.4): one `w_sN` a scene with a caption, inside its scene, the words exactly as written. */
export function ownerCues(own: OwnScript, scenes: Pick<Scene, "sceneId" | "durationSec">[]): CaptionCue[] {
  const out: CaptionCue[] = [];
  let start = 0;
  scenes.forEach((sc, i) => {
    const s = own.scenes.find((x) => x.sceneId === sc.sceneId) ?? own.scenes[i];
    if (s?.caption) out.push({ id: `w_${sc.sceneId}`, at: r2(start + 0.25), dur: r2(Math.max(0.3, sc.durationSec - 0.5)), text: s.caption });
    start += sc.durationSec;
  });
  return out;
}

/**
 * The practice adapter (§45.46.9): one scene for each script scene, in the owner's order, with its id. The place is the
 * owner's, else the one the words name, else the kind's usual place; the people are the scene's Who, else the cast the
 * words name, else the first person; a car of the cast in Who is its car (the driver sits in it on a road). Beats come
 * from what happens; each scene lasts at least what its caption needs, then the video is fitted to its length. The
 * owner's caption cues are built by code after the fit, word for word, and every scene's caption is null.
 */
export function stageOwn(
  own: OwnScript,
  chars: Character[],
  o: { title: string; seed: number; category: IdeaCategory; topicId: string | null; captionsOn: boolean; musicMood: MusicMood; durationSec: number; format?: StoryFormat; art?: ArtStyle; act: (text: string) => ActionId },
): StoryScript {
  const { cast, cars, key } = castOf(chars);
  const people = chars.filter((c) => !isCar(c));
  const scenes: Scene[] = own.scenes.map((s, i) => {
    const sceneId = s.sceneId ?? `s${i + 1}`;
    const set = ((s.place as SetId | null) ?? placeIn(s.what) ?? USUAL[o.category]) as SetId;
    const road = !!setInfo(set).road;
    const named = s.who?.length ? s.who : namesIn(s.what, chars).map((c) => c.characterId);
    let who = named.filter((id) => people.some((p) => p.characterId === id)).map((id) => key.get(id)!);
    const carId = named.map((id) => chars.find((c) => c.characterId === id)).find((c) => !!c && isCar(c))?.characterId;
    if (!who.length && people[0] && !s.who?.length) who = [key.get(people[0].characterId)!];
    who = who.slice(0, 4);
    const d = r1(need(s));
    const props: SceneProp[] = carId ? [{ propId: "car1", kind: "car", x: 0.45, y: 0.72, scale: 1, rot: 0, castId: key.get(carId)! }] : [];
    const actors: SceneActor[] = who.map((k, j) => ({ castId: k, x: r1(Math.min(0.85, 0.3 + j * 0.2)), y: 0.72, facing: j % 2 ? "left" : "right", ...(j === 0 && carId && road ? { inCar: "car1" } : {}) }));
    const act = o.act(s.what);
    const beats: Beat[] = [];
    who.forEach((k, j) => {
      const inCar = j === 0 && !!carId && road;
      beats.push(j === 0 ? beat(0.2, d * 0.7, k, inCar || !DRIVING.has(act) ? act : "gesture") : beat(0.4, d * 0.5, k, "nod"));
    });
    if (carId && road) beats.push(beat(0.1, d * 0.85, "car1", "move", { to: { x: 0.65, y: 0.72 } }));
    const notes: string[] = [];
    if (s.leaveOut?.length) notes.push(`Not drawn: ${s.leaveOut.join(", ")}.`);
    return {
      sceneId,
      title: sceneLabel(s.what),
      durationSec: d,
      seed: (o.seed + i * 7919) >>> 0,
      set,
      view: "side",
      camera: i % 3 === 0 ? "wide" : i % 3 === 1 ? "medium" : "close",
      actors,
      props,
      beats,
      sfx: [],
      caption: null,
      note: notes.length ? notes.join(" ").slice(0, 200) : null,
    };
  });
  const width = o.format?.width ?? 1080;
  const height = o.format?.height ?? 1920;
  const raw: StoryScript = {
    engine: ENGINE_VERSION,
    fps: 30,
    width: width as StoryScript["width"],
    height: height as StoryScript["height"],
    durationSec: r1(scenes.reduce((a, sc) => a + sc.durationSec, 0)),
    title: o.title.slice(0, 80),
    seed: o.seed,
    cast,
    ...(Object.keys(cars).length ? { cars } : {}),
    scenes,
    music: o.musicMood === "none" ? null : { mood: o.musicMood, volume: 0.35 },
    captionsOn: o.captionsOn,
    captions: [],
    safety: o.topicId ? { topicId: o.topicId, citations: citationsFor(o.topicId) } : null,
    ...(o.art === "night_drive" ? { art: "night_drive" as const } : {}),
  };
  const fitted = fitDuration(normalizeScript(raw), fitTarget(o.durationSec, own.scenes));
  const script: StoryScript = { ...fitted, captions: ownerCues(own, fitted.scenes) };
  const r = validateScript(script);
  if (!r.ok) throw new Error(`The practice adapter made a script the engine refused: ${r.errors.join(" ")}`);
  const problems = ownProblems(script, own);
  if (problems.length) throw new OwnFailed(problems[0]!);
  return script;
}

/**
 * The code check (§45.46.6, the parts the final script shows): the scenes and their order, the owner's words (one `w_sN`
 * cue a caption, the same words, inside its scene; no scene caption; no other cue but the owner's own edits), who is in
 * each scene, and the place. The owner's sentences of what broke, first problem first; [] when the script was kept.
 */
export function ownProblems(script: StoryScript, own: OwnScript, ownerEdits: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  const ids = own.scenes.map((s, i) => s.sceneId ?? `s${i + 1}`);
  ids.forEach((id, i) => {
    if (script.scenes[i]?.sceneId !== id) out.push(OWN_FAILS.lost(i + 1));
  });
  if (script.scenes.length !== ids.length && !out.length) out.push(OWN_FAILS.lost(Math.min(ids.length, script.scenes.length) + 1));
  if (out.length) return out;
  const key = new Map<string, string>();
  for (const [k, m] of Object.entries(script.cast)) key.set(m.characterId, k);
  for (const [k, m] of Object.entries(script.cars ?? {})) key.set(m.characterId, k);
  const names = new Map<string, string>([...Object.entries(script.cast), ...Object.entries(script.cars ?? {})].map(([k, m]) => [k, m.name]));
  let start = 0;
  const mine = new Set<string>();
  own.scenes.forEach((s, i) => {
    const n = i + 1;
    const sc = script.scenes[i]!;
    const end = start + sc.durationSec;
    if (sc.caption) out.push(OWN_FAILS.words(n));
    if (s.caption) {
      const cues = script.captions.filter((c) => c.id === `w_${sc.sceneId}`);
      mine.add(`w_${sc.sceneId}`);
      const cue = cues[0];
      if (cues.length !== 1 || !cue || !sameWords(cue.text, s.caption) || cue.at < start - 0.05 || cue.at + cue.dur > end + 0.05) out.push(OWN_FAILS.words(n));
    }
    if (s.who?.length) {
      const want = new Set(s.who.map((id) => key.get(id)).filter((k): k is string => !!k));
      const there = new Set([...sc.actors.map((a) => a.castId), ...sc.props.map((p) => p.castId).filter((k): k is string => !!k)]);
      const missing = [...want].find((k) => !there.has(k));
      const extra = [...there].find((k) => !want.has(k));
      if (missing) out.push(OWN_FAILS.who(n, names.get(missing) ?? "someone"));
      else if (extra) out.push(OWN_FAILS.extra(n));
    }
    if (s.place && sc.set !== s.place) out.push(OWN_FAILS.place(n, (placeLabel(s.place) ?? s.place).toLowerCase()));
    start = end;
  });
  const other = script.captions.find((c) => !mine.has(c.id) && !ownerEdits.has(c.id));
  if (other) {
    const at = script.scenes.findIndex((_, i) => script.scenes.slice(0, i + 1).reduce((a, x) => a + x.durationSec, 0) > other.at);
    out.push(OWN_FAILS.words(Math.max(0, at) + 1));
  }
  return out;
}

// ---------- Check the facts on an owner's script: reported, never rewritten (§45.46.7) ----------

/**
 * The practice fact checker on the owner's own words: in a fog video, a scene (or its caption) that says "full beam"
 * disagrees with the checked advice. Each problem names "Your scene N" (the refs own:sN and caption:w_sN); the words
 * stay exactly as the owner wrote them.
 */
export function ownFactProblems(own: OwnScript, topicId: string | null): string[] {
  if (topicId !== "fog-driving") return [];
  const out: string[] = [];
  const advice = "the checked advice says to use dipped headlights in fog. (The Highway Code)";
  own.scenes.forEach((s, i) => {
    if (/full beam|high beam/i.test(s.what)) out.push(`Your scene ${i + 1} (“${s.what}”): ${advice}`);
    if (s.caption && /full beam|high beam/i.test(s.caption)) out.push(`Your scene ${i + 1}'s caption (“${s.caption}”): ${advice}`);
  });
  return out;
}

// ---------- PATCH: Change my script, and the captions editor's mirror (§45.46.5) ----------

/** The cue ids the owner added or changed by hand (the code check lets them be). */
const edits = new WeakMap<object, Set<string>>();
export function ownerEditsOf(story: object): Set<string> {
  let s = edits.get(story);
  if (!s) {
    s = new Set();
    edits.set(story, s);
  }
  return s;
}

const sameShape = (a: OwnScript, b: OwnScript) =>
  a.scenes.length === b.scenes.length &&
  a.scenes.every((s, i) => {
    const t = b.scenes[i]!;
    return s.what === t.what && JSON.stringify(s.who ?? []) === JSON.stringify(t.who ?? []) && (s.place ?? null) === (t.place ?? null) && JSON.stringify(s.leaveOut ?? []) === JSON.stringify(t.leaveOut ?? []);
  });

/**
 * "Change my script" (§45.46.5). Only the captions changed: the script's `w_sN` cues follow them (a changed text, a new cue
 * timed in its scene, a cleared one gone), and only the steps a captions edit makes out of date are marked. Anything
 * else: every step is out of date and the topic is matched again (a driving-safety video needs checked advice). The
 * script is changed in place; the story's ownScript is the new one.
 */
export function patchOwn(story: Story, script: StoryScript | undefined, value: unknown, logline: string, switchGiven = false): StepKey[] {
  if (!story.ownScript) bad(OWN_WORDS.noScript, "ownScript");
  const next = checkOwnScript(value, story.characterIds);
  // The owner's first words turn the captions on (as a new video's do), unless the switch is set in the same change.
  const firstWords = !story.ownScript.scenes.some((s) => s.caption) && next.scenes.some((s) => s.caption);
  if (firstWords && !switchGiven && story.captionsOn === false) {
    story.captionsOn = true;
    if (script) script.captionsOn = true;
  }
  // A new or changed caption that needs more time than its scene has (the agent's 90 % rule) stages it again.
  const fits = (sc: { durationSec: number }, i: number) => {
    const c = next.scenes[i]?.caption ?? null;
    return !c || c === (story.ownScript!.scenes[i]?.caption ?? null) || sc.durationSec >= 0.9 * need({ caption: c }) - 1e-9;
  };
  if (script && sameShape(story.ownScript, next) && script.scenes.length === next.scenes.length && script.scenes.every(fits)) {
    const changed = next.scenes.some((s, i) => (s.caption ?? null) !== (story.ownScript!.scenes[i]?.caption ?? null));
    if (!changed) {
      story.ownScript = next;
      return [];
    }
    let start = 0;
    const cues = [...script.captions];
    script.scenes.forEach((sc, i) => {
      const id = `w_${sc.sceneId}`;
      const caption = next.scenes[i]?.caption ?? null;
      const at = cues.findIndex((c) => c.id === id);
      if (!caption) {
        if (at >= 0) cues.splice(at, 1);
      } else if (at >= 0) {
        cues[at] = { ...cues[at]!, text: caption };
      } else cues.push({ id, at: r2(start + 0.25), dur: r2(Math.max(0.3, sc.durationSec - 0.5)), text: caption });
      if (caption) ownerEditsOf(story).add(id);
      start += sc.durationSec;
    });
    script.captions = cues.sort((a, z) => a.at - z.at);
    story.ownScript = next;
    return ["safety", "captions", "assemble", "preview"];
  }
  const topic = ownTopic(story.title, logline, next, story.category);
  if (story.category === "driving_safety" && !topic) throw new ApiError(409, "conflict", NO_GUIDANCE);
  story.safetyTopicId = topic;
  story.ownScript = next;
  ownerEditsOf(story).clear();
  return [...STEP_ORDER];
}

/** A captions edit (the CaptionEditor) on an owner's script, copied into it: both copies of the owner's words agree. */
export function mirrorCaptions(story: Story, cues: CaptionCue[]): void {
  if (!story.ownScript) return;
  const by = new Map(cues.map((c) => [c.id, c]));
  story.ownScript.scenes.forEach((s, i) => {
    const cue = by.get(`w_${s.sceneId ?? `s${i + 1}`}`);
    if (cue && CAPTION_MARKS.test(cue.text)) bad(OWN_WORDS.marks(i + 1), "captions");
  });
  story.ownScript = {
    scenes: story.ownScript.scenes.map((s, i) => {
      const cue = by.get(`w_${s.sceneId ?? `s${i + 1}`}`);
      return { ...s, caption: cue?.text.trim() || null };
    }),
  };
  for (const c of cues) if (!c.id.startsWith("w_")) ownerEditsOf(story).add(c.id);
}
