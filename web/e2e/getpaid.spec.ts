import { readFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { visibleEdges } from "./edges.ts";
import { tap } from "./flows.ts";
import { findOverflow, launcherSettled, settle, stillBackdrop } from "./helpers.ts";

// Get paid (docs/CONTRACTS.md §40, §40.8 tests), in mock mode: Clip Factory's own taps per place equal §40.1's CF
// counts (YouTube 15, TikTok 4, Instagram 4, Facebook 4 and 2 after Instagram, X 5, Content Rewards 5 or 3 with
// Finance, Connect Whop 6), the ways in (4 from Settings, 2 from Money), Allow payment reading's result sentences,
// Connect Whop on and off with the Whop key; and every new screen: no sideways scroll at 320–1920, no edges, targets
// of 44 px (48 on phones), the arrow cursor only, AA contrast light and dark, reduced motion, the phone's main button
// at the bottom right, and Ask never over it.

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const PHONE = { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, userAgent: IPHONE } as const;
const DESKTOP = { viewport: { width: 1440, height: 900 } } as const;
const PLACES = ["youtube", "tiktok", "instagram", "facebook", "x", "contentrewards"] as const;
const PAGES = ["/settings/posting/getpaid", ...PLACES.map((p) => `/settings/posting/getpaid/${p}`)];

type Knobs = Record<string, (...a: unknown[]) => unknown>;
type MockWin = Window & { __cfMock?: { getpaid?: Knobs; setup?: Knobs; cr?: Knobs } };

/** The pretend owner's start: a Get paid scenario, setups finished, and more knobs, then the page. */
const watched = new WeakSet<object>();
async function start(page: Page, path: string, scenario = "fresh", finish: string[] = [], knobs: [string, unknown[]][] = []) {
  // The platforms' own pages never load here: they open in a new tab, which closes at once (axe's own blank page, with
  // no opener, stays). The blocked load leaves the tab on about:blank, so waiting for an https address never closed it:
  // a YouTube walk left 8 tabs open behind the page.
  const ctx = page.context();
  if (!watched.has(ctx)) {
    watched.add(ctx);
    await ctx.route(/^https:\/\/(?!localhost)/, (r) => r.abort());
    ctx.on("page", (p) => {
      if (p === page) return;
      void p
        .opener()
        .then((o) => (o ? p.close() : undefined))
        .catch(() => undefined);
    });
  }
  await page.goto("/");
  await page.waitForFunction(() => !!(window as MockWin).__cfMock?.getpaid && !!(window as MockWin).__cfMock?.setup);
  await page.evaluate(
    ([s, f, k]) => {
      const m = (window as MockWin).__cfMock!;
      m.getpaid!.scenario!(s);
      for (const p of f) m.setup!.finish!(p);
      for (const [fn, args] of k) m.getpaid![fn]!(...args);
    },
    [scenario, finish, knobs] as const,
  );
  await page.goto(path);
  await settle(page);
}
const knob = (page: Page, fn: string, ...args: unknown[]) => page.evaluate(([fn, args]) => (window as MockWin).__cfMock!.getpaid![fn as string]!(...(args as unknown[])), [fn, args] as const);
/** The screen's one vermilion button (each screen has at most one). */
const tomato = (page: Page) => page.locator("main .btn--primary").filter({ visible: true });
const step = (page: Page, id: string) => page.locator(`#step-${id}`);
const answer = (page: Page, id: string, name: string | RegExp) => step(page, id).getByRole("button", { name });
/** Live news reaches the page a second later (debounced). */
const live = (page: Page) => page.waitForTimeout(1400);

/** Every new screen's checks. On Money, only Get paid's parts are new (the card, and All your money's sent lines). */
async function screenProblems(page: Page, phone: boolean, scope = "main"): Promise<string[]> {
  const out: string[] = [];
  const o = await findOverflow(page);
  if (o.page > o.viewport) out.push(`sideways scroll ${o.page} > ${o.viewport}: ${JSON.stringify(o.items.slice(0, 3))}`);
  const bad = await page.evaluate(([min, scope]) => {
    const found: string[] = [];
    const sel = scope
      .split(",")
      .map((r) => ["button", "a.btn", "summary", "a.setup-card", ".segmented__opt"].map((c) => `${r.trim()} ${c}`).join(", "))
      .join(", ");
    for (const e of document.querySelectorAll<HTMLElement>(sel)) {
      const b = e.getBoundingClientRect();
      if (!b.width || !b.height || getComputedStyle(e).display === "inline") continue;
      const name = (e.getAttribute("aria-label") || e.textContent || e.tagName).trim().slice(0, 40);
      if (b.height < min - 0.5) found.push(`"${name}" is ${Math.round(b.width)}x${Math.round(b.height)}`);
      const cur = getComputedStyle(e).cursor;
      if (cur !== "auto" && cur !== "default") found.push(`"${name}" has cursor ${cur}`);
    }
    const redFill = (e: HTMLElement) => {
      const cs = getComputedStyle(e);
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(`${cs.backgroundImage} ${cs.backgroundColor}`);
      return !!m && Number(m[1]) > 150 && Number(m[2]) < 90 && Number(m[3]) < 80;
    };
    // The screen's own buttons (the floating setup list's are glass on Get paid pages, and §17.13's own elsewhere).
    const red = [...document.querySelectorAll<HTMLElement>("main .btn")].filter((e) => e.getBoundingClientRect().height > 0 && redFill(e));
    if (red.length > 1) found.push(`${red.length} vermilion buttons: ${red.map((e) => e.textContent?.trim()).join(" | ")}`);
    return found;
  }, [phone ? 48 : 44, scope] as const);
  out.push(...bad);
  out.push(...(await visibleEdges(page)).filter((e) => /gp-|gstep|setup-card|cr-all|getpaid/.test(e)));
  return out;
}

// ---------- the ways in ----------

for (const [name, use] of [
  ["phone", PHONE],
  ["desktop", DESKTOP],
] as const) {
  const phone = name === "phone";
  test.describe(`${name}`, () => {
    test.use(use);
    // WebKit on Linux paints without a GPU: hold the living backdrop still so frames stay cheap (helpers.ts,
    // stillBackdrop). Every tap waits for frames, and YouTube's 15 crawled past 120 s on the CI runner's iPhone.
    test.beforeEach(async ({ page, browserName }) => {
      if (browserName === "webkit") await stillBackdrop(page);
    });

    test("the ways in: 4 taps from Settings, 2 from Money, 1 from a setup page", async ({ page }) => {
      await start(page, "/", "owner");
      const t = tap(4);
      await t.tap(page.getByRole("link", { name: "Settings", exact: true }).filter({ visible: true }).first());
      await settle(page);
      const content = page.locator(".settings-content");
      await t.tap(content.getByRole("link", { name: /^Posting/ }));
      await settle(page);
      await t.tap(content.getByRole("link", { name: /^Get paid/ }));
      await settle(page);
      await expect(page).toHaveURL(/\/settings\/posting\/getpaid$/);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Get paid");
      await t.tap(page.locator("a.gp-card[data-place='youtube']"));
      await expect(page).toHaveURL(/\/settings\/posting\/getpaid\/youtube$/);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Get paid by YouTube");
      expect(t.count).toBe(4);

      const m = tap(2);
      await m.tap(page.getByRole("link", { name: "Money", exact: true }).filter({ visible: true }).first());
      await settle(page);
      const row = page.locator(".gp-money__row[data-place='instagram']");
      await m.tap(row.getByRole("link"));
      await expect(page).toHaveURL(/\/settings\/posting\/getpaid\/instagram\?back=\/money$/);
      await settle(page);
      await expect(page.locator("[data-gp='back']")).toHaveText("Back to Money");
      expect(m.count).toBe(2);

      // A platform's setup page: its glass Get paid link, 1 tap, with the way back.
      await page.goto("/settings/posting/setup/youtube");
      await settle(page);
      const link = page.locator("[data-setup='getpaid']");
      await expect(link).toHaveAttribute("href", "/settings/posting/getpaid/youtube?back=/settings/posting/setup/youtube");
      await expect(link).not.toHaveClass(/btn--primary/);
      await link.click();
      await settle(page);
      await expect(page.locator("[data-gp='back']")).toHaveText("Back to YouTube setup");
      // Content Rewards' existing Get paid link goes to its Get paid page.
      await page.goto("/settings/posting/setup/contentrewards");
      await settle(page);
      await expect(page.locator("[data-cr='getpaid']")).toHaveAttribute("href", "/settings/posting/getpaid/contentrewards");
    });

    test("YouTube: Clip Factory's taps are 15 (Partner Program, the reading step, five payout steps)", async ({ page, browserName }) => {
      test.setTimeout(120_000);
      // The longest walk in this file, 15 taps and a trip to Google and back in one test (the count spans all of it):
      // 1.2 min on CI's WebKit iPhone with the backdrop still, and a slow runner there takes half as long again.
      test.slow(browserName === "webkit", "the 15-tap walk paints in software in CI");
      await start(page, "/settings/posting/getpaid/youtube", "fresh", ["youtube"]);
      const t = tap(15);
      await expect(tomato(page)).toHaveCount(1);
      await expect(tomato(page)).toHaveText(/Open YouTube Studio/);
      if (phone) await expect(tomato(page).locator("xpath=ancestor::*[contains(@class,'gp-pin')]")).toHaveCount(1);
      await t.tap(tomato(page));
      // YouTube says he is in: step 1 ticks itself, and says who said so.
      await knob(page, "youtube", "in_program");
      await live(page);
      await expect(step(page, "yt-join").locator(".gp-step__who")).toHaveText("YouTube says you're in");
      // The optional reading step: 4 of Clip Factory's taps; it comes back by itself.
      const reading = step(page, "yt-reading");
      await expect(reading.locator(".gstep__num")).toHaveText("Optional");
      await t.tap(reading.getByRole("link", { name: /Turn on AdSense reading/ }));
      await t.tap(reading.getByRole("link", { name: /Open Google's permissions page/ }));
      await t.tap(reading.getByRole("button", { name: "Copy Permission" }));
      const back = page.waitForEvent("load");
      await t.tap(reading.getByRole("button", { name: "Allow payment reading" }));
      await back;
      await settle(page);
      await expect(page.locator("[data-result='payments_allowed']")).toHaveText("Clip Factory can see your YouTube payments now. It checks once a day.");
      await expect(step(page, "yt-reading")).toHaveAttribute("data-done", "true");
      // Steps 2 to 6: Open and I did this each, in time order.
      for (const id of ["yt-tax", "yt-bank", "yt-test", "yt-id", "yt-pin"]) {
        await expect(tomato(page)).toHaveCount(1);
        await expect(tomato(page)).toHaveText(/Open AdSense for YouTube/);
        await t.tap(tomato(page));
        await t.tap(answer(page, id, "I did this"));
        await expect(step(page, id).locator(".gp-step__who")).toHaveText("You said it's done");
      }
      expect(t.count).toBe(15);
      await expect(page.locator(".gp-head [role='progressbar']")).toHaveAttribute("aria-label", "YouTube: 6 of 6 steps done");
      await expect(page.locator("[data-help='getpaid-status'] .gp-pill")).toHaveText("Checking…");
      await expect(page.locator("main")).not.toContainText(/\bLive\b/);
    });

    test("Facebook: 4 taps, then 2 after Instagram (one Meta tick); X: 5 taps, Premium never the vermilion", async ({ page }) => {
      await start(page, "/settings/posting/getpaid/facebook");
      let t = tap(4);
      await t.tap(tomato(page));
      await t.tap(answer(page, "fb-join", "I joined"));
      await expect(tomato(page)).toHaveText(/Open Meta Business Suite/);
      await t.tap(tomato(page));
      await t.tap(answer(page, "meta-payout", "I did this"));
      expect(t.count).toBe(4);
      await expect(page.locator("[data-help='getpaid-status'] .gp-pill")).toHaveText("Can get paid (you said it's done)");
      // After Instagram: the Meta payout step is already done.
      await knob(page, "reset");
      await page.goto("/settings/posting/getpaid/instagram");
      await settle(page);
      await answer(page, "ig-gifts", "I turned it on").click();
      await answer(page, "meta-payout", "I did this").click();
      await expect(step(page, "meta-payout")).toHaveAttribute("data-done", "true");
      await page.waitForFunction(() => ((window as MockWin).__cfMock!.getpaid!.state!() as { ticks: string[] }).ticks.includes("meta-payout"));
      await page.goto("/settings/posting/getpaid/facebook");
      await settle(page);
      await expect(step(page, "meta-payout")).toHaveAttribute("data-done", "true");
      t = tap(2);
      await t.tap(tomato(page));
      await t.tap(answer(page, "fb-join", "I joined"));
      expect(t.count).toBe(2);

      await page.goto("/settings/posting/getpaid/x");
      await settle(page);
      await expect(page.locator("[data-help='getpaid-status']")).toContainText("Your Clip Factory clips probably won't earn on X.");
      await expect(tomato(page)).toHaveCount(0);
      t = tap(5);
      await t.tap(step(page, "x-premium").getByRole("link", { name: /Open X/ }));
      await knob(page, "followers", { xPremium: true });
      await live(page);
      await expect(step(page, "x-premium").locator(".gp-step__who")).toHaveText("X says you have Premium");
      await t.tap(tomato(page));
      await t.tap(answer(page, "x-apply", "X said yes"));
      await t.tap(tomato(page));
      await t.tap(answer(page, "x-stripe", "I did this"));
      expect(t.count).toBe(5);
    });

    test(`TikTok and Instagram: ${phone ? "4 taps each, the Opens open the apps" : "2 taps each, no Open on a computer"}`, async ({ page }) => {
      for (const [place, one, two] of [
        ["tiktok", "tt-gifts", "tt-payout"],
        ["instagram", "ig-gifts", "meta-payout"],
      ] as const) {
        await start(page, `/settings/posting/getpaid/${place}`);
        const t = tap(phone ? 4 : 2);
        if (phone) {
          await expect(tomato(page)).toHaveAttribute("href", place === "tiktok" ? "https://www.tiktok.com/" : "https://www.instagram.com/");
          await t.tap(tomato(page));
        } else {
          await expect(step(page, one)).toContainText(`Do this in the ${place === "tiktok" ? "TikTok" : "Instagram"} app on your phone.`);
          await expect(step(page, one).locator("a[href^='https://']")).toHaveCount(0);
          await expect(tomato(page)).toHaveCount(0);
        }
        await t.tap(answer(page, one, "I turned it on"));
        if (phone) await t.tap(tomato(page));
        await t.tap(answer(page, two, "I did this"));
        expect(t.count).toBe(phone ? 4 : 2);
      }
    });

    test("Content Rewards: 5 taps without Finance, 3 with it; §38.7's words and ticks", async ({ page }) => {
      await start(page, "/settings/posting/getpaid/contentrewards");
      await expect(page.locator("#cr-finance")).toContainText("Do you see Finance in the Content Rewards menu?");
      let t = tap(5);
      await t.tap(page.locator("#cr-finance").getByRole("radio", { name: "No" }));
      await expect(step(page, "move-whop")).toBeVisible();
      await expect(tomato(page)).toHaveText(/Open Content Rewards settings/);
      await t.tap(tomato(page));
      await t.tap(answer(page, "move-whop", "I did this"));
      await expect(tomato(page)).toHaveText(/Open Whop/);
      await t.tap(tomato(page));
      await t.tap(answer(page, "bank-setup", "I did this"));
      expect(t.count).toBe(5);
      // The two new hints on Add your bank on Whop.
      await step(page, "bank-setup").locator(".gstep__head").click();
      await expect(step(page, "bank-setup")).toContainText("If you see Set up Whop Payments: Tap it. Pick Sweden.");
      await expect(step(page, "bank-setup")).toContainText("Don't type your personal number.");
      // With Finance: 3.
      await page.locator("#cr-finance").getByRole("button", { name: "Change my answer" }).click();
      await page.waitForTimeout(400);
      t = tap(3);
      await t.tap(page.locator("#cr-finance").getByRole("radio", { name: "Yes" }));
      await expect(tomato(page)).toHaveText(/Open Content Rewards/);
      await t.tap(tomato(page));
      await t.tap(answer(page, "fin-setup", "I did this"));
      expect(t.count).toBe(3);
    });

    test("Connect Whop: Coming soon while off; on, 7 taps with the Whop key (the how-to is one fold)", async ({ page }) => {
      await start(page, "/settings/posting/getpaid/contentrewards");
      const card = page.locator("[data-help='getpaid-whop']");
      await expect(card).toContainText("Coming soon: your Whop payouts here.");
      await expect(card.locator("button, a")).toHaveCount(0);
      await knob(page, "whop", true);
      await page.reload();
      await settle(page);
      await expect(card.locator(".btn--primary")).toHaveCount(0);
      const t = tap(7);
      await t.tap(card.locator("summary", { hasText: "How do I make it?" }));
      await t.tap(card.getByRole("link", { name: /Open Whop's developer page/ }));
      await t.tap(card.getByRole("button", { name: "Copy App name" }));
      await t.tap(card.getByRole("button", { name: "Copy Redirect URI" }));
      const box = card.getByLabel("Whop key");
      await t.tap(box);
      await box.fill("nope");
      await card.getByRole("button", { name: "Save key" }).click();
      await expect(card.locator("#whop-key-bad")).toHaveText("Your Whop key starts with app_.");
      await box.fill("app_AbCdEf123456");
      await t.tap(card.getByRole("button", { name: "Save key" }));
      await expect(card).toContainText("Your Whop key is saved: app_Ab…3456");
      const back = page.waitForEvent("load");
      await t.tap(card.getByRole("button", { name: "Connect Whop" }));
      await back;
      await expect(page).toHaveURL(/\/settings\/posting\/getpaid\/contentrewards#whop$/);
      await settle(page);
      await expect(card.locator(".gp-result")).toHaveText("Clip Factory can see your Whop payouts now (@faze).");
      expect(t.count).toBe(7);
      await expect(card.getByRole("button", { name: "Stop reading Whop" })).toBeVisible();
    });

    test("Allow payment reading's results say their sentences, word for word", async ({ page }) => {
      const want: Record<string, string> = {
        payments_denied: "You didn't allow it. Tap Allow payment reading to try again.",
        payments_missing: "Tick View your AdSense data on Google's page. Then tap Allow payment reading again.",
        payments_no_account:
          "That Google account has no AdSense for YouTube. Tap Allow payment reading again and pick the Google account that has it. Still no luck? Skip this step. Your ticks still work.",
        payments_api_off: "Tap Turn on AdSense reading, then Enable. Then tap Allow payment reading again.",
        payments_error: "Something went wrong. Tap Allow payment reading again.",
      };
      await start(page, "/settings/posting/getpaid/youtube", "fresh", ["youtube"], [["youtube", ["in_program"]]]);
      for (const [code, sentence] of Object.entries(want)) {
        await knob(page, "nextResult", code);
        const back = page.waitForEvent("load");
        await step(page, "yt-reading").getByRole("button", { name: "Allow payment reading" }).click();
        await back;
        await settle(page);
        await expect(page.locator(`[data-result='${code}']`)).toHaveText(sentence);
      }
      // Without saved YouTube keys: 409 and a glass Set up YouTube with the way back.
      await page.evaluate(() => (window as MockWin).__cfMock!.setup!.reset!());
      await page.reload();
      await settle(page);
      await step(page, "yt-reading").getByRole("button", { name: "Allow payment reading" }).click();
      await expect(step(page, "yt-reading").getByRole("link", { name: "Set up YouTube" })).toHaveAttribute("href", "/settings/posting/setup/youtube?back=/settings/posting/getpaid/youtube");
    });

    test("the list, the place pages and Money's card: no sideways scroll, no edges, big targets, arrow cursor, one vermilion at most", async ({ page }) => {
      test.setTimeout(120_000);
      const fails: string[] = [];
      for (const scenario of ["fresh", "owner"]) {
        await start(page, "/", scenario, [], [["whop", [true]]]);
        for (const path of [...PAGES, "/money"]) {
          await page.goto(path);
          await settle(page);
          fails.push(...(await screenProblems(page, phone, path === "/money" ? ".gp-money, .cr-all__sentsofar" : "main")).map((f) => `${scenario} ${path}: ${f}`));
        }
      }
      expect(fails, fails.join("\n")).toEqual([]);
    });

    test("never Live on a Get paid screen: the app's realtime chip steps aside there, and only there", async ({ page }) => {
      await start(page, "/settings/posting/setup", "owner");
      // Outside Get paid the chip still shows while the live connection is up.
      await expect(page.locator(".live-dot").filter({ visible: true }).first()).toBeVisible({ timeout: 10_000 });
      for (const path of ["/settings/posting/getpaid", "/settings/posting/getpaid/youtube", "/settings/posting/getpaid/contentrewards"]) {
        await page.goto(path);
        await settle(page);
        await expect(page.locator(".live-dot").filter({ visible: true }), path).toHaveCount(0);
        await expect(page.locator("body"), path).not.toContainText(/\bLive\b/, { useInnerText: true });
      }
    });

    if (!phone)
      test("computer, first visit: the first step not done is brought into view, so the one vermilion is on screen", async ({ page }) => {
        // The step comes into view with a smooth scroll 160 ms after its card arrives. On the CI runner, which paints
        // without a GPU, the living backdrop made that scroll start late (the vermilion still at 1391 of 900 after a
        // fixed 900 ms), so the backdrop holds still and the check waits for the scroll to arrive. A step that is
        // never brought into view still fails.
        await stillBackdrop(page);
        for (const [place, finish] of [
          ["youtube", ["youtube"]],
          ["facebook", ["facebook"]],
        ] as const) {
          await start(page, `/settings/posting/getpaid/${place}`, "fresh", [...finish]);
          await expect
            .poll(
              async () => {
                const box = await tomato(page).boundingBox();
                return !!box && box.y >= 0 && box.y + box.height <= 900;
              },
              { message: `${place}: brought into view`, timeout: 10_000 },
            )
            .toBe(true);
          const b = await tomato(page).boundingBox();
          expect(b, `${place}: one vermilion`).not.toBeNull();
          expect(b!.y, `${place}: on screen`).toBeGreaterThanOrEqual(0);
          expect(b!.y + b!.height, `${place}: on screen`).toBeLessThanOrEqual(900);
          await expect(tomato(page)).toHaveCount(1);
        }
      });

    if (phone)
      test("phone: the next step's main button sits at the bottom right from page open, and Ask is never over it", async ({ page }) => {
        await start(page, "/settings/posting/getpaid/youtube", "fresh", ["youtube"], [["youtube", ["in_program"]]]);
        await launcherSettled(page);
        const geo = await page.evaluate(() => {
          const b = document.querySelector<HTMLElement>("main .btn--primary")!.getBoundingClientRect();
          const ask = document.querySelector<HTMLElement>(".help-launcher");
          const a = ask && !ask.classList.contains("is-hidden") && getComputedStyle(ask).opacity !== "0" ? ask.getBoundingClientRect() : null;
          return { vw: innerWidth, vh: innerHeight, b: { left: b.left, right: b.right, top: b.top, bottom: b.bottom }, a: a && { left: a.left, right: a.right, top: a.top, bottom: a.bottom } };
        });
        expect(geo.b.bottom).toBeLessThanOrEqual(geo.vh);
        expect(geo.b.top + (geo.b.bottom - geo.b.top) / 2, "in the bottom 40%").toBeGreaterThanOrEqual(0.6 * geo.vh);
        expect(geo.vw - geo.b.right, "at the right").toBeLessThanOrEqual(32);
        if (geo.a) expect(geo.a.bottom <= geo.b.top || geo.a.top >= geo.b.bottom || geo.a.right <= geo.b.left || geo.a.left >= geo.b.right, "Ask over the main button").toBe(true);
        // It stays there while the page scrolls.
        await page.evaluate(() => window.scrollTo(0, 600));
        await page.waitForTimeout(300);
        const after = await tomato(page).boundingBox();
        expect(after!.y + after!.height).toBeLessThanOrEqual(812);
        expect(after!.y).toBeGreaterThanOrEqual(0.5 * 812);
        // Focus and scrolls stop above the pin's lane (WCAG 2.4.11): a step brought into view from above lands clear of
        // the pinned button, so it is never under the pin or the tab bar.
        const brought = await page.evaluate(() => {
          window.scrollTo({ top: 0, behavior: "instant" });
          const head = document.querySelector<HTMLElement>("#step-yt-pin .gstep__head")!;
          head.scrollIntoView({ block: "nearest", behavior: "instant" });
          return { y: scrollY, head: head.getBoundingClientRect().bottom, pin: document.querySelector<HTMLElement>("main .btn--primary")!.getBoundingClientRect().top };
        });
        expect(brought.y, "step 6 was below the screen").toBeGreaterThan(0);
        expect(brought.head, "brought into view above the pinned button").toBeLessThanOrEqual(brought.pin);
      });
  });
}

// ---------- AA contrast, light and dark; reduced motion ----------

async function ctxFor(browser: Browser, w: number, h: number, touch: boolean, scheme: "light" | "dark") {
  return browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch, userAgent: touch ? IPHONE : undefined, reducedMotion: "reduce", colorScheme: scheme });
}

// One test per scheme and scenario (and per width and scenario below), so the workers share them: all of them in one
// test ran past its timeout in Linux WebKit, where a 1440 or 1920 px page paints in software. Desktop sizes get
// Playwright's slow allowance there too.
for (const [w, h, touch] of [
  [375, 812, true],
  [1440, 900, false],
] as const)
  for (const scheme of ["light", "dark"] as const)
    for (const scenario of ["owner", "hold"])
      test(`axe AA contrast, ${scheme}, ${scenario}: ${touch ? "phone" : "desktop"} ${w}x${h}`, async ({ browser, browserName }) => {
        test.setTimeout(120_000);
        test.slow(browserName === "webkit" && !touch, "large WebKit pages paint in software in CI");
        const fails: string[] = [];
        const ctx = await ctxFor(browser, w, h, touch, scheme);
        const page = await ctx.newPage();
        await start(page, "/", scenario, [], [["whop", [true]]]);
        for (const path of [...PAGES, "/money"]) {
          await page.goto(path);
          await settle(page);
          const axe = await new AxeBuilder({ page }).withRules(["color-contrast"]).include("main").analyze();
          fails.push(...axe.violations.flatMap((v) => v.nodes.map((n) => `${scheme} ${scenario} ${path}: ${n.target.join(" ")}: ${n.any.map((c) => c.message).join("; ")}`)));
        }
        await ctx.close();
        expect(fails, fails.join("\n")).toEqual([]);
      });

for (const w of [320, 390, 768, 1024, 1920] as const)
  for (const scenario of ["owner", "hold", "unread"])
    test(`no sideways scroll at ${w} px on every Get paid screen (${scenario})${w >= 1024 ? " desktop" : ""}`, async ({ browser, browserName }) => {
      test.setTimeout(120_000);
      test.slow(browserName === "webkit" && w >= 768, "large WebKit pages paint in software in CI");
      const touch = w < 768;
      const ctx = await ctxFor(browser, w, touch ? 700 : 900, touch, "light");
      const page = await ctx.newPage();
      const fails: string[] = [];
      await start(page, "/", scenario, [], [["whop", [true]]]);
      for (const path of [...PAGES, "/money"]) {
        await page.goto(path);
        await settle(page);
        const o = await findOverflow(page);
        if (o.page > o.viewport) fails.push(`${scenario} ${path}: ${o.page} > ${o.viewport} ${JSON.stringify(o.items.slice(0, 3))}`);
      }
      await ctx.close();
      expect(fails, fails.join("\n")).toEqual([]);
    });

test("reduced motion: nothing on a Get paid page keeps moving", async ({ browser }) => {
  const ctx = await ctxFor(browser, 375, 812, true, "light");
  const page = await ctx.newPage();
  await start(page, "/settings/posting/getpaid/youtube", "fresh", ["youtube"], [["youtube", ["in_program"]]]);
  const running = await page.evaluate(
    () =>
      document
        .getAnimations()
        .filter((a) => a.playState === "running")
        .map((a) => (a.effect as KeyframeEffect | null)?.target)
        .filter((t): t is Element => !!t && !!(t as Element).closest?.("main .gp-page, main .gp-list"))
        .map((t) => t.className).length,
  );
  expect(running).toBe(0);
  await ctx.close();
});

// The server's link to the Finance question (getpaid/status.py's FINANCE, as its golden cases have it) lands on the
// page's own question on a phone: arriving on it, and each tap on "Answer: do you see Finance?", bring it into view.
const GOLDEN = join(import.meta.dirname, "..", "..", "api", "tests", "fixtures", "getpaid_status_cases.json");
test("the server's Finance link brings the question into view at 390x844", async ({ browser }) => {
  const cards = (JSON.parse(readFileSync(GOLDEN, "utf8")) as { cards: { expect: { next: { label: string; href: string } | null } }[] }).cards;
  const href = cards.map((c) => c.expect.next).find((n) => n?.label === "Answer: do you see Finance?")!.href;
  expect(href.split("#")[0]).toBe("/settings/posting/getpaid/contentrewards");
  const ctx = await ctxFor(browser, 390, 844, true, "light");
  const page = await ctx.newPage();
  const question = page.getByRole("radiogroup", { name: "Do you see Finance in the Content Rewards menu?" });
  const top = () => page.evaluate(() => window.scrollTo(0, 0));
  await start(page, href);
  await expect(question).toBeInViewport({ ratio: 1 });
  // The button the server sends (the pretend app sends the same): each tap, from the top of the page where the
  // question is off screen, and the address left as it is.
  await page.goto("/settings/posting/getpaid/contentrewards");
  await settle(page);
  const button = page.getByRole("button", { name: "Answer: do you see Finance?" });
  for (let i = 0; i < 2; i++) {
    await top();
    await expect(question).not.toBeInViewport();
    await button.click();
    await expect(question).toBeInViewport({ ratio: 1 });
  }
  expect(new URL(page.url()).hash).toBe("");
  await ctx.close();
});

// Kid-proof (an 8-year-old must never get stuck): a button to a step on the same page goes there on every tap and keeps
// the way back; an answered Finance question keeps the keyboard's focus.
test.describe("kid-proof Get paid", () => {
  test.use(DESKTOP);

  test("Sent to your bank's Allow payment reading: every tap goes to the step, and ?back= stays", async ({ page }) => {
    await start(page, "/settings/posting/getpaid/youtube?back=/money", "fresh", ["youtube"]);
    const sent = page.locator("[data-help='getpaid-sent']");
    const go = sent.getByRole("button", { name: "Allow payment reading" });
    await go.click();
    await expect(page).toHaveURL(/\/settings\/posting\/getpaid\/youtube\?back=\/money#yt-reading$/);
    await expect(step(page, "yt-reading")).toBeInViewport();
    // The open step is taller than the screen: its head, where the focus goes, is all in sight (never its middle in the
    // middle with the head above the screen).
    const head = step(page, "yt-reading").locator(".gstep__head");
    await expect(head).toBeFocused();
    await expect(head).toBeInViewport({ ratio: 1 });
    // A second tap (from further down, the focus elsewhere) goes there again.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await go.focus();
    await go.click();
    await expect(head).toBeFocused();
    await expect(head).toBeInViewport({ ratio: 1 });
    await expect(page).toHaveURL(/\?back=\/money#yt-reading$/);
  });

  test("Do you see Finance: after the answer and after Change my answer, the focus stays on the question", async ({ page }) => {
    await start(page, "/settings/posting/getpaid/contentrewards");
    const q = page.locator("#cr-finance");
    await q.getByRole("radio", { name: "Yes" }).focus();
    await page.keyboard.press("Space");
    await expect(q.getByRole("button", { name: "Change my answer" })).toBeVisible();
    await expect(q).toBeFocused();
    await q.getByRole("button", { name: "Change my answer" }).focus();
    await page.keyboard.press("Enter");
    await expect(q.getByRole("radio", { name: "Yes" })).toBeAttached();
    await expect(q).toBeFocused();
  });
});
