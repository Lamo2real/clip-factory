import { expect, test, type Page } from "@playwright/test";
import { openTodo, CLIPS, openClip, resolveRoute, ROUTES, settle } from "./helpers.ts";
import { decode, rowMeans } from "./pixels.ts";
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

// A band of glass can draw an edge with no border at all: where its blur and tint stop. The setup bar the page scrolls
// under must melt into the page, so across its bottom the change it makes to the picture ramps, never jumps between
// two pixel rows. Measured as the difference between the screen with the bar and without it (the page under it the
// same: a flat white page under the bar), row by row.
for (const path of ["/", "/review", "/settings"]) {
  test(`the scrolled setup bar has no hard bottom edge on a phone (${path})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path);
    await settle(page);
    await page.mouse.wheel(0, 400);
    await expect(page.locator(".setup-todo-bar")).toHaveClass(/is-scrolled/);
    await page.waitForTimeout(500);
    // A flat white page under the bar (the worst case, a white thumbnail), so the page's own words and cards cannot
    // make a step and the bar's tint shows at its strongest.
    await page.evaluate(() => {
      const d = document.createElement("div");
      Object.assign(d.style, { position: "fixed", inset: "0", zIndex: "1", background: "#fff" });
      document.body.append(d);
    });
    await page.waitForTimeout(300);
    const bar = (await page.locator(".setup-todo-bar").boundingBox())!;
    // Left of the pill: the pill is a pane of its own, so where it ends is its edge, not the bar's.
    const pill = (await page.locator(".setup-todo").boundingBox())!;
    const clip = { x: 0, y: Math.max(0, bar.y + bar.height - 30), width: Math.max(60, Math.floor(pill.x) - 24), height: 90 };
    const withBar = rowMeans(await decode(page, await page.screenshot({ clip })));
    await page.addStyleTag({ content: ".setup-todo-bar, .setup-todo-bar * { visibility: hidden !important; }" });
    await page.waitForTimeout(300);
    const without = rowMeans(await decode(page, await page.screenshot({ clip })));
    const effect = withBar.map((v, i) => v - without[i]!);
    let jump = 0;
    for (let i = 1; i < effect.length; i++) jump = Math.max(jump, Math.abs(effect[i]! - effect[i - 1]!));
    expect(jump, `largest step between two rows of the bar's effect: ${jump.toFixed(2)} (${effect.map((v) => v.toFixed(1)).join(" ")})`).toBeLessThan(6);
  });
}

// With no rings, a button has to show it is a button some other way: a fill of its own, an underline or an icon.
// (Buttons inside a pick-one group are the group's options: the track and the <Glide> pill show them.)
test("every button reads as one without a ring: a fill, an underline or an icon, phone size", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const bare = async (where: string) =>
    (
      await page.evaluate(() => {
        const out: string[] = [];
        for (const el of Array.from(document.querySelectorAll<HTMLElement>("button, [role='button'], a.btn"))) {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height || (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))) continue;
          if (el.closest(".glide, [role='radiogroup'], [role='tablist'], .sr-only, .skip-link, svg")) continue;
          const s = getComputedStyle(el);
          const filled = (x: Element) => {
            const cs = getComputedStyle(x);
            const m = /rgba?\(([^)]*)\)/.exec(cs.backgroundColor);
            const a = m ? (m[1]!.split(/[\s,/]+/).filter(Boolean)[3] ?? "1") : "0";
            return Number(a) > 0.02 || cs.backgroundImage !== "none";
          };
          if (filled(el) || ["::before", "::after"].some((p) => getComputedStyle(el, p).content !== "none" && getComputedStyle(el, p).backgroundImage !== "none")) continue;
          if (s.textDecorationLine.includes("underline") || el.querySelector("svg, img, .icon")) continue;
          if (Array.from(el.querySelectorAll("*")).some((c) => getComputedStyle(c).textDecorationLine.includes("underline") || filled(c))) continue;
          out.push(`${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).slice(0, 2).join(".")} "${(el.textContent ?? "").trim().slice(0, 40)}"`);
        }
        return out;
      })
    ).map((b) => `${where}: ${b}`);
  const failures: string[] = [];
  for (const r of ROUTES) {
    const path = await resolveRoute(page, r);
    await page.goto(path);
    await settle(page);
    failures.push(...(await bare(path)));
  }
  await page.goto("/");
  await settle(page);
  await page.getByRole("button", { name: "Ask Clip Factory" }).click();
  await page.locator(".help-panel").waitFor();
  await page.waitForTimeout(400);
  failures.push(...(await bare("/ with Ask open")));
  expect([...new Set(failures)]).toEqual([]);
});

// Opening Ask by a tap or a click puts the caret in its box: that is no keyboard focus, so no ring (a deeper well and a
// soft glow show it is in use). After Tab the ring is back.
test("the Ask box wears no ring when Ask is opened by a click, and the ring after Tab", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await settle(page);
  await page.getByRole("button", { name: "Ask Clip Factory" }).click();
  const box = page.locator(".help-panel__input");
  await expect(box).toBeFocused();
  const ring = () =>
    box.evaluate((el) => {
      const s = getComputedStyle(el);
      const border = parseFloat(s.borderTopWidth) > 0 && !/rgba\([^)]*,\s*0\)|transparent/.test(s.borderTopColor);
      const solid = s.boxShadow.split(/,(?![^(]*\))/).some((l) => /0px 0px 0px [1-9]/.test(l.trim()));
      return border || solid;
    });
  expect(await ring()).toBe(false);
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(box).toBeFocused();
  expect(await ring()).toBe(true);
});
