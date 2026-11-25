// Clips Funded: the frozen presets (design-final section 1, point 7). A saved `{v:1}` look depends on `PRESET` and
// `PRESET_PARTS`: a change would redraw every stored vehicle. After this PR they change only under a new `v`.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CAR_DETAIL_V, PRESET, PRESET_PARTS } from "../src/stories/engine/carDetail.ts";

/** JSON with every object's keys sorted, so the hash does not depend on the order things were written in. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
const sha = (v: unknown): string => createHash("sha256").update(canon(v)).digest("hex");

const FROZEN = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "car-detail-presets.json"), "utf8")) as { v: number; preset: string; parts: string };

describe("the presets of detail v1 are frozen", () => {
  it("is still version 1", () => {
    expect(CAR_DETAIL_V).toBe(FROZEN.v);
  });
  it("PRESET is the frozen outline of each body", () => {
    expect(sha(PRESET), "PRESET changed: a stored look would redraw. Make a new `v` instead.").toBe(FROZEN.preset);
  });
  it("PRESET_PARTS is the frozen set of typical parts of each body", () => {
    expect(sha(PRESET_PARTS), "PRESET_PARTS changed: a stored look would redraw. Make a new `v` instead.").toBe(FROZEN.parts);
  });
});
