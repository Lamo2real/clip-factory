// The "no visible edges" scan (ADR-45), shared by edges.spec.ts and help-pictures.spec.ts.
import type { Page } from "@playwright/test";

/** What may draw a line, as one selector matched against the element or its ancestors. */
export const ALLOWED = [
  ":focus-visible",
  ".is-found",
  ".help-ring",
  ".ring",
  ".progress",
  ".update-bar__progress",
  ".switch",
  ".spinner",
  ".act__item",
  ".is-running .timeline__node",
].join(", ");

/** Every visible edge on the screen, one line each ("selector: what"). */
export async function visibleEdges(page: Page): Promise<string[]> {
  return page.evaluate((allowed) => {
    const alpha = (css: string): number => {
      const m = /rgba?\(([^)]*)\)/.exec(css);
      if (!m) return css === "transparent" || css === "" ? 0 : 1;
      const parts = m[1]!.split(/[\s,/]+/).filter(Boolean);
      return parts.length >= 4 ? Number(parts[3]) : 1;
    };
    const layers = (v: string): string[] => {
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
    const name = (el: Element) => {
      const cls = typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}` : "";
      return `${el.tagName.toLowerCase()}${cls}`;
    };
    const found: string[] = [];
    const check = (el: Element, s: CSSStyleDeclaration, where: string) => {
      for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
        const w = parseFloat(s.getPropertyValue(`border-${side.toLowerCase()}-width`));
        const style = s.getPropertyValue(`border-${side.toLowerCase()}-style`);
        const colour = s.getPropertyValue(`border-${side.toLowerCase()}-color`);
        if (w > 0 && style !== "none" && style !== "hidden" && alpha(colour) > 0.02) found.push(`${where}: border-${side.toLowerCase()} ${w}px ${style} ${colour}`);
      }
      if (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 && alpha(s.outlineColor) > 0.02) found.push(`${where}: outline ${s.outlineWidth} ${s.outlineStyle} ${s.outlineColor}`);
      if (s.boxShadow && s.boxShadow !== "none")
        for (const layer of layers(s.boxShadow)) {
          const colour = /rgba?\([^)]*\)/.exec(layer)?.[0] ?? "";
          if (alpha(colour) <= 0.02) continue;
          const [x = 0, y = 0, blur = 0, spread = 0] = [...layer.replace(/rgba?\([^)]*\)/, "").matchAll(/(-?[\d.]+)px/g)].map((m) => Number(m[1]));
          if (blur <= 2 && (spread !== 0 || x !== 0 || y !== 0)) found.push(`${where}: box-shadow ${layer}`);
        }
    };
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      if (el.closest(allowed) || el.closest("svg")) continue;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || s.visibility === "hidden" || s.display === "none") continue;
      if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      check(el, s, name(el));
      for (const pseudo of ["::before", "::after"] as const) {
        const p = getComputedStyle(el, pseudo);
        if (p.content === "none" || p.content === "normal" || p.display === "none") continue;
        check(el, p, `${name(el)}${pseudo}`);
      }
    }
    return [...new Set(found)];
  }, ALLOWED);
}
