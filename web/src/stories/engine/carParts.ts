// Clips Funded engine: the detailed vehicle's parts in the side view, and the style they are drawn in (CONTRACTS §45.48
// section 3). `carSide2.ts` calls these groups in the draw order below; every group reads only the resolved look
// (`resolveDetail`) and the detailed shape (`sideShape`), draws in the pen's current frame (the body frame: facing +x,
// ground at y = 0, up is negative) and is safe on a motorbike, a plane or a boat (it then draws nothing, those use the
// classic shapes). Both art styles come from one set of functions through the palette object `Sty`: Bright uses `shade`
// and never calls `glow` or reads `F.light`; Night drive uses graded colours only (`S.t`), the amber marker, the lamp
// lenses `headCore` / `tailCore` / `brakeCore` and a constant 2.6 px outline.
//
// Draw order (the groups; prim counts in brackets, Bright):
//   shadow, skid marks, smoke                                          (carSide2)
//   bodyPaint     outline, paint, lower shade, two-tone, wells, dark trim group, flares, boards       [5-9]
//   stripes       the paint stripes                                                                    [0-3]
//   nightTop      Night drive's lit top line                                                           [0-1]
//   glassBack     targa bar, glass (all panes one shape), the seat backs of an open car                [1-3]
//   ... the riders (carSide2) ...
//   glassFront    door skin again, glass tint, glint (Night drive: two reflection bands), windscreen frame, soft top, glass roof   [2-8]
//   bodyLines     door lines, handles, crease, shoulder highlight, fuel cap                            [1-6]
//   sidePieces    side intake, rub strip, mirror                                                       [0-5]
//   nightEdge     Night drive: the amber marker and the rim light                                      [0-2]
//   nose, tail    bumpers, plates, grille, intake, fog lamps, bonnet vent                             [2-10]
//   lamps         the front lamp and its daytime light, the rear lamp (they return their centres)      [2-5]
//   tailPieces    spoiler, exhaust tips, finned diffuser                                               [0-6]
//   extras        roof rails, bull bar, spare wheel, antenna, fin, snorkel, light bar, flaps, ...      [0-14]
//   wheels        rear then front, in the ground frame                                                 [7-9 each]
//   glows, the face, effects                                                                           (carSide2)
//
// Level of detail is an alpha fade, never a hard level: a part's alpha is multiplied by smoothstep(lo, hi, size) where
// `size` is design px per vehicle unit (k * pen.unit() / F.k). ALWAYS: outline, wells, shade, glass, lamps, tyres and
// spokes, stripes, roofs, spoilers, bull bar and spare wheel. MEDIUM (.20 to .42): calipers, discs, lips, mirrors, side
// intakes, vents, exhaust tips, fins, bumpers, grille detail, running lights, flares, skirts, highlight. FINE (.42 to
// .70): door lines, crease, handles, fuel cap, antenna, rails, disc holes, rim shine, fog lamps, second reflection, seams.
// The pen drops a prim under alpha .004, so a faded-out part costs nothing.
//
// No marks: nothing here draws a logo, badge, emblem or lettering; plates are two plain rects.

import { cel, grade, ink as softInk, lift, lineUnits, ND, nightDrive } from "./art.ts";
import { GLASS, GLASS_ND, LENS_OFF, outlined, PLATE, TAIL_OFF, TYRE, TYRE_ND } from "./car.ts";
import type { Resolved } from "./carDetail.ts";
import { lampAt, roundPath, sweptCore, sweptLamp, type CP, type Side2 } from "./carShape.ts";
import { wheelPart } from "./carWheels.ts";
import { F } from "./frame.ts";
import { clamp, hex, lerp, mix, shade, smoothstep } from "./math.ts";
import { arcPts, clipConvex, joinShapes, type Pen } from "./pen.ts";
import type { CarLook, CarProfile } from "./types.ts";

export { wheelSide2 } from "./carWheels.ts";

type Pt = [number, number];

/** How a detailed vehicle's parts are painted: the night drive palette or Bright, line weights and colour helpers. */
export interface Sty {
  /** night drive */
  nd: boolean;
  /** 0..1: how much of a part shows at this size (a smoothstep between two sizes, so a zooming camera never pops a part in) */
  fade: (lo: number, hi: number) => number;
  /** the outline's width in the pen's units */
  ow: number;
  /** a fine line's width */
  fine: number;
  /** the outline colour */
  ink: string;
  /** a colour as it stands in the light (night drive: graded) or itself (Bright) */
  t(c: string): string;
  /** darker and lighter by k */
  dk(c: string, k: number): string;
  lt(c: string, k: number): string;
  tyre: string;
  /** 0..1.15: how glossy the finish is (matte .25, satin .55, gloss 1, metallic 1.15) */
  gloss: number;
}

const GLOSS: Record<Resolved["finish"], number> = { gloss: 1, metallic: 1.15, satin: 0.55, matte: 0.25 };

/**
 * The style of one detailed vehicle drawn at on-screen `size` (design px per vehicle unit: k * pen.unit() / F.k; the
 * editor's stage passes 2, everything on). Call it BEFORE `pen.scale(k, k)`: the widths it returns are in the units the
 * pen will have after that scale (Night drive's constant 2.6 px line is `lineUnits(pen, 2.6) / k`).
 */
export function styleOf(pen: Pen, k: number, car: CarLook, R: Resolved, size: number): Sty {
  const nd = nightDrive();
  const kk = k > 0 ? k : 1;
  const ow = nd ? lineUnits(pen, 2.6) / kk : 8;
  const outline = hex(car.outline, "#1c1842");
  return {
    nd,
    fade: (lo, hi) => smoothstep(lo, hi, size),
    ow,
    fine: nd ? Math.max(ow * 0.6, 1.1) : 3,
    ink: nd ? softInk(outline) : outline,
    t: (c) => (nd ? grade(c) : c),
    dk: (c, d) => (nd ? cel(c, d * 1.5) : shade(c, -d)),
    lt: (c, d) => (nd ? lift(c, d * 0.6) : shade(c, d)),
    tyre: nd ? TYRE_ND : TYRE,
    gloss: GLOSS[R.finish] ?? 1,
  };
}

// ---- the context every group reads -----------------------------------------------------------------------------------

/** The vehicle's lights at this moment: headlights on, tail lamps on (night), brake lights on. */
export interface LampState {
  lit: boolean;
  tailOn: boolean;
  braking: boolean;
  /** draw the front lamp (default true; false under a lamp eye or on a body with no front lamp) */
  front?: boolean;
  /** draw the rear lamp (default true) */
  rear?: boolean;
}

export interface PartCtx {
  pen: Pen;
  g: Side2;
  R: Resolved;
  S: Sty;
  car: CarLook;
  p: CarProfile;
  /** true when the shape has arches and landmarks (false: a motorbike, plane or boat, whose parts are not drawn here) */
  full: boolean;
  tall: number;
  len: number;
  hl: number;
  /** a length of `v` px at a 214 px tall vehicle, grown with the vehicle */
  u: number;
  /** the MEDIUM and FINE alpha multipliers (0..1) */
  med: number;
  fine: number;
  paint: string;
  accent: string;
  trim: string;
  chrome: string;
  dark: string;
  glass: { glass: string; tint: string; a: number };
}

const cp = (x: number, y: number, r = 0): CP => ({ x, y, r });
const rev = (pts: number[]): number[] => {
  const o: number[] = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) o.push(pts[i]!, pts[i + 1]!);
  return o;
};
const ring = (cx: number, cy: number, r1: number, r0: number, a0: number, a1: number, n = 16): number[] => [...arcPts(cx, cy, r1, r1, a0, a1, n), ...rev(arcPts(cx, cy, r0, r0, a0, a1, n))];

/** The context of one detailed vehicle: its colours as they stand in the light, its sizes and its two fade tiers. */
export function partCtx(pen: Pen, g: Side2, S: Sty): PartCtx {
  const R = g.R;
  const car = R.car;
  const full = g.arch.length >= 2 && g.pts.nose !== undefined && g.pts.cowl !== undefined;
  const gl = GLASS[car.windows] ?? GLASS.clear;
  return {
    pen,
    g,
    R,
    S,
    car,
    p: g.p,
    full,
    tall: g.tall,
    len: g.len,
    hl: g.hl,
    u: clamp(g.tall / 214, 0.6, 1.7),
    med: S.fade(0.2, 0.42),
    fine: S.fade(0.42, 0.7),
    paint: S.t(hex(car.paint, "#d8352a")),
    accent: S.t(hex(car.accent, "#f4f1ea")),
    trim: S.t(R.trim),
    chrome: S.t("#d9dde3"),
    dark: S.t("#17181d"),
    glass: { glass: S.nd ? grade(GLASS_ND[car.windows] ?? GLASS_ND.clear) : gl.glass, tint: S.nd ? grade(GLASS_ND[car.windows] ?? GLASS_ND.clear) : gl.tint, a: gl.a },
  };
}

/** Runs `fn` with the pen's alpha multiplied by `f` (a faded-out part is skipped, so it costs nothing). */
function tier(c: PartCtx, f: number, fn: () => void): void {
  if (f < 0.004) return;
  if (f >= 0.999) {
    fn();
    return;
  }
  c.pen.save();
  c.pen.fade(f);
  fn();
  c.pen.restore();
}

// ---- the silhouette's top, sampled -----------------------------------------------------------------------------------

/** The highest point of the outline at `x` (the smallest y where a vertical line crosses it), or null outside it. */
export function topAt(poly: number[], x: number): number | null {
  let best: number | null = null;
  const n = poly.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    const x0 = poly[i]!;
    const x1 = poly[j]!;
    if ((x0 <= x && x < x1) || (x1 <= x && x < x0)) {
      const y = lerp(poly[i + 1]!, poly[j + 1]!, (x - x0) / (x1 - x0));
      if (best === null || y < best) best = y;
    }
  }
  return best;
}

/** The lowest point of the outline at `x` (the largest y where a vertical line crosses it), or null outside it. */
function bottomAt(poly: number[], x: number): number | null {
  let best: number | null = null;
  const n = poly.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    const x0 = poly[i]!;
    const x1 = poly[j]!;
    if ((x0 <= x && x < x1) || (x1 <= x && x < x0)) {
      const y = lerp(poly[i + 1]!, poly[j + 1]!, (x - x0) / (x1 - x0));
      if (best === null || y > best) best = y;
    }
  }
  return best;
}

/** A band that follows the outline's top between x0 and x1 (x0 > x1 allowed): `inset` under it, `thick(t)` thick. */
function bandOnTop(sil: number[], xa: number, xb: number, inset: number, thick: (t: number) => number, n = 12): number[] {
  const up: number[] = [];
  const down: number[] = [];
  for (let i = 0; i <= n; i += 1) {
    const t = i / n;
    const x = lerp(xa, xb, t);
    const y = topAt(sil, x) ?? topAt(sil, x + (xb > xa ? -0.5 : 0.5)) ?? 0;
    up.push(x, y + inset);
    down.unshift(x, y + inset + thick(t));
  }
  return [...up, ...down];
}

/** The top chain of the outline, tip to tail, as a flat list. */
function topChain(sil: number[]): number[] {
  let k = 0;
  for (let i = 2; i < sil.length; i += 2) if (sil[i]! < sil[k]!) k = i;
  return sil.slice(0, k + 2);
}

// ---- body ------------------------------------------------------------------------------------------------------------

/** The crease's height (percent) and the level it sits at over the body: wedge rises to the rear. */
function creaseHeight(c: PartCtx): number {
  return Math.max(c.p.sillH + 14, c.p.beltH * 0.58);
}
function creaseY(c: PartCtx, x: number): number {
  const wedge = c.R.side.crease === "wedge" ? 6 : 0;
  const t = clamp((c.hl - x) / (2 * c.hl || 1), -0.3, 1.3);
  return c.g.y(creaseHeight(c) + wedge * lerp(-1, 0.6, t));
}

/** The body: outline, paint, the lower body in shade under the crease, two-tone and roof colour, the wheel wells, the dark
 * trim group (skirts, splitter, diffuser, cladding: ONE shape), flares and running boards. */
export function bodyPaint(c: PartCtx): void {
  const { pen, g, S, R, hl, paint, accent, p } = c;
  pen.poly(outlined(g.sil, S.ow), S.ink);
  pen.poly(g.sil, paint);
  if (!c.full) return;
  const lowerPoly = [-hl - 50, creaseY(c, -hl - 50), hl + 50, creaseY(c, hl + 50), hl + 50, 60, -hl - 50, 60];
  pen.poly(clipConvex(g.sil, lowerPoly), R.twoTone === "lower" ? S.dk(accent, 0.1) : S.dk(paint, 0.15));
  const belt = (x: number) => g.beltY(x) + 1;
  if (R.twoTone === "split") pen.poly(clipConvex(g.sil, [-hl - 50, -9999, hl + 50, -9999, hl + 50, belt(hl), -hl - 50, belt(-hl)]), accent);
  else if (R.twoTone === "bonnet") {
    const cx = g.pts.cowl![0];
    pen.poly(clipConvex(g.sil, [cx, -9999, hl + 50, -9999, hl + 50, g.y(lerp(p.tipH, p.noseH, 0.45)), cx, g.y(p.cowlH) + 2]), accent);
  } else if (!g.open && (R.twoTone === "roof" || R.roof.color !== null)) {
    const roofLine = g.y(Math.min(p.headH, p.roofH)) + g.roofT * 0.8;
    pen.poly(clipConvex(g.sil, [-hl - 50, -9999, hl + 50, -9999, hl + 50, roofLine, -hl - 50, roofLine]), R.roof.color !== null ? S.t(R.roof.color) : accent);
  }
  pen.poly(joinShapes(g.wells), S.nd ? mix(paint, ND.ao, 0.78) : mix(paint, "#0c0b10", 0.8));
  // skirts, splitter, diffuser and cladding: one dark trim shape
  const a0 = g.arch[0]!;
  const a1 = g.arch[1]!;
  const tall = c.tall;
  const dark: number[][] = [];
  const skirts = R.side.skirts;
  if (skirts === "lip" || skirts === "deep") {
    const h = skirts === "deep" ? 0.1 : 0.075; // a thick sill, not a thin edge
    const ys = g.y(p.sillH);
    dark.push([a0.x + a0.ra + 2, ys - tall * h, a1.x - a1.ra - 2, ys - tall * h, a1.x - a1.ra - 6, ys + 3, a0.x + a0.ra + 6, ys + 3]);
  }
  const xN = (q: number) => g.X(q);
  if (R.front.splitter === "lip") dark.push([xN(-0.5), g.y(p.chinH) - 2, a1.x + a1.ra + 4, g.y(p.chinH) - 3, a1.x + a1.ra + 4, g.y(p.chinH) + 4, xN(-0.3), g.y(p.chinH) + 4]);
  else if (R.front.splitter === "blade") dark.push([xN(-2.7), g.y(p.chinH) - 3 * c.u, xN(-1.0), g.y(p.chinH) - 2, a1.x + a1.ra + 4, g.y(p.chinH) - 3, a1.x + a1.ra + 4, g.y(p.chinH) + 7, xN(-2.2), g.y(p.chinH) + 7]);
  const yR = g.y(p.rumpH);
  if (R.rear.diffuser === "fins") dark.push([a0.x - a0.ra - 4, yR - tall * 0.05, xN(99.4), yR - tall * 0.07, xN(99), yR + 4, a0.x - a0.ra - 4, yR + 4]);
  else if (R.rear.diffuser === "deep") dark.push([a0.x - a0.ra - 4, yR - tall * 0.08, xN(99.6), yR - tall * 0.11, xN(99.2), yR + 5, a0.x - a0.ra - 4, yR + 5]);
  if (R.arches === "clad") for (const a of g.arch) dark.push(archRing(a, g.square, 9, 1));
  if (dark.length) pen.poly(joinShapes(dark), c.trim);
  if (R.arches === "flare") tier(c, c.med, () => g.arch.forEach((a) => pen.poly(archRing(a, g.square, 7, 1), S.dk(paint, 0.22))));
  if (skirts === "boards") tier(c, c.med, () => pen.rect(a0.x + a0.ra + 8, g.y(p.sillH) + 2, a1.x - a1.ra - a0.x - a0.ra - 16, 9 * c.u, 4, c.chrome));
}

/** A ring round an arch (the upper half, a little past the horizontal): flares and cladding. */
function archRing(a: { x: number; cy: number; ra: number }, square: boolean, out: number, inn: number): number[] {
  if (!square) return ring(a.x, a.cy, a.ra + out, a.ra - inn, 172, 368);
  const R = a.ra;
  const u = (r: number): number[] => [a.x - r, a.cy + 0.12 * r, a.x - r, a.cy - 0.25 * r, a.x - 0.62 * r, a.cy - r, a.x + 0.62 * r, a.cy - r, a.x + r, a.cy - 0.25 * r, a.x + r, a.cy + 0.12 * r];
  return [...u(R + out), ...rev(u(R - inn))];
}

/** The paint stripes: `centre` and `twin` over the bonnet, roof and deck (an open car skips the cockpit), `offset` a thin
 * one over the bonnet and deck, `side` along the flank, `sill` low along the sills, `pin` a hairline under the belt. */
export function stripes(c: PartCtx): void {
  const { pen, g, R, S, p, tall, len } = c;
  const st = R.stripe;
  if (!c.full || st.layout === "none") return;
  const sc = S.t(st.color);
  const w = clamp(st.width, 0, 100) / 100;
  const th = w * 0.055 * tall + 3;
  const inset = S.ow * 0.3;
  const nose = g.pts.nose![0];
  const cowl = g.pts.cowl![0];
  const lay = st.layout;
  if (lay === "centre" || lay === "twin" || lay === "offset") {
    const k = lay === "centre" ? 0.55 : lay === "twin" ? 0.4 : 0.4;
    const tail = g.pts.tail![0] + 0.004 * len;
    const deckStart = g.open ? g.X(p.roofX) - 0.012 * len : g.pts.roof![0];
    // the bonnet (an offset stripe sits to one side, so from here it is a thin band lower down)
    pen.poly(bandOnTop(g.sil, nose, cowl, inset + (lay === "offset" ? th * 0.45 : 0), () => th * k), sc);
    if (lay === "offset") pen.poly(bandOnTop(g.sil, deckStart, tail, inset + th * 0.45, () => th * k), sc);
    else if (g.open) pen.poly(bandOnTop(g.sil, deckStart, tail, inset, () => th * k), sc);
    else {
      pen.poly(bandOnTop(g.sil, g.pts.head![0] - 0.004 * len, g.pts.roof![0], inset, () => th * k), sc);
      pen.poly(bandOnTop(g.sil, g.pts.roof![0], tail, inset, () => th * k), sc);
    }
  } else if (lay === "side") {
    const a0 = g.arch[0]!;
    const a1 = g.arch[1]!;
    const y0 = g.y(lerp(p.sillH, p.beltH, 0.4));
    const hh = (0.02 + 0.07 * w) * tall;
    pen.poly(clipConvex(g.sil, [a0.x - a0.ra * 0.2, y0 - hh, a1.x + a1.ra * 0.2, y0 - hh, a1.x + a1.ra * 0.2, y0, a0.x - a0.ra * 0.2, y0]), sc);
  } else if (lay === "sill") {
    const a0 = g.arch[0]!;
    const a1 = g.arch[1]!;
    const y0 = g.y(p.sillH) - 2;
    pen.poly(clipConvex(g.sil, [a0.x + a0.ra * 0.3, y0 - 0.025 * tall - w * 0.03 * tall, a1.x - a1.ra * 0.3, y0 - 0.025 * tall - w * 0.03 * tall, a1.x - a1.ra * 0.3, y0, a0.x + a0.ra * 0.3, y0]), sc);
  } else if (lay === "pin") {
    const x1 = g.pts.cowl![0] - 0.02 * len;
    const x0 = g.arch[0]!.x - g.arch[0]!.ra * 0.6;
    pen.line([x1, g.beltY(x1) + 12, x0, g.beltY(x0) + 12], Math.max(2, th * 0.3), sc);
  }
}

/** Night drive's lit top line along the real outline (the roof, or the screen of an open car). Bright draws nothing. */
export function nightTop(c: PartCtx): void {
  const { pen, g, S, paint } = c;
  if (!S.nd || !c.full) return;
  const chain = topChain(g.sil);
  const pts: number[] = [];
  for (let i = 0; i < chain.length; i += 2) if (i > 2 && i < chain.length - 4) pts.push(chain[i]!, chain[i + 1]! + S.ow * 2);
  pen.line(pts, S.ow * 2.2, lift(paint, 0.16), 0.8);
}

// ---- glass -----------------------------------------------------------------------------------------------------------

/** The windscreen of an open car: dark, nearly black-blue glass. */
function deepGlass(c: PartCtx): string {
  return mix(c.glass.glass, "#0c1722", c.S.nd ? 0.8 : 0.86);
}

/** The targa bar and hoops behind the riders, the glass (all panes ONE shape) and an open car's seat backs. */
export function glassBack(c: PartCtx): void {
  const { pen, g, S, R, tall } = c;
  if (!c.full) return;
  if (R.roof.type === "targa" && R.roof.hoops === "none") {
    const x = g.X(c.p.roofX);
    pen.poly(roundPath([cp(x + 0.02 * c.len, g.y(c.p.beltH), 4), cp(x + 0.004 * c.len, g.y(c.p.roofH), 6), cp(x - 0.02 * c.len, g.y(c.p.roofH), 6), cp(x - 0.012 * c.len, g.y(c.p.beltH), 4)]), c.trim);
  }
  if (g.open && g.frame) pen.poly(g.frame, c.trim);
  if (g.panes.length) pen.poly(joinShapes(g.panes), g.open ? deepGlass(c) : c.glass.glass);
  if (g.open) {
    const seatC = S.t(R.cabin.seat ?? "#2a2a30");
    pen.poly(joinShapes(g.seats.map((s) => roundPath([cp(s.x - 30, s.beltY + 6, 6), cp(s.x - 36, s.beltY - 0.13 * tall, 9), cp(s.x - 12, s.beltY - 0.15 * tall, 9), cp(s.x - 6, s.beltY + 6, 6)]))), seatC);
  }
}

/** After the riders: the door skin painted again (only heads and shoulders show), the glass tint, the glint (Night drive:
 * two reflection bands on the front pane), the windscreen frame of an open car, a soft top, a glass roof. */
export function glassFront(c: PartCtx): void {
  const { pen, g, S, R, paint, tall, len } = c;
  if (!c.full) return;
  pen.poly(g.mask, paint);
  if (g.panes.length) {
    if (!g.open) pen.poly(joinShapes(g.panes), c.glass.tint, c.glass.a);
    const f = g.panes[0]!;
    let fx = -1e9;
    let fy = 0;
    for (let i = 0; i < f.length; i += 2) {
      if (f[i]! > fx) {
        fx = f[i]!;
        fy = f[i + 1]!;
      }
    }
    const s = tall / 214;
    if (S.nd && !g.open) {
      pen.poly(clipConvex([fx - 26 * s, fy - 60 * s, fx - 44 * s, fy - 60 * s, fx - 62 * s, fy + 4 * s, fx - 44 * s, fy + 4 * s], f), "#ffffff", 0.12);
      tier(c, c.fine, () => pen.poly(clipConvex([fx - 54 * s, fy - 60 * s, fx - 62 * s, fy - 60 * s, fx - 80 * s, fy + 4 * s, fx - 72 * s, fy + 4 * s], f), "#ffffff", 0.07));
    } else if (!g.open) pen.line([fx - 34 * s, fy - 0.17 * tall, fx - 22 * s, fy - 0.05 * tall], 6 * s, "#ffffff", R.car.windows === "clear" ? 0.55 : 0.3);
    else {
      // an open car's screen: dark and reflective, one pale streak down its slope
      const f0 = g.panes[0]!;
      pen.line([f0[0]! + (f0[2]! - f0[0]!) * 0.22, f0[1]! + (f0[3]! - f0[1]!) * 0.22, f0[0]! + (f0[2]! - f0[0]!) * 0.7, f0[1]! + (f0[3]! - f0[1]!) * 0.7], 3.4 * s, "#cfe6f2", S.nd ? 0.3 : 0.38);
    }
  }
  // a soft top: the area above the belt in the roof colour, one small pane, two seams
  if (R.roof.type === "soft_top") {
    const hx = g.pts.head![0] - 0.03 * len;
    const rx = -c.hl - 50;
    const top = clipConvex(g.sil, [hx, -9999, rx, -9999, rx, g.beltY(rx), hx, g.beltY(hx)]);
    const col = S.t(R.roof.color ?? "#2d2b2a");
    pen.poly(top, col);
    const last = g.panes[g.panes.length - 1];
    if (last !== undefined && last.length >= 6) {
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < last.length; i += 2) {
        cx += last[i]!;
        cy += last[i + 1]!;
      }
      cx /= last.length / 2;
      cy /= last.length / 2;
      pen.poly(
        last.map((v, i) => (i % 2 === 0 ? cx + (v - cx) * 0.62 : cy + (v - cy) * 0.55)),
        c.glass.glass,
      );
    }
    tier(c, c.fine, () => {
      const y0 = topAt(g.sil, g.hl - 0.45 * len) ?? 0;
      pen.line([hx - 0.02 * len, y0 + 3, hx - 0.03 * len, g.beltY(hx) - 2, hx - 0.06 * len, g.beltY(hx) - 2], S.fine, S.dk(col, 0.35), 0.8);
    });
  } else if (R.roof.type === "glass") {
    const x0 = g.pts.head![0] - 0.02 * len;
    const x1 = g.pts.roof![0] + 0.02 * len;
    pen.poly(bandOnTop(g.sil, x0, x1, S.ow * 0.4, () => 0.022 * tall), c.glass.tint, 0.7);
  } else if (R.roof.type === "sunroof") {
    const x0 = lerp(g.pts.head![0], g.pts.roof![0], 0.25);
    const x1 = lerp(g.pts.head![0], g.pts.roof![0], 0.65);
    tier(c, c.med, () => pen.poly(bandOnTop(g.sil, x0, x1, S.ow * 0.4, () => 0.018 * tall, 6), S.dk(paint, 0.55)));
  }
}

// ---- lines on the body -----------------------------------------------------------------------------------------------

/** Door shut lines, handles, the crease, the shoulder highlight and the fuel cap. */
export function bodyLines(c: PartCtx): void {
  const { pen, g, S, R, paint, tall, len, p } = c;
  if (!c.full) return;
  const a0 = g.arch[0]!;
  const a1 = g.arch[1]!;
  const gloss = S.gloss;
  const doors = clamp(Math.round(R.side.doors), 0, 3);
  const dx0 = Math.min(g.pts.cowl![0] - 0.01 * len, a1.x - a1.ra - 6);
  const dxEnd = g.open ? g.X(p.roofX) + 0.045 * len : g.X(doors <= 1 ? p.pillarX : lerp(p.pillarX, p.glassX, 0.75));
  const dx1 = Math.max(dxEnd, a0.x + a0.ra + 6);
  const ys = g.y(p.sillH + 3);
  if (doors > 0 && dx0 - dx1 > 24) {
    const xs: number[] = [];
    for (let i = 0; i <= doors; i += 1) xs.push(lerp(dx0, dx1, i / doors));
    tier(c, c.fine, () => {
      const dl: number[] = [xs[0]!, g.beltY(xs[0]!) + 2, xs[0]! - 4, ys];
      for (let i = 1; i < doors; i += 1) dl.push(xs[i]!, ys, xs[i]!, g.beltY(xs[i]!) + 2, xs[i]!, ys);
      dl.push(dx1 + 6, ys, dx1, g.beltY(dx1) + 2);
      pen.line(dl, S.fine, S.nd ? S.ink : S.dk(paint, 0.42), 0.85);
      if (R.side.handles !== "none") {
        const hy = g.y(lerp(p.sillH, p.beltH, 0.8));
        const hw = (R.side.handles === "flush" ? 0.022 : 0.035) * len;
        const hh = R.side.handles === "flush" ? 3.5 : 5;
        const hs: number[][] = [];
        for (let i = 0; i < doors; i += 1) {
          const x0 = xs[i + 1]! + 0.012 * len;
          hs.push([x0, hy, x0 + hw, hy, x0 + hw, hy + hh, x0, hy + hh]);
        }
        pen.poly(joinShapes(hs), R.side.handles === "chrome" ? c.chrome : S.dk(paint, 0.4));
      }
    });
  }
  tier(c, c.fine, () => {
    const cr = R.side.crease;
    if (cr === "none") return;
    const lite = S.lt(paint, 0.32);
    if (cr === "wedge") {
      // a sculpted door: a long swoosh from behind the front wheel, rising across the door to the side intake, a darker
      // surface under it and a lit edge on it
      const xs0 = g.X(p.cowlX + 9);
      const xs1 = Math.max(g.X(p.axR - 17), a0.x + a0.ra);
      const hLo = p.sillH + (p.beltH - p.sillH) * 0.42;
      const hHi = p.sillH + (p.beltH - p.sillH) * 0.9;
      const pts: number[] = [];
      for (let i = 0; i <= 8; i += 1) {
        const t = i / 8;
        const e = t * t * (3 - 2 * t) * 0.65 + t * 0.35;
        pts.push(lerp(xs0, xs1, t), g.y(lerp(hLo, hHi, e)));
      }
      const under: number[] = [];
      for (let i = 0; i <= 8; i += 1) under.push(pts[i * 2]!, pts[i * 2 + 1]! + (0.05 + 0.1 * Math.sin(Math.PI * (i / 8))) * tall);
      const band = [...pts];
      for (let i = 8; i >= 0; i -= 1) band.push(under[i * 2]!, under[i * 2 + 1]!);
      pen.poly(band, S.dk(paint, 0.22), 0.8);
      pen.line(pts, S.fine * 2, lite, 0.9 * gloss);
      // the fender crown over the front wheel and the haunch over the rear one: a lit swell just under the top line
      const crown = (xa: number, xb: number, drop: number): number[] => {
        const o: number[] = [];
        for (let i = 0; i <= 8; i += 1) {
          const x = lerp(xa, xb, i / 8);
          const ty = topAt(g.sil, x);
          if (ty !== null) o.push(x, ty + drop * (1 + 0.6 * Math.sin(Math.PI * (i / 8))));
        }
        return o;
      };
      const cF = crown(a1.x + a1.ra * 0.85, a1.x - a1.ra * 0.95, 0.035 * tall);
      const cR = crown(a0.x + a0.ra * 0.95, a0.x - a0.ra * 0.8, 0.03 * tall);
      for (const cr2 of [cF, cR]) if (cr2.length >= 8) pen.line(cr2, S.fine * 2.2, S.lt(paint, 0.2), 0.7 * gloss);
      return;
    }
    const xa = a1.x - a1.ra * 0.2;
    const xb = a0.x + a0.ra * 0.3;
    pen.line([xa, creaseY(c, xa) - 1, xb, creaseY(c, xb) - 1], S.fine * 0.9, lite, 0.7 * gloss);
    if (cr === "double") pen.line([xa, creaseY(c, xa) + 6 * c.u, xb, creaseY(c, xb) + 6 * c.u], S.fine * 0.7, lite, 0.5 * gloss);
  });
  if (g.open && R.roof.hoops !== "none") {
    // the engine cover's seam, under the deck's edge
    tier(c, c.fine, () => {
      const xa = g.X(p.roofX) - 0.045 * len;
      const xb = g.pts.tail![0] + 0.012 * len;
      const pts: number[] = [];
      for (let i = 0; i <= 8; i += 1) {
        const x = lerp(xa, xb, i / 8);
        pts.push(x, (topAt(g.sil, x) ?? g.y(p.deckH)) + 0.075 * tall);
      }
      pen.line(pts, S.fine * 0.8, S.dk(paint, 0.4), 0.7);
    });
  }
  tier(c, c.med, () => {
    const s0 = a1.x + a1.ra * 0.6;
    const s1 = a0.x - a0.ra * 0.4;
    pen.poly([s0, g.beltY(s0) + 7, s1, g.beltY(s1) + 7, s1 + 12, g.beltY(s1) + 7 + 0.045 * tall, s0 - 18, g.beltY(s0) + 7 + 0.045 * tall], "#ffffff", (S.nd ? 0.1 : 0.16) * (0.65 + 0.35 * gloss) * 1.25);
    if (R.finish === "metallic") pen.line([s0 - 8, g.beltY(s0) + 7 + 0.07 * tall, s1 + 6, g.beltY(s1) + 7 + 0.07 * tall], S.fine * 0.8, "#ffffff", S.nd ? 0.08 : 0.14);
  });
  if (R.side.fuelCap) {
    tier(c, c.fine, () => {
      const x = a0.x + a0.ra * 0.4;
      pen.circle(x, g.beltY(x) + 0.075 * tall, 0.02 * tall + 1, S.dk(paint, 0.35));
    });
  }
}

/** Side intake or vents (`intakeX` places them), the rub strip and the mirror. */
export function sidePieces(c: PartCtx): void {
  const { pen, g, S, R, tall, len, p, u } = c;
  if (!c.full) return;
  const a0 = g.arch[0]!;
  const a1 = g.arch[1]!;
  const vent = S.t("#17181d");
  const ix = g.X(R.side.intakeX);
  tier(c, c.med, () => {
    const it = R.side.intake;
    if (it === "scoop") {
      // a long dark blade on the rear shoulder: deep and low at its front end (the door's trailing edge), sweeping back and
      // up to a thin tip over the haunch, a lit lower lip and a few mesh slats inside it
      const xa = ix;
      const xb = Math.max(xa - 0.15 * len, a0.x + a0.ra * 0.1);
      const bh = p.beltH;
      const tipY = Math.max(g.y(bh + 8), (topAt(g.sil, xb) ?? g.y(100)) + 0.04 * tall);
      const fTop = g.y(bh + 1);
      const fBot = g.y(bh - 30);
      const mid = (t: number, hh: number): Pt => [lerp(xa, xb, t), lerp(hh, tipY, t)];
      const upper = mid(0.5, fTop - 0.012 * tall);
      const lower = mid(0.55, lerp(fBot, tipY, 0.55) + 0.01 * tall);
      pen.poly(roundPath([cp(xa, fTop, 5 * u), cp(upper[0], upper[1], 14 * u), cp(xb, tipY, 2), cp(lower[0], lower[1], 24 * u), cp(xa + 0.003 * len, fBot, 8 * u)]), vent);
      tier(c, c.fine, () => {
        const slats: number[][] = [];
        for (let i = 0; i < 3; i += 1) {
          const t0 = 0.12 + i * 0.2;
          const lo = mid(t0, lerp(fBot, tipY, t0));
          const hi = mid(t0 + 0.07, lerp(fTop, tipY, t0 + 0.07) + 0.02 * tall);
          slats.push([lo[0], lo[1] - 3 * u, hi[0], hi[1], hi[0], hi[1] + 2.4 * u, lo[0], lo[1] - 0.6 * u]);
        }
        pen.poly(joinShapes(slats), S.lt(vent, 0.22), 0.8);
      });
      pen.line([xa - 0.004 * len, fBot + 1, lower[0], lower[1] + 1, xb + 0.01 * len, tipY + 3], S.fine * 0.9, S.lt(c.trim, 0.4), 0.85);
    } else if (it === "gill") {
      const y0 = g.y(lerp(p.sillH, p.beltH, 0.78));
      const gs = [0, 1, 2].map((i) => [ix - i * 9 * u, y0 - 16 * u, ix - i * 9 * u - 5 * u, y0 - 16 * u, ix - i * 9 * u - 9 * u, y0 + 14 * u, ix - i * 9 * u - 4 * u, y0 + 14 * u]);
      pen.poly(joinShapes(gs), vent);
    } else if (it === "slats") {
      const y0 = g.beltY(ix) + 10 * u;
      pen.poly(joinShapes([0, 1, 2, 3].map((i) => [ix - 0.05 * len, y0 + i * 7 * u, ix + 0.03 * len, y0 + i * 7 * u, ix + 0.03 * len, y0 + 3 * u + i * 7 * u, ix - 0.05 * len, y0 + 3 * u + i * 7 * u])), vent);
    } else if (it === "duct") {
      const ys = g.y(p.sillH) - 0.03 * tall;
      pen.poly(roundPath([cp(ix, ys - 0.03 * tall, 4 * u), cp(ix + 0.012 * len, ys + 0.012 * tall, 4 * u), cp(ix - 0.1 * len, ys + 0.012 * tall, 4 * u), cp(ix - 0.09 * len, ys - 0.03 * tall, 4 * u)]), vent);
    }
    if (R.side.rubStrip) pen.rect(a0.x + a0.ra + 6, g.y(lerp(p.sillH, p.beltH, 0.42)), a1.x - a1.ra - a0.x - a0.ra - 12, 6 * u, 3, c.trim);
  });
  // the mirror
  const m = R.side.mirror;
  if (m === "none") return;
  tier(c, c.med, () => {
    const mx = g.pts.cowl![0] - 0.022 * len;
    const my = g.beltY(mx) - 0.035 * tall;
    const mc = S.t(R.mirrorColor);
    const nd = S.nd;
    if (m === "stalk") {
      pen.line([mx - 14 * u, g.beltY(mx) + 3, mx - 2 * u, my + 2], 5 * u, c.trim);
      if (nd) pen.ellipse(mx + 4 * u, my - 2 * u, 15 * u + S.ow, 10 * u + S.ow, 0, S.ink);
      pen.ellipse(mx + 4 * u, my - 2 * u, 15 * u, 10 * u, 0, mc);
      if (!nd) pen.line(arcPts(mx + 4 * u, my - 2 * u, 12 * u, 7 * u, 200, 290, 5), S.fine * 0.8, "#ffffff", 0.3 * S.gloss);
    } else if (m === "square") {
      pen.line([mx - 10 * u, g.beltY(mx) - 6 * u, mx + 6 * u, g.beltY(mx) - 6 * u], 4 * u, c.trim);
      pen.rect(mx + 2 * u, my - 18 * u, 13 * u, 26 * u, 3, c.trim);
    } else {
      if (nd) pen.ellipse(mx, my + 6 * u, 14 * u + S.ow, 10 * u + S.ow, 0, S.ink);
      pen.ellipse(mx, my + 6 * u, 14 * u, 10 * u, 0, mc);
    }
  });
}

/** Night drive: the amber side marker and the rim light along the screen or roof. Bright draws nothing. */
export function nightEdge(c: PartCtx): void {
  const { pen, g, S, p, len } = c;
  if (!S.nd || !c.full) return;
  pen.rect(c.hl - 0.07 * len, g.y(lerp(p.sillH, p.beltH, 0.5)) - 4, 14 * c.u, 8 * c.u, 3, ND.marker);
  if (!g.open) {
    const chain = topChain(g.sil);
    const pts: number[] = [];
    for (let i = 0; i < chain.length; i += 2) {
      if (chain[i]! <= g.pts.head![0] + 2 && chain[i]! >= g.pts.roof![0] - 2 && chain[i + 1]! < g.beltY(chain[i]!)) pts.push(chain[i]! * 0.99, chain[i + 1]! + S.ow * 0.7);
    }
    if (pts.length >= 4) pen.line(pts, S.ow, F.light.rim, F.light.rimA);
  } else pen.line([g.pts.cowl![0], g.pts.cowl![1] + S.ow * 0.7, g.pts.head![0], g.pts.head![1] + S.ow * 0.7], S.ow, F.light.rim, F.light.rimA);
}

// ---- nose, tail, bonnet ----------------------------------------------------------------------------------------------

/** The point on the bonnet's surface t of the way from the nose to the cowl (0..1). */
function bonnetAt(c: PartCtx, t: number): Pt {
  const x = lerp(c.g.pts.nose![0], c.g.pts.cowl![0], t);
  return [x, topAt(c.g.sil, x) ?? lerp(c.g.pts.nose![1], c.g.pts.cowl![1], t)];
}

/** Bumpers (black or chrome), the two plain plates, grille, intake and fog lamps. */
export function noseTail(c: PartCtx, mouth = false): void {
  const { pen, g, S, R, p, tall, len, hl, u } = c;
  if (!c.full) return;
  const fr = R.front;
  const re = R.rear;
  tier(c, c.med, () => {
    for (const [b, isFront] of [[fr.bumper, true], [re.bumper, false]] as const) {
      if (b === "body") continue;
      const col = b === "chrome" ? c.chrome : c.trim;
      if (isFront) pen.rect(hl - 0.04 * len, g.y(p.chinH + 9), 0.04 * len + 7, 0.045 * tall, 5, col);
      else pen.rect(-hl - 7, g.y(p.rumpH + 9), 0.04 * len + 7, 0.045 * tall, 5, col);
    }
  });
  // the plates: two plain rects, never lettering
  // seen from the side a plate is edge on: a thin light sliver, not a dot
  pen.rect(hl - 1.5, g.y(lerp(p.chinH, p.tipH, 0.55)), 3, 0.036 * tall, 1, S.t(PLATE));
  pen.rect(-hl - 1.5, g.y(lerp(p.rumpH, p.tailH, 0.45)), 3, 0.036 * tall, 1, S.t(PLATE));
  const gy = g.y(lerp(p.tipH, p.noseH, 0.75));
  const gh = ((tall * (p.noseH - p.tipH)) / 100) * 0.6;
  if (!mouth) tier(c, c.med, () => {
    const gc = S.t("#2a2d36");
    const gw = 0.022 * len;
    switch (fr.grille) {
      case "slot":
        pen.rect(hl - gw, gy + gh * 0.3, gw - 1, Math.max(3, gh * 0.22), 2, gc);
        break;
      case "bars":
        pen.rect(hl - gw, gy, gw - 1, gh, 4, gc);
        pen.line([hl - gw + 3, gy + gh * 0.5, hl - 3, gy + gh * 0.5], Math.max(2, gh * 0.12), c.chrome);
        break;
      case "slats":
        pen.poly(joinShapes([0, 1, 2].map((i) => [hl - gw, gy + (i * gh) / 3, hl - 1, gy + (i * gh) / 3, hl - 1, gy + (i * gh) / 3 + gh * 0.2, hl - gw, gy + (i * gh) / 3 + gh * 0.2])), gc);
        break;
      case "mesh":
        pen.rect(hl - gw, gy, gw - 1, gh, 4, S.dk(gc, 0.3));
        break;
      case "oval":
        pen.ellipse(hl - gw / 2, gy + gh / 2, gw / 2 - 0.5, gh * 0.55, 0, gc);
        break;
      case "tall":
        pen.rect(hl - gw, gy - gh * 0.5, gw - 1, gh * 1.7, 4, gc);
        break;
      case "twin":
        pen.poly(joinShapes([0, 1].map((i) => roundPath([cp(hl - gw, gy + i * gh * 0.55, 3), cp(hl - 1, gy + i * gh * 0.55, 3), cp(hl - 1, gy + i * gh * 0.55 + gh * 0.42, 3), cp(hl - gw, gy + i * gh * 0.55 + gh * 0.42, 3)]))), gc);
        break;
      default:
    }
    if (fr.intake !== "none") {
      const yb = g.y(p.chinH + 3);
      const yt = g.y(lerp(p.chinH, p.tipH, 0.75));
      const vent = S.t("#17181d");
      if (fr.intake === "wide") pen.poly(roundPath([cp(hl - 0.004 * len, yb, 4), cp(hl - 0.002 * len, yt, 4), cp(hl - 0.045 * len, lerp(yb, yt, 0.6), 6), cp(hl - 0.05 * len, yb, 4)]), vent);
      else if (fr.intake === "split3") pen.poly(joinShapes([0, 1, 2].map((i) => roundPath([cp(hl - 0.052 * len + i * 0.016 * len, yb, 3), cp(hl - 0.04 * len + i * 0.016 * len, lerp(yb, yt, 0.55 + 0.1 * (2 - i) / 2), 3), cp(hl - 0.03 * len + i * 0.016 * len, lerp(yb, yt, 0.55 + 0.1 * (2 - i) / 2), 3), cp(hl - 0.034 * len + i * 0.016 * len, yb, 3)]))), vent);
      else if (fr.intake === "twin") pen.poly(roundPath([cp(hl - 0.03 * len, lerp(yb, yt, 0.35), 5), cp(hl - 0.004 * len, lerp(yb, yt, 0.55), 5), cp(hl - 0.004 * len, yt, 4), cp(hl - 0.03 * len, lerp(yb, yt, 0.9), 5)]), vent);
      else pen.poly(bandOnSmile(hl, yb, yt, len), vent);
    }
  });
  if (fr.fog) {
    tier(c, c.fine, () => {
      const [fx, fy] = [hl - 0.045 * len, g.y(p.chinH + 7 * 0.6)];
      pen.circle(fx, fy, 0.022 * tall + 1.5, S.dk(c.paint, 0.4));
      pen.circle(fx, fy, 0.022 * tall, S.nd ? grade(LENS_OFF) : "#ffe08a");
    });
  }
  void u;
}

/** The `smile` intake: a curved low mouth, a crescent. */
function bandOnSmile(hl: number, yb: number, yt: number, len: number): number[] {
  const x0 = hl - 0.06 * len;
  const x1 = hl - 0.003 * len;
  const pts: number[] = [];
  for (let i = 0; i <= 8; i += 1) {
    const t = i / 8;
    pts.push(lerp(x0, x1, t), lerp(yb, yt, 0.35) + Math.sin(t * Math.PI) * (yb - yt) * 0.35);
  }
  for (let i = 8; i >= 0; i -= 1) {
    const t = i / 8;
    pts.push(lerp(x0, x1, t), lerp(yb, yt, 0.35) - 1 - Math.sin(t * Math.PI) * (yb - yt) * 0.1 - (yb - yt) * 0.22);
  }
  return pts;
}

/** The bonnet's vent: a scoop, a long bulge, two slats or a wide outlet. */
export function bonnetVent(c: PartCtx): void {
  const { pen, g, S, R, tall, u } = c;
  if (!c.full || R.bonnet.vent === "none") return;
  tier(c, c.med, () => {
    const v = R.bonnet.vent;
    const inset = S.ow * 0.5 + 1;
    const x = (t: number) => bonnetAt(c, t)[0];
    if (v === "duct") pen.poly(bandOnTop(g.sil, x(0.5), x(0.88), inset, (t) => 0.045 * tall * (1 - 0.3 * t)), S.t("#17181d"));
    else if (v === "vents") {
      const slats = [0, 1].map((i) => bandOnTop(g.sil, x(0.46 + i * 0.16), x(0.56 + i * 0.16), inset + 1, () => 0.022 * tall, 3));
      pen.poly(joinShapes(slats), S.t("#17181d"));
    } else if (v === "scoop") {
      const x0 = x(0.4);
      const x1 = x(0.7);
      const y0 = topAt(g.sil, x0) ?? 0;
      const y1 = topAt(g.sil, x1) ?? 0;
      pen.poly(roundPath([cp(x0, y0 + 2, 2), cp(x0 - 0.004 * c.len, y0 - 0.05 * tall, 4 * u), cp(x1, y1 - 0.055 * tall, 5 * u), cp(x1, y1 + 2, 2)]), S.dk(c.paint, 0.12));
      pen.poly([x0 + 1, y0 - 0.005 * tall, x0 + 0.014 * c.len, y0 - 0.04 * tall, x0 + 0.014 * c.len, y0 + 1, x0 + 1, y0 + 1], S.t("#17181d"));
    } else {
      // bulge: a long hump above the surface, outlined like the body
      const hump = (grow: number): number[] => {
        const a = x(0.22);
        const b = x(0.88);
        const up: number[] = [];
        for (let i = 0; i <= 10; i += 1) {
          const t = i / 10;
          const xx = lerp(a, b, t);
          up.push(xx, (topAt(g.sil, xx) ?? 0) - Math.sin(t * Math.PI) * 0.03 * tall - grow + 1);
        }
        return [...up, b, (topAt(g.sil, b) ?? 0) + 2, a, (topAt(g.sil, a) ?? 0) + 2];
      };
      pen.poly(hump(-S.ow * 0.6), S.ink);
      pen.poly(hump(0), S.lt(c.paint, 0.08));
    }
  });
}

// ---- lamps -----------------------------------------------------------------------------------------------------------

/** The top of an upright exhaust stack: behind the cab of a truck, up the tail of a bus. */
function stackAt(g: Side2): [number, number] {
  const p = g.p;
  if (p.deckX - p.roofX > 12) return [g.X(p.roofX) + 0.015 * g.len, g.y(Math.max(p.deckH, p.roofH * 0.8))];
  return [-g.hl + 9 * clamp(g.tall / 214, 0.6, 1.7), g.y(lerp(p.rumpH, p.tailH, 0.85))];
}

/** Where the tail pipe's puff starts (carSide2's exhaust effect): by `rear.exhaust`. */
export function exhaustAt(g: Side2): [number, number] {
  const R = g.R;
  const e = R.rear.exhaust;
  const p = g.p;
  if (g.arch.length < 2) return [-g.hl - 3, g.y(0.3)];
  if (e === "high") return [-g.hl - 3, g.y(lerp(p.rumpH, p.tailH, 0.45))];
  if (e === "centre") return [-g.hl - 3, g.y(p.rumpH + 5)];
  if (e === "stack") return stackAt(g);
  if (e === "side") return [g.arch[0]!.x + g.arch[0]!.ra + 0.03 * g.len, g.y(p.sillH) + 3];
  return [-g.hl - 3, g.y(p.rumpH + 3)];
}

/** The front lamp (and its daytime light), the rear lamp: drawn, and the centres of their lenses returned (they are
 * `lampAt`'s, one function: the beam and the glows are drawn from them before the body). */
export function lamps(c: PartCtx, st: LampState): { front: [number, number]; rear: [number, number] } {
  const front = lampAt(c.g, "front");
  const rear = lampAt(c.g, "rear");
  if (!c.full) return { front, rear };
  if (st.front !== false) frontLamp(c, st, front);
  if (st.rear !== false) rearLamp(c, st, rear);
  return { front, rear };
}

function frontLamp(c: PartCtx, st: LampState, at: [number, number]): void {
  const { pen, g, S, R, tall, len } = c;
  const L = R.lights.front;
  const off = L.lens === "yellow" ? "#ffd34d" : L.lens === "smoked" ? "#7d786d" : null;
  const lens = S.nd ? (st.lit ? ND.headCore : grade(off ?? LENS_OFF)) : st.lit ? "#fff3b0" : (off ?? "#ffe08a");
  const bezel = R.front.bumper === "chrome" ? c.chrome : S.dk(c.paint, 0.35);
  const [cx, cy] = at;
  let hw = 0.062 * tall;
  let hh = hw;
  switch (L.shape) {
    case "round":
      pen.circle(cx, cy, hw + 2.5, bezel);
      pen.circle(cx, cy, hw, lens);
      break;
    case "twin_round":
      pen.circle(cx, cy, hw + 2.5, bezel);
      pen.circle(cx, cy, hw, lens);
      pen.circle(cx + hw * 0.2, cy, hw * 0.5, S.nd ? (st.lit ? ND.headBloom : S.lt(lens, 0.3)) : S.lt(lens, 0.35));
      break;
    case "oval":
      hw = 0.09 * tall;
      hh = 0.05 * tall;
      pen.ellipse(cx, cy, hw + 2, hh + 2, 0, bezel);
      pen.ellipse(cx, cy, hw, hh, 0, lens);
      break;
    case "square":
      hw = 0.0175 * len - 1;
      hh = 0.0425 * tall;
      pen.rect(cx - hw, cy - hh, hw * 2, hh * 2, 4, lens);
      break;
    case "rect":
      hw = 0.026 * len;
      hh = 0.03 * tall;
      pen.rect(cx - hw, cy - hh, hw * 2, hh * 2, 4, lens);
      break;
    case "slim":
      hw = 0.026 * len;
      hh = 0.0175 * tall;
      pen.rect(cx - hw, cy - hh, hw * 2, hh * 2, 4, lens);
      break;
    case "angled":
      hw = 0.026 * len;
      hh = 0.034 * tall;
      pen.poly(roundPath([cp(cx - hw, cy - hh, 3), cp(cx + hw, cy - hh * 0.1, 3), cp(cx + hw, cy + hh, 3), cp(cx - hw, cy + hh * 0.4, 3)]), lens);
      break;
    case "stacked": {
      hw = 0.02 * len;
      hh = 0.065 * tall;
      const bh = 0.027 * tall;
      pen.poly(joinShapes([-1, 1].map((s) => [cx - hw, cy + s * hh * 0.55 - bh, cx + hw, cy + s * hh * 0.55 - bh, cx + hw, cy + s * hh * 0.55 + bh, cx - hw, cy + s * hh * 0.55 + bh])), lens);
      break;
    }
    case "pop_up":
      hw = 0.02 * len;
      hh = 0.03 * tall;
      if (st.lit) pen.rect(cx - hw, cy - hh * 1.5, hw * 2, hh * 2.4, 3, lens);
      else {
        pen.rect(cx - hw, cy - hh * 0.5, hw * 2, hh, 2, S.dk(c.paint, 0.12));
        pen.line([cx - hw, cy - hh * 0.5, cx + hw, cy - hh * 0.5], S.fine * 0.8, S.dk(c.paint, 0.45), 0.8);
      }
      break;
    case "strip":
      hw = 0.026 * len;
      hh = 0.008 * tall;
      pen.rect(cx - hw, cy - hh, hw * 2, hh * 2, 2, lens);
      break;
    case "swept": {
      // a leaf of dark glass running back along the wing from the nose, with a small lit core near its front end
      const w = sweptLamp(g);
      const th = w.thick;
      const inset = w.inset;
      hw = Math.abs(w.xa - w.xb) / 2;
      hh = 0.03 * tall;
      pen.poly(bandOnTop(g.sil, w.xa, w.xb, inset, th, 10), S.t("#14161b"));
      const [kx, ky] = sweptCore(g);
      const kr = 0.026 * tall;
      pen.ellipse(kx, ky, kr * 1.6, kr, 14, st.lit ? lens : S.nd ? S.lt(S.t("#3a4552"), 0.2) : S.dk(lens, 0.45));
      if (L.drl !== "none") {
        tier(c, c.med, () => {
          const col = S.nd ? (st.lit ? ND.headCore : grade(LENS_OFF)) : st.lit ? "#ffffff" : "#fff3b0";
          const pts: number[] = [];
          for (let i = 0; i <= 10; i += 1) {
            const t = i / 10;
            const x = lerp(w.xa, w.xb, t);
            pts.push(x, (topAt(g.sil, x) ?? cy) + inset + th(t) + Math.max(S.fine, 2) * 0.8);
          }
          pen.line(pts, Math.max(S.fine, 2), col, st.lit ? 0.95 : 0.55);
        });
      }
      return;
    }
    default:
      pen.circle(cx, cy, hw, lens);
  }
  // the daytime light: one line prim, bright when the lights are on
  if (L.drl !== "none") {
    tier(c, c.med, () => {
      const col = S.nd ? (st.lit ? ND.headCore : grade(LENS_OFF)) : st.lit ? "#ffffff" : "#fff3b0";
      const a = st.lit ? 0.95 : 0.55;
      const w = Math.max(S.fine, 2);
      const lowY = cy + hh + 3;
      if (L.drl === "line") pen.line([cx - hw, lowY, cx + hw, lowY], w, col, a);
      else if (L.drl === "hook") pen.line([cx - hw, lowY - hh * 0.9, cx - hw, lowY, cx + hw, lowY], w, col, a);
      else if (L.drl === "ring") pen.line(arcPts(cx, cy, hw + 4, hh + 4, 0, 360, 20), w, col, a);
      else if (L.drl === "dots") pen.poly(joinShapes([-0.6, 0, 0.6].map((k) => arcPts(cx + k * hw, lowY, w * 0.8, w * 0.8, 0, 360, 6).slice(0, -2))), col, a);
      else if (L.drl === "brow") pen.line([cx - hw, cy - hh * 0.2 - 3, cx, cy - hh - 3, cx + hw, cy - hh * 0.6 - 3], w, col, a);
    });
  }
}

function rearLamp(c: PartCtx, st: LampState, at: [number, number]): void {
  const { pen, S, R, tall, len } = c;
  const L = R.lights.rear;
  const off = L.lens === "clear" ? "#e6dede" : L.lens === "smoked" ? "#5e2025" : TAIL_OFF;
  const lens = S.nd ? (st.braking ? ND.brakeCore : st.tailOn ? ND.tailCore : grade(off)) : st.braking ? "#ff2d2d" : off;
  const [cx, cy] = at;
  switch (L.shape) {
    case "round":
      // a round lamp on the tail face is seen from the side as a narrow oval, not a dot on the flank
      pen.ellipse(cx, cy, 0.03 * tall, 0.062 * tall, 0, S.dk(c.paint, 0.5));
      pen.ellipse(cx, cy, 0.021 * tall, 0.05 * tall, 0, lens);
      break;
    case "twin_round":
      pen.ellipse(cx, cy, 0.03 * tall, 0.062 * tall, 0, S.dk(c.paint, 0.5));
      pen.ellipse(cx, cy, 0.021 * tall, 0.05 * tall, 0, lens);
      pen.ellipse(cx, cy, 0.01 * tall, 0.026 * tall, 0, S.lt(lens, 0.3));
      break;
    case "square":
      pen.rect(cx - 0.011 * len, cy - 0.0375 * tall, 0.022 * len, 0.075 * tall, 3, lens);
      break;
    case "rect":
      pen.rect(cx - 0.015 * len, cy - 0.03 * tall, 0.03 * len, 0.06 * tall, 3, lens);
      break;
    case "tall":
      pen.rect(cx - 0.008 * len, cy - 0.05 * tall, 0.016 * len, 0.1 * tall, 3, lens);
      break;
    case "slim":
      pen.rect(cx - 0.015 * len, cy - 0.009 * tall, 0.03 * len, 0.018 * tall, 2, lens);
      break;
    case "bar":
      pen.rect(cx - 0.015 * len, cy - 0.015 * tall, 0.03 * len, 0.03 * tall, 3, lens);
      break;
    case "split_bar":
      pen.poly(joinShapes([-1, 1].map((s) => [cx - 0.015 * len, cy + s * 0.012 * tall - 0.008 * tall, cx + 0.015 * len, cy + s * 0.012 * tall - 0.008 * tall, cx + 0.015 * len, cy + s * 0.012 * tall + 0.008 * tall, cx - 0.015 * len, cy + s * 0.012 * tall + 0.008 * tall])), lens);
      break;
    case "wedge":
      pen.poly(roundPath([cp(cx - 0.011 * len, cy - 0.0375 * tall, 3), cp(cx + 0.011 * len, cy - 0.0375 * tall + 0.012 * tall, 2), cp(cx + 0.011 * len, cy + 0.0375 * tall, 2), cp(cx - 0.011 * len, cy + 0.0375 * tall, 3)]), lens);
      break;
    case "c_shape":
      pen.line([cx + 0.011 * len, cy - 0.034 * tall, cx - 0.008 * len, cy - 0.034 * tall, cx - 0.008 * len, cy + 0.034 * tall, cx + 0.011 * len, cy + 0.034 * tall], 0.016 * tall + 1, lens);
      break;
    default:
      pen.circle(cx, cy, 0.05 * tall, lens);
  }
}

// ---- tail ------------------------------------------------------------------------------------------------------------

/** Spoiler, exhaust tips and the diffuser's fins. */
export function tailPieces(c: PartCtx): void {
  const { pen, g, S, R, tall, len, hl, p, u } = c;
  if (!c.full) return;
  const t = g.pts.tail!;
  const sp = R.rear.spoiler;
  const trim = c.trim;
  if (sp === "lip" || sp === "ducktail") {
    pen.poly(roundPath([cp(t[0] + (sp === "ducktail" ? 0.06 : 0.035) * len, t[1] + 1, 3), cp(t[0] - 0.004 * len, t[1] - (sp === "ducktail" ? 0.075 : 0.025) * tall, 3), cp(t[0] - 0.012 * len, t[1] + 3, 3)]), sp === "lip" ? trim : S.dk(c.paint, 0.1));
  } else if (sp === "wing") {
    const wx = t[0] + 0.03 * len;
    const wy = t[1];
    pen.line([wx, wy + 2, wx - 4 * u, wy - 0.09 * tall], 6 * u, trim);
    pen.rect(wx - 0.06 * len, wy - 0.11 * tall, 0.085 * len, 8 * u, 4, trim);
  } else if (sp === "big_wing") {
    const wx = t[0] + 0.028 * len;
    const wy = t[1];
    pen.poly(joinShapes([0, 1].map((i) => [wx - i * 0.05 * len, wy + 2, wx - i * 0.05 * len - 7 * u, wy + 2, wx - i * 0.05 * len - 9 * u, wy - 0.15 * tall, wx - i * 0.05 * len - 2 * u, wy - 0.15 * tall])), trim);
    pen.rect(wx - 0.1 * len, wy - 0.18 * tall, 0.13 * len, 11 * u, 5, trim);
    pen.rect(wx - 0.1 * len - 3, wy - 0.22 * tall, 6 * u, 0.07 * tall, 2, trim);
  } else if (sp === "roof") {
    const r = g.pts.roof!;
    pen.poly(roundPath([cp(r[0] + 0.012 * len, r[1] + 3, 2), cp(r[0] - 0.045 * len, r[1] - 0.028 * tall, 3), cp(r[0] - 0.045 * len, r[1] + 0.006 * tall, 2)]), trim);
  }
  tier(c, c.med, () => {
    const e = R.rear.exhaust;
    const tip = S.t("#3a3d44");
    const x = -hl - 3;
    if (e === "none") return;
    if (e === "single") pen.ellipse(x, g.y(p.rumpH + 3), 7 * u, 5 * u, 0, tip);
    else if (e === "twin") pen.poly(joinShapes([[0, 0], [4, -4 * u]].map(([dx, dy]) => arcPts(x + dx!, g.y(p.rumpH + 3) + dy!, 7 * u, 5 * u, 0, 360, 10).slice(0, -2))), tip);
    else if (e === "quad") pen.poly(joinShapes([0, 1].flatMap((i) => [0, 1].map((j) => arcPts(x + j * 4, g.y(p.rumpH + 3) - i * 11 * u - j * 3 * u, 6 * u, 4.5 * u, 0, 360, 10).slice(0, -2)))), tip);
    else if (e === "centre") pen.ellipse(x, g.y(p.rumpH + 5), 9 * u, 6 * u, 0, tip);
    else if (e === "high") pen.poly(joinShapes([[0, 0], [4, -3 * u]].map(([dx, dy]) => arcPts(x + dx!, g.y(lerp(p.rumpH, p.tailH, 0.45)) + dy!, 6 * u, 5 * u, 0, 360, 10).slice(0, -2))), tip);
    else if (e === "side") {
      const [sx, sy] = exhaustAt(g);
      pen.rect(sx - 6 * u, sy - 3 * u, 12 * u, 6 * u, 3, tip);
    } else if (e === "stack") {
      const [sx, sy] = stackAt(g);
      const base = p.deckX - p.roofX > 12 ? g.y(p.deckH) : g.y(p.rumpH + 4);
      pen.rect(sx - 3.5 * u, sy, 7 * u, base - sy, 3, tip);
    }
  });
  if (R.rear.diffuser === "fins") {
    tier(c, c.med, () => {
      const a0 = g.arch[0]!;
      const yR = g.y(p.rumpH);
      const x0 = a0.x - a0.ra - 4;
      const x1 = g.X(99.2);
      const fins: number[][] = [0, 1, 2].map((i) => {
        const x = lerp(x0 + 6 * u, x1 - 4 * u, (i + 0.5) / 3);
        return [x, yR - 0.05 * tall, x + 2.5 * u, yR - 0.05 * tall, x + 2.5 * u, yR + 3, x, yR + 3];
      });
      pen.poly(joinShapes(fins), S.lt(trim, 0.22));
    });
  }
}

// ---- extras ----------------------------------------------------------------------------------------------------------

/** Roof rails, the classic roof rack and box, the bull bar, spare wheel, antenna, shark fin, snorkel, light bar, mudflaps,
 * roof scoop, tow hook, ladder and wing lamps. A part on the roof is skipped on an open car. */
export function extras(c: PartCtx): void {
  const { pen, g, S, R, p, tall, len, hl, u } = c;
  if (!c.full) return;
  const ex = R.extras;
  const open = g.open;
  const roofTop = (q: number): number => topAt(g.sil, g.X(q)) ?? g.y(100);
  const trim = c.trim;
  // the roof's rails (the `roof.rails` flag or the extra: one pair of rails)
  if (!open && (R.roof.rails || ex.includes("roof_rails"))) {
    tier(c, c.fine, () => {
      const x0 = g.pts.head![0] - 0.04 * len;
      const x1 = g.pts.roof![0] + 0.04 * len;
      const y0 = topAt(g.sil, x0) ?? g.y(100);
      const y1 = topAt(g.sil, x1) ?? g.y(100);
      pen.line([x0, y0 + 1, x0 - 1, y0 - 9 * u, x1 + 1, y1 - 9 * u, x1, y1 + 1], 5 * u, trim);
    });
  }
  if (!open && R.car.extra === "roof_rack") {
    const x0 = g.pts.head![0] - 0.03 * len;
    const x1 = g.pts.roof![0] + 0.03 * len;
    const y0 = (topAt(g.sil, x0) ?? g.y(100)) + 1;
    pen.line([x0, y0, x0 - 1, y0 - 15 * u, x1 + 1, y0 - 15 * u, x1, y0], 7 * u, S.t("#3d4250"));
  } else if (!open && R.car.extra === "roof_box") {
    const x0 = g.pts.head![0] - 0.06 * len;
    const x1 = g.pts.roof![0] + 0.04 * len;
    const y0 = topAt(g.sil, (x0 + x1) / 2) ?? g.y(100);
    pen.rect(x1 - 6, y0 - 44 * u, x0 - x1 + 12, 46 * u, 20 * u, S.ink);
    pen.rect(x1, y0 - 38 * u, x0 - x1, 36 * u, 16 * u, S.t("#454b58"));
  }
  if (ex.includes("bull_bar")) pen.line([hl - 2, g.y(p.chinH + 4), hl + 13 * u, g.y(p.chinH + 6), hl + 13 * u, g.y(p.noseH - 18), hl - 3, g.y(p.noseH - 18)], 6 * u, c.chrome);
  if (ex.includes("spare_wheel")) {
    const r = g.arch[0]!.wr * 0.86;
    const cy = g.y(lerp(p.rumpH, p.tailH, 0.62));
    pen.rect(-hl - r * 0.62, cy - r, r * 0.62, r * 2, 8 * u, S.tyre);
    pen.rect(-hl - r * 0.62 - 3, cy - r * 0.62, 5 * u, r * 1.24, 2, c.chrome);
  }
  if (ex.includes("antenna") && !open) {
    tier(c, c.fine, () => {
      const x = g.X(p.roofX - 6);
      pen.line([x, (topAt(g.sil, x) ?? g.y(100)) + 2, x + 0.007 * len, g.y(100) - 0.18 * tall], 2 * u, trim);
    });
  } else if (ex.includes("antenna")) {
    tier(c, c.fine, () => {
      const x = g.X(p.deckX - 3);
      pen.line([x, (topAt(g.sil, x) ?? g.y(p.deckH)) + 2, x + 0.007 * len, g.y(p.deckH) - 0.16 * tall], 2 * u, trim);
    });
  }
  if (ex.includes("shark_fin") && !open) {
    tier(c, c.fine, () => {
      const x0 = g.X(p.roofX - 16);
      const x1 = g.X(p.roofX - 5);
      const y0 = (topAt(g.sil, x0) ?? g.y(100)) + 2;
      const y1 = (topAt(g.sil, x1) ?? g.y(100)) + 2;
      pen.poly([x0, y0, x1, y1, x1 + 0.004 * len, y1 - 0.025 * tall, x0 - 0.002 * len, y0 - 0.045 * tall], trim);
    });
  }
  if (ex.includes("snorkel")) {
    tier(c, c.med, () => pen.line([g.X(p.cowlX - 2), g.y(p.cowlH) + 6, g.X(p.cowlX - 1), g.y(p.headH) + 2, g.X(p.cowlX + 2), g.y(p.headH) - 1], 7 * u, trim));
  }
  if (ex.includes("light_bar") && !open) {
    tier(c, c.fine, () => {
      const x0 = g.X(p.headX + 6);
      const x1 = g.X(p.headX + 26);
      const y0 = (topAt(g.sil, (x0 + x1) / 2) ?? g.y(100)) + 1;
      pen.rect(x1, y0 - 0.045 * tall, x0 - x1, 0.045 * tall, 3, trim);
      pen.poly(joinShapes([0, 1, 2, 3].map((i) => arcPts(lerp(x0, x1, (i + 0.5) / 4), y0 - 0.0225 * tall, 0.012 * tall + 1, 0.012 * tall + 1, 0, 360, 6).slice(0, -2))), S.nd ? grade("#fff3b0") : "#fff3b0");
    });
  }
  if (ex.includes("roof_scoop") && !open) {
    tier(c, c.med, () => {
      const x0 = g.X(p.headX + 14);
      const x1 = g.X(p.headX + 28);
      const y0 = (topAt(g.sil, x0) ?? g.y(100)) + 1;
      const y1 = (topAt(g.sil, x1) ?? g.y(100)) + 1;
      pen.poly([x0, y0, x0 - 0.004 * len, y0 - 0.05 * tall, x1, y1 - 0.034 * tall, x1, y1], trim);
    });
  }
  if (ex.includes("mudflaps")) {
    tier(c, c.med, () => {
      for (const a of g.arch) {
        const x = a.x - a.ra - 1 * u;
        const top = (bottomAt(g.sil, x + 3 * u) ?? g.y(p.sillH)) - 2;
        const bottom = -a.wr * 0.22;
        if (bottom > top + 4) pen.rect(x, top, 7 * u, bottom - top, 2, trim);
      }
    });
  }
  if (ex.includes("tow_hook")) {
    tier(c, c.fine, () => {
      const y0 = g.y(p.chinH + 4);
      pen.line([hl - 4, y0, hl + 9 * u, y0, hl + 9 * u, y0 + 7 * u, hl + 3 * u, y0 + 7 * u], 3 * u, c.chrome);
    });
  }
  if (ex.includes("ladder")) {
    tier(c, c.med, () => {
      const y0 = g.y(p.rumpH + 4);
      const y1 = g.y(p.deckH);
      const x = -hl - 3 * u;
      const rungs: number[][] = [];
      for (let i = 0; i < 5; i += 1) {
        const yy = lerp(y0, y1, (i + 0.5) / 5);
        rungs.push([x - 4 * u, yy, x + 4 * u, yy, x + 4 * u, yy + 2.4 * u, x - 4 * u, yy + 2.4 * u]);
      }
      pen.poly(joinShapes([[x - 4 * u, y0, x - 2 * u, y0, x - 2 * u, y1, x - 4 * u, y1], [x + 2 * u, y0, x + 4 * u, y0, x + 4 * u, y1, x + 2 * u, y1], ...rungs]), trim);
    });
  }
  if (ex.includes("wing_lamps")) {
    tier(c, c.fine, () => {
      const x = g.X(p.noseX + 13);
      pen.rect(x - 5 * u, (topAt(g.sil, x) ?? g.y(p.noseH)) + 4 * u, 10 * u, 5 * u, 2, S.t("#ffb347"));
    });
  }
  void roofTop;
}

// ---- wheels ----------------------------------------------------------------------------------------------------------

/** The two wheels, rear then front, in the GROUND frame (they do not ride the body's springs). `spin` in radians;
 * `flatFront` squashes the front tyre. Returns how many prims it drew. */
export function wheels(c: PartCtx, spin: number, flatFront: boolean): number {
  const { pen, g, S, R, car } = c;
  if (!R.fits.wheels) return 0;
  const rim = hex(car.wheels.rim, "#c9ccd2");
  if (g.arch.length >= 2) {
    const [aR, aF] = [g.arch[0]!, g.arch[1]!];
    return wheelPart(pen, S, R, aR.x, aR.cy, aR.wr, spin, false, false, rim) + wheelPart(pen, S, R, aF.x, aF.cy, aF.wr, spin, flatFront, true, rim);
  }
  // a motorbike or a plane: today's shape, real wheels (a plane's are small)
  const r = (g.spec.form === "plane" ? 0.5 : 1) * g.wr;
  return wheelPart(pen, S, R, g.axRear, -r, r, spin, false, false, rim) + wheelPart(pen, S, R, g.ax, -r, r, spin, flatFront, true, rim);
}
