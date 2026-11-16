import { expect, test, type Page } from "@playwright/test";
import type { Platform } from "../src/api/types.ts";
import { GUIDES, SETUP_ORDER } from "../src/setup/index.ts";
import { animationsDone, findOverflow, settle, WIDTHS } from "./helpers.ts";

// The Set up posting lists (docs/CONTRACTS.md §17.1), audited at every phone width with touch (320–430) and every
// tablet/desktop width (768–1920): every step open, Copy buttons, paste boxes, Connect, resume after a reload, the
// finished panel, the account picker and a failed Connect. Nothing overflows, targets are big, one tomato at most.

type MockSetup = { finish(p: Platform): void; askToChoose(p: Platform): void; reset(): void };
const mock = (page: Page) => page.evaluateHandle(() => (window as unknown as { __cfMock: { setup: MockSetup } }).__cfMock.setup);
const step = (page: Page, id: string) => page.locator(`[data-step="${id}"]`);

/** Overflow, small targets, controls off the screen and more than one tomato on what is shown now. */
async function problems(page: Page, label: string, phone: boolean): Promise<string[]> {
  // Measured at rest: mid-slide a 44 px box can read 43.99999 px (a fractional translate).
  await animationsDone(page);
  const out: string[] = [];
  const o = await findOverflow(page);
  if (o.page > o.viewport) out.push(`${label}: the page scrolls sideways (${o.page} > ${o.viewport})`);
  for (const i of o.items) out.push(`${label}: ${i.selector} "${i.text}" ${i.scrollWidth} > ${i.clientWidth}`);
  const found = await page.evaluate((min) => {
    const bad: string[] = [];
    const vw = document.documentElement.clientWidth;
    for (const e of document.querySelectorAll<HTMLElement>(
      "main button, main a, main input:not([type=radio]):not([type=file]):not(.find__input), main .segmented__opt",
    )) {
      const b = e.getBoundingClientRect();
      if (!b.width || !b.height || getComputedStyle(e).display === "inline") continue;
      const name = (e.getAttribute("aria-label") || e.textContent || e.tagName).trim().slice(0, 40);
      if (b.height < min - 0.5 || b.width < min - 0.5) bad.push(`"${name}" is ${Math.round(b.width)}x${Math.round(b.height)}`);
      if (b.right > vw + 0.5 || b.left < -0.5) bad.push(`"${name}" is off the screen`);
    }
    const tomatoes = [...document.querySelectorAll<HTMLElement>("main .btn--primary")].filter((e) => e.getBoundingClientRect().height > 0);
    if (tomatoes.length > 1) bad.push(`${tomatoes.length} tomato buttons: ${tomatoes.map((e) => e.textContent?.trim()).join(" | ")}`);
    return bad;
  }, phone ? 48 : 44);
  return [...out, ...found.map((f) => `${label}: ${f}`)];
}

/** Opens every folded step card, so each Copy chip, paste box and button is on the page. */
async function openEveryStep(page: Page) {
  const closed = page.locator(".gstep__head[aria-expanded=false]");
  for (let n = 0; n < 60 && (await closed.count()); n++) await closed.first().evaluate((e: HTMLElement) => e.click());
}

for (const width of WIDTHS) {
  const phone = width < 768;
  test.describe(`Set up posting at ${width} px${phone ? " (touch)" : ""}`, () => {
    test.use(phone ? { viewport: { width, height: 800 }, hasTouch: true, isMobile: true } : { viewport: { width, height: 900 } });

    test("the list, every step of every platform, a finished one, the picker and a failed Connect fit", async ({ page }) => {
      test.setTimeout(120_000);
      const failures: string[] = [];
      await page.goto("/settings/posting/setup");
      await settle(page);
      failures.push(...(await problems(page, "list", phone)));
      for (const platform of SETUP_ORDER) {
        await page.goto(`/settings/posting/setup/${platform}`);
        await settle(page);
        await openEveryStep(page);
        failures.push(...(await problems(page, `${platform}, every step open`, phone)));
      }
      await page.goto("/settings/posting/setup/youtube?result=denied");
      await settle(page);
      failures.push(...(await problems(page, "failed Connect", phone)));
      await (await mock(page)).evaluate((s) => s.askToChoose("facebook"));
      await page.goto("/settings/posting/setup/facebook?result=choose");
      await settle(page);
      failures.push(...(await problems(page, "account picker", phone)));
      await (await mock(page)).evaluate((s) => s.finish("youtube"));
      await page.goto("/settings/posting/setup/youtube");
      await settle(page);
      failures.push(...(await problems(page, "finished", phone)));
      expect(failures, failures.join("\n")).toEqual([]);
    });
  });
}

test.describe("Set up posting on the smallest phone", () => {
  test.use({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true, permissions: ["clipboard-read", "clipboard-write"] });

  test("Copy is a quiet glass button, and a tap copies the value", async ({ page }) => {
    await page.goto("/settings/posting/setup/youtube");
    await settle(page);
    await openEveryStep(page);
    const btn = page.getByRole("button", { name: "Copy App name" });
    // Glass, not a dark pill: the background is light, the label dark.
    const look = await btn.evaluate((e) => {
      const s = getComputedStyle(e);
      return { bg: s.backgroundImage + s.backgroundColor, color: s.color };
    });
    expect(look.bg).not.toContain("rgb(30, 42, 27)");
    expect(look.color).toBe("rgb(30, 42, 27)");
    await btn.scrollIntoViewIfNeeded();
    await btn.tap();
    await expect(page.getByRole("button", { name: "App name copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Clip Factory");
  });

  test("paste boxes do not zoom the phone, and Paste fills the box from the clipboard", async ({ page }) => {
    await page.goto("/settings/posting/setup/tiktok");
    await settle(page);
    await openEveryStep(page);
    const card = step(page, "key-paste");
    const boxes = card.locator("input.key-field__input");
    await expect(boxes).toHaveCount(2);
    for (const box of await boxes.all()) {
      expect(parseFloat(await box.evaluate((e) => getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(16);
      expect((await box.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    }
    await page.evaluate(() => navigator.clipboard.writeText("awx1y2z3b4c5d6e7"));
    const paste = card.getByRole("button", { name: "Paste the Client key" });
    await paste.scrollIntoViewIfNeeded();
    await paste.tap();
    await expect(boxes.first()).toHaveValue("awx1y2z3b4c5d6e7");
  });

  test("a long account name ends in … instead of breaking in the middle of a word", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await (await mock(page)).evaluate((s) => s.finish("youtube"));
    await page.goto("/settings/posting/setup/youtube");
    await settle(page);
    const name = page.locator(".done-panel__name");
    await name.scrollIntoViewIfNeeded();
    const { lines, full } = await name.evaluate((e) => ({
      lines: Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight || "20")),
      full: e.getAttribute("title"),
    }));
    expect(lines).toBe(1);
    expect(full).toBe(await name.textContent());
  });

  test("Connect by tapping, through the pretend consent page", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    // Everything but Connect done, so Connect is the current step.
    await page.goto("/settings/posting/setup/x");
    await settle(page);
    await openEveryStep(page);
    const card = step(page, "key-paste");
    await card.getByLabel("Client ID", { exact: true }).fill("dGhpc2lzYWNsaWVudGlkMTIz");
    await card.getByLabel("Client Secret", { exact: true }).fill("c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0");
    const save = card.getByRole("button", { name: "Save keys" });
    await save.evaluate((e) => e.scrollIntoView({ block: "center" }));
    await save.tap();
    await expect(card.locator(".key-saved")).toBeVisible();
    const connect = page.getByRole("button", { name: "Connect X", exact: true });
    await connect.evaluate((e) => e.scrollIntoView({ block: "center" }));
    await connect.tap();
    await page.waitForURL(/\/mock-oauth\/x\?state=/);
    await settle(page);
    expect(await problems(page, "consent", true)).toEqual([]);
    await page.getByRole("button", { name: "Allow" }).tap();
    await expect(page.locator(".result-card--ok")).toContainText("Connected as");
    await expect(page.locator(".setup-head [role=progressbar]")).toHaveAttribute("aria-valuenow", /\d+/);
  });
});

// "Press Connect again" must never leave the owner hunting for the button many steps down the page.
for (const size of [
  { width: 320, height: 640, touch: true },
  { width: 1920, height: 1080, touch: false },
]) {
  test.describe(`a failed Connect at ${size.width} px`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, hasTouch: size.touch, isMobile: size.touch });

    for (const code of ["denied", "expired", "missing_permissions", "platform_down", "error"]) {
      test(`${code}: the card takes you to the Connect step`, async ({ page }) => {
        await page.goto(`/settings/posting/setup/tiktok?result=${code}`);
        await settle(page);
        const n = GUIDES.tiktok.parts.flatMap((p) => p.steps).findIndex((s) => s.id === "connect") + 1;
        const go = page.locator(".result-card").getByRole("button", { name: `Go to step ${n}` });
        await expect(go).toBeVisible();
        await expect(go).not.toHaveClass(/btn--primary/);
        if (size.touch) await go.tap();
        else await go.click();
        await expect(step(page, "connect").locator(".gstep__head")).toHaveAttribute("aria-expanded", "true");
        await expect(step(page, "connect").locator(".gstep__head")).toBeInViewport();
      });
    }
  });
}

// Back from the platform on a small phone, the answer is on screen without scrolling (the header fills the first screen).
test.describe("back from the platform on a 320 px phone", () => {
  test.use({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true });

  test("a failed Connect's card is in view", async ({ page }) => {
    await page.goto("/settings/posting/setup/tiktok?result=denied");
    await settle(page);
    await expect(page.locator(".result-card .result-card__title")).toBeInViewport();
    await expect(page.locator(".result-card").getByRole("button", { name: /^Go to step/ })).toBeInViewport();
  });

  test("the account picker's first choice is in view", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await (await mock(page)).evaluate((s) => s.askToChoose("facebook"));
    await page.goto("/settings/posting/setup/facebook?result=choose");
    await settle(page);
    await expect(page.locator(".choose__title")).toBeInViewport();
    await expect(page.locator(".choose button").first()).toBeInViewport();
  });
});

// Resume where you left, at the narrowest and widest screens (the full journeys run at 375 and 1440).
for (const size of [
  { width: 320, height: 640, touch: true },
  { width: 430, height: 932, touch: true },
  { width: 768, height: 1024, touch: false },
  { width: 1920, height: 1080, touch: false },
]) {
  test(`a reload at ${size.width} px reopens the first step not done`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, hasTouch: size.touch, isMobile: size.touch });
    const page = await ctx.newPage();
    await page.goto("/settings/posting/setup/instagram");
    await settle(page);
    const ids = GUIDES.instagram.parts[0]!.steps.map((s) => s.id);
    for (const id of ids) {
      const did = step(page, id).getByRole("button", { name: "I did this" });
      await did.evaluate((e) => e.scrollIntoView({ block: "center" }));
      if (size.touch) await did.tap();
      else await did.click();
      await expect(step(page, id)).toHaveAttribute("data-done", "true");
    }
    await page.waitForFunction((n) => (JSON.parse(sessionStorage.getItem("cf-mock-setup") ?? "{}").instagram?.stepsDone ?? []).length === n, ids.length);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.reload();
    await settle(page);
    const next = GUIDES.instagram.parts[1]!.steps[0]!.id;
    await expect(step(page, next)).toHaveClass(/is-current/);
    await expect(step(page, next).locator(".gstep__head")).toBeInViewport();
    expect(await problems(page, "resumed", size.touch)).toEqual([]);
    await ctx.close();
  });
}
