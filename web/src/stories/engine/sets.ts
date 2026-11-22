// Lamo Stories engine: the places (SetId). Side views are built from parallax layers (sky, far hills or skyline,
// roadside things, the ground and road) so a camera move or a driving scene feels deep; top views show a road from
// above for explaining how a car moves. Everything is flat-shaded with the studio's palette.
//
// Each place is laid out for the 1080 × 1920 frame and kept in the same parts of any other shape's frame (frame.ts):
// the horizon, the road and a window stay at the same height and across the same part of the width, things keep
// their size, and the rows of trees, lamps and buildings repeat across a wider frame.

import { F, X, Y } from "./frame.ts";
import { mix, rand, shade } from "./math.ts";
import type { Pen } from "./pen.ts";
import { starPts } from "./pen.ts";
import { drawWeather } from "./props.ts";
import type { SetId } from "./types.ts";

/** Side-view layout of the 1080 × 1920 frame (world px). Actors and cars stand around y 0.62–0.85 of the frame. */
export const SIDE = { horizon: 1080, verge: 1150, roadTop: 1225, roadBottom: 1545, lane: 1385 };
/** Top-view road of the 1080-wide frame (world px): it runs up the frame between x 0.25 and 0.75 in every shape. */
export const TOP = { left: 270, right: 810 };

/** The side view's lines in the frame being drawn (the same parts of its height as in 1080 × 1920), `sy` for
 * distances between them and `tall` for how high hills and skylines reach into a shorter sky. */
function side(): typeof SIDE & { sy: number; tall: number } {
  return { horizon: Y(SIDE.horizon), verge: Y(SIDE.verge), roadTop: Y(SIDE.roadTop), roadBottom: Y(SIDE.roadBottom), lane: Y(SIDE.lane), sy: F.sy, tall: (1 + F.sy) / 2 };
}

/** How many more copies a row needs to cover a frame wider than 1080 px at this spacing. */
const more = (spacing: number): number => Math.max(0, Math.ceil((F.w - 1080) / spacing));

type Decor = "trees" | "pines" | "posts" | "lamps" | "city" | "highway" | "fields" | "parking";

interface OutdoorLook {
  sky: [string, string];
  body: "sun" | "moon" | "none";
  clouds: number;
  cloud: string;
  hills: [string, string];
  verge: string;
  near: string;
  road: string;
  lane: string;
  edge: string | null;
  decor: Decor;
  weather: "snow" | "rain" | "fog" | null;
  night: boolean;
  surface: "dry" | "ice" | "snow" | "wet";
  lanes: 1 | 2;
}

const OUT: Partial<Record<SetId, OutdoorLook>> = {
  road_day: { sky: ["#4fb3ff", "#c9ecff"], body: "sun", clouds: 3, cloud: "#ffffff", hills: ["#a6dca4", "#73c47f"], verge: "#7fcf6a", near: "#5fb85a", road: "#4a4f5c", lane: "#ffffff", edge: "#ffffff", decor: "trees", weather: null, night: false, surface: "dry", lanes: 1 },
  road_night: { sky: ["#0d0b2a", "#2a2466"], body: "moon", clouds: 2, cloud: "#3a3470", hills: ["#2a2560", "#1d1a48"], verge: "#1f3b3a", near: "#183130", road: "#2b2e3a", lane: "#d9d9e6", edge: "#bfc3d6", decor: "lamps", weather: null, night: true, surface: "dry", lanes: 1 },
  icy_road: { sky: ["#9fd3f2", "#eef9ff"], body: "sun", clouds: 2, cloud: "#ffffff", hills: ["#e6f3fb", "#cfe6f3"], verge: "#f4fbff", near: "#e6f3fb", road: "#6b7686", lane: "#ffffff", edge: "#ffffff", decor: "pines", weather: null, night: false, surface: "ice", lanes: 1 },
  snowy_road: { sky: ["#b4c3d3", "#eaf0f6"], body: "none", clouds: 3, cloud: "#ffffff", hills: ["#f2f6fa", "#dfe8f1"], verge: "#ffffff", near: "#f1f6fb", road: "#c3ccd7", lane: "#ffffff", edge: "#ffffff", decor: "pines", weather: "snow", night: false, surface: "snow", lanes: 1 },
  rainy_road: { sky: ["#526178", "#8e9cad"], body: "none", clouds: 4, cloud: "#6b7889", hills: ["#6f8a7a", "#56705f"], verge: "#4f7a52", near: "#456b47", road: "#3a3f4c", lane: "#e6e9ef", edge: "#e6e9ef", decor: "posts", weather: "rain", night: false, surface: "wet", lanes: 1 },
  foggy_road: { sky: ["#b2bcc6", "#dde2e7"], body: "none", clouds: 0, cloud: "#ffffff", hills: ["#cdd4da", "#b9c3cb"], verge: "#9fb59c", near: "#8fa88c", road: "#5b6270", lane: "#ffffff", edge: "#ffffff", decor: "posts", weather: "fog", night: false, surface: "dry", lanes: 1 },
  highway: { sky: ["#4fb3ff", "#d2efff"], body: "sun", clouds: 2, cloud: "#ffffff", hills: ["#a9c8e6", "#8db1d4"], verge: "#8fcf7a", near: "#6cbf62", road: "#474c58", lane: "#ffffff", edge: "#ffd54a", decor: "highway", weather: null, night: false, surface: "dry", lanes: 2 },
  country_road: { sky: ["#5cc2ff", "#d8f3ff"], body: "sun", clouds: 3, cloud: "#ffffff", hills: ["#b8e08c", "#8fcf6b"], verge: "#a7d86d", near: "#86c95a", road: "#6a6f7a", lane: "#ffffff", edge: null, decor: "fields", weather: null, night: false, surface: "dry", lanes: 1 },
  city_street: { sky: ["#74c4ff", "#e0f4ff"], body: "sun", clouds: 2, cloud: "#ffffff", hills: ["#a9b8d6", "#8796b8"], verge: "#c9ced8", near: "#b7bdc9", road: "#40444f", lane: "#ffd54a", edge: "#ffffff", decor: "city", weather: null, night: false, surface: "dry", lanes: 1 },
  parking_lot: { sky: ["#5cc2ff", "#d8f3ff"], body: "sun", clouds: 2, cloud: "#ffffff", hills: ["#b8e08c", "#8fcf6b"], verge: "#b9bec8", near: "#5a5f6b", road: "#5a5f6b", lane: "#ffffff", edge: null, decor: "parking", weather: null, night: false, surface: "dry", lanes: 1 },
};

export interface SetInfo {
  outdoor: boolean;
  night: boolean;
  weather: "snow" | "rain" | "fog" | null;
  road: boolean;
  /** the looping sound this place needs, if any */
  loop: { sfx: "wind" | "rain" | "engine"; volume: number } | null;
}

export function setInfo(set: SetId): SetInfo {
  const o = OUT[set];
  const loops: Partial<Record<SetId, SetInfo["loop"]>> = {
    rainy_road: { sfx: "rain", volume: 0.35 },
    snowy_road: { sfx: "wind", volume: 0.25 },
    icy_road: { sfx: "wind", volume: 0.18 },
    foggy_road: { sfx: "wind", volume: 0.14 },
    highway: { sfx: "engine", volume: 0.16 },
    park: { sfx: "wind", volume: 0.08 },
  };
  return { outdoor: !!o || set === "park", night: o?.night ?? false, weather: o?.weather ?? null, road: !!o, loop: loops[set] ?? null };
}

export interface SetEnv {
  pen: Pen;
  t: number;
  seed: number;
  /** px the road has rolled by (driving scenes): side view moves scenery left, top view moves it down */
  scroll: number;
  /** puts the pen in the camera's frame for a layer at this depth (0 = sky, 1 = the ground actors stand on) */
  layer: (depth: number) => void;
  /** the world x/y range visible at depth 1 */
  view: { x0: number; x1: number; y0: number; y1: number };
}

/** Repeating things along a line: the x of each copy visible in [x0, x1]. */
function repeat(spacing: number, offset: number, x0: number, x1: number, max = 12): number[] {
  const out: number[] = [];
  const start = Math.floor((x0 - offset) / spacing) - 1;
  for (let i = start; out.length < max; i += 1) {
    const x = i * spacing + offset;
    if (x > x1 + spacing) break;
    out.push(x);
  }
  return out;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

export function drawSetBack(set: SetId, view: "side" | "top", env: SetEnv): void {
  if (view === "top") {
    drawTop(set, env);
    return;
  }
  const o = OUT[set];
  if (o) outdoorSide(o, env);
  else if (set === "park") parkSide(env);
  else if (set === "studio") studioSide(env);
  else indoorSide(set, env);
}

export function drawSetFront(set: SetId, _view: "side" | "top", env: SetEnv, extraWeather: ("snow" | "rain" | "fog")[]): void {
  const info = setInfo(set);
  const kinds = new Set(extraWeather);
  if (info.weather) kinds.add(info.weather);
  env.pen.setMatrix([1, 0, 0, 1, 0, 0]);
  for (const k of kinds) drawWeather(env.pen, k, env.t, env.seed, "front", 1);
}

export function drawSetWeatherBack(set: SetId, env: SetEnv, extraWeather: ("snow" | "rain" | "fog")[]): void {
  const info = setInfo(set);
  const kinds = new Set(extraWeather);
  if (info.weather) kinds.add(info.weather);
  env.pen.setMatrix([1, 0, 0, 1, 0, 0]);
  for (const k of kinds) drawWeather(env.pen, k, env.t, env.seed, "back", 1);
}

// ---- side views ---------------------------------------------------------------------------------------------

function sky(pen: Pen, o: { sky: [string, string] }): void {
  pen.setMatrix([1, 0, 0, 1, 0, 0]);
  pen.grad(0, 0, 0, side().verge, [
    [0, o.sky[0]],
    [1, o.sky[1]],
  ]);
}

function cloud(pen: Pen, x: number, y: number, s: number, c: string, a: number): void {
  pen.circle(x, y, 60 * s, c, a);
  pen.circle(x - 70 * s, y + 18 * s, 44 * s, c, a);
  pen.circle(x + 72 * s, y + 14 * s, 50 * s, c, a);
  pen.rect(x - 110 * s, y + 10 * s, 230 * s, 50 * s, 25 * s, c, a);
}

function hills(pen: Pen, seed: number, base: number, height: number, color: string, shift: number, x0: number, x1: number): void {
  const pts: number[] = [];
  const n = 26;
  const span = x1 - x0;
  for (let i = 0; i <= n; i += 1) {
    const x = x0 + (span * i) / n;
    const u = (x + shift) / 520;
    const y = base - height * (0.55 + 0.25 * Math.sin(u * 1.3 + (seed % 9)) + 0.2 * Math.sin(u * 3.1 + (seed % 5)));
    pts.push(x, y);
  }
  pts.push(x1, base + 240, x0, base + 240);
  pen.poly(pts, color);
}

function outdoorSide(o: OutdoorLook, env: SetEnv): void {
  const { pen, t, seed } = env;
  const S = side();
  sky(pen, o);
  // sun or moon and stars, almost fixed
  env.layer(0.04);
  if (o.body === "sun") {
    const [sx, sy] = [X(820), Y(360)];
    pen.circle(sx, sy, 150, "#fff3b0", 0.18);
    pen.circle(sx, sy, 110, "#fff3b0", 0.3);
    pen.circle(sx, sy, 78, "#ffd54a");
  } else if (o.body === "moon") {
    const [mx, my] = [X(800), Y(330)];
    pen.circle(mx, my, 120, "#fff6e5", 0.08);
    pen.circle(mx, my, 70, "#fff6e5");
    pen.circle(mx - 22, my - 18, 14, "#e8dcc6");
    pen.circle(mx + 24, my + 22, 10, "#e8dcc6");
  }
  if (o.night) {
    pen.setMatrix([1, 0, 0, 1, 0, 0]);
    for (let i = 0; i < 22; i += 1) {
      const tw = 0.35 + 0.65 * Math.abs(Math.sin(t * (1 + rand(seed, i) * 2) + i));
      pen.poly(starPts(rand(seed, i + 30) * F.w, rand(seed, i + 60) * Y(900), 7 * tw, 2.4 * tw, 4, 0), "#fff6e5", 0.9);
    }
  }
  // clouds drift slowly
  env.layer(0.12);
  for (let i = 0; i < o.clouds; i += 1) {
    const x = mod(rand(seed, i + 90) * (F.w + 520) + t * (10 + i * 4) - env.scroll * 0.03, F.w + 820) - 400;
    cloud(pen, x, Y(180 + i * 150 + rand(seed, i + 95) * 80), 0.8 + rand(seed, i + 99) * 0.5, o.cloud, o.weather === "rain" ? 0.95 : 0.9);
  }
  // far hills or a skyline
  env.layer(0.25);
  const vx0 = -700;
  const vx1 = F.w + 700;
  if (o.decor === "city" || o.decor === "parking") {
    const far = o.decor === "city";
    for (let i = 0; i < (far ? 9 : 4) + more(230); i += 1) {
      const bw = 150 + rand(seed, i + 120) * 120;
      const bh = ((far ? 300 : 160) + rand(seed, i + 130) * (far ? 380 : 120)) * S.tall;
      const bx = mod(-260 + i * 230 - env.scroll * 0.25, F.w + 1220) - 600;
      const col = mix(o.hills[0], o.hills[1], rand(seed, i + 140));
      pen.rect(bx, S.verge - bh, bw, bh + 40, 10, col);
      for (let j = 0; j < 3; j += 1) pen.rect(bx + 24, S.verge - bh + 40 + j * 80, bw - 48, 28, 6, o.night ? "#ffd54a" : "#ffffff", o.night ? 0.7 : 0.28);
    }
  } else {
    hills(pen, seed, S.horizon + 40 * S.sy, 260 * S.tall, o.hills[0], env.scroll * 0.12, vx0, vx1);
    if (o.decor === "fields") {
      pen.rect(vx0, S.horizon - 10 * S.sy, vx1 - vx0, 90 * S.sy, 0, "#e9d27a");
      pen.rect(vx0, S.horizon + 40 * S.sy, vx1 - vx0, 50 * S.sy, 0, "#c6dd7c");
      const fx = mod(X(620) - env.scroll * 0.25, F.w + 1120) - 500;
      pen.rect(fx, S.horizon - 120, 150, 110, 8, "#ff6f61");
      pen.poly([fx - 20, S.horizon - 118, fx + 75, S.horizon - 190, fx + 170, S.horizon - 118], "#8a3b3b");
      pen.rect(fx + 55, S.horizon - 70, 40, 60, 6, "#fff6e5");
    }
  }
  env.layer(0.5);
  hills(pen, seed + 3, S.verge + 30 * S.sy, 150 * S.tall, o.hills[1], env.scroll * 0.5, -800, F.w + 800);
  // roadside things at mid depth
  drawDecor(o, env);
  // the ground the actors stand on
  env.layer(1);
  const gx0 = env.view.x0 - 200;
  const gw = env.view.x1 - env.view.x0 + 400;
  pen.rect(gx0, S.verge, gw, S.roadTop - S.verge + 10, 0, o.verge);
  if (o.decor === "parking") {
    pen.rect(gx0, S.roadTop, gw, F.h + 200 - S.roadTop, 0, o.road);
    for (const x of repeat(260, mod(-env.scroll, 260), env.view.x0, env.view.x1)) pen.line([x, S.roadTop + 40, x - 60, S.roadBottom], 10, o.lane, 0.85);
  } else {
    pen.rect(gx0, S.roadTop, gw, S.roadBottom - S.roadTop, 0, o.road);
    pen.rect(gx0, S.roadBottom, gw, F.h + 200 - S.roadBottom, 0, o.near);
    if (o.edge) {
      pen.rect(gx0, S.roadTop + 14, gw, 9, 0, o.edge, 0.85);
      pen.rect(gx0, S.roadBottom - 24, gw, 9, 0, o.edge, 0.85);
    }
    if (o.decor === "city") {
      pen.rect(gx0, S.roadTop - 6, gw, 14, 0, "#9aa1ae");
      pen.rect(gx0, S.roadBottom - 6, gw, 14, 0, "#9aa1ae");
    }
    const lanes = o.lanes === 2 ? [S.roadTop + 105 * S.sy, S.roadBottom - 105 * S.sy] : [S.lane];
    const dashA = o.surface === "snow" ? 0.45 : 1;
    for (const ly of lanes) {
      for (const x of repeat(250, mod(-env.scroll, 250), env.view.x0, env.view.x1, 14)) pen.rect(x, ly - 7, 140, 14, 7, o.lane, dashA);
    }
    surfaceSide(o, env);
  }
  if (o.decor === "highway") {
    // the crash barrier along the far edge
    pen.line([gx0, S.roadTop - 30, gx0 + gw, S.roadTop - 30], 12, "#c9d3de");
    for (const x of repeat(180, mod(-env.scroll, 180), env.view.x0, env.view.x1, 16 + more(180))) pen.rect(x - 5, S.roadTop - 34, 10, 40, 3, "#8b97a8");
  }
}

function drawDecor(o: OutdoorLook, env: SetEnv): void {
  const { pen } = env;
  env.layer(0.7);
  const scroll = env.scroll * 0.7;
  const S = side();
  const baseY = S.verge + 40 * S.sy;
  const xs = repeat(520, mod(-scroll + 140, 520), -400, F.w + 400, 6 + more(520));
  for (const [i, x] of xs.entries()) {
    const r = rand(env.seed + 7, Math.round((x + scroll) / 520) + 40);
    switch (o.decor) {
      case "trees":
      case "fields": {
        if (o.decor === "fields") {
          pen.rect(x - 4, baseY - 70, 10, 70, 3, "#a8683a");
          pen.line([x - 260, baseY - 52, x + 260, baseY - 52], 6, "#a8683a");
          pen.line([x - 260, baseY - 26, x + 260, baseY - 26], 6, "#a8683a");
          if (i % 2 === 1) break;
        }
        const s = 0.8 + r * 0.5;
        pen.rect(x - 12 * s, baseY - 120 * s, 24 * s, 120 * s, 8, "#7a4a2a");
        pen.circle(x, baseY - 170 * s, 82 * s, shade(o.hills[1], -0.12));
        pen.circle(x - 40 * s, baseY - 200 * s, 40 * s, shade(o.hills[1], 0.08), 0.8);
        break;
      }
      case "pines": {
        const s = 0.8 + r * 0.5;
        pen.rect(x - 10 * s, baseY - 60 * s, 20 * s, 60 * s, 6, "#7a4a2a");
        for (let k = 0; k < 2; k += 1) {
          const yy = baseY - 50 * s - k * 70 * s;
          pen.poly([x, yy - 130 * s, x + (100 - k * 25) * s, yy, x - (100 - k * 25) * s, yy], "#3b8a68");
          pen.poly([x, yy - 130 * s, x + 44 * s, yy - 72 * s, x - 44 * s, yy - 72 * s], "#ffffff");
        }
        break;
      }
      case "posts":
        pen.rect(x - 7, baseY - 70, 14, 70, 4, "#ffffff");
        pen.rect(x - 7, baseY - 62, 14, 14, 3, "#ff6f61");
        break;
      case "lamps":
      case "city":
      case "highway": {
        pen.rect(x - 7, baseY - 330, 14, 330, 5, o.night ? "#4b4f66" : "#8b97a8");
        pen.rect(x - 7, baseY - 330, 80, 14, 6, o.night ? "#4b4f66" : "#8b97a8");
        pen.ellipse(x + 64, baseY - 312, 24, 10, 0, o.night ? "#fff3b0" : "#e6ecf3");
        if (o.night) pen.poly([x + 44, baseY - 306, x + 84, baseY - 306, x + 190, baseY + 160, x - 62, baseY + 160], "#fff3b0", 0.12);
        break;
      }
      case "parking":
        break;
    }
  }
  if (o.decor === "parking") {
    env.layer(0.35);
    const bx = F.w / 2 - 400;
    pen.rect(bx, S.verge - 380, 800, 400, 18, "#e8eef5");
    pen.rect(bx, S.verge - 380, 800, 70, 18, "#ff6f61");
    pen.rect(bx + 330, S.verge - 200, 140, 220, 10, "#62c6ff");
    pen.rect(bx + 60, S.verge - 260, 200, 120, 10, "#9fdcff");
    pen.rect(bx + 540, S.verge - 260, 200, 120, 10, "#9fdcff");
  }
}

function surfaceSide(o: OutdoorLook, env: SetEnv): void {
  const { pen, t, seed } = env;
  const S = side();
  const x0 = env.view.x0;
  const x1 = env.view.x1;
  if (o.surface === "ice") {
    // shiny sheets of ice on the road, with glints that twinkle
    for (const x of repeat(620, mod(-env.scroll + 90, 620), x0, x1, 6 + more(620))) {
      const y = S.lane + 40 * S.sy + (rand(seed, Math.round(x)) - 0.5) * 60 * S.sy;
      pen.poly([x - 230, y + 30, x + 210, y + 22, x + 250, y - 18, x - 190, y - 26], "#dff4ff", 0.42);
      const tw = 0.3 + 0.7 * Math.abs(Math.sin(t * 2.2 + x * 0.01));
      pen.line([x - 120, y + 6, x + 40, y - 10], 6, "#ffffff", 0.7 * tw);
      pen.poly(starPts(x + 60, y - 12, 18 * tw, 4 * tw, 4, 0), "#ffffff", tw);
    }
    pen.rect(x0 - 200, S.roadTop - 16, x1 - x0 + 400, 22, 11, "#ffffff");
    pen.rect(x0 - 200, S.roadBottom - 6, x1 - x0 + 400, 22, 11, "#ffffff");
  } else if (o.surface === "snow") {
    for (const ly of [S.lane - 70 * S.sy, S.lane + 80 * S.sy]) {
      pen.rect(x0 - 200, ly - 14, x1 - x0 + 400, 28, 14, "#9aa6b4", 0.55);
    }
    pen.rect(x0 - 200, S.roadTop - 20, x1 - x0 + 400, 40, 20, "#ffffff");
    pen.rect(x0 - 200, S.roadBottom - 16, x1 - x0 + 400, 40, 20, "#ffffff");
  } else if (o.surface === "wet") {
    for (const x of repeat(300, mod(-env.scroll * 1 + 40, 300), x0, x1, 8 + more(300))) {
      pen.rect(x, S.roadTop + 60 * S.sy, 26, S.roadBottom - S.roadTop - 120 * S.sy, 13, "#c9d6e8", 0.1);
      const p = mod(t * 0.9 + x * 0.003, 1);
      pen.ellipse(x + 120, S.lane + 90 * S.sy, 30 + p * 70, 6 + p * 12, 0, "#ffffff", 0.35 * (1 - p));
    }
  }
}

function parkSide(env: SetEnv): void {
  const { pen, t, seed } = env;
  const S = side();
  sky(pen, { sky: ["#5cc2ff", "#d8f3ff"] });
  env.layer(0.04);
  pen.circle(X(820), Y(360), 110, "#fff3b0", 0.3);
  pen.circle(X(820), Y(360), 78, "#ffd54a");
  env.layer(0.12);
  for (let i = 0; i < 3; i += 1) cloud(pen, mod(rand(seed, i) * (F.w + 520) + t * 12, F.w + 820) - 400, Y(200 + i * 160), 0.9, "#ffffff", 0.9);
  env.layer(0.3);
  hills(pen, seed, S.horizon + 60 * S.sy, 220 * S.tall, "#a6dca4", env.scroll * 0.3, -700, F.w + 700);
  env.layer(0.6);
  for (let i = 0; i < 5 + more(360); i += 1) {
    const x = -200 + i * 360 + rand(seed, i + 3) * 80;
    pen.rect(x - 14, S.verge - 140, 28, 150, 8, "#7a4a2a");
    pen.circle(x, S.verge - 200, 100, "#4fae5f");
    pen.circle(x - 50, S.verge - 240, 54, "#6cc17a");
  }
  env.layer(0.85);
  const bx = X(700);
  pen.rect(bx, S.verge + 10, 240, 20, 8, "#a8683a");
  pen.rect(bx, S.verge - 40, 240, 16, 8, "#a8683a");
  pen.rect(bx + 16, S.verge + 28, 12, 50, 4, "#7a4a2a");
  pen.rect(bx + 212, S.verge + 28, 12, 50, 4, "#7a4a2a");
  env.layer(1);
  const gx0 = env.view.x0 - 200;
  const gw = env.view.x1 - env.view.x0 + 400;
  pen.rect(gx0, S.verge + 60 * S.sy, gw, F.h + 180 - S.verge, 0, "#7fcf6a");
  pen.rect(gx0, S.roadTop + 40 * S.sy, gw, 260 * S.sy, 130 * S.sy, "#ecd9a8");
  for (let i = 0; i < 9 + more(144); i += 1) {
    const x = rand(seed, i + 50) * (F.w + 220) - 100;
    const y = S.roadBottom + 40 * S.sy + rand(seed, i + 60) * 300 * S.sy;
    pen.circle(x, y, 12, ["#ff6f61", "#ffc94a", "#ffffff"][i % 3]!);
  }
}

function studioSide(env: SetEnv): void {
  const { pen, t, seed } = env;
  const S = side();
  pen.setMatrix([1, 0, 0, 1, 0, 0]);
  pen.grad(0, 0, 0, F.h, [
    [0, "#231e58"],
    [0.55, "#3a3288"],
    [1, "#1c1842"],
  ]);
  env.layer(0.3);
  for (let i = 0; i < 14; i += 1) {
    const tw = 0.3 + 0.7 * Math.abs(Math.sin(t * 1.4 + i * 1.3));
    pen.poly(starPts(rand(seed, i) * F.w, Y(120 + rand(seed, i + 20) * 900), 10 * tw, 3 * tw, 4, 0), i % 3 === 0 ? "#ffc94a" : "#fff6e5", 0.7);
  }
  env.layer(0.6);
  const sway = Math.sin(t * 0.6) * 40;
  const low = Y(1500);
  pen.poly([X(200), -40, X(300), -40, X(520) + sway, low, X(80) + sway, low], "#fff6e5", 0.09);
  pen.poly([X(780), -40, X(880), -40, X(1000) - sway, low, X(560) - sway, low], "#fff6e5", 0.09);
  env.layer(1);
  pen.rect(env.view.x0 - 200, S.verge + 40 * S.sy, env.view.x1 - env.view.x0 + 400, 1200, 0, "#2a2466");
  pen.ellipse(F.w / 2, S.lane + 20 * S.sy, 520, 120, 0, "#ffc94a", 0.13);
  pen.ellipse(F.w / 2, S.lane + 20 * S.sy, 330, 70, 0, "#fff6e5", 0.1);
}

function indoorSide(set: SetId, env: SetEnv): void {
  const { pen, t } = env;
  const wall = set === "kitchen" ? "#fff1d6" : set === "living_room" ? "#ffe0c2" : "#e3ecf7";
  const floor = set === "kitchen" ? "#f2c48d" : set === "living_room" ? "#c98d5a" : "#9fb0c4";
  const S = side();
  pen.setMatrix([1, 0, 0, 1, 0, 0]);
  pen.fill(wall);
  env.layer(0.85);
  const fy = S.roadTop - 20;
  // a window with sky in it
  const [wx, wy] = [X(110), Y(360)];
  pen.rect(wx, wy, 360, 400, 24, "#ffffff");
  pen.rect(wx + 18, wy + 18, 324, 364, 16, "#9fdcff");
  pen.circle(wx + 270, wy + 110, 40, "#ffd54a", 0.9);
  pen.rect(wx + 172, wy + 18, 16, 364, 0, "#ffffff");
  if (set === "office") for (let i = 0; i < 6; i += 1) pen.rect(wx + 18, wy + 30 + i * 58, 324, 20, 6, "#e3ecf7", 0.9);
  if (set === "kitchen") {
    const cx = X(480);
    for (let i = 0; i < 4; i += 1) pen.rect(cx + 40 + i * 120, fy - 470, 110, 70, 10, "#ffffff", 0.75);
    pen.rect(cx, fy - 300, 600, 300, 18, "#ffd9a8");
    pen.rect(cx - 20, fy - 320, 640, 34, 12, "#c98d5a");
    for (let i = 0; i < 3; i += 1) pen.rect(cx + 20 + i * 190, fy - 260, 160, 220, 14, "#ffcf91");
    pen.rect(-60, fy - 620, 200, 620, 24, "#e8eef5");
    pen.rect(110, fy - 560, 14, 120, 7, "#9aa6b4");
    const steam = (t * 0.6) % 1;
    pen.circle(cx + 220, fy - 360 - steam * 120, 20 + steam * 20, "#ffffff", 0.5 * (1 - steam));
  } else if (set === "living_room") {
    const [px, py] = [X(620), Y(330)];
    pen.rect(px, py, 220, 170, 12, "#ff6f61");
    pen.rect(px + 16, py + 16, 188, 138, 8, "#ffc94a");
    const sx = X(500);
    pen.rect(sx, fy - 250, 560, 170, 50, "#62c6ff");
    pen.rect(sx - 30, fy - 150, 620, 150, 40, "#4aa8e0");
    pen.rect(-20, fy - 430, 18, 430, 6, "#8b97a8");
    pen.poly([-80, fy - 540, 60, fy - 540, 30, fy - 430, -50, fy - 430], "#ffc94a");
  } else {
    const dx = X(560);
    pen.rect(dx, fy - 230, 520, 30, 10, "#a8683a");
    pen.rect(dx + 40, fy - 200, 24, 200, 8, "#7a4a2a");
    pen.rect(dx + 450, fy - 200, 24, 200, 8, "#7a4a2a");
    pen.rect(dx + 140, fy - 470, 300, 210, 16, "#2d3a55");
    pen.rect(dx + 156, fy - 454, 268, 178, 10, "#62c6ff");
    pen.rect(dx + 270, fy - 260, 40, 34, 4, "#5b6478");
    pen.rect(-30, fy - 160, 120, 160, 20, "#ff6f61");
    pen.circle(30, fy - 220, 80, "#47d6a0");
  }
  env.layer(1);
  const gx0 = env.view.x0 - 200;
  const gw = env.view.x1 - env.view.x0 + 400;
  pen.rect(gx0, fy, gw, 30, 0, shade(wall, -0.12));
  pen.rect(gx0, fy + 30, gw, F.h + 200 - fy, 0, floor);
  if (set === "kitchen") {
    for (let i = 0; i < 5; i += 1) pen.line([gx0, fy + 120 + i * 150, gx0 + gw, fy + 120 + i * 150], 4, shade(floor, -0.12), 0.6);
  } else {
    for (let i = 0; i < 6; i += 1) pen.line([gx0, fy + 90 + i * 120, gx0 + gw, fy + 90 + i * 120], 4, shade(floor, -0.15), 0.5);
  }
  if (set === "living_room") pen.ellipse(F.w / 2, S.lane + 40 * S.sy, 460, 110, 0, "#ff6f61", 0.3);
}

// ---- top views ----------------------------------------------------------------------------------------------

function drawTop(set: SetId, env: SetEnv): void {
  const { pen, t, seed } = env;
  const o = OUT[set];
  pen.setMatrix([1, 0, 0, 1, 0, 0]);
  if (!o) {
    // indoor, studio or park, seen from above: a floor pattern
    const floor = set === "park" ? "#7fcf6a" : set === "studio" ? "#241f58" : set === "kitchen" ? "#f2c48d" : set === "living_room" ? "#c98d5a" : "#9fb0c4";
    pen.fill(floor);
    env.layer(1);
    for (let i = 0; i < 8; i += 1) pen.line([-400, i * 280 + mod(env.scroll, 280), F.w + 400, i * 280 + mod(env.scroll, 280)], 5, shade(floor, -0.12), 0.5);
    if (set === "park") pen.rect(F.w / 2 - 160, -200, 320, F.h + 480, 160, "#ecd9a8");
    if (set === "studio") pen.circle(F.w / 2, F.h / 2, 420, "#ffc94a", 0.1);
    return;
  }
  const grass = o.decor === "city" ? "#b7bdc9" : o.decor === "parking" ? o.road : o.surface === "snow" || o.surface === "ice" ? "#f4fbff" : o.near;
  pen.fill(grass);
  env.layer(1);
  const y0 = env.view.y0 - 300;
  const y1 = env.view.y1 + 300;
  const scroll = env.scroll;
  if (o.decor === "parking") {
    for (let i = 0; i < 7; i += 1) {
      const y = mod(i * 320 + scroll, 2240) - 160;
      pen.line([X(60), y, X(380), y], 10, "#ffffff", 0.85);
      pen.line([X(700), y, X(1020), y], 10, "#ffffff", 0.85);
    }
    return;
  }
  const left = X(o.lanes === 2 ? 170 : o.decor === "fields" ? 330 : TOP.left);
  const right = X(o.lanes === 2 ? 910 : o.decor === "fields" ? 750 : TOP.right);
  if (o.decor === "fields") {
    for (let i = 0; i < 6; i += 1) {
      const y = mod(i * 380 + scroll * 1, 2280) - 180;
      pen.rect(-60, y, X(300) + 60, 180, 0, "#c6dd7c");
      pen.rect(X(780), y + 190, F.w + 60 - X(780), 180, 0, "#e9d27a");
    }
  }
  if (o.decor === "city") {
    pen.rect(-100, y0, left - 40 + 100, y1 - y0, 0, "#8796b8");
    pen.rect(right + 40, y0, F.w + 100 - right, y1 - y0, 0, "#8796b8");
    for (let i = 0; i < 5; i += 1) {
      const y = mod(i * 460 + scroll, 2300) - 200;
      pen.rect(-40, y, left - 90, 380, 16, "#a9b8d6");
      pen.rect(right + 90, y + 100, F.w + 40 - right - 90, 380, 16, "#a9b8d6");
    }
  }
  pen.rect(left - 30, y0, right - left + 60, y1 - y0, 0, shade(o.road, -0.2));
  pen.rect(left, y0, right - left, y1 - y0, 0, o.road);
  if (o.edge) {
    pen.rect(left + 14, y0, 10, y1 - y0, 0, o.edge, 0.9);
    pen.rect(right - 24, y0, 10, y1 - y0, 0, o.edge, 0.9);
  }
  const dashes = o.lanes === 2 ? [left + (right - left) / 3, left + (2 * (right - left)) / 3] : [(left + right) / 2];
  for (const lx of dashes) {
    for (let i = 0; i < 10; i += 1) {
      const y = mod(i * 240 + scroll, 2400) - 240;
      pen.rect(lx - 8, y, 16, 130, 8, o.lane, o.surface === "snow" ? 0.5 : 1);
    }
  }
  if (o.decor === "city") {
    const cy = mod(560 + scroll, 2600) - 300;
    for (let i = 0; i < 7; i += 1) pen.rect(left + 20 + i * ((right - left - 40) / 7), cy, (right - left - 40) / 7 - 26, 150, 6, "#ffffff", 0.9);
  }
  if (o.surface === "ice") {
    for (let i = 0; i < 4; i += 1) {
      const y = mod(i * 560 + scroll + rand(seed, i) * 200, 2240) - 160;
      const x = left + 60 + rand(seed, i + 7) * (right - left - 240);
      pen.ellipse(x + 90, y, 150, 90, 20, "#dff4ff", 0.55);
      const tw = 0.3 + 0.7 * Math.abs(Math.sin(t * 2 + i));
      pen.line([x + 20, y + 30, x + 140, y - 30], 7, "#ffffff", 0.7 * tw);
    }
    pen.rect(left - 60, y0, 50, y1 - y0, 25, "#ffffff");
    pen.rect(right + 10, y0, 50, y1 - y0, 25, "#ffffff");
  } else if (o.surface === "snow") {
    for (const lx of [left + (right - left) * 0.22, left + (right - left) * 0.36, left + (right - left) * 0.64, left + (right - left) * 0.78]) {
      pen.rect(lx - 14, y0, 28, y1 - y0, 14, "#9aa6b4", 0.5);
    }
  } else if (o.surface === "wet") {
    for (let i = 0; i < 3; i += 1) {
      const y = mod(i * 700 + scroll + 200, 2100) - 150;
      const x = left + 80 + rand(seed, i + 3) * (right - left - 200);
      const p = mod(t * 0.8 + i * 0.3, 1);
      pen.ellipse(x, y, 110, 70, 0, "#7aa7c7", 0.55);
      pen.ellipse(x, y, 30 + p * 70, 20 + p * 45, 0, "#ffffff", 0.4 * (1 - p));
    }
  }
  if (o.decor === "trees" || o.decor === "pines" || o.decor === "fields" || o.decor === "posts" || o.decor === "lamps") {
    for (let i = 0; i < 5; i += 1) {
      const y = mod(i * 480 + scroll + rand(seed, i + 20) * 120, 2400) - 240;
      for (const side of [-1, 1]) {
        const x = side < 0 ? left - 140 - rand(seed, i + 30) * 60 : right + 140 + rand(seed, i + 40) * 60;
        if (o.decor === "posts" || o.decor === "lamps") {
          pen.circle(x, y, 18, o.night ? "#fff3b0" : "#ffffff");
          if (o.night) pen.circle(x, y, 120, "#fff3b0", 0.1);
          continue;
        }
        const r = 90 + rand(seed, i + side + 50) * 30;
        pen.circle(x + 10, y + 12, r, "#000000", 0.15);
        pen.circle(x, y, r, o.decor === "pines" ? "#3b8a68" : shade(o.hills[1], -0.1));
        if (o.decor === "pines" || o.surface === "snow" || o.surface === "ice") pen.circle(x - r * 0.2, y - r * 0.2, r * 0.55, "#ffffff", 0.8);
        else pen.circle(x - r * 0.3, y - r * 0.3, r * 0.45, shade(o.hills[1], 0.15), 0.8);
      }
    }
  }
  if (o.weather === "fog") {
    for (let i = 0; i < 2; i += 1) pen.ellipse(mod(t * 40 + i * 600, F.w + 520) - 300, Y(500 + i * 800), 800, 260, 0, "#f2f5f8", 0.3);
  }
}
