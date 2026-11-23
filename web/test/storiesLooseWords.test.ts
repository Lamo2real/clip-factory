// Two readability fixes from the final check (23 Nov), held in place:
// - a glass control loose on the page over the owner's own bright colours (#fff000 #00ffff #ff00ff) measured
//   4.47-4.49:1 with the words' page veil alone: once the colours need a page veil, it also keeps a loose control's
//   words (its cream fill and level-4 light over the veil, at rest and hovered) at CONTROL_TARGET;
// - the coral and sun chips on Social accounts' lit hero measured 3.98-4.44:1 over Ember: every tone chip is now the
//   tone cut to 0.12 over a deep well (st-parts.css), in every look.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AA, CONTROL_TARGET, EMBER, INKS, PRESETS, VEIL, contrast, hexToRgb, lit, looseControl, mix, stageSpots, veilsFor, ELEVATION, ELEVATION_TOP, type Rgb } from "../src/stories/look.ts";

const colours = (c: readonly string[]) => veilsFor({ mode: "colours", strength: "clear", colours: [...c], picture: null }, "none");
const OWN: [string, readonly string[]][] = [
  ["the owner's own (bright)", ["#fff000", "#00ffff", "#ff00ff"]],
  ["the owner's own (white)", ["#ffffff"]],
  ["the owner's own (yellow)", ["#ffff00"]],
];

describe("a glass control loose on the page over the owner's own colours", () => {
  for (const [name, c] of OWN)
    it(name, () => {
      const v = colours(c);
      expect(v.page).toBeGreaterThan(0);
      const ink = hexToRgb(INKS.ink!);
      for (const spot of stageSpots(c)) {
        const { rest, hover } = looseControl(mix(VEIL, spot, v.page));
        expect(contrast(ink, rest), `${spot} at rest`).toBeGreaterThanOrEqual(CONTROL_TARGET);
        expect(contrast(ink, hover), `${spot} hovered`).toBeGreaterThanOrEqual(CONTROL_TARGET);
      }
    });
  it("Ember, Rose and Lagoon keep their page as it is (no veil: their loose controls measure 4.9:1 or more)", () => {
    for (const p of PRESETS) expect(colours(p.colours).page, p.name).toBe(0);
  });
});

describe("a tone chip on the brightest glass of the colours", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "src", "stories", "styles", "st-parts.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens = readFileSync(join(import.meta.dirname, "..", "src", "stories", "styles", "glass-tokens.css"), "utf8");
  const rgbOf = (name: string): Rgb => {
    const m = new RegExp(`${name}:\\s*([\\d]+) ([\\d]+) ([\\d]+)`).exec(tokens)!;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const hexOf = (name: string) => hexToRgb(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`).exec(tokens)![1]!);
  const TONES = { sun: ["--st-amber-rgb", "--st-text-amber"], coral: ["--st-coral-rgb", "--st-coral-ink"], mint: ["--st-mint-rgb", "--st-mint-ink"], sky: ["--st-sky-rgb", "--st-sky-ink"] } as const;
  for (const [tone, [rgb, ink]] of Object.entries(TONES))
    it(`${tone}: its tone over the well, in every look, keeps 4.5:1 on a lit hero over the lightest spot`, () => {
      const rule = new RegExp(`\\n\\.st-chip--${tone} \\{([^}]*)\\}`).exec(css)![1]!;
      const m = new RegExp(`rgb\\(var\\(${rgb}\\) / ([\\d.]+)\\).*rgb\\(var\\(--st-well-rgb\\) / ([\\d.]+)\\)`).exec(rule);
      expect(m, rule).not.toBeNull();
      const [cut, well] = [Number(m![1]), Number(m![2])];
      for (const c of [EMBER, ...PRESETS.map((p) => p.colours), ...OWN.map(([, x]) => x)]) {
        const v = colours(c);
        for (const spot of stageSpots(c)) {
          const page = mix(VEIL, spot, v.page);
          // the hero at its top (its brightest), with a cream control lift under the chip as on Social accounts' choices
          const hero = lit(page, v.hero, ELEVATION[3]! + ELEVATION_TOP[3]!);
          for (const under of [hero, mix(hexToRgb("#fff3e4"), hero, 0.2)]) {
            const chip = mix(rgbOf(rgb), mix(rgbOf("--st-well-rgb"), under, well), cut);
            expect(contrast(hexOf(ink), chip), `${tone} over ${c.join(" ")}`).toBeGreaterThanOrEqual(AA);
          }
        }
      }
    });
});
