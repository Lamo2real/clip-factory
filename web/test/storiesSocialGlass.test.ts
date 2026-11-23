// Clip Factory Stories › Social accounts and the setup on the liquid glass (styles/GLASS-CONTRACT.md): their four style
// files use the contract's tokens only (no old names, no Clip Factory radii, no colour written out, no token defined
// here), and every word on their boxes reaches 4.5:1 over the worst each look can show: Ember's lightest light, a
// white or busy desktop or photo behind the measured veils (See-through Clear), a white photo through each glass's own
// filter (Picture: it dims the picture before the veil, glass-tokens.css --st-dim), and Frosted. The tiles inside a
// card take the look-aware control fill: a light cream lift over the colours, a veil over a picture or the desktop (so
// there they are a step deeper); notes and tinted cards carry the tinted veil under their colour, over what their own
// filter shows; wells are deeper still. From look.ts only what the contract lists (veilsFor); every colour and alpha comes
// from glass-tokens.css, so a change there is checked here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { veilsFor, type StoriesLook } from "../src/stories/look.ts";

type Rgb = readonly [number, number, number];
/** WCAG 2.x colour maths, Stories' own copy for this check. */
const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a: Rgb, b: Rgb) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};
/** `top` at `alpha` over `under`. */
const mix = (top: Rgb, under: Rgb, alpha: number): Rgb => top.map((c, i) => c * alpha + under[i]! * (1 - alpha)) as unknown as Rgb;
/** CSS saturate(s) on one colour (the filter matrix, clamped): what a bar's or a liquid hero's filter does to the stage. */
const saturate = ([r, g, b]: Rgb, s: number): Rgb => {
  const k = (v: number) => Math.max(0, Math.min(255, v));
  return [
    k((0.2126 + 0.7874 * s) * r + (0.7152 - 0.7152 * s) * g + (0.0722 - 0.0722 * s) * b),
    k((0.2126 - 0.2126 * s) * r + (0.7152 + 0.2848 * s) * g + (0.0722 - 0.0722 * s) * b),
    k((0.2126 - 0.2126 * s) * r + (0.7152 - 0.7152 * s) * g + (0.0722 + 0.9278 * s) * b),
  ];
};
const hexToRgb = (hex: string): Rgb => [0, 2, 4].map((i) => parseInt(hex.replace("#", "").slice(i, i + 2), 16)) as unknown as Rgb;
const toHex = (c: Rgb) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
const WHITE: Rgb = [255, 255, 255];

const DIR = join(import.meta.dirname, "..", "src", "stories", "styles");
const FILES = ["social.css", "st-connections.css", "st-social-auth.css", "st-setup.css"] as const;
const read = (f: string) => readFileSync(join(DIR, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const css = Object.fromEntries(FILES.map((f) => [f, read(f)])) as Record<(typeof FILES)[number], string>;
const tokensCss = read("glass-tokens.css");

function rules(text: string): { selector: string; body: string }[] {
  return Array.from(text.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
}
function decl(body: string, prop: string): string | undefined {
  for (const d of body.split(/;(?![^(]*\))/)) {
    const at = d.indexOf(":");
    if (at > 0 && d.slice(0, at).trim() === prop) return d.slice(at + 1).trim();
  }
  return undefined;
}
/** A token's value in glass-tokens.css (the first .stories-app block). */
function token(name: string): string {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(tokensCss);
  expect(m, name).not.toBeNull();
  return m![1]!.trim();
}
const hex = (name: string): Rgb => hexToRgb(token(name));
const channels = (name: string): Rgb => token(name).split(/\s+/).map(Number) as unknown as Rgb;
const alphaOf = (value: string, channel: string): number => Number(new RegExp(`rgb\\(var\\(${channel}\\)\\s*/\\s*([\\d.]+)\\)`).exec(value)?.[1]);
/** What the look blocks of glass-tokens.css set a token to (`.stories-app[data-look="picture"]`, …): the last one wins. */
const lookToken = (look: string, name: string): string | undefined => {
  let out: string | undefined;
  for (const r of rules(tokensCss)) if (r.selector.split(",").some((sel) => sel.trim() === `.stories-app[data-look="${look}"]`)) out = decl(r.body, name) ?? out;
  return out;
};
/** The rows that only show and the developer-app tile. */
const ROWS = /^(\.st-(who|auth|app|limits|agent|setup__model)|\.st-setup__facts li)$/;

describe("the social screens' styles keep the contract", () => {
  it("use the contract's tokens only: no old names, no Clip Factory radii, no colour written out, no token defined", () => {
    const old = /var\(--st-(ink|ink-soft|ink-hint|sun|sun-ink|sun-top|sun-bottom|sun-hover|sun-deep|on-sun|ember|panel|panel-strong|panel-hover|stage|s-fill|s-fill-2|s-fill-3|s-ink-2|shadow|shadow-soft|s-soft|s-lift|glow-sun|glow-sun-hover|sun-rgb|ember-rgb)\)/g;
    for (const f of FILES) {
      expect(css[f].match(old) ?? [], `${f}: old token names`).toEqual([]);
      expect(css[f].match(/var\(--r-[a-z]+\)/g) ?? [], `${f}: Clip Factory's radii`).toEqual([]);
      expect(css[f].match(/#[0-9a-f]{3,8}\b|rgba?\(\s*\d/gi) ?? [], `${f}: colours written out`).toEqual([]);
      expect(css[f].match(/(^|[{;\s])--st-[a-z0-9-]+\s*:/g) ?? [], `${f}: tokens defined outside glass-tokens.css`).toEqual([]);
    }
  });

  it("round every corner from the one --st-r-* scale", () => {
    for (const f of FILES)
      for (const m of css[f].matchAll(/border-radius:\s*([^;]+);/g)) expect(m[1], `${f}: ${m[0]}`).toMatch(/^var\(--st-r-(surface|control|inner|tiny|round)\)$/);
  });

  it("fill the tiles inside a card with the look-aware control fill: a lift over the colours, a card's veil over a picture or the desktop", () => {
    const rows = FILES.flatMap((f) => rules(css[f]).map((r) => ({ f, ...r }))).filter((r) => ROWS.test(r.selector));
    expect(rows.length).toBe(7);
    for (const r of rows) expect(decl(r.body, "background"), `${r.f}: ${r.selector}`).toBe("var(--st-fill-control)");
    // Over a picture or the desktop the control fill is a veil: the tiles are a step deeper there, never lighter. Over the
    // desktop a card's; over a picture the measured card floor (look.ts MEASURED.card), as a glass control loose on the
    // page there has no filter of its own to dim the picture.
    expect(lookToken("window", "--st-fill-control")).toBe("rgb(var(--st-veil-rgb) / var(--st-veil-card))");
    expect(lookToken("picture", "--st-fill-control")).toBe("rgb(var(--st-veil-rgb) / 0.74)");
    // Nothing with words is lit with raw cream: a lift only ever comes from the look-aware token.
    const lit: string[] = [];
    for (const f of FILES) for (const r of rules(css[f])) if (/--st-cream-rgb/.test(decl(r.body, "background") ?? "")) lit.push(`${f}: ${r.selector}`);
    expect(lit).toEqual([]);
  });

  it("tint every note, ask and card that needs the owner over the measured tinted veil, the colour cut to --st-tint-cut", () => {
    const tinted = (FILES.flatMap((f) => rules(css[f]).map((r) => ({ f, ...r }))) as { f: string; selector: string; body: string }[]).filter((r) =>
      /^\.st-(note--[a-z]+|sure|intended|conn--(needs_reconnect|same_as_clips|choose_account)|setupcard|continue)$|^\.st-conn--needs_reconnect,/.test(r.selector),
    );
    expect(tinted.length).toBeGreaterThanOrEqual(9);
    for (const r of tinted) {
      const bg = decl(r.body, "background");
      if (!bg) continue;
      expect(bg, `${r.f}: ${r.selector}`).toContain("var(--st-veil-tinted)");
      expect(bg, `${r.f}: ${r.selector}`).toContain("var(--st-tint-cut)");
    }
  });
});

describe("every word on the social screens' boxes reaches 4.5:1 over all three backgrounds", () => {
  const VEIL = channels("--st-veil-rgb");
  const WELL = channels("--st-well-rgb");
  const CREAM = channels("--st-cream-rgb");
  const COPPER = channels("--st-copper-rgb");
  const TONES = { coral: channels("--st-coral-rgb"), mint: channels("--st-mint-rgb"), sky: channels("--st-sky-rgb"), amber: channels("--st-amber-rgb") };
  const CUT = Number(token("--st-tint-cut"));
  const FILL_WELL = alphaOf(token("--st-fill-well"), "--st-well-rgb");
  /** The control fill over the colours: a cream lift (read from the tokens). */
  const LIFT = alphaOf(token("--st-fill-control"), "--st-cream-rgb");
  const ON_GLASS = ["--st-text-strong", "--st-text", "--st-text-soft", "--st-text-amber", "--st-coral-ink", "--st-mint-ink", "--st-sky-ink"].map((n) => [n, hex(n)] as const);
  const IN_WELLS = [...ON_GLASS, ["--st-text-muted", hex("--st-text-muted")] as const];
  const ON_CREAM = ["--st-on-cream", "--st-on-cream-soft", "--st-on-cream-orange"].map((n) => [n, hex(n)] as const);
  const lightest = (spots: readonly Rgb[]): Rgb => spots.reduce((a, b) => (luminance(b) > luminance(a) ? b : a));
  // The stage the tokens draw for Ember: its base and two lights at their full strength, here stacked on one pixel
  // (more than the stage ever shows: they sit in opposite corners), through every saturate a filter puts on it.
  const C1 = hex("--st-stage-c1");
  const C2 = channels("--st-stage-c2-rgb");
  const C3 = channels("--st-stage-c3-rgb");
  const [A2, A3] = [Number(token("--st-stage-a2")), Number(token("--st-stage-a3"))];
  // Each glass's own filter: blurred, dimmed (--st-dim: the page draws the colours and a picture, so it dims them; the
  // desktop is not part of the page, so 1 there), then saturated (none, --st-saturate, a liquid hero's --st-saturate-lens).
  const SATS = [1, Number(token("--st-saturate")), Number(token("--st-saturate-lens"))];
  const dimOf = (look: string | null) => Number((look ? lookToken(look, "--st-dim") : undefined) ?? token("--st-dim"));
  const through = (c: Rgb, dim: number): Rgb[] => SATS.map((k) => saturate(c.map((v) => v * dim) as unknown as Rgb, k));
  const EMBER_LIGHTEST = lightest([C1, mix(C2, C1, A2), mix(C3, C1, A3), mix(C3, mix(C2, C1, A2), A3)].flatMap((c) => through(c, dimOf(null))));
  const ember: StoriesLook = { mode: "colours", strength: "clear", colours: [toHex(C1), toHex(C2), toHex(C3)], picture: null };
  /** The fill of a tile inside a card over a picture or the desktop (look-aware: a veil). */
  const rowVeil = (look: string, v: number) => (lookToken(look, "--st-fill-control") === "rgb(var(--st-veil-rgb) / var(--st-veil-card))" ? v : alphaOf(lookToken(look, "--st-fill-control")!, "--st-veil-rgb"));
  /** Each look: the lightest pixel under the glass as its filter shows it, its veils, and the tiles' fill over a card. */
  const looks = [
    { name: "Colours › Ember", under: EMBER_LIGHTEST, v: veilsFor(ember, "none"), tile: (card: Rgb) => mix(CREAM, card, LIFT) },
    { name: "Picture over white", under: lightest(through(WHITE, dimOf("picture"))), v: veilsFor({ ...ember, mode: "picture", picture: "data:image/png;base64," }, "none"), row: rowVeil("picture", 0) },
    { name: "See-through Clear over white", under: lightest(through(WHITE, dimOf("window"))), v: veilsFor({ ...ember, mode: "see-through" }, "liquid") },
    { name: "See-through Frosted over white", under: WHITE, v: veilsFor({ ...ember, mode: "see-through", strength: "frosted" }, "liquid"), frost: true },
  ];

  it("the looks are the ones the contract measured", () => {
    // Over the desktop no filter can dim it: the measured card or more.
    expect(dimOf("window")).toBe(1);
    expect(looks[2]!.v.card).toBeGreaterThanOrEqual(0.74);
    // Over a picture nothing dims it either (a dim showed less of the photo, not more: look.ts DIM), so the card is the
    // desktop's, and a tile loose on the page keeps the measured card.
    expect(dimOf("picture")).toBe(1);
    expect(dimOf(null)).toBe(1);
    expect(looks[1]!.v.card).toBe(looks[2]!.v.card);
    expect(looks[1]!.row).toBe(0.74);
    // Frosted: the 0.30 frost, then the panels in the light's order (look.ts WINDOW_FROSTED); the frost and a card
    // together still cover more than Clear's measured card.
    expect(looks[3]!.v.card).toBeGreaterThanOrEqual(0.82);
    expect(looks[3]!.v.page).toBeGreaterThanOrEqual(0.3);
    expect(1 - (1 - looks[3]!.v.page) * (1 - looks[3]!.v.card)).toBeGreaterThanOrEqual(0.87);
  });

  for (const look of looks)
    it(look.name, () => {
      const low: string[] = [];
      const check = (where: string, bg: Rgb, inks: readonly (readonly [string, Rgb])[]) => {
        for (const [name, ink] of inks) {
          const ratio = contrast(ink, bg);
          if (ratio < 4.5) low.push(`${name} on ${where}: ${ratio.toFixed(2)}`);
        }
      };
      const under = look.frost ? mix(VEIL, look.under, look.v.page) : look.under;
      const card = mix(VEIL, under, look.v.card);
      const hero = mix(VEIL, under, look.v.hero);
      // A tile: the cream lift over the colours; a veil over a picture (the measured card) or the desktop (a card's).
      const row = look.tile ? look.tile(card) : mix(VEIL, card, look.row ?? look.v.card);
      check("a card", card, ON_GLASS);
      check("the setup's hero", hero, ON_GLASS);
      check("a tile that only shows", row, ON_GLASS);
      check("a well in a tile", mix(WELL, row, FILL_WELL), IN_WELLS);
      check("a well on a card", mix(WELL, card, FILL_WELL), IN_WELLS);
      for (const [tone, rgb] of Object.entries(TONES)) {
        // Loose on the page, or a whole card that needs the owner: the tinted veil right over the backdrop.
        check(`a ${tone} note or card`, mix(rgb, mix(VEIL, under, look.v.tinted), CUT), ON_GLASS);
      }
      check("a step's Later chip", mix(TONES.amber, mix(WELL, card, 0.42), 0.14), [["--st-text-amber", hex("--st-text-amber")]]);
      // The current step: cream with espresso words, over the lightest and the darkest card.
      for (const under2 of [card, mix(VEIL, C1, look.v.card)]) {
        const cream = mix(CREAM, under2, 0.96);
        check("the current step", cream, ON_CREAM);
        check("the current step's Later chip", mix(COPPER, cream, 0.14), [["--st-on-cream-orange", hex("--st-on-cream-orange")]]);
      }
      expect(low).toEqual([]);
    });
});
