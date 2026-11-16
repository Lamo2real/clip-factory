// The send motion's CSS against its spec (docs/CONTRACTS.md §20.1, §20.6) and lib/motion.ts.
// Audit F045: the paper plane's reduced fade was cut to 1 ms by base.css's global rule.
// Audit F069: a labelled send's glyph and trail crossed its label mid-flight.
// Audit F070: the in-button send's reduced fade was 240 ms while the state timer holds it for 300 ms.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SEND_FADE_MS, phaseMs } from "../src/lib/motion.ts";

const css = (name: string) => readFileSync(join(import.meta.dirname, "../src/styles", name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const motion = css("motion.css");
const fly = css("fly.css");
const base = css("base.css");

/** The declarations of every rule whose selector list is exactly `selector` (outside or inside @media). */
function rules(sheet: string, selector: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(sheet); m; m = re.exec(sheet)) if (m[1]!.trim() === selector) out.push(m[2]!);
  return out;
}

const px = (decls: string, prop: string) => Number(new RegExp(`${prop}:\\s*(-?\\d+)px`).exec(decls)?.[1]);

describe("send motion CSS", () => {
  it("base.css still cuts every animation to 1 ms under reduced motion (why the fades need !important)", () => {
    expect(base).toMatch(/animation-duration:\s*1ms !important/);
  });

  it("the paper plane's reduced fade keeps its 300 ms against the global rule (F045)", () => {
    for (const sel of [".fly.is-fading .fly__item", ".fly.is-flying .fly__item", ".reduce-motion .fly.is-flying .fly__item"]) {
      const found = rules(fly, sel).filter((d) => d.includes("fly-fade"));
      expect(found.length, sel).toBeGreaterThan(0);
      for (const d of found) expect(d, sel).toMatch(new RegExp(`fly-fade ${SEND_FADE_MS}ms ease-out backwards !important`));
    }
  });

  it("the in-button send's reduced fade lasts SEND_FADE_MS, like its state timer (F070)", () => {
    const root = /:root\s*\{([^}]*)\}/.exec(motion)![1]!;
    expect(px(root.replace(/ms/g, "px"), "--send-fade")).toBe(SEND_FADE_MS);
    expect(phaseMs("send", "fade")).toBe(SEND_FADE_MS);
    for (const prefix of ["", ".reduce-motion "]) {
      const item = rules(motion, `${prefix}.act.act--send.is-fade .act__item`).join(";");
      const wrap = rules(motion, `${prefix}.act.act--send.is-fade`).join(";");
      expect(item, prefix || "@media").toMatch(/act-fade var\(--send-fade\) ease-out !important/);
      expect(wrap, prefix || "@media").toMatch(/act-fade-tint var\(--send-fade\) ease-out !important/);
    }
  });

  it("a labelled send flies mostly up and stays clear of its label (F069)", () => {
    const send = rules(motion, ".act--send").join(";");
    const x = px(send, "--fly-x");
    const y = px(send, "--fly-y");
    // The glyph sits 8-12 px from its label (the button's gap): its sideways travel stays under that.
    expect(x).toBeLessThanOrEqual(8);
    expect(Math.abs(y)).toBeGreaterThan(x);
    const trail = rules(motion, ".act__trail").join(";");
    expect(px(trail, "width")).toBeLessThanOrEqual(18);
    // No container brings the long flight back for a labelled button.
    expect(motion).not.toMatch(/\.act--send\s*\{[^}]*--fly-x:\s*(?:1[0-9]|[2-9][0-9])px/);
  });
});
