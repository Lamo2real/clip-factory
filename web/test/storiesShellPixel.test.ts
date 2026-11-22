// The before/after pixel check (web/scripts/clips-unchanged.sh, docs/CONTRACTS.md §45.19, §45.35 D20): it leaves
// out only the antialiased edge pixels that two renders of the same text or curve shade a little differently
// (pixelmatch's test, includeAA false, threshold 0.1), and still fails on any change of layout or colour. The script
// runs the same file (web/scripts/pixeldiff.mjs) in its browser page.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pixelDiff } from "../scripts/pixeldiff.mjs";

const W = 24;
const H = 16;
type Rgb = [number, number, number];
const INK: Rgb = [20, 40, 30];
const BONE: Rgb = [239, 231, 218];

/** A picture: bone, with an ink block from x0 to x1 (exclusive) on every row, and `edge` shading the column at x1. */
function picture({ x0 = 6, x1 = 14, edge = null as Rgb | null, colour = INK } = {}): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const c = x >= x0 && x < x1 ? colour : x === x1 && edge ? edge : BONE;
      px.set([...c, 255], (y * W + x) * 4);
    }
  return px;
}

describe("the pixel check's comparison", () => {
  it("finds nothing between two identical pictures", () => {
    expect(pixelDiff(picture(), picture(), W, H)).toMatchObject({ diff: 0, aa: 0 });
  });

  it("leaves out an edge that is only shaded differently (antialiasing), and counts it apart", () => {
    // The same block; the soft column beside it is a little darker in one render, as font smoothing does.
    const a = picture({ edge: [150, 150, 140] });
    const b = picture({ edge: [110, 115, 105] });
    const r = pixelDiff(a, b, W, H);
    expect(r.diff).toBe(0);
    expect(r.aa).toBe(H);
    // Exactly compared (CF_EXACT=1), as the script did before, every one of them counts.
    expect(pixelDiff(a, b, W, H, { exact: true }).diff).toBe(H);
  });

  it("still fails when something moved (a layout change)", () => {
    const r = pixelDiff(picture(), picture({ x0: 8, x1: 16 }), W, H);
    expect(r.diff).toBeGreaterThanOrEqual(2 * H);
  });

  it("still fails when a colour changed", () => {
    const r = pixelDiff(picture(), picture({ colour: [200, 40, 30] }), W, H);
    expect(r.diff).toBe(8 * H);
  });

  it("leaves out the switcher's own box (masked), and nothing else", () => {
    const moved = picture({ x0: 8, x1: 16 });
    expect(pixelDiff(picture(), moved, W, H, { mask: [{ x: 0, y: 0, w: W, h: H }] }).diff).toBe(0);
    expect(pixelDiff(picture(), moved, W, H, { mask: [{ x: 0, y: 0, w: W, h: H / 2 }] }).diff).toBeGreaterThan(0);
  });

  it("leaves out only the pixels where the base changes when it is shot again (a line snapping 1 px), and counts them apart", () => {
    // The base's block, shot again, sits 1 px further right: the two columns that changed are the base's own motion.
    const base = picture();
    const again = picture({ x0: 7, x1: 15 });
    const ignore = pixelDiff(base, again, W, H).kinds;
    // The branch's shot snapped the same way: nothing of it is the branch's doing.
    expect(pixelDiff(base, again, W, H, { ignore })).toMatchObject({ diff: 0, moving: 2 * H });
    // A real change elsewhere (a colour in the block's middle) still counts, every pixel of it.
    const changed = picture({ x0: 7, x1: 15 });
    for (let y = 0; y < H; y++) changed.set([200, 40, 30, 255], (y * W + 10) * 4);
    expect(pixelDiff(base, changed, W, H, { ignore }).diff).toBe(H);
    // Without a second shot of the base nothing is left out.
    expect(pixelDiff(base, again, W, H).diff).toBe(2 * H);
  });

  it("is the comparison the script runs, with includeAA off and threshold 0.1, on every size the switcher has", () => {
    const script = readFileSync(join(import.meta.dirname, "..", "scripts", "clips-unchanged.sh"), "utf8");
    expect(script).toContain('export CF_PIXELDIFF="$here/scripts/pixeldiff.mjs"');
    expect(script).toContain("window.cfPixelDiff(da, db, W, H, { threshold, exact, mask, ignore })");
    // The base shot again in the same browser gives what moves by itself; each retry is a fresh browser, the other way round.
    expect(script).toContain("window.cfPixelDiff(da, read(ic).data, W, H, { threshold, exact, mask }).kinds");
    expect(script).toContain("const run = t === 0 ? browser : await chromium.launch();");
    expect(script).toContain("if (t % 2 === 0) {");
    expect(script).toContain('const THRESHOLD = EXACT ? 0 : Number(process.env.CF_THRESHOLD || 0.1);');
    // The folded sidebar of a short window (the slim toggle beside the fold button, §45.35 D19) is shot too.
    expect(script).toMatch(/"390x844,1000x560,1000x600,1000x650,1000x720,1440x900"/);
    // Still one machine, the merge base against this branch, and a failure exits 1.
    expect(script).toContain('|| status=1');
  });
});
