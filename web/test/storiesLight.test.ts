// The logic of light in Clip Factory Stories (the owner, 22 Nov: "the top layer is always brighter than the bottom,
// growing gradually in between", and more liquid glass; styles/GLASS-CONTRACT.md, Elevation), proven from the style
// sheets alone, without a browser: the elevation tokens and every glass fill are read from glass-tokens.css and
// worked out exactly as the browser does (var() substituted with each look's veils as look.ts sets them, calc()
// evaluated, gradients top and bottom, layers composited in sRGB). Then:
// - each level is brighter than the one under it (relative luminance), at its top and at its bottom, over the espresso
//   (the stage's own colour) and black, in every look: the colours (Ember, Rose, Lagoon, the owner's own),
//   a picture, See-through Clear and Frosted, and solid glass (reduced transparency); a control is brighter than the
//   surface it sits on;
// - over a light backdrop (a white or mid-grey picture or desktop) the light keeps its order (the owner's rule, Clip
//   Factory's own): from the page panel upward every level is at least LIGHT_STEP (+0.015) brighter than the one under
//   it over white, and brighter over mid grey; only the page-to-panel step may go darker, where AA needs the veil;
// - every surface is lighter at its top, and has a bright top rim, brighter on higher levels;
// - every word keeps 4.5:1 at the brightest part of each surface (its top) and at its bottom, over the lightest pixel
//   each look can show (the stage's lights, a white or busy picture or desktop, a cream card under a bar or a sheet);
// - the glass classes and the screens' own surfaces lay their level's light.
// e2e/stories-light.spec.ts measures the same on the pages.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CREAM,
  ELEVATION,
  ELEVATION_TOP,
  EMBER,
  FROSTED,
  INKS,
  KIND_LEVEL,
  LIGHT_STEP,
  MEASURED,
  PRESETS,
  SOLID_PAGE,
  VEIL,
  WHITE,
  contrast,
  hexToRgb,
  lit,
  luminance,
  mix,
  saturateRgb,
  solidVeils,
  stageSpots,
  veilsFor,
  type Rgb,
  type Veils,
} from "../src/stories/look.ts";
import { middleVeil } from "../src/stories/glass/lens.ts";

const DIR = join(import.meta.dirname, "..", "src", "stories", "styles");
const read = (f: string) => readFileSync(join(DIR, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const TOKENS = read("glass-tokens.css");
const GLASS = read("glass.css");

// ---------- A small CSS evaluator: custom properties, var(), calc(), rgb(), linear-gradient() ----------

/** The declarations of the first rule with exactly this selector. */
function rule(css: string, selector: string): Map<string, string> {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule ${selector}`);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  const out = new Map<string, string>();
  for (const d of body.split(";")) {
    const i = d.indexOf(":");
    if (i > 0) out.set(d.slice(0, i).trim(), d.slice(i + 1).trim().replace(/\s+/g, " "));
  }
  return out;
}
const BASE = rule(TOKENS, ".stories-app");
const OVER_PICTURES = rule(TOKENS, '.stories-app[data-look="window"],\n.stories-app[data-look="picture"]');
const FIGURE_INSIDE = rule(TOKENS, '.stories-app:is([data-look="window"], [data-look="picture"]) :is(.st-glass:not(.st-glass--control), .st-plate)');

/** The matching close paren of the open paren at `open`. */
function close(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  throw new Error(`unbalanced: ${s}`);
}
/** Split at top-level commas. */
function split(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
/** Every var() substituted from `env` (with its fallback when unset), recursively. */
function subst(value: string, env: Map<string, string>, depth = 0): string {
  if (depth > 40) throw new Error(`var() loop in ${value}`);
  const at = value.indexOf("var(");
  if (at < 0) return value;
  const end = close(value, at + 3);
  const [name, ...fallback] = split(value.slice(at + 4, end));
  const got = env.get(name!) ?? (fallback.length ? fallback.join(", ") : undefined);
  if (got === undefined) throw new Error(`${name} is not defined`);
  return subst(value.slice(0, at) + subst(got, env, depth + 1) + value.slice(end + 1), env, depth + 1);
}
/** A calc() body: numbers, + - * / and parentheses. */
function arith(src: string): number {
  const t = src.match(/\d*\.?\d+(?:e-?\d+)?|[-+*/()]/g) ?? [];
  let i = 0;
  const expr = (): number => {
    let v = term();
    while (t[i] === "+" || t[i] === "-") v = t[i++] === "+" ? v + term() : v - term();
    return v;
  };
  const term = (): number => {
    let v = factor();
    while (t[i] === "*" || t[i] === "/") v = t[i++] === "*" ? v * factor() : v / factor();
    return v;
  };
  const factor = (): number => {
    const tok = t[i++];
    if (tok === "(") {
      const v = expr();
      i++;
      return v;
    }
    if (tok === "-") return -factor();
    return Number(tok);
  };
  return expr();
}
function calcs(s: string): string {
  for (let at = s.indexOf("calc("); at >= 0; at = s.indexOf("calc(")) {
    const end = close(s, at + 4);
    s = s.slice(0, at) + String(arith(s.slice(at + 5, end))) + s.slice(end + 1);
  }
  return s;
}
type Rgba = [number, number, number, number];
function colour(s: string): Rgba {
  const m = /^rgb\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.e-]+))?\s*\)/.exec(s.trim());
  if (!m) throw new Error(`not a colour: ${s}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Math.max(0, Math.min(1, m[4] === undefined ? 1 : Number(m[4])))];
}
type Layer = { top: Rgba; bottom: Rgba };
/** The layers of a background value (the top one first): a colour, or a linear gradient's first and last stop. */
function layers(value: string, env: Map<string, string>): Layer[] {
  return split(calcs(subst(value, env))).map((part) => {
    if (part.startsWith("linear-gradient(")) {
      const stops = split(part.slice(16, close(part, 15))).filter((a) => !/^-?[\d.]+deg$/.test(a) && !a.startsWith("to "));
      return { top: colour(stops[0]!), bottom: colour(stops[stops.length - 1]!) };
    }
    const c = colour(part);
    return { top: c, bottom: c };
  });
}
function over(ls: Layer[], under: Rgb, at: "top" | "bottom"): Rgb {
  let c: Rgb = under;
  for (const l of [...ls].reverse()) {
    const [r, g, b, a] = l[at];
    c = mix([r, g, b], c, a);
  }
  return c;
}

// ---------- The looks, as look.ts puts them on .stories-app ----------

type Look = { name: string; kind: "colours" | "picture" | "window"; veils: Veils; solid?: boolean; colours?: readonly string[] };
const veilsOfColours = (colours: readonly string[]) => veilsFor({ mode: "colours", strength: "clear", colours: [...colours], picture: null }, "none");
const LOOKS: Look[] = [
  ...PRESETS.map((p) => ({ name: `Colours › ${p.name}`, kind: "colours" as const, veils: veilsOfColours(p.colours), colours: p.colours })),
  { name: "Colours › the owner's own (white)", kind: "colours", veils: veilsOfColours(["#ffffff"]), colours: ["#ffffff"] },
  { name: "Colours › the owner's own (bright)", kind: "colours", veils: veilsOfColours(["#fff000", "#00ffff", "#ff00ff"]), colours: ["#fff000", "#00ffff", "#ff00ff"] },
  // (as veilsFor draws them: each glass at or above its measured floor, MEASURED and FROSTED, in the light's order)
  { name: "a picture", kind: "picture", veils: veilsFor({ mode: "picture", strength: "clear", colours: [...EMBER], picture: "data:image/png;base64," }, "none") },
  { name: "See-through, Clear", kind: "window", veils: veilsFor({ mode: "see-through", strength: "clear", colours: [...EMBER], picture: null }, "liquid") },
  { name: "See-through, Frosted", kind: "window", veils: veilsFor({ mode: "see-through", strength: "frosted", colours: [...EMBER], picture: null }, "liquid") },
  { name: "solid glass over the colours", kind: "colours", veils: solidVeils(0), solid: true, colours: EMBER },
  { name: "solid glass over a picture or the desktop", kind: "picture", veils: solidVeils(SOLID_PAGE), solid: true },
];

function envOf(look: Look, tone?: string): Map<string, string> {
  const env = new Map(BASE);
  if (look.kind !== "colours") for (const [k, v] of OVER_PICTURES) env.set(k, v);
  for (const [k, v] of Object.entries(look.veils)) env.set(`--st-veil-${k}`, String(v));
  if (look.solid) env.set("--st-veil-lens-rim", env.get("--st-veil-solid")!);
  if (tone) env.set("--st-tone-rgb", tone);
  return env;
}

const ESPRESSO = hexToRgb("#1c130e");
const BLACK: Rgb = [0, 0, 0];
const TONES = ["--st-action-rgb", "--st-amber-rgb", "--st-coral-rgb", "--st-mint-rgb", "--st-sky-rgb"];

type Surface = { name: string; level: number; at: (under: Rgb, at: "top" | "bottom") => Rgb; inks: string[] };
const GLASS_INKS = ["--st-text-strong", "--st-text", "--st-text-soft", "--st-text-amber", "--st-coral-ink", "--st-mint-ink", "--st-sky-ink"];

/** Every kind of glass surface in this look, with the words that may sit on it. */
function surfacesOf(look: Look): Surface[] {
  const env = envOf(look);
  const page = look.veils.page;
  const pageOver = (b: Rgb) => (page ? mix(VEIL, b, page) : b);
  const one = (name: string, level: number, token: string, inks = GLASS_INKS, e = env): Surface => {
    const ls = layers(`var(${token})`, e);
    return { name, level, at: (b, at) => over(ls, pageOver(b), at), inks };
  };
  const card = one("a card", 2, "--st-tint-card", [...GLASS_INKS, "--st-text-muted"]);
  // A card inside a card (glass.css: .st-glass .st-glass) is painted over its card, as the browser draws it: its layers
  // over the card's own colour over the backdrop, never straight over the backdrop.
  const raised = layers("var(--st-tint-raised)", env);
  const nested: Surface = { name: "a card inside a card", level: 3, at: (b, at) => over(raised, card.at(b, at), at), inks: [...GLASS_INKS, "--st-text-muted"] };
  const out: Surface[] = [
    one("the rail", 1, "--st-tint-rail"),
    card,
    one("a hero", 3, "--st-tint-hero"),
    nested,
    one("a bar", 3, "--st-tint-bar"),
    one("a sheet", 5, "--st-tint-float"),
  ];
  // A plate is a page panel over a picture or the desktop; over the colours it draws nothing (it is the page).
  if (look.kind !== "colours") out.push(one("a plate", 1, "--st-tint-plate"));
  for (const tone of TONES) out.push(one(`a tinted tile (${tone})`, 3, "--st-tint-tinted", GLASS_INKS, envOf(look, env.get(tone)!)));
  // A liquid hero (Chromium, liquid glass only, never solid): its filter lays middleVeil under the words, then its tint.
  if (!look.solid) {
    const ls = layers("var(--st-tint-lens)", env);
    const m = middleVeil(look.veils.hero, Number(env.get("--st-veil-lens-rim")));
    out.push({ name: "a liquid hero (under its words)", level: 3, at: (b, at) => over(ls, mix(VEIL, pageOver(b), m), at), inks: GLASS_INKS });
  }
  return out;
}

/** A control's own layers in this look, inside a glass surface (or loose on the page). */
function controlLayers(look: Look, inside: boolean): { name: string; ls: Layer[] }[] {
  const env = envOf(look);
  if (inside && look.kind !== "colours") for (const [k, v] of FIGURE_INSIDE) env.set(k, v);
  const light = layers("var(--st-light-4)", env);
  const fill = (v: string) => [...light, ...layers(v, env)];
  if (look.kind === "colours") return [{ name: "a glass control", ls: fill("var(--st-fill-control)") }];
  if (!inside) return [{ name: "a glass control loose on the page", ls: fill("var(--st-fill-control)") }];
  const btn = /\.st-btn:not\(\.st-btn--main, \.st-btn--coral, \.st-btn--cream, \.st-cream \.st-btn\) \{\s*background-color: ([^;]+);/.exec(read("st-parts.css"))![1]!;
  return [
    { name: "a pill or round button", ls: fill(FIGURE_INSIDE.get("--st-fill-figure")!) },
    { name: "a button", ls: fill(btn) },
  ];
}

describe("the elevation tokens", () => {
  const num = (name: string) => Number(BASE.get(name));
  it("are the same numbers as look.ts's (ELEVATION, ELEVATION_TOP, KIND_LEVEL)", () => {
    for (let n = 0; n <= 5; n++) {
      expect(num(`--st-elev-${n}`), `--st-elev-${n}`).toBe(ELEVATION[n]);
      expect(num(`--st-elev-grad-${n}`), `--st-elev-grad-${n}`).toBe(ELEVATION_TOP[n]);
    }
    expect(KIND_LEVEL).toEqual({ page: 0, rail: 1, plate: 1, card: 2, tinted: 3, hero: 3, bar: 3, float: 5 });
    expect(colour(`rgb(${BASE.get("--st-cream-rgb")})`).slice(0, 3)).toEqual([...CREAM]);
  });

  it("grow gradually from the backdrop to the sheets: the light, the rim and the glow, never a jump", () => {
    for (let n = 1; n <= 5; n++) {
      expect(num(`--st-elev-${n}`), `light ${n}`).toBeGreaterThan(num(`--st-elev-${n - 1}`));
      expect(num(`--st-elev-rim-${n}`), `rim ${n}`).toBeGreaterThan(num(`--st-elev-rim-${n - 1}`));
      expect(num(`--st-elev-glow-${n}`), `glow ${n}`).toBeGreaterThan(num(`--st-elev-glow-${n - 1}`));
      // gradual: no step more than a tenth of the cream
      expect(num(`--st-elev-${n}`) - num(`--st-elev-${n - 1}`), `step ${n}`).toBeLessThanOrEqual(0.1);
    }
    expect(num("--st-elev-0")).toBe(0);
  });

  it("each level's sheen carries its own bright top rim, a thin straight inner line", () => {
    for (const [sheen, n] of [["--st-sheen-panel", 1], ["--st-sheen", 2], ["--st-sheen-hero", 3], ["--st-sheen-raised", 3], ["--st-sheen-control", 4], ["--st-sheen-float", 5]] as const) expect(BASE.get(sheen), sheen).toMatch(new RegExp(`^var\\(--st-rim-${n}\\),`));
    // soft (blur over 2 px: light, never a drawn line, e2e/edges.ts), straight down, only along the top
    for (let n = 1; n <= 5; n++) expect(BASE.get(`--st-rim-${n}`)).toBe(`inset 0 3px 3px -2px rgb(255 250 240 / var(--st-elev-rim-${n}))`);
  });
});

describe("each level is brighter than the one under it", () => {
  for (const look of LOOKS)
    it(look.name, () => {
      const surfaces = surfacesOf(look);
      const env = envOf(look);
      const problems: string[] = [];
      for (const under of [ESPRESSO, BLACK])
        for (const at of ["top", "bottom"] as const) {
          const backdrop = look.veils.page ? mix(VEIL, under, look.veils.page) : under;
          const L = (s: Surface) => luminance(s.at(under, at));
          const byLevel = (n: number) => surfaces.filter((s) => s.level === n);
          // level 1 over the backdrop, then each level over every surface of the one under it
          for (const s of byLevel(1)) if (!(L(s) > luminance(backdrop))) problems.push(`${at} over ${under}: ${s.name} is not brighter than the backdrop`);
          for (const n of [2, 3])
            for (const s of byLevel(n)) for (const b of byLevel(n - 1)) if (!(L(s) > L(b))) problems.push(`${at} over ${under}: ${s.name} (${L(s).toFixed(4)}) ≤ ${b.name} (${L(b).toFixed(4)})`);
          // level 4: a control on a card is brighter than every level-3 surface; level 5 brighter than it
          const card = byLevel(2)[0]!;
          for (const c of controlLayers(look, true)) {
            const onCard = luminance(over(c.ls, card.at(under, at), at));
            // (a tinted tile's tone is colour as well as light: a control on one is a step above that tile, below)
            for (const b of byLevel(3).filter((x) => !x.name.startsWith("a tinted"))) if (!(onCard > L(b))) problems.push(`${at} over ${under}: ${c.name} on a card (${onCard.toFixed(4)}) ≤ ${b.name} (${L(b).toFixed(4)})`);
            for (const s of byLevel(5)) if (!(L(s) > onCard)) problems.push(`${at} over ${under}: ${s.name} (${L(s).toFixed(4)}) ≤ ${c.name} on a card (${onCard.toFixed(4)})`);
            // the top layer's top is brighter than the top of any control under it, on a hero too (the More sheet over
            // the hero's buttons)
            if (at === "top")
              for (const h of byLevel(3).filter((x) => !x.name.startsWith("a tinted"))) {
                const onRaised = luminance(over(c.ls, h.at(under, at), at));
                for (const s of byLevel(5)) if (!(L(s) > onRaised)) problems.push(`top over ${under}: ${s.name} (${L(s).toFixed(4)}) ≤ ${c.name} on ${h.name} (${onRaised.toFixed(4)})`);
              }
            // and on every surface it sits on, a step up from it
            for (const s of surfaces) {
              const on = luminance(over(c.ls, s.at(under, at), at));
              if (!(on > L(s))) problems.push(`${at} over ${under}: ${c.name} on ${s.name} is not brighter than it`);
            }
          }
          // (Over a picture or the desktop a control loose on the page carries a card's veil, so its words hold over a
          // white desktop: it is a veiled step up from the page there, checked for its words below.)
          if (look.kind !== "colours")
            for (const c of controlLayers(look, false)) {
              const loose = luminance(over(c.ls, backdrop, at));
              if (!(loose > luminance(backdrop)) && under === ESPRESSO) problems.push(`${at}: ${c.name} is not a step up from the page`);
            }
        }
      // lighter at the top (its own light), over the espresso
      for (const s of surfaces) if (!(luminance(s.at(ESPRESSO, "top")) > luminance(s.at(ESPRESSO, "bottom")))) problems.push(`${s.name} is not lighter at its top`);
      expect(env.get("--st-elev-settle")).toBe("58%");
      expect(problems, problems.join("\n")).toEqual([]);
    });

  it("a liquid hero keeps exactly the hero's veil share under its words: the light takes it from the backdrop", () => {
    for (const look of LOOKS.filter((l) => !l.solid)) {
      const hero = surfacesOf(look).find((s) => s.name === "a hero")!;
      const lens = surfacesOf(look).find((s) => s.name.startsWith("a liquid hero"))!;
      for (const under of [WHITE, ESPRESSO, BLACK, hexToRgb("#3a7bd5")])
        for (const at of ["top", "bottom"] as const) {
          const a = lens.at(under, at);
          const b = hero.at(under, at);
          for (let i = 0; i < 3; i++) expect(Math.abs(a[i]! - b[i]!), `${look.name} over ${under} at the ${at}`).toBeLessThan(0.75);
        }
    }
  });

  it("the light never thins a surface's measured veil over a white desktop or photo (it takes its share from the backdrop)", () => {
    // Clear (a picture, See-through Clear): MEASURED's veils were measured over white. Frosted lays its frost first, so
    // what is behind is never white there (its words are checked below, at 9:1 and more).
    for (const look of LOOKS.filter((l) => l.kind !== "colours" && !l.solid && l.veils.page === 0))
      for (const s of surfacesOf(look).filter((x) => !x.name.startsWith("a tinted"))) {
        const key = ({ "the rail": "rail", "a card": "card", "a hero": "hero", "a card inside a card": "hero", "a bar": "bar", "a sheet": "float", "a plate": "plate", "a liquid hero (under its words)": "hero" } as const)[s.name as "a card"];
        const plain = mix(VEIL, look.veils.page ? mix(VEIL, WHITE, look.veils.page) : WHITE, look.veils[key]);
        const lv = KIND_LEVEL[key];
        for (const at of ["top", "bottom"] as const) {
          // where veil and light together cover everything (Frosted's sheets) the surface is solid: its words are
          // checked below, at 4.5:1 or more
          if (look.veils[key] + ELEVATION[lv]! + (at === "top" ? ELEVATION_TOP[lv]! : 0) > 1) continue;
          expect(luminance(s.at(WHITE, at)), `${look.name}: ${s.name} at the ${at}`).toBeLessThanOrEqual(luminance(plain) + 1e-4);
        }
      }
  });
});

describe("over a light backdrop the light keeps its order (a picture or the desktop)", () => {
  const GREY: Rgb = [128, 128, 128];
  it("the drawn veils are never thinner than the measured floors", () => {
    for (const look of LOOKS.filter((l) => l.kind !== "colours" && !l.solid)) {
      const floor = look.veils.page ? FROSTED : MEASURED;
      // Frosted's floor is its whole cover: the frost and the glass together (1 - (1 - page)(1 - veil)).
      const cover = (v: Veils, k: keyof Veils) => 1 - (1 - v.page) * (1 - v[k]);
      for (const k of ["card", "tinted", "hero", "rail", "bar", "float", "plate"] as const)
        expect(cover(look.veils, k) + 1e-9, `${look.name}: ${k}`).toBeGreaterThanOrEqual(look.veils.page ? MEASURED[k] : floor[k]);
    }
  });
  for (const look of LOOKS.filter((l) => l.kind !== "colours" && !l.solid))
    it(look.name, () => {
      const surfaces = surfacesOf(look);
      const problems: string[] = [];
      for (const [name, under, step] of [
        ["white", WHITE, LIGHT_STEP],
        ["mid grey", GREY, 1e-4],
      ] as const)
        for (const at of ["top", "bottom"] as const) {
          const L = (s: Surface) => luminance(s.at(under, at));
          const byLevel = (n: number) => surfaces.filter((s) => s.level === n);
          // (a tinted tile's tone is colour as well as light: it is a step up from the cards, and the sheets are a
          // step up from every other raised surface)
          const plain3 = byLevel(3).filter((x) => !x.name.startsWith("a tinted"));
          const steps: [Surface[], Surface[]][] = [
            [byLevel(2), byLevel(1)],
            [byLevel(3), byLevel(2)],
            [byLevel(5), plain3],
          ];
          for (const [ups, downs] of steps)
            for (const s of ups)
              for (const b of downs)
                if (!(L(s) >= L(b) + step)) problems.push(`${at} over ${name}: ${s.name} (${L(s).toFixed(4)}) is not ${step} above ${b.name} (${L(b).toFixed(4)})`);
          // a control is a step up from every surface it sits on
          for (const c of controlLayers(look, true))
            for (const s of surfaces) {
              const on = luminance(over(c.ls, s.at(under, at), at));
              if (!(on >= L(s) + step)) problems.push(`${at} over ${name}: ${c.name} on ${s.name} (${on.toFixed(4)}) is not ${step} above it (${L(s).toFixed(4)})`);
            }
        }
      expect(problems, problems.join("\n")).toEqual([]);
    });
});

describe("every word stays readable at the brightest part of every surface", () => {
  const ink = (name: string) => hexToRgb(BASE.get(name)!);
  const busy: Rgb[] = [WHITE, [255, 255, 0], [0, 255, 255], [255, 0, 255], [255, 64, 64], [64, 255, 64], [80, 140, 255], [255, 200, 150], [128, 128, 128], BLACK];
  /** The lightest pixels each look can show behind its glass. */
  const behind = (look: Look): Rgb[] => {
    if (look.kind === "colours") {
      const spots = stageSpots(look.colours ?? EMBER);
      return [...spots, ...spots.map((s) => saturateRgb(s, 1.35)), ESPRESSO];
    }
    // a picture or the desktop: anything, white the worst (the page veil, Frosted's frost, is laid by surfacesOf)
    return busy.flatMap((b) => [b, saturateRgb(b, 1.35)]);
  };

  for (const look of LOOKS)
    it(look.name, () => {
      const low: string[] = [];
      const surfaces = surfacesOf(look);
      for (const under of behind(look))
        for (const s of surfaces)
          for (const at of ["top", "bottom"] as const) {
            const bg = s.at(under, at);
            for (const i of s.inks) {
              const r = contrast(ink(i), bg);
              if (r < 4.5) low.push(`${s.name} at the ${at} over ${under.map(Math.round)}: ${i} ${r.toFixed(2)}`);
            }
          }
      // Bars and sheets can have a cream card or the action under them (things scroll under a bar; a sheet opens over
      // the page): their words hold there too.
      for (const under of [CREAM, hexToRgb(BASE.get("--st-action")!), hexToRgb(BASE.get("--st-cream-2")!)])
        for (const s of surfaces.filter((x) => x.name === "a bar" || x.name === "a sheet"))
          for (const at of ["top", "bottom"] as const)
            for (const i of s.inks) {
              const r = contrast(ink(i), s.at(under, at));
              if (r < 4.5) low.push(`${s.name} over ${under}: ${i} ${r.toFixed(2)}`);
            }
      // A control's words on every surface it sits on (and loose on the page over a picture or the desktop).
      const words = ["--st-text-strong", "--st-text", "--st-text-soft"];
      for (const under of behind(look))
        for (const at of ["top", "bottom"] as const) {
          for (const c of controlLayers(look, true))
            for (const s of surfaces) {
              const bg = over(c.ls, s.at(under, at), at);
              for (const i of words) if (contrast(ink(i), bg) < 4.5) low.push(`${c.name} on ${s.name} at the ${at} over ${under.map(Math.round)}: ${i} ${contrast(ink(i), bg).toFixed(2)}`);
            }
          if (look.kind !== "colours")
            for (const c of controlLayers(look, false)) {
              const bg = over(c.ls, look.veils.page ? mix(VEIL, under, look.veils.page) : under, at);
              for (const i of words) if (contrast(ink(i), bg) < 4.5) low.push(`${c.name} at the ${at} over ${under.map(Math.round)}: ${i} ${contrast(ink(i), bg).toFixed(2)}`);
            }
        }
      expect([...new Set(low)], [...new Set(low)].slice(0, 30).join("\n")).toEqual([]);
    });

  it("lit() in look.ts is what the style sheets draw (so veilsFor works the colours out with the light in)", () => {
    const look = LOOKS[0]!;
    const card = surfacesOf(look).find((s) => s.name === "a card")!;
    for (const under of [WHITE, ESPRESSO, hexToRgb("#e2621f")]) {
      const a = card.at(under, "bottom");
      const b = lit(under, look.veils.card, ELEVATION[2]!);
      for (let i = 0; i < 3; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(0.75);
    }
    expect(INKS.ink).toBe(BASE.get("--st-text"));
  });
});

describe("the glass classes and the screens' surfaces lay their level's light", () => {
  const body = (css: string, selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThanOrEqual(0);
    return css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  };

  it("glass.css: each class on its level (fill, rim in its sheen, glow)", () => {
    const want: [string, string, string, string][] = [
      [".st-glass", "--st-tint-card", "--st-sheen", "--st-glow-2"],
      [".st-glass--hero", "--st-tint-hero", "--st-sheen-hero", "--st-glow-3"],
      [".st-glass--bar", "--st-tint-bar", "--st-sheen-raised", "--st-glow-3"],
      [".st-glass--float", "--st-tint-float", "--st-sheen-float", "--st-glow-5"],
      [".st-glass .st-glass:not(.st-glass--hero, .st-glass--bar, .st-glass--float, .st-glass--control, .st-glass--tinted)", "--st-tint-raised", "--st-sheen-raised", "--st-glow-3"],
      ['.stories-app:is([data-look="window"], [data-look="picture"]) .st-plate', "--st-tint-plate", "--st-sheen-panel", "--st-glow-1"],
    ];
    for (const [sel, fill, sheen, glow] of want) {
      const b = body(GLASS, sel);
      expect(b, sel).toMatch(new RegExp(`background: var\\(${fill}\\);`));
      expect(b, sel).toMatch(new RegExp(`box-shadow: var\\(${sheen}\\),`));
      expect(b, sel).toContain(`var(${glow})`);
    }
    const tinted = body(GLASS, ".st-glass--tinted");
    expect(tinted).toMatch(/^\s*background:\s*var\(--st-light-3\),/);
    expect(tinted).toContain("calc(var(--st-veil-tinted) / (1 - var(--st-elev-3)))");
    expect(body(GLASS, ".st-glass--tinted:where(:not(.st-glass--hero))")).toContain("var(--st-sheen-raised)");
    const control = body(GLASS, ".st-glass--control");
    expect(control).toContain("background-image: var(--st-light-4);");
    expect(control).toContain("box-shadow: var(--st-sheen-control), var(--st-glow-4);");
    expect(body(GLASS, ".st-glass--control:hover")).toContain("background-image: var(--st-light-4);");
  });

  it("the rail is a page panel (level 1); the phone tab bar a bar (level 3)", () => {
    const frame = read("st-frame.css");
    const rail = body(frame, "  .st-rail");
    expect(rail).toContain("background: var(--st-tint-rail);");
    expect(rail).toContain("box-shadow: var(--st-sheen-panel), var(--st-depth-2), var(--st-glow-1);");
    expect(body(frame, ".st-tabbar")).toContain("box-shadow: var(--st-sheen-raised), var(--st-depth-3), var(--st-glow-3);");
  });

  it("the figures and buttons are controls (level 4): their light at the top, kept on hover, and their rim", () => {
    const figures = read("glass-figures.css");
    const parts = read("st-parts.css");
    for (const [css, sel] of [[figures, ".st-pill"], [figures, ".st-round-btn"], [parts, ".st-btn"]] as const) {
      const b = body(css, sel);
      expect(b, sel).toContain("background-image: var(--st-light-4);");
      expect(b, sel).toMatch(/box-shadow: var\(--st-sheen-control\)/);
    }
    for (const [css, sel] of [[figures, "a.st-pill:hover"], [figures, ".st-round-btn:hover"]] as const) expect(body(css, sel), sel).toContain("background-image: var(--st-light-4);");
  });

  it("every surface in the screens' own files that lays a glass veil lays its level's light over it, and gives the light its share", () => {
    const bad: string[] = [];
    for (const f of readdirSync(DIR).filter((n) => n.endsWith(".css") && n !== "glass-tokens.css")) {
      for (const m of read(f).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        for (const d of m[2]!.matchAll(/background(?:-image)?:\s*([^;]+);/g)) {
          const v = d[1]!;
          const veil = /var\(--st-veil-(card|tinted|hero|rail|bar|float|plate)\)/.exec(v);
          if (!veil) continue;
          // a fill of the glass veil: the level's light in front, the veil divided by what the light takes
          const level = { card: 2, tinted: 3, hero: 3, rail: 1, bar: 3, float: 5, plate: 1 }[veil[1] as "card"];
          if (!v.includes(`var(--st-light-${level})`) || !v.includes(`/ (1 - var(--st-elev-${level})`)) bad.push(`${f}: ${m[1]!.trim().slice(0, 90)}: ${v.slice(0, 90)}`);
        }
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("no surface keeps an old flat tint or the old deeper-at-the-top veil: the tints are each level's light over its veil", () => {
    for (const [t, n] of [["--st-tint-card", 2], ["--st-tint-hero", 3], ["--st-tint-rail", 1], ["--st-tint-bar", 3], ["--st-tint-float", 5], ["--st-tint-plate", 1], ["--st-tint-raised", 3], ["--st-tint-tinted", 3], ["--st-tint-lens", 3]] as const)
      expect(BASE.get(t), t).toMatch(new RegExp(`^var\\(--st-light-${n}\\),`));
  });
});
