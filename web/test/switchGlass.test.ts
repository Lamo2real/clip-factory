import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { luminance, SATURATIONS, type Rgb } from "../src/lib/background.ts";

// The workspace switch is clear, colour-free liquid glass (the owner, 2026-11-23: "make his color freee and liquid
// glass style", as the Reload button's "without color and only a liquid glassy style"; docs/CONTRACTS.md §45.38 S5).
// It is one element of the shell, drawn the same over Clip Factory's green sidebar and Funded Clips' espresso rail, in
// both phone top bars and in every look, so none of its fills, rims or shades may carry a colour: every one is white
// or black at an alpha (a smoke may take the look's own panel tint, --panel-veil, as its alpha). Its contrast and its
// lens's lift (+0.06 OKLab L or more over the track) are measured in real pixels over every place it is drawn by
// e2e/switch-glass.spec.ts, and contrast.spec.ts reads its words as it reads every word; here the stylesheets are read
// so no green, cream or bone fill comes back, and the dock never makes its host the Backdrop Root of its glass.

const STYLES = join(import.meta.dirname, "..", "src", "styles");
const STORIES_STYLES = join(import.meta.dirname, "..", "src", "stories", "styles");
/** Without comments, so a word in a comment never stands in for one in a rule. */
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const sheet = (dir: string, name: string) => strip(readFileSync(join(dir, name), "utf8"));
const glide = sheet(STYLES, "glide.css");

/** Every innermost rule as [selector, body]. */
const ruleList = (text: string) => [...text.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((m) => [m[1]!.trim().replace(/\s+/g, " "), m[2]!] as const);
/** The one rule of glide.css whose selector list is exactly `selector` (two would let a later one repaint it). */
const body = (selector: string) => {
  const found = ruleList(glide).filter(([s]) => s === selector);
  expect(found, selector).toHaveLength(1);
  return found[0]![1];
};
/** Declarations of a rule body, custom properties included (a multi-line value is folded onto one line). */
const decls = (text: string) => new Map([...text.matchAll(/(?:^|;)\s*(-{0,2}[a-z][a-z0-9-]*)\s*:\s*([^;]+)/g)].map((m) => [m[1]!, m[2]!.trim().replace(/\s+/g, " ")]));

/** Splits a value at its top-level commas (its layers). */
const layers = (v: string) => {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of v) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};

/** The switch's own glass, declared once on the track and read by the chosen option and the glide. */
const own = decls(body(".ws-switch"));
const resolve = (v: string): string => v.replace(/var\((--wsg-[a-z-]+)\)/g, (whole, name: string) => (own.has(name) ? resolve(own.get(name)!) : whole));

/** The paint of the switch: what a fill, rim, shade or line is made of. Words are checked on their own. */
const PAINT = /^(background(?:-color|-image)?|box-shadow|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color|-image)?|outline(?:-color)?|--wsg-[a-z-]+)$/;
/**
 * A black smoke as strong as the look's own panel tint, never under a floor: `rgb(0 0 0 / max(0.3, var(--panel-veil)))`.
 * The only token a paint may name, and only as the alpha of black.
 */
const SMOKE = /rgb\(0 0 0 \/ max\(([\d.]+), var\(--panel-veil\)\)\)/g;
/** Where a paint names a colour that is not white or black at an alpha (or names a token, which could be one). */
const tinted = (raw: string) => {
  const out: string[] = [];
  const value = raw.replace(SMOKE, "rgb(0 0 0 / $1)");
  for (const m of value.matchAll(/var\((--[a-z0-9-]+)/g)) if (!m[1]!.startsWith("--wsg-")) out.push(`token ${m[1]}`);
  for (const m of value.matchAll(/#[0-9a-f]{3,8}\b/gi)) out.push(`hex ${m[0]}`);
  for (const m of value.matchAll(/\b(hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/g)) out.push(`${m[1]}()`);
  for (const m of value.matchAll(/\brgba?\(([^)]*)\)/g)) {
    const [r, g, b] = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
    if (!(r === g && g === b && (r === 0 || r === 255))) out.push(`rgb(${m[1]})`);
  }
  // A named colour (anything but transparent and none) is a colour too.
  for (const m of value.replace(/[a-z-]+\(|\b(?:inset|transparent|none|at|deg|px|0)\b/gi, " ").matchAll(/\b([a-z]{3,})\b/gi)) out.push(`named ${m[1]}`);
  return out;
};

/** The selectors that draw the switch: its track, its options, the glide, the round toggle and the menu it opens. */
const SWITCH = /\.(?:ws-switch(?:__opt|--stack)?|glide--ws|ws-round(?:--phone|--slim)?|ws-menu)(?![\w-])/;
const SWITCH_RULES = [".ws-switch", ".ws-switch__opt", ".ws-switch__opt:not(.is-on):hover", ".ws-switch__opt:active", ".ws-switch__opt.is-on", ".glide--ws", ".glide--ws::before", ".ws-round", ".ws-round:hover", ".ws-round:active", ".ws-menu"];
/** One white stop of a flat face, `linear-gradient(180deg, rgb(255 255 255 / a), rgb(255 255 255 / a))`: its alpha. */
const flatWhite = (v: string) => {
  const m = /^linear-gradient\(180deg, rgb\(255 255 255 \/ ([\d.]+)\), rgb\(255 255 255 \/ ([\d.]+)\)\)$/.exec(v);
  expect(m, v).not.toBeNull();
  expect(m![1], `${v}: one even light`).toBe(m![2]);
  return Number(m![1]);
};

describe("the workspace switch is clear, colour-free glass (§45.38 S5)", () => {
  it("the track and the chosen option (the lens on the option and on the glide) use no green, cream or bone fill", () => {
    const track = resolve(decls(body(".ws-switch")).get("background")!);
    const chosen = resolve(decls(body(".ws-switch__opt.is-on")).get("background")!);
    const glideLens = resolve(decls(body(".glide--ws")).get("background")!);
    const glideTop = resolve(decls(body(".glide--ws::before")).get("background")!);
    for (const [what, v] of [["track", track], ["chosen option", chosen], ["glide", glideLens], ["glide's light", glideTop]] as const) {
      expect(v.replace(SMOKE, "rgb(0 0 0 / $1)"), what).not.toMatch(/var\(|bone|green|cream|selected|fill|#/);
      expect(tinted(v), what).toEqual([]);
    }
    // The chosen option and the glide are the same lens, and both light it: the glide draws the light above the words
    // on its ::before, over its own face, so its own fill is only what is under the words.
    expect(chosen).toBe(`${glideTop}, ${glideLens}`);
    expect(decls(body(".glide--ws::before")).get("content")).toBe('""');
    expect(decls(body(".glide--ws::before")).get("inset")).toBe("0");
    expect(resolve(decls(body(".ws-switch__opt.is-on")).get("box-shadow")!)).toBe(resolve(decls(body(".glide--ws")).get("box-shadow")!));
    // The glide's own rule repaints both of .glide's bone paints (the bone pill and its bone light), so neither shows.
    expect([...decls(body(".glide--ws")).keys()]).toEqual(expect.arrayContaining(["background", "box-shadow"]));
  });

  it("every fill, rim and shade of every switch rule is white or black at an alpha", () => {
    for (const selector of SWITCH_RULES) {
      const found: string[] = [];
      for (const [prop, value] of decls(body(selector))) if (PAINT.test(prop)) for (const t of tinted(resolve(value))) found.push(`${prop}: ${t}`);
      expect(found, selector).toEqual([]);
    }
  });

  it("no other rule repaints it: not a look of Clip Factory's (the window, the picture), not Funded Clips' own styles", () => {
    const sheets = [
      ...readdirSync(STYLES).filter((f) => f.endsWith(".css")).map((f) => [`styles/${f}`, sheet(STYLES, f)] as const),
      ...readdirSync(STORIES_STYLES).filter((f) => f.endsWith(".css")).map((f) => [`stories/styles/${f}`, sheet(STORIES_STYLES, f)] as const),
    ];
    const found: string[] = [];
    for (const [file, text] of sheets)
      for (const [selector, rule] of ruleList(text)) {
        if (!SWITCH.test(selector)) continue;
        for (const [prop, value] of decls(rule)) if (PAINT.test(prop)) for (const t of tinted(resolve(value))) found.push(`${file} ${selector} { ${prop}: ${t} }`);
      }
    expect(found).toEqual([]);
    // The old see-through repaint (the pick-one track's bone-on-green --fill-control) is gone: the track holds its
    // words by itself in every look.
    expect(glide).not.toMatch(/\.ws-dock \.ws-switch \{/);
  });

  it("its words are bone at rest, near-black on the bright clear lens and white on hover, never a bone pill's colour", () => {
    expect(decls(body(".ws-switch__opt")).get("color")).toBe("var(--ink-2)");
    expect(decls(body(".ws-switch__opt.is-on")).get("color")).toBe("#141414");
    expect(decls(body(".ws-switch__opt:not(.is-on):hover")).get("color")).toBe("#fff");
    expect(glide).not.toMatch(/--on-bone/);
    // The soft dark halo is for comfort only (never counted toward AA) and neutral, like every shade here.
    for (const selector of [".ws-switch__opt", ".ws-switch__opt.is-on"]) expect(tinted(decls(body(selector)).get("text-shadow")!), selector).toEqual([]);
  });

  it("the track's smoke is neutral and never weaker than the look's own panel tint, nor under 0.7", () => {
    // Black is darker than the panels' bottle green, so a track as strong as the panel tint holds its words wherever a
    // panel would (a white desktop or photo, a Cream backdrop), and no word sits on less than the panel tint (§22.3).
    expect(own.get("--wsg-smoke")).toBe("rgb(0 0 0 / max(0.7, var(--panel-veil)))");
    expect(layers(resolve(own.get("--wsg-track")!)).at(-1)).toBe(own.get("--wsg-smoke"));
    // The menu a round toggle opens is nearly solid smoke, also never under the panel tint.
    expect(layers(decls(body(".ws-menu")).get("background")!).at(-1)).toBe("rgb(0 0 0 / max(0.78, var(--panel-veil)))");
  });

  it("the lens's light lies above its words: a catch light 9 px deep and a top light gone by 12 px", () => {
    const top = layers(resolve(own.get("--wsg-lens-top")!));
    expect(top).toHaveLength(2);
    const catchLight = /^radial-gradient\(\d+% (\d+)px at 50% 0, rgb\(255 255 255 \/ [\d.]+\), transparent\)$/.exec(top[0]!);
    expect(catchLight, top[0]).not.toBeNull();
    expect(Number(catchLight![1])).toBeLessThanOrEqual(9);
    const fade = /^linear-gradient\(180deg, rgb\(255 255 255 \/ [\d.]+\) 0, rgb\(255 255 255 \/ 0\) (\d+)px\)$/.exec(top[1]!);
    expect(fade, top[1]).not.toBeNull();
    // A 44 px option's words (14 px, a 17 px line box) start 13 px down.
    expect(Number(fade![1])).toBeLessThanOrEqual(12);
    flatWhite(resolve(own.get("--wsg-lens-face")!));
  });

  it("the dock dims and clips the switch's own parts, never its host (which would cut its glass off from what is behind)", () => {
    // Filter Effects 2: an ancestor with an opacity under 1, a clip, a mask or a filter is the Backdrop Root of the
    // switch's glass, whose blur and grey-out would then see nothing behind it, so the colour behind would flash back.
    const ROOT = /(?:^|;)\s*(opacity|clip-path|mask|filter|backdrop-filter|mix-blend-mode|animation)\s*:/;
    const host = ruleList(glide).filter(([sel]) => sel.split(",").some((one) => /\.ws-switch-host(?:--[a-z]+)?(?:\[[^\]]*\])?$/.test(one.trim())));
    expect(host.length).toBeGreaterThan(0);
    for (const [sel, rule] of host) expect(ROOT.exec(rule)?.[1] ?? null, sel).toBeNull();
    expect(decls(body(".ws-dock.is-under > .ws-switch-host > *, .ws-dock.is-under > .ws-dock__live")).get("opacity")).toBe("0.34");
    expect(decls(body('.ws-dock.is-unfolding:not([data-ws-dock="edge"]) > .ws-switch-host > *, .ws-dock.is-unfolding > .ws-dock__live')).get("animation")).toMatch(/^ws-dock-unfold /);
    // The switch's parts fade with the dim on their own transition (opacity only).
    for (const selector of [".ws-switch", ".ws-round", ".ws-menu"]) expect(decls(body(selector)).get("transition"), selector).toMatch(/opacity 200ms ease/);
  });

  it("the track, the round toggle and the menu blur and drain what is behind them, and never saturate it", () => {
    for (const selector of [".ws-switch", ".ws-round", ".ws-menu"]) {
      const d = decls(body(selector));
      expect(d.get("backdrop-filter"), selector).toMatch(/^blur\(\d+px\) grayscale\(0\.6\)$/);
      expect(d.get("-webkit-backdrop-filter"), selector).toBe(d.get("backdrop-filter"));
    }
    // No saturate() of the switch's own: the worst cases are worked out only for SATURATIONS, and 0.4 is not one.
    for (const selector of SWITCH_RULES) expect(body(selector), selector).not.toMatch(/saturate\(/);
    expect(SATURATIONS).not.toContain(0.4);
  });

  it("the colour drain never lightens the backdrop, so the lightest-spot maths still hold under it", () => {
    // grayscale(a) as Filter Effects 1 defines it, in sRGB (as browsers composite) and in linear light; the lighter wins.
    const a = Number(/grayscale\(([\d.]+)\)/.exec(decls(body(".ws-switch")).get("backdrop-filter")!)![1]);
    const s = 1 - a;
    const m = [
      [0.2126 + 0.7874 * s, 0.7152 - 0.7152 * s, 0.0722 - 0.0722 * s],
      [0.2126 - 0.2126 * s, 0.7152 + 0.2848 * s, 0.0722 - 0.0722 * s],
      [0.2126 - 0.2126 * s, 0.7152 - 0.7152 * s, 0.0722 + 0.9278 * s],
    ] as const;
    const toLinear = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
    const toSrgb = (l: number) => 255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055);
    const clip = (v: number, hi: number) => Math.max(0, Math.min(hi, v));
    const drained = (c: Rgb): Rgb[] => {
      const lin = c.map(toLinear);
      return [
        m.map((r) => clip(r[0] * c[0] + r[1] * c[1] + r[2] * c[2], 255)) as unknown as Rgb,
        m.map((r) => toSrgb(clip(r[0] * lin[0]! + r[1] * lin[1]! + r[2] * lin[2]!, 1))) as unknown as Rgb,
      ];
    };
    let checked = 0;
    for (let r = 0; r <= 255; r += 15)
      for (let g = 0; g <= 255; g += 15)
        for (let b = 0; b <= 255; b += 15) {
          const c: Rgb = [r, g, b];
          for (const d of drained(c)) expect(luminance(d), `${c.join(" ")}`).toBeLessThanOrEqual(luminance(c) + 1e-9);
          checked++;
        }
    expect(checked).toBe(18 ** 3);
    // White (a white desktop or photo, the worst spot) stays white: nothing gets lighter than it already planned for.
    for (const d of drained([255, 255, 255])) expect(d.map(Math.round)).toEqual([255, 255, 255]);
  });

  it("its light comes from above and is soft: straight-down gradients, top lights white, foot shades black, no hard line", () => {
    const found: string[] = [];
    for (const selector of SWITCH_RULES)
      for (const [prop, raw] of decls(body(selector))) {
        if (!PAINT.test(prop)) continue;
        const value = resolve(raw);
        for (const g of value.matchAll(/linear-gradient\(([^,]+),/g)) if (g[1]!.trim() !== "180deg") found.push(`${selector} ${prop}: linear-gradient(${g[1]}`);
        for (const g of value.matchAll(/radial-gradient\(([^,]+),/g)) if (!/ at 50% 0$/.test(g[1]!.trim())) found.push(`${selector} ${prop}: radial-gradient(${g[1]}`);
        if (prop !== "box-shadow" && prop !== "--wsg-lens-light") continue;
        for (const layer of layers(value)) {
          if (layer === "none") continue;
          const white = /rgb\(255 255 255/.test(layer);
          const [x = 0, y = 0, blur = 0] = layer
            .replace(/rgba?\([^)]*\)|inset/g, " ")
            .trim()
            .split(/\s+/)
            .map(parseFloat);
          if (blur <= 2) found.push(`${selector}: a hard line ${layer}`);
          if (x !== 0) found.push(`${selector}: light from the side ${layer}`);
          if (/inset/.test(layer) && (white ? y < 0 : y > 0)) found.push(`${selector}: ${white ? "a light from below" : "a shade at the top"} ${layer}`);
          if (!/inset/.test(layer) && y < 0) found.push(`${selector}: a drop above ${layer}`);
        }
      }
    expect(found).toEqual([]);
  });

  it("the chosen side is the brightest: the lens's face is more light than the hover's, and the hover more than rest", () => {
    // The white the words sit on: the lens's even face and the hover's clear glass (e2e/switch-glass.spec.ts measures
    // the lens 0.06 OKLab L or more over the hovered name too).
    const lens = flatWhite(resolve(own.get("--wsg-lens-face")!));
    const hover = Number(/^rgb\(255 255 255 \/ ([\d.]+)\)$/.exec(decls(body(".ws-switch__opt:not(.is-on):hover")).get("background")!)![1]);
    expect(lens).toBeGreaterThanOrEqual(3 * hover);
    expect(hover).toBeGreaterThan(0);
    // At rest an option paints nothing of its own: the track shows through.
    expect(decls(body(".ws-switch__opt")).has("background")).toBe(false);
  });

  it("hover adds light, the round toggle rises by light alone (it has a blur of its own), and a press still springs", () => {
    expect(decls(body(".ws-round:hover")).has("transform")).toBe(false);
    expect(decls(body(".ws-round:hover")).get("background")).not.toBe(decls(body(".ws-round")).get("background"));
    expect(decls(body(".ws-round:hover")).get("box-shadow")).not.toBe(decls(body(".ws-round")).get("box-shadow"));
    expect(decls(body(".ws-round:active")).get("transform")).toBe("scale(0.94)");
    expect(decls(body(".ws-switch__opt:active")).get("transform")).toBe("scale(0.97)");
    // Nothing of the switch transitions a filter, and the glide has no transition of its own (the slide is Glide's
    // Web Animation on transform, §45.38 S3).
    for (const selector of SWITCH_RULES) expect(decls(body(selector)).get("transition") ?? "", selector).not.toMatch(/filter|\ball\b/);
    expect(decls(body(".glide--ws")).has("transition")).toBe(false);
    expect(body(".glide--ws")).not.toMatch(/cursor/);
    for (const selector of SWITCH_RULES) expect(body(selector), selector).not.toMatch(/cursor|!important/);
  });

  it("only its paint changed: the track, the options and the toggle keep their boxes", () => {
    const track = decls(body(".ws-switch"));
    expect([track.get("display"), track.get("gap"), track.get("padding"), track.get("border-radius")]).toEqual(["grid", "2px", "4px", "var(--r-md)"]);
    const opt = decls(body(".ws-switch__opt"));
    expect([opt.get("min-height"), opt.get("padding"), opt.get("line-height"), opt.get("border-radius")]).toEqual(["44px", "0 6px", "44px", "calc(var(--r-md) - 4px)"]);
    expect(decls(body(".glide--ws")).get("border-radius")).toBe("calc(var(--r-md) - 4px)");
    const round = decls(body(".ws-round"));
    expect([round.get("width"), round.get("height"), round.get("border-radius"), round.get("padding")]).toEqual(["44px", "44px", "50%", "0"]);
    expect(decls(body(".ws-round--slim"))).toEqual(new Map([["width", "100%"], ["border-radius", "var(--r-pill)"]]));
  });
});
