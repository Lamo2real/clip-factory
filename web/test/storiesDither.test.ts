// Night drive's seeded 1-level dither (docs/CONTRACTS.md §45.45.23, engine/README.md "Dither"): the sky's gradients and
// the vignette round each pixel's value up or down by a seeded threshold, the same in the preview (preview/draw.ts) as in
// the final video (the agent's raster.py). fixtures/stories-dither.json holds raster.py's thresholds and small pictures;
// the agent's test_stories_raster.py checks raster.py against the same file, so the two drawers agree bit for bit.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { drawFrame, ENGINE_VERSION, normalizeScript, validateScript } from "../src/stories/engine/engine.ts";
import { ditherSeed } from "../src/stories/engine/pen.ts";
import type { Prim, StoryScript } from "../src/stories/engine/types.ts";
import { ditherAt, glowBox, glowPixels, gradPixels } from "../src/stories/preview/draw.ts";

interface Case {
  name: string;
  width: number;
  height: number;
  prims: Prim[];
  rgb: string;
}
const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "stories-dither.json"), "utf8")) as { thresholds: [number, number, number, number][]; cases: Case[] };
const ENGINE = join(import.meta.dirname, "../src/stories/engine");

function valid(s: unknown): StoryScript {
  const r = validateScript(s);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return normalizeScript(r.script);
}

/** The case's prims the way drawPrims paints them on a canvas at scale 1, as RGB bytes. */
function paint(c: Case): Uint8Array {
  let px = new Uint8ClampedArray(c.width * c.height * 4);
  for (const p of c.prims) {
    if (p.k === "fill") {
      const rgb = [1, 3, 5].map((i) => parseInt(p.color.slice(i, i + 2), 16));
      for (let i = 0; i < c.width * c.height; i += 1) px.set([...rgb, 255], i * 4);
    } else if (p.k === "grad") px = gradPixels(p, c.width, c.height, 1);
    else if (p.k === "glow") {
      const box = glowBox(p, c.width, c.height, 1);
      if (!box) continue;
      const [bx, by, bw, bh] = box;
      const part = new Uint8ClampedArray(bw * bh * 4);
      for (let j = 0; j < bh; j += 1) part.set(px.subarray(((by + j) * c.width + bx) * 4, ((by + j) * c.width + bx + bw) * 4), j * bw * 4);
      glowPixels(p, part, bx, by, bw, c.width, c.height, 1);
      for (let j = 0; j < bh; j += 1) px.set(part.subarray(j * bw * 4, (j + 1) * bw * 4), ((by + j) * c.width + bx) * 4);
    } else throw new Error(`the dither cases use fill, grad and glow only, not ${p.k}`);
  }
  const out = new Uint8Array(c.width * c.height * 3);
  for (let i = 0; i < c.width * c.height; i += 1) out.set(px.subarray(i * 4, i * 4 + 3), i * 3);
  return out;
}

describe("night drive's dither", () => {
  it("has raster.py's thresholds, bit for bit", () => {
    for (const [x, y, seed, t] of FIXTURE.thresholds) expect(ditherAt(x, y, seed), `(${x}, ${y}) seed ${seed}`).toBe(t);
    for (let x = 0; x < 64; x += 1) {
      const t = ditherAt(x, 3, 7);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThan(1);
    }
  });

  it("paints raster.py's pictures, bit for bit: a sky fade, a slanted fade, a vignette corner and a turned glow", () => {
    expect(FIXTURE.cases.length).toBeGreaterThanOrEqual(4);
    for (const c of FIXTURE.cases) {
      const want = Buffer.from(c.rgb, "base64");
      const got = paint(c);
      const diff = got.findIndex((v, i) => v !== want[i]);
      expect(diff, `${c.name}: byte ${diff} is ${got[diff]}, raster.py has ${want[diff]}`).toBe(-1);
    }
  });

  it("keeps every pixel within one level of the true fade, and the sky shows no runs of one level", () => {
    const sky = FIXTURE.cases[0]!;
    const p = sky.prims[0] as Extract<Prim, { k: "grad" }>;
    const px = gradPixels(p, sky.width, sky.height, 1);
    const blue = p.stops.map(([o, c]) => [o, parseInt(c.slice(5, 7), 16)] as const);
    /** the fade's true blue at a row (a vertical gradient from y0 to y1, linear between its stops) */
    const trueBlue = (y: number): number => {
      const t = Math.min(1, Math.max(0, (y + 0.5 - p.y0) / (p.y1 - p.y0)));
      const j = Math.max(0, blue.findLastIndex(([o]) => o <= t));
      if (j >= blue.length - 1) return blue[blue.length - 1]![1];
      const [o0, v0] = blue[j]!;
      const [o1, v1] = blue[j + 1]!;
      return v0 + ((t - o0) / (o1 - o0)) * (v1 - v0);
    };
    let mixed = 0;
    for (let y = 0; y < sky.height; y += 1) {
      const v = trueBlue(y);
      const row = new Set<number>();
      for (let x = 0; x < sky.width; x += 1) {
        const got = px[(y * sky.width + x) * 4 + 2]!;
        // rounded down or up, never further: floor(v) or the level above it
        expect(got, `row ${y}: ${v.toFixed(3)}`).toBeGreaterThanOrEqual(Math.floor(v - 1e-4));
        expect(got, `row ${y}: ${v.toFixed(3)}`).toBeLessThanOrEqual(Math.floor(v + 1e-4) + 1);
        row.add(got);
      }
      if (row.size > 1) mixed += 1;
    }
    // a row between two levels mixes both, so the band's edge is broken up instead of a straight ring
    expect(mixed).toBeGreaterThan(sky.height / 2);
  });

  it("is on night drive's sky gradients and vignette, with the story's own seed, and nowhere in Bright", () => {
    const night = valid({ ...JSON.parse(readFileSync(join(ENGINE, "fixtures", "night-drive.json"), "utf8")), engine: ENGINE_VERSION });
    const seed = ditherSeed(night.seed);
    for (const f of [20, 200, 400]) {
      const prims = drawFrame(night, f);
      const grads = prims.filter((p) => p.k === "grad");
      expect(grads.length, `frame ${f}`).toBeGreaterThan(0);
      for (const g of grads) expect(g.dither, `frame ${f}`).toBe(seed);
      const dithered = prims.filter((p): p is Extract<Prim, { k: "glow" }> => p.k === "glow" && p.dither !== undefined);
      expect(dithered.length, `frame ${f}: the four corners of the vignette`).toBe(4);
      for (const g of dithered) expect(g.dither).toBe(seed);
    }
    const bright = valid({ ...JSON.parse(readFileSync(join(ENGINE, "fixtures", "sample-script.json"), "utf8")), engine: ENGINE_VERSION });
    for (const f of [20, 200]) expect(drawFrame(bright, f).filter((p) => "dither" in p)).toEqual([]);
  });
});
