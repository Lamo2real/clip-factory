import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { visibleEdges } from "./edges.ts";
import { findOverflow, launcherSettled, settle } from "./helpers.ts";

// The money dashboard (docs/CONTRACTS.md §27.4, §27.9): every size the owner uses (phones, tablets with and without
// touch, monitors, the desktop app's 1200 × 820 and its smallest 380 × 600) with no sideways scroll, no edges, AA
// contrast in light and dark, 44 px targets and the arrow cursor; on phones every control in the bottom-right thumb
// zone and nothing tappable top left; on wide screens a toolbar top right that stays in view; and the flows.

const NOW = "2026-11-19T12:00:00Z";
const VIEWPORTS: { w: number; h: number; touch: boolean }[] = [
  { w: 320, h: 568, touch: true },
  { w: 375, h: 812, touch: true },
  { w: 390, h: 844, touch: true },
  { w: 430, h: 932, touch: true },
  { w: 768, h: 1024, touch: true },
  { w: 768, h: 1024, touch: false },
  { w: 1024, h: 768, touch: true },
  { w: 1024, h: 768, touch: false },
  { w: 1280, h: 800, touch: false },
  { w: 1440, h: 900, touch: false },
  { w: 1920, h: 1080, touch: false },
  { w: 1200, h: 820, touch: false },
  { w: 380, h: 600, touch: false },
];
/** Where the dock is used: phones, the desktop app's smallest window, and touch screens up to a large tablet. */
const docked = (v: { w: number; touch: boolean }) => v.w < 768 || (v.touch && v.w <= 1194);

async function open(page: Page, scenario = "dash_many", path = "/money", keep = false) {
  await page.clock.setFixedTime(new Date(NOW));
  await page.goto("/");
  await page.evaluate(
    ([n, k]) => {
      sessionStorage.setItem("cf-mock-money", JSON.stringify({ scenario: n, country: "US", seen: [] }));
      if (!k) localStorage.removeItem("cf-money-dash");
    },
    [scenario, keep] as const,
  );
  await page.goto(path);
  await settle(page);
  if (path.startsWith("/money")) await page.locator(".dash-kpi, .dash-kpi--empty").first().waitFor();
}

/** Show more, scrolled to the middle first so the dock never sits on it. */
async function showMore(page: Page) {
  const more = page.getByRole("button", { name: "Show more" });
  await more.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await more.click();
}

async function context(browser: Browser, v: { w: number; h: number; touch: boolean }, scheme: "light" | "dark" = "light") {
  return browser.newContext({
    viewport: { width: v.w, height: v.h },
    hasTouch: v.touch,
    isMobile: v.touch && v.w < 768,
    reducedMotion: "reduce",
    colorScheme: scheme,
  });
}

const label = (v: { w: number; h: number; touch: boolean }) => `${v.w}x${v.h}${v.touch ? " touch" : ""}`;

for (const v of VIEWPORTS) {
  test(`fits, no edges, readable, big targets, arrow cursor: ${label(v)}`, async ({ browser }) => {
    test.setTimeout(180_000);
    for (const scheme of ["light", "dark"] as const) {
      const ctx = await context(browser, v, scheme);
      const page = await ctx.newPage();
      await open(page);
      const over = await findOverflow(page);
      expect(over.page, `${label(v)} ${scheme}: sideways scroll ${JSON.stringify(over.items.slice(0, 3))}`).toBeLessThanOrEqual(over.viewport);
      expect(await visibleEdges(page), `${label(v)} ${scheme}`).toEqual([]);
      const axe = await new AxeBuilder({ page }).include(".money-dash").withRules(["color-contrast"]).analyze();
      expect(axe.violations.flatMap((x) => x.nodes.map((n) => n.target.join(" "))), `${label(v)} ${scheme}`).toEqual([]);
      const small = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".money-dash a, .money-dash button, .money-dash .segmented__opt, .money-dash [tabindex='0']")]
          .filter((el) => el.offsetParent !== null && !el.closest("[hidden]"))
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && (r.width < 43.5 || r.height < 43.5))
          .map(({ el, r }) => `${el.className || el.tagName} ${Math.round(r.width)}x${Math.round(r.height)}`),
      );
      expect(small, `${label(v)} ${scheme}: targets under 44 px`).toEqual([]);
      const cursors = await page.evaluate(() =>
        [...document.querySelectorAll(".money-dash a, .money-dash button, .money-dash label, .money-dash [tabindex]")].map((el) => getComputedStyle(el).cursor).filter((c) => c !== "default"),
      );
      expect(cursors).toEqual([]);
      // The change chip's words carry the change: never cut off, even in the narrowest card.
      const cut = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".dash-chip .pill__text")].filter((el) => el.scrollWidth > el.clientWidth + 0.5).map((el) => el.textContent),
      );
      expect(cut, `${label(v)} ${scheme}: cut-off chips`).toEqual([]);
      // Wide clip rows: each app's views fit on one line in its column.
      const wrapped = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".mclip__app:not(.mclip__app--none) .mclip__app-views")]
          .filter((el) => getComputedStyle(el).display !== "none")
          .filter((el) => el.getBoundingClientRect().height > parseFloat(getComputedStyle(el).lineHeight) * 1.5).length,
      );
      expect(wrapped, `${label(v)} ${scheme}: app views wrapping`).toBe(0);
      await ctx.close();
    }
  });

  if (docked(v)) {
    test(`thumb zone: controls bottom right, nothing tappable top left: ${label(v)}`, async ({ browser }) => {
      const ctx = await context(browser, v);
      const page = await ctx.newPage();
      await open(page);
      await launcherSettled(page);
      const dock = page.locator(".money-dock");
      await expect(dock).toBeVisible();
      const geo = await page.evaluate(() => {
        const d = document.querySelector<HTMLElement>(".money-dock")!;
        const box = d.getBoundingClientRect();
        const pad = parseFloat(getComputedStyle(d).paddingRight);
        const controls = [...d.querySelectorAll<HTMLElement>("button, .segmented__opt")].map((el) => el.getBoundingClientRect());
        const seg = d.querySelector(".dash-period .segmented")!.getBoundingClientRect();
        // §39.2: All your money is the page's first card (its title in view above the dock on first load).
        const num = document.querySelector(".cr-all__title")!.getBoundingClientRect();
        const tabEl = document.querySelector<HTMLElement>(".tabbar");
        const tab = tabEl && tabEl.offsetParent !== null ? tabEl.getBoundingClientRect() : null;
        const ask = document.querySelector<HTMLElement>(".help-launcher");
        const askBox = ask?.getBoundingClientRect() ?? null;
        const topLeft = [...document.querySelectorAll<HTMLElement>(".money-dash a, .money-dash button, .money-dash input, .money-dash [tabindex='0']")]
          .filter((el) => el.offsetParent !== null && !el.closest(".money-dock"))
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.left + r.width / 2 < innerWidth / 2 && r.top + r.height / 2 < innerHeight / 3);
        return {
          vw: innerWidth,
          vh: innerHeight,
          box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
          contentRight: box.right - pad,
          centres: controls.map((r) => r.top + r.height / 2),
          segRight: seg.right,
          tab: tab && { top: tab.top, bottom: tab.bottom },
          ask: askBox && { top: askBox.top, bottom: askBox.bottom, left: askBox.left, right: askBox.right },
          askHidden: ask?.classList.contains("is-hidden") ?? false,
          numBottom: num.bottom,
          topLeft: topLeft.length,
        };
      });
      for (const c of geo.centres) expect(c, "control centre in the bottom 40%").toBeGreaterThanOrEqual(0.6 * geo.vh);
      expect(geo.vw - geo.box.right).toBeLessThanOrEqual(24 + 1);
      expect(Math.abs(geo.segRight - geo.contentRight)).toBeLessThanOrEqual(1);
      expect(geo.topLeft, "nothing tappable in the top-left third").toBe(0);
      if (geo.tab) expect(geo.box.bottom).toBeLessThanOrEqual(geo.tab.top);
      if (geo.ask) {
        const overlaps = !(geo.ask.bottom <= geo.box.top || geo.ask.top >= geo.box.bottom || geo.ask.right <= geo.box.left || geo.ask.left >= geo.box.right);
        expect(overlaps, "Ask sits above the dock").toBe(false);
        expect(geo.askHidden, "Ask stays shown once the page is still").toBe(false);
      }
      expect(geo.numBottom, "All your money is in view above the dock on first load").toBeLessThanOrEqual(geo.box.top);
      // The last clip row scrolls fully clear of the dock.
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(200);
      const clear = await page.evaluate(() => {
        const rows = document.querySelectorAll(".mclip-item, .dash-more");
        const last = rows[rows.length - 1]!.getBoundingClientRect();
        return last.bottom <= document.querySelector(".money-dock")!.getBoundingClientRect().top + 1;
      });
      expect(clear).toBe(true);
      await ctx.close();
    });
  } else {
    test(`toolbar top right, stays in view after scrolling: ${label(v)}`, async ({ browser }) => {
      const ctx = await context(browser, v);
      const page = await ctx.newPage();
      await open(page);
      await expect(page.locator(".money-dock")).toHaveCount(0);
      const bar = page.locator(".dash-toolbar");
      const inRightHalf = async () =>
        bar.evaluate((el) => [...el.querySelectorAll("button, .segmented__opt")].every((c) => c.getBoundingClientRect().left >= innerWidth / 2 - 80));
      expect(await inRightHalf()).toBe(true);
      // Wheel over the page itself (not the sidebar under the mouse's start point), then wait for the scroll to land.
      await page.mouse.move(v.w * 0.6, v.h * 0.6);
      await page.mouse.wheel(0, 1500);
      await expect.poll(() => page.evaluate(() => document.scrollingElement!.scrollTop)).toBeGreaterThan(600);
      await page.waitForTimeout(150);
      const box = await bar.boundingBox();
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(v.h / 3);
      await expect(bar).toBeInViewport();
      // It is a full-width band the page scrolls under, not a pill floating over the content beside it.
      const widths = await page.evaluate(() => ({
        band: document.querySelector(".dash-band")!.getBoundingClientRect().width,
        page: document.querySelector(".money-dash")!.getBoundingClientRect().width,
      }));
      expect(widths.band).toBeGreaterThanOrEqual(widths.page - 1);
      // The sort bar and a clip's money, scrolled to where they are read, are never under the band.
      const clear = async (selector: string) => {
        await page.locator(selector).first().evaluate((el) => el.scrollIntoView({ block: "center" }));
        await page.waitForTimeout(150);
        return page.evaluate((sel) => {
          const band = document.querySelector(".dash-band")!.getBoundingClientRect();
          const r = document.querySelector(sel)!.getBoundingClientRect();
          return r.top >= band.bottom || r.bottom <= band.top;
        }, selector);
      };
      expect(await clear(".dash-sort"), "sort bar clear of the band").toBe(true);
      expect(await clear(".mclip-item:nth-child(6) .mclip__total"), "a clip's total clear of the band").toBe(true);
      await ctx.close();
    });
  }
}

// Ask never covers words on the Money page (§27.4): on every phone size, light and dark, at the top and at every
// place the page can be scrolled to and left, a shown Ask has no line of visible text under it (it fades out there
// instead), and on first load it is shown. Weekly reads from the top: no empty gap above its number.
const textUnderAsk = () => {
  const el = document.querySelector<HTMLElement>(".help-launcher");
  if (!el || el.classList.contains("is-hidden")) return { shown: false, under: [] as string[] };
  const b = { top: el.offsetTop, bottom: el.offsetTop + el.offsetHeight, left: el.offsetLeft, right: el.offsetLeft + el.offsetWidth };
  const under: string[] = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const p = n.parentElement;
    if (!p || !n.textContent?.trim() || p.closest(".help-launcher, .help-panel, .sr-only, [hidden], [inert]")) continue;
    if (getComputedStyle(p).visibility === "hidden") continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const line of range.getClientRects()) {
      // Only what shows: the part of the line inside every box around it that cuts off what runs past it.
      const r = { left: line.left, right: line.right, top: line.top, bottom: line.bottom, width: 0, height: 0 };
      for (let a: HTMLElement | null = p; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a);
        const box = a.getBoundingClientRect();
        if (cs.overflowX !== "visible") {
          r.left = Math.max(r.left, box.left);
          r.right = Math.min(r.right, box.right);
        }
        if (cs.overflowY !== "visible") {
          r.top = Math.max(r.top, box.top);
          r.bottom = Math.min(r.bottom, box.bottom);
        }
        if (cs.position === "fixed") break;
      }
      r.width = r.right - r.left;
      r.height = r.bottom - r.top;
      if (r.width > 1 && r.height > 1 && Math.min(r.right, b.right) - Math.max(r.left, b.left) > 0.5 && Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top) > 0.5) {
        const pr = p.getBoundingClientRect();
        // What the failure says: the words, the box they are in, and Ask's state (to tell a miss from a late fade).
        under.push(`${n.textContent.trim().slice(0, 40)} [words ${Math.round(r.left)}-${Math.round(r.right)} x ${Math.round(r.top)}-${Math.round(r.bottom)}, box ${Math.round(pr.left)}-${Math.round(pr.right)}, Ask ${b.left}-${b.right} x ${b.top}-${b.bottom}${el.hasAttribute("data-settling") ? ", settling" : ""}]`);
        break;
      }
    }
  }
  return { shown: true, under };
};
for (const v of VIEWPORTS.filter((x) => x.w < 768)) {
  for (const scheme of ["light", "dark"] as const) {
    test(`no words under Ask, at rest anywhere on the page: ${label(v)} ${scheme}`, async ({ browser }) => {
      const ctx = await context(browser, v, scheme);
      const page = await ctx.newPage();
      const fails: string[] = [];
      for (const scenario of ["dash_youtube_only", "dash_many"]) {
        await open(page, scenario);
        await launcherSettled(page);
        const first = await page.evaluate(textUnderAsk);
        expect(first.shown, `${scenario}: Ask is shown on first load`).toBe(true);
        if (scenario === "dash_youtube_only") {
          const gap = await page.evaluate(() => {
            const sub = document.querySelector("[data-kpi=weekly] .dash-kpi__sub")!.getBoundingClientRect();
            const num = document.querySelector("[data-kpi=weekly] .dash-num")!.getBoundingClientRect();
            return num.top - sub.bottom;
          });
          expect(gap, "Weekly's number sits right under its words").toBeLessThanOrEqual(24);
        }
        const max = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
        for (const y of [...Array.from({ length: Math.floor(max / 400) + 1 }, (_, i) => i * 400), max]) {
          await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), y);
          await launcherSettled(page);
          const at = await page.evaluate(textUnderAsk);
          if (at.under.length) {
            // Say whether Ask fades a little later (it looked too early) or never does (it missed the words).
            const state = await page.evaluate(() => {
              const el = document.querySelector<HTMLElement>(".help-launcher")!;
              const vv = window.visualViewport;
              return `scrollY ${Math.round(scrollY)}, inner ${innerWidth}x${innerHeight}, vv ${vv ? `${vv.scale} ${Math.round(vv.offsetTop)}` : "-"}, class "${el.className}"`;
            });
            await page.waitForTimeout(2500);
            const later = await page.evaluate(textUnderAsk);
            fails.push(`${scenario} at ${y}: ${at.under.join(" | ")} {${state}; 2.5 s later ${later.shown ? `still shown over ${later.under.length}` : "faded"}}`);
          }
        }
      }
      expect(fails, fails.join("\n")).toEqual([]);
      await ctx.close();
    });
  }
}

test.describe("flows", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("All is the default and Monthly MRR comes first and biggest", async ({ page }) => {
    await open(page);
    await expect(page.locator(".dash-app[data-app='all']")).toHaveAttribute("aria-pressed", "true");
    const kpis = page.locator("[data-kpi]");
    await expect(kpis.first()).toHaveAttribute("data-kpi", "monthly");
    const sizes = await page.locator(".dash-kpi .dash-num").evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)));
    expect(sizes[0]).toBe(Math.max(...sizes));
    await expect(page.locator("[data-kpi='monthly']")).toContainText("Monthly MRR");
    await expect(page.locator("[data-kpi='monthly']")).toContainText("Apps' estimates");
    await expect(page.locator("[data-kpi='yearly']")).toContainText("At this pace for a year");
    await expect(page.locator(".dash-through")).toContainText("Up to Mon 16 Nov");
    await expect(page.locator(".dash-notes")).toContainText("Not counted: TikTok, Instagram and X don't share money with apps.");
    // Vermilion is for actions only: none here (no Allow money reading needed).
    await expect(page.locator(".money-dash .btn--action, .money-dash .btn--primary")).toHaveCount(0);
  });

  test("TikTok only: one card says where to look, the clips sort by views with a note", async ({ page }) => {
    await open(page);
    await page.locator(".dash-app[data-app='tiktok']").click();
    await expect(page.locator(".dash-app[data-app='tiktok']")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-kpi='not-shared']")).toContainText("TikTok doesn't share money with apps. Look in Profile › Balance.");
    await expect(page.locator(".dash-clips")).toContainText("TikTok doesn't share money per video. Sorted by views.");
    await expect(page.locator(".mclip").first()).not.toContainText("$");
    // The list can only be sorted by views: no sort bar saying "Most money".
    await expect(page.getByRole("radiogroup", { name: "Sort clips" })).toHaveCount(0);
    await expect(page).toHaveURL(/\/money\?apps=tiktok$/);
  });

  test("two currencies get a picker and are never added", async ({ page }) => {
    await open(page, "dash_two_currencies", "/money?apps=youtube,facebook");
    await expect(page.getByRole("radiogroup", { name: "Money type" })).toBeVisible();
    await expect(page.getByText("Different money types are never added together.")).toBeVisible();
    await expect(page.locator("[data-kpi='monthly'] .dash-kpi__line")).toHaveCount(2);
    const eur = page.getByRole("radiogroup", { name: "Money type" }).getByRole("radio", { name: "EUR" });
    await eur.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await eur.click();
    await expect(page.locator(".dash-chart-card .money-tag")).toHaveText("Meta's estimate");
  });

  test("the choice survives a reload, a deep link wins, and changing it never moves focus or scroll", async ({ page }) => {
    await open(page);
    await page.locator(".dash-app[data-app='youtube']").click();
    await page.getByRole("radiogroup", { name: "Period" }).getByRole("radio", { name: "7 days" }).click();
    await page.evaluate(() => scrollTo(0, 400));
    const y = await page.evaluate(() => scrollY);
    await page.getByRole("radiogroup", { name: "Period" }).getByRole("radio", { name: "90 days" }).click();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => scrollY)).toBe(y);
    expect(await page.evaluate(() => document.activeElement?.closest(".money-dock") !== null)).toBe(true);
    await page.goto("/money");
    await settle(page);
    await expect(page.locator(".dash-app[data-app='youtube']")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("radiogroup", { name: "Period" }).getByRole("radio", { name: "90 days" })).toBeChecked();
    await page.goto("/money?apps=facebook&period=7");
    await settle(page);
    await expect(page.locator(".dash-app[data-app='facebook']")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".dash-app[data-app='youtube']")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("radiogroup", { name: "Period" }).getByRole("radio", { name: "7 days" })).toBeChecked();
  });

  test("the period's highlight slides with Glide, and is instant under reduced motion", async ({ page }) => {
    await open(page);
    const bar = page.locator(".money-dock .segmented");
    await expect(bar).toHaveClass(/has-glide/);
    await page.getByRole("radiogroup", { name: "Period" }).getByRole("radio", { name: "Year" }).click();
    await expect(page.locator(".dash-section-title").first()).toHaveText("Money per week");
    await page.emulateMedia({ reducedMotion: "reduce" });
    // Under reduced motion the highlight only cross-fades: no transform travels.
    const props = await bar.evaluate((el) => getComputedStyle(el.querySelector(":scope > .glide")!).transitionProperty);
    expect(props).not.toContain("transform");
  });

  test("a tap on the chart shows the day, the amount and whose estimate; the list shows every value", async ({ page }) => {
    await open(page);
    const plot = page.locator(".dash-chart__plot");
    await plot.scrollIntoViewIfNeeded();
    const box = (await plot.boundingBox())!;
    await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
    await expect(page.locator(".dash-tip")).toContainText("Mon 16 Nov · $");
    await expect(page.locator(".dash-tip")).toContainText("Apps' estimates");
    await expect(page.locator(".dash-chart [aria-live]")).toContainText("Mon 16 Nov");
    await page.getByRole("button", { name: "Show as a list" }).click();
    await expect(page.locator(".dash-chart__list li")).toHaveCount(30);
    // One name, on the focusable plot (a group, so screen readers read it); the drawing itself is hidden.
    await expect(plot).toHaveAttribute("role", "group");
    await expect(plot).toHaveAttribute("aria-label", /^Money per day, 30 days up to Mon 16 Nov\. Highest: \$/);
    await expect(plot.locator("svg")).toHaveAttribute("aria-hidden", "true");
  });

  test("a clip row opens its clip page, and Show more loads the next page", async ({ page }) => {
    await open(page);
    const rows = page.locator(".mclip");
    await expect(rows).toHaveCount(20);
    await showMore(page);
    // 26 posted clips; the 2 posted after YouTube's newest reported day wait for their first money day.
    await expect(rows).toHaveCount(24);
    await expect(rows.first()).toContainText("per 1,000 views · YouTube's numbers");
    const id = await rows.first().getAttribute("data-clip");
    await rows.first().click();
    await expect(page).toHaveURL(new RegExp(`/clips/${id}$`));
  });

  test("no money yet shows the nearest goal; a failed check shows a banner with the data kept", async ({ page }) => {
    await open(page, "dash_nothing");
    await expect(page.locator("[data-kpi='empty']")).toContainText("No money yet.");
    await expect(page.locator("[data-kpi='empty'] .money-bar")).toBeVisible();
    await expect(page.getByRole("link", { name: "See how close you are" })).toHaveAttribute("href", "/settings/posting/money");
    await open(page, "dash_error");
    await expect(page.locator(".dash-banner")).toHaveText("Couldn't check YouTube today. Showing money up to Tue 10 Nov.");
    await expect(page.locator("[data-kpi='monthly'] .dash-num")).toContainText("$");
    await showMore(page);
    await expect(page.locator(".dash-clips .error-panel")).toBeVisible();
    await expect(page.locator(".mclip")).toHaveCount(20); // the rows already shown stay
  });

  test("short history says it can't compare yet, and needs-permission offers the one vermilion button", async ({ page }) => {
    await open(page, "dash_short_history");
    await expect(page.locator("[data-kpi='monthly']")).toContainText("Not enough days to compare yet");
    await expect(page.locator("[data-kpi='monthly'] .dash-chip")).toHaveCount(0);
    await open(page, "start");
    // The Notes card's (All your money's YouTube row has its own glass one).
    const allow = page.locator(".dash-notes").getByRole("link", { name: "Allow money reading" });
    await expect(allow).toHaveClass(/btn--action/);
    await expect(allow).toHaveAttribute("href", "/settings/posting/money#money-youtube");
  });

  test("Home's See money and the tab bar go to Money, and Money shows as the active tab", async ({ page }) => {
    await open(page, "earning", "/");
    await page.getByRole("link", { name: "See money" }).click();
    await expect(page).toHaveURL(/\/money$/);
    await expect(page.locator(".tabbar__item[aria-current='page']")).toHaveAttribute("aria-label", "Money");
    expect(await page.title()).toBe("Money · Clip Factory");
  });

  test("All your money comes right after the title, then the filters, in reading and tab order (§39.2)", async ({ page }) => {
    await open(page);
    const order = await page.evaluate(() => [...document.querySelector(".money-dash")!.children].slice(0, 3).map((el) => el.className));
    expect(order[0]).toContain("dash-head");
    expect(order[1]).toContain("cr-all");
    expect(order[2]).toContain("money-dock");
  });

  test("with motion on, the count-up never shows a negative amount", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "no-preference" });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __seen: string[] }).__seen = seen;
      new MutationObserver(() => {
        for (const el of document.querySelectorAll("[data-kpi=monthly] .dash-num")) seen.push(el.textContent ?? "");
      }).observe(document, { subtree: true, childList: true, characterData: true });
    });
    await open(page);
    await page.waitForTimeout(1200);
    const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.filter((t) => t.trim().startsWith("-") || t.includes("−"))).toEqual([]);
    const num = page.locator("[data-kpi='monthly'] .dash-num").first();
    expect(await num.textContent()).toBe(await num.getAttribute("data-final"));
    await ctx.close();
  });

  test("with reduced motion the number is final on first paint (no count-up)", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page);
    const num = page.locator("[data-kpi='monthly'] .dash-num").first();
    expect(await num.textContent()).toBe(await num.getAttribute("data-final"));
  });
});

test.describe("desktop sidebar", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test("Money sits between Library and Settings and shows as active", async ({ page }) => {
    await open(page);
    const items = page.locator(".sidebar__item:not(.sidebar__getapp)");
    await expect(items).toHaveText([/Home/, /Jobs/, /Review/, /Library/, /Money/, /Settings/]);
    await expect(page.locator(".sidebar__item[aria-current='page']")).toContainText("Money");
  });
});
