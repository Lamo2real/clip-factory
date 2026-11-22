// Lamo Stories' own look keeps the owner's rules (docs/CONTRACTS.md §45.16.2), over every file in
// web/src/stories/styles: the cursor never changes, no visible borders or outlines (shadows and fills instead, and no
// hairline inset shadow posing as one), corner
// radii from the --r-* scale, no type below 0.78rem, light only (no dark-scheme rules), nothing outside .stories-app
// (or an st- class), and AA contrast: every --st-* text colour on the stage and the panels, words on the sunshine
// and on each tinted chip, and the status fills at 3:1 where they are icons and marks.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(import.meta.dirname, "..", "src", "stories", "styles");
const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".css"))
  .map((f) => [f, readFileSync(join(DIR, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")] as const);

/** Every innermost `selector { declarations }` of a file (rules inside @media included). */
function rules(text: string): { selector: string; body: string }[] {
  return Array.from(text.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
}

function decls(body: string): [string, string][] {
  return body
    .split(";")
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
  const h = /^#([0-9a-f]{6})$/i.exec(v.trim());
  if (h) return { rgb: hex(v.trim()), a: 1 };
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v.trim());
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

/** The --st-* tokens declared on .stories-app, with var() references resolved. */
function tokens(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, text] of files) for (const r of rules(text)) if (r.selector === ".stories-app") for (const [k, v] of decls(r.body)) if (k.startsWith("--st-")) out.set(k, v);
  for (const [k, v] of out) {
    const ref = /^var\((--st-[a-z0-9-]+)\)$/.exec(v);
    if (ref && out.has(ref[1]!)) out.set(k, out.get(ref[1]!)!);
  }
  return out;
}

describe("the files", () => {
  it("are there (stories.css at least)", () => {
    expect(files.map(([f]) => f)).toContain("stories.css");
  });
});

describe("the owner's rules hold in Lamo Stories' styles", () => {
  it("never change the cursor", () => {
    for (const [f, text] of files) expect(text.match(/(^|[\s;{])cursor\s*:/g) ?? [], f).toEqual([]);
  });

  it("draw no borders or outlines (shadows and fills instead)", () => {
    const bad: string[] = [];
    for (const [f, text] of files)
      for (const r of rules(text))
        for (const [k, v] of decls(r.body)) {
          const border = /^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-(width|style|color|image))?$/.test(k);
          const outline = /^outline(-(width|style))?$/.test(k);
          if ((border || outline) && !/^(none|0|0px|transparent|hidden)$/.test(v)) bad.push(`${f}: ${r.selector} { ${k}: ${v} }`);
        }
    expect(bad).toEqual([]);
  });

  it("fake no border with a thin inset shadow either (a hairline ring reads as an edge)", () => {
    const rings: string[] = [];
    for (const [f, text] of files)
      for (const r of rules(text))
        for (const [k, v] of decls(r.body)) {
          if (k !== "box-shadow") continue;
          // Split on commas outside parentheses: each shadow on its own.
          for (const one of v.split(/,(?![^(]*\))/).map((x) => x.trim())) {
            if (!/\binset\b/.test(one)) continue;
            const lengths = one.replace(/rgba?\([^)]*\)|var\([^)]*\)|#[0-9a-f]+/gi, "").match(/-?\d*\.?\d+(px)?/g) ?? [];
            const [, , blur = "0", spread = "0"] = lengths.map((n) => n.replace("px", ""));
            if (Number(blur) <= 1 && Math.abs(Number(spread)) <= 2) rings.push(`${f}: ${r.selector} { box-shadow: ${one} }`);
          }
        }
    expect(rings).toEqual([]);
  });

  it("round corners from the --r-* scale (8 px and up never hard-coded)", () => {
    const loose: string[] = [];
    for (const [f, text] of files)
      for (const m of text.matchAll(/border(?:-[a-z-]+)?-radius:\s*([^;]+);/g))
        for (const part of m[1]!.replace(/calc\(var\(--r-[a-z]+\)[^)]*\)/g, "var(--r-sm)").split(/\s+/)) {
          if (/^var\(--r-(xs|sm|md|lg|xl|pill)\)$/.test(part) || /^(0|50%|inherit)$/.test(part)) continue;
          const px = /^(\d+(?:\.\d+)?)px$/.exec(part);
          if (px && Number(px[1]) < 8) continue;
          loose.push(`${f}: ${m[0]}`);
        }
    expect(loose).toEqual([]);
  });

  it("set no text smaller than 0.78rem (12.5 px)", () => {
    const tiny: string[] = [];
    for (const [f, text] of files)
      for (const r of rules(text))
        for (const [k, v] of decls(r.body)) {
          if (k !== "font-size" && k !== "font") continue;
          for (const m of v.matchAll(/(\d*\.?\d+)(rem|px|em)\b/g)) {
            const n = Number(m[1]);
            const small = m[2] === "px" ? n < 12.5 : n < 0.78;
            // In the `font` shorthand only the size before the slash counts (the line height may be 1).
            if (k === "font" && v.indexOf(m[0]) > v.indexOf("/") && v.includes("/")) continue;
            if (small) tiny.push(`${f}: ${r.selector} { ${k}: ${v} }`);
          }
        }
    expect(tiny).toEqual([]);
  });

  it("are light only: no dark-scheme rules", () => {
    for (const [f, text] of files) {
      expect(text, f).not.toMatch(/prefers-color-scheme/);
      expect(text, f).not.toMatch(/color-scheme\s*:\s*dark/);
    }
  });

  it("never reach a Lamo Clips screen: no :root, html or body rule, every selector under .stories-app or an st- class", () => {
    const outside: string[] = [];
    for (const [f, text] of files)
      for (const r of rules(text)) {
        if (/^(from|to|\d+%)(\s*,\s*(from|to|\d+%))*$/.test(r.selector)) continue; // keyframe steps
        for (const sel of r.selector.split(",").map((s) => s.trim())) {
          if (/(^|[\s>+~])(:root|html|body)\b/.test(sel)) outside.push(`${f}: ${sel}`);
          else if (!/\.stories-app\b|\.st-[a-z]/.test(sel)) outside.push(`${f}: ${sel}`);
        }
      }
    expect(outside).toEqual([]);
  });

  it("name every keyframes st-… (they share one page with Lamo Clips' own)", () => {
    for (const [f, text] of files) for (const m of text.matchAll(/@keyframes\s+([a-z0-9-]+)/g)) expect(m[1], f).toMatch(/^st-/);
  });
});

describe("contrast", () => {
  const t = tokens();
  const solid = (name: string): Rgb => {
    const c = colour(t.get(name) ?? "");
    expect(c, name).not.toBeNull();
    return c!.rgb;
  };
  const stages = ["--st-stage", "--st-stage-2"].map(solid);
  const panel = colour(t.get("--st-panel")!)!;
  /** The stage itself and the frosted panel laid over each stage colour. */
  const backgrounds: [string, Rgb][] = stages.flatMap((s, i) => [
    [`stage${i ? "-2" : ""}`, s] as [string, Rgb],
    [`panel on stage${i ? "-2" : ""}`, over(panel, s)] as [string, Rgb],
  ]);
  /** Fills that are never words: the stage, the panels, the shadows, and the status tones used for icons and marks. */
  const FILLS = /^--st-(stage|panel|shadow|on-)|^--st-(coral|mint|sky)$/;
  const colourTokens = [...t].filter(([, v]) => colour(v) !== null);

  it("finds the tokens", () => {
    for (const name of ["--st-stage", "--st-panel", "--st-ink", "--st-ink-soft", "--st-sun", "--st-on-sun", "--st-coral", "--st-mint", "--st-sky"]) expect(t.has(name), name).toBe(true);
  });

  it("every --st-* text colour reaches 4.5:1 on the stage and on the panels", () => {
    const low: string[] = [];
    for (const [name, value] of colourTokens) {
      if (FILLS.test(name)) continue;
      const c = colour(value)!;
      for (const [where, bg] of backgrounds) {
        const ratio = contrast(over(c, bg), bg);
        if (ratio < 4.5) low.push(`${name} on ${where}: ${ratio.toFixed(2)}`);
      }
    }
    expect(low).toEqual([]);
  });

  it("words on the sunshine (every main action) reach 4.5:1", () => {
    expect(contrast(solid("--st-on-sun"), solid("--st-sun"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(solid("--st-on-sun"), solid("--st-sun-hover"))).toBeGreaterThanOrEqual(4.5);
    // Coral, mint and sky fills carry the stage's colour for their words and glyphs too (buttons, counts, icons).
    for (const fill of ["--st-coral", "--st-mint", "--st-sky"]) expect(contrast(solid("--st-on-sun"), solid(fill)), fill).toBeGreaterThanOrEqual(4.5);
  });

  it("the status tones reach 3:1 as icons and marks on the stage and the panels", () => {
    for (const fill of ["--st-coral", "--st-mint", "--st-sky", "--st-sun"]) for (const [where, bg] of backgrounds) expect(contrast(solid(fill), bg), `${fill} on ${where}`).toBeGreaterThanOrEqual(3);
  });

  it("the status tones are never used for words, only for icons and marks", () => {
    const words: string[] = [];
    for (const [f, text] of files)
      for (const r of rules(text))
        for (const [k, v] of decls(r.body))
          if (k === "color" && /var\(--st-(coral|mint|sky)\)/.test(v) && !r.selector.split(",").every((s) => /icon|mark|\.st-icon/.test(s))) words.push(`${f}: ${r.selector}`);
    expect(words).toEqual([]);
  });

  it("chip and note words reach 4.5:1 on their tinted fills over the panels", () => {
    const low: string[] = [];
    for (const [f, text] of files)
      for (const r of rules(text)) {
        if (!/^\.st-(chip|note)--[a-z]+$/.test(r.selector)) continue;
        const d = Object.fromEntries(decls(r.body));
        const fg = /var\((--st-[a-z0-9-]+)\)/.exec(d.color ?? "")?.[1];
        const tint = colour(d.background ?? "");
        if (!fg || !tint) continue;
        const word = colour(t.get(fg)!)!;
        for (const [where, bg] of backgrounds) {
          const fill = over(tint, bg);
          const ratio = contrast(over(word, fill), fill);
          if (ratio < 4.5) low.push(`${f}: ${r.selector} on ${where}: ${ratio.toFixed(2)}`);
        }
      }
    expect(low).toEqual([]);
  });
});
