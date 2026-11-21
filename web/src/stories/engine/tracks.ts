// Lamo Stories engine: the text track (captions, bubble symbols, the safety end card) and the audio track (every
// effect and character noise at its absolute time, plus the loops a place needs).

import { BUBBLE_SYMBOL, symbolSpan } from "./bubbles.ts";
import { clamp } from "./math.ts";
import { actorPath, STYLES } from "./motion.ts";
import { drives, prepare } from "./scene.ts";
import { setInfo } from "./sets.ts";
import type { AudioEvent, Beat, Scene, SfxId, StoryScript, TextEvent } from "./types.ts";

/** Captions sit in the platforms' safe area: above the bottom bar of names and buttons, away from the right column. */
export const CAPTION = { x: 520, y: 1400, maxW: 840, sizes: [64, 58, 52, 46, 40], color: "#fff6e5" };
/** Scene teaching text: under the platforms' top tabs. */
export const HEADER = { x: 520, y: 330, maxW: 840, sizes: [60, 54, 48, 42], color: "#ffc94a" };
/** The safety end card: high up, over the background, so it never covers a face. */
export const ENDCARD = { x: 540, y: 420, maxW: 860, sizes: [52, 48, 44, 40], color: "#fff6e5", seconds: 2.5, maxLines: 4 };

/** Inter ExtraBold widths in em, roughly: enough to wrap lines before they overflow. */
function charEm(ch: string): number {
  if (ch === " ") return 0.27;
  if ("il.,:;'!|I·•".includes(ch)) return 0.3;
  if ("ftrj()[]-/\"".includes(ch)) return 0.42;
  if ("mwMW@%&".includes(ch)) return 0.92;
  if (ch >= "A" && ch <= "Z") return 0.72;
  if (ch >= "0" && ch <= "9") return 0.63;
  return 0.6;
}

export function textWidth(text: string, size: number): number {
  let em = 0;
  for (const ch of text) em += charEm(ch);
  return em * size * 1.04;
}

/** Splits text into lines no wider than maxW (a word longer than a line keeps its own line); two lines are balanced. */
export function wrapText(text: string, size: number, maxW: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (!cur || textWidth(next, size) <= maxW) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length === 2) {
    let best = lines;
    let bestW = Math.max(...lines.map((l) => textWidth(l, size)));
    for (let i = 1; i < words.length; i += 1) {
      const a = words.slice(0, i).join(" ");
      const b = words.slice(i).join(" ");
      const wmax = Math.max(textWidth(a, size), textWidth(b, size));
      if (wmax <= maxW && wmax < bestW) {
        best = [a, b];
        bestW = wmax;
      }
    }
    return best;
  }
  return lines;
}

/** The biggest size at which the text fits in `maxLines` lines. */
export function fitText(text: string, sizes: number[], maxW: number, maxLines: number): { lines: string[]; size: number } {
  for (const size of sizes) {
    const lines = wrapText(text, size, maxW);
    if (lines.length <= maxLines && lines.every((l) => textWidth(l, size) <= maxW)) return { lines, size };
  }
  const size = sizes[sizes.length - 1]!;
  return { lines: wrapText(text, size, maxW).slice(0, maxLines), size };
}

const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");

/** "Based on {publisher} advice. Check your local road rules." with the cited publishers, shortened. */
export function endCardText(publishers: string[]): string {
  const names: string[] = [];
  for (const p of publishers) {
    // "UK Department for Transport (GOV.UK) - The Highway Code" → "The Highway Code"
    const last = p.split(/\s+[-–—]\s+/).pop() ?? p;
    const short = last.replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
    if (short && !names.some((n) => norm(n) === norm(short))) names.push(short);
  }
  const who = names.length === 0 ? "checked road safety" : names.length === 1 ? names[0]! : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names[0]}, ${names[1]} and other road safety`;
  return `Based on ${who} advice. Check your local road rules.`;
}

/** Each sentence of the end card starts on its own line ("Check your local road rules." stands alone). */
export function endCardLines(text: string): { lines: string[]; size: number } {
  const sentences = text.split(/(?<=\.)\s+/).filter(Boolean);
  for (const size of ENDCARD.sizes) {
    const lines = sentences.flatMap((t) => wrapText(t, size, ENDCARD.maxW));
    if (lines.length <= ENDCARD.maxLines && lines.every((l) => textWidth(l, size) <= ENDCARD.maxW)) return { lines, size };
  }
  return fitText(text, ENDCARD.sizes, ENDCARD.maxW, ENDCARD.maxLines);
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

export function textTrack(s: StoryScript): TextEvent[] {
  const prep = prepare(s);
  const total = prep.total;
  const out: TextEvent[] = [];
  if (s.captionsOn) {
    for (const c of s.captions ?? []) {
      if (!c.text?.trim() || c.at >= total) continue;
      const { lines, size } = fitText(c.text, CAPTION.sizes, CAPTION.maxW, 2);
      out.push({ start: round3(c.at), end: round3(Math.min(total, c.at + c.dur)), kind: "caption", text: lines.join("\n"), x: CAPTION.x, y: CAPTION.y, size, color: CAPTION.color });
    }
    s.scenes.forEach((sc, i) => {
      if (!sc.caption?.trim()) return;
      const start = prep.starts[i]!;
      const end = start + sc.durationSec;
      const dup = (s.captions ?? []).some((c) => norm(c.text) === norm(sc.caption!) && c.at < end && c.at + c.dur > start);
      if (dup) return;
      const { lines, size } = fitText(sc.caption, HEADER.sizes, HEADER.maxW, 2);
      // a safety story's end card takes the top of the frame for its last seconds
      const stop = s.safety ? Math.min(end - 0.05, total - ENDCARD.seconds) : end - 0.05;
      const from = start + Math.min(0.3, sc.durationSec * 0.1);
      if (stop - from < 0.6) return;
      out.push({ start: round3(from), end: round3(stop), kind: "caption", text: lines.join("\n"), x: HEADER.x, y: HEADER.y, size, color: HEADER.color });
    });
  }
  for (const b of prep.bubbles) {
    const sym = BUBBLE_SYMBOL[b.kind];
    if (!sym) continue;
    const [start, end] = symbolSpan(b);
    out.push({ start: round3(start), end: round3(end), kind: "bubble", text: sym.text, x: Math.round(b.x), y: Math.round(b.y - (b.kind === "idea" ? 6 : 0)), size: sym.size, color: sym.color });
  }
  if (s.safety) {
    const { lines, size } = endCardLines(endCardText((s.safety.citations ?? []).map((c) => c.publisher)));
    out.push({ start: round3(Math.max(0, total - ENDCARD.seconds)), end: round3(total), kind: "endcard", text: lines.join("\n"), x: ENDCARD.x, y: ENDCARD.y, size, color: ENDCARD.color });
  }
  return out.sort((a, b) => a.start - b.start || order(a.kind) - order(b.kind));
}

function order(k: TextEvent["kind"]): number {
  return k === "caption" ? 0 : k === "bubble" ? 1 : 2;
}

const LOOPS: Set<SfxId> = new Set(["engine", "wind", "rain"]);
const REPEATS: Set<SfxId> = new Set(["footsteps", "heartbeat", "tick", "snow_crunch"]);

/** -1 (left) .. 1 (right) from where the sound's maker stands. */
function panOf(s: StoryScript, scene: Scene, who: string | undefined, at: number): number {
  if (!who) return 0;
  const actor = scene.actors.find((a) => a.castId === who);
  let x = 0.5;
  if (actor) {
    const car = actor.inCar ? scene.props.find((p) => p.propId === actor.inCar) : undefined;
    if (car) x = car.x;
    else {
      const member = s.cast[who];
      const style = STYLES[member?.movementStyle ?? "bouncy"] ?? STYLES.bouncy;
      x = actorPath(actor, scene.beats.filter((b) => b.who === who).sort((a, b) => a.at - b.at), style, at).x;
    }
  } else {
    const prop = scene.props.find((p) => p.propId === who);
    if (prop) {
      const moved = scene.beats.filter((b) => b.who === who && b.to && b.at + b.dur <= at).pop();
      x = moved?.to?.x ?? prop.x;
    }
  }
  return Math.round(clamp((x - 0.5) * 1.6, -1, 1) * 100) / 100;
}

function matchBeat(scene: Scene, at: number, sfx: SfxId): Beat | undefined {
  return scene.beats.find((b) => Math.abs(b.at - at) < 0.002 && (b.sfx === undefined || b.sfx === sfx));
}

export function audioTrack(s: StoryScript): AudioEvent[] {
  const prep = prepare(s);
  const out: AudioEvent[] = [];
  s.scenes.forEach((scene, i) => {
    const start = prep.starts[i]!;
    const end = start + scene.durationSec;
    const have = new Set<SfxId>();
    const sfxEvent = (at: number, id: SfxId, volume: number, who: string | undefined, beatDur: number | undefined) => {
      const ev: AudioEvent = { at: round3(start + at), kind: "sfx", id, volume: clamp(volume, 0, 1), pan: panOf(s, scene, who, at) };
      if (LOOPS.has(id)) ev.dur = round3(Math.max(0.1, scene.durationSec - at));
      else if (REPEATS.has(id) && beatDur) ev.dur = round3(Math.min(beatDur, scene.durationSec - at));
      have.add(id);
      out.push(ev);
    };
    for (const b of scene.beats) {
      if (b.noise && b.who in s.cast) {
        const voice = s.cast[b.who]!.voice;
        if (voice?.style !== "none") {
          out.push({ at: round3(start + b.at), kind: "noise", id: b.noise, volume: 0.9, pitch: clamp(voice?.pitch ?? 1, 0.5, 2), pan: panOf(s, scene, b.who, b.at) });
        }
      }
      // a script that is not normalized yet still has its effects on the beats
      if (b.sfx) sfxEvent(b.at, b.sfx, 0.8, b.who, b.dur);
    }
    for (const c of scene.sfx ?? []) {
      const beat = matchBeat(scene, c.at, c.sfx);
      sfxEvent(c.at, c.sfx, c.volume, beat?.who, beat?.dur);
    }
    // the place's own loop, and weather props, unless the scene already has that sound
    const loops: { sfx: SfxId; volume: number; pan: number }[] = [];
    const info = setInfo(scene.set);
    if (info.loop) loops.push({ ...info.loop, pan: 0 });
    for (const p of scene.props) {
      if (p.kind === "rain") loops.push({ sfx: "rain", volume: 0.35, pan: 0 });
      if (p.kind === "snow") loops.push({ sfx: "wind", volume: 0.22, pan: 0 });
    }
    if (drives(scene)) {
      const car = scene.props.find((p) => p.kind === "car" || p.kind === "truck");
      loops.push({ sfx: "engine", volume: 0.3, pan: car ? Math.round(clamp((car.x - 0.5) * 1.6, -1, 1) * 100) / 100 : 0 });
    }
    for (const l of loops) {
      if (have.has(l.sfx)) continue;
      have.add(l.sfx);
      out.push({ at: round3(start), kind: "sfx", id: l.sfx, volume: l.volume, dur: round3(end - start), pan: l.pan });
    }
  });
  return out.sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === "sfx" ? -1 : 1) || a.id.localeCompare(b.id));
}
