import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AA,
  BRAND_GLASS,
  brandMeshSpots,
  coloursMeshSpots,
  coloursVeils,
  UPDATE_EXTRA_VEIL,
  GHOST_VEIL,
  GHOST_LIFT,
  LADDER_SLACK,
  LADDER_STEP,
  noRoom,
  panelWords,
  FLOAT_LIGHT,
  FLOAT_VEIL,
  glassChecks,
  lit,
  type LightLook,
  luminance,
  mix,
  oklabL,
  panelTop,
  PICTURE_GLASS,
  raised,
  type Rgb,
  windowGlass,
  SWATCHES,
  TEXT_COLOURS,
  VEIL,
} from "../src/lib/background.ts";

// The quiet button (Later, Skip, Not now) and the colourless Reload lens on the update bar (ADR-87, the logic of
// light), worked out with lib/background.ts over every look: each must read as a button, a step of light above the
// surface it sits on (the lens a step above Later), and their bone words keep WCAG AA at rest and on hover.

const css = readFileSync(join(import.meta.dirname, "..", "src", "styles", "components.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** The body of the rule whose selector is exactly `selector`. */
const body = (selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
const num = (selector: string, prop: string) => {
  const m = new RegExp(`${prop}:\\s*([\\d.]+);`).exec(body(selector));
  expect(m, `${selector} { ${prop} }`).not.toBeNull();
  return Number(m![1]);
};

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
const worst = (bg: Rgb) => {
  const lb = luminance(bg);
  return Math.min(...TEXT_COLOURS.map((t) => (luminance(t) > lb ? (luminance(t) + 0.05) / (lb + 0.05) : (lb + 0.05) / (luminance(t) + 0.05))));
};

const sys = readFileSync(join(import.meta.dirname, "..", "src", "styles", "system.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** A number declared in system.css's rule whose selector is exactly `selector`. */
const sysNum = (selector: string, prop: string) => {
  const rule = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(sys)?.[1] ?? "";
  const m = new RegExp(`${prop}:\\s*([\\d.]+);`).exec(rule);
  expect(m, `${selector} { ${prop} }`).not.toBeNull();
  return Number(m![1]);
};
const LATER = ".update-bar .btn--ghost.update-bar__later";
const LENS = ".btn.btn--lens";
const LENS_HOVER = '.btn.btn--lens:hover:not([aria-disabled="true"])';
const GHOST_INSIDE = ":where(.glass, .tt-sheet, .help-panel, .money-dock, .page-head__text, .dash-head__text, .dropdown__list, .ws-menu) .btn--ghost";

interface Place {
  at: string;
  look: LightLook;
  behind: Rgb;
}
/** Where the app can be: the living backdrop, every window glass over its checks, a photo, a spread of Colours. */
const PLACES: Place[] = (() => {
  const out: Place[] = [];
  for (const behind of brandMeshSpots()) out.push({ at: `the living backdrop over ${behind.map(Math.round).join(" ")}`, look: { kind: "frosted", ...BRAND_GLASS }, behind });
  for (const glass of ["liquid", "vibrancy", "mica", "acrylic", "blur"] as const)
    for (const scheme of ["light", "dark"] as const)
      for (const strength of ["clear", "frosted"] as const) {
        const v = windowGlass(glass, scheme, strength);
        for (const check of glassChecks(glass, scheme)) out.push({ at: `${glass} ${scheme} ${strength} over ${check.name}`, look: { kind: "window", ...v }, behind: check.behind });
      }
  for (const behind of [WHITE, BLACK]) out.push({ at: "a photo", look: { kind: "picture", ...PICTURE_GLASS }, behind });
  for (const s of SWATCHES)
    for (const cs of [[s.hex], [s.hex, "#efe7da"], [s.hex, "#e8392b", "#0f372b"]]) {
      const v = coloursVeils(cs);
      for (const behind of coloursMeshSpots(cs)) out.push({ at: `colours ${cs.join(" ")}`, look: { kind: "colours", ...v }, behind });
    }
  return out;
})();

describe("the update bar's two buttons (ADR-87)", () => {
  const lift = num(LENS, "--btn-lift");
  const hoverLift = num(LENS_HOVER, "--btn-lift");
  // Later on the bar: bone alone over the bar's heavier green (UPDATE_EXTRA_VEIL), quieter than Reload.
  const later = sysNum(LATER, "--btn-lift");
  const laterVeil = 0;
  const laterHover = sysNum(LATER, "--ghost-hover-lift");

  it("the lens is colourless: white light over the bar, no green and no vermilion under it, and no blur of its own", () => {
    const rule = body(LENS);
    expect(rule).not.toMatch(/--vermilion|--cta/);
    // Its face and its light are white alone (the words' soft halo, never counted, is the only green on it).
    for (const part of [declaredValue(rule, "--lens-face"), declaredValue(rule, "--lens-light")]) {
      expect(part).toBeDefined();
      expect(part).not.toMatch(/--green|--vermilion|--cta|--bone/);
    }
    expect(rule).toContain("background: var(--lens-face);");
    // No blur of its own: inside the blurred bar it would only lay the bar's tint again under the lens (darker).
    expect(rule).toMatch(/(?:^|\s)backdrop-filter: none;/);
    expect(rule).toContain("color: var(--ink);");
    // A glass button lifts on hover only where it has no blur of its own (moving a blurred button redraws its
    // backdrop on every frame of the spring): inside a blurred surface, or the lens.
    const lifts = [...css.matchAll(/([^{}]*)\{[^{}]*translateY\(-1px\)/g)].map((m) => m[1]!.trim());
    expect(lifts.length).toBeGreaterThan(0);
    for (const sel of lifts.flatMap((l) => l.split(/,\s*(?![^()]*\))/)))
      if (/btn--(glass|lens)/.test(sel)) expect(sel, "a glass button that lifts").toMatch(/^(:where\(\.glass, [^)]*\) \.btn--glass|\.btn\.btn--lens):hover/);
    expect(lift).toBeGreaterThan(0);
    expect(hoverLift).toBeGreaterThan(lift);
  });

  it("over anything under the bar (a white thumbnail too): Later is a step above the bar, Reload a step above Later, and the words keep AA", () => {
    const fails: string[] = [];
    const lowest = { later: Infinity, lens: Infinity, hover: Infinity, aa: Infinity };
    for (const p of PLACES) {
      const page = mix(VEIL, p.behind, p.look.pageVeil ?? 0);
      for (const under of [WHITE, page, panelTop(p.look, p.behind)]) {
        // The bar's own tint: the floating veil and the bar's pay (--light-update-pay), or the panel's, if heavier.
        const tint = Math.min(1, Math.max(FLOAT_VEIL + UPDATE_EXTRA_VEIL, p.look.panelVeil));
        // The bar's light where the buttons sit: from half its top light (the buttons' top on a computer) down to a
        // quarter (the bottom row on a phone, where its light has eased off).
        for (const light of [FLOAT_LIGHT * 0.25, FLOAT_LIGHT * 0.5, FLOAT_LIGHT * 0.75]) {
          const bar = lit(under, tint, light);
          const laterFace = lit(bar, laterVeil, later);
          const lensFace = mix(WHITE, bar, lift);
          const lensHover = mix(WHITE, bar, hoverLift);
          const steps: [string, number][] = [
            ["Later − the bar", oklabL(laterFace) - oklabL(bar)],
            ["Reload − Later", oklabL(lensFace) - oklabL(laterFace)],
            ["Reload hover − Reload", oklabL(lensHover) - oklabL(lensFace)],
          ];
          lowest.later = Math.min(lowest.later, steps[0]![1]);
          lowest.lens = Math.min(lowest.lens, steps[1]![1]);
          lowest.hover = Math.min(lowest.hover, steps[2]![1]);
          for (const [name, dl] of steps) if (dl < (name.includes("hover") ? 0.01 : name.startsWith("Reload") ? 0.08 : 0.03) && fails.length < 20) fails.push(`${name} ${dl.toFixed(3)}, ${p.at}, light ${light}`);
          // The words sit in the middle of the button, where the bar's light is half its top or less.
          if (light <= FLOAT_LIGHT * 0.5)
            for (const [name, face] of [["Later", laterFace], ["Later hover", lit(bar, laterVeil, laterHover)], ["Reload", lensFace], ["Reload hover", lensHover]] as const) {
              const c = worst(face);
              lowest.aa = Math.min(lowest.aa, c);
              if (c < AA && fails.length < 20) fails.push(`${name} ${c.toFixed(2)}:1, ${p.at}`);
            }
        }
      }
    }
    expect(fails).toEqual([]);
    expect(lowest.lens).toBeGreaterThanOrEqual(0.08);
    expect(lowest.later).toBeGreaterThanOrEqual(0.03);
    expect(lowest.aa).toBeGreaterThanOrEqual(AA);
  });
});

describe("the quiet button looks like a button (ADR-87)", () => {
  const lift = num(GHOST_INSIDE, "--btn-lift");
  const veil = num(GHOST_INSIDE, "--btn-veil");
  const hoverLift = num(GHOST_INSIDE, "--ghost-hover-lift");
  const hoverVeil = num(GHOST_INSIDE, "--ghost-hover-veil");
  const rule = body(".btn--ghost");

  it("is a pill with a thin soft rim of light and a top light of its own, no drop, and hover adds light", () => {
    expect(rule).toMatch(/--ghost-rim: inset 0 0 [3-9]px rgb\(var\(--bone-rgb\) \/ 0\.\d+\);/);
    expect(rule).toMatch(/--ghost-top: inset 0 \dpx \dpx -\dpx rgb\(var\(--bone-rgb\) \/ 0\.\d+\);/);
    expect(rule).toContain("box-shadow: var(--ghost-top), var(--ghost-rim);");
    // Inside a lit surface its face is the quiet fill (GHOST_VEIL, GHOST_LIFT); on the page the track's green carries the words.
    expect(Number(declaredValue(body(GHOST_INSIDE), "--btn-veil"))).toBe(GHOST_VEIL);
    expect(lift).toBe(GHOST_LIFT);
    expect(declaredValue(rule, "--btn-veil")).toMatch(/^var\(--light-ghost-veil/);
    expect(hoverLift).toBeGreaterThan(lift);
  });

  it("its face is a step of light over the panel it sits on (0.03 where the AA cap leaves room), and its words keep AA, wherever the panel can be", () => {
    const fails: string[] = [];
    for (const p of PLACES) {
      const e1 = panelWords(p.look, p.behind);
      for (const [where, parent] of [["a panel", e1], ["a row on a panel", raised(e1)]] as const) {
        const face = lit(parent, veil, lift);
        const dl = oklabL(face) - oklabL(parent);
        if (where === "a panel" && dl < (noRoom(parent) ? -LADDER_SLACK : oklabL(parent) > 0.4 ? LADDER_STEP : 0.03) && fails.length < 20) fails.push(`on ${where}: +${dl.toFixed(3)}, ${p.at}`);
        for (const [state, f] of [["rest", face], ["hover", lit(parent, hoverVeil, hoverLift)]] as const) {
          const c = worst(f);
          if (c < AA && fails.length < 20) fails.push(`on ${where}, ${state}: ${c.toFixed(2)}:1 (parent L ${oklabL(parent).toFixed(3)}), ${p.at}`);
        }
      }
    }
    expect(fails).toEqual([]);
  });
});

function declaredValue(text: string, prop: string): string | undefined {
  return new RegExp(`${prop}:\\s*([^;]+);`).exec(text)?.[1]?.trim();
}
