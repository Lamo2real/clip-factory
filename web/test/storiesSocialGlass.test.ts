// Clip Factory Stories › Social accounts and the setup on the liquid glass (styles/GLASS-CONTRACT.md): their four style
// files use the contract's tokens only (no old names, no Clip Factory radii, no colour written out, no token defined
// here), and every word on their boxes reaches 4.5:1 over the worst each look can show: Ember's lightest light, a
// white or busy desktop or photo behind the measured veils (Picture and See-through Clear), and Frosted. Words on
// glass are never put on a box lighter than its card: rows that only show are a step deeper, notes and tinted cards
// carry the measured tinted veil under their colour, wells are deeper still.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMBER, FROSTED, MEASURED, SATURATIONS, VEIL, WHITE, contrast, hexToRgb, luminance, meshSpots, mix, veilsFor, type Rgb } from "../src/stories/look.ts";

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

  it("never light a box with words: cream only behind the platform's mark", () => {
    const lit: string[] = [];
    for (const f of FILES) for (const r of rules(css[f])) if (/--st-cream-rgb/.test(decl(r.body, "background") ?? "")) lit.push(`${f}: ${r.selector}`);
    expect(lit).toEqual(["st-connections.css: .st-conn__mark"]);
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
  const WELL = channels("--st-well-rgb");
  const CREAM = channels("--st-cream-rgb");
  const COPPER = channels("--st-copper-rgb");
  const TONES = { coral: channels("--st-coral-rgb"), mint: channels("--st-mint-rgb"), sky: channels("--st-sky-rgb"), amber: channels("--st-amber-rgb") };
  const CUT = Number(token("--st-tint-cut"));
  const FILL_WELL = alphaOf(token("--st-fill-well"), "--st-well-rgb");
  /** The rows that only show (and the developer-app sheet): their own deeper step, read from the CSS. */
  const rowAlpha = (() => {
    const all = FILES.flatMap((f) => rules(css[f])).filter((r) => /^(\.st-(who|auth|app|limits|agent|setup__model)|\.st-setup__facts li)$/.test(r.selector));
    const alphas = all.map((r) => alphaOf(decl(r.body, "background") ?? "", "--st-well-rgb"));
    expect(alphas.length).toBe(7);
    for (const a of alphas) expect(a).toBeGreaterThan(0);
    return Math.min(...alphas);
  })();
  const ON_GLASS = ["--st-text-strong", "--st-text", "--st-text-soft", "--st-text-amber", "--st-coral-ink", "--st-mint-ink", "--st-sky-ink"].map((n) => [n, hex(n)] as const);
  const IN_WELLS = [...ON_GLASS, ["--st-text-muted", hex("--st-text-muted")] as const];
  const ON_CREAM = ["--st-on-cream", "--st-on-cream-soft", "--st-on-cream-orange"].map((n) => [n, hex(n)] as const);
  const lightest = (spots: readonly Rgb[]): Rgb => spots.reduce((a, b) => (luminance(b) > luminance(a) ? b : a));
  const ember = veilsFor({ mode: "colours", strength: "clear", colours: [...EMBER], picture: null }, "none");
  /** Each look: the lightest pixel under the glass, and its veils. */
  const looks = [
    { name: "Colours › Ember", under: lightest(meshSpots(EMBER, SATURATIONS)), v: ember },
    { name: "Picture or See-through over white", under: WHITE, v: MEASURED },
    { name: "See-through Frosted over white", under: mix(VEIL, WHITE, FROSTED.page), v: FROSTED },
  ];

  for (const look of looks)
    it(look.name, () => {
      const low: string[] = [];
      const check = (where: string, bg: Rgb, inks: readonly (readonly [string, Rgb])[]) => {
        for (const [name, ink] of inks) {
          const ratio = contrast(ink, bg);
          if (ratio < 4.5) low.push(`${name} on ${where}: ${ratio.toFixed(2)}`);
        }
      };
      const card = mix(VEIL, look.under, look.v.card);
      const hero = mix(VEIL, look.under, look.v.hero);
      const row = mix(WELL, card, rowAlpha);
      check("a card", card, ON_GLASS);
      check("the setup's hero", hero, ON_GLASS);
      check("a row that only shows", row, ON_GLASS);
      check("a well in a row", mix(WELL, row, FILL_WELL), IN_WELLS);
      check("a well on a card", mix(WELL, card, FILL_WELL), IN_WELLS);
      for (const [tone, rgb] of Object.entries(TONES)) {
        // Loose on the page, or a whole card that needs the owner: the tinted veil right over the backdrop.
        check(`a ${tone} note or card`, mix(rgb, mix(VEIL, look.under, look.v.tinted), CUT), ON_GLASS);
      }
      check("a step's Later chip", mix(TONES.amber, mix(WELL, card, 0.42), 0.14), [["--st-text-amber", hex("--st-text-amber")]]);
      // The current step: cream with espresso words, over the lightest and the darkest card.
      for (const under of [card, mix(VEIL, hexToRgb(EMBER[0]!), look.v.card)]) {
        const cream = mix(CREAM, under, 0.96);
        check("the current step", cream, ON_CREAM);
        check("the current step's Later chip", mix(COPPER, cream, 0.14), [["--st-on-cream-orange", hex("--st-on-cream-orange")]]);
      }
      expect(low).toEqual([]);
    });
});
