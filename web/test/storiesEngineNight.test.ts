// Night drive's goldens (docs/CONTRACTS.md §45.45): the night fixture (engine/fixtures/night-drive.json, our own
// sample characters only) drawn in each of its shots. Four frames at 1080 × 1920 are pinned prim by prim (the whole
// scene, Driver's eyes, Face up close and Mirror; the agent's pytest rasterizes these same four through raster.py), and
// the middle frame of every shot span in every scene is pinned by the sha256 of its draw list in all six sizes. A change
// to what a night frame draws must bump ENGINE_VERSION (engine/README.md) and write this file again
// (STORIES_GOLDENS=write), as the Bright golden in storiesEngineShapes.test.ts does.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { drawFrame, ENGINE_VERSION, FORMATS, normalizeScript, sceneFrames, validateScript } from "../src/stories/engine/engine.ts";
import { shotAt } from "../src/stories/engine/shots.ts";
import type { Prim, ShotId, StoryScript, VideoFormat } from "../src/stories/engine/types.ts";

const ENGINE = join(import.meta.dirname, "../src/stories/engine");
const GOLDEN = join(import.meta.dirname, "fixtures", "stories-engine-night.json");
const raw = (): StoryScript => JSON.parse(readFileSync(join(ENGINE, "fixtures", "night-drive.json"), "utf8")) as StoryScript;

function valid(s: unknown): StoryScript {
  const r = validateScript(s);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return normalizeScript(r.script);
}

const sized = (f: Pick<VideoFormat, "width" | "height">): StoryScript => valid({ ...raw(), engine: ENGINE_VERSION, width: f.width, height: f.height });

/** The middle frame of every shot span of every scene: "<sceneId> <shot>" → frame number. */
function spans(s: StoryScript): Record<string, number> {
  const out: Record<string, number> = {};
  for (const sc of s.scenes) {
    const [from] = sceneFrames(s, sc.sceneId);
    const starts = [0, ...(sc.cuts ?? []).map((c) => c.at)];
    for (const at of starts) {
      const span = shotAt(sc, at);
      out[`${sc.sceneId} ${span.cue.shot}`] = from + Math.floor(((span.from + span.until) / 2) * s.fps);
    }
  }
  return out;
}

const sha = (prims: Prim[]): string => createHash("sha256").update(JSON.stringify(prims)).digest("hex");
/** The four frames pinned prim by prim, from the first scene (the highway at night, which cuts through every shot). */
const FULL: ShotId[] = ["scene", "driver_view", "face", "mirror"];

interface NightGolden {
  engine: number;
  frames: Record<string, number>;
  full: Record<string, Prim[]>;
  sha: Record<string, Record<string, string>>;
}

describe("night drive's goldens", () => {
  it("the night fixture is valid in every size, draws in night drive and cuts through every shot", () => {
    const tall = sized(FORMATS[0]!);
    expect(tall.art).toBe("night_drive");
    const shots = new Set(Object.keys(spans(tall)).map((k) => k.split(" ")[1]));
    expect([...shots].sort()).toEqual(["driver_view", "face", "mirror", "pedals", "road_behind", "road_wide", "scene", "side_window", "speed_dial"]);
    for (const f of FORMATS) expect(() => sized(f), f.resolution).not.toThrow();
  });

  it("night drive frames are exactly what this engine drew", () => {
    const tall = sized(FORMATS[0]!);
    const frames = spans(tall);
    const full = Object.fromEntries(FULL.map((shot) => [shot, drawFrame(tall, frames[`s1 ${shot}`]!)]));
    const shas = Object.fromEntries(
      FORMATS.map((f) => {
        const s = sized(f);
        return [f.resolution, Object.fromEntries(Object.entries(frames).map(([key, fr]) => [key, sha(drawFrame(s, fr))]))];
      }),
    );
    if (process.env.STORIES_GOLDENS === "write") writeFileSync(GOLDEN, JSON.stringify({ engine: ENGINE_VERSION, frames, full, sha: shas } satisfies NightGolden) + "\n");
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as NightGolden;
    expect(golden.engine, "the drawing changed with ENGINE_VERSION: write the goldens again").toBe(ENGINE_VERSION);
    expect(frames).toEqual(golden.frames);
    for (const shot of FULL) {
      const want = golden.full[shot]!;
      const got = full[shot]!;
      expect(got.length, shot).toBe(want.length);
      const bad = want.findIndex((p, i) => JSON.stringify(p) !== JSON.stringify(got[i]));
      expect(bad, `${shot}: prim ${bad} changed; bump ENGINE_VERSION and write the goldens again`).toBe(-1);
    }
    for (const f of FORMATS) expect(shas[f.resolution], `${f.resolution}: a night frame changed; bump ENGINE_VERSION and write the goldens again`).toEqual(golden.sha[f.resolution]);
  });

  it("the same script draws the same night frames every time (no clock, no Math.random)", () => {
    const a = sized(FORMATS[0]!);
    const b = sized(FORMATS[0]!);
    for (const fr of Object.values(spans(a))) expect(sha(drawFrame(a, fr))).toBe(sha(drawFrame(b, fr)));
  });
});
