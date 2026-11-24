// The phone's status bar (the clock, the Dynamic Island, the signal), which an installed iPhone app runs under, edge to
// edge (index.html: black-translucent, viewport-fit=cover; docs/CONTRACTS.md §11.1). The application shell's, for both
// apps (Clip Factory's Backdrop, Clips Funded's stage), so neither reads the other's code for it. It holds:
//
//   - how tall the status bar is right now (`--status-bar-h`, tokens.css: 0 on a computer, in Safari and on a phone
//     turned on its side), read from the page itself, and `<html data-status-bar>` while there is one;
//   - the shade each app's own backdrop carries under the clock where the look's top edge is too light for iOS's white
//     clock (statusShade): part of the backdrop, never a strip over the page;
//   - the lightest pixel of the owner's own picture where it lies under the clock (usePictureTop), so a picture gets
//     only the shade it needs (none at all when its top is dark), not one planned for white.
//
// Nothing fixed and coloured lies across the top (the owner, 24 Nov: "remove the top green top fixed color at the top,
// it just takes space and is unncessary"): what scrolls up to the clock fades into each app's own backdrop, drawn once
// more over the page in the status bar alone (Clip Factory's .backdrop--cover, Clips Funded's .stories-app::after).
import { useEffect, useState, useSyncExternalStore } from "react";

type Rgb = readonly [number, number, number];

/** The status bar right now: its height and the window's size (CSS px), all 0 while there is none. */
export interface StatusBar {
  readonly h: number;
  readonly w: number;
  readonly vh: number;
}

const NONE: StatusBar = { h: 0, w: 0, vh: 0 };
let bar: StatusBar = NONE;
const listeners = new Set<() => void>();

/** The status bar right now (NONE until installStatusBar runs, and on a computer). */
export function statusBar(): StatusBar {
  return bar;
}

function set(next: StatusBar, root: HTMLElement) {
  if (next.h === bar.h && (next.h === 0 || (next.w === bar.w && next.vh === bar.vh))) return;
  bar = next.h > 0 ? next : NONE;
  root.toggleAttribute("data-status-bar", bar.h > 0);
  for (const fn of listeners) fn();
}

/**
 * Follows the status bar's height (`--status-bar-h`: a phone turned, a check that simulates one) with a probe exactly
 * that tall, which nothing sees or taps (`measure` reads it). Run once before the first render (main.tsx), so an app
 * that opens under a status bar draws its backdrop's cover in its very first frame.
 */
export function installStatusBar(
  root: HTMLElement = document.documentElement,
  win: Window = window,
  measure: (probe: HTMLElement) => number = (probe) => probe.getBoundingClientRect().height,
): () => void {
  const doc = root.ownerDocument;
  const probe = doc.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.dataset.statusBarProbe = "";
  probe.style.cssText = "position:fixed;top:0;left:0;width:1px;height:var(--status-bar-h, 0px);visibility:hidden;pointer-events:none;contain:strict";
  (doc.body ?? root).append(probe);
  const read = () => set({ h: Math.round(measure(probe)), w: win.innerWidth, vh: win.innerHeight }, root);
  read();
  const watch = typeof ResizeObserver === "function" ? new ResizeObserver(read) : null;
  watch?.observe(probe);
  win.addEventListener("resize", read);
  return () => {
    watch?.disconnect();
    win.removeEventListener("resize", read);
    probe.remove();
    set(NONE, root);
  };
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The status bar, following it (a phone turned). */
export function useStatusBar(): StatusBar {
  return useSyncExternalStore(subscribe, statusBar, () => NONE);
}

// ---------- The shade under the clock ----------

/**
 * How the shade falls off (each app's backdrop draws it over a box twice the status bar's height, from the top): held
 * at its full strength under the clock and the icons (the bar's top 75 %: 37.5 % of the box), then easing out
 * (smoothstep, in eighths) to nothing a status bar's height below the bar, so it reads as the backdrop's own light
 * falling off, never as a band with an edge.
 */
export const SHADE_HOLD = 37.5;
export const SHADE_STEPS = 8;

/**
 * The shade's gradient for a scrim of `alpha` black (each app's own statusScrim: the least that keeps the white clock
 * at AA over its look's top edge), or "none" when the look needs none (the dark looks: nothing is drawn).
 */
export function statusShade(alpha: number): string {
  if (!(alpha > 0)) return "none";
  const stops = [`rgb(0 0 0 / ${round(alpha)}) ${SHADE_HOLD}%`];
  for (let i = 1; i < SHADE_STEPS; i++) {
    const t = i / SHADE_STEPS;
    stops.push(`rgb(0 0 0 / ${round(alpha * (1 - t * t * (3 - 2 * t)))}) ${round(SHADE_HOLD + (100 - SHADE_HOLD) * t)}%`);
  }
  stops.push("transparent");
  return `linear-gradient(${stops.join(", ")})`;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

// ---------- The owner's picture under the clock ----------

/** How a picture is laid on the screen: `background-size: cover`, centred, over the window grown by `bleed` each side. */
export interface PictureLayout {
  /** The window (CSS px). */
  w: number;
  vh: number;
  /** The status bar's height (CSS px). */
  bar: number;
  /** How far the picture's box runs past the window on every side, as a share of it (Clip Factory's: inset -2 %). */
  bleed: number;
}

/**
 * Where the window's top strip (0 to `bar`, the whole width) lies in a picture of `iw` x `ih` pixels: the source
 * rectangle a canvas draws it from, one canvas pixel per CSS px.
 */
export function pictureStrip(iw: number, ih: number, l: PictureLayout): { sx: number; sy: number; sw: number; sh: number } {
  const bw = l.w * (1 + 2 * l.bleed);
  const bh = l.vh * (1 + 2 * l.bleed);
  const scale = Math.max(bw / iw, bh / ih);
  const dx = -l.w * l.bleed + (bw - iw * scale) / 2;
  const dy = -l.vh * l.bleed + (bh - ih * scale) / 2;
  return { sx: (0 - dx) / scale, sy: (0 - dy) / scale, sw: l.w / scale, sh: l.bar / scale };
}

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** The lightest pixel of RGBA `data`. */
export function lightestPixel(data: ArrayLike<number>): Rgb | null {
  let best: Rgb | null = null;
  let most = -1;
  for (let i = 0; i + 2 < data.length; i += 4) {
    const px: Rgb = [data[i]!, data[i + 1]!, data[i + 2]!];
    const l = lum(px);
    if (l > most) [best, most] = [px, l];
  }
  return best;
}

/** The lightest pixel of the picture at `url` where it lies under the status bar, or null if it cannot be read. */
export async function pictureTopLightest(url: string, l: PictureLayout): Promise<Rgb | null> {
  if (typeof Image === "undefined" || typeof document === "undefined" || !(l.bar > 0) || !(l.w > 0) || !(l.vh > 0)) return null;
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) return null;
    const s = pictureStrip(img.naturalWidth, img.naturalHeight, l);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(l.w));
    canvas.height = Math.max(1, Math.round(l.bar));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, s.sx, s.sy, s.sw, s.sh, 0, 0, canvas.width, canvas.height);
    return lightestPixel(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  } catch {
    return null;
  }
}

/**
 * What is read of each picture, by its window, status bar and bleed: Clip Factory's and Clips Funded's own pictures at
 * most (an older picture lets go of its pixels' answer once two newer ones are read).
 */
const reads = new Map<string, Map<string, { done: Promise<Rgb | null>; top?: Rgb | null }>>();
const PICTURES_KEPT = 2;

function readPicture(url: string, key: string, l: PictureLayout) {
  let byLayout = reads.get(url);
  if (!byLayout) {
    byLayout = new Map();
    reads.set(url, byLayout);
    for (const old of reads.keys()) if (reads.size > PICTURES_KEPT && old !== url) reads.delete(old);
  }
  let read = byLayout.get(key);
  if (!read) {
    const entry: { done: Promise<Rgb | null>; top?: Rgb | null } = { done: pictureTopLightest(url, l) };
    void entry.done.then((top) => (entry.top = top));
    byLayout.set(key, entry);
    read = entry;
  }
  return read;
}

/**
 * The lightest pixel of the owner's picture under the status bar (`bleed`: how its app lays it, PictureLayout), or null
 * while there is no status bar, no picture, it is still being read, or it cannot be: each app then plans for white.
 */
export function usePictureTop(url: string | null, bleed: number): Rgb | null {
  const b = useStatusBar();
  const key = `${b.w}x${b.vh}|${b.h}|${bleed}`;
  const on = url !== null && url !== "" && b.h > 0;
  const [, redraw] = useState(0);
  useEffect(() => {
    if (!on) return;
    const read = readPicture(url, key, { w: b.w, vh: b.vh, bar: b.h, bleed });
    if ("top" in read) return;
    let live = true;
    void read.done.then(() => {
      if (live) redraw((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [on, url, key, b.w, b.vh, b.h, bleed]);
  return on ? (reads.get(url)?.get(key)?.top ?? null) : null;
}
