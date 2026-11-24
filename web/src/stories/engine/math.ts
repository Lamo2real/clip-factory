// Lamo Stories engine: numbers, timing curves, seeded randomness and colours. Pure functions only (no Date, no
// Math.random): the same input always gives the same output in the browser and in Deno.

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 0 below `a`, 1 above `b`, smooth in between. */
export function smoothstep(a: number, b: number, v: number): number {
  const x = clamp01((v - a) / (b - a || 1));
  return x * x * (3 - 2 * x);
}

export type Ease = (t: number) => number;

export const ease = {
  linear: ((t) => clamp01(t)) as Ease,
  inQuad: ((t) => {
    const x = clamp01(t);
    return x * x;
  }) as Ease,
  outQuad: ((t) => {
    const x = clamp01(t);
    return 1 - (1 - x) * (1 - x);
  }) as Ease,
  inOutQuad: ((t) => {
    const x = clamp01(t);
    return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
  }) as Ease,
  inOutSine: ((t) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(t))) as Ease,
  outCubic: ((t) => 1 - Math.pow(1 - clamp01(t), 3)) as Ease,
  inCubic: ((t) => Math.pow(clamp01(t), 3)) as Ease,
  inOutCubic: ((t) => {
    const x = clamp01(t);
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  }) as Ease,
  outExpo: ((t) => {
    const x = clamp01(t);
    return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x);
  }) as Ease,
  outBack: ((t) => {
    const x = clamp01(t);
    const s = 1.70158;
    return 1 + (s + 1) * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2);
  }) as Ease,
  inBack: ((t) => {
    const x = clamp01(t);
    const s = 1.70158;
    return (s + 1) * x * x * x - s * x * x;
  }) as Ease,
  /** a slow start and a long, slightly springy settle (heavy things) */
  heavy: ((t) => {
    const x = clamp01(t);
    const base = x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    return base + 0.05 * Math.sin(Math.PI * x) * Math.sin(Math.PI * 2 * x) * (1 - x);
  }) as Ease,
};

/** A small seeded PRNG (mulberry32): the only randomness the engine may use. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over the parts: a stable 32-bit seed from names and numbers. */
export function hash(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A stateless random number in [0, 1) for (seed, i): particles without stepping a generator. */
export function rand(seed: number, i: number): number {
  let t = (seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
  t = Math.imul(t ^ (t >>> 16), 0x85ebca6b);
  t = Math.imul(t ^ (t >>> 13), 0xc2b2ae35);
  return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [-1, 1] over time: wobbles and camera shake. */
export function noise(seed: number, t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  return lerp(rand(seed, i) * 2 - 1, rand(seed, i + 1) * 2 - 1, u);
}

// ---- colours -------------------------------------------------------------------------------------------------

const HEX6 = /^#[0-9a-fA-F]{6}$/;

export function isHex(v: unknown): v is string {
  return typeof v === "string" && HEX6.test(v);
}

/** "#rrggbb" in lower case; anything else becomes the fallback. */
export function hex(v: string | undefined, fallback = "#ff6f61"): string {
  return isHex(v) ? v.toLowerCase() : fallback;
}

/** The red, green and blue of a colour, 0..255. */
export function channels(h: string): [number, number, number] {
  const n = parseInt(hex(h).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** "#rrggbb" from 0..255 channels, rounded and clamped. */
export function toHex(r: number, g: number, b: number): string {
  const c = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Mixes two colours (t = 0 → a, 1 → b). */
export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = channels(a);
  const [r2, g2, b2] = channels(b);
  const k = clamp01(t);
  return toHex(lerp(r1, r2, k), lerp(g1, g2, k), lerp(b1, b2, k));
}

/** Darker (k < 0, towards a deep indigo) or lighter (k > 0, towards white). */
export function shade(c: string, k: number): string {
  return k < 0 ? mix(c, "#120f2e", -k) : mix(c, "#ffffff", k);
}

/** Relative luminance 0..1 (sRGB). */
export function luminance(c: string): number {
  const [r, g, b] = channels(c).map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
