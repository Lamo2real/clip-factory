import { expect, test, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

// One text line down every page (docs/UX_DESIGN_SYSTEM.md, Layout): loose words (the breadcrumb, the page title, the
// lines between panels) start exactly where the words and contents inside the panels and cards start, at every size.

/** Where an element's first piece of content starts: its first glyph, or its first element child (an icon tile, a
 * thumbnail), whichever comes first in the document. */
async function startX(page: Page, selector: string): Promise<number | null> {
  return page.evaluate((sel) => {
    const el = Array.from(document.querySelectorAll<HTMLElement>(sel)).find((e) => e.getClientRects().length > 0);
    if (!el) return null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n: Node | null = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) {
        const text = n.textContent ?? "";
        const i = text.search(/\S/);
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, i + 1);
        const r = range.getBoundingClientRect();
        if (r.width > 0) return r.left;
      } else {
        const e = n as HTMLElement;
        const s = getComputedStyle(e);
        // A picture or tile that holds no words: its box is where the content starts.
        if (/^(IMG|SVG|VIDEO|PICTURE|CANVAS)$/i.test(e.tagName) || (!e.textContent?.trim() && e.getClientRects().length && s.display !== "contents")) {
          const r = e.getBoundingClientRect();
          if (r.width > 0) return r.left;
        }
      }
    }
    return null;
  }, selector);
}

const PAGES: { path: string; parts: string[]; below?: number }[] = [
  { path: "/settings/look-and-feel", parts: [".crumbs__item:first-child .crumbs__link", ".page-head__lede", ".branch-card"] },
  { path: "/settings/look-and-feel/sounds", parts: [".page-head__lede", ".apple-panel .apple__name"] },
  { path: "/", parts: [".hero__title", ".home-row__intro h2", ".getapp-banner"] },
  { path: "/review", parts: [".review-count", ".review-card__hook"] },
  { path: "/jobs", parts: [".job-row"] },
  // The views total leads the Library on phones; on wider screens it sits in the second column.
  { path: "/library", parts: [".lib-card"] },
  { path: "/library", parts: [".stat"], below: 768 },
];

for (const width of [320, 390, 768, 1440]) {
  test(`loose words and panel contents share one line at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fails: string[] = [];
    for (const p of PAGES) {
      if (p.below && width >= p.below) continue;
      await page.goto(p.path);
      await settle(page);
      const title = await startX(page, ".page-head__title");
      const line = title ?? (await startX(page, ".home-row__intro h2"));
      expect(line, `${p.path}: no text line`).not.toBeNull();
      for (const part of p.parts) {
        const x = await startX(page, part);
        if (x === null) continue;
        if (Math.abs(x - line!) > 1) fails.push(`${p.path} ${part}: starts at ${x.toFixed(1)}, the line is at ${line!.toFixed(1)}`);
      }
    }
    expect(fails, fails.join("\n")).toEqual([]);
  });
}
