import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { visibleEdges } from "./edges.ts";
import { findOverflow, settle } from "./helpers.ts";

// All your money in one place (docs/CONTRACTS.md §39.2, §39.5), in mock mode: the first card on the Money page, before
// the Apps chips; one row per place in STATS_ORDER then Content Rewards; "Not available from TikTok" and never a
// number there; one total per currency, the biggest number on the page (Monthly's one size smaller, "Apps only."),
// "Nothing to add up yet." with no total; no vermilion in it; and every size: no sideways scroll, no edges, big
// targets, the arrow cursor, AA contrast light and dark, the phone's buttons at the right.

const NOW = "2026-11-19T15:00:00.000Z";
type Knobs = Record<string, (...a: unknown[]) => unknown>;
type MockWin = Window & { __cfMock?: { cr?: Knobs } };

async function open(page: Page, scenario = "dash_many", flags: Record<string, string> = {}) {
  await page.clock.setFixedTime(new Date(NOW));
  await page.goto("/");
  await page.evaluate(
    ([n, f]) => {
      sessionStorage.setItem("cf-mock-money", JSON.stringify({ scenario: n, country: "US", seen: [] }));
      for (const [k, v] of Object.entries(f)) sessionStorage.setItem(k, v);
    },
    [scenario, flags] as const,
  );
  await page.goto("/money");
  await settle(page);
}
const card = (page: Page) => page.locator(".cr-all");
const row = (page: Page, place: string) => page.locator(`.cr-all__row[data-place='${place}']`);
const knob = (page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([fn, args]) => (window as MockWin).__cfMock!.cr![fn as string]!(...(args as unknown[])), [fn, args] as const);

test.describe("All your money", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("first on the page, every place in order, one USD total that names what it adds, Monthly says it is apps only", async ({ page }) => {
    await open(page);
    await expect(card(page).locator(".cr-all__title")).toHaveText("All your money");
    await expect(card(page)).toContainText(/Every place · 30 days up to \w{3} \d{1,2} \w{3} · YouTube is 2–3 days behind/);
    await expect(page.locator(".cr-all__row")).toHaveCount(6);
    expect(await page.locator(".cr-all__row").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.place))).toEqual([
      "youtube",
      "tiktok",
      "instagram",
      "facebook",
      "x",
      "contentrewards",
    ]);
    // The card comes before the Apps chips and the Monthly card.
    const order = await page.evaluate(() => {
      const all = document.querySelector(".cr-all")!;
      const band = document.querySelector(".dash-band, .money-dock")!;
      const monthly = document.querySelector("[data-kpi='monthly']")!;
      return [all.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING, band.compareDocumentPosition(monthly) & Node.DOCUMENT_POSITION_FOLLOWING];
    });
    expect(order.every(Boolean)).toBe(true);
    await expect(row(page, "youtube")).toContainText("YouTube says");
    await expect(row(page, "youtube")).toContainText("YouTube's estimate");
    await expect(row(page, "tiktok")).toContainText("Not available from TikTok");
    await expect(row(page, "tiktok")).toContainText("Look in TikTok: Profile, then Balance.");
    await expect(row(page, "tiktok").locator(".cr-all__amount")).toHaveCount(0);
    await expect(row(page, "x").getByRole("link", { name: /Open X/ })).toHaveAttribute("href", "https://x.com/i/jf/creators/studio");
    await expect(row(page, "contentrewards")).toContainText("Content Rewards says");
    // §40.8 change 5: "Paid out to your bank" becomes the row's sent line, "Sent to your bank".
    await expect(row(page, "contentrewards")).toContainText("Sent to your bank: not available from Content Rewards. Look on Whop: Balances.");
    await expect(row(page, "contentrewards")).not.toContainText("Paid out to your bank");
    await expect(row(page, "contentrewards").getByRole("link", { name: "See it all" })).toHaveAttribute("href", "/money#content-rewards");
    const sum = page.locator(".cr-all__sum");
    await expect(sum).toHaveCount(1);
    await expect(sum).toContainText(/^Total: \$[\d,]+\.\d{2}/);
    await expect(sum).toContainText(/YouTube \+ (Facebook \+ )?Content Rewards · 30 days up to/);
    await expect(card(page)).toContainText("Not in the total: TikTok, Instagram and X (not available)");
    await expect(card(page).locator(".btn--primary, .btn--action")).toHaveCount(0);
    await expect(page.locator("[data-kpi='monthly']")).toContainText("Apps only. Content Rewards is in All your money.");
    // The total is the biggest number on the page; Monthly's is one size smaller.
    const sizes = await page.evaluate(() => ({
      total: parseFloat(getComputedStyle(document.querySelector(".cr-all__total-num")!).fontSize),
      monthly: parseFloat(getComputedStyle(document.querySelector("[data-kpi='monthly'] .dash-num")!).fontSize),
      biggest: Math.max(...[...document.querySelectorAll<HTMLElement>(".money-dash *")].filter((e) => /\$/.test(e.textContent ?? "") && e.children.length === 0).map((e) => parseFloat(getComputedStyle(e).fontSize))),
    }));
    expect(sizes.total).toBeGreaterThan(sizes.monthly);
    expect(sizes.total).toBe(sizes.biggest);
    // Content Rewards' own part stays at the end of the page.
    await expect(page.locator("#content-rewards")).toBeAttached();
  });

  test("two currencies: one total each, never added; YouTube needs your OK; nothing to add up yet", async ({ page }) => {
    await open(page, "dash_two_currencies");
    await expect(page.locator(".cr-all__sum")).toHaveCount(2);
    await expect(card(page)).toContainText("Different money, like dollars and euros, is never added together.");
    await expect(page.locator(".cr-all__sum").nth(1)).toContainText("€");
    await open(page, "start");
    await expect(row(page, "youtube")).toContainText("YouTube needs your OK");
    await expect(row(page, "youtube").getByRole("link", { name: "Allow money reading" })).toHaveAttribute("href", "/settings/posting/money#money-youtube");
    await knob(page, "reset", "fresh");
    await page.reload();
    await settle(page);
    await expect(row(page, "contentrewards")).toContainText("Not set up yet");
    await expect(row(page, "contentrewards").getByRole("link", { name: "Set up Content Rewards" })).toHaveAttribute("href", "/settings/posting/setup/contentrewards?back=/money");
    await expect(row(page, "contentrewards")).not.toContainText("Earned so far");
    await expect(card(page)).toContainText("Nothing to add up yet.");
    await expect(page.locator(".cr-all__sum")).toHaveCount(0);
    await expect(card(page)).not.toContainText("$0");
  });

  test("§40.4: each row's sent line, and Sent to your bank, so far: per currency, never in the 30-day total", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => !!(window as Window & { __cfMock?: { getpaid?: unknown } }).__cfMock?.getpaid);
    await page.evaluate(() => (window as unknown as { __cfMock: { getpaid: { scenario(n: string): void } } }).__cfMock.getpaid.scenario("owner"));
    await open(page);
    const sent = (place: string) => row(page, place).locator(".cr-all__sent");
    await expect(sent("youtube")).toHaveText(/^Sent to your bank by Google: SEK\s2,468\.00 so far · YouTube says$/);
    await expect(sent("tiktok")).toHaveText("Sent to your bank: Not available from TikTok. Look in TikTok: Profile, then Balance, then Transactions, then Withdrawal.");
    await expect(sent("instagram")).toHaveText("Sent to your bank: Not available from Instagram. Look in Instagram: Professional dashboard, then Payouts. Meta also emails you each month.");
    await expect(sent("facebook")).toHaveText("Sent to your bank: Not available from Meta. Look in Meta Business Suite: All tools, then Payouts. Meta also emails you each month.");
    // Its Open Stripe is on X's Get paid page (a row keeps one button, at its right end).
    await expect(sent("x")).toHaveText("Sent to your bank: Not available from X. Look in Stripe: Payouts. More in Get paid below.");
    await expect(sent("contentrewards")).toHaveText("Sent to your bank: not available from Content Rewards. Look on Whop: Balances.");
    for (const p of ["tiktok", "instagram", "facebook", "x"]) await expect(sent(p)).not.toContainText("$0");
    const block = page.locator(".cr-all__sentsofar");
    await expect(block.locator("h3")).toHaveText("Sent to your bank, so far");
    await expect(block.locator("li")).toHaveCount(1);
    await expect(block.locator("li")).toHaveText(/^SEK\s2,468\.00 · YouTube$/);
    await expect(block).toContainText("Google and Whop say they sent it.");
    await expect(block).toContainText("Different money, like dollars and kronor, is never added together.");
    await expect(block).toContainText("Not in this: TikTok, Instagram, Facebook and X (not available).");
    await expect(block).toContainText("Clip Factory can't see your bank. Look in your bank's app to see what arrived.");
    await expect(block).not.toContainText("Nothing sent to your bank yet.");
    // It comes after the 30-day total and is never added to it.
    expect(await page.evaluate(() => document.querySelector(".cr-all__total")!.compareDocumentPosition(document.querySelector(".cr-all__sentsofar")!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
    await expect(page.locator(".cr-all__sum")).not.toContainText("SEK");
    await expect(card(page).locator(".btn--primary")).toHaveCount(0);
  });

  test("§40.4: nothing sent yet says so, with no total", async ({ page }) => {
    await open(page);
    const block = page.locator(".cr-all__sentsofar");
    await expect(block).toContainText("Nothing sent to your bank yet.");
    await expect(block.locator("li")).toHaveCount(0);
    // Allow payment reading is on YouTube's Get paid page, right below; the row's own button stays Allow money reading.
    await expect(row(page, "youtube").locator(".cr-all__sent")).toHaveText("Sent to your bank: Clip Factory can't see YouTube payments yet. More in Get paid below.");
  });

  test("Content Rewards signed out: Sign in again, its own button and no See it all", async ({ page }) => {
    await open(page);
    await knob(page, "signOut");
    await expect(row(page, "contentrewards")).toContainText("Sign in again");
    await expect(row(page, "contentrewards").getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/settings/posting/setup/contentrewards?back=/money");
    await expect(row(page, "contentrewards").getByRole("link", { name: "See it all" })).toHaveCount(0);
  });

  test("an API from before §39: the card isn't there and Monthly keeps its words", async ({ page }) => {
    await open(page, "dash_many", { "cf-mock-money-everywhere": "404" });
    await expect(page.locator("[data-kpi='monthly']")).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    await expect(page.locator("[data-kpi='monthly']")).not.toContainText("Apps only.");
  });
});

async function ctxFor(browser: Browser, w: number, h: number, touch: boolean, scheme: "light" | "dark") {
  return browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch && w < 768, reducedMotion: "reduce", colorScheme: scheme });
}

for (const [w, h, touch] of [
  [320, 568, true],
  [375, 812, true],
  [768, 1024, true],
  [1024, 768, false],
  [1440, 900, false],
  [1920, 1080, false],
] as const)
  test(`All your money fits, no edges, big targets, the arrow cursor, AA contrast: ${w}x${h}${touch ? " touch" : ""}`, async ({ browser }) => {
    test.setTimeout(120_000);
    for (const scheme of ["light", "dark"] as const) {
      const ctx = await ctxFor(browser, w, h, touch, scheme);
      const page = await ctx.newPage();
      await open(page);
      const o = await findOverflow(page);
      expect(o.page, `${scheme}: sideways scroll ${JSON.stringify(o.items.slice(0, 3))}`).toBeLessThanOrEqual(o.viewport);
      expect((await visibleEdges(page)).filter((e) => /cr-all/.test(e)), scheme).toEqual([]);
      const axe = await new AxeBuilder({ page }).include(".cr-all").withRules(["color-contrast"]).analyze();
      expect(axe.violations.flatMap((v) => v.nodes.map((n) => n.target.join(" "))), scheme).toEqual([]);
      const bad = await page.evaluate((min) => {
        const out: string[] = [];
        for (const e of document.querySelectorAll<HTMLElement>(".cr-all a, .cr-all button")) {
          const r = e.getBoundingClientRect();
          if (!r.width) continue;
          if (r.height < min - 0.5) out.push(`"${e.textContent?.trim()}" ${Math.round(r.height)} px`);
          if (getComputedStyle(e).cursor !== "default" && getComputedStyle(e).cursor !== "auto") out.push(`"${e.textContent?.trim()}" cursor`);
          // At most one glass button at a row's right end (never at the left: the thumb is at the right).
          if (r.left + r.width / 2 < innerWidth / 2 && innerWidth < 768) out.push(`"${e.textContent?.trim()}" sits at the left`);
        }
        for (const r of document.querySelectorAll(".cr-all__row")) if (r.querySelectorAll(".btn").length > 1) out.push(`${(r as HTMLElement).dataset.place} has two buttons`);
        return out;
      }, touch && w < 768 ? 48 : 44);
      expect(bad, scheme).toEqual([]);
      // Reduced motion: the total is there at once, never counting up.
      await expect(page.locator(".cr-all__total-num").first()).toHaveText(/^\$[\d,]+\.\d{2}$/);
      await ctx.close();
    }
  });
