import { describe, expect, it } from "vitest";
import { BRANCH_HANDLE, BRANCH_Y, TRUNK_BEND, TRUNK_X, paths, type Box } from "../src/components/PerfLines.tsx";
import { sparkPoints } from "../src/components/Sparkline.tsx";

const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, width, height });

/** Points along a path made of "M x y C … L x y" segments, sampled finely. */
function sample(d: string): { x: number; y: number }[] {
  const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
  const cmds = d.match(/[MCL]/g)!;
  const pts: { x: number; y: number }[] = [];
  let i = 0;
  let cur = { x: 0, y: 0 };
  for (const c of cmds) {
    if (c === "M") {
      cur = { x: nums[i++]!, y: nums[i++]! };
      pts.push(cur);
    } else if (c === "C") {
      const [x1, y1, x2, y2, x, y] = nums.slice(i, i + 6) as [number, number, number, number, number, number];
      i += 6;
      for (let s = 1; s <= 50; s++) {
        const t = s / 50;
        const u = 1 - t;
        pts.push({
          x: u * u * u * cur.x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x,
          y: u * u * u * cur.y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y,
        });
      }
      cur = { x, y };
    } else {
      const x = nums[i++]!;
      const y = nums[i++]!;
      for (let s = 1; s <= 50; s++) pts.push({ x: cur.x + ((x - cur.x) * s) / 50, y: cur.y + ((y - cur.y) * s) / 50 });
      cur = { x, y };
    }
  }
  return pts;
}

const inside = (p: { x: number; y: number }, b: Box) => p.x > b.left + 0.5 && p.x < b.left + b.width - 0.5 && p.y > b.top + 0.5 && p.y < b.top + b.height - 0.5;

describe("PerfLines.paths", () => {
  // Client rectangles offset by the stage position, as getBoundingClientRect gives them.
  const stage = box(300, 100, 1100, 1400);

  it("fan (≥ 1024 px): one soft curve from the video's bottom centre to each stack's top centre", () => {
    const preview = box(300 + 410, 100 + 40, 280, 498);
    const stacks = [0, 1, 2, 3, 4].map((i) => box(300 + i * 223.2, 100 + 650, 207.2, 400));
    const g = paths("fan", { stage, preview, stacks });
    expect(g.trunk).toBeNull();
    expect(g.origin).toEqual({ x: 550, y: 538 });
    expect(g.lines).toHaveLength(5);
    g.lines.forEach((l, i) => {
      expect(l.to.x).toBeCloseTo(i * 223.2 + 103.6, 1);
      expect(l.to.y).toBe(650);
      expect(l.d.startsWith("M 550 538 C 550 ")).toBe(true);
      const end = sample(l.d).at(-1)!;
      expect(Math.abs(end.x - l.to.x)).toBeLessThan(0.2);
      expect(Math.abs(end.y - 650)).toBeLessThan(0.2);
    });
    // Handles at 55 % of the drop: M x0 y0 C x0 (y0 + 0.55·dy), xi (yi − 0.55·dy), xi yi
    expect(g.lines[0]!.d).toBe("M 550 538 C 550 599.6, 103.6 588.4, 103.6 650");
  });

  it("rows (600–1023 px): the second-row lines never cross a first-row card", () => {
    // A 6-track grid: tracks 60 px, gaps 24 px. Row 1 spans 1–2, 3–4, 5–6; row 2 spans 2–3 and 4–5.
    const t = 60;
    const g = 24;
    const x = (track: number) => 300 + (track - 1) * (t + g);
    const w = 2 * t + g;
    const row1 = [box(x(1), 800, w, 500), box(x(3), 800, w, 380), box(x(5), 800, w, 620)];
    const row2 = [box(x(2), 1450, w, 300), box(x(4), 1450, w, 300)];
    const preview = box(300 + 121, 140, 240, 426);
    const geo = paths("rows", { stage, preview, stacks: [...row1, ...row2] });
    const rel = (b: Box) => box(b.left - stage.left, b.top - stage.top, b.width, b.height);
    for (const line of geo.lines.slice(3)) {
      expect(line.d).toContain(" L ");
      for (const p of sample(line.d)) for (const card of row1) expect(inside(p, rel(card))).toBe(false);
    }
    // Facebook and X land in the middle of the gutters between the row-1 cards.
    expect(geo.lines[3]!.to.x).toBeCloseTo(w + g / 2, 1);
    expect(geo.lines[4]!.to.x).toBeCloseTo(2 * w + g + g / 2, 1);
    // Each line ends at its stack's top centre.
    [...row1, ...row2].forEach((s, i) => {
      expect(geo.lines[i]!.to).toEqual({ x: Math.round((s.left - 300 + s.width / 2) * 10) / 10, y: s.top - 100 });
    });
  });

  it("trunk (< 600 px): a trunk down the left, and a quarter-curve branch into each card", () => {
    const preview = box(16 + 50, 100 + 300, 263, 467);
    const cards = [0, 1, 2, 3, 4].map((i) => box(300 + 44, 100 + 830 + i * 420, 314, 400));
    const g = paths("trunk", { stage, preview, stacks: cards });
    expect(g.trunk).not.toBeNull();
    expect(g.lines).toHaveLength(5);
    g.lines.forEach((l, i) => {
      const y = 830 + i * 420 + BRANCH_Y;
      expect(l.from).toEqual({ x: TRUNK_X, y: y - BRANCH_HANDLE });
      expect(l.to).toEqual({ x: 44, y });
      expect(l.d).toBe(`M ${TRUNK_X} ${y - BRANCH_HANDLE} C ${TRUNK_X} ${y}, ${44 - BRANCH_HANDLE} ${y}, 44 ${y}`);
    });
    // The trunk ends where the last branch leaves it, and its bend finishes above the first card.
    expect(g.trunk!.to).toEqual({ x: TRUNK_X, y: 830 + 4 * 420 + BRANCH_Y - BRANCH_HANDLE });
    for (const p of sample(g.trunk!.d)) if (p.x > TRUNK_X + 0.5) expect(p.y).toBeLessThanOrEqual(830 + 0.5);
    // The bend is done within TRUNK_BEND under the preview, so the trunk runs down the left of the hero's boxes.
    const y0 = 300 + 467;
    for (const p of sample(g.trunk!.d)) if (p.y > y0 + TRUNK_BEND + 0.5) expect(p.x).toBeCloseTo(TRUNK_X, 1);
  });
});

describe("sparkPoints", () => {
  it("scales time to x and views to y, and needs two points", () => {
    expect(sparkPoints([{ at: "2026-11-16T10:00:00Z", views: 5 }])).toBe("");
    const pts = sparkPoints([
      { at: "2026-11-16T10:00:00Z", views: 0 },
      { at: "2026-11-16T11:00:00Z", views: 50 },
      { at: "2026-11-16T12:00:00Z", views: 100 },
    ]);
    expect(pts).toBe("2,30 60,16 118,2");
  });
});
