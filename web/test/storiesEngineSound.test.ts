// The Lamo Stories engine's sound (CONTRACTS §45.6 SceneEdit.sfx, §45.10 audioTrack, §45.16.6): every effect the
// video plays is in a scene's effects list, so the owner can see, move and remove it in Review; the place's wind,
// rain, traffic and a driving car's engine are written into new scenes' lists by normalizeScript and never come back
// once removed. A character's voice style shows in the sound (a "hum" noise) and in the frames (closed lips).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { audioTrack, drawFrame, LIMITS, normalizeScript, validateScript } from "../src/stories/engine/engine.ts";
import type { VoicedAudioEvent } from "../src/stories/engine/tracks.ts";
import type { CastMember, Prim, Scene, StoryScript } from "../src/stories/engine/types.ts";

const ENGINE = join(import.meta.dirname, "../src/stories/engine");
const raw = (name: string): StoryScript => JSON.parse(readFileSync(join(ENGINE, "fixtures", name), "utf8")) as StoryScript;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function valid(s: unknown): StoryScript {
  const r = validateScript(s);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.script;
}

const ice = () => normalizeScript(valid(raw("ice-skid.json")));
const sfxEvents = (s: StoryScript) => audioTrack(s).filter((e) => e.kind === "sfx");

describe("every effect is in a scene's list", () => {
  it("a scene with an empty effects list has no effects in the sound", () => {
    const s = ice();
    for (const sc of s.scenes) sc.sfx = [];
    expect(sfxEvents(s)).toEqual([]);
    // the noises stay
    expect(audioTrack(s).some((e) => e.kind === "noise")).toBe(true);
  });

  it("emptying one scene's list silences that scene only", () => {
    const s = ice();
    const i = s.scenes.findIndex((sc) => sc.sceneId === "s2");
    s.scenes[i]!.sfx = [];
    const start = s.scenes.slice(0, i).reduce((a, sc) => a + sc.durationSec, 0);
    const end = start + s.scenes[i]!.durationSec;
    const before = sfxEvents(ice());
    const after = sfxEvents(s);
    expect(before.some((e) => e.at >= start && e.at < end)).toBe(true);
    expect(after.some((e) => e.at >= start && e.at < end)).toBe(false);
    expect(after).toEqual(before.filter((e) => e.at < start || e.at >= end));
  });

  it("the sound plays exactly the lists: one effect per cue, nothing added", () => {
    const s = ice();
    const cues = s.scenes.reduce((a, sc) => a + sc.sfx.length, 0);
    expect(sfxEvents(s)).toHaveLength(cues);
  });

  it("new scenes get their place's sounds in the list, as {sceneId}.amb{k} at the start", () => {
    const s = ice();
    const byId = Object.fromEntries(s.scenes.map((sc) => [sc.sceneId, sc]));
    // s1 is a snowy road whose list already has wind: no second wind; its car is parked and empty: no engine
    expect(byId.s1!.sfx.filter((c) => c.sfx === "wind").map((c) => c.id)).toEqual(["s1.wind"]);
    expect(byId.s1!.sfx.some((c) => c.sfx === "engine")).toBe(false);
    // s3 is an icy road with two people driving: its wind and the engine hum are listed
    expect(byId.s3!.sfx.filter((c) => /\.amb\d+$/.test(c.id))).toEqual([
      { id: "s3.amb1", at: 0, sfx: "wind", volume: 0.18 },
      { id: "s3.amb2", at: 0, sfx: "engine", volume: 0.3 },
    ]);
    // s2's own engine effect (from a beat) is kept, and no ambient engine is added on top
    expect(byId.s2!.sfx.filter((c) => c.sfx === "engine").map((c) => c.id)).toEqual(["s2.fx1"]);
    // the studio has no place sound
    expect(byId.s9!.sfx.some((c) => /\.amb\d+$/.test(c.id))).toBe(false);
    // ambient loops last until their scene ends, from the scene's start
    let start = 0;
    for (const sc of s.scenes) {
      for (const c of sc.sfx.filter((x) => /\.amb\d+$/.test(x.id))) {
        const ev = audioTrack(s).find((e) => e.kind === "sfx" && e.id === c.sfx && Math.abs(e.at - (start + c.at)) < 0.001)!;
        expect(ev.dur, `${sc.sceneId} ${c.sfx}`).toBeCloseTo(sc.durationSec - c.at, 3);
      }
      start += sc.durationSec;
    }
  });

  it("an engine hum comes from the car, the place's sounds from everywhere", () => {
    const sc: Scene = {
      sceneId: "s1",
      title: "Drive",
      durationSec: 4,
      set: "icy_road",
      view: "side",
      camera: "wide",
      actors: [{ castId: "c1", x: 0.2, y: 0.74, facing: "right", inCar: "car1" }],
      props: [{ propId: "car1", kind: "car", x: 0.2, y: 0.74, scale: 1, rot: 0 }],
      beats: [{ at: 0, dur: 4, who: "c1", do: "drive" }],
      sfx: [],
      caption: null,
      note: null,
    };
    const s = normalizeScript(valid({ ...raw("ice-skid.json"), durationSec: 4, scenes: [sc], captions: [] }));
    expect(s.scenes[0]!.sfx.map((c) => [c.id, c.sfx])).toEqual([
      ["s1.amb1", "wind"],
      ["s1.amb2", "engine"],
    ]);
    const a = audioTrack(s);
    expect(a.find((e) => e.id === "engine")).toEqual({ at: 0, kind: "sfx", id: "engine", volume: 0.3, pan: -0.48, dur: 4 });
    expect(a.find((e) => e.id === "wind")).toEqual({ at: 0, kind: "sfx", id: "wind", volume: 0.18, pan: 0, dur: 4 });
  });

  it("a sound the owner removed in Review stays removed when the story is normalized again", () => {
    const once = ice();
    const edited = clone(once);
    // the owner removes every ambient sound (and so the engine hum and the wind)
    for (const sc of edited.scenes) sc.sfx = sc.sfx.filter((c) => !/\.amb\d+$/.test(c.id));
    const again = normalizeScript(valid(edited));
    expect(again).toEqual(edited);
    expect(again.scenes.flatMap((sc) => sc.sfx).some((c) => /\.amb\d+$/.test(c.id))).toBe(false);
    // and the scene the owner emptied stays empty
    edited.scenes[2]!.sfx = [];
    expect(normalizeScript(valid(edited)).scenes[2]!.sfx).toEqual([]);
  });

  it("a remade scene (new beats with effects, a new seed) gets its place's sounds; the others are left as they are", () => {
    const old = ice();
    for (const sc of old.scenes) sc.sfx = sc.sfx.filter((c) => !/\.amb\d+$/.test(c.id));
    const remade = clone(old);
    const fresh = clone(raw("ice-skid.json").scenes[2]!);
    remade.scenes[2] = { ...fresh, seed: 4242 };
    const n = normalizeScript(valid(remade));
    expect(n.scenes[2]!.seed).toBe(4242);
    expect(n.scenes[2]!.sfx.some((c) => c.id === "s3.amb1" && c.sfx === "wind")).toBe(true);
    for (const i of [0, 1, 3, 4, 5, 6, 7, 8]) expect(n.scenes[i]).toEqual(old.scenes[i]);
  });

  it("never fills a list past the limit", () => {
    const sc = clone(raw("ice-skid.json").scenes[2]!);
    sc.beats = sc.beats.map((b) => {
      const { sfx: _, ...rest } = b;
      return rest;
    });
    sc.sfx = Array.from({ length: LIMITS.sfx }, (_, k) => ({ id: `own${k}`, at: 0.1, sfx: "pop" as const, volume: 0.5 }));
    const s = normalizeScript(valid({ ...raw("ice-skid.json"), durationSec: sc.durationSec, scenes: [sc], captions: [] }));
    expect(s.scenes[0]!.sfx).toHaveLength(LIMITS.sfx);
    expect(validateScript(s).ok).toBe(true);
  });
});

describe("a character's voice style", () => {
  function talking(style: CastMember["voice"]["style"]): StoryScript {
    const c1 = clone(raw("ice-skid.json").cast.c1!);
    c1.voice = { ...c1.voice, style, pitch: 1.1 };
    const sc: Scene = {
      sceneId: "s1",
      title: "Talk",
      durationSec: 3,
      set: "studio",
      view: "side",
      camera: "close",
      actors: [{ castId: "c1", x: 0.5, y: 0.75, facing: "right" }],
      props: [],
      beats: [{ at: 0.5, dur: 1.5, who: "c1", do: "gesture", noise: "babble" }],
      sfx: [],
      caption: null,
      note: null,
    };
    return normalizeScript(valid({ ...raw("ice-skid.json"), cast: { c1 }, durationSec: 3, scenes: [sc], captions: [], safety: null }));
  }
  const MOUTH_DARK = "#4a1830";
  const openMouth = (prims: Prim[]) => prims.some((p) => (p.k === "poly" || p.k === "ellipse") && p.color === MOUTH_DARK);

  it("a noise carries the voice style, so the synth can hum or babble", () => {
    const hum = audioTrack(talking("hum")).filter((e) => e.kind === "noise") as VoicedAudioEvent[];
    const babble = audioTrack(talking("babble")).filter((e) => e.kind === "noise") as VoicedAudioEvent[];
    expect(hum).toEqual([{ at: 0.5, kind: "noise", id: "babble", volume: 0.9, pitch: 1.1, pan: 0, voice: "hum" }]);
    expect(babble).toEqual([{ ...hum[0]!, voice: "babble" }]);
    expect(audioTrack(talking("none")).filter((e) => e.kind === "noise")).toEqual([]);
  });

  it("a humming character keeps its lips closed while a babbling one opens its mouth", () => {
    const hum = talking("hum");
    const babble = talking("babble");
    let opened = 0;
    for (let f = 16; f < 45; f += 2) {
      expect(openMouth(drawFrame(hum, f)), `frame ${f}: hum mouth closed`).toBe(false);
      if (openMouth(drawFrame(babble, f))) opened += 1;
    }
    expect(opened).toBeGreaterThan(8);
    // and the hum moves: its frames are not all the same while it plays
    const moving = new Set([18, 20, 22, 24].map((f) => JSON.stringify(drawFrame(hum, f).filter((p) => p.k === "line"))));
    expect(moving.size).toBeGreaterThan(1);
  });
});
