// Lamo Stories › Settings' own styles (web/src/stories/styles/settings.css) keep the owner's rules (docs/CONTRACTS.md
// §45.16.2): the cursor never changes, no visible borders or outlines, radii from the --r-* scale, no type under
// 0.78rem, no dark-scheme rules, every selector under .stories-app or an st- class (nothing reaches Clip Factory),
// keyframes named st-…, tones used only as fills and marks (never for words), every control with a hover state, and
// the words on the sunshine and on each tinted chip and note at AA contrast over the stage.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(import.meta.dirname, "..", "src", "stories", "styles", "settings.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function rules(text: string): { selector: string; body: string }[] {
  return Array.from(text.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
}
function decls(body: string): [string, string][] {
  return body
    .split(/;(?![^(]*\))/)
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const at = d.indexOf(":");
      return [d.slice(0, at).trim().toLowerCase(), d.slice(at + 1).trim()] as [string, string];
    });
}

type Rgb = [number, number, number];
const hex = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
function colour(v: string): { rgb: Rgb; a: number } | null {
  const fallback = /var\(--[a-z0-9-]+,\s*(#[0-9a-f]{6})\)/i.exec(v)?.[1];
  const t = (fallback ?? v).trim();
  if (/^#[0-9a-f]{6}$/i.test(t)) return { rgb: hex(t), a: 1 };
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(t);
  return m ? { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a: m[4] === undefined ? 1 : Number(m[4]) } : null;
}
const over = (top: { rgb: Rgb; a: number }, under: Rgb): Rgb => top.rgb.map((c, i) => c * top.a + under[i]! * (1 - top.a)) as Rgb;
function luminance([r, g, b]: Rgb): number {
  const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const contrast = (a: Rgb, b: Rgb) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

describe("settings.css keeps the owner's rules", () => {
  it("never changes the cursor", () => {
    expect(CSS.match(/(^|[\s;{])cursor\s*:/g) ?? []).toEqual([]);
  });

  it("draws no borders or outlines", () => {
    const bad: string[] = [];
    for (const r of rules(CSS))
      for (const [k, v] of decls(r.body)) {
        const border = /^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-(width|style|color|image))?$/.test(k);
        const outline = /^outline(-(width|style))?$/.test(k);
        if ((border || outline) && !/^(none|0|0px|transparent|hidden)$/.test(v)) bad.push(`${r.selector} { ${k}: ${v} }`);
      }
    expect(bad).toEqual([]);
  });

  it("rounds corners from the --r-* scale", () => {
    const loose: string[] = [];
    for (const m of CSS.matchAll(/border(?:-[a-z-]+)?-radius:\s*([^;]+);/g))
      for (const part of m[1]!.replace(/calc\(var\(--r-[a-z]+\)[^)]*\)/g, "var(--r-sm)").split(/\s+/)) {
        if (/^var\(--r-(xs|sm|md|lg|xl|pill)\)$/.test(part) || /^(0|50%|inherit)$/.test(part)) continue;
        const px = /^(\d+(?:\.\d+)?)px$/.exec(part);
        if (px && Number(px[1]) < 8) continue;
        loose.push(m[0]);
      }
    expect(loose).toEqual([]);
  });

  it("sets no text under 0.78rem", () => {
    const tiny: string[] = [];
    for (const r of rules(CSS))
      for (const [k, v] of decls(r.body)) {
        if (k !== "font-size" && k !== "font") continue;
        const size = k === "font" ? v.split("/")[0]! : v;
        for (const m of size.matchAll(/(\d*\.?\d+)(rem|px|em)\b/g)) if ((m[2] === "px" ? Number(m[1]) < 12.5 : Number(m[1]) < 0.78)) tiny.push(`${r.selector} { ${k}: ${v} }`);
      }
    expect(tiny).toEqual([]);
  });

  it("is light only and keeps to Lamo Stories (no :root, html or body; every selector st- or under .stories-app)", () => {
    expect(CSS).not.toMatch(/prefers-color-scheme|color-scheme\s*:\s*dark/);
    const outside: string[] = [];
    for (const r of rules(CSS)) {
      if (/^(from|to|\d+%)(\s*,\s*(from|to|\d+%))*$/.test(r.selector)) continue;
      for (const sel of r.selector.split(",").map((s) => s.trim())) {
        if (/(^|[\s>+~])(:root|html|body)\b/.test(sel) || !/\.stories-app\b|\.st-[a-z]/.test(sel)) outside.push(sel);
      }
    }
    expect(outside).toEqual([]);
    for (const m of CSS.matchAll(/@keyframes\s+([a-z0-9-]+)/g)) expect(m[1]).toMatch(/^st-/);
  });

  it("uses the tones only as fills and marks, never as the colour of words", () => {
    const words: string[] = [];
    for (const r of rules(CSS)) for (const [k, v] of decls(r.body)) if (k === "color" && /var\(--st-(coral|mint|sky|sun)\)/.test(v)) words.push(r.selector);
    expect(words).toEqual([]);
  });

  it("gives every control a hover state", () => {
    const hovers = rules(CSS)
      .map((r) => r.selector)
      .join("\n");
    for (const control of ["st-stg-tab", "st-stg-pick__opt", "st-stg-switch", "st-stg-select", "st-stg-input", "st-stg-textarea", "st-stg-btn", "st-stg-btn--main", "st-stg-btn--quiet", "st-stg-btn--danger", "st-stg-round"])
      expect(hovers, control).toMatch(new RegExp(`\\.${control}[^\\n,{]*:hover`));
  });

  it("keeps phone targets 48 px and desktop ones 44 px", () => {
    const at = (sel: string) => rules(CSS).filter((r) => r.selector === sel);
    for (const sel of [".st-stg-tab", ".st-stg-pick__opt", ".st-stg-btn"]) {
      const base = at(sel).map((r) => Object.fromEntries(decls(r.body)));
      expect(base.some((d) => d["min-height"] === "48px" || d["min-height"] === "56px"), sel).toBe(true);
    }
  });

  it("puts AA words on every tinted chip and note, on the sunshine, and on the stage", () => {
    const stages: Rgb[] = [hex("#1c1842"), hex("#26205a")];
    const panel = { rgb: [255, 246, 229] as Rgb, a: 0.08 };
    const low: string[] = [];
    for (const r of rules(CSS)) {
      if (!/^\.st-stg-(chip|note)--[a-z]+$/.test(r.selector)) continue;
      const d = Object.fromEntries(decls(r.body));
      const fg = colour(d.color ?? "");
      const tint = colour(d.background ?? "");
      if (!fg || !tint) throw new Error(`${r.selector} has no colour or fill`);
      for (const s of stages) {
        const fill = over(tint, over(panel, s));
        const ratio = contrast(over(fg, fill), fill);
        if (ratio < 4.5) low.push(`${r.selector}: ${ratio.toFixed(2)}`);
      }
    }
    expect(low).toEqual([]);
    // Words on the sunshine (the chosen option, the main buttons) and the cream words on the stage.
    expect(contrast(hex("#1c1842"), hex("#ffc94a"))).toBeGreaterThanOrEqual(4.5);
    for (const s of stages) expect(contrast(over({ rgb: [255, 246, 229], a: 0.78 }, s), s)).toBeGreaterThanOrEqual(4.5);
  });
});
