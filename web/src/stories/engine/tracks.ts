// Lamo Stories engine: the text track (captions, bubble symbols, the safety end card) and the audio track (every
// effect of the scenes' lists and every character noise at its absolute time). The text layout is text.ts; each
// shape has its own places, and the track is in output pixels of the script's size.

import { BED_ID, bedPan } from "./ambience.ts";
import { BUBBLE_SYMBOL, symbolSpan } from "./bubbles.ts";
import { F, inFrame } from "./frame.ts";
import { clamp } from "./math.ts";
import { actorPath, boardingAt, boardingOf, STYLES } from "./motion.ts";
import { prepare } from "./scene.ts";
import { endCardFrom, endCardLayout, fitText, textBoxes } from "./text.ts";
import type { AudioEvent, Beat, Scene, SfxId, StoryScript, TextEvent } from "./types.ts";

export { CAPTION, ENDCARD, endCardLines, endCardText, fitText, HEADER, shortPublisher, TEXT_BOXES, textWidth, wrapText } from "./text.ts";

const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Captions, bubble symbols and the safety end card, placed for the script's shape, in its output pixels. */
export function textTrack(s: StoryScript): TextEvent[] {
  return inFrame(s, () => {
    const k = F.k;
    // design px to output px (the 720 sizes are the 1080 ones scaled down)
    const out = k === 1 ? (v: number) => v : (v: number) => Math.round(v * k * 10) / 10;
    return textTrackNow(s).map((e) => (k === 1 ? e : { ...e, x: out(e.x), y: out(e.y), size: out(e.size) }));
  });
}

function textTrackNow(s: StoryScript): TextEvent[] {
  const { caption: CAPTION, header: HEADER, endcard: ENDCARD } = textBoxes();
  const prep = prepare(s);
  const total = prep.total;
  const out: TextEvent[] = [];
  const lastAt = prep.starts[s.scenes.length - 1] ?? 0;
  const cardAt = lastAt + endCardFrom(total - lastAt);
  if (s.captionsOn) {
    for (const c of s.captions ?? []) {
      if (!c.text?.trim() || c.at >= total) continue;
      const { lines, size } = fitText(c.text, CAPTION.sizes, CAPTION.maxW, CAPTION.maxLines);
      out.push({ start: round3(c.at), end: round3(Math.min(total, c.at + c.dur)), kind: "caption", text: lines.join("\n"), x: CAPTION.x, y: CAPTION.y, size, color: CAPTION.color });
    }
    s.scenes.forEach((sc, i) => {
      if (!sc.caption?.trim()) return;
      const start = prep.starts[i]!;
      const end = start + sc.durationSec;
      const dup = (s.captions ?? []).some((c) => norm(c.text) === norm(sc.caption!) && c.at < end && c.at + c.dur > start);
      if (dup) return;
      const { lines, size } = fitText(sc.caption, HEADER.sizes, HEADER.maxW, HEADER.maxLines);
      // a safety story's end card takes the top of the frame for its last seconds
      const stop = s.safety ? Math.min(end - 0.05, cardAt) : end - 0.05;
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
    const { lines, size } = endCardLayout((s.safety.citations ?? []).map((c) => c.publisher), ENDCARD);
    out.push({ start: round3(cardAt), end: round3(total), kind: "endcard", text: lines.join("\n"), x: ENDCARD.x, y: ENDCARD.y, size, color: ENDCARD.color });
  }
  return out.sort((a, b) => a.start - b.start || order(a.kind) - order(b.kind));
}

function order(k: TextEvent["kind"]): number {
  return k === "caption" ? 0 : k === "bubble" ? 1 : 2;
}

/** The same as AudioEvent, whose `voice` (CONTRACTS §45.34) now carries the character's voice style on its noises;
 * kept as a name for older imports. */
export type VoicedAudioEvent = AudioEvent;

const LOOPS: Set<SfxId> = new Set(["engine", "wind", "rain"]);
const REPEATS: Set<SfxId> = new Set(["footsteps", "heartbeat", "tick", "snow_crunch"]);

/** -1 (left) .. 1 (right) from where the sound's maker stands: a rider from its car, one still outside it (before
 * getting in, or after getting out, §45.42) from where it walks. */
function panOf(s: StoryScript, scene: Scene, who: string | undefined, at: number): number {
  if (!who) return 0;
  const actor = scene.actors.find((a) => a.castId === who);
  let x = 0.5;
  if (actor) {
    const beats = scene.beats.filter((b) => b.who === who).sort((a, b) => a.at - b.at);
    const car = actor.inCar ? scene.props.find((p) => p.propId === actor.inCar) : undefined;
    if (car && boardingAt(boardingOf(beats), at).seat >= 0.5) x = car.x;
    else {
      const member = s.cast[who];
      const style = STYLES[member?.movementStyle ?? "bouncy"] ?? STYLES.bouncy;
      const { inCar: _, ...outside } = actor;
      x = actorPath(car ? outside : actor, beats, style, at).x;
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

/** Every effect of the scenes' lists (and, in a script not normalized yet, on its beats) and every character noise,
 * at absolute times. Nothing else: the place's ambience is in the lists (normalizeScript puts it there), so what the
 * owner removes in Review is gone from the sound too. A noise carries its character's voice style ("babble" or
 * "hum"); a character with no voice makes none. */
export function audioTrack(s: StoryScript): AudioEvent[] {
  return inFrame(s, () => audioTrackNow(s));
}

function audioTrackNow(s: StoryScript): AudioEvent[] {
  const prep = prepare(s);
  const out: AudioEvent[] = [];
  s.scenes.forEach((scene, i) => {
    const start = prep.starts[i]!;
    const sfxEvent = (at: number, id: SfxId, volume: number, pan: number, beatDur: number | undefined) => {
      const ev: AudioEvent = { at: round3(start + at), kind: "sfx", id, volume: clamp(volume, 0, 1), pan };
      if (LOOPS.has(id)) ev.dur = round3(Math.max(0.1, scene.durationSec - at));
      else if (REPEATS.has(id) && beatDur) ev.dur = round3(Math.min(beatDur, scene.durationSec - at));
      out.push(ev);
    };
    for (const b of scene.beats) {
      if (b.noise && b.who in s.cast) {
        const voice = s.cast[b.who]!.voice;
        if (voice?.style !== "none") {
          out.push({ at: round3(start + b.at), kind: "noise", id: b.noise, volume: 0.9, pitch: clamp(voice?.pitch ?? 1, 0.5, 2), pan: panOf(s, scene, b.who, b.at), voice: voice?.style === "hum" ? "hum" : "babble" });
        }
      }
      // a script that is not normalized yet still has its effects on the beats
      if (b.sfx) sfxEvent(b.at, b.sfx, 0.8, panOf(s, scene, b.who, b.at), b.dur);
    }
    for (const c of scene.sfx ?? []) {
      if (BED_ID.test(c.id)) {
        sfxEvent(c.at, c.sfx, c.volume, bedPan(scene, c.sfx), undefined);
        continue;
      }
      const beat = matchBeat(scene, c.at, c.sfx);
      sfxEvent(c.at, c.sfx, c.volume, panOf(s, scene, beat?.who, c.at), beat?.dur);
    }
  });
  return out.sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === "sfx" ? -1 : 1) || a.id.localeCompare(b.id));
}
