// Lamo Stories mock: the stories part (docs/CONTRACTS.md §45.9, §45.16.8). Builder G.
// Stories in every status, a practice "writer" that makes real engine scripts (they pass validateScript), and
// production jobs that walk their `configuration.run` steps in about 10 seconds (knobs: jobSeconds, failStep,
// safetyProblems on window.__cfStoriesMock.store.knobs). The status table, the stale rules and the approve rule of
// §45.9 hold here as they do in the API. In mock mode the "final video" is the engine's live preview (no videoUrl);
// stills and the cover are the engine's middle frames drawn on a small canvas when the browser has one.
//
// Also the small helpers the ideas and characters parts share (ids, errors, the workspace check, the seed ids).
import { ApiError, type ErrorCode } from "../../../api/errors.ts";
import { DEFAULT_CLIP_MODEL } from "../../../lib/models.ts";
import { CATALOG, drawFrame, ENGINE_VERSION, fitDuration, normalizeScript, sceneFrames, validateScript } from "../../engine/engine.ts";
import type { ActionId, Beat, CameraId, CastMember, Expression, NoiseId, PropAction, PropKind, Scene, SceneActor, SceneProp, SetId, SfxId, StoryScript } from "../../engine/types.ts";
import { drawPrims } from "../../preview/draw.ts";
import {
  STEP_LABEL,
  STEP_ORDER,
  type Captions,
  type Character,
  type IdeaCategory,
  type LibraryItem,
  type MusicMood,
  type ProductionJob,
  type StepKey,
  type StoriesApi,
  type StoriesConfig,
  type Story,
  type StorySafety,
  type StoryStatus,
} from "../types.ts";
import { citationsFor, shownSteps, topicFor } from "./ideas.ts";
import { delay, type MockStore } from "./store.ts";

export const KEYS = ["listStories", "createStory", "getStory", "storyJobs", "patchStory", "deleteStory", "produce", "cancelStory", "approve", "reject", "requestChanges", "download"] as const;

// ---------- Shared helpers (the ideas and characters parts use them too) ----------

/** The fixed ids of the seeded things, so the parts can point at each other. */
export const SEED_IDS = {
  characters: { pip: "01JSTCH0000000000000000001", bolt: "01JSTCH0000000000000000002", nana: "01JSTCH0000000000000000003", dash: "01JSTCH0000000000000000004" },
  ideas: {
    skid: "01JSTDE0000000000000000001",
    fog: "01JSTDE0000000000000000002",
    shoes: "01JSTDE0000000000000000003",
    sandwich: "01JSTDE0000000000000000004",
    tractor: "01JSTDE0000000000000000005",
    gps: "01JSTDE0000000000000000006",
    rainbow: "01JSTDE0000000000000000007",
    deer: "01JSTDE0000000000000000008",
  },
  stories: {
    review: "01JSTST0000000000000000001",
    needsCheck: "01JSTST0000000000000000002",
    approved: "01JSTST0000000000000000003",
    published: "01JSTST0000000000000000004",
    rejected: "01JSTST0000000000000000005",
    producing: "01JSTST0000000000000000006",
    failed: "01JSTST0000000000000000007",
    draft: "01JSTST0000000000000000008",
  },
} as const;

export function fail(status: number, code: ErrorCode, message: string): never {
  throw new ApiError(status, code, message);
}

export function clone<T>(v: T): T {
  return structuredClone(v);
}

export function iso(ms = Date.now()): string {
  return new Date(ms).toISOString();
}

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let counter = 0;

/** A ULID-shaped id (time first, so newer sorts later). */
export function mockId(): string {
  let t = Date.now();
  let time = "";
  for (let i = 0; i < 10; i += 1) {
    time = ALPHABET[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  counter += 1;
  let r = counter * 7919 + Math.floor(Math.random() * 1000);
  let rand = "";
  for (let i = 0; i < 16; i += 1) {
    rand = ALPHABET[r % 32]! + rand;
    r = Math.floor(r / 32);
  }
  return time + rand;
}

/** The S routes' workspace check (§45.5): Lamo Clips' id is a conflict, an unknown id is not found. */
export function guardWs(store: MockStore, ws: string): void {
  if (ws === "clips") fail(409, "conflict", "That is a Lamo Stories page. Switch to Lamo Stories first.");
  if (store.workspaces.length) {
    const w = store.workspaces.find((x) => x.workspaceId === ws);
    if (!w) fail(404, "not_found", "We could not find that workspace.");
    if (w.workspaceType !== "stories") fail(409, "conflict", "That is a Lamo Stories page. Switch to Lamo Stories first.");
  } else if (ws !== "stories") fail(404, "not_found", "We could not find that workspace.");
}

function wsConfig(store: MockStore, ws: string): Partial<StoriesConfig> {
  return (store.workspaces.find((w) => w.workspaceId === ws)?.configuration ?? {}) as Partial<StoriesConfig>;
}

const NO_GUIDANCE = "Lamo Stories only makes driving-safety videos from checked advice, and this one isn't in the list yet.";

// ---------- The practice writer: a real engine script from a brief and a cast ----------

interface Brief {
  title: string;
  logline: string;
  category: IdeaCategory;
}

interface Draft {
  title: string;
  set: SetId;
  view?: "side" | "top";
  camera: CameraId;
  actors: SceneActor[];
  props: SceneProp[];
  beats: (d: number) => Beat[];
  text?: { text: string; ref?: string };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** One beat, with no empty keys (the engine's validator reads every key it is given). */
function b(at: number, dur: number, who: string, act: ActionId | PropAction, extra: Partial<Pick<Beat, "face" | "to" | "dir" | "bubble" | "noise" | "sfx">> = {}): Beat {
  const beat: Beat = { at: r1(at), dur: r1(Math.max(0.3, dur)), who, do: act };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) (beat as unknown as Record<string, unknown>)[k] = v;
  return beat;
}

function faceOf(c: Character | undefined, want: Expression): Expression {
  return c?.expressions.includes(want) ? want : "neutral";
}

function noiseOf(c: Character | undefined, want: NoiseId): NoiseId | undefined {
  if (!c || c.voice.style === "none" || !c.voice.noises.length) return undefined;
  return c.voice.noises.includes(want) ? want : c.voice.noises[0];
}

function castOf(chars: Character[]): Record<string, CastMember> {
  const cast: Record<string, CastMember> = {};
  chars.forEach((c, i) => {
    cast[`c${i + 1}`] = { characterId: c.characterId, name: c.name, look: clone(c.look), movementStyle: c.movementStyle, voice: clone(c.voice) };
  });
  return cast;
}

const TROUBLE: Record<string, { set: SetId; prop?: PropKind; carDo: PropAction; sfx: SfxId; face: Expression; top?: boolean }> = {
  "skid-recovery": { set: "icy_road", prop: "ice_patch", carDo: "skid", sfx: "skid", face: "shocked", top: true },
  "ice-snow-driving": { set: "snowy_road", prop: "snow", carDo: "skid", sfx: "snow_crunch", face: "worried" },
  "tyre-blowout": { set: "highway", prop: "tyre", carDo: "tyre_burst", sfx: "tyre_burst", face: "shocked" },
  aquaplaning: { set: "rainy_road", prop: "puddle", carDo: "skid", sfx: "rain", face: "scared", top: true },
  "brake-failure": { set: "country_road", carDo: "wobble", sfx: "brake_squeal", face: "scared" },
  "stuck-accelerator": { set: "road_day", carDo: "move", sfx: "engine", face: "shocked" },
  "off-road-recovery": { set: "country_road", prop: "cone", carDo: "wobble", sfx: "bump", face: "surprised" },
  "fog-driving": { set: "foggy_road", prop: "fog", carDo: "move", sfx: "wind", face: "worried" },
  "animal-on-road": { set: "country_road", prop: "deer", carDo: "stop", sfx: "brake_squeal", face: "shocked" },
  "motorway-breakdown": { set: "highway", prop: "warning_triangle", carDo: "stop", sfx: "beep", face: "worried" },
  "abs-emergency-stop": { set: "city_street", prop: "stop_sign", carDo: "stop", sfx: "screech", face: "shocked" },
  crosswinds: { set: "highway", prop: "dust", carDo: "wobble", sfx: "wind", face: "worried" },
};

function actionFor(text: string): ActionId {
  const t = text.toLowerCase();
  if (/\bsteer|turn the (steering )?wheel/.test(t)) return t.includes("left") ? "steer_left" : "steer_right";
  if (/\bbrake|slow down|stop\b/.test(t)) return "brake";
  if (/\blook|check|see\b/.test(t)) return "look_right";
  if (/\bcalm|breathe/.test(t)) return "nod";
  if (/\bhold|grip/.test(t)) return "brace";
  return "drive";
}

function drivingDrafts(chars: Character[], topicId: string, n: number): Draft[] {
  const t = TROUBLE[topicId] ?? { set: "road_day" as SetId, carDo: "wobble" as PropAction, sfx: "screech" as SfxId, face: "surprised" as Expression };
  const lead = chars[0];
  const pal = chars[1];
  const steps = shownSteps(topicId).filter((s) => s.text.length <= 60);
  const teach = Math.max(1, n - 4);
  const car = (x: number): SceneProp => ({ propId: "car1", kind: "car", x, y: 0.72, scale: 1, rot: 0, ...(lead ? { color: lead.look.outfit.top } : {}) });
  const inCar = (x: number): SceneActor[] => [{ castId: "c1", x, y: 0.72, facing: "right", inCar: "car1" }];
  const out: Draft[] = [
    {
      title: "Off we go",
      set: t.set,
      camera: "wide",
      actors: inCar(0.4),
      props: [car(0.4)],
      beats: (d) => [b(0, d * 0.9, "car1", "move", { to: { x: 0.6, y: 0.72 } }), b(0.2, d * 0.6, "c1", "drive", { face: faceOf(lead, "happy"), bubble: "music", sfx: "engine" })],
    },
    {
      title: "Uh oh!",
      set: t.set,
      camera: "shake",
      actors: inCar(0.5),
      props: [car(0.5), ...(t.prop ? [{ propId: "p1", kind: t.prop, x: 0.72, y: 0.76, scale: 1, rot: 0 }] : [])],
      beats: (d) => [b(0.2, d * 0.5, "car1", t.carDo), b(0.3, d * 0.5, "c1", "gasp", { face: faceOf(lead, t.face), bubble: "exclaim", noise: noiseOf(lead, "gasp"), sfx: t.sfx })],
    },
  ];
  for (let i = 0; i < teach; i += 1) {
    const step = steps.length ? steps[i % steps.length] : undefined;
    const act = actionFor(step?.text ?? "");
    out.push({
      title: `Step ${i + 1}`,
      set: t.set,
      view: i === 0 && t.top ? "top" : "side",
      camera: (["medium", "close", "push_in"] as const)[i % 3] ?? "medium",
      actors: inCar(0.5),
      props: [car(0.5)],
      beats: (d) => [
        b(0.2, d * 0.7, "c1", act, { face: faceOf(lead, "determined") }),
        act === "brake" ? b(0.4, d * 0.5, "car1", "stop") : b(0.4, d * 0.5, "car1", "move", { to: { x: 0.56, y: 0.72 } }),
      ],
      text: step ? { text: step.text, ref: step.id } : { text: "Stay calm." },
    });
  }
  out.push({
    title: "Phew!",
    set: t.set,
    camera: "medium",
    actors: inCar(0.55),
    props: [car(0.55)],
    beats: (d) => [b(0.1, d * 0.4, "car1", "stop"), b(0.4, d * 0.5, "c1", "nod", { face: faceOf(lead, "relieved"), noise: noiseOf(lead, "phew") })],
  });
  out.push({
    title: "Remember",
    set: "studio",
    camera: "wide",
    actors: [{ castId: "c1", x: 0.4, y: 0.76, facing: "right" }, ...(pal ? [{ castId: "c2", x: 0.68, y: 0.76, facing: "left" as const }] : [])],
    props: [{ propId: "p9", kind: "check", x: 0.5, y: 0.3, scale: 1, rot: 0 }],
    beats: (d) => [
      b(0.1, d * 0.6, "c1", "thumbs_up", { face: faceOf(lead, "proud"), sfx: "ding" }),
      b(0.2, d * 0.3, "p9", "appear"),
      ...(pal ? [b(0.3, d * 0.5, "c2", "wave", { face: faceOf(pal, "happy") })] : []),
    ],
  });
  return out;
}

const MOMENTS: Record<Exclude<IdeaCategory, "driving_safety">, { title: string; set: SetId; act: ActionId; face: Expression; bubble?: Beat["bubble"]; noise?: NoiseId; sfx?: SfxId; pal?: ActionId; text?: string }[]> = {
  comedy: [
    { title: "A big plan", set: "kitchen", act: "think", face: "thinking", bubble: "idea", noise: "hmm", sfx: "ding" },
    { title: "Here goes!", set: "kitchen", act: "walk", face: "determined", sfx: "footsteps", pal: "look_right" },
    { title: "Oops!", set: "kitchen", act: "slip", face: "shocked", noise: "oops", sfx: "boing", pal: "gasp" },
    { title: "Bump!", set: "living_room", act: "fall", face: "dizzy", sfx: "thud", pal: "facepalm" },
    { title: "Try again", set: "living_room", act: "get_up", face: "determined", pal: "point" },
    { title: "Nearly there", set: "park", act: "gesture", face: "surprised", sfx: "whoosh", pal: "shrug" },
    { title: "It works!", set: "park", act: "celebrate", face: "happy", bubble: "heart", noise: "yay", sfx: "tada", pal: "dance" },
  ],
  everyday_skills: [
    { title: "Hmm, how?", set: "living_room", act: "think", face: "thinking", bubble: "question", noise: "hmm" },
    { title: "First step", set: "living_room", act: "point", face: "determined", sfx: "click", text: "Start with the first small step" },
    { title: "Next step", set: "kitchen", act: "gesture", face: "happy", sfx: "pop", text: "Then the next one" },
    { title: "Oh no, again", set: "kitchen", act: "shrug", face: "worried", noise: "sigh", pal: "nod" },
    { title: "Slow and steady", set: "office", act: "nod", face: "determined", text: "Slow and steady wins" },
    { title: "Got it!", set: "park", act: "thumbs_up", face: "proud", sfx: "ding", pal: "celebrate", text: "You've got it!" },
    { title: "Ta-da!", set: "park", act: "celebrate", face: "happy", noise: "yay", sfx: "tada", pal: "dance" },
  ],
  explainer: [
    { title: "I wonder...", set: "studio", act: "think", face: "thinking", bubble: "question", noise: "hmm" },
    { title: "Look here", set: "studio", act: "point", face: "surprised", sfx: "pop", text: "Look closely" },
    { title: "What happens", set: "studio", act: "gesture", face: "determined", sfx: "whoosh", text: "Here is what happens" },
    { title: "And then", set: "studio", act: "point", face: "happy", sfx: "click", pal: "nod", text: "And then this" },
    { title: "Aha!", set: "studio", act: "nod", face: "proud", bubble: "idea", sfx: "ding", text: "That's the secret!" },
    { title: "Now you know", set: "studio", act: "celebrate", face: "happy", noise: "yay", sfx: "tada", pal: "thumbs_up" },
  ],
};

function storyDrafts(chars: Character[], category: Exclude<IdeaCategory, "driving_safety">, n: number): Draft[] {
  const list = MOMENTS[category];
  const lead = chars[0];
  const pals = chars.slice(1);
  const picked = [list[0]!, ...Array.from({ length: Math.max(0, n - 2) }, (_, i) => list[1 + (i % (list.length - 2))]!), list[list.length - 1]!];
  const cameras: CameraId[] = ["wide", "medium", "close", "push_in", "pan_left", "medium", "pan_right", "wide"];
  return picked.map((m, i) => ({
    title: m.title,
    set: m.set,
    camera: cameras[i % cameras.length]!,
    actors: [
      { castId: "c1", x: 0.4, y: 0.76, facing: "right" as const },
      ...pals.map((_, k) => ({ castId: `c${k + 2}`, x: k === 0 ? 0.7 : 0.18, y: 0.76, facing: (k === 0 ? "left" : "right") as "left" | "right" })),
    ],
    props: m.bubble === "heart" ? [{ propId: "p1", kind: "sparkles" as PropKind, x: 0.5, y: 0.35, scale: 1, rot: 0 }] : [],
    beats: (d) => [
      b(0.1, d * 0.7, "c1", m.act, { face: faceOf(lead, m.face), bubble: m.bubble, noise: m.noise ? noiseOf(lead, m.noise) : undefined, sfx: m.sfx }),
      ...pals.map((p, k) => b(0.4 + k * 0.2, d * 0.5, `c${k + 2}`, m.pal ?? "idle", { face: faceOf(p, m.pal === "facepalm" ? "sad" : "happy") })),
      ...(m.bubble === "heart" ? [b(0.3, d * 0.4, "p1", "appear")] : []),
    ],
    ...(m.text ? { text: { text: m.text } } : {}),
  }));
}

/** The engine must accept every script the practice writer makes. */
function checked(s: StoryScript): StoryScript {
  const r = validateScript(s);
  if (!r.ok) throw new Error(`The practice writer made a script the engine refused: ${r.errors.join(" ")}`);
  return s;
}

/** On-screen captions from each scene's teaching text, in the whole video's time. */
function cuesFor(s: StoryScript, texts: Record<string, { text: string; ref?: string }>): StoryScript["captions"] {
  const out: StoryScript["captions"] = [];
  let start = 0;
  for (const scene of s.scenes) {
    const t = texts[scene.sceneId];
    if (t) {
      out.push({
        id: `cap${out.length + 1}`,
        at: r1(start + 0.3),
        dur: r1(Math.max(1, scene.durationSec - 0.6)),
        text: t.text.slice(0, 60),
        ...(t.ref ? { guidanceRef: t.ref } : {}),
      });
    }
    start += scene.durationSec;
  }
  return out;
}

function writeScript(chars: Character[], brief: Brief, o: { seed: number; topicId: string | null; captionsOn: boolean; musicMood: MusicMood; durationSec: number; note?: string | null }): StoryScript {
  const safety = brief.category === "driving_safety" && o.topicId ? o.topicId : null;
  const n = Math.min(8, Math.max(safety ? 5 : 4, Math.round(o.durationSec / 7.5)));
  const drafts = safety ? drivingDrafts(chars, safety, n) : storyDrafts(chars, brief.category === "driving_safety" ? "explainer" : brief.category, n);
  const d = Math.min(15, Math.max(2, r1(o.durationSec / drafts.length)));
  const texts: Record<string, { text: string; ref?: string }> = {};
  const scenes: Scene[] = drafts.map((dr, i) => {
    const sceneId = `s${i + 1}`;
    if (dr.text) texts[sceneId] = dr.text;
    return {
      sceneId,
      title: dr.title.slice(0, 40),
      durationSec: d,
      seed: (o.seed + i * 7919) >>> 0,
      set: dr.set,
      view: dr.view ?? "side",
      camera: dr.camera,
      actors: dr.actors,
      props: dr.props,
      beats: dr.beats(d),
      sfx: [],
      caption: null,
      note: i === 0 && o.note ? `Changes asked for: ${o.note}`.slice(0, 200) : null,
    };
  });
  const raw: StoryScript = {
    engine: ENGINE_VERSION,
    fps: 30,
    width: 1080,
    height: 1920,
    durationSec: r1(d * scenes.length),
    title: brief.title.slice(0, 80),
    seed: o.seed,
    cast: castOf(chars),
    scenes,
    music: o.musicMood === "none" ? null : { mood: o.musicMood, volume: 0.35 },
    captionsOn: o.captionsOn,
    captions: [],
    safety: safety ? { topicId: safety, citations: citationsFor(safety) } : null,
  };
  const fitted = fitDuration(normalizeScript(raw), o.durationSec);
  return checked({ ...fitted, captions: cuesFor(fitted, texts) });
}

const OTHER_TAKE: Partial<Record<string, ActionId | PropAction>> = {
  slip: "fall",
  fall: "slip",
  walk: "run",
  run: "walk",
  think: "shrug",
  shrug: "think",
  celebrate: "dance",
  dance: "celebrate",
  point: "gesture",
  gesture: "point",
  nod: "thumbs_up",
  thumbs_up: "nod",
  gasp: "cower",
  drive: "look_left",
  steer_left: "steer_right",
  steer_right: "steer_left",
  wave: "jump",
  get_up: "brace",
  move: "wobble",
  wobble: "move",
};
const CAMERAS: CameraId[] = ["wide", "medium", "close", "pan_left", "pan_right", "push_in"];

/** "Remake this scene": a new take of only these scenes (same cast, place and length; new action, staging and seed). */
function retake(prev: StoryScript, sceneIds: string[], salt: number): StoryScript {
  const scenes = prev.scenes.map((sc) => {
    if (!sceneIds.includes(sc.sceneId)) return sc;
    return {
      ...sc,
      seed: ((sc.seed ?? prev.seed) + 1009 + salt) >>> 0,
      camera: CAMERAS[(CAMERAS.indexOf(sc.camera) + 1) % CAMERAS.length]!,
      actors: sc.actors.map((a) => ({ ...a, x: r1(Math.min(0.9, Math.max(0.1, 1 - a.x))), facing: a.facing === "left" ? ("right" as const) : ("left" as const) })),
      beats: sc.beats.map((bt) => ({ ...bt, do: (OTHER_TAKE[bt.do] ?? bt.do) as Beat["do"] })),
      note: "A new take",
    };
  });
  return checked(normalizeScript({ ...prev, scenes }));
}

function postCaptionsFor(title: string, logline: string, topicId: string | null): Captions {
  const cites = topicId ? citationsFor(topicId) : [];
  const pubs = [...new Set(cites.map((c) => c.publisher))].slice(0, 3);
  const sources = pubs.length ? `\n\nBased on advice from ${pubs.join(", ")}. Check your local road rules.\nSources:\n${cites.slice(0, 4).map((c) => c.url).join("\n")}` : "";
  return {
    youtubeTitle: `${title} #Shorts`.slice(0, 100),
    youtubeDescription: `${logline}${sources}\n\n#LamoStories #animation`.slice(0, 5000),
    instagram: `${logline}${pubs.length ? ` Based on ${pubs[0]} advice.` : ""} #LamoStories #animation #cartoon`.slice(0, 2200),
    facebook: `${logline}${sources}`.slice(0, 5000),
    tiktok: `${logline} #LamoStories #animation #fyp`.slice(0, 2200),
    x: `${title}: ${logline}`.slice(0, 270),
  };
}

/**
 * The practice fact checker: in a fog story, words that say "full beam" (and are not one of the checked steps)
 * disagree with the checked advice.
 */
function problemsIn(s: StoryScript): string[] {
  if (s.safety?.topicId !== "fog-driving") return [];
  const texts = [...s.captions.filter((c) => !c.guidanceRef).map((c) => c.text), ...s.scenes.map((sc) => sc.caption ?? "")];
  return texts
    .filter((t) => /full beam|high beam/i.test(t))
    .map((t) => `“${t}” does not match the checked advice. In fog, use dipped headlights, not full beam.`);
}

// ---------- Stills, assets and the step runner ----------

const isBrowser = () => typeof document !== "undefined" && typeof navigator !== "undefined" && !/jsdom/i.test(navigator.userAgent);
const stillCache = new Map<string, string>();

/** A scene's middle frame as a small JPEG data URL (the browser draws it with the engine), else a plain card. */
function stillOf(storyId: string, s: StoryScript, sceneId: string): string {
  const key = `${storyId}:${s.seed}:${sceneId}:${JSON.stringify(s.scenes.find((x) => x.sceneId === sceneId) ?? "")}`;
  const hit = stillCache.get(key);
  if (hit) return hit;
  let url: string | null = null;
  if (isBrowser()) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 216;
      canvas.height = 384;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const [from, to] = sceneFrames(s, sceneId);
        drawPrims(ctx, drawFrame(s, from + Math.floor((to - from) / 2)), canvas.width / s.width);
        url = canvas.toDataURL("image/jpeg", 0.82);
      }
    } catch {
      url = null;
    }
  }
  if (!url) {
    const title = s.scenes.find((x) => x.sceneId === sceneId)?.title ?? "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 160"><rect width="90" height="160" fill="#322a73"/><circle cx="45" cy="70" r="18" fill="#ffc94a"/><text x="45" y="120" font-size="9" fill="#fff6e5" text-anchor="middle" font-family="sans-serif">${title.replace(/[<&>"]/g, "")}</text></svg>`;
    url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
  if (stillCache.size > 400) stillCache.clear();
  stillCache.set(key, url);
  return url;
}

interface Run {
  start: number;
  done: number;
  fail: StepKey | null;
  problems: string[] | null;
}

interface Extra {
  brief: Brief;
  statusBefore: StoryStatus;
  stills: boolean;
  cover: boolean;
}

const runs = new WeakMap<ProductionJob, Run>();
const extras = new WeakMap<MockStore, Map<string, Extra>>();
const tickers = new WeakMap<MockStore, ReturnType<typeof setInterval>>();

function extraOf(store: MockStore, storyId: string): Extra {
  let all = extras.get(store);
  if (!all) {
    all = new Map();
    extras.set(store, all);
  }
  let e = all.get(storyId);
  if (!e) {
    const story = store.stories.find((s) => s.storyId === storyId);
    e = { brief: { title: story?.title ?? "", logline: story?.title ?? "", category: story?.category ?? "comedy" }, statusBefore: "draft", stills: false, cover: false };
    all.set(storyId, e);
  }
  return e;
}

const order = (keys: Iterable<StepKey>) => {
  const set = new Set(keys);
  return STEP_ORDER.filter((k) => set.has(k));
};

function seconds(store: MockStore): number {
  const s = Number(store.knobs.jobSeconds);
  return Number.isFinite(s) && s > 0 ? s : 10;
}

function progressOf(job: ProductionJob): number {
  let n = 0;
  for (const st of job.steps) {
    if (st.status === "done" || st.status === "skipped") n += 1;
    else if (st.status === "running" && st.n) n += (st.i ?? 0) / st.n;
  }
  return Math.round((n / job.steps.length) * 1000) / 1000;
}

function addAsset(store: MockStore, story: Story, kind: LibraryItem["kind"], url: string, contentType: string, bytes: number, sceneId?: string): void {
  for (const a of store.assets)
    if (a.storyId === story.storyId && a.kind === kind && (sceneId === undefined || a.meta.sceneId === sceneId)) a.meta = { ...a.meta, current: 0 };
  store.assets.push({
    assetId: mockId(),
    kind,
    storyId: story.storyId,
    characterId: null,
    title: story.title,
    url,
    contentType,
    bytes,
    version: story.scriptVersion,
    createdAt: iso(),
    meta: sceneId ? { sceneId, current: 1 } : { current: 1 },
  });
}

const EMPTY_VIDEO = "data:video/mp4;base64,";

function sceneCount(store: MockStore, job: ProductionJob, key: StepKey): number {
  if (key !== "scenes" && key !== "animation") return 0;
  if (job.configuration.sceneIds?.length) return job.configuration.sceneIds.length;
  return store.scripts[job.contentId]?.scenes.length ?? 6;
}

/** What each finished step leaves behind, as the agent writes it (§45.9.1). */
function finishStep(store: MockStore, job: ProductionJob, key: StepKey, run: Run): "done" | "skipped" {
  const story = store.stories.find((s) => s.storyId === job.contentId);
  if (!story) return "done";
  const extra = extraOf(store, story.storyId);
  const chars = story.characterIds.map((id) => store.characters.find((c) => c.characterId === id)).filter((c): c is Character => !!c);
  let result: "done" | "skipped" = "done";
  const script = store.scripts[story.storyId];
  if (key === "storyboard") {
    const { sceneIds, note } = job.configuration;
    const seed = (hash(story.storyId) + story.scriptVersion * 101) >>> 0;
    const next =
      script && sceneIds?.length && !note
        ? retake(script, sceneIds, story.scriptVersion)
        : writeScript(chars.length ? chars : [], extra.brief, { seed, topicId: story.safetyTopicId, captionsOn: story.captionsOn, musicMood: story.musicMood, durationSec: story.durationSec, note });
    story.scriptVersion += 1;
    store.scripts[story.storyId] = next;
    story.scenes = next.scenes.map((sc) => ({ sceneId: sc.sceneId, title: sc.title, durationSec: sc.durationSec }));
    story.postCaptions = postCaptionsFor(story.title, extra.brief.logline, story.category === "driving_safety" ? story.safetyTopicId : null);
    extra.stills = false;
    extra.cover = false;
    job.meta.scriptVersion = story.scriptVersion;
    job.meta.seed = next.seed;
    addAsset(store, story, "storyboard", `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(next))}`, "application/json", JSON.stringify(next).length);
  } else if (key === "safety" && script) {
    const problems = run.problems ?? problemsIn(script);
    const topicId = story.category === "driving_safety" ? story.safetyTopicId : null;
    story.safety = { topicId, status: problems.length ? "problems" : "ok", problems, checkedScriptVersion: story.scriptVersion, citations: citationsFor(topicId) };
  } else if (key === "scenes" && script) {
    extra.stills = true;
    for (const sc of script.scenes) if (!job.configuration.sceneIds || job.configuration.sceneIds.includes(sc.sceneId)) addAsset(store, story, "scene_still", stillOf(story.storyId, script, sc.sceneId), "image/jpeg", 24_000, sc.sceneId);
  } else if (key === "animation" && script) {
    for (const sc of script.scenes) if (!job.configuration.sceneIds || job.configuration.sceneIds.includes(sc.sceneId)) addAsset(store, story, "scene_clip", EMPTY_VIDEO, "video/mp4", Math.round(sc.durationSec * 900_000), sc.sceneId);
  } else if (key === "sound") {
    addAsset(store, story, "audio", "data:audio/mp4;base64,", "audio/mp4", Math.round(story.durationSec * 24_000));
  } else if (key === "captions") {
    if (!story.captionsOn) result = "skipped";
    else addAsset(store, story, "captions", `data:text/plain;charset=utf-8,${encodeURIComponent("[Script Info]\nTitle: " + story.title)}`, "text/plain", 2_000);
  } else if (key === "assemble" && script) {
    story.actualDurationSec = script.durationSec;
    job.meta.actualSec = script.durationSec;
    extra.cover = true;
    addAsset(store, story, "final_video", EMPTY_VIDEO, "video/mp4", Math.round(script.durationSec * 1_400_000));
    const mid = script.scenes[Math.floor(script.scenes.length / 2)];
    if (mid) addAsset(store, story, "cover", stillOf(story.storyId, script, mid.sceneId), "image/jpeg", 30_000);
  }
  story.stale = story.stale.filter((k) => k !== key);
  story.version += 1;
  story.updatedAt = iso();
  return result;
}

function endJob(store: MockStore, job: ProductionJob, now: number): void {
  const story = store.stories.find((s) => s.storyId === job.contentId);
  const problems = story?.safety?.status === "problems";
  job.status = problems ? "needs_check" : "ready";
  job.progress = 1;
  job.updatedAt = iso(now);
  if (!story) return;
  story.status = problems ? "needs_check" : "review";
  story.currentJobId = null;
  story.version += 1;
  story.updatedAt = iso(now);
}

function failJob(store: MockStore, job: ProductionJob, key: StepKey, now: number): void {
  const step = job.steps.find((s) => s.key === key);
  if (step) {
    step.status = "failed";
    step.message = "This step stopped.";
    step.finishedAt = iso(now);
  }
  job.status = "failed";
  job.error = `Making the video stopped at “${STEP_LABEL[key]}”. Tap Try again.`;
  job.updatedAt = iso(now);
  job.progress = progressOf(job);
  const story = store.stories.find((s) => s.storyId === job.contentId);
  if (!story) return;
  story.status = "failed";
  story.stale = order([...story.stale, ...STEP_ORDER.slice(STEP_ORDER.indexOf(key))]);
  story.currentJobId = null;
  story.version += 1;
  story.updatedAt = iso(now);
}

/** Moves every running job on to where its time says it is (each read calls this; so does a small timer). */
export function advanceJobs(store: MockStore, now = Date.now()): void {
  const total = seconds(store) * 1000;
  for (const job of store.jobs) {
    if (job.status !== "queued" && job.status !== "running") continue;
    const run = runs.get(job);
    if (!run) continue;
    const keys = job.configuration.run as StepKey[];
    const per = total / Math.max(1, keys.length);
    const elapsed = now - run.start;
    if (job.status === "queued") {
      if (elapsed < Math.min(400, per / 2)) continue;
      job.status = "running";
    }
    while (run.done < keys.length) {
      const key = keys[run.done]!;
      const step = job.steps.find((s) => s.key === key);
      if (!step) {
        run.done += 1;
        continue;
      }
      if (step.status === "pending") {
        step.status = "running";
        step.startedAt = iso(run.start + run.done * per);
      }
      const n = sceneCount(store, job, key);
      if (elapsed < (run.done + 1) * per) {
        if (n > 1) {
          step.n = n;
          step.i = Math.min(n - 1, Math.floor(((elapsed - run.done * per) / per) * n));
          step.message = `Scene ${step.i + 1} of ${n}`;
        }
        break;
      }
      if (run.fail === key) {
        failJob(store, job, key, now);
        break;
      }
      try {
        step.status = finishStep(store, job, key, run);
      } catch (e) {
        console.warn(e);
        failJob(store, job, key, now);
        break;
      }
      if (n > 1) {
        step.i = n;
        step.n = n;
      }
      delete step.message;
      if (step.status === "skipped") step.message = "Captions are off.";
      step.finishedAt = iso(run.start + (run.done + 1) * per);
      run.done += 1;
    }
    if (job.status === "running") {
      if (run.done >= keys.length) endJob(store, job, now);
      else {
        job.progress = progressOf(job);
        job.updatedAt = iso(now);
      }
    }
  }
}

function wake(store: MockStore): void {
  if (typeof window === "undefined" || tickers.has(store)) return;
  const timer = setInterval(() => {
    advanceJobs(store);
    if (!store.jobs.some((j) => (j.status === "queued" || j.status === "running") && runs.has(j))) {
      clearInterval(timer);
      tickers.delete(store);
    }
  }, 500);
  tickers.set(store, timer);
}

function running(store: MockStore, story: Story): ProductionJob | null {
  const job = store.jobs.find((j) => j.jobId === story.currentJobId);
  return job && (job.status === "queued" || job.status === "running") ? job : null;
}

function startJob(store: MockStore, story: Story, jobType: ProductionJob["jobType"], run: StepKey[], conf: { from: StepKey | null; sceneIds: string[] | null; note: string | null }, now = Date.now()): ProductionJob {
  const cfg = wsConfig(store, story.workspaceId);
  const job: ProductionJob = {
    jobId: mockId(),
    workspaceId: story.workspaceId,
    contentType: "animation",
    contentId: story.storyId,
    jobType,
    status: "queued",
    steps: STEP_ORDER.map((key) => ({ key, label: STEP_LABEL[key], status: run.includes(key) ? "pending" : "done" })),
    progress: 0,
    configuration: { run, ...conf },
    meta: {
      writerModel: run.includes("storyboard") ? (cfg.storyModel ?? DEFAULT_CLIP_MODEL) : null,
      engineVersion: ENGINE_VERSION,
      seed: store.scripts[story.storyId]?.seed ?? null,
      scriptVersion: story.scriptVersion || null,
      targetSec: story.durationSec,
      actualSec: story.actualDurationSec,
      safetyTopicId: story.safetyTopicId,
      providers: { writer: "bedrock-claude", images: cfg.providers?.images ?? "builtin-rig", animation: "builtin-2d", audio: "builtin-synth" },
    },
    createdAt: iso(now),
    updatedAt: iso(now),
  };
  job.progress = progressOf(job);
  const knob = store.knobs.failStep as StepKey | null | undefined;
  const failAt = knob && run.includes(knob) ? knob : null;
  if (failAt) store.knobs.failStep = null;
  const problems = Array.isArray(store.knobs.safetyProblems) ? (store.knobs.safetyProblems as string[]) : null;
  runs.set(job, { start: now, done: 0, fail: failAt, problems });
  store.jobs.push(job);
  extraOf(store, story.storyId).statusBefore = story.status === "producing" ? "draft" : story.status;
  story.status = "producing";
  story.currentJobId = job.jobId;
  story.stale = order([...story.stale, ...run]);
  if (run.includes("safety") && story.safety) story.safety = { ...story.safety, status: "pending" };
  story.version += 1;
  story.updatedAt = iso(now);
  wake(store);
  return job;
}

function storyOut(store: MockStore, story: Story): Story {
  const copy = clone(story);
  const extra = extraOf(store, story.storyId);
  const script = store.scripts[story.storyId];
  if (script && extra.stills) copy.scenes = copy.scenes.map((sc) => ({ ...sc, stillUrl: stillOf(story.storyId, script, sc.sceneId) }));
  if (script && extra.cover) {
    const mid = script.scenes[Math.floor(script.scenes.length / 2)];
    if (mid) copy.coverUrl = stillOf(story.storyId, script, mid.sceneId);
  }
  return copy;
}

function find(store: MockStore, ws: string, storyId: string): Story {
  const s = store.stories.find((x) => x.storyId === storyId && x.workspaceId === ws);
  if (!s) fail(404, "not_found", "We could not find that video. It may have been deleted.");
  return s;
}

function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "lamo-story"
  );
}

const EMPTY_CAPTIONS: Captions = { youtubeTitle: "", youtubeDescription: "", instagram: "", facebook: "", tiktok: "", x: "" };
const CAPTION_LIMITS: Record<keyof Captions, number> = { youtubeTitle: 100, youtubeDescription: 5000, instagram: 2200, facebook: 5000, tiktok: 2200, x: 280 };
const SFX_IDS = new Set<string>(CATALOG.sfx.map((e) => e.id));
const MOODS = new Set<string>(CATALOG.musicMoods.map((e) => e.id));

/** The approve rule (§45.9), as the sentence the 409 carries, or null when it holds. */
function approveProblem(story: Story): string | null {
  if (story.safety?.status === "problems") return `Fix the facts first: ${story.safety.problems.join(" ")}`;
  if (story.status !== "review" || story.stale.length) return "Your changes aren't in the video yet. Tap Remake first.";
  if (story.safety && (story.safety.status !== "ok" || story.safety.checkedScriptVersion !== story.scriptVersion)) return "Your changes aren't in the video yet. Tap Remake first.";
  return null;
}

// ---------- Seed ----------

interface SeedSpec {
  id: string;
  ideaId: string | null;
  brief: Brief;
  cast: string[];
  status: StoryStatus;
  durationSec: number;
  musicMood: MusicMood;
  ageDays: number;
  captionsOn?: boolean;
  /** replace one caption's text (the needs_check story's wrong advice) */
  badCaption?: string;
  failAt?: StepKey;
  reviewNote?: string;
}

function seedStory(store: MockStore, spec: SeedSpec, now: number): void {
  const ws = "stories";
  const at = now - spec.ageDays * 86_400_000;
  const chars = spec.cast.map((id) => store.characters.find((c) => c.characterId === id)).filter((c): c is Character => !!c);
  const topicId = spec.brief.category === "driving_safety" ? topicFor(`${spec.brief.title} ${spec.brief.logline}`) : null;
  const story: Story = {
    storyId: spec.id,
    workspaceId: ws,
    contentType: "animation",
    title: spec.brief.title,
    status: spec.status,
    category: spec.brief.category,
    ideaId: spec.ideaId,
    characterIds: chars.map((c) => c.characterId),
    durationSec: spec.durationSec,
    actualDurationSec: null,
    captionsOn: spec.captionsOn ?? true,
    musicMood: spec.musicMood,
    postCaptions: { ...EMPTY_CAPTIONS },
    scenes: [],
    scriptVersion: 0,
    storageLocation: `s3://cf-prod-media/ws/mock-user/${ws}/stories/${spec.id}/`,
    stale: [],
    safetyTopicId: topicId,
    safety: null,
    reviewNote: spec.reviewNote ?? null,
    currentJobId: null,
    posted: [],
    version: 1,
    createdAt: iso(at),
    updatedAt: iso(at + 600_000),
  };
  store.stories.push(story);
  const extra = extraOf(store, spec.id);
  extra.brief = spec.brief;
  const job: ProductionJob = {
    jobId: `01JSTJB${spec.id.slice(7)}`,
    workspaceId: ws,
    contentType: "animation",
    contentId: spec.id,
    jobType: "produce",
    status: "ready",
    steps: STEP_ORDER.map((key) => ({ key, label: STEP_LABEL[key], status: "done", startedAt: iso(at), finishedAt: iso(at + 300_000) })),
    progress: 1,
    configuration: { run: [...STEP_ORDER], from: null, sceneIds: null, note: null },
    meta: { writerModel: DEFAULT_CLIP_MODEL, engineVersion: ENGINE_VERSION, seed: null, scriptVersion: 1, targetSec: spec.durationSec, actualSec: null, safetyTopicId: topicId, providers: { writer: "bedrock-claude", images: "builtin-rig", animation: "builtin-2d", audio: "builtin-synth" } },
    createdAt: iso(at),
    updatedAt: iso(at + 300_000),
  };
  store.jobs.push(job);
  if (spec.status === "producing") {
    store.jobs.pop();
    story.status = "draft";
    const live = startJob(store, story, "produce", [...STEP_ORDER], { from: null, sceneIds: null, note: null }, now);
    live.jobId = job.jobId;
    story.currentJobId = live.jobId;
    return;
  }
  if (spec.status === "draft") {
    job.status = "canceled";
    job.steps = job.steps.map((s, i) => ({ key: s.key, label: s.label, status: i === 0 ? "running" : "pending" }));
    job.progress = 0;
    story.stale = [...STEP_ORDER];
    return;
  }
  let script = writeScript(chars, spec.brief, { seed: hash(spec.id), topicId, captionsOn: story.captionsOn, musicMood: spec.musicMood, durationSec: spec.durationSec });
  if (spec.badCaption && script.captions[0]) script = checked({ ...script, captions: script.captions.map((c, i) => (i === 0 ? { ...c, text: spec.badCaption!, guidanceRef: undefined } : c)).map(({ guidanceRef, ...c }) => (guidanceRef ? { ...c, guidanceRef } : c)) });
  store.scripts[spec.id] = script;
  story.scriptVersion = 1;
  story.version = 6;
  story.scenes = script.scenes.map((sc) => ({ sceneId: sc.sceneId, title: sc.title, durationSec: sc.durationSec }));
  story.postCaptions = postCaptionsFor(spec.brief.title, spec.brief.logline, topicId);
  job.meta.seed = script.seed;
  const problems = problemsIn(script);
  story.safety = { topicId, status: problems.length ? "problems" : "ok", problems, checkedScriptVersion: 1, citations: citationsFor(topicId) } satisfies StorySafety;
  extra.stills = true;
  addAsset(store, story, "storyboard", `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(script))}`, "application/json", JSON.stringify(script).length);
  for (const sc of script.scenes) addAsset(store, story, "scene_still", stillOf(spec.id, script, sc.sceneId), "image/jpeg", 24_000, sc.sceneId);
  if (spec.failAt) {
    const k = STEP_ORDER.indexOf(spec.failAt);
    job.status = "failed";
    job.error = `Making the video stopped at “${STEP_LABEL[spec.failAt]}”. Tap Try again.`;
    job.steps = job.steps.map((s, i) => (i < k ? s : i === k ? { ...s, status: "failed", message: "This step stopped.", finishedAt: iso(at + 200_000) } : { key: s.key, label: s.label, status: "pending" }));
    job.progress = k / STEP_ORDER.length;
    story.stale = STEP_ORDER.slice(k);
    return;
  }
  extra.cover = true;
  story.actualDurationSec = script.durationSec;
  job.meta.actualSec = script.durationSec;
  if (problems.length) job.status = "needs_check";
  for (const sc of script.scenes) addAsset(store, story, "scene_clip", EMPTY_VIDEO, "video/mp4", Math.round(sc.durationSec * 900_000), sc.sceneId);
  addAsset(store, story, "audio", "data:audio/mp4;base64,", "audio/mp4", Math.round(script.durationSec * 24_000));
  if (story.captionsOn) addAsset(store, story, "captions", `data:text/plain;charset=utf-8,${encodeURIComponent("[Script Info]\nTitle: " + story.title)}`, "text/plain", 2_000);
  addAsset(store, story, "final_video", EMPTY_VIDEO, "video/mp4", Math.round(script.durationSec * 1_400_000));
  const mid = script.scenes[Math.floor(script.scenes.length / 2)];
  if (mid) addAsset(store, story, "cover", stillOf(spec.id, script, mid.sceneId), "image/jpeg", 30_000);
  if (spec.status === "approved" || spec.status === "published") story.approvedAt = iso(at + 3_600_000);
  if (spec.status === "published") {
    story.publishedAt = iso(at + 7_200_000);
    story.posted = [{ platform: "youtube", url: "https://www.youtube.com/shorts/lamostories01" }];
  }
}

export function seed(store: MockStore): void {
  const now = Date.now();
  const { characters: C, ideas: I, stories: S } = SEED_IDS;
  const specs: SeedSpec[] = [
    { id: S.review, ideaId: I.skid, brief: { title: "When the car starts to slide", logline: "Pip hits black ice and the car starts sliding. Pip stays calm and steers out of it.", category: "driving_safety" }, cast: [C.pip], status: "review", durationSec: 45, musicMood: "tense", ageDays: 1 },
    {
      id: S.needsCheck,
      ideaId: I.fog,
      brief: { title: "Foggy morning drive", logline: "Nana Rose drives through thick fog and shows how to see and be seen.", category: "driving_safety" },
      cast: [C.nana],
      status: "needs_check",
      durationSec: 40,
      musicMood: "calm",
      ageDays: 1.5,
      badCaption: "Turn on your full beam lights",
    },
    { id: S.approved, ideaId: I.shoes, brief: { title: "Bolt ties his shoes", logline: "Bolt keeps tripping on his laces until he learns the bunny-ears trick.", category: "everyday_skills" }, cast: [C.bolt], status: "approved", durationSec: 35, musicMood: "playful", ageDays: 3 },
    { id: S.published, ideaId: I.sandwich, brief: { title: "The sandwich tower", logline: "Pip builds the tallest sandwich ever. Dash wants a bite. The tower wobbles.", category: "comedy" }, cast: [C.pip, C.dash], status: "published", durationSec: 30, musicMood: "comedic", ageDays: 5 },
    { id: S.rejected, ideaId: I.sandwich, brief: { title: "The sandwich tower (first try)", logline: "Pip builds a sandwich tower and Dash knocks it over.", category: "comedy" }, cast: [C.pip, C.dash], status: "rejected", durationSec: 30, musicMood: "comedic", ageDays: 6, reviewNote: "Too short, and the ending was flat." },
    { id: S.failed, ideaId: null, brief: { title: "Why do leaves fall?", logline: "Bolt wonders why the trees drop their leaves every autumn.", category: "explainer" }, cast: [C.bolt, C.nana], status: "failed", durationSec: 30, musicMood: "wonder", ageDays: 2, failAt: "animation" },
    { id: S.draft, ideaId: null, brief: { title: "Dash at the car wash", logline: "Dash tries to wash the car and ends up covered in bubbles.", category: "comedy" }, cast: [C.dash], status: "draft", durationSec: 30, musicMood: "comedic", ageDays: 0.6 },
    { id: S.producing, ideaId: null, brief: { title: "When the car floats on water", logline: "Heavy rain, standing water: Nana Rose feels the car float and knows what to do.", category: "driving_safety" }, cast: [C.nana, C.pip], status: "producing", durationSec: 45, musicMood: "tense", ageDays: 0.01 },
  ];
  for (const spec of specs) seedStory(store, spec, now);
}

// ---------- The routes ----------

export function api(store: MockStore): Pick<StoriesApi, (typeof KEYS)[number]> {
  const settle = () => advanceJobs(store);
  return {
    async listStories(ws, q = {}) {
      guardWs(store, ws);
      settle();
      await delay(120);
      const limit = Math.min(50, Math.max(1, q.limit ?? 20));
      const all = store.stories
        .filter((s) => s.workspaceId === ws && (!q.status || q.status === "all" || s.status === q.status))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const from = q.cursor ? Number(q.cursor) || 0 : 0;
      const page = all.slice(from, from + limit);
      return { stories: page.map((s) => storyOut(store, s)), nextCursor: from + limit < all.length ? String(from + limit) : null };
    },
    async createStory(ws, body) {
      guardWs(store, ws);
      const cfg = wsConfig(store, ws);
      const ids = body.characterIds ?? [];
      if (ids.length < 1 || ids.length > 3) fail(400, "bad_request", "Pick 1 to 3 characters.");
      const chars = ids.map((id) => store.characters.find((c) => c.characterId === id && c.workspaceId === ws));
      if (chars.some((c) => !c)) fail(404, "not_found", "We could not find one of those characters.");
      const idea = body.ideaId ? store.ideas.find((i) => i.ideaId === body.ideaId && i.workspaceId === ws) : undefined;
      if (body.ideaId && !idea) fail(404, "not_found", "We could not find that idea. It may have been deleted.");
      if (!idea) {
        const br = body.brief;
        if (!br || !br.title?.trim() || !br.logline?.trim()) fail(400, "bad_request", "Pick an idea, or type a title and one line.");
        if (br.title.length > 80 || br.logline.length > 280) fail(400, "bad_request", "Make the title or the line a little shorter.");
      }
      const brief: Brief = idea ? { title: idea.title, logline: idea.logline, category: idea.category } : { title: body.brief!.title.trim(), logline: body.brief!.logline.trim(), category: body.brief!.category };
      const safetyTopicId = brief.category === "driving_safety" ? (idea ? idea.safetyTopicId : topicFor(`${brief.title} ${brief.logline}`)) : null;
      if (brief.category === "driving_safety" && !safetyTopicId) fail(409, "conflict", NO_GUIDANCE);
      const durationSec = body.durationSec ?? cfg.defaultDurationSec ?? 45;
      if (durationSec < 15 || durationSec > 90) fail(400, "bad_request", "Pick a length from 15 to 90 seconds.");
      const musicMood = body.musicMood ?? (cfg.musicOn === false ? "none" : "playful");
      if (!MOODS.has(musicMood)) fail(400, "bad_request", "Pick a music mood.");
      await delay(220);
      const now = Date.now();
      const storyId = mockId();
      const story: Story = {
        storyId,
        workspaceId: ws,
        contentType: "animation",
        title: (body.title ?? brief.title).trim().slice(0, 80),
        status: "draft",
        category: brief.category,
        ideaId: idea?.ideaId ?? null,
        characterIds: [...ids],
        durationSec,
        actualDurationSec: null,
        captionsOn: body.captionsOn ?? cfg.captionsOn ?? true,
        musicMood,
        postCaptions: { ...EMPTY_CAPTIONS },
        scenes: [],
        scriptVersion: 0,
        storageLocation: `s3://cf-prod-media/ws/mock-user/${ws}/stories/${storyId}/`,
        stale: [],
        safetyTopicId,
        safety: null,
        reviewNote: null,
        currentJobId: null,
        posted: [],
        version: 1,
        createdAt: iso(now),
        updatedAt: iso(now),
      };
      store.stories.push(story);
      extraOf(store, storyId).brief = brief;
      if (idea) {
        idea.status = "used";
        idea.storyIds = [...idea.storyIds, storyId];
        idea.updatedAt = iso(now);
      }
      const job = startJob(store, story, "produce", [...STEP_ORDER], { from: null, sceneIds: null, note: null }, now);
      return { story: storyOut(store, story), job: clone(job) };
    },
    async getStory(ws, storyId) {
      guardWs(store, ws);
      settle();
      await delay(100);
      const story = find(store, ws, storyId);
      const job = store.jobs.find((j) => j.jobId === story.currentJobId) ?? store.jobs.filter((j) => j.contentId === storyId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
      const script = store.scripts[storyId];
      return { story: storyOut(store, story), job: job ? clone(job) : null, script: script ? clone(script) : null };
    },
    async storyJobs(ws, storyId) {
      guardWs(store, ws);
      settle();
      await delay(100);
      find(store, ws, storyId);
      return store.jobs
        .filter((j) => j.contentId === storyId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((j) => clone(j));
    },
    async patchStory(ws, storyId, patch) {
      guardWs(store, ws);
      settle();
      await delay(180);
      const story = find(store, ws, storyId);
      if (running(store, story)) fail(409, "conflict", "Wait until the video is done, then change it.");
      if (!["review", "needs_check", "failed"].includes(story.status)) fail(409, "conflict", "You can only change a video while it waits for review.");
      if (patch.version !== story.version) fail(409, "conflict", "This video changed while you were editing. Reload to see the newest version.");
      const before = store.scripts[storyId];
      const script: StoryScript | undefined = before ? clone(before) : undefined;
      const stale = new Set(story.stale);
      const mark = (...keys: StepKey[]) => keys.forEach((k) => stale.add(k));
      if (patch.title !== undefined) {
        const t = patch.title.trim();
        if (!t || t.length > 80) fail(400, "bad_request", "Give the video a title of up to 80 letters.");
        story.title = t;
        if (script) script.title = t;
        for (const a of store.assets) if (a.storyId === storyId) a.title = t;
      }
      if (patch.postCaptions) {
        const next = { ...story.postCaptions };
        for (const [k, v] of Object.entries(patch.postCaptions) as [keyof Captions, string][]) {
          if (!(k in CAPTION_LIMITS)) fail(400, "bad_request", "Unknown caption.");
          if (v.length > CAPTION_LIMITS[k]) fail(400, "bad_request", "One of the post captions is too long.");
          next[k] = v;
        }
        if (JSON.stringify(next) !== JSON.stringify(story.postCaptions)) mark("safety");
        story.postCaptions = next;
      }
      if (script) {
        const total = () => script.scenes.reduce((s, sc) => s + sc.durationSec, 0);
        if (patch.captionsOn !== undefined && patch.captionsOn !== script.captionsOn) {
          script.captionsOn = patch.captionsOn;
          story.captionsOn = patch.captionsOn;
          mark("captions", "assemble", "preview", "safety");
        }
        if (patch.musicMood !== undefined && patch.musicMood !== story.musicMood) {
          if (!MOODS.has(patch.musicMood)) fail(400, "bad_request", "Pick a music mood.");
          story.musicMood = patch.musicMood;
          script.music = patch.musicMood === "none" ? null : { mood: patch.musicMood, volume: script.music?.volume ?? 0.35 };
          mark("sound", "assemble", "preview");
        }
        for (const edit of patch.scenes ?? []) {
          const sc = script.scenes.find((x) => x.sceneId === edit.sceneId);
          if (!sc) fail(400, "bad_request", "One of those scenes is not in this video.");
          if (edit.durationSec !== undefined && edit.durationSec !== sc.durationSec) {
            if (edit.durationSec < 2 || edit.durationSec > 15) fail(400, "bad_request", "A scene can be 2 to 15 seconds long.");
            const f = edit.durationSec / sc.durationSec;
            sc.beats = sc.beats.map((bt) => ({ ...bt, at: r1(bt.at * f), dur: r1(bt.dur * f) }));
            sc.sfx = sc.sfx.map((c) => ({ ...c, at: r1(Math.min(edit.durationSec!, c.at * f)) }));
            sc.durationSec = edit.durationSec;
            mark("animation", "sound", "captions", "assemble", "preview");
          }
          if (edit.caption !== undefined && edit.caption !== sc.caption) {
            if (edit.caption !== null && edit.caption.length > 60) fail(400, "bad_request", "Scene words can be up to 60 letters.");
            sc.caption = edit.caption && edit.caption.trim() ? edit.caption.trim() : null;
            mark("captions", "assemble", "preview", "safety");
          }
          if (edit.sfx !== undefined && JSON.stringify(edit.sfx) !== JSON.stringify(sc.sfx)) {
            const seen = new Set<string>();
            for (const c of edit.sfx) {
              if (!SFX_IDS.has(c.sfx)) fail(400, "bad_request", "One of those sounds is not one Lamo Stories has.");
              if (c.at < 0 || c.at > sc.durationSec) fail(400, "bad_request", "Every sound must play inside its scene.");
              if (c.volume < 0 || c.volume > 1) fail(400, "bad_request", "Sound volume is 0 to 1.");
              if (!c.id || seen.has(c.id)) fail(400, "bad_request", "Each sound needs its own id.");
              seen.add(c.id);
            }
            sc.sfx = [...edit.sfx].sort((a, z) => a.at - z.at);
            mark("sound", "assemble", "preview");
          }
        }
        script.durationSec = r1(total());
        if (patch.captions !== undefined && JSON.stringify(patch.captions) !== JSON.stringify(script.captions)) {
          for (const c of patch.captions) {
            if (!c.text.trim() || c.text.length > 60) fail(400, "bad_request", "Each caption needs 1 to 60 letters.");
            if (c.at < 0 || c.dur < 0.5 || c.at + c.dur > script.durationSec + 0.5) fail(400, "bad_request", "Every caption must show inside the video.");
          }
          script.captions = [...patch.captions].sort((a, z) => a.at - z.at);
          mark("captions", "assemble", "preview", "safety");
        }
        if (JSON.stringify(script) !== JSON.stringify(before)) {
          const r = validateScript(script);
          if (!r.ok) fail(400, "bad_request", "That change would break the video. Try a smaller change.");
          story.scriptVersion += 1;
          store.scripts[storyId] = script;
          story.scenes = script.scenes.map((sc) => ({ sceneId: sc.sceneId, title: sc.title, durationSec: sc.durationSec }));
        }
      } else if (patch.captions || patch.scenes || patch.musicMood || patch.captionsOn !== undefined) {
        fail(409, "conflict", "This video has no storyboard yet. Tap Try again first.");
      }
      story.stale = order(stale);
      if (stale.has("safety") && story.safety) story.safety = { ...story.safety, status: "pending" };
      story.version += 1;
      story.updatedAt = iso();
      const now = store.scripts[storyId];
      return { story: storyOut(store, story), script: now ? clone(now) : null };
    },
    async deleteStory(ws, storyId) {
      guardWs(store, ws);
      await delay(140);
      const story = find(store, ws, storyId);
      const job = running(store, story);
      if (job) job.status = "canceled";
      store.stories = store.stories.filter((s) => s.storyId !== storyId);
      store.jobs = store.jobs.filter((j) => j.contentId !== storyId);
      store.assets = store.assets.filter((a) => a.storyId !== storyId);
      delete store.scripts[storyId];
    },
    async produce(ws, storyId, body = {}) {
      guardWs(store, ws);
      settle();
      await delay(180);
      const story = find(store, ws, storyId);
      if (running(store, story)) fail(409, "conflict", "This video is being made right now. Wait until it is done.");
      if (!["draft", "review", "needs_check", "failed"].includes(story.status)) fail(409, "conflict", "This video can't be remade now.");
      if (body.from && !STEP_ORDER.includes(body.from)) fail(400, "bad_request", "Unknown step.");
      if (body.sceneIds && (!body.from || !["scenes", "animation"].includes(body.from))) fail(400, "bad_request", "Scenes can only be picked from Draw the scenes or Animate.");
      if (body.sceneIds?.some((id) => !story.scenes.some((sc) => sc.sceneId === id))) fail(400, "bad_request", "One of those scenes is not in this video.");
      if (!store.scripts[storyId] && body.from && body.from !== "storyboard") fail(409, "conflict", "This video has no storyboard yet. Tap Try again first.");
      const run = body.from ? STEP_ORDER.slice(STEP_ORDER.indexOf(body.from)) : order(story.stale);
      if (!run.length) fail(409, "conflict", "Nothing needs making again: the video already has every change.");
      const job = startJob(store, story, "produce", run, { from: body.from ?? null, sceneIds: body.sceneIds ?? null, note: null });
      return { story: storyOut(store, story), job: clone(job) };
    },
    async cancelStory(ws, storyId) {
      guardWs(store, ws);
      settle();
      await delay(140);
      const story = find(store, ws, storyId);
      const job = running(store, story);
      if (!job) fail(409, "conflict", "Nothing is being made for this video right now.");
      job.status = "canceled";
      for (const st of job.steps) if (st.status === "running") st.status = "pending";
      job.updatedAt = iso();
      story.status = extraOf(store, storyId).statusBefore;
      story.currentJobId = null;
      story.version += 1;
      story.updatedAt = iso();
      return { story: storyOut(store, story), job: clone(job) };
    },
    async approve(ws, storyId, version) {
      guardWs(store, ws);
      settle();
      await delay(160);
      const story = find(store, ws, storyId);
      if (version !== story.version) fail(409, "conflict", "This video changed while you were looking. Reload to see the newest version.");
      const problem = approveProblem(story);
      if (problem) fail(409, "conflict", problem);
      story.status = "approved";
      story.approvedAt = iso();
      story.version += 1;
      story.updatedAt = iso();
      return storyOut(store, story);
    },
    async reject(ws, storyId, reason) {
      guardWs(store, ws);
      settle();
      await delay(140);
      const story = find(store, ws, storyId);
      if (!["review", "needs_check"].includes(story.status)) fail(409, "conflict", "Only a video waiting for review can be rejected.");
      if (reason && reason.length > 500) fail(400, "bad_request", "Keep the reason to 500 letters.");
      story.status = "rejected";
      story.reviewNote = reason?.trim() || null;
      story.version += 1;
      story.updatedAt = iso();
      return storyOut(store, story);
    },
    async requestChanges(ws, storyId, body) {
      guardWs(store, ws);
      settle();
      await delay(180);
      const story = find(store, ws, storyId);
      const note = body.note?.trim() || null;
      const sceneIds = body.sceneIds?.length ? body.sceneIds : null;
      if (!note && !sceneIds) fail(400, "bad_request", "Say what to change, or pick a scene.");
      if (note && note.length > 500) fail(400, "bad_request", "Keep the note to 500 letters.");
      if (running(store, story)) fail(409, "conflict", "This video is being made right now. Wait until it is done.");
      if (!["review", "needs_check", "failed"].includes(story.status)) fail(409, "conflict", "This video can't be changed now.");
      if (!store.scripts[storyId]) fail(409, "conflict", "This video has no storyboard yet. Tap Try again first.");
      if (sceneIds?.some((id) => !story.scenes.some((sc) => sc.sceneId === id))) fail(400, "bad_request", "One of those scenes is not in this video.");
      if (note) story.reviewNote = note;
      const job = startJob(store, story, "changes", [...STEP_ORDER], { from: "storyboard", sceneIds, note });
      return { story: storyOut(store, story), job: clone(job) };
    },
    async download(ws, storyId) {
      guardWs(store, ws);
      await delay(120);
      const story = find(store, ws, storyId);
      if (story.status !== "approved" && story.status !== "published") fail(409, "conflict", "Approve the video first, then download it.");
      return { url: EMPTY_VIDEO, filename: `${slug(story.title)}.mp4` };
    },
  };
}
