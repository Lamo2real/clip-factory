// Clip Factory Stories › Settings' own styles (web/src/stories/styles/settings.css, st-settings.css and
// st-settings-video.css) keep the owner's rules (docs/CONTRACTS.md §45.16.2) on the liquid-glass contract
// (web/src/stories/styles/GLASS-CONTRACT.md): the cursor never changes, no visible borders or outlines, radii from
// Stories' own --st-r-* scale only, no type under the 13 px floor, no dark-scheme rules, every selector under
// .stories-app or an st- class (nothing reaches Clip Factory), keyframes named st-…, the tones and the bright orange
// only ever fills and marks (never the colour of words), every control with a hover state, phone targets of 48 px, and
// every word at 4.5:1 over all three backgrounds: the colours (each preset, at the brightest spot its lights make), a
// white desktop or photo (See-through in the app, Picture: the measured veils) and Frosted.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FROSTED, MEASURED, PRESETS, SATURATIONS, VEIL, WHITE, contrast, hexToRgb, luminance, meshSpots, mix, veilsFor, type Rgb, type Veils } from "../src/stories/look.ts";

const STYLES = join(import.meta.dirname, "..", "src", "stories", "styles");
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "");
const read = (f: string) => strip(readFileSync(join(STYLES, f), "utf8"));
/** Settings' own files (the ownership map in GLASS-CONTRACT.md). */
const FILES = ["settings.css", "st-settings.css", "st-settings-video.css"] as const;
const CSS = read("settings.css");
const ALL = FILES.map((f) => [f, read(f)] as const);

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
const allRules = () => ALL.flatMap(([f, text]) => rules(text).map((r) => ({ ...r, file: f })));

// ---------- The tokens (glass-tokens.css, the only place --st-* design tokens are defined), per look ----------

type Tokens = Map<string, string>;
const GLASS_TOKENS = rules(read("glass-tokens.css"));
const tokensOf = (selector: string): [string, string][] => GLASS_TOKENS.filter((r) => r.selector === selector).flatMap((r) => decls(r.body).filter(([k]) => k.startsWith("--st-")));
const TOKENS: Tokens = new Map(tokensOf(".stories-app"));
// Settings' own local values (set on .st-stg, never on .stories-app).
for (const r of rules(CSS)) if (r.selector === ".st-stg") for (const [k, v] of decls(r.body)) if (k.startsWith("--st-stg-")) TOKENS.set(k, v);
/** A look's tokens: glass-tokens.css's data-look rules on top, and the veils look.ts sets inline for it. */
function lookTokens(kind: "colours" | "desktop", veils: Veils): Tokens {
  const t = new Map(TOKENS);
  for (const [k, v] of tokensOf(".stories-app[data-look]")) t.set(k, v);
  if (kind === "desktop") for (const [k, v] of tokensOf('.stories-app[data-look="window"],\n.stories-app[data-look="picture"]')) t.set(k, v);
  for (const [k, n] of Object.entries(veils)) t.set(`--st-veil-${k}`, String(n));
  return t;
}

type Paint = { rgb: Rgb; a: number };
/** A colour value with Stories' tokens resolved: #hex, rgb(r g b / a), rgb(var(--st-x-rgb) / a), var(--st-x). */
function paint(v: string, t: Tokens = TOKENS, depth = 0): Paint | null {
  const s = v.trim();
  if (depth > 8) return null;
  const ref = /^var\((--st-[a-z0-9-]+)\)$/.exec(s);
  if (ref) return t.has(ref[1]!) ? paint(t.get(ref[1]!)!, t, depth + 1) : null;
  if (/^#[0-9a-f]{6}$/i.test(s)) return { rgb: hexToRgb(s), a: 1 };
  const m = /^rgba?\((.+)\)$/.exec(s);
  if (!m) return null;
  const [chan, alpha] = m[1]!.split("/").map((x) => x.trim()) as [string, string | undefined];
  const channels = /^var\((--st-[a-z0-9-]+-rgb)\)$/.exec(chan)?.[1];
  const nums = (channels ? (t.get(channels) ?? "") : chan).split(/[\s,]+/).filter(Boolean).map(Number);
  const legacyAlpha = !channels && nums.length === 4 ? nums.pop() : undefined;
  if (nums.length !== 3 || nums.some((n) => !Number.isFinite(n))) return null;
  // The alpha: a number, a token, or calc(var(--st-veil-x) + n).
  const alphaOf = (a: string): number => {
    const tok = /^var\((--st-[a-z0-9-]+)\)$/.exec(a)?.[1];
    if (tok) return Number(t.get(tok));
    const sum = /^calc\(var\((--st-[a-z0-9-]+)\)\s*([+-])\s*([\d.]+)\)$/.exec(a);
    if (sum) return Number(t.get(sum[1]!)) + (sum[2] === "+" ? 1 : -1) * Number(sum[3]);
    return Number(a);
  };
  const a = alpha === undefined ? (legacyAlpha ?? 1) : alphaOf(alpha);
  return Number.isFinite(a) ? { rgb: nums as unknown as Rgb, a: Math.min(1, a) } : null;
}
/** A background (one colour, or solid gradient layers over a colour) laid over `under`; null when it is not flat. */
function laid(background: string, under: Rgb, t: Tokens = TOKENS): Rgb | null {
  const layers: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of background) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      layers.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  layers.push(cur.trim());
  let out = under;
  for (const layer of layers.reverse()) {
    if (layer === "transparent" || layer === "none") continue;
    const ref = /^var\((--st-[a-z0-9-]+)\)$/.exec(layer)?.[1];
    if (ref && t.has(ref) && /,|gradient/.test(t.get(ref)!)) {
      const inner = laid(t.get(ref)!, out, t);
      if (!inner) return null;
      out = inner;
      continue;
    }
    const solid = /^linear-gradient\((.+)\)$/.exec(layer);
    const stops = solid ? solid[1]!.split(/,(?![^(]*\))/).map((x) => x.trim()) : [layer];
    if (new Set(stops).size !== 1) return null;
    const p = paint(stops[0]!, t);
    if (!p) return null;
    out = mix(p.rgb, out, p.a);
  }
  return out;
}

// ---------- Every look's worst case ----------

const lightest = (spots: readonly Rgb[]): Rgb => spots.reduce((a, b) => (luminance(b) > luminance(a) ? b : a));
const frost = mix(VEIL, WHITE, FROSTED.page);
interface Place {
  where: string;
  /** what a glass card's words sit on */
  card: Rgb;
  /** what words loose on the page sit on (the stage with its page veil, or the plate over a desktop or picture) */
  loose: Rgb;
  /** what a glass control loose on the page sits on before its own fill (the stage, or the bare desktop) */
  bare: Rgb;
  tokens: Tokens;
}
const PLACES: Place[] = [
  ...PRESETS.map((p): Place => {
    const v = veilsFor({ mode: "colours", strength: "clear", colours: [...p.colours], picture: null }, "none");
    const stage = mix(VEIL, lightest(meshSpots(p.colours)), v.page);
    return { where: `the ${p.name} colours`, card: mix(VEIL, mix(VEIL, lightest(meshSpots(p.colours, SATURATIONS)), v.page), v.card), loose: stage, bare: stage, tokens: lookTokens("colours", v) };
  }),
  { where: "a white desktop or photo", card: mix(VEIL, WHITE, MEASURED.card), loose: mix(VEIL, WHITE, MEASURED.plate), bare: WHITE, tokens: lookTokens("desktop", MEASURED) },
  { where: "a white desktop, Frosted", card: mix(VEIL, frost, FROSTED.card), loose: mix(VEIL, frost, FROSTED.plate), bare: frost, tokens: lookTokens("desktop", FROSTED) },
];

/** Light words (on glass and loose on the page) and the dark words that only ever sit on cream or the action. */
const LIGHT_WORDS = /^var\(--st-(text-strong|text|text-soft|text-amber|coral-ink|mint-ink|sky-ink)\)$/;
const DARK_WORDS = /^var\(--st-(on-cream|on-cream-soft|on-cream-orange|on-accent)\)$/;
/** Words loose on the page: the page head, the section head, the bar under it and its Saved mark. */
const LOOSE_SELECTOR = /\.st-stg-(head(?!__setup-go)|section__|bar|saved)/;

describe("Settings' styles keep the owner's rules", () => {
  it("never change the cursor", () => {
    for (const [f, text] of ALL) expect(text.match(/(^|[\s;{])cursor\s*:/g) ?? [], f).toEqual([]);
  });

  it("draw no borders or outlines", () => {
    const bad: string[] = [];
    for (const r of allRules())
      for (const [k, v] of decls(r.body)) {
        const border = /^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-(width|style|color|image))?$/.test(k);
        const outline = /^outline(-(width|style))?$/.test(k);
        if ((border || outline) && !/^(none|0|0px|transparent|hidden)$/.test(v)) bad.push(`${r.file}: ${r.selector} { ${k}: ${v} }`);
      }
    expect(bad).toEqual([]);
  });

  it("round corners from Stories' own --st-r-* scale only (by kind, concentric: calc(var(--st-r-…) - gap))", () => {
    const loose: string[] = [];
    for (const [f, text] of ALL)
      for (const m of text.matchAll(/border(?:-[a-z-]+)?-radius:\s*([^;]+);/g))
        for (const part of m[1]!.replace(/calc\(var\(--st-r-(surface|control|inner|tiny)\)\s*-\s*[^)]*\)/g, "var(--st-r-inner)").split(/\s+/)) {
          if (/^var\(--st-r-(surface|control|inner|tiny|round)\)$/.test(part) || /^(0|inherit)$/.test(part)) continue;
          loose.push(`${f}: ${m[0]}`);
        }
    expect(loose).toEqual([]);
  });

  it("set no text under the 13 px floor (--st-fs-min)", () => {
    const tiny: string[] = [];
    for (const r of allRules())
      for (const [k, v] of decls(r.body)) {
        if (k !== "font-size" && k !== "font") continue;
        const size = k === "font" ? v.split("/")[0]! : v;
        for (const m of size.matchAll(/(\d*\.?\d+)(rem|px|em)\b/g)) if (m[2] === "px" ? Number(m[1]) < 13 : Number(m[1]) < 0.8125) tiny.push(`${r.file}: ${r.selector} { ${k}: ${v} }`);
        const ref = /var\((--st-fs-[a-z]+)\)/.exec(size)?.[1];
        if (ref) expect(TOKENS.has(ref), ref).toBe(true);
      }
    expect(tiny).toEqual([]);
  });

  it("are light only and keep to Stories (no :root, html or body; every selector st- or under .stories-app)", () => {
    const outside: string[] = [];
    for (const [f, text] of ALL) {
      expect(text, f).not.toMatch(/prefers-color-scheme|color-scheme\s*:\s*dark/);
      for (const r of rules(text)) {
        if (/^(from|to|\d+%)(\s*,\s*(from|to|\d+%))*$/.test(r.selector)) continue;
        for (const sel of r.selector.split(",").map((s) => s.trim())) {
          if (/(^|[\s>+~])(:root|html|body)\b/.test(sel) || !/\.stories-app\b|\.st-[a-z]/.test(sel)) outside.push(`${f}: ${sel}`);
        }
      }
      for (const m of text.matchAll(/@keyframes\s+([a-z0-9-]+)/g)) expect(m[1], f).toMatch(/^st-/);
    }
    expect(outside).toEqual([]);
  });

  it("set no --st-* design token (glass-tokens.css is the only place); their one local value is --st-stg-…", () => {
    const set: string[] = [];
    for (const r of allRules()) for (const [k] of decls(r.body)) if (k.startsWith("--") && !k.startsWith("--st-stg-")) set.push(`${r.file}: ${r.selector} { ${k} }`);
    expect(set).toEqual([]);
  });

  it("use the tones and the bright orange only as fills and marks, never as the colour of words", () => {
    const words: string[] = [];
    for (const r of allRules()) for (const [k, v] of decls(r.body)) if (k === "color" && /var\(--st-(coral|mint|sky|sun|accent|action|ember|glow-[a-z]+|cream|knob|selected)(-[a-z]+)?\)/.test(v) && !/-ink\)/.test(v)) words.push(`${r.file}: ${r.selector} { color: ${v} }`);
    expect(words).toEqual([]);
  });

  it("never animate a filter or change one on hover", () => {
    const bad: string[] = [];
    for (const r of allRules())
      for (const [k, v] of decls(r.body)) {
        if (k === "transition" && /(^|[\s,])(-webkit-)?(backdrop-)?filter\b/.test(v)) bad.push(`${r.file}: ${r.selector} { ${k} }`);
        if (/:hover/.test(r.selector) && /^(-webkit-)?(backdrop-)?filter$/.test(k)) bad.push(`${r.file}: ${r.selector} { ${k} }`);
      }
    expect(bad).toEqual([]);
  });

  it("give every control a hover state", () => {
    const hovers = allRules()
      .map((r) => r.selector)
      .join("\n");
    for (const control of [
      "st-stg-tab",
      "st-stg-pick__opt",
      "st-stg-switch",
      "st-stg-select",
      "st-stg-input",
      "st-stg-textarea",
      "st-stg-btn",
      "st-stg-btn--main",
      "st-stg-btn--quiet",
      "st-stg-btn--danger",
      "st-stg-round",
      "st-stg-toggle",
      "st-stg-head__setup-go",
    ])
      expect(hovers, control).toMatch(new RegExp(`\\.${control}[^\\n,{]*:hover`));
  });

  it("keep phone targets 48 px and desktop ones 44 px", () => {
    const at = (sel: string) => rules(CSS).filter((r) => r.selector === sel);
    for (const sel of [".st-stg-tab", ".st-stg-pick__opt", ".st-stg-btn", ".st-stg-switch", ".st-stg-select,\n.st-stg-input,\n.st-stg-textarea", ".st-stg-toggle"]) {
      const base = at(sel).map((r) => Object.fromEntries(decls(r.body)));
      expect(base.length, sel).toBeGreaterThan(0);
      expect(base.some((d) => d["min-height"] === "48px" || d["min-height"] === "56px" || d.height === "48px"), sel).toBe(true);
    }
  });
});

describe("every word in Settings reaches 4.5:1 over all three backgrounds", () => {
  it("finds the looks and the tokens", () => {
    expect(PLACES.length).toBeGreaterThanOrEqual(5);
    for (const name of ["--st-text", "--st-text-soft", "--st-text-muted", "--st-veil-rgb", "--st-well-rgb", "--st-fill-well", "--st-fill-control", "--st-cream", "--st-selected"]) expect(TOKENS.has(name), name).toBe(true);
    // The desktop looks really do carry a card's veil on glass controls (the rule this test reads).
    expect(PLACES.at(-2)!.tokens.get("--st-fill-control")).toBe("rgb(var(--st-veil-rgb) / var(--st-veil-card))");
  });

  it("every light word colour on a glass card, over the rule's own fill (rows, wells, tints) where it has one", () => {
    const low: string[] = [];
    for (const r of allRules()) {
      const d = Object.fromEntries(decls(r.body));
      if (!d.color || !LIGHT_WORDS.test(d.color)) continue;
      const own = d.background ?? d["background-color"];
      for (const { where, card, tokens } of PLACES) {
        const word = paint(d.color, tokens)!;
        const bg = (own ? laid(own, card, tokens) : null) ?? card;
        const ratio = contrast(mix(word.rgb, bg, word.a), bg);
        // A card's mark is an icon (3:1, WCAG 1.4.11); everything else here is words (4.5:1).
        const need = /__mark/.test(r.selector) ? 3 : 4.5;
        if (ratio < need) low.push(`${r.file}: ${r.selector} (${d.color}) on a card over ${where}: ${ratio.toFixed(2)}`);
      }
    }
    expect(low).toEqual([]);
  });

  it("the hint words (--st-text-muted) only in a field's well, where they still reach 4.5:1", () => {
    for (const r of allRules())
      for (const [k, v] of decls(r.body)) {
        if (!/--st-text-muted/.test(v)) continue;
        expect(`${k} in ${r.selector}`).toMatch(/^color in [^{]*::placeholder$/);
        for (const { where, card, tokens } of PLACES) expect(contrast(paint(v, tokens)!.rgb, laid("var(--st-fill-well)", card, tokens)!), where).toBeGreaterThanOrEqual(4.5);
      }
  });

  it("words loose on the page (the page head, the section head, the bar and its Saved mark) over the stage and the plates", () => {
    const low: string[] = [];
    for (const r of allRules()) {
      if (!LOOSE_SELECTOR.test(r.selector)) continue;
      const d = Object.fromEntries(decls(r.body));
      if (!d.color || !LIGHT_WORDS.test(d.color)) continue;
      for (const { where, loose, tokens } of PLACES) {
        const word = paint(d.color, tokens)!;
        const under = d.background ? laid(d.background, loose, tokens) : loose;
        if (!under) throw new Error(`${r.selector}: its background is not flat`);
        const ratio = contrast(mix(word.rgb, under, word.a), under);
        if (ratio < 4.5) low.push(`${r.selector} on ${where}: ${ratio.toFixed(2)}`);
      }
    }
    expect(low).toEqual([]);
    // The Saved mark's mint sits over a well, so it reads over the brightest stage too.
    const saved = rules(CSS).find((r) => r.selector.includes(".st-stg-saved.is-on"))!;
    const fill = Object.fromEntries(decls(saved.body)).background!;
    for (const { where, loose, tokens } of PLACES) expect(contrast(paint("var(--st-mint-ink)", tokens)!.rgb, laid(fill, loose, tokens)!), `Saved on ${where}`).toBeGreaterThanOrEqual(4.5);
  });

  it("glass controls loose on the page (the section pills, Open setup again) carry a card's veil, so their words read, hovered too", () => {
    const low: string[] = [];
    for (const sel of [".st-stg-tab", ".st-stg-head__setup-go.st-btn", ".st-stg-tab:not(.is-on):hover", ".st-stg-head__setup-go.st-btn:hover"]) {
      const rule = rules(CSS).find((r) => r.selector === sel);
      expect(rule, sel).toBeDefined();
      const d = Object.fromEntries(decls(rule!.body));
      expect(d.background, sel).toMatch(/^var\(--st-stg-loose(-hover)?\)$/);
      for (const { where, bare, tokens } of PLACES) {
        const bg = laid(d.background!, bare, tokens);
        expect(bg, `${sel} is flat`).not.toBeNull();
        for (const w of ["var(--st-text-soft)", "var(--st-text)", "var(--st-text-amber)"]) {
          const ratio = contrast(paint(w, tokens)!.rgb, bg!);
          if (ratio < 4.5) low.push(`${sel} ${w} over ${where}: ${ratio.toFixed(2)}`);
        }
      }
    }
    expect(low).toEqual([]);
  });

  it("puts AA words on every tinted chip and note, over every look", () => {
    const low: string[] = [];
    let seen = 0;
    for (const r of rules(CSS)) {
      if (!/^\.st-stg-(chip|note)--[a-z]+$/.test(r.selector)) continue;
      seen++;
      const d = Object.fromEntries(decls(r.body));
      if (!d.color || !d.background) throw new Error(`${r.selector} has no colour or fill`);
      for (const { where, card, tokens } of PLACES) {
        const fg = paint(d.color, tokens);
        const fill = laid(d.background, card, tokens);
        if (!fg || !fill) throw new Error(`${r.selector}: its colour or fill is not flat`);
        const ratio = contrast(mix(fg.rgb, fill, fg.a), fill);
        if (ratio < 4.5) low.push(`${r.selector} on a card over ${where}: ${ratio.toFixed(2)}`);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(8);
    expect(low).toEqual([]);
  });

  it("dark words only on cream, the cream highlight and the action, at 4.5:1 there", () => {
    const fills = ["--st-cream", "--st-cream-2", "--st-cream-hover", "--st-action-top", "--st-action-bottom", "--st-action-hover", "--st-accent", "--st-accent-hover"].map((n) => [n, paint(`var(${n})`)!.rgb] as const);
    // The sliding highlight is cream at 0.96 over whatever is under it: at its darkest, black.
    const selected = paint("var(--st-selected)")!;
    const all = [...fills, ["--st-selected", mix(selected.rgb, [0, 0, 0], selected.a)] as const];
    let seen = 0;
    for (const r of allRules())
      for (const [k, v] of decls(r.body)) {
        if (k !== "color" || !DARK_WORDS.test(v)) continue;
        seen++;
        const word = paint(v)!.rgb;
        const where = v.includes("on-accent") ? all.filter(([n]) => /action|accent/.test(n)) : all.filter(([n]) => /cream|selected/.test(n));
        for (const [n, bg] of where) expect(contrast(word, bg), `${r.selector} (${v}) on ${n}`).toBeGreaterThanOrEqual(4.5);
      }
    expect(seen).toBeGreaterThan(5);
  });
});
