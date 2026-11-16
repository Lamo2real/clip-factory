// The five smooth lines from the clip's preview to its five platform stacks (docs/CONTRACTS.md §16.8). The geometry
// comes from where the preview and the stacks really are (getBoundingClientRect), worked out again by a
// ResizeObserver whenever anything moves, so the lines always meet their stacks, at every width.
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Platform } from "../api/types.ts";

/** Chosen from the stage's own width (see layoutFor): five columns, two rows, or a trunk down the left with branches. */
export type LinesLayout = "fan" | "rows" | "trunk";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LineGeom {
  d: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
}

export interface Geometry {
  width: number;
  height: number;
  /** One per stack, in the order given. On phones these are the branches. */
  lines: LineGeom[];
  /** Phones only: the line from the preview down the left side. */
  trunk: LineGeom | null;
  /** Where every line starts (the preview's bottom centre). */
  origin: { x: number; y: number };
}

/** Distance from the left of the stage to the phone trunk. */
export const TRUNK_X = 20;
/** Branches meet a phone card this far below its top (level with the platform mark). */
export const BRANCH_Y = 28;
/** On phones the bend from the preview to the trunk takes at most this much height, so the trunk runs down the
 *  left of the total, chips and buttons under the video (they sit 44 px in) instead of behind them. */
export const TRUNK_BEND = 32;
/** Handle length of a branch's quarter curve. */
export const BRANCH_HANDLE = 16;

const n = (v: number) => Math.round(v * 10) / 10;

/** One cubic from (x0, y0) down to (x1, y1), with vertical handles at 55 % of the drop: a soft S. */
function sCurve(x0: number, y0: number, x1: number, y1: number): string {
  const dy = y1 - y0;
  return `M ${n(x0)} ${n(y0)} C ${n(x0)} ${n(y0 + 0.55 * dy)}, ${n(x1)} ${n(y1 - 0.55 * dy)}, ${n(x1)} ${n(y1)}`;
}

/**
 * The paths, in stage coordinates. `rects` are client rectangles (as getBoundingClientRect gives them); `stage` is
 * the box the SVG covers. Pure, so the tests can check each layout.
 */
export function paths(layout: LinesLayout, rects: { stage: Box; preview: Box; stacks: Box[] }): Geometry {
  const { stage, preview } = rects;
  const rel = (b: Box): Box => ({ left: b.left - stage.left, top: b.top - stage.top, width: b.width, height: b.height });
  const p = rel(preview);
  const stacks = rects.stacks.map(rel);
  const x0 = p.left + p.width / 2;
  const y0 = p.top + p.height;
  const origin = { x: n(x0), y: n(y0) };
  const geom = (d: string, x1: number, y1: number): LineGeom => ({ d, from: origin, to: { x: n(x1), y: n(y1) } });

  if (layout === "trunk") {
    const branchY = stacks.map((s) => s.top + BRANCH_Y);
    const first = stacks[0];
    // The bend from the preview to the left edge finishes right under the preview (and always above the first
    // card), so it never crosses a card or the hero's boxes.
    const bendEnd = first ? Math.max(y0 + 12, Math.min(y0 + TRUNK_BEND, first.top)) : y0 + TRUNK_BEND;
    const lastY = branchY.length ? Math.max(...branchY) - BRANCH_HANDLE : bendEnd;
    const h = bendEnd - y0;
    const trunkD =
      `M ${n(x0)} ${n(y0)} C ${n(x0)} ${n(y0 + 0.55 * h)}, ${TRUNK_X} ${n(bendEnd - 0.55 * h)}, ${TRUNK_X} ${n(bendEnd)}` +
      (lastY > bendEnd ? ` L ${TRUNK_X} ${n(lastY)}` : "");
    const trunk: LineGeom = { d: trunkD, from: origin, to: { x: TRUNK_X, y: n(Math.max(lastY, bendEnd)) } };
    const lines = stacks.map((s, i) => {
      const y = branchY[i]!;
      const x = s.left;
      const d = `M ${TRUNK_X} ${n(y - BRANCH_HANDLE)} C ${TRUNK_X} ${n(y)}, ${n(x - BRANCH_HANDLE)} ${n(y)}, ${n(x)} ${n(y)}`;
      return { d, from: { x: TRUNK_X, y: n(y - BRANCH_HANDLE) }, to: { x: n(x), y: n(y) } };
    });
    return { width: stage.width, height: stage.height, lines, trunk, origin };
  }

  if (layout === "rows") {
    // Row 1 holds the first three stacks; the last two sit in the gutters below and are reached by a curve that
    // ends above row 1, then a straight drop through the gutter.
    const row1Top = Math.min(...stacks.slice(0, 3).map((s) => s.top));
    const lines = stacks.map((s, i) => {
      const x1 = s.left + s.width / 2;
      const y1 = s.top;
      if (i < 3 || y1 <= row1Top + 1) return geom(sCurve(x0, y0, x1, y1), x1, y1);
      return geom(`${sCurve(x0, y0, x1, row1Top)} L ${n(x1)} ${n(y1)}`, x1, y1);
    });
    return { width: stage.width, height: stage.height, lines, trunk: null, origin };
  }

  const lines = stacks.map((s) => {
    const x1 = s.left + s.width / 2;
    return geom(sCurve(x0, y0, x1, s.top), x1, s.top);
  });
  return { width: stage.width, height: stage.height, lines, trunk: null, origin };
}

const box = (el: Element): Box => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
};

export function PerfLines({
  stage,
  preview,
  stacks,
  platforms,
  layout,
  best,
  animate,
}: {
  stage: RefObject<HTMLElement | null>;
  preview: RefObject<HTMLElement | null>;
  /** The outer (never transformed) element of each stack, in `platforms` order. */
  stacks: RefObject<(HTMLElement | null)[]>;
  platforms: readonly Platform[];
  layout: LinesLayout;
  best: Platform | null;
  /** Draw the lines in once (false when motion is reduced). */
  animate: boolean;
}) {
  const [geo, setGeo] = useState<Geometry | null>(null);
  const svg = useRef<SVGSVGElement>(null);

  useLayoutEffect(() => {
    // The page's own refs attach after this effect runs, so everything is looked up a frame later.
    let frame = 0;
    let ro: ResizeObserver | null = null;
    let watching = false;
    const root = () => stage.current ?? (svg.current?.parentElement as HTMLElement | null) ?? null;
    const run = () => {
      const r = root();
      const p = preview.current;
      const els = stacks.current ?? [];
      if (!r || !r.isConnected || !p || els.length < platforms.length || els.slice(0, platforms.length).some((e) => !e)) return;
      if (ro && !watching) {
        watching = true;
        ro.observe(r);
        ro.observe(p);
        for (const el of els) if (el) ro.observe(el);
      }
      const next = paths(layout, { stage: box(r), preview: box(p), stacks: els.slice(0, platforms.length).map((e) => box(e!)) });
      setGeo((old) => (old && JSON.stringify(old) === JSON.stringify(next) ? old : next));
    };
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(run);
    };
    if (typeof ResizeObserver !== "undefined") ro = new ResizeObserver(measure);
    measure();
    // Fonts arriving can move things without resizing anything we watch.
    void document.fonts?.ready.then(measure);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [stage, preview, stacks, platforms, layout]);

  if (!geo) return <svg ref={svg} className="perf-lines" aria-hidden="true" focusable="false" />;
  const bestAt = best ? platforms.indexOf(best) : -1;
  const trunkDelay = geo.trunk ? 1 : 0;
  return (
    <svg
      ref={svg}
      className={`perf-lines perf-lines--${layout}${animate ? " perf-lines--draw" : ""}`}
      aria-hidden="true"
      focusable="false"
      width={geo.width}
      height={geo.height}
      viewBox={`0 0 ${n(geo.width)} ${n(geo.height)}`}
      data-layout={layout}
    >
      {geo.trunk ? (
        <path className="perf-line perf-line--trunk" d={geo.trunk.d} pathLength={1} style={{ ["--i" as string]: 0 }} data-line="trunk" />
      ) : null}
      {geo.lines.map((l, i) => (
        <path
          key={platforms[i]}
          className={`perf-line${i === bestAt ? " is-best" : ""}`}
          d={l.d}
          pathLength={1}
          style={{ ["--i" as string]: i + trunkDelay }}
          data-line={platforms[i]}
        />
      ))}
      <circle className="perf-dot perf-dot--origin" cx={geo.origin.x} cy={geo.origin.y} r={3} />
      {geo.lines.map((l, i) => (
        <circle
          key={platforms[i]}
          className={`perf-dot${i === bestAt ? " is-best" : ""}`}
          cx={l.to.x}
          cy={l.to.y}
          r={3}
          style={{ ["--i" as string]: i + trunkDelay }}
          data-dot={platforms[i]}
        />
      ))}
    </svg>
  );
}
