// The areas the CR editor warns about (docs/CONTRACTS.md §53 C3) are the renderer's own: this reads agent/.../render.py
// and overlay.py and fails when a number in lib/overlayAreas.ts drifts from them. Then the geometry: the boxes, the
// overlap rule, the corner presets and the one short warning line.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  areasOf,
  CAMPAIGN_FACECAM_TOP,
  CAPTION_AREA,
  CORNERS,
  cornerCentre,
  FACECAM_AREA,
  FACECAM_H,
  FRAME_H,
  FRAME_W,
  keepInside,
  logoBox,
  ON_FACECAM,
  overlapWarning,
  overlaps,
  SAFE_AREA,
  TEXT_CHAR_W,
  TEXT_EDGE,
  TEXT_PX,
  textBox,
  textPx,
  UNDER_CAPTIONS,
} from "../src/lib/overlayAreas.ts";

const AGENT = join(import.meta.dirname, "..", "..", "agent", "src", "clipfactory_agent");
const render = readFileSync(join(AGENT, "render.py"), "utf8");
const overlay = readFileSync(join(AGENT, "overlay.py"), "utf8");
const int = (re: RegExp, text = render) => {
  const m = re.exec(text);
  if (!m) throw new Error(`not found in the agent: ${re}`);
  return m.slice(1).map(Number);
};

describe("the web copy of the renderer's areas", () => {
  const [W, H] = int(/^W, H = (\d+), (\d+)/m);
  const [band] = int(/^BAND = (\d+)/m);
  const [camH] = int(/^CAM_H = (\d+)/m);
  const [campaignBand] = int(/^CAMPAIGN_BAND = (\d+)/m);
  const [safeLeft] = int(/^SAFE = \((\d+), round\(H \* 0\.10\), round\(W \* 0\.85\), round\(H \* 0\.75\)\)/m);
  const safe = [safeLeft!, Math.round(H! * 0.1), Math.round(W! * 0.85), Math.round(H! * 0.75)];
  const [capBottomGap] = int(/^CAP_BOTTOM = SAFE\[3\] - (\d+)/m);
  const capBottom = safe[3]! - capBottomGap!;
  const [lineH, lines] = int(/^CAPTION_LINE_H, CAPTION_LINES = (\d+), (\d+)/m);
  const [rightGap] = int(/^TEXT_MARGIN_L, TEXT_MARGIN_R = SAFE\[0\], W - SAFE\[2\] \+ (\d+)/m);

  it("the frame and the safe area", () => {
    expect([FRAME_W, FRAME_H]).toEqual([W, H]);
    expect([...SAFE_AREA]).toEqual(safe);
  });
  it("the captions' band stands on CAP_BOTTOM and grows up by its lines", () => {
    expect([...CAPTION_AREA]).toEqual([safe[0], capBottom - lines! * lineH!, W! - (W! - safe[2]! + rightGap!), capBottom]);
  });
  it("the facecam of a facecam_top clip, and the lower one of a campaign clip", () => {
    expect([...FACECAM_AREA]).toEqual([0, band, W, band! + camH!]);
    expect(FACECAM_H).toBe(camH);
    expect(CAMPAIGN_FACECAM_TOP).toBe(campaignBand);
  });
  it("the text sizes, a letter's width and the line's edge are the overlay's", () => {
    const sizes = /TEXT_SIZES = \{"s": (\d+), "m": (\d+), "l": (\d+)\}/.exec(overlay);
    expect(sizes && [TEXT_PX.s, TEXT_PX.m, TEXT_PX.l]).toEqual(sizes?.slice(1).map(Number));
    expect(TEXT_CHAR_W).toBe(Number(/^CHAR_WIDTH = ([\d.]+)/m.exec(overlay)?.[1]));
    expect(TEXT_EDGE).toBe(Number(/^EDGE = ([\d.]+)/m.exec(overlay)?.[1]));
    expect(overlay).toMatch(/SIZE_MIN, SIZE_MAX, SIZE_DEFAULT = 0\.08, 0\.50, 0\.22/);
    expect(overlay).toMatch(/MAX_TEXT = 80/);
  });
});

describe("boxes", () => {
  it("a logo is size wide and as tall as its own shape", () => {
    const sq = logoBox(0.5, 0.5, 0.22, 100, 100);
    expect(sq.w).toBeCloseTo(0.22);
    expect(sq.h).toBeCloseTo((0.22 * 1080) / 1920);
    const wide = logoBox(0.5, 0.5, 0.3, 300, 100);
    expect(wide.h).toBeCloseTo((0.3 * 1080) / 3 / 1920);
  });
  it("text: one line as wide as its words; a long line gets a smaller font, never a second line", () => {
    const short = textBox(0.5, 0.5, "#Valor", "m");
    expect(short.w).toBeCloseTo((6 * 0.6 * 68) / 1080);
    expect(short.h).toBeCloseTo((68 * 1.4) / 1920);
    const long = "x".repeat(80);
    expect(textPx(long, "l")).toBeLessThan(TEXT_PX.l);
    expect(textBox(0.5, 0.5, long, "l").w).toBeCloseTo(0.97);
    expect(textBox(0.5, 0.5, long, "l").h).toBeLessThan((TEXT_PX.l * 1.4) / 1920);
  });
  it("keepInside moves a centre so the whole box stays in the frame", () => {
    expect(keepInside(0.01, 0.99, 0.2, 0.1)).toEqual({ x: 0.1, y: 0.95 });
    expect(keepInside(0.5, 0.5, 0.2, 0.1)).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe("the overlap rule and the one warning line", () => {
  const at = (x: number, y: number, w = 0.2, h = 0.1) => ({ x, y, w, h });
  it("touching edges do not overlap, a shared piece does", () => {
    expect(overlaps(at(0.2, 0.2), at(0.4, 0.2))).toBe(false);
    expect(overlaps(at(0.2, 0.2), at(0.39, 0.2))).toBe(true);
    expect(overlaps(at(0.2, 0.2), at(0.2, 0.9))).toBe(false);
  });
  it("Under the captions on any clip; On the facecam only on a facecam_top clip", () => {
    const captions = at(0.4, 0.65);
    expect(overlapWarning(captions, "blur_fill")).toBe(UNDER_CAPTIONS);
    expect(overlapWarning(captions, "facecam_top")).toBe(UNDER_CAPTIONS);
    const cam = at(0.5, 0.35);
    expect(overlapWarning(cam, "facecam_top")).toBe(ON_FACECAM);
    expect(overlapWarning(cam, "blur_fill")).toBeNull();
  });
  it("the hook band above the facecam and the gameplay below it are not warned about", () => {
    expect(overlapWarning(at(0.5, 0.12), "facecam_top")).toBeNull();
    expect(overlapWarning(at(0.5, 0.9), "facecam_top")).toBeNull();
  });
  it("a campaign clip's facecam starts lower", () => {
    const strip = at(0.5, 430 / FRAME_H, 0.3, 40 / FRAME_H);
    expect(overlapWarning(strip, "facecam_top", false)).toBe(ON_FACECAM);
    expect(overlapWarning(strip, "facecam_top", true)).toBeNull();
    expect(areasOf("facecam_top", true).facecam!.y - areasOf("facecam_top", true).facecam!.h / 2).toBeCloseTo(CAMPAIGN_FACECAM_TOP / FRAME_H);
  });
});

describe("the four corner presets sit in the safe area", () => {
  it("every corner keeps the box inside what the apps leave free", () => {
    const w = 0.22;
    const h = 0.12;
    for (const c of CORNERS) {
      const { x, y } = cornerCentre(c, w, h);
      expect(x - w / 2).toBeGreaterThanOrEqual(SAFE_AREA[0] / FRAME_W - 1e-9);
      expect(x + w / 2).toBeLessThanOrEqual(SAFE_AREA[2] / FRAME_W + 1e-9);
      expect(y - h / 2).toBeGreaterThanOrEqual(SAFE_AREA[1] / FRAME_H - 1e-9);
      expect(y + h / 2).toBeLessThanOrEqual(SAFE_AREA[3] / FRAME_H + 1e-9);
    }
  });
  it("left corners are left of right corners, top above bottom", () => {
    const tl = cornerCentre("tl", 0.2, 0.1);
    const br = cornerCentre("br", 0.2, 0.1);
    expect(tl.x).toBeLessThan(br.x);
    expect(tl.y).toBeLessThan(br.y);
  });
});
