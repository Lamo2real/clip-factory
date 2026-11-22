// Lamo Stories' own look keeps the owner's rules (docs/CONTRACTS.md §45.16.2), over every file in
// web/src/stories/styles: the cursor never changes, no visible borders or outlines (shadows and fills instead, and no
// hairline inset shadow posing as one), corner
// radii from Stories' own --st-r-* scale (or the old --r-* scale while the screens move over to the liquid-glass
// contract, styles/GLASS-CONTRACT.md; the merge step makes it --st-r-* only), no type below 0.78rem, light only (no dark-scheme rules), nothing outside .stories-app
// (or an st- class), and AA contrast: every --st-* text colour on the stage and the panels, words on the sunshine
// and on each tinted chip, and the status fills at 3:1 where they are icons and marks.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
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

  it("round corners from the --st-r-* scale or, while the screens move over, the old --r-* one (8 px and up never hard-coded)", () => {
    const loose: string[] = [];
    for (const [f, text] of files)
      for (const m of text.matchAll(/border(?:-[a-z-]+)?-radius:\s*([^;]+);/g))
        for (const part of m[1]!.replace(/calc\(var\(--(?:st-)?r-[a-z]+\)[^)]*\)/g, "var(--r-sm)").split(/\s+/)) {
          if (/^var\(--r-(xs|sm|md|lg|xl|pill)\)$/.test(part) || /^var\(--st-r-(surface|control|inner|tiny|round)\)$/.test(part) || /^(0|50%|inherit)$/.test(part)) continue;
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
        if (r.selector === "@font-face") continue; // Stories' own fonts: checked on their own below
        for (const sel of r.selector.split(",").map((s) => s.trim())) {
          if (/(^|[\s>+~])(:root|html|body)\b/.test(sel)) outside.push(`${f}: ${sel}`);
          else if (!/\.stories-app\b|\.st-[a-z]/.test(sel)) outside.push(`${f}: ${sel}`);
        }
      }
    expect(outside).toEqual([]);
  });

  it("declare only Stories' own fonts (Playfair and Jost, from /fonts/stories/), never one of Clip Factory's names", () => {
    const faces = files.flatMap(([f, text]) => rules(text).filter((r) => r.selector === "@font-face").map((r) => [f, Object.fromEntries(decls(r.body))] as const));
    expect(faces.length).toBeGreaterThan(0);
    for (const [f, d] of faces) {
      expect(d["font-family"], f).toMatch(/^"(Playfair|Jost)"$/);
      expect(d.src, f).toMatch(/^url\("\/fonts\/stories\/[A-Za-z-]+\.woff2"\) format\("woff2"\)$/);
      expect(d["font-display"], f).toBe("swap");
    }
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
  const FILLS = /^--st-(stage|base|panel|shadow|on-)|^--st-(coral|mint|sky)$/;
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

  it("words on cream (the active pill, the cream card, the steppers) reach 4.5:1, the orange words too", () => {
    for (const fill of ["--st-cream", "--st-cream-2", "--st-cream-hover"])
      for (const word of ["--st-on-cream", "--st-on-cream-soft", "--st-on-cream-orange"]) expect(contrast(solid(word), solid(fill)), `${word} on ${fill}`).toBeGreaterThanOrEqual(4.5);
    // The bright accent is for shapes: glyphs on it are espresso.
    for (const fill of ["--st-accent", "--st-accent-hover", "--st-action", "--st-action-hover"]) expect(contrast(solid("--st-on-accent"), solid(fill)), fill).toBeGreaterThanOrEqual(4.5);
  });

  it("the base and glow colours stay dark and warm (a fill, never words)", () => {
    for (const name of ["--st-base", "--st-base-2", "--st-base-3"]) expect(luminance(solid(name)), name).toBeLessThan(0.02);
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

// ---------- The font files themselves (web/public/fonts/stories): read from the WOFF2 tables, no tools needed ----------

const FONTS = join(import.meta.dirname, "..", "public", "fonts", "stories");
const WOFF2_TAGS = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill"];

/** The variation axes (tag → [min, max]) and the code points among `want` that the font maps. */
function readWoff2(file: string, want: number[]): { axes: Record<string, [number, number]>; has: Set<number> } {
  const b = readFileSync(join(FONTS, file));
  expect(b.toString("latin1", 0, 4), file).toBe("wOF2");
  const numTables = b.readUInt16BE(12);
  const compressed = b.readUInt32BE(20);
  let p = 48;
  const u128 = () => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const x = b[p++]!;
      v = (v << 7) | (x & 0x7f);
      if (!(x & 0x80)) return v >>> 0;
    }
    return v >>> 0;
  };
  const tables: { tag: string; length: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const flags = b[p++]!;
    let tag = WOFF2_TAGS[flags & 0x3f] ?? "";
    if ((flags & 0x3f) === 63) {
      tag = b.toString("latin1", p, p + 4);
      p += 4;
    }
    const xf = (flags >> 6) & 3;
    const orig = u128();
    const transformed = tag === "glyf" || tag === "loca" ? xf === 0 : xf !== 0;
    tables.push({ tag, length: transformed ? u128() : orig });
  }
  const data = brotliDecompressSync(b.subarray(p, p + compressed));
  const at: Record<string, Buffer> = {};
  let off = 0;
  for (const t of tables) {
    at[t.tag] = data.subarray(off, off + t.length);
    off += t.length;
  }
  const axes: Record<string, [number, number]> = {};
  const f = at.fvar;
  if (f) {
    const first = f.readUInt16BE(4);
    const size = f.readUInt16BE(10);
    for (let i = 0; i < f.readUInt16BE(8); i++) {
      const o = first + i * size;
      axes[f.toString("latin1", o, o + 4)] = [f.readInt32BE(o + 4) / 65536, f.readInt32BE(o + 12) / 65536];
    }
  }
  const has = new Set<number>();
  const c = at.cmap!;
  for (let i = 0; i < c.readUInt16BE(2); i++) {
    const so = c.readUInt32BE(4 + i * 8 + 4);
    const fmt = c.readUInt16BE(so);
    if (fmt === 4) {
      const segs = c.readUInt16BE(so + 6) / 2;
      const ends = so + 14;
      const starts = ends + segs * 2 + 2;
      for (const cp of want) for (let s = 0; s < segs; s++) if (cp >= c.readUInt16BE(starts + s * 2) && cp <= c.readUInt16BE(ends + s * 2)) has.add(cp);
    } else if (fmt === 12) {
      for (let g = 0; g < c.readUInt32BE(so + 12); g++) {
        const lo = c.readUInt32BE(so + 16 + g * 12);
        const hi = c.readUInt32BE(so + 20 + g * 12);
        for (const cp of want) if (cp >= lo && cp <= hi) has.add(cp);
      }
    }
  }
  return { axes, has };
}

describe("Stories' own font files", () => {
  // å ä ö Å Ä Ö and the marks the words use (− – ’ … · ›)
  const WANT = [0xe5, 0xe4, 0xf6, 0xc5, 0xc4, 0xd6, 0x2212, 0x2013, 0x2019, 0x2026, 0xb7, 0x203a];

  it("keep each family's OFL licence beside it", () => {
    for (const f of ["OFL-Playfair.txt", "OFL-Jost.txt"]) {
      expect(existsSync(join(FONTS, f)), f).toBe(true);
      expect(readFileSync(join(FONTS, f), "utf8")).toMatch(/SIL OPEN FONT LICENSE/i);
    }
  });

  it("Playfair has an optical-size axis (high contrast at display sizes, sturdy at reading sizes), a width and a weight axis", () => {
    const { axes } = readWoff2("Playfair-latin.woff2", []);
    expect(axes.opsz![0]).toBeLessThanOrEqual(8);
    expect(axes.opsz![1]).toBeGreaterThanOrEqual(900);
    expect(axes.wdth![0]).toBeLessThanOrEqual(92);
    expect(axes.wght).toEqual([300, 900]);
  });

  it("the Latin files cover å ä ö and the marks the words use", () => {
    for (const f of ["Playfair-latin.woff2", "Jost-latin.woff2"]) {
      const { has } = readWoff2(f, WANT);
      expect(WANT.filter((cp) => !has.has(cp)).map((cp) => String.fromCodePoint(cp)), f).toEqual([]);
    }
  });
});
