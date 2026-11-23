// Clip Factory Stories' shell on the liquid-glass contract (web/src/stories/styles/GLASS-CONTRACT.md), the shell's own
// choices that the foundation's checks do not cover:
// - inside a glass surface or a plate over a picture or the desktop, the shell's controls keep a light cream glass
//   (the surface already carries the measured veil; a second veil made them dark holes). Every cream fill the shell
//   lays there keeps its words at 4.5:1 over a white picture on the thinnest veil, at rest, on hover and not ready yet;
// - StToggle draws the contract's orange toggle figure (.st-toggle), never disabled: aria-disabled and no change.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contrast, FROSTED, hexToRgb, MEASURED, mix, VEIL, WHITE, type Rgb, type Veils } from "../src/stories/look.ts";
import { StToggle } from "../src/stories/ui.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const styles = (file: string) => readFileSync(join(import.meta.dirname, "..", "src", "stories", "styles", file), "utf8");
const TOKENS = styles("glass-tokens.css");
const SHELL = ["st-frame.css", "st-parts.css", "st-controls.css", "st-end.css"].map(styles).join("\n");

/** A token's value in glass-tokens.css (the first definition, on .stories-app). */
const token = (name: string): string => {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(TOKENS);
  if (!m) throw new Error(`${name} is not in glass-tokens.css`);
  return m[1]!.replace(/\/\*.*$/, "").trim();
};
const channels = (name: string): Rgb => token(name).split(/\s+/).map(Number) as unknown as Rgb;
const hex = (name: string): Rgb => hexToRgb(token(name));

/** Every rule of the shell's files that only applies over a picture or the desktop, with the cream alphas it lays. */
function creamFillsOverPictures(): { selector: string; alpha: number }[] {
  const out: { selector: string; alpha: number }[] = [];
  const plain = SHELL.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1]!.trim();
    if (!selector.includes('[data-look="picture"]')) continue;
    for (const d of m[2]!.matchAll(/background(?:-color)?:\s*rgb\(var\(--st-cream-rgb\)\s*\/\s*([\d.]+)\)/g)) out.push({ selector, alpha: Number(d[1]) });
  }
  return out;
}

/** Each glass surface the shell's controls sit in, over a white picture or desktop, for these veils. */
function surfacesOverWhite(v: Veils): { name: string; rgb: Rgb }[] {
  const under = mix(VEIL, WHITE, v.page);
  const out: { name: string; rgb: Rgb }[] = [];
  for (const k of ["card", "hero", "rail", "bar", "float", "plate"] as const) out.push({ name: k, rgb: mix(VEIL, under, v[k]) });
  // A colour-tinted bar (the Needs you bar is coral): the veil, then the tone cut to --st-tint-cut over it.
  const cut = Number(token("--st-tint-cut"));
  for (const tone of ["--st-coral-rgb", "--st-mint-rgb", "--st-sky-rgb", "--st-amber-rgb", "--st-action-rgb"]) out.push({ name: `tinted ${tone}`, rgb: mix(channels(tone), mix(VEIL, under, v.tinted), cut) });
  return out;
}

describe("the shell's controls inside glass over a picture or the desktop", () => {
  const fills = creamFillsOverPictures();
  const cream = channels("--st-cream-rgb");
  const words = { text: hex("--st-text"), strong: hex("--st-text-strong"), soft: hex("--st-text-soft") };

  it("are a light cream glass there, never the card's veil a second time", () => {
    const sel = fills.map((f) => f.selector).join("\n");
    for (const part of [".st-btn", ".st-needs__hide", ".st-tabs__tab", ".st-pick__opt", ".st-rail__item", ".st-tabbar__item", ".st-more__item", ".st-brand"]) expect(sel, part).toContain(part);
    // Never so much cream that a hover could lift the words under 4.5:1 (checked one by one below).
    for (const f of fills) expect(f.alpha, f.selector).toBeLessThanOrEqual(0.16);
  });

  for (const [look, veils] of [["Picture and See-through Clear", MEASURED], ["See-through Frosted", FROSTED]] as const)
    it(`keep every word at 4.5:1 over a white picture or desktop (${look})`, () => {
      for (const s of surfacesOverWhite(veils))
        for (const f of fills) {
          const bg = mix(cream, s.rgb, f.alpha);
          // Not ready yet (aria-disabled): the soft words; everything else the glass words.
          const inks = /disabled/.test(f.selector) ? [words.soft] : [words.text, words.strong];
          for (const ink of inks) expect(contrast(ink, bg), `${f.selector} at ${f.alpha} on ${s.name}`).toBeGreaterThanOrEqual(4.5);
        }
    });

  it("leave the bright orange for the screen's one main action: Needs you's Fix it and Show me are cream", () => {
    const ui = readFileSync(join(import.meta.dirname, "..", "src", "stories", "ui.tsx"), "utf8");
    const needs = ui.slice(ui.indexOf("export function NeedsYouBar"), ui.indexOf("// ---------- The onboarding"));
    expect(needs).toContain('className="st-needs__go st-btn--cream"');
    expect(needs).not.toMatch(/\bmain\b(?=[^>]*st-needs__go)/);
    expect(SHELL).toMatch(/\.st-btn--cream\s*\{[^}]*background-color:\s*var\(--st-cream\)/);
  });
});

describe("StToggle: the orange toggle figure, never disabled", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("draws the figure's track and knob as a switch with its words", () => {
    const onChange = vi.fn();
    act(() => root.render(<StToggle checked={false} onChange={onChange} label="Post by itself" description="Every six hours." />));
    const sw = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(sw.className).toBe("st-switch st-toggle");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.querySelector(":scope > .st-toggle__track > .st-toggle__knob")).not.toBeNull();
    expect(sw.querySelector(".st-toggle__track")?.getAttribute("aria-hidden")).toBe("true");
    expect(document.getElementById(sw.getAttribute("aria-labelledby")!)?.textContent).toBe("Post by itself");
    expect(document.getElementById(sw.getAttribute("aria-describedby")!)?.textContent).toBe("Every six hours.");
    act(() => sw.click());
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("not available yet: aria-disabled, still a button that can be tapped (the deny sound), and nothing changes", () => {
    const onChange = vi.fn();
    act(() => root.render(<StToggle checked onChange={onChange} label="Post by itself" disabled />));
    const sw = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(sw.disabled).toBe(false);
    expect(sw.getAttribute("aria-disabled")).toBe("true");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    act(() => sw.click());
    expect(onChange).not.toHaveBeenCalled();
  });
});
