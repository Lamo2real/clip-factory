import { expect, test, type Page } from "@playwright/test";
import { settle, stillBackdrop } from "./helpers.ts";

// Home's boxes are as tall as what is in them and nothing leaves the screen, from a phone to a big monitor. The owner
// (2026-11-21): "fix the unnecessary space in the boxes and make sure the solution fits all resolutions such as phone
// and monitors". From 1440 px the setup list's column is open and takes 352 px of the page, which is where the old
// side-by-side rows stretched the covers, the views total and the money box to a tall heading column.

const SIZES: [number, number][] = [
  [375, 812],
  [768, 1024],
  [1024, 768],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
  [2560, 1440],
];
/** Room a box may keep under (and, centred, over) its last line: half-leading and rounding, never a blank band. */
const SPARE = 12;

// WebKit on Linux paints without a GPU: hold the living backdrop still so frames stay cheap (helpers.ts, stillBackdrop).
test.beforeEach(async ({ page, browserName }) => {
  if (browserName === "webkit") await stillBackdrop(page);
});

interface Box {
  name: string;
  spareTop: number;
  spareBottom: number;
  /** How much of its inner width the drawn content spans (0 to 1). */
  fill: number;
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    /** Where the drawn things in a box start and end: glyph boxes, pictures, icons, bars and buttons. */
    const drawn = (el: Element) => {
      let top = Infinity;
      let bottom = -Infinity;
      let left = Infinity;
      let right = -Infinity;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        let rects: DOMRect[] = [];
        if (n.nodeType === Node.TEXT_NODE) {
          if (!n.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          rects = Array.from(range.getClientRects());
        } else {
          const e = n as HTMLElement;
          const s = getComputedStyle(e);
          if (s.display === "none" || s.visibility === "hidden") continue;
          // Links and buttons are drawn boxes too: a text link is a 48 px tap target round its words.
          if (/^(IMG|SVG|BUTTON|A)$/i.test(e.tagName) || e.getAttribute("role") === "progressbar" || e.classList.contains("btn") || e.classList.contains("stat__dots"))
            rects = [e.getBoundingClientRect()];
        }
        for (const r of rects) {
          if (r.width < 1 || r.height < 1) continue;
          top = Math.min(top, r.top);
          bottom = Math.max(bottom, r.bottom);
          left = Math.min(left, r.left);
          right = Math.max(right, r.right);
        }
      }
      return { top, bottom, left, right };
    };
    const boxes: Box[] = [];
    for (const el of document.querySelectorAll(".home-row .teaser, .home-row > .stat, .money-tile__body, .cr-row-chip, .working")) {
      if (!el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const d = drawn(el);
      boxes.push({
        name: `${(el as HTMLElement).className.split(" ")[0]} "${(el.textContent ?? "").trim().slice(0, 24)}"`,
        spareTop: Math.round(d.top - r.top - parseFloat(s.paddingTop) - parseFloat(s.borderTopWidth)),
        spareBottom: Math.round(r.bottom - parseFloat(s.paddingBottom) - parseFloat(s.borderBottomWidth) - d.bottom),
        fill: (d.right - d.left) / (r.width - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) - parseFloat(s.borderLeftWidth) - parseFloat(s.borderRightWidth)),
      });
    }
    const out: string[] = [];
    for (const el of document.querySelectorAll(".home .glass, .home-row__intro > *, .setup-todo")) {
      if (!el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      if (r.left < -0.5 || r.right > vw + 0.5) out.push(`${(el as HTMLElement).className.split(" ")[0]} runs ${Math.round(r.left)}–${Math.round(r.right)} on a ${vw} px screen`);
    }
    const cards = document.querySelector(".home-row__cards")!;
    const shown = Array.from(cards.children).filter((c) => c.getClientRects().length > 0);
    const hero = document.querySelector(".hero__main")!.getBoundingClientRect();
    const side = document.querySelector(".hero__side")!.getBoundingClientRect();
    return {
      boxes,
      out,
      sideways: document.scrollingElement!.scrollWidth > vw,
      shown: shown.length,
      rowGap: Math.round(cards.getBoundingClientRect().right - shown[shown.length - 1]!.getBoundingClientRect().right),
      lines: new Set(shown.map((c) => Math.round(c.getBoundingClientRect().top))).size,
      heights: new Set(shown.map((c) => Math.round(c.getBoundingClientRect().height))).size,
      narrowest: Math.min(...shown.map((c) => c.getBoundingClientRect().width)),
      widest: Math.max(...shown.map((c) => c.getBoundingClientRect().width)),
      twoColumnHero: Math.abs(hero.top - side.top) < 2,
      heroGap: Math.round(hero.height - side.height),
      todo: document.querySelector<HTMLElement>(".setup-todo")?.dataset.mode ?? null,
    };
  });
}

for (const [width, height] of SIZES) {
  test(`Home at ${width} px: every box fits what is in it, the covers fill one line, nothing is cut off`, async ({ page, browserName }) => {
    // Linux WebKit in CI is slow at the biggest page; 1920 px covers its wide case.
    test.skip(browserName === "webkit" && width > 1920, "Chromium covers 2560 px");
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await settle(page);
    const m = await measure(page);
    if (width >= 1440) expect(m.todo, "the setup list's column is open").toBe("rail");

    const loose = m.boxes.filter((b) => b.spareBottom > SPARE || b.spareTop > SPARE).map((b) => `${b.name}: ${b.spareTop} px over, ${b.spareBottom} px under`);
    expect(loose, loose.join("\n")).toEqual([]);
    expect(m.out, m.out.join("\n")).toEqual([]);
    expect(m.sideways, "the page scrolls sideways").toBe(false);
    // The views total is no wider than what is in it: a short card with the number beside its lines, or a column
    // as wide as the number.
    const stat = m.boxes.find((b) => b.name.startsWith("stat "))!;
    expect(stat.fill, `the views total is ${Math.round((1 - stat.fill) * 100)} % empty across`).toBeGreaterThanOrEqual(0.66);

    // The mock starts with five clips waiting, at least one short of any row: the covers fill the row edge to edge,
    // all on one line, all one height, none squeezed thin or blown up.
    expect(m.shown).toBeGreaterThanOrEqual(2);
    expect(Math.abs(m.rowGap), "the covers leave the end of the row empty").toBeLessThanOrEqual(2);
    expect(m.lines).toBe(1);
    expect(m.heights).toBe(1);
    expect(m.narrowest).toBeGreaterThanOrEqual(130);
    expect(m.widest).toBeLessThanOrEqual(240);

    // Side by side, the hero's right column runs its whole height (the fanned covers take the room under Working now).
    if (m.twoColumnHero) expect(Math.abs(m.heroGap)).toBeLessThanOrEqual(1);
  });
}

test("Home with nothing to review: the one card spans the row and stays one short line, and the hero is one column", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("cf-mock-empty", "1"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await settle(page);
  const empty = page.locator(".home-row__cards > .teaser--empty");
  await expect(empty).toHaveText("All done here.");
  const [card, row] = await Promise.all([empty.boundingBox(), page.locator(".home-row__cards").boundingBox()]);
  expect(Math.round(card!.width)).toBe(Math.round(row!.width));
  expect(card!.height).toBeLessThanOrEqual(72);
  // No covers to fan out: Working now goes under the form, as wide as it, instead of a short card over empty glass.
  await expect(page.locator(".hero")).toHaveClass(/hero--bare/);
  const [main, working] = await Promise.all([page.locator(".hero__main").boundingBox(), page.locator(".working").boundingBox()]);
  expect(working!.y).toBeGreaterThan(main!.y + main!.height - 1);
  expect(Math.round(working!.width)).toBe(Math.round(main!.width));
});
