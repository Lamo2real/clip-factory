// Clip Factory Stories' liquid glass, the points the merge of the screens settled (styles/GLASS-CONTRACT.md):
// a glass control or pill loose on the colours keeps its words at 4.5:1 when hovered too, over the lightest pixel each
// preset's stage can show (inside a glass card it keeps the cream lift); a tinted tile and a tinted liquid hero take
// their own --st-tone-rgb (the token --st-tint-tinted is worked out on .stories-app, where no tone is set); the shell's
// chips keep their words at 4.5:1 over a white desktop or photo on every glass they sit on; and the
// Dashboard's Continue and setup cards are styled in st-dashboard.css only, their fill and rest shadow left to the
// glass classes; and Stories' font faces come with the first Stories screen, never with the chunk the shell prefetches
// while Clip Factory is on screen (any @font-face arriving then repaints Clip Factory's words a pixel off). Every
// number comes from the stylesheets, so a change there is checked here.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FONTS_ATTR, addStoriesFonts } from "../src/stories/fonts.ts";
import { FROSTED, MEASURED, PRESETS, WHITE, contrast, hexToRgb, luminance, mix, stageSpots, type Rgb } from "../src/stories/look.ts";

const DIR = join(import.meta.dirname, "..", "src", "stories", "styles");
const read = (f: string) => readFileSync(join(DIR, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const TOKENS = read("glass-tokens.css");
const GLASS = read("glass.css");

/** A token's first value in glass-tokens.css (the one on .stories-app). */
function token(name: string): string {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(TOKENS);
  if (!m) throw new Error(`${name} is not defined`);
  return m[1]!.trim();
}
const channels = (name: string): Rgb => token(name).split(/\s+/).map(Number) as unknown as Rgb;
/** `rgb(var(--x-rgb) / a)` or `rgb(r g b / a)` from the tokens, as a colour and its alpha. */
function fill(value: string): { rgb: Rgb; a: number } {
  const v = /^rgb\(var\((--st-[a-z0-9-]+)\)\s*\/\s*([\d.]+)\)$/.exec(value);
  if (v) return { rgb: channels(v[1]!), a: Number(v[2]) };
  const n = /^rgb\((\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\)$/.exec(value);
  if (n) return { rgb: [Number(n[1]), Number(n[2]), Number(n[3])], a: Number(n[4]) };
  throw new Error(`not a plain fill: ${value}`);
}
const lightest = (spots: readonly Rgb[]): Rgb => spots.reduce((a, b) => (luminance(b) > luminance(a) ? b : a));

describe("a glass control loose on the colours", () => {
  const text = hexToRgb(token("--st-text"));
  const rest = fill(token("--st-fill-control"));
  const hover = fill(token("--st-fill-control-hover"));
  const lift = fill(token("--st-fill-control-lift"));

  for (const preset of PRESETS)
    it(`keeps its words at 4.5:1 at rest and hovered over ${preset.name}'s lightest pixel`, () => {
      const under = lightest(stageSpots(preset.colours));
      expect(contrast(text, mix(rest.rgb, under, rest.a)), "at rest").toBeGreaterThanOrEqual(4.5);
      expect(contrast(text, mix(hover.rgb, under, hover.a)), "hovered").toBeGreaterThanOrEqual(4.5);
    });

  it("still shows the hover on a dark glass card, where the card's veil is under it: the cream lift", () => {
    expect(TOKENS).toMatch(/\.stories-app:not\(\[data-look="window"\]\):not\(\[data-look="picture"\]\) \.st-glass:not\(\.st-glass--control\) \{\s*--st-fill-control-hover: var\(--st-fill-control-lift\);/);
    const card = mix(channels("--st-veil-rgb"), lightest(stageSpots(PRESETS[0]!.colours)), Number(token("--st-veil-card")));
    expect(luminance(mix(lift.rgb, card, lift.a))).toBeGreaterThan(luminance(mix(rest.rgb, card, rest.a)) * 1.2);
    // Loose on the page the hover changes the fill too (it deepens over a bright light, lifts over a dark one).
    expect(mix(hover.rgb, card, hover.a)).not.toEqual(mix(rest.rgb, card, rest.a));
  });
});

describe("a tinted surface takes its own tone", () => {
  const rule = (css: string, selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf("}", at));
  };

  it(".st-glass--tinted: the tile's --st-tone-rgb, never the token worked out on .stories-app", () => {
    const body = rule(GLASS, ".st-glass--tinted");
    expect(body).toContain("var(--st-tone-rgb, var(--st-action-rgb))");
    expect(body).toContain("var(--st-tint-cut)");
    expect(body).toContain("var(--st-veil-tinted)");
    expect(body).not.toContain("var(--st-tint-tinted)");
  });

  it(".st-lens--tinted: a liquid hero keeps its colour over the rim's tint", () => {
    const body = rule(GLASS, '.refract .stories-app[data-glass="liquid"] .st-lens.st-lens--tinted.is-liquid');
    expect(body).toContain("var(--st-tone-rgb, var(--st-action-rgb))");
    expect(body).toContain("var(--st-tint-lens)");
  });

  it("the words on it keep 4.5:1 over a white picture or desktop, for every tone", () => {
    const veil = channels("--st-veil-rgb");
    const cut = Number(token("--st-tint-cut"));
    const inks = ["--st-text", "--st-text-soft"].map((n) => hexToRgb(token(n)));
    for (const tone of ["--st-action-rgb", "--st-amber-rgb", "--st-coral-rgb", "--st-mint-rgb", "--st-sky-rgb"])
      for (const v of [0.76, 0.8]) {
        const bg = mix(channels(tone), mix(veil, [255, 255, 255], v), cut);
        for (const ink of inks) expect(contrast(ink, bg), `${tone} over veil ${v}`).toBeGreaterThanOrEqual(4.5);
      }
  });
});

describe("a chip over a picture or the desktop (st-parts.css), on the glass it sits on", () => {
  const PARTS = read("st-parts.css");
  const LOOSE = '.stories-app:is([data-look="window"], [data-look="picture"]) .st-chip';
  const body = (selector: string) => {
    const at = PARTS.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThanOrEqual(0);
    return PARTS.slice(at, PARTS.indexOf("}", at));
  };
  const well = channels("--st-well-rgb");
  const veil = channels("--st-veil-rgb");
  const cream = channels("--st-cream-rgb");
  // The well under every chip there, and the tone's cut over it, as the rules write them.
  const wellAlpha = Number(/rgb\(var\(--st-well-rgb\) \/ ([\d.]+)\)/.exec(body(LOOSE))![1]);
  const TONES = { sun: "--st-amber-rgb", coral: "--st-coral-rgb", mint: "--st-mint-rgb", sky: "--st-sky-rgb" } as const;
  const inkOf = (tone: keyof typeof TONES | null) => {
    const m = /color:\s*var\((--st-[a-z-]+)\)/.exec(body(tone ? `.st-chip--${tone}` : ".st-chip"));
    return hexToRgb(token(m![1]!));
  };
  // The glass under it over a white desktop or photo (look.ts's measured veils, Clear and Frosted), bare or one of the
  // shell's cream lifts inside glass (0.12 at rest, 0.16 hovered: a row, a control).
  const surfaces: [string, Rgb][] = [];
  for (const [name, veils] of [["Clear", MEASURED], ["Frosted", FROSTED]] as const)
    for (const kind of ["card", "tinted", "hero", "plate", "float"] as const) {
      const under = mix(veil, veils.page ? mix(veil, WHITE, veils.page) : WHITE, veils[kind]);
      for (const lift of [0, 0.12, 0.16]) surfaces.push([`${name} ${kind} + cream ${lift}`, lift ? mix(cream, under, lift) : under]);
    }

  it("keeps the plain chip's words at 4.5:1", () => {
    expect(wellAlpha).toBeGreaterThan(0);
    for (const [where, under] of surfaces) expect(contrast(inkOf(null), mix(well, under, wellAlpha)), where).toBeGreaterThanOrEqual(4.5);
  });

  for (const tone of Object.keys(TONES) as (keyof typeof TONES)[])
    it(`keeps the ${tone} chip's words at 4.5:1 (its tone cut over the well)`, () => {
      const rule = body(`${LOOSE}--${tone}`);
      const cut = new RegExp(`rgb\\(var\\(${TONES[tone]}\\) / ([\\d.]+)\\)`).exec(rule);
      expect(cut, tone).not.toBeNull();
      expect(rule).toContain(`rgb(var(--st-well-rgb) / ${wellAlpha})`);
      for (const [where, under] of surfaces) {
        const chip = mix(channels(TONES[tone]), mix(well, under, wellAlpha), Number(cut![1]));
        expect(contrast(inkOf(tone), chip), `${tone} on ${where}`).toBeGreaterThanOrEqual(4.5);
      }
    });
});

describe("a glass pill or round button inside glass over a picture or the desktop (glass-figures.css)", () => {
  const FIGURES = read("glass-figures.css");
  const rule = /\.stories-app:is\(\[data-look="window"\], \[data-look="picture"\]\) :is\(\.st-glass:not\(\.st-glass--control\), \.st-plate\) \{([^}]*)\}/.exec(TOKENS);

  it("is the light cream glass there, never a second veil (and the cream card decides its own)", () => {
    expect(rule, "the rule on glass surfaces and plates").not.toBeNull();
    expect(TOKENS).toMatch(/\.stories-app \.st-cream \{\s*--st-fill-figure: initial;\s*--st-fill-figure-hover: initial;/);
    for (const figure of [".st-pill {", ".st-round-btn {"]) {
      const at = FIGURES.indexOf(figure);
      expect(at, figure).toBeGreaterThanOrEqual(0);
      expect(FIGURES.slice(at, FIGURES.indexOf("}", at)), figure).toContain("background: var(--st-fill-figure, var(--st-fill-control));");
    }
    for (const hover of ["a.st-pill:hover {", ".st-round-btn:hover {"]) {
      const at = FIGURES.indexOf(hover);
      expect(at, hover).toBeGreaterThanOrEqual(0);
      expect(FIGURES.slice(at, FIGURES.indexOf("}", at)), hover).toContain("background: var(--st-fill-figure-hover, var(--st-fill-control-hover));");
    }
  });

  it("keeps its words at 4.5:1 at rest and hovered over a white desktop or photo, on every glass it sits on", () => {
    const body = rule![1]!;
    const at = (name: string) => fill(new RegExp(`${name}:\\s*([^;]+);`).exec(body)![1]!.trim());
    const rest = at("--st-fill-figure");
    const hover = at("--st-fill-figure-hover");
    expect(luminance(mix(hover.rgb, mix(channels("--st-veil-rgb"), WHITE, MEASURED.card), hover.a))).toBeGreaterThan(luminance(mix(rest.rgb, mix(channels("--st-veil-rgb"), WHITE, MEASURED.card), rest.a)));
    const text = hexToRgb(token("--st-text"));
    const veil = channels("--st-veil-rgb");
    for (const [name, veils] of [["Clear", MEASURED], ["Frosted", FROSTED]] as const)
      for (const kind of ["card", "tinted", "hero", "plate", "float"] as const) {
        const under = mix(veil, veils.page ? mix(veil, WHITE, veils.page) : WHITE, veils[kind]);
        for (const [state, f] of [["at rest", rest], ["hovered", hover]] as const)
          expect(contrast(text, mix(f.rgb, under, f.a)), `${name} ${kind} ${state}`).toBeGreaterThanOrEqual(4.5);
      }
  });
});

describe("the Dashboard's Continue and setup cards", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".css"));

  it("are styled in st-dashboard.css only (st-setup.css's old copy is gone)", () => {
    for (const f of files) {
      if (f === "st-dashboard.css") continue;
      expect(read(f).match(/\.st-(continue|setupcard)\b/g) ?? [], f).toEqual([]);
    }
  });

  it("leave their fill and rest shadow to the glass classes (.st-glass--hero, .st-glass)", () => {
    const css = read("st-dashboard.css");
    for (const selector of [".st-dash .st-continue", ".st-dash .st-setupcard", ".st-dash .st-setupcard--left"]) {
      const at = css.indexOf(`${selector} {`);
      expect(at, selector).toBeGreaterThanOrEqual(0);
      const body = css.slice(at, css.indexOf("}", at));
      expect(body, selector).not.toMatch(/\bbackground\s*:/);
      expect(body, selector).not.toMatch(/\bbox-shadow\s*:/);
    }
  });
});

describe("Stories' fonts", () => {
  const SRC = join(import.meta.dirname, "..", "src", "stories");

  it("are not in the chunk's style sheet: only fonts.css declares a face, and no index imports it", () => {
    for (const f of readdirSync(DIR).filter((n) => n.endsWith(".css"))) {
      if (f === "fonts.css") {
        expect(read(f), f).toMatch(/@font-face/);
        continue;
      }
      expect(read(f), f).not.toMatch(/@font-face/);
      expect(read(f), f).not.toMatch(/@import\s+["']\.\/fonts\.css["']/);
    }
  });

  it("are put on the page by StoriesApp, once, before its first paint", () => {
    expect(readFileSync(join(SRC, "fonts.ts"), "utf8")).toMatch(/import FACES from "\.\/styles\/fonts\.css\?inline";/);
    expect(readFileSync(join(SRC, "StoriesApp.tsx"), "utf8")).toMatch(/useLayoutEffect\(\(\) => addStoriesFonts\(\), \[\]\);/);
    document.head.querySelectorAll(`style[${FONTS_ATTR}]`).forEach((n) => n.remove());
    addStoriesFonts();
    addStoriesFonts();
    expect(document.head.querySelectorAll(`style[${FONTS_ATTR}]`)).toHaveLength(1);
    document.head.querySelectorAll(`style[${FONTS_ATTR}]`).forEach((n) => n.remove());
  });
});
