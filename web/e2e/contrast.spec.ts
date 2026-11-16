import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { animationsDone, resolveRoute, ROUTES, scanText, settle } from "./helpers.ts";

// Every screen's text is readable (audit F081, WCAG 2.1 AA 1.4.3; docs/TESTING.md "Contrast and text size"):
// at 320, 375 and 1440 px, with the browser asking for light and for dark (the app is light-only, so dark must
// look the same), on every route in ROUTES:
//   1. axe-core's color-contrast rule finds no violation;
//   2. every visible text run reaches 4.5:1 (3:1 for 24 px, or 18.66 px bold, and up) against every background it
//      can sit on: its ancestors' colours and glass gradients composited over the backdrop it can scroll across;
//   3. no visible text is smaller than 12 px.
// Reduced motion parks the drifting backdrop and finishes entrance fades, so every run measures the same picture.

const WIDTHS = [320, 375, 1440] as const;
const SCHEMES = ["light", "dark"] as const;

/**
 * Decorative text left out on purpose, as one CSS selector. It is empty today: every visible text run passes.
 * Only add aria-hidden text that carries no meaning (never a label, a number or an error), each with a comment
 * saying why, and add the same selector to the axe `exclude` below.
 */
const DECORATIVE = "";

test.use({ reducedMotion: "reduce" });

for (const route of ROUTES) {
  test(`text on ${route} is readable at 320, 375 and 1440 px, light and dark`, async ({ page }) => {
    test.setTimeout(180_000);
    const path = await resolveRoute(page, route);
    const failures: string[] = [];
    for (const scheme of SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: width < 768 ? 812 : 900 });
        await page.goto(path);
        await settle(page);
        await animationsDone(page);
        const at = `${path} @${width} ${scheme}`;

        const axe = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
        for (const v of axe.violations)
          for (const n of v.nodes) failures.push(`${at} axe: ${n.target.join(" ")}: ${n.any.map((c) => c.message).join("; ")}`);

        const scan = await scanText(page, DECORATIVE);
        expect(scan.checked, `${at}: found no text to check`).toBeGreaterThan(0);
        test.info().annotations.push({ type: "text runs", description: `${at}: ${scan.checked} checked, ${scan.pictures} on a picture (axe only)` });
        for (const f of scan.contrast)
          failures.push(`${at} contrast: ${f.selector} "${f.text}" ${f.ratio}:1 < ${f.need}:1 (${f.color} on ${f.background}, ${f.fontSize}px)`);
        for (const f of scan.tiny) failures.push(`${at} size: ${f.selector} "${f.text}" is ${f.fontSize}px (< 12px)`);
      }
    }
    expect(failures).toEqual([]);
  });
}
