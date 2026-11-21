// Lamo Stories animation engine (docs/CONTRACTS.md §45.10): story script → draw lists, text and sound timelines.
// One file set, two places: the browser draws it on a canvas for live previews, and the agent runs it with Deno
// (cli.ts) and rasterizes the draw lists into the final frames. Pure and deterministic: no DOM, no Date, no
// Math.random (use the seeded PRNG), relative ".ts" imports only.
//
// SCAFFOLD (Phase 1): this is a deliberately small first version so every builder can work against the real API.
// Builder D replaces the drawing with the full rig, sets, props, cameras and movement styles; the exported names and
// signatures below are the contract and must not change.

import { CATALOG, catalogIds } from "./catalog.ts";
import type {
  ActionId,
  AudioEvent,
  CharacterLook,
  Expression,
  MovementStyle,
  Prim,
  StoryScript,
  TextEvent,
  ValidateResult,
} from "./types.ts";

export { CATALOG };
export type * from "./types.ts";

export const ENGINE_VERSION = 1;
export const WIDTH = 1080;
export const HEIGHT = 1920;
export const FPS = 30;
/** Facebook Reels take at most 90 s; the audio tail needs a little room (CONTRACTS §45.9). */
export const MAX_SECONDS = 89.5;

/** A small seeded PRNG (mulberry32): the only randomness the engine may use. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEX = /^#[0-9a-f]{6}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateScript(s: unknown): ValidateResult {
  const errors: string[] = [];
  if (!isObj(s)) return { ok: false, errors: ["The script is not an object."] };
  if (s.fps !== FPS || s.width !== WIDTH || s.height !== HEIGHT) errors.push("The script must be 1080×1920 at 30 fps.");
  if (typeof s.durationSec !== "number" || s.durationSec < 5 || s.durationSec > 120) errors.push("durationSec is out of range.");
  if (!isObj(s.cast)) errors.push("cast is missing.");
  if (!Array.isArray(s.scenes) || s.scenes.length === 0) errors.push("scenes is empty.");
  const sets = new Set(catalogIds("sets"));
  const actions = new Set([...catalogIds("actions"), ...catalogIds("propActions")]);
  const cast = isObj(s.cast) ? s.cast : {};
  for (const [i, scene] of (Array.isArray(s.scenes) ? s.scenes : []).entries()) {
    if (!isObj(scene)) {
      errors.push(`scene ${i} is not an object.`);
      continue;
    }
    if (typeof scene.set !== "string" || !sets.has(scene.set)) errors.push(`scene ${i}: unknown set.`);
    if (typeof scene.durationSec !== "number" || scene.durationSec < 2 || scene.durationSec > 15)
      errors.push(`scene ${i}: durationSec must be 2 to 15.`);
    const props = new Set(Array.isArray(scene.props) ? scene.props.map((p) => (isObj(p) ? p.propId : "")) : []);
    for (const [j, beat] of (Array.isArray(scene.beats) ? scene.beats : []).entries()) {
      if (!isObj(beat)) continue;
      if (typeof beat.do !== "string" || !actions.has(beat.do)) errors.push(`scene ${i} beat ${j}: unknown action.`);
      if (typeof beat.who !== "string" || (!(beat.who in cast) && !props.has(beat.who)))
        errors.push(`scene ${i} beat ${j}: unknown actor or prop.`);
    }
  }
  for (const [id, m] of Object.entries(cast)) {
    if (!isObj(m) || !isObj(m.look) || typeof m.look.skin !== "string" || !HEX.test(m.look.skin))
      errors.push(`cast ${id}: look is missing.`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, script: s as unknown as StoryScript };
}

function sceneStarts(s: StoryScript): number[] {
  const starts: number[] = [];
  let t = 0;
  for (const scene of s.scenes) {
    starts.push(t);
    t += scene.durationSec;
  }
  return starts;
}

/** Moves every Beat.sfx into its scene's own effects list (ids "{sceneId}.fx{k}"), gives each scene a seed, and makes
 * sure every scene has an `sfx` list. Idempotent. */
export function normalizeScript(s: StoryScript): StoryScript {
  const scenes = s.scenes.map((sc, i) => {
    const sfx = [...(sc.sfx ?? [])];
    let k = sfx.length;
    const beats = sc.beats.map((b) => {
      if (!b.sfx) return b;
      k += 1;
      sfx.push({ id: `${sc.sceneId}.fx${k}`, at: b.at, sfx: b.sfx, volume: 0.8 });
      const { sfx: _moved, ...rest } = b;
      return rest;
    });
    return { ...sc, seed: sc.seed ?? (s.seed + i * 7919) >>> 0, beats, sfx: sfx.sort((a, b) => a.at - b.at) };
  });
  return { ...s, scenes };
}

/** Scales every scene (its beats and effects too) so the total lands within ±10% of the target and never above
 * MAX_SECONDS; scenes stay 2..15 s. */
export function fitDuration(s: StoryScript, targetSec: number): StoryScript {
  const total = s.scenes.reduce((sum, sc) => sum + sc.durationSec, 0);
  if (total <= 0) return s;
  const target = Math.min(targetSec, MAX_SECONDS);
  const k = target / total;
  let scenes = s.scenes.map((sc) => {
    const d = Math.min(15, Math.max(2, Math.round(sc.durationSec * k * 10) / 10));
    const f = d / sc.durationSec;
    return {
      ...sc,
      durationSec: d,
      beats: sc.beats.map((b) => ({ ...b, at: b.at * f, dur: b.dur * f })),
      sfx: (sc.sfx ?? []).map((c) => ({ ...c, at: c.at * f })),
    };
  });
  // Rounding or the 2 s floor may push the total over the cap: trim the longest scenes by 0.1 s until it fits.
  let sum = scenes.reduce((acc, sc) => acc + sc.durationSec, 0);
  while (sum > MAX_SECONDS + 1e-9) {
    const longest = scenes.reduce((best, sc, i) => (sc.durationSec > scenes[best]!.durationSec ? i : best), 0);
    const sc = scenes[longest]!;
    if (sc.durationSec <= 2) break;
    scenes = scenes.map((x, i) => (i === longest ? { ...x, durationSec: Math.round((x.durationSec - 0.1) * 10) / 10 } : x));
    sum = scenes.reduce((acc, x) => acc + x.durationSec, 0);
  }
  return { ...s, scenes, durationSec: Math.round(sum * 10) / 10 };
}

/** Each scene's frame range and its middle frame (the still). */
export function sceneList(s: StoryScript): { sceneId: string; from: number; to: number; mid: number }[] {
  return s.scenes.map((sc) => {
    const [from, to] = sceneFrames(s, sc.sceneId);
    return { sceneId: sc.sceneId, from, to, mid: from + Math.floor((to - from) / 2) };
  });
}

export function frameCount(s: StoryScript): number {
  return Math.round(s.scenes.reduce((sum, sc) => sum + sc.durationSec, 0) * s.fps);
}

/** [first frame, end frame) of one scene. */
export function sceneFrames(s: StoryScript, sceneId: string): [number, number] {
  const starts = sceneStarts(s);
  const i = s.scenes.findIndex((sc) => sc.sceneId === sceneId);
  if (i < 0) return [0, 0];
  const scene = s.scenes[i]!;
  const from = Math.round(starts[i]! * s.fps);
  return [from, from + Math.round(scene.durationSec * s.fps)];
}

function sceneAt(s: StoryScript, frame: number): { index: number; t: number } {
  const starts = sceneStarts(s);
  const time = frame / s.fps;
  for (let i = s.scenes.length - 1; i >= 0; i -= 1) {
    if (time >= starts[i]!) return { index: i, t: time - starts[i]! };
  }
  return { index: 0, t: 0 };
}

const SET_SKY: Record<string, string> = { road_night: "#1c1842", foggy_road: "#9aa3ad", icy_road: "#cfe8f5", snowy_road: "#dfeaf2" };

export function drawFrame(s: StoryScript, frame: number): Prim[] {
  const { index } = sceneAt(s, frame);
  const scene = s.scenes[index];
  if (!scene) return [{ k: "fill", color: "#1c1842" }];
  const out: Prim[] = [{ k: "fill", color: SET_SKY[scene.set] ?? "#62c6ff" }];
  out.push({ k: "rect", x: 0, y: HEIGHT * 0.62, w: WIDTH, h: HEIGHT * 0.38, r: 0, color: "#3a3f4b" });
  for (const actor of scene.actors) {
    const member = s.cast[actor.castId];
    if (!member) continue;
    out.push(...previewCharacter(member.look, member.movementStyle, "neutral", "idle", frame / s.fps, 520).map((p) =>
      shift(p, actor.x * WIDTH - 260, actor.y * HEIGHT - 520),
    ));
  }
  return out;
}

function shift(p: Prim, dx: number, dy: number): Prim {
  switch (p.k) {
    case "rect":
    case "circle":
    case "ellipse":
    case "image":
      return { ...p, x: p.x + dx, y: p.y + dy };
    case "poly":
    case "line":
      return { ...p, pts: p.pts.map((v, i) => v + (i % 2 === 0 ? dx : dy)) };
    default:
      return p;
  }
}

export function textTrack(s: StoryScript): TextEvent[] {
  const out: TextEvent[] = [];
  if (s.captionsOn) {
    for (const c of s.captions) {
      out.push({ start: c.at, end: c.at + c.dur, kind: "caption", text: c.text, x: WIDTH / 2, y: HEIGHT * 0.78, size: 64, color: "#fff6e5" });
    }
  }
  return out;
}

export function audioTrack(s: StoryScript): AudioEvent[] {
  const out: AudioEvent[] = [];
  const starts = sceneStarts(s);
  s.scenes.forEach((scene, i) => {
    const start = starts[i]!;
    for (const b of scene.beats) {
      const pitch = s.cast[b.who]?.voice.pitch;
      if (b.sfx) out.push({ at: start + b.at, kind: "sfx", id: b.sfx, volume: 0.8 });
      if (b.noise) out.push({ at: start + b.at, kind: "noise", id: b.noise, volume: 0.9, ...(pitch ? { pitch } : {}) });
    }
    for (const c of scene.sfx ?? []) out.push({ at: start + c.at, kind: "sfx", id: c.sfx, volume: c.volume });
  });
  return out.sort((a, b) => a.at - b.at);
}

/** One character, drawn into a size × size box from (0, 0). */
export function previewCharacter(
  look: CharacterLook,
  _style: MovementStyle,
  _expression: Expression,
  _action: ActionId,
  t: number,
  size: number,
): Prim[] {
  const u = size / 100;
  const bob = Math.sin(t * Math.PI * 2) * 1.2 * u;
  return [
    { k: "ellipse", x: 50 * u, y: 96 * u, rx: 22 * u, ry: 3 * u, rot: 0, color: "#000000", a: 0.2 },
    { k: "rect", x: 32 * u, y: 46 * u + bob, w: 36 * u * look.width, h: 46 * u * look.height, r: 14 * u, color: look.outfit.top },
    { k: "circle", x: 50 * u, y: 32 * u + bob, r: 18 * u, color: look.skin },
    { k: "circle", x: 44 * u, y: 30 * u + bob, r: 2.4 * u, color: "#1c1842" },
    { k: "circle", x: 56 * u, y: 30 * u + bob, r: 2.4 * u, color: "#1c1842" },
  ];
}
