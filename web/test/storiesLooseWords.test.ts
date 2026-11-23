// Two readability fixes from the final check (23 Nov), held in place:
// - a glass control loose on the page over the owner's own bright colours (#fff000 #00ffff #ff00ff) measured
//   4.47-4.49:1 with the words' page veil alone, and over mid-tones whose words need no veil (#446677, #0066aa,
//   #3355dd: 63 single colours of a 4096 sweep) 4.25-4.59:1 with none: the page veil also keeps a loose control's words
//   (its cream fill and level-4 light over the veil, at its top at rest and hovered) at CONTROL_TARGET, where a page
//   can put a control (controlSpots: inside the frame's side margins), for every colour the owner can pick;
// - the coral and sun chips on Social accounts' lit hero measured 3.98-4.44:1 over Ember: every tone chip is now the
//   tone cut to 0.12 over a deep well (st-parts.css), in every look.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AA, CONTROL_TARGET, EMBER, INKS, PRESETS, STAGE_WINDOWS, VEIL, contrast, controlSpots, frameGutter, hexToRgb, lit, looseControl, mix, stageSpots, veilsFor, ELEVATION, ELEVATION_TOP, type Rgb } from "../src/stories/look.ts";

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
  it("Ember, Rose and Lagoon keep their page as it is (no veil: their loose controls measure 4.87:1 or more where they sit)", () => {
    const ink = hexToRgb(INKS.ink!);
    for (const p of PRESETS) {
      const v = colours(p.colours);
      expect(v.page, p.name).toBe(0);
      // what the OWN loop above holds them to: a loose control's words at its top, at rest and hovered
      for (const spot of controlSpots(p.colours)) {
        const { rest, hover } = looseControl(mix(VEIL, spot, v.page));
        expect(contrast(ink, rest), `${p.name} over ${spot} at rest`).toBeGreaterThanOrEqual(4.87);
        expect(contrast(ink, hover), `${p.name} over ${spot} hovered`).toBeGreaterThanOrEqual(4.87);
      }
    }
  });

  it("where a control can sit is the page inside the frame's side margins, as st-frame.css lays them", () => {
    const tokens = readFileSync(join(import.meta.dirname, "..", "src", "styles", "tokens.css"), "utf8");
    const frame = readFileSync(join(import.meta.dirname, "..", "src", "stories", "styles", "st-frame.css"), "utf8");
    expect(tokens).toMatch(/--gutter: clamp\(16px, 3\.2vw, 36px\);/);
    // the phone frame and the wide one (beside the rail) both keep at least --gutter from each side of the window
    expect(frame).toMatch(/\.st-frame \{[^}]*padding: var\(--top-line\) max\(var\(--gutter\), env\(safe-area-inset-right\)\) [^;]* max\(var\(--gutter\), env\(safe-area-inset-left\)\);/);
    expect(frame).toMatch(/ {2}\.st-frame \{[^}]*padding: var\(--top-line\) max\(var\(--gutter\), env\(safe-area-inset-right\)\) 48px calc\(var\(--st-rail-w\) \+ 14px \+ var\(--gutter\)\);/);
    for (const [w] of STAGE_WINDOWS) expect(frameGutter(w), `${w} px`).toBe(Math.min(36, Math.max(16, 0.032 * w)));
  });

  it("every colour the owner can pick: a loose control's words keep CONTROL_TARGET at rest and hovered (a sweep)", () => {
    const hex = (n: number) => n.toString(16).padStart(2, "0");
    const sets: string[][] = [];
    // the 63 single colours (of a 17-step sweep) the words alone left with no veil and their loose controls under
    // CONTROL_TARGET (4.25-4.59:1), the review's three among them
    const BEFORE = "006699 0066aa 116688 116699 2255dd 226677 226688 226699 3355cc 3355dd 336666 336677 336688 4455bb 4455cc 446633 446644 446655 446666 446677 5544ee 5555aa 5555bb 556600 556611 556622 556633 556644 556655 556666 6633ff 6644dd 665588 665599 6655aa 666600 666611 666622 7733ee 7744bb 7744cc 775544 775555 775566 775577 775588 8833cc 884488 884499 8844aa 885500 885511 885522 885533 885544 885555 9933aa 994444 994455 994466 994477 aa3366 aa3377";
    for (const c of BEFORE.split(" ")) sets.push([`#${c}`]);
    // every single colour in steps of 51 per channel
    for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) sets.push([`#${hex(r)}${hex(g)}${hex(b)}`]);
    // two and three colours of the owner's own, a fixed sample
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = () => `#${[0, 0, 0].map(() => hex(Math.floor(rnd() * 16) * 17)).join("")}`;
    for (let i = 0; i < 40; i++) sets.push([pick(), pick(), ...(i % 2 ? [pick()] : [])]);
    const ink = hexToRgb(INKS.ink!);
    const low: string[] = [];
    for (const c of sets) {
      const v = colours(c);
      for (const spot of controlSpots(c)) {
        const { rest, hover } = looseControl(mix(VEIL, spot, v.page));
        for (const [state, bg] of [["at rest", rest], ["hovered", hover]] as const) {
          const k = contrast(ink, bg);
          if (k < CONTROL_TARGET) low.push(`${c.join(" ")} (page ${v.page}) ${state}: ${k.toFixed(3)}`);
        }
      }
    }
    expect(sets.length).toBeGreaterThan(300);
    expect([...new Set(low)], [...new Set(low)].slice(0, 20).join("\n")).toEqual([]);
  }, 60_000);
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
