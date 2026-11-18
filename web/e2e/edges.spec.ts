import { expect, test, type Page } from "@playwright/test";
import { openTodo, CLIPS, openClip, resolveRoute, ROUTES, settle } from "./helpers.ts";
import { WINDOW_EXTRA_ROUTES } from "./glass.ts";

// No visible edges anywhere (owner, 2026-11-18; docs/DECISIONS.md ADR-45): no element on any screen draws a border,
// an outline, a ring or a hard line (a box-shadow layer with almost no blur), and no pseudo-element draws one for it.
// A pane shows by its blur, tint and shadow; a control by its fill. The only lines left are the allowed ones:
//   - the keyboard focus ring while :focus-visible (nothing is focused by keyboard here);
//   - the temporary "found" highlight (search) and Ask's spotlight ring, which trace a box on purpose;
//   - progress bars and rings, the switch track, spinners and the running step's pulse;
//   - the short action blinks (motion.css .act__item) and text underlines (text decoration, not a box edge).
// Run at a phone (390 × 844) and a desktop (1440 × 900) size, on every route plus a clip page, the Ask panel open and
// the setup list open. test/background.test.ts holds the stylesheets to the same rule without a browser.

const SIZES = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

/** What may draw a line, as one selector matched against the element or its ancestors. */
const ALLOWED = [
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

test.use({ reducedMotion: "reduce" });

/** Every visible edge on the screen, one line each ("selector: what"). */
async function visibleEdges(page: Page): Promise<string[]> {
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
      const bg = s.backgroundColor;
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
          // A spread in the element's own fill colour pads its fill (the loose-text scrim): not an edge.
          if (colour === bg) continue;
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

for (const size of SIZES) {
  test(`no visible edges on any screen, ${size.name} (${size.width}×${size.height})`, async ({ page }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: size.width, height: size.height });
    const paths: string[] = [];
    for (const r of ROUTES) paths.push(await resolveRoute(page, r));
    paths.push(...WINDOW_EXTRA_ROUTES);
    const failures: string[] = [];
    for (const path of paths) {
      await page.goto(path);
      if (!path.endsWith(".html")) await settle(page);
      for (const e of await visibleEdges(page)) failures.push(`${path}: ${e}`);
    }
    // A clip's page (opened from the Library), the Ask panel open, the setup list open.
    await openClip(page, CLIPS.all);
    for (const e of await visibleEdges(page)) failures.push(`a clip page: ${e}`);
    await page.goto("/");
    await settle(page);
    await page.getByRole("button", { name: "Ask Clip Factory" }).click();
    await page.locator(".help-panel").waitFor();
    await page.waitForTimeout(400);
    for (const e of await visibleEdges(page)) failures.push(`/ with Ask open: ${e}`);
    await page.goto("/library");
    await settle(page);
    await openTodo(page);
    await page.waitForTimeout(400);
    for (const e of await visibleEdges(page)) failures.push(`/library with the setup list open: ${e}`);
    expect(failures).toEqual([]);
  });
}

test("the scan does find an edge when one is drawn (so the checks above can fail)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings");
  await settle(page);
  expect(await visibleEdges(page)).toEqual([]);
  await page.addStyleTag({ content: ".glass { border-color: rgb(239 231 218 / 0.22) !important; } .glass { box-shadow: inset 0 1px 0 #efe7da !important; }" });
  const found = await visibleEdges(page);
  expect(found.some((f) => f.includes("border-top"))).toBe(true);
  expect(found.some((f) => f.includes("box-shadow"))).toBe(true);
});
