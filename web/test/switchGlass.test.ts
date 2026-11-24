import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AA,
  contrast,
  coloursMeshSpots,
  coloursVeils,
  DEFAULT_COLOURS,
  glassChecks,
  oklabL,
  panelWords,
  PICTURE_GLASS,
  SATURATIONS,
  saturateRgb,
  SWATCHES,
  mix,
  windowGlass,
  type NativeGlass,
  type Rgb,
} from "../src/lib/background.ts";
import { ELEVATION, lit as stLit, MEASURED, VEIL as ESPRESSO, WINDOW_CLEAR, WINDOW_FROSTED } from "../src/stories/look.ts";
import { APP_SLIDE_EASE, APP_SLIDE_MS } from "../src/app/shell.ts";
import { GLIDE_MS } from "../src/components/Glide.tsx";

// The workspace switch is see-through, colour-free liquid glass (the owner, 2026-11-23: "make his color freee and
// liquid glass style", then "see through liquid glassy instead of black and white so whatever is under it is visible
// through the glassy buttons"; docs/CONTRACTS.md §45.38 S5). It is one element of the shell, drawn the same over Clip
// Factory's green sidebar and Clips Funded's espresso rail, in both phone top bars and in every look, so none of its
// fills, rims or shades may carry a colour: every one is white or black at an alpha. Its track has no smoke, only a
// faint white tint, so what is under it shows through; its words are white, read over the panel the dock is drawn
// over (e2e/helpers.ts). Here the stylesheets are read so no colour or smoke comes back, the tints stay faint, and the
// recipe is worked out over the lightest panel every look can show: white words at AA on the track, the hover and the
// lens, the lens plainly the chosen side. e2e/switch-glass.spec.ts measures the same in real pixels wherever it is
// drawn, and contrast.spec.ts reads its words as it reads every word.

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
 * The menu's plate: black as strong as the look's own panel tint, never under a floor,
 * `rgb(0 0 0 / max(0.78, var(--panel-veil)))`. The only token a paint may name, and only as the alpha of black.
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

/** Where a bar's words start, down the track: 4 px of padding, then a 44 px option's words 13 px down. */
const WORDS_TOP = 17;
/** The track's white frost as stops: alpha at px down the track (100% is read as the bottom of any track). */
const trackStops = () =>
  [...resolve(own.get("--wsg-track")!).matchAll(/rgb\(255 255 255 \/ ([\d.]+)\) (0|\d+px|100%)/g)].map((m) => ({
    alpha: Number(m[1]),
    at: m[2] === "0" ? 0 : m[2] === "100%" ? Infinity : parseFloat(m[2]!),
  }));
/** The track's white at `y` px down (between its stops, as CSS draws a gradient). */
const trackAt = (y: number) => {
  const stops = trackStops();
  expect(stops.length, "the track's stops").toBeGreaterThan(1);
  expect(stops.at(-1)!.at, "the last stop reaches the bottom").toBe(Infinity);
  for (let i = 1; i < stops.length; i++) {
    const [a, b] = [stops[i - 1]!, stops[i]!];
    // Towards the bottom stop the track's own height decides: the lighter end, so nothing is read darker than drawn.
    if (y <= b.at) return b.at === Infinity ? Math.max(a.alpha, b.alpha) : a.alpha + ((b.alpha - a.alpha) * (y - a.at)) / (b.at - a.at);
  }
  return stops.at(-1)!.alpha;
};
/** The hover's light: box-shadows in its top few px and a rim, above the words. */
const hoverShadows = () => layers(resolve(decls(body(".ws-switch__opt:not(.is-on):hover")).get("box-shadow")!));
/** The hover's own lift under the words: one even clear white, `rgb(255 255 255 / a)`: its alpha. */
const hoverLift = () => {
  const v = decls(body(".ws-switch__opt:not(.is-on):hover")).get("background-color") ?? "";
  const m = /^rgb\(255 255 255 \/ ([\d.]+)\)$/.exec(v);
  expect(m, `hover's lift ${v}: one clear white`).not.toBeNull();
  return Number(m![1]);
};

/** The Live chip under the switch, in the dock and at a phone's top bar: the shell's own (glide.css). */
const LIVE = ".ws-dock > .ws-dock__live > .live-dot, .ws-switch-host--topbar > .live-dot";
/** The chip where it is over no panel (a phone's top bar, Clips Funded's first Setup on a computer): its tint. */
const LIVE_BARE = ".ws-switch-host--topbar > .live-dot, html[data-ws-bare] .ws-dock > .ws-dock__live > .live-dot";
/** Where the chip's word starts, down its box: 1 px of border, 4 px of padding, then about 1.8 px of half-leading. */
const LIVE_WORDS_TOP = 6;
/** A top-down white frost's alpha at `y` px down (its stops in px, the last at 100%), as CSS draws it. */
const frostAt = (v: string, y: number) => {
  const stops = [...v.matchAll(/rgb\(255 255 255 \/ ([\d.]+)\) (0|\d+px|100%)/g)].map((m) => ({ alpha: Number(m[1]), at: m[2] === "0" ? 0 : m[2] === "100%" ? Infinity : parseFloat(m[2]!) }));
  expect(stops.length, v).toBeGreaterThan(1);
  for (let i = 1; i < stops.length; i++) {
    const [a, b] = [stops[i - 1]!, stops[i]!];
    if (y <= b.at) return b.at === Infinity ? Math.max(a.alpha, b.alpha) : a.alpha + ((b.alpha - a.alpha) * (y - a.at)) / (b.at - a.at);
  }
  return stops.at(-1)!.alpha;
};

describe("the workspace switch is see-through, colour-free glass (§45.38 S5)", () => {
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

  it("no other rule repaints it: not a look of Clip Factory's (the window, the picture), not Clips Funded's own styles", () => {
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
    // The old repaint (the pick-one track's bone-on-green --fill-control) is gone: the switch is its own clear glass.
    expect(glide).not.toMatch(/\.ws-dock \.ws-switch \{/);
  });

  it("its words are white on both sides with a soft neutral halo, never a bone pill's colour", () => {
    expect(decls(body(".ws-switch__opt")).get("color")).toBe("#fff");
    // The chosen name and a hovered one keep the same white: the lens and the hover add light under them, not ink.
    for (const selector of [".ws-switch__opt.is-on", ".ws-switch__opt:not(.is-on):hover"]) expect(decls(body(selector)).has("color"), selector).toBe(false);
    expect(glide).not.toMatch(/--on-bone|#141414/);
    // The soft dark halo is for comfort only (never counted toward AA) and neutral, like every shade here.
    const halo = decls(body(".ws-switch__opt")).get("text-shadow")!;
    expect(tinted(halo)).toEqual([]);
    for (const layer of layers(halo)) expect(layer, "a soft halo, never a hard line").toMatch(/^0 (?:0|\d+px) [1-9]\d*px rgb\(0 0 0 \/ 0\.\d+\)$/);
  });

  it("the track is see-through: a faint white tint and no smoke, so what is under it shows through in its own colours", () => {
    expect(own.has("--wsg-smoke")).toBe(false);
    expect(body(".ws-switch")).not.toMatch(/--panel-veil|rgb\(0 0 0 \/ (?:0?\.[3-9]|1)/);
    const track = layers(resolve(own.get("--wsg-track")!));
    expect(track, "one layer: a white frost from above, no colour or smoke under it").toHaveLength(1);
    expect(resolve(decls(body(".ws-switch")).get("background")!)).toBe(track[0]);
    expect(track[0]).not.toMatch(/rgb\(0 0 0/);
    const stops = trackStops();
    expect(stops.length, "every stop of the track is white").toBe(track[0]!.match(/rgb\(/g)!.length);
    for (const st of stops) expect(st.alpha, "a faint frost").toBeLessThanOrEqual(0.16);
    // Where the words sit (17 px down the track and below: a 44 px option's words start 13 px down, under 4 px of
    // padding), a faint even tint and no more; the frost above them is gone by then.
    expect(trackAt(WORDS_TOP)).toBeGreaterThan(0);
    expect(trackAt(WORDS_TOP)).toBeLessThanOrEqual(0.1);
    expect(trackAt(WORDS_TOP + 40)).toBe(trackAt(WORDS_TOP));
    expect(decls(body(".ws-switch")).has("background-color")).toBe(false);
    // The lens (the chosen side) is brighter clear glass, still see-through, its catch light bright.
    const lens = flatWhite(resolve(own.get("--wsg-lens-face")!));
    expect(lens).toBeGreaterThanOrEqual(0.14);
    expect(lens).toBeLessThanOrEqual(0.2);
    // The round toggle is not over a panel (a phone's top bar, beside the sidebar): a slightly stronger neutral tint,
    // still see-through, so its edge shows over a white desktop; its mark holds its own colours on its own tile.
    const round = layers(decls(body(".ws-round")).get("background")!).at(-1)!;
    const roundTint = /^rgb\(0 0 0 \/ ([\d.]+)\)$/.exec(round);
    expect(roundTint, round).not.toBeNull();
    expect(Number(roundTint![1])).toBeLessThanOrEqual(0.25);
    // ...and no less: that tint is what keeps its edge over a white desktop or photo.
    expect(Number(roundTint![1])).toBeGreaterThanOrEqual(0.15);
    // The menu a round toggle opens holds its words by itself: a readable plate, never under the panel tint.
    expect(layers(decls(body(".ws-menu")).get("background")!).at(-1)).toBe("rgb(0 0 0 / max(0.78, var(--panel-veil)))");
  });

  it("the lens's light lies above its words: a catch light 9 px deep and a top light gone by 12 px", () => {
    const top = layers(resolve(own.get("--wsg-lens-top")!));
    expect(top).toHaveLength(2);
    const catchLight = /^radial-gradient\(\d+% (\d+)px at 50% 0, rgb\(255 255 255 \/ [\d.]+\), transparent\)$/.exec(top[0]!);
    expect(catchLight, top[0]).not.toBeNull();
    expect(Number(catchLight![1])).toBeLessThanOrEqual(9);
    // A bright catch light on its top edge, so the chosen side reads as lit glass.
    expect(Number(/rgb\(255 255 255 \/ ([\d.]+)\)/.exec(top[0]!)![1])).toBeGreaterThanOrEqual(0.4);
    const fade = /^linear-gradient\(180deg, rgb\(255 255 255 \/ [\d.]+\) 0, rgb\(255 255 255 \/ 0\) (\d+)px\)$/.exec(top[1]!);
    expect(fade, top[1]).not.toBeNull();
    // A 44 px option's words (14 px, a 17 px line box) start 13 px down.
    expect(Number(fade![1])).toBeLessThanOrEqual(12);
    flatWhite(resolve(own.get("--wsg-lens-face")!));
  });

  it("the dock dims and clips the switch's own parts, never its host (which would cut its glass off from what is behind)", () => {
    // Filter Effects 2: an ancestor with an opacity under 1, a clip, a mask or a filter is the Backdrop Root of the
    // switch's glass, whose blur and light would then see nothing behind it, so the backdrop would flash back sharp.
    const ROOT = /(?:^|;)\s*(opacity|clip-path|mask|filter|backdrop-filter|mix-blend-mode|animation)\s*:/;
    const host = ruleList(glide).filter(([sel]) => sel.split(",").some((one) => /\.ws-switch-host(?:--[a-z]+)?(?:\[[^\]]*\])?$/.test(one.trim())));
    expect(host.length).toBeGreaterThan(0);
    for (const [sel, rule] of host) expect(ROOT.exec(rule)?.[1] ?? null, sel).toBeNull();
    expect(decls(body(".ws-dock.is-under > .ws-switch-host > *, .ws-dock.is-under > .ws-dock__live > *")).get("opacity")).toBe("0.34");
    expect(decls(body('.ws-dock.is-unfolding:not([data-ws-dock="edge"]) > .ws-switch-host > *')).get("animation")).toMatch(/^ws-dock-unfold /);
    // The Live chip is glass of its own too: it carries its dim and its clip itself, never its row, and its own
    // arrival (live-in) stays in its list, so unfolding never plays it again.
    const row = ruleList(glide).filter(([sel]) => sel.split(",").some((one) => /\.ws-dock__live$/.test(one.trim())));
    for (const [sel, rule] of row) expect(ROOT.exec(rule)?.[1] ?? null, sel).toBeNull();
    expect(layers(decls(body(".ws-dock.is-unfolding > .ws-dock__live > .live-dot")).get("animation")!).map((a) => a.split(" ")[0])).toEqual(["live-in", "ws-dock-unfold"]);
    // The switch's parts and the chip fade with the dim on their own transition (opacity only).
    for (const selector of [".ws-switch", ".ws-round", ".ws-menu", LIVE]) expect(decls(body(selector)).get("transition"), selector).toMatch(/opacity 200ms ease/);
  });

  it("the dock's placed parts land at once, also under reduced motion: the dock's frame, the switch's host and the Live chip's row never transition", () => {
    // Under reduced motion base.css gives every element a 1 ms transition of every property (transition-property is
    // `all` unless a rule says otherwise). A 1 ms move of the dock's host still waits for the next animation frame, and
    // on CI's runner that frame came over a second late in the Colours look: the switch was read at the place it was
    // first given (over Get the app and the jobs line) and pictured at its real one, so its words read 1.17:1 against
    // Get the app's own white words (PR #186; e2e/switch-glass.spec.ts holds the same in real pixels, every frame held).
    const reduced = ruleList(sheet(STYLES, "base.css")).filter(([sel, rule]) => sel === "*, *::before, *::after" && decls(rule).has("transition-duration"));
    expect(reduced, "base.css's reduced-motion rule").toHaveLength(1);
    expect(decls(reduced[0]![1]).get("transition-duration")).toBe("1ms !important");
    expect(decls(body(".ws-dock > .ws-switch-host, .ws-dock > .ws-dock__live")).get("transition")).toBe("none");
    // The frame they are placed in (the sidebar's box on a wide window) takes its folded or open width at once too.
    const frame = ruleList(glide).filter(([sel, rule]) => sel === ".ws-dock" && decls(rule).get("position") === "fixed");
    expect(frame, "the dock's frame on a wide window").toHaveLength(1);
    expect(decls(frame[0]![1]).get("transition")).toBe("none");
    // No later rule of glide.css hands the frame or either part a transition back.
    const placed = ruleList(glide).filter(([sel]) =>
      sel.split(",").some((one) => /^\.ws-dock(?:\.[a-z-]+|\[[^\]]*\]|:[a-z-]+\([^)]*\))*(?: > (?:\.ws-switch-host|\.ws-dock__live|\.sidebar__live))?$/.test(one.trim())),
    );
    expect(placed.length).toBeGreaterThan(4);
    const handedBack = placed.flatMap(([sel, rule]) =>
      [...decls(rule)].filter(([prop, value]) => prop.startsWith("transition") && !(prop === "transition" && value === "none")).map(([prop, value]) => `${sel} { ${prop}: ${value} }`),
    );
    expect(handedBack).toEqual([]);
  });

  it("the track, the round toggle and the menu blur what is behind them and take back a little light, its colours kept", () => {
    for (const selector of [".ws-switch", ".ws-round", ".ws-menu"]) {
      const d = decls(body(selector));
      const f = /^blur\((\d+)px\) brightness\(([\d.]+)\)$/.exec(d.get("backdrop-filter") ?? "");
      expect(f, `${selector}: ${d.get("backdrop-filter")}`).not.toBeNull();
      expect(Number(f![1]), selector).toBeGreaterThanOrEqual(12);
      if (selector !== ".ws-menu") expect(Number(f![1]), selector).toBeLessThanOrEqual(16);
      expect(Number(f![2]), selector).toBeGreaterThanOrEqual(0.9);
      expect(Number(f![2]), selector).toBeLessThanOrEqual(1);
      expect(d.get("-webkit-backdrop-filter"), selector).toBe(d.get("backdrop-filter"));
    }
    // The stacked switch inside the list is the list's glass: the list is its Backdrop Root, so a blur of its own would
    // see only the list's dark plate and darken what shows through it. On the plate its lens is the lens's brightest.
    const inMenu = decls(body(".ws-menu .ws-switch"));
    expect([...inMenu.keys()].sort()).toEqual(["--wsg-lens-face", "-webkit-backdrop-filter", "backdrop-filter"]);
    expect([inMenu.get("backdrop-filter"), inMenu.get("-webkit-backdrop-filter")]).toEqual(["none", "none"]);
    const menuLens = flatWhite(inMenu.get("--wsg-lens-face")!);
    expect(menuLens).toBeGreaterThanOrEqual(flatWhite(resolve(own.get("--wsg-lens-face")!)));
    expect(menuLens).toBeLessThanOrEqual(0.2);
    // White words on that lens over the lightest the plate can be (black 0.78 over white, then the lens): far past AA.
    const plate: Rgb = mix([0, 0, 0], [255, 255, 255], 0.78);
    expect(contrast([255, 255, 255], mix([255, 255, 255], plate, menuLens))).toBeGreaterThanOrEqual(AA);
    // Nothing drains, tints or saturates what shows through: grey-out would hide the colours behind, and saturate()
    // would lift a vermilion or grape panel past the room white words have on the lens (worked out below).
    for (const selector of SWITCH_RULES) expect(body(selector), selector).not.toMatch(/grayscale\(|saturate\(|sepia\(|hue-rotate\(|invert\(|contrast\(/);
  });

  it("white words keep AA on the track, the hover and the lens over the lightest panel any look shows, the lens plainly chosen", () => {
    // What the switch's words sit on (glide.css), worked out over every panel its dock can be drawn over: the panel at
    // the height of its words (lib/background.ts panelWords; Clips Funded's rail as stories/look.ts lays it), through
    // the switch's brightness() in sRGB as Chromium and WebKit apply the shorthands, then the track's faint white
    // where the words sit, then the hover's or the lens's white. The app's own living backdrop is measured in pixels
    // where the dock is drawn (e2e/switch-glass.spec.ts, contrast.spec.ts): under the sidebar's foot it is the deep
    // field under the deep vermilion glow, never the mesh's lightest corner, which no part of the dock reaches.
    // In the window looks the desktop itself shows through the window, under the page: a web backdrop-filter sees only
    // the page, so brightness() takes light only from the panel's own tint (what it lays over the window, `web`: the
    // panel over black), never from the desktop under it. A white and a black desktop are behind it too (the window
    // look's stand-ins, e2e/glass.ts WHITE), as well as the glass's own lightest and darkest.
    const k = Number(/brightness\(([\d.]+)\)/.exec(decls(body(".ws-switch")).get("backdrop-filter")!)![1]);
    const track = trackAt(WORDS_TOP);
    const lens = flatWhite(resolve(own.get("--wsg-lens-face")!));
    const W: Rgb = [255, 255, 255];
    const B: Rgb = [0, 0, 0];
    /** What the panel lays over the window (premultiplied: the panel over black), or null where all of it is the page's. */
    const panels: { at: string; under: Rgb; web: Rgb | null }[] = [];
    const GLASSES: NativeGlass[] = ["liquid", "vibrancy", "mica", "acrylic", "blur"];
    for (const glass of GLASSES)
      for (const scheme of ["light", "dark"] as const)
        for (const strength of ["clear", "frosted"] as const) {
          const look = { kind: "window" as const, ...windowGlass(glass, scheme, strength) };
          const web = panelWords(look, B);
          for (const { name, behind } of [...glassChecks(glass, scheme), { name: "a white desktop", behind: W }, { name: "a black desktop", behind: B }])
            for (const sat of SATURATIONS) panels.push({ at: `window ${glass} ${scheme} ${strength} over ${name}`, under: panelWords(look, saturateRgb(behind, sat)), web });
        }
    for (const behind of [W, B]) panels.push({ at: `picture over ${behind.join(" ")}`, under: panelWords({ kind: "picture", ...PICTURE_GLASS }, behind), web: null });
    // The colours: the default, every swatch alone and every pair, over every corner of their mesh.
    const sets: string[][] = [[...DEFAULT_COLOURS], ...SWATCHES.map((s) => [s.hex])];
    for (const a of SWATCHES) for (const b of SWATCHES) if (a !== b) sets.push([a.hex, b.hex]);
    for (const colours of sets) {
      const look = { kind: "colours" as const, ...coloursVeils(colours), colours };
      for (const spot of coloursMeshSpots(colours)) panels.push({ at: `colours ${colours.join(" ")}`, under: panelWords(look, spot), web: null });
    }
    // Clips Funded's rail over a white or a black picture or desktop, at the foot (its level-1 light, settled).
    for (const [name, v] of [["picture", MEASURED], ["window clear", WINDOW_CLEAR], ["window frosted", WINDOW_FROSTED]] as const)
      for (const behind of [W, B])
        panels.push({ at: `Clips Funded's rail, ${name}`, under: stLit(mix(ESPRESSO, behind, v.page), v.rail, ELEVATION[1]!), web: name === "picture" ? null : stLit(mix(ESPRESSO, B, v.page), v.rail, ELEVATION[1]!) });
    expect(panels.length).toBeGreaterThan(4000);
    /** What is under the switch's glass once its brightness(kk) has taken its light: all of it, or only the panel's own. */
    const seen = ({ under, web }: { under: Rgb; web: Rgb | null }, kk: number) => under.map((c, i) => c - (1 - kk) * (web ? web[i]! : c)) as unknown as Rgb;

    // The Live chip under the switch: the same glass, its word white on its own frost where the word starts.
    const liveK = Number(/brightness\(([\d.]+)\)/.exec(decls(body(LIVE)).get("backdrop-filter")!)![1]);
    const liveFrost = frostAt(decls(body(LIVE)).get("background")!, LIVE_WORDS_TOP);
    const hover = hoverLift();
    const fails: string[] = [];
    let least = { aa: Infinity, lift: Infinity, live: Infinity };
    for (const panel of panels) {
      const { at } = panel;
      // A hovered name's words sit on the track and its faint clear lift (its light lies above them).
      const rest = mix(W, seen(panel, k), track);
      const hovered = mix(W, rest, hover);
      const lensOn = mix(W, rest, lens);
      const aa = Math.min(contrast(W, rest), contrast(W, hovered), contrast(W, lensOn));
      // The lens over the other name at rest and hovered: the hovered one is the lighter, so its lift is the least.
      const lift = Math.min(oklabL(lensOn) - oklabL(rest), oklabL(lensOn) - oklabL(hovered));
      const live = contrast(W, mix(W, seen(panel, liveK), liveFrost));
      least = { aa: Math.min(least.aa, aa), lift: Math.min(least.lift, lift), live: Math.min(least.live, live) };
      if (aa < AA) fails.push(`${at}: white words ${aa.toFixed(2)}:1`);
      // Plainly the chosen side for a child (S5), at rest and while the other name is hovered (the same lift).
      if (lift < 0.06) fails.push(`${at}: the lens only +${lift.toFixed(3)} OKLab L over the track`);
      if (live < AA) fails.push(`${at}: the Live chip's word ${live.toFixed(2)}:1`);
    }
    expect([...new Set(fails)].slice(0, 12), JSON.stringify(least)).toEqual([]);
    // Over no panel (a phone's top bar, Clips Funded's first Setup on a computer) the chip's tint holds its word by
    // itself over a white, a black, a cream or a copper photo, page or desktop, at its floor (the look's panel tint
    // only ever adds to it). Read as a desktop: its brightness() takes no light from it (it dims only the page).
    const liveTint = Number(/^rgb\(0 0 0 \/ max\(([\d.]+), var\(--panel-veil\)\)\)$/.exec(layers(decls(body(LIVE_BARE)).get("background")!).at(-1)!)![1]);
    const bareFrost = frostAt(layers(decls(body(LIVE_BARE)).get("background")!)[0]!, LIVE_WORDS_TOP);
    for (const behind of [W, [0, 0, 0] as Rgb, [0xe2, 0x62, 0x1f] as Rgb, [0xf7, 0xf5, 0xef] as Rgb]) {
      const tinted = mix(B, behind, liveTint);
      expect(contrast(W, mix(W, tinted, bareFrost)), `the Live chip over no panel, ${behind.join(" ")}`).toBeGreaterThanOrEqual(AA);
    }
    // The menu's plate holds the stacked switch's words by itself, over a white or a black page or desktop (read as
    // a desktop, which its brightness() never dims), on the lens it carries there (the stacked switch inside it has no
    // glass of its own, so nothing takes light back under its words).
    const plate = Number(/max\(([\d.]+), var\(--panel-veil\)\)/.exec(decls(body(".ws-menu")).get("background")!)![1]);
    const plateLight = Math.max(...[...decls(body(".ws-menu")).get("background")!.matchAll(/rgb\(255 255 255 \/ ([\d.]+)\)/g)].map((m) => Number(m[1])));
    const menuLens = flatWhite(decls(body(".ws-menu .ws-switch")).get("--wsg-lens-face")!);
    for (const behind of [W, B]) {
      const onPlate = mix(W, mix(B, behind, plate), plateLight);
      const rest = mix(W, onPlate, track);
      expect(contrast(W, mix(W, rest, menuLens)), `the menu over ${behind.join(" ")}`).toBeGreaterThanOrEqual(AA);
    }
    // Clips Funded's phone top bar in its Picture and See-through looks is the list's Backdrop Root (its blur sees
    // only the bar): there the plate is denser, so the page under it shows as a faint shade, never readable words.
    // The shell finds Clips Funded by its own pane, never by Clips Funded's classes (glide.css is in the main bundle,
    // which carries none of its styles: ci.yml "Clips Funded is not in the main bundle").
    const sharp = body('[data-app-pane="stories"] :is([data-look="window"], [data-look="picture"]) .ws-menu');
    expect(layers(decls(sharp).get("background")!).at(-1)).toBe("rgb(0 0 0 / max(0.92, var(--panel-veil)))");
    expect(glide, "no Clips Funded marker in the shell's sheet").not.toMatch(/stories-app|--st-|\.st-[a-z]/);
    // Over no panel (Clips Funded's first-time Setup on a computer, no rail under the dock): the track's own plate
    // holds white words at AA on the track and the lens over a white or a black photo or desktop, and over the default
    // look's copper glow, the lens still plainly the chosen side (read as a desktop, which brightness() never dims).
    const bare = body("html[data-ws-bare] .ws-dock > .ws-switch-host > .ws-switch");
    const bareTrack = layers(resolve(decls(bare).get("--wsg-track")!));
    expect(bareTrack).toHaveLength(2);
    expect(bareTrack[0], "the same frost").toBe(resolve(own.get("--wsg-track")!));
    const bareSmoke = Number(/^rgb\(0 0 0 \/ max\(([\d.]+), var\(--panel-veil\)\)\)$/.exec(bareTrack[1]!)![1]);
    for (const behind of [W, [0, 0, 0] as Rgb, [0xe2, 0x62, 0x1f] as Rgb, [0xf7, 0xf5, 0xef] as Rgb]) {
      const plated = mix(B, behind, bareSmoke);
      const rest = mix(W, plated, track);
      const lensOn = mix(W, rest, lens);
      expect(Math.min(contrast(W, rest), contrast(W, lensOn)), `over no panel, ${behind.join(" ")}`).toBeGreaterThanOrEqual(AA);
      expect(oklabL(lensOn) - oklabL(rest), `the lens over no panel, ${behind.join(" ")}`).toBeGreaterThanOrEqual(0.06);
    }
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

  it("the chosen side is the brightest: hover lays only a faint clear lift under the words, and its light lies above them", () => {
    // The white the words sit on: the lens's even face (worked out above over every panel, and measured in pixels by
    // e2e/switch-glass.spec.ts). Hover lays a faint clear lift of its own under them, so the control shows itself on
    // hover (the owner's rule, e2e/stories-shell.spec.ts reads its background), far under the lens, so the lens keeps
    // its lift over a hovered name (worked out above). One even white, no image: nothing of the lens's light.
    const lensFace = flatWhite(resolve(own.get("--wsg-lens-face")!));
    expect(lensFace).toBeGreaterThan(0);
    expect(decls(body(".ws-switch__opt:not(.is-on):hover")).has("background")).toBe(false);
    expect(decls(body(".ws-switch__opt:not(.is-on):hover")).has("background-image")).toBe(false);
    const lift = hoverLift();
    expect(lift, "a lift that shows").toBeGreaterThan(0);
    expect(lift, "faint and clear, never a fill").toBeLessThanOrEqual(0.04);
    expect(lift, "far under the lens").toBeLessThanOrEqual(lensFace / 4);
    // It fades in on the option's own transition.
    expect(decls(body(".ws-switch__opt")).get("transition")).toMatch(/background-color/);
    // Its light: a white top light that ends above the words (offset + blur + spread inside 13 px, where they start
    // in a 44 px option), and a faint white rim of a few px.
    const shadows = hoverShadows();
    expect(shadows.length).toBeGreaterThanOrEqual(1);
    let top = 0;
    for (const layer of shadows) {
      expect(layer, "hover's light is white and inside its box").toMatch(/^inset 0 (?:0|\d+px) \d+px (?:-?\d+px )?rgb\(255 255 255 \/ [\d.]+\)$/);
      const [, y = 0, blur = 0, spread = 0] = layer.replace(/inset|rgb\([^)]*\)/g, " ").trim().split(/\s+/).map(parseFloat);
      // An inset light's lower edge sits y + spread down, and its blur reaches that much further.
      expect(Math.max(y + spread, 0) + blur, `${layer}: reaches no further than the words' top`).toBeLessThanOrEqual(13);
      if (y > 0) top = Math.max(top, Number(/\/ ([\d.]+)\)$/.exec(layer)![1]));
    }
    expect(top, "a top light that shows").toBeGreaterThanOrEqual(0.3);
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

describe("the Live chip under the switch is the same see-through glass (§45.38 S5)", () => {
  // The owner, 23 Nov, with a screenshot of the dock: "this should be see through but liquid glassy like" and "the live
  // indicator should be one glasssy liquyid theme as well". The shell's chip (the dock's, and the one at a phone's top
  // bar) is the switch track's own glass: a faint clear frost and no fill, the track's blur, a clear rim and a soft top
  // light, white words; only its light keeps its colour (green says "live"). Worked out on paper with the switch,
  // above; e2e/switch-glass.spec.ts measures it in pixels.
  const chip = decls(body(LIVE));
  const components = sheet(STYLES, "components.css");

  it("a faint white frost from above and no fill of its own: what is under it shows through", () => {
    const bg = layers(chip.get("background")!);
    expect(bg, "one layer: a white frost, no colour or smoke under it").toHaveLength(1);
    expect(bg[0]).toMatch(/^linear-gradient\(180deg, /);
    expect(bg[0]).not.toMatch(/rgb\(0 0 0|var\(/);
    const stops = [...bg[0]!.matchAll(/rgb\(255 255 255 \/ ([\d.]+)\)/g)].map((m) => Number(m[1]));
    expect(stops.length, "every stop is white").toBe(bg[0]!.match(/rgb\(/g)!.length);
    for (const a of stops) expect(a, "a faint frost").toBeLessThanOrEqual(0.16);
    // As the track: its brightest at the top, and where its word sits the very tint the track lays under the names.
    expect(frostAt(bg[0]!, 0)).toBe(frostAt(resolve(own.get("--wsg-track")!), 0));
    expect(frostAt(bg[0]!, LIVE_WORDS_TOP)).toBeCloseTo(trackAt(WORDS_TOP), 6);
    expect(frostAt(bg[0]!, LIVE_WORDS_TOP + 20)).toBeCloseTo(frostAt(bg[0]!, LIVE_WORDS_TOP), 6);
    expect(chip.has("background-color")).toBe(false);
    // The app's .glass border stays clear (the chip carries the class): no line of colour round it.
    expect(chip.get("border-color")).toBe("transparent");
  });

  it("the track's own blur, no saturate, its rim and top light soft and white, its foot shade black, all inside its box", () => {
    expect(chip.get("backdrop-filter")).toBe(decls(body(".ws-switch")).get("backdrop-filter"));
    expect(chip.get("-webkit-backdrop-filter")).toBe(chip.get("backdrop-filter"));
    expect(body(LIVE)).not.toMatch(/grayscale\(|saturate\(|sepia\(|hue-rotate\(|invert\(|contrast\(/);
    const shadows = layers(chip.get("box-shadow")!);
    expect(shadows.length).toBeGreaterThanOrEqual(2);
    for (const layer of shadows) {
      expect(layer, "inside its box").toMatch(/^inset /);
      const white = /rgb\(255 255 255/.test(layer);
      expect(white || /rgb\(0 0 0/.test(layer), `${layer}: white or black`).toBe(true);
      const [x = 0, y = 0, blur = 0] = layer.replace(/rgba?\([^)]*\)|inset/g, " ").trim().split(/\s+/).map(parseFloat);
      expect(blur, `${layer}: soft, never a hard line`).toBeGreaterThan(2);
      expect(x, `${layer}: from above, not the side`).toBe(0);
      expect(white ? y >= 0 : y <= 0, `${layer}: light from above, shade at the foot`).toBe(true);
    }
    expect(shadows.some((l) => /^inset 0 [1-9]\d*px .*rgb\(255 255 255/.test(l)), "a soft top light").toBe(true);
    expect(shadows.some((l) => /^inset 0 0 \d+px rgb\(255 255 255/.test(l)), "a clear rim").toBe(true);
  });

  it("white words with the switch's soft neutral halo; its light keeps its green", () => {
    expect(chip.get("color")).toBe("#fff");
    expect(chip.get("text-shadow")).toBe(decls(body(".ws-switch__opt")).get("text-shadow"));
    const light = /\.live-dot__light \{([^}]*)\}/.exec(components)![1]!;
    expect(decls(light).get("background")).toMatch(/var\(--green-leaf\)/);
  });

  it("every paint is white or black at an alpha, and no other rule repaints it", () => {
    for (const selector of [LIVE, LIVE_BARE]) {
      const found: string[] = [];
      for (const [prop, value] of decls(body(selector))) if (PAINT.test(prop)) for (const t of tinted(value)) found.push(`${prop}: ${t}`);
      expect(found, selector).toEqual([]);
    }
    const sheets = [
      ...readdirSync(STYLES).filter((f) => f.endsWith(".css")).map((f) => [`styles/${f}`, sheet(STYLES, f)] as const),
      ...readdirSync(STORIES_STYLES).filter((f) => f.endsWith(".css")).map((f) => [`stories/styles/${f}`, sheet(STORIES_STYLES, f)] as const),
    ];
    const found: string[] = [];
    for (const [file, text] of sheets)
      for (const [selector, rule] of ruleList(text)) {
        if (!/\.live-dot(?![\w-])/.test(selector) || selector === LIVE || selector === LIVE_BARE) continue;
        for (const [prop] of decls(rule)) if (PAINT.test(prop) || /backdrop-filter|^color$|text-shadow/.test(prop)) found.push(`${file} ${selector} { ${prop} }`);
      }
    // The base chip (components.css .live-dot) sets its words' bone for the sidebar's own chip; the shell's rule wins.
    expect(found).toEqual(["styles/components.css .live-dot { color }"]);
  });

  it("over no panel it carries the tint its word needs, still see-through, under the same frost", () => {
    const bg = layers(decls(body(LIVE_BARE)).get("background")!);
    expect(bg).toHaveLength(2);
    expect(bg[0], "the same frost").toBe(chip.get("background"));
    // Its word sits straight on the window there, so its tint is never under the look's own panel tint (§22.3: the
    // window look's 0.73 or 0.88; e2e/helpers.ts looseText holds every word on the window to it), and never under a
    // floor of its own where that tint is lighter.
    const m = /^rgb\(0 0 0 \/ max\(([\d.]+), var\(--panel-veil\)\)\)$/.exec(bg[1]!);
    expect(m, `${bg[1]}: never under the panel tint`).not.toBeNull();
    const tint = Number(m![1]);
    expect(tint, "enough for white words over a white photo or desktop (worked out above)").toBeGreaterThanOrEqual(0.5);
    expect(tint, "never a solid plate of its own").toBeLessThanOrEqual(0.66);
    expect([...decls(body(LIVE_BARE)).keys()], "only its tint changes").toEqual(["background"]);
  });

  it("never transitions a filter, no cursor, nothing important", () => {
    for (const selector of [LIVE, LIVE_BARE, ".ws-dock.is-unfolding > .ws-dock__live > .live-dot"]) {
      expect(decls(body(selector)).get("transition") ?? "", selector).not.toMatch(/filter|\ball\b/);
      expect(body(selector), selector).not.toMatch(/cursor|!important/);
    }
  });
});

describe("the whole switch moves slow in, slow out (§45.38 S3)", () => {
  // The owner, 23 Nov: "make sure the switch between clip factory and clips funded uses slow in slow out effect when
  // switching between them". One symmetric curve for both panes' slide and the switch's lens, for one length.
  const tokens = sheet(STYLES, "tokens.css");
  const token = (name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(tokens)?.[1]?.trim();

  it("tokens.css has the slow-in slow-out curve beside the ease-out, and the shell's fallback is the same curve", () => {
    expect(token("--ease-out"), "the ease-out stays").toBe("cubic-bezier(0.16, 1, 0.3, 1)");
    expect(token("--ease-in-out")).toBe("cubic-bezier(0.65, 0, 0.35, 1)");
    expect(APP_SLIDE_EASE).toBe(token("--ease-in-out"));
    // Symmetric: it starts as gently as it settles.
    const [x1, y1, x2, y2] = APP_SLIDE_EASE.match(/-?\d*\.?\d+/g)!.map(Number);
    expect(x1! + x2!).toBeCloseTo(1, 6);
    expect(y1! + y2!).toBeCloseTo(1, 6);
  });

  it("the switch's lens takes that curve (.glide--ws), and no other glide does", () => {
    expect(decls(body(".glide--ws")).get("--glide-ease")).toBe("var(--ease-in-out)");
    const others = ruleList(glide).filter(([sel, b]) => /--glide-ease\s*:/.test(b) && sel !== ".glide--ws");
    expect(others.map(([sel]) => sel)).toEqual([]);
  });

  it("the lens slides as long as the panes, and the other glides keep their own length", () => {
    expect(APP_SLIDE_MS).toBe(450);
    expect(GLIDE_MS).toBe(360);
    const dock = readFileSync(join(import.meta.dirname, "..", "src", "app", "WorkspaceDock.tsx"), "utf8");
    const lenses = [...dock.matchAll(/<Glide [^>]*className="glide--ws"[^>]*\/>/g)].map((m) => m[0]);
    expect(lenses.length, "the bar's lens and the menu's").toBe(2);
    for (const l of lenses) expect(l).toContain("ms={APP_SLIDE_MS}");
  });
});
