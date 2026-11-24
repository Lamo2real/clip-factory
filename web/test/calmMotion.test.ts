import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Calm motion adds no transitions (docs/CONTRACTS.md §20.6). Under calm motion (the system's setting or Settings ›
// Motion) base.css cuts every transition and animation to 1 ms, and sets transition-property to none at specificity 0,
// so only the transitions a part has of its own run (at 1 ms, so they still end and fire their end event at once).
// Before, transition-property's initial `all` gave every element a 1 ms transition of every style change, which lands
// only on the next frame drawn: on CI's software paint the page read old places, colours and visibility for hundreds of
// ms. Here every stylesheet is read so that stays true: base.css keeps its rules, and every rule that gives a part a
// transition names its properties and is more specific than base.css's none (so it wins, wherever it is loaded).
// e2e/calm-motion-transitions.spec.ts reads the same on real pages in both apps.

const SRC = join(import.meta.dirname, "..", "src");
/** Without comments, so a word in a comment never stands in for one in a rule. */
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const SHEETS = readdirSync(SRC, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".css"))
  .map((f) => ({ name: relative(SRC, join(SRC, f)), text: strip(readFileSync(join(SRC, f), "utf8")) }));
const BASE = SHEETS.find((s) => s.name === join("styles", "base.css"))!.text;

/** Every innermost rule as [selector, body]. */
const ruleList = (text: string) => [...text.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((m) => [m[1]!.trim().replace(/\s+/g, " "), m[2]!] as const);
/** Declarations of a rule body (a multi-line value is folded onto one line). */
const decls = (text: string) => [...text.matchAll(/(?:^|;)\s*(-{0,2}[a-z][a-z0-9-]*)\s*:\s*([^;]+)/g)].map((m) => [m[1]!, m[2]!.trim().replace(/\s+/g, " ")] as const);

/** Splits at top-level commas (a selector list, a value's layers). */
const split = (v: string) => {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of v) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};

type Spec = [number, number, number];
const add = (a: Spec, b: Spec): Spec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const more = (a: Spec, b: Spec) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const PSEUDO_ELEMENTS = new Set(["before", "after", "first-line", "first-letter", "placeholder", "selection", "marker", "backdrop"]);
/** A selector's specificity (Selectors Level 4: :where counts 0; :is, :not and :has count their most specific). */
function specificity(sel: string): Spec {
  let s: Spec = [0, 0, 0];
  let i = 0;
  const word = () => {
    while (i < sel.length && /[\w\\-]/.test(sel[i]!)) i++;
  };
  while (i < sel.length) {
    const c = sel[i]!;
    if (c === "#") {
      i++;
      word();
      s = add(s, [1, 0, 0]);
    } else if (c === ".") {
      i++;
      word();
      s = add(s, [0, 1, 0]);
    } else if (c === "[") {
      i = sel.indexOf("]", i) + 1;
      s = add(s, [0, 1, 0]);
    } else if (c === ":") {
      const element = sel[i + 1] === ":";
      i += element ? 2 : 1;
      const start = i;
      word();
      const name = sel.slice(start, i);
      let arg = "";
      if (sel[i] === "(") {
        let depth = 0;
        const open = i;
        for (; i < sel.length; i++) {
          if (sel[i] === "(") depth++;
          if (sel[i] === ")" && --depth === 0) break;
        }
        arg = sel.slice(open + 1, i++);
      }
      if (element || PSEUDO_ELEMENTS.has(name)) s = add(s, [0, 0, 1]);
      else if (name === "where") continue;
      else if (["is", "not", "has", "matches"].includes(name)) s = add(s, split(arg).map(specificity).reduce((m, x) => (more(x, m) > 0 ? x : m), [0, 0, 0] as Spec));
      else s = add(s, [0, 1, 0]);
    } else if (/[a-zA-Z]/.test(c)) {
      word();
      s = add(s, [0, 0, 1]);
    } else i++;
  }
  return s;
}
/** Whether a selector's subject is a pseudo-element (::before, ::-webkit-slider-thumb, ...). */
const pseudoElement = (sel: string) => /::?(?:before|after|first-line|first-letter|placeholder|selection|marker|backdrop)\s*$|::[\w-]+\s*$/.test(sel);

/** Every [sheet, selector, property, value] that touches a transition, outside base.css. */
const TRANSITIONS = SHEETS.filter((s) => s.name !== join("styles", "base.css")).flatMap((s) =>
  ruleList(s.text).flatMap(([selector, body]) =>
    decls(body)
      .filter(([prop]) => prop === "transition" || prop.startsWith("transition-"))
      .flatMap(([prop, value]) => split(selector).map((one) => ({ sheet: s.name, selector: one, prop, value }))),
  ),
);

describe("calm motion adds no transitions (§20.6)", () => {
  it("base.css cuts transitions to 1 ms and sets transition-property none at specificity 0, never !important", () => {
    const media = /@media \(prefers-reduced-motion: reduce\) \{((?:[^{}]*\{[^{}]*\})*)\s*\}/.exec(BASE)?.[1] ?? "";
    const only = (text: string, selector: string, prop: string, value: string) =>
      ruleList(text).filter(([sel, body]) => sel === selector && decls(body).some(([p, v]) => p === prop && v === value)).length;
    expect(only(media, "*, *::before, *::after", "transition-duration", "1ms !important")).toBe(1);
    expect(only(BASE, ".reduce-motion *, .reduce-motion *::before, .reduce-motion *::after", "transition-duration", "1ms !important")).toBe(1);
    expect(only(media, "*, *::before, *::after", "transition-property", "none")).toBe(1);
    expect(only(BASE, ":where(.reduce-motion) *, :where(.reduce-motion) *::before, :where(.reduce-motion) *::after", "transition-property", "none")).toBe(1);
    // As specific as can be for an element (0) and a pseudo-element (0,0,1), so every part's own rule wins.
    for (const sel of ["*", ":where(.reduce-motion) *"]) expect(specificity(sel)).toEqual([0, 0, 0]);
    for (const sel of ["*::before", ":where(.reduce-motion) *::after"]) expect(specificity(sel)).toEqual([0, 0, 1]);
  });

  it("the stylesheets were read", () => {
    expect(SHEETS.length).toBeGreaterThan(40);
    expect(TRANSITIONS.length).toBeGreaterThan(200);
  });

  it("every transition names its properties: none leans on `all` (an `all` would come back under calm motion)", () => {
    const leaning = TRANSITIONS.filter(({ prop }) => prop === "transition" || prop === "transition-property").flatMap(({ sheet, selector, prop, value }) =>
      value === "none"
        ? []
        : split(value)
            .map((layer) => layer.split(/\s+/)[0]!)
            .filter((first) => first === "all" || /^(?:[\d.]|var\(|calc\(|ease|linear|step|cubic-bezier|inherit|initial|unset)/.test(first))
            .map((first) => `${sheet}: ${selector} { ${prop}: ${value} } (${first})`),
    );
    expect(leaning).toEqual([]);
  });

  it("every rule that sets a transition is more specific than base.css's none, so it keeps its own transition under calm motion", () => {
    const weak = TRANSITIONS.filter(({ selector }) => more(specificity(selector), pseudoElement(selector) ? [0, 0, 1] : [0, 0, 0]) <= 0).map(
      ({ sheet, selector, prop, value }) => `${sheet}: ${selector} ${JSON.stringify(specificity(selector))} { ${prop}: ${value} }`,
    );
    expect(weak).toEqual([]);
  });

  it("the specificity count is right", () => {
    expect(specificity(".a .b")).toEqual([0, 2, 0]);
    expect(specificity(":is(.a, #b) > c::before")).toEqual([1, 0, 2]);
    expect(specificity(":where(.a, #b) d")).toEqual([0, 0, 1]);
    expect(specificity('.btn:active:not([aria-disabled="true"])')).toEqual([0, 3, 0]);
    expect(pseudoElement(".st-s-range::-webkit-slider-thumb")).toBe(true);
    expect(pseudoElement(".a:hover")).toBe(false);
  });
});
