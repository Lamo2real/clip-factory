import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { visibleEdges } from "./edges.ts";
import { tap } from "./flows.ts";
import { findOverflow, launcherSettled, settle } from "./helpers.ts";

// Your bank (docs/CONTRACTS.md §40.5, §40.5.13 Playwright), in mock mode: Clip Factory's own taps per step equal
// §40.5.3's CF counts (18 without the email, 20 with it); the ways in (4 from Settings, 2 from Money); Connect through
// /bank-done (signed in, and as a browser that isn't) and every result; the reconnect at 9 days; a question answered
// with 1 tap and with 2. Every new screen: no sideways scroll at 320–1920, no edges, targets of 44 px (48 on phones),
// the arrow cursor only, AA contrast light and dark, reduced motion, phone controls bottom right, Ask never over them.

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const PHONE = { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, userAgent: IPHONE } as const;
const DESKTOP = { viewport: { width: 1440, height: 900 } } as const;
const BANK = "/settings/posting/getpaid/bank";
const UUID = "0f8c2a4e-9b1d-4c6e-8a3f-5d7b9e1c2a40";

type Knobs = Record<string, (...a: unknown[]) => unknown>;
type MockWin = Window & { __cfMock?: { bank?: Knobs; getpaid?: Knobs } };

const watched = new WeakSet<object>();
/** The pretend owner's start: a Your bank scenario, then the page. Enable Banking's own pages never load here. */
async function start(page: Page, path: string, scenario = "fresh", knobs: [string, unknown[]][] = []) {
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
  await page.waitForFunction(() => !!(window as MockWin).__cfMock?.bank);
  await page.evaluate(
    ([s, k]) => {
      const m = (window as MockWin).__cfMock!;
      m.bank!.scenario!(s);
      for (const [fn, args] of k) m.bank![fn]!(...args);
    },
    [scenario, knobs] as const,
  );
  await page.goto(path);
  await settle(page);
  // The email's Open is his own email app: the test stays on the page.
  await page.evaluate(() => document.addEventListener("click", (e) => (e.target as Element | null)?.closest?.("a[href^='mailto:']") && e.preventDefault(), true));
}
const tomato = (page: Page) => page.locator("main .btn--primary").filter({ visible: true });
const step = (page: Page, id: string) => page.locator(`#step-${id}`);
const live = (page: Page) => page.waitForTimeout(1400);

async function screenProblems(page: Page, phone: boolean, scope = "main"): Promise<string[]> {
  const out: string[] = [];
  const o = await findOverflow(page);
  if (o.page > o.viewport) out.push(`sideways scroll ${o.page} > ${o.viewport}: ${JSON.stringify(o.items.slice(0, 3))}`);
  const bad = await page.evaluate(
    ([min, scope]) => {
      const found: string[] = [];
      const sel = scope
        .split(",")
        .map((r) => ["button", "a.btn", "summary", "a.setup-card", ".bank-pick"].map((c) => `${r.trim()} ${c}`).join(", "))
        .join(", ");
      for (const e of document.querySelectorAll<HTMLElement>(sel)) {
        const b = e.getBoundingClientRect();
        if (!b.width || !b.height || getComputedStyle(e).display === "inline") continue;
        const name = (e.getAttribute("aria-label") || e.textContent || e.tagName).trim().slice(0, 40);
        if (b.height < min - 0.5) found.push(`"${name}" is ${Math.round(b.width)}x${Math.round(b.height)}`);
        const cur = getComputedStyle(e).cursor;
        if (cur !== "auto" && cur !== "default") found.push(`"${name}" has cursor ${cur}`);
      }
      const red = [...document.querySelectorAll<HTMLElement>("main .btn--primary")].filter((e) => e.getBoundingClientRect().height > 0);
      if (red.length > 1) found.push(`${red.length} vermilion buttons: ${red.map((e) => e.textContent?.trim()).join(" | ")}`);
      return found;
    },
    [phone ? 48 : 44, scope] as const,
  );
  out.push(...bad);
  out.push(...(await visibleEdges(page)).filter((e) => /bank|gp-|gstep|setup-card|cr-all/.test(e)));
  return out;
}

/** Steps 1 to 7 by Clip Factory's own taps: 18 (§40.5.3). With `email`, the optional step first: 20. */
async function walk(page: Page, email: boolean) {
  const t = tap(email ? 20 : 18);
  if (email) {
    await t.tap(step(page, "bank-ask").getByRole("link", { name: "Open email" }));
    await t.tap(step(page, "bank-ask").getByRole("button", { name: "I asked" }));
    await expect(step(page, "bank-ask")).toHaveAttribute("data-done", "true");
  }
  // 1: Open Enable Banking · I'm in.
  await expect(tomato(page)).toHaveCount(1);
  await expect(tomato(page)).toHaveText(/Open Enable Banking/);
  await t.tap(tomato(page));
  await t.tap(step(page, "bank-account").getByRole("button", { name: "I'm in" }));
  // 2: Make my bank key.
  await expect(tomato(page)).toHaveText("Make my bank key");
  await t.tap(tomato(page));
  await expect(step(page, "bank-key")).toHaveAttribute("data-done", "true");
  // 3: Open your Enable Banking apps · Copy the bank key · I did this.
  await expect(tomato(page)).toHaveText(/Open your Enable Banking apps/);
  await t.tap(tomato(page));
  await t.tap(step(page, "bank-app").getByRole("button", { name: "Copy Bank key" }));
  await t.tap(step(page, "bank-app").getByRole("button", { name: "I did this" }));
  // 4: five Copy chips · I did this (no vermilion: the page is already open).
  await expect(tomato(page)).toHaveCount(0);
  for (const label of ["Application name", "Allowed redirect URLs (one per line)", "Application description", "Privacy URL of the application", "Terms URL of the application"])
    await t.tap(step(page, "bank-details").getByRole("button", { name: `Copy ${label}` }));
  await t.tap(step(page, "bank-details").getByRole("button", { name: "I did this" }));
  // 5: paste the message · Save.
  const box = step(page, "bank-appid").getByLabel("App ID");
  await t.tap(box);
  await box.fill(`New application Clip Factory ${UUID} has been added.`);
  await expect(step(page, "bank-appid")).toContainText(`App ID: ${UUID}`);
  await expect(tomato(page)).toHaveText("Save");
  await t.tap(tomato(page));
  await expect(step(page, "bank-appid")).toContainText("Saved. Next: link your bank accounts (step 6).");
  // 6: Open your Enable Banking apps · I linked them.
  await expect(tomato(page)).toHaveText(/Open your Enable Banking apps/);
  await t.tap(tomato(page));
  await t.tap(step(page, "bank-link").getByRole("button", { name: "I linked them" }));
  await expect(step(page, "bank-link")).toHaveAttribute("data-done", "true");
  // 7: Connect your bank · his bank in the list; then the pretend bank's Allow (not Clip Factory's) and back.
  await expect(tomato(page)).toHaveText("Connect your bank");
  await t.tap(tomato(page));
  const picker = page.locator("[data-help='bank-picker']");
  await expect(picker.locator(".bank-pick__name").first()).toHaveText("Swedbank");
  const away = page.waitForURL(/\/mock-bank\?state=/);
  await t.tap(picker.locator("[data-bank='Swedbank']"));
  await away;
  expect(t.count).toBe(email ? 20 : 18);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pretend Swedbank");
  await page.getByRole("button", { name: "Allow" }).click();
  await page.waitForURL(new RegExp(`${BANK}$`));
  await settle(page);
  await expect(page.locator("#bank-connect-card")).toContainText("Clip Factory can see money coming into Swedbank now. It looks once a day.");
}

for (const [name, use] of [
  ["phone", PHONE],
  ["desktop", DESKTOP],
] as const) {
  const phone = name === "phone";
  test.describe(name, () => {
    test.use(use);

    test("Clip Factory's taps: 18 without the email, then the first read; Connect comes back through /bank-done", async ({ page }) => {
      test.setTimeout(120_000);
      await start(page, BANK);
      if (phone) await expect(tomato(page).locator("xpath=ancestor::*[contains(@class,'gp-pin')]")).toHaveCount(1);
      await walk(page, false);
      // The first read: one link (Swedbank, 143 of 180 days) and its four rows, by live news.
      await live(page);
      await expect(page.locator(".bank-link")).toContainText("Swedbank");
      await expect(page.locator(".bank-link [role='progressbar']")).toHaveAttribute("aria-label", "Swedbank: 143 days left of 180 days");
      await expect(page.locator("[data-help='bank-reached']")).toContainText("matches Google's payment of 21 Oct");
      await expect(page.locator("[data-bank='fold']")).toHaveText("Set up ✓ (Enable Banking knows your app)");
      await expect(tomato(page)).toHaveCount(0);
    });

    if (!phone)
      test("with the optional email first: 20", async ({ page }) => {
        test.setTimeout(120_000);
        await start(page, BANK);
        await expect(step(page, "bank-ask").getByRole("link", { name: "Open email" })).toHaveAttribute("href", /^mailto:support\.api@enablebanking\.com\?subject=/);
        await expect(step(page, "bank-ask").locator(".btn--primary")).toHaveCount(0);
        await walk(page, true);
      });

    test("the ways in: 4 taps from Settings, 2 from Money", async ({ page }) => {
      await start(page, "/", "connected");
      const t = tap(4);
      await t.tap(page.getByRole("link", { name: "Settings", exact: true }).filter({ visible: true }).first());
      await settle(page);
      const content = page.locator(".settings-content");
      await t.tap(content.getByRole("link", { name: /^Posting/ }));
      await settle(page);
      await t.tap(content.getByRole("link", { name: /^Get paid/ }));
      await settle(page);
      await t.tap(page.locator("a[data-help='getpaid-bank-card']"));
      await expect(page).toHaveURL(new RegExp(`${BANK}$`));
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your bank");
      expect(t.count).toBe(4);
      const m = tap(2);
      await m.tap(page.getByRole("link", { name: "Money", exact: true }).filter({ visible: true }).first());
      await settle(page);
      await m.tap(page.locator("[data-help='money-reached']").getByRole("link", { name: "Answer them" }));
      await expect(page).toHaveURL(new RegExp(`${BANK}#bank-asks$`));
      await settle(page);
      await expect(page.locator("#bank-asks")).toBeInViewport();
      expect(m.count).toBe(2);
    });

    test("a question answered with 1 tap, and another with 2", async ({ page }) => {
      await start(page, BANK, "connected");
      const one = tap(1);
      await one.tap(page.locator(".bank-ask[data-suggested='youtube']").getByRole("button", { name: "Yes, it's YouTube" }));
      await expect(page.locator(".toast__text").filter({ hasText: "Saved for YouTube." })).toBeVisible();
      await expect(page.locator(".bank-ask[data-suggested='youtube']")).toHaveCount(0);
      const two = tap(2);
      await two.tap(page.locator(".bank-ask[data-suggested='x']").getByRole("button", { name: "No, another app" }));
      await two.tap(page.getByRole("dialog").getByRole("button", { name: "TikTok" }));
      await expect(page.locator(".toast__text").filter({ hasText: "Saved for TikTok." })).toBeVisible();
      expect(one.count + two.count).toBe(3);
      await expect(page.locator("[data-help='bank-reached']")).toContainText("TikTok");
    });

    test("the reconnect at 9 days: the status block's vermilion (pinned on phones), the link card's glass", async ({ page }) => {
      await start(page, BANK, "ending");
      await expect(page.locator("[data-help='bank-status'] .gp-pill")).toHaveText("Link ends in 9 days");
      await expect(tomato(page)).toHaveCount(1);
      await expect(tomato(page)).toHaveText("Reconnect Swedbank");
      if (phone) await expect(tomato(page).locator("xpath=ancestor::*[contains(@class,'gp-pin')]")).toHaveCount(1);
      else await expect(page.locator("[data-help='bank-status'] .btn--primary")).toHaveCount(1);
      await expect(page.locator("[data-bank='reconnect-card']")).not.toHaveClass(/btn--primary/);
      const away = page.waitForURL(/\/mock-bank\?state=/);
      await tomato(page).click();
      await away;
      await page.getByRole("button", { name: "Allow" }).click();
      await page.waitForURL(new RegExp(`${BANK}$`));
      await settle(page);
      await expect(page.locator("#bank-connect-card")).toContainText("Clip Factory can see money coming into Swedbank now.");
    });
  });
}

test.describe("Connect's way back", () => {
  test.use(DESKTOP);
  test("/bank-done as a browser that isn't signed in: one sentence, no button, no link; Cancel at the bank: its sentence", async ({ page }) => {
    await start(page, BANK, "setup");
    await page.getByRole("button", { name: "Connect your bank", exact: true }).click();
    const away = page.waitForURL(/\/mock-bank\?state=/);
    await page.locator("[data-bank='Nordea']").click();
    await away;
    await page.goto(`${page.url()}&mockBankDone=signedout`);
    await page.getByRole("button", { name: "Allow" }).click();
    await page.waitForURL(/\/bank-done\?result=bank_connected/);
    await expect(page.locator(".bank-done__text")).toHaveText("Done! Go back to Clip Factory. You can close this tab.");
    await expect(page.locator("main a, main button")).toHaveCount(0);
    await page.goto("/bank-done?result=bank_denied&mockBankDone=signedout");
    await expect(page.locator(".bank-done__text")).toHaveText("Your bank didn't connect. Go back to Clip Factory to see what to do.");
    // Signed in: on to the bank page, where the result says its sentence.
    await page.goto(BANK);
    await settle(page);
    await page.getByRole("button", { name: /^Connect (your|another) bank$/ }).first().click();
    const away2 = page.waitForURL(/\/mock-bank\?state=/);
    await page.locator("[data-bank='SEB']").click();
    await away2;
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.waitForURL(new RegExp(`${BANK}$`));
    await settle(page);
    await expect(page.locator("#bank-connect-card")).toHaveText("You stopped at the bank. Tap Connect your bank to try again.");
  });

  test("every result says its sentence, word for word", async ({ page }) => {
    const want: Record<string, string> = {
      bank_denied: "You stopped at the bank. Tap Connect your bank to try again.",
      bank_no_accounts: "Enable Banking didn't share an account. Link it on Enable Banking first (step 6). Then tap Connect your bank again.",
      bank_business_only: "That bank only shared a business account. Clip Factory reads private accounts only. Pick your private account at your bank, then tap Connect your bank again.",
      bank_expired: "That took too long. Tap Connect your bank again.",
      bank_key_wrong: "Enable Banking didn't know your bank key. Tap Check again in step 5.",
      bank_error: "Something went wrong. Tap Connect your bank again in a few minutes.",
      nonsense: "Something went wrong. Tap Connect your bank again in a few minutes.",
    };
    await start(page, "/", "setup");
    for (const [code, sentence] of Object.entries(want)) {
      await page.goto(`/bank-done?result=${code}`);
      await page.waitForURL(new RegExp(`${BANK}$`));
      await settle(page);
      await expect(page.locator("#bank-connect-card .gp-result"), code).toHaveText(sentence);
    }
  });
});

// ---------- every new screen ----------

const SCREENS: [string, string][] = [
  ["fresh", BANK],
  ["setup", BANK],
  ["connected", BANK],
  ["ending", BANK],
  ["ended", BANK],
  ["cant_read", BANK],
  ["connected", "/settings/posting/getpaid"],
  ["connected", "/settings/posting/getpaid/youtube"],
  ["connected", "/settings/posting/getpaid/instagram"],
  ["connected", "/money"],
];

for (const [name, use] of [
  ["phone", PHONE],
  ["desktop", DESKTOP],
] as const)
  test.describe(`${name} screens`, () => {
    test.use(use);
    test("no sideways scroll, no edges, big targets, the arrow cursor, one vermilion at most", async ({ page }) => {
      test.setTimeout(120_000);
      const fails: string[] = [];
      for (const [scenario, path] of SCREENS) {
        await start(page, path, scenario);
        const scope = path === "/money" ? "[data-help='money-reached']" : path === BANK ? "main" : "[data-help='getpaid-bank-card'], [data-bank-place]";
        fails.push(...(await screenProblems(page, name === "phone", scope)).map((f) => `${scenario} ${path}: ${f}`));
      }
      // The picker sheet too.
      await start(page, BANK, "setup");
      await page.getByRole("button", { name: "Connect your bank", exact: true }).click();
      await expect(page.locator("[data-help='bank-picker'] .bank-pick").first()).toBeVisible();
      fails.push(...(await screenProblems(page, name === "phone", "[role='dialog']")).map((f) => `picker: ${f}`));
      expect(fails, fails.join("\n")).toEqual([]);
    });

    if (name === "phone")
      test("the main button sits at the bottom right from page open, and Ask is never over it", async ({ page }) => {
        for (const scenario of ["fresh", "ending"]) {
          await start(page, BANK, scenario);
          await launcherSettled(page);
          const geo = await page.evaluate(() => {
            const b = document.querySelector<HTMLElement>("main .btn--primary")!.getBoundingClientRect();
            const ask = document.querySelector<HTMLElement>(".help-launcher");
            const a = ask && !ask.classList.contains("is-hidden") && getComputedStyle(ask).opacity !== "0" ? ask.getBoundingClientRect() : null;
            return { vw: innerWidth, vh: innerHeight, b: { left: b.left, right: b.right, top: b.top, bottom: b.bottom }, a: a && { left: a.left, right: a.right, top: a.top, bottom: a.bottom } };
          });
          expect(geo.b.bottom, scenario).toBeLessThanOrEqual(geo.vh);
          expect(geo.b.top + (geo.b.bottom - geo.b.top) / 2, `${scenario}: in the bottom 40%`).toBeGreaterThanOrEqual(0.6 * geo.vh);
          expect(geo.vw - geo.b.right, `${scenario}: at the right`).toBeLessThanOrEqual(32);
          if (geo.a) expect(geo.a.bottom <= geo.b.top || geo.a.top >= geo.b.bottom || geo.a.right <= geo.b.left || geo.a.left >= geo.b.right, `${scenario}: Ask over the main button`).toBe(true);
        }
      });
  });

async function ctxFor(browser: Browser, w: number, h: number, touch: boolean, scheme: "light" | "dark") {
  return browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch, userAgent: touch ? IPHONE : undefined, reducedMotion: "reduce", colorScheme: scheme });
}

for (const [w, h, touch] of [
  [375, 812, true],
  [1440, 900, false],
] as const)
  for (const scheme of ["light", "dark"] as const)
    test(`axe AA contrast, ${scheme}: ${touch ? "phone" : "desktop"} ${w}x${h}`, async ({ browser }) => {
      test.setTimeout(120_000);
      const fails: string[] = [];
      const ctx = await ctxFor(browser, w, h, touch, scheme);
      const page = await ctx.newPage();
      for (const [scenario, path] of [
        ["fresh", BANK],
        ["connected", BANK],
        ["ended", BANK],
        ["connected", "/money"],
        ["connected", "/settings/posting/getpaid"],
      ] as const) {
        await start(page, path, scenario);
        const axe = await new AxeBuilder({ page }).withRules(["color-contrast"]).include("main").analyze();
        fails.push(...axe.violations.flatMap((v) => v.nodes.map((n) => `${scheme} ${scenario} ${path}: ${n.target.join(" ")}: ${n.any.map((c) => c.message).join("; ")}`)));
      }
      await page.goto("/bank-done?result=bank_connected&mockBankDone=signedout");
      const axe = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
      fails.push(...axe.violations.flatMap((v) => v.nodes.map((n) => `bank-done: ${n.target.join(" ")}`)));
      await ctx.close();
      expect(fails, fails.join("\n")).toEqual([]);
    });

for (const w of [320, 390, 768, 1024, 1920] as const)
  test(`no sideways scroll at ${w} px on Your bank's screens`, async ({ browser }) => {
    test.setTimeout(120_000);
    const touch = w < 768;
    const ctx = await ctxFor(browser, w, touch ? 700 : 900, touch, "light");
    const page = await ctx.newPage();
    const fails: string[] = [];
    for (const [scenario, path] of SCREENS) {
      await start(page, path, scenario);
      const o = await findOverflow(page);
      if (o.page > o.viewport) fails.push(`${scenario} ${path}: ${o.page} > ${o.viewport} ${JSON.stringify(o.items.slice(0, 3))}`);
    }
    await page.goto("/bank-done?result=bank_denied&mockBankDone=signedout");
    const o = await findOverflow(page);
    if (o.page > o.viewport) fails.push(`bank-done: ${o.page} > ${o.viewport}`);
    await ctx.close();
    expect(fails, fails.join("\n")).toEqual([]);
  });

test("reduced motion: nothing on the bank page keeps moving", async ({ browser }) => {
  const ctx = await ctxFor(browser, 375, 812, true, "light");
  const page = await ctx.newPage();
  await start(page, BANK, "connected");
  const running = await page.evaluate(
    () =>
      document
        .getAnimations()
        .filter((a) => a.playState === "running")
        .map((a) => (a.effect as KeyframeEffect | null)?.target)
        .filter((t): t is Element => !!t && !!(t as Element).closest?.("main .bank-page")).length,
  );
  expect(running).toBe(0);
  await ctx.close();
});
